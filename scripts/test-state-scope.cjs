"use strict";
const assert = require("node:assert/strict");
const { createStateScopeFactory } = require("../electron/backend/extensions/state-scope.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { validateStateScope } = require("../electron/backend/extensions/provider-protocol.cjs");
const ref = { kind: "extension", pluginId: "fixture.plugin", publisherId: "publisher", providerId: "provider", channel: "channel" };
const identity = { pluginId: ref.pluginId, publisherId: ref.publisherId, sessionId: "installation-session", generation: 1 };
const context = { audience: "key:internal-id", authorizationVersion: "revision-one" };
const base = { context, ref, identity, permissions: ["pool.forward-scoped", "network.outbound"], channels: ["channel", "other"] };
const derive = createStateScopeFactory(), first = derive(base);
validateStateScope(first);
assert.throws(() => validateStateScope(first + "\n"), /state scope/, "the regex end anchor alone accepts a final newline");
assert.equal(derive(structuredClone(base)), first);
assert.equal(derive({ ...base, permissions: [...base.permissions].reverse(), channels: [...base.channels].reverse() }), first);
for (const changed of [
  { context: { ...context, audience: "key:other" } }, { context: { ...context, authorizationVersion: "revision-two" } },
  ...["publisherId", "pluginId", "providerId", "channel"].map(key => ({ ref: { ...ref, [key]: "other" } })),
  { identity: { ...identity, sessionId: "new-session" } }, { identity: { ...identity, generation: 2 } },
  { permissions: [...base.permissions, "storage.private"] }, { channels: ["channel"] },
]) assert.notEqual(derive({ ...base, ...changed }), first);
assert.notEqual(createStateScopeFactory()(base), first, "new host service cannot recover the old execution domain");
assert.doesNotMatch(first, /internal-id|revision|publisher|channel/);
for (const invalid of [null, {}, { audience: "", authorizationVersion: "1" }, { audience: "bad\n", authorizationVersion: "1" },
  { audience: "x".repeat(4097), authorizationVersion: "1" }, { audience: "key", authorizationVersion: "" }]) {
  assert.throws(() => derive({ ...base, context: invalid }), /scope/);
}
let allowed = true, accountReads = 0;
const session = { requireService() {}, supports: feature => feature === "state-scope@1" };
let live = [{ id: ref.pluginId, identity, session, permissions: base.permissions, channels: base.channels,
  manifest: { contributes: { providers: [{ id: ref.providerId, channels: [ref.channel] }] } } }];
const service = createPoolService({ host: { providerSessions: () => live }, getAccount() { accountReads++; throw new Error("must not read"); },
  access: { policyFor: () => ({ credentials: ["token"], context: [] }),
    readCredentials() { accountReads++; throw new Error("must not decrypt"); },
    ensureCredentials() { accountReads++; throw new Error("must not refresh"); } } });
try {
  const captured = service.capture(ref, () => allowed);
  const scope = captured.stateScope(context);
  assert.equal(captured.stateScope(context), scope);
  live = [{ ...live[0], permissions: [...base.permissions, "storage.private"] }];
  assert.notEqual(captured.stateScope(context), scope, "current authority, not a saved grant, controls the partition");
  allowed = false;
  assert.throws(() => captured.stateScope(context), /未就绪或未授权/);
  allowed = true;
  live = [{ ...live[0], identity: { ...identity, generation: 2 } }];
  assert.throws(() => captured.stateScope(context), /未就绪或未授权/);
  assert.equal(accountReads, 0, "state metadata never selects, decrypts or refreshes accounts");
} finally { service.close(); }
console.log("PASS state scope: opaque keyed partitions, current source/authority, restart separation, bounded facts, zero account access");
