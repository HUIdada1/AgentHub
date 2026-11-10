"use strict";
// Explicit external-project integration harness. Temporary signed package,
// original management singleton/SQLite, real gateway, synthetic local upstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const project = fs.realpathSync(path.resolve(process.argv[2] || (() => { throw new Error("External plugin project required"); })()));
const core = path.resolve(__dirname, "..");
const relative = path.relative(core, project);
assert.ok(relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), "plugin must be outside the core tree");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-autoclaw-formal-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.AGENTHUB_PLUGIN_DIR = path.join(temporary, "plugins");
const { zip } = require("../scripts/test-extension-package.cjs");
const { signingPayload } = require("../electron/backend/extensions/manifest.cjs");
const { exportSdk } = require("./provider-sdk.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const management = require("../electron/backend/proxy/management-adapters.cjs");
const refresh = require("../electron/backend/proxy/autoclaw/refresh.cjs");
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
let selections = 0, reads = 0;
const originalPick = pool.pickAccount, originalSecrets = store.accountSecrets, originalRefresh = refresh.refreshToken;
pool.pickAccount = (...args) => { selections++; return originalPick(...args); };
store.accountSecrets = (...args) => { reads++; return originalSecrets(...args); };
const sends = [];
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  sends.push({ headers: req.headers, url: req.url, body: JSON.parse(raw) });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"EXTERNAL-PLUGIN"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
});
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const filename = path.join(directory, item.name); assert.ok(!fs.lstatSync(filename).isSymbolicLink());
    return item.isDirectory() ? filesUnder(filename) : [filename];
  });
}
async function main() {
  exportSdk(project, { check: true });
  services.configure({ host, poolService: scoped, executor: createExtensionExecutor({ pool, poolService: scoped,
    onSuccess: pool.noteSuccess, onFailure: forwarder.applyExtensionFailure }) });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const template = JSON.parse(fs.readFileSync(path.join(project, "manifest.json")));
  const id = template.id, channels = ["autoclaw", "autoclaw_intl"];
  host.init({ app: { getVersion: () => "1.99.0" }, bindExtensionSession: scoped.bindSession,
    extensionPolicy: { trustStore: new Map([["fixture-root", { publisher: template.publisher, pluginIds: [id], publicKey }]]) } });
  const jwt = marker => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, marker })).toString("base64url")}.signature`;
  const oldToken = jwt("old-db"), effectiveToken = jwt("effective-cache");
  const accounts = new Map();
  for (const channel of channels) {
    store.addAccount({ channel, uid: `fixture-${channel}`, token: oldToken, refreshToken: "private-original-refresh", source: "paste" });
    const row = store.listAccounts(channel)[0]; accounts.set(channel, row);
    pool.updateStatus(row.id, { status: "online", coolUntil: 0, coolReason: "" });
    refresh.refreshToken = async () => ({ ok: true, token: effectiveToken, refreshToken: "cache-only-refresh", noPersist: true });
    const result = await management.get(channel).refreshToken({ ...row, meta: {} }, store.accountSecrets(store.getAccount(row.id)));
    assert.equal(result.noPersist, true);
  }
  refresh.refreshToken = originalRefresh;
  fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify(Object.fromEntries(channels.map(channel =>
    [channel, { models: [{ id: "catalog-only", name: "Catalog Display", routeId: "zaicoding_formal-only" }] }]))));
  rules.reload("catalog.json");
  const current = config.loadConfig();
  current.localgw = settings.normalize({ ...current.localgw, port: 19647, portCandidates: [19647, 19648, 19649],
    injectPrompt: false, requestTimeoutMs: 10000, routing: { failover: false, maxRetriesPerRequest: 1 },
    models: { custom: Object.fromEntries(channels.map(channel => [`view-${channel}`, { channel, real_model: "Catalog Display" }])) } });
  config.saveConfig(current);
  const started = await gateway.start(); assert.equal(started.ok, true, started.message);
  const key = keys.create({ scopes: ["*"] });
  async function call(channel = "autoclaw", extraHeaders = {}, bodyPatch = {}) {
    const previous = new Set(oplog.list({ limit: 100 }).rows.map(row => row.id));
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ model: `view-${channel}`, messages: [{ role: "user", content: "fixture" }], max_tokens: 12, ...bodyPatch }) });
    const text = await response.text();
    return { status: response.status, text, log: oplog.list({ limit: 100 }).rows.find(row => !previous.has(row.id)) };
  }
  const initialReads = reads;
  assert.equal((await call()).status, 503); assert.equal(selections, 0); assert.equal(reads, initialReads);
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const files = Object.fromEntries(["src", "sdk"].flatMap(name => filesUnder(path.join(project, name))).map(filename =>
    [path.relative(project, filename).replace(/\\/g, "/"), fs.readFileSync(filename)]));
  const manifest = { ...template, runtime: { ...template.runtime, node: ">=22", platforms: [{ os: process.platform, arch: process.arch,
    ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] }, dataSchema: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId: "fixture-root", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  const archive = path.join(temporary, "suite.zip");
  fs.writeFileSync(archive, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))]));
  assert.equal((await host.install(archive)).ok, true);
  const executionSettings = { userapiBase: `http://127.0.0.1:${upstream.address().port}` };
  fs.mkdirSync(host.dataDir(id), { recursive: true });
  fs.writeFileSync(path.join(host.dataDir(id), "settings.json"), JSON.stringify({ autoclaw: executionSettings, autoclaw_intl: executionSettings }));
  const permissions = ["pool.forward-scoped", "network.outbound"];
  assert.equal((await host.authorize(id, { permissions, channels })).ok, true);
  assert.equal((await host.toggle(id, true)).ok, true);
  assert.equal((await call()).status, 503); assert.equal(selections, 0); assert.equal(reads, initialReads);
  for (const channel of channels) services.setBinding(channel, { kind: "extension", pluginId: id, publisherId: template.publisher, providerId: channel, channel });
  const suppliedHeaders = { "x-autoclaw-session-id": "actual-session", "x-autoclaw-agent-id": "actual-agent",
    "x-autoclaw-zcode-invocation-id": "actual-invocation", "x-api-key": "inbound-private", cookie: "inbound-private" };
  let result = await call("autoclaw", suppliedHeaders);
  assert.equal(result.status, 200, result.text);
  assert.equal("x-session-id" in sends.at(-1).headers, false, "optional permission is not granted by installation");
  assert.equal((await host.authorize(id, { permissions: [...permissions, "request.headers.read"], channels })).ok, true);
  const beforeRevoked = { reads, selections };
  assert.equal((await call()).status, 503, "authorization mutation invalidates the old process");
  assert.equal(reads, beforeRevoked.reads); assert.equal(selections, beforeRevoked.selections);
  assert.equal((await host.toggle(id, true)).ok, true);
  for (const channel of channels) {
    result = await call(channel, suppliedHeaders, { requestHeaders: { "x-autoclaw-session-id": "forged-body" } });
    assert.equal(result.status, 200, result.text); const sent = sends.at(-1);
    assert.equal(JSON.parse(result.text).choices[0].message.content, "EXTERNAL-PLUGIN");
    assert.equal(JSON.parse(result.text).model, `view-${channel}`);
    assert.equal(sent.body.model, "catalog-only"); assert.equal(sent.body.max_tokens, 10000);
    assert.equal(sent.headers["x-request-model"], "zaicoding_formal-only");
    assert.equal(sent.headers["x-authorization"], `Bearer ${effectiveToken}`, "original noPersist cache wins over old database token");
    assert.equal(sent.headers["x-session-id"], "actual-session"); assert.equal(sent.headers["x-agent-id"], "actual-agent");
    assert.equal(sent.headers["x-zcode-invocation-id"], "actual-invocation");
    for (const name of ["authorization", "x-api-key", "cookie", "x-harness-type"]) assert.equal(name in sent.headers, false);
    assert.equal(result.log.model, `view-${channel}`); assert.equal(result.log.attempts[0].model, "Catalog Display");
    assert.deepEqual(result.log.attempts[0].executionFacts.map(({ attemptId, ...facts }) => facts), [{ number: 1, state: "responded", actualModel: "catalog-only" }]);
    assert.doesNotMatch(JSON.stringify(result.log), /private-original-refresh|cache-only-refresh|actual-session|inbound-private|Bearer/);
    const secrets = store.accountSecrets(store.getAccount(accounts.get(channel).id));
    assert.equal(secrets.token, oldToken); assert.equal(secrets.refreshToken, "private-original-refresh");
    assert.equal(pool.inFlightCount(accounts.get(channel).id), 0);
  }
  const invalidBefore = { reads, selections, sends: sends.length };
  result = await call("autoclaw", { "x-autoclaw-session-id": "x".repeat(4097) });
  assert.equal(result.status, 503, result.text);
  assert.equal(reads, invalidBefore.reads); assert.equal(selections, invalidBefore.selections); assert.equal(sends.length, invalidBefore.sends);
  const duplicate = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "view-autoclaw", messages: [{ role: "user", content: "duplicate fixture" }] });
    const request = http.request({ hostname: "127.0.0.1", port: started.port, path: "/v1/chat/completions", method: "POST",
      headers: ["Host", `127.0.0.1:${started.port}`, "Authorization", `Bearer ${key.rawKey}`, "Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(body)),
        "X-AutoClaw-Session-Id", "one", "x-autoclaw-session-id", "two"] }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject); request.end(body);
  });
  assert.equal(duplicate, 503, "duplicate real HTTP field names cannot hide behind Node's merged headers");
  assert.equal(reads, invalidBefore.reads); assert.equal(selections, invalidBefore.selections); assert.equal(sends.length, invalidBefore.sends);
  assert.equal((await host.toggle(id, false)).ok, true);
  const stoppedBefore = { reads, selections };
  assert.equal((await call()).status, 503); assert.equal(reads, stoppedBefore.reads); assert.equal(selections, stoppedBefore.selections);
  assert.equal((await host.uninstall(id)).ok, true); assert.equal((await call()).status, 503);
  for (const channel of channels) assert.equal(store.listAccounts(channel).length, 1);
  assert.equal(scoped.activeGrants, 0); assert.equal(scoped.activeRequests, 0);
  console.log("PASS external AutoClaw signed install/partial authorization/binding/real gateway: both regions, original noPersist singleton, catalog route, authorized real client headers, no gateway secrets, actual model facts, zero account access on invalid headers/stop/uninstall");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await gateway.stop(); scoped.close(); host.killAll(); refresh.refreshToken = originalRefresh;
  if (upstream.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  require("../electron/backend/proxy/netproxy.cjs").closeAll();
  pool.pickAccount = originalPick; store.accountSecrets = originalSecrets;
  store.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
