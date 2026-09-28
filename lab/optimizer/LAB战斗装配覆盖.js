'use strict';
/*
 * LAB 战斗装配覆盖源 —— 以「源文本」形态追加到 autocalc.v3.js 之后注入引擎闭包（不作为模块加载）。
 *
 * 作用：同函数作用域内后声明的 function start() 覆盖 autocalc.v3.js 的 start()，使搜索评估的战斗装配与
 * lab/simulator/simulator.v3.js 的 start()/setElvBuff()/setGboss() 逐项一致——
 *   ① per-char 潜能系数：coef_atk = 조련승수 × atk승수 × 1.25 × elvCoef，coef_hp 同理（lab 的 a_o 公式）；
 *   ② li（首领减益五项）走 autocalc 自带 setBossLi()（读 GLOBAL_OPTION_LIST[3..7]，与 lab 的 liParam 同构）；
 *   ③ ELV 四槽增益按 lab 的 setElvBuff 逐 case 转写（elvOn 时 elvCoef=1.06 已在系数侧生效）；
 *   ④ gboss 两式按 lab 的 setGboss 转写；
 *   ⑤ hitAll 每场重建时写入引擎闭包同名变量。
 * 其余装配（buff_ex 重置 / setDefault / leader / passive / turnstart / 印证 isActed）保持引擎原生路径，
 * 与 DebugTools 自检背书的评估口径完全一致。
 *
 * 配置通道：GLOBAL_OPTION_LIST[8] = {
 *   coefs: [[조련승수, atk승수, hp승수] × 5],
 *   elvOn: boolean, elv: [["v11","v21","v31","v41"] × 5] | null,
 *   gboss: 0 | 1 | 2, hitAll: boolean
 * }（[0..2] 引擎内空闲、[3..7] = li 五项；由 优化worker.js 的 fastReplay 包装层逐场传入。）
 *
 * 本文件文本与 lab 模拟页的对应实现同源同构；改动须两侧同步。
 */

function labSetElvBuff(idx, curList) {
   const e = comp[idx].element, r = comp[idx].role;
   for (const v of curList) {
      switch (v) {
         case "v11":
            if (r == 0) { tbf(comp[idx], "가뎀증", 9, "딜러:데미지+", always); }
            else if (r == 1) tbf(all, "공퍼증", 10, "힐러:전체 공격+", always);
            else if (r == 2) tbf(all, "공고증", comp[idx].hp, "탱커:전체 공격+", 50);
            else if (r == 3) atbf(comp[idx], "공격", all, "공고증", myCurAtk + comp[idx].id + 3, "서포터:전체 공격+", 1, always);
            else nbf(boss, "받뎀증", 6, "디스럽터:데미지+", 1, 5);
            break;
         case "v12":
            if (r == 0) tbf(comp[idx], "공퍼증", 30, "딜러:공격+", always);
            else if (r == 1) ;
            else if (r == 2) ;
            else if (r == 3) tbf(all, "가뎀증", 5.4, "서포터:전체 데미지+", always);
            else ;
            break;
         case "v21": tbf(comp[idx], "공퍼증", 10, "통용:공격+", always); break;
         case "v22": hpUpMe(comp[idx], 10); break;
         case "v31":
            if (e == 0) for (const idx2 of getElementIdx("화")) nbf(comp[idx2], "받속뎀", 3, "화속성:데미지+", 1, 5);
            else if (e == 1) for (const idx2 of getElementIdx("수")) nbf(comp[idx2], "받속뎀", 3, "수속성:데미지+", 1, 5);
            else if (e == 2) for (const idx2 of getElementIdx("풍")) nbf(comp[idx2], "받속뎀", 3, "풍속성:데미지+", 1, 5);
            else if (e == 3) for (const idx2 of getElementIdx("광")) nbf(comp[idx2], "받속뎀", 3, "광속성:데미지+", 1, 5);
            else for (const idx2 of getElementIdx("암")) nbf(comp[idx2], "받속뎀", 3, "암속성:데미지+", 1, 5);
            break;
         case "v32":
            break;
         case "v41":
            if (r == 0) tbf(comp[idx], "궁추가*", 20, "딜러:궁극기 추가 공격+", always);
            else if (r == 1) tbf(all, "가뎀증", 3, "힐러:전체 데미지+", always);
            else if (r == 2) tbf(all, "공퍼증", 5, "탱커:전체 공격+", always);
            else if (r == 3) for (const idx2 of getRoleIdx("딜", "탱", "디"))
               tbf(comp[idx2], "평추가*", 5, "서포터:일반 공격 추가 공격+", always);
            else nbf(boss, "받궁뎀", 5, "디스럽터:궁극기+", 1, 5);
            break;
         case "v42":
            if (r == 0) tbf(comp[idx], "평추가*", 10, "딜러:일반 공격 추가 공격+", always);
            else if (r == 1) ;
            else if (r == 2) ;
            else if (r == 3) for (const idx2 of getRoleIdx("딜", "탱", "디"))
               tbf(comp[idx2], "궁추가*", 10, "서포터:궁극기 추가 공격+", always);
            else nbf(boss, "받일뎀", 7.5, "디스럽터:일반 공격+", 1, 5);
            break;
         case "v43":
            if (r == 0) tbf(comp[idx], "공발동*", 6, "딜러:공격 트리거+", always);
            else if (r == 1) ;
            else if (r == 2) tbf(all, "받아증", 15, "탱커:전체 아머+", always);
            else if (r == 3) for (const idx2 of getRoleIdx("딜", "탱", "디"))
               tbf(comp[idx2], "공발동*", 3, "서포터:공격 트리거+", always);
            else nbf(boss, "받발뎀", 10, "디스럽터:트리거+", 1, 5);
            break;
      }
   }
}

function labSetGboss(gboss) {
   switch (gboss) {
      case 1:
         for (const idx of getRoleIdx("디")) anbf(comp[idx], "궁", boss, "받뎀증", 15, "gboss1", 1, 2, always);
         break;
      case 2:
         anbf(comp[0], "힐", boss, "받뎀증", 0.5, "gboss2", 1, 65, always);
         break;
   }
}

function start(compIds) {
   GLOBAL_TURN = 1; comp = []; dmg13 = 0;
   lastDmg = 0; lastAtvDmg = 0;
   boss.hp = boss.maxHp; boss.def = false;
   boss.buff = []; boss.li = [];
   buff_ex.length = 0;
   buff_ex.push("도트뎀");

   const cfg = (GLOBAL_OPTION_LIST && GLOBAL_OPTION_LIST[8]) || null;
   if (GLOBAL_OPTION_LIST != null) setBossLi();

   hitAll = !(cfg && cfg.hitAll === false);
   const elvOn = !!(cfg && cfg.elvOn);
   const elvCoef = elvOn ? 1.06 : 1;
   let curIdx = 0;
   for (const id of compIds) {
      const tmp = getCharacter(id);
      const _mul = lib_set.has(tmp.name) ? 1.1 : 1.0;
      const k = (cfg && cfg.coefs && cfg.coefs[curIdx]) || [1, 1, 1];
      const coef_atk = k[0] * k[1] * 1.25 * elvCoef;
      const coef_hp = k[0] * k[2] * 1.25 * elvCoef;
      curIdx++;
      comp.push(new Champ(tmp.id, tmp.name,
         tmp.hp * _mul, tmp.atk * _mul, tmp.cd,
         tmp.element, tmp.role, tmp.atkMag, tmp.ultMag,
         coef_hp, coef_atk));
   }
   comp[0].isLeader = true;
   for (let i = 0; i < 5; i++) {
      if (GLOBAL_BOND_LIST[i] < 1 || GLOBAL_BOND_LIST[i] > 5 || typeof GLOBAL_BOND_LIST[i] != 'number') GLOBAL_BOND_LIST[i] = 5;
      comp[i] = setDefault(comp[i], GLOBAL_BOND_LIST[i]);
      if (comp[i] == undefined || comp[i] == null) return 0;
   }
   comp[0].leader();
   for (let i = 0; i < 5; i++) {
      comp[i].passive();
      if (elvOn && cfg.elv) labSetElvBuff(i, cfg.elv[i]);
   }
   if (cfg && cfg.gboss) labSetGboss(cfg.gboss);
   for (let i = 0; i < 5; i++) comp[i].turnstart();
   for (let i = 0; i < 5; i++) if (comp[i].isSealed) comp[i].isActed = true;

   return auto();
}
