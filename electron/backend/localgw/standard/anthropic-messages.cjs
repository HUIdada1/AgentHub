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
// 标准自定义供应商执行器 · Anthropic Messages 档。
// 与 openai-compat.cjs 暴露完全相同的接口面（executor.cjs 与 provider.probe() 按这套调用）：
//   headers / upstreamFor / entryFor / models / modelEntries / rewriteBody / chat / chatAwaited /
//   fetchModels / refreshToken / userInfo
// 协议翻译本身在 anthropic-translate.cjs（纯函数），本文件只负责 HTTP 与事件桥接。
// 禁止依赖混合 adapters 或供应商私有实现。
"use strict";
const transport = require("../../proxy/transport-context.cjs");
const { timeoutMs, firstByteBudgetMs, fetchStream, httpJson, pumpSse } = require("../../network/http.cjs");
const { pumpSseAwaited } = require("../../network/sse-reader.cjs");
const { toAnthropic, createSseBridge } = require("./anthropic-translate.cjs");
const { compatModelEntries } = require("./openai-compat.cjs");
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** 出站端点：base_url 存的是**不含 /v1 的根**（normalizeBaseUrl 在写入侧剥掉了），所以这里恒补 /v1。
 *  Anthropic 只有 messages 一个主 leaf，不做 openai-compat 那种「完整端点形态」分支。 */
function endpoint(base, leaf) {
  return `${String(base || "").replace(/\/+$/, "")}/v1/${leaf}`;
}

/** 鉴权风格：row.auth 三档（"" = auto / bearer / x-api-key）。
 *  auto 的唯一例外是官方 api.anthropic.com（只认 x-api-key）；国内 Coding Plan / OpenRouter /
 *  OpenCode 一律 Bearer（Claude Code 的 ANTHROPIC_AUTH_TOKEN 语义）。 */
function authStyle(row) {
  const a = String((row && row.auth) || "");
  if (a === "x-api-key" || a === "bearer") return a;
  try {
    return new URL(String(row.baseUrl || "")).hostname.toLowerCase() === "api.anthropic.com" ? "x-api-key" : "bearer";
  } catch {
    return "bearer";
  }
}

const FINISH_REASON = (r) => {
  const s = String(r || "");
  if (s === "end_turn" || s === "stop_sequence") return "stop";
  if (s === "max_tokens") return "length";
  if (s === "tool_use") return "tool_calls";
  return s || "stop";
};

const USAGE_BASE_KEYS = new Set(["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens"]);

/** 非流式整包响应的 usage 归一：口径与 createSseBridge 完全一致
 *  （prompt_tokens 含缓存读/写，缓存命中另放 prompt_tokens_details.cached_tokens）。 */
function usageOf(u) {
  const usage = u && typeof u === "object" ? u : {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  const extra = {};
  for (const [k, v] of Object.entries(usage)) if (typeof v === "number" && !USAGE_BASE_KEYS.has(k)) extra[k] = v;
  const promptTotal = input + cacheRead + cacheCreate;
  const out = { ...extra, prompt_tokens: promptTotal, completion_tokens: output, total_tokens: promptTotal + output };
  if (cacheRead || cacheCreate) {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
    out.cache_read_input_tokens = cacheRead;
    out.cache_creation_input_tokens = cacheCreate;
  }
  return out;
}

/** Anthropic 错误 → HTTP 语义：余额/配额 402（换号）、限流 429、鉴权 401，其余 502（可换号） */
function statusFromAnthropicError(err) {
  const text = `${String((err && (err.type || err.code)) || "")} ${String((err && err.message) || "")}`;
  if (/insufficient|quota|balance|余额|额度|recharge/i.test(text)) return 402;
  if (/rate[_ ]?limit|too many requests|限流|请求过于频繁/i.test(text)) return 429;
  if (/auth|api[_ ]?key|unauthorized|permission/i.test(text)) return 401;
  return 502;
}

function makeAnthropicMessages(row, opts) {
  const entries = compatModelEntries(row);
  const messagesUrl = endpoint(row.baseUrl, "messages");
  // 首字节预算注入口径与 openai-compat.cjs 完全一致（自测能把 30s 缩到秒级复现「首事件不解除预算」）
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
  /** 剥掉自家的 `slug/` 前缀（那是路由信息，上游听不懂） */
  const stripPrefix = (clientModel) => {
    const s = String(clientModel || "");
    return s.slice(0, row.id.length + 1).toLowerCase() === `${row.id}/`.toLowerCase() ? s.slice(row.id.length + 1) : s;
  };
  return {
    /** 头 = 标准 JSON + anthropic-version + 按 auth 生成的鉴权头 + 用户自定义覆盖。
     *  鉴权头由网关按 Key 生成，normalizeHeaders 已拦住用户覆盖。 */
    headers(secrets) {
      const h = {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (authStyle(row) === "x-api-key") h["x-api-key"] = String((secrets && secrets.token) || "");
      else h.authorization = `Bearer ${String((secrets && secrets.token) || "")}`;
      for (const [k, v] of Object.entries(row.extraHeaders || {})) h[String(k)] = String(v);
      return h;
    },

    /** 客户端模型名 → 上游真名（剥前缀 + 查 upstream 映射，别名同表）；目录外原样透传 */
    upstreamFor(clientModel) {
      const s = stripPrefix(clientModel);
      return upstreamByClient.get(s.toLowerCase()) || s;
    },

    /** 客户端模型名（或别名）→ 该条目的元数据；查不到回 null */
    entryFor(clientModel) {
      return entryByClient.get(stripPrefix(clientModel).toLowerCase()) || null;
    },

    models() {
      return entries.map((e) => e.client);
    },

    modelEntries() {
      return entries;
    },

    /** Anthropic 协议必填 max_tokens：模型行上的 maxOutputTokens 优先，其次预设兜底，
     *  最后才 8192。缺了它长回答会被上游按小值截断（客户端看到 MAX_TOKENS）。 */
    defaultMaxTokensFor(clientModel) {
      const entry = this.entryFor(clientModel);
      const fromModel = Number(entry && entry.entry && entry.entry.maxOutputTokens);
      if (Number.isFinite(fromModel) && fromModel > 0) return Math.floor(fromModel);
      const fromRow = Number(row.defaultMaxTokens);
      if (Number.isFinite(fromRow) && fromRow > 0) return Math.floor(fromRow);
      return 8192;
    },

    rewriteBody(model, body) {
      // toAnthropic 返回的 body 已含 stream:true（非流式由 server 侧聚合器兜）
      return toAnthropic(this.upstreamFor(model), body, { defaultMaxTokens: this.defaultMaxTokensFor(model) });
    },

    async chat(ctx) {
      return this.chatAnthropic(ctx);
    },

    async chatAwaited(ctx) {
      return this.chatAnthropic({ ...ctx, awaitEvents: true });
    },

    async chatAnthropic({ secrets, model, body, emit, awaitEvents = false }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(messagesUrl, {
        method: "POST", headers: this.headers(secrets), body: payload,
        firstByteMs: budgetOf(payload),
      });
      const result = { status: 200, planLimit: false };
      // 首字节达标即解除预算计时器：漏这一步会让计时器在整个流期间一直武装，到点 abort 掉
      // resp.body，把一条正常的长回答掐成「HTTP 200 + 半截内容」（issue #107 的根因）。
      // finally 那次是「一个字节都没到时」的兜底。
      let settled = false;
      const settle = () => { if (!settled) { settled = true; cancelTimer(); } };
      // awaitEvents 时先把事件排进本地队列再逐条 await emit：桥本身是同步的，
      // 但 executor 的 emit 是异步的（且会抛授权/取消），必须保持顺序与背压。
      const pending = [];
      const bridge = createSseBridge(awaitEvents ? (ev) => { pending.push(ev); } : emit);
      const flush = async () => { while (pending.length) await emit(pending.shift()); };
      try {
        // 少数中转站无视 stream:true、直接回一整个 JSON：SseScanner 找不到 data: 行会一条都不产出，
        // 客户端就拿到 200 空响应。按 content-type 单独走非流式分支（createSseBridge 只吃 SSE 事件）。
        const ctype = String(resp.headers.get("content-type") || "");
        if (!ctype.includes("event-stream")) {
          settle(); // 非流式形态没有"首事件"，读到正文即达标
          const text = await transport.readText(resp, 16 * 1024 * 1024, timeoutMs("httpJsonTimeoutMs", 60000));
          const data = parseJson(text);
          if (!data) throw Object.assign(new Error(`上游返回非 JSON（${text.slice(0, 200)}）`), { status: 502 });
          if (awaitEvents) {
            const events = [];
            emitWholeResponse(data, (ev) => events.push(ev), result);
            for (const ev of events) await emit(ev);
          } else emitWholeResponse(data, emit, result);
          return result;
        }
        if (awaitEvents) {
          await pumpSseAwaited(resp, async (event, raw) => {
            settle();
            bridge.onEvent(event, raw);
            await flush();
          }, { signal: transport.current()?.signal, idleMs: timeoutMs("streamIdleMs", 300000) });
          if (bridge.result.planLimit) result.planLimit = true;
          return result;
        }
        await pumpSse(resp, (event, raw) => {
          settle();
          bridge.onEvent(event, raw);
        });
        if (bridge.result.planLimit) result.planLimit = true;
      } finally {
        cancelTimer();
      }
      return result;
    },

    /** 拉上游自己的模型清单（GET {base}/v1/models）：Anthropic 官方与部分厂商有，失败如实回错 */
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

    // 提供商是 API Key 直连：没有刷新链路，也没有"余额"这个概念（刻意不定义 queryCredits）。
    async refreshToken() {
      return { ok: false, noRefresh: true, message: "该渠道为 API Key 直连，无自动刷新；Key 失效请换新" };
    },
    async userInfo() {
      return { uid: "", name: "" };
    },
  };
}

/** 非流式上游响应 → 同一套 emit 词汇（正文 + tool_use + usage + finish）。
 *  Anthropic 非流式形状：{content:[{type:"text"|"thinking"|"tool_use",...}], stop_reason, usage}。 */
function emitWholeResponse(data, emit, result) {
  if (data && data.error) {
    const status = statusFromAnthropicError(data.error);
    if (status === 402) result.planLimit = true;
    emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
    return;
  }
  let toolIndex = 0;
  for (const block of Array.isArray(data && data.content) ? data.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      emit({ type: "delta", delta: { content: block.text } });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      emit({ type: "delta", delta: { reasoning_content: block.thinking } });
    } else if (block.type === "tool_use") {
      emit({
        type: "delta",
        delta: {
          tool_calls: [{
            index: toolIndex++, id: String(block.id || ""), type: "function",
            function: { name: String(block.name || ""), arguments: JSON.stringify(block.input || {}) },
          }],
        },
      });
    }
  }
  if (data && data.usage) emit({ type: "usage", usage: usageOf(data.usage) });
  emit({ type: "finish", reason: FINISH_REASON(data && data.stop_reason) });
}

module.exports = { makeAnthropicMessages, authStyle };
