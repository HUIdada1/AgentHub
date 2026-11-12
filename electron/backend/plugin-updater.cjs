"use strict";
// 官方插件更新器。业务（feed 解析 / 平台与版本匹配 / sha256 校验 / 磁盘余量 / 交给
// plugin-host 安装的事务）在本文件；**网络出口不在**——2026-11-12 板块 4C 起，
// 取字节这件事收口到 proxy/platform 的 fetchBinary 契约：
//   · 桌面（platform/electron.cjs）：独立 session 分区 "plugin-update" + 系统代理 +
//     本机代理端口候选（与改造前逐参数一致，桌面行为零变化）；
//   · 容器（platform/node.cjs）：undici，代理只认 HTTPS_PROXY / HTTP_PROXY 等环境变量，
//     绝不探本机端口（容器里的 127.0.0.1 是容器自己，探 7897 必然假阴性）。
// 这里不得出现顶层 require("electron")：gateway 一旦 require 本文件就会把 electron
// 带进容器启动链（专项 §八 V1、§十 第 5 条 T8 断言）。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const platform = require("./proxy/platform/index.cjs");
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
// 容器形态的自动更新开关：默认**关**（专项 §四 S2「比桌面保守」、§七 R3「不悄悄换执行引擎」）。
// 个人 NAS 想要桌面式省心，设 AGENTHUB_PLUGIN_AUTO_UPDATE=1 即可，不改 config.json。
const AUTO_UPDATE_ENV = "AGENTHUB_PLUGIN_AUTO_UPDATE";
// 部署期换源（内网镜像 / 分平台 feed）：容器里比 config 更近一层的事实源。
// 桌面不设这个变量 → 取的是 config.plugins.feedUrl，与改造前一致。
const FEED_ENV = "AGENTHUB_PLUGIN_FEED";

let ctx = null;
let timer = null;
let status = idleStatus();
let inFlight = null;

function idleStatus() {
  // autoApply / form 是板块 4C 新增的**只增**字段（旧消费方各取所需，不受影响）：
  // 前端要据此诚实显示「容器形态默认手动更新」，不能让用户以为自动更新在跑。
  // 这里就按形态算真值，而不是等 init 才填——容器在 task-5 接线前直接查 status 也不会被骗。
  return { state: "idle", lastCheckAt: 0, lastError: "", available: [], lastInstalled: null, feed: "", lastGoodProxy: "", autoApply: autoApplyAllowed(), form: platform.form() };
}
function publish(patch) {
  status = { ...status, ...patch };
  try { ctx?.onStatus?.(status); } catch { /* 状态回调失败不影响更新流程 */ }
  return status;
}

// ===== 配置 =====
function readConfig() {
  try { return config.loadConfig() || {}; } catch { return {}; }
}

/** 只接受 https 的绝对地址；其它（畸形值、http:// 明文源）一律回空 = 视为没配 */
function normalizeFeedUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try { return new URL(text).protocol === "https:" ? text : ""; } catch { return ""; }
}

/**
 * 生效的 feed 地址，**以及是谁在生效**：env(部署期) > config(界面 PUT) > default(内置)。
 *
 * 部署期这一层只认 https（与入口层 PUT /api/plugins/feed 同口径）：非 https 或畸形值一律
 * 视为没配，回落上一级，绝不因为一个写错的环境变量就把更新源换成明文地址。
 * config 那一层保持原样不过滤（桌面今天就是这个行为，不加严）。
 *
 * 为什么必须把 source 一起回出来：env 压在 config 之上，用户在插件页改 feed、页面显示保存成功，
 * 实际生效的却还是 compose 里那行 env —— 这正是本项目要消灭的「改了不生效」。
 * 所以 source==="env" 时带 lockedByEnv=true，入口层据此把 PUT 拒成明确错误而不是假装写进去了。
 */
function pickFeed(cfg) {
  const fromEnv = normalizeFeedUrl(process.env[FEED_ENV]);
  if (fromEnv) return { feedUrl: fromEnv, feedSource: "env", lockedByEnv: true };
  const p = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
  const configured = typeof p.feedUrl === "string" ? p.feedUrl.trim() : "";
  if (configured) return { feedUrl: configured, feedSource: "config", lockedByEnv: false };
  return { feedUrl: DEFAULT_FEED, feedSource: "default", lockedByEnv: false };
}

/** 只读当前生效的 feed 与来源（入口层 GET/PUT 回显用它，别自己去拼 config，口径会分叉） */
function getFeedSource() { return pickFeed(readConfig()); }

function pluginSettings() {
  const cfg = readConfig();
  const p = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
  const feed = pickFeed(cfg);
  return {
    autoUpdate: p.autoUpdate !== false,
    autoDownload: p.autoDownload !== false,
    // 桌面两个变量都不设 → source=config/default，feedUrl 与改造前逐字一致
    feedUrl: feed.feedUrl,
    feedSource: feed.feedSource,
    lockedByEnv: feed.lockedByEnv,
    autoCheck: !(cfg.update && cfg.update.autoCheck === false),
    // 自动链路（定时器 + 到点自动装）是否允许跑。桌面恒等于今天的行为；容器默认 false。
    // 注意：**只**闸自动链路，不闸 feed.plan 的 autoUpdate/autoDownload 入参——
    // 后者一旦被进程内置为 false，容器里手动「检查更新」就恒为空，Web 端等于没有更新功能
    // （与专项 §六 验收 5「update/check 出条目 → update/apply」冲突）。
    autoApply: autoApplyAllowed(),
  };
}

/** 容器形态默认不跑自动更新（S2 保守 + R3 不悄悄换执行引擎）；AGENTHUB_PLUGIN_AUTO_UPDATE=1 放行 */
function autoApplyAllowed() {
  if (platform.isElectron) return true;
  return process.env[AUTO_UPDATE_ENV] === "1";
}

function isNetworkError(error) {
  if (error && error.networkLike) return true;   // 容器实现（undici）显式标注的传输类错误
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

/** 候选顺序：环境变量 → 上次成功的 → 本机在监听的常见端口（容器形态这一项是空集） */
async function proxyCandidates() {
  const list = [];
  for (const key of PROXY_ENV_KEYS) {
    const rule = normalizeProxy(process.env[key]);
    if (rule) list.push(rule);
  }
  const remembered = normalizeProxy(loadState().lastGoodProxy);
  if (remembered) list.push(remembered);
  for (const rule of await platform.localProxyCandidates()) list.push(rule);
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buffer = await platform.fetchBinary(url, { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, proxyRule: rule });
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
    // 入口注入的落地后钩子（板块 4C 新增，桌面 main.cjs 不传 → 行为与改造前一致）。
    // 容器形态用它把 plugin-host 的「装完即用」自动授权/自动启用收回（专项 §四 S1 / §三 F4）。
    try { ctx?.onInstalled?.(result); } catch { /* 钩子失败不影响更新结果 */ }
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

/**
 * 下载并安装当前清单里符合条件的条目。
 * @param options.ids 只装点选的 id（板块 4C 新增，供容器 REST 的「逐条安装」用）；
 *                    不传 = 装全部 = 改造前行为（桌面 plugin_update_apply 走这条）。
 */
async function apply({ ids } = {}) {
  if (status.state === "checking" || status.state === "downloading" || status.state === "installing") return { ok: false, message: "插件更新正在进行" };
  if (!status.available.length) await check({ manual: false });
  if (!status.available.length) return { ok: true, results: [] };
  let picked = [...status.available];
  if (Array.isArray(ids) && ids.length) {
    const want = new Set(ids.map(String));
    picked = picked.filter(item => want.has(item.id));
    if (!picked.length) return { ok: false, message: "所选插件不在当前可更新清单里，请先检查更新" };
  }
  const results = await applyAll(picked);
  return { ok: results.every(row => row.ok), results };
}

// ===== 生命周期 =====
async function tick() {
  clearTimeout(timer);
  // 容器形态默认不跑自动链路（S2 保守 / R3）：不检查、不下载、不重排定时器。
  // 手动入口（ipc plugin_update_check / gateway 的 POST /api/plugins/update/check）不经这里。
  if (!autoApplyAllowed()) return;
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
  const autoApply = autoApplyAllowed();
  status = {
    ...idleStatus(),
    autoApply,
    form: platform.form(),
    lastCheckAt: Number(saved.lastCheckAt) || 0,
    lastGoodProxy: typeof saved.lastGoodProxy === "string" ? saved.lastGoodProxy : "",
  };
  cleanupUpdates();
  clearTimeout(timer);
  // 桌面：与改造前一致，启动 +90s 首查。容器：默认不排（autoApply=false），
  // 需要它跑起来要显式设 AGENTHUB_PLUGIN_AUTO_UPDATE=1。
  if (autoApply) {
    timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
    timer?.unref?.();
  }
}

function stop() { clearTimeout(timer); timer = null; }

function getStatus() { return status; }

module.exports = {
  init, stop, check, apply, getStatus, DEFAULT_FEED, autoApplyAllowed,
  // 生效配置的只读取数口：入口层的 GET /api/plugins/feed 要回显「当前在用哪个源、是谁在生效」，
  // PUT 要据 lockedByEnv 决定拒绝还是落盘 —— 口径统一在这里，别各自去拼 config。
  getSettings: pluginSettings,
  getFeedSource,
};
