"use strict";
// Provider-neutral host connection. The manager owns process, package trust and
// permissions. The gateway owns account leases, grants, routing and statistics.
const { randomUUID } = require("node:crypto");
const p = require("./provider-protocol.cjs");
const { PROTOCOL, LIMITS, assert, identifier, integer, object, terminal, validateEvent, hasContent, failure } = p;

function raceSignal(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class ProviderSession {
  constructor({ peer, identity, declarations, windowBytes = LIMITS.windowBytes, eventBytes = LIMITS.eventBytes, maxQueueBytes = LIMITS.queueBytes, maxConcurrent = LIMITS.concurrent, firstContentMs = 30000, idleMs = 30000, onRevoke = () => {}, onUnhealthy = () => {} }) {
    assert(peer && identifier(identity?.pluginId) && identifier(identity?.publisherId) && integer(identity?.generation, 1, Number.MAX_SAFE_INTEGER) && Array.isArray(declarations), "Missing verified plugin connection identity");
    assert(integer(windowBytes, 1024, LIMITS.windowBytes) && integer(eventBytes, 512, Math.min(windowBytes, LIMITS.eventBytes)), "Invalid host stream limits");
    Object.assign(this, { peer, windowBytes, eventBytes, maxQueueBytes, maxConcurrent, firstContentMs, idleMs, onRevoke, onUnhealthy });
    this.identity = Object.freeze({ ...identity, sessionId: identity.sessionId || randomUUID() });
    this.declarations = structuredClone(declarations);
    this.active = new Map();
    this.retired = new Map();
    this.queuedBytes = 0;
    this.queuedDataBytes = 0;
    this.ready = false;
    this.disposeEvents = peer.handleNotification(p.EVENT_METHOD, (event, metadata) => this.receive(event, metadata));
    peer.once("closed", error => {
      this.ready = false;
      for (const record of this.active.values()) this.fail(record, failure("PLUGIN_DISCONNECTED", "反代插件连接已断开", { category: "network", scope: "service", replay: "unknown", cause: error }));
      try { this.onUnhealthy(error); } catch { /* Manager diagnostics must not block cleanup. */ }
    });
  }

  async initialize() {
    assert(!this.ready && !this.peer.closed, "Plugin session unavailable");
    const result = await this.peer.call("initialize", { protocol: PROTOCOL, features: p.FEATURES, generation: this.identity.generation, windowBytes: this.windowBytes, eventBytes: this.eventBytes });
    assert(result?.protocol === PROTOCOL && Array.isArray(result.capabilities) && result.capabilities.includes("ai.provider@1") && Array.isArray(result.providers), "Plugin handshake incompatible");
    assert(result.features === undefined || Array.isArray(result.features) && new Set(result.features).size === result.features.length && result.features.every(value => p.FEATURES.includes(value)), "Invalid negotiated provider features");
    const seen = new Set();
    for (const provider of result.providers) {
      const allowed = this.declarations.find(item => item.id === provider?.id);
      assert(allowed && !seen.has(provider.id) && Array.isArray(provider.channels) && provider.channels.length && provider.channels.every(channel => allowed.channels.includes(channel)), "Plugin runtime exceeded signed provider declaration");
      assert(provider.requiredFeatures === undefined || Array.isArray(provider.requiredFeatures)
        && new Set(provider.requiredFeatures).size === provider.requiredFeatures.length
        && provider.requiredFeatures.every(feature => p.FEATURES.includes(feature) && result.features?.includes(feature)), "Invalid required provider features");
      seen.add(provider.id);
    }
    assert(seen.size > 0, "Plugin declared no executable provider");
    this.providers = structuredClone(result.providers);
    this.features = Object.freeze([...(result.features || [])]);
    this.ready = true;
    return this.providers;
  }

  requireService(providerId, channel) {
    if (!this.ready || this.peer.closed) throw failure("FORWARD_PLUGIN_UNAVAILABLE", "反代执行插件尚未就绪", { status: 503, scope: "service", replay: "safe" });
    assert(this.providers.some(provider => provider.id === providerId && provider.channels.includes(channel)), "Plugin provider/channel unavailable");
  }

  supports(feature) { return this.features?.includes(feature) === true; }

  async rotateGrant(invocationId, renew) {
    const record = this.active.get(invocationId);
    if (!record || record.terminalReceived || record.controller.signal.aborted) return false;
    assert(this.supports("scoped-grant-rotation@1") && !record.rotating && typeof renew === "function", "Grant rotation not available");
    record.rotating = true;
    const epoch = (record.grantEpoch || 0) + 1;
    try {
      // Prepare pauses NEW callbacks and awaits already issued callbacks. A
      // simple grant notification races a refresh response and loses its result.
      const params = { invocationId, generation: this.identity.generation, epoch };
      const ready = await this.peer.call("provider.prepareGrant", params, { signal: record.controller.signal, timeoutMs: 12000 });
      if (ready?.active === false && record.terminalReceived) return false;
      assert(ready?.prepared === true && ready.epoch === epoch, "Plugin did not prepare grant rotation");
      if (!this.active.has(invocationId) || record.controller.signal.aborted) return false;
      const next = renew(); // synchronous host authorization + opaque ID rotation
      assert(identifier(next?.grantId), "Invalid renewed account grant");
      const done = await this.peer.call("provider.commitGrant", { ...params, grantId: next.grantId }, { signal: record.controller.signal, timeoutMs: 5000 });
      if (done?.active === false && record.terminalReceived) return false;
      assert(done?.committed === true && done.epoch === epoch, "Plugin did not commit grant rotation");
      record.grantEpoch = epoch;
      return true;
    } catch (error) {
      if (!record.terminalReceived) this.fail(record, error);
      throw error;
    } finally { record.rotating = false; }
  }

  async listModels({ providerId, channel, grantId, invocationId, force = false, signal }) {
    this.requireService(providerId, channel);
    assert(typeof force === "boolean", "Invalid model catalog refresh flag");
    const models = await this.peer.call("listModels", { providerId, channel, grantId, invocationId, force, generation: this.identity.generation }, { signal });
    assert(Array.isArray(models) && models.length <= 4096 && models.every(model => object(model) && identifier(model.id)), "Invalid plugin model catalog");
    p.jsonValue(models);
    return models;
  }

  /**
   * 管理层调用（额度 / 签到 / 领取 / 登录 / 账号规范化）。
   *
   * 与执行面分开：不走 invocation 记录、不占并发额度；插件没实现就返回
   * `{supported:false}`，调用方据此回落到本地实现，而不是把「不支持」当失败。
   */
  async manage({ providerId, channel, method, payload }, { signal, timeoutMs = 30000 } = {}) {
    this.requireService(providerId, channel);
    assert(typeof method === "string" && method.length > 0 && method.length <= 64, "Invalid management method");
    if (payload !== undefined) p.jsonValue(payload);
    const result = await this.peer.call("provider.manage", {
      providerId, channel, method, payload: payload === undefined ? {} : payload,
      generation: this.identity.generation,
    }, { signal, timeoutMs });
    assert(result && typeof result.supported === "boolean", "Invalid management response");
    return result;
  }

  receive(event, metadata) {
    validateEvent(event);
    assert(event.generation === this.identity.generation, "Event from a different plugin generation");
    const record = this.active.get(event.invocationId);
    if (!record) {
      const retired = this.retired.get(event.invocationId);
      if (retired && retired > Date.now()) return;
      assert(false, "Event for unknown plugin invocation");
    }
    if (record.controller.signal.aborted) return;
    assert(!record.terminalReceived && event.seq === record.nextSeq, "Plugin event sequence or terminal violation");
    const bytes = metadata?.wireBytes;
    assert(integer(bytes, 1, this.eventBytes), "Plugin event exceeds host wire limit");
    const isTerminal = terminal(event);
    // Observe replay barriers at receipt, before a slow output consumer can
    // leave a later control RPC ahead of the queued model event.
    if (event.type === "delta" && hasContent(event.delta) || event.type === "checkpoint" && event.replay !== "safe") record.onReplayBarrier?.();
    if (!isTerminal) {
      assert(bytes <= record.credit, "Plugin exceeded stream credit");
      record.credit -= bytes;
    }
    // One terminal may use the control reserve even with a full data window.
    assert(record.queuedBytes + bytes <= this.windowBytes + this.eventBytes && this.queuedBytes + bytes <= this.maxQueueBytes + this.eventBytes * this.maxConcurrent, "Plugin event queue exhausted");
    if (!isTerminal) assert(this.queuedDataBytes + bytes <= this.maxQueueBytes, "Plugin data queue exhausted");
    record.nextSeq++;
    record.terminalReceived = isTerminal;
    record.queue.push({ event, bytes, credited: !isTerminal });
    record.queuedBytes += bytes;
    this.queuedBytes += bytes;
    if (!isTerminal) this.queuedDataBytes += bytes;
    record.wake?.();
  }

  fail(record, error) {
    if (record.controller.signal.aborted) return;
    record.controller.abort(error);
    record.wake?.();
  }

  async invoke({ invocationId = randomUUID(), providerId, channel, model, input, grantId, deadlineAt, attempt = 1, attemptsRemaining = 0, attemptBudget = false, onReplayBarrier, idempotencyKey, requestHeaders = {}, stateScope, signal, onEvent }) {
    this.requireService(providerId, channel);
    const provider = this.providers.find(item => item.id === providerId && item.channels.includes(channel));
    assert(!provider.requiredFeatures?.includes("state-scope@1") || stateScope !== undefined, "Required execution state scope missing");
    if (stateScope !== undefined) {
      assert(this.supports("state-scope@1"), "Execution state scope not negotiated");
      p.validateStateScope(stateScope);
    }
    assert(!attemptBudget || this.supports("attempt-reservation@1"), "Model attempt reservation not negotiated");
    p.validateRequestHeaders(requestHeaders);
    assert(!Object.keys(requestHeaders).length || this.supports("request-headers@1"), "Client headers not negotiated");
    const unbounded = deadlineAt === null;
    assert(identifier(invocationId) && identifier(model) && identifier(grantId) && typeof onEvent === "function" && object(input)
      && (unbounded ? this.supports("unbounded-deadline@1") : Number.isFinite(deadlineAt) && deadlineAt > Date.now() && deadlineAt - Date.now() <= 24 * 3600000), "Invalid host invocation");
    assert(!this.active.has(invocationId) && this.active.size < this.maxConcurrent, "Host invocation limit reached");
    if (signal?.aborted) throw signal.reason || failure("CANCELLED", "请求已取消");
    const record = { id: invocationId, controller: new AbortController(), queue: [], queuedBytes: 0, credit: this.windowBytes, nextSeq: 1, terminalReceived: false, hasContent: false, wake: null, firstTimer: null, idleTimer: null };
    record.onReplayBarrier = onReplayBarrier;
    const cancel = () => this.fail(record, signal.reason || failure("CANCELLED", "请求已取消"));
    signal?.addEventListener("abort", cancel, { once: true });
    const remainingMs = unbounded ? null : Math.max(1, Math.floor(deadlineAt - Date.now()));
    const timeout = () => this.fail(record, failure("PLUGIN_TIMEOUT", "反代调用超过时限", { category: "network", scope: "invocation", replay: "unknown", status: 504 }));
    record.totalTimer = unbounded ? null : setTimeout(timeout, remainingMs);
    record.firstTimer = setTimeout(timeout, Math.min(remainingMs ?? Infinity, this.firstContentMs));
    this.active.set(invocationId, record); // Must exist before RPC can deliver events.
    let succeeded = false;
    try {
      const response = await this.peer.call("invoke", { invocationId, providerId, channel, model, input, grantId, generation: this.identity.generation, remainingMs, attempt, attemptsRemaining, attemptBudget, idempotencyKey,
        ...(Object.keys(requestHeaders).length ? { requestHeaders } : {}), ...(stateScope === undefined ? {} : { stateScope }) }, { signal: record.controller.signal, timeoutMs: Math.min(10000, remainingMs ?? Infinity) });
      assert(response?.accepted === true && response.invocationId === invocationId && response.generation === this.identity.generation, "Plugin did not accept the requested invocation");
      while (true) {
        record.controller.signal.throwIfAborted();
        if (!record.queue.length) {
          await new Promise((resolve, reject) => {
            const abort = () => { record.wake = null; reject(record.controller.signal.reason); };
            record.wake = () => { record.controller.signal.removeEventListener("abort", abort); record.wake = null; resolve(); };
            record.controller.signal.addEventListener("abort", abort, { once: true });
            if (record.controller.signal.aborted) abort();
          });
          continue;
        }
        const { event, bytes, credited } = record.queue.shift();
        record.queuedBytes -= bytes;
        this.queuedBytes -= bytes;
        if (credited) this.queuedDataBytes -= bytes;
        if (event.type === "error") throw failure(event.error.code, event.error.message, event.error);
        if (event.type === "finish" && !record.hasContent) throw failure("EMPTY_UPSTREAM", "反代上游返回空响应", { category: "upstream", scope: "invocation", replay: "unknown" });
        if (event.type === "delta" && hasContent(event.delta)) {
          record.hasContent = true;
          clearTimeout(record.firstTimer);
          clearTimeout(record.idleTimer);
          record.idleTimer = setTimeout(timeout, Math.min(this.idleMs, unbounded ? Infinity : Math.max(1, deadlineAt - Date.now())));
        }
        // Await real output consumption. Reading the RPC pipe alone is not credit.
        await raceSignal(onEvent(event, record.controller.signal), record.controller.signal);
        record.controller.signal.throwIfAborted();
        if (credited && !this.peer.closed) {
          record.credit += bytes;
          await this.peer.notify("provider.credit", { invocationId, generation: this.identity.generation, bytes });
        }
        if (event.type === "finish") { succeeded = true; return { ok: true, invocationId }; }
      }
    } finally {
      clearTimeout(record.totalTimer); clearTimeout(record.firstTimer); clearTimeout(record.idleTimer);
      signal?.removeEventListener("abort", cancel);
      this.queuedBytes -= record.queuedBytes;
      this.queuedDataBytes -= record.queue.filter(item => item.credited).reduce((sum, item) => sum + item.bytes, 0);
      record.queue.length = 0;
      record.queuedBytes = 0;
      this.active.delete(invocationId);
      for (const [id, until] of this.retired) if (until < Date.now()) this.retired.delete(id);
      if (this.retired.size >= 256) this.retired.delete(this.retired.keys().next().value);
      this.retired.set(invocationId, Date.now() + 10000);
      try { this.onRevoke(invocationId); } catch { /* Resource cleanup must continue. */ }
      if (!succeeded && !this.peer.closed) {
        // Cancellation uses a separate RPC, not the already-completed invoke ID.
        // This runs independently of the caller but is bounded and observed.
        this.peer.call("cancel", { invocationId, generation: this.identity.generation }, { timeoutMs: 1500 })
          .then(result => { if (result?.cancelled !== true) this.peer.close(failure("PLUGIN_CANCEL_FAILED", "Plugin did not stop invocation")); }, error => this.peer.close(error));
      }
    }
  }

  close(reason = failure("PLUGIN_STOPPED", "插件已停止")) {
    this.ready = false;
    this.peer.close(reason);
    this.disposeEvents();
  }
}
module.exports = { ProviderSession };
