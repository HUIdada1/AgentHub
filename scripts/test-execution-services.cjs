"use strict";
const assert = require("node:assert/strict");
const { createExecutionServices } = require("../electron/backend/localgw/services.cjs");
let state = { localgw: { models: { serviceBindings: {} } } }, live = [], captures = 0;
const providers = { getProvider: id => id === "standard" ? { id, enabled: true, kind: "openai_compat" } : null,
  listProviders: () => [{ id: "standard", enabled: true }] };
const settings = { get: () => state.localgw, normalize: value => value, mergeDeep: (_base, value) => value, LOCALGW_DEFAULTS: {} };
const configuration = { loadConfig: () => structuredClone(state), saveConfig: value => { state = value; } };
const sources = createExecutionServices({ providers, settings, configuration });
const ref = { kind: "extension", pluginId: "fixture", publisherId: "publisher", providerId: "model", channel: "channel" };
const host = { providerSessions: () => live };
const poolService = { capture(value, authorize) {
  captures++;
  assert.equal(authorize(), true);
  if (!live.some(item => item.id === value.pluginId && item.identity.publisherId === value.publisherId)) throw new Error("offline");
  return { session: live[0].session };
} };
sources.configure({ host, poolService, executor: { execute() {} } });
assert.equal(sources.refFor("channel"), null, "no automatic plugin choice");
assert.throws(() => sources.check("channel", () => true));
assert.deepEqual(sources.check("standard", () => true).ref, { kind: "custom", providerId: "standard" });
assert.throws(() => sources.check("standard", () => Promise.resolve(true)), "async authorization is not true");
sources.setBinding("channel", ref);
assert.deepEqual(sources.refFor("channel"), ref);
assert.throws(() => sources.check("channel", () => true));
assert.deepEqual(sources.list().find(item => item.channel === "channel"), {
  channel: "channel", ref, ready: false, bound: true, code: "FORWARD_PLUGIN_UNAVAILABLE"
});
live = [{ id: "fixture", identity: { publisherId: "publisher" }, session: {}, manifest: { contributes: { providers: [{ id: "model", channels: ["channel"] }] } } }];
assert.equal(sources.check("channel", () => true).session, live[0].session);
assert.equal(sources.list().find(item => item.channel === "channel").bound, true);
live = [{ ...live[0], identity: { publisherId: "different-publisher" } }];
assert.throws(() => sources.check("channel", () => true), "same plugin ID cannot substitute another publisher");
const snapshot = JSON.stringify(state);
assert.throws(() => sources.setBinding("channel", { ...ref, generation: 3 }));
assert.throws(() => sources.setBinding("channel", { kind: "custom", providerId: "standard" }));
assert.equal(JSON.stringify(state), snapshot, "invalid bindings do not write configuration");
state.localgw.models.serviceBindings.standard = null;
assert.throws(() => sources.check("standard", () => true), "corrupt explicit pin never falls back to standard provider");
state.localgw.models.serviceBindings.channel = { ...ref, publisherId: "old-publisher" };
assert.throws(() => sources.check("channel", () => true));
state.localgw.models.serviceBindings = [];
assert.throws(() => sources.check("standard", () => true), "corrupt source table never restores implicit defaults");
assert.ok(captures > 0);
console.log("PASS execution sources: explicit pins, publisher identity, no automatic substitution, offline history, authorization and corrupt-pin refusal");
