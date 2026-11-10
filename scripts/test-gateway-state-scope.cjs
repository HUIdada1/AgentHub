"use strict";
// Real signed stdio package + original SQLite/pool + authenticated gateway HTTP.
// The packaged provider is neutral test code, never a private upstream executor.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-state-scope-http-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.AGENTHUB_PLUGIN_DIR = path.join(temporary, "plugins");
const { zip } = require("./test-extension-package.cjs");
const { signingPayload } = require("../electron/backend/extensions/manifest.cjs");
const { exportSdk } = require("../tools/provider-sdk.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const config = require("../electron/backend/config.cjs");
const settings = require("../electron/backend/localgw/config.cjs");
const services = require("../electron/backend/localgw/services.cjs");
const host = require("../electron/backend/plugin-host.cjs");
const scoped = require("../electron/backend/extensions/pool-runtime.cjs").getPoolRuntime(host);
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");
const forwarder = require("../electron/backend/localgw/forwarder.cjs");
const gateway = require("../electron/backend/localgw/server.cjs");
const keys = require("../electron/backend/localgw/keys-store.cjs");
const oplog = require("../electron/backend/localgw/oplog.cjs");
const id = "fixture.state-scope", publisher = "fixture-publisher";
const ref = { kind: "extension", pluginId: id, publisherId: publisher, providerId: "fixture", channel: "loomy" };
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const filename = path.join(directory, item.name);
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false);
    return item.isDirectory() ? filesUnder(filename) : [filename];
  });
}
async function main() {
  // Simulate a database created before authority_revision existed.
  store.open().exec("CREATE TABLE localgw_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', key_hash TEXT NOT NULL, "
    + "key_enc TEXT NOT NULL DEFAULT '', key_prefix TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '[\"*\"]', "
    + "expires_at INTEGER, concurrency INTEGER NOT NULL DEFAULT 8, rate_per_min INTEGER NOT NULL DEFAULT 120, "
    + "status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_used_at INTEGER, "
    + "total_requests INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0)");
  const a = keys.create({ scopes: ["loomy"], ratePerMin: 1000 }), b = keys.create({ scopes: ["loomy"], ratePerMin: 1000 });
  assert.ok(store.open().prepare("PRAGMA table_info(localgw_keys)").all().some(row => row.name === "authority_revision"));
  const aId = a.apiKey.id, initialVersion = keys.authorizationVersion(aId);
  assert.match(initialVersion, /^[a-f0-9]{64}$/);
  assert.equal(keys.authorizationVersion("missing"), null);
  keys.rename(aId, "display only"); keys.touch(aId, 3, 2);
  keys.update(aId, { concurrency: 9, ratePerMin: 999 });
  keys.setStatus(aId, "active");
  assert.equal(keys.authorizationVersion(aId), initialVersion, "non-authority edits keep conversation continuity");
  assert.equal("authorityRevision" in keys.getById(aId), false, "private revision does not alter public Key contract");
  store.addAccount({ channel: "loomy", uid: "fixture", token: "fixture-effective-token", source: "paste" });
  const account = store.listAccounts("loomy")[0];
  pool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  services.configure({ host, poolService: scoped, executor: createExtensionExecutor({ pool, poolService: scoped,
    onSuccess: pool.noteSuccess, onFailure: forwarder.applyExtensionFailure }) });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  host.init({ app: { getVersion: () => "1.99.0" }, bindExtensionSession: scoped.bindSession,
    extensionPolicy: { trustStore: new Map([["fixture-root", { publisher, pluginIds: [id], publicKey }]]) } });
  const project = path.join(temporary, "fixture-package");
  fs.mkdirSync(project);
  exportSdk(project);
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src/main.cjs"), [
    '"use strict";',
    'const assert = require("node:assert/strict");',
    'const { runStdio } = require("../sdk/runtime/provider.cjs");',
    'runStdio({ providers: [{ id: "fixture", channels: ["loomy"], requiredFeatures: ["state-scope@1"],',
    'async *invoke(_params, ctx) {',
    '  assert.equal((await ctx.pool.credentials()).token, "fixture-effective-token");',
    '  yield { type: "delta", delta: { content: JSON.stringify({ stateScope: ctx.request.stateScope,',
    '    requestKeys: Object.keys(ctx.request), frozen: Object.isFrozen(ctx.request) }) } };',
    '  yield { type: "finish", reason: "stop" };',
    '} }] });',
  ].join("\n"));
  const files = Object.fromEntries(filesUnder(project).map(filename => [path.relative(project, filename).replace(/\\/g, "/"), fs.readFileSync(filename)]));
  const manifest = { schema: 2, id, name: "State scope fixture", publisher, version: "1.0.0",
    host: { api: ">=1.0.0 <2.0.0" }, transport: { kind: "stdio-jsonrpc", version: 1 },
    runtime: { kind: "node", entry: "src/main.cjs", node: ">=22", platforms: [{ os: process.platform, arch: process.arch,
      ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] },
    capabilities: ["ai.provider@1"], permissions: { required: ["pool.forward-scoped"], optional: [] },
    contributes: { providers: [{ id: "fixture", channels: ["loomy"], catalogMode: "public" }] },
    dataSchema: 1, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId: "fixture-root", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  const archive = path.join(temporary, "fixture.zip");
  fs.writeFileSync(archive, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))]));
  assert.equal((await host.install(archive)).ok, true);
  assert.equal((await host.authorize(id, { permissions: ["pool.forward-scoped"], channels: ["loomy"] })).ok, true);
  assert.equal((await host.toggle(id, true)).ok, true);
  const current = config.loadConfig();
  current.localgw = settings.normalize({ ...current.localgw, port: 19657, portCandidates: [19657, 19658, 19659],
    injectPrompt: false, requestTimeoutMs: 10000, routing: { failover: false, maxRetriesPerRequest: 1 },
    models: { custom: { "state-view": { channel: "loomy", real_model: "fixture-model" } } } });
  config.saveConfig(current); services.setBinding("loomy", ref);
  const started = await gateway.start(); assert.equal(started.ok, true, started.message);
  async function call(key, extra = {}) {
    const response = await fetch("http://127.0.0.1:" + started.port + "/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + key.rawKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "state-view", messages: [{ role: "user", content: "same-session" }], ...extra }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const observed = JSON.parse(JSON.parse(text).choices[0].message.content);
    assert.equal(observed.frozen, true);
    assert.deepEqual(observed.requestKeys.sort(), ["headers", "stateScope"]);
    assert.match(observed.stateScope, /^[a-f0-9]{64}$/);
    return observed.stateScope;
  }
  const first = await call(a, { stateScope: "forged-body", audience: "key:forged", request: { stateScope: "forged-nested" } });
  assert.equal(await call(a), first, "same authenticated Key/source retains its partition");
  const other = await call(b);
  assert.notEqual(other, first, "a different gateway Key cannot continue the same plugin session");
  keys.touch(aId, 2, 1); keys.rename(aId, "renamed");
  assert.equal(await call(a), first);
  keys.update(aId, { scopes: ["*"] });
  assert.notEqual(await call(a), first);
  keys.update(aId, { scopes: ["loomy"] });
  const restored = await call(a);
  assert.notEqual(restored, first, "restoring old scopes does not revive the old state domain");
  assert.equal(await call(b), other, "another Key's permissions do not invalidate this valid Key");
  keys.setStatus(aId, "disabled");
  assert.equal(keys.authorizationVersion(aId), null);
  keys.setStatus(aId, "active");
  assert.notEqual(await call(a), restored, "disable/enable rotates the execution domain");
  const beforeExpiry = keys.authorizationVersion(aId);
  keys.update(aId, { expiresAt: Date.now() - 1 }); assert.equal(keys.authorizationVersion(aId), null);
  keys.update(aId, { expiresAt: null }); assert.notEqual(keys.authorizationVersion(aId), beforeExpiry);
  const beforeRestart = await call(a);
  assert.equal((await host.toggle(id, false)).ok, true);
  assert.equal((await host.toggle(id, true)).ok, true);
  assert.notEqual(await call(a), beforeRestart, "a new plugin process cannot recover old session state");
  const logs = JSON.stringify(oplog.list({ limit: 100 }));
  for (const value of [a.rawKey, b.rawKey, first, other, aId, "fixture-effective-token"]) {
    assert.equal(logs.includes(value), false, "state context and credentials stay out of public operation logs");
  }
  keys.remove(aId); assert.equal(keys.authorizationVersion(aId), null);
  assert.equal((await host.uninstall(id)).ok, true);
  assert.equal(store.listAccounts("loomy").length, 1);
  assert.equal(scoped.activeRequests, 0); assert.equal(scoped.activeGrants, 0);
  console.log("PASS signed state scope over formal HTTP: legacy Key migration, stable same-Key state, cross-Key separation, forged body ignored, non-reviving reauthorization, isolated other Key, process restart, private logs and account retention");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await gateway.stop(); scoped.close(); host.killAll();
  require("../electron/backend/proxy/netproxy.cjs").closeAll();
  store.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
