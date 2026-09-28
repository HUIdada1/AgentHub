// 软件自更新
// 安装版走 electron-updater（下载和安装都由用户点）；便携版只会读 latest.yml 比版本，提示手动下
// GitHub 直连在部分网络环境（如国内）会被掐断（net::ERR_CONNECTION_CLOSED）：
// 直连失败时按候选逐个试本机常见代理端口（开源通用，不指向特定代理软件），候选用尽才报错
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Notification, nativeImage, shell, net, session } = require("electron");
const config = require("./config.cjs");

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
// 读进来，js-yaml dump 成 "|-" 块标量（块内每行缩进固定、空行可无缩进）；内容无换行时
// 是冒号后的单行标量。解析不到返回空串，不影响版本比对主流程
function parseYmlReleaseNotes(yml) {
  const lines = String(yml).split("\n");
  const idx = lines.findIndex((l) => /^releaseNotes:/.test(l));
  if (idx < 0) return "";
  const inline = lines[idx].slice("releaseNotes:".length).trim();
  // 单行标量：剥掉成对引号并解 YAML 转义（CI 检出 CRLF 时 js-yaml 会放弃块标量，
  // 输出 "...\r\n..." 单行双引号标量；\r 直接抹掉，\n 转回真实换行）
  if (inline && !/^[|>]/.test(inline)) {
    return inline
      .replace(/^["'](.*)["']$/, "$1")
      .replace(/\\r/g, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  const block = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") block.push("");
    else if (/^[ \t]/.test(l)) block.push(l);
    else break;
  }
  while (block.length && block[block.length - 1] === "") block.pop();
  if (!block.length) return "";
  // 去公共缩进（保住嵌套列表的相对缩进）
  const indents = block.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
  const pad = Math.min(...indents);
  return block.map((l) => l.slice(pad)).join("\n");
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

function triggerInstall() {
  if (installTriggered || !autoUpdater || status.status !== "downloaded") return status;
  installTriggered = true;
  // 复位通知去重，万一安装器被拦没装上，下次启动还能提醒
  config.setUpdateNotified("");
  autoUpdater.quitAndInstall(true, true);
  // 杀软拦安装器时 electron-updater 只发 error 不退出进程。
  // 10 秒后还活着说明安装没走起来，复位标志报错，不然退出流程被吞掉
  setTimeout(() => {
    if (installTriggered) {
      installTriggered = false;
      onUpdateError(new Error("安装程序未能启动"));
    }
  }, 10 * 1000);
  return status;
}

function pendingInstall() {
  return !installTriggered && status.status === "downloaded" && !!autoUpdater && !isPortable();
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
  });
  autoUpdater.on("error", (e) => onUpdateError(e));
}

function init(opts) {
  showWindow = (opts && opts.onShowWindow) || null;
  onTrayRefresh = (opts && opts.onTrayRefresh) || null;
  status = idleStatus();
  if (autoUpdater) {
    autoUpdater.autoDownload = false; // 下载让用户自己点
    autoUpdater.autoInstallOnAppQuit = false; // 退出安装自己接管，默认实现会弹向导
    bindUpdaterEvents();
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

module.exports = { init, check, download, triggerInstall, pendingInstall, getStatus, openReleases, openRepo, isPortable };
