/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Electron 主进程入口：窗口 / 托盘 / 单实例 / 主题同步 / 全局大小自适应
// 技能仓库后台能力：定时 WebDAV 同步调度、自动感知收纳、软件自更新
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, nativeTheme, Notification, globalShortcut } = require("electron");

// ===== 闪退取证（本地补丁 __agenthubCrashTrace）=====
// 1.42.0 出现静默退出：Windows 无 Application Error 事件、无 minidump、应用自身零日志，
// 只能靠重启时间戳反推。这里把 JS 异常 / 子进程死亡 / 退出原因全部落到 userData/logs/crash.log，
// 并启用本地 crashpad（只落盘不上传）——原生崩溃会留下 minidump，debug.log 的 "not connected" 噪音随之消失。
const { crashReporter } = require("electron");
// 行写入与截断逻辑抽到 backend/crashlog.cjs：backend 模块（如会话流水 worker 的父进程侧）
// 也要写同一份取证日志——child-process-gone 不覆盖 node 子进程，那边必须自行落痕
const __crashlog = require("./backend/crashlog.cjs");
let __crashCount = 0;
// 顶层 require 链完成前，任何未捕获异常都意味着模块图不完整：后续 whenReady/建窗不会执行，
// 继续活着只会变成「无窗口僵尸」。启动阶段用它区分「真崩溃」与「可降级的运行时异常」。
let bootPhase = "requires";
const MB = 1024 * 1024;
function memUsage() {
  const m = process.memoryUsage();
  return `rss=${Math.round(m.rss / MB)}MB heap=${Math.round(m.heapUsed / MB)}MB ext=${Math.round(m.external / MB)}MB`;
}
function crashLogFile() {
  return path.join(process.env.APPDATA || app.getPath("appData"), "AgentHub", "logs", "crash.log");
}
function __crashLog(kind, detail) {
  if (__crashCount > 50) return;
  __crashCount++;
  __crashlog.write(kind, detail);
}
function __describe(e) {
  if (e instanceof Error) return `${e.name}: ${e.message} :: ${String(e.stack || "").replace(/\s+/g, " ").slice(0, 1200)}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}
try { crashReporter.start({ uploadToServer: false, submitURL: "" }); } catch { /* 无 crashReporter 则仅失去 dump 能力 */ }
// 启动留痕：放在 whenReady 里，确保 app.setName 之后再取 userData（否则会落到错误目录）
app.whenReady().then(() => {
  try { __crashLog("boot", `v${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} ${memUsage()}`); } catch { /* 忽略 */ }
  // 休眠唤醒守卫：注册 powerMonitor 的 suspend/resume，供各周期任务判断「是否刚唤醒」
  // （避免唤醒瞬间签到 + 额度刷新 + 记忆中枢任务集中爆发，见 backend/wakeGuard.cjs）。
  // 事件同时写入 crash.log——Windows Modern Standby 是否派发 resume 尚无定论，
  // 留痕后下次实际睡眠即可在日志里核实该守卫是否真的生效。
  try {
    const wk = require("./backend/wakeGuard.cjs");
    wk.start({ powerMonitor: require("electron").powerMonitor, log: __crashLog });
  } catch (e) { __crashLog("wake-guard-failed", __describe(e)); }
});
// 捕获而非退出：托盘常驻的反代网关被别的工具依赖，宁可降级活着也要把根因留痕（每次运行最多记 50 条）
process.on("uncaughtException", (e) => {
  __crashLog("uncaughtException", __describe(e));
  // 启动阶段（顶层 require）失败时后续 whenReady/建窗都不会执行：明确弹窗并退出，
  // 避免用户看到「双击没反应/一闪而过」却拿不到任何信息。
  if (bootPhase === "requires") {
    try {
      require("electron").dialog.showErrorBox("AgentHub 启动失败", `原生组件加载失败：${(e && e.message) || e}\n日志：${crashLogFile()}`);
    } catch { /* 无 GUI 时只退出 */ }
    app.exit(1);
  }
});
process.on("unhandledRejection", (r) => __crashLog("unhandledRejection", __describe(r)));
process.on("exit", (code) => {
  let sync = "n/a";
  try { sync = require("./backend/webdav.cjs").syncBusyTag() || "idle"; } catch { /* 模块未加载 */ }
  __crashLog("exit", `code=${code} uptime=${Math.round(process.uptime())}s ${memUsage()} sync=${sync}`);
});
app.on("child-process-gone", (_e, d) => __crashLog("child-process-gone", __describe(d)));
app.on("render-process-gone", (_e, _wc, d) => __crashLog("render-process-gone", __describe(d)));
app.on("gpu-process-gone", (_e, d) => __crashLog("gpu-process-gone", __describe(d)));
app.on("before-quit", () => { let p = "n/a"; try { p = String(updater.pendingInstall()); } catch { /* updater 尚未就绪 */ } __crashLog("before-quit", `pendingInstall=${p}`); });
app.on("quit", (_e, code) => { __crashLog("quit", `exitCode=${code}`); try { updater.spawnAtQuit(); } catch { /* 退出不被更新失败阻断 */ } });
// 渲染进程无响应取证：界面「卡死/未响应」不崩溃、不退出，此前零痕迹（2026-10-05 卡死排查实证——
// crashpad 25 个 dump 全来自 node 子进程，渲染进程冻结无一字留痕）。unresponsive/responsive 成对
// 落盘，与同期的 worker/同步日志对齐即可定位因果；Chromium 的挂起检测有去重，不会刷屏。
app.on("browser-window-created", (_e, win) => {
  const wc = win && win.webContents;
  if (!wc) return;
  wc.on("unresponsive", () => { let u = ""; try { u = String(wc.getURL()).slice(0, 200); } catch { /* 已销毁 */ } __crashLog("render-unresponsive", `url=${u}`); });
  wc.on("responsive", () => __crashLog("render-responsive", ""));
});
// 内存高水位留痕（issue #146 猜想 3）：只在 RSS 超过 1.5GB 且继续增长 512MB 时记一条，
// 避免占满 __crashCount 配额；正常 ASCII 路径零开销。
let memWarnAt = 0;
const memTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss < 1536 * MB || rss - memWarnAt < 512 * MB) return;
  memWarnAt = rss;
  __crashLog("memory-high", memUsage());
}, 5 * 60 * 1000);
memTimer.unref?.();
// 同步卡死留痕（issue #146 猜想 2）：正常一次远端同步最长约 90s（30s×重试），
// 持锁超过 10 分钟即疑似卡死；同一标签每 15 分钟最多记一条。
let stallTag = "";
let stallAt = 0;
const stallTimer = setInterval(() => {
  let wd;
  try { wd = require("./backend/webdav.cjs"); } catch { return; }
  const tag = wd.syncBusyTag();
  const held = wd.syncHeldMs();
  if (!tag || held < 10 * 60 * 1000) { stallTag = ""; stallAt = 0; return; }
  if (tag === stallTag && Date.now() - stallAt < 15 * 60 * 1000) return;
  stallTag = tag;
  stallAt = Date.now();
  __crashLog("sync-stall", `tag=${tag} held=${Math.round(held / 1000)}s`);
}, 60 * 1000);
stallTimer.unref?.();
// ===== 闪退取证结束 =====

const config = require("./backend/config.cjs");
const ipc = require("./backend/ipc.cjs");
const updater = require("./backend/updater.cjs");
const remotesync = require("./backend/remotesync.cjs");
const scheduler = require("./backend/scheduler.cjs");
const watch = require("./backend/watch.cjs");
// 用量同步模块（原「用量记录同步」）：独立配置与本地库，调度器与技能仓库互不干扰
const usageConfig = require("./backend/sync-config.cjs");
const usagedb = require("./backend/db.cjs");
const usagesync = require("./backend/sync.cjs");
// 反代网关模块：本地 OpenAI 兼容服务（默认 127.0.0.1:9527），托盘常驻期间持续提供 API
const proxy = require("./backend/proxy/index.cjs");
const memory = require("./backend/memory/index.cjs");
const usageScheduler = require("./backend/usage-scheduler.cjs");
// 全局快捷键：唤起/释放界面。冲突时弹气泡并持续重试（见 backend/shortcut.cjs）
const shortcut = require("./backend/shortcut.cjs");
// 轻量模式：关窗决策（纯逻辑，可自测）+ 窗口几何持久化（销毁窗口后重建要回到原位）
const windowMode = require("./backend/window-mode.cjs");
const windowState = require("./backend/window-state.cjs");
// 外置插件宿主：只提供加载/启停/安装能力，不含任何具体插件逻辑；无插件时全为空操作
const pluginHost = require("./backend/plugin-host.cjs");
const pluginBridge = require("./backend/plugin-bridge.cjs");

/**
 * 提示词库后端（第三板块）：惰性 require + 兜底。
 * 为什么不做顶层 require：该模块若缺失或初始化抛错（旧安装包残留、开发中途），
 * 顶层 require 失败会让**整个主进程起不来**；这里降级为「仅提示词库不可用」。
 * 另外 IPC 注册与板块开关无关（停用只停后台设施），否则停用后再启用会因
 * ipcMain.handle 重复注册而抛错。
 */
function promptsMod() {
  try {
    return require("./backend/prompts/index.cjs");
  } catch (e) {
    __crashLog("prompts-require-failed", __describe(e));
    return null;
  }
}

/**
 * 本地网关后端（第五板块）：与提示词库同款「惰性 require + 兜底」。
 * 为什么不做顶层 require：localgw 会连带 require server.cjs / forwarder.cjs 等一大票文件，
 * 其中任何一个缺失（旧安装包残留、增量更新中途）都会让顶层 require 抛错 →
 * 整个主进程起不来。降级为「仅本地网关不可用」是唯一可接受的失败半径。
 *
 * 注意：这里**只加载模块**，不启动 HTTP 服务。是否 listen 由 boot() 内的
 * autostart 开关决定（默认 false），即「装了不等于对外开端口」。
 */
function localgwMod() {
  try {
    return require("./backend/localgw/index.cjs");
  } catch (e) {
    __crashLog("localgw-require-failed", __describe(e));
    return null;
  }
}

/** 本地网关 → 渲染层广播：走既有 app:event 通道，event 字段固定 "localgw"
 *  （消费方：Sidebar.vue 的 p.event === "localgw" 分支；payload 结构见 localgw/usagehook.cjs） */
function broadcastLocalgw(payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("app:event", payload);
    }
  } catch { /* 无窗口/已销毁时静默：广播失败不能影响网关转发本身 */ }
}

pluginHost.init({ app });
pluginBridge.init(pluginHost);
// 顶层 require 链完成：此后的未捕获异常可以降级记录，不再按「启动失败」弹窗退出
bootPhase = "ready";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:1420";

// 目录名用 productName 大小写（userData = %APPDATA%\AgentHub），与安装名/任务栏一致
app.setName("AgentHub");

let mainWindow = null;
let tray = null;
let quitting = false;

/** 资源目录：打包后为 process.resourcesPath 的相邻 build，开发时为项目 build/ */
function buildDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "build") : path.join(__dirname, "..", "build");
}

function iconPath(name) {
  try {
    return nativeImage.createFromPath(path.join(buildDir(), name));
  } catch {
    return nativeImage.createEmpty();
  }
}

/** 应用主题同步到原生窗口框架（标题栏/边框）：否则外框颜色只跟系统主题走，不跟应用主题走。
 *
 *  同时同步**窗口画布底色**：BrowserWindow 的 backgroundColor 是窗口在页面首帧渲染出来
 *  之前铺的底色。此前写死为深色 #0a0c0f ✗ —— 浅色主题下每次窗口重建都会先铺黑底、
 *  再被首帧覆盖 → **闪黑** ✗。而本 PR 的轻量模式恰恰会**销毁窗口**，
 *  用户下次唤回必然走 createWindow() 重建 → 该闪烁会被明显放大 ✓ 故一并修掉。
 *  与 src/styles/global.css 的 --bg 取值一致：dark #0a0c0f / light #f4f6f9。
 *  setBackgroundColor 对已存在窗口即时生效；窗口不存在（已释放）时由 createWindow
 *  在下次创建时按当前主题取色，故这里静默跳过即可。 */
const WINDOW_BG = { dark: "#0a0c0f", light: "#f4f6f9" };

function applyNativeTheme(theme) {
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
  const bg = WINDOW_BG[theme === "light" ? "light" : "dark"];
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(bg);
  } catch { /* 窗口正在销毁等竞态：下次 createWindow 会用当前主题取色 */ }
}

// ===== 全局大小自适应 =====
// 以 1280 为设计基准宽，整页等比缩放（钳制 0.7~1.25）：窗口更小整体缩小、更大适度放大。
// zoomFactor 缩放的是 CSS 像素（含媒体查询），常态下有效布局宽度恒为 1280，
// 布局本身只在大窗口侧自然拉伸；浏览器预览（dev:web）不走此逻辑，由 CSS 断点兜底
const DESIGN_WIDTH = 1280;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.25;

// ===== 轻量模式：窗口几何的读写 =====
// 销毁窗口会丢掉窗口摆放，重建时若不还原，用户每次点托盘「显示主界面」都会
// 得到一个居中大窗 —— 所以位置/尺寸/最大化必须落盘（见 backend/window-state.cjs）。
// 越界收敛交给 clampBounds：显示器被拔掉后旧坐标会落在不存在的屏上（窗口"打开但看不见"）。

/** 读取上次的窗口几何，并收敛到当前实际存在的屏幕上 */
function restoreWindowBounds() {
  const saved = windowState.load(config.dataDir());
  const clamped = windowState.clampBounds(saved.bounds, safeDisplays(), { width: 1280, height: 820 });
  return { clamped, maximized: saved.maximized === true };
}

/** screen.getAllDisplays() 的容错包装：拿不到就当没有屏幕信息（clampBounds 会退回默认尺寸） */
function safeDisplays() {
  try {
    return require("electron").screen.getAllDisplays();
  } catch {
    return [];
  }
}

/** 落盘当前窗口几何：仅在有窗口且未最小化时记录（最小化时 getBounds 会给出异常值） */
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    // Windows 最小化时 getBounds 给 -32000 系异常值，写进盘会把用户原位置顶掉；
    // getNormalBounds 对最大化/最小化都返回「恢复为普通窗口时」的 bounds，两种非常态都兜住
    const bounds = maximized || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    windowState.save(config.dataDir(), windowState.pickState({ bounds, maximized }));
  } catch {
    /* 记不住位置不该影响任何主流程 */
  }
}

/** 几何变化的落盘节流：拖动窗口时 resize/move 会高频触发，别每次都写盘 */
let boundsSaveTimer = null;
function schedulePersistBounds() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    persistWindowBounds();
  }, 400);
}

function applyViewportZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w] = mainWindow.getSize();
  const factor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w / DESIGN_WIDTH));
  try {
    mainWindow.webContents.setZoomFactor(factor);
  } catch {
    /* 页面未就绪时调用可能失败，下个 resize / 加载事件会重试 */
  }
}

function createWindow() {
  const { clamped, maximized } = restoreWindowBounds();
  mainWindow = new BrowserWindow({
    width: clamped.width,
    height: clamped.height,
    // x/y 可能为 undefined（无历史状态/无可用屏幕）→ 交给 Electron 居中
    x: clamped.x,
    y: clamped.y,
    minWidth: 920,
    minHeight: 640,
    title: "AgentHub",
    icon: iconPath("icon.png"),
    // 无边框：原生标题栏（「AgentHub · Agent中控台」+ 最小化/最大化/关闭）整条去掉，
    // 改由渲染层自绘 —— 左上角品牌卡 + 右上角横条卡最右侧的窗口按钮（见 TopBarActions.vue）。
    // 拖拽靠 CSS 的 -webkit-app-region: drag；缩放仍由系统边缘热区负责（resizable 默认 true）
    frame: false,
    autoHideMenuBar: true,
    // 窗口画布底色随当前主题：写死深色时，浅色主题下窗口重建会先铺黑底再被首帧覆盖 → 闪黑 ✗
    // （轻量模式会销毁窗口，唤回即重建，故这里必须按主题取色）
    // 取值与 src/styles/global.css 的 --bg 对齐：dark #0a0c0f / light #f4f6f9。
    backgroundColor: WINDOW_BG[config.loadConfig().theme === "light" ? "light" : "dark"],
    // 先隐藏，等页面渲染出首帧再显示：窗口出现时内容已就绪，避免空壳闪烁
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_URL);
  }

  // 首帧就绪后显示窗口（did-finish-load 兜底：HMR 重载等场景 ready-to-show 可能不触发）
  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", reveal);
  mainWindow.webContents.once("did-finish-load", reveal);

  // 最大化状态要在窗口存在后设置；恢复越界过就记一笔，便于排查「窗口位置自己变了」
  if (maximized) {
    try { mainWindow.maximize(); } catch { /* 某些平台/时序下可能失败，不拦启动 */ }
  }
  if (clamped.adjusted && clamped.reason !== "no-position") {
    __crashLog("window-bounds-adjusted", `${clamped.reason} → ${clamped.width}x${clamped.height}+${clamped.x},${clamped.y}`);
  }

  // 窗口尺寸变化 / 页面（重）载入后按当前宽度重算缩放
  applyViewportZoom();
  mainWindow.on("resize", () => { applyViewportZoom(); schedulePersistBounds(); });
  mainWindow.webContents.on("did-finish-load", applyViewportZoom);
  // 拖动/最大化切换都要记账（move 只在非最大化时有意义，maximize/unmaximize 各记一次）
  mainWindow.on("move", schedulePersistBounds);
  mainWindow.on("maximize", schedulePersistBounds);
  mainWindow.on("unmaximize", schedulePersistBounds);

  // 自绘标题栏要跟着切换「全屏 / 还原」图标：状态一变就广播，渲染层据此换图标。
  // 窗口还没加载完时 send 会打到空页面，无害；加载完由前端再查一次 window_is_maximized 对齐
  const pushMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("app:event", { event: "window-maximized", maximized: mainWindow.isMaximized() });
  };
  mainWindow.on("maximize", pushMaximized);
  mainWindow.on("unmaximize", pushMaximized);

  // 关闭 → 按三态决策：真退出 / 缩到托盘（保留渲染进程）/ 轻量模式（销毁窗口释放渲染进程）
  mainWindow.on("close", (e) => {
    const cfg = config.loadConfig();
    const action = windowMode.decideCloseAction({
      quitting,
      minimizeToTray: !!(cfg.schedule && cfg.schedule.minimizeToTray),
      lightweightMode: !!(cfg.schedule && cfg.schedule.lightweightMode),
    });
    if (action === "quit") return; // 放行：走正常退出流程
    e.preventDefault();
    // 无论藏还是销毁，都先把窗口位置记下来（销毁后再也读不到）
    persistWindowBounds();
    if (windowMode.releasesRenderer(action)) {
      // 轻量模式：销毁窗口 → 渲染进程整只消失（实测省 ~298 MB）。
      // 主进程/托盘/反代网关/定时同步/记忆中枢都不受影响（它们本就不依赖窗口）。
      // 用 setImmediate 延到本次 close 事件派发结束之后再 destroy：
      // 在 close 回调里同步销毁自己属于重入，交给下一轮事件循环更稳。
      // （destroy() 不会再触发 close，故不会二次进入本分支）
      __crashLog("lightweight-enter", `渲染进程释放（mode=${cfg.schedule.lightweightMode ? "lightweight" : "no-tray"}）`);
      const w = mainWindow;
      mainWindow = null;
      setImmediate(() => {
        try { w.destroy(); } catch { /* 已销毁 */ }
      });
      refreshTrayMenu();
    } else {
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    // 从托盘唤回时窗口可能是隐藏态（hide 模式），先显示再聚焦
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
}

// ===== 全局快捷键：唤起 / 释放界面 =====
// 全局生效（应用在后台/托盘时也能唤起）。按下时是「开关」语义：
//   窗口可见   → 隐藏（hide）
//   窗口不可见 → 显示并聚焦（没有窗口时重建）
//
// 收起动作按「轻量模式」开关分派（见 collapseMainWindow）：开启走释放，关闭仅 hide。
let shortcutRegistrar = null;

/** 按当前配置注册快捷键；配置变更后由 ipc 的 onConfigSaved 钩子再次调用 */
function setupShortcut() {
  const cfg = config.loadConfig();
  const acc = (cfg.schedule && cfg.schedule.shortcutToggle) || "";

  if (!shortcutRegistrar) {
    shortcutRegistrar = shortcut.createRegistrar({
      globalShortcut,
      onTrigger: onShortcutToggle,
      notify: (title, body) => notify(title, body),
      log: (kind, detail) => __crashLog(kind, detail),
    });
  }
  const st = shortcutRegistrar.set(acc);
  if (st.error) __crashLog("shortcut-invalid", String(st.error));
  return st;
}

/** 收起主界面：按「轻量模式」开关决定是隐藏还是释放渲染进程。
 *  恒为 hide → 用户开了轻量模式却省不到内存；恒为 destroy → 没开轻量也每次唤回闪黑重建。 */
function collapseMainWindow(reason) {
  const cfg = config.loadConfig();
  const lightOn = !!(cfg.schedule && cfg.schedule.lightweightMode);
  if (lightOn) {
    releaseWindowNow(reason);
    return;
  }
  try { mainWindow.hide(); } catch { /* 已销毁：下次唤回会重建 */ }
  refreshTrayMenu();
}

/** 快捷键按下：可见则收起界面，不可见则唤回 */
function onShortcutToggle() {
  try {
    const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    if (visible) {
      collapseMainWindow("shortcut");
    } else {
      showWindow();
    }
  } catch (e) {
    __crashLog("shortcut-toggle-failed", String((e && e.message) || e));
  }
}

// ===== 技能仓库：WebDAV 定时同步 =====

function triggerSync() {
  const cfg = config.loadConfig();
  if (remotesync.isRunning()) return;
  if (!remotesync.configured(cfg)) {
    notify("AgentHub", "请先在「技能仓库 · WebDAV 同步」页配置服务器地址和账号");
    return;
  }
  remotesync.run(cfg).catch(() => {});
}

// ===== 用量同步：本机用量上传/拉取 =====

function triggerUsageSync() {
  // 运行中/恢复中不重复触发：原来直接 run 抛错只 console.error，托盘用户毫无反馈
  const p = usagesync.progress();
  if (p && (p.running || p.restoring)) {
    notify("AgentHub", p.restoring ? "正在恢复备份，请稍候" : "用量同步正在进行中");
    return;
  }
  const cfg = usageConfig.loadConfig();
  usagesync.run(cfg).catch((e) => {
    console.error("[usage-sync]", e);
    notify("AgentHub", `用量同步启动失败：${String((e && e.message) || e)}`);
  });
}

/** 今日用量摘要（托盘菜单用），无数据时返回 null */
function usageTodaySummary() {
  try {
    const cfg = usageConfig.loadConfig();
    const s = usagedb.getSummary(cfg.totalMode || "full");
    // 无记录时返回 null（托盘显示「今日用量 —」）；todayTokens 恒 >= 0，不能用其判断空态
    return s && s.todayRecordCount > 0 ? s.todayTokens : null;
  } catch {
    return null;
  }
}

// 托盘今日用量：与渲染进程 formatToken 同口径的中文单位分级（两位小数）
function formatNum(n) {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  const units = [[1e10, "百亿"], [1e8, "亿"], [1e7, "千万"], [1e6, "百万"], [1e4, "万"], [1e3, "千"]];
  for (const [div, unit] of units) {
    if (abs >= div) {
      return (n / div).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + unit;
    }
  }
  return Math.round(n).toLocaleString("en-US");
}

// ===== 托盘 =====

/** 托盘菜单（动态构建：今日用量 + 更新提示 + 暂停/恢复定时同步） */
function buildTrayMenu() {
  const cfg = config.loadConfig();
  const running = remotesync.isRunning();
  // 板块开关（issue #91）：关闭板块的托盘入口一并隐藏，避免绕过 UI 触发已停用模块
  const on = (k) => {
    const m = (cfg.modules || {})[k];
    return !m || m.enabled !== false;
  };
  const usageToday = on("sync") ? usageTodaySummary() : null;
  const items = [];
  if (on("sync")) items.push({ label: usageToday != null ? `今日用量 ${formatNum(usageToday)} token` : "今日用量 —", enabled: false });
  if (items.length) items.push({ type: "separator" });
  const st = updater.getStatus();
  if (st.status === "available" || st.status === "downloaded") {
    items.push({ label: `发现新版本 v${st.latestVersion} →`, click: () => { showWindow(); focusSettingsUpdate(); } });
    items.push({ type: "separator" });
  }
  // 轻量模式：关窗缩到托盘的用户，托盘是唯一入口，所以开关必须放这里
  // （设置 · 通用里也有同一个开关，两处写的是同一份配置）
  const lightOn = !!(cfg.schedule && cfg.schedule.lightweightMode);
  const trayOn = !!(cfg.schedule && cfg.schedule.minimizeToTray);
  const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
  items.push(
    { label: "显示主界面", click: showWindow },
    {
      // 未开托盘常驻时该开关无意义（关窗本来就释放界面）→ 置灰并说明，而不是点了没反应
      label: lightOn ? "轻量模式：已开启（关窗释放界面）" : "轻量模式：关窗释放界面",
      type: "checkbox",
      checked: lightOn,
      enabled: trayOn,
      click: () => { toggleLightweightMode(!lightOn); },
    },
    {
      // 手动立即释放：不必真的去关窗（窗口当前可见时也能用）
      label: hasWindow ? "立即释放界面内存" : "界面已释放（点上方可唤回）",
      enabled: hasWindow,
      click: () => { releaseWindowNow("tray-manual"); },
    },
    { type: "separator" },
    ...(on("skills") ? [{
      label: "立即同步技能",
      enabled: remotesync.configured(cfg) && !running,
      click: triggerSync,
    }] : []),
    ...(on("sync") ? [{ label: "立即同步用量", click: triggerUsageSync }] : []),
    ...(on("skills") ? [{
      label: scheduler.isPaused() ? "恢复定时同步" : "暂停定时同步",
      enabled: remotesync.configured(cfg) && !!(cfg.schedule && (cfg.schedule.hourly || cfg.schedule.daily)),
      click: () => { scheduler.setPaused(!scheduler.isPaused()); refreshTrayMenu(); },
    }] : []),
    ...(on("sync") ? [{
      label: usageScheduler.isPaused() ? "恢复用量定时同步" : "暂停用量定时同步",
      click: () => { usageScheduler.setPaused(!usageScheduler.isPaused()); refreshTrayMenu(); },
    }] : []),
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}

/**
 * 四大板块启用开关（issue #91）唯一写入口：设置页与「模块顺序」区的开关都走这里。
 * 放在 main 而非 ipc.cjs：运行时启停要调 scheduler/watch/usageScheduler/proxy/memory，
 * 这些设施的启停本来就归本文件管（before-quit 同款收口）。
 * 落盘走 config.saveConfig 直写；saveConfigFromUI 对 modules 做磁盘优先，
 * 渲染层旧快照的整份保存不会把开关状态写回去。
 */
function registerModuleToggle() {
  ipcMain.handle("module_toggle", async (_e, args) => {
    try {
      const m = String((args && args.module) || "");
      const enabled = !!(args && args.enabled);
      // 板块 key 白名单：**新增板块必须补进来**，否则开关报「未知板块」
      // localgw 在前端的启停开关是锁死的（方案决策 5：对外 API 的唯一入口，写死启用，
      // 顺序列表里可见可排序但不可停），白名单仍要收 —— 否则旧配置里残留的
      // localgw.enabled=false 只能靠改配置文件恢复，且 module_toggle 会给出
      // 「未知板块」这种自相矛盾的回复（该 key 明明在 MODULES 里）。
      if (!["skills", "sync", "proxy", "memory", "prompts", "localgw"].includes(m)) return { ok: false, message: "未知板块" };
      const cfg = config.loadConfig();
      const next = { ...cfg.modules, [m]: { ...((cfg.modules || {})[m] || {}), enabled } };
      if (!enabled && Object.values(next).every((x) => !x || x.enabled === false)) {
        return { ok: false, message: "至少保留一个启用的板块" };
      }
      cfg.modules = next;
      config.saveConfig(cfg);
      // 运行时启停：关 = 停后台设施（定时器/监听/服务/库）；开 = 重新拉起（各处均幂等）
      if (m === "skills") {
        if (enabled) { scheduler.start(); watch.start(); }
        else { scheduler.stop(); watch.stop(); }
      } else if (m === "sync") {
        if (enabled) usageScheduler.start();
        else {
          usageScheduler.stop();
          // 在途同步一并取消（与 proxy 停用时 poolsync.cancel 对称）：否则收尾写库会把
          // 刚关掉的库惰性重开，违背「停用后后台完全不运行」的语义
          try { usagesync.cancel(); } catch { /* 无在途任务时无碍 */ }
          try { usagedb.close(); } catch { /* 关闭失败无碍，重新启用时惰性重开 */ }
        }
      } else if (m === "proxy") {
        // 只做运行时启停，不触碰「记住网关开关」（proxy.restoreOnLaunch）——那是用户的设置，
        // 静默改写会与设置页提示「网关是否自启仍看『记住网关开关』」自相矛盾，且用户无法察觉
        // 设置已被改动。模块停用后重启不拉起网关，由启动短路保证：
        // whenReady 里 `if (on("proxy")) proxy.boot()`——不 boot 就走不到 boot() 内的
        // restoreOnLaunch 分支，无需改写用户设置。
        await proxy.setRuntime(enabled);
      } else if (m === "memory") {
        // 与 memory_toggle 同口径双写旧字段 memory.enabled：loadConfig 每次都会执行
        // 「旧字段 false → modules.memory.enabled=false」的迁移，只写新字段的话
        // 旧字段残留的 false 会把刚启用的开关在下一次任意 loadConfig 时打回（审查整改）
        try {
          const c2 = config.loadConfig();
          c2.memory = { ...(c2.memory || {}), enabled };
          config.saveConfig(c2);
        } catch { /* 双写失败时迁移仍以旧字段为准，行为退化为旧版一致 */ }
        if (enabled) await memory.boot().catch((e) => __crashLog("memory-boot-failed", __describe(e)));
        else await memory.shutdown().catch(() => {});
      } else if (m === "prompts") {
        // 提示词库：启停只影响后台设施（定时同步调度）；IPC 常驻注册，
        // 停用后前端仍能读取本地库（与「停用后后台完全不运行」的语义不冲突）
        const pm = promptsMod();
        if (pm) {
          if (enabled) {
            try { await pm.boot(); } catch (e) { __crashLog("prompts-boot-failed", __describe(e)); }
          } else {
            try { await pm.shutdown(); } catch { /* 停用失败无碍，下次启动会重新收口 */ }
          }
        }
      } else if (m === "localgw") {
        // 本地网关：启用 = 按 autostart 决定是否拉起 HTTP 服务；停用 = 立刻关掉监听。
        // IPC 常驻注册（与 prompts 同口径）：停用后前端仍能读状态/密钥/日志，
        // 否则页面会白屏，用户连「为什么连不上」都看不到。
        const lgw = localgwMod();
        if (lgw) {
          if (enabled) {
            try { lgw.setRuntime({ broadcast: broadcastLocalgw }); } catch { /* 广播器注入失败只影响事件刷新 */ }
            // boot() 内部已按 autostart 短路：autostart=false 时不会开端口
            try { await lgw.boot(); } catch (e) { __crashLog("localgw-boot-failed", __describe(e)); }
          } else {
            try { await lgw.shutdown(); } catch { /* 停用失败无碍，下次启动会重新收口 */ }
          }
        }
      }
      // 渲染层各页订阅该事件刷新（左栏灰态即时生效、统计数字停止轮询）
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send("app:event", { event: "module-toggled", module: m, enabled });
        }
      } catch { /* 通知失败不影响切换结果 */ }
      refreshTrayMenu();
      return { ok: true, message: enabled ? "已启用" : "已停用" };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });
}

/** 新版本提示点击 → 打开配置中心 · 通用并定位到「软件更新」卡片 */
function focusSettingsUpdate() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "focus-update" });
    }
  } catch { /* 无窗口就算了 */ }
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (tray) {
    try {
      const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
      tray.setToolTip(hasWindow ? "AgentHub · Agent中控台" : "AgentHub · 界面已释放（点此唤回）");
    } catch { /* 托盘不可用时忽略 */ }
  }
}

/** 立即销毁窗口释放渲染进程（托盘「立即释放界面内存」与自动触发共用）。
 *  与关窗路径的区别：不经过 close 事件，供「窗口还开着也想省内存」的场景使用。 */
function releaseWindowNow(reason) {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return false;
  persistWindowBounds();
  __crashLog("lightweight-enter", `渲染进程释放（reason=${reason}）`);
  const w = mainWindow;
  mainWindow = null;
  setImmediate(() => {
    try { w.destroy(); } catch { /* 已销毁 */ }
  });
  refreshTrayMenu();
  return true;
}

/** 托盘里切换轻量模式：写同一份配置（与设置 · 通用页共用），即时生效 */
function toggleLightweightMode(next) {
  try {
    const cfg = config.loadConfig();
    cfg.schedule = cfg.schedule || {};
    cfg.schedule.lightweightMode = !!next;
    config.saveConfig(cfg);
    // 托盘直写不经 save_config：ipc 的内存快照与渲染层快照都不会自己更新。
    // 只作废后端缓存还不够，渲染层旧快照在下次设置页整份保存时会把这里的改动冲掉
    // （saveConfigFromUI 不保护 schedule 字段），故广播一次让渲染层重拉。
    ipc.refreshConfigCache();
    try {
      const w = mainWindow;
      if (w && !w.isDestroyed()) w.webContents.send("app:event", { event: "config-changed" });
    } catch { /* 渲染层不在（界面已释放）时忽略：下次唤回 load() 会读到新值 */ }
    __crashLog("lightweight-toggle", `lightweightMode=${cfg.schedule.lightweightMode}（来自托盘）`);
  } catch (e) {
    __crashLog("lightweight-toggle-failed", String((e && e.message) || e));
    notify("AgentHub", "轻量模式开关写入失败，请到「设置 · 通用」重试");
  }
  refreshTrayMenu();
}

function createTray() {
  const icon = iconPath("tray.png");
  tray = new Tray(icon.isEmpty() ? iconPath("icon.png") : icon);
  tray.setToolTip("AgentHub · Agent中控台");
  refreshTrayMenu();
  tray.on("double-click", showWindow);
}

// ===== 桌面通知：默认仅同步失败提醒，设置里可开启「成功也通知」；失败持续期间不重复弹 =====

let lastNotifiedOk = null;
function notifySync(okFlag, message) {
  try {
    refreshTrayMenu();
    if (!Notification.isSupported()) return;
    if (okFlag) {
      lastNotifiedOk = true;
      const cfg = config.loadConfig();
      if (!(cfg.schedule && cfg.schedule.notifyOnSuccess)) return;
    } else {
      // 失败持续中不重复打扰；首次失败/失败恢复后再失败才提醒
      if (lastNotifiedOk === false) return;
      lastNotifiedOk = false;
    }
    const n = new Notification({
      title: okFlag ? "WebDAV 同步完成" : "WebDAV 同步失败",
      body: message || (okFlag ? "中央仓库已与远端同步" : "请检查 WebDAV 配置与网络"),
      icon: iconPath("icon.png"),
    });
    n.show();
  } catch {
    /* 通知失败静默 */
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath("icon.png") });
  n.show();
}

// 用量同步完成/失败通知：与技能同步同一套去重逻辑，配置读用量模块自己的 schedule
let lastUsageNotifiedOk = null;
function notifyUsageSync(okFlag, message) {
  try {
    refreshTrayMenu(); // 同步结束后刷新托盘「今日用量」
    if (!Notification.isSupported()) return;
    const cfg = usageConfig.loadConfig();
    if (okFlag) {
      lastUsageNotifiedOk = true;
      if (!(cfg.schedule && cfg.schedule.notifyOnSuccess)) return;
    } else {
      if (lastUsageNotifiedOk === false) return;
      lastUsageNotifiedOk = false;
    }
    const n = new Notification({
      title: okFlag ? "用量同步完成" : "用量同步失败",
      body: message || (okFlag ? "本机用量已上传并拉取最新数据" : "请检查用量同步的 WebDAV 配置"),
      icon: iconPath("icon.png"),
    });
    n.show();
  } catch {
    /* 通知失败静默 */
  }
}

// 自动感知回执：零冲突收纳直接报告结果；发现冲突只提醒，等用户去软件里裁决
watch.setOnEvent(({ kind, summary, count }) => {
  refreshTrayMenu();
  if (kind === "conflict") {
    notify("AgentHub 技能仓库", `发现 ${count || 0} 个需要裁决的冲突，已跳过自动收纳`);
    return;
  }
  if (kind === "synced" && summary) {
    notify("AgentHub 技能仓库", `自动收纳完成：${summary.imported} 个新增 · 挂载 ${summary.mounted} 处 · 合并重复 ${summary.merged} 份`);
  }
});

// ===== 单实例锁 =====
// 开发旁路：AGENTHUB_ALLOW_MULTI=1 时跳过单实例锁，并隔离 userData，
// 使 `npm run dev` 能在安装版 AgentHub 仍在运行时并存（否则新实例拿不到锁会干净退出，
// concurrently -k 随即把 vite 一起关掉——表现为"npm run dev 一闪而过"）。
// 仅用于本地开发调试，生产不设该变量，行为与原来完全一致。
const ALLOW_MULTI = process.env.AGENTHUB_ALLOW_MULTI === "1";
if (ALLOW_MULTI) {
  // userData 隔离：避免与安装版争抢同一个库/日志/缓存
  app.setPath("userData", path.join(app.getPath("appData"), "AgentHub-dev"));
}
const gotLock = ALLOW_MULTI ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  __crashLog("single-instance-lock-lost", "已有实例持有单实例锁，本次启动即退出（第二次启动的正常行为，不是崩溃）");
  app.quit();
} else {
  if (!ALLOW_MULTI) app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    // 建窗前先应用主题，避免深色配置下标题栏先白后黑闪烁
    const bootCfg = config.loadConfig();
    // 同步配置留痕（issue #146 猜想 1）：崩溃日志里一眼能看出崩时有没有配 WebDAV、
    // 各模块是否在跑远端同步；只记有无，不落任何账号密码。
    try {
      const usageBoot = usageConfig.loadConfig();
      // 与各引擎的 configured() 同口径：usage/memory 只要求 endpoint；skills/pool 还要账号密码。
      const hasEndpoint = (w) => !!(w && String(w.endpoint || "").trim());
      const hasAuth = (w) => !!(w && w.endpoint && w.username && w.password);
      __crashLog(
        "sync-config",
        `usage=${hasEndpoint(usageBoot.webdav) ? "yes" : "no"} skills=${hasAuth(bootCfg.webdav) ? "yes" : "no"} ` +
          `memory=${hasEndpoint(config.moduleWebdav("memory")) ? "yes" : "no"} pool=${hasAuth(config.moduleWebdav("proxy")) ? "yes" : "no"} ` +
          `usageMode=${usageBoot.mode || "auto"}`,
      );
    } catch (e) {
      __crashLog("sync-config-failed", __describe(e));
    }
    applyNativeTheme(bootCfg.theme);
    // 四大板块启用开关（issue #91）：关闭的板块后台完全不运行（不装定时器/监听/服务/库）
    const on = (k) => {
      const m = (bootCfg.modules || {})[k];
      return !m || m.enabled !== false;
    };

    // 用量同步：初始化本地库（惰性打开），并确保本机设备登记在册（设备列表/本机口径立即可用）
    if (on("sync")) {
      usagedb.get();
      const usageCfg0 = usageConfig.loadConfig();
      const usageLocalId = usagesync.ensureLocalDeviceId(usageCfg0);
      usagedb.upsertDevice(usageLocalId, usageCfg0.deviceName || "这台电脑", usagesync.enabledSourceIds(usageCfg0).join(","), usagedb.getLastSyncAt(usageLocalId));
    }

    ipc.register({ ipcMain, app, shell, nativeTheme });
    registerModuleToggle();
    // 提示词库（第三板块）：IPC 无条件注册（停用只停后台调度），后台设施按板块开关启停
    {
      const pm = promptsMod();
      if (pm) {
        try { pm.register({ ipcMain, app, shell }); } catch (e) { __crashLog("prompts-register-failed", __describe(e)); }
        // 注意：prompts.boot() 是**同步**函数（只做调度启动与台账对账），不能像下面 proxy.boot()
        // 那样挂 .catch —— 对同步函数调 .catch 会抛 TypeError，而此处不在 try 内，
        // 会变成未捕获异常（对照 L611 的 await 写法：await 一个非 Promise 值是安全的）
        if (on("prompts")) { try { pm.boot(); } catch (e) { __crashLog("prompts-boot-failed", __describe(e)); } }
      }
    }
    // 本地网关（第五板块）：IPC 无条件注册（停用只停 HTTP 服务），服务按板块开关 + autostart 启停。
    // 与 prompts 的差别：localgw.boot() 是 **async**（内含 server.start()），所以必须挂 .catch ——
    // 裸调用一旦 reject 就是 unhandledRejection，会让主进程静默退出（同 proxy.boot 的教训）。
    // setRuntime 必须在 boot 之前：usagehook 的广播器只在 boot 时注入，晚注入会丢掉启动初期的落账事件。
    {
      const lgw = localgwMod();
      if (lgw) {
        try { lgw.register(ipcMain); } catch (e) { __crashLog("localgw-register-failed", __describe(e)); }
        try { lgw.setRuntime({ broadcast: broadcastLocalgw }); } catch (e) { __crashLog("localgw-runtime-failed", __describe(e)); }
        if (on("localgw")) lgw.boot().catch((e) => __crashLog("localgw-boot-failed", __describe(e)));
      }
    }
    remotesync.setOnFinish(notifySync);
    usagesync.setOnFinish(notifyUsageSync);
    // 反代网关：规则热加载 + 额度定时刷新 + 按配置自启网关服务（服务独立于窗口存续）
    // boot() 是 async：rules.init() / store.open() / credits.startScheduler() / startCheckinAuto()
    // 都是裸调用，抛错会变成 rejected promise。原先这里没有任何 catch，
    // 未处理的 rejection 会让主进程直接退出——症状是「窗口凭空消失、无崩溃事件、无 dump、无日志」。
    if (on("proxy")) proxy.boot().catch((e) => __crashLog("proxy-boot-failed", __describe(e)));
    // 外置插件：恢复上次启用的插件（无插件时是空操作，不产生任何进程）
    pluginHost.resumeEnabled().catch((e) => __crashLog("plugin-resume-failed", __describe(e)));
    // 记忆中枢：仓库初始化 + 本地 HTTP API（供 MCP 桥转发）+ 目录监听；失败只影响本模块
    //（boot 内部有 modules.memory.enabled 短路，无需在此判断）
    memory.boot().catch((e) => __crashLog("memory-boot-failed", __describe(e)));
    createWindow();
    createTray();
    if (on("skills")) {
      scheduler.start();
      watch.start();
    }
    if (on("sync")) usageScheduler.start();
    updater.init({ onShowWindow: showWindow, onTrayRefresh: refreshTrayMenu });
    // 全局快捷键（默认 Alt+`，两键）：冲突则弹气泡并持续重试，解除后自动恢复。
    // 设置页改键后经 ipc.onConfigSaved 钩子重新注册，无需重启。
    ipc.onConfigSaved(() => {
      try { setupShortcut(); } catch (e) { __crashLog("shortcut-reload-failed", __describe(e)); }
    });
    try { setupShortcut(); } catch (e) { __crashLog("shortcut-setup-failed", __describe(e)); }

    // 依据配置启用开机自启（便携版不支持：注册的会是临时解压副本路径，退出即失效）。
    // 开关唯一来源是框架配置（设置 · 通用 · 应用行为），用量模块旧配置字段不再参与
    config.applyAutoStart(config.loadConfig());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  }).catch((e) => {
    // 初始化链（建库 / 注册 IPC / 建窗建托盘 / 起各调度器）任何一步抛错都记下来；
    // 原先这里没有 catch，抛错 = unhandledRejection = 主进程静默退出
    __crashLog("whenReady-failed", __describe(e));
    // 没有窗口时继续活着就是「无窗口僵尸」；明确告知原因并退出。已有窗口则弹窗提示后保留。
    try {
      require("electron").dialog.showErrorBox("AgentHub 启动异常", `初始化失败：${(e && e.message) || e}\n日志：${crashLogFile()}`);
    } catch { /* 无 GUI */ }
    if (!mainWindow) app.exit(1);
  });

  app.on("before-quit", () => {
    // 统一收尾：原先两条分支各自重复一遍 stop 调用，新增模块时极易漏改一处
    const cleanup = () => {
      scheduler.stop();
      usageScheduler.stop();
      watch.stop();
      // 全局快捷键必须显式注销：更新重启是"拦下退出再重启"，
      // 不注销会让旧键在重启窗口期内处于悬空占用状态
      try { if (shortcutRegistrar) shortcutRegistrar.stop(); else shortcut.unregisterAll(globalShortcut); } catch { /* 忽略 */ }
      proxy.shutdown();
      memory.shutdown();
      // 提示词库：停掉定时同步调度（模块缺失时是空操作，不拦退出）
      try { const pm = promptsMod(); if (pm) pm.shutdown(); } catch { /* 未加载时无操作 */ }
      // 本地网关：关掉 HTTP 监听并释放连接。shutdown() 是 async，这里只能尽力而为——
      // 但必须调：进程退出虽会回收 socket，可「更新重启」是拦下退出再重启，
      // 端口没放掉会让新实例的 9527 探测失败、静默漂到 9528（用户看到端口变了会困惑）。
      try { const lgw = localgwMod(); if (lgw) lgw.shutdown().catch(() => {}); } catch { /* 未加载时无操作 */ }
      // 插件进程必须显式回收：Windows 下父进程退出不会带走子进程，会留孤儿占端口
      try { pluginBridge.stop(); } catch { /* 无桥接时是空操作 */ }
      try { pluginHost.killAll(); } catch { /* 无插件时是空操作 */ }
    };
    // 下载完的更新：武装安装器，退出序列照常走完。安装器的 spawn 推迟到 quit 事件
    // （窗口/渲染/GPU/托盘全销毁之后）——应用活着时启动安装器会踩它的杀进程竞态，
    // 详见 updater.cjs 顶部取证注释
    if (updater.pendingInstall()) updater.triggerInstall({ quitAfter: false });
    quitting = true;
    cleanup();
  });

  app.on("window-all-closed", () => {
    // Windows 下常驻托盘，不随窗口关闭退出（定时同步要后台跑）
  });
}
