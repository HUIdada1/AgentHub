"use strict";
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { ProviderRuntime } = require("../electron/backend/extensions/sdk/provider.cjs");
const { ProviderSession } = require("../electron/backend/extensions/provider-session.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");
const { createAttemptLedger } = require("../electron/backend/extensions/attempt-ledger.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = { pluginId: "fixture", publisherId: "publisher", sessionId: "session", generation: 1 };
const declarations = [{ id: "provider", channels: ["channel"] }];
const ref = { kind: "extension", pluginId: "fixture", publisherId: "publisher", providerId: "provider", channel: "channel" };

async function scenario({ revoke = false, unbounded = true } = {}) {
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  let refreshes = 0, authorized = true, leased = 0, token = "original", refreshStarted, refreshFinished, finished = false;
  const account = { id: "account", channel: "channel", status: "online" };
  const session = new ProviderSession({ peer: host, identity, declarations, firstContentMs: 2000, idleMs: 1000 });
  const manager = { providerSessions: () => [{ id: "fixture", identity, session, manifest: { contributes: { providers: declarations } }, permissions: ["pool.forward-scoped"], channels: ["channel"] }] };
  const service = createPoolService({ host: manager, getAccount: () => account, grantLifetimeMs: 400,
    access: { policyFor: () => ({ credentials: ["token"], context: [] }),
      readCredentials: () => ({ token }),
      async ensureCredentials() {
        refreshes++;
        refreshStarted = Date.now();
        // Start at t~140ms; the t~200ms rotation must await this existing
        // management callback, rather than invalidating its successful result.
        await delay(140);
        token = "fresh";
        refreshFinished = Date.now();
        return { token };
      }
    }
  });
  service.bindSession(host, identity);
  const scopes = [], oldIds = new Set();
  const observedService = { ...service, capture(...args) {
    const captured = service.capture(...args);
    return { ...captured, open(options) { const scope = captured.open(options); scopes.push(scope); return scope; } };
  } };
  const pool = { pickAccount: () => account, accountPlan: () => [{ eligible: true, account }], acquireAccount: () => { leased++; }, releaseAccount: () => { leased--; } };
  const runtime = new ProviderRuntime({ peer: plugin, providers: [{ id: "provider", channels: ["channel"],
    async *invoke(params, ctx) {
      try {
        assert.equal(ctx.deadlineAt === Infinity, unbounded, "unbounded is explicit in the local SDK, never an Infinity JSON number");
        assert.deepEqual(await ctx.pool.credentials(), { token: "original" });
        oldIds.add(params.grantId);
        const initialAttempt = ctx.attempts.current;
        assert.equal(initialAttempt.number, 1);
        yield { type: "delta", delta: { role: "assistant" } };
        await delay(140);
        const next = await ctx.pool.ensureCredentials("upstream-auth-expired");
        assert.equal(next.token, "fresh", "rotation cannot lose the original refresh result");
        for (let i = 0; i < 22; i++) {
          await delay(30);
          assert.equal((await ctx.pool.credentials()).token, "fresh");
          assert.equal(ctx.attempts.current.attemptId, initialAttempt.attemptId, "grant rotation cannot silently allocate another model attempt");
          yield { type: "delta", delta: { role: "assistant" } };
        }
        await assert.rejects(ctx.pool.ensureCredentials("upstream-auth-expired"), /refresh exhausted/);
        const retry = await ctx.attempts.next("content-remediation");
        assert.equal(retry.number, 2);
        assert.equal(retry.remaining, 0, "new grant IDs preserve the original shared model budget");
        yield { type: "delta", delta: { content: "next" } };
        await assert.rejects(ctx.attempts.next("auth-retry"), /宿主拒绝/);
        yield { type: "finish", reason: "stop" };
      } finally { finished = true; }
    }
  }] });
  const executor = createExtensionExecutor({ pool, poolService: observedService });
  let revocationTimer;
  const before = Date.now();
  const ledger = createAttemptLedger({ limit: 2 });
  try {
    await session.initialize();
    assert.ok(session.supports("unbounded-deadline@1"));
    assert.ok(session.supports("scoped-grant-rotation@1"));
    if (revoke) revocationTimer = setTimeout(() => { authorized = false; }, 240);
    const ids = new Set();
    const result = await executor.execute({ ref, model: "model", input: {}, authorize: () => authorized,
      attemptLedger: ledger,
      deadlineAt: unbounded ? null : Date.now() + 2500,
      onEvent(event) { if (["delta", "checkpoint"].includes(event.type)) ids.add(scopes[0].grantId); } });
    assert.equal(leased, 0);
    assert.equal(service.activeRequests, 0);
    assert.equal(service.activeGrants, 0);
    assert.equal(refreshes, 1, "opaque ID rotation never resets the invocation's management refresh allowance");
    if (revoke) {
      // Active revocation now returns before the shared management refresh. It
      // releases the model lease immediately, while the original owner keeps
      // running and must still retain its successful result.
      const refreshDeadline = Date.now() + 1000;
      while (!refreshFinished && Date.now() < refreshDeadline) await delay(5);
    }
    assert.ok(refreshFinished >= refreshStarted + 100);
    if (revoke) {
      assert.equal(result.ok, false);
      assert.equal(result.switchable, false);
      assert.equal(token, "fresh", "a successful management refresh survives revocation of its waiting invocation");
    } else {
      assert.equal(result.ok, true);
      assert.equal(ledger.used, 2);
      assert.ok(Date.now() - before > 800, "generation outlives multiple 400ms credential leases");
      assert.ok(ids.size >= 3, "host actually rotates opaque grant IDs, not merely local expiry timestamps");
      for (const id of oldIds) await assert.rejects(plugin.call("pool.readForwardCredentials", { grantId: id }));
    }
    const cleanupDeadline = Date.now() + 1500;
    while (runtime.active.size && Date.now() < cleanupDeadline) await delay(5);
    assert.equal(runtime.active.size, 0);
    assert.equal(finished, true);
    assert.equal(session.active.size, 0);
  } finally {
    clearTimeout(revocationTimer);
    ledger.close();
    service.close(); session.close(); plugin.close(); toHost.destroy(); toPlugin.destroy();
  }
}

async function legacy() {
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  plugin.handle("initialize", () => ({ protocol: 1, capabilities: ["ai.provider@1"], providers: declarations }));
  const session = new ProviderSession({ peer: host, identity, declarations });
  let selected = 0;
  const fakePool = { pickAccount() { selected++; }, accountPlan() { selected++; }, acquireAccount() {}, releaseAccount() {} };
  const service = { maxGrantLifetimeMs: 300000, capture: () => ({ ref, session }) };
  try {
    await session.initialize();
    assert.equal(session.supports("unbounded-deadline@1"), false);
    await assert.rejects(session.invoke({ providerId: "provider", channel: "channel", model: "model", input: {}, grantId: "grant", deadlineAt: null, onEvent() {} }), /Invalid host invocation/);
    const executor = createExtensionExecutor({ pool: fakePool, poolService: service });
    await assert.rejects(executor.execute({ ref, model: "model", input: {}, deadlineAt: null, authorize: () => true, onEvent() {} }), error => error.code === "PLUGIN_FEATURE_UNAVAILABLE");
    await assert.rejects(executor.execute({ ref, model: "model", input: {}, deadlineAt: Date.now() + 1000, authorize: () => true, onEvent() {} }), error => error.code === "PLUGIN_FEATURE_UNAVAILABLE");
    assert.equal(selected, 0, "an old runtime is rejected before pool selection, never silently given a 5 minute timeout");
  } finally { session.close(); plugin.close(); toHost.destroy(); toPlugin.destroy(); }
}

(async () => {
  await scenario();
  await scenario({ unbounded: false });
  await scenario({ revoke: true });
  await legacy();
  console.log("PASS optional deadline/grant features: bounded and unbounded streams exceed short credential leases, drain refresh callbacks before rotation, old grants invalid, refresh budget retained, revocation and legacy fail-closed");
})().catch(error => { console.error(error); process.exitCode = 1; });
