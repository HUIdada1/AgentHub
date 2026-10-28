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
// 本地网关 · 转发核心（薄包装）
// 真正干活的是 proxy/adapters.cjs 的 chat()（IR 转换 + SSE 泵 + 错误分类）；
// 本模块只做"挑账号 → 组装调用 → 泵事件到客户端回调"这一薄壳，不重写协议。
// 这样：号池里新增渠道（28+ 内置）自动被网关免改动支持；结算/冷却状态由 pool 统一管理。
"use strict";
const store = require("../proxy/store.cjs");
const pool = require("../proxy/pool.cjs");
const adapters = require("../proxy/adapters.cjs");
const classify = require("../proxy/classify.cjs");
// 出站伪装与清洗：策略在**本层**解析（渠道此刻才确定——server 是在 failover 循环里
// 逐个试渠道的，循环之前根本不知道该用哪份渠道策略），body 清洗在这里做，
// 头覆盖则通过 ALS 上下文让 adapters/util 出口的 applyHeaders 生效。
const lgwConfig = require("./config.cjs");
const outboundHook = require("../proxy/outbound-hook.cjs");
const outbound = require("./outbound.cjs");

/** 模型级冷却上限：上游明示的重置时间再远，也不超过 24h（防止脏时间戳把账号冻住） */
const MODEL_COOL_CAP_MS = 24 * 3600 * 1000;
/** 模型级冷却默认时长：上游没给重置时间时用（对齐归档实现的 24h 口径） */
const MODEL_COOL_DEFAULT_MS = 24 * 3600 * 1000;

/** 把 classifyUpstream 的结果翻译成 pool 需要的两个入参（冷却截止时刻 + 原因文案）。
 *  【审查修正】classifyUpstream 只回 { kind, switchable, status, resetMs? }，
 *  **从不回 coolMs / detail**（见 proxy/classify.cjs，与归档实现一致）。原代码取
 *  `cls.coolMs || 24h` 与 `cls.detail || {}`，实际恒为默认值，表现为两个真实缺陷：
 *   · 6004 模型级限流上游明示的「XXX 重置」被忽略，一律按 24h 冻住；
 *   · 冷却原因被写成 "[object Object]"（{} 是 truthy，String({}) 就是这个字符串）。
 *  resetMs 已是**绝对墙钟**（parseRateResetMs 返回绝对时刻；retryAfterMs 分支也换算成了
 *  Date.now()+剩余时长），所以这里直接当 until 用，并加 24h 上限。 */
function coolPlan(cls, fallbackMsg) {
  const now = Date.now();
  const reset = Number(cls && cls.resetMs);
  const coolMs = Number(cls && cls.coolMs);
  const until = Number.isFinite(reset) && reset > now
    ? Math.min(reset, now + MODEL_COOL_CAP_MS)
    : now + (Number.isFinite(coolMs) && coolMs > 0 ? Math.min(coolMs, MODEL_COOL_CAP_MS) : MODEL_COOL_DEFAULT_MS);
  // 原因：只认非空字符串；对象/数组一律丢弃，回落调用方给的错误文案，再回落空串
  //（pool 侧对空串有各分支的默认文案，绝不会显示成 [object Object]）
  const raw = (cls && (cls.detail || cls.reason)) || fallbackMsg || "";
  const why = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : "";
  return { until, why };
}

/** 渠道 → 在该渠道下选号（按号池策略；与号池管理页 UI 一致）。
 *  rejectReason: no_account / model_blocked（模型被该账号×模型负缓存挡住） */
function pickAccountFor(channel, model, excludeIds) {
  const accs = pool.poolAccounts(channel);
  const strategy = "expire_first";
  // 先看模型级负缓存：账号×模型 冷却中的不能选
  const ids = new Set();
  for (const a of accs) {
    if (a.status !== "online") continue;
    if (model && pool.isModelCooled(a.id, model)) {
      ids.add(a.id);
    }
  }
  const excluded = new Set([...(excludeIds || []), ...[...ids]]);
  const a = pool.pickAccount(channel, strategy, [...excluded]);
  if (!a) return { account: null, reason: "no_account" };
  return { account: a, reason: null };
}

/** 抽凭据（解密）；失败时静默返回 null 让上层回落。
 *  【审查修正·P0】store.accountSecrets(r) 的入参是**数据库原始行**（要读 r.token_enc /
 *  r.refresh_enc / r.meta），而 listAccounts/pickAccount 给的是脱敏视图（无 *_enc 字段）。
 *  原实现传的是 `acc.id` 字符串，导致 decryptSecret(undefined) 恒空 → 每次转发都以
 *  「凭据缺失(no_token)」失败。这里必须先 getAccount(id) 取原始行。 */
function secrets(acc) {
  if (!acc || !acc.id) return null;
  try {
    const row = store.getAccount(acc.id);
    if (!row) return null;
    return store.accountSecrets(row);
  } catch {
    return null;
  }
}

/** 主转发入口：客户端请求 → 渠道适配器 → SSE 事件 → 回给客户端。
 *  事件一到就通过 onEvent 推给客户端（真流式），同时留一份 events 供上层聚合/落账。
 *
 *  @param {object} req          来自 HTTP server 的请求体（OpenAI 格式）
 *  @param {string}  channel     目标渠道 id
 *  @param {string}  realModel   目标实际模型名（已应用 overrides/aliases）
 *  @param {string}  modelRequested 客户端请求的模型名（用于负缓存键）
 *  @param {object}  ctx         { requestId, apiKeyId, apiKeyPrefix }（humanizeJitter 已改由
 *                               outbound policy 决定，ctx 上那个字段保留仅为兼容调用方）
 *  @param {number}  timeoutMs
 *  @param {(ev: any) => Promise<void>|void} onEvent    SSE 事件回调（delta/usage/finish/error）
 *  @param {AbortSignal} signal  客户端 close 时的外部终止信号
 *
 *  返回 { ok, status?, error?, firstByteMs?, errCode?, outboundHits, events? }
 */
async function forward(req, channel, realModel, modelRequested, ctx, timeoutMs, onEvent, signal) {
  ctx = ctx || {};
  // 拟人抖动：默认开（本模块自身配置项，方案 §7）
  // 注：adapters.cjs 内部也有自己的 humanizeJitter（号池配置），不重复——本模块只读 localgw 配置
  // 这里刻意再保留一层是因为对外 API 的限流更接近"人"的请求节奏
  // （生产模式：网络抖动 / 退避已由 adapters 一侧 cover，此层可关）
  // 开关现在从 outbound policy 的 jitter 字段读（见下），透传模式下自动为 false

  // 挑选账号：按号池策略 + 模型级负缓存
  const { account, reason } = pickAccountFor(channel, modelRequested, []);
  if (!account) {
    return { ok: false, status: 503, error: `渠道 ${channel} 当前无可用账号`, errCode: reason || "no_account", outboundHits: "", events: [] };
  }

  const secretsRow = secrets(account);
  if (!secretsRow || !secretsRow.token) {
    return { ok: false, status: 503, error: `渠道 ${channel} 账号 ${account.id} 凭据缺失`, errCode: "no_token", outboundHits: "", events: [] };
  }

  const ad = adapters.get(channel);
  if (!ad) {
    return { ok: false, status: 501, error: `渠道 ${channel} 未注册适配器`, errCode: "no_adapter", outboundHits: "", events: [] };
  }
  if (typeof ad.chat !== "function") {
    // 渠道存在但没有对话能力（只有余额/签到能力的渠道）：提前拦下，避免 TypeError 被归成 502 上游错误
    return { ok: false, status: 501, error: `渠道 ${channel} 不支持对话转发`, errCode: "no_adapter", outboundHits: "", events: [] };
  }

  // 出站伪装与清洗：账号与适配器都已就绪，渠道确定，这里才是渠道特有规则的正确生效点。
  // outboundHits 必须出现在**每一个** return 分支上（含上面的早退分支），
  // 否则 server 落 oplog 时拿到 undefined，请求日志的「敏」列会变成 undefined。
  const policy = outbound.policyFor(channel, lgwConfig.get());
  const san = outbound.sanitizeBody(req, policy);
  const outboundBody = san.body;
  const outboundHits = san.hits;

  // 单次请求的 emit 收集器：每个请求独立一份，绝不跨请求共享
  const events = [];
  let firstEventAt = 0;
  const emit = (ev) => {
    if (!firstEventAt) firstEventAt = Date.now();
    events.push(ev);
    // 真流式：事件一到就回客户端。原实现先攒满再回放，SSE 实际退化成"一次性输出"，
    // 前端与 IDE 会看到"卡很久然后一次性吐完"。
    if (typeof onEvent !== "function") return;
    try {
      const r = onEvent(ev);
      if (r && typeof r.then === "function") r.then(undefined, () => { /* 回写失败（客户端已断）不影响泵 */ });
    } catch { /* 回调异常不能把适配器的解析流程带崩 */ }
  };

  // 租约与超时
  const ac = new AbortController();
  const external = signal || null;
  const onExternalAbort = () => { try { ac.abort(); } catch { /* 已结束 */ } };
  if (external) {
    if (external.aborted) return { ok: false, status: 499, error: "客户端已断开", errCode: "cancelled", events: [] };
    external.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try { ac.abort(new Error("TIMEOUT")); } catch { /* 已结束 */ }
  }, Math.max(1000, Number(timeoutMs) || 120000));
  const t0 = Date.now();
  // 租约必须在 try 内获取：acquireAccount 自身抛错时下面的 finally 不会执行，
  // 会出现"没租到却释放一次"的计数错乱（原实现 acquire 在 try 之外）
  let leased = false;
  try {
    pool.acquireAccount(account.id);
    leased = true;

    // 处理 humanizeJitter（本模块配置）：判断改读 policy.jitter——
    // mode==="passthrough" 时它是 false，透传语义下"不加抖动"才自洽
    if (policy.jitter) {
      const jit = 40 + Math.random() * 180;
      await new Promise((r) => setTimeout(r, jit));
    }

    // 调用渠道适配器（一口气完成 IR 转换 + SSE 解析 + 错误分类）
    // 关键约定（adapters.cjs 顶部）：chat() 不抛错，事件走 emit（含 error）
    // 适配器 chat 返回值：事件走 emit；signal 由 meta 携带（workbuddy_ai 等在 meta 里读）
    // ALS 包裹：让 adapters → util.byteSafeHeaders（以及 catpaw 那条独立链路）在发请求前
    // 取到本次的 policy，从而套用渠道级的头覆盖/移除。run() 返回 fn() 的返回值，
    // ad.chat 的异步续体在上下文内创建，故整个请求生命周期都能看到 policy。
    await outboundHook.run(policy, () => ad.chat({
      account: { ...account, secrets: secretsRow },
      secrets: secretsRow,
      model: realModel,
      body: outboundBody,
      emit,
      meta: { requestId: ctx.requestId, apiKeyId: ctx.apiKeyId, signal: ac.signal },
    }));

    const firstByteMs = firstEventAt ? firstEventAt - t0 : Date.now() - t0;

    // 从 events 流里检出最后一次 error 事件
    const errEv = events.slice().reverse().find((e) => e.type === "error");
    if (errEv) {
      // 走到这里说明上游已有具体错误事件；classify 用于决定是否要冷却账号
      const cls = classify.classifyUpstream(errEv, errEv.planLimit, channel) || {};
      const plan = coolPlan(cls, errEv.message);
      if (cls.kind === "credit" || cls.kind === "relogin" || cls.kind === "rate" || cls.kind === "slow" || cls.kind === "server") {
        pool.coolAccount(account.id, cls.kind, plan.why);
      } else if (cls.kind === "model_blocked" || cls.kind === "model_config" || cls.kind === "model_rate") {
        pool.coolAccountModel(account.id, modelRequested, plan.until, plan.why);
      }
      return {
        ok: false,
        // 超时也会以 error 事件形式浮现（适配器侧 abort），统一映射 504
        status: timedOut ? 504 : (errEv.status || 502),
        error: timedOut ? "上游响应超时" : (errEv.message || "上游错误"),
        firstByteMs,
        errCode: timedOut ? "timeout" : (errEv.code || "upstream_error"),
        outboundHits,
        events,
      };
    }

    pool.noteSuccess(account.id, modelRequested);
    const ms = Date.now() - t0;
    return { ok: true, ms, firstByteMs, outboundHits, events };
  } catch (e) {
    // 适配层异常：落冷却 + 回错给客户端
    const cls = timedOut ? { kind: "timeout" } : (classify.classifyUpstream(e, undefined, channel) || { kind: "unknown" });
    const plan = coolPlan(cls, e && e.message);
    if (cls.kind === "credit" || cls.kind === "relogin" || cls.kind === "rate" || cls.kind === "slow" || cls.kind === "server") {
      pool.coolAccount(account.id, cls.kind, plan.why);
    } else if (cls.kind === "model_blocked" || cls.kind === "model_config" || cls.kind === "model_rate") {
      pool.coolAccountModel(account.id, modelRequested, plan.until, plan.why);
    }
    const ms = Date.now() - t0;
    return {
      ok: false,
      status: timedOut ? 504 : (external && external.aborted ? 499 : 502),
      error: timedOut ? "上游响应超时" : String((e && e.message) || e),
      firstByteMs: firstEventAt ? firstEventAt - t0 : 0,
      ms,
      errCode: timedOut ? "timeout" : (external && external.aborted ? "cancelled" : (cls.kind || "exception")),
      outboundHits,
      events,
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (external) external.removeEventListener("abort", onExternalAbort);
    if (leased) pool.releaseAccount(account.id);
  }
}

module.exports = { forward, pickAccountFor };
