"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tcp = require("node:net");
const { net, session } = require("electron");
const config = require("./config.cjs");
const pluginHost = require("./plugin-host.cjs");
const feed = require("./plugin-feed.cjs");

// 官方插件清单。默认指向 GitHub Release 的 latest 直链：
// 不调 API、不受限流影响，和主程序更新器同一套思路。
const DEFAULT_FEED = "https://github.com/UltimateREN/AgentHub_skill/releases/latest/download/plugin-index.json";
const FIRST_CHECK_DELAY_MS = 90 * 1000;      // 启动一分半后再查，避开启动高峰
const CHECK_INTERVAL_MS = 60 * 60 * 1000;    // 跟随主程序的自动检查间隔
const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_INDEX_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
// 和主程序更新器同一组本机代理候选。只试真的在监听的那些，盲试会白白等超时。
const PROXY_CANDIDATES = [
  "http://127.0.0.1:7890",
  "http://127.0.0.1:7897",
  "http://127.0.0.1:10809",
  "socks5://127.0.0.1:10808",
  "http://127.0.0.1:8118",
];

let ctx = null;
let timer = null;
let status = idleStatus();
let inFlight = null;

function idleStatus() {
  return { state: "idle", lastCheckAt: 0, lastError: "", available: [], lastInstalled: null, feed: "", lastGoodProxy: "" };
}
function publish(patch) {
  status = { ...status, ...patch };
  try { ctx?.onStatus?.(status); } catch { /* 状态回调失败不影响更新流程 */ }
  return status;
}

// ===== 配置 =====
function pluginSettings() {
  let cfg;
  try { cfg = config.loadConfig(); } catch { cfg = {}; }
  const p = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
  return {
    autoUpdate: p.autoUpdate !== false,
    autoDownload: p.autoDownload !== false,
    feedUrl: typeof p.feedUrl === "string" && p.feedUrl.trim() ? p.feedUrl.trim() : DEFAULT_FEED,
    autoCheck: !(cfg.update && cfg.update.autoCheck === false),
  };
}

// ===== 网络：走独立分区，代理一处生效 =====
function updateSession() {
  try { return session.fromPartition("plugin-update", { cache: false }); }
  catch { return null; }
}
function setProxy(rule) {
  const ses = updateSession();
  if (!ses) return Promise.resolve();
  return ses.setProxy(rule ? { proxyRules: rule } : { mode: "system" }).catch(() => {});
}
function isNetworkError(error) {
  const text = String((error && error.message) || error || "");
  return /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_PROXY|socket hang up|请求超时/i.test(text);
}

// ===== 状态：上次成功的代理要记住，下次直接排前面 =====
function stateFile() { return path.join(config.dataDir(), "plugin-update.json"); }
function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const temp = `${stateFile()}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, stateFile());
  } catch { /* 状态写不进去不影响更新流程 */ }
}
function rememberProxy(rule) {
  if (!rule || loadState().lastGoodProxy === rule) return;
  saveState({ lastGoodProxy: rule });
}

// ===== 代理探测 =====
function normalizeProxy(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  return /^(https?|socks5?):\/\//i.test(text) ? text : "";
}

/** 端口有没有在监听。只探本机回环，250ms 没连上就当没有 */
function portOpen(rule, timeoutMs = 250) {
  return new Promise(resolve => {
    let target;
    try { target = new URL(rule); } catch { resolve(false); return; }
    const socket = tcp.connect({ host: target.hostname, port: Number(target.port) || 80 });
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 候选顺序：环境变量 → 上次成功的 → 本机在监听的常见端口 */
async function proxyCandidates() {
  const list = [];
  for (const key of PROXY_ENV_KEYS) {
    const rule = normalizeProxy(process.env[key]);
    if (rule) list.push(rule);
  }
  const remembered = normalizeProxy(loadState().lastGoodProxy);
  if (remembered) list.push(remembered);
  for (const rule of PROXY_CANDIDATES) {
    if (await portOpen(rule)) list.push(rule);
  }
  return [...new Set(list)];
}

/**
 * 拉一个 URL。先走系统代理（Windows 的 IE 设置 / macOS 网络设置都认这个），
 * 失败再按候选逐个试；同一个代理给一次重试，网络抖动不至于直接判死。
 * HTTP 4xx/5xx 不换代理，换也解决不了。
 */
async function fetchWithProxyFallback(url, maxBytes) {
  const plan = [null, ...(await proxyCandidates())];
  let lastError = null;
  for (const rule of plan) {
    await setProxy(rule);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buffer = await fetchBuffer(url, maxBytes);
        rememberProxy(rule);
        return buffer;
      } catch (error) {
        lastError = error;
        if (error.httpStatus || !isNetworkError(error)) throw error;
      }
    }
  }
  throw lastError || new Error("插件源不可达：直连和本机代理都没有成功");
}

function fetchBuffer(url, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let request;
    try {
      request = net.request({ method: "GET", url, session: updateSession() || undefined, redirect: "follow" });
    } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { try { request.abort(); } catch { /* 已结束 */ } done(reject, new Error("插件源请求超时")); }, FETCH_TIMEOUT_MS);
    request.on("response", response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        clearTimeout(timer);
        response.resume();
        done(reject, Object.assign(new Error(`插件源返回 HTTP ${response.statusCode}`), { httpStatus: response.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          try { request.abort(); } catch { /* 已结束 */ }
          clearTimeout(timer);
          done(reject, new Error("插件源响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => { clearTimeout(timer); done(resolve, Buffer.concat(chunks)); });
      response.on("error", error => { clearTimeout(timer); done(reject, error); });
    });
    request.on("error", error => { clearTimeout(timer); done(reject, error); });
    request.end();
  });
}

// ===== 清单 =====
function plan(entries) {
  const settings = pluginSettings();
  const hostVersion = ctx?.app?.getVersion?.() || "0.0.0";
  const installed = new Map(pluginHost.list().filter(item => item.installed).map(item => [item.id, item]));
  return feed.plan(entries, { installed, settings, hostVersion });
}

async function check({ manual = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const settings = pluginSettings();
    publish({ state: "checking", feed: settings.feedUrl, lastError: "" });
    try {
      const raw = await fetchWithProxyFallback(settings.feedUrl, MAX_INDEX_BYTES);
      const available = plan(feed.parseIndex(raw));
      const checkedAt = Date.now();
      publish({ state: available.length ? "ready" : "idle", lastCheckAt: checkedAt, available });
      saveState({ lastCheckAt: checkedAt });
      return status;
    } catch (error) {
      const message = String((error && error.message) || error);
      publish({ state: "error", lastCheckAt: Date.now(), lastError: message });
      if (manual) throw error;
      return status;
    } finally { inFlight = null; }
  })();
  return inFlight;
}

// ===== 下载与安装 =====
function updatesRoot() {
  return path.join(config.dataDir(), "plugin-updates");
}

/** 剩余空间；拿不到就返回 0，交给写入时的 ENOSPC 兜底 */
function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch { return 0; }
}

/** 下载中断留下的临时包，超过一小时就清掉；正在用的（刚写完）不动 */
function cleanupUpdates() {
  const dir = updatesRoot();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith(".zip")) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* 下次再清 */ }
  }
}

async function download(entry) {
  const dir = updatesRoot();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.id}-${entry.version}-${crypto.randomBytes(4).toString("hex")}.zip`);
  const buffer = await fetchWithProxyFallback(entry.url, MAX_PACKAGE_BYTES);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`插件包 sha256 不匹配（期望 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
  }
  const reserve = buffer.length + 32 * 1024 * 1024;
  const free = freeBytes(dir);
  if (free && free < reserve) {
    throw new Error(`磁盘空间不足：需要 ${Math.ceil(reserve / 1024 / 1024)}MB，当前剩余 ${Math.floor(free / 1024 / 1024)}MB`);
  }
  try {
    fs.writeFileSync(file, buffer, { mode: 0o600 });
  } catch (error) {
    if (error.code === "ENOSPC") throw new Error("磁盘空间不足，插件包未能保存");
    throw error;
  }
  return file;
}

async function installOne(entry) {
  publish({ state: "downloading", current: { id: entry.id, version: entry.version } });
  const file = await download(entry);
  try {
    publish({ state: "installing", current: { id: entry.id, version: entry.version } });
    // 包内 manifest 的签名由 plugin-host 用内置官方公钥校验，sha256 只保证传输完整
    const result = await pluginHost.install(file);
    if (!result.ok) throw new Error(result.message || "安装失败");
    publish({ lastInstalled: { id: result.id, version: result.version, updated: !!result.updated, at: Date.now() } });
    return result;
  } finally {
    try { fs.unlinkSync(file); } catch { /* 临时文件清理失败不影响结果 */ }
  }
}

async function applyAll(entries) {
  const results = [];
  for (const entry of entries) {
    try {
      results.push({ ok: true, ...(await installOne(entry)) });
    } catch (error) {
      results.push({ ok: false, id: entry.id, version: entry.version, message: String((error && error.message) || error) });
    }
  }
  const failed = results.filter(row => !row.ok);
  publish({
    state: failed.length ? "error" : "idle",
    lastError: failed.length ? failed.map(row => `${row.id}: ${row.message}`).join("；") : "",
    available: status.available.filter(item => !results.some(row => row.ok && row.id === item.id)),
  });
  return results;
}

/** 下载并安装当前清单里所有符合条件的条目 */
async function apply() {
  if (status.state === "checking" || status.state === "downloading" || status.state === "installing") return { ok: false, message: "插件更新正在进行" };
  if (!status.available.length) await check({ manual: false });
  if (!status.available.length) return { ok: true, results: [] };
  const results = await applyAll([...status.available]);
  return { ok: results.every(row => row.ok), results };
}

// ===== 生命周期 =====
async function tick() {
  clearTimeout(timer);
  try {
    const settings = pluginSettings();
    if (settings.autoCheck) {
      const result = await check({ manual: false });
      if (result.available.length) await applyAll(result.available);
    } else {
      // 关闭日常检查时仍要补齐已安装插件的最低版本
      const result = await check({ manual: false });
      const required = result.available.filter(item => item.required);
      if (required.length) await applyAll(required);
    }
  } catch { /* 单轮失败由状态体现，下轮继续 */ }
  finally {
    const settings = pluginSettings();
    if (settings.autoCheck) timer = setTimeout(tick, CHECK_INTERVAL_MS);
    timer?.unref?.();
  }
}

function init(options = {}) {
  ctx = { ...options };
  const saved = loadState();
  status = {
    ...idleStatus(),
    lastCheckAt: Number(saved.lastCheckAt) || 0,
    lastGoodProxy: typeof saved.lastGoodProxy === "string" ? saved.lastGoodProxy : "",
  };
  cleanupUpdates();
  clearTimeout(timer);
  timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  timer?.unref?.();
}

function stop() { clearTimeout(timer); timer = null; }

function getStatus() { return status; }

module.exports = { init, stop, check, apply, getStatus, DEFAULT_FEED };
