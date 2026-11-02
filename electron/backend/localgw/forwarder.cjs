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
const store = require("../proxy/store.cjs");
const pool = require("../proxy/pool.cjs");
const adapters = require("../proxy/adapters.cjs");
const classify = require("../proxy/classify.cjs");
const util = require("../proxy/util.cjs");
const lgwConfig = require("./config.cjs");
const outboundHook = require("../proxy/outbound-hook.cjs");
const transport = require("../proxy/transport-context.cjs");
const outbound = require("./outbound.cjs");

function pickAccountFor(channel, model, excludeIds) {
  const a = pool.pickAccount(channel, undefined, excludeIds, 0, model);
  return { account: a, reason: a ? null : "no_account" };
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

async function forward(req, channel, realModel, modelRequested, ctx, timeoutMs, onEvent, signal) {
  ctx = ctx || {};
  const { account, reason } = pickAccountFor(channel, realModel, ctx.excludeAccounts || []);
  if (!account) return { ok: false, status: 503, error: `渠道 ${channel} 当前无可用账号`, errCode: reason, switchable: true, events: [] };
  const ad = adapters.get(channel);
  if (!ad || typeof ad.chat !== "function") return { ok: false, status: 501, error: "渠道不支持对话转发", errCode: "no_adapter", switchable: true, events: [] };
  let secrets;
  try { secrets = store.accountSecrets(store.getAccount(account.id)); } catch {}
  if (!secrets?.token) return { ok: false, status: 503, error: "账号凭据缺失", errCode: "no_token", switchable: true, accountId: account.id, events: [] };
  const policy = outbound.policyFor(channel, lgwConfig.get());
  const san = outbound.sanitizeBody(req, policy);
  const ac = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  const t0 = Date.now();
  let timedOut = false, firstEventAt = 0, committed = false, error = null, finish = null, usage = null;
  const events = [];
  const budget = timeoutMs == null ? 120000 : Number(timeoutMs);
  const timer = budget > 0 ? setTimeout(() => { timedOut = true; ac.abort(new Error("请求总时限已到")); }, Math.max(1, budget)) : null;
  const emit = (ev) => {
    if (requestSignal.aborted || !ev) return;
    if (ev.type === "error") { error = ev; return; }
    if (error) return;
    if (ev.type === "usage") { usage = ev; return; }
    if (ev.type === "finish") { if (ev.reason || !finish) finish = ev; return; }
    if (ev.type === "delta") {
      if (util.hasConsumableDelta(ev.delta || {})) {
        if (!firstEventAt) firstEventAt = Date.now();
        committed = true;
      }
      onEvent?.(ev);
    }
  };
  let leased = false;
  try {
    requestSignal.throwIfAborted();
    pool.acquireAccount(account.id);
    leased = true;
    if (policy.jitter) await require("node:timers/promises").setTimeout(40 + Math.random() * 180, undefined, { signal: requestSignal });
    await transport.run(requestSignal, () => outboundHook.run(policy, () => ad.chat({
      account: { ...account, secrets }, secrets, model: realModel, body: san.body, emit,
      meta: { requestId: ctx.requestId, apiKeyId: ctx.apiKeyId, signal: requestSignal },
    })));
    requestSignal.throwIfAborted();
    if (error) throw error;
    if (!committed) throw { status: 502, message: "上游返回空响应" };
    if (usage) { events.push(usage); onEvent?.(usage); }
    if (finish) { events.push(finish); onEvent?.(finish); }
    pool.noteSuccess(account.id, realModel);
    return { ok: true, accountId: account.id, ms: Date.now() - t0, firstByteMs: firstEventAt - t0, outboundHits: san.hits, events };
  } catch (e) {
    const deadlineExpired = timedOut || (signal?.aborted && signal.reason?.code === "TIMEOUT");
    const cancelled = signal?.aborted && !deadlineExpired;
    const cls = cancelled ? { kind: "cancelled", status: 499, switchable: false }
      : deadlineExpired ? { kind: "timeout", status: 504, switchable: false }
      : classify.classifyUpstream(e, e?.planLimit, channel);
    if (!cancelled && !deadlineExpired && !e?.netproxy) applyFailure(account.id, realModel, cls, e?.message);
    return {
      ok: false, accountId: account.id, status: cls.status || 502, errCode: cls.kind,
      failureScope: e?.netproxy ? "egress" : "upstream",
      switchable: cls.switchable !== false, committed,
      error: cancelled ? "客户端已断开" : deadlineExpired ? "上游响应超时" : String(e?.message || e),
      ms: Date.now() - t0, firstByteMs: firstEventAt ? firstEventAt - t0 : 0, outboundHits: san.hits, events,
    };
  } finally {
    clearTimeout(timer);
    if (leased) pool.releaseAccount(account.id);
  }
}

module.exports = { forward, pickAccountFor, applyFailure };
