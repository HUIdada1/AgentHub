/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 标准自定义供应商执行器 · OpenAI Responses 档（POST {base}/v1/responses）。
// 与 openai-compat.cjs 暴露完全相同的接口面（executor.cjs 与 provider.probe() 按这套调用）：
//   headers / upstreamFor / entryFor / models / modelEntries / rewriteBody / chat / chatAwaited /
//   fetchModels / refreshToken / userInfo
// 内部输入一律是 OpenAI Chat 形状（网关的公共入口），本文件负责 Chat → Responses 的请求互转
// 与 Responses SSE → 统一 emit 事件的映射。禁止依赖混合 adapters 或供应商私有实现。
"use strict";
const transport = require("../../proxy/transport-context.cjs");
const { timeoutMs, firstByteBudgetMs, fetchStream, httpJson, pumpSse } = require("../../network/http.cjs");
const { pumpSseAwaited } = require("../../network/sse-reader.cjs");
const { compatModelEntries } = require("./openai-compat.cjs");
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** 出站端点：base_url 存的是**不含 /v1 的根**（normalizeBaseUrl 在写入侧剥掉了），所以这里恒补 /v1 */
function endpoint(base, leaf) {
  return `${String(base || "").replace(/\/+$/, "")}/v1/${leaf}`;
}

/** OpenAI content（string | parts[]）→ 纯文本（system/assistant/tool 只用文本） */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** user 消息的 content parts → Responses 的 input parts（文本 + 图片） */
function inputParts(content) {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") out.push({ type: "input_text", text: part.text });
    else if (part.type === "image_url" && part.image_url && part.image_url.url) out.push({ type: "input_image", image_url: String(part.image_url.url) });
  }
  return out;
}

/** Responses 的 usage 口径与 OpenAI Chat 一致：input/output → prompt/completion，
 *  缓存命中放 prompt_tokens_details.cached_tokens（下游按此显示命中率）。 */
function responsesUsage(u) {
  const src = u && typeof u === "object" ? u : {};
  const prompt = Number(src.input_tokens) || 0;
  const completion = Number(src.output_tokens) || 0;
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(src.total_tokens) || prompt + completion };
  const cached = Number(src.input_tokens_details && src.input_tokens_details.cached_tokens) || 0;
  if (cached) usage.prompt_tokens_details = { cached_tokens: cached };
  return usage;
}

/** 上游错误 → HTTP 语义（与 openai-compat 同一条判序：先限流、再欠费、再鉴权，其余 502） */
function statusFromResponsesError(err) {
  const text = `${String((err && (err.code || err.type)) || "")} ${String((err && err.message) || "")}`;
  if (/rate[_ ]?limit|too many requests|限流|请求过于频繁/i.test(text)) return 429;
  if (/insufficient|quota|balance|余额|额度|recharge/i.test(text)) return 402;
  if (/auth|api[_ ]?key|invalid[_ ]?key|unauthorized/i.test(text)) return 401;
  return 502;
}

function makeOpenaiResponses(row, opts) {
  const entries = compatModelEntries(row);
  const responsesUrl = endpoint(row.baseUrl, "responses");
  // 首字节预算注入口径与 openai-compat.cjs 完全一致
  const budgetOf = opts && typeof opts.firstByteBudgetMs === "function" ? opts.firstByteBudgetMs : firstByteBudgetMs;
  const upstreamByClient = new Map();
  const entryByClient = new Map();
  for (const e of entries) {
    upstreamByClient.set(e.client.toLowerCase(), e.upstream);
    entryByClient.set(e.client.toLowerCase(), e);
    for (const a of (e.entry && Array.isArray(e.entry.aliases) ? e.entry.aliases : [])) {
      const k = String(a || "").toLowerCase();
      if (!k) continue;
      upstreamByClient.set(k, e.upstream);
      entryByClient.set(k, e);
    }
  }
  const stripPrefix = (clientModel) => {
    const s = String(clientModel || "");
    return s.slice(0, row.id.length + 1).toLowerCase() === `${row.id}/`.toLowerCase() ? s.slice(row.id.length + 1) : s;
  };
  return {
    headers(secrets) {
      const h = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${String((secrets && secrets.token) || "")}`,
      };
      for (const [k, v] of Object.entries(row.extraHeaders || {})) h[String(k)] = String(v);
      return h;
    },

    upstreamFor(clientModel) {
      const s = stripPrefix(clientModel);
      return upstreamByClient.get(s.toLowerCase()) || s;
    },

    entryFor(clientModel) {
      return entryByClient.get(stripPrefix(clientModel).toLowerCase()) || null;
    },

    models() {
      return entries.map((e) => e.client);
    },

    modelEntries() {
      return entries;
    },

    /** Chat 形状 → Responses 形状。
     *  网关内部字段（conversation_id / conversationId / prompt_cache_key / extraBody / stream_options）
     *  刻意不出现在出站体里：它们是网关自己的记账/路由载体，上游会当成未知字段回 400。 */
    rewriteBody(model, body) {
      const b = body || {};
      const out = { model: this.upstreamFor(model), stream: true, store: false };
      const instructions = [];
      const input = [];
      for (const msg of Array.isArray(b.messages) ? b.messages : []) {
        if (!msg || typeof msg !== "object") continue;
        const role = String(msg.role || "");
        if (role === "system" || role === "developer") {
          const text = contentText(msg.content);
          if (text) instructions.push(text);
          continue;
        }
        if (role === "tool") {
          // tool 结果 → function_call_output（call_id 对齐上一轮 function_call）
          input.push({
            type: "function_call_output",
            call_id: String(msg.tool_call_id || msg.toolCallId || ""),
            output: contentText(msg.content),
          });
          continue;
        }
        if (role === "assistant") {
          const text = contentText(msg.content);
          if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
          for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
            if (!tc || typeof tc !== "object") continue;
            const fn = tc.function && typeof tc.function === "object" ? tc.function : {};
            input.push({
              type: "function_call",
              call_id: String(tc.id || ""),
              name: String(fn.name || ""),
              arguments: String(fn.arguments || "{}"),
            });
          }
          continue;
        }
        const parts = inputParts(msg.content);
        input.push({ type: "message", role: "user", content: parts.length ? parts : [{ type: "input_text", text: "" }] });
      }
      if (instructions.length) out.instructions = instructions.join("\n\n");
      out.input = input;
      if (Array.isArray(b.tools) && b.tools.length) {
        const tools = [];
        for (const t of b.tools) {
          // Chat 的 {type:"function",function:{...}} → Responses 的摊平形态 {type:"function",name,...}
          const fn = t && t.type === "function" && t.function && typeof t.function === "object" ? t.function : t;
          if (!fn || typeof fn.name !== "string" || !fn.name) continue;
          tools.push({
            type: "function",
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : "",
            parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
          });
        }
        if (tools.length) out.tools = tools;
      }
      const mt = Number(b.max_tokens ?? b.max_completion_tokens);
      if (Number.isFinite(mt) && mt > 0) out.max_output_tokens = Math.floor(mt);
      if (typeof b.reasoning_effort === "string" && b.reasoning_effort) out.reasoning = { effort: b.reasoning_effort };
      return out;
    },

    async chat(ctx) {
      return this.chatResponses(ctx);
    },

    async chatAwaited(ctx) {
      return this.chatResponses({ ...ctx, awaitEvents: true });
    },

    async chatResponses({ secrets, model, body, emit, awaitEvents = false }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(responsesUrl, {
        method: "POST", headers: this.headers(secrets), body: payload,
        firstByteMs: budgetOf(payload),
      });
      const result = { status: 200, planLimit: false };
      // 首字节达标即解除预算计时器（漏了会把长回答掐成半截，见 openai-compat.cjs 同处注释）
      let settled = false;
      const settle = () => { if (!settled) { settled = true; cancelTimer(); } };
      // 事件映射器：SSE 与非流式整包共用同一份 emit 词汇
      const state = { toolByIndex: new Map(), nextToolIndex: 0, sawTool: false };
      const dispatch = (event, raw) => {
        const events = [];
        mapEvent(event, raw, state, events, result);
        for (const ev of events) emit(ev);
      };
      try {
        const ctype = String(resp.headers.get("content-type") || "");
        if (!ctype.includes("event-stream")) {
          settle();
          const text = await transport.readText(resp, 16 * 1024 * 1024, timeoutMs("httpJsonTimeoutMs", 60000));
          const data = parseJson(text);
          if (!data) throw Object.assign(new Error(`上游返回非 JSON（${text.slice(0, 200)}）`), { status: 502 });
          if (awaitEvents) {
            const events = [];
            mapWholeResponse(data, state, events, result);
            for (const ev of events) await emit(ev);
          } else {
            const events = [];
            mapWholeResponse(data, state, events, result);
            for (const ev of events) emit(ev);
          }
          return result;
        }
        if (awaitEvents) {
          await pumpSseAwaited(resp, async (event, raw) => {
            settle();
            const events = [];
            mapEvent(event, raw, state, events, result);
            for (const ev of events) await emit(ev);
          }, { signal: transport.current()?.signal, idleMs: timeoutMs("streamIdleMs", 300000) });
          return result;
        }
        await pumpSse(resp, (event, raw) => {
          settle();
          dispatch(event, raw);
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    async fetchModels(account, secrets) {
      const r = await httpJson(endpoint(row.baseUrl, "models"), { method: "GET", headers: this.headers(secrets || {}) })
        .catch((e) => ({ ok: false, status: 0, data: null, text: String((e && e.message) || e) }));
      if (!r.ok) {
        return {
          ok: false,
          message: `HTTP ${r.status || 0} ${(r.text || "").slice(0, 200)}` +
            (r.status === 404 ? "（该上游没有模型目录接口，请在模型清单里手填）" : ""),
        };
      }
      const list = (r.data && (Array.isArray(r.data) ? r.data : r.data.data)) || [];
      const models = list.map((m) => String((m && (m.id ?? m.model ?? m.name)) || "")).filter(Boolean);
      return { ok: true, models };
    },

    // 提供商是 API Key 直连：没有刷新链路（刻意不定义 queryCredits）
    async refreshToken() {
      return { ok: false, noRefresh: true, message: "该渠道为 API Key 直连，无自动刷新；Key 失效请换新" };
    },
    async userInfo() {
      return { uid: "", name: "" };
    },
  };
}

/** 单个 Responses SSE 事件 → 统一 emit 事件（顺序与内容都写在这里，便于逐事件核对） */
function mapEvent(event, raw, state, out, result) {
  const data = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!data || typeof data !== "object") return;
  const type = String(data.type || event || "");
  if (type === "response.output_text.delta") {
    if (typeof data.delta === "string" && data.delta) out.push({ type: "delta", delta: { content: data.delta } });
    return;
  }
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    if (typeof data.delta === "string" && data.delta) out.push({ type: "delta", delta: { reasoning_content: data.delta } });
    return;
  }
  if (type === "response.output_item.added") {
    const item = data.item || {};
    if (item.type !== "function_call") return;
    const key = Number(data.output_index) || 0;
    const toolIndex = state.nextToolIndex++;
    state.toolByIndex.set(key, { toolIndex, id: String(item.call_id || item.id || ""), name: String(item.name || "") });
    // arguments.delta 用 item_id 指回同一个 function_call（两种键都铺上，output_index 缺失时也能命中）
    if (item.id) state.toolByIndex.set(String(item.id), state.toolByIndex.get(key));
    state.sawTool = true;
    out.push({
      type: "delta",
      delta: { tool_calls: [{ index: toolIndex, id: String(item.call_id || item.id || "") || undefined, type: "function", function: { name: String(item.name || ""), arguments: "" } }] },
    });
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const key = data.output_index != null ? Number(data.output_index) : String(data.item_id || "");
    const acc = state.toolByIndex.get(key) || (data.item_id ? state.toolByIndex.get(String(data.item_id)) : null);
    if (!acc || typeof data.delta !== "string" || !data.delta) return;
    out.push({ type: "delta", delta: { tool_calls: [{ index: acc.toolIndex, function: { arguments: data.delta } }] } });
    return;
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const response = data.response || {};
    if (response.usage) out.push({ type: "usage", usage: responsesUsage(response.usage) });
    const reason = type === "response.incomplete" ? "length" : state.sawTool ? "tool_calls" : "stop";
    out.push({ type: "finish", reason });
    return;
  }
  if (type === "response.failed" || type === "error") {
    const err = (data.response && data.response.error) || data.error || {};
    const status = statusFromResponsesError(err);
    if (status === 402) result.planLimit = true;
    out.push({ type: "error", status, code: Number(err.code) || 0, message: String(err.message || data.message || "上游错误") });
  }
  // 其余事件（response.created / in_progress / output_item.done 等）忽略
}

/** 非流式整包（部分中转站无视 stream:true）→ 同一套 emit 词汇。
 *  形状：{output:[{type:"message",content:[{type:"output_text",text}]} | {type:"function_call",call_id,name,arguments} | {type:"reasoning",summary:[...]}], usage} */
function mapWholeResponse(data, state, out, result) {
  if (data && data.error) {
    const status = statusFromResponsesError(data.error);
    if (status === 402) result.planLimit = true;
    out.push({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
    return;
  }
  for (const item of Array.isArray(data && data.output) ? data.output : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && part.type === "output_text" && typeof part.text === "string" && part.text) {
          out.push({ type: "delta", delta: { content: part.text } });
        }
      }
    } else if (item.type === "reasoning") {
      for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (part && typeof part.text === "string" && part.text) out.push({ type: "delta", delta: { reasoning_content: part.text } });
      }
    } else if (item.type === "function_call") {
      const toolIndex = state.nextToolIndex++;
      state.sawTool = true;
      out.push({
        type: "delta",
        delta: { tool_calls: [{ index: toolIndex, id: String(item.call_id || item.id || "") || undefined, type: "function", function: { name: String(item.name || ""), arguments: String(item.arguments || "{}") } }] },
      });
    }
  }
  if (data && data.usage) out.push({ type: "usage", usage: responsesUsage(data.usage) });
  out.push({ type: "finish", reason: state.sawTool ? "tool_calls" : "stop" });
}

module.exports = { makeOpenaiResponses };
