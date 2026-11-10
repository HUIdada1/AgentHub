"use strict";
// Integration entry point for the separately located plugin project. The core
// never imports this provider at runtime or ships its source. All data is temp.
// Run with Electron-as-Node: tools/plugin-cline-selftest.cjs <external-project>.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const project = fs.realpathSync(path.resolve(process.argv[2] || (() => { throw new Error("External plugin project argument required"); })()));
const core = path.resolve(__dirname, "..");
const relative = path.relative(core, project);
assert.ok(relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), "plugin must be outside the core tree");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cline-formal-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.AGENTHUB_PLUGIN_DIR = path.join(temporary, "plugins");
const { zip } = require("../scripts/test-extension-package.cjs");
const { signingPayload } = require("../electron/backend/extensions/manifest.cjs");
const { exportSdk } = require("./provider-sdk.cjs");
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
const rules = require("../electron/backend/proxy/rules.cjs");
const oplog = require("../electron/backend/localgw/oplog.cjs");
const sends = [];
let mode = "ok", selections = 0, reads = 0;
const originalPick = pool.pickAccount, originalSecrets = store.accountSecrets;
pool.pickAccount = (...args) => { selections++; return originalPick(...args); };
store.accountSecrets = (...args) => { reads++; return originalSecrets(...args); };
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  sends.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
  if (mode === "denied" || mode === "surface") {
    res.writeHead(403); res.end(mode === "surface" ? "not a supported client" : "ENTITLEMENT_ERROR private-details"); return;
  }
  if (mode === "missing") { res.writeHead(404); res.end("private-details model not found"); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"CLINE-PLUGIN"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
});
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const filename = path.join(directory, item.name);
    assert.ok(!fs.lstatSync(filename).isSymbolicLink());
    return item.isDirectory() ? filesUnder(filename) : [filename];
  });
}
async function main() {
  exportSdk(project, { check: true });
  services.configure({ host, poolService: scoped,
    executor: createExtensionExecutor({ pool, poolService: scoped, onSuccess: pool.noteSuccess, onFailure: forwarder.applyExtensionFailure }) });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const template = JSON.parse(fs.readFileSync(path.join(project, "manifest.json")));
  const id = template.id;
  host.init({ app: { getVersion: () => "1.99.0" }, bindExtensionSession: scoped.bindSession,
    extensionPolicy: { trustStore: new Map([["fixture-root", { publisher: template.publisher, pluginIds: [id], publicKey }]]) } });
  const future = Math.floor(Date.now() / 1000) + 7200;
  const token = `header.${Buffer.from(JSON.stringify({ exp: future, external_id: "usr-fixture" })).toString("base64url")}.signature`;
  const channels = ["cline_free", "cline_pass"];
  for (const channel of channels) for (const suffix of ["one", "two"]) {
    store.addAccount({ channel, uid: `usr-${channel}-${suffix}`, token, refreshToken: "private-management-refresh", source: "paste" });
    const account = store.listAccounts(channel).find(row => row.uid.endsWith(suffix));
    pool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  }
  fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify({
    cline_free: { models: [{ id: "cline-free/Model-A" }] }, cline_pass: { models: [{ id: "cline-pass/Model-A" }] },
  }));
  rules.reload("catalog.json");
  const current = config.loadConfig();
  current.localgw = settings.normalize({ ...current.localgw, port: 19637, portCandidates: [19637, 19638, 19639],
    injectPrompt: false, requestTimeoutMs: 10000, routing: { failover: true, maxRetriesPerRequest: 3 },
    models: { custom: { "free-view": { channel: "cline_free", real_model: "model-a" }, "pass-view": { channel: "cline_pass", real_model: "model-a" } } } });
  config.saveConfig(current);
  const started = await gateway.start(); assert.equal(started.ok, true, started.message);
  const key = keys.create({ scopes: ["*"] });
  async function call(model = "free-view", stream = false) {
    const previous = new Set(oplog.list({ limit: 100 }).rows.map(row => row.id));
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "formal fixture" }] }) });
    const text = await response.text();
    const log = oplog.list({ limit: 100 }).rows.find(row => !previous.has(row.id));
    return { status: response.status, text, log };
  }
  assert.equal((await call()).status, 503); assert.equal(selections, 0); assert.equal(reads, 0);
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const files = Object.fromEntries(["src", "sdk"].flatMap(name => filesUnder(path.join(project, name))).map(filename => [path.relative(project, filename).replace(/\\/g, "/"), fs.readFileSync(filename)]));
  const manifest = { ...template, runtime: { ...template.runtime, node: ">=22", platforms: [{ os: process.platform, arch: process.arch,
    ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] }, dataSchema: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId: "fixture-root", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  const archive = path.join(temporary, "actual-suite.zip");
  fs.writeFileSync(archive, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))]));
  const installed = await host.install(archive); assert.equal(installed.ok, true, installed.message);
  fs.mkdirSync(host.dataDir(id), { recursive: true });
  fs.writeFileSync(path.join(host.dataDir(id), "settings.json"), JSON.stringify({ cline: { apiBase: `http://127.0.0.1:${upstream.address().port}/api/v1` } }));
  const authorized = await host.authorize(id, { permissions: ["pool.forward-scoped", "network.outbound"], channels });
  assert.equal(authorized.ok, true, authorized.message);
  const enabled = await host.toggle(id, true); assert.equal(enabled.ok, true, enabled.message);
  assert.ok(!host.providerSessions()[0].channels.includes("loomy"), "starting a suite does not grant other declared channels");
  assert.throws(() => scoped.capture({ kind: "extension", pluginId: id, publisherId: template.publisher, providerId: "loomy", channel: "loomy" }, () => true), /未就绪|未授权/);
  assert.equal((await call()).status, 503, "READY does not bind automatically");
  assert.equal(selections, 0); assert.equal(reads, 0);
  for (const channel of channels) services.setBinding(channel, { kind: "extension", pluginId: id, publisherId: template.publisher, providerId: channel, channel });
  for (const [model, actual] of [["free-view", "cline-free/Model-A"], ["pass-view", "cline-pass/Model-A"]]) {
    const result = await call(model); assert.equal(result.status, 200, result.text);
    assert.equal(JSON.parse(result.text).choices[0].message.content, "CLINE-PLUGIN");
    assert.equal(JSON.parse(result.text).model, model, "visible alias survives private model mapping");
    assert.equal(sends.at(-1).body.model, actual);
    assert.equal(result.log.model, model, "visible model accounting stays unchanged");
    assert.equal(result.log.attempts[0].model, "model-a", "binding accounting is not overwritten by private mapping");
    assert.deepEqual(result.log.attempts[0].executionFacts.map(({ attemptId, ...facts }) => facts), [{ number: 1, state: "responded", actualModel: actual }]);
    assert.ok(result.log.attempts[0].executionFacts[0].attemptId);
    assert.doesNotMatch(JSON.stringify(result.log), /private-management-refresh|Bearer|workos:/);
    assert.equal(sends.at(-1).headers.authorization, `Bearer workos:${token}`);
    assert.equal(sends.at(-1).headers["x-client-type"], "cline-sdk");
    assert.equal(sends.at(-1).headers["x-task-id"], sends.at(-1).body.session_id);
  }
  const streamed = await call("free-view", true);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.log.attempts[0].executionFacts[0].actualModel, "cline-free/Model-A");
  for (const scenario of ["denied", "surface", "missing"]) {
    mode = scenario; const previous = sends.length;
    const result = await call(); assert.equal(result.status, scenario === "missing" ? 404 : 403, result.text);
    assert.equal(sends.length, previous + 1, "formal gateway never retries Cline deterministic rejection on another account");
    assert.equal(result.log.attempts[0].executionFacts[0].state, "responded", "HTTP rejection still records the actual dispatched model");
    assert.equal(result.log.attempts[0].executionFacts[0].actualModel, "cline-free/Model-A");
    assert.doesNotMatch(result.text, /private-details/);
    for (const channel of channels) for (const account of pool.poolAccounts(channel, true)) {
      assert.equal(account.status, "online"); assert.equal(Number(account.coolUntil || 0), 0);
    }
    assert.equal(scoped.activeGrants, 0); assert.equal(scoped.activeRequests, 0);
  }
  for (const channel of channels) for (const row of store.listAccounts(channel)) {
    assert.equal(store.accountSecrets(store.getAccount(row.id)).refreshToken, "private-management-refresh");
    assert.equal(pool.inFlightCount(row.id), 0);
  }
  const cleanFact = { attemptId: "synthetic-attempt", number: 1, state: "planned", actualModel: "generic/model" };
  oplog.insert({ model: "metadata-validation", attempts: [{ model: "binding", executionFacts: [
    { ...cleanFact, privateToken: "MUST-NOT-LEAK" }, { ...cleanFact, number: 1.5 },
    { ...cleanFact, actualModel: "bad\nmodel" }, { ...cleanFact, actualModel: "界".repeat(342) },
  ] }] });
  const validated = oplog.list({ limit: 100 }).rows.find(row => row.model === "metadata-validation");
  assert.deepEqual(validated.attempts[0].executionFacts, [cleanFact], "logging projects only bounded typed facts and retains its request row");
  assert.doesNotMatch(JSON.stringify(validated), /MUST-NOT-LEAK/);
  oplog.insert({ model: "metadata-bounds", attempts: [{ executionFacts: Array.from({ length: 11 }, () => cleanFact) }] });
  assert.equal(oplog.list({ limit: 100 }).rows.find(row => row.model === "metadata-bounds").attempts[0].executionFacts.length, 10);
  const exported = oplog.exportTo("jsonl"); assert.equal(exported.ok, true);
  assert.ok(fs.readFileSync(exported.path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).some(row => row.attempts.some(attempt => attempt.executionFacts?.[0]?.actualModel === "cline-free/Model-A")));
  const disabled = await host.toggle(id, false); assert.equal(disabled.ok, true, disabled.message);
  const previousReads = reads, previousSelections = selections;
  assert.equal((await call()).status, 503); assert.equal(reads, previousReads); assert.equal(selections, previousSelections);
  const removed = await host.uninstall(id); assert.equal(removed.ok, true, removed.message);
  assert.equal((await call()).status, 503);
  for (const channel of channels) assert.equal(store.listAccounts(channel).length, 2);
  console.log("PASS actual external Cline suite: signed install/authorize/READY/bind, original SQLite zero-balance pools and preflight, HTTP alias/model/headers, deterministic rejection no failover/cooldown, token ownership, stop/uninstall and zero reads without a plugin");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await gateway.stop(); scoped.close(); host.killAll();
  if (upstream.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  require("../electron/backend/proxy/netproxy.cjs").closeAll();
  pool.pickAccount = originalPick; store.accountSecrets = originalSecrets;
  store.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
