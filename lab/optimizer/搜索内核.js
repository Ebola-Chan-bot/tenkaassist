'use strict';
/*
 * 搜索内核 —— DebugTools 优化器/搜索队伍.js 搜索管线的 Worker 移植版
 *
 * 与 CLI 入口的关系：搜索队伍(inst, ids, 名称, 羁绊, 设置) 与 CLI 的同名函数逐段同构（先验贪心 →
 * 前瞻贪心 → 前瞻+爬山 → DB 种子 → 束搜索 → 相位/节拍/窗对齐兜底 → 自然收敛 → 编辑球），兜底口径
 * 同样固定 谷底试探=8、兜底爬山预算=max(爬山预算, 30000)。差异只有三点：
 *   1) 说() 输出改为进度回调（emit），由 优化worker.js 转发给页面做实时展示；
 *   2) DB 种子由装配器预取的 data.json 数组注入（CLI 侧是 fs 读本地 gzip）；
 *   3) 角色解析/参数解析/落盘等 CLI 专属逻辑剥离（页面直接给 ids 与配置）。
 * 改动管线逻辑须两侧同步。
 */
const 排程器 = require('./排程器.js');
const 机制特征 = require('./机制特征.js');

const 谷底试探 = 8;
function 兜底爬山预算(爬山预算) { return Math.max(爬山预算 || 0, 30000); }

/**
 * 搜索给定 5 人队伍的最优指令序列（toks = [{idx,act} × 65]）。
 * @param {object} inst 多例引擎实例（lab 口径装配，见 引擎适配.js createEngine）
 * @param {number[]} ids 5 个角色 id（站位序，首位=队长）
 * @param {string[]} 名称 5 个展示名（仅用于日志）
 * @param {number[]} 羁绊 5 个羁绊等级
 * @param {object} 设置 { 束时限, 束宽, 评分, 爬山预算, 禁用种子, DB }
 * @param {object} 钩子 { 阶段(name), 最优(info), 日志(text), 进度(info), shouldStop() }
 * @returns {{ toks, dmg, 来源, 已评估 } | null} null = 全路径零伤害
 */
function 搜索队伍(inst, ids, 名称, 羁绊, 设置, 钩子) {
   const 说 = (s) => 钩子.日志(String(s));
   const 重放 = toks => 排程器.重放(inst, ids, toks, 羁绊);
   const 停 = () => 钩子.shouldStop && 钩子.shouldStop();
   let 最好 = null, 已评估 = 0, 段基线 = 0;
   // 爬一段：统一爬山调用口径（预算/停止/进度），进度回调报「段基线+本段已评估」的全局累计值，
   // 段结束后把本段评估数并入全局，避免旧写法的「进度覆盖全局值 + 段后重复累加」双计。
   const 爬一段 = (阶段, toks, 预算, 谷) => {
      const r = 排程器.爬山(inst, ids, toks, 羁绊, 预算, 停, (n) => 钩子.进度({ 阶段, 已评估: 段基线 + n }), 谷);
      段基线 += (r && r.评估) || 0;
      已评估 = 段基线;
      return r;
   };
   const 取优 = (来源, r) => {
      if (r && r.dmg > 0 && (!最好 || r.dmg > 最好.dmg)) {
         最好 = { 来源, toks: r.toks, dmg: r.dmg };
         钩子.最优({ dmg: r.dmg, 来源, 已评估 });
      }
   };

   说('===== 搜索管线 =====');
   const g = 排程器.先验贪心(inst, ids, 羁绊); 取优('先验贪心', g);
   说(`先验贪心        = ${g ? g.dmg.toLocaleString() : '失败'}`);
   if (停()) return 收尾(最好, 已评估);

   const f = 排程器.先验前瞻贪心(inst, ids, 羁绊, {}); 取优('前瞻贪心', f);
   说(`前瞻贪心        = ${f ? f.dmg.toLocaleString() : '失败'}${f ? ' 前瞻=' + f.前瞻次数 : ''}`);
   if (f) {
      const h = 爬一段('前瞻+爬山', f.toks, 设置.爬山预算);
      取优('前瞻+爬山', h); 说(`前瞻+爬山       = ${h.dmg.toLocaleString()} 评估=${h.评估}`);
   }
   if (停()) return 收尾(最好, 已评估);

   // DB 种子（同站位同序条目）：与 CLI 版同口径逐条重放+爬山
   if (!设置.禁用种子 && 设置.DB) {
      const 种子 = [];
      for (const d of 设置.DB) {
         const a = String(d.compstr).trim().split(/\s+/).map(Number);
         if (a.length !== 5 || a.join(',') !== ids.join(',')) continue;
         const t = 排程器.解析指令集(inst, ids, d.description || '', 羁绊);
         const dmg = t ? 重放(t) : 0;
         if (t && dmg > 0) 种子.push({ 来源: `DB条目${d.id}(${d.name})`, toks: t, dmg, ranking: d.ranking });
      }
      if (种子.length) {
         说(`DB种子(${种子.length}条同站位):`);
         for (const s of 种子) {
            说(`  ${s.来源} ranking=${s.ranking} 重放=${s.dmg.toLocaleString()}`);
            const h = 爬一段('种子+爬山', s.toks, 设置.爬山预算);
            取优(s.来源 + '+爬山', h);
            说(`  → +爬山=${h.dmg.toLocaleString()} 评估=${h.评估}`);
            if (停()) return 收尾(最好, 已评估);
         }
      } else 说('DB种子: 无同站位同序条目');
   } else 说('DB种子: 已跳过');

   // 束搜索（0=跳过）
   if (设置.束时限 > 0) {
      钩子.阶段('束搜索');
      const t0 = Date.now();
      const b = 排程器.束搜索(inst, ids, 羁绊, {
         width: 设置.束宽, 评分: 设置.评分, 时限秒: 设置.束时限,
         stopFlag: () => 停(),
      });
      说(`束搜索(w${设置.束宽},${设置.束时限}s) = ${b ? b.dmg.toLocaleString() : '失败'} 扩展=${b ? b.扩展数 : 0} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (b) {
         取优('束搜索', b);
         const h = 爬一段('束搜索+爬山', b.toks, 设置.爬山预算);
         取优('束搜索+爬山', h); 说(`束搜索+爬山     = ${h.dmg.toLocaleString()} 评估=${h.评估}`);
      }
   } else 说('束搜索: 已跳过');
   if (停()) return 收尾(最好, 已评估);

   // ===== 构造兜底（与 团队搜索器.js 生产链路同口径，按真值 max 取优 → 只增不减零回退）=====
   const 兜底预算 = 兜底爬山预算(设置.爬山预算);
   if (机制特征.需相位规划(ids)) {
      const 见构 = new Set();
      for (const 憋 of [5, 99]) {
         if (停()) return 收尾(最好, 已评估);
         钩子.阶段(`相位兜底(憋${憋})`);
         const t0 = Date.now();
         const g2 = 排程器.相位对齐构造(inst, ids, 羁绊, { 最大憋: 憋 });
         if (!g2 || !(g2.dmg > 0)) continue;
         const 键 = 排程器.toks键(g2.toks);
         if (见构.has(键)) { 说(`相位兜底(憋${憋})   = 与憋5构造相同，跳过重复爬山`); continue; }
         见构.add(键);
         const gh = 爬一段(`相位兜底(憋${憋})+爬山`, g2.toks, 兜底预算, 谷底试探);
         const 终 = (gh && gh.dmg > g2.dmg) ? gh.dmg : g2.dmg;
         取优(`相位对齐(憋${憋})`, 终 > g2.dmg ? gh : g2);
         说(`相位兜底(憋${憋})   = ${终.toLocaleString()} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      const t0b = Date.now();
      钩子.阶段('节拍兜底');
      const 节拍候选 = 排程器.节拍对齐构造(inst, ids, 羁绊, { TopK: 3 });
      let 节拍最好 = 0;
      for (const 构 of 节拍候选) {
         if (停()) return 收尾(最好, 已评估);
         const gh = 爬一段('节拍兜底+爬山', 构.toks, 兜底预算, 谷底试探);
         const 终 = (gh && gh.dmg > 构.dmg) ? gh.dmg : 构.dmg;
         if (终 > 节拍最好) 节拍最好 = 终;
         取优('节拍对齐', 终 > 构.dmg ? gh : 构);
      }
      说(`节拍兜底(TopK${节拍候选.length}) = ${节拍最好.toLocaleString()} ${((Date.now() - t0b) / 1000).toFixed(0)}s`);
   }
   if (机制特征.需相位规划(ids)) {
      if (停()) return 收尾(最好, 已评估);
      钩子.阶段('窗对齐兜底');
      const t0c = Date.now();
      const r0 = 排程器.窗对齐构造(inst, ids, 羁绊, { TopK: 3, 爬山预算: 兜底预算, 谷底试探 });
      let r = r0;
      if (r0 && r0.dmg > 0) {
         const o = 排程器.整回合序重排(inst, ids, r0.toks, 羁绊);
         if (o && o.dmg > r0.dmg) r = { toks: o.toks, dmg: o.dmg, 来源: '窗对齐+序重排:' + r0.来源 };
         取优('窗对齐', r);
         说(`窗对齐兜底      = ${r.dmg.toLocaleString()} [${r.来源}] ${((Date.now() - t0c) / 1000).toFixed(0)}s`);
      } else 说('窗对齐兜底      = 无有效构造');
   } else 说('窗对齐兜底: 跳过（需相位规划=false，队内无CD改写/注入机制）');

   if (!最好) {
      说('所有搜索路径 dmg=0（引擎模拟该队造不出伤害）');
      return null;
   }

   // 自然收敛 + 编辑球邻域验证
   if (停()) return 收尾(最好, 已评估);
   钩子.阶段('自然收敛');
   const hi = 爬一段('自然收敛', 最好.toks, Infinity);
   取优(最好.来源 + '+自然收敛', hi);
   说(`自然收敛        = ${hi.dmg.toLocaleString()} 评估=${hi.评估} 提升=${hi.提升}`);
   for (const r of [1, 2]) {
      if (停()) break;
      钩子.阶段(`编辑球r=${r}`);
      let n = 0, best = 最好.dmg;
      排程器.编辑球层(inst, ids, 最好.toks, 羁绊, r, (t, d) => { n++; if (d > best) best = d; }, Infinity, 停);
      段基线 += n; 已评估 = 段基线;
      说(`编辑球r=${r}       穷举=${n} 最高=${best.toLocaleString()} 更优=${best > 最好.dmg ? '有' : '无'}`);
   }
   return 收尾(最好, 已评估);
}

function 收尾(最好, 已评估) {
   return 最好 ? { toks: 最好.toks, dmg: 最好.dmg, 来源: 最好.来源, 已评估 } : null;
}

/** toks → 站点 description 文本（模拟器可直接消费的"N턴 : 2평 > ..."格式） */
function 导出指令文本(toks) { return 排程器.导出指令集(toks); }
/** toks → 紧凑串 */
function 紧凑串(toks) { return 排程器.toks键(toks); }

/**
 * 零伤害自动诊断（与 CLI 版同构的精简版）：给出换队长/去触发源等可执行建议。
 * @returns {string[]} 诊断行
 */
function 零伤害诊断(inst, ids, 名称, 羁绊) {
   const 行 = [];
   行.push('===== 零伤害诊断 =====');
   const ok = inst.increment.initBattle(ids, 羁绊, -1, null);
   if (!ok) { 行.push('initBattle 失败：该队无法构建（角色数据缺失或 N/R 卡）'); return 行; }
   let 抓到减益 = false;
   for (let i = 0; i < 5; i++) {
      const u = inst.internals.comp[i];
      if (!u || !Array.isArray(u.buff)) continue;
      for (const b of u.buff) {
         if (typeof b.size === 'number' && b.size <= -100 && b.on !== false && /뎀증|발효증/.test(b.type || '')) {
            行.push(`[发现] 槽${i + 1}${名称[i]} 挂永久减益: [${b.type} size=${b.size}% name=${b.name}] → 伤害乘区为负，引擎按公式强制归 0`);
            抓到减益 = true;
            break;
         }
      }
   }
   const 全普攻 = [];
   for (let s = 0; s < 65; s++) 全普攻.push({ idx: s % 5, act: '평' });
   行.push('队长轮换隔离（全队固定普攻重放 13 回合）:');
   let 可恢复 = null;
   for (let L = 0; L < 5; L++) {
      const 轮换ids = ids.slice(L).concat(ids.slice(0, L));
      const 轮换名 = 名称.slice(L).concat(名称.slice(0, L));
      const d = inst.increment.fastReplay(轮换ids, 全普攻, 羁绊, -1, null);
      行.push(`  ${轮换名[0]} 当队长${L === 0 ? '(原队长)' : ''}: dmg=${d.toLocaleString()}`);
      if (L > 0 && d > 0 && !可恢复) 可恢复 = { 队长: 轮换名[0] };
   }
   行.push('诊断结论:');
   if (抓到减益 && 可恢复) 行.push(`  原队长（${名称[0]}）的队长技与当前阵容冲突（常见条件如"队内含힐治疗"）。建议换队长试算（${可恢复.队长} 当队长时伤害恢复正常）或移除队内治疗。`);
   else if (抓到减益) 行.push('  存在永久负值伤害 buff，且任意队长轮换均未恢复——减益可能被多个角色共享条件触发，需人工排查。');
   else if (可恢复) 行.push(`  未发现负值 buff 但换队长可恢复（${可恢复.队长}）——原队长的其它机制抑制了全队输出，需人工排查。`);
   else 行.push('  未发现单一归因：任意队长+全普攻重放均为 0，可能是被动触发型机制，需人工排查。');
   return 行;
}

module.exports = { 搜索队伍, 导出指令文本, 紧凑串, 零伤害诊断, 谷底试探, 兜底爬山预算 };
