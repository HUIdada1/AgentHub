"use strict";
const { makeOpenaiCompat } = require("./openai-compat.cjs");
const transport = require("../../proxy/transport-context.cjs");
const { hasContent } = require("../../extensions/provider-protocol.cjs");
const { authority } = require("../../extensions/authority-watch.cjs");
const { createAttemptLedger } = require("../../extensions/attempt-ledger.cjs");
const { randomUUID } = require("node:crypto");

function classify(error) {
  const status = Number(error?.status) || 502;
  if (error?.netproxy) return { kind: "egress", status, scope: "service", switchable: true };
  if (error?.firstByteTimeout || error?.idleTimeout) return { kind: "slow", status: 504, scope: "invocation", switchable: true };
  const kind = status === 402 ? "credit" : status === 401 ? "relogin" : status === 429 ? "rate" : status === 404 ? "not_found" : status >= 500 ? "server" : "fatal";
  return { kind, status, scope: status === 404 ? "account-model" : [401, 402, 429].includes(status) || status >= 500 ? "account" : "invocation",
    switchable: status !== 400 && status !== 413, resetMs: error?.retryAfterMs > 0 ? Date.now() + error.retryAfterMs : 0 };
}

async function executeStandard({ provider, pool, store, model, input, signal, onEvent, authorize, excludeAccounts = [], probe = false, onFailure, attemptLedger, deadlineAt = null, pinAccountId = "" }) {
  if (authorize() !== true) throw Object.assign(new Error("执行来源未授权"), { status: 403 });
  signal?.throwIfAborted();
  attemptLedger?.assertAvailable();
  const account = probe ? pool.accountPlan(provider.id, undefined, excludeAccounts, 0, model).find(row => row.eligible)?.account
    : pool.pickAccount(provider.id, undefined, excludeAccounts, 0, model, pinAccountId);
  if (!account) return { ok: false, status: 503, errCode: "no_account", error: "渠道当前无可用账号", switchable: true, events: [] };
  let leased = false, committed = false, firstAt = 0, usage, finish, releaseAuthority, attemptScope, reservation;
  const ownsLedger = !attemptLedger;
  const ledger = attemptLedger || createAttemptLedger({ deadlineAt, signal });
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const started = Date.now();
  try {
    signal?.throwIfAborted();
    if (authorize() !== true) throw Object.assign(new Error("执行来源未授权"), { status: 403 });
    pool.acquireAccount(account.id); leased = true;
    const live = store.getAccount(account.id);
    const identityStamp = row => JSON.stringify([row?.id, row?.channel, row?.uid, row?.created_at]);
    const originalIdentity = identityStamp(live);
    releaseAuthority = authority.watch({ controller, tags: { accountId: account.id, channel: provider.id }, check() {
      const current = store.getAccount(account.id);
      return authorize() === true && !!current && current.status !== "disabled" && identityStamp(current) === originalIdentity;
    } });
    signal.throwIfAborted();
    const secrets = live && store.accountSecrets(live);
    if (!secrets?.token) throw Object.assign(new Error("账号凭据缺失"), { status: 401 });
    const adapter = makeOpenaiCompat(provider);
    attemptScope = ledger.open({ invocationId: randomUUID(), accountId: account.id, connection: `standard:${provider.id}`, authorize });
    reservation = attemptScope.reserve("initial");
    attemptScope.start(reservation.attemptId);
    // 账号级出口：accountId 交给 transport 上下文，netproxy 据此优先用账号绑定的出口
    await transport.run({ signal, accountId: account.id }, () => adapter.chatAwaited({ secrets, model, body: input,
      async emit(event) {
        signal?.throwIfAborted();
        if (authorize() !== true) throw Object.assign(new Error("执行来源未授权"), { status: 403 });
        if (event.type === "error") throw event;
        if (event.type === "usage") { usage = event; return; }
        if (event.type === "finish") { if (event.reason || !finish) finish = event; return; }
        if (event.type === "delta") {
          if (hasContent(event.delta)) { ledger.preventReplay(); committed = true; if (!firstAt) firstAt = Date.now(); }
          await onEvent(event);
        }
      }
    }));
    signal?.throwIfAborted();
    if (!committed) throw Object.assign(new Error("上游返回空响应"), { status: 502 });
    attemptScope.complete(reservation.attemptId, "unsafe");
    const events = [];
    if (usage) { events.push(usage); await onEvent(usage); }
    if (finish) { events.push(finish); await onEvent(finish); }
    if (!probe) {
      try { pool.noteSuccess(account.id, model); }
      catch { /* A failed statistic must not rerun or fail an executed model. */ }
    }
    return { ok: true, accountId: account.id, committed, events, ms: Date.now() - started, firstByteMs: firstAt - started };
  } catch (error) {
    const cancelled = signal?.aborted;
    const reason = classify(error);
    if (reservation) {
      try { attemptScope.complete(reservation.attemptId, !cancelled && !committed && reason.switchable ? "safe" : "unknown"); }
      catch { /* Closed/expired authority cannot refund or reset a reservation. */ }
    }
    if (!cancelled && !probe && ["account", "account-model"].includes(reason.scope)) {
      try { onFailure(account.id, model, reason, error?.message); }
      catch { /* Preserve execution result and release the original lease. */ }
    }
    return { ok: false, accountId: account.id, committed, events: usage ? [usage] : [],
      status: cancelled ? signal.reason?.code === "TIMEOUT" ? 504 : 499 : reason.status,
      errCode: cancelled ? signal.reason?.code === "TIMEOUT" ? "timeout" : "cancelled" : reason.kind,
      failureScope: reason.kind === "egress" ? "egress" : reason.scope,
      error: cancelled ? "模型调用已取消或超时" : String(error?.message || "标准上游调用失败").slice(0, 200),
      switchable: !cancelled && !committed && reason.switchable, ms: Date.now() - started, firstByteMs: firstAt ? firstAt - started : 0 };
  } finally {
    releaseAuthority?.(); attemptScope?.close();
    try { if (leased) pool.releaseAccount(account.id); } finally { if (ownsLedger) ledger.close(); }
  }
}
module.exports = { executeStandard, classify };
