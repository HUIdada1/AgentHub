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
"use strict";
// Only standard custom providers and explicitly bound external execution.
// Proprietary model HTTP, remediation and error strings belong to the plugin.
const store = require("../proxy/store.cjs");
const pool = require("../proxy/pool.cjs");
const services = require("./services.cjs");
const outbound = require("./outbound.cjs");
const lgwConfig = require("./config.cjs");
const { executeStandard } = require("./standard/executor.cjs");
const { watchAuthority } = require("./requests.cjs");

/**
 * 出站脱敏：把请求体按渠道策略洗一遍（自定义规则 + 内置指纹规则）。
 *
 * ── 为什么在这里接 ────────────────────────────────────────────
 * 渠道是在 server 的 failover 循环里才确定的，所以「渠道特有策略」只有到这里才拿得到。
 * 之前 outbound.cjs 只有 UI 试跑（localgw_outbound_preview）在用，转发链路一直没接，
 * 于是「内置指纹脱敏」开关虽然默认开着、日志里的「敏」列却永远是空的 —— 这条补上。
 *
 * ── 只对标准执行器生效 ────────────────────────────────────────
 * 插件执行器（extension）自己构造请求体、自己处理指纹（见各 provider 的 fingerprint/headers 模块），
 * 宿主再洗一遍会与插件的口径打架；而且插件入参形状由协议约定，宿主不该改。
 *
 * ── 失败一律原样放行 ──────────────────────────────────────────
 * 规则写坏 / 正则炸了 / JSON 循环引用：宁可少脱敏一次，也不能把请求打挂（sanitizeBody 内部已兜）。
 */
function scrubRequest(req, channel) {
  try {
    const policy = outbound.policyFor(channel, lgwConfig.get());
    const r = outbound.sanitizeBody(req, policy);
    return r && r.changed ? { input: r.body, hits: r.hits || "" } : { input: req, hits: "" };
  } catch {
    return { input: req, hits: "" };
  }
}

function applyFailure(accountId, model, cls, message) {
  const now = Date.now();
  const reason = typeof message === "string" ? message.slice(0, 200) : "";
  const reset = Number(cls.resetMs);
  if (["credit", "relogin", "account_blocked"].includes(cls.kind)) pool.coolAccount(accountId, cls.kind, reason);
  else if (cls.kind === "rate") {
    const until = reset > now ? Math.min(reset, now + 86400000) : now + pool.softBackoffMs(accountId);
    pool.coolAccountMs(accountId, until, reason);
  } else if (cls.kind === "server") {
    pool.coolAccountMs(accountId, pool.noteServerError(accountId) || now + 10000, reason);
  } else if (["model_blocked", "model_config", "model_rate", "not_found"].includes(cls.kind)) {
    const fallback = cls.kind === "model_rate" ? pool.softBackoffMs(accountId) : cls.kind === "not_found" ? 60000 : 300000;
    pool.coolAccountModel(accountId, model, reset > now ? Math.min(reset, now + 86400000) : now + fallback, reason);
  }
}

function applyExtensionFailure(accountId, model, error) {
  const scoped = error?.scope;
  if (!["account", "account-model"].includes(scoped)) return;
  const kind = scoped === "account-model"
    ? error.category === "rate" ? "model_rate" : error.status === 404 ? "not_found" : "model_blocked"
    : ({ auth: "relogin", quota: "credit", rate: "rate", account: "account_blocked", upstream: "server" })[error.category];
  if (kind) applyFailure(accountId, model, { kind, resetMs: error.retryAfterMs > 0 ? Date.now() + error.retryAfterMs : 0 }, "模型执行服务报告账号限制");
}

async function forward(req, channel, realModel, modelRequested, ctx = {}, timeoutMs, onEvent = () => {}, signal) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, releaseAuthority;
  const budget = timeoutMs == null ? 120000 : Number(timeoutMs);
  const deadlineAt = budget > 0 ? Date.now() + budget : null;
  try {
    requestSignal.throwIfAborted();
    const ref = Object.hasOwn(ctx, "serviceRef") ? ctx.serviceRef : services.refFor(channel);
    const authorize = () => {
      if (requestSignal.aborted || ctx.authorize && ctx.authorize() !== true) return false;
      try { return JSON.stringify(services.refFor(channel)) === JSON.stringify(ref); }
      catch { return false; }
    };
    // Gate before selection/decryption. An absent plugin has no legacy fallback.
    const captured = services.capture(ref, channel, authorize);
    releaseAuthority = watchAuthority({ controller, tags: { keyId: ctx.apiKeyId, channel }, check() {
      if (authorize() !== true) return false;
      captured.assertCurrent?.();
      return true;
    } });
    requestSignal.throwIfAborted();
    if (budget > 0) timer = setTimeout(() => controller.abort(Object.assign(new Error("请求总时限已到"), { code: "TIMEOUT" })), budget);
    if (captured.ref.kind === "extension") {
      return await captured.executor.execute({ ref: captured.ref, model: realModel, input: req,
        authorize, signal: requestSignal, onEvent, deadlineAt, probe: !!ctx.probe,
        excludeAccounts: [...new Set([...(ctx.excludeAccounts || []), ...(ctx.catalogExcludeAccounts?.() || [])])], attempt: ctx.attempt || 1,
        attemptsRemaining: ctx.attemptsRemaining || 0, attemptLedger: ctx.attemptLedger, idempotencyKey: ctx.idempotencyKey,
        clientHeaders: ctx.clientHeaders, clientRawHeaders: ctx.clientRawHeaders, stateContext: ctx.stateContext,
        catalogModels: ctx.catalogModels });
    }
    // 出站脱敏：拿到渠道后才拿得到策略（见 scrubRequest 注释）
    const scrubbed = scrubRequest(req, channel);
    const result = await executeStandard({ provider: captured.provider, pool, store, model: realModel,
      input: scrubbed.input, signal: requestSignal, onEvent, authorize, probe: !!ctx.probe,
      excludeAccounts: ctx.excludeAccounts || [], attemptLedger: ctx.attemptLedger, deadlineAt, onFailure: applyFailure });
    // 命中摘要回传给 server.cjs 落 oplog 的 sensitiveHits 列（日志页「敏」列的数据源）
    return scrubbed.hits ? { ...result, outboundHits: scrubbed.hits } : result;
  } catch (error) {
    const cancelled = requestSignal.aborted;
    return { ok: false, status: cancelled ? requestSignal.reason?.code === "TIMEOUT" ? 504 : 499 : error.status || 503,
      errCode: cancelled ? requestSignal.reason?.code === "TIMEOUT" ? "timeout" : "cancelled" : error.code || "EXECUTION_SERVICE_UNAVAILABLE",
      failureScope: "service", switchable: false, committed: false, events: [],
      error: cancelled ? "模型调用已取消或超时" : String(error.message || "执行来源不可用") };
  } finally { releaseAuthority?.(); clearTimeout(timer); }
}
module.exports = { forward, applyFailure, applyExtensionFailure };
