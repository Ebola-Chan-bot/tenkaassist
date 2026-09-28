'use strict';
/*
 * 优化worker.js —— LAB 模拟页单队指令优化器的 Web Worker 装配器
 *
 * 职责：
 * 1. 预取全部源文本：站内引擎链（js/characterJson.js、js/header.js、make/autocalc.v3.js、lab/optimizer/deobfuscated.js）
 *    与优化器内核（本目录复制件，与 DebugTools 优化器/ 字节级一致的模块）+ 机制表数据.json.gz（DebugTools
 *    机制表 bin 的一次性 JSON 导出）+ data.json 种子库（make 页同源镜像列表，失败自动跳过种子）。
 * 2. CommonJS mini-shim：内核模块（排程器/序先验/防守名单/机制特征/多例引擎/搜索内核）保持 require/module.exports
 *    原貌装载；fs/path/process 提供浏览器桩。引擎适配.js 为浏览器定制件（其余模块的 './引擎适配.js' 解析到它）。
 * 3. 引擎装配：多例引擎 createSimulator(deps, { calcSrc: deobfuscated.js, autocalcSrc: autocalc.v3.js + LAB战斗装配覆盖.js,
 *    headerFrag }) —— 覆盖源以同作用域后声明方式替换 start()，使评估口径与 lab/simulator/simulator.v3.js 的
 *    战斗装配（per-char 潜能系数 / li / gboss / ELV / hitAll）逐项一致。
 * 4. 配置注入：monkey-patch inst.increment.fastReplay，把排程器内部硬编码的 (bossElement=-1, optionList=null)
 *    替换为页面配置（li→optionList[3..7]，lab 配置对象→optionList[8]），排程器.js 因此零改动。
 * 5. 消息协议（worker ⇄ 主线程）：
 *    ← { t:'开始', cfg: { ids, bond, bossEl, li, gboss, coefs, elvOn, elv, hitAll, 档, 总时限秒, 禁用种子 } }
 *    → { t:'就绪', 用时ms } / { t:'日志', text } / { t:'阶段', name } / { t:'最优', dmg, 来源, 已评估 }
 *      / { t:'进度', 阶段, 已评估 }（≥200ms 节流）/ { t:'完成', ... } / { t:'失败', reason }
 *    手动停止：主线程 worker.terminate()（消息通道在同步搜索期间不可入，terminate 即时生效，best-so-far 已由最优消息留存）。
 */

// ================= CommonJS mini-shim =================
const 模块缓存 = new Map();
const 模块文本 = {};          // 模块名 → 源文本（fetch 后填入）
const fs文件 = {};            // basename → 文本（序先验.js 经 fs.readFileSync 取 JSON）
let _进度上次 = 0;

const path桩 = {
  join: (...a) => a.filter(Boolean).join('/'),
  resolve: (...a) => a.filter(Boolean).join('/'),
  basename: (p) => String(p).split('/').pop(),
  dirname: (p) => String(p).split('/').slice(0, -1).join('/'),
  sep: '/',
};
const fs桩 = {
  readFileSync: (p) => {
    const 名 = path桩.basename(String(p));
    if (名 in fs文件) return fs文件[名];
    throw new Error('优化器 fs 桩：浏览器端不支持读 ' + 名 + '（应在装配器预取）');
  },
};
function 装载模块(名) {
  if (模块缓存.has(名)) return 模块缓存.get(名).exports;
  const m = { exports: {} };
  模块缓存.set(名, m);
  const 源文本 = 模块文本[名];
  if (源文本 == null) throw new Error('缺少内核模块源: ' + 名);
  const 假require = (请求) => 解析依赖(请求);
  假require.main = {};   // ≠ module：flatten_core 等文件的 CLI 守卫块跳过
  const fn = new Function('require', 'module', 'exports', 'process', '__dirname',
    源文本 + '\n//# sourceURL=lab/optimizer/' + 名);
  fn(假require, m, m.exports, { env: {} }, '');
  return m.exports;
}
function 解析依赖(请求) {
  if (请求 === 'fs') return fs桩;
  if (请求 === 'path') return path桩;
  if (请求 === 'flatbuffers') throw new Error('优化器：机制表已 JSON 化，flatbuffers 不应被加载');
  const 名 = path桩.basename(String(请求));
  return 装载模块(名);
}

// ================= 源预取 =================
async function 取文本(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.text();
}
async function 解压(bytes, 格式们) {
  for (const f of 格式们) {
    try {
      const ds = new DecompressionStream(f);
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) { /* 试下一种格式 */ }
  }
  throw new Error('解压失败: ' + 格式们.join('/'));
}
async function 取解压文本(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const 解 = await 解压(bytes, ['gzip', 'deflate', 'deflate-raw']);
  return new TextDecoder().decode(解);
}

const 源路径 = {
  characterJson: '../../js/characterJson.js',
  header: '../../js/header.js',
  autocalc: '../../make/autocalc.v3.js',
  deobfuscated: './deobfuscated.js',
  lab覆盖: './LAB战斗装配覆盖.js',
  机制表数据: './机制表数据.json.gz',
  模块: ['引擎适配.js', '多例引擎.js', '排程器.js', '序先验.js', '防守名单.js', '机制特征.js', '搜索内核.js'],
  序先验数据: './序先验数据.json',
};

async function 装配() {
  const t0 = Date.now();
  const [characterJson, header, autocalc, deobfuscated, lab覆盖, 机制表文本, 序先验文本] = await Promise.all([
    取文本(源路径.characterJson),
    取文本(源路径.header),
    取文本(源路径.autocalc),
    取文本(源路径.deobfuscated),
    取文本(源路径.lab覆盖),
    取解压文本(源路径.机制表数据),
    取文本(源路径.序先验数据),
  ]);
  for (const 名 of 源路径.模块) 模块文本[名] = await 取文本('./' + 名);
  fs文件['序先验数据.json'] = 序先验文本;
  globalThis.__优化器源 = {
    characterJson, header, autocalc, deobfuscated, lab覆盖,
    机制表数据: JSON.parse(机制表文本),
  };
  装载模块('引擎适配.js');       // 先装适配层（排程器装载时建特征表需要它）
  装载模块('搜索内核.js');       // 内核全链装载（排程器/序先验/防守名单/机制特征经 require 图自解析）
  postMessage({ t: '就绪', 用时ms: Date.now() - t0 });
}

// ================= DB 种子（make 页同源镜像列表，失败跳过）=================
const 种子镜像 = ['raw.githubusercontent.com', 'raw.gitmirror.com', 'raw.bgithub.xyz', 'raw.fastgit.org', 'raw.staticdn.net'];
async function 取种子DB() {
  for (const host of 种子镜像) {
    try {
      const r = await fetch(`https://${host}/inittt/tenkaassist_data/main/data/data.json`);
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const 解 = await 解压(bytes, ['gzip', 'deflate', 'deflate-raw']);
      return JSON.parse(new TextDecoder().decode(解).replace(/^\uFEFF/, ''));
    } catch (e) { /* 试下一面镜子 */ }
  }
  return null;
}

// ================= 搜索执行 =================
const 档预设 = {
  快速: { 束时限: 10, 束宽: 10, 爬山预算: 3000, 总时限秒: 60 },
  标准: { 束时限: 30, 束宽: 20, 爬山预算: 10000, 总时限秒: 150 },
  深度: { 束时限: 90, 束宽: 20, 爬山预算: 30000, 总时限秒: 400 },
};

async function 开始搜索(cfg) {
  const 适配 = 装载模块('引擎适配.js');
  const 内核 = 装载模块('搜索内核.js');
  const 排程器 = 装载模块('排程器.js');
  const 预设 = 档预设[cfg.档] || 档预设.标准;
  const 总时限秒 = cfg.总时限秒 || 预设.总时限秒;
  const 截止 = Date.now() + 总时限秒 * 1000;
  const 停 = () => Date.now() > 截止;

   // DB 种子并行预取（失败=跳过种子，管线自带容错）
  const DB = cfg.禁用种子 ? null : await 取种子DB();

  // lab 口径战斗装配通道：li → optionList[3..7]；lab 配置对象 → optionList[8]
  const lab配置 = {
    coefs: cfg.coefs || null,
    elvOn: !!cfg.elvOn,
    elv: cfg.elv || null,
    gboss: cfg.gboss || 0,
    hitAll: cfg.hitAll !== false,
  };
  const 扩展option = [0, 0, 0, ...(cfg.li || [0, 0, 0, 0, 0]), lab配置];
  const bossEl = (cfg.bossEl == null || cfg.bossEl < 0) ? -1 : cfg.bossEl;

  const t0 = Date.now();
  const inst = 适配.createEngine();
  // 配置注入：排程器的全部评估入口只有两个——重放() 的 fastReplay，以及检查点评估/贪心推进直接调的
  // initBattle（两者内部都硬编码 bossElement=-1、optionList=null）。两个入口都要包一层，把页面配置
  // （li→optionList[3..7]，lab 配置对象→optionList[8]，bossEl→bossElement）替换进去，排程器.js 零改动。
  const 原重放 = inst.increment.fastReplay;
  inst.increment.fastReplay = (ids, toks, bonds) => 原重放(ids, toks, bonds, bossEl, 扩展option);
  const 原init = inst.increment.initBattle;
  inst.increment.initBattle = (ids, bonds) => 原init(ids, bonds, bossEl, 扩展option);

  const 名称 = (cfg.ids || []).map(id => String(id));
  const 钩子 = {
    阶段: (name) => postMessage({ t: '阶段', name, 用时秒: (Date.now() - t0) / 1000 }),
    最优: (info) => postMessage({ t: '最优', ...info, 用时秒: (Date.now() - t0) / 1000 }),
    日志: (text) => postMessage({ t: '日志', text }),
    进度: (info) => {
      const now = Date.now();
      if (now - _进度上次 >= 200) { _进度上次 = now; postMessage({ t: '进度', ...info, 用时秒: (now - t0) / 1000 }); }
    },
    shouldStop: 停,
  };
  钩子.日志(`队伍: ${cfg.ids.join(', ')}  羁绊: ${(cfg.bond || []).join(',')}  档: ${cfg.档}  总时限: ${总时限秒}s`);
  钩子.日志(`种子库: ${DB ? DB.length + ' 条' : '不可用（跳过种子）'}`);

  let 结果;
  try {
    结果 = 内核.搜索队伍(inst, cfg.ids, 名称, cfg.bond || [5, 5, 5, 5, 5], {
      束时限: 预设.束时限, 束宽: 预设.束宽, 评分: 'sync', 爬山预算: 预设.爬山预算,
      禁用种子: cfg.禁用种子 || !DB, DB,
    }, 钩子);
  } catch (e) {
    postMessage({ t: '失败', reason: (e && e.stack) || String(e) });
    return;
  }
  if (!结果) {
    const 诊断 = 内核.零伤害诊断(inst, cfg.ids, 名称, cfg.bond || [5, 5, 5, 5, 5]);
    for (const 行 of 诊断) 钩子.日志(行);
    postMessage({ t: '完成', dmg: 0, 用时秒: (Date.now() - t0) / 1000, 零伤害: true });
    return;
  }
  postMessage({
    t: '完成',
    dmg: 结果.dmg,
    来源: 结果.来源,
    toks: 结果.toks,
    description: 内核.导出指令文本(结果.toks),
    紧凑串: 内核.紧凑串(结果.toks),
    已评估: 结果.已评估,
    用时秒: (Date.now() - t0) / 1000,
  });
}

// ================= 消息循环 =================
const 装配完成 = 装配();
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.t === '开始') {
    try {
      await 装配完成;
      await 开始搜索(msg.cfg || {});
    } catch (e) {
      postMessage({ t: '失败', reason: (e && e.stack) || String(e) });
    }
  }
};
