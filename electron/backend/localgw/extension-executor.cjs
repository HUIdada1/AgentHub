"use strict";
// Provider-neutral gateway execution. Dependencies are the ORIGINAL pool and the
// manager-owned scoped service; no provider, private HTTP or management registry.
const { randomUUID } = require("node:crypto");
const { hasContent, failure } = require("../extensions/provider-protocol.cjs");
const { revoked } = require("../extensions/authority-watch.cjs");
const { createAttemptLedger } = require("../extensions/attempt-ledger.cjs");

function mergeUsage(previous, incoming, mode) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergeUsage(result[key] || {}, value, mode);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) throw failure("PLUGIN_PROTOCOL", "Invalid model usage", { scope: "service", replay: "unknown" });
      result[key] = mode === "delta" ? (Number(result[key]) || 0) + value : value;
    }
  }
  return result;
}

function createExtensionExecutor({ pool, poolService, onSuccess = () => {}, onFailure = () => {}, onDiagnostic = () => {} }) {
  if (!["pickAccount", "accountPlan", "acquireAccount", "releaseAccount"].every(key => typeof pool?.[key] === "function")
    || typeof poolService?.capture !== "function") throw new TypeError("Extension executor requires the existing pool and service");

  async function execute({ ref, model, input, authorize, onEvent, signal, deadlineAt,
    invocationId = randomUUID(), excludeAccounts = [], probe = false, attempt = 1, attemptsRemaining = 0, attemptLedger, idempotencyKey, clientHeaders, clientRawHeaders, stateContext, catalogModels }) {
    // Capture identity BEFORE touching the pool. Never adopt a newly restarted or
    // substituted service between selection and the invocation grant.
    const captured = poolService.capture(ref, authorize);
    ref = captured.ref;
    const requestHeaders = captured.requestHeaders?.(clientHeaders, clientRawHeaders) || {};
    // Internal probes get a fresh invocation-only partition, never a default
    // administrator. Model input cannot supply its own audience or stateScope.
    const stateScope = captured.session.supports?.("state-scope@1")
      ? captured.stateScope(stateContext === undefined
        ? { audience: "invocation:" + randomUUID(), authorizationVersion: "1" }
        : stateContext()) : undefined;
    const unbounded = deadlineAt === null;
    if ((!unbounded && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())) || typeof onEvent !== "function") {
      throw failure("INVOCATION_INPUT", "Invalid model execution deadline or consumer", { status: 400, scope: "invocation", replay: "safe" });
    }
    if (!captured.session.supports?.("attempt-reservation@1") || (unbounded && !captured.session.supports?.("unbounded-deadline@1"))
      || ((unbounded || deadlineAt > Date.now() + poolService.maxGrantLifetimeMs) && !captured.session.supports?.("scoped-grant-rotation@1"))) {
      throw failure("PLUGIN_FEATURE_UNAVAILABLE", "插件不支持本次调用所需的协议能力", { status: 503, scope: "service", replay: "safe" });
    }
    signal?.throwIfAborted();
    attemptLedger?.assertAvailable();
    // Probe preserves the old read-only selection: accountPlan, no lastUsed update.
    const account = probe
      ? pool.accountPlan(ref.channel, undefined, excludeAccounts, 0, model).find(row => row.eligible)?.account
      : pool.pickAccount(ref.channel, undefined, excludeAccounts, 0, model);
    if (!account) throw failure("NO_ACCOUNT", "渠道当前无可用账号", { status: 503, scope: "invocation", replay: "safe" });
    const ownsLedger = !attemptLedger;
    const ledger = attemptLedger || createAttemptLedger({ limit: Math.min(10, Math.max(1, 1 + attemptsRemaining)), deadlineAt, signal });
    // Only facts for this invocation; never export connection identity or grant
    // material. A reported model does not change the binding or pool callbacks.
    const executionFacts = () => ledger.snapshot().filter(row => row.invocationId === invocationId && row.facts)
      .map(row => ({ attemptId: row.id, number: row.number, ...row.facts }));

    let leased = false, grant, committed = false, usage = {}, replay = "unknown", unsafe = false, rotationTimer, rotationTask, grantAbort;
    const controller = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let firstContentAt = 0, finish;
    const startedAt = Date.now();
    function scheduleRotation() {
      if (runSignal.aborted || !unbounded && grant.expiresAt >= deadlineAt) return;
      rotationTimer = setTimeout(() => {
        rotationTask = captured.session.rotateGrant(invocationId, () => grant.renew())
          .then(rotated => { if (rotated) scheduleRotation(); })
          .catch(error => { controller.abort(error); });
      }, Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 2)));
      rotationTimer.unref?.();
    }
    try {
      runSignal.throwIfAborted();
      captured.assertCurrent();
      pool.acquireAccount(account.id);
      leased = true;
      grant = captured.open({ invocationId, accountId: account.id, deadlineAt, purpose: "invoke", attemptLedger: ledger, catalogModels });
      grantAbort = () => controller.abort(grant.signal.reason);
      grant.signal?.addEventListener("abort", grantAbort, { once: true });
      if (grant.signal?.aborted) grantAbort();
      runSignal.throwIfAborted();
      scheduleRotation();
      await captured.session.invoke({ invocationId, providerId: ref.providerId, channel: ref.channel,
        model, input, grantId: grant.grantId, deadlineAt, attempt, attemptsRemaining, attemptBudget: true,
        onReplayBarrier: () => ledger.preventReplay(), idempotencyKey, requestHeaders, stateScope, signal: runSignal,
        async onEvent(event, consumeSignal) {
          grant.assertCurrent();
          runSignal.throwIfAborted();
          if (event.type === "checkpoint") {
            unsafe ||= event.replay === "unsafe";
            replay = unsafe ? "unsafe" : event.replay;
          } else if (event.type === "usage") {
            usage = mergeUsage(usage, event.usage, event.mode);
          } else if (event.type === "delta") {
            if (hasContent(event.delta)) {
              if (!firstContentAt) firstContentAt = Date.now();
              // Conservatively committed before handing off: a consumer may
              // write part of a multi-frame event and then throw.
              committed = true;
            }
            await onEvent(event, consumeSignal);
          } else if (event.type === "finish") {
            finish = event.reason;
          }
          captured.assertCurrent();
        }
      });
      const events = [];
      if (Object.keys(usage).length) {
        const event = { type: "usage", mode: "snapshot", usage };
        events.push(event);
        await onEvent(event, runSignal);
      }
      if (finish !== undefined) {
        const event = { type: "finish", reason: finish };
        events.push(event);
        await onEvent(event, runSignal);
      }
      runSignal.throwIfAborted();
      captured.assertCurrent();
      if (!probe) {
        try { await onSuccess(account.id, model); }
        catch { try { onDiagnostic({ code: "POOL_SUCCESS_RECORD_FAILED", invocationId }); } catch { /* Reporting cannot re-execute a model. */ } }
      }
      return { ok: true, accountId: account.id, committed, events, replay, executionFacts: executionFacts(),
        ms: Date.now() - startedAt, firstByteMs: firstContentAt ? firstContentAt - startedAt : 0 };
    } catch (cause) {
      // A permission/account mutation may race a pool callback and produce an
      // RPC error before the idle observer runs. Preserve cancellation semantics
      // and never cool the account for this revoked authority.
      if (grant && !runSignal.aborted) {
        try { grant.assertCurrent(); } catch { controller.abort(revoked()); }
      }
      const isCancelled = signal?.aborted || controller.signal.aborted && controller.signal.reason?.code === "AUTHORIZATION_REVOKED";
      const cancelReason = signal?.aborted ? signal.reason : controller.signal.reason;
      // The private classifier belongs to the plugin. A service/protocol fault
      // must never be fed into the management adapter's error classifier.
      const scope = cause?.scope || "service";
      const result = { ok: false, accountId: account.id, committed, executionFacts: executionFacts(),
        replay: unsafe || committed ? "unsafe" : cause?.replay || replay,
        status: isCancelled ? cancelReason?.code === "TIMEOUT" ? 504 : 499 : cause?.status || 502,
        errCode: isCancelled ? cancelReason?.code === "TIMEOUT" ? "timeout" : "cancelled" : cause?.code || "PLUGIN_EXECUTION_FAILED",
        category: cause?.category || "protocol", failureScope: scope,
        error: isCancelled ? "模型调用已取消或超时" : "模型执行失败，请查看脱敏诊断",
        events: Object.keys(usage).length ? [{ type: "usage", mode: "snapshot", usage }] : [],
        ms: Date.now() - startedAt, firstByteMs: firstContentAt ? firstContentAt - startedAt : 0 };
      // Replay safety and retry desirability are separate: a deterministic
      // rejection can be safe to replay yet cannot be fixed by switching accounts.
      result.switchable = !isCancelled && !committed && result.replay === "safe" && cause?.retryable !== false;
      if (!probe && ["account", "account-model"].includes(scope) && !isCancelled) {
        try { await onFailure(account.id, model, cause); }
        catch { try { onDiagnostic({ code: "POOL_FAILURE_RECORD_FAILED", invocationId }); } catch { /* Keep original result and cleanup. */ } }
      }
      return result;
    } finally {
      clearTimeout(rotationTimer);
      grant?.signal?.removeEventListener("abort", grantAbort);
      controller.abort();
      await rotationTask;
      // Even an injected cleanup/reporting exception must not leak the ORIGINAL
      // concurrency slot. The gateway does not create another account scheduler.
      try { grant?.close(); }
      finally { try { if (leased) pool.releaseAccount(account.id); } finally { if (ownsLedger) ledger.close(); } }
    }
  }
  return Object.freeze({ execute });
}
module.exports = { createExtensionExecutor };
