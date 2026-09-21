// 反代网关 · 通用工具：JWT 解析 / 宽容取值 / SSE 行扫描 / OpenAI chunk 组装与非流式聚合
"use strict";
const crypto = require("node:crypto");

function uuid() {
  return crypto.randomUUID();
}

/** Trae 风格 trace id："00-<hex32>-<hex32>-01" */
function traceId() {
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(16).toString("hex")}-01`;
}

/** JWT payload 解析（不验签）：剥 Cloud-IDE-JWT / Bearer 前缀，取 uid 与 exp */
function jwtDecode(token) {
  let t = String(token || "").trim();
  t = t.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length < 2) return { token: t, uid: "", exp: 0, payload: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const uid = String((payload.data && payload.data.id) || payload.auth_id || payload.sub || payload.user_id || "");
    const exp = Number(payload.exp) || 0;
    return { token: t, uid, exp, payload };
  } catch {
    return { token: t, uid: "", exp: 0, payload: null };
  }
}

/** 宽容解析（参考项目 dig 思路）：递归在响应 JSON 里按键名正则找第一个匹配值 */
function dig(node, re, depth) {
  if (node == null || (depth != null && depth < 0)) return undefined;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = dig(v, re, (depth == null ? 6 : depth) - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (re.test(k) && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) return v;
    }
    for (const v of Object.values(node)) {
      const hit = dig(v, re, (depth == null ? 6 : depth) - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 把可能是秒/毫秒/ISO 字符串的时间统一成毫秒时间戳（0 = 无） */
function toMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "string" && /[-T:]/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** 判定字符串是否为完整 JSON（SSE 紧凑流兼容的判据，参考项目 wb_sse 实证） */
function isCompleteJson(s) {
  if (!s || s === "[DONE]") return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

/**
 * 限流响应头解析（参考项目 P1-2：Retry-After 秒 / Retry-After-Ms 毫秒 / X-Ratelimit-Reset epoch）。
 * 纯数字才认（HTTP-Date 不解析，宁缺毋滥），上限 2h（超过视为上游异常值丢弃）。
 * 传 web fetch 的 Headers 对象；取不到返回 0。
 */
function parseRetryAfterHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return 0;
  const CAP = 2 * 3600 * 1000;
  for (const [name, kind] of [["retry-after", "s"], ["retry-after-ms", "ms"], ["x-ratelimit-reset", "epoch"]]) {
    const v = String(headers.get(name) || "").trim();
    if (!v || !/^[0-9]+$/.test(v)) continue;
    const n = Number(v);
    if (n <= 0) continue;
    if (kind === "s") { const ms = n * 1000; if (ms <= CAP) return ms; continue; }
    if (kind === "ms") { if (n <= CAP) return n; continue; }
    // epoch：≥12 位按毫秒，否则按秒；取「now + 剩余量」，已过去视为不可用
    const sec = String(v).length >= 12 ? n / 1000 : n;
    const remain = sec * 1000 - Date.now();
    if (remain > 0 && remain <= CAP) return remain;
  }
  return 0;
}

/** 稳定会话键：取前 3 条消息指纹的 sha256 前 16 hex——同一会话多轮间头部不变，键即稳定 */
function stableConvId(messages) {
  try {
    const head = (Array.isArray(messages) ? messages : [])
      .slice(0, 3)
      .map((m) => `${(m && m.role) || ""}:${typeof (m && m.content) === "string" ? m.content : JSON.stringify((m && m.content) ?? null)}`)
      .join("|");
    if (!head || head === "||") return "";
    return crypto.createHash("sha256").update(head).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/** 上游 prompt_cache_key（参考项目 cache_key.go 实证：带上后 credit≈0.02 vs 0.34，约 17× 费用差）。
 *  uid 是跨账号硬隔离段——跨账号绝不复用同一键，防止命中错账号的前缀缓存 */
function promptCacheKey(uid, conversation) {
  const u = String(uid || "-");
  const uid8 = u.slice(0, 8) || "-";
  const conv = crypto.createHash("sha256").update(`${u}|${String(conversation || "")}`).digest("hex").slice(0, 16);
  return `agenthub-${uid8}-${conv}`;
}

// ===== deepseek 思维链（参考项目 thinking.go：开思考必须显式 thinking:enabled + effort，否则无思维链） =====

function isDeepSeekModel(model) {
  return /^deepseek/i.test(String(model || "").trim());
}

/** deepseek thinking 注入：显式 disabled 尊重并删 effort；显式 enabled 缺 effort 补默认档；
 *  无 thinking 注入 enabled + 补默认档。非 deepseek 零改动。 */
function injectThinking(obj, defaultEffort) {
  if (!obj || !isDeepSeekModel(obj.model)) return;
  const dft = String(defaultEffort || "high");
  const th = obj.thinking && typeof obj.thinking === "object" ? obj.thinking : null;
  const typ = th ? String(th.type || "").trim() : "";
  const ensureEffort = () => {
    if (obj.reasoning_effort != null || obj.reasoningEffort != null) return;
    obj.reasoning_effort = dft;
  };
  if (typ) {
    if (/^disabled$/i.test(typ)) {
      delete obj.reasoning_effort;
      delete obj.reasoningEffort;
      return;
    }
    ensureEffort();
    return;
  }
  if (th) th.type = "enabled";
  else obj.thinking = { type: "enabled" };
  ensureEffort();
}

const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** reasoning_effort 档位降级（参考项目 normalizeReasoningEffort）：模型目录声明 supportedEfforts
 *  时按其收敛——请求档不在支持集则降到 ≤ 请求档的最高支持档；支持档全高于请求档取最低档。 */
function normalizeReasoningEffort(obj, reasoningMeta) {
  const supported = (reasoningMeta && Array.isArray(reasoningMeta.supportedEfforts))
    ? reasoningMeta.supportedEfforts.map(String).filter((s) => EFFORT_RANK[s] != null)
    : [];
  if (!supported.length || !obj) return;
  const cur = typeof obj.reasoning_effort === "string" ? obj.reasoning_effort : "";
  if (!cur || EFFORT_RANK[cur] == null) return;
  const sorted = [...new Set(supported)].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  if (sorted.includes(cur)) return;
  const curRank = EFFORT_RANK[cur];
  const lower = sorted.filter((s) => EFFORT_RANK[s] <= curRank);
  obj.reasoning_effort = lower.length ? lower[lower.length - 1] : sorted[0];
}

/** deepseek 多轮回填（参考项目 backfillReasoningContent）：会话含 reasoning 痕迹时，
 *  所有 assistant 消息必须带 reasoning_content 字段（可为空串），否则上游 400 */
function backfillReasoningContent(obj) {
  if (!obj || !isDeepSeekModel(obj.model)) return;
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  if (!msgs.length) return;
  const hasTrace = msgs.some((m) => m && typeof m === "object" && (
    (typeof m.reasoning === "string" && m.reasoning !== "") || "reasoning_content" in m
  ));
  if (!hasTrace) return;
  for (const m of msgs) {
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    if ("reasoning_content" in m) continue;
    m.reasoning_content = typeof m.reasoning === "string" ? m.reasoning : "";
  }
}

// ===== SSE =====

/** SSE 行扫描器：累积 event:/data: 到空行触发一次事件（对齐参考项目 scan_line） */
class SseScanner {
  constructor(onEvent) {
    this.buf = "";
    this.event = "";
    this.data = [];
    this.onEvent = onEvent;
  }
  /** 喂入一块文本（可能不完整） */
  feed(text) {
    this.buf += text;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        const raw = this.data.join("\n");
        this.data = [];
        const ev = this.event;
        this.event = "";
        this.onEvent(ev, raw);
      }
      return;
    }
    if (line.startsWith(":")) return; // keep-alive 注释行
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      this.data.push(line.slice(5).replace(/^ /, ""));
      // 紧凑流兼容（参考项目 wb_sse 实证：上游存在无空行分隔的连续 data: 流）——
      // data 已拼出完整 JSON 或 [DONE] 时立即产出，不等空行；不完整则继续等
      const joined = this.data.join("\n");
      if (joined === "[DONE]" || isCompleteJson(joined)) {
        const raw = this.data.join("\n");
        this.data = [];
        const ev = this.event;
        this.event = "";
        this.onEvent(ev, raw);
      }
      return;
    }
  }
  /** 流结束时冲刷残余（无结尾空行也兜底触发一个事件） */
  flush() {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.line(rest);
    if (this.data.length) this.line("");
  }
}

/**
 * 空噪声 delta 字段清洗（出线前统一过一遍）。
 * WorkBuddy 上游实测：每个流式 chunk 的 delta 都带全展开的
 * `function_call:null / refusal:"" / tool_calls:[] / extra_fields:null`，且首块之后仍重复携带 `role`。
 * 原样透传有两层危害：
 *  1) 严格拼接的客户端（Qoder 等）见到"无 content 却有结构字段"的 delta 会另起一段，
 *     一句正文被切成几十行；
 *  2) 网关侧 emit 以"rest 非空"判定正文开始并冲刷思考链缓冲，噪声帧被误判成正文，
 *     使思考链合批（REASON_BATCH_CHARS）永远攒不满，碎成一词一条刷屏。
 * 规则：值为 null/undefined/空串/空数组的字段一律丢弃（OpenAI 语义下这些字段无需显式空值），
 * 非空 role 也丢弃——首包的 {role:"assistant"} 由 server 统一发出，重复 role 才是分段元凶。
 * 只清顶层，非空的上游私有扩展字段（如 extra_fields:{}）会原样保留，由调用方自行判消费。
 */
function stripEmptyDelta(d) {
  const out = {};
  if (!d || typeof d !== "object") return out;
  for (const [k, v] of Object.entries(d)) {
    if (k === "role") continue;
    if (v === null || v === undefined) continue;
    if (v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 这帧 delta 是否含"客户端与聚合器真正可消费"的内容：正文 / 思考链 / 非空工具调用。
 * 判据必须与 Aggregator.pushDelta 认的三类字段一致——若用"清洗后还有键"代替，
 * 上游私有的非空扩展字段（extra_fields:{} 之类）会被判成已出线，
 * 既进不了聚合器，又封死 server 侧 streamErr 的换号路径，最终把空响应记成 200。
 * 全空噪声帧（function_call:null / refusal:"" / tool_calls:[] / role 重复）恒为 false。
 */
function hasConsumableDelta(d) {
  if (!d || typeof d !== "object") return false;
  return !!d.reasoning_content
    || !!d.content
    || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0);
}

/** OpenAI 流式 chunk 组装 */
function chunk(reqId, model, delta, finishReason, usage) {
  const c = {
    id: `chatcmpl-${reqId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
  };
  if (usage) c.usage = usage;
  return `data: ${JSON.stringify(c)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

/** 非流式聚合器：把流式 delta 拼成完整 chat.completion（tool_calls 按 index 合并） */
class Aggregator {
  constructor(reqId, model) {
    this.reqId = reqId;
    this.model = model;
    this.content = "";
    this.reasoning = "";
    this.toolCalls = new Map(); // index -> {id, type, function:{name, arguments}}
    this.finishReason = "stop";
    this.usage = null;
  }
  pushDelta(delta) {
    if (!delta) return;
    if (delta.content) this.content += delta.content;
    if (delta.reasoning_content) this.reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        const cur = this.toolCalls.get(i) || { id: tc.id || `call_${uuid().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function) {
          if (tc.function.name) cur.function.name += tc.function.name;
          if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
        }
        this.toolCalls.set(i, cur);
      }
    }
  }
  result() {
    const message = { role: "assistant", content: this.content || "" };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.size) {
      message.tool_calls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    }
    const body = {
      id: `chatcmpl-${this.reqId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
      usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return body;
  }
}

/** OpenAI 同构错误体 */
function openaiError(message, type, code) {
  return { error: { message: String(message), type: type || "server_error", param: null, code: code || null } };
}

/** 请求体验证：messages/model 缺失返回 OpenAI 同构 400 */
function validateChatBody(body) {
  if (!body || typeof body !== "object") return "请求体必须是 JSON 对象";
  if (!Array.isArray(body.messages) || !body.messages.length) return "messages 缺失或为空";
  if (!body.model || typeof body.model !== "string") return "model 缺失";
  return "";
}

/** 估算 token（上游 usage 缺失时的兜底口径：~4 字符 1 token） */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

module.exports = {
  uuid, traceId, jwtDecode, dig, toMs,
  isCompleteJson, parseRetryAfterHeaders, stableConvId, promptCacheKey,
  isDeepSeekModel, injectThinking, normalizeReasoningEffort, backfillReasoningContent,
  SseScanner, stripEmptyDelta, hasConsumableDelta, chunk, DONE, Aggregator, openaiError, validateChatBody, estimateTokens,
};
