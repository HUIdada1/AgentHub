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
  SseScanner, chunk, DONE, Aggregator, openaiError, validateChatBody, estimateTokens,
};
