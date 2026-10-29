/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 桌宠模块 · 配置读写（落在主 config.json 的 pet 段）
//
// 为什么不让 pet 模块自己维护一份独立配置文件：
//   · 配置面板走的是「整份 config 提交 + 深合并」，pet 单独存会让设置页保存时看不到它；
//   · 框架已有深合并默认值 / 原子写 / 旧配置兼容，这里复用即可，不重复造轮子。
//
// 本模块只做三件事：给默认值、做脏数据归一化（手改 config.json 不得传到窗口与 shader）、落盘。
"use strict";
const config = require("../backend/config.cjs");

/**
 * 默认值：与 docs/桌宠/01-模块契约.md §1 必须逐字一致。
 * electron/backend/config.cjs 的 defaultConfig() 里也有一份同值副本（那边负责首次落盘时的基线），
 * 两份都要改时一起改——这里再次兜底，是因为用户可能手改 config.json 把 pet 段删掉/写脏。
 */
const DEFAULTS = Object.freeze({
  enabled: false,
  theme: "gargantua",
  size: 240,
  diskSpeed: 1,
  lensStrength: 1,
  fxEnabled: true,
  screenSample: true,
  captureFps: 30,
  opacity: 1,
  alwaysOnTop: true,
  clickThrough: true,
  pos: { x: null, y: null },
  rightMenu: {
    optimizePrompt: true,
    tokenUsage: true,
    hide: true,
    resetPosition: true,
    closePet: true,
  },
  optimize: { styleId: "", source: "auto", pasteBack: true, extra: "" },
});

/** 数值钳制：非数字/NaN 一律回默认，越界钳到区间 */
function clampNum(v, min, max, dft) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

function boolOr(v, dft) {
  // 只认显式 true/false；其它（undefined / 字符串 / 0）一律回默认，
  // 避免手改配置写成 "false"（字符串）时被当成真值
  return v === true ? true : v === false ? false : dft;
}

/**
 * 坐标归一化：null / undefined / "" 一律视为「没有存过位置」。
 * ★ 不能直接 Number(v)：Number(null) 是 0 而不是 NaN，会把「没位置」写死成窗口跑到 (0,0)。
 *   这是 position 类配置最经典的坑，务必保留这道判断。
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 脏数据归一化：任何不符合契约的值都收敛到合法域，绝不把脏值传给窗口/GPU */
function normalize(raw) {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rm = p.rightMenu && typeof p.rightMenu === "object" ? p.rightMenu : {};
  const op = p.optimize && typeof p.optimize === "object" ? p.optimize : {};
  const pos = p.pos && typeof p.pos === "object" ? p.pos : {};
  const fps = Number(p.captureFps);
  return {
    enabled: boolOr(p.enabled, DEFAULTS.enabled),
    theme: "gargantua",
    size: Math.round(clampNum(p.size, 120, 720, DEFAULTS.size)),
    // 0 是合法值（"静止"），不能写成 `p.diskSpeed || dft`
    diskSpeed: clampNum(p.diskSpeed === undefined ? DEFAULTS.diskSpeed : p.diskSpeed, 0, 3, DEFAULTS.diskSpeed),
    lensStrength: clampNum(
      p.lensStrength === undefined ? DEFAULTS.lensStrength : p.lensStrength,
      0,
      2.5,
      DEFAULTS.lensStrength,
    ),
    fxEnabled: boolOr(p.fxEnabled, DEFAULTS.fxEnabled),
    screenSample: boolOr(p.screenSample, DEFAULTS.screenSample),
    captureFps: [15, 30, 60].includes(fps) ? fps : DEFAULTS.captureFps,
    opacity: clampNum(p.opacity === undefined ? DEFAULTS.opacity : p.opacity, 0.35, 1, DEFAULTS.opacity),
    alwaysOnTop: boolOr(p.alwaysOnTop, DEFAULTS.alwaysOnTop),
    clickThrough: boolOr(p.clickThrough, DEFAULTS.clickThrough),
    pos: { x: numOrNull(pos.x), y: numOrNull(pos.y) },
    rightMenu: {
      optimizePrompt: boolOr(rm.optimizePrompt, DEFAULTS.rightMenu.optimizePrompt),
      tokenUsage: boolOr(rm.tokenUsage, DEFAULTS.rightMenu.tokenUsage),
      hide: boolOr(rm.hide, DEFAULTS.rightMenu.hide),
      resetPosition: boolOr(rm.resetPosition, DEFAULTS.rightMenu.resetPosition),
      closePet: boolOr(rm.closePet, DEFAULTS.rightMenu.closePet),
    },
    optimize: {
      styleId: String(op.styleId || "").slice(0, 80),
      source: op.source === "clipboard" ? "clipboard" : "auto",
      pasteBack: boolOr(op.pasteBack, DEFAULTS.optimize.pasteBack),
      extra: String(op.extra || "").slice(0, 4000),
    },
  };
}

/** 当前配置（每次读盘后归一化：用户可能刚手改过 config.json） */
function get() {
  try {
    return normalize(config.loadConfig().pet);
  } catch {
    // 读盘异常（损坏/权限）时用默认值兜底——桌宠停用比主进程起不来好
    return normalize(null);
  }
}

/**
 * 局部更新：只接受契约里列出的字段（白名单），其余静默忽略。
 * 设置面板、渲染层缩放、窗口移动三条路径都走这里，保证落盘形状唯一。
 */
function mergePatch(base, patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = normalize(base);
  const scalars = ["enabled", "size", "diskSpeed", "lensStrength", "fxEnabled", "screenSample", "captureFps", "opacity", "alwaysOnTop", "clickThrough"];
  for (const k of scalars) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
  // ★ pos 刻意不收补丁：位置是窗口的运行时状态，只有 pet-window 的 savePosition() 能写。
  //   设置面板保存时会连 pos 一起回传（那是启动时的旧快照，多为 null），收下就会把用户
  //   拖动后的位置清零、下次启动弹回默认位。需要改位置用 resetPosition / 拖动。
  if (p.rightMenu && typeof p.rightMenu === "object") {
    for (const k of Object.keys(DEFAULTS.rightMenu)) {
      if (Object.prototype.hasOwnProperty.call(p.rightMenu, k)) out.rightMenu[k] = p.rightMenu[k];
    }
  }
  if (p.optimize && typeof p.optimize === "object") {
    for (const k of Object.keys(DEFAULTS.optimize)) {
      if (Object.prototype.hasOwnProperty.call(p.optimize, k)) out.optimize[k] = p.optimize[k];
    }
  }
  // 归一化兜底：上面按原值塞进来的脏值（越界/类型错）在这里被收敛
  return normalize(out);
}

/**
 * 保存局部补丁。
 * @param {object} patch
 * @param {{ silent?: boolean }} opts silent 时不返回 message（窗口内部高频写入用）
 */
function patch(patchValue, opts = {}) {
  const disk = config.loadConfig();
  const next = mergePatch(disk.pet, patchValue);
  disk.pet = next;
  config.saveConfig(disk);
  return opts.silent ? next : { ok: true, config: next };
}

/** 只写位置（拖动/缩放节流落盘专用）：避免每次 move 都走整份合并 */
function savePosition(pos) {
  try {
    const disk = config.loadConfig();
    const cur = normalize(disk.pet);
    cur.pos = { x: numOrNull(pos && pos.x), y: numOrNull(pos && pos.y) };
    disk.pet = cur;
    config.saveConfig(disk);
    return true;
  } catch {
    // 记不住位置不该影响任何主流程（与 window-state 同款容错）
    return false;
  }
}

module.exports = { DEFAULTS, normalize, get, patch, mergePatch, savePosition };
