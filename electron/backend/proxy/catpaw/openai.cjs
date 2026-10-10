// CatPaw 出站翻译层：上游 SSE 事件 → OpenAI delta（移植来源：参照实现 catpaw/openai.rs，
// 其上游是 catpaw-upstream-messages.mjs 的 messageDelta / openAIMessage / extractToolCalls /
// usageFromResponse / responseError 与 catpaw-upstream-client.mjs 的 turnStream）。
//
// 两条容易踩的语义（原实现踩过）：
//   1. **上游的 text / toolParams 是累积值不是增量**：每个 SSE 事件的 content/reasoningContent/
//      toolParams 都是「到目前为止的全部内容」，必须做**后缀差分**；直接当 delta 下发会让客户端看到重复内容。
//   2. **usage 口径与 OpenAI 不同**：上游 prompt_tokens 只是本轮增量输入、total_tokens 是**会话累计**占用，
//      而客户端要的是「本次请求的完整输入」，故 prompt = max(prompt, total - completion)；上游没有缓存字段，
//      cache_read_tokens 恒空不估算。
//
// 本层不发网络、不读盘。SSE 被 TCP 分段切开、半行 JSON 是正常路径（半行留在 tail 里等下一个 chunk）。
"use strict";
const CatPawError = require("./errors.cjs");



/** `stream_options.include_usage === true`（只认布尔真值：字符串 "true" / 数字 1 不算） */
function includeUsage(body) {
  const opts = body && body.stream_options;
  return !!(opts && typeof opts === "object" && opts.include_usage === true);
}

/** `unwrapApiData`：`code` 可转成数值且不是 0/200 → 上游错误；有 `data` 成员则取出。
 *
 *  code 的判定口径：按**数值**判定（`Number(code)`），不按类型区分——原实现是 JS 严格比较
 *  （字符串 `"0"` 不等于数字 `0`，于是 `"0"` 会被误判成错误），参照实现改成「非数字 → 继续」。
 *  这里取两者的折中：字符串形态的数字按数值判定（`"0"` 成功、`"500"` 如实报错）。
 *  理由——上游若真回了字符串业务码，当成功放行会把一次失败伪装成正常流（客户端拿到空内容
 *  却记成 200），如实报错更安全；而畸形 code（完全非数字）走「继续」，不误伤正常流 */
function unwrapApiData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const code = value.code;
  if (code !== undefined && code !== null) {
    const codeNumber = Number(code);
    if (Number.isFinite(codeNumber) && codeNumber !== 0 && codeNumber !== 200) {
      const message = String(value.msg || value.message || "").trim() || `上游 API 返回错误 code=${codeNumber}`;
      const status = Number(value.httpStatus) || 502;
      throw new CatPawError(status >= 100 && status < 600 ? status : 502, message, {
        code: codeNumber,
        unifyCode: Number.isFinite(Number(value.unifyCode)) ? Number(value.unifyCode) : null,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "data")) return value.data;
  return value;
}

/** 事件里的错误对象：`error` / `data.error` / `result.error` */
function responseError(data) {
  if (!data || typeof data !== "object") return null;
  const error = data.error
    || (data.data && data.data.error)
    || (data.result && data.result.error);
  if (!error || typeof error !== "object") return null;
  const message = String(error.message || error.msg || "").trim()
    || `上游返回错误 code=${error.code !== undefined ? String(error.code) : "unknown"}`;
  const status = Number(error.httpStatus) || 502;
  return new CatPawError(status >= 100 && status < 600 ? status : 502, message, {
    code: Number.isFinite(Number(error.code)) ? Number(error.code) : null,
    unifyCode: Number.isFinite(Number(error.unifyCode)) ? Number(error.unifyCode) : null,
  });
}

/** 事件里的 assistant 消息 */
function responseMessage(data) {
  if (!data || typeof data !== "object") return null;
  return data.message
    || (data.data && data.data.message)
    || (data.result && data.result.message)
    || null;
}

/** SSE 逐行读取器（对照 catpaw-upstream-client.mjs 的 turnStream）。
 *  按字节缓冲：TCP 分片不会按行对齐，思考内容里中文占大头（一个汉字 3 字节），
 *  按字符串逐段拼接时若分片落在字符中间会产生 U+FFFD（内容损坏） */
class SseReader {
  constructor() {
    this.tail = Buffer.alloc(0);
  }

  /** 吃一段上游字节，吐出这一批能解析出的事件（{data} | {failed} 两类） */
  push(chunk) {
    const out = [];
    this.tail = this.tail.length ? Buffer.concat([this.tail, Buffer.from(chunk)]) : Buffer.from(chunk);
    let start = 0;
    let offset = this.tail.indexOf(0x0a, start);
    while (offset >= 0) {
      const line = this.tail.toString("utf8", start, offset);
      const event = parseLine(line);
      if (event) out.push(event);
      start = offset + 1;
      offset = this.tail.indexOf(0x0a, start);
    }
    this.tail = this.tail.subarray(start);
    return out;
  }

  /** 流结束：处理可能没有换行结尾的最后一行（残缺 JSON 解析失败自然丢弃） */
  finish() {
    const line = this.tail.toString("utf8");
    this.tail = Buffer.alloc(0);
    return parseLine(line);
  }
}

/** 解析一行 SSE（非 data: 行、空行、[DONE]、非法 JSON 都返回 null） */
function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice("data:".length).trim();
  if (!raw || raw === "[DONE]") return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // 无法解析的行忽略（上游偶尔混入心跳/注释帧）
    require("./log.cjs").verbose("忽略无法解析的 SSE 行");
    return null;
  }
  try {
    return { data: unwrapApiData(value) };
  } catch (e) {
    return { failed: e };
  }
}

/** 后缀差分：current 以 previous 开头时返回新增部分，否则整体返回；完全相等返回 null（不发帧） */
function suffixAfter(current, previous) {
  if (current === previous) return null;
  if (current.startsWith(previous)) return current.slice(previous.length);
  return current;
}

/** 流式翻译状态机：生命周期 = 一个 turn。
 *  consume(event) 返回本轮要下发的 delta 数组（可能为空）；流读到底后调 finish() 取结果 */
class TurnTranslator {
  constructor({ choice }) {
    this.text = ""; // 累积正文（上游给全量，差分后才是 delta）
    this.reasoning = ""; // 累积思考
    this.tools = new Map(); // toolCallId → {args, name}
    this.order = []; // tool_call 首见顺序（决定下发 chunk 里的 index）
    this.latest = null; // 最近一个事件（usage 从它取）
    this.lastMessage = null; // 最近一条 assistant 消息（收尾组装 OpenAI 消息）
    this.completed = false; // 是否收到过 message.finished === true
    this.choice = choice || { kind: "auto" };
  }

  /** 消费一个事件：返回要下发的 delta 数组；上游在数据帧里报错则抛 CatPawError */
  consume(event) {
    this.latest = event;
    const error = responseError(event);
    if (error) throw error;
    const message = responseMessage(event);
    if (!message) return []; // 心跳 / status 之类不下发任何帧
    const deltas = [];
    const delta = this.messageDelta(message);
    if (delta && Object.keys(delta).length) deltas.push(delta);
    if (message.finished === true) this.completed = true;
    this.lastMessage = message;
    return deltas;
  }

  /** 收尾：校验「流在消息完成前结束」并执行 tool_choice 约束，产出本轮结果。
   *  这里**不代表** turn 已结束——message.finished=true 只是消息完成，服务端关连接才是 turn 结束，
   *  所以调用方必须把 SSE 读到底再来调 finish */
  finish() {
    if (!this.completed) throw CatPawError.upstream("上游 SSE 在消息完成前结束");
    const message = this.lastMessage;
    if (!message) throw CatPawError.upstream("上游没有返回消息");
    const calls = this.checkChoice(message);
    const finishReason = calls.length ? "tool_calls" : "stop";
    return {
      conversationId: String((this.latest && this.latest.conversationId) || ""),
      openaiMessage: openaiMessage(message, calls),
      text: extractMessageText(message),
      reasoning: extractReasoning(message),
      toolCalls: calls,
      message,
      raw: this.latest || null,
      finishReason,
      usage: this.finalUsage(),
    };
  }

  /** `tool_choice` 的收尾校验（照抄原实现 llmTurn 末尾那一段） */
  checkChoice(message) {
    const all = extractToolCalls(message);
    if (this.choice.kind === "none") {
      if (all.length) throw CatPawError.upstream("tool_choice=none 时上游仍返回了 tool_call");
      return [];
    }
    if (this.choice.kind === "auto") return all;
    if (this.choice.kind === "required") {
      if (!all.length) throw CatPawError.upstream("tool_choice=required 时上游未返回 tool_call");
      return all;
    }
    const selected = all.filter((call) => call.function && call.function.name === this.choice.name);
    if (!selected.length) {
      throw CatPawError.upstream(`tool_choice 要求调用 ${this.choice.name}，但上游未返回该工具`);
    }
    return selected;
  }

  /** 本轮 usage（已按本家口径修正；上游没给就是三个 0） */
  finalUsage() {
    return usageFromResponse(this.latest) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  /** 累积 → 增量差分（正文、思考、每个 tool 的参数都用前缀判定；上游换了一段完全不同的内容时整体重发） */
  messageDelta(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const textBlocks = blocks.filter((block) => block && block.type === "text");
    const text = textBlocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
    const reasoning = textBlocks.map((block) => (typeof block.reasoningContent === "string" ? block.reasoningContent : "")).join("");
    const textDelta = suffixAfter(text, this.text);
    const reasoningDelta = suffixAfter(reasoning, this.reasoning);
    this.text = text;
    this.reasoning = reasoning;

    const delta = {};
    if (textDelta !== null) delta.content = textDelta;
    if (reasoningDelta !== null) delta.reasoning_content = reasoningDelta;
    const calls = this.toolDeltas(blocks);
    if (calls) delta.tool_calls = calls;
    return delta;
  }

  /** tool_use 块的增量差分：首见发 id+type+name 一帧（参数增量另起一帧），其后只发参数增量 */
  toolDeltas(blocks) {
    const calls = [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use") continue;
      const id = typeof block.toolCallId === "string" ? block.toolCallId : "";
      const name = typeof block.toolName === "string" ? block.toolName : "";
      if (!id || !name) continue;
      const args = typeof block.toolParams === "string" ? block.toolParams : "";
      const previous = this.tools.has(id) ? this.tools.get(id).args : "";
      const seen = this.tools.has(id);
      const argsDelta = suffixAfter(args, previous);
      this.tools.set(id, { args, name });
      let toolIndex = this.order.indexOf(id);
      if (toolIndex < 0) {
        this.order.push(id);
        toolIndex = this.order.length - 1;
      }
      if (!seen) {
        calls.push({ index: toolIndex, id, type: "function", function: { name, arguments: "" } });
        if (argsDelta !== null) calls.push({ index: toolIndex, function: { arguments: argsDelta } });
      } else if (argsDelta !== null) {
        calls.push({ index: toolIndex, function: { arguments: argsDelta } });
      }
    }
    return calls.length ? calls : null;
  }
}

/** 组装 OpenAI 的非流式 assistant 消息 */
function openaiMessage(message, calls) {
  const text = extractMessageText(message);
  const reasoning = extractReasoning(message);
  const out = { role: "assistant", content: text || null };
  if (reasoning) out.reasoning_content = reasoning;
  if (calls && calls.length) out.tool_calls = calls;
  return out;
}

/** 上游 assistant 消息的 tool_use 块 → OpenAI tool_calls。重复 toolCallId 报 502
 *  （同一条消息里出现重复 id 会让客户端的 tool_use/tool_result 配对错乱，属上游数据问题） */
function extractToolCalls(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  const out = [];
  const ids = [];
  for (const block of blocks) {
    if (!block || block.type !== "tool_use") continue;
    const id = typeof block.toolCallId === "string" ? block.toolCallId : "";
    if (ids.includes(id)) throw CatPawError.upstream(`上游返回重复的 tool_call_id: ${id}`);
    ids.push(id);
    out.push({
      id,
      type: "function",
      function: {
        name: typeof block.toolName === "string" ? block.toolName : "",
        arguments: typeof block.toolParams === "string" ? block.toolParams : "",
      },
    });
  }
  return out;
}

function extractMessageText(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === "text").map((b) => (typeof b.text === "string" ? b.text : "")).join("");
}

function extractReasoning(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === "text").map((b) => (typeof b.reasoningContent === "string" ? b.reasoningContent : "")).join("");
}

/** 上游 usage → OpenAI usage（口径修正）：
 *    prompt = max(prompt, total - completion)（完整输入）；total = prompt + completion；
 *    max 的意义：上游若让 total 小于 completion（异常/钳位），取 prompt 原值比取负数稳 */
function usageFromResponse(data) {
  if (!data || typeof data !== "object") return null;
  const usage = data.usage || (data.contextInfo && data.contextInfo.usage);
  if (!usage || typeof usage !== "object") return null;
  const prompt = numberOf(usage.prompt_tokens) ?? numberOf(usage.promptTokens) ?? 0;
  const completion = numberOf(usage.completion_tokens) ?? numberOf(usage.completionTokens) ?? 0;
  const upstreamTotal = numberOf(usage.total_tokens) ?? numberOf(usage.totalTokens) ?? 0;
  const fullPrompt = upstreamTotal > 0 ? Math.max(prompt, upstreamTotal - completion) : prompt;
  return { prompt_tokens: fullPrompt, completion_tokens: completion, total_tokens: fullPrompt + completion };
}

function numberOf(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

module.exports = {
  includeUsage,
  unwrapApiData,
  extractToolCalls,
  usageFromResponse,
  SseReader,
  TurnTranslator,

};
