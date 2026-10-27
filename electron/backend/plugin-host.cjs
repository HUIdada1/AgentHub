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

const MANIFEST = "manifest.json";
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const RESERVED_ENV = new Set([
  "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC",
]);
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const DEFAULT_HEALTH_TIMEOUT = 30000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

let ctx = null; // { app }
let state = null; // { plugins: { id: { enabled, secret, token } } }
let installing = false;
const procs = new Map(); // id -> { child, starting, stopping, restarts, lastError }
const windows = new Map(); // id -> BrowserWindow

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
    if (!ID_RE.test(id) || !v || typeof v !== "object") continue;
    state.plugins[id] = {
      enabled: v.enabled === true,
      secret: config.decryptSecret(v.secret || ""),
      token: config.decryptSecret(v.token || ""),
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
    };
  }
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(out, null, 2));
  } catch { /* 磁盘异常不影响运行 */ }
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
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
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
      name: m.name,
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
      ui: m.ui && m.ui.url ? { url: m.ui.url, title: m.ui.title || m.name } : null,
      sidebar: m.sidebar ? { label: String(m.sidebar.label || m.name) } : null,
      bridgeKinds: bridge ? bridge.kinds : [],
      embed: !!(m.ui && m.ui.url) && m.ui.embed !== false,
    };
  });
}

// ===== 桥接声明 / 内嵌地址 =====
/** manifest.bridge：插件愿意接收哪些宿主资源。宿主只认 kinds，不认插件身份 */
function parseBridge(m) {
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
  return { ok: true, id, url: u.toString(), title: m.ui.title || m.name };
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

async function stop(id) {
  const p = procs.get(id);
  if (p) {
    p.stopping = true;
    killTree(p.child);
  }
  const st = readState();
  if (st.plugins[id]) {
    st.plugins[id].enabled = false;
    writeState();
  }
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

async function resumeEnabled() {
  for (const item of scan()) {
    if (item.invalid) continue;
    const st = pluginState(item.manifest.id);
    if (!st.enabled) continue;
    try { await start(item.manifest.id); } catch { /* 单个失败不影响其它插件 */ }
  }
}

function killAll() {
  for (const [, p] of procs) {
    p.stopping = true;
    killTree(p.child);
  }
  for (const [, w] of windows) {
    try { if (!w.isDestroyed()) w.close(); } catch { /* 已关闭 */ }
  }
}

// ===== 安装 / 卸载 =====
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const cp = require("node:child_process");
  const dir = path.dirname(zip);
  const base = path.basename(zip);
  // 用「工作目录 + 相对包名」调用 tar：Windows 下 GNU tar 会把 C:\ 前缀当成 host:path
  // 去解析（报 Cannot connect to C:），相对名可绕开；-C 的目标目录不受该解析影响
  try {
    cp.execFileSync("tar", ["-xf", base, "-C", dest], { cwd: dir, stdio: "ignore" });
    return;
  } catch { /* 换下一种 */ }
  try {
    cp.execFileSync("tar", ["--force-local", "-xf", zip, "-C", dest], { stdio: "ignore" });
    return;
  } catch { /* 系统 tar 可能是 bsdtar，不认 --force-local */ }
  const q = (v) => String(v).replace(/'/g, "''");
  cp.execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(dest)}' -Force`], { stdio: "ignore" });
}

function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of subs) {
    const p = path.join(dir, d.name);
    if (fs.existsSync(path.join(p, MANIFEST))) return p;
  }
  return null;
}

async function renameRetry(from, to, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i === tries - 1) throw e; await sleep(300); }
  }
}

async function install(zipPath) {
  if (installing) return { ok: false, message: "正在安装其他插件" };
  ensureClean();
  installing = true;
  const stage = path.join(pluginsRoot(), `.incoming-${Date.now()}`);
  let hadOld = false;
  try {
    const size = fs.statSync(zipPath).size;
    if (size > MAX_ZIP_BYTES) return { ok: false, message: "插件包超过 200MB" };
    extractZip(zipPath, stage);
    const root = findManifestRoot(stage);
    if (!root) return { ok: false, message: "插件包缺少 manifest.json" };
    const parsed = readManifest(root);
    if (!parsed.ok) return { ok: false, message: parsed.reason };
    const m = parsed.manifest;
    const dest = pluginDir(m.id);
    hadOld = fs.existsSync(dest);
    const wasRunning = isRunning(m.id);
    const wasEnabled = hadOld ? !!pluginState(m.id).enabled : true;
    if (wasRunning) { await stop(m.id); await sleep(600); }

    fs.mkdirSync(pluginsRoot(), { recursive: true });
    const bak = dest + `.bak-${Date.now()}`;
    if (hadOld) await renameRetry(dest, bak);
    try {
      await renameRetry(root, dest);
    } catch (e) {
      if (hadOld && fs.existsSync(bak)) { try { await renameRetry(bak, dest); } catch { /* 回滚失败保留备份 */ } }
      throw e;
    }

    const st = pluginState(m.id);
    st.enabled = hadOld ? wasEnabled : true;
    writeState();

    let warning = "";
    if (wasRunning || !hadOld) {
      const r = await start(m.id);
      if (!r.ok) {
        warning = r.message;
        st.enabled = false;
        writeState();
      }
    }
    if (hadOld) { try { fs.rmSync(bak, { recursive: true, force: true }); } catch { /* 下次启动清理 */ } }
    return { ok: true, id: m.id, name: m.name, version: m.version, updated: hadOld, warning };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  } finally {
    installing = false;
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
    title: m.ui.title || m.name,
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
  cleaned = true;
  cleanupStale();
}

function init(o) {
  ctx = o;
}

module.exports = {
  init, list, install, uninstall, toggle, open,
  start, stop, resumeEnabled, killAll,
  pluginDir, dataDir, pluginsRoot,
  embedUrl, bridgeOf, tokenOf,
};
