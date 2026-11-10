"use strict";
const assert = require("node:assert/strict");
const { PoolBroker } = require("../electron/backend/extensions/pool-broker.cjs");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { PassThrough } = require("node:stream");

async function main() {
  const identity = { pluginId: "test-forward", publisherId: "test-publisher", sessionId: "session-one", generation: 1 };
  let account = { id: "one", channel: "test-channel", status: "online" };
  let allowed = true;
  let refreshCalls = 0;
  let finishRefresh;
  const secrets = { token: "old", refreshToken: "never-export", meta: { deviceId: "existing-device", unrelatedSecret: "never-export" } };
  const broker = new PoolBroker({
    getAccount: id => id === account?.id ? account : null,
    readCredentials: () => secrets,
    ensureCredentials: async () => { refreshCalls++; if (finishRefresh) await finishRefresh; return { ...secrets, token: "effective-nonpersistent" }; },
    readContext: () => ({ plan: "test-plan", unrelated: "private" }),
    policyFor: () => ({ credentials: ["token", "meta.deviceId"], context: ["plan"] }),
    authorize: () => allowed
  });
  const issue = purpose => broker.issue({ identity, invocationId: "request-one", accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 10000, purpose });
  const denied = promise => assert.rejects(promise, error => ["GRANT_DENIED", "GRANT_LIMIT", "GRANT_EXPIRED"].includes(error.code));
  try {
    const { grantId } = issue("invoke");
    assert.deepEqual(await broker.credentials(identity, grantId), { token: "old", meta: { deviceId: "existing-device" } });
    assert.deepEqual(await broker.context(identity, grantId), { plan: "test-plan" });
    await denied(broker.credentials({ ...identity, sessionId: "other-session" }, grantId));
    await denied(broker.credentials({ ...identity, generation: 2 }, grantId));
    await denied(broker.credentials({ ...identity, publisherId: "impostor" }, grantId));
    const effective = await broker.ensure(identity, grantId, "upstream-auth-expired");
    assert.equal(effective.token, "effective-nonpersistent");
    assert.equal(secrets.token, "old", "broker must not persist or overwrite existing management credentials");
    await denied(broker.ensure(identity, grantId, "upstream-auth-expired"));
    assert.equal(refreshCalls, 1);
    const renewed = broker.rotate(identity, grantId, Date.now() + 10000);
    await denied(broker.credentials(identity, grantId));
    assert.deepEqual(await broker.credentials(identity, renewed.grantId), { token: "old", meta: { deviceId: "existing-device" } });
    await denied(broker.ensure(identity, renewed.grantId, "upstream-auth-expired"));
    assert.equal(refreshCalls, 1, "rotation does not grant another refresh");
    broker.revokeInvocation("request-one");
    await denied(broker.credentials(identity, grantId));

    const catalog = issue("catalog");
    await denied(broker.ensure(identity, catalog.grantId, "upstream-auth-expired"));
    broker.revokeAccount("one");
    await denied(broker.credentials(identity, catalog.grantId));

    const disabled = issue("invoke");
    account.status = "disabled";
    await denied(broker.credentials(identity, disabled.grantId));
    account.status = "online";
    const unauthorized = issue("invoke");
    allowed = false;
    await denied(broker.context(identity, unauthorized.grantId));
    allowed = true;

    const deleted = issue("invoke");
    const savedAccount = account;
    account = null;
    await denied(broker.credentials(identity, deleted.grantId));
    account = savedAccount;

    // Cancellation during a shared refresh revokes the grant but does not abort
    // the existing pool refresh operation or roll back its eventual result.
    let release;
    finishRefresh = new Promise(resolve => { release = resolve; });
    const cancelled = issue("invoke");
    const refreshing = broker.ensure(identity, cancelled.grantId, "upstream-auth-expired");
    await new Promise(resolve => setImmediate(resolve));
    broker.revokeConnection(identity);
    release();
    await denied(refreshing);
    assert.equal(refreshCalls, 2);
    assert.equal(broker.grants.size, 0);

    const expiring = broker.issue({ identity, invocationId: "expiry", accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 20 });
    await new Promise(resolve => setTimeout(resolve, 35));
    await denied(broker.credentials(identity, expiring.grantId));
    const toHost = new PassThrough();
    const toPlugin = new PassThrough();
    const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
    const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
    const attached = issue("invoke");
    try {
      broker.attach(host, identity);
      const result = await plugin.call("pool.readForwardCredentials", { grantId: attached.grantId, pluginId: "impostor", accountId: "another-account" });
      assert.deepEqual(result, { token: "old", meta: { deviceId: "existing-device" } }, "caller-supplied identity must not redirect account access");
      await assert.rejects(plugin.call("pool.listAccounts", {}), error => error.code === -32601);
      host.close();
      assert.equal(broker.grants.size, 0, "connection close must revoke its grants");
    } finally { host.close(); plugin.close(); toHost.destroy(); toPlugin.destroy(); }
    // Live catalog injection: invoke grants get a clone, catalog grants never do,
    // and a revocation that lands mid-read still invalidates the context.
    const live = [{ id: "live-model", name: "Live", routing: { modelType: 7 } }];
    let catalogReads = 0;
    const catalogBroker = new PoolBroker({
      getAccount: id => id === account?.id ? account : null,
      readCredentials: () => secrets,
      ensureCredentials: async () => secrets,
      readContext: () => ({ plan: "test-plan" }),
      policyFor: () => ({ credentials: ["token"], context: ["plan"] }),
      authorize: () => true,
      getModelCatalog(identityArg, grant) {
        catalogReads++;
        assert.equal(grant.purpose, "invoke", "catalog grants must not receive executable models");
        return live;
      }
    });
    try {
      const liveInvoke = catalogBroker.issue({ identity, invocationId: "live-invoke", accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 10000, purpose: "invoke" });
      const context = await catalogBroker.context(identity, liveInvoke.grantId);
      assert.deepEqual(context, { plan: "test-plan", models: [{ id: "live-model", name: "Live", routing: { modelType: 7 } }] });
      context.models[0].routing.modelType = 99;
      assert.equal(live[0].routing.modelType, 7, "broker must hand out a clone of the catalog");
      assert.equal(catalogReads, 1);
      const catalogOnly = catalogBroker.issue({ identity, invocationId: "catalog-only", accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 10000, purpose: "catalog" });
      await assert.rejects(catalogBroker.context(identity, catalogOnly.grantId), error => /catalog grants must not receive executable models/.test(error.message));
      assert.equal(catalogReads, 2);
      catalogBroker.revoke(liveInvoke.grantId);
      await denied(catalogBroker.context(identity, liveInvoke.grantId));
    } finally { catalogBroker.close(); }

    let raceBroker;
    raceBroker = new PoolBroker({
      getAccount: id => id === account?.id ? account : null,
      readCredentials: () => secrets,
      ensureCredentials: async () => secrets,
      readContext: () => ({}),
      policyFor: () => ({ credentials: ["token"], context: [] }),
      authorize: () => true,
      getModelCatalog(identityArg, grant) { raceBroker.revoke(grant.grantId); return live; }
    });
    try {
      const racing = raceBroker.issue({ identity, invocationId: "live-race", accountId: "one", channel: "test-channel", deadlineAt: Date.now() + 10000, purpose: "invoke" });
      await denied(raceBroker.context(identity, racing.grantId));
    } finally { raceBroker.close(); }

    console.log("PASS pool broker scoped fields, process identity, refresh budget, noPersist, deletion/disable/revocation, cancellation, expiry, live catalog injection and mid-read revocation");
  } finally { broker.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
