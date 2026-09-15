// 软件自更新
// 安装版走 electron-updater（下载和安装都由用户点）；便携版只会读 latest.yml 比版本，提示手动下
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Notification, nativeImage, shell, net } = require("electron");
const config = require("./config.cjs");

const GITHUB_REPO_URL = "https://github.com/HUIdada1/AgentHub";
const GITHUB_RELEASES_URL = GITHUB_REPO_URL + "/releases";
// latest.yml 在每个 Release 里都有，latest 直链永远指最新版，不用调 API 也不用担心限流
const LATEST_YML_URL = GITHUB_RELEASES_URL + "/latest/download/latest.yml";
const FIRST_CHECK_DELAY_MS = 60 * 1000; // 启动一分钟后再查，避开启动高峰
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

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

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// GitHub 会把 release notes 渲染成 HTML 塞进 atom feed，这里还原成纯文本。
// &amp; 必须最后替换，不然 &amp;lt; 会被二次解码
function htmlToText(html) {
  let s = String(html);
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

function onUpdateError(e) {
  const msg = e && e.message ? e.message : String(e || "未知错误");
  const action =
    status.status === "checking" ? "检查更新失败" :
    status.status === "downloading" ? "下载更新失败" : "更新失败";
  setState("error", { percent: 0, message: `${action}：${msg}。请前往 GitHub 手动下载更新` });
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
  setState("checking");
  // 失败走 error 事件，这里 catch 只是防 unhandled rejection
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

// 便携版用 Electron 的 net 模块（走系统代理）。latest 直链会 302 到 objects.githubusercontent.com，手动跟一下
function netFetch(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
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
  try {
    const text = await netFetch(LATEST_YML_URL, 5);
    const m = text.match(/^version:\s*([^\s]+)/m);
    if (!m) throw new Error("版本信息格式异常");
    const latest = m[1].trim();
    if (compareVersions(latest, app.getVersion()) > 0) {
      setState("available", { latestVersion: latest, notes: "", percent: 0, message: "" });
      if (!currentCheckIsManual) notifyAvailable(latest);
    } else {
      setState("up-to-date", { latestVersion: "", notes: "", percent: 0, message: "" });
    }
  } catch (e) {
    onUpdateError(e);
  }
  return status;
}

function check(manual) {
  // checking 自不必说；downloading/downloaded 期间重入 checkForUpdates 会让
  // electron-updater 状态机收到交错事件（percent 跳回 0 / 重复 update-available 通知）
  if (status.status === "checking" || status.status === "downloading" || status.status === "downloaded") return status;
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
  if (isPortable()) return checkPortable();
  return checkInstalled();
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
