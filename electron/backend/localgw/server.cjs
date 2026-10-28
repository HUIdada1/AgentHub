/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · HTTP 转发服务器（完整实现）
// 转发由 forwarder.cjs 完成（薄包装 proxy/adapters.cjs 的 chat()）；
// Anthropic 协议入向按 proxy/protocols/anthropic-in.cjs 的字段映射共识在本地翻译（本模块只做路径级分发）。
// 关键决策：
//  · 单进程内嵌（方案 §3.1）：不另起子进程，与号池共用主进程 event loop
//  · 鉴权前置：所有 /v1/* 都要求凭据（Authorization: Bearer 或 Anthropic 的 x-api-key；GET /health 除外）
//  · 出站指纹脱敏：默认开（方案 §7），剥离 cc_* 等客户端痕迹头
//  · 账号体系只读号池（方案 §4.1）：号池凭据永远不进本模块的 config/log
"use strict";
const http = require("node:http");
const lgwConfig = require("./config.cjs");
const keysStore = require("./keys-store.cjs");
const routing = require("./routing.cjs");
const models = require("./models.cjs");
const oplog = require("./oplog.cjs");
const usagehook = require("./usagehook.cjs");
const forwarder = require("./forwarder.cjs");
// 出站指纹脱敏**不在本层**：渠道要等 failover 循环里才确定，而渠道特有规则只能那时生效，
// 所以出站 body 清洗整体下沉到 forwarder.forward()（契约 §4.7 v1.1 修订）。
// 本层只负责把 forwardResult.outboundHits 落进请求日志的「敏」列。
// 说明：Anthropic 字段映射的"共识来源"是 proxy/protocols/anthropic-in.cjs / anthropic-out.cjs，
// 但本模块只用其中的字段约定（见下方 anthropicRequestToOpenai / openaiEventToAnthropic），
// 不直接调用那两个模块。审查前这里 require 了却从未使用——顶层死 require 会在
// 被依赖文件出问题时把整个网关一起拖崩，已移除。
// 提示词注入与记忆写入的两个可选依赖都**惰性**取用（见 promptsStoreMod / maybeWriteToMemory）：
// 顶层 require 会在被依赖模块出问题时把整个网关一起拖崩，而这两个能力都是"锦上添花"。
// 注：`../prompts/index.cjs` 曾被顶层 require 却从未使用，已移除（审查整改）。
const memory = (() => { try { return require("../memory/index.cjs"); } catch { return null; } })();

/** 运行状态 */
const state = {
  server: null,
  running: false,
  port: 0,
  bind: "",
  startedAt: 0,
};

/** 集锦并发控制：在途数量（用于本地网关的全局促流） */
const concurrencyGuard = {
  inFlight: 0,
  max: 16,
  queue: [],
  async acquire(timeoutMs) {
    const t0 = Date.now();
    while (this.inFlight >= this.max) {
      if (Date.now() - t0 > (timeoutMs || 10000)) {
        const e = new Error("QUEUE_TIMEOUT");
        e.code = "QUEUE_TIMEOUT";
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    this.inFlight++;
  },
  release() { this.inFlight = Math.max(0, this.inFlight - 1); },
};

/** 常量时间字符串比较：长度不等直接 false（长度本身不是秘密），等长走 timingSafeEqual。
 *  用于 adminToken / readonlyToken 这类"进程内共享口令"的比对，避免逐字符短路被计时侧信道利用。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? "" : a), "utf8");
  const y = Buffer.from(String(b == null ? "" : b), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  try {
    return require("node:crypto").timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/** 解析 Bearer Token（兼容 Anthropic 客户端的 x-api-key 头） */
function authenticate(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  // Claude Code / Anthropic SDK 走的是 x-api-key 头：原代码注释声称兼容但只读了 Authorization，
  // 结果 Anthropic 客户端 100% 401。这里补上（Bearer 优先，其次 x-api-key）。
  const raw = (m ? m[1] : (req.headers["x-api-key"] || "")).trim();
  if (!raw) return { ok: false, status: 401, message: "缺少 Bearer Token（或 x-api-key 头）" };
  const r = keysStore.authenticate(raw);
  if (r.ok) return { ok: true, kind: "apikey", key: r.key };
  const c = lgwConfig.get();
  if (c.security.adminToken && safeEqual(raw, c.security.adminToken)) return { ok: true, kind: "admin" };
  if (c.security.readonlyToken && safeEqual(raw, c.security.readonlyToken)) return { ok: true, kind: "readonly" };
  const reason = r.reason === "revoked" ? "密钥已吊销" : r.reason === "expired" ? "密钥已过期" : "无效密钥";
  return { ok: false, status: 401, message: reason };
}

/** 限流判定（key 粒度）：每 key 每分钟 ratePerMin 次 */
const rateBuckets = new Map(); // keyId -> { windowStart, count }
/** 桶上限：超过就整体清一遍过期桶（key 被删除后桶不会自己消失，长期运行会只增不减） */
const RATE_BUCKET_MAX = 5000;
function checkRateLimit(key) {
  if (!key) return { ok: true };
  const now = Date.now();
  const limit = Number(key.ratePerMin) > 0 ? Number(key.ratePerMin) : lgwConfig.get().apiKeyRatePerMin;
  const b = rateBuckets.get(key.id) || { windowStart: now, count: 0 };
  if (now - b.windowStart >= 60000) { b.windowStart = now; b.count = 0; }
  b.count++;
  rateBuckets.set(key.id, b);
  if (rateBuckets.size > RATE_BUCKET_MAX) {
    for (const [id, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= 60000) rateBuckets.delete(id);
    }
  }
  if (b.count > limit) return { ok: false, status: 429, message: `超过限流（${limit} req/min）` };
  return { ok: true };
}

/** 每 key 在途计数（配置里 `key.concurrency` 的落地点）。
 *  为什么必须有：全局闸门（concurrencyGuard）只管"别把主进程打爆"，
 *  它管不住"某一个 key 把全局并发配额吃光"——而创建密钥时用户明确填了「并发」这一项，
 *  不生效就是界面承诺了没兑现（审查发现该字段落库但无任何消费点）。 */
const keyInFlight = new Map(); // keyId -> 在途数
/** 申请一个 key 槽位。返回 { ok, limit, release() }；release 幂等，多次调用不会把计数减穿。
 *  非 API Key（admin/readonly 令牌）不参与每 key 限额，返回空释放器。 */
function acquireKeySlot(key) {
  const noop = { ok: true, limit: 0, release() {} };
  if (!key || !key.id) return noop;
  const raw = Number(key.concurrency);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 8;
  const cur = keyInFlight.get(key.id) || 0;
  if (cur >= limit) return { ok: false, limit, release() {} };
  keyInFlight.set(key.id, cur + 1);
  let released = false;
  return {
    ok: true,
    limit,
    release() {
      if (released) return;
      released = true;
      const n = (keyInFlight.get(key.id) || 1) - 1;
      if (n <= 0) keyInFlight.delete(key.id);
      else keyInFlight.set(key.id, n);
    },
  };
}

/** 指纹脱敏：剔除客户端痕迹头的实际过滤在 proxy/adapters.cjs 内部完成；
 *  本模块不再单独做（避免重复维护两套名单；adapters 里已剥离 cc_/x-anthropic 等前缀特征头） */

/** 发送 JSON 响应 */
function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  // headersSent 之后 writeHead 会抛 ERR_HTTP_HEADERS_SENT（例如流式响应中途改走错误分支）
  if (res.headersSent) { try { res.end(); } catch { /* 已断 */ } return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-cache",
    ...extraHeaders,
  });
  res.end(payload);
}

/** 发送 SSE 头（流式响应前调用） */
function sendSseHeaders(res) {
  if (res.writableEnded) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** SSE 写一帧（data: {...}\n\n） */
function sendSseFrame(res, data) {
  if (res.writableEnded) return false;
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
function sendSseDone(res) {
  if (res.writableEnded) return;
  try { res.write("data: [DONE]\n\n"); } catch { /* 已断 */ }
}

/** CORS 预检：按 corsOrigins 列表放行 */
function applyCors(req, res) {
  const c = lgwConfig.get();
  const origin = req.headers.origin;
  if (!origin) return;
  if ((c.corsOrigins || []).includes(origin) || c.corsOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, anthropic-version");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

/** 请求体读取（受 bodyLimitMb 钳制）
 *  三处加固：
 *  ① maxMb 非法时回落 4MB（原实现会让 max 变成 NaN，"超限"判定恒为 false = 无上限）；
 *  ② 客户端中途断开（aborted/close）时立即 reject——原实现只监听 end/error，
 *     断连后 Promise 永不 settle，请求处理器与监听器一直挂着；
 *  ③ 无论成功失败都摘掉全部监听器，避免同一 req 上残留 data 回调。 */
function readBody(req, maxMb) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const max = (Number(maxMb) > 0 ? Number(maxMb) : 4) * 1024 * 1024;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAbort);
      req.removeListener("close", onClose);
    };
    const done = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
    function onData(c) {
      size += c.length;
      if (size > max) {
        done(reject, Object.assign(new Error("PAYLOAD_TOO_LARGE"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    }
    function onEnd() { done(resolve, Buffer.concat(chunks)); }
    function onError(e) { done(reject, e); }
    function onAbort() { done(reject, Object.assign(new Error("REQUEST_ABORTED"), { code: "REQUEST_ABORTED" })); }
    function onClose() { if (!settled) onAbort(); }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAbort);
    req.on("close", onClose);
  });
}

/** 请求体解析失败的统一回应（400/413），流式与非流式共用一套文案 */
function replyBodyError(res, e, bodyLimitMb) {
  const code = String(e && e.code);
  if (code === "PAYLOAD_TOO_LARGE") {
    sendJson(res, 413, { error: { type: "invalid_request_error", message: `请求体超过 ${bodyLimitMb}MB 上限` } });
    return;
  }
  if (code === "REQUEST_ABORTED") {
    // 客户端已断开：回应只是尽力而为，不写成"JSON 非法"以免误导排查
    sendJson(res, 400, { error: { type: "invalid_request_error", message: "请求体传输中断" } });
    return;
  }
  sendJson(res, 400, { error: { type: "invalid_request_error", message: "请求体不是合法 JSON" } });
}

/** 提示词库的**存储层**（惰性 require）：注入只走它自己的公开 API（listItems / getItem），
 *  与提示词库模块读写库的口径完全一致，不另建一套目录约定。
 *  为什么不用 prompts/index.cjs：那个入口只导出 register/boot/shutdown/emit/isRunning，
 *  没有任何"取提示词正文"的接口；而 store.cjs 是提示词库自己的持久化层，稳定且已冻结。
 *  这里仍做惰性 + 兜底：提示词库模块缺失时注入开关退化为不生效，绝不拖垮转发。 */
let promptsStoreCache = null;
function promptsStoreMod() {
  if (promptsStoreCache !== null) return promptsStoreCache || null;
  try { promptsStoreCache = require("../prompts/store.cjs") || false; } catch { promptsStoreCache = false; }
  return promptsStoreCache || null;
}

/** 提示词注入：按配置把提示词库里的**指定条目正文**前置到 messages。
 *  语义（与配置页文案一一对应）：
 *   · injectPrompt=false            → 不注入
 *   · injectPromptName 为空         → 不注入（本仓库没有"active 提示词"这个概念，
 *                                      不做"按 model/channel 自动匹配"的猜测：那等于替用户选提示词）
 *   · injectPromptName 指定了名字   → 从个人库按名字精确取一条，取到才注入
 *  名字不存在、条目为空、提示词库不可用——一律原样返回 body，转发不受任何影响。 */
async function maybeInjectPrompt(body) {
  const c = lgwConfig.get();
  if (!c.injectPrompt) return body;
  const name = String(c.injectPromptName || "").trim();
  if (!name) return body;
  const store = promptsStoreMod();
  if (!store) return body;
  try {
    const listed = store.listItems({ includeTrash: false });
    const items = Array.isArray(listed && listed.items) ? listed.items : [];
    const hit = items.find((it) => it && String(it.name || "").trim() === name);
    if (!hit || !hit.id) return body;
    const full = store.getItem(String(hit.id));
    const text = String((full && full.body) || "").trim();
    if (!text) return body;
    const next = JSON.parse(JSON.stringify(body));
    const msgs = Array.isArray(next.messages) ? next.messages : [];
    // 已有 system 消息时**合并进那一条**，而不是再插一条：
    // 上游对"多条 system"的处理不一致（有的只认第一条、有的报错），合并是唯一到处都安全的形式
    const at = msgs.findIndex((m) => m && m.role === "system");
    if (at >= 0) {
      const cur = typeof msgs[at].content === "string" ? msgs[at].content : "";
      msgs[at] = { ...msgs[at], content: `${text}\n\n${cur}`.trim() };
    } else {
      msgs.unshift({ role: "system", content: text });
    }
    next.messages = msgs;
    return next;
  } catch {
    return body; // 注入失败绝不能影响转发本身
  }
}

/** 对话写入记忆：chatToMemoryEnabled 开启时把请求摘要落进记忆中枢。
 *  【本期明确不接线 · 有意为之，不是遗漏】
 *  能力其实具备（memory/index.cjs 导出了 `get service()`，service.writeMemory() 是公开写入接口），
 *  但**不接**的理由是产品语义而不是技术：
 *    · 网关是高频转发面，一次 API 调用写一条记忆 = 把用户的记忆库变成请求流水账，
 *      而记忆库是「用户资产」（参与 WebDAV 同步、进 FTS 索引、进画像蒸馏），污染代价不可逆；
 *    · writeMemory 在多条合法路径上会返回 { ok:false }（索引只读模式 / 隐私模式暂停 / 内容为空），
 *      静默失败时用户既拿不到记忆也看不到原因，等于把开关做成"看起来生效"的假象；
 *    · 记忆内容策略（写哪一条消息、写多少、要不要脱敏后写）没有方案层面的定论，
 *      替用户拍板一个策略，比不接线更危险。
 *  因此：开关与调用点保留（schema 稳定，将来定策略后可直接接），
 *  但配置页**不再展示这个开关**，改为一行"本期未接线"的说明（见 ConfigLocalgwSection.vue
 *  的「未接线能力」区块）——让用户看到事实，而不是一个点了没反应的开关。
 *  本函数保留为唯一落点：将来接线时只改这里，调用方不动。 */
async function maybeWriteToMemory(body, channel, model, status) {
  const c = lgwConfig.get();
  if (!c.chatToMemoryEnabled) return;
  if (!memory) return;
  try {
    if (typeof memory.writeChat !== "function") return;
    const userMsg = (body.messages || []).filter((m) => m && m.role === "user").pop();
    if (!userMsg) return;
    // content 可能是字符串，也可能是 OpenAI 多模态数组：非文本形态不写，避免落进 "[object Object]"
    const rawContent = userMsg.content;
    const prompt = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join("")
        : "";
    if (!prompt) return;
    await memory.writeChat({
      channel,
      model,
      prompt: prompt.slice(0, 2000),
      status,
      ts: Date.now(),
    });
  } catch { /* 静默 */ }
}

/** Anthropic /v1/messages 转 OpenAI chat/completions 的字段映射
 *  按 proxy/protocols/anthropic-in.cjs 的共识字段（system / messages[content array] / max_tokens / temperature）
 *  本模块只做协议入向翻译；响应由 anthropic-out 包装完成 */
function anthropicRequestToOpenai(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.messages)) return body;
  const out = {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: !!body.stream,
    messages: [],
  };
  if (body.system) {
    out.messages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  }
  for (const m of body.messages) {
    if (!m || !m.role) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      out.messages.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      // 合并 text 块；image 块按 OpenAI 多模态格式映射
      const textParts = [];
      const imageParts = [];
      for (const part of content) {
        if (!part) continue;
        if (part.type === "text" && part.text) textParts.push({ type: "text", text: part.text });
        else if (part.type === "image" && (part.source || part.image)) {
          const src = part.source || part.image;
          if (src && src.type === "base64" && src.data) {
            const mime = src.media_type || "image/jpeg";
            imageParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${src.data}` } });
          }
        }
      }
      // 按 OpenAI 风格组装：text + image_url 数组
      const contentParts = [];
      if (textParts.length) contentParts.push({ type: "text", text: textParts.map((t) => t.text).join("\n") });
      for (const img of imageParts) contentParts.push(img);
      out.messages.push({ role, content: contentParts.length ? contentParts : "" });
      continue;
    }
    out.messages.push({ role, content: String(content || "") });
  }
  // tool 调用翻译：Anthropic tools → OpenAI tools
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
      },
    }));
    if (body.tool_choice) {
      // Anthropic tool_choice: {type:'auto'|'any'|'tool', name?}  → OpenAI
      const tc = body.tool_choice;
      if (tc.type === "auto") out.tool_choice = "auto";
      else if (tc.type === "any") out.tool_choice = "required";
      else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }
  return out;
}

/** 转换 OpenAI 流式 chunk → Anthropic SSE 事件 */
function openaiEventToAnthropic(ev, state) {
  // state: { started, sentInputTokens, sentContentBlockStart }
  const out = [];
  if (!state.started) {
    state.started = true;
    out.push({
      event: "message_start",
      data: {
        type: "message",
        id: `msg_${Date.now().toString(36)}`,
        role: "assistant",
        model: state.model,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    out.push({ event: "ping", data: { type: "ping" } });
  }
  if (!ev) return out;
  if (ev.type === "delta" && ev.delta) {
    const d = ev.delta;
    if (d.content) {
      if (!state.sentContentBlockStart) {
        state.sentContentBlockStart = true;
        out.push({ event: "content_block_start", data: { type: "text", index: 0, text: "" } });
      }
      out.push({ event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: d.content } } });
    }
    if (d.tool_calls) {
      // 工具调用：Anthropic 用 content_block + input_json_delta
      for (const tc of d.tool_calls) {
        if (tc.id && !state.toolIdxMap) state.toolIdxMap = {};
        // 简化：只允许一个工具调用；多工具时需按 index 把每个 tool 映射到独立 content_block
        const idx = tc.index || 0;
        if (tc.function && tc.function.name) {
          if (!state.toolIdxMap[idx]) {
            state.toolIdxMap[idx] = { name: tc.function.name, argsJson: "" };
            out.push({
              event: "content_block_start",
              data: { type: "tool_use", index: idx + 1, id: tc.id || `toolu_${Date.now().toString(36)}_${idx}`, name: tc.function.name, input: {} },
            });
          }
        }
        if (tc.function && tc.function.arguments) {
          state.toolIdxMap[idx].argsJson += tc.function.arguments;
          out.push({
            event: "content_block_delta",
            data: { index: idx + 1, delta: { type: "input_json_delta", partial_json: tc.function.arguments } },
          });
        }
      }
    }
  }
  if (ev.type === "usage" && ev.usage) {
    const u = ev.usage;
    state.sentInputTokens = u.input_tokens || u.prompt_tokens || 0;
    state.sentOutputTokens = u.output_tokens || u.completion_tokens || 0;
  }
  if (ev.type === "finish") {
    // message_delta + message_stop
    out.push({
      event: "message_delta",
      data: {
        delta: { stop_reason: ev.reason || "end_turn", stop_sequence: null },
        usage: { output_tokens: state.sentOutputTokens || 0 },
      },
    });
  }
  if (ev.type === "error") {
    out.push({
      event: "error",
      data: { type: "error", error: { type: "api_error", message: ev.message || "upstream error" } },
    });
  }
  return out;
}

/** 从事件流里取 token 用量（最后一次 usage 事件为准；无 usage 时回 0）
 *  dir: "in" → prompt_tokens / input_tokens；"out" → completion_tokens / output_tokens */
function aggregatedUsage(events, dir) {
  const list = Array.isArray(events) ? events : [];
  let inTok = 0;
  let outTok = 0;
  for (const ev of list) {
    if (!ev || ev.type !== "usage" || !ev.usage) continue;
    const u = ev.usage;
    inTok = Number(u.prompt_tokens || u.input_tokens || 0) || 0;
    outTok = Number(u.completion_tokens || u.output_tokens || 0) || 0;
  }
  return dir === "in" ? inTok : outTok;
}

/** 把 OpenAI 事件流聚合成非流式 chat.completion 响应体。
 *  【审查修正·P0】本函数与 aggregatedUsage 在审查前**只有调用、没有定义**——
 *  每一次请求走到落账行都会抛 ReferenceError（流式与非流式都躲不过），
 *  表现为"请求把上游跑完了，客户端却拿不到任何响应"。此处补齐实现。
 *  对 undefined / 非数组 / 空数组一律返回结构完整的空补全，绝不抛错。 */
function aggregateOpenaiEvents(events, model) {
  const list = Array.isArray(events) ? events : [];
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  const toolSlots = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "delta" && ev.delta && typeof ev.delta === "object") {
      const d = ev.delta;
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (!tc) continue;
          const idx = Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : toolSlots.length;
          if (!toolSlots[idx]) {
            toolSlots[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
          }
          const slot = toolSlots[idx];
          if (tc.id) slot.id = String(tc.id);
          if (tc.function) {
            if (tc.function.name) slot.function.name = String(tc.function.name);
            if (typeof tc.function.arguments === "string") slot.function.arguments += tc.function.arguments;
          }
        }
      }
    } else if (ev.type === "usage" && ev.usage && typeof ev.usage === "object") {
      const u = ev.usage;
      const p = Number(u.prompt_tokens || u.input_tokens || 0) || 0;
      const c = Number(u.completion_tokens || u.output_tokens || 0) || 0;
      const t = Number(u.total_tokens || 0) || p + c;
      usage = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
    } else if (ev.type === "finish") {
      if (ev.reason) finishReason = String(ev.reason);
    }
  }

  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = toolSlots.filter(Boolean);
  if (toolCalls.length) {
    // 上游没给 id 时补一个（OpenAI 客户端按 id 关联后续 tool 结果，缺 id 会被部分客户端拒）
    for (let i = 0; i < toolCalls.length; i++) {
      if (!toolCalls[i].id) toolCalls[i].id = `call_${Date.now().toString(36)}_${i}`;
    }
    message.tool_calls = toolCalls;
    finishReason = finishReason === "stop" ? "tool_calls" : finishReason;
  }

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

/** 处理 OpenAI /v1/chat/completions */
async function handleChat(req, res, ctx) {
  const t0 = Date.now();
  const c = lgwConfig.get();
  let body;
  try {
    const raw = await readBody(req, c.bodyLimitMb);
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    replyBodyError(res, e, c.bodyLimitMb);
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(res, 400, { error: { message: "请求体必须是 JSON 对象" } }); return; }
  if (!Array.isArray(body.messages)) { sendJson(res, 400, { error: { message: "缺少 messages 字段" } }); return; }

  body = await maybeInjectPrompt(body);

  const model = String(body.model || "").trim();
  if (!model) { sendJson(res, 400, { error: { message: "缺少 model 字段" } }); return; }

  // Key scopes 校验：key 授权范围内的渠道才允许被路由（"*" = 全部）
  const allowedChannels = ctx.isApiKey && Array.isArray(ctx.key && ctx.key.scopes) && ctx.key.scopes.length && !ctx.key.scopes.includes("*")
    ? new Set(ctx.key.scopes)
    : null;

  try { await concurrencyGuard.acquire(c.queueTimeoutMs); }
  catch { sendJson(res, 429, { error: { message: "网关繁忙，请稍后重试" } }); return; }
  if (ctx.isApiKey) {
    const rl = checkRateLimit(ctx.key);
    if (!rl.ok) { concurrencyGuard.release(); sendJson(res, rl.status, { error: { message: rl.message } }); return; }
  }

  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) { try { ac.abort(); } catch { /* 已结束 */ } } });

  const isStream = !!body.stream;
  if (isStream) sendSseHeaders(res);

  const emit = (ev) => {
    if (res.writableEnded || !isStream) return;
    if (ev.type === "delta") {
      sendSseFrame(res, { id: `chatcmpl-${ctx.requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: ev.delta || {}, finish_reason: null }] });
    } else if (ev.type === "usage") {
      const u = ev.usage || {};
      if (body.stream_options === undefined || body.stream_options.include_usage !== false) {
        sendSseFrame(res, { id: `chatcmpl-${ctx.requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: u.prompt_tokens || u.input_tokens || 0, completion_tokens: u.completion_tokens || u.output_tokens || 0, total_tokens: (u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0) } });
      }
    } else if (ev.type === "finish") {
      sendSseFrame(res, { id: `chatcmpl-${ctx.requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: ev.reason || "stop" }] });
    } else if (ev.type === "error") {
      sendSseFrame(res, { error: { message: ev.message || "upstream error" } });
    }
  };

  const triedExcluded = new Set();
  const failoverEnabled = c.routing.failover !== false;
  const maxAttempts = failoverEnabled ? Math.max(1, Math.min(8, c.routing.maxRetriesPerRequest || 3)) : 1;
  let channelUsed = "";
  let forwardResult = null;

  // 每 key 并发闸门：紧跟全局闸门之后申请（全局已占住，这里失败要把它还回去），
  // 释放与全局闸门同放在 finally —— 两条路径任一抛错都不会把槽位漏掉
  const slot = acquireKeySlot(ctx.key);
  if (!slot.ok) {
    concurrencyGuard.release();
    sendJson(res, 429, { error: { message: `超过该密钥的并发上限（${slot.limit}）` } });
    return;
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ch = routing.pick(model, [...triedExcluded]);
      if (!ch) break;
      if (allowedChannels && !allowedChannels.has(ch)) { triedExcluded.add(ch); continue; }
      triedExcluded.add(ch);
      channelUsed = ch;
      const resolved = models.resolve(model) || { channel: ch, realModel: model };
      const realModel = resolved.realModel || model;
      channelUsed = resolved.channel || ch;
      const fwdCtx = { requestId: ctx.requestId, apiKeyId: ctx.apiKeyId, apiKeyPrefix: ctx.apiKeyPrefix, isApiKey: ctx.isApiKey, key: ctx.key, humanizeJitter: ctx.humanizeJitter };
      forwardResult = await forwarder.forward({ ...body, model: realModel }, channelUsed, realModel, model, fwdCtx, c.requestTimeoutMs, emit, ac.signal);
      if (forwardResult && forwardResult.ok) break;
      if (classifyForwardError(forwardResult)) break;
      routing.markFailed(channelUsed);
    }
  } catch (e) {
    // forwarder 已自行吞掉适配层异常；能走到这里的是本层的意外错误。
    // 必须兜住：否则并发闸门永久少一格，且 dispatch 的 catch 只能回一个 500。
    forwardResult = { ok: false, status: 502, error: String((e && e.message) || e), errCode: "server_exception", events: [] };
  } finally {
    slot.release();
    concurrencyGuard.release();
  }
  const ms = Date.now() - t0;

  if (!channelUsed && !forwardResult) { sendJson(res, 503, { error: { message: allowedChannels ? "当前没有授权渠道可用（超出 key 的 scopes）" : "当前没有可用渠道（所有渠道冷却中或未启用）" } }); return; }

  const ok = !!(forwardResult && forwardResult.ok);
  const events = forwardResult && forwardResult.events;
  // 成功即解除本渠道冷却并清零连续失败计数（markSucceeded 原先只导出、从未被调用，
  // 导致 failCount 只增不减：偶发失败几次后退避会一路涨到 cooldownCapMs）
  if (ok && channelUsed) routing.markSucceeded(channelUsed);

  if (isStream) {
    if (!res.writableEnded) {
      // 失败也要给客户端一个 SSE error 帧：否则流"干净地"结束，调用方以为成功但内容是空的
      if (!ok) sendSseFrame(res, { error: { message: (forwardResult && forwardResult.error) || "上游错误", code: (forwardResult && forwardResult.errCode) || "upstream_error" } });
      else sendSseDone(res);
      res.end();
    }
  } else {
    const aggregated = aggregateOpenaiEvents(events, model);
    if (ok) sendJson(res, 200, aggregated);
    else sendJson(res, (forwardResult && forwardResult.status) || 502, { error: { message: (forwardResult && forwardResult.error) || "上游错误", type: "upstream_error", code: (forwardResult && forwardResult.errCode) || "upstream_error" } });
  }

  oplog.insert({ ts: Date.now(), apiKeyPrefix: ctx.apiKeyPrefix, channel: channelUsed, model, status: ok ? "success" : "error", ms, promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out"), errCode: forwardResult && forwardResult.errCode, sensitiveHits: (forwardResult && forwardResult.outboundHits) || "" });
  if (ok) usagehook.afterRequest({ apiKeyId: ctx.apiKeyId, channel: channelUsed, model, ms, promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out") });
  await maybeWriteToMemory(body, channelUsed, model, ok ? "success" : "error");
}

/** 推断 forward 失败分类：返回非空表示**不再转移**（致命/参数错），返回 null 表示可换渠道重试。
 *  · bad_params  请求本身不合法，换渠道也一样失败
 *  · model_blocked 模型被上游封禁/不存在，换渠道也是白打
 *  · fatal/cancelled/timeout 致命或客户端已断，没有再试的意义
 *  注意：no_adapter / no_token / no_account 属于"本渠道不可用"，必须继续 failover——
 *  原实现把它们归成 not_found 直接 break，等于一个没账号的渠道就把整次请求判死。 */
function classifyForwardError(r) {
  if (!r || r.ok) return null;
  const msg = String(r.error || "");
  const code = String(r.errCode || "");
  if (/PAYLOAD_TOO_LARGE|bodyLimit|缺少|model 字段|messages/i.test(msg)) return "bad_params";
  if (/model.*(blocked|not.*found|unknown|unsupported)/i.test(msg) || code === "model_blocked" || code === "model_config") return "model_blocked";
  if (code === "fatal" || code === "cancelled" || code === "timeout") return "fatal";
  return null;
}

/** 处理 Anthropic /v1/messages
 *  【审查删除说明】此处原本还有一份重复的 handleMessages 定义（.then 风格、无 key scopes 校验、
 *  无故障转移、emit 未判 isStream 会把 SSE 帧写进非流式响应体，且 catch 里无条件 release 并发闸门）。
 *  它被下方同名函数整体覆盖（JS 顶层同名函数声明后者胜出），属纯死代码，已删除只留唯一实现。 */
async function handleMessages(req, res, ctx) {
  const t0 = Date.now();
  const c = lgwConfig.get();
  let body;
  try {
    const raw = await readBody(req, c.bodyLimitMb);
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    replyBodyError(res, e, c.bodyLimitMb);
    return;
  }
  body = anthropicRequestToOpenai(body);
  if (!body || typeof body !== "object" || !Array.isArray(body.messages) || !body.messages.length) {
    sendJson(res, 400, { error: { type: "invalid_request_error", message: "缺少 messages 字段（Anthropic 协议要求非空数组）" } });
    return;
  }
  // 出站指纹脱敏已下沉到 forwarder（渠道在 failover 循环里才确定，见 §4.7 修订）；
  // 本层只把 forwarder 带回的命中摘要落进请求日志

  const model = String(body.model || "").trim();
  if (!model) { sendJson(res, 400, { error: { type: "invalid_request_error", message: "缺少 model 字段" } }); return; }

  const allowedChannels = ctx.isApiKey && Array.isArray(ctx.key && ctx.key.scopes) && ctx.key.scopes.length && !ctx.key.scopes.includes("*")
    ? new Set(ctx.key.scopes)
    : null;

  try { await concurrencyGuard.acquire(c.queueTimeoutMs); }
  catch { sendJson(res, 429, { error: { type: "rate_limit_error", message: "网关繁忙" } }); return; }
  if (ctx.isApiKey) {
    const rl = checkRateLimit(ctx.key);
    if (!rl.ok) { concurrencyGuard.release(); sendJson(res, 429, { error: { type: "rate_limit_error", message: rl.message } }); return; }
  }

  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) { try { ac.abort(); } catch { /* 已结束 */ } } });

  const isStream = !!body.stream;
  if (isStream) sendSseHeaders(res);

  const st = { started: false, model, toolIdxMap: null, sentInputTokens: 0, sentOutputTokens: 0 };
  const emit = (ev) => {
    if (res.writableEnded || !isStream) return;
    const frames = openaiEventToAnthropic(ev, st);
    for (const f of frames) {
      try { res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`); } catch { /* 已断 */ }
    }
    if (ev.type === "finish") {
      try {
        res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      } catch { /* 已断 */ }
    }
  };

  const triedExcluded = new Set();
  const failoverEnabled = c.routing.failover !== false;
  const maxAttempts = failoverEnabled ? Math.max(1, Math.min(8, c.routing.maxRetriesPerRequest || 3)) : 1;
  let channelUsed = "";
  let forwardResult = null;

  // 每 key 并发闸门：与 OpenAI 路径同款（全局闸门已占住，失败要还回去）
  const slot = acquireKeySlot(ctx.key);
  if (!slot.ok) {
    concurrencyGuard.release();
    sendJson(res, 429, { error: { type: "rate_limit_error", message: `超过该密钥的并发上限（${slot.limit}）` } });
    return;
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ch = routing.pick(model, [...triedExcluded]);
      if (!ch) break;
      if (allowedChannels && !allowedChannels.has(ch)) { triedExcluded.add(ch); continue; }
      triedExcluded.add(ch);
      channelUsed = ch;
      const resolved = models.resolve(model) || { channel: ch, realModel: model };
      const realModel = resolved.realModel || model;
      channelUsed = resolved.channel || ch;
      const fwdCtx = { requestId: ctx.requestId, apiKeyId: ctx.apiKeyId, apiKeyPrefix: ctx.apiKeyPrefix, isApiKey: ctx.isApiKey, key: ctx.key, humanizeJitter: ctx.humanizeJitter };
      forwardResult = await forwarder.forward({ ...body, model: realModel }, channelUsed, realModel, model, fwdCtx, c.requestTimeoutMs, emit, ac.signal);
      if (forwardResult && forwardResult.ok) break;
      if (classifyForwardError(forwardResult)) break;
      routing.markFailed(channelUsed);
    }
  } catch (e) {
    forwardResult = { ok: false, status: 502, error: String((e && e.message) || e), errCode: "server_exception", events: [] };
  } finally {
    slot.release();
    concurrencyGuard.release();
  }
  const ms = Date.now() - t0;

  if (!channelUsed && !forwardResult) { sendJson(res, 503, { error: { type: "overloaded_error", message: allowedChannels ? "当前没有授权渠道可用（超出 key 的 scopes）" : "当前没有可用渠道" } }); return; }

  const ok = !!(forwardResult && forwardResult.ok);
  const events = forwardResult && forwardResult.events;
  if (ok && channelUsed) routing.markSucceeded(channelUsed);

  if (isStream) {
    if (!res.writableEnded) {
      // 失败补一个 Anthropic 规范的 error 事件：否则客户端只看到流被截断，无法区分"空回复"与"上游失败"
      if (!ok) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: (forwardResult && forwardResult.error) || "上游错误" } })}\n\n`);
        } catch { /* 已断 */ }
      }
      res.end();
    }
  } else {
    const agg = aggregateOpenaiEvents(events, model);
    const firstTool = agg.choices && agg.choices[0] && agg.choices[0].message && agg.choices[0].message.tool_calls && agg.choices[0].message.tool_calls[0];
    let toolInput = {};
    if (firstTool) {
      // 上游可能给出被截断的 arguments（如 '{"a":'），JSON.parse 会抛——不能让它变成 500
      try { toolInput = JSON.parse(firstTool.function.arguments || "{}"); } catch { toolInput = { _raw: String(firstTool.function.arguments || "") }; }
    }
    const anthropicResp = {
      id: `msg_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model,
      content: firstTool
        ? [{ type: "tool_use", id: firstTool.id, name: firstTool.function.name, input: toolInput }]
        : [{ type: "text", text: (agg.choices && agg.choices[0] && agg.choices[0].message && agg.choices[0].message.content) || "" }],
      stop_reason: firstTool ? "tool_use" : ((agg.choices && agg.choices[0] && agg.choices[0].finish_reason) || "end_turn"),
      usage: { input_tokens: (agg.usage && agg.usage.prompt_tokens) || 0, output_tokens: (agg.usage && agg.usage.completion_tokens) || 0 },
    };
    if (ok) sendJson(res, 200, anthropicResp);
    else sendJson(res, (forwardResult && forwardResult.status) || 502, { error: { type: "api_error", message: (forwardResult && forwardResult.error) || "上游错误" } });
  }

  oplog.insert({ ts: Date.now(), apiKeyPrefix: ctx.apiKeyPrefix, channel: channelUsed, model, status: ok ? "success" : "error", ms, promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out"), errCode: forwardResult && forwardResult.errCode, sensitiveHits: (forwardResult && forwardResult.outboundHits) || "" });
  if (ok) usagehook.afterRequest({ apiKeyId: ctx.apiKeyId, channel: channelUsed, model, ms, promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out") });
  await maybeWriteToMemory(body, channelUsed, model, ok ? "success" : "error");
}

/** 处理 OpenAI /v1/models */
function handleModels(req, res) {
  const c = lgwConfig.get();
  if (!c.models.exposeInV1Models) {
    sendJson(res, 200, { object: "list", data: [] });
    return;
  }
  const rows = models.list().map((m) => ({
    id: m.display,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.channel,
  }));
  sendJson(res, 200, { object: "list", data: rows });
}

/** 处理 Anthropic /v1/models
 *  Anthropic 没有 /v1/models 端点；本模块返回空目录即可（不影响 Claude Code 等客户端） */
function handleAnthropicModels(req, res) {
  sendJson(res, 200, { data: [] });
}

/** 主请求分发 */
async function dispatch(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, { error: { message: "非法请求 URL" } });
    return;
  }
  const path = url.pathname;
  const method = req.method || "GET";

  // 探活：不需要鉴权
  if (path === "/health" && method === "GET") {
    sendJson(res, 200, { ok: true, running: state.running, port: state.port || lgwConfig.get().port, uptimeSec: state.running ? Math.floor((Date.now() - state.startedAt) / 1000) : 0 });
    return;
  }

  // CORS 预检：先放行再结束（浏览器只认预检响应里的 Allow-* 头）
  if (method === "OPTIONS") {
    applyCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // CORS 头必须在鉴权之前挂上：否则 401/403 响应不带 Allow-Origin，
  // 浏览器里只能看到"网络错误"，看不到我们精心写的"密钥已吊销"。
  applyCors(req, res);

  // 鉴权（/v1/* 都需要；Authorization: Bearer 与 Anthropic 的 x-api-key 都支持）
  if (!path.startsWith("/v1/")) {
    sendJson(res, 404, { error: { message: "Not Found" } });
    return;
  }
  const auth = authenticate(req);
  if (!auth.ok) {
    sendJson(res, auth.status || 401, { error: { message: auth.message } });
    return;
  }
  // readonly 令牌只能读（GET）：它存在的意义是给监控/健康检查用，
  // 原实现允许它 POST /v1/chat/completions 消耗账号额度，属于权限越界。
  if (auth.kind === "readonly" && method !== "GET") {
    sendJson(res, 403, { error: { message: "只读令牌不允许写操作（仅支持 GET）" } });
    return;
  }

  // 上下文
  const crypto2 = require("node:crypto");
  const ctx = {
    requestId: crypto2.randomUUID().slice(0, 8),
    apiKeyId: auth.kind === "apikey" ? auth.key.id : null,
    apiKeyPrefix: auth.kind === "apikey" ? auth.key.keyPrefix : `[${auth.kind}]`,
    isApiKey: auth.kind === "apikey",
    isAdmin: auth.kind === "admin",
    isReadonly: auth.kind === "readonly",
    humanizeJitter: lgwConfig.get().humanizeJitter,
    key: auth.kind === "apikey" ? auth.key : null,
  };

  // 注意：这里必须 **return** 处理器返回的 Promise。
  // dispatch 自己不 await 的话，处理器内部的 rejected promise 会逃出
  // http server 回调上的 .catch()，变成 unhandledRejection（主进程可能直接退出）。
  if (path === "/v1/chat/completions" && method === "POST") {
    return handleChat(req, res, ctx);
  }
  if (path === "/v1/models" && method === "GET") {
    return handleModels(req, res);
  }
  if (path === "/v1/messages" && method === "POST") {
    return handleMessages(req, res, ctx);
  }
  if (path === "/v1/anthropic/models" && method === "GET") {
    return handleAnthropicModels(req, res);
  }
  // 方法不匹配 vs 路径不存在分开报：前者 405 更贴近 HTTP 语义，也方便调用方排查
  const KNOWN = { "/v1/chat/completions": "POST", "/v1/messages": "POST", "/v1/models": "GET", "/v1/anthropic/models": "GET" };
  if (KNOWN[path]) {
    sendJson(res, 405, { error: { message: `方法不允许：${path} 只支持 ${KNOWN[path]}` } });
    return;
  }
  sendJson(res, 404, { error: { message: `未知端点：${method} ${path}` } });
}

function isPortFree(bind, port) {
  return new Promise((resolve) => {
    const s = http.createServer();
    // 探测用的临时 server 无论成功失败都必须关掉：出错时不 close 会留下一个已绑定的句柄
    const done = (v) => { try { s.close(() => resolve(v)); } catch { resolve(v); } };
    s.once("error", () => { try { s.close(); } catch { /* 未监听 */ } resolve(false); });
    s.once("listening", () => done(true));
    try {
      s.listen(port, bind);
    } catch {
      resolve(false);
    }
  });
}

/** 在途 start 的共享 Promise：boot() 与 IPC start 可能同时到达，
 *  没有它两次调用会各自走一遍端口探测（第二次 listen 撞 EADDRINUSE 报假失败）。 */
let startingPromise = null;

async function start() {
  if (state.running) return { ok: true, port: state.port, bind: state.bind };
  if (startingPromise) return startingPromise;
  startingPromise = doStart().finally(() => { startingPromise = null; });
  return startingPromise;
}

async function doStart() {
  const c = lgwConfig.get();
  const bind = c.bind || "127.0.0.1";

  // 端口候选：config.port 已在 normalize 里置顶到 portCandidates[0]，
  // 这里再兜一层空数组（手改 config 把 portCandidates 清空时不能直接崩在 join 上）
  const candidates = Array.isArray(c.portCandidates) && c.portCandidates.length ? c.portCandidates : [c.port];
  let port = 0;
  for (const candidate of candidates) {
    if (await isPortFree(bind, candidate)) {
      port = candidate;
      break;
    }
  }
  if (!port) {
    return { ok: false, message: `候选端口 ${candidates.join("/")} 全被占用` };
  }

  concurrencyGuard.max = Math.max(1, Number(c.concurrency) || 16);

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch((e) => {
      if (!res.writableEnded) sendJson(res, 500, { error: { message: String((e && e.message) || e) } });
    });
  });
  // 客户端 keep-alive 长连接不应阻止 stop()：closeAllConnections 在 stop 里统一收
  server.keepAliveTimeout = 65000;

  return new Promise((resolve) => {
    server.once("error", (e) => {
      // 探测与实际 listen 之间有竞态（端口被别人抢走）：必须关掉 server 再回报，
      // 否则这个未监听的 server 对象会挂着 error 监听器泄漏
      try { server.close(); } catch { /* 未监听 */ }
      resolve({ ok: false, message: String((e && e.message) || e) });
    });
    server.listen(port, bind, () => {
      state.server = server;
      state.running = true;
      state.port = port;
      state.bind = bind;
      state.startedAt = Date.now();
      if (gcTimer) clearInterval(gcTimer);
      gcTimer = setInterval(() => { try { oplog.gc(); } catch { /* GC 失败不影响服务 */ } }, 24 * 3600 * 1000);
      if (gcTimer.unref) gcTimer.unref();
      resolve({ ok: true, port, bind });
    });
  });
}

let gcTimer = null;

function stop() {
  // 定时器与状态先收：无论 server 是否在跑，stop 之后都不能再有 gc 定时器存活
  if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
  const srv = state.server;
  state.server = null;
  state.running = false;
  state.port = 0;
  state.bind = "";
  state.startedAt = 0;
  if (!srv) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      srv.close(() => finish({ ok: true }));
      // 只关空闲连接不够：SSE 长连接会一直占着，close 回调永远不来（表现为"停止按钮点了没反应"）
      if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
      else if (typeof srv.closeIdleConnections === "function") srv.closeIdleConnections();
      // 兜底：极少数情况下 close 回调不触发，5s 后也要让 IPC 返回，不能把渲染层吊死
      const t = setTimeout(() => finish({ ok: true, message: "close 回调超时，已强制返回" }), 5000);
      if (t.unref) t.unref();
    } catch (e) {
      finish({ ok: false, message: String((e && e.message) || e) });
    }
  });
}

function status() {
  let totals = { todayReq: 0, todayTokens: 0, errCount: 0 };
  try { totals = oplog.todayTotals() || totals; } catch { /* 库不可用时状态查询仍要能返回 */ }
  let activeChannels = 0;
  try { activeChannels = routing.activeCount(); } catch { /* 号池不可用 */ }
  return {
    running: state.running,
    port: state.port || lgwConfig.get().port,
    bind: state.bind || lgwConfig.get().bind,
    // 未运行时没有 pid 可言：前端契约是 number|null，返回进程 pid 会让"已停止"看起来仍在跑
    pid: state.running ? process.pid : null,
    uptimeSec: state.running ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
    todayReq: totals.todayReq,
    todayTokens: totals.todayTokens,
    errRate: totals.todayReq ? totals.errCount / totals.todayReq : 0,
    activeChannels,
    validKeys: keysStore.countActive(),
  };
}

module.exports = { start, stop, status, state, isPortFree };
