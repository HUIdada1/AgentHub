"use strict";
// Generic SDK runtime. Packaged plugins carry their own copy; they must never
// import a running AgentHub checkout. No account management or upstream code.
const { RpcPeer } = require("../rpc.cjs");
const { createNetwork } = require("./network.cjs");
const protocol = require("../provider-protocol.cjs");
const { PROTOCOL, LIMITS, assert, object, identifier, integer, jsonValue, terminal, validateEvent, eventBytes, publicError } = protocol;

function abortError() { return Object.assign(new Error("Invocation cancelled"), { name: "AbortError" }); }
function waitAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || abortError());
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

class ProviderRuntime {
  constructor({ peer, providers, maxConcurrent = LIMITS.concurrent, maxWindowBytes = LIMITS.windowBytes, maxEventBytes = LIMITS.eventBytes }) {
    assert(peer && Array.isArray(providers) && providers.length > 0, "Provider runtime requires providers");
    this.peer = peer;
    this.providers = new Map();
    for (const provider of providers) {
      assert(identifier(provider.id) && !this.providers.has(provider.id) && Array.isArray(provider.channels) && provider.channels.length > 0 && provider.channels.every(identifier) && typeof provider.invoke === "function", "Invalid SDK provider");
      this.providers.set(provider.id, provider);
    }
    Object.assign(this, { maxConcurrent, maxWindowBytes, maxEventBytes });
    this.active = new Map();
    this.initialized = false;
    this.closing = false;
    peer.handle("initialize", params => this.initialize(params));
    peer.handle("listModels", (params, ctx) => this.listModels(params, ctx));
    peer.handle("invoke", (params, ctx) => this.register(params, ctx));
    peer.handle("cancel", params => this.cancel(params));
    peer.handle("provider.prepareGrant", (params, ctx) => this.prepareGrant(params, ctx.signal));
    peer.handle("provider.commitGrant", params => this.commitGrant(params));
    peer.handleNotification("provider.credit", params => this.credit(params));
    peer.handle("status", () => ({ ready: this.initialized && !this.closing, active: this.active.size }));
    peer.handle("shutdown", async () => {
      this.closing = true;
      for (const record of this.active.values()) this.abort(record);
      return { stopped: this.active.size === 0 };
    });
    peer.once("closed", () => {
      this.closing = true;
      for (const record of this.active.values()) this.abort(record);
    });
  }

  initialize(params) {
    assert(!this.initialized && params?.protocol === PROTOCOL && integer(params.generation, 1, Number.MAX_SAFE_INTEGER), "Plugin initialization incompatible or repeated");
    assert(integer(params.windowBytes, 1024, this.maxWindowBytes) && integer(params.eventBytes, 512, this.maxEventBytes) && params.eventBytes <= params.windowBytes, "Invalid negotiated stream limits");
    const features = protocol.FEATURES.filter(value => params.features?.includes(value));
    for (const provider of this.providers.values()) {
      assert(provider.requiredFeatures === undefined || Array.isArray(provider.requiredFeatures)
        && provider.requiredFeatures.every(value => features.includes(value)), "Provider requires unavailable protocol features");
    }
    this.generation = params.generation;
    this.windowBytes = params.windowBytes;
    this.eventLimit = params.eventBytes;
    this.initialized = true;
    this.features = features;
    return { protocol: PROTOCOL, features: this.features, capabilities: ["ai.provider@1"], providers: [...this.providers.values()].map(provider => ({ id: provider.id, channels: provider.channels,
      ...(provider.requiredFeatures ? { requiredFeatures: [...provider.requiredFeatures] } : {}) })) };
  }

  provider(params) {
    assert(this.initialized && !this.closing && params?.generation === this.generation, "Plugin generation unavailable");
    const provider = this.providers.get(params.providerId);
    assert(provider && provider.channels.includes(params.channel), "Provider or channel not declared");
    return provider;
  }

  async listModels(params, rpcContext) {
    const provider = this.provider(params);
    const result = typeof provider.listModels === "function" ? await provider.listModels(params, { signal: rpcContext.signal,
      pool: this.pool({ id: params.grantId, invocationId: params.invocationId, pending: 0, catalog: true,
        networkAllowed: params.force === true }, rpcContext.signal, Date.now() + 10000, provider.requiredFeatures) }) : [];
    assert(Array.isArray(result) && result.length <= 4096, "Invalid plugin model catalog");
    jsonValue(result);
    for (const model of result) assert(object(model) && identifier(model.id), "Invalid plugin model ID");
    return result;
  }

  attemptControl(record) {
    if (!record.params.attemptBudget) return undefined;
    assert(this.features.includes("attempt-reservation@1"), "Model attempt reservation not negotiated");
    const factsSupported = this.features.includes("execution-facts@1");
    let ticket, completed = false, busy = false;
    const call = async (method, extra) => {
      const state = record.grant, signal = record.controller.signal;
      if (state.pause) await waitAbort(state.pause.promise, signal);
      signal.throwIfAborted();
      state.pending++;
      try {
        return await this.peer.call(method, { grantId: state.id, invocationId: record.params.invocationId, ...extra },
          { signal, timeoutMs: Math.max(1, Math.min(10000, record.deadlineAt - Date.now())) });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw protocol.forwardError({ code: error.code === -32040 ? "MODEL_ATTEMPT_LIMIT" : "MODEL_ATTEMPT_DENIED",
          message: "宿主拒绝模型尝试预约或状态变更", category: "protocol", scope: "invocation", replay: "unknown", status: 503 });
      } finally { if (--state.pending === 0) state.drained?.(); }
    };
    const complete = async replay => {
      if (!ticket || completed) return;
      await call("execution.completeAttempt", { attemptId: ticket.attemptId, replay });
      completed = true;
    };
    return Object.freeze({
      async next(reason) {
        assert(!busy, "Concurrent model attempt reservation");
        busy = true;
        try {
          await complete("safe");
          ticket = await call("execution.reserveAttempt", { reason });
          assert(identifier(ticket?.attemptId) && integer(ticket.number, 1, 10) && integer(ticket.remaining, 0, 9), "Invalid host attempt reservation");
          completed = false;
          await call("execution.startAttempt", { attemptId: ticket.attemptId });
          return Object.freeze({ ...ticket });
        } finally { busy = false; }
      },
      complete,
      async report(facts) {
        assert(factsSupported && ticket && !completed && !busy, "Execution facts require a negotiated active attempt");
        protocol.validateExecutionFacts(facts);
        busy = true;
        try {
          const result = await call("execution.reportFacts", { attemptId: ticket.attemptId, facts });
          assert(result?.recorded === true, "Host did not record execution facts");
        } finally { busy = false; }
      },
      get current() { return ticket && Object.freeze({ ...ticket }); }
    });
  }

  pool(grant, signal, deadline, requiredFeatures = []) {
    const state = typeof grant === "string" || grant === undefined ? { id: grant, pending: 0 } : grant;
    const call = async (method, extra = {}) => {
      if (state.pause) await waitAbort(state.pause.promise, signal);
      signal.throwIfAborted();
      const grantId = state.id;
      assert(identifier(grantId), "Missing scoped account grant");
      state.pending++;
      try { return await this.peer.call(method, { grantId, ...extra }, { signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) }); }
      finally { if (--state.pending === 0) state.drained?.(); }
    };
    return Object.freeze({
      credentials: () => call("pool.readForwardCredentials"),
      context: async () => {
        const context = await call("pool.readForwardContext");
        assert(object(context), "Invalid scoped execution context");
        if (requiredFeatures.includes("account-execution-epoch@1") || context.accountExecutionEpoch !== undefined) {
          assert(this.features.includes("account-execution-epoch@1"), "Account execution epoch was not negotiated");
          protocol.validateAccountExecutionEpoch(context.accountExecutionEpoch);
        }
        return context;
      },
      ensureCredentials: reason => call("pool.ensureForwardCredentials", { reason }),
      network: () => {
        assert(state.id && (!state.catalog && state.invocationId || state.networkAllowed === true), "Catalog network access requires an explicit forced refresh");
        return createNetwork({
        invocationId: state.invocationId,
        open: extra => call("pool.network.open", extra),
        read: requestId => call("pool.network.read", { requestId }),
        send: (requestId, chunk) => call("pool.network.send", { requestId, chunk }),
        close: requestId => call("pool.network.close", { requestId }),
        }, signal);
      },
    });
  }

  rotationRecord(params) {
    assert(this.initialized && this.features.includes("scoped-grant-rotation@1") && params?.generation === this.generation
      && identifier(params.invocationId) && integer(params.epoch, 1, Number.MAX_SAFE_INTEGER), "Invalid account grant rotation");
    return this.active.get(params.invocationId);
  }

  async prepareGrant(params, signal) {
    const record = this.rotationRecord(params);
    if (!record || record.terminalSent) return { active: false };
    const state = record.grant;
    assert(!state.pause && params.epoch === state.epoch + 1, "Concurrent or stale grant rotation");
    let release;
    state.pause = { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
    try {
      if (state.pending) await waitAbort(new Promise(resolve => { state.drained = resolve; }), AbortSignal.any([signal, record.controller.signal]));
      record.controller.signal.throwIfAborted();
      return { prepared: true, epoch: params.epoch };
    } catch (error) { state.pause?.release(); state.pause = null; throw error; }
    finally { state.drained = null; }
  }

  commitGrant(params) {
    const record = this.rotationRecord(params);
    if (!record || record.terminalSent) return { active: false };
    const state = record.grant;
    assert(state.pause && !state.pending && params.epoch === state.epoch + 1 && identifier(params.grantId), "Unprepared account grant rotation");
    state.id = params.grantId;
    state.epoch = params.epoch;
    const pause = state.pause;
    state.pause = null;
    pause.release();
    return { committed: true, epoch: state.epoch };
  }

  register(params, rpcContext) {
    const provider = this.provider(params);
    assert(this.active.size < this.maxConcurrent && identifier(params.invocationId) && !this.active.has(params.invocationId) && identifier(params.model) && identifier(params.grantId), "Invalid or duplicate invocation");
    const unbounded = params.remainingMs === null;
    assert(params.attemptBudget === undefined || typeof params.attemptBudget === "boolean", "Invalid model attempt mode");
    assert(!params.attemptBudget || this.features.includes("attempt-reservation@1"), "Model attempt reservation not negotiated");
    assert(!provider.requiredFeatures?.includes("execution-facts@1") || params.attemptBudget === true, "Required execution facts need a scoped attempt budget");
    assert(!provider.requiredFeatures?.includes("state-scope@1") || params.stateScope !== undefined, "Required execution state scope missing");
    if (params.stateScope !== undefined) {
      assert(this.features.includes("state-scope@1"), "Execution state scope not negotiated");
      protocol.validateStateScope(params.stateScope);
    }
    if (params.requestHeaders !== undefined) {
      assert(this.features.includes("request-headers@1"), "Client headers not negotiated");
      protocol.validateRequestHeaders(params.requestHeaders);
    }
    assert((unbounded ? this.features.includes("unbounded-deadline@1") : integer(params.remainingMs, 1, 24 * 3600000)) && object(params.input), "Invalid invocation input or deadline");
    jsonValue(params.input);
    const record = { params, provider, grant: { id: params.grantId, invocationId: params.invocationId, pending: 0, epoch: 0 }, controller: new AbortController(), deadlineAt: unbounded ? Infinity : Date.now() + params.remainingMs, seq: 0, credit: this.windowBytes, waitCredit: null, terminalSent: false, done: null, pendingNext: null, started: false };
    record.done = new Promise(resolve => { record.resolveDone = resolve; });
    record.timer = unbounded ? null : setTimeout(() => this.abort(record), params.remainingMs);
    const abortRegistration = () => this.abort(record);
    rpcContext.signal.addEventListener("abort", abortRegistration, { once: true });
    this.active.set(params.invocationId, record);
    rpcContext.afterReply(() => {
      rpcContext.signal.removeEventListener("abort", abortRegistration);
      if (!this.active.has(params.invocationId)) return;
      return this.run(record);
    });
    return { accepted: true, invocationId: params.invocationId, generation: this.generation };
  }

  credit(params) {
    assert(params?.generation === this.generation && identifier(params.invocationId) && integer(params.bytes, 1, this.windowBytes), "Invalid stream credit");
    const record = this.active.get(params.invocationId);
    if (!record) return; // Host can consume the last data after SDK sent finish.
    assert(record.credit + params.bytes <= this.windowBytes, "Stream credit overflow");
    record.credit += params.bytes;
    record.waitCredit?.();
  }

  abort(record) {
    if (!record.controller.signal.aborted) record.controller.abort(abortError());
    record.grant?.pause?.release();
    record.waitCredit?.();
    if (!record.started) {
      clearTimeout(record.timer);
      this.active.delete(record.params.invocationId);
      record.resolveDone();
    }
  }

  async cancel(params) {
    assert(params?.generation === this.generation && identifier(params.invocationId), "Invalid stream cancellation");
    const record = this.active.get(params.invocationId);
    if (!record) return { cancelled: true };
    this.abort(record);
    // A provider ignoring AbortSignal cannot consume all slots indefinitely.
    // Report failure to drain so the supervisor can terminate this generation.
    let timer;
    try {
      return await Promise.race([
        record.done.then(() => ({ cancelled: true })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ cancelled: false, needsRestart: true }), 1000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async emit(record, payload) {
    record.controller.signal.throwIfAborted();
    assert(!record.terminalSent, "Event after terminal");
    const event = { ...payload, invocationId: record.params.invocationId, generation: this.generation, seq: record.seq + 1 };
    validateEvent(event);
    const bytes = eventBytes(event);
    assert(bytes <= this.eventLimit, "Plugin event exceeds negotiated limit");
    if (!terminal(event)) {
      while (record.credit < bytes) {
        await new Promise((resolve, reject) => {
          const wake = () => { record.controller.signal.removeEventListener("abort", abort); record.waitCredit = null; resolve(); };
          const abort = () => { record.waitCredit = null; reject(record.controller.signal.reason || abortError()); };
          record.waitCredit = wake;
          record.controller.signal.addEventListener("abort", abort, { once: true });
          if (record.controller.signal.aborted) abort();
        });
        record.controller.signal.throwIfAborted();
      }
      record.credit -= bytes;
    }
    record.seq++;
    if (terminal(event)) record.terminalSent = true;
    // Previous events have completed their writes before the terminal frame is
    // queued on the reserved control lane, preserving per-call event ordering.
    await this.peer.notify("provider.event", event, { lane: terminal(event) ? "control" : "data" });
  }

  async run(record) {
    record.started = true;
    const deadline = record.deadlineAt;
    const attempts = this.attemptControl(record);
    const context = {
      signal: record.controller.signal,
      deadlineAt: deadline,
      pool: this.pool(record.grant, record.controller.signal, deadline, record.provider.requiredFeatures),
      attempts,
      limits: Object.freeze({ eventBytes: this.eventLimit }),
      request: Object.freeze({ headers: Object.freeze({ ...record.params.requestHeaders }),
        ...(record.params.stateScope === undefined ? {} : { stateScope: record.params.stateScope }) }),
    };
    let iterator;
    try {
      record.controller.signal.throwIfAborted();
      if (attempts) await attempts.next("initial");
      iterator = record.provider.invoke(record.params, context)[Symbol.asyncIterator]();
      while (true) {
        const pending = Promise.resolve(iterator.next());
        record.pendingNext = pending;
        const next = await waitAbort(pending, record.controller.signal);
        record.pendingNext = null;
        if (next.done) { assert(record.terminalSent, "Plugin generator ended without terminal event"); break; }
        if (terminal(next.value)) await attempts?.complete(next.value.type === "finish" ? "unsafe" : next.value.error.replay);
        await this.emit(record, next.value);
        if (record.terminalSent) break;
      }
    } catch (error) {
      try { await attempts?.complete(publicError(error).replay); }
      catch (completionError) { if (!record.controller.signal.aborted) error = completionError; }
      if (!record.terminalSent && !this.peer.closed) {
        // Cancellation also gets a terminal, even though normal data emission
        // stops on its signal. No raw exception string crosses the boundary.
        const event = { type: "error", error: publicError(error), invocationId: record.params.invocationId, generation: this.generation, seq: ++record.seq };
        record.terminalSent = true;
        try { await this.peer.notify("provider.event", event); } catch { /* Connection already failed. */ }
      }
    } finally {
      // The invocation capability ends with the generator, even if a provider
      // retained ctx.pool in a detached background task.
      this.abort(record);
      clearTimeout(record.timer);
      record.waitCredit?.();
      // A local race with AbortSignal stops waiting, but does not prove the
      // upstream/generator stopped. Do not acknowledge cancellation until its
      // pending read and return settle. Failure closes this generation.
      let cleanupTimer;
      let cleaned = false;
      try {
        const cleanup = (async () => {
          try { await record.pendingNext; } catch { /* Rejected upstream read. */ }
          await iterator?.return?.();
          cleaned = true;
        })();
        await Promise.race([cleanup, new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1000); })]);
      } catch { /* Treat cleanup failure as an unclean generation. */ }
      finally { clearTimeout(cleanupTimer); }
      if (!cleaned) this.peer.close(protocol.failure("PLUGIN_CLEANUP", "Plugin invocation did not stop"));
      this.active.delete(record.params.invocationId);
      record.resolveDone();
    }
  }
}

function runStdio({ providers }) {
  const peer = new RpcPeer({ input: process.stdin, output: process.stdout, prefix: "p:", remotePrefix: "h:", maxFrameBytes: LIMITS.frameBytes });
  const runtime = new ProviderRuntime({ peer, providers });
  peer.once("closed", () => { process.stdin.pause(); });
  return runtime;
}
module.exports = { ProviderRuntime, runStdio, forwardError: protocol.forwardError };
