"use strict";
// Real bidirectional RPC/SDK and catalog-purpose grants. No production data or
// upstream, and no legacy adapter model facts used by the directory.
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { ProviderRuntime } = require("../electron/backend/extensions/sdk/provider.cjs");
const { ProviderSession } = require("../electron/backend/extensions/provider-session.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createExecutionServices } = require("../electron/backend/localgw/services.cjs");
const { createModelCatalog, normalizeModels } = require("../electron/backend/localgw/model-catalog.cjs");
const { DEFAULTS: proxyRuleDefaults } = require("../electron/backend/proxy/rules.cjs");
const protocol = require("../electron/backend/extensions/provider-protocol.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("catalog test condition timed out");
}
async function main() {
  assert.deepEqual(normalizeModels([{ id: "pdf-model", capabilities: { pdf: true, privateField: true } }])[0].capabilities,
    { pdf: true }, "declared PDF support survives the gateway catalog boundary");
  assert.deepEqual(normalizeModels([{ id: "routed", routing: { upstreamId: "uuid-1", interfaceType: "openai_responses", nested: { value: true } } }])[0].routing,
    { upstreamId: "uuid-1", interfaceType: "openai_responses", nested: { value: true } }, "opaque plugin routing metadata survives generic catalog normalization");
  assert.throws(() => normalizeModels([{ id: "bad-route", routing: { route: "x".repeat(513) } }]), /不可用/,
    "routing metadata has a bounded value size");
  assert.deepEqual(normalizeModels([{ id: "routed", routing: { upstreamId: "uuid-1", interfaceType: "openai_responses", nested: { value: true } } }])[0].routing,
    { upstreamId: "uuid-1", interfaceType: "openai_responses", nested: { value: true } }, "opaque plugin routing metadata survives generic catalog normalization");
  assert.throws(() => normalizeModels([{ id: "bad-route", routing: { secret: "x".repeat(513) } }]), /不可用/,
    "routing metadata has a bounded value size");
  const zcodeModels = proxyRuleDefaults["catalog.json"].zcode.models;
  for (const [id, maxOutputTokens] of [["GLM-4.6V", 32768], ["GLM-5V-Turbo", 131072]]) {
    const model = zcodeModels.find(item => item.id === id);
    assert.ok(model, `${id} must be present in the ZCode fallback catalog`);
    assert.equal(model.capabilities.images, true);
    assert.equal(model.capabilities.reasoning, false);
    assert.equal(model.maxOutputTokens, maxOutputTokens);
    assert.equal(model.contextLength, 0, "unknown context length stays unknown");
  }
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const hostPeer = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:", maxFrameBytes: protocol.LIMITS.frameBytes });
  const pluginPeer = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:", maxFrameBytes: protocol.LIMITS.frameBytes });
  const identity = { pluginId: "fixture.catalog", publisherId: "fixture-publisher", sessionId: "catalog-session", generation: 1 };
  const ref = { kind: "extension", pluginId: identity.pluginId, publisherId: identity.publisherId, providerId: "fixture", channel: "fixture-channel" };
  const declaration = { id: "fixture", channels: [ref.channel], catalogMode: "account" };
  const manifest = { version: "1.0.0", contributes: { providers: [declaration] } };
  let sourceReady = true, mode = "account", calls = 0, reads = 0, opens = 0, closed = 0, blocked, release, failNextOpen = false, catalogAllowed = true, plans = 0, accountLookups = 0;
  const slowAccounts = new Set();
  const accounts = new Map(["a", "b"].map(id => [id, { id, channel: ref.channel, uid: id, status: "online", token_enc: `cipher-${id}`, meta: "{}" }]));
  const standard = { id: "standard", enabled: true, kind: "openai_compat", models: [{ model: "client", upstream: "wire", rate: 2 }], updatedAt: 1 };
  let state = { localgw: { models: { serviceBindings: {} } } }, clock = 1000, authorized = true;
  const store = { getAccount: id => { accountLookups++; return accounts.get(id); }, getProvider: id => id === standard.id ? standard : null, listProviders: () => [standard], channelList: () => [{ id: ref.channel, kind: "builtin" }, { id: "retired-extension", kind: "builtin" }] };
  const pool = { accountPlan(channel) { plans++; return channel === ref.channel ? [...accounts.values()].map(account => ({ account, eligible: account.status === "online" })) : []; } };
  const runtime = new ProviderRuntime({ peer: pluginPeer, providers: [{ id: declaration.id, channels: declaration.channels,
    async listModels(params, ctx) {
      calls++;
      if (params.force) assert.equal(typeof ctx.pool.network().fetch, "function", "only explicit refresh receives catalog network capability");
      else assert.throws(() => ctx.pool.network(), /explicit forced refresh/, "ordinary catalog reads cannot access network");
      if (blocked) await blocked;
      if (mode === "error") throw new Error("synthetic catalog failure");
      if (mode === "public") { assert.equal(params.grantId, undefined); return [{ id: "Public" }]; }
      const credentials = await ctx.pool.credentials();
      if (mode === "slow") { slowAccounts.add(credentials.token); await new Promise(resolve => setTimeout(resolve, 80)); }
      await assert.rejects(ctx.pool.ensureCredentials("preflight"), /not authorized/);
      const accountA = credentials.token === "a";
      return [
        { id: `Only-${credentials.token}`, capabilities: { tools: true, privateField: true } },
        { id: "Shared", name: accountA ? "Shared A" : "Shared B", rate: accountA ? 2 : 3,
          capabilities: { images: accountA, tools: true }, contextLength: accountA ? 200000 : 100000,
          maxOutputTokens: accountA ? 32000 : 16000 },
        { id: "Sparse", rate: accountA ? null : 4, contextLength: accountA ? 200000 : 0,
          maxOutputTokens: accountA ? 32000 : 0 }
      ];
    },
    async *invoke() { throw new Error("catalog must never execute a model"); }
  }] });
  const session = new ProviderSession({ peer: hostPeer, identity, declarations: [declaration] });
  const host = { providerSessions: () => sourceReady ? [{ id: identity.pluginId, identity, manifest, session,
    permissions: ["pool.forward-scoped"], channels: declaration.channels }] : [] };
  const scopedPool = createPoolService({ host, getAccount: store.getAccount, access: {
    policyFor: (_channel, purpose) => purpose === "catalog" && !catalogAllowed ? null : ({ credentials: ["token"], context: [] }),
    readCredentials(account) { reads++; return { token: account.id }; },
    ensureCredentials() { throw new Error("catalog cannot refresh"); }, readContext: () => ({})
  } });
  scopedPool.bindSession(hostPeer, identity);
  const services = createExecutionServices({ providers: store,
    settings: { get: () => state.localgw, normalize: value => value, mergeDeep: (_base, value) => value, LOCALGW_DEFAULTS: {} },
    configuration: { loadConfig: () => structuredClone(state), saveConfig: value => { state = value; } } });
  services.configure({ host, executor: { execute() {} }, poolService: {
    capture(...args) {
      const captured = scopedPool.capture(...args);
      return { ...captured, open(options) {
        if (failNextOpen) { failNextOpen = false; throw new Error("synchronous grant failure"); }
        const grant = captured.open(options); opens++;
        return { ...grant, close() { closed++; grant.close(); } };
      } };
    }
  } });
  const options = { audience: "key:one", authorizationVersion: "v1", authorizeChannel: () => authorized };
  const catalog = createModelCatalog({ services, store, pool, getProxy: () => ({}), now: () => clock, ttlMs: 100, refreshMs: 1000 });
  try {
    await session.initialize();
    let view = await catalog.prepare(options);
    assert.deepEqual(view.mergedModels().map(row => row.id), ["standard/client"]);
    assert.equal(calls, 0); assert.equal(reads, 0); assert.equal(opens, 0);
    const withoutPlugin = await catalog.refresh(options);
    assert.deepEqual(withoutPlugin.summary, { refreshed: 0, skipped: 3, failed: 0 });
    assert.equal(calls, 0, "no installed and bound plugin means no private catalog request");
    assert.equal(reads, 0, "catalog refresh without a bound plugin never reads account credentials");
    assert.equal(plans, 0, "catalog refresh without a bound plugin never queries account selection");
    const visibleNonBuiltin = await catalog.refresh({ ...options, channels: [standard.id, "retired-extension"] });
    assert.deepEqual(visibleNonBuiltin.summary, { refreshed: 0, skipped: 2, failed: 0 });
    assert.match(visibleNonBuiltin.results[0].message, /供应商设置/);
    assert.match(visibleNonBuiltin.results[1].message, /未绑定已授权/);
    assert.equal(calls, 0, "standard and stale channels are reported without account reads or provider RPC");
    assert.equal(reads, 0); assert.equal(plans, 0);
    services.setBinding(ref.channel, ref);
    view = await catalog.prepare(options);
    assert.deepEqual(view.channelModelIds(ref.channel).sort(), ["Only-a", "Only-b", "Shared", "Sparse"]);
    assert.equal(view.resolveModelTarget("only-A", ref.channel), "Only-a");
    assert.deepEqual(view.excludedAccounts(ref.channel, "Only-a"), ["b"]);
    // accountModels 只给执行该账号能用的条目，且每次都是克隆。
    assert.deepEqual(view.accountModels(ref.channel, "a").map(model => model.id), ["Only-a", "Shared", "Sparse"]);
    assert.deepEqual(view.accountModels(ref.channel, "b").map(model => model.id), ["Only-b", "Shared", "Sparse"]);
    const accountClone = view.accountModels(ref.channel, "a");
    accountClone[1].name = "mutated";
    assert.equal(view.accountModels(ref.channel, "a")[1].name, "Shared A", "account catalogs are cloned per read");
    assert.equal(view.accountModels("standard", "a"), undefined, "standard suppliers never expose a plugin catalog");
    assert.deepEqual(view.excludedAccounts(ref.channel, "Shared"), []);
    assert.deepEqual(view.modelMetadata("Only-a", ref.channel).capabilities, { tools: true });
    assert.deepEqual(view.modelMetadata("Shared", ref.channel), {
      rate: null, capabilities: { images: false, tools: true }, contextLength: 100000,
      maxOutputTokens: 16000, metadataScope: "binding", rateSource: "catalog"
    }, "conflicting account metadata must not depend on catalog traversal order");
    assert.deepEqual(view.modelMetadata("Sparse", ref.channel), {
      rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0,
      metadataScope: "binding", rateSource: "catalog"
    }, "missing account metadata must remain unknown instead of borrowing another account's value");
    assert.equal(view.resolveModelTarget("standard/client", "standard"), "client");
    assert.equal(view.modelMetadata("client", "standard").rate, 2);
    assert.equal(calls, 2); assert.equal(opens, closed); assert.equal(scopedPool.activeGrants, 0);
    await catalog.prepare(options); assert.equal(calls, 2, "cache reuses only the same audience/authorization/account/source");
    const refreshedDirectory = await catalog.refresh({ ...options, channels: [ref.channel] });
    assert.deepEqual(refreshedDirectory.summary, { refreshed: 1, skipped: 0, failed: 0 }, JSON.stringify(refreshedDirectory.results));
    assert.equal(refreshedDirectory.results[0].count, 4);
    assert.equal(calls, 4, "manual refresh force-fetches each eligible account through the plugin catalog RPC");
    declaration.modelRefresh = false;
    const fixedDirectory = await catalog.refresh({ ...options, channels: [ref.channel] });
    assert.deepEqual(fixedDirectory.summary, { refreshed: 0, skipped: 1, failed: 0 });
    assert.match(fixedDirectory.results[0].message, /固定模型目录/);
    assert.equal(calls, 4, "fixed model catalogs are not given forced refresh network access");
    declaration.modelRefresh = true;
    const actualList = services.list;
    const duplicateSources = createModelCatalog({ services: { ...services, list: () => [...actualList(),
      { channel: ref.channel, ref: { ...ref, pluginId: "unbound-other" }, bound: false, ready: true }] }, store, pool, getProxy: () => ({}) });
    assert.deepEqual((await duplicateSources.refresh({ ...options, channels: [ref.channel] })).summary,
      { refreshed: 1, skipped: 0, failed: 0 }, "another installed unbound plugin cannot hide the selected model source");
    accounts.get("a").updated_at = Date.now(); accounts.get("a").status = "cooling";
    assert.equal(view.resolveModelTarget("Only-a", ref.channel), "Only-a", "usage/cooldown writes do not erase known model identity");
    accounts.get("a").status = "online";
    const restricted = await catalog.prepare({ ...options, audience: "key:two", authorizeAccount: id => id === "a" });
    assert.deepEqual(restricted.channelModelIds(ref.channel), ["Only-a", "Shared", "Sparse"]);
    assert.deepEqual(restricted.excludedAccounts(ref.channel, "Only-a"), ["b"]);
    assert.deepEqual(catalog.view({ ...options, audience: "unknown" }).channelModelIds(ref.channel), []);
    authorized = false;
    assert.deepEqual(view.channelModelIds(ref.channel), [], "held views recheck live authorization");
    authorized = true;
    accounts.set("c", { id: "c", channel: ref.channel, uid: "c", token_enc: "new", status: "online" });
    assert.deepEqual(view.excludedAccounts(ref.channel, "Only-a"), ["b", "c"], "new accounts cannot borrow an old account's entitlement");
    accounts.delete("c");
    accounts.get("a").token_enc = "replacement-login";
    assert.equal(view.resolveModelTarget("Only-a", ref.channel), null, "replacement credentials invalidate account catalog immediately");
    assert.deepEqual(view.accountModels(ref.channel, "a"), [], "replacement credentials drop the account catalog instead of reusing the old one");
    assert.equal(view.resolveModelTarget("Only-b", ref.channel), "Only-b");
    clock += 101;
    assert.deepEqual(view.channelModelIds(ref.channel), [], "TTL also invalidates already-held views");

    // A manual refresh bypasses a still-valid plugin catalog TTL.
    await catalog.prepare(options);
    const beforeForced = calls;
    const forced = await catalog.prepare({ ...options, force: true });
    assert.equal(calls, beforeForced + 2, "manual force fetches fresh descriptors from every eligible account");
    catalog.invalidate([ref.channel]);
    assert.deepEqual(forced.channelModelIds(ref.channel), [], "manual refresh invalidates held snapshots for every audience");
    assert.deepEqual(forced.channelModelIds("standard"), ["client"]);
    await catalog.prepare(options);
    clock += 101;

    // Single-flight, independent waiters, cancellation, old results and cleanup.
    blocked = new Promise(resolve => { release = resolve; });
    const startCalls = calls;
    const controller = new AbortController();
    const first = catalog.prepare({ ...options, signal: controller.signal });
    const second = catalog.prepare(options);
    await until(() => calls === startCalls + 2);
    controller.abort(new Error("one waiter left"));
    await assert.rejects(first, /one waiter left/);
    release(); blocked = null;
    view = await second;
    assert.equal(calls, startCalls + 2); assert.equal(view.ready(ref.channel), true);
    assert.equal(catalog.pendingCount, 0); assert.equal(opens, closed);

    clock += 101;
    blocked = new Promise(resolve => { release = resolve; });
    const stale = catalog.prepare(options);
    await until(() => scopedPool.activeGrants === 2);
    accounts.get("a").token_enc = "another-login";
    sourceReady = false;
    release(); blocked = null;
    view = await stale;
    assert.equal(view.ready(ref.channel), false); assert.equal(catalog.pendingCount, 0);
    assert.equal(scopedPool.activeGrants, 0); assert.equal(opens, closed);
    assert.ok(view.historicalBindings("Only-b").length > 0);
    assert.equal(view.historicalBindings("Only-a").length, 0, "changed account's history is not borrowed");
    sourceReady = true;

    mode = "public"; declaration.catalogMode = "public"; manifest.version = "1.1.0";
    const readsBefore = reads, opensBefore = opens;
    view = await catalog.prepare(options);
    assert.deepEqual(view.channelModelIds(ref.channel), ["Public"]);
    assert.equal(reads, readsBefore); assert.equal(opens, opensBefore, "public directory has no account grant");

    // A public catalog has no account grant to revoke. The source/authorization
    // observer still cancels it without waiting for a response or the deadline.
    clock += 101;
    blocked = new Promise(resolve => { release = resolve; });
    const beforeIdleCalls = calls;
    const idlePublic = catalog.prepare(options);
    await until(() => calls > beforeIdleCalls);
    authorized = false;
    let idleTimer;
    try {
      const revokedView = await Promise.race([idlePublic, new Promise((_, reject) => { idleTimer = setTimeout(() => reject(new Error("idle public directory was not revoked")), 750); })]);
      assert.equal(revokedView.ready(ref.channel), false); assert.equal(catalog.pendingCount, 0);
      assert.equal(scopedPool.activeGrants, 0);
    } finally { clearTimeout(idleTimer); release(); blocked = null; authorized = true; }

    clock += 101; mode = "error";
    view = await catalog.prepare(options);
    assert.ok(view.errors.length); assert.equal(view.ready(ref.channel), false);
    assert.equal(catalog.pendingCount, 0, "failed refresh cannot poison single-flight");
    assert.deepEqual((await catalog.refresh({ ...options, channels: [ref.channel] })).summary, { refreshed: 0, skipped: 0, failed: 1 }, "failed forced refresh does not report stale cached models as fresh");
    mode = "public";
    assert.equal((await catalog.prepare(options)).ready(ref.channel), true, "same key retries after failure");
    await assert.rejects(catalog.prepare({ audience: "x".repeat(257) }), /不可用/);
    assert.throws(() => normalizeModels([{ id: "bad\nname" }]));
    // Synchronous failures used to race pending.set() and retain a dead owner.
    mode = "account"; declaration.catalogMode = "account"; manifest.version = "2.0.0";
    failNextOpen = true;
    view = await catalog.prepare(options);
    assert.ok(view.errors.length); assert.equal(catalog.pendingCount, 0);
    view = await catalog.prepare(options);
    assert.ok(view.channelModelIds(ref.channel).includes("Only-a"));
    catalogAllowed = false;
    const plansBefore = plans;
    const rejectedCatalog = createModelCatalog({ services, store, pool, getProxy: () => ({}) });
    assert.equal((await rejectedCatalog.prepare(options)).ready(ref.channel), false);
    assert.equal(plans, plansBefore, "catalog field policy is checked before read-only account planning");
    catalogAllowed = true;

    let partialTime = 2000;
    const partialCatalog = createModelCatalog({ services, store, pool, getProxy: () => ({}), now: () => partialTime, ttlMs: 100 });
    await partialCatalog.prepare(options);
    partialTime += 51; accounts.get("a").token_enc = "updated-a-only";
    await partialCatalog.prepare(options);
    partialTime += 50;
    const partial = partialCatalog.view(options);
    assert.equal(partial.ready(ref.channel), true);
    assert.deepEqual(partial.channelModelIds(ref.channel), ["Only-a", "Shared", "Sparse"]);
    assert.deepEqual(partial.historicalBindings("Only-b"), [{ channel: ref.channel, realModel: "Only-b" }], "one fresh account cannot hide another account's unavailable model");

    const timeoutCatalog = createModelCatalog({ services, store, pool, getProxy: () => ({}), refreshMs: 30 });
    blocked = new Promise(resolve => { release = resolve; });
    const timed = await timeoutCatalog.prepare(options);
    assert.equal(timed.ready(ref.channel), false); assert.ok(timed.errors.some(error => error.code === "CATALOG_TIMEOUT"));
    assert.equal(timeoutCatalog.pendingCount, 0); assert.equal(scopedPool.activeGrants, 0);
    release(); blocked = null; await tick();
    assert.equal(timeoutCatalog.cacheSize, 0, "late result after total catalog deadline cannot populate cache");

    declaration.catalogMode = "public"; mode = "public";
    const bounded = createModelCatalog({ services, store, pool, getProxy: () => ({}), maxEntries: 1 });
    await bounded.prepare(options);
    await bounded.prepare({ ...options, audience: "another-key" });
    assert.equal(bounded.cacheSize, 1); assert.deepEqual(bounded.view(options).channelModelIds(ref.channel), []);
    mode = "account"; declaration.catalogMode = "account"; manifest.version = "3.0.0";
    for (const size of [129, 1000]) {
      accounts.clear();
      for (let i = 0; i < size; i++) {
        const id = `account-${i}`;
        accounts.set(id, { id, channel: ref.channel, uid: id, status: "online", token_enc: `cipher-${id}`, meta: "{}" });
      }
      // One bounded source group must retain all of its account entitlements.
      const large = createModelCatalog({ services, store, pool, getProxy: () => ({}), maxEntries: 1, refreshMs: 30000 });
      const start = calls;
      const full = await large.prepare(options);
      assert.equal(full.completeness.complete, true, JSON.stringify(full.errors));
      assert.equal(full.completeness.examinedAccounts, size); assert.equal(full.completeness.pendingAccounts, 0);
      assert.equal(full.channelModelIds(ref.channel).length, size + 2);
      assert.equal(full.resolveModelTarget("Only-account-0", ref.channel), "Only-account-0");
      assert.equal(full.resolveModelTarget(`Only-account-${size - 1}`, ref.channel), `Only-account-${size - 1}`);
      const excluded = full.excludedAccounts(ref.channel, `Only-account-${size - 1}`);
      assert.equal(excluded.length, size - 1); assert.ok(!excluded.includes(`account-${size - 1}`));
      assert.equal(calls - start, size); assert.equal(large.cacheSize, 1); assert.ok(large.cacheBytes <= 16 * 1024 * 1024);
      accountLookups = 0;
      for (let i = 0; i < size; i++) full.modelMetadata(`Only-account-${i}`, ref.channel);
      assert.ok(accountLookups <= size * 3, "metadata resolves model owners without re-reading the whole pool per model");
      await large.prepare(options);
      assert.equal(calls - start, size, "all account facts remain reusable, rather than thrashing a 128-account cache");
      const onlyLast = await large.prepare({ ...options, audience: "restricted-scale", authorizeAccount: id => id === `account-${size - 1}` });
      assert.deepEqual(onlyLast.channelModelIds(ref.channel), [`Only-account-${size - 1}`, "Shared", "Sparse"]);
      assert.equal(onlyLast.completeness.totalAccounts, 1);
      assert.equal(full.resolveModelTarget("Only-account-0", ref.channel), "Only-account-0", "cache eviction cannot invalidate an already prepared authorized snapshot");
      accounts.get("account-0").token_enc = "replaced";
      assert.equal(full.resolveModelTarget("Only-account-0", ref.channel), null, "retained snapshots still recheck account facts");
    }
    // Prefetch progress must not skip accounts when each request times out
    // before its batch drains. Only work actually started advances the cursor.
    accounts.clear();
    for (let i = 0; i < 9; i++) { const id = `fair-${i}`; accounts.set(id, { id, channel: ref.channel, uid: id, status: "online", token_enc: id }); }
    mode = "slow";
    const fair = createModelCatalog({ services, store, pool, getProxy: () => ({}), batchSize: 64, concurrency: 1, refreshMs: 30 });
    for (let i = 0; i < 9; i++) {
      const partial = await fair.prepare(options);
      assert.equal(partial.completeness.complete, false);
      assert.ok(partial.completeness.pendingAccounts > 0);
      assert.ok(partial.errors.some(error => error.code === "CATALOG_TIMEOUT"));
      assert.ok(partial.mergedModels().some(row => row.id === "standard/client"), "partial plugin catalogs cannot hide standard providers");
    }
    assert.equal(slowAccounts.size, 9, "later accounts are eventually visited despite repeated partial timeouts");
    mode = "account";
    const tiny = createModelCatalog({ services, store, pool, getProxy: () => ({}), snapshotBytes: 1024 });
    const limited = await tiny.prepare(options);
    assert.equal(limited.completeness.complete, false);
    assert.ok(limited.errors.some(error => error.code === "CATALOG_SNAPSHOT_LIMIT"));
    assert.ok(limited.channelModelIds(ref.channel).length < accounts.size + 1);
    assert.ok(limited.mergedModels().some(row => row.id === "standard/client"));
    blocked = new Promise(resolve => { release = resolve; });
    const saturated = createModelCatalog({ services, store, pool, getProxy: () => ({}), maxPreparations: 1 });
    const running = saturated.prepare(options);
    await until(() => saturated.pendingCount > 0);
    const overload = await saturated.prepare(options);
    assert.equal(overload.completeness.complete, false);
    assert.ok(overload.errors.some(error => error.code === "CATALOG_BUSY"));
    release(); blocked = null; await running;
    assert.equal(saturated.preparingCount, 0);
    assert.throws(() => createModelCatalog({ services, store, pool, getProxy: () => ({}), concurrency: 0 }), /resource limit/);
    assert.equal(catalog.pendingCount, 0); assert.equal(opens, closed);
    assert.equal(runtime.active.size, 0);
    await tick();
    console.log("PASS executable catalog: real RPC/grants, 129/1000-account grouped cache, tail entitlements, linear metadata lookup, audience isolation, bounded snapshots/preparations, fair partial timeouts, no refresh, TTL, replacement, single-flight/cancel and cleanup");
  } finally { scopedPool.close(); session.close(); pluginPeer.close(); toHost.destroy(); toPlugin.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
