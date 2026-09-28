'use strict';
/*
 * 引擎适配层（浏览器/Worker 侧）
 *
 * DebugTools 优化器/引擎适配.js 的 Worker 移植版（本目录其余内核文件与 DebugTools 字节级一致，本文件为浏览器定制件）。
 * 职责一致：把「角色数据 + 多例模拟器引擎 + 引擎源码」封装成一次 createEngine() 调用，供搜索内核/排程器复用。
 *
 * 与 Node 版的差异（其余行为刻意保持同构）：
 * 1. 源码获取从 fs.readFileSync 改为 worker 装配器预取的文本（globalThis.__优化器源，见 优化worker.js）：
 *    characterJson.js / deobfuscated.js / make/autocalc.v3.js / js/header.js 均为站点自有文件的运行时 fetch，
 *    与 DebugTools 侧同源同址，保证口径与官网一致。
 * 2. 机制表消费改为 机制表数据.json（bin 由 DebugTools 优化器/机制表/tools/bin读取器.js 一次性导出，结构与
 *    读取bin 返回值逐字段一致），免去 flatbuffers/flatten_core 运行链。
 * 3. autocalcSrc 尾部追加「lab 口径 start() 覆盖源」（LAB战斗装配覆盖.js）：同作用域后声明覆盖前声明，
 *    使搜索评估的战斗装配（per-char 潜能系数 / li / gboss / ELV / hitAll）与 lab/simulator/simulator.v3.js
 *    的 start() 逐项一致，其余（setDefault/leader/passive/turnstart/do_*）仍走引擎原生路径。
 */
const 源 = globalThis.__优化器源;
if (!源 || !源.characterJson) throw new Error('优化器源未预载：须先执行 优化worker.js 的装配流程');

// ---- 角色数据：new Function 求值 characterJson.js（与 Node 版同法，免 realm 跨界开销）----
let _角色数据 = null;
function 角色数据() {
  if (_角色数据) return _角色数据;
  const mod = new Function(源.characterJson + '\n;return { getCharacter, liberationList, chJSON, eternalList, isValidComp };')();
  _角色数据 = mod;
  return mod;
}

// ---- deps：多例引擎只读依赖（与 Node 版一致）----
let _默认deps = null;
function 构建默认deps() {
  if (_默认deps) return _默认deps;
  const m = 角色数据();
  _默认deps = {
    getCharacter: m.getCharacter,
    liberationList: m.liberationList.slice(),
    t: (s) => s,
    lang: 'ko',
    alert: () => {},
    updateAll: () => {},
  };
  return _默认deps;
}

// ---- 机制表数据（懒载入缓存）：{ version, records, names } ----
let _机制数据 = null;
function 机制数据() {
  if (!_机制数据) _机制数据 = 源.机制表数据;
  return _机制数据;
}

/**
 * 创建一个隔离的模拟器实例（lab 口径战斗装配）。
 * calcSrc 固定为 deobfuscated.js（性能改写版，与线上混淆版逐位一致——DebugTools 自检 40/40 背书）；
 * autocalcSrc = 站点 make/autocalc.v3.js + lab 口径 start() 覆盖源。
 */
function createEngine() {
  const { createSimulator, 提取header片段 } = 模块('多例引擎.js');
  return createSimulator(构建默认deps(), {
    calcSrc: 源.deobfuscated,
    autocalcSrc: 源.autocalc + '\n;\n' + 源.lab覆盖,
    headerFrag: 提取header片段(源.header),
  });
}

// ---- 角色总表与闸门（与 Node 版一致）----
function 角色表() { return 角色数据().chJSON.data; }
function 可模拟SSR清单() {
  return 角色表().filter(c => c && c.ok === true && c.rarity === 3 && c.hp && c.atk);
}
function isValidComp(ids) { return 角色数据().isValidComp(ids); }

// 模块环引用防护：多例引擎.js 由 worker 装载器统一供给（require('./多例引擎.js') 的语义入口）
function 模块(名) { return require('./' + 名); }

module.exports = {
  角色数据, 构建默认deps, 机制数据, createEngine,
  角色表, 可模拟SSR清单, isValidComp,
};
