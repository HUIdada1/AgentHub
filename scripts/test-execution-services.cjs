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
  channel: "channel", ref, ready: false, bound: true, selected: true, code: "FORWARD_PLUGIN_UNAVAILABLE"
});
live = [{ id: "fixture", identity: { publisherId: "publisher" }, session: {}, manifest: { contributes: { providers: [{ id: "model", channels: ["channel"] }] } } }];
assert.equal(sources.check("channel", () => true).session, live[0].session);
assert.deepEqual(sources.list().find(item => item.channel === "channel"), {
  channel: "channel", ref, ready: true, bound: true, selected: true, auto: false,
  modelRefresh: true, catalogMode: "account"
});
// 没有显式绑定时，运行中且声明了该渠道的插件自动接管（与参考实现同口径）；
// 显式绑定始终优先，取消固定后回到自动选择而不是留空。
sources.clearBinding("channel");
assert.deepEqual(sources.refFor("channel"), ref, "clearBinding falls back to the running plugin");
assert.deepEqual(sources.list().find(item => item.channel === "channel"), {
  channel: "channel", ref, ready: true, bound: false, selected: true, auto: true,
  modelRefresh: true, catalogMode: "account"
});
sources.setBinding("channel", ref);
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
// 新装插件自动固定：只写「就绪 + 未被其它来源占用 + 非自定义提供商」的渠道，一次落盘，幂等。
state.localgw.models.serviceBindings = {};
providers.getProvider = id => id === "standard" || id === "custom-channel" ? { id, enabled: true, kind: "openai_compat" } : null;
live = [{ id: "fixture", identity: { publisherId: "publisher" }, session: {},
  manifest: { contributes: { providers: [{ id: "model", channels: ["channel", "secondary", "custom-channel"] }] } } }];
state.localgw.models.serviceBindings.secondary = { ...ref, channel: "secondary", publisherId: "other-publisher" };
const manifest = { id: "fixture", publisher: "publisher", contributes: { providers: [{ id: "model", channels: ["channel", "secondary", "custom-channel"] }] } };
const autoBound = sources.bindDeclaredChannels(manifest);
assert.equal(autoBound.bound, 1);
assert.deepEqual(autoBound.channels, ["channel"]);
assert.ok(autoBound.skipped.some(row => row.channel === "secondary" && row.reason === "BOUND_OTHER"), "existing pins to another publisher are not stolen");
assert.ok(autoBound.skipped.some(row => row.channel === "custom-channel"), "custom provider channels are not pinned to a plugin");
assert.deepEqual(state.localgw.models.serviceBindings.channel, ref);
assert.equal(state.localgw.models.serviceBindings.secondary.publisherId, "other-publisher");
assert.equal(sources.bindDeclaredChannels(manifest).bound, 0, "already pinned channels are left untouched");
assert.deepEqual(sources.refFor("secondary").publisherId, "other-publisher");
live = [];
assert.equal(sources.bindDeclaredChannels(manifest).bound, 0, "offline sources are never pinned (explicit pins fail closed)");
assert.ok(captures > 0);
console.log("PASS execution sources: explicit pins win, running declarations auto-select, publisher identity, offline history, authorization and corrupt-pin refusal");
