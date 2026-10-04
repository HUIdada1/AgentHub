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
  const owners = adapters.modelOwners(model, settings);
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

/** 渠道综合分：可用账号数 × 号池总余额（方案 §6.2 auto）；降级中的渠道记 0 分——
 *  熔断让位备选，到期半开自动恢复资格（成功一次清零，见 noteChannelSuccess） */
function channelScore(channel) {
  if (channelCooling(channel)) return 0;
  const s = pool.poolSummary(channel);
  return (s.onlineCount > 0 ? 1 : 0) * (1 + s.totalCredits);
}

/** 智能路由打分：可用账号数 × 号池总余额（方案 §6.2 auto） */
function bestByScore(candidates) {
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const score = channelScore(c);
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
    // resetMs 统一为绝对时刻：parseRateResetMs 本就返回墙钟；retryAfterMs 是剩余时长，必须换算。
    // 二者混装会让 coolAccountMs 把时长当时刻，Retry-After: 7200 被 Math.max(now+1s) 兜成 1s 冷却（墙钟对齐失效）
    return { kind: "rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) || (e.retryAfterMs ? Date.now() + e.retryAfterMs : 0) };
  }
  if (e && e.status === 401) return { kind: "relogin", switchable: true, status: 401 };
  if (e && e.status === 404) return { kind: "not_found", switchable: true, status: 404 }; // 短冷却不累计，防雪崩
  if (e && e.status === 400) return { kind: "fatal", switchable: false, status: 400 };
  // 首字节超时（上游迟迟不吐第一个 token）：多为"这次 prompt 太大 / 上游这一刻忙"，
  // 不是账号故障——单独分类，只换号不冷却、也不计入 5xx/网络熔断
  if (e && e.firstByteTimeout) return { kind: "slow", switchable: true, status: 504 };
  return { kind: "server", switchable: true, status: 502 }; // 5xx / 网络 / 超时
}

/** WAF/渠道级故障识别：WAF Block Page（HTML）与渠道白名单 11128 都不是账号问题——
 *  拦的是 IP/指纹/渠道，换号照拦。正确反应是渠道级短退避 + 如实报错，绝不能逐个冷却账号 */
function isWafBlock(e) {
  return /WAF Block Page/i.test(String((e && e.body) || (e && e.message) || ""));
}

function isChannelBlock(e) {
  return isWafBlock(e) || /\b11128\b/.test(String((e && e.message) || ""));
}

/** 可触发渠道降级的错误类别：上游/余额/限流/凭证类。400 参数 / 11101 参数 / 11115 超长 /
 *  4001 模型配置类不降级——换渠道也救不了，罚渠道是冤枉 */
const DEGRADABLE = new Set(["credit", "rate", "server", "relogin", "model_rate", "model_blocked", "not_found"]);

// ===== 渠道健康状态机：normal → degraded（降级，流量走备选）→ 半开（到期重获资格）→ 正常/再降级 =====
// 内存态不落库（本机流量调度状态；重启后首请求撞一次墙即自愈重建）。streak 驱动指数退避防震荡
const channelHealth = new Map(); // channel → { until, reason, streak, lastHit }

// 渠道连续失败计数：连续 2 次「真实打过上游仍打光」才降级——单次失败只做请求内跳备选
//（客户端已无感），保留账号侧「单次 5xx 不罚号」的防雪崩节奏（历史 issue #2：一次抖动
// 罚满冷却会把号池打空）；间隔超 60s 的失败不算连续。成功清零（noteChannelSuccess）
const channelFailStreaks = new Map(); // channel → { n, last }

/** 渠道连续失败计数（≥2 触发降级）；WAF/11128 渠道级拦截不走此计数（一锤定音直接降级） */
function noteChannelFail(channel) {
  const now = Date.now();
  const cur = channelFailStreaks.get(channel);
  const n = cur && now - cur.last < 60000 ? cur.n + 1 : 1;
  channelFailStreaks.set(channel, { n, last: now });
  return n;
}

/** 渠道降级时长：base × 2^streak 封顶 cap（settings 可调；cap 至少不低于 base） */
function degradeDuration(streak, settings) {
  const base = Number(settings && settings.channelCooldownMs) > 0 ? Number(settings.channelCooldownMs) : 120000;
  const cap = Number(settings && settings.channelCooldownCapMs) > 0 ? Number(settings.channelCooldownCapMs) : base * 8;
  return Math.min(base * Math.pow(2, Math.min(streak, 10)), Math.max(cap, base));
}

/** 渠道降级（半开 + 指数退避）：渠道耗尽 / 上游边缘拦截 / 全模型负缓存时整体让位备选渠道。
 *  streak 语义：同一波（并发请求同时打光，间隔 < 基础时长一半，产品默认 120s 下即 10s 内）
 *  只延不升级；30 分钟内的再次触发（半开探测再失败）streak+1 时长翻倍；超过 30 分钟重开。
 *  请求成功清零。until 与现存条目取 max——并发触发不能互相缩短冷却 */
function degradeChannel(channel, reason, settings) {
  const now = Date.now();
  const cur = channelHealth.get(channel);
  const wave = cur ? Math.min(10000, degradeDuration(0, settings) / 2) : 0;
  const gap = cur ? now - (cur.lastHit || 0) : Infinity;
  const streak = cur ? (gap < wave ? (cur.streak || 0) : gap < 30 * 60000 ? (cur.streak || 0) + 1 : 0) : 0;
  const until = Math.max((cur && cur.until) || 0, now + degradeDuration(streak, settings));
  const why = reason || (cur && cur.reason) || "";
  channelHealth.set(channel, { until, reason: why, streak, lastHit: now });
  events.emit({ type: "channel-health", channel, state: "degraded", until, reason: why, streak });
}

/** 渠道降级状态查询：到期只判过期不删条目（半开后 streak 还要用来翻倍），
 *  条目由 noteChannelSuccess（成功清零）覆盖更新；渠道数固定，无内存膨胀 */
function channelCooling(channel) {
  const hit = channelHealth.get(channel);
  if (!hit || hit.until <= Date.now()) return null;
  return hit;
}

/** 请求在该渠道真实成功 → 渠道恢复完全体（streak 一并清零，下次降级从基础时长重新开始） */
function noteChannelSuccess(channel) {
  if (!channel) return;
  channelFailStreaks.delete(channel);
  if (channelHealth.has(channel)) {
    channelHealth.delete(channel);
    events.emit({ type: "channel-health", channel, state: "ok" });
  }
}

/** 渠道健康快照（号池 IPC 与 /status 端点展示降级状态、原因与回切倒计时） */
function channelHealthSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [ch, v] of channelHealth) {
    if (v.until > now) out[ch] = { until: v.until, reason: v.reason || "", streak: v.streak || 0 };
  }
  return out;
}

/** 按分类落冷却（账号级或账号×模型级）；429 优先对齐上游明示时间（墙钟/Retry-After），
 *  都没有时走有界指数退避；模型配置/参数/超长错误零动作不罚号 */
function applyCool(accId, model, cls, message) {
  if (!accId) return;
  // 参数/模型配置类错误与账号无关，不罚号也不记错；其余落冷却的错误都记入账号最近错误（号池气泡展示）
  // slow（首字节超时）同样不记错：它是"这次请求太大/上游这一刻慢"，记在账号上只会留下误导性的
  // 长期错误气泡（实测一次 54 万 token 请求超时，账号卡片挂了两天的"上游首字节超时"）
  if (cls.kind !== "model_config" && cls.kind !== "bad_params" && cls.kind !== "prompt_too_long" && cls.kind !== "slow" && message) {
    store.noteError(accId, message);
  }
  switch (cls.kind) {
    case "model_config": // 4001 模型配置为空：模型问题不是账号问题，不罚号
    case "bad_params": // 11101：参数问题不罚号（换号仍会发生，由外层轮转决定）
    case "prompt_too_long": // 11115：同一 body 换任何号都超限，零动作
    case "slow": // 首字节超时：请求/上游侧的慢，账号本身没问题，零冷却（外层仍会换号重试）
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
  // 角色归一（issue #47）：各渠道上游 role 白名单互相冲突（workbuddy 拒 developer、
  // raccoon 拒 function），而 400 会触发渠道回退，导致同一条请求能否成功取决于命中
  // 哪个渠道。入口处统一收敛到所有渠道都接受的交集角色，避免逐渠道维护白名单表。
  util.normalizeRoles(body.messages);
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
    const hint = adapters.listableModels(settings).map((m) => m.id).join(", ");
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
    // 成功收尾的 record() 在模型回退链之外，读不到链内声明的 targetModel；这里在链外承接
    // 「真正发给上游的模型名」供 record 记 rev→ 归因。链路一漏，每个成功请求都会在记账时抛
    // ReferenceError，被外层 catch 落成 502/0 token 的假流水（v1.30.0 起曾如此）。
    let usedTargetModel = actualModel;
    // 跨渠道故障转移的请求级状态：全局上游尝试预算 / 渠道轨迹 / failover 归因
    const maxTries = 6 * modelChain.length; // 每个模型 6 次上游尝试（跨渠道共享；429 就地重试、
    // 401 刷新重试各计 1）。按模型链长度放大：预算按请求计但逐模型消耗，避免主模型耗尽预算后饿死回退模型
    let upstreamTries = 0;
    const triedChannels = []; // 本请求跳过或耗尽的渠道轨迹（最终错误消息用）
    let failoverFrom = "";    // 成功渠道 ≠ 主渠道时记录 failover:主→实（记账轨迹）
    let planLimitEnd = false; // planLimit（402）流中已出线的就地收尾：不是真成功，不清渠道降级态
    for (const chainModel of modelChain) {
      if (done || fatalErr) break;
      if (upstreamTries >= maxTries) break; // 上游尝试预算用尽：不再开新渠道/新模型
      const resolved = resolveChannel(key, chainModel, settings);
      if (!resolved.channel) {
        lastErr = Object.assign(new Error(`模型 "${chainModel}" 不在任何渠道目录中`), { status: 400 });
        continue; // 未知模型 → 尝试回退模型
      }
      usedModel = chainModel;
      // ===== 渠道候选队列（跨渠道故障转移）：主渠道尊重全部现有路由语义（单源强制 /
      // key.route / per-model 覆盖 / fixed / 智能打分），备选 = 拥有该模型的其余渠道按
      // 综合分（健康×余额）降序。主渠道降级或耗尽时请求内直接跳备选（客户端无感），
      // 全部候选走完才报错。单渠道模型无备选可跳（模型目录的物理边界，靠回退模型兜底）
      const owners = adapters.modelOwners(chainModel, settings).filter((c) => c !== resolved.channel);
      owners.sort((a, b) => channelScore(b) - channelScore(a));
      const queue = [resolved.channel, ...owners];
      queue.length = Math.min(
        queue.length,
        settings.channelFailover === false ? 1 : Math.max(1, Number(settings.channelFailoverMax) || 3)
      );
      const primaryChannel = queue[0];
      for (const chan of queue) {
        if (done || fatalErr) break;
        if (upstreamTries >= maxTries) break;
        // 渠道降级中（熔断窗口）：跳过不撞墙；每轮重查——备选可能在排队期间刚被并发请求打光降级
        const chCool = channelCooling(chan);
        if (chCool) {
          if (!lastErr) {
            lastErr = Object.assign(new Error(`渠道 ${chan} 降级中（${chCool.reason || "渠道级退避"}），${Math.ceil((chCool.until - Date.now()) / 1000)}s 后回切重试`), { status: 503 });
          }
          triedChannels.push(chan);
          continue;
        }
        usageRow.channel = chan;
        // 反向映射：统一请求模型名 → 该渠道的实际模型名（映射按渠道，换渠道必须重算）
        let targetModel = chainModel;
        const revAliases = settings.modelReverseAliases || {};
        let revEntry = revAliases[chainModel];
        if (!revEntry) {
          const lowerChain = chainModel.toLowerCase();
          for (const [k, v] of Object.entries(revAliases)) {
            if (k.toLowerCase() === lowerChain) { revEntry = v; break; }
          }
        }
        if (revEntry && typeof revEntry === "object" && revEntry[chan]) {
          targetModel = revEntry[chan];
        }
        usedTargetModel = targetModel; // 承接给链外 record()，见上面的声明注释
        const strategy = (store.listAgents().find((a) => a.id === chan) || {}).poolStrategy || "expire_first";
        const tried = new Set();
        const rateRetried = new Set(); // 无明示时间的 429 同号退避重试标记（每号限一次）
        // 每账号并发租约：expire_first 排序与并发无关，同窗口并发会话否则全打同一账号（参考项目租约语义）
        const perAccountLimit = Number(settings.concurrencyPerAccount) > 0 ? Number(settings.concurrencyPerAccount) : 3;
        let poolEmpty = false; // 号池无可用账号（全冷却/耗尽/负缓存打光）
        let realTries = 0;     // 本渠道真实上游尝试次数（区分「打过但失败」与「没打就打光」）
        let modelCooledSkips = 0; // 负缓存跳过次数（6004/11102 是账号×模型粒度，不是渠道的错）
        let degradedHere = ""; // 本渠道已就地降级过（WAF/11128），耗尽判定不再重复降级
        let budgetOut = false; // 上游尝试预算用尽跳出（不是渠道的错，不降级）
        for (let attempt = 0; attempt <= 2 && !done; attempt++) {
          if (upstreamTries >= maxTries) { budgetOut = true; break; }
          const acc = pool.pickAccount(chan, strategy, [...tried], perAccountLimit);
          if (!acc) { poolEmpty = true; break; }
          tried.add(acc.id);
          // 模型级负缓存（6004 模型级限流 / 11102 该号不支持此模型）：直接换号，不浪费一次上游请求。
          // 不计入换号次数（attempt--）：已 tried 集合单调增长，全 cooled 时 pickAccount 返回 null 自然 break，不会死循环。
          // 注意：负缓存跳过分支绝不能提前占用租约，否则未进请求 try/finally 导致在途计数永久泄漏死锁
          if (pool.isModelCooled(acc.id, targetModel)) {
            lastErr = Object.assign(new Error(`模型 "${targetModel}" 在该账号冷却中`), { status: 429 });
            modelCooledSkips++;
            attempt--;
            continue;
          }
          pool.acquireAccount(acc.id);
          upstreamTries++; // 全局上游尝试预算（负缓存跳过不计；429 就地重试走下一轮自然再计）
          realTries++;
          usageRow.accountId = acc.id;
          usageRow.accountName = acc.name;
          try {
            // 拟人抖动（方案 §9：不超单人使用强度的限速与随机抖动）：每次上游请求前随机停 40~220ms，
            // 把机器式的瞬时连发抹成真实客户端节奏，降低被上游风控识别为反代的概率
            if (settings.humanizeJitter !== false) {
              await new Promise((r) => setTimeout(r, 40 + Math.random() * 180));
            }
            let r = null;
            resetAttemptState(); // 上一次尝试的输出不得带进本轮（详见函数注释）
            // 自定义模型参数覆盖（modelCustom：上下文长度 / 最大输出 Token / 思考强度）
            const custom = (settings.modelCustom || {})[chainModel] || (settings.modelCustom || {})[targetModel] || null;
            let effectiveBody = body;
            if (custom && typeof custom === "object") {
              effectiveBody = { ...body };
              if (typeof custom.maxOutputTokens === "number" && custom.maxOutputTokens > 0) {
                effectiveBody.max_tokens = custom.maxOutputTokens;
                effectiveBody.max_completion_tokens = custom.maxOutputTokens;
              }
              if (typeof custom.contextLength === "number" && custom.contextLength > 0) {
                effectiveBody.prompt_max_tokens = custom.contextLength;
                effectiveBody.context_length = custom.contextLength;
              }
              if (custom.reasoningEffort) {
                if (custom.reasoningEffort === "off") {
                  effectiveBody.reasoning_effort = "off";
                  effectiveBody.thinking = { type: "disabled" };
                } else {
                  effectiveBody.reasoning_effort = custom.reasoningEffort;
                  effectiveBody.thinking = { type: "enabled" };
                }
              }
            }
            r = await attemptChat(chan, acc, targetModel, effectiveBody, emitTimed, chatMeta);
            if (r && r.planLimit) {
              pool.coolAccount(acc.id, "credit");
              lastErr = Object.assign(new Error("积分不足"), { status: 402 });
              // 积分耗尽常以流中 error 事件返回（trae 1005 / workbuddy 402），此时正文可能已出线。
              // 流式下换号重发会让客户端收到「半截旧答 + 完整新答」，就地收尾不再换号；
              // 非流式可以换，下一轮 attemptChat 前的 resetAttemptState 会重建 agg 防拼接
              if (wantStream && sentDelta) { done = true; planLimitEnd = true; break; }
              continue; // 换号
            }
            // 一条内容都没产出却收到过流中 error：本次尝试实质失败（上游业务错误），
            // 冷却换号重试，绝不能记 200 空响应
            if (!sentDelta && streamErr) {
              // 流内的渠道级拦截同样按渠道级降级处理（WAF 也可能在流中返回拦截页）
              if (isChannelBlock(streamErr)) {
                degradeChannel(chan, isWafBlock(streamErr) ? "WAF Block" : "渠道白名单 11128", settings);
                store.noteError(acc.id, String(streamErr.message || "渠道被上游边缘拦截"));
                lastErr = Object.assign(new Error(`渠道 ${chan} 被上游边缘拦截，已降级跳备选渠道`), { status: 503 });
                degradedHere = "block";
                streamErr = null;
                break;
              }
              lastErr = Object.assign(new Error(String(streamErr.message || "上游返回错误")), {
                status: streamErr.status || 502,
                code: streamErr.code || 0,
              });
              applyCool(acc.id, targetModel, classifyUpstream(lastErr, false), lastErr.message);
              streamErr = null;
              continue;
            }
            done = true;
            if (chan !== primaryChannel) failoverFrom = primaryChannel; // 记账轨迹：实际走的是备选渠道
          } catch (e) {
            lastErr = e;
            // 已向客户端输出过内容：绝不能换号重发（客户端会收到「半截旧回答 + 完整新回答」拼接）。
            // 就地收尾，本轮以错误结束，由客户端下一次请求自然重试
            if (sentDelta || ttftMs) {
              fatalErr = Object.assign(new Error(`上游流已输出后中断：${String((e && e.message) || "未知错误").slice(0, 200)}`), { status: 502 });
              break;
            }
            // WAF Block / 渠道白名单 11128：渠道级故障——降级整个渠道（指数退避），不换号不罚号，跳备选继续
            if (isChannelBlock(e)) {
              degradeChannel(chan, isWafBlock(e) ? "WAF Block" : "渠道白名单 11128", settings);
              store.noteError(acc.id, String(e.message || "渠道被上游边缘拦截"));
              lastErr = Object.assign(
                new Error(`渠道 ${chan} 被上游边缘拦截（${isWafBlock(e) ? "WAF Block Page" : "渠道白名单 11128"}）：与账号无关，已跳备选渠道`),
                { status: 503 }
              );
              degradedHere = "block";
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
            applyCool(acc.id, targetModel, cls, e.message);
            if (!cls.switchable) {
              fatalErr = e;
              break;
            }
          } finally {
            pool.releaseAccount(acc.id);
          }
        }
        // 渠道尝试结束仍未成功：连续 2 次「真实打过上游仍打光」才降级渠道（后续请求直接走
        // 备选）；单次失败只做了请求内跳备选（客户端已无感），不降级——保留账号侧「单次 5xx
        // 不罚号」的防雪崩节奏。纯本地打光（全冷却/耗尽/负缓存跳过）也不降级：号池状态是
        // 实时派生的（cooling 到期自动复活、新账号入池立即可用、负缓存只罚账号×模型），
        // 渠道级再缓存一份反而会把「已恢复」的渠道错误地挡在门外。
        // 预算用尽跳出与 WAF/11128 已就地降级的不重复处理
        if (!done && !fatalErr && !budgetOut) {
          triedChannels.push(chan);
          if (!degradedHere && realTries > 0 && lastErr) {
            const cls = classifyUpstream(lastErr, false);
            if (DEGRADABLE.has(cls.kind) && noteChannelFail(chan) >= 2) {
              degradeChannel(chan, String(lastErr.message || cls.kind).slice(0, 120), settings);
            }
          }
        }
      }
      // 当前模型渠道队列走完（含备选）→ 链到下一模型（lastErr 保留为最终错误）
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
      // 成功收尾：清软限流 streak / 凭证失效计数 / 该账号该模型的负缓存（键用 targetModel，
      // 与 applyCool/isModelCooled 同键）；渠道侧一并恢复完全体——planLimit 就地收尾（402 半截）
      // 不算真成功，不清渠道降级态（并发场景下会把别人刚熔断的渠道误放回来）
      pool.noteSuccess(usageRow.accountId, usedTargetModel);
      if (!planLimitEnd) noteChannelSuccess(usageRow.channel);
      // 上游 usage.credit 实际扣减余额（参考项目 NoteModelCost）：两次定时刷新之间
      // 余额不再虚高，「余额不足自动切换」更实时；无限额度哨兵(-1)与估算 usage 不扣
      const creditUsed = Number(usage.credit ?? usage.total_credit ?? 0) || 0;
      if (usageRow.accountId && creditUsed > 0) {
        const cur = store.getAccount(usageRow.accountId);
        if (cur && typeof cur.credits === "number" && cur.credits > 0) {
          store.updateAccount(usageRow.accountId, { credits: Math.max(0, cur.credits - creditUsed), creditsAt: Date.now() });
        }
      }
      // 记账轨迹：别名 / 跨渠道 failover / 模型回退 / 反向映射可同时发生，改为拼接而非互斥三目
      const errParts = [];
      if (actualModel !== requestedModel) errParts.push("alias→" + actualModel);
      if (failoverFrom) errParts.push(`failover:${failoverFrom}→${usageRow.channel}`);
      if (usedModel !== actualModel) errParts.push("fallback→" + usedModel);
      else if (usedTargetModel !== actualModel) errParts.push("rev→" + usedTargetModel);
      record({
        status: 200, ttftMs, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        // 缓存 token：OpenAI 语义取 prompt_tokens_details.cached_tokens，Anthropic 上游取 cache_read_input_tokens
        cacheReadTokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0,
        error: errParts.join(" "),
      });
      return;
    }

    // 全部渠道/账号用尽：如实报错并带渠道轨迹（单请求尝试预算用尽时由 lastErr 消息如实说明）
    const st = (lastErr && lastErr.status) || 503;
    let msg = st === 402 ? "该渠道号池积分全部耗尽" : (lastErr && lastErr.message) || "渠道暂不可用（号池无可用账号）";
    const triedUnique = [...new Set(triedChannels)];
    if (triedUnique.length > 1) msg = `已尝试 ${triedUnique.length} 个渠道（${triedUnique.join("→")}）均不可用：${msg}`;
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

  // 模型目录：三渠道合并视图，鉴权可选（方案 §6.1）；停用模型不对外列出（调不通就不给看，省下游翻找）
  app.get("/v1/models", (_req, res) => {
    res.json({ object: "list", data: adapters.listableModels(settings()) });
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
      channelHealth: channelHealthSnapshot(),
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

module.exports = { start, stop, stopAsync, status, channelHealthSnapshot, classifyUpstream };
