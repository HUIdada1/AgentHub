"use strict";
// Request-scoped pool callbacks for sessions owned by the existing plugin manager.
// No process spawning, provider implementation, account selection or second pool.
const { PoolBroker } = require("./pool-broker.cjs");
const { authority, revoked } = require("./authority-watch.cjs");
const { validateRequestHeaders } = require("./provider-protocol.cjs");
const { createStateScopeFactory } = require("./state-scope.cjs");
const { accountExecution } = require("./account-execution.cjs");
const netproxy = require("../proxy/netproxy.cjs");
const { randomUUID } = require("node:crypto");
function unavailable() { return Object.assign(new Error("模型执行插件未就绪或未授权"), { code: "FORWARD_PLUGIN_UNAVAILABLE", status: 503, scope: "service" }); }
function connection(identity) { return JSON.stringify([identity.pluginId, identity.publisherId, identity.sessionId, identity.generation]); }
function serviceKey(ref) { return JSON.stringify([ref.pluginId, ref.publisherId, ref.providerId, ref.channel]); }

function createPoolService({ host, getAccount, access, grantLifetimeMs = 300000, execution = accountExecution }) {
  if (typeof host?.providerSessions !== "function" || typeof getAccount !== "function" || !access) throw new TypeError("Pool service requires the existing host and account services");
  const requests = new Map();
  const network = new Map();
  const deriveStateScope = createStateScopeFactory();
  let closed = false;
  function resolve(ref) {
    if (closed || ref?.kind !== "extension" || ![ref.pluginId, ref.publisherId, ref.providerId, ref.channel].every(value => typeof value === "string" && value.length > 0)) throw unavailable();
    const current = host.providerSessions().find(item => item.id === ref.pluginId && item.identity.publisherId === ref.publisherId
      && item.manifest.contributes.providers.some(provider => provider.id === ref.providerId && provider.channels.includes(ref.channel)));
    if (!current || !current.permissions?.includes("pool.forward-scoped") || !current.channels?.includes(ref.channel)
      || typeof current.session?.requireService !== "function" || !access.policyFor(ref.channel, "invoke")) throw unavailable();
    // A signed declaration is only an upper bound. The live handshake may expose
    // fewer providers/channels; reject before selection or any account lookup.
    try { current.session.requireService(ref.providerId, ref.channel); }
    catch { throw unavailable(); }
    return current;
  }
  function capture(ref, authorize) {
    const savedRef = Object.freeze({ ...ref });
    const live = resolve(savedRef);
    if (typeof authorize !== "function" || authorize() !== true) throw unavailable();
    const capturedConnection = connection(live.identity);
    function assertCurrent() {
      const current = resolve(savedRef);
      if (current.session !== live.session || connection(current.identity) !== capturedConnection || authorize() !== true) throw unavailable();
    }
    return Object.freeze({ ref: savedRef, session: live.session, identity: live.identity, assertCurrent,
      stateScope(context) {
        assertCurrent();
        const current = resolve(savedRef);
        if (!current.session.supports?.("state-scope@1")) throw unavailable();
        return deriveStateScope({ context, ref: savedRef, identity: current.identity,
          permissions: current.permissions, channels: current.channels });
      },
      requestHeaders(source, rawHeaders) {
        assertCurrent();
        const current = resolve(savedRef);
        const result = {};
        if (!current.permissions.includes("request.headers.read")) return result;
        const declaration = current.manifest.contributes.providers.find(provider => provider.id === savedRef.providerId && provider.channels.includes(savedRef.channel));
        const names = declaration?.requestHeaders || [];
        if (!names.length) return result;
        if (!live.session.supports?.("request-headers@1")) throw unavailable();
        // IncomingMessage.headers coalesces duplicate HTTP fields. Inspect the
        // original names before that information is lost; never send this raw
        // array (which contains gateway authentication) across the RPC boundary.
        if (rawHeaders !== undefined) {
          if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 || !rawHeaders.every(value => typeof value === "string")) throw unavailable();
          const seen = new Set();
          for (let index = 0; index < rawHeaders.length; index += 2) {
            const name = rawHeaders[index].toLowerCase();
            if (!names.includes(name)) continue;
            if (seen.has(name)) throw unavailable();
            seen.add(name);
          }
        }
        // Read only signed, explicitly granted names from the CURRENT HTTP
        // request. Never forward authentication, cookies, body metadata or a bag.
        for (const name of names) {
          const matches = Object.keys(source || {}).filter(key => key.toLowerCase() === name);
          if (matches.length > 1) throw unavailable();
          if (matches.length) result[name] = source[matches[0]];
        }
        validateRequestHeaders(result);
        return result;
      },
      assertPurpose(purpose) {
        assertCurrent();
        if (!["invoke", "catalog"].includes(purpose) || !access.policyFor(savedRef.channel, purpose)) throw unavailable();
      },
      open(options) {
        assertCurrent();
        return open({ ...options, ref: savedRef, authorize: () => { assertCurrent(); return true; } });
      }
    });
  }
  function requestKey(identity, invocationId) { return JSON.stringify([connection(identity), invocationId]); }
  if (!Number.isSafeInteger(grantLifetimeMs) || grantLifetimeMs < 20 || grantLifetimeMs > 300000) throw new TypeError("Invalid scoped grant lifetime");
  async function networkOpen(identity, params, rpcContext) {
    const { grant } = broker.validate(identity, params?.grantId);
    const request = requests.get(requestKey(identity, grant.invocationId));
    if (!request || !(grant.purpose === "invoke" || grant.purpose === "catalog" && request.networkAllowed === true)
      || params?.invocationId !== grant.invocationId) throw unavailable();
    const live = resolve(request.ref);
    if (!live.permissions?.includes("network.outbound")) throw unavailable();
    request.execution.assertCurrent();
    let url; try { url = new URL(String(params?.url || "")); } catch { throw Object.assign(new Error("Invalid upstream URL"), { code: "NETWORK_POLICY" }); }
    const websocket = params.kind === "websocket";
    if (!(websocket ? ["ws:", "wss:"].includes(url.protocol) : ["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.hash) throw Object.assign(new Error("Upstream URL is not allowed"), { code: "NETWORK_POLICY" });
    const method = String(params?.method || "GET").toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw Object.assign(new Error("Upstream method is not allowed"), { code: "NETWORK_POLICY" });
    const inputHeaders = params?.headers;
    if (!inputHeaders || typeof inputHeaders !== "object" || Array.isArray(inputHeaders) || Object.keys(inputHeaders).length > 64) throw Object.assign(new Error("Invalid upstream headers"), { code: "NETWORK_POLICY" });
    const headers = {};
    for (const [name, value] of Object.entries(inputHeaders)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 16384) throw Object.assign(new Error("Invalid upstream header"), { code: "NETWORK_POLICY" });
      headers[name] = value;
    }
    const body = params.body === undefined ? undefined : Buffer.from(String(params.body), "base64");
    if (body && body.byteLength > 8 * 1024 * 1024) throw Object.assign(new Error("Upstream request exceeds limit"), { code: "NETWORK_POLICY" });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, rpcContext?.signal || AbortSignal.timeout(120000), request.controller.signal]);
    if (websocket) {
      const ws = netproxy.webSocketThrough(url.toString(), { headers }, grant.accountId);
      const item = { identity: connection(identity), grantId: params.grantId, controller, ws, queue: [], queuedBytes: 0, waiters: [], closed: false };
      const closeSocket = () => {
        if (item.closed) return;
        item.closed = true;
        controller.abort();
        while (item.waiters.length) item.waiters.shift()({ type: "close" });
        try { ws.close(); } catch {}
      };
      const push = message => {
        const data = typeof message === "string" ? Buffer.from(message) : Buffer.from(message);
        if (data.byteLength > 1024 * 1024) { item.controller.abort(); try { item.ws.close(); } catch {} return; }
        const waiter = item.waiters.shift();
        if (waiter) waiter({ type: "message", data: data.toString("base64") });
        else {
          item.queuedBytes += data.byteLength;
          if (item.queuedBytes > 8 * 1024 * 1024) { item.controller.abort(); try { item.ws.close(); } catch {} return; }
          item.queue.push({ type: "message", data: data.toString("base64"), bytes: data.byteLength });
        }
      };
      if (typeof ws.addEventListener === "function") ws.addEventListener("message", event => push(event.data));
      else ws.onmessage = event => push(event.data);
      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("error", () => { const waiter = item.waiters.shift(); if (waiter) waiter({ type: "error" }); });
        ws.addEventListener("close", () => { item.closed = true; while (item.waiters.length) item.waiters.shift()({ type: "close" }); });
      }
      const abortHandshake = () => closeSocket();
      signal.addEventListener("abort", abortHandshake, { once: true });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error("WebSocket handshake timeout"), { code: "NETWORK_TIMEOUT" })), 30000);
          const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abortHandshake); };
          const opened = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(Object.assign(new Error("WebSocket handshake failed"), { code: "NETWORK_CONNECT" })); };
          if (typeof ws.addEventListener === "function") { ws.addEventListener("open", opened, { once: true }); ws.addEventListener("error", failed, { once: true }); }
          else { ws.onopen = opened; ws.onerror = failed; }
          if (signal.aborted) { cleanup(); reject(signal.reason); }
        });
      } catch (error) { closeSocket(); throw error; }
      const requestId = randomUUID(); network.set(requestId, item);
      return { requestId, kind: "websocket", status: 101, headers: {}, done: false };
    }
    // 账号级出口：把 grant 上的 accountId 交给 netproxy，绑定过出口的账号必须走它
    // （否则「A 账号走美国、B 账号走日本」这种按账号落地无从实现）。
    const response = await netproxy.fetchThrough(url.toString(), { method, headers, body, redirect: "error", signal, accountId: grant.accountId });
    const reader = response.body?.getReader?.();
    if (!reader) return { requestId: "", status: response.status, headers: Object.fromEntries(response.headers), done: true };
    const requestId = randomUUID();
    network.set(requestId, { identity: connection(identity), grantId: params.grantId, reader, controller, bytes: 0 });
    return { requestId, status: response.status, headers: Object.fromEntries(response.headers), done: false };
  }
  async function networkRead(identity, params) {
    const item = network.get(String(params?.requestId));
    if (!item || item.identity !== connection(identity)) throw unavailable();
    broker.validate(identity, item.grantId);
    if (item.ws) {
      if (item.queue.length) { const event = item.queue.shift(); item.queuedBytes -= event.bytes; delete event.bytes; return event; }
      if (item.closed) return { type: "close" };
      return await new Promise(resolve => item.waiters.push(resolve));
    }
    const next = await item.reader.read();
    if (next.done) { network.delete(params.requestId); return { done: true, chunk: "" }; }
    item.bytes += next.value.byteLength;
    if (item.bytes > 32 * 1024 * 1024) { network.delete(params.requestId); item.controller.abort(); throw Object.assign(new Error("Upstream response exceeds limit"), { code: "NETWORK_LIMIT" }); }
    return { done: false, chunk: Buffer.from(next.value).toString("base64") };
  }
  async function networkSend(identity, params) {
    const item = network.get(String(params?.requestId));
    if (!item || item.identity !== connection(identity) || !item.ws) throw unavailable();
    broker.validate(identity, item.grantId);
    const data = Buffer.from(String(params?.chunk || ""), "base64");
    if (data.byteLength > 1024 * 1024) throw Object.assign(new Error("WebSocket message exceeds limit"), { code: "NETWORK_LIMIT" });
    item.ws.send(data);
    return { sent: true };
  }
  async function networkClose(identity, params) {
    const item = network.get(String(params?.requestId));
    if (!item || item.identity !== connection(identity)) return { closed: true };
    network.delete(params.requestId); item.controller.abort();
    if (item.ws) { item.closed = true; while (item.waiters.length) item.waiters.shift()({ type: "close" }); try { item.ws.close(); } catch {} }
    else try { await item.reader.cancel(); } catch {}
    return { closed: true };
  }
  const broker = new PoolBroker({ getAccount, ...access, networkOpen, networkRead, networkSend, networkClose, maxLifetimeMs: grantLifetimeMs,
    getModelCatalog(identity, grant) {
      const request = requests.get(requestKey(identity, grant.invocationId));
      if (!request || grant.purpose !== "invoke") return undefined;
      request.execution.assertCurrent();
      return request.catalogModels?.(grant.accountId);
    },
    getExecutionEpoch(identity, grant) {
      const request = requests.get(requestKey(identity, grant.invocationId));
      if (!request) throw unavailable();
      request.execution.assertCurrent();
      return request.session.supports?.("account-execution-epoch@1") ? request.execution.epoch : undefined;
    },
    authorize(identity, grant) {
      const request = requests.get(requestKey(identity, grant.invocationId));
      if (!request || request.accountId !== grant.accountId || request.ref.channel !== grant.channel || request.purpose !== grant.purpose) return false;
      try {
        request.execution.assertCurrent();
        const live = resolve(request.ref);
        return live.session === request.session && connection(live.identity) === connection(identity) && request.authorize() === true;
      } catch { return false; }
    }
  });
  function bindSession(peer, identity) {
    const detach = broker.attach(peer, identity);
    function control(method, params) {
      const { grant } = broker.validate(identity, params?.grantId);
      const request = requests.get(requestKey(identity, grant.invocationId));
      if (grant.purpose !== "invoke" || !request?.attemptScope || params?.invocationId !== grant.invocationId
        || !request.session.supports?.("attempt-reservation@1")) throw unavailable();
      if (method === "reserve") return request.attemptScope.reserve(params.reason);
      if (method === "start") return request.attemptScope.start(params.attemptId);
      if (method === "facts") {
        if (!request.session.supports?.("execution-facts@1")) throw unavailable();
        return request.attemptScope.report(params.attemptId, params.facts);
      }
      return request.attemptScope.complete(params.attemptId, params.replay);
    }
    const controls = [
      peer.handle("execution.reserveAttempt", params => control("reserve", params)),
      peer.handle("execution.startAttempt", params => control("start", params)),
      peer.handle("execution.completeAttempt", params => control("complete", params)),
      peer.handle("execution.reportFacts", params => control("facts", params))
    ];
    let detached = false;
    const revoke = () => {
      if (detached) return;
      detached = true;
      detach();
      for (const dispose of controls) dispose();
      peer.off("closed", revoke);
      for (const request of requests.values()) if (request.connection === connection(identity)) request.close();
    };
    peer.once("closed", revoke);
    return revoke;
  }
  function open({ ref, invocationId, accountId, deadlineAt, purpose = "invoke", authorize, attemptLedger, catalogModels, network: networkAllowed = false }) {
    // Resolve before broker.getAccount: an absent service must not touch the pool.
    const live = resolve(ref);
    if (typeof authorize !== "function" || authorize() !== true || typeof invocationId !== "string" || !invocationId || !["invoke", "catalog"].includes(purpose)
      || deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) || deadlineAt === null && purpose !== "invoke"
      || typeof networkAllowed !== "boolean" || networkAllowed && purpose !== "catalog" || !access.policyFor(ref.channel, purpose)) throw unavailable();
    const key = requestKey(live.identity, invocationId);
    if (requests.has(key)) throw Object.assign(new Error("Invocation already registered"), { code: "INVOCATION_DUPLICATE" });
    const controller = new AbortController();
    const request = { ref: Object.freeze({ ...ref }), accountId, session: live.session, connection: connection(live.identity), purpose,
      networkAllowed, authorize, controller, catalogModels };
    request.execution = execution.acquire(accountId, () => request.close?.());
    requests.set(key, request);
    let grant;
    const grantDeadline = () => deadlineAt === null ? Date.now() + grantLifetimeMs : deadlineAt;
    try { grant = broker.issue({ identity: live.identity, invocationId, accountId, channel: ref.channel, purpose, deadlineAt: grantDeadline() }); }
    catch (error) { requests.delete(key); request.execution.release(); throw error; }
    let released = false, releaseAuthority;
    function close() {
      if (released) return;
      released = true;
      clearTimeout(request.timer);
      releaseAuthority?.();
      request.attemptScope?.close();
      controller.signal.removeEventListener("abort", close);
      broker.revoke(grant.grantId);
      for (const [id, item] of network) if (item.identity === request.connection && item.grantId === grant.grantId) {
        network.delete(id); item.controller.abort();
        if (item.ws) {
          item.closed = true;
          while (item.waiters.length) item.waiters.shift()({ type: "close" });
          try { item.ws.close(); } catch {}
        } else item.reader.cancel().catch(() => {});
      }
      requests.delete(key);
      request.execution.release();
      controller.abort(revoked());
    }
    request.close = close;
    function armExpiry() {
      clearTimeout(request.timer);
      request.timer = setTimeout(close, Math.max(1, grant.expiresAt - Date.now()));
      request.timer.unref?.();
    }
    armExpiry();
    function assertCurrent() {
      const current = resolve(request.ref);
      request.execution.assertCurrent();
      if (released || current.session !== live.session || connection(current.identity) !== request.connection || authorize() !== true) throw unavailable();
      broker.validate(live.identity, grant.grantId);
    }
    try {
      if (attemptLedger !== undefined) {
        if (purpose !== "invoke" || typeof attemptLedger?.open !== "function" || !live.session.supports?.("attempt-reservation@1")) throw unavailable();
        request.attemptScope = attemptLedger.open({ invocationId, accountId, connection: request.connection, authorize: () => { assertCurrent(); return true; } });
      }
      // Identity facts only: ordinary token rotation/usage/cooldown changes do
      // not revoke a generation. Same-uid replacement needs separate provenance.
      const original = getAccount(accountId);
      const stamp = account => JSON.stringify([account?.id, account?.channel, account?.uid, account?.created_at]);
      const identityStamp = stamp(original);
      controller.signal.addEventListener("abort", close, { once: true });
      releaseAuthority = authority.watch({ controller, tags: { accountId, channel: ref.channel }, check() {
        assertCurrent();
        const account = getAccount(accountId);
        return !!account && account.status !== "disabled" && stamp(account) === identityStamp;
      } });
      controller.signal.throwIfAborted();
    } catch (error) { close(); throw error; }
    return Object.freeze({
      get grantId() { return grant.grantId; }, get invocationId() { return invocationId; }, get expiresAt() { return grant.expiresAt; },
      signal: controller.signal, session: live.session, identity: live.identity, assertCurrent,
      // Only the gateway owns this method. No RPC lets a plugin extend itself.
      renew() {
        assertCurrent();
        grant = broker.rotate(live.identity, grant.grantId, grantDeadline());
        armExpiry();
        return { grantId: grant.grantId, expiresAt: grant.expiresAt };
      },
      close
    });
  }
  return Object.freeze({ resolve, capture, open, bindSession, maxGrantLifetimeMs: grantLifetimeMs,
    revokeAccount(accountId) {
      execution.invalidateAccountExecution(accountId);
      broker.revokeAccount(accountId);
      for (const request of [...requests.values()]) if (request.accountId === accountId) request.close();
    },
    close() { closed = true; for (const request of requests.values()) request.close(); broker.close(); },
    get activeGrants() { return broker.grants.size; },
    get activeRequests() { return requests.size; },
    serviceKey
  });
}
module.exports = { createPoolService };
