"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { createAttemptLedger } = require("../electron/backend/extensions/attempt-ledger.cjs");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { ProviderRuntime, forwardError } = require("../electron/backend/extensions/sdk/provider.cjs");
const { ProviderSession } = require("../electron/backend/extensions/provider-session.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");
const owner = { invocationId: "one", accountId: "account", connection: "verified-connection", authorize: () => true };
function unit() {
  assert.throws(() => createAttemptLedger({ limit: 11 }));
  const budget = createAttemptLedger({ limit: 2 });
  const a = budget.open(owner), b = budget.open({ ...owner, invocationId: "other" });
  const first = a.reserve("initial");
  assert.equal(budget.remaining, 1);
  assert.throws(() => b.start(first.attemptId), error => error.code === -32043);
  assert.throws(() => a.reserve("auth-retry"), error => error.code === -32043);
  a.start(first.attemptId);
  assert.throws(() => a.start(first.attemptId), error => error.code === -32043);
  a.complete(first.attemptId, "safe"); a.close();
  const second = b.reserve("initial"); b.start(second.attemptId); b.complete(second.attemptId, "safe");
  assert.throws(() => b.reserve("content-remediation"), error => error.code === -32040);
  assert.equal(budget.used, 2); budget.close();
  assert.throws(() => b.complete(second.attemptId, "safe"), error => error.code === -32041);

  for (const outcome of ["unknown", "unsafe"]) {
    const ledger = createAttemptLedger({ limit: 3 }), scope = ledger.open(owner);
    const item = scope.reserve("initial"); scope.start(item.attemptId); scope.complete(item.attemptId, outcome);
    assert.throws(() => scope.reserve("auth-retry"), error => error.code === -32042);
    ledger.close();
  }
  const blocked = createAttemptLedger({ limit: 3 }), blockedScope = blocked.open(owner);
  const item = blockedScope.reserve("initial"); blockedScope.start(item.attemptId);
  blocked.preventReplay(); blockedScope.complete(item.attemptId, "safe");
  assert.throws(() => blockedScope.reserve("content-remediation"), error => error.code === -32042, "a plugin safe declaration cannot undo received content");
  blocked.close();
  const abandoned = createAttemptLedger({ limit: 3 }), abandonedScope = abandoned.open(owner);
  abandonedScope.reserve("initial"); abandonedScope.close();
  assert.equal(abandoned.used, 1); assert.equal(abandoned.snapshot()[0].replay, "unknown");
  assert.throws(() => abandoned.assertAvailable(), error => error.code === -32042);
  abandoned.close();
  let monotonic = 0;
  const deadline = createAttemptLedger({ deadlineAt: Date.now() + 100, now: () => monotonic });
  monotonic = 101;
  assert.throws(() => deadline.assertAvailable(), error => error.code === -32041);
  deadline.close();

  const factsLedger = createAttemptLedger({ limit: 2 }), factsScope = factsLedger.open(owner), foreignScope = factsLedger.open({ ...owner, invocationId: "foreign" });
  const factsTicket = factsScope.reserve("initial");
  const planned = { state: "planned", actualModel: "vendor/实际模型" };
  assert.throws(() => factsScope.report(factsTicket.attemptId, planned), error => error.code === -32043, "reserved is not started");
  factsScope.start(factsTicket.attemptId);
  assert.throws(() => foreignScope.report(factsTicket.attemptId, planned), error => error.code === -32043);
  assert.throws(() => factsScope.report(factsTicket.attemptId, { ...planned, state: "responded" }), error => error.code === -32043);
  for (const bad of [{ ...planned, actualModel: "x\nsecret" }, { ...planned, actualModel: "" }, { ...planned, actualModel: "界".repeat(342) },
    { ...planned, token: "never-store" }, { ...planned, state: "charged" }, { ...planned, upstreamReportedModel: "premature" }]) {
    assert.throws(() => factsScope.report(factsTicket.attemptId, bad), error => error.code === "PLUGIN_PROTOCOL");
  }
  assert.deepEqual(factsScope.report(factsTicket.attemptId, planned), { recorded: true });
  assert.deepEqual(factsScope.report(factsTicket.attemptId, planned), { recorded: true }, "same report is idempotent");
  assert.throws(() => factsScope.report(factsTicket.attemptId, { ...planned, actualModel: "substituted" }), error => error.code === -32043);
  const responded = { ...planned, state: "responded", upstreamReportedModel: "reported-model" };
  factsScope.report(factsTicket.attemptId, responded);
  factsScope.report(factsTicket.attemptId, responded);
  assert.throws(() => factsScope.report(factsTicket.attemptId, planned), error => error.code === -32043, "stage cannot regress");
  assert.throws(() => factsScope.report(factsTicket.attemptId, { ...responded, upstreamReportedModel: "different" }), error => error.code === -32043);
  const copy = factsLedger.snapshot(); copy[0].facts.actualModel = "mutated";
  assert.equal(factsLedger.snapshot()[0].facts.actualModel, planned.actualModel, "snapshots cannot mutate ledger facts");
  factsScope.complete(factsTicket.attemptId, "safe");
  const next = factsScope.reserve("auth-retry"); factsScope.start(next.attemptId);
  assert.throws(() => factsScope.report(factsTicket.attemptId, responded), error => error.code === -32043, "old attempts cannot be amended");
  factsScope.report(next.attemptId, { state: "planned", actualModel: "a".repeat(1024) });
  factsScope.close();
  assert.throws(() => factsScope.report(next.attemptId, planned), error => error.code === -32043);
  assert.equal(factsLedger.snapshot()[1].facts.state, "planned", "uncertain dispatch is not promoted to responded");
  factsLedger.close();
}
async function integration() {
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const hostPeer = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const pluginPeer = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  let sends = 0, selected = 0, leased = 0, mode = "retry", chosen = "a";
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    assert.ok(JSON.parse(raw).attemptId); sends++;
    if (mode === "cancel-dispatch") { res.once("close", () => {}); return; }
    res.end("model-result");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const identity = { pluginId: "test", publisherId: "publisher", sessionId: "session", generation: 1 };
  const declarations = [{ id: "provider", channels: ["channel"] }];
  const ref = { kind: "extension", pluginId: "test", publisherId: "publisher", providerId: "provider", channel: "channel" };
  const runtime = new ProviderRuntime({ peer: pluginPeer, providers: [{ ...declarations[0], async *invoke(request, ctx) {
    await ctx.pool.credentials();
    if (mode === "retry") {
      const auth = { grantId: request.grantId, invocationId: request.invocationId };
      await assert.rejects(pluginPeer.call("execution.reserveAttempt", { ...auth, invocationId: "different-invocation", reason: "auth-retry" }));
      await assert.rejects(pluginPeer.call("execution.reserveAttempt", { ...auth, grantId: "different-grant", reason: "auth-retry" }));
      await assert.rejects(pluginPeer.call("execution.reserveAttempt", { ...auth, reason: "admin.exec" }), error => error.code === -32602);
      await assert.rejects(pluginPeer.call("execution.startAttempt", { ...auth, attemptId: "different-ticket" }), error => error.code === -32043);
      const facts = { state: "planned", actualModel: "forged" };
      await assert.rejects(pluginPeer.call("execution.reportFacts", { ...auth, invocationId: "other", attemptId: ctx.attempts.current.attemptId, facts }));
      await assert.rejects(pluginPeer.call("execution.reportFacts", { ...auth, grantId: "other", attemptId: ctx.attempts.current.attemptId, facts }));
      await assert.rejects(pluginPeer.call("execution.reportFacts", { ...auth, attemptId: "other", facts }), error => error.code === -32043);
      const savedFeatures = session.features;
      session.features = savedFeatures.filter(feature => feature !== "execution-facts@1");
      try {
        await assert.rejects(pluginPeer.call("execution.reportFacts", { ...auth, attemptId: ctx.attempts.current.attemptId, facts }));
      } finally { session.features = savedFeatures; }
      assert.equal(ctx.attempts.current.number, 1, "rejected control calls do not reset or consume another reservation");
    }
    const send = async () => {
      const facts = { state: "planned", actualModel: `private/model-${ctx.attempts.current.number}` };
      await ctx.attempts.report(facts);
      if (mode === "before-send") throw new Error("no network request sent");
      const response = await fetch(endpoint, { method: "POST", signal: ctx.signal, body: JSON.stringify({ attemptId: ctx.attempts.current.attemptId }) });
      await ctx.attempts.report({ ...facts, state: "responded", upstreamReportedModel: "reported" });
      await response.text();
    };
    await send();
    if (mode === "retry" || mode === "exhaust") {
      await ctx.attempts.next("content-remediation"); await send();
      if (mode === "exhaust") { await ctx.attempts.next("auth-retry"); await send(); }
    }
    if (mode === "safe") throw forwardError({ code: "RATE", message: "limited", status: 429, category: "rate", scope: "account", replay: "safe" });
    if (mode === "unknown") throw new Error("dispatch outcome unknown");
    if (mode === "output" || mode === "task") {
      yield mode === "output" ? { type: "delta", delta: { content: "already generated" } } : { type: "checkpoint", replay: "unsafe", taskRef: "created-task" };
      await ctx.attempts.next("content-remediation"); await send();
    }
    yield { type: "delta", delta: { content: "done" } };
    yield { type: "finish", reason: "stop" };
  } }] });
  const session = new ProviderSession({ peer: hostPeer, identity, declarations });
  const service = createPoolService({ host: { providerSessions: () => [{ id: "test", identity, session, manifest: { contributes: { providers: declarations } }, permissions: ["pool.forward-scoped"], channels: ["channel"] }] },
    getAccount: id => ({ id, channel: "channel", status: "online" }), access: {
      policyFor: () => ({ credentials: ["token"], context: [] }), readCredentials: () => ({ token: "scoped" }), ensureCredentials: () => null
    } });
  service.bindSession(hostPeer, identity);
  const pool = { pickAccount() { selected++; return { id: chosen }; }, accountPlan: () => [], acquireAccount() { leased++; }, releaseAccount() { leased--; } };
  const executor = createExtensionExecutor({ pool, poolService: service });
  const execute = (ledger, extra = {}) => executor.execute({ ref, model: "model", input: {}, authorize: () => true,
    attemptLedger: ledger, deadlineAt: Date.now() + 3000, onEvent() {}, ...extra });
  try {
    await session.initialize();
    for (const [scenario, limit, expectedSends, expectedOk] of [["retry", 2, 2, true], ["exhaust", 2, 2, false], ["output", 3, 1, false], ["task", 3, 1, false]]) {
      mode = scenario; sends = 0;
      const ledger = createAttemptLedger({ limit });
      const result = await execute(ledger);
      assert.equal(result.ok, expectedOk, JSON.stringify(result));
      assert.equal(sends, expectedSends, `${scenario} must reserve before every actual loopback model send`);
      assert.equal(ledger.used, expectedSends);
      assert.equal(result.executionFacts.length, expectedSends);
      assert.deepEqual(result.executionFacts.map(row => row.actualModel), Array.from({ length: expectedSends }, (_, i) => `private/model-${i + 1}`));
      assert.ok(result.executionFacts.every(row => row.state === "responded" && row.upstreamReportedModel === "reported"));
      assert.doesNotMatch(JSON.stringify(result.executionFacts), /verified-connection|session|accountId|grantId/);
      assert.ok(ledger.snapshot().every(row => row.state === "terminal"));
      assert.equal(leased, 0); assert.equal(service.activeGrants, 0); ledger.close();
    }
    mode = "safe"; sends = 0; chosen = "a";
    const shared = createAttemptLedger({ limit: 2 });
    assert.equal((await execute(shared)).switchable, true);
    chosen = "b"; mode = "ok";
    const secondResult = await execute(shared);
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.executionFacts.length, 1, "prior account/invocation facts do not leak into a later result");
    assert.equal(secondResult.executionFacts[0].number, 2, "attempt numbering belongs to the shared ledger");
    assert.equal(sends, 2);
    assert.deepEqual(shared.snapshot().map(row => row.accountId), ["a", "b"], "account changes use the same total budget");
    const selectedBefore = selected;
    await assert.rejects(execute(shared), error => error.code === -32042 || error.code === -32040);
    assert.equal(selected, selectedBefore, "spent or unsafe budgets are rejected before selection");
    shared.close();
    mode = "unknown"; sends = 0;
    const unknown = createAttemptLedger({ limit: 3 });
    assert.equal((await execute(unknown)).switchable, false);
    await assert.rejects(execute(unknown), error => error.code === -32042);
    assert.equal(sends, 1); unknown.close();
    mode = "before-send"; sends = 0;
    const notSent = createAttemptLedger({ limit: 1 });
    const failedBeforeSend = await execute(notSent);
    assert.equal(failedBeforeSend.ok, false); assert.equal(sends, 0);
    assert.equal(failedBeforeSend.executionFacts[0].state, "planned", "a report of intent never proves a dispatch");
    notSent.close();
    mode = "cancel-dispatch"; sends = 0;
    const cancelledLedger = createAttemptLedger({ limit: 1 }), controller = new AbortController();
    const running = execute(cancelledLedger, { signal: controller.signal });
    const timeout = Date.now() + 1500;
    while (!sends && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sends, 1); controller.abort(new Error("stop pending upstream"));
    const cancelled = await running;
    assert.equal(cancelled.errCode, "cancelled");
    assert.equal(cancelled.executionFacts[0].state, "planned", "cancel without response retains only the accepted planned fact");
    assert.equal(cancelled.switchable, false);
    cancelledLedger.close();
    assert.equal(service.activeRequests, 0);
    const end = Date.now() + 1000;
    while (runtime.active.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.active.size, 0);
    assert.equal(session.active.size, 0);
    console.log("PASS attempt ledger: real RPC/SDK and loopback sends, shared budget, execution-fact ownership/order/size/negotiation, pre-send failure/cancellation, per-invocation isolation, barriers, no refund and monotonic deadline");
  } finally {
    service.close(); session.close(); pluginPeer.close(); toHost.destroy(); toPlugin.destroy();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
}
(async () => { unit(); await integration(); })().catch(error => { console.error(error); process.exitCode = 1; });
