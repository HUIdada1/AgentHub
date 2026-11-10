/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-06
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";

// Host boundary smoke. Provider protocol behavior is tested in AgentHub_skill;
// the host owns account management and must not expose a forwarding fallback.
const assert = require("node:assert/strict");
const store = require("../electron/backend/proxy/store.cjs");
const management = require("../electron/backend/proxy/management-adapters.cjs");
const legacy = require("../electron/backend/proxy/adapters.cjs");

assert.deepEqual(management.consistencyReport(), { channelsWithoutAdapter: [], adaptersWithoutChannel: [] });
assert.equal(Object.keys(management.ADAPTERS).length, store.CHANNELS.length);
for (const channel of store.CHANNELS) {
  const adapter = management.get(channel.id);
  assert.ok(adapter, `${channel.id} management adapter is registered`);
  management.assertAdapterContract(channel.id, adapter);
  for (const method of ["chat", "chatOnce", "chatOpenai", "chatSession", "rewriteBody", "mapModel"])
    assert.equal(method in adapter, false, `${channel.id}.${method} is not a management capability`);
}

const pluginChannels = ["trae", "workbuddy", "workbuddy_ai", "raccoon", "catpaw", "autoclaw", "autoclaw_intl", "accio", "accio_cn", "codearts", "loomy", "kuku", "monkeycode", "monkeycode_intl", "cline_free", "cline_pass"];
for (const channel of pluginChannels)
  assert.equal(legacy.get(channel), null, `${channel} has no in-process forwarding fallback`);
for (const channel of ["zcode", "qoder", "qoder_intl"])
  assert.equal(legacy.get(channel), null, `${channel} has no in-process forwarding fallback while its plugin is unavailable`);
for (const channel of ["modelscope", "lobster"]) {
  const adapter = legacy.get(channel);
  assert.ok(adapter, `${channel} retains its host management bridge`);
  for (const method of ["chat", "mapModel", "rewriteBody"])
    assert.equal(typeof adapter[method], "undefined", `${channel}.${method} is not a host forwarding fallback`);
}

console.log(`PASS host boundary: ${store.CHANNELS.length} management channels; ${pluginChannels.length} plugin-owned channels have no in-process fallback`);
