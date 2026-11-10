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
// 本地网关 HTTP 入口。
"use strict";
const http = require("node:http");
const lgwConfig = require("./config.cjs");
const keysStore = require("./keys-store.cjs");
const routing = require("./routing.cjs");
const models = require("./models.cjs");
const oplog = require("./oplog.cjs");
const usagehook = require("./usagehook.cjs");
const forwarder = require("./forwarder.cjs");
const services = require("./services.cjs");
const { waitForDrain } = require("./output-drain.cjs");
const { createAttemptLedger } = require("../extensions/attempt-ledger.cjs");
const memory = (() => { try { return require("../memory/index.cjs"); } catch { return null; } })();

const { Gate, BodyQueue } = require("./admission.cjs");
const concurrencyGuard = new Gate();
const bodyQueue = new BodyQueue();
const requests = require("./requests.cjs");
const openaiOut = require("./protocols/openai-out.cjs");
const anthropicOut = require("./protocols/anthropic-out.cjs");
const anthropicIn = require("./protocols/anthropic-in.cjs");
const responsesIn = require("./protocols/responses-in.cjs");
const responsesOut = require("./protocols/responses-out.cjs");
const protocolUtil = require("../proxy/util.cjs");

/** 运行状态 */
const state = {
  server: null,
  running: false,
  port: 0,
  bind: "",
  startedAt: 0,
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
  // 口径：吊销已改为「停用」（可再启用）/「删除」（不可逆），401 文案统一成「已停用」
  const reason = r.reason === "disabled" || r.reason === "revoked" ? "密钥已停用" : r.reason === "expired" ? "密钥已过期" : "无效密钥";
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

/** 指纹脱敏：私有渠道头由外部插件按其签名授权处理；本地网关只传递宿主允许的
 * 受限材料，不在主仓复制渠道名单或私有协议。 */

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
function readBody(req, maxMb, signal) {
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
      signal?.removeEventListener("abort", onSignalAbort);
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
    function onSignalAbort() { done(reject, Object.assign(new Error("请求已取消"), { status: 499 })); }
    if (signal?.aborted) { onSignalAbort(); return; }
    signal?.addEventListener("abort", onSignalAbort, { once: true });
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

function aggregatedUsage(events, direction) {
  const usage = (events || []).findLast((ev) => ev.type === "usage")?.usage;
  if (!usage) return 0;
  return Math.max(0, Number(direction === "in" ? usage.prompt_tokens ?? usage.input_tokens : usage.completion_tokens ?? usage.output_tokens) || 0);
}

async function handleCompletion(req, res, ctx, protocol) {
  const t0 = Date.now();
  const c = lgwConfig.get();
  const ac = new AbortController();
  const close = () => { if (!res.writableEnded) ac.abort(new Error("客户端已断开")); };
  res.once("close", close);
  let releaseBody, releaseGlobal, slot, deadline, heartbeat, releaseAuthority, attemptLedger;
  let body, sink, channelUsed = "", forwardResult;
  const attempts = [];
  let requestState, authorizedChannels;
  try {
    requestState = requests.begin(ctx.requestId, ac, ctx.apiKeyPrefix);
    releaseAuthority = watchKey(ctx, ac, () => requestState.channel ? [requestState.channel] : authorizedChannels);
    const raw = await readBody(req, c.bodyLimitMb, ac.signal);
    try { body = JSON.parse(raw.toString("utf8") || "{}"); }
    catch { sendJson(res, 400, { error: { message: "请求体不是有效 JSON" } }); return; }
    if (protocol === "anthropic" || protocol === "responses") {
      const converted = (protocol === "anthropic" ? anthropicIn : responsesIn).toInternal(body);
      if (!converted.ok) { sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: converted.message } }); return; }
      body = converted.body;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) || !body.messages.length) {
      sendJson(res, 400, { error: { message: "messages 必须为非空数组" } }); return;
    }
    const invalid = protocolUtil.validateChatBody(body);
    if (invalid) { sendJson(res, 400, { error: { message: invalid } }); return; }
    body = await maybeInjectPrompt(body);
    requestState.model = String(body.model || "");
    requestState.phase = "排队";
    const model = String(body.model || "").trim();
    if (!model) { sendJson(res, 400, { error: { message: "缺少 model 字段" } }); return; }
    const allowed = ctx.isApiKey && ctx.key?.scopes?.length && !ctx.key.scopes.includes("*") ? new Set(ctx.key.scopes) : null;
    const authorizeChannel = catalogAuthorization(ctx);
    const snapshot = await models.prepare({ ...catalogContext(ctx, authorizeChannel), signal: ac.signal });
    const declared = models.bindings(model, new Set(), snapshot).filter((m) => !allowed || allowed.has(m.channel));
    // 模型组先解析：组存在但成员渠道全被关闭时 declared 是空数组，错误文案要说清是「组没有可用成员」
    const group = models.groupSpec(model, snapshot);
    if (!declared.length) {
      if (group && !allowed) {
        sendJson(res, 503, { error: { message: `模型组「${model}」当前没有可用成员（渠道被关闭或执行来源未打开）`, code: "MODEL_GROUP_EMPTY" } });
        return;
      }
      sendJson(res, allowed ? 403 : 404, { error: { message: allowed ? "模型没有已授权的渠道绑定" : "模型未配置或已关闭" } });
      return;
    }
    const bindings = [];
    for (const binding of declared) {
      if (binding.unavailable) continue;
      try {
        const captured = services.check(binding.channel, () => authorizeChannel(binding.channel));
        bindings.push({ ...binding, serviceRef: captured.ref });
      } catch { /* Unavailable sources must not reach routing/account selection. */ }
    }
    if (!bindings.length) {
      sendJson(res, 503, { error: { message: group
        ? `模型组「${model}」的成员渠道当前都不可执行（执行插件未启用、未就绪或未打开该渠道）`
        : "执行插件未启用、未就绪或未打开该渠道", code: "FORWARD_PLUGIN_UNAVAILABLE" } });
      return;
    }
    // 组成员按「渠道 + 实际模型」逐个选：同一渠道可以挂多个成员，渠道级 pick 会永远只命中第一条。
    const groupRows = group ? bindings.filter((m) => m.groupName) : [];
    const groupMode = groupRows.length > 0;
    // While queued, loss of every candidate channel cancels the waiter. Once an
    // attempt starts, revocation is scoped to that attempt's actual channel.
    authorizedChannels = bindings.map(binding => binding.channel);
    if (ctx.isApiKey) {
      const rl = checkRateLimit(ctx.key);
      if (!rl.ok) { sendJson(res, rl.status, { error: { message: rl.message } }); return; }
    }
    slot = acquireKeySlot(ctx.key);
    if (!slot.ok) { sendJson(res, 429, { error: { message: `超过该密钥的并发上限（${slot.limit}）` } }); return; }
    const bodyKey = require("node:crypto").createHash("sha256").update(JSON.stringify(body)).digest("hex");
    releaseBody = await bodyQueue.acquire(`${ctx.apiKeyId || ctx.apiKeyPrefix}:${protocol}:${bodyKey}`, c.dedupeWaitMs, ac.signal);
    concurrencyGuard.max = c.concurrency;
    concurrencyGuard.maxQueue = Math.min(512, c.concurrency * 4);
    releaseGlobal = await concurrencyGuard.acquire(c.queueTimeoutMs, ac.signal);
    ac.signal.throwIfAborted();
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => sendJson(res, res.statusCode || 200, value);
    sink = (protocol === "anthropic" ? anthropicOut : protocol === "responses" ? responsesOut : openaiOut).create({
      res, reqId: ctx.requestId, requestedModel: model, wantStream: !!body.stream,
      estInputTokens: () => 0,
    });
    if (body.stream) heartbeat = setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed && !res.writableNeedDrain) sink.keepAlive();
    }, 15000);
    const excluded = new Set(routing.channelsWithAccounts().filter((ch) => !bindings.some((m) => m.channel === ch)));
    // 组内成员级排重：同一渠道的不同模型要分开判死，不能因为一个模型失败把整条渠道排掉
    const blockedMembers = new Set();
    const triedAccounts = new Map();
    const budget = c.routing.failover === false ? 1 : Math.max(1, Math.min(10, Math.floor(c.routing.maxRetriesPerRequest || 3)));
    const totalBudget = body.stream ? c.streamTotalTimeoutMs : c.requestTimeoutMs;
    const until = totalBudget > 0 ? Date.now() + totalBudget : Infinity;
    attemptLedger = createAttemptLedger({ limit: budget, deadlineAt: Number.isFinite(until) ? until : null, signal: ac.signal });
    if (totalBudget > 0) deadline = setTimeout(() => ac.abort(Object.assign(new Error("请求总时限已到"), { code: "TIMEOUT" })), totalBudget);
    if (protocol !== "openai") sink.writeHead();
    let loops = 0;
    while (attemptLedger.remaining > 0 && loops++ < 128) {
      ac.signal.throwIfAborted();
      let binding;
      if (groupMode) {
        // 组请求不看全局路由策略：成员顺序 / 轮询由组自己决定，失败自动换下一个还能用的成员
        binding = routing.pickGroupMember(groupRows, group.strategy, excluded, blockedMembers, `group:${group.name}`);
        if (!binding) break;
      } else {
        const channel = routing.pick(model, [...excluded]);
        if (!channel) break;
        binding = bindings.find((m) => m.channel === channel);
        if (!binding) {
          // fixed / 模型覆盖 / 渠道锁定可能选出一个没有可用执行绑定的渠道。
          // failover 关掉时必须按「固定渠道不可用」直接失败，不能悄悄换到别的渠道。
          excluded.add(channel);
          if (c.routing.failover === false) break;
          continue;
        }
      }
      const channel = binding.channel;
      // 账号排重键：普通模型按渠道；组按「渠道 + 实际模型」（同渠道不同模型的可用账号可能不同）
      const accountScope = groupMode ? routing.groupMemberKey(binding) : channel;
      channelUsed = channel;
      requestState.phase = "等待上游";
      requestState.channel = channel;
      requestState.attempts = attemptLedger.used + 1;
      sink.resetAttempt();
      let committed = false, outputBytes = 0, usage = null, finish = "stop";
      const emit = async (ev) => {
        if (ev.type === "delta") {
          if (!protocolUtil.hasConsumableDelta(ev.delta || {})) return;
          outputBytes += Buffer.byteLength(JSON.stringify(ev.delta));
          if (outputBytes > 16 * 1024 * 1024) throw Object.assign(new Error("上游输出超过网关限制"), { status: 413 });
          if (body.stream && !committed) { if (protocol === "openai") sink.writeHead(); committed = true; }
          requestState.phase = "接收响应";
          sink.onDelta(ev.delta);
        } else if (ev.type === "usage") { usage = ev.usage; sink.onUsage(usage); }
        else if (ev.type === "finish") { finish = ev.reason || "stop"; sink.onFinish(finish); }
        await waitForDrain(res, ac.signal);
      };
      forwardResult = await forwarder.forward({ ...body, model: binding.realModel }, channel, binding.realModel, model,
        { ...ctx, serviceRef: binding.serviceRef, clientHeaders: req.headers, clientRawHeaders: req.rawHeaders,
          stateContext: () => executionStateContext(ctx), authorize: () => !ac.signal.aborted && authorizeChannel(channel),
          catalogExcludeAccounts: () => snapshot.catalog.excludedAccounts(channel, binding.realModel),
          catalogModels: accountId => snapshot.catalog.accountModels(channel, accountId), attempt: attemptLedger.used + 1,
          attemptsRemaining: attemptLedger.remaining - 1, attemptLedger, excludeAccounts: [...(triedAccounts.get(accountScope) || [])] }, Number.isFinite(until) ? Math.max(1, until - Date.now()) : 0, emit, ac.signal);
      requestState.attempts = attemptLedger.used;
      // committed 取两者之或：本地 sink 已写响应头，或转发层已向客户端吐出可消费内容。
      // 只看局部变量时，非流式 / 降级重发路径会把「已输出」记成 false，日志漏标。
      attempts.push({ channel, model: binding.realModel, code: forwardResult.errCode || "ok", ms: forwardResult.ms || 0, committed: committed || forwardResult.committed === true,
        ...(forwardResult.executionFacts?.length ? { executionFacts: forwardResult.executionFacts } : {}) });
      if (forwardResult.accountId) {
        if (!triedAccounts.has(accountScope)) triedAccounts.set(accountScope, new Set());
        triedAccounts.get(accountScope).add(forwardResult.accountId);
      }
      if (forwardResult.ok) {
        routing.markSucceeded(channel);
        sink.endOk(finish, protocol === "openai" && body.stream && body.stream_options?.include_usage === false ? null : usage);
        break;
      }
      if (committed || forwardResult.switchable === false || ac.signal.aborted) break;
      const accountsLeft = !!forwardResult.accountId
        && require("../proxy/pool.cjs").accountPlan(channel, undefined, [...(triedAccounts.get(accountScope) || [])], 0, binding.realModel).some((r) => r.eligible);
      if (groupMode) {
        // 组内成员级故障转移：模型不存在 / 账号都不可用时只判死这个成员，
        // 同渠道的其它成员（另一个模型）仍然保留在候选里。
        const hopeless = !forwardResult.accountId || ["not_found", "model_blocked", "model_config"].includes(forwardResult.errCode);
        if (!accountsLeft || hopeless) blockedMembers.add(routing.groupMemberKey(binding));
        if (!accountsLeft && forwardResult.failureScope !== "egress" && ["server", "timeout"].includes(forwardResult.errCode)) routing.markFailed(channel);
      } else {
        if (forwardResult.accountId && !accountsLeft) {
          excluded.add(channel);
          if (forwardResult.failureScope !== "egress" && ["server", "timeout"].includes(forwardResult.errCode)) routing.markFailed(channel);
        }
        if (!forwardResult.accountId) {
          excluded.add(channel);
        }
      }
      if (c.routing.failover === false) break;
    }
    if (!forwardResult?.ok && !res.writableEnded && !res.destroyed) {
      const noRoute = group ? `模型组「${model}」当前没有可用成员` : "当前没有可用渠道";
      sink.endErr(forwardResult?.status || 503, forwardResult?.error || noRoute, "upstream_error",
        forwardResult?.errCode || (group ? "no_group_member" : "no_route"));
    }
    const ok = forwardResult?.ok === true;
    const ms = Date.now() - t0;
    const events = forwardResult?.events;
    oplog.insert({ ts: Date.now(), apiKeyPrefix: ctx.apiKeyPrefix, channel: channelUsed, model, status: ok ? "success" : forwardResult?.errCode === "cancelled" ? "cancelled" : "error", ms,
      promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out"), errCode: forwardResult?.errCode,
      sensitiveHits: forwardResult?.outboundHits || "", attempts });
    if (ok) usagehook.afterRequest({ apiKeyId: ctx.apiKeyId, channel: channelUsed, model, ms, promptTokens: aggregatedUsage(events, "in"), completionTokens: aggregatedUsage(events, "out") });
    await maybeWriteToMemory(body, channelUsed, model, ok ? "success" : "error");
  } catch (e) {
    const status = ac.signal.aborted ? ac.signal.reason?.code === "TIMEOUT" ? 504 : 499 : /QUEUE/.test(e?.message) ? 429 : e?.status || 502;
    if (attempts.length) oplog.insert({ ts: Date.now(), apiKeyPrefix: ctx.apiKeyPrefix, channel: channelUsed, model: body?.model || "", status: status === 499 ? "cancelled" : "error", ms: Date.now() - t0, errCode: status === 504 ? "timeout" : status === 499 ? "cancelled" : "request_failed", attempts });
    if (!res.destroyed && !res.writableEnded) {
      if (sink) sink.endErr(status, status === 429 ? "网关排队已满或等待超时" : String(e?.message || e));
      else if (e?.code === "PAYLOAD_TOO_LARGE" || e instanceof SyntaxError) replyBodyError(res, e, c.bodyLimitMb);
      else sendJson(res, status, { error: { message: String(e?.message || e) } });
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    releaseAuthority?.();
    attemptLedger?.close();
    requests.end(ctx.requestId);
    releaseGlobal?.();
    releaseBody?.();
    slot?.release();
    res.removeListener("close", close);
  }
}

function handleChat(req, res, ctx) { return handleCompletion(req, res, ctx, "openai"); }
function handleMessages(req, res, ctx) { return handleCompletion(req, res, ctx, "anthropic"); }

/** 处理 OpenAI /v1/models */
async function handleModels(req, res, ctx) {
  const c = lgwConfig.get();
  if (!c.models.exposeInV1Models) {
    sendJson(res, 200, { object: "list", data: [] });
    return;
  }
  const allowed = ctx?.key?.scopes?.length && !ctx.key.scopes.includes("*") ? new Set(ctx.key.scopes) : null;
  const snapshot = await prepareRequestCatalog(req, res, ctx);
  if (res.destroyed) return;
  const rows = [...new Map(models.list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()].map((m) => ({
    id: m.display,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.channel,
  }));
  sendJson(res, 200, { object: "list", data: rows });
}

/** 处理 Anthropic /v1/models
 *  Anthropic 没有 /v1/models 端点；本模块返回空目录即可（不影响 Claude Code 等客户端） */
async function handleAnthropicModels(req, res, ctx) {
  const allowed = ctx?.key?.scopes?.length && !ctx.key.scopes.includes("*") ? new Set(ctx.key.scopes) : null;
  const snapshot = await prepareRequestCatalog(req, res, ctx);
  if (res.destroyed) return;
  const rows = [...new Map(models.list(snapshot).filter((m) => (!allowed || allowed.has(m.channel)) && serviceReady(m.channel)).map((m) => [m.display, m])).values()];
  sendJson(res, 200, { data: rows.map((m) => ({ id: m.display, type: "model", display_name: m.display })), has_more: false, first_id: rows[0]?.display || null, last_id: rows.at(-1)?.display || null });
}

// The shared directory refresh checks current credentials/permissions, independent
// of any one HTTP waiter's signal. Disconnect only cancels that waiter.
function catalogAuthorization(ctx) {
  return channel => {
    if (!ctx?.isApiKey) return ctx?.isAdmin === true || ctx?.isReadonly === true;
    const key = keysStore.getById(ctx.apiKeyId);
    return !!key && key.status === "active" && (!key.expiresAt || key.expiresAt > Date.now())
      && (!key.scopes?.length || key.scopes.includes("*") || key.scopes.includes(channel));
  };
}
function watchKey(ctx, controller, channelsFor = () => undefined) {
  if (!ctx?.isApiKey) return () => {};
  return requests.watchAuthority({ controller, tags: { keyId: ctx.apiKeyId }, check() {
    const key = keysStore.getById(ctx.apiKeyId);
    const channels = channelsFor();
    return !!key && key.status === "active" && (!key.expiresAt || key.expiresAt > Date.now())
      && (!channels?.length || !key.scopes?.length || key.scopes.includes("*") || channels.some(channel => key.scopes.includes(channel)));
  } });
}
function catalogContext(ctx, authorizeChannel = catalogAuthorization(ctx)) {
  const key = ctx?.isApiKey ? keysStore.getById(ctx.apiKeyId) : null;
  return { audience: ctx?.isApiKey ? `key:${ctx.apiKeyId}` : ctx?.isReadonly ? "readonly" : "admin", authorizeChannel,
    authorizationVersion: key ? require("node:crypto").createHash("sha256").update(JSON.stringify([key.status, key.expiresAt, key.scopes])).digest("hex") : "",
    ...(key?.scopes?.length && !key.scopes.includes("*") ? { channels: key.scopes } : {}) };
}
function executionStateContext(ctx) {
  if (ctx?.isApiKey) {
    const version = keysStore.authorizationVersion(ctx.apiKeyId);
    if (!version) throw Object.assign(new Error("网关密钥授权已失效"), { code: "AUTHORITY_REVOKED", status: 403 });
    return { audience: "key:" + ctx.apiKeyId, authorizationVersion: version };
  }
  if (ctx?.isAdmin === true || ctx?.isReadonly === true) {
    return { audience: ctx.isAdmin === true ? "admin" : "readonly", authorizationVersion: "local-role-v1" };
  }
  throw Object.assign(new Error("缺少已认证的执行主体"), { code: "AUTHORITY_REVOKED", status: 403 });
}
async function prepareRequestCatalog(req, res, ctx) {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(new Error("客户端已断开")); };
  res.once("close", close);
  let releaseAuthority;
  try {
    releaseAuthority = watchKey(ctx, controller);
    const snapshot = await models.prepare({ ...catalogContext(ctx), signal: controller.signal });
    controller.signal.throwIfAborted();
    return snapshot;
  } finally { releaseAuthority?.(); res.off("close", close); }
}

function serviceReady(channel) {
  try { services.check(channel, () => true); return true; } catch { return false; }
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
    requestId: crypto2.randomUUID(),
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
  if (path === "/v1/responses" && method === "POST") return handleCompletion(req, res, ctx, "responses");
  if (path === "/v1/messages/count_tokens" && method === "POST") {
    try {
      const raw = await readBody(req, lgwConfig.get().bodyLimitMb);
      sendJson(res, 200, anthropicIn.countTokens(JSON.parse(raw.toString("utf8"))));
    } catch (e) { replyBodyError(res, e, lgwConfig.get().bodyLimitMb); }
    return;
  }
  if (path === "/v1/models" && method === "GET") {
    return handleModels(req, res, ctx);
  }
  if (path === "/v1/messages" && method === "POST") {
    return handleMessages(req, res, ctx);
  }
  if (path === "/v1/anthropic/models" && method === "GET") {
    return handleAnthropicModels(req, res, ctx);
  }
  // 方法不匹配 vs 路径不存在分开报：前者 405 更贴近 HTTP 语义，也方便调用方排查
  const KNOWN = { "/v1/responses": "POST", "/v1/messages/count_tokens": "POST", "/v1/chat/completions": "POST", "/v1/messages": "POST", "/v1/models": "GET", "/v1/anthropic/models": "GET" };
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
