/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 选路运行期状态（进程内存，不落盘）
//
// ── 与 route-plan.cjs 的分工 ─────────────────────────────────
// route-plan 是纯函数：输入快照、输出带原因的排序计划，绝不写状态。
// 本模块持有全部「会被写」的东西：轮转游标 / 会话粘性 / 失败退避 / 限流垫底 / 熔断。
// 「决策」与「状态」分开后，只读接口（计划预览）与转发路径读到的是同一份口径。
//
// ── 为什么全部放内存、重启清零 ────────────────────────────────
// 这些判定回答的是「接下来这一会儿请求怎么分」，不是需要跨重启保留的账本。
// 真正要持久的是账号限额冷却（rateLimits / model_cooldowns），那部分已有专用存储。
//
// ── 四层状态各自的语义（不要混用）─────────────────────────────
//   · 冷却（cooldown）：这个号现在不许用，由上游 429/402 决定，不在这里；
//   · 垫底（sunk）：只是排到队尾，30 分钟自动回来 —— 防「429 → 沉底 → 轮不到 → 永远解除不了」的自锁；
//   · 休息（backoff）：单次失败后的短期退避，15 分钟起、翻倍、封顶 1 小时；
//   · 熔断（breaker）：连续失败到阈值才打开，连续成功若干次才关，打开期间直接跳过。
"use strict";
const crypto = require("node:crypto");

/** 失败退避：15 分钟起，连续失败翻倍，封顶 1 小时 */
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** 限流垫底：固定 30 分钟。标记的是「疑似共享池被别人抢」，不是账号本身坏了，重犯不加重。 */
const SINK_TTL_MS = 30 * 60 * 1000;

/** 熔断：连续失败 3 次打开，30 分钟起翻倍、封顶 6 小时；连续 2 次成功关闭 */
const BREAKER_THRESHOLD = 3;
const BREAKER_BASE_MS = 30 * 60 * 1000;
const BREAKER_MAX_MS = 6 * 60 * 60 * 1000;
const BREAKER_CLOSE_SUCCESSES = 2;

/** 会话粘性：auto = 5 分钟没有往来就放手；on = 一直保持 */
const STICKY_TTL_MS = 5 * 60 * 1000;
const STICKY_MAX_KEYS = 512;

const CURSOR_MAX_KEYS = 4096;

const cursors = new Map(); // scopeKey → 单调计数
const sticky = new Map(); // convKey → { accountId, at }
const backoff = new Map(); // accountId → { until, strikes }
const sunk = new Map(); // accountId → until
const breaker = new Map(); // accountId → { failures, openUntil, successes }

/** 取请求头（大小写不敏感）；Node 已小写，但兼容手写对象。 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const lower = name.toLowerCase();
  const hit = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  const value = hit ? headers[hit] : "";
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

/** 消息内容取文本：字符串 / 内容块数组两种形态都要认。 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : "")).join("");
}

/** 显式会话标识的长度闸（对齐示例 Agent2API route_state.rs::EXPLICIT_ID_MAX_CHARS）：
 *  值是客户端自选串且会长住进粘性表的内存键，超限当「没有标识」回落内容哈希。 */
const EXPLICIT_ID_MAX_CHARS = 256;

/** Claude Code 的 metadata.user_id → session_id（两种可辨认形状，照示例 parse_claude_code_user_id）：
 *  v2(≥2.1.78) 是 JSON 文本；legacy 是 user_<64hex>_account__session_<uuid>。解析不出就当没有，
 *  宁可无粘性也不把陌生串当会话 id（会把不相干请求粘到一起）。 */
function parseClaudeCodeUserId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try { return String(JSON.parse(s)?.session_id || "").trim(); } catch { return ""; }
  }
  const rest = s.startsWith("user_") ? s.slice(5) : "";
  const at = rest.indexOf("_account__session_");
  if (at < 0) return "";
  const device = rest.slice(0, at);
  const tail = rest.slice(at + "_account__session_".length);
  const hex64 = device.length === 64 && /^[0-9a-f]{64}$/.test(device);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail);
  return hex64 && uuid ? tail : "";
}

/** 显式会话标识提取链（顺序即优先级，对齐示例 conversation_key 的五级链）：
 *  ① x-conversation-id（本项目约定头）② AH-Thread-Id（会话级；**不能**用 AH-Trace-Id，
 *  其粒度是单条消息，粘性会逐轮断裂）③ OpenCode 系三头 ④ Codex 会话头 / X-Codex-Turn-Metadata
 *  里的 session_id ⑤ body.prompt_cache_key（经 Anthropic→Chat 翻译网关接入时唯一拿得到的）
 *  ⑥ Claude Code metadata.user_id。都没命中返回空串，调用方回落内容哈希。 */
function explicitConversationId(headers, body) {
  for (const name of ["x-conversation-id", "ah-thread-id", "x-opencode-session", "x-session-id", "x-session-affinity", "session_id", "session-id"]) {
    const value = headerValue(headers, name).trim();
    if (value) return value;
  }
  const turn = headerValue(headers, "x-codex-turn-metadata").trim();
  if (turn) {
    try {
      const session = String(JSON.parse(turn)?.session_id || "").trim();
      if (session) return session;
    } catch { /* 解析不出当没有 */ }
  }
  const cache = typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "";
  if (cache) return cache;
  const userId = body?.metadata && typeof body.metadata === "object" ? body.metadata.user_id : undefined;
  if (typeof userId === "string") {
    const session = parseClaudeCodeUserId(userId);
    if (session) return session;
  }
  return "";
}

/** 会话键：显式会话标识优先（长度闸内），否则用「模型 + 首条 user 消息」的哈希。
 *  网关不做会话管理，但同一对话的稳定特征就是这两样不变、后续轮次只追加。
 *  body 用于读 prompt_cache_key / metadata.user_id；不传时行为与旧版一致（仅头 + 哈希）。 */
function conversationKey({ model, messages, headers, body } = {}) {
  const explicit = explicitConversationId(headers, body);
  let seed;
  if (explicit && explicit.length <= EXPLICIT_ID_MAX_CHARS) {
    seed = `id\u0000${explicit}`;
  } else {
    const firstUser = (Array.isArray(messages) ? messages : []).find((m) => m && m.role === "user");
    seed = `model\u0000${String(model || body?.model || "")}\u0000first\u0000${textOf(firstUser && firstUser.content)}`;
  }
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** 轮转游标：取一次并自增。游标只在「本次请求第一次选路」推进，429 顺延不重复消耗。 */
function rotateTake(scopeKey) {
  const key = String(scopeKey || "");
  const next = (cursors.get(key) || 0) + 1;
  cursors.set(key, next);
  if (cursors.size > CURSOR_MAX_KEYS) {
    for (const stale of cursors.keys()) {
      if (cursors.size <= CURSOR_MAX_KEYS) break;
      cursors.delete(stale);
    }
  }
  return next - 1;
}

/** 只读游标（预览用，不推进）。 */
function rotatePeek(scopeKey) {
  return cursors.get(String(scopeKey || "")) || 0;
}

/** 粘性命中：过期即删并返回空串。 */
function stickyGet(convKey, now = Date.now(), ttlMs = STICKY_TTL_MS) {
  const key = String(convKey || "");
  if (!key) return "";
  const hit = sticky.get(key);
  if (!hit) return "";
  if (ttlMs > 0 && now - hit.at >= ttlMs) {
    sticky.delete(key);
    return "";
  }
  return hit.accountId;
}

function stickySet(convKey, accountId, now = Date.now()) {
  const key = String(convKey || "");
  const id = String(accountId || "");
  if (!key || !id) return;
  sticky.delete(key);
  sticky.set(key, { accountId: id, at: now });
  // 超上限时按插入顺序淘汰最旧的（Map 保序），避免长跑进程无限增长
  while (sticky.size > STICKY_MAX_KEYS) {
    const oldest = sticky.keys().next();
    if (oldest.done) break;
    sticky.delete(oldest.value);
  }
}

function stickyClear(convKey) {
  sticky.delete(String(convKey || ""));
}

/** 记录一次失败：退避时长翻倍，并累计熔断计数。返回当前状态供调用方打日志。 */
function markFailure(accountId, now = Date.now()) {
  const id = String(accountId || "");
  if (!id) return null;
  const prev = backoff.get(id);
  const strikes = prev ? (Number(prev.strikes) || 0) + 1 : 1;
  const until = now + Math.min(BACKOFF_BASE_MS * Math.pow(2, strikes - 1), BACKOFF_MAX_MS);
  backoff.set(id, { until, strikes });

  const state = breaker.get(id) || { failures: 0, openUntil: 0, successes: 0 };
  state.failures = (Number(state.failures) || 0) + 1;
  state.successes = 0;
  if (state.failures >= BREAKER_THRESHOLD) {
    const step = Math.min(state.failures - BREAKER_THRESHOLD, 4);
    state.openUntil = now + Math.min(BREAKER_BASE_MS * Math.pow(2, step), BREAKER_MAX_MS);
  }
  breaker.set(id, state);
  return { until, strikes, openUntil: state.openUntil };
}

/** 记录一次成功：清退避、清垫底；熔断需要连续成功若干次才关。 */
function markSuccess(accountId, now = Date.now()) {
  const id = String(accountId || "");
  if (!id) return;
  backoff.delete(id);
  sunk.delete(id);
  const state = breaker.get(id);
  if (!state) return;
  state.failures = 0;
  state.successes = (Number(state.successes) || 0) + 1;
  if (state.successes >= BREAKER_CLOSE_SUCCESSES || state.openUntil <= now) {
    state.openUntil = 0;
    state.successes = 0;
  }
  if (state.openUntil > 0) breaker.set(id, state);
  else breaker.delete(id);
}

/** 限流垫底：只影响位次，不阻止使用。 */
function markSunk(accountId, now = Date.now(), ttlMs = SINK_TTL_MS) {
  const id = String(accountId || "");
  if (!id) return;
  sunk.set(id, now + Math.max(0, Number(ttlMs) || 0));
}

/** 给纯函数用的只读快照。传 now 时顺手剔除已过期的项，避免调用方各自判断。 */
function snapshot(now = Date.now()) {
  const backoffView = {};
  for (const [id, entry] of backoff) if (entry && entry.until > now) backoffView[id] = entry.until;
  const sunkView = {};
  for (const [id, until] of sunk) if (until > now) sunkView[id] = until;
  const open = [];
  for (const [id, entry] of breaker) if (entry && entry.openUntil > now) open.push(id);
  const stickyView = {};
  for (const [key, hit] of sticky) stickyView[key] = hit.accountId;
  return { backoff: backoffView, sunk: sunkView, open, sticky: stickyView, cursors };
}

/** 清理过期项：长跑进程必须调用（转发每次结束顺手一次即可）。 */
function prune(now = Date.now()) {
  for (const [id, entry] of backoff) if (!entry || entry.until <= now) backoff.delete(id);
  for (const [id, until] of sunk) if (until <= now) sunk.delete(id);
  for (const [id, entry] of breaker) if (!entry || entry.openUntil <= now) breaker.delete(id);
  for (const [key, hit] of sticky) if (!hit || now - hit.at >= STICKY_TTL_MS) sticky.delete(key);
}

/** 测试与「重置路由状态」按钮用。 */
function reset() {
  cursors.clear();
  sticky.clear();
  backoff.clear();
  sunk.clear();
  breaker.clear();
}

function stats(now = Date.now()) {
  let resting = 0, sunken = 0, open = 0;
  for (const entry of backoff.values()) if (entry && entry.until > now) resting++;
  for (const until of sunk.values()) if (until > now) sunken++;
  for (const entry of breaker.values()) if (entry && entry.openUntil > now) open++;
  return { cursors: cursors.size, sticky: sticky.size, resting, sunken, open };
}

module.exports = {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  SINK_TTL_MS,
  BREAKER_THRESHOLD,
  BREAKER_BASE_MS,
  BREAKER_MAX_MS,
  STICKY_TTL_MS,
  conversationKey,
  rotateTake,
  rotatePeek,
  stickyGet,
  stickySet,
  stickyClear,
  markFailure,
  markSuccess,
  markSunk,
  snapshot,
  prune,
  reset,
  stats,
};
