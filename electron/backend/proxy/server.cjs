// 反代网关 · HTTP 服务（方案 §4/§6.1）：Express @ 127.0.0.1:9527（可配置）
// 端点：POST /v1/chat/completions（SSE 双态）/ GET /v1/models / GET /healthz / GET /status（调试，默认关）
// 错误语义对齐 OpenAI：401 invalid_api_key / 429 配额或限流 / 400 参数 / 502 上游 / 503 渠道不可用
// 转发不用现成反代中间件：Dispatch(Key→渠道) → PoolService(号池选号) → Adapter(渠道改写) → SSE 转换输出
"use strict";
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

/** 单账号尝试：401 就地刷新凭证、同渠道重试一次（方案 §6.3 WB 实证，Trae 同理） */
async function attemptChat(channel, acc, model, body, emit) {
  const adapter = adapters.get(channel);
  let secrets = store.accountSecrets(store.getAccount(acc.id));
  try {
    return await adapter.chat({ account: acc, secrets, model, body, emit });
  } catch (e) {
    if (e && e.status === 401) {
      const r = await adapter.refreshToken(acc, secrets).catch(() => ({ ok: false }));
      if (r.ok) {
        store.updateAccount(acc.id, { token: r.token, refreshToken: r.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
        return await adapter.chat({ account: acc, secrets: { token: r.token, refreshToken: r.refreshToken }, model, body, emit });
      }
      pool.coolAccount(acc.id, "relogin");
      // 401 刷新失败 = 这个账号凭证废了，走普通可切换错误换下一个号；
      // 置 fatal 会把整个请求（含其他健康账号、回退模型）一起废掉，与冷却表设计自相矛盾
      throw Object.assign(new Error("凭证失效且自动刷新失败，请到号池重新登录"), { status: 401 });
    }
    throw e;
  }
}

/** 从错误文本解析上游明示的限流重置时间（参考项目实证：「将在 2026-09-17 04:00 重置」）。
 *  对齐墙钟冷却比固定 60s 盲猜准确——重置前换哪个号打这个模型都是白费 */
function parseRateResetMs(text) {
  const m = /将在\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*重置/.exec(String(text || ""));
  if (!m) return 0;
  const t = new Date(m[1].replace(/\//g, "-").replace("T", " ")).getTime();
  return Number.isFinite(t) && t > Date.now() ? t : 0;
}

/** 错误分类（方案 §6.10 冷却表 + 参考项目模型级错误实证）：决定冷却档位与是否换号。
 *  6004 = 模型级限流（罚账号×模型，换模型豁免）；11102 = 该账号不支持此模型（6h 负缓存） */
function classifyUpstream(e, planLimit) {
  if (planLimit || (e && e.status === 402)) return { kind: "credit", switchable: true, status: 402 };
  const msg = String((e && e.message) || "");
  if (/\b6004\b/.test(msg)) return { kind: "model_rate", switchable: true, status: 429 };
  if (/\b11102\b/.test(msg) || /service info not found/i.test(msg)) return { kind: "model_blocked", switchable: true, status: 404 };
  if (e && e.status === 429) return { kind: "rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) };
  if (e && e.status === 401) return { kind: "relogin", switchable: true, status: 401 };
  if (e && e.status === 400) return { kind: "fatal", switchable: false, status: 400 };
  return { kind: "server", switchable: true, status: 502 }; // 5xx / 网络 / 超时
}

/** 按分类落冷却（账号级或账号×模型级）；429 带重置时间的对齐墙钟 */
function applyCool(accId, model, cls, message) {
  const now = Date.now();
  if (cls.kind === "model_rate") {
    pool.coolAccountModel(accId, model, now + 600000, message); // 模型级限流：10min
    return;
  }
  if (cls.kind === "model_blocked") {
    pool.coolAccountModel(accId, model, now + 6 * 3600000, message); // 该号不支持此模型：6h
    return;
  }
  if (cls.kind === "rate" && cls.resetMs) {
    pool.coolAccountModel(accId, model, cls.resetMs, message); // 上游明示重置时间：对齐墙钟
    return;
  }
  pool.coolAccount(accId, cls.kind, message);
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
    events.emit({ type: "request" });
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
  const agg = new util.Aggregator(reqId, requestedModel);

  const emit = (ev) => {
    if (ev.type === "delta") {
      if (!ttftMs) ttftMs = Date.now() - startedAt;
      sentDelta = true;
      if (wantStream) write(util.chunk(reqId, requestedModel, ev.delta));
      else agg.pushDelta(ev.delta);
    } else if (ev.type === "usage") {
      lastUsage = ev.usage;
      if (!wantStream) agg.usage = ev.usage;
    } else if (ev.type === "finish") {
      if (ev.reason) finishReason = ev.reason;
      if (!wantStream) agg.finishReason = finishReason;
    } else if (ev.type === "error") {
      // 流中错误：注入 OpenAI 错误对象后仍发 [DONE]（幂等兜底，方案 §6.3）。
      // 但内容尚未开始时错误不下发——交给换号逻辑，换号成功客户端完全无感（防监测：不暴露多账号切换痕迹）。
      // 无论下没下发都要记账：没出过内容的 error 意味着本次尝试实质失败，不能伪装成 200 空响应
      streamErr = ev;
      if (wantStream && sentDelta) write(`data: ${JSON.stringify(util.openaiError(ev.message, "upstream_error", ev.code || null))}\n\n`);
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
      const strategy = (store.listAgents().find((a) => a.id === resolved.channel) || {}).poolStrategy || "expire_first";
      const tried = new Set();
      for (let attempt = 0; attempt <= 2 && !done; attempt++) {
        const acc = pool.pickAccount(resolved.channel, strategy, [...tried]);
        if (!acc) break;
        tried.add(acc.id);
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
          const r = await attemptChat(resolved.channel, acc, chainModel, body, emitTimed);
          if (r && r.planLimit) {
            pool.coolAccount(acc.id, "credit");
            lastErr = Object.assign(new Error("积分不足"), { status: 402 });
            continue; // 换号
          }
          // 一条内容都没产出却收到过流中 error：本次尝试实质失败（上游业务错误），
          // 冷却换号重试，绝不能记 200 空响应
          if (!sentDelta && streamErr) {
            lastErr = Object.assign(new Error(String(streamErr.message || "上游返回错误")), { status: streamErr.status || 502 });
            applyCool(acc.id, chainModel, classifyUpstream(lastErr, false), lastErr.message);
            streamErr = null;
            continue;
          }
          done = true;
        } catch (e) {
          lastErr = e;
          if (e && e.fatal) {
            fatalErr = e; // 400 参数类等直接透传，不再换号也不回退
            break;
          }
          const cls = classifyUpstream(e, false);
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
        write(util.chunk(reqId, requestedModel, {}, finishReason, usage));
        write(util.DONE);
        res.end();
      } else {
        agg.finishReason = finishReason;
        agg.usage = usage;
        res.json(agg.result());
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
