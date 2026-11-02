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
// 反代网关 · 网络代理池：集中管理一组**命名出口**（http / socks5），网关向上游转发时按
// 出口策略取用；每条出口可单独启停、单独测试（连通性 + 出口 IP + 耗时），测试结果落盘。
//
// ── 为什么要有它 ───────────────────────────────────────────────
// 改造前网关只能直连：本机要走代理（Clash / 公司出口 / 海外落地）时，除了改系统环境变量
// 没有别的办法，而环境变量是全局的、无法按条目切换，也看不到"这个出口到底通不通、出口 IP
// 是什么"。代理池把「出口」抽成独立实体：配一次、测一次、多条可轮换，网关按策略取用。
//
// ── 存储：proxyDir 下的 netproxy.json（不是 stats.db 的表）────────
// 条目数量级是几个到几十个、无查询需求（永远是整份读、整份写），与 rules 目录下的
// 规则文件同类。不新增表也就不动库 schema —— 没有需要索引/约束的字段，不值得为它推一版。
// 文件随数据目录走：桌面版与容器版各自的数据目录里各存一份，语义与 stats.db 一致。
//
// ── 密码不明文落盘 ────────────────────────────────────────────
// passwordEnc 走 config.encryptSecret（桌面 safeStorage/DPAPI，容器 AGENTHUB_SECRET_KEY
// 派生的 AES），与账号 token、网关 Key 同一条信封链；列表接口只回 hasPassword，不回明文。
//
// ── 出口策略（mode）──────────────────────────────────────────
//   off    直连（默认）：不经过任何代理，与改造前完全一致；
//   fixed  固定：所有上游请求都走 fixedId 那一条；
//   rotate 轮询：每条请求按顺序换一个**启用**条目（上游看到的 IP 因此是变化的），
//          没有启用条目时明确失败，避免绕过用户配置的出口。
// 策略与条目都是热生效的：取用时现读文件（文件很小，且带 mtime 缓存），不必重启网关。
//
// ── dispatcher 缓存 ──────────────────────────────────────────
// 每个出口一个 undici ProxyAgent（内含连接池），否则每个请求都要重新和代理建一条 TCP
// 连接，SSE 长连接场景下开销很直观。键是条目、端点及加密凭据的 SHA-256 摘要：不将明文密码放进
// 缓存键；同主机不同身份不共用一个池。上限 24，超出淘汰最久未用。
//
// ── 测试判据 ─────────────────────────────────────────────────
// 判据是「能否拿到 HTTP 响应」（不管状态码与响应体内容），出口 IP 是附加信息（拿不到只是
// 少一项，不影响结论）。测试目标可在设置里换（settings.testUrl），留空用默认。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.cjs");
const config = require("../config.cjs");
const oplog = require("./oplog.cjs");
const util = require("./util.cjs");
const transport = require("./transport-context.cjs");

/** 文件名（proxyDir 下，与 stats.db / rules 同级） */
const FILE_NAME = "netproxy.json";
/** 默认测试目标：国内可直连的稳定站点（判据只看能否拿到 HTTP 响应，404 也算连通） */
const DEFAULT_TEST_URL = "https://api.deepseek.com/";
/** 出口 IP 查询服务（附加信息，失败不影响结论） */
const IP_ECHO_URL = "https://api.ipify.org?format=json";
/** 测试默认超时 */
const DEFAULT_TIMEOUT_MS = 15000;
/** IP 查询的超时上限（即便测试超时给得更大，也不要在这里耗太久） */
const IP_LOOKUP_MAX_MS = 6000;
/** dispatcher 缓存上限 */
const MAX_DISPATCHERS = 24;
/** 字段长度上限（名称要出现在表格里；主机名要能放下 IPv6 字面量） */
const MAX_NAME = 60;
const MAX_HOST = 255;
const MAX_USER = 200;
const MAX_TEST_URL = 500;

const MODES = new Set(["off", "fixed", "rotate"]);
const PROTOCOLS = new Set(["http", "socks5"]);

/** 空态（文件缺失 / 解析失败时的兜底；也是前端首次打开看到的形状） */
function emptyState() {
  return {
    version: 1,
    mode: "off",
    fixedId: "",
    settings: { testUrl: "", timeoutMs: DEFAULT_TIMEOUT_MS },
    items: [],
  };
}

function filePath() {
  return path.join(store.proxyDir(), FILE_NAME);
}

// ===== 读写（带 mtime 缓存：取用频率高，但文件几乎不变） =====

let cache = { mtimeMs: -1, size: -1, state: null };

/** 读整份状态；文件缺失 / 解析失败 / 形状不对一律按空态处理（比整页报错更可恢复） */
function readState() {
  const p = filePath();
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    cache = { mtimeMs: -1, size: -1, state: emptyState() };
    return cache.state;
  }
  if (cache.state && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.state;
  let state = emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw && typeof raw === "object") {
      state = {
        version: 1,
        mode: MODES.has(String(raw.mode)) ? String(raw.mode) : "off",
        fixedId: typeof raw.fixedId === "string" ? raw.fixedId : "",
        settings: {
          testUrl: typeof raw.settings?.testUrl === "string" ? raw.settings.testUrl : "",
          timeoutMs: clampTimeout(raw.settings?.timeoutMs),
        },
        items: Array.isArray(raw.items) ? raw.items.filter((it) => it && typeof it === "object") : [],
      };
    }
  } catch {
    throw Object.assign(new Error("代理配置文件损坏，请修复配置后重试"), { code: "EGRESS_CONFIG_INVALID", netproxy: {} });
  }
  cache = { mtimeMs: st.mtimeMs, size: st.size, state };
  return state;
}

/** 整份写回（增删改都走它；条目数量小，整份重写的开销可忽略） */
function writeState(state) {
  const p = filePath();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, p);
  cache = { mtimeMs: -1, size: -1, state: null };
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(120000, Math.max(1000, Math.round(n)));
}

// ===== 归一 / 校验 =====

function text(v, max) {
  const s = v == null ? "" : String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 表单 → 归一化条目字段；非法时抛错（文案面向用户，前端原样展示） */
function normalizeDraft(raw) {
  const name = text(raw.name, MAX_NAME);
  if (!name) throw new Error("请填写代理名称");
  const host = text(raw.host, MAX_HOST);
  if (!host) throw new Error("请填写代理主机地址");
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("代理端口必须是 1-65535 的整数");
  const protocol = String(raw.protocol || "http").toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new Error("代理协议只支持 http 或 socks5");
  return {
    name,
    protocol,
    host,
    port,
    username: text(raw.username, MAX_USER),
    enabled: raw.enabled !== false,
  };
}

/** 对外形态：密码只回 hasPassword，密文永不出后端 */
function describe(item) {
  return {
    id: item.id,
    name: item.name || "",
    protocol: item.protocol === "socks5" ? "socks5" : "http",
    host: item.host || "",
    port: Number(item.port) || 0,
    username: item.username || "",
    hasPassword: !!item.passwordEnc,
    enabled: item.enabled !== false,
    lastTest: item.lastTest && typeof item.lastTest === "object" ? item.lastTest : null,
    createdAt: Number(item.createdAt) || 0,
    updatedAt: Number(item.updatedAt) || 0,
  };
}

/** 条目 → 代理 URI（含凭证）；端口非法返回 null。 */
function proxyUri(item) {
  const port = Number(item && item.port);
  if (!item || !item.host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const protocol = item.protocol === "socks5" ? "socks5" : "http";
  const user = item.username ? encodeURIComponent(item.username) : "";
  const pass = item.passwordEnc ? encodeURIComponent(config.decryptSecret(item.passwordEnc) || "") : "";
  const auth = user ? `${user}${pass ? `:${pass}` : ""}@` : "";
  const host = item.host.includes(":") && !item.host.startsWith("[") ? `[${item.host}]` : item.host;
  return `${protocol}://${auth}${host}:${port}`;
}

/** 连接池按出口身份和加密凭据隔离。 */
function cacheKey(item) {
  return require("node:crypto").createHash("sha256").update(JSON.stringify([item.id, item.protocol, item.host, item.port, item.username, item.passwordEnc])).digest("hex");
}

// ===== 出口选择 =====

/** 轮询游标（进程内；重启从头开始，不需要持久化） */
let rotateCursor = 0;

/** 当前请求该走哪条出口；返回 null 表示直连 */
function pickEgress() {
  const state = readState();
  if (state.mode === "off") return null;
  if (state.mode === "fixed") {
    const hit = state.items.find((it) => it.id === state.fixedId && it.enabled !== false);
    if (!hit || !proxyUri(hit)) throw Object.assign(new Error("固定代理不可用，请检查出口配置"), { code: "EGRESS_UNAVAILABLE", netproxy: { id: state.fixedId } });
    return hit;
  }
  // rotate：只在启用条目里轮，且必须能拼出合法 URI
  const usable = state.items.filter((it) => it.enabled !== false && proxyUri(it));
  if (!usable.length) throw Object.assign(new Error("代理池中没有可用出口"), { code: "EGRESS_UNAVAILABLE", netproxy: {} });
  const item = usable[rotateCursor % usable.length];
  rotateCursor = (rotateCursor + 1) % 1e9;
  return item;
}

// ===== dispatcher 缓存（LRU）=====

const agents = new Map(); // key → { at, agent }

function agentFor(item) {
  const key = cacheKey(item);
  const hit = agents.get(key);
  if (hit) {
    agents.delete(key);
    agents.set(key, { at: Date.now(), agent: hit.agent });
    return hit.agent;
  }
  const uri = proxyUri(item);
  if (!uri) return null;
  // 延迟 require：容器镜像里 undici 由 gateway/package.json 提供，桌面端由根 package.json 提供；
  // 顶层 require 会让「没装 undici」的旧安装包在启动时就崩，延迟到真正用代理时才加载
  const { ProxyAgent } = require("undici");
  const agent = new ProxyAgent(uri);
  agents.set(key, { at: Date.now(), agent });
  while (agents.size > MAX_DISPATCHERS) {
    const oldest = agents.keys().next().value;
    const dead = agents.get(oldest);
    agents.delete(oldest);
    closeAgent(dead?.agent);
  }
  return agent;
}

/** 关闭全部连接池（停机时调用；容器 exit / 桌面退出都走它） */
function closeAgent(agent) {
  try { Promise.resolve(agent?.close?.()).catch(() => {}); } catch {}
}

function closeAll() {
  for (const { agent } of agents.values()) {
    closeAgent(agent);
  }
  agents.clear();
}

// ===== 出站请求（唯一入口）=====

/**
 * 带出口的 fetch：直连模式走全局 fetch，代理不可用时明确失败；
 * 有出口时走 npm undici 的 fetch + ProxyAgent（同一份实现，dispatcher 才认）。
 *
 * ⚠ 不能用「全局 fetch + npm undici 的 ProxyAgent」：Node 内置 undici 与 npm undici
 * 不是同一份 Dispatcher 实现，实测直接 `fetch failed`（2026-10 本机复现）。
 */
async function fetchThrough(url, opts) {
  const context = transport.current();
  if (context && context.egress === undefined) context.egress = pickEgress();
  const item = context ? context.egress : pickEgress();
  opts = { ...opts, signal: transport.signalFor(opts?.signal) };
  opts.signal?.throwIfAborted();
  if (!item) return fetch(url, opts);
  const agent = agentFor(item);
  if (!agent) throw Object.assign(new Error("代理配置无效"), { code: "EGRESS_UNAVAILABLE", netproxy: { id: item.id } });
  const { fetch: undiciFetch } = require("undici");
  try {
    return await undiciFetch(url, { ...(opts || {}), dispatcher: agent });
  } catch (e) {
    // 代理侧失败要能一眼看出是出口的问题：把出口名挂到错误上，转发层文案随之带上
    if (e && typeof e === "object") {
      e.netproxy = { id: item.id, name: item.name, protocol: item.protocol, host: item.host, port: item.port };
    }
    throw e;
  }
}

function webSocketThrough(url, opts) {
  const context = transport.current();
  if (context && context.egress === undefined) context.egress = pickEgress();
  const item = context ? context.egress : pickEgress();
  const { WebSocket } = require("undici");
  return new WebSocket(url, item ? { ...opts, dispatcher: agentFor(item) } : opts);
}

// ===== 连通性测试 =====

/** 错误链描述：undici 的连接类错误常挂在 cause 上，逐层下钻拼成「分段 → 分段」 */
function describeError(e) {
  const parts = [];
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    const t = String(cur.message || cur);
    if (t && !parts.includes(t)) parts.push(t);
    cur = cur.cause;
  }
  return parts.join(" → ") || "连接失败";
}

/**
 * 测一条出口（item 可为草稿：未保存也能测）。
 * 返回 { success, status, ip, durationMs, error } —— 失败不抛，由调用方展示。
 */
async function testEgress(item, settings) {
  const uri = proxyUri(item);
  if (!uri) return { success: false, status: null, ip: "", durationMs: 0, error: "代理地址不完整" };
  const timeoutMs = clampTimeout(settings && settings.timeoutMs);
  const target = text(settings && settings.testUrl, MAX_TEST_URL) || DEFAULT_TEST_URL;
  const started = Date.now();
  let agent;
  try {
    const { ProxyAgent, fetch: undiciFetch } = require("undici");
    agent = new ProxyAgent(uri);
    const resp = await undiciFetch(target, {
      dispatcher: agent,
      headers: { Accept: "application/json, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - started;
    // 只关心「连得上」，不读响应体（body 直接丢弃）
    try { await resp.body?.cancel?.(); } catch { /* 已消费 / 无 body */ }
    const ip = await readExitIp(agent, Math.min(timeoutMs, IP_LOOKUP_MAX_MS));
    return { success: true, status: resp.status, ip, durationMs, error: "" };
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError" || e.code === "UND_ERR_CONNECT_TIMEOUT");
    return {
      success: false,
      status: null,
      ip: "",
      durationMs: Date.now() - started,
      error: timedOut ? `连接超时（${Math.round(timeoutMs / 1000)} 秒）` : describeError(e),
    };
  } finally {
    try { await agent?.close?.(); } catch { /* 已关闭 */ }
  }
}

/** 出口 IP：拿不到返回空串（附加信息，不影响连通性结论） */
async function readExitIp(agent, timeoutMs) {
  try {
    const { fetch: undiciFetch } = require("undici");
    const resp = await undiciFetch(IP_ECHO_URL, {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return "";
    const data = await resp.json().catch(() => null);
    return data && typeof data.ip === "string" ? data.ip : "";
  } catch {
    return "";
  }
}

// ===== 对外动作（供 index.cjs 注册命令）=====

function list() {
  const state = readState();
  return {
    ok: true,
    mode: state.mode,
    fixedId: state.fixedId,
    settings: {
      testUrl: state.settings.testUrl,
      timeoutMs: state.settings.timeoutMs,
      defaultTestUrl: DEFAULT_TEST_URL,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    },
    items: state.items.map(describe),
  };
}

/** 新增 / 编辑（带 id 即编辑；密码留空表示不改） */
function save(raw) {
  const state = readState();
  const fields = normalizeDraft(raw || {});
  const id = text(raw && raw.id, 64);
  const now = Date.now();
  if (id) {
    const idx = state.items.findIndex((it) => it.id === id);
    if (idx < 0) throw new Error("代理不存在（可能已被删除）");
    const cur = state.items[idx];
    const next = { ...cur, ...fields, updatedAt: now };
    // 先清空再写新值：用户点了「清除密码」之后又填了新密码时，以新密码为准
    if (raw.clearPassword === true) next.passwordEnc = "";
    if (typeof raw.password === "string" && raw.password !== "") next.passwordEnc = config.encryptSecret(raw.password);
    state.items[idx] = next;
    writeState(state);
    oplog.log("info", "网络代理", `已更新出口「${fields.name}」（${fields.protocol} ${fields.host}:${fields.port}）`);
    return { ok: true, item: describe(next) };
  }
  const item = {
    id: util.uuid(),
    ...fields,
    passwordEnc: typeof raw.password === "string" && raw.password ? config.encryptSecret(raw.password) : "",
    lastTest: null,
    createdAt: now,
    updatedAt: now,
  };
  state.items.push(item);
  writeState(state);
  oplog.log("info", "网络代理", `已新增出口「${fields.name}」（${fields.protocol} ${fields.host}:${fields.port}）`);
  return { ok: true, item: describe(item) };
}

function remove(raw) {
  const state = readState();
  const id = text(raw && raw.id, 64);
  const idx = state.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error("代理不存在（可能已被删除）");
  const [gone] = state.items.splice(idx, 1);
  // 保留 fixed 模式，后续请求明确报告出口不可用。
  if (state.fixedId === id) {
    state.fixedId = "";
  }
  writeState(state);
  oplog.log("info", "网络代理", `已删除出口「${gone.name || id}」`);
  return { ok: true };
}

function toggle(raw) {
  const state = readState();
  const id = text(raw && raw.id, 64);
  const item = state.items.find((it) => it.id === id);
  if (!item) throw new Error("代理不存在（可能已被删除）");
  item.enabled = raw.enabled !== false;
  item.updatedAt = Date.now();
  writeState(state);
  oplog.log("info", "网络代理", `${item.enabled ? "已启用" : "已停用"}出口「${item.name || id}」`);
  return { ok: true, item: describe(item) };
}

/** 测试：带 id 测已存条目（结果落进条目）；带 draft 测未保存的表单（不落盘） */
async function test(raw) {
  const state = readState();
  const id = text(raw && raw.id, 64);
  if (id) {
    const item = state.items.find((it) => it.id === id);
    if (!item) throw new Error("代理不存在（可能已被删除）");
    const result = await testEgress(item, state.settings);
    const idx = state.items.findIndex((it) => it.id === id);
    if (idx >= 0) {
      state.items[idx] = { ...state.items[idx], lastTest: { ...result, at: Date.now() } };
      writeState(state);
    }
    oplog.log(result.success ? "info" : "warn", "网络代理",
      `测试出口「${item.name || id}」${result.success ? `通过（HTTP ${result.status}${result.ip ? ` · 出口 ${result.ip}` : ""} · ${result.durationMs}ms）` : `失败：${result.error}`}`);
    return { ok: true, ...result };
  }
  const draft = raw && raw.draft;
  if (!draft || typeof draft !== "object") throw new Error("缺少要测试的代理");
  const fields = normalizeDraft(draft);
  const probe = {
    ...fields,
    passwordEnc: typeof draft.password === "string" && draft.password ? config.encryptSecret(draft.password) : "",
  };
  const result = await testEgress(probe, state.settings);
  return { ok: true, ...result };
}

/** 保存策略与设置（mode / fixedId / testUrl / timeoutMs 任给其一） */
function saveSettings(raw) {
  const state = readState();
  if (raw && raw.mode != null) {
    const mode = String(raw.mode);
    if (!MODES.has(mode)) throw new Error("出口策略只支持 off / fixed / rotate");
    state.mode = mode;
  }
  if (raw && raw.fixedId != null) {
    const fixedId = text(raw.fixedId, 64);
    if (fixedId && !state.items.some((it) => it.id === fixedId)) throw new Error("指定的固定出口不存在");
    state.fixedId = fixedId;
  }
  if (state.mode === "fixed" && !state.fixedId) throw new Error("选择「固定出口」时必须指定一条出口");
  if (raw && raw.testUrl != null) {
    const url = text(raw.testUrl, MAX_TEST_URL);
    if (url && !/^https?:\/\//i.test(url)) throw new Error("测试网址要以 http:// 或 https:// 开头");
    state.settings.testUrl = url;
  }
  if (raw && raw.timeoutMs != null) state.settings.timeoutMs = clampTimeout(raw.timeoutMs);
  writeState(state);
  oplog.log("info", "网络代理", `出口策略已更新：${state.mode === "off" ? "直连" : state.mode === "fixed" ? `固定出口（${state.fixedId}）` : "轮询启用出口"}`);
  return list();
}

module.exports = {
  list, save, remove, toggle, test, saveSettings,
  fetchThrough, webSocketThrough, closeAll, proxyUri, cacheKey,
  // 供自测与排障：当前生效出口（不含凭证）
  currentEgress: () => {
    const it = pickEgress();
    return it ? { id: it.id, name: it.name, protocol: it.protocol, host: it.host, port: it.port } : null;
  },
  DEFAULT_TEST_URL,
  DEFAULT_TIMEOUT_MS,
};
