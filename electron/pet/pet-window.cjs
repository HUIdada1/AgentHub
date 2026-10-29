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
// 桌宠模块 · 悬浮窗（创建 / 置顶 / 点击穿透 / 拖拽 / 缩放 / 位置持久化）
//
// 几个关键取舍（都是踩过的坑，改之前先读完）：
//  1. **拖拽不能用 CSS -webkit-app-region: drag**：该区域在 setIgnoreMouseEvents(true) 下收不到事件，
//     且透明窗叠加 drag region 时 Windows 会漏掉 mousemove。改为「渲染层 mousedown 报位 → 主进程
//     16ms 轮询 screen.getCursorScreenPoint() 移动窗口 → mouseup 收尾」，跟手且不经过 IPC 回环。
//  2. **必须 setContentProtection(true)**：桌宠要采样它背后的屏幕画面，若不把自己排除在捕获之外，
//     desktopCapturer 会把桌宠自己也拍进去 → 黑洞里递归出现下一个黑洞（无限镜像）。
//     Windows 上是 WDA_EXCLUDEFROMCAPTURE，副作用是该窗口也不会出现在用户截图/录屏里。
//  3. **缩放保持中心**：改 size 时按中心重算左上角，否则用户会觉得黑洞"往右下角跑"。
//  4. **位置落盘节流 400ms**：与主窗口 window-state 同款，拖动时 move 会高频触发。
"use strict";
const path = require("node:path");
const { BrowserWindow, screen } = require("electron");
const petConfig = require("./pet-config.cjs");

/** 当前桌宠窗口（模块级单例；销毁后置 null） */
let win = null;
/** 创建时注入的上下文（preload 路径 / web 目录 / 右键菜单回调 / 日志） */
let ctx = null;
/** 拖拽状态：起点光标 + 起点窗口位置 + 轮询定时器 */
let drag = null;
/** 位置落盘定时器 */
let saveTimer = null;
/** 最近一次应用的配置（applyConfig 幂等判断用） */
let lastApplied = null;
/** 渲染层当前是否处于「盘面热区内可交互」态（clickThrough=false 时不参与判定） */
let interactive = false;

const DRAG_INTERVAL_MS = 16; // ≈60fps；再快也超不过光标回报率，只是白烧 CPU

function log(kind, detail) {
  try {
    if (ctx && typeof ctx.log === "function") ctx.log(`pet-window/${kind}`, detail);
  } catch {
    /* 日志失败不影响窗口 */
  }
}

function alive() {
  return !!win && !win.isDestroyed();
}

/** 窗口所在显示器（拿不到时退回主显示器，避免透明窗口建在 (0,0) 这种诡异位置） */
function displayFor(cfg) {
  try {
    if (cfg && cfg.pos && Number.isFinite(cfg.pos.x) && Number.isFinite(cfg.pos.y)) {
      const cx = cfg.pos.x + cfg.size / 2;
      const cy = cfg.pos.y + cfg.size / 2;
      return screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
    }
  } catch {
    /* 多屏热插拔竞态 */
  }
  try {
    return screen.getPrimaryDisplay();
  } catch {
    return null;
  }
}

/** 默认位置：主显示器工作区右下角，留 40px 边距（避开任务栏） */
function defaultPosition(cfg) {
  const d = displayFor(cfg);
  const wa = (d && d.workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    x: Math.round(wa.x + wa.width - cfg.size - 40),
    y: Math.round(wa.y + wa.height - cfg.size - 40),
  };
}

/** 把窗口位置收敛到某个显示器的可见工作区内（显示器拔掉后旧坐标会落到不存在的屏上） */
function clampToNearestDisplay(pos, size) {
  let d = null;
  try {
    d = screen.getDisplayNearestPoint({ x: Math.round(pos.x + size / 2), y: Math.round(pos.y + size / 2) });
  } catch {
    return pos;
  }
  if (!d) return pos;
  const wa = d.workArea;
  // 允许 1/3 露在屏幕外（用户可能就想让它半挂在边上），但不允许整块飘出去
  const minX = wa.x - size * 0.66;
  const maxX = wa.x + wa.width - size * 0.34;
  const minY = wa.y - size * 0.66;
  const maxY = wa.y + wa.height - size * 0.34;
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, pos.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, pos.y))),
  };
}

/** 解析初始 bounds：优先上次位置；没有或落空则用默认位置 */
function resolveBounds(cfg) {
  const hasPos = cfg.pos && Number.isFinite(cfg.pos.x) && Number.isFinite(cfg.pos.y);
  const raw = hasPos ? { x: cfg.pos.x, y: cfg.pos.y } : defaultPosition(cfg);
  const pos = clampToNearestDisplay(raw, cfg.size);
  const out = { x: pos.x, y: pos.y, width: cfg.size, height: cfg.size };
  // 位置算错时窗口会"自己跑到 (0,0)"或干脆不显示，这里留痕便于定位
  log("resolve-bounds", `hasPos=${hasPos} raw=${JSON.stringify(raw)} size=${cfg.size} out=${JSON.stringify(out)}`);
  return out;
}

/** 位置节流落盘（move / resize 都会调） */
function scheduleSavePosition() {
  if (!alive()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!alive()) return;
    try {
      const b = win.getBounds();
      petConfig.savePosition({ x: b.x, y: b.y });
    } catch {
      /* 窗口正在销毁：忽略 */
    }
  }, 400);
}

/** 发送配置变更事件给桌宠渲染层（窗口还没加载完时 send 会丢，渲染层 boot 会再拉一次全量） */
function pushEvent(payload) {
  if (!alive()) return;
  try {
    win.webContents.send("pet:event", payload);
  } catch {
    /* 页面还没 ready 或无 webContents：忽略 */
  }
}

function pushConfig(config) {
  pushEvent({ event: "config-changed", config });
}

/**
 * 创建桌宠窗口。
 * @param {{ log?: Function, onContextMenu?: Function, webDir: string, preload: string }} context
 * @param {object} config pet 配置（已归一化）
 */
function create(context, config) {
  ctx = Object.assign({}, ctx, context);
  if (alive()) return win;
  lastApplied = config;
  const bounds = resolveBounds(config);

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    // 桌宠是桌面装饰，不该在任务栏 / Alt+Tab / 窗口标题里带出「AgentHub · 卡冈图雅」这种品牌串。
    // 标题留空 + type: "toolbar"（Windows 上按工具窗处理，不进 Alt+Tab）+ skipTaskbar。
    title: "",
    type: "toolbar",
    // 悬浮桌宠的三个硬要求：无边框 / 透明 / 不占任务栏
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 画布底色必须全透明：否则透明区域会铺一层黑，桌宠就变成"黑方块"
    backgroundColor: "#00000000",
    show: false,
    // 不允许被主窗口的 zoom 影响到（否则桌宠在不同 DPI 下缩放比会漂）
    webPreferences: {
      preload: ctx.preload,
      contextIsolation: true,
      nodeIntegration: false,
      // 透明窗 + 定时器：默认的 backgroundThrottling 会在窗口失焦时把 rAF/定时器压到 1fps，
      // 表现为"点一下别的窗口，桌宠就不转了"
      backgroundThrottling: false,
      // 桌宠页面是纯本地静态资源，唯一的外部能力是 preload 暴露的 petHost
      sandbox: false,
      spellcheck: false,
    },
  });

  // 置顶：用 floating 级别而不是 screen-saver —— 后者会盖在全屏游戏/演示之上，
  // 桌宠的定位是"桌面装饰"，不该抢占全屏内容的层级
  try {
    win.setAlwaysOnTop(!!config.alwaysOnTop, "floating");
  } catch {
    /* 某些窗口管理器（Linux）不支持级别参数 */
  }
  // 显式再关一次任务栏图标与标题：部分 Windows 版本会在首次 show 时回填标题
  try { win.setSkipTaskbar(true); } catch { /* 忽略 */ }
  try { win.setTitle(""); } catch { /* 忽略 */ }
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  } catch {
    /* Windows 无工作区概念 */
  }
  // 见文件头第 2 条：把自己排除在屏幕捕获之外，否则黑洞会递归采样自己
  // 调试旁路：AGENTHUB_PET_NO_CAPTURE_GUARD=1 时跳过（验证/截图时才能看见桌宠本身），
  // 生产环境绝不设这个变量 —— 跳过会让黑洞采样到自己，出现"镜中镜"递归
  if (!(ctx && ctx.skipContentProtection)) {
    try {
      win.setContentProtection(true);
    } catch (e) {
      log("content-protection-failed", String((e && e.message) || e));
    }
  }
  // 鼠标模式：clickThrough=true（默认）时只有盘面热区可交互，其余透明区域穿透到桌面；
  // clickThrough=false 时整窗接收鼠标（调试布局 / 想整块拖拽时用）。
  // 两种状态都由 applyMouseMode 统一出口决定，避免「设置里关了穿透、渲染层又把窗口设回穿透」互相覆盖。
  interactive = false;
  applyMouseMode();

  // 不透明度**只**由渲染层的 shader alpha（与 2D 降级的 globalAlpha）负责：
  // 透明窗在 Windows 上本身就是分层窗，再调 setOpacity 会与画布 alpha 相乘（0.5 → 0.25），
  // 用户看到的比滑块标的暗一半。这里刻意不调。

  win.loadFile(path.join(ctx.webDir, "index.html"));

  // 首帧就绪再显示，避免"先闪一个空黑方块再出现黑洞"
  let revealed = false;
  const reveal = () => {
    if (revealed || !alive()) return;
    revealed = true;
    try { win.showInactive(); } catch { win.show(); }
  };
  win.once("ready-to-show", reveal);
  win.webContents.once("did-finish-load", () => {
    reveal();
    // 页面 <title> 在加载完成后会回填窗口标题，这里再清一次：
    // 桌宠是桌面装饰，任务栏/Alt+Tab/悬停提示里都不该出现「平台名 · 桌宠名」
    try { win.setTitle(""); } catch { /* 窗口已销毁 */ }
  });

  // 位置 / 尺寸变化记账
  win.on("move", scheduleSavePosition);
  win.on("resize", scheduleSavePosition);
  win.on("closed", () => {
    win = null;
    lastApplied = null;
    if (drag) endDrag();
  });

  // 渲染进程崩溃：不留一个"看不见的黑洞占着屏幕"（透明窗口看不到但仍在，用户以为是卡死）
  win.webContents.on("render-process-gone", (_e, d) => {
    log("render-gone", JSON.stringify(d || {}));
    destroy("render-gone");
    if (ctx && typeof ctx.onCrash === "function") ctx.onCrash(d);
  });

  return win;
}

/** 应用一份新配置（幂等：值没变的分支不重复调用系统 API） */
function applyConfig(config) {
  if (!alive()) return;
  const prev = lastApplied || {};
  lastApplied = config;
  try {
    if (config.size !== prev.size) {
      // 保持中心缩放
      const b = win.getBounds();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const size = config.size;
      const next = clampToNearestDisplay({ x: Math.round(cx - size / 2), y: Math.round(cy - size / 2) }, size);
      win.setBounds({ x: next.x, y: next.y, width: size, height: size });
    }
    if (config.alwaysOnTop !== prev.alwaysOnTop) {
      win.setAlwaysOnTop(!!config.alwaysOnTop, "floating");
    }
    if (config.clickThrough !== prev.clickThrough) {
      // 关掉穿透时清掉热区态：否则渲染层之后的一次 mouseleave 会把窗口又设回穿透
      if (config.clickThrough === false) interactive = false;
      applyMouseMode();
    }
  } catch (e) {
    log("apply-config-failed", String((e && e.message) || e));
  }
  pushConfig(config);
}

/** 当前配置是否要求「仅热区可交互」（clickThrough=true 即默认行为） */
function isClickThrough() {
  return !lastApplied || lastApplied.clickThrough !== false;
}

/** 鼠标穿透的唯一出口：create / applyConfig / setInteractive 都走它，不各写一份 */
function applyMouseMode() {
  if (!alive()) return;
  const ignore = isClickThrough() ? !interactive : false;
  try {
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  } catch (e) {
    log("ignore-mouse-failed", String((e && e.message) || e));
  }
}

function setInteractive(on) {
  if (!alive()) return;
  const next = !!on;
  if (next === interactive) return;
  interactive = next;
  applyMouseMode();
}

function isInteractive() {
  return interactive;
}

/** 拖拽开始：记下光标与窗口起点，起轮询 */
function startDrag() {
  if (!alive() || drag) return;
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return;
  }
  let b;
  try {
    b = win.getBounds();
  } catch {
    return;
  }
  drag = {
    cursorX: Math.round(cursor.x),
    cursorY: Math.round(cursor.y),
    winX: b.x,
    winY: b.y,
    timer: null,
  };
  drag.timer = setInterval(() => {
    if (!alive() || !drag) return;
    let c;
    try {
      c = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    const nx = drag.winX + (Math.round(c.x) - drag.cursorX);
    const ny = drag.winY + (Math.round(c.y) - drag.cursorY);
    try {
      win.setPosition(nx, ny);
    } catch {
      /* 窗口已销毁 */
    }
  }, DRAG_INTERVAL_MS);
}

/** 拖拽结束：停轮询 + 收敛到最近显示器 + 落盘 */
function endDrag() {
  if (!drag) return;
  if (drag.timer) clearInterval(drag.timer);
  drag = null;
  if (!alive()) return;
  try {
    const b = win.getBounds();
    const next = clampToNearestDisplay({ x: b.x, y: b.y }, b.width);
    if (next.x !== b.x || next.y !== b.y) win.setPosition(next.x, next.y);
  } catch {
    /* 忽略 */
  }
  scheduleSavePosition();
}

/** 重置位置到主屏右下角 */
function resetPosition() {
  if (!alive()) return { ok: false, message: "桌宠窗口不存在" };
  const cfg = petConfig.get();
  const pos = defaultPosition(cfg);
  try {
    win.setPosition(pos.x, pos.y);
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  petConfig.savePosition(pos);
  return { ok: true };
}

/** 把窗口当前实际位置写回配置。
 *  为什么需要：设置面板保存的是「整份 config」，其中的 pet.pos 往往是启动时的旧快照（或 null），
 *  直接落盘会把用户拖动后的位置冲掉；主进程每次整份保存后调一次本函数就能纠正回来。 */
function persistPosition() {
  if (!alive()) return false;
  try {
    const b = win.getBounds();
    return petConfig.savePosition({ x: b.x, y: b.y });
  } catch {
    return false;
  }
}

/** 窗口可见性（隐藏 ≠ 不存在：右键「隐藏」只 hide，设置页的「显示桌宠」能把它唤回） */
function isVisible() {
  if (!alive()) return false;
  try {
    return win.isVisible();
  } catch {
    return false;
  }
}

function show() {
  if (!alive()) return false;
  try {
    win.showInactive();
    win.setAlwaysOnTop(!!(lastApplied && lastApplied.alwaysOnTop), "floating");
    pushEvent({ event: "shown" });
    return true;
  } catch {
    return false;
  }
}

function hide() {
  if (!alive()) return false;
  try {
    win.hide();
    pushEvent({ event: "hidden" });
    return true;
  } catch {
    return false;
  }
}

/** 销毁窗口（关闭桌宠 / 退出应用 / 渲染崩溃收尾） */
function destroy(reason) {
  const w = win;
  win = null;
  lastApplied = null;
  interactive = false;
  if (drag) {
    if (drag.timer) clearInterval(drag.timer);
    drag = null;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!w || w.isDestroyed()) return false;
  try {
    w.destroy();
  } catch {
    /* 已销毁 */
  }
  log("destroyed", String(reason || ""));
  return true;
}

/** 窗口几何信息（给渲染层 boot / 屏幕 uv 映射用） */
function geometry() {
  if (!alive()) return null;
  try {
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    return { bounds: b, display: d ? { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, workArea: d.workArea } : null };
  } catch {
    return null;
  }
}

// ===== 显示器变化：窗口别飘到已经不存在的屏上 =====
let displayHooked = false;
function hookDisplayChanges() {
  if (displayHooked) return;
  displayHooked = true;
  const reflow = () => {
    if (!alive()) return;
    try {
      const b = win.getBounds();
      const next = clampToNearestDisplay({ x: b.x, y: b.y }, b.width);
      if (next.x !== b.x || next.y !== b.y) {
        win.setPosition(next.x, next.y);
        scheduleSavePosition();
      }
      // 分辨率变化会让 scaleFactor 变：通知渲染层重算 dpr 与屏幕 uv 映射
      pushEvent({ event: "config-changed", config: petConfig.get() });
    } catch {
      /* 忽略 */
    }
  };
  try {
    screen.on("display-removed", reflow);
    screen.on("display-added", reflow);
    screen.on("display-metrics-changed", reflow);
  } catch (e) {
    log("display-hook-failed", String((e && e.message) || e));
  }
}

module.exports = {
  create,
  destroy,
  show,
  hide,
  isVisible,
  resetPosition,
  persistPosition,
  applyConfig,
  setInteractive,
  isInteractive,
  startDrag,
  endDrag,
  geometry,
  hookDisplayChanges,
  pushConfig,
  alive,
  getWindow: () => (alive() ? win : null),
};
