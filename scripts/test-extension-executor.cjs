"use strict";
// The actual original account DB/plan/concurrency, real bidirectional RPC/SDK,
// and a blocked output writer. No production account or upstream access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-executor-"));
const store = require("../electron/backend/proxy/store.cjs");
const originalPool = require("../electron/backend/proxy/pool.cjs");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { ProviderSession } = require("../electron/backend/extensions/provider-session.cjs");
const { ProviderRuntime, forwardError } = require("../electron/backend/extensions/sdk/provider.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");
const { waitForDrain } = require("../electron/backend/localgw/output-drain.cjs");

const identity = { pluginId: "test.plugin", publisherId: "test-publisher", sessionId: "one", generation: 1 };
const declarations = [{ id: "provider", channels: ["loomy"] }];
const ref = { kind: "extension", pluginId: identity.pluginId, publisherId: identity.publisherId, providerId: "provider", channel: "loomy" };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timeout"); await tick(); }
}

async function main() {
  store.addAccount({ channel: "loomy", uid: "fixture", token: "original-secret", source: "paste" });
  const account = store.listAccounts("loomy")[0];
  originalPool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  let selection = 0, accountReads = 0, success = 0, failures = [], authorized = true, mode = "ok", cleanup = 0, changeOnSelection;
  const executionScopes = [];
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  const runtime = new ProviderRuntime({ peer: plugin, providers: [{ id: "provider", channels: ["loomy"],
    async *invoke(_params, ctx) {
      executionScopes.push(ctx.request.stateScope);
      try {
        assert.deepEqual(await ctx.pool.credentials(), { token: "original-secret" });
        assert.equal(originalPool.inFlightCount(account.id), 1, "the original account slot is held while upstream executes");
        if (mode === "rate") throw forwardError({ code: "RATE", category: "rate", scope: "account", replay: "safe", message: "limited", status: 429 });
        if (mode === "denied") throw forwardError({ code: "MODEL_DENIED", category: "model", scope: "invocation", replay: "safe", retryable: false, message: "not retryable", status: 403 });
        if (mode === "task") {
          yield { type: "checkpoint", replay: "unsafe", taskRef: "existing-task" };
          throw forwardError({ code: "UNKNOWN", category: "upstream", scope: "invocation", replay: "safe", message: "task status unknown" });
        }
        for (let i = 0; i < (mode === "slow" ? 40 : 1); i++) yield { type: "delta", delta: { content: "x".repeat(mode === "slow" ? 300 : 1) } };
        yield { type: "usage", mode: "snapshot", usage: { prompt_tokens: 3, completion_tokens: 2 } };
        yield { type: "usage", mode: "delta", usage: { completion_tokens: 1 } };
        yield { type: "finish", reason: "stop" };
      } finally { cleanup++; }
    }
  }] });
  const session = new ProviderSession({ peer: host, identity, declarations, windowBytes: 2048, eventBytes: 1024 });
  let current = [];
  const access = { policyFor: () => ({ credentials: ["token"], context: [] }),
    readCredentials: row => store.accountSecrets(row), ensureCredentials: () => null };
  const service = createPoolService({ host: { providerSessions: () => current }, access,
    getAccount: id => { accountReads++; return store.getAccount(id); } });
  service.bindSession(host, identity);
  const pool = { ...originalPool,
    pickAccount(...args) { selection++; const result = originalPool.pickAccount(...args); changeOnSelection?.(); return result; },
    accountPlan(...args) { selection++; return originalPool.accountPlan(...args); }
  };
  const executor = createExtensionExecutor({ pool, poolService: service,
    onSuccess: () => { success++; }, onFailure: (_account, _model, error) => { failures.push(error.code); } });
  const invoke = (options = {}) => executor.execute({ ref, model: "model", input: { messages: [{ role: "user", content: "test" }] },
    authorize: () => authorized, deadlineAt: Date.now() + 5000, onEvent: () => {}, ...options });
  const unavailable = fn => assert.rejects(fn, error => error.code === "FORWARD_PLUGIN_UNAVAILABLE");
  const entry = () => ({ id: identity.pluginId, manifest: { contributes: { providers: declarations } },
    identity, session, permissions: ["pool.forward-scoped"], channels: ["loomy"] });
  try {
    await session.initialize();
    await unavailable(() => invoke());
    current = [entry()];
    authorized = false;
    await unavailable(() => invoke());
    authorized = true;
    const policy = access.policyFor;
    access.policyFor = () => null;
    await unavailable(() => invoke());
    access.policyFor = policy;
    session.providers = [];
    await unavailable(() => invoke());
    session.providers = declarations;
    assert.equal(selection, 0);
    assert.equal(accountReads, 0, "missing/denied/unimplemented services never select or decrypt an account");
    await assert.rejects(invoke({ stateContext: () => ({ audience: "", authorizationVersion: "1" }) }), /scope/);
    assert.equal(selection, 0); assert.equal(accountReads, 0, "invalid state facts fail before pool selection");

    const events = [];
    const result = await invoke({ onEvent: event => events.push(event) });
    assert.equal(result.ok, true);
    assert.equal(success, 1);
    assert.deepEqual(events.map(event => event.type), ["delta", "usage", "finish"]);
    assert.deepEqual(events[1].usage, { prompt_tokens: 3, completion_tokens: 3 });
    assert.equal(originalPool.inFlightCount(account.id), 0);
    assert.equal(service.activeGrants, 0);
    assert.equal(service.activeRequests, 0);
    const firstScope = executionScopes.at(-1);
    assert.match(firstScope, /^[a-f0-9]{64}$/);

    const previousUsed = originalPool.poolAccounts("loomy", true).find(row => row.id === account.id).lastUsed;
    assert.ok(previousUsed > 0, "read the ORIGINAL in-memory lastUsed overlay, not just its DB column");
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await invoke({ probe: true })).ok, true);
    assert.equal(success, 1, "probe never updates original pool health/statistics");
    assert.equal(originalPool.poolAccounts("loomy", true).find(row => row.id === account.id).lastUsed, previousUsed, "probe uses read-only accountPlan");

    mode = "rate";
    const rate = await invoke();
    assert.equal(rate.status, 429);
    assert.equal(rate.switchable, true);
    assert.deepEqual(failures, ["RATE"]);
    await invoke({ probe: true });
    assert.notEqual(executionScopes.at(-1), firstScope, "context-free probes never recover an earlier conversation");
    assert.deepEqual(failures, ["RATE"], "probe never applies account failures");
    mode = "denied";
    const denied = await invoke();
    assert.equal(denied.status, 403);
    assert.equal(denied.replay, "safe", "replay safety is not the same as desirability");
    assert.equal(denied.switchable, false, "explicit rejection cannot be fixed by switching accounts");
    assert.deepEqual(failures, ["RATE"], "deterministic invocation rejection never cools an account");
    mode = "task";
    const task = await invoke();
    assert.equal(task.replay, "unsafe");
    assert.equal(task.switchable, false, "created tasks are not replayable merely because no delta was emitted");

    mode = "ok";
    changeOnSelection = () => { current = [{ ...entry(), identity: { ...identity, generation: 2 } }]; };
    const readsBefore = accountReads;
    const replaced = await invoke();
    assert.equal(replaced.ok, false);
    assert.equal(replaced.failureScope, "service");
    assert.equal(accountReads, readsBefore, "a generation changed during selection cannot read credentials");
    assert.equal(originalPool.inFlightCount(account.id), 0);
    changeOnSelection = null;
    current = [entry()];

    // A synchronous sink may expand one model event into multiple HTTP frames.
    // Hold its actual writer: credit must not return until drain, and cancellation
    // must release all original-pool and RPC resources while it is blocked.
    mode = "slow";
    const writer = new PassThrough({ highWaterMark: 1 });
    const controller = new AbortController();
    let wrote = false;
    const waiting = invoke({ signal: controller.signal, onEvent: async (event, consumeSignal) => {
      if (event.type === "delta") { writer.write(event.delta.content); wrote = true; await waitForDrain(writer, consumeSignal); }
    } });
    await until(() => wrote && runtime.active.values().next().value?.waitCredit);
    assert.ok(session.queuedBytes <= 2048);
    assert.equal(originalPool.inFlightCount(account.id), 1);
    assert.equal((await host.call("status", {})).active, 1);
    controller.abort(new Error("cancel blocked output"));
    const cancelled = await waiting;
    assert.equal(cancelled.errCode, "cancelled");
    await until(() => runtime.active.size === 0);
    assert.equal(originalPool.inFlightCount(account.id), 0);
    assert.equal(service.activeRequests, 0);
    assert.equal(service.activeGrants, 0);
    assert.equal(writer.listenerCount("drain"), 0);
    assert.equal(writer.listenerCount("close"), 0);
    assert.equal(writer.listenerCount("error"), 0);
    writer.destroy();
    assert.ok(cleanup >= 6);
    console.log("PASS extension executor: original pool/leases, source/handshake/policy gates before reads, usage, probe, unsafe tasks, generation race, real RPC byte credit and writer cancellation");
  } finally {
    service.close(); session.close(); plugin.close(); toHost.destroy(); toPlugin.destroy();
    store.close();
    fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
