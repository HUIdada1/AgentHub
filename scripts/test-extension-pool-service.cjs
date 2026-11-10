"use strict";
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createAccountExecution } = require("../electron/backend/extensions/account-execution.cjs");

async function main() {
  const identity = Object.freeze({ pluginId: "plugin", publisherId: "publisher", sessionId: "session", generation: 1 });
  const session = { requireService(provider, channel) { if (provider !== "provider" || channel !== "channel") throw new Error("not in handshake"); } };
  let current = [{ id: "plugin", identity, session, permissions: ["pool.forward-scoped"], channels: ["channel"], manifest: { contributes: { providers: [{ id: "provider", channels: ["channel"] }] } } }];
  let reads = 0, keyAllowed = true;
  let contextRead = () => ({ accountExecutionEpoch: "adapter-cannot-supply-this" });
  let account = { id: "account", channel: "channel", status: "online", uid: "identity", token_enc: "before" };
  const execution = createAccountExecution();
  const service = createPoolService({ execution, host: { providerSessions: () => current }, getAccount: id => { reads++; return account && { ...account, id }; },
    access: { policyFor: () => ({ credentials: ["token"], context: ["accountExecutionEpoch"] }), readContext: (...args) => contextRead(...args), readCredentials: () => ({ token: "current-token", refreshToken: "private" }), ensureCredentials: () => null } });
  const ref = { kind: "extension", pluginId: "plugin", publisherId: "publisher", providerId: "provider", channel: "channel" };
  const open = (overrides = {}) => service.open({ ref, invocationId: "request", accountId: "account", deadlineAt: Date.now() + 10000, authorize: () => keyAllowed, ...overrides });
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  const denied = fn => assert.throws(fn, error => error.code === "FORWARD_PLUGIN_UNAVAILABLE");
  try {
    denied(() => open({ ref: { ...ref, publisherId: "impostor" } }));
    denied(() => open({ ref: { ...ref, providerId: "undeclared" } }));
    current[0].permissions = [];
    denied(() => open());
    current[0].permissions = ["pool.forward-scoped"];
    const savedRequire = session.requireService;
    session.requireService = () => { throw new Error("signed but absent from this handshake"); };
    denied(() => open());
    session.requireService = savedRequire;
    keyAllowed = false;
    denied(() => open());
    keyAllowed = true;
    assert.equal(reads, 0, "service, publisher, permission and Key checks precede account access");
    const captured = service.capture(ref, () => keyAllowed);
    current = [{ ...current[0], session: { ...session }, identity: { ...identity, generation: 2 } }];
    denied(() => captured.open({ invocationId: "late-open", accountId: "account", deadlineAt: Date.now() + 10000 }));
    assert.equal(reads, 0, "a stale pre-selection capture cannot grant a new generation");
    current = [{ ...current[0], session, identity }];
    const declaration = current[0].manifest.contributes.providers[0];
    declaration.requestHeaders = ["x-session-id", "x-agent-id"];
    const headerSource = { "X-Session-ID": "session-one", "x-agent-id": "agent-one", authorization: "gateway-key", cookie: "private", "x-api-key": "private", "x-undeclared": "not-granted" };
    const headerCapture = service.capture(ref, () => keyAllowed);
    assert.deepEqual(headerCapture.requestHeaders(headerSource), {}, "a signed declaration alone grants no client headers");
    current[0].permissions = ["pool.forward-scoped", "request.headers.read"];
    denied(() => headerCapture.requestHeaders(headerSource));
    session.supports = feature => feature === "request-headers@1";
    assert.deepEqual(headerCapture.requestHeaders(headerSource), { "x-session-id": "session-one", "x-agent-id": "agent-one" });
    assert.deepEqual(headerCapture.requestHeaders({}), {});
    for (const value of [["one", "two"], 123, "bad\r\nheader", "x".repeat(4097)]) {
      assert.throws(() => headerCapture.requestHeaders({ "x-session-id": value }), /header/);
    }
    denied(() => headerCapture.requestHeaders({ "X-Session-ID": "one", "x-session-id": "two" }));
    denied(() => headerCapture.requestHeaders({ "x-session-id": "one, two" }, ["X-Session-Id", "one", "x-session-id", "two"]));
    assert.deepEqual(headerCapture.requestHeaders(headerSource, ["Authorization", "gateway-key", "X-Session-Id", "session-one", "x-agent-id", "agent-one"]),
      { "x-session-id": "session-one", "x-agent-id": "agent-one" });
    denied(() => headerCapture.requestHeaders(headerSource, ["x-session-id"]));
    current[0].manifest.contributes.providers.push({ id: "other", channels: ["other"], requestHeaders: ["x-undeclared"] });
    assert.deepEqual(headerCapture.requestHeaders(headerSource), { "x-session-id": "session-one", "x-agent-id": "agent-one" }, "another signed provider cannot widen this service's header access");
    current[0].permissions = ["pool.forward-scoped"];
    assert.deepEqual(headerCapture.requestHeaders(headerSource), {}, "permissions are reread rather than retained from capture");
    keyAllowed = false; denied(() => headerCapture.requestHeaders(headerSource)); keyAllowed = true;
    assert.equal(reads, 0, "header checks, invalid values and revoked permissions do not touch accounts or secrets");
    service.bindSession(host, identity);
    session.supports = feature => ["request-headers@1", "account-execution-epoch@1"].includes(feature);
    const waiting = open();
    const beforeEpoch = await plugin.call("pool.readForwardContext", { grantId: waiting.grantId });
    assert.match(beforeEpoch.accountExecutionEpoch, /^[a-f0-9]{32}$/);
    const originalEpoch = beforeEpoch.accountExecutionEpoch;
    const rotated = waiting.renew();
    assert.equal((await plugin.call("pool.readForwardContext", { grantId: rotated.grantId })).accountExecutionEpoch, originalEpoch, "grant rotation preserves account execution epoch");
    // A synchronous disable/re-enable can occur entirely between authority polls.
    account.status = "disabled";
    execution.invalidateAccountExecution("account");
    account.status = "online";
    assert.equal(waiting.signal.aborted, true);
    assert.equal(service.activeRequests, 0);
    await assert.rejects(plugin.call("pool.readForwardContext", { grantId: rotated.grantId }));
    const afterEnable = open();
    assert.notEqual((await plugin.call("pool.readForwardContext", { grantId: afterEnable.grantId })).accountExecutionEpoch, originalEpoch);
    afterEnable.close();
    // Revocation while awaiting an adapter's read cannot return a stale context.
    let finishRead, entered;
    const reading = new Promise(resolve => { entered = resolve; });
    contextRead = () => { entered(); return new Promise(resolve => { finishRead = resolve; }); };
    const late = open();
    const rejectedContext = assert.rejects(plugin.call("pool.readForwardContext", { grantId: late.grantId }));
    await reading;
    execution.invalidateAccountExecution("account");
    finishRead({ accountExecutionEpoch: originalEpoch });
    await rejectedContext;
    assert.equal(late.signal.aborted, true);
    contextRead = () => ({});
    const scope = open();
    assert.throws(() => open(), error => error.code === "INVOCATION_DUPLICATE");
    assert.deepEqual(await plugin.call("pool.readForwardCredentials", { grantId: scope.grantId, accountId: "other" }), { token: "current-token" });
    keyAllowed = false;
    await assert.rejects(plugin.call("pool.readForwardCredentials", { grantId: scope.grantId }));
    assert.equal(service.activeGrants, 0);
    scope.close();
    keyAllowed = true;

    const old = open();
    current = [{ ...current[0], session: { ...session }, identity: { ...identity, generation: 2 } }];
    denied(() => old.assertCurrent());
    await assert.rejects(plugin.call("pool.readForwardCredentials", { grantId: old.grantId }));
    old.close();
    current = [{ ...current[0], session, identity }];

    const expiring = open({ deadlineAt: Date.now() + 20 });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(service.activeGrants, 0);
    assert.equal(service.activeRequests, 0, "expiry releases request records as well as broker grants");
    denied(() => expiring.assertCurrent());
    expiring.close();

    const idle = open();
    keyAllowed = false;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(idle.signal.aborted, true, "no next RPC/event is required for authority revocation");
    assert.equal(service.activeRequests, 0); assert.equal(service.activeGrants, 0);
    keyAllowed = true;
    const rotating = open();
    account = { ...account, token_enc: "normal-rotation", updated_at: Date.now(), status: "cooling" };
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(rotating.signal.aborted, false, "token rotation and non-disabled health updates do not replace identity");
    account = { ...account, uid: "replacement-identity" };
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(rotating.signal.aborted, true, "observable identity replacement cancels idle scope");
    assert.equal(service.activeRequests, 0);
    const removed = open();
    account = null;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(removed.signal.aborted, true, "deletion cancels idle scope without changing management store");
    assert.equal(service.activeGrants, 0);
    account = { id: "account", channel: "channel", status: "online" };
    const revoked = open();
    service.revokeAccount("account");
    assert.equal(revoked.signal.aborted, true); assert.equal(service.activeRequests, 0);

    open();
    host.close();
    assert.equal(service.activeGrants, 0);
    assert.equal(service.activeRequests, 0, "disconnect cleans pending invocation authorization");
    assert.equal(execution.active, 0, "all grant leases release execution fence references");
    service.close();
    denied(() => open());
    console.log("PASS pool service: explicit source/publisher/permission/Key gating before pool access, real RPC, generation revocation, expiry/disconnect cleanup");
  } finally { service.close(); host.close(); plugin.close(); toHost.destroy(); toPlugin.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
