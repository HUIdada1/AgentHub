/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 桌宠模块 · 入口（main.cjs 只调 boot / shutdown / reloadConfig 三个函数）
//
// 设计原则：
//   · 主进程侧不反向依赖 pet 模块：所有宿主能力（今日用量、通知、日志、格式化）都由 boot 注入；
//   · 桌宠「关掉」= 销毁窗口 + 总开关 false，不残留定时器/采样流/进程；
//   · 任何一步失败都只让桌宠不可用，绝不抛到 main.cjs 的启动链上（那会让整个应用起不来）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const config = require("../backend/config.cjs");
const petConfig = require("./pet-config.cjs");
const petWindow = require("./pet-window.cjs");
const petCapture = require("./pet-capture.cjs");
const petMenu = require("./pet-menu.cjs");
const petActions = require("./pet-actions.cjs");
const petInput = require("./pet-input.cjs");
const petIpc = require("./pet-ipc.cjs");

const WEB_DIR = path.join(__dirname, "web");
const PRELOAD = path.join(__dirname, "preload-pet.cjs");

let started = false;
let logFile = "";
/** 宿主注入的能力 */
const host = {
  usageTodaySummary: () => null,
  formatNum: (n) => String(n),
  notify: null,
};

// ===== 日志（独立 pet.log，不污染主进程的 crash.log）=====
function setupLog() {
  try {
    const dir = path.join(config.dataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "pet.log");
    // 简单轮转：超过 512KB 就换名，只保留一份历史
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".1");
    } catch {
      /* 文件还不存在 */
    }
    logFile = file;
  } catch {
    logFile = "";
  }
}

function log(kind, detail) {
  if (!logFile) return;
  try {
    const line = `[${new Date().toISOString()}] ${kind} :: ${String(detail == null ? "" : detail).slice(0, 2000)}\n`;
    fs.appendFileSync(logFile, line, "utf8");
  } catch {
    /* 日志写不进去不该影响功能 */
  }
}

// ===== 主窗口广播（设置页要即时反映右键菜单造成的改动）=====
function broadcastMain(cfg) {
  try {
    const own = petWindow.getWindow();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w || w.isDestroyed()) continue;
      if (own && w === own) continue; // 桌宠窗口走 pet:event，不走 app:event
      w.webContents.send("app:event", { event: "pet-config-changed", config: cfg });
    }
  } catch {
    /* 无窗口时忽略 */
  }
}

// ===== 窗口创建 / 应用配置 =====
/** 调试旁路：本地验证/截图时跳过「窗口不参与屏幕捕获」的守卫（否则全屏截图里看不到桌宠） */
const SKIP_CAPTURE_GUARD = process.env.AGENTHUB_PET_NO_CAPTURE_GUARD === "1";

function createWindow(cfg) {
  try {
    petWindow.create(
      {
        webDir: WEB_DIR,
        preload: PRELOAD,
        log,
        skipContentProtection: SKIP_CAPTURE_GUARD,
        onCrash: (detail) => {
          log("render-crash", JSON.stringify(detail || {}));
          host.notify && host.notify("卡冈图雅", "桌宠渲染进程异常退出，已自动关闭。可在「设置 · 桌宠组件」重新开启");
          // 崩溃后把总开关置 false，避免设置页显示"已开启"却没有窗口
          try { petConfig.patch({ enabled: false }, { silent: true }); } catch { /* 忽略 */ }
        },
      },
      cfg,
    );
    petWindow.hookDisplayChanges();
  } catch (e) {
    log("create-failed", String((e && e.message) || e));
  }
}

function applyConfig(cfg) {
  try {
    if (cfg.enabled) {
      if (!petWindow.alive()) createWindow(cfg);
      else petWindow.applyConfig(cfg);
    } else if (petWindow.alive()) {
      petWindow.destroy("disabled");
    }
  } catch (e) {
    log("apply-config-failed", String((e && e.message) || e));
  }
}

/** 从磁盘重读并应用（主窗口保存设置 / 托盘改动配置后调用） */
function reloadConfig() {
  let cfg;
  try {
    cfg = petConfig.get();
  } catch (e) {
    log("reload-failed", String((e && e.message) || e));
    return;
  }
  applyConfig(cfg);
  // 设置面板保存的是整份 config，其中的 pet.pos 是启动旧快照（多为 null）：
  // 窗口还活着就以实际 bounds 覆盖回去，否则下次启动会弹回默认位。
  if (petWindow.alive()) {
    petWindow.persistPosition();
    try { cfg = petConfig.get(); } catch { /* 读失败就用内存里的这份 */ }
  }
  broadcastMain(cfg);
  return cfg;
}

// ===== 前台窗口跟踪（给「优化提示词」用）=====
// 为什么要轮询而不是在弹菜单时取一次：右键桌宠时焦点会落到桌宠窗口，
// 那一刻 GetForegroundWindow 已经是自己了，取到的句柄会让我们把 Ctrl+C 发给自己。
// 所以后台每秒采一次，忽略自身句柄，留下「用户真正在用的那个窗口」。
let fgTimer = null;
let lastForeignHwnd = null;

function ownNativeHandle() {
  const w = petWindow.getWindow();
  if (!w) return null;
  try {
    return w.getNativeWindowHandle().readBigUInt64LE(0);
  } catch {
    return null;
  }
}

function startForegroundTracking() {
  if (fgTimer) return;
  if (!petInput.available()) {
    log("input-unavailable", petInput.unavailableReason());
    return;
  }
  fgTimer = setInterval(() => {
    try {
      const h = petInput.getForeground();
      if (h == null) return;
      const own = ownNativeHandle();
      if (own != null && String(h) === String(own)) return;
      lastForeignHwnd = h;
    } catch {
      /* 忽略单次采样失败 */
    }
  }, 1000);
  fgTimer.unref && fgTimer.unref();
}

function currentTargetHwnd() {
  // 最近一次采样仍有效就用它；否则现场取一次。
  // 现场取到的可能就是桌宠自己（右键把焦点抢过来了）——那种情况返回 null，
  // 让上层走「剪贴板兜底」，而不是把 Ctrl+A/C 发给自己。
  if (lastForeignHwnd != null && petInput.isWindow(lastForeignHwnd)) return lastForeignHwnd;
  const fg = petInput.getForeground();
  if (fg == null) return null;
  const own = ownNativeHandle();
  if (own != null && String(fg) === String(own)) return null;
  return fg;
}

// ===== 主窗口侧（设置面板）能力 =====
function status() {
  const cfg = petConfig.get();
  return {
    ok: true,
    config: cfg,
    visible: petWindow.isVisible(),
    windowReady: petWindow.alive(),
    screenSampleSupported: true,
    version: app.getVersion(),
  };
}

function saveConfig(patchValue) {
  if (!patchValue || typeof patchValue !== "object") {
    return { ok: false, message: "缺少配置补丁" };
  }
  const next = petConfig.patch(patchValue, { silent: true });
  applyConfig(next);
  broadcastMain(next);
  return { ok: true, config: next };
}

function setEnabled(enabled) {
  try {
    const next = petConfig.patch({ enabled: !!enabled }, { silent: true });
    applyConfig(next);
    broadcastMain(next);
    return { ok: true, visible: petWindow.isVisible(), config: next };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), visible: petWindow.isVisible() };
  }
}

function resetPosition() {
  const r = petWindow.resetPosition();
  if (r && r.ok) broadcastMain(petConfig.get());
  return r || { ok: false, message: "窗口不存在" };
}

function usageToday() {
  return petActions.usageToday();
}

function optimizePreview() {
  return petActions.optimizePreview();
}

// ===== 桌宠窗口侧的聚合通道 =====
const petHooks = {
  isSender(event) {
    const w = petWindow.getWindow();
    return !!(w && event && event.sender === w.webContents);
  },
  ipc(type, payload) {
    switch (type) {
      case "set-interactive":
        petWindow.setInteractive(!!payload.interactive);
        break;
      case "drag-start":
        petWindow.startDrag();
        break;
      case "drag-end":
        petWindow.endDrag();
        break;
      case "context-menu":
        popupMenu(payload);
        break;
      case "hide":
        doHide();
        break;
      case "close":
        doClose();
        break;
      case "reset-position":
        resetPosition();
        break;
      case "log":
        log(`render/${String(payload.kind || "info")}`, payload.detail || "");
        break;
      default:
        break;
    }
  },
  async rpc(type, payload) {
    switch (type) {
      case "boot":
        return bootInfo();
      case "patch": {
        const next = petConfig.patch(payload.patch, { silent: true });
        applyConfig(next);
        broadcastMain(next);
        return { ok: true, config: next };
      }
      case "usage-today":
        return petActions.usageToday();
      case "capture-source": {
        const geo = petWindow.geometry();
        return petCapture.getScreenSource({ windowBounds: geo ? geo.bounds : null });
      }
      default:
        return { ok: false, message: `未知的桌宠调用：${type}` };
    }
  },
};

function popupMenu(payload) {
  const w = petWindow.getWindow();
  if (!w) return;
  petWindow.setInteractive(true);
  petMenu.popup(w, {
    x: payload && payload.x,
    y: payload && payload.y,
    hwnd: currentTargetHwnd(),
  });
}

function doHide() {
  if (petWindow.hide()) broadcastMain(petConfig.get());
}

function doClose() {
  // 「关闭桌宠」= 总开关置 false（与设置面板的开关同一语义），下次可在设置里重新开启
  setEnabled(false);
}

/** 渲染层初始化信息：窗口几何 + 显示器 + 配置（见契约 §3） */
function bootInfo() {
  const cfg = petConfig.get();
  const geo = petWindow.geometry();
  const bounds = geo ? geo.bounds : { x: 0, y: 0, width: cfg.size, height: cfg.size };
  const display = geo && geo.display
    ? { id: geo.display.id, bounds: geo.display.bounds, scaleFactor: geo.display.scaleFactor, workArea: geo.display.workArea }
    : { id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  return {
    ok: true,
    config: cfg,
    bounds,
    display,
    screenSampleSupported: true,
    appVersion: app.getVersion(),
  };
}

// ===== 生命周期 =====
/**
 * 启动桌宠模块。
 * @param {{
 *   ipcMain: Electron.IpcMain,
 *   usageTodaySummary?: () => number|null,
 *   formatNum?: (n:number)=>string,
 *   notify?: (title:string, body:string)=>void
 * }} opts
 */
function boot(opts = {}) {
  if (started) return { ok: true, alreadyStarted: true };
  started = true;
  setupLog();
  if (typeof opts.usageTodaySummary === "function") host.usageTodaySummary = opts.usageTodaySummary;
  if (typeof opts.formatNum === "function") host.formatNum = opts.formatNum;
  if (typeof opts.notify === "function") host.notify = opts.notify;

  petActions.setContext({
    log,
    usageTodaySummary: () => host.usageTodaySummary(),
    formatNum: (n) => host.formatNum(n),
    notify: host.notify,
    pushEvent: (p) => {
      const w = petWindow.getWindow();
      if (!w) return;
      try { w.webContents.send("pet:event", p); } catch { /* 未就绪 */ }
    },
    hide: doHide,
    closePet: doClose,
    resetPosition,
    broadcastConfig: (cfg) => broadcastMain(cfg),
  });
  petMenu.setApplyConfig((next) => {
    applyConfig(next);
    broadcastMain(next);
  });

  try {
    petIpc.register(opts.ipcMain, {
      mainHooks: { status, saveConfig, setEnabled, resetPosition, usageToday, optimizePreview },
      petHooks,
    });
  } catch (e) {
    // IPC 注册失败（重复注册 / ipcMain 未就绪）：桌宠整体不可用，但不影响主程序
    log("ipc-register-failed", String((e && e.message) || e));
    started = false;
    return { ok: false, message: String((e && e.message) || e) };
  }

  startForegroundTracking();
  const cfg = petConfig.get();
  applyConfig(cfg);
  const enabled = !!cfg.enabled;
  log("boot", `enabled=${enabled} size=${cfg.size} fx=${cfg.fxEnabled} sample=${cfg.screenSample} input=${petInput.available()}`);
  // 调试快照：AGENTHUB_PET_SNAPSHOT=<png 绝对路径> 时，启动 N 毫秒后抓一张窗口自身内容。
  // 用途：多屏 / 混合 DPI / 全屏截图抓不到透明置顶窗时，直接验证渲染是否正确（带 alpha）。
  scheduleSnapshot();
  return { ok: true, enabled };
}

let snapshotTimer = null;
function scheduleSnapshot() {
  const target = process.env.AGENTHUB_PET_SNAPSHOT;
  if (!target) return;
  const delay = Math.max(500, Number(process.env.AGENTHUB_PET_SNAPSHOT_DELAY) || 5000);
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    const w = petWindow.getWindow();
    if (!w) return;
    try {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(target, img.toPNG());
      const g = petWindow.geometry();
      log("snapshot", `${target} bounds=${g ? JSON.stringify(g.bounds) : "n/a"}`);
    } catch (e) {
      log("snapshot-failed", String((e && e.message) || e));
    }
  }, delay);
  snapshotTimer.unref && snapshotTimer.unref();
}

function shutdown() {
  if (fgTimer) {
    clearInterval(fgTimer);
    fgTimer = null;
  }
  lastForeignHwnd = null;
  try {
    petWindow.destroy("shutdown");
  } catch {
    /* 忽略 */
  }
  log("shutdown", "");
  started = false;
}

module.exports = {
  boot,
  shutdown,
  reloadConfig,
  status,
  saveConfig,
  setEnabled,
  resetPosition,
  usageToday,
  optimizePreview,
  // 供调试 / 自测脚本直接调用
  _internals: { bootInfo, petConfig },
};
