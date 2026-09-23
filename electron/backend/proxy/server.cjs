// 反代网关 · HTTP 服务（方案 §4/§6.1）：Express @ 127.0.0.1:9527（可配置）
// 端点：POST /v1/chat/completions（SSE 双态）/ GET /v1/models / GET /healthz / GET /status（调试，默认关）
// 错误语义对齐 OpenAI：401 invalid_api_key / 429 配额或限流 / 400 参数 / 502 上游 / 503 渠道不可用
// 转发不用现成反代中间件：Dispatch(Key→渠道) → PoolService(号池选号) → Adapter(渠道改写) → SSE 转换输出
"use strict";
const crypto = require("node:crypto");
const store = require("./store.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const util = require("./util.cjs");
const events = require("./events.cjs");

let runtime = null; // { server, startedAt, port, bind, active }

// 单 Key 令牌桶（内存态，默认 120 次/分钟，Key 上可单独配置覆盖）
const buckets = new Map();

function rateLimitOk(key, defaultPerMin) {
  const perMin = key.rateLimit > 0 ? key.rateLimit : defaultPerMin;
  if (!perMin) return true;
  if (buckets.size > 5000) buckets.clear(); // 已删 Key 的桶定期清，防内存缓慢增长
  const now = Date.now();
  let b = buckets.get(key.id);
  if (!b) {
    b = { tokens: perMin, ts: now };
    buckets.set(key.id, b);
  }
  b.tokens = Math.min(perMin, b.tokens + ((now - b.ts) / 60000) * perMin);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function sendError(res, status, message, type, code) {
  if (res.headersSent) return;
  res.status(status).json(util.openaiError(message, type, code));
}

/** request 事件节流：每条代理请求完成都会调用，高流量时逐条广播只烧 IPC，
    合并为每 2 秒至多一条（带合并条数），渲染层本就以 5s 轮询展示实时流 */
let reqEvt = { count: 0, timer: null };
function emitRequestThrottled() {
  reqEvt.count++;
  if (reqEvt.timer) return;
  reqEvt.timer = setTimeout(() => {
    const n = reqEvt.count;
    reqEvt = { count: 0, timer: null };
    events.emit({ type: "request", count: n });
  }, 2000);
}

/** 渠道选择（方案 §6.2）：单源强制 → per-model 覆盖 → 打分（健康度×余额）/ 指定渠道优先 */
function resolveChannel(key, model, settings) {
  const owners = adapters.modelOwners(model);
  if (owners.length === 1) return { channel: owners[0] }; // 模型仅存在于单渠道目录 → 强制
  if (key.route !== "auto") return { channel: key.route };
  if (owners.length > 1) {
    const ov = (settings.modelOverrides || {})[model];
    if (ov && owners.includes(ov)) return { channel: ov };
    if (settings.routeStrategy === "fixed" && owners.includes(settings.fixedChannel)) return { channel: settings.fixedChannel };
    return { channel: bestByScore(owners) };
  }
  // 模型不在任何目录：auto 且固定渠道策略时放行指定渠道（透传试错），否则 400 给可用模型提示
  if (settings.routeStrategy === "fixed") return { channel: settings.fixedChannel };
  return { channel: null, unknownModel: true };
}

/** 智能路由打分：可用账号数 × 号池总余额（方案 §6.2 auto） */
function bestByScore(candidates) {
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const s = pool.poolSummary(c);
    const score = (s.onlineCount > 0 ? 1 : 0) * (1 + s.totalCredits);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** 单账号尝试：401 就地刷新凭证、同渠道重试一次（方案 §6.3 WB 实证，Trae 同理）。
 *  刷新走 single-flight（并发 401 共享同一次刷新，防 refreshToken 轮换互相践踏）；
 *  刷新失败不立即判废——连续 3 次才 relogin（参考项目语义），中间短冷却重试 */
async function attemptChat(channel, acc, model, body, emit, meta) {
  const adapter = adapters.get(channel);
  let secrets = store.accountSecrets(store.getAccount(acc.id));
  try {
    return await adapter.chat({ account: acc, secrets, model, body, emit, meta });
  } catch (e) {
    if (e && e.status === 401) {
      const r = await adapters.refreshTokenLocked(channel, acc, secrets).catch(() => ({ ok: false }));
      if (r.ok) {
        store.updateAccount(acc.id, { token: r.token, refreshToken: r.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
        return await adapter.chat({ account: acc, secrets: { token: r.token, refreshToken: r.refreshToken }, model, body, emit, meta });
      }
      // 触发计数与冷却交给 catch 侧的 applyCool 统一处理（classifyUpstream → relogin），
      // 这里只如实抛出：是短冷却重试还是判废由计数决定
      throw Object.assign(new Error("凭证失效且自动刷新失败"), { status: 401 });
    }
    throw e;
  }
}

/** 从错误文本解析上游明示的限流重置时间（参考项目实证：「将在 2026-09-17 04:00 重置」）。
 *  对齐墙钟冷却比固定 60s 盲猜准确——重置前换哪个号打这个模型都是白费。
 *  文案固定按 UTC+8 解释（参考项目 ParseRateReset 口径，与本机时区无关） */
function parseRateResetMs(text) {
  const m = /将在\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*重置/.exec(String(text || ""));
  if (!m) return 0;
  const t = Date.parse(m[1].replace(/\//g, "-").replace(" ", "T") + "+08:00");
  return Number.isFinite(t) && t > Date.now() ? t : 0;
}

/** 错误分类（对齐参考项目 handler.applyErrorPolicy 全表 + 参考项目 SOLO 专项）：
 *  决定冷却档位与是否换号。6004 = 模型级限流（罚账号×模型，切模型豁免）；
 *  11102 = 该账号不支持此模型（6h 指数负缓存）；4008 = 模型/账号级限流；4001 = 模型配置问题
 * （不罚号）；11115 prompt 过长（零动作透传）；11101 参数错误（换号不罚号——不同账号模型权限不同） */
function classifyUpstream(e, planLimit) {
  if (planLimit || (e && e.status === 402)) return { kind: "credit", switchable: true, status: 402 };
  const msg = String((e && e.message) || "");
  const code = Number(e && e.code) || 0;
  if (code === 4001 || /model config is empty|config.*is empty/i.test(msg)) {
    return { kind: "model_config", switchable: true, status: 502 }; // 模型/配置问题：不罚号
  }
  if (code === 4008 || /\b4008\b/.test(msg)) return { kind: "rate", switchable: true, status: 429 };
  if (/\b6004\b/.test(msg)) return { kind: "model_rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) };
  if (/\b11102\b/.test(msg) || /service info not found/i.test(msg)) return { kind: "model_blocked", switchable: true, status: 404 };
  if (/\b11115\b/.test(msg) || /prompt is too long|prompt_too_long/i.test(msg)) {
    return { kind: "prompt_too_long", switchable: false, status: 400 }; // 请求本身超限：零动作透传
  }
  if (/\b11101\b/.test(msg)) return { kind: "bad_params", switchable: true, status: 400 };
  if (e && e.status === 429) {
    return { kind: "rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) || (e.retryAfterMs || 0) };
  }
  if (e && e.status === 401) return { kind: "relogin", switchable: true, status: 401 };
  if (e && e.status === 404) return { kind: "not_found", switchable: true, status: 404 }; // 短冷却不累计，防雪崩
  if (e && e.status === 400) return { kind: "fatal", switchable: false, status: 400 };
  return { kind: "server", switchable: true, status: 502 }; // 5xx / 网络 / 超时
}

/** WAF/渠道级故障识别：WAF Block Page（HTML）与渠道白名单 11128 都不是账号问题——
 *  拦的是 IP/指纹/渠道，换号照拦。正确反应是渠道级短退避 + 如实报错，绝不能逐个冷却账号 */
const channelBackoff = new Map(); // channel → untilMs

function isWafBlock(e) {
  return /WAF Block Page/i.test(String((e && e.body) || (e && e.message) || ""));
}

function isChannelBlock(e) {
  return isWafBlock(e) || /\b11128\b/.test(String((e && e.message) || ""));
}

function coolChannel(channel, ms, reason) {
  channelBackoff.set(channel, { until: Date.now() + ms, reason: reason || "" });
}

function channelCooling(channel) {
  const hit = channelBackoff.get(channel);
  if (!hit) return null;
  if (hit.until <= Date.now()) {
    channelBackoff.delete(channel);
    return null;
  }
  return hit;
}

/** 按分类落冷却（账号级或账号×模型级）；429 优先对齐上游明示时间（墙钟/Retry-After），
 *  都没有时走有界指数退避；模型配置/参数/超长错误零动作不罚号 */
function applyCool(accId, model, cls, message) {
  if (!accId) return;
  // 参数/模型配置类错误与账号无关，不罚号也不记错；其余落冷却的错误都记入账号最近错误（号池气泡展示）
  if (cls.kind !== "model_config" && cls.kind !== "bad_params" && cls.kind !== "prompt_too_long" && message) {
    store.noteError(accId, message);
  }
  switch (cls.kind) {
    case "model_config": // 4001 模型配置为空：模型问题不是账号问题，不罚号
    case "bad_params": // 11101：参数问题不罚号（换号仍会发生，由外层轮转决定）
    case "prompt_too_long": // 11115：同一 body 换任何号都超限，零动作
      return;
    case "model_rate":
      pool.coolAccountModel(accId, model, cls.resetMs || Date.now() + 600000, message); // 6004：对齐墙钟优先，缺省 10min
      return;
    case "model_blocked":
      pool.coolAccountModel(accId, model, 6 * 3600000, message, { backoff: true, baseMs: 6 * 3600000, capMs: 24 * 3600000 }); // 11102：6h 起指数封顶 24h
      return;
    case "rate": {
      const until = cls.resetMs || (cls.retryAfterMs || 0) || (Date.now() + pool.softBackoffMs(accId));
      pool.coolAccountMs(accId, until, message);
      return;
    }
    case "not_found":
      pool.coolAccountMs(accId, Date.now() + 60000, message); // 404 短冷却不累计，防雪崩
      return;
    case "relogin":
      // 连续 3 次凭证失效才判废（参考项目 sessionDeadThreshold）；否则 60s 短冷却给重试机会
      if (pool.noteSessionDead(accId)) pool.coolAccount(accId, "relogin", `${message || "凭证失效"}（连续 3 次，请重新登录）`);
      else pool.coolAccountMs(accId, Date.now() + 60000, `${message || "凭证失效"}（短冷却重试）`);
      return;
    case "server": {
      // 5xx/网络：单次失败不冷却（只由外层轮转换号），连续 3 次才熔断（30m 指数封顶 6h）。
      // 参考项目语义（note_error 的 err_count 分支）：网络抖动/上游偶发 5xx 立即罚 10 分钟
      // 会把号池一次打空（实测：一次首字节超时 → 全渠道 503 直到手动解冷却）
      const until = pool.noteServerError(accId);
      if (until) pool.coolAccountMs(accId, until, message);
      return; // 未达熔断阈值：不罚号
    }
    default:
      pool.coolAccount(accId, cls.kind, message);
  }
}

/** chat/completions 主流程（stream 双态共用一套 emit → 出线或聚合） */
async function handleChat(req, res, settings) {
  const startedAt = Date.now();
  const reqId = util.uuid().replace(/-/g, "").slice(0, 24);
  const body = req.body || {};
  const usageRow = { ts: startedAt, reqId, keyId: "", keyName: "", channel: "", accountId: "", accountName: "", model: String(body.model || ""), status: 0 };

  const record = (extra) => {
    usageRow.latencyMs = Date.now() - startedAt;
    Object.assign(usageRow, extra || {});
    store.insertUsage(usageRow);
    if (usageRow.accountId) store.bumpAccountUsage(usageRow.accountId, (usageRow.promptTokens || 0) + (usageRow.completionTokens || 0));
    emitRequestThrottled();
  };

  // ===== 鉴权：Bearer sk-…，库中只存哈希，实时查表（启停/删除即时生效） =====
  const auth = String(req.headers.authorization || "");
  const secret = auth.replace(/^Bearer\s+/i, "").trim();
  const key = secret ? store.findKeyBySecret(secret) : null;
  if (!key) {
    record({ status: 401, error: "invalid_api_key" });
    return sendError(res, 401, "无效的 API Key", "invalid_request_error", "invalid_api_key");
  }
  usageRow.keyId = key.id;
  usageRow.keyName = key.name;
  if (!key.enabled) {
    record({ status: 401, error: "key disabled" });
    return sendError(res, 401, "API Key 已停用", "invalid_request_error", "invalid_api_key");
  }
  // 日配额（0=不限，次日 00:00 重置）
  if (key.dailyQuota > 0 && store.keyTodayReq(key.id) >= key.dailyQuota) {
    record({ status: 429, error: "daily quota exceeded" });
    return sendError(res, 429, "该 Key 今日配额已用尽（次日 00:00 重置）", "rate_limit_exceeded", "quota_exceeded");
  }
  // 单 Key 令牌桶限速
  if (!rateLimitOk(key, settings.rateLimitPerMin)) {
    record({ status: 429, error: "rate limited" });
    return sendError(res, 429, "请求过于频繁（单 Key 限速）", "rate_limit_exceeded", "rate_limited");
  }
  // 参数校验（OpenAI 同构 400）；请求体上限 32MB 由 express.json 把关
  const bad = util.validateChatBody(body);
  if (bad) {
    record({ status: 400, error: bad });
    return sendError(res, 400, bad, "invalid_request_error", "invalid_params");
  }
  // 上游并发上限（默认 8）
  if (runtime.active >= settings.concurrency) {
    record({ status: 429, error: "concurrency limit" });
    return sendError(res, 429, "上游并发已满，请稍后重试", "rate_limit_exceeded", "concurrency_limited");
  }

  // ===== Dispatch：Key → 渠道（别名解析 → 模型禁用 → 回退链） =====
  const requestedModel = String(body.model);
  // 自定义模型映射（别名）：请求的模型名先过别名表得实际模型，路由/转发都用实际模型；
  // 客户端响应的 model 字段保持请求值（契约不变），记账备注标 alias→actual
  const aliased = (settings.modelAliases || {})[requestedModel];
  const actualModel = aliased && aliased !== requestedModel ? String(aliased) : requestedModel;
  if ((settings.disabledModels || []).includes(actualModel)) {
    record({ status: 400, error: "model disabled" });
    return sendError(res, 400, `模型 "${actualModel}" 已被禁用（模型目录页可恢复）`, "invalid_request_error", "model_disabled");
  }
  // 模型回退链（多模型自动切换）：请求模型 → 回退模型（单跳防循环）。
  // 触发时机：① 模型不在任何渠道目录（unknown）；② 渠道号池全部不可用（耗尽/冷却）。
  // per-model 覆盖（旧配置兼容）优先，否则用全局统一回退模型（autoFallbackEnabled !== false 且已配置）。
  // 上游用实际命中模型转发，客户端响应的 model 字段保持请求值（契约不变）
  const modelChain = [actualModel];
  const perModel = (settings.modelFallback || {})[actualModel];
  const globalFb = settings.autoFallbackEnabled === false ? "" : String(settings.fallbackModel || "");
  const fallback = perModel || globalFb;
  // 回退模型自身被禁用时不入链（切过去也是 400，白费一跳）
  if (fallback && fallback !== actualModel && fallback !== requestedModel && !(settings.disabledModels || []).includes(fallback)) {
    modelChain.push(fallback);
  }

  if (!resolveChannel(key, actualModel, settings).channel && !fallback) {
    const hint = adapters.mergedModels().map((m) => m.id).join(", ");
    record({ status: 400, error: "unknown model" });
    return sendError(res, 400, `模型 "${actualModel}" 不在任何渠道目录中。可用模型：${hint}`, "invalid_request_error", "model_not_found");
  }
  const wantStream = !!body.stream;

  // ===== 出线准备 =====
  // 会话元数据：轮内稳定（参考项目 ChatMeta——一次 user send 内的重试/换号复用同一
  // X-Conversation-Request-ID，上游后台按它聚合）；会话键按前 3 条消息指纹派生
  const chatMeta = {
    conversationRequestId: crypto.randomBytes(16).toString("hex"),
    conversationId: util.stableConvId(body.messages) || "",
  };
  runtime.active += 1;
  const rt = runtime; // 捕获引用：stop() 会把 runtime 置 null，finally 里直接碰会 TypeError
  let keepAliveTimer = null;
  let clientGone = false;
  // 注意：req 的 close 在请求体读完后就可能触发（Node 18+ 语义），不能用来判客户端断连；
  // res close 才是响应维度的断开——断连后只停写，上游继续消费至 EOF（保 usage 完整，方案 §2.2）
  res.on("close", () => { clientGone = true; });
  const write = (text) => {
    if (clientGone || res.writableEnded) return;
    res.write(text);
  };
  let ttftMs = 0;
  let lastUsage = null;
  let finishReason = "stop";
  let sentDelta = false; // 是否已向客户端出过内容（决定流中错误要不要写进 SSE）
  let streamErr = null;  // 流中 error 事件：出过内容时下发作罢；一条内容都没出过时按失败换号
  // 思考链合批（仅流式）：上游 reasoning_content 按 1~2 字符切片推流（实测 hy3-preview 140 个增量/轮），
  // 原样透传会让客户端思考链面板碎成几百段刷屏。攒 ≥24 字符或 ≥120ms 或思考结束才下发，正文内容不受影响
  let reasoningBuf = "";
  let reasoningLastFlush = 0;
  const REASON_BATCH_CHARS = 24;
  const REASON_BATCH_MS = 120;
  let agg = new util.Aggregator(reqId, requestedModel);

  /**
   * 每次真实上游请求前重置「单轮尝试独占」的状态。
   * 这些变量都声明在换号循环与模型回退链之外，不重置就会让上一次尝试的输出混进本次：
   *  - agg：非流式换号重发时两个账号的正文拼进同一条 content（planLimit 分支曾在 :462
   *    无条件 continue，完全不查出线状态，是最容易触发的一条路）；
   *  - reasoningBuf：尾段思考链跨尝试残留，客户端看到上一号的半截思考；
   *  - sentDelta / ttftMs：残留会让下一次尝试的"是否已出线"判定失真；
   *  - finishReason / lastUsage：残留会让本次以错误的 stop_reason 或上一号的 usage 收尾。
   * 流式已出线时不允许走到重发（见 planLimit 分支的 wantStream && sentDelta 短路），
   * 因为已 write 给客户端的半截正文无法撤回，重置也救不回拼接问题。
   */
  const resetAttemptState = () => {
    agg = new util.Aggregator(reqId, requestedModel);
    sentDelta = false;
    streamErr = null;
    finishReason = "stop";
    lastUsage = null;
    reasoningBuf = "";
    ttftMs = 0;
  };

  /** 冲刷思考链缓冲（思考结束/出错/收尾时必调，防尾段滞留） */
  const flushReasoning = () => {
    if (wantStream && reasoningBuf) {
      write(util.chunk(reqId, requestedModel, { reasoning_content: reasoningBuf }));
      reasoningBuf = "";
    }
  };

  const emit = (ev) => {
    if (ev.type === "delta") {
      const d = ev.delta || {};
      const rc = d.reasoning_content;
      // 噪声字段（function_call:null / refusal:"" / tool_calls:[] / extra_fields:null / 重复 role）
      // 必须在此剔除：它们会让下面的"rest 非空即正文"误判，既提前冲刷思考链缓冲
      // （合批攒不满 → 思考链碎成一词一条），又把无正文的空帧发给客户端造成逐段换行
      const rest = util.stripEmptyDelta(d);
      delete rest.reasoning_content;
      // "已出线"只认客户端与聚合器真正可消费的三类字段（正文/思考/工具调用），
      // 不用 rest 非空做判据：rest 可能带上游私有的非空扩展字段（如 extra_fields:{}），
      // 它既进不了 Aggregator，也不该封死 streamErr 的换号路径、把一次空响应记成 200。
      // 全空噪声帧同样不得置位——否则流中错误被误判为"已输出不可换号"。
      // 首字延迟与出线标志在此一并置位：噪声帧若计入 ttftMs，既让统计页 TTFT 虚低，
      // 又会短路 catch 分支的 `sentDelta || ttftMs` 禁令、废掉换号自救的机会。
      const substantive = util.hasConsumableDelta(d);
      if (substantive) {
        if (!ttftMs) ttftMs = Date.now() - startedAt;
        sentDelta = true;
      }
      if (!wantStream) {
        agg.pushDelta(ev.delta);
        return;
      }
      // 思考链合批：攒批下发；正文/工具调用立即下发前先冲刷思考缓冲（保持先后顺序）
      if (rc) {
        reasoningBuf += rc;
        const now = Date.now();
        if (reasoningBuf.length >= REASON_BATCH_CHARS || now - reasoningLastFlush >= REASON_BATCH_MS) {
          flushReasoning();
          reasoningLastFlush = now;
        }
      }
      if (Object.keys(rest).length) {
        flushReasoning();
        write(util.chunk(reqId, requestedModel, rest));
      }
    } else if (ev.type === "usage") {
      lastUsage = ev.usage;
      if (!wantStream) agg.usage = ev.usage;
    } else if (ev.type === "finish") {
      if (ev.reason) finishReason = ev.reason;
      if (!wantStream) agg.finishReason = finishReason;
      flushReasoning(); // 思考结束：尾段全部下发
    } else if (ev.type === "error") {
      // 流中错误：注入 OpenAI 错误对象后仍发 [DONE]（幂等兜底，方案 §6.3）。
      // 但内容尚未开始时错误不下发——交给换号逻辑，换号成功客户端完全无感（防监测：不暴露多账号切换痕迹）。
      // 无论下没下发都要记账：没出过内容的 error 意味着本次尝试实质失败，不能伪装成 200 空响应
      streamErr = ev;
      if (wantStream && sentDelta) {
        flushReasoning();
        write(`data: ${JSON.stringify(util.openaiError(ev.message, "upstream_error", ev.code || null))}\n\n`);
      }
    }
  };

  try {
    if (wantStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      });
      write(util.chunk(reqId, requestedModel, { role: "assistant" }));
    }
    // 15s keep-alive 注释行（防中间层回收，方案 §2.2 联调坑）；有真实输出时静默。
    // 清理放在外层 finally：循环体异常（DB 故障等）直接跳走时定时器也必须清，
    // 不然每 5 秒空转一次还阻止进程退出，随失败请求数累积
    let lastWrite = Date.now();
    const rawWrite = write;
    keepAliveTimer = setInterval(() => {
      if (wantStream && Date.now() - lastWrite >= 15000) rawWrite(": keep-alive\n\n");
    }, 5000);
    const emitTimed = (ev) => {
      lastWrite = Date.now();
      emit(ev);
    };

    // ===== PoolService：号池选号，单请求最多换号 2 次（402/429/401 触发）；模型回退链外层 =====
    let done = false;
    let lastErr = null;
    let fatalErr = null;
    let usedModel = actualModel;
    for (const chainModel of modelChain) {
      if (done || fatalErr) break;
      const resolved = resolveChannel(key, chainModel, settings);
      if (!resolved.channel) {
        lastErr = Object.assign(new Error(`模型 "${chainModel}" 不在任何渠道目录中`), { status: 400 });
        continue; // 未知模型 → 尝试回退模型
      }
      usedModel = chainModel;
      usageRow.channel = resolved.channel;
      // 渠道级退避（WAF Block / 渠道白名单 11128）：拦的是 IP/指纹/渠道本身，换号照拦。
      // 退避窗口内直接 503 如实报错，不把号池逐个刷成冷却中
      const chCool = channelCooling(resolved.channel);
      if (chCool) {
        lastErr = Object.assign(new Error(`渠道 ${resolved.channel} 被上游边缘拦截（${chCool.reason || "WAF/渠道白名单"}），${Math.ceil((chCool.until - Date.now()) / 1000)}s 后重试`), { status: 503 });
        break;
      }
      const strategy = (store.listAgents().find((a) => a.id === resolved.channel) || {}).poolStrategy || "expire_first";
      const tried = new Set();
      const rateRetried = new Set(); // 无明示时间的 429 同号退避重试标记（每号限一次）
      // 每账号并发租约：expire_first 排序与并发无关，同窗口并发会话否则全打同一账号（参考项目租约语义）
      const perAccountLimit = Number(settings.concurrencyPerAccount) > 0 ? Number(settings.concurrencyPerAccount) : 3;
      for (let attempt = 0; attempt <= 2 && !done; attempt++) {
        const acc = pool.pickAccount(resolved.channel, strategy, [...tried], perAccountLimit);
        if (!acc) break;
        tried.add(acc.id);
        pool.acquireAccount(acc.id);
        // 模型级负缓存（6004 模型级限流 / 11102 该号不支持此模型）：直接换号，不浪费一次上游请求。
        // 不计入换号次数（attempt--）：已 tried 集合单调增长，全 cooled 时 pickAccount 返回 null 自然 break，不会死循环
        if (pool.isModelCooled(acc.id, chainModel)) {
          lastErr = Object.assign(new Error(`模型 "${chainModel}" 在该账号冷却中`), { status: 429 });
          attempt--;
          continue;
        }
        usageRow.accountId = acc.id;
        usageRow.accountName = acc.name;
        // 拟人抖动（方案 §9：不超单人使用强度的限速与随机抖动）：每次上游请求前随机停 40~220ms，
        // 把机器式的瞬时连发抹成真实客户端节奏，降低被上游风控识别为反代的概率
        if (settings.humanizeJitter !== false) {
          await new Promise((r) => setTimeout(r, 40 + Math.random() * 180));
        }
        try {
          let r = null;
          resetAttemptState(); // 上一次尝试的输出不得带进本轮（详见函数注释）
          try {
            r = await attemptChat(resolved.channel, acc, chainModel, body, emitTimed, chatMeta);
          } finally {
            pool.releaseAccount(acc.id);
          }
          if (r && r.planLimit) {
            pool.coolAccount(acc.id, "credit");
            lastErr = Object.assign(new Error("积分不足"), { status: 402 });
            // 积分耗尽常以流中 error 事件返回（trae 1005 / workbuddy 402），此时正文可能已出线。
            // 流式下换号重发会让客户端收到「半截旧答 + 完整新答」，就地收尾不再换号；
            // 非流式可以换，下一轮 attemptChat 前的 resetAttemptState 会重建 agg 防拼接
            if (wantStream && sentDelta) { done = true; break; }
            continue; // 换号
          }
          // 一条内容都没产出却收到过流中 error：本次尝试实质失败（上游业务错误），
          // 冷却换号重试，绝不能记 200 空响应
          if (!sentDelta && streamErr) {
            // 流内的渠道级拦截同样按渠道级退避处理（WAF 也可能在流中返回拦截页）
            if (isChannelBlock(streamErr)) {
              coolChannel(resolved.channel, 60000, isWafBlock(streamErr) ? "WAF Block" : "渠道白名单 11128");
              store.noteError(acc.id, String(streamErr.message || "渠道被上游边缘拦截"));
              fatalErr = Object.assign(new Error(`渠道 ${resolved.channel} 被上游边缘拦截，60s 退避后自动恢复`), { status: 503 });
              streamErr = null;
              break;
            }
            lastErr = Object.assign(new Error(String(streamErr.message || "上游返回错误")), {
              status: streamErr.status || 502,
              code: streamErr.code || 0,
            });
            applyCool(acc.id, chainModel, classifyUpstream(lastErr, false), lastErr.message);
            streamErr = null;
            continue;
          }
          done = true;
        } catch (e) {
          lastErr = e;
          // 已向客户端输出过内容：绝不能换号重发（客户端会收到「半截旧回答 + 完整新回答」拼接）。
          // 就地收尾，本轮以错误结束，由客户端下一次请求自然重试
          if (sentDelta || ttftMs) {
            fatalErr = Object.assign(new Error(`上游流已输出后中断：${String((e && e.message) || "未知错误").slice(0, 200)}`), { status: 502 });
            break;
          }
          // WAF Block / 渠道白名单 11128：渠道级故障——短退避整个渠道，不换号不罚号，如实报错
          if (isChannelBlock(e)) {
            coolChannel(resolved.channel, 60000, isWafBlock(e) ? "WAF Block" : "渠道白名单 11128");
            store.noteError(acc.id, String(e.message || "渠道被上游边缘拦截"));
            fatalErr = Object.assign(
              new Error(`渠道 ${resolved.channel} 被上游边缘拦截（${isWafBlock(e) ? "WAF Block Page" : "渠道白名单 11128"}）：与账号无关，60s 退避后自动恢复`),
              { status: 503 }
            );
            break;
          }
          if (e && e.fatal) {
            fatalErr = e; // 400 参数类等直接透传，不再换号也不回退
            break;
          }
          const cls = classifyUpstream(e, false);
          // 无明示重置时间的 429：上游多为 1~3s 短窗限流，退避 1s 重试一次再落冷却换号
          // （参考项目 RetrySame 语义）；有墙钟/Retry-After 的 429 重试必白费，直接冷却。
          // 单号池场景下这一跳决定 429 是就地消化还是直接抛给客户端
          if (cls.kind === "rate" && !cls.resetMs && !rateRetried.has(acc.id)) {
            rateRetried.add(acc.id);
            tried.delete(acc.id); // 允许重新选中本号（多号池防惊群可能让位别的号，同样不罚号）
            attempt--;
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          applyCool(acc.id, chainModel, cls, e.message);
          if (!cls.switchable) {
            fatalErr = e;
            break;
          }
        }
      }
      // 当前模型号池打光且有回退模型 → 链到下一模型（lastErr 保留为最终错误）
    }

    if (done) {
      // 收尾：末 chunk 附 usage + [DONE]；无 done 事件也兜底结束（方案 §6.3）
      const usage = lastUsage || {
        prompt_tokens: util.estimateTokens(JSON.stringify(body.messages)),
        completion_tokens: util.estimateTokens(agg.content),
        total_tokens: 0,
      };
      if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      if (wantStream) {
        flushReasoning(); // 收尾兜底：finish 事件缺失时尾段思考链不滞留
        write(util.chunk(reqId, requestedModel, {}, finishReason, usage));
        write(util.DONE);
        res.end();
      } else {
        agg.finishReason = finishReason;
        agg.usage = usage;
        res.json(agg.result());
      }
      // 成功收尾：清软限流 streak / 凭证失效计数 / 该账号该模型的负缓存
      pool.noteSuccess(usageRow.accountId, usedModel);
      // 上游 usage.credit 实际扣减余额（参考项目 NoteModelCost）：两次定时刷新之间
      // 余额不再虚高，「余额不足自动切换」更实时；无限额度哨兵(-1)与估算 usage 不扣
      const creditUsed = Number(usage.credit ?? usage.total_credit ?? 0) || 0;
      if (usageRow.accountId && creditUsed > 0) {
        const cur = store.getAccount(usageRow.accountId);
        if (cur && typeof cur.credits === "number" && cur.credits > 0) {
          store.updateAccount(usageRow.accountId, { credits: Math.max(0, cur.credits - creditUsed), creditsAt: Date.now() });
        }
      }
      record({
        status: 200, ttftMs, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        error: usedModel !== actualModel
          ? "fallback→" + usedModel
          : actualModel !== requestedModel
            ? "alias→" + actualModel
            : "",
      });
      return;
    }

    // 全部账号用尽：渠道不可用
    const st = (lastErr && lastErr.status) || 503;
    const msg = st === 402 ? "该渠道号池积分全部耗尽" : (lastErr && lastErr.message) || "渠道暂不可用（号池无可用账号）";
    if (!wantStream || !ttftMs) {
      // 还没出过内容，可以正常回错误状态
      if (wantStream && res.headersSent) {
        write(`data: ${JSON.stringify(util.openaiError(msg, "upstream_error", null))}\n\n`);
        write(util.DONE);
        res.end();
      } else {
        sendError(res, st === 401 ? 502 : st, msg, st === 402 ? "rate_limit_exceeded" : "server_error");
      }
    } else {
      write(`data: ${JSON.stringify(util.openaiError(msg, "upstream_error", null))}\n\n`);
      write(util.DONE);
      res.end();
    }
    record({ status: st, ttftMs, error: msg.slice(0, 200) });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!res.headersSent) sendError(res, 502, msg, "server_error");
    else {
      write(`data: ${JSON.stringify(util.openaiError(msg, "server_error", null))}\n\n`);
      write(util.DONE);
      res.end();
    }
    record({ status: 502, error: msg.slice(0, 200) });
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    rt.active -= 1;
  }
}

// ===== 服务生命周期 =====

function buildApp(settings) {
  const express = require("express");
  const app = express();
  // runtime 判空放在最前：服务停止期间到达的连接一律 503，绝不能打进 handler 碰空 runtime
  app.use((req, res, next) => {
    if (runtime) return next();
    sendError(res, 503, "网关服务已停止", "server_error", "service_stopped");
  });
  app.use(express.json({ limit: "32mb" })); // 方案 §6.9：单请求体上限 32MB（多模态 base64）

  app.post("/v1/chat/completions", (req, res) => handleChat(req, res, settings()).catch((e) => {
    if (!res.headersSent) sendError(res, 500, String((e && e.message) || e), "server_error");
  }));

  // 模型目录：三渠道合并视图，鉴权可选（方案 §6.1）
  app.get("/v1/models", (_req, res) => {
    res.json({ object: "list", data: adapters.mergedModels() });
  });

  // 探活：无健康渠道时 503
  app.get("/healthz", (_req, res) => {
    const healthy = store.CHANNELS.some((c) => pool.poolSummary(c.id).onlineCount > 0);
    res.status(healthy ? 200 : 503).json({ ok: healthy });
  });

  // 调试快照：默认关闭（设置里显式开启），且校验回环地址（方案 §6.7）
  app.get("/status", (req, res) => {
    const cfg = settings();
    const ip = req.socket.remoteAddress || "";
    if (!cfg.debugStatus || !/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(ip)) {
      return res.status(404).json(util.openaiError("not found", "invalid_request_error", "not_found"));
    }
    res.json({
      uptime: runtime ? Date.now() - runtime.startedAt : 0,
      active: runtime ? runtime.active : 0,
      channels: store.CHANNELS.map((c) => pool.poolSummary(c.id)),
      today: store.statsToday(),
    });
  });

  // 兜底 404：OpenAI 同构
  app.use((_req, res) => res.status(404).json(util.openaiError("not found", "invalid_request_error", "not_found")));
  // express.json 的 413（超 32MB）/ JSON 解析失败也要回 OpenAI 同构错误，不能泄出 HTML 错误页
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 400;
    sendError(res, status, status === 413 ? "请求体超过 32MB 上限" : `请求体解析失败：${err.message}`, "invalid_request_error", status === 413 ? "payload_too_large" : "invalid_json");
  });
  return app;
}

/** 启动服务（settingsGetter 每次请求取最新配置 = 设置热生效；端口例外需重启监听） */
function start(settingsGetter) {
  if (runtime) return { ok: true, already: true, port: runtime.port };
  store.open();
  const s = settingsGetter();
  const app = buildApp(settingsGetter);
  return new Promise((resolve) => {
    const server = app.listen(s.port, s.bind, () => {
      runtime = { server, startedAt: Date.now(), port: s.port, bind: s.bind, active: 0 };
      resolve({ ok: true, port: s.port });
    });
    server.on("error", (e) => {
      resolve({ ok: false, message: `端口 ${s.port} 绑定失败：${e.code === "EADDRINUSE" ? "已被占用，请更换端口" : e.message}` });
    });
  });
}

function stop() {
  if (!runtime) return { ok: true };
  const r = runtime;
  runtime = null;
  try {
    r.server.closeAllConnections && r.server.closeAllConnections();
    r.server.close();
  } catch { /* 已关闭 */ }
  return { ok: true };
}

/** 停止并等监听完全释放（换端口/重启监听前调用，避免在途连接被 Reset 或新监听 EADDRINUSE） */
function stopAsync() {
  if (!runtime) return Promise.resolve({ ok: true });
  const r = runtime;
  runtime = null;
  return new Promise((resolve) => {
    try {
      r.server.closeAllConnections && r.server.closeAllConnections();
      r.server.close(() => resolve({ ok: true }));
      setTimeout(() => resolve({ ok: true }), 1000).unref(); // 兜底不阻塞
    } catch {
      resolve({ ok: true });
    }
  });
}

function status() {
  return {
    running: !!runtime,
    port: runtime ? runtime.port : 0,
    bind: runtime ? runtime.bind : "",
    uptime: runtime ? Date.now() - runtime.startedAt : 0,
    active: runtime ? runtime.active : 0,
  };
}

module.exports = { start, stop, stopAsync, status };
