"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { ProviderRuntime } = require("../electron/backend/extensions/sdk/provider.cjs");
const { ProviderSession } = require("../electron/backend/extensions/provider-session.cjs");
const { PoolBroker } = require("../electron/backend/extensions/pool-broker.cjs");
const protocol = require("../electron/backend/extensions/provider-protocol.cjs");
const identity = { pluginId: "test.plugin", publisherId: "verified-test-publisher", sessionId: "connection-one", generation: 7 };
const declarations = [{ id: "mock", channels: ["test-channel"] }];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function brokerFor(peer) {
  const broker = new PoolBroker({
    getAccount: id => ({ id, channel: "test-channel", status: "online" }),
    readCredentials: () => ({ token: "scoped-test-token", refreshToken: "must-not-expose" }),
    ensureCredentials: () => ({ token: "fresh-scoped-token" }),
    readContext: () => ({ region: "test-region", privateField: "must-not-expose" }),
    policyFor: () => ({ credentials: ["token"], context: ["region"] }),
    authorize: () => true,
  });
  broker.attach(peer, identity);
  return broker;
}
function makeSession(peer, broker, options = {}) {
  return new ProviderSession({ peer, identity, declarations, windowBytes: 2048, eventBytes: 1024, onRevoke: id => broker.revokeInvocation(id), ...options });
}
function issue(broker, invocationId) {
  return broker.issue({ identity, invocationId, accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 5000 }).grantId;
}
function invoke(session, broker, id, onEvent, extra = {}) {
  return session.invoke({ invocationId: id, providerId: "mock", channel: "test-channel", model: "test-model", input: {}, grantId: issue(broker, id), deadlineAt: Date.now() + 5000, onEvent, ...extra });
}
function pair(provider, options = {}) {
  const toPlugin = new PassThrough(), toHost = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:", maxFrameBytes: protocol.LIMITS.frameBytes });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:", maxFrameBytes: protocol.LIMITS.frameBytes });
  const runtime = new ProviderRuntime({ peer: plugin, providers: [{ id: "mock", channels: ["test-channel"], ...provider }] });
  const broker = brokerFor(host);
  const session = makeSession(host, broker, options);
  return { host, plugin, runtime, broker, session, toHost, close() { session.close(); plugin.close(); broker.close(); toHost.destroy(); toPlugin.destroy(); } };
}

async function main() {
  const policyError = { code: "DENIED", category: "model", scope: "invocation", replay: "safe", message: "denied", retryable: false };
  protocol.validateError(policyError);
  assert.throws(() => protocol.validateError({ ...policyError, retryable: "false" }), /retry policy/);
  for (const feature of ["explicit-retry-policy@1", "execution-facts@1", "request-headers@1", "state-scope@1", "account-execution-epoch@1"]) {
    const incompatible = pair({ requiredFeatures: [feature], async *invoke() { throw new Error("must not execute"); } });
    try {
    await assert.rejects(incompatible.host.call("initialize", { protocol: protocol.PROTOCOL, generation: identity.generation,
      features: protocol.FEATURES.filter(value => value !== feature), windowBytes: 2048, eventBytes: 1024 }), /features/);
    assert.equal(incompatible.runtime.initialized, false, "incompatible host fails before READY or account access");
    assert.equal(incompatible.broker.grants.size, 0);
    await incompatible.session.initialize();
    assert.equal(incompatible.session.supports(feature), true);
    if (feature === "execution-facts@1") {
      await assert.rejects(invoke(incompatible.session, incompatible.broker, "no-budget", () => {}), /attempt budget/);
      assert.equal(incompatible.runtime.active.size, 0, "required facts cannot execute without scoped attempt control");
    }
    if (feature === "state-scope@1") {
      await assert.rejects(invoke(incompatible.session, incompatible.broker, "missing-scope", () => {}), /state scope/);
      assert.equal(incompatible.runtime.active.size, 0, "required scope fails before provider execution");
    }
    } finally { incompatible.close(); }
  }
  const opaqueScope = "a".repeat(64);
  let scopedInvocations = 0;
  const scoped = pair({ requiredFeatures: ["state-scope@1"], async *invoke(params, ctx) {
    scopedInvocations++;
    assert.equal(ctx.request.stateScope, opaqueScope);
    assert.equal(Object.isFrozen(ctx.request), true);
    assert.notEqual(ctx.request.stateScope, params.input.stateScope, "model body cannot replace host metadata");
    yield { type: "delta", delta: { content: "scoped" } };
    yield { type: "finish", reason: "stop" };
  } });
  try {
    await scoped.session.initialize();
    for (const value of [undefined, null, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "a".repeat(63) + "\n", "a".repeat(64) + "\n", 123, {}]) {
      await assert.rejects(invoke(scoped.session, scoped.broker, "invalid-scope-host", () => {}, { stateScope: value }), /state scope/);
      // Independently check SDK wire validation, bypassing ProviderSession.
      await assert.rejects(scoped.host.call("invoke", { invocationId: "invalid-scope-wire", providerId: "mock", channel: "test-channel",
        generation: identity.generation, model: "test-model", input: {}, grantId: "fixture", remainingMs: 1000, stateScope: value }), /state scope/);
    }
    assert.equal(scopedInvocations, 0);
    assert.equal(scoped.runtime.active.size, 0);
    await invoke(scoped.session, scoped.broker, "valid-scope", () => {}, { stateScope: opaqueScope, input: { stateScope: "forged-body" } });
    assert.equal(scopedInvocations, 1);
    scoped.session.features = scoped.session.features.filter(feature => feature !== "state-scope@1");
    await assert.rejects(invoke(scoped.session, scoped.broker, "unnegotiated-scope", () => {}, { stateScope: opaqueScope }), /not negotiated/);
  } finally { scoped.close(); }
  for (const badHeaders of [{ authorization: "private" }, { "x-session-id": ["one"] }, { "x-session-id": "bad\nvalue" },
    { "x-session-id": "x".repeat(4097) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x-session-${i}`, "one"])),
    Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-session-${i}`, "x".repeat(4096)]))]) {
    assert.throws(() => protocol.validateRequestHeaders(badHeaders), /header/);
  }
  let headerInvocations = 0;
  const headerPeers = pair({ async *invoke(_request, ctx) {
    headerInvocations++;
    assert.deepEqual(ctx.request.headers, { "x-session-id": "session-one" });
    assert.equal(Object.isFrozen(ctx.request), true); assert.equal(Object.isFrozen(ctx.request.headers), true);
    yield { type: "delta", delta: { content: "header-contract" } };
    yield { type: "finish", reason: "stop" };
  } });
  try {
    await headerPeers.session.initialize();
    await invoke(headerPeers.session, headerPeers.broker, "headers", () => {}, { requestHeaders: { "x-session-id": "session-one" } });
    await assert.rejects(invoke(headerPeers.session, headerPeers.broker, "bad-headers", () => {}, { requestHeaders: { "x-session-id": ["ambiguous"] } }), /header/);
    assert.equal(headerInvocations, 1, "bad header metadata never executes provider code");
  } finally { headerPeers.close(); }
  let generated = 0;
  let peers = pair({
    async listModels() { return [{ id: "test-model" }]; },
    async *invoke(_request, ctx) {
      assert.deepEqual(await ctx.pool.credentials(), { token: "scoped-test-token" });
      for (let index = 0; index < 80; index++) {
        generated++;
        yield { type: "delta", delta: { content: "汉".repeat(80) } };
      }
      yield { type: "usage", mode: "snapshot", usage: { prompt_tokens: 2, completion_tokens: 80 } };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await peers.session.initialize();
    assert.deepEqual(await peers.session.listModels({ providerId: "mock", channel: "test-channel" }), [{ id: "test-model" }]);
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const events = [];
    const completion = invoke(peers.session, peers.broker, "slow", async event => { events.push(event); if (events.length === 1) await blocked; });
    await until(() => !!peers.runtime.active.get("slow")?.waitCredit);
    const generatedAtPause = generated;
    await tick(); await tick();
    assert.equal(generated, generatedAtPause, "SDK must stop pulling when the consumer retains credit");
    assert.ok(generated < 12 && peers.session.queuedBytes <= 2048, "slow consumer memory and upstream reads must be bounded");
    assert.equal((await peers.host.call("status", {})).active, 1, "control calls work with a full stream window");
    const grantId = [...peers.broker.grants.keys()][0];
    assert.deepEqual(await peers.plugin.call("pool.ensureForwardCredentials", { grantId, reason: "upstream-auth-expired" }), { token: "fresh-scoped-token" });
    release();
    assert.equal((await completion).ok, true);
    assert.equal(events.length, 82);
    assert.equal(events.at(-1).type, "finish");
    assert.equal(peers.session.queuedBytes, 0);
    assert.equal(peers.session.queuedDataBytes, 0);
    assert.equal(peers.broker.grants.size, 0);
    await until(() => peers.runtime.active.size === 0);
  } finally { peers.close(); }

  let cleanup = 0;
  peers = pair({ async *invoke(_request, ctx) {
    try {
      yield { type: "delta", delta: { content: "first" } };
      ctx.signal.throwIfAborted();
      await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
    } finally { cleanup++; }
  } });
  try {
    await peers.session.initialize();
    const controller = new AbortController();
    let started = false;
    const completion = invoke(peers.session, peers.broker, "cancel", async () => { started = true; await new Promise(() => {}); }, { signal: controller.signal });
    const rejected = assert.rejects(completion, /cancelled-by-test/);
    await until(() => started);
    controller.abort(new Error("cancelled-by-test"));
    await rejected;
    assert.equal(peers.session.active.size, 0);
    assert.equal(peers.broker.grants.size, 0);
    await until(() => cleanup === 1 && peers.runtime.active.size === 0);
    assert.equal(peers.host.closed, false, "cooperative per-call cancellation must retain shared runtime");
  } finally { peers.close(); }

  peers = pair({ async *invoke() { throw new Error("SECRET-TOKEN: must not cross RPC"); } });
  try {
    await peers.session.initialize();
    await assert.rejects(invoke(peers.session, peers.broker, "redacted", () => {}), error => error.code === "UPSTREAM_FAILED" && !error.message.includes("SECRET-TOKEN"));
    assert.equal(peers.broker.grants.size, 0);
  } finally { peers.close(); }

  peers = pair({ async *invoke(_request, ctx) {
    while (!ctx.signal.aborted) {
      yield { type: "usage", mode: "snapshot", usage: { total_tokens: 0 } };
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } }, { firstContentMs: 40 });
  try {
    await peers.session.initialize();
    await assert.rejects(invoke(peers.session, peers.broker, "no-content", () => {}), error => error.code === "PLUGIN_TIMEOUT");
    await until(() => peers.runtime.active.size === 0);
  } finally { peers.close(); }

  peers = pair({ async *invoke(_request, ctx) {
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
  } });
  try {
    await peers.session.initialize();
    const result = invoke(peers.session, peers.broker, "bad-sequence", () => {});
    const rejected = assert.rejects(result, error => error.code === "PLUGIN_DISCONNECTED");
    await until(() => peers.runtime.active.size === 1);
    await peers.plugin.notify("provider.event", { type: "delta", invocationId: "bad-sequence", generation: 7, seq: 2, delta: { content: "must not pass" } });
    await rejected;
    assert.equal(peers.session.queuedBytes, 0);
    assert.equal(peers.broker.grants.size, 0);
  } finally { peers.close(); }

  const child = spawn(process.execPath, [path.join(__dirname, "fixtures/stdio-provider.cjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  const peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:", maxFrameBytes: protocol.LIMITS.frameBytes });
  const broker = brokerFor(peer), session = makeSession(peer, broker);
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await session.initialize();
    const events = [];
    await invoke(session, broker, "real-child", event => { events.push(event); });
    assert.equal(events[0].delta.content, "你好");
    assert.equal(events[1].delta.tool_calls[0].function.name, "lookup");
    assert.equal(events[2].usage.total_tokens, 5);
    assert.equal(events[3].reason, "tool_calls");
    assert.equal(broker.grants.size, 0);
    assert.equal(diagnostics, "");
  } finally { session.close(); broker.close(); child.kill(); await exited; }
  console.log("PASS provider session/SDK: scoped nested callbacks, byte credit/slow consumer, control reserve, cancellation, first-content deadline, redacted errors, sequence faults, grant cleanup and real child stdio model stream");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
