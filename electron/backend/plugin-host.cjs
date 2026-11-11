/**
 * 外置插件宿主
 * 发现、校验、安装、启停、卸载外部插件。插件通过 manifest.json 声明入口、环境变量、
 * 健康检查与界面地址；本文件不包含任何具体插件的业务逻辑。
 *
 * ── 给插件作者的界面约定 ────────────────────────────────────
 * 插件界面是**独立文档**（独立 BrowserWindow，`sandbox: true` / `contextIsolation: true`
 * / `nodeIntegration: false`），读不到主壳的样式与 localStorage。宿主因此做两件事：
 *   1. 窗口底色跟随宿主主题（`themeBackground()`）—— 不再是一块写死的暗色；
 *   2. 每次页面加载后把宿主的设计令牌注入进去（`themeCss()` → `insertCSS`），
 *      插件页面直接用 `var(--panel)` / `var(--accent)` / `var(--text)` 这套变量写样式，
 *      就能与主壳同一套色板、自动跟随明暗主题切换。
 * 令牌表是生成物（`theme-tokens.json`，由 `tools/gen-theme-tokens.cjs` 从
 * `src/styles/global.css` 抽出），因此宿主换肤时插件无需改代码。
 * 插件若要用登录态，在 manifest 的 `ui.tokenStorageKey` 里声明键名，宿主会在加载后写入。
 */
"use strict";
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");
const extensionManifest = require("./extensions/manifest.cjs");
const extensionPackage = require("./extensions/package.cjs");
const { StdioTransport } = require("./extensions/stdio-transport.cjs");
const { loadTrustStore } = require("./extensions/trust.cjs");
const { officialTrustStore, keyFingerprint } = require("./extensions/official-keys.cjs");
const { ActivationTransaction, recoverActivation } = require("./extensions/activation.cjs");

const MANIFEST = "manifest.json";
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const RESERVED_ENV = new Set([
  "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC",
]);
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const DEFAULT_HEALTH_TIMEOUT = 30000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

/** 官方插件的对外显示名：包清单里的 name 与签名一起发布，改一个称呼不必重签重发包，
 *  因此只在展示层按「官方发布者 + 精确插件 id」改名；第三方插件一律用清单自带的名字。 */
const DISPLAY_NAMES = new Map([
  ["com.agenthub.forwarding-suite", "模型增强执行器"],
]);
function displayName(m) {
  const name = m && m.publisher === "agenthub" ? DISPLAY_NAMES.get(m.id) : "";
  return name || (m && m.name) || "";
}

let ctx = null; // { app }
let state = null; // { plugins: { id: { enabled, secret, token } } }
let installing = false;
const procs = new Map(); // id -> { child, starting, stopping, restarts, lastError }
const windows = new Map(); // id -> BrowserWindow
const pluginOperations = new Set();
let nextGeneration = 0;

async function pluginOperation(id, operation) {
  if (installing || pluginOperations.has(id)) return { ok: false, message: "插件管理操作正在进行，请稍后重试" };
  pluginOperations.add(id);
  try { return await operation(); } finally { pluginOperations.delete(id); }
}

// 内置官方公钥 + 本地信任库。本地可以用同一个 keyId 声明撤销或有效期，
// 但不允许换成另一把公钥 —— 那等于把「官方签名」的定义改掉。
function mergedTrustStore() {
  const store = officialTrustStore();
  for (const [keyId, entry] of loadTrustStore(path.join(config.dataDir(), "plugin-trust.json"))) {
    const builtin = store.get(keyId);
    if (builtin && keyFingerprint(builtin.publicKey) !== keyFingerprint(entry.publicKey)) {
      throw new Error(`本地信任库的 ${keyId} 与内置官方公钥不一致，已拒绝加载`);
    }
    store.set(keyId, entry);
  }
  return store;
}

function extensionVerification() {
  const policy = ctx?.extensionPolicy || {};
  const store = mergedTrustStore();
  if (policy.trustStore instanceof Map) for (const [keyId, entry] of policy.trustStore) store.set(keyId, entry);
  const { trustStore: _policyTrust, ...rest } = policy;
  return {
    hostApi: "1.0.0",
    libc: process.platform === "linux" ? (process.report?.getReport().header.glibcVersionRuntime ? "glibc" : "musl") : undefined,
    ...rest,
    trustStore: store,
  };
}
function declaredChannelsOf(m) {
  return new Set((m.contributes?.providers || []).flatMap(provider => Array.isArray(provider.channels) ? provider.channels : []));
}

function extensionAuthorized(m, st) {
  const a = st.authorization;
  if (!a || a.publisherId !== m.publisher || !Array.isArray(a.permissions) || !Array.isArray(a.channels)
    || !m.permissions.required.every(permission => a.permissions.includes(permission))) return false;
  // 插件升级可能删掉旧渠道，而 plugins.json 里的授权仍保留旧渠道。那些渠道已经
  // 不在签名声明里，任何 capture 都会先检查声明、永远用不到；把整个插件判成未授权
  // 会让升级后直接停用（症状是模型目录全空、请求 503）。只要求至少还有一条当前
  // 声明内的授权渠道即可，其余由 pruneAuthorization 在启动/安装时清掉。
  const declared = declaredChannelsOf(m);
  return a.channels.some(channel => declared.has(channel));
}

function pruneAuthorization(m, st) {
  const a = st.authorization;
  if (!a || !Array.isArray(a.channels)) return false;
  const declared = declaredChannelsOf(m);
  const channels = a.channels.filter(channel => declared.has(channel));
  if (channels.length === a.channels.length) return false;
  st.authorization = { ...a, channels };
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结束进程树：Windows 下插件可能再派生子进程，只杀父进程会留孤儿 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      require("node:child_process").execFileSync(
        "taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }
      );
      return;
    } catch { /* 退回普通 kill */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

// ===== 路径 =====
function pluginsRoot() {
  if (process.env.AGENTHUB_PLUGIN_DIR) return process.env.AGENTHUB_PLUGIN_DIR;
  return path.join(config.dataDir(), "plugins");
}
function pluginDir(id) { return path.join(pluginsRoot(), id); }
function dataRoot() { return path.join(config.dataDir(), "plugin-data"); }
function dataDir(id) { return path.join(dataRoot(), id); }
function statePath() { return path.join(config.dataDir(), "plugins.json"); }

// ===== 状态 =====
function readState() {
  if (state) return state;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) || {};
  } catch {
    // 损坏的状态文件留档，避免反复解析失败
    try { fs.renameSync(statePath(), statePath() + ".bak"); } catch { /* 首次运行 */ }
  }
  state = { plugins: {} };
  const src = raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {};
  for (const [id, v] of Object.entries(src)) {
    if ((!ID_RE.test(id) && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)) || id.length > 128 || !v || typeof v !== "object") continue;
    state.plugins[id] = {
      enabled: v.enabled === true,
      secret: config.decryptSecret(v.secret || ""),
      token: config.decryptSecret(v.token || ""),
      authorization: v.authorization || null,
    };
  }
  return state;
}

function writeState() {
  if (!state) return;
  const out = { plugins: {} };
  for (const [id, v] of Object.entries(state.plugins)) {
    out.plugins[id] = {
      enabled: !!v.enabled,
      secret: config.encryptSecret(v.secret),
      token: config.encryptSecret(v.token),
      authorization: v.authorization || null,
    };
  }
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const temp = statePath() + `.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const file = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); fs.fsyncSync(file); } finally { fs.closeSync(file); }
    fs.renameSync(temp, statePath());
  } finally { try { fs.unlinkSync(temp); } catch { /* Renamed or failed before creation. */ } }
  invalidateSessionSnapshot();
}

function pluginState(id) {
  const st = readState();
  const cur = st.plugins[id] || {};
  let dirty = false;
  if (!cur.secret) { cur.secret = crypto.randomBytes(32).toString("base64"); dirty = true; }
  if (!cur.token) { cur.token = crypto.randomBytes(24).toString("hex"); dirty = true; }
  if (cur.enabled === undefined) { cur.enabled = false; dirty = true; }
  st.plugins[id] = cur;
  if (dirty) writeState();
  return cur;
}

// ===== 版本 =====
function compareVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function compatReason(m) {
  if (m.schema === 2) {
    try { extensionManifest.verifyManifest(m, extensionVerification()); return ""; }
    catch (error) { return String(error.message || "插件校验失败"); }
  }
  if (!ctx) return "";
  const appVersion = ctx.app.getVersion();
  if (m.minAppVersion && compareVersion(appVersion, m.minAppVersion) < 0) {
    return `需要 AgentHub >= ${m.minAppVersion}`;
  }
  if (m.maxAppVersion && compareVersion(appVersion, m.maxAppVersion) > 0) {
    return `仅支持 AgentHub <= ${m.maxAppVersion}`;
  }
  return "";
}

// ===== manifest =====
function validateManifest(m, dir) {
  if (!m || typeof m !== "object") return { ok: false, reason: "manifest 不是对象" };
  if (m.schema === 2) {
    try { extensionManifest.validateManifest(m); return { ok: true, manifest: m }; }
    catch (error) { return { ok: false, reason: String(error.message || "manifest 无效") }; }
  }
  if (m.schema !== undefined && m.schema !== 1) return { ok: false, reason: "manifest schema 不支持" };
  if (!ID_RE.test(String(m.id || ""))) return { ok: false, reason: "id 不合法" };
  if (!String(m.name || "").trim()) return { ok: false, reason: "缺少 name" };
  if (!String(m.version || "").trim()) return { ok: false, reason: "缺少 version" };

  const entry = String(m.entry || "");
  if (!entry || path.isAbsolute(entry)) return { ok: false, reason: "entry 必须是相对路径" };
  const entryAbs = path.resolve(dir, entry);
  if (entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) return { ok: false, reason: "entry 越界" };
  if (!fs.existsSync(entryAbs)) return { ok: false, reason: "entry 不存在" };

  const cwd = String(m.cwd || ".");
  const cwdAbs = path.resolve(dir, cwd);
  if (cwdAbs !== dir && !cwdAbs.startsWith(dir + path.sep)) return { ok: false, reason: "cwd 越界" };

  const env = m.env && typeof m.env === "object" ? m.env : {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return { ok: false, reason: `环境变量名不合法：${k}` };
    if (RESERVED_ENV.has(k)) return { ok: false, reason: `环境变量被保留：${k}` };
    if (typeof v !== "string") return { ok: false, reason: `环境变量值必须是字符串：${k}` };
  }

  const urlOk = (u) => !u || /^https?:\/\//i.test(String(u));
  if (m.ui && !urlOk(m.ui.url)) return { ok: false, reason: "ui.url 只允许 http/https" };
  if (m.health && !urlOk(m.health.url)) return { ok: false, reason: "health.url 只允许 http/https" };

  return { ok: true, manifest: m };
}

function readManifest(dir) {
  try {
    const filename = path.join(dir, MANIFEST), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { ok: false, reason: "manifest 不是普通文件或超过大小限制" };
    const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
    return validateManifest(raw, dir);
  } catch (e) {
    return { ok: false, reason: "manifest 缺失或无法解析" };
  }
}

// ===== 扫描 =====
function scan() {
  ensureClean();
  const root = pluginsRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const dirName of entries) {
    const dir = path.join(root, dirName);
    const parsed = readManifest(dir);
    if (!parsed.ok) {
      out.push({ id: dirName, dir, invalid: true, reason: parsed.reason, manifest: null });
      continue;
    }
    const m = parsed.manifest;
    if (m.id !== dirName) {
      out.push({ id: dirName, dir, invalid: true, reason: "目录名与 id 不一致", manifest: null });
      continue;
    }
    out.push({ id: m.id, dir, invalid: false, reason: "", manifest: m });
  }
  return out;
}

function find(id) {
  return scan().find((x) => x.id === id) || null;
}

function isRunning(id) {
  const p = procs.get(id);
  if (p?.transport) return p.transport.ready && !p.transport.closed;
  return !!p && !!p.child && p.child.exitCode === null;
}

function list() {
  return scan().map((item) => {
    if (item.invalid) {
      return {
        id: item.id, name: item.id, version: "", installed: false, invalid: true,
        reason: item.reason, enabled: false, running: false, compatible: false,
        compatReason: item.reason, lastError: "", ui: null, sidebar: null,
        bridgeKinds: [], embed: false,
      };
    }
    const m = item.manifest;
    const st = pluginState(m.id);
    const p = procs.get(m.id);
    const reason = compatReason(m);
    const bridge = parseBridge(m);
    return {
      id: m.id,
      name: displayName(m),
      version: m.version,
      installed: true,
      invalid: false,
      reason: "",
      enabled: !!st.enabled,
      running: isRunning(m.id),
      compatible: !reason,
      compatReason: reason,
      lastError: p ? p.lastError : "",
      minAppVersion: m.minAppVersion || "",
      maxAppVersion: m.maxAppVersion || "",
      ui: m.ui && m.ui.url ? { url: m.ui.url, title: m.ui.title || displayName(m) } : null,
      sidebar: m.sidebar ? { label: String(m.sidebar.label || displayName(m)) } : null,
      bridgeKinds: bridge ? bridge.kinds : [],
      embed: !!(m.ui && m.ui.url) && m.ui.embed !== false,
      schema: m.schema || 1,
      ready: m.schema === 2 ? !!p?.transport?.ready : isRunning(m.id),
      authorized: m.schema === 2 ? extensionAuthorized(m, st) : true,
      capabilities: m.schema === 2 ? m.capabilities : [],
      requiredPermissions: m.schema === 2 ? m.permissions.required : [],
      channels: m.schema === 2 ? [...new Set(m.contributes.providers.flatMap(provider => provider.channels))] : [],
      publisherId: m.schema === 2 ? m.publisher : "",
    };
  });
}

// ===== 桥接声明 / 内嵌地址 =====
/** manifest.bridge：插件愿意接收哪些宿主资源。宿主只认 kinds，不认插件身份 */
function parseBridge(m) {
  if (m?.schema === 2) return null; // Never broadcast a pool mirror to a provider.
  const b = m && m.bridge;
  if (!b || typeof b !== "object" || !b.url) return null;
  const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k) => typeof k === "string" && k) : [];
  if (!kinds.length) return null;
  return { url: String(b.url), kinds };
}

function bridgeOf(id) {
  const item = find(id);
  if (!item || item.invalid) return null;
  return parseBridge(item.manifest);
}

/** 插件的管理令牌（桥接推送用，不外传渲染层） */
function tokenOf(id) { return pluginState(id).token; }

/** 内嵌地址：在 ui.url 上追加令牌，供跨域 iframe 首次自动登录。
 *  令牌由插件进程自己从地址栏读走并立即抹除（见插件侧 web-transport）。 */
function embedUrl(id) {
  const item = find(id);
  if (!item || item.invalid) return { ok: false, message: "插件未安装或已损坏" };
  const m = item.manifest;
  if (!m.ui || !m.ui.url) return { ok: false, message: "插件没有界面" };
  if (m.ui.embed === false) return { ok: false, message: "该插件不支持内嵌" };
  let u;
  try { u = new URL(String(m.ui.url)); } catch { return { ok: false, message: "插件界面地址非法" }; }
  u.searchParams.set("token", pluginState(id).token);
  return { ok: true, id, url: u.toString(), title: m.ui.title || displayName(m) };
}

// ===== 运行 =====
function buildEnv(m, id) {
  const st = pluginState(id);
  const vars = {
    id,
    dir: pluginDir(id),
    dataDir: dataDir(id),
    secret: st.secret,
    token: st.token,
    appVersion: ctx ? ctx.app.getVersion() : "",
  };
  const out = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
  const env = m.env || {};
  for (const [k, tpl] of Object.entries(env)) {
    out[k] = String(tpl).replace(/\$\{(\w+)\}/g, (all, key) => (key in vars ? vars[key] : all));
  }
  return out;
}

async function ping(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function onExit(id, code) {
  const p = procs.get(id);
  if (!p) return;
  p.child = null;
  if (p.stopping) { p.stopping = false; return; }
  if (p.lastError.includes("端口被占用")) return;
  const st = readState();
  if (!st.plugins[id] || !st.plugins[id].enabled) return;

  p.restarts = p.restarts.filter((t) => Date.now() - t < RESTART_WINDOW_MS);
  if (p.restarts.length >= MAX_RESTARTS) {
    p.lastError = `连续退出（code=${code}），已停止自动重启`;
    return;
  }
  p.restarts.push(Date.now());
  setTimeout(() => {
    if (!p.stopping) start(id).catch(() => { /* 重启失败由下次状态查询体现 */ });
  }, 2000).unref?.();
}

async function start(id) {
  const item = find(id);
  if (!item || item.invalid) return { ok: false, message: "插件未安装或已损坏" };
  const m = item.manifest;
  const reason = compatReason(m);
  if (reason) return { ok: false, message: reason };
  if (m.schema === 2) return startExtension(item);
  if (isRunning(id)) return { ok: true, already: true };

  let p = procs.get(id);
  if (p && p.starting) return { ok: false, message: "正在启动" };
  if (!p) { p = { child: null, starting: false, stopping: false, restarts: [], lastError: "" }; procs.set(id, p); }
  p.starting = true;
  p.stopping = false;
  p.lastError = "";

  try {
    fs.mkdirSync(dataDir(id), { recursive: true });
    const child = spawn(process.execPath, [path.join(item.dir, m.entry)], {
      cwd: path.resolve(item.dir, m.cwd || "."),
      env: buildEnv(m, id),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.child = child;
    if (p.stopping) {
      killTree(child);
      return { ok: false, message: "已取消启动" };
    }

    const log = (prefix) => (b) => {
      const s = String(b).trimEnd();
      if (s.includes("EADDRINUSE")) p.lastError = "端口被占用";
      try { console.log(`[plugin:${id}] ${prefix}${s}`); } catch { /* 无控制台 */ }
    };
    child.stdout.on("data", log(""));
    child.stderr.on("data", log("! "));
    child.on("error", (e) => { p.lastError = e.message; p.child = null; });
    child.on("exit", (code) => onExit(id, code));

    const healthUrl = m.health && m.health.url ? String(m.health.url) : "";
    const timeout = Number(m.health && m.health.timeoutMs) || DEFAULT_HEALTH_TIMEOUT;
    if (!healthUrl) {
      await sleep(1500);
      if (isRunning(id)) return { ok: true };
      return { ok: false, message: p.lastError || "插件进程未保持运行" };
    }
    const rounds = Math.max(1, Math.ceil(timeout / 1000));
    for (let i = 0; i < rounds; i++) {
      await sleep(1000);
      if (!isRunning(id)) break;
      if (await ping(healthUrl)) return { ok: true };
    }
    p.lastError = p.lastError || "健康检查超时";
    p.stopping = true;
    killTree(p.child);
    return { ok: false, message: p.lastError };
  } catch (e) {
    p.lastError = String((e && e.message) || e);
    return { ok: false, message: p.lastError };
  } finally {
    p.starting = false;
  }
}

async function startExtension(item) {
  const m = item.manifest, st = pluginState(m.id);
  if (pruneAuthorization(m, st)) writeState();
  if (!extensionAuthorized(m, st)) return { ok: false, message: "插件所需号池渠道或权限尚未授权" };
  const previous = procs.get(m.id);
  if (previous?.transport?.ready) return { ok: true, already: true };
  if (previous?.starting) return { ok: false, message: "正在启动" };
  const generation = ++nextGeneration;
  const p = { child: null, starting: true, stopping: false, restarts: previous?.restarts || [], lastError: "" };
  procs.set(m.id, p);
  clearTimeout(previous?.restartTimer);
  if (previous?.transport) await previous.transport.stop();
  if (p.stopping || procs.get(m.id) !== p) { p.starting = false; return { ok: false, message: "已取消启动" }; }
  const transport = p.transport = new StdioTransport({
    directory: item.dir, dataDir: dataDir(m.id), generation,
    verification: extensionVerification(), killTree,
    bindSession: (peer, identity) => ctx?.bindExtensionSession?.(peer, identity, m) || (() => {}),
    onExit: event => {
      if (procs.get(m.id) !== p || p.transport !== transport || event.generation !== generation) return;
      p.child = null;
      invalidateSessionSnapshot();
      if (event.stopping || p.stopping || !readState().plugins[m.id]?.enabled) return;
      p.restarts = p.restarts.filter(time => Date.now() - time < RESTART_WINDOW_MS);
      if (p.restarts.length >= 5) { p.lastError = "插件连续退出，已熔断自动重启"; return; }
      p.restarts.push(Date.now());
      p.lastError = "插件进程退出，等待退避重启";
      p.restartTimer = setTimeout(() => {
        if (procs.get(m.id) === p && !p.stopping && readState().plugins[m.id]?.enabled) start(m.id).catch(() => {});
      }, Math.min(60000, 1000 * 2 ** (p.restarts.length - 1)));
      p.restartTimer.unref?.();
    },
  });
  try {
    await transport.start();
    p.child = transport.child;
    if (procs.get(m.id) !== p || p.stopping) { await transport.stop(); invalidateSessionSnapshot(); return { ok: false, message: "已取消启动" }; }
    invalidateSessionSnapshot();
    return { ok: true };
  } catch {
    p.lastError = "插件启动、完整性校验或握手失败";
    invalidateSessionSnapshot();
    return { ok: false, message: p.lastError };
  } finally { p.starting = false; }
}

async function authorize(id, { permissions, channels } = {}) {
  const item = find(id);
  if (!item || item.invalid || item.manifest.schema !== 2) return { ok: false, message: "不是可授权的新版插件" };
  const m = item.manifest, reason = compatReason(m);
  if (reason) return { ok: false, message: reason };
  const declaredPermissions = [...m.permissions.required, ...m.permissions.optional];
  const declaredChannels = m.contributes.providers.flatMap(provider => provider.channels);
  if (!Array.isArray(permissions) || !Array.isArray(channels) || permissions.some(value => !declaredPermissions.includes(value)) || channels.some(value => !declaredChannels.includes(value))) return { ok: false, message: "授权超出插件已签声明" };
  await stop(id); // Changing authorization revokes the current process/session.
  const st = pluginState(id);
  st.authorization = { publisherId: m.publisher, permissions: [...new Set(permissions)], channels: [...new Set(channels)] };
  writeState();
  return { ok: true, authorized: extensionAuthorized(m, st) };
}

// ===== 会话快照（热路径缓存）=====
// providerSessions() 处在转发链路的极热路径上：每次授权检查、authority.watch 的 250ms
// 周期巡检、插件流式响应的每个事件都会经由 resolve()/assertCurrent()/refFor() 调到这里。
// 原实现每次都全目录 readdirSync + 逐 manifest 读取校验 + Ed25519 验签，单次流式请求
// 可触发数百次同步 IO 与验签，全部阻塞在主进程 event loop 上。
// 快照在所有状态变更点显式失效（writeState / transport 退出 / 启停路径），
// 1s TTL 只是防漏网的兜底；未变更的窗口内快照与实时计算结果一致。
let sessionSnapshot = null;
function invalidateSessionSnapshot() { sessionSnapshot = null; }

function providerSessions() {
  if (sessionSnapshot && Date.now() - sessionSnapshot.at < 1000) return sessionSnapshot.value;
  const items = scan();
  const result = [...procs].flatMap(([id, p]) => {
    if (!p.transport?.ready || p.stopping || !readState().plugins[id]?.enabled) return [];
    const item = items.find(x => x.id === id);
    if (!item || item.invalid || item.manifest.schema !== 2 || compatReason(item.manifest) || !extensionAuthorized(item.manifest, pluginState(id))) return [];
    const authorization = pluginState(id).authorization;
    const declared = declaredChannelsOf(item.manifest);
    return [{ id, manifest: item.manifest, identity: p.transport.session.identity, session: p.transport.session,
      permissions: [...authorization.permissions], channels: [...new Set(authorization.channels.filter(channel => declared.has(channel)))] }];
  });
  sessionSnapshot = { at: Date.now(), value: result };
  return snapshotView();
}
// 调用方拿到的是快照的防御性拷贝（元素与数组都新建）：测试与上层有对 channels 原地
// sort 的用法，绝不能让它们变异到缓存本体。
function snapshotView() {
  return sessionSnapshot.value.map(item => ({ ...item, permissions: [...item.permissions], channels: [...item.channels] }));
}

async function stop(id) {
  const p = procs.get(id);
  if (p) {
    p.stopping = true;
    clearTimeout(p.restartTimer);
  }
  const st = readState();
  if (st.plugins[id]) {
    st.plugins[id].enabled = false;
    writeState();
  }
  if (p?.transport) await p.transport.stop();
  else if (p) killTree(p.child);
  invalidateSessionSnapshot();
  return { ok: true };
}

async function toggle(id, enabled) {
  const item = find(id);
  if (!item || item.invalid) return { ok: false, message: "插件未安装或已损坏" };
  const st = pluginState(id);
  if (enabled) {
    const r = await start(id);
    if (!r.ok) return r;
    st.enabled = true;
    writeState();
    return { ok: true };
  }
  st.enabled = false;
  writeState();
  await stop(id);
  return { ok: true };
}

async function resumeEnabled({ schema } = {}) {
  for (const item of scan()) {
    if (item.invalid) continue;
    if (schema !== undefined && item.manifest.schema !== schema) continue;
    const st = pluginState(item.manifest.id);
    if (!st.enabled) continue;
    try { await start(item.manifest.id); } catch { /* 单个失败不影响其它插件 */ }
  }
}

function killAll() {
  for (const [, p] of procs) {
    p.stopping = true;
    clearTimeout(p.restartTimer);
    if (p.transport) {
      p.transport.stopping = true;
      p.transport.closed = true;
      p.transport.ready = false;
      p.transport.revoke?.();
      p.transport.peer?.close(new Error("Host shutting down"));
      killTree(p.transport.child);
    }
    killTree(p.child);
  }
  invalidateSessionSnapshot();
  for (const [, w] of windows) {
    try { if (!w.isDestroyed()) w.close(); } catch { /* 已关闭 */ }
  }
}

// ===== 安装 / 卸载 =====
async function renameRetry(from, to, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (i === tries - 1) {
        // Windows 上插件进程退出后 .node / DLL 可能还被扫描器或加载器占着
        if (process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
          throw new Error("文件被占用，插件目录暂时无法替换；请稍后重试，或关闭杀毒软件的实时扫描");
        }
        throw e;
      }
      await sleep(400);
    }
  }
}

async function install(zipPath) {
  if (installing || pluginOperations.size) return { ok: false, message: "插件管理操作正在进行" };
  ensureClean();
  installing = true;
  let stage;
  let hadOld = false;
  let transaction, installedId, wasRunning = false;
  const restoreState = (id, enabled) => { pluginState(id).enabled = enabled; writeState(); };
  try {
    recoverActivation(pluginsRoot(), restoreState);
    const size = fs.statSync(zipPath).size;
    if (size > MAX_ZIP_BYTES) return { ok: false, message: "插件包超过 200MB" };
    const schema = await extensionPackage.packageSchema(zipPath);
    if (![1, 2].includes(schema)) return { ok: false, message: "插件 schema 不支持" };
    const prepared = schema === 2
      ? await extensionPackage.stagePackage(zipPath, { parentDir: pluginsRoot(), verification: extensionVerification() })
      : await extensionPackage.stageLegacyPackage(zipPath, { parentDir: pluginsRoot() });
    const root = stage = prepared.stageDir;
    const parsed = readManifest(root);
    if (!parsed.ok) return { ok: false, message: parsed.reason };
    const m = parsed.manifest;
    installedId = m.id;
    const dest = pluginDir(m.id);
    hadOld = fs.existsSync(dest);
    if (hadOld) {
      const old = readManifest(dest);
      if (!old.ok || (old.manifest.schema || 1) !== (m.schema || 1) || m.schema === 2 && old.manifest.publisher !== m.publisher) return { ok: false, message: "禁止跨 schema 或发布者替换已有插件" };
      if (m.schema === 2 && old.manifest.dataSchema !== m.dataSchema) return { ok: false, message: "插件私有数据版本变化需要迁移支持，已保持旧版" };
    }
    wasRunning = isRunning(m.id);
    // 全新安装 = 装完即用：签名声明内的权限与渠道在下面一次性授权，安装后直接启用并启动，
    // 用户不再需要先去开关一次才能看到执行来源。更新保持用户原有的启停选择。
    const wasEnabled = hadOld ? !!pluginState(m.id).enabled : true;
    if (wasRunning) { await stop(m.id); await sleep(600); }

    fs.mkdirSync(pluginsRoot(), { recursive: true });
    transaction = new ActivationTransaction({ root: path.dirname(root), id: m.id, stageDir: root, priorEnabled: wasEnabled });
    await transaction.activate(renameRetry);

    const st = pluginState(m.id);
    if (pruneAuthorization(m, st)) writeState();
    // 自动授权只给插件自己签名声明的 required 权限与全部声明渠道：
    // 不越出清单，也不替用户扩展 optional 权限（例如读取请求头）。
    let autoGranted = false;
    if (!hadOld && m.schema === 2 && !extensionAuthorized(m, st)) {
      st.authorization = { publisherId: m.publisher, permissions: [...new Set(m.permissions.required)], channels: [...declaredChannelsOf(m)] };
      autoGranted = true;
    }
    st.enabled = wasEnabled && (m.schema !== 2 || extensionAuthorized(m, st));
    writeState();

    let warning = "";
    if (st.enabled && (wasRunning || !hadOld)) {
      const r = await start(m.id);
      if (!r.ok) {
        warning = r.message;
        st.enabled = false;
        writeState();
        if (hadOld) {
          await stop(m.id);
          transaction.rollback(restoreState);
          transaction = null;
          const restored = wasRunning ? await start(m.id) : { ok: true };
          return { ok: false, message: restored.ok ? "新版插件启动失败，已恢复旧版" : "新版失败，旧版目录已恢复但重启失败", rollback: restored.ok };
        }
      }
    }
    transaction.commit();
    // 新装插件把声明渠道显式固定到它，等同于用户在「设置」里点一次「全部固定」。
    // 自定义提供商占用、已绑定到其它来源、当前不可用的渠道由回调自行跳过。
    let autoBound = null;
    if (!hadOld && m.schema === 2 && isRunning(m.id)) {
      try { autoBound = await (ctx?.onExtensionActivated?.(m) ?? null); } catch { autoBound = null; }
    }
    return { ok: true, id: m.id, name: displayName(m), version: m.version, updated: hadOld, warning, autoGranted,
      autoEnabled: !hadOld && st.enabled && isRunning(m.id), autoBound,
      requiresAuthorization: m.schema === 2 && !extensionAuthorized(m, st) };
  } catch (e) {
    if (transaction && !transaction.committed) {
      try {
        if (installedId) await stop(installedId);
        transaction.rollback(restoreState);
        if (wasRunning && installedId) await start(installedId);
      } catch { return { ok: false, message: "插件激活失败且恢复未完成，已保留 journal 与备份" }; }
    }
    return { ok: false, message: String((e && e.message) || e) };
  } finally {
    installing = false;
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

function closeWindow(id) {
  const w = windows.get(id);
  if (w) {
    try { if (!w.isDestroyed()) w.close(); } catch { /* 已关闭 */ }
    windows.delete(id);
  }
}

// ===== 主题令牌：让插件界面与主壳同一套色板 =====
// 插件界面是**独立文档**（独立 BrowserWindow / iframe），读不到主壳的 :root 变量。
// 宿主把同一份设计令牌发过去，插件页面按这套变量写样式就能与主壳逐字同色。
// 令牌表由 tools/gen-theme-tokens.cjs 从 src/styles/global.css 生成（单一事实源，
// 不手抄，避免两处色板漂移；npm test 里有漂移检查兜底）。
let tokensCache;
function themeTokens() {
  if (tokensCache !== undefined) return tokensCache;
  try {
    tokensCache = JSON.parse(fs.readFileSync(path.join(__dirname, "theme-tokens.json"), "utf8"));
  } catch {
    // 生成物缺失（未跑生成脚本 / 打包漏带）：退化成"不注入"，绝不影响插件能否打开
    tokensCache = null;
  }
  return tokensCache;
}

/** 当前主题（只认 light，其余一律按暗色 —— 与 config.cjs 的归一化同口径） */
function currentTheme() {
  return config.get().theme === "light" ? "light" : "dark";
}

/** 当前主题的令牌表；生成物缺失时返回空对象 */
function themeVars(theme) {
  const t = themeTokens();
  if (!t) return {};
  const vars = theme === "light" ? t.light : t.dark;
  return vars && typeof vars === "object" ? vars : {};
}

/** 当前主题令牌 → 一段可直接 insertCSS 的 `:root{...}` 块（无令牌时返回空串） */
function themeCss(theme) {
  const vars = themeVars(theme);
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("");
  return body ? `:root{${body}}` : "";
}

/** 插件窗口的初始底色：跟随宿主主题。
 *  原来是写死的暗色 —— 亮色主题下开插件窗口会先闪一块纯黑，观感与主壳完全脱节。 */
function themeBackground() {
  return themeVars(currentTheme())["--bg"] || "#0a0c0f";
}

async function uninstall(id) {
  const item = find(id);
  if (!item) return { ok: false, message: "插件不存在" };
  await stop(id);
  closeWindow(id);
  const dir = pluginDir(id);
  try {
    if (fs.existsSync(dir)) {
      const trash = dir + `.removed-${Date.now()}`;
      await renameRetry(dir, trash);
      try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* 下次启动清理 */ }
    }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  const st = readState();
  delete st.plugins[id];
  writeState();
  procs.delete(id);
  invalidateSessionSnapshot();
  return { ok: true };
}

// ===== 打开界面 =====
async function open(id) {
  const item = find(id);
  if (!item || item.invalid) return { ok: false, message: "插件未安装或已损坏" };
  const m = item.manifest;
  if (!m.ui || !m.ui.url) return { ok: false, message: "插件没有界面" };
  const r = await start(id);
  if (!r.ok) return r;
  const st = pluginState(id);
  st.enabled = true;
  writeState();

  const { BrowserWindow } = require("electron");
  let win = windows.get(id);
  if (win && !win.isDestroyed()) { win.focus(); return { ok: true }; }

  try {
    win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: m.ui.title || displayName(m),
    autoHideMenuBar: true,
    show: false,
    // 底色跟随宿主主题（原来是写死的暗色，亮色主题下会先闪一块纯黑）
    backgroundColor: themeBackground(),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }

  const key = m.ui.tokenStorageKey ? String(m.ui.tokenStorageKey) : "";
  const token = pluginState(id).token;
  const css = themeCss(currentTheme());
  let injected = false;
  win.webContents.on("did-finish-load", () => {
    // 每次加载都注入一次（含 reload 之后）：插件是独立文档，读不到主壳的 :root 变量。
    // 注入失败不能挡住窗口显示 —— 第三方页面可能带 CSP，insertCSS 会 reject。
    const show = () => { try { win.show(); } catch { /* 窗口已销毁 */ } };
    const apply = css ? win.webContents.insertCSS(css).catch(() => {}) : Promise.resolve();
    apply.then(() => {
      if (injected) { show(); return; }
      injected = true;
      if (!key) { show(); return; }
      win.webContents
        .executeJavaScript(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(token)}); true;`)
        .then(() => win.webContents.reload())
        .catch(show);
    });
  });
  win.on("closed", () => { windows.delete(id); });
  windows.set(id, win);
  win.loadURL(m.ui.url);
  return { ok: true };
}

// ===== 生命周期 =====
function cleanupStale() {
  let names = [];
  try { names = fs.readdirSync(pluginsRoot()); } catch { return; }
  for (const n of names) {
    if (n.startsWith(".incoming-") || n.startsWith(".bak-") || n.startsWith(".removed-")) {
      try { fs.rmSync(path.join(pluginsRoot(), n), { recursive: true, force: true }); } catch { /* 下次再清 */ }
    }
  }
}

let cleaned = false;
function ensureClean() {
  if (cleaned || installing) return; // 安装中不清理，避免误删暂存目录
  recoverActivation(pluginsRoot(), (id, enabled) => { pluginState(id).enabled = enabled; writeState(); });
  cleaned = true;
  cleanupStale();
}

function init(o) {
  ctx = o;
}

module.exports = {
  init, list, install,
  uninstall: id => pluginOperation(id, () => uninstall(id)),
  toggle: (id, enabled) => pluginOperation(id, () => toggle(id, enabled)),
  open: id => pluginOperation(id, () => open(id)),
  start: id => pluginOperation(id, () => start(id)),
  stop: id => pluginOperation(id, () => stop(id)),
  resumeEnabled, killAll,
  pluginDir, dataDir, pluginsRoot,
  embedUrl, bridgeOf, tokenOf,
  authorize: (id, args) => pluginOperation(id, () => authorize(id, args)),
  providerSessions,
};
