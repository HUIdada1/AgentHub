"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createCatalogRefresh } = require("../electron/backend/proxy/catalog-refresh.cjs");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-catalog-refresh-"));
  let catalog = { first: { models: [{ id: "old" }] }, untouched: { models: [{ id: "keep" }] } };
  fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  const rows = new Map([['a', { id: 'a', uid: 'a', channel: 'first', token_enc: 'token', meta: '{}' }],
    ['b', { id: 'b', uid: 'b', channel: 'second', token_enc: 'token', meta: '{}' }]]);
  const calls = [], gates = new Map();
  const adapters = {
    first: { async fetchModels(account, secrets, options) {
      calls.push(account.id); assert.equal(options.force, true); assert.deepEqual(account.meta, { parsed: true });
      await gates.get('first'); return { ok: true, models: [{ id: "NewCase", rate: 0, capabilities: { tools: true }, contextLength: 200000 }] };
    } },
    second: { async fetchModels() { return { ok: true, models: ['second-model'] }; }, modelEntries: () => [{ id: 'second-model', name: 'Second', upstreamId: 'uuid' }] },
    cline_free: { async fetchModels() { return { ok: true, models: [{ id: 'cline-free/vendor/model' }] }; } },
  };
  const refresh = createCatalogRefresh({
    store: { channelList: () => ['first', 'second', 'cline_free', 'unsupported'].map(id => ({ id, kind: 'builtin' })),
      accountRows: channel => [...rows.values()].filter(r => r.channel === channel), getAccount: id => rows.get(id),
      accountSecrets: () => ({ token: 'secret-never-returned', meta: { parsed: true } }) },
    management: { get: channel => adapters[channel] },
    rules: { rulesDir: () => directory, get: () => catalog, reload: () => { catalog = JSON.parse(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8')); } },
    ensureFreshSecrets: async (_account, secrets) => secrets,
  });
  try {
    let release; gates.set('first', new Promise(resolve => { release = resolve; }));
    const one = refresh.refresh({ channels: ['first'] }), two = refresh.refresh({ channels: ['first'] });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
    release(); assert.deepEqual(await one, await two); gates.delete('first');
    const all = await refresh.refresh();
    assert.deepEqual(all.summary, { refreshed: 3, skipped: 1, failed: 0 });
    assert.equal(catalog.first.models[0].id, 'NewCase'); assert.equal(catalog.first.models[0].rate, 0);
    assert.equal(catalog.second.models[0].upstreamId, 'uuid'); assert.equal(catalog.untouched.models[0].id, 'keep');
    assert.equal(JSON.stringify(all).includes('secret-never-returned'), false);
    const before = JSON.stringify(catalog);
    const invalid = await refresh.refresh({ channels: ['first'], accounts: { first: 'b' } });
    assert.equal(invalid.results[0].code, 'INVALID_ACCOUNT'); assert.equal(JSON.stringify(catalog), before);
    adapters.first.fetchModels = async () => ({ ok: false, message: 'Bearer secret-never-returned https://private' });
    assert.equal((await refresh.refresh({ channels: ['first'] })).results[0].status, 'failed');
    assert.equal(JSON.stringify(catalog), before);
    adapters.first.fetchModels = async () => { rows.delete('a'); return { ok: true, models: [{ id: 'must-not-persist' }] }; };
    assert.equal((await refresh.refresh({ channels: ['first'] })).results[0].code, 'ACCOUNT_CHANGED');
    assert.equal(JSON.stringify(catalog), before);
    rows.set('a', { id: 'a', channel: 'first', token_enc: 'x' });
    adapters.first.fetchModels = async () => ({ ok: true, models: [] });
    assert.equal((await refresh.refresh({ channels: ['first'] })).results[0].status, 'failed');
    assert.equal(JSON.stringify(catalog), before);
    fs.writeFileSync(path.join(directory, 'catalog.json'), '{broken');
    adapters.first.fetchModels = async () => ({ ok: true, models: [{ id: 'valid' }] });
    assert.equal((await refresh.refresh({ channels: ['first'] })).results[0].status, 'failed');
    assert.equal(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8'), '{broken');
    await assert.rejects(refresh.refresh({ channels: ['unknown'] }), /无效/);
    console.log('PASS channel refresh: real forced fetch, public/no-account, single-flight, channel isolation, metadata, atomic persistence, retained failed/empty/corrupt catalogs, explicit account and deleted-account races, redacted results');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
