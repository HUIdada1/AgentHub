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
// 软件自更新
// 安装版走 electron-updater（下载和安装都由用户点）；便携版只会读 latest.yml 比版本，提示手动下
// GitHub 直连在部分网络环境（如国内）会被掐断（net::ERR_CONNECTION_CLOSED）：
// 直连失败时按候选逐个试本机常见代理端口（开源通用，不指向特定代理软件），候选用尽才报错
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Notification, nativeImage, shell, net, session } = require("electron");
const config = require("./config.cjs");
const crashlog = require("./crashlog.cjs");

const GITHUB_REPO_URL = "https://github.com/HUIdada1/AgentHub";
const GITHUB_RELEASES_URL = GITHUB_REPO_URL + "/releases";
// latest.yml 在每个 Release 里都有，latest 直链永远指最新版，不用调 API 也不用担心限流
const LATEST_YML_URL = GITHUB_RELEASES_URL + "/latest/download/latest.yml";
const FIRST_CHECK_DELAY_MS = 60 * 1000; // 启动一分钟后再查，避开启动高峰
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时一次
const MANUAL_COOLDOWN_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
// 本机代理回退候选：直连失败后逐个试，命中即记入会话；都没命中说明本机没可用代理
const PROXY_CANDIDATES = [
  "http://127.0.0.1:7890",     // Clash 系混合端口
  "http://127.0.0.1:7897",     // Clash Verge 默认
  "http://127.0.0.1:10809",    // v2rayN HTTP
  "socks5://127.0.0.1:10808",  // v2rayN SOCKS
  "http://127.0.0.1:8118",     // Privoxy
];

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  // 没打进来就只能提示手动更新了
}

let status = idleStatus();
let lastManualCheckAt = 0;
let installTriggered = false; // quitAndInstall 内部会再触发一次 quit，得防重入
let currentCheckIsManual = false; // 手动检查时用户正看着页面，不弹系统通知
let timer = null;
let showWindow = null;
let onTrayRefresh = null; // 状态一变就刷新托盘菜单（更新提示条目随之出现/消失）

function isPortable() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  // 与 sync-config.cjs 同口径：exe 同目录放 portable.flag 手动开启便携模式，
  // 不然手动便携副本会走 electron-updater 自动更新路径（更新的是被当便携用的副本）
  try {
    const fs = require("node:fs");
    const path2 = require("node:path");
    if (app.isPackaged && fs.existsSync(path2.join(path2.dirname(app.getPath("exe")), "portable.flag"))) return true;
  } catch { /* 判定失败按非便携 */ }
  return false;
}

function idleStatus() {
  return {
    status: "idle", // idle | checking | up-to-date | available | downloading | downloaded | error
    isPortable: isPortable(),
    currentVersion: app.getVersion(),
    latestVersion: "",
    percent: 0,
    notes: "",
    message: "",
  };
}

function notifyIcon() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, "build", "icon.png")
      : path.join(__dirname, "..", "..", "build", "icon.png");
    return nativeImage.createFromPath(p);
  } catch {
    return nativeImage.createEmpty();
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: notifyIcon() });
  n.on("click", () => {
    broadcast({ event: "focus-update" });
    if (showWindow) showWindow();
  });
  n.show();
}

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("app:event", payload);
  }
}

function setState(state, extra = {}) {
  status = { ...status, ...extra, status: state };
  broadcast({ event: "state", ...status });
  if (onTrayRefresh) {
    try { onTrayRefresh(); } catch { /* 托盘刷新失败不影响更新流程 */ }
  }
}

// 每次读盘，设置页改完立刻生效
function autoCheckEnabled() {
  try {
    const cfg = config.loadConfig();
    return !!(cfg.update && cfg.update.autoCheck);
  } catch {
    return true;
  }
}

// electron-updater 与便携检查共用同一分区会话（electron-updater 分区），代理设置一处生效两路
function updaterSession() {
  try {
    return session.fromPartition("electron-updater", { cache: false });
  } catch {
    return null;
  }
}

// null = 回直连/系统代理（每轮检查前先复位，上一轮残留的代理可能已失效）
function setUpdaterProxy(rule) {
  const ses = updaterSession();
  if (!ses) return Promise.resolve();
  return ses.setProxy(rule ? { proxyRules: rule } : { mode: "system" }).catch(() => {});
}

let proxyTried = -1; // 本轮检查已试到第几个代理候选（-1=还没走过回退）
let checkInFlight = false; // check() 全程置位，防代理复位 await 空档里的重入

// 直连失败后试下一个候选；返回 false 表示候选用尽，走最终报错
async function tryNextProxy() {
  const idx = proxyTried + 1;
  if (idx >= PROXY_CANDIDATES.length) return false;
  proxyTried = idx;
  await setUpdaterProxy(PROXY_CANDIDATES[idx]);
  return true;
}

// 只有网络类错误才值得走代理回退；HTTP 404、版本格式异常等换代理也没用
function isNetworkError(e) {
  const s = String((e && e.message) || e || "");
  return /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_PROXY|socket hang up|请求超时/i.test(s);
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 更新说明两条来源（内容同源，都是 build/release-notes.md）：
// 1) 安装版：electron-updater 拉 latest.yml，releaseNotes 字段非空直接用（空才回退 atom feed）
// 2) 便携版：本文件 netFetch 直读 latest.yml，parseYmlReleaseNotes 解析 releaseNotes 字段
// atom feed 兜底路径里的说明是 GitHub 渲染后的 HTML，htmlToText 还原成纯文本；
// &amp; 必须最后替换，不然 &amp;lt; 会被二次解码
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/\r\n?/g, "\n"); // latest.yml 直读可能带 CRLF，统一成 \n 再走后续清洗
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<h[1-6][^>]*>/gi, "\n");
  s = s.replace(/<\/(h[1-6]|p|div|blockquote|pre|ul|ol|table|tr|li)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "· ");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function toNotes(releaseNotes) {
  if (typeof releaseNotes === "string") return htmlToText(releaseNotes);
  if (Array.isArray(releaseNotes)) {
    return htmlToText(
      releaseNotes
        .map((r) => (r && typeof r.note === "string" ? r.note : ""))
        .filter(Boolean)
        .join("\n")
    );
  }
  return "";
}

// 从 latest.yml 文本里解出 releaseNotes：electron-builder 发版时把 build/release-notes.md
// 读进来，js-yaml dump 成 "|-" 块标量（块内每行缩进固定、空行可无缩进）；CI 检出 CRLF 或
// 内容含特殊字符时会降级为单行标量。解析不到返回空串，不影响版本比对主流程
function parseYmlReleaseNotes(yml) {
  const lines = String(yml).split("\n");
  const idx = lines.findIndex((l) => /^releaseNotes:/.test(l));
  if (idx < 0) return "";
  const inline = lines[idx].slice("releaseNotes:".length).trim();
  // 块标量（|、>）：收集缩进行，去公共缩进（保住嵌套列表的相对缩进）
  if (/^[|>]/.test(inline)) {
    const block = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") block.push("");
      else if (/^[ \t]/.test(l)) block.push(l);
      else break;
    }
    while (block.length && block[block.length - 1] === "") block.pop();
    if (!block.length) return "";
    const indents = block.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
    const pad = Math.min(...indents);
    return block.map((l) => l.slice(pad)).join("\n");
  }
  // 单行标量：按引号类型还原。双引号标量解 \ 转义（\r 抹掉、\n 转回真实换行）；
  // 单引号标量只有 '' 转义，\ 是普通字符不能动，不然说明文字里的字面 \r\n 字样会被误改
  if (/^".*"$/s.test(inline)) {
    return inline
      .slice(1, -1)
      .replace(/\\(.)/g, (m, c) => (c === "n" ? "\n" : c === "r" ? "" : c))
      .trim(); // 标量尾部可能带文件末尾换行
  }
  if (/^'.*'$/s.test(inline)) {
    return inline.slice(1, -1).replace(/''/g, "'").trim();
  }
  return inline.trim();
}

// 同一个版本跨会话只提醒一次
function notifyAvailable(version) {
  if (config.getUpdateNotified() === version) return;
  config.setUpdateNotified(version);
  if (isPortable()) {
    notify("检测到新版本 " + version, "便携版不支持自动更新，请前往 GitHub 手动下载");
  } else {
    notify("发现新版本 " + version, "点击查看更新内容，可在更新中心下载");
  }
}

async function onUpdateError(e) {
  const msg = e && e.message ? e.message : String(e || "未知错误");
  // 检查/下载阶段的网络类错误：先走本机代理回退逐个重试，候选用尽才报错。
  // 下载走的也是同一分区会话，失败后从 available 重新触发，换代理即生效
  if (isNetworkError(e) && (status.status === "checking" || status.status === "downloading")) {
    if (await tryNextProxy()) {
      if (status.status === "downloading") {
        setState("available", { percent: 0, message: "" });
        download();
      } else {
        startCheck();
      }
      return;
    }
  }
  const action =
    status.status === "checking" ? "检查更新失败" :
    status.status === "downloading" ? "下载更新失败" : "更新失败";
  // 网络类错误说明直连与代理候选都已试过，提示更贴近实际
  const hint = isNetworkError(e) ? "已自动尝试本机常见代理仍不可用，" : "";
  setState("error", { percent: 0, message: `${action}：${msg}。${hint}请前往 GitHub 手动下载更新` });
}

function checkInstalled() {
  if (!app.isPackaged) {
    setState("up-to-date", { latestVersion: "", notes: "", percent: 0, message: "开发模式不检查更新" });
    return status;
  }
  if (!autoUpdater) {
    setState("error", { percent: 0, message: "更新组件缺失，请前往 GitHub 手动下载更新" });
    return status;
  }
  startCheck();
  return status;
}

function startCheck() {
  setState("checking");
  // 失败走 error 事件，这里 catch 只是防 unhandled rejection
  autoUpdater.checkForUpdates().catch(() => {});
}

// 便携版用 Electron 的 net 模块，走更新专用分区会话（代理回退在同一会话上生效）。
// latest 直链会 302 到 objects.githubusercontent.com，手动跟一下
function netFetch(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const opts = { url };
    const ses = updaterSession();
    if (ses) opts.session = ses;
    const req = net.request(opts);
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer2);
      fn(v);
    };
    const timer2 = setTimeout(() => {
      if (done) return;
      done = true;
      try { req.abort(); } catch {}
      reject(new Error("请求超时"));
    }, FETCH_TIMEOUT_MS);
    req.on("response", (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.on("data", () => {});
        res.on("end", () => {
          try {
            const next = new URL(res.headers.location, url).toString();
            finish(() => netFetch(next, redirectsLeft - 1).then(resolve, reject));
          } catch (e) {
            finish(reject, e);
          }
        });
        return;
      }
      if (res.statusCode !== 200) {
        res.on("data", () => {});
        res.on("end", () => finish(reject, new Error("HTTP " + res.statusCode)));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", (e) => finish(reject, e));
    req.end();
  });
}

async function checkPortable() {
  setState("checking");
  let lastErr = null;
  for (;;) {
    try {
      const text = await netFetch(LATEST_YML_URL, 5);
      const m = text.match(/^version:\s*([^\s]+)/m);
      if (!m) throw new Error("版本信息格式异常");
      const latest = m[1].trim();
      if (compareVersions(latest, app.getVersion()) > 0) {
        setState("available", { latestVersion: latest, notes: parseYmlReleaseNotes(text), percent: 0, message: "" });
        if (!currentCheckIsManual) notifyAvailable(latest);
      } else {
        setState("up-to-date", { latestVersion: "", notes: "", percent: 0, message: "" });
      }
      return status;
    } catch (e) {
      lastErr = e;
      // 网络类错误走本机代理回退逐个重试；其余（HTTP 404/格式异常）直接报错
      if (!isNetworkError(e) || !(await tryNextProxy())) break;
    }
  }
  onUpdateError(lastErr);
  return status;
}

async function check(manual) {
  // checking 自不必说；downloading/downloaded 期间重入 checkForUpdates 会让
  // electron-updater 状态机收到交错事件（percent 跳回 0 / 重复 update-available 通知）
  if (checkInFlight || status.status === "checking" || status.status === "downloading" || status.status === "downloaded") return status;
  if (manual) {
    const now = Date.now();
    if (now - lastManualCheckAt < MANUAL_COOLDOWN_MS) {
      if (status.status !== "error") {
        setState(status.status, { message: "刚刚检查过，请稍后再试" });
      }
      return status;
    }
    lastManualCheckAt = now;
  }
  currentCheckIsManual = !!manual;
  checkInFlight = true; // 同步置位：挡掉代理复位 await 空档里的重入
  try {
    // 每轮先回直连/系统代理再开查：上一轮试过的代理可能已关掉，残留规则会连不上
    proxyTried = -1;
    await setUpdaterProxy(null);
    return isPortable() ? await checkPortable() : checkInstalled();
  } finally {
    checkInFlight = false;
  }
}

function download() {
  if (isPortable() || status.status !== "available" || !autoUpdater) return status;
  autoUpdater.downloadUpdate().catch(() => {});
  return status;
}

// ===== 安装器启动（自管） =====
// electron-updater 的 quitAndInstall 在 spawn 发起后立即退出应用，spawn 一旦失败
// （杀软对刚落盘安装包的实时扫描锁、MOTW 放行、文件占用等 EACCES/EBUSY），错误事件
// 随进程一起消失——表现为「应用退了、新版本没装上、也没自动重启」且无任何日志可查，
// 1.87.0 更新即命于此。所以不再走 quitAndInstall：自己校验、自己 spawn，失败可重试
// 可报错，应用绝不盲退。
function installerPaths() {
  const helper = autoUpdater && autoUpdater.downloadedUpdateHelper;
  if (!helper || !helper.file) return null;
  const file = String(helper.file);
  return {
    file,
    fileName: path.basename(file),
    // 下载清单里的 sha512（base64）：spawn 前整包校验，防半包与被替换
    sha512: (helper.downloadedFileInfo && helper.downloadedFileInfo.sha512) || "",
  };
}

// ===== 安装包「搬台面」（stage 到 TEMP 副本） =====
// 安全软件对「刚从网络下载的未签名 exe」所在的更新缓存区（%LOCALAPPDATA%\<app>-updater）
// 盯得最紧——1.87.0/1.87.1 更新时 quitAndInstall 的 spawn 首击即败且错误随进程一起丢失，
// 历次成功纯属首击恰好没撞上。下载完成立刻把包复制到 TEMP：一) 复制本身就是完整读盘
// 预热，扫描锁就地解开；二) spawn 落点换出缓存目录，命中盯梢的概率显著降低。
function stagedDir() {
  return path.join(require("node:os").tmpdir(), "AgentHub-update");
}

function stagedInstallerPath(fileName) {
  return path.join(stagedDir(), fileName);
}

let stagedPromise = null; // 后台搬台面任务；triggerInstall 等它，失败回退原始路径

async function stageInstaller(pkg) {
  const fsp = require("node:fs/promises");
  await verifyAndWarmInstaller(pkg.file, pkg.sha512);
  const dir = stagedDir();
  await fsp.mkdir(dir, { recursive: true });
  const staged = stagedInstallerPath(pkg.fileName);
  await fsp.copyFile(pkg.file, staged);
  // 副本也校验一遍：复制中断/截断的文件绝不能拿去装
  await verifyAndWarmInstaller(staged, pkg.sha512);
  // 顺手清掉上一版残留的副本（文件名按版本命名，不同版本互不相同）
  try {
    for (const name of await fsp.readdir(dir)) {
      if (name !== pkg.fileName && name.toLowerCase().endsWith(".exe")) {
        await fsp.unlink(path.join(dir, name)).catch(() => {});
      }
    }
  } catch { /* 清理失败无碍 */ }
  crashlog.write("updater-staged", staged);
  return staged;
}

// 整文件读一遍：一为校验 sha512，二为「预热」——杀软的实时扫描锁通常在读盘后解除，
// 后续 spawn 不再撞 EACCES
async function verifyAndWarmInstaller(file, wantSha) {
  const { createHash } = require("node:crypto");
  const fsp = require("node:fs/promises");
  const hash = createHash("sha512");
  const fd = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, buf.length);
      if (!bytesRead) break;
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close().catch(() => {});
  }
  const got = hash.digest("base64");
  if (wantSha && got !== wantSha) {
    throw new Error("安装包校验失败（sha512 与下载清单不符）");
  }
}

// ===== 安装器启动：统一收口到「进程退出最后一刻」（quit 事件） =====
// 真机取证结论（1.88.x，本机 crash.log + CDP 主进程注入实验）：
// 只要 AgentHub.exe 还在运行，安装器的 CHECK_APP_RUNNING 就会 taskkill 它，而 Electron
// 多进程死亡慢于安装器的 tasklist 轮询——第二轮判「杀不死」时静默模式下自动选取消，
// 安装器 Quit：不装、无 UI、无日志，表现为「应用退了、新版本没装上」（v1.88.0→1.88.2 用户四连败）。
// 外部进程 spawn 同一份安装包多次成功，纯因竞态恰好赢了，不可依赖。
// 结论：安装器必须在「进程表里没有 AgentHub.exe」时启动——spawn 一律推迟到 quit 事件：
// 那一刻窗口/渲染/GPU/托盘全部销毁，只剩主进程且即将退出，竞态窗口不复存在。

// 副本就绪后的路径（stage 后台进行）；stage 失败则回退原始 pending 路径（1.87.1 起的旧行为）
let stagedFile = "";
let quitSpawn = null; // triggerInstall 武装后的待发射任务，quit 事件消费

// 安装哨兵：spawn 后本进程随即退出，成败只能由下次启动判定。
// 下次启动时：目标版本 === 当前版本 → 安装成功，清哨兵；否则记日志保留待重试。
function sentinelPath() {
  return path.join(config.dataDir(), "update-sentinel.json");
}
function writeSentinel(target) {
  try {
    require("node:fs").writeFileSync(sentinelPath(), JSON.stringify({ target, at: Date.now() }));
  } catch { /* 写不了哨兵只损失取证，不阻断更新 */ }
}
function settleSentinel() {
  try {
    const s = JSON.parse(require("node:fs").readFileSync(sentinelPath(), "utf8"));
    if (!s.target) return;
    if (s.target === app.getVersion()) {
      require("node:fs").unlinkSync(sentinelPath());
      crashlog.write("updater-sentinel", `上次更新确认完成：v${s.target} 已在运行`);
    } else {
      crashlog.write("updater-sentinel-fail", `上次更新的 v${s.target} 没装上（当前 v${app.getVersion()}），pending 包保留可重试`);
    }
  } catch { /* 无哨兵或损坏：首次启动/文件问题，无操作 */ }
}

function pendingInstall() {
  return !installTriggered && status.status === "downloaded" && !!autoUpdater && !isPortable();
}

function triggerInstall(opts = {}) {
  if (installTriggered || !autoUpdater || status.status !== "downloaded") return status;
  const pkg = installerPaths();
  if (!pkg) {
    crashlog.write("updater-install-fail", "下载助手丢失，找不到已下载的安装包");
    onUpdateError(new Error("找不到已下载的安装包，请重新检查更新"));
    return status;
  }
  installTriggered = true;
  // 复位通知去重，万一安装器没装上，下次启动还能提醒
  config.setUpdateNotified("");
  quitSpawn = { pkg };
  // 副本搬运：update-downloaded 时已在后台搬台面，这里复用它的结果；用户点得太快没赶上
  // 就现场搬（秒级），两条路都失败则 spawnAtQuit 用原始 pending 路径兜底
  (stagedPromise || stageInstaller(pkg))
    .then((p) => { stagedFile = p; })
    .catch(() => { stagedFile = ""; });
  writeSentinel(status.latestVersion || "");
  // 「立即重启安装」语义：武装完即走正常退出链，quit 事件里完成 spawn。
  // 「退出时自动安装」（before-quit 调用）本来就在退出中，无需再 quit
  if (opts.quitAfter !== false) setImmediate(() => app.quit());
  return status;
}

function pendingInstall() {
  return !installTriggered && status.status === "downloaded" && !!autoUpdater && !isPortable();
}

/** quit 事件（所有窗口/渲染/GPU/托盘已销毁，主进程即将退出）最后一刻拉起安装器。
 *  同步发起、不等待不重试——本进程此后自然退出，安装器独立完成安装并 --force-run 启动新版。
 *  spawn 失败（杀软锁等）由哨兵在下次启动时暴露，pending 包保留可直接重试。 */
function spawnAtQuit() {
  if (!quitSpawn) return;
  const { pkg } = quitSpawn;
  quitSpawn = null;
  const file = stagedFile || pkg.file;
  const args = ["--updated", "/S", "--force-run"];
  try {
    const child = require("node:child_process").spawn(file, args, { stdio: "ignore", detached: true });
    crashlog.write("updater-install", `quit 时刻拉起 pid=${child.pid || "?"} src=${stagedFile ? "副本" : "原始"} ${file}`);
  } catch (e) {
    crashlog.write("updater-install-fail", `quit 时刻 spawn 失败 code=${e && e.code} ${(e && e.message) || ""}`);
  }
}

function openReleases() {
  shell.openExternal(GITHUB_RELEASES_URL);
}

function openRepo() {
  shell.openExternal(GITHUB_REPO_URL);
}

function bindUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => setState("checking"));
  autoUpdater.on("update-available", (info) => {
    setState("available", { latestVersion: info.version, notes: toNotes(info.releaseNotes), percent: 0, message: "" });
    if (!currentCheckIsManual) notifyAvailable(info.version);
  });
  autoUpdater.on("update-not-available", () => setState("up-to-date", { latestVersion: "", notes: "", percent: 0, message: "" }));
  autoUpdater.on("download-progress", (p) => {
    setState("downloading", { percent: Number.isFinite(p.percent) ? Math.round(p.percent) : 0, message: "" });
  });
  autoUpdater.on("update-downloaded", () => {
    setState("downloaded", { percent: 100, message: "" });
    notify("新版本已就绪", "退出应用时自动安装，也可在更新中心立即重启安装");
    // 下载完成立即后台搬台面（不阻塞）：等用户点安装时副本多半已就绪，spawn 不再撞扫描锁
    const pkg = installerPaths();
    if (pkg) {
      stagedPromise = stageInstaller(pkg).catch((e) => {
        stagedPromise = null;
        crashlog.write("updater-stage-fail", String((e && e.message) || e));
        return "";
      });
    }
  });
  autoUpdater.on("error", (e) => onUpdateError(e));
}

// electron-updater 内部日志接进 crash.log：quitAndInstall/spawn/缓存路径每一步都有迹可循
// （此前它的错误只进 stdout，GUI 下不可见，出事后无从取证）。debug 调用必须存在
// （内部多处会调）但置为空实现，否则下载进度级别的噪声会把 crash.log 刷掉。
function bindUpdaterLogger() {
  if (!autoUpdater) return;
  const text = (m) => String(typeof m === "function" ? m() : (m && m.message) || m);
  autoUpdater.logger = {
    info: (m) => crashlog.write("updater", text(m)),
    warn: (m) => crashlog.write("updater-warn", text(m)),
    error: (m) => crashlog.write("updater-error", text(m)),
    debug: () => {},
  };
}

function init(opts) {
  showWindow = (opts && opts.onShowWindow) || null;
  onTrayRefresh = (opts && opts.onTrayRefresh) || null;
  status = idleStatus();
  settleSentinel();
  if (autoUpdater) {
    autoUpdater.autoDownload = false; // 下载让用户自己点
    autoUpdater.autoInstallOnAppQuit = false; // 退出安装自己接管，默认实现会弹向导
    bindUpdaterEvents();
    bindUpdaterLogger();
  }
  if (app.isPackaged) timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
}

function tick() {
  if (autoCheckEnabled() && status.status !== "downloading" && status.status !== "downloaded") {
    check(false);
  }
  timer = setTimeout(tick, CHECK_INTERVAL_MS);
}

function getStatus() {
  return status || idleStatus();
}

module.exports = { init, check, download, triggerInstall, pendingInstall, spawnAtQuit, getStatus, openReleases, openRepo, isPortable };
