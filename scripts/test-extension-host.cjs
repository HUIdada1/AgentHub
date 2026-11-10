"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { zip } = require("./test-extension-package.cjs");
const { signingPayload } = require("../electron/backend/extensions/manifest.cjs");
const { createPoolService } = require("../electron/backend/extensions/pool-service.cjs");
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-host-test-"));
  process.env.AGENTHUB_DATA_DIR = path.join(directory, "data");
  process.env.AGENTHUB_PLUGIN_DIR = path.join(directory, "plugins");
  process.env.AGENTHUB_HOST_SECRET = "must-not-be-inherited";
  process.env.NODE_OPTIONS = "--trace-warnings";
  const host = require("../electron/backend/plugin-host.cjs");
  let accountReads = 0;
  const poolService = createPoolService({ host, getAccount(id) { accountReads++; return id === "existing-account" ? { id, channel: "test-channel", status: "online" } : null; },
    access: { policyFor: () => ({ credentials: ["token"], context: [] }), readCredentials: () => ({ token: "only-current-account" }), ensureCredentials: () => null } });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const id = "test.example-provider", channel = "test-channel";
  const verification = { trustStore: new Map([["test-key", { publisher: "test-publisher", pluginIds: [id], publicKey }]]) };
  const sdkRoot = path.join(__dirname, "../electron/backend/extensions");
  const files = {
    "main.cjs": `"use strict"; const {runStdio} = require('./sdk/runtime/provider.cjs');
      runStdio({providers:[{id:'fixture',channels:['${channel}','test-secondary-channel'],async listModels(){return [{id:'fixture-model'}]},
        async *invoke(request,ctx){
          yield {type:'delta',delta:{content:JSON.stringify({secret:!!process.env.AGENTHUB_HOST_SECRET,nodeOptions:!!process.env.NODE_OPTIONS,pluginId:process.env.AGENTHUB_PLUGIN_ID,...(request.input.pool?{pool:await ctx.pool.credentials()}:{} )})}};
          yield {type:'usage',mode:'snapshot',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
          yield {type:'finish',reason:'stop'};
        }}]});`,
    "sdk/runtime/provider.cjs": fs.readFileSync(path.join(sdkRoot, "sdk/provider.cjs"), "utf8"),
    "sdk/runtime/network.cjs": fs.readFileSync(path.join(sdkRoot, "sdk/network.cjs"), "utf8"),
    "sdk/rpc.cjs": fs.readFileSync(path.join(sdkRoot, "rpc.cjs"), "utf8"),
    "sdk/provider-protocol.cjs": fs.readFileSync(path.join(sdkRoot, "provider-protocol.cjs"), "utf8"),
  };
  const filename = path.join(directory, "plugin.zip");
  function pack(version = "1.0.0", override = {}, contributes = { providers: [{ id: "fixture", channels: [channel, "test-secondary-channel"] }] }) {
    const content = { ...files, ...override };
    const manifest = {
      schema: 2, id, name: "Host fixture", publisher: "test-publisher", version,
      host: { api: ">=1.0.0 <2.0.0" }, transport: { kind: "stdio-jsonrpc", version: 1 },
      runtime: { kind: "node", entry: "main.cjs", node: ">=22", platforms: [{ os: process.platform, arch: process.arch, ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] },
      capabilities: ["ai.provider@1"], permissions: { required: ["network.outbound"], optional: ["pool.forward-scoped"] },
      contributes, dataSchema: 1,
      files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, crypto.createHash("sha256").update(value).digest("hex")])),
    };
    manifest.signature = { algorithm: "ed25519", keyId: "test-key", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
    fs.writeFileSync(filename, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...Object.entries(content).map(([name, data]) => ({ name, data, deflate: true }))]));
  }
  try {
    pack();
    host.init({ app: { getVersion: () => "1.99.0" } });
    assert.equal((await host.install(filename)).ok, false, "No implicit trust on installation");
    assert.equal(fs.existsSync(process.env.AGENTHUB_PLUGIN_DIR), false);
    host.init({ app: { getVersion: () => "1.99.0" }, extensionPolicy: verification, bindExtensionSession: poolService.bindSession });
    const installed = await host.install(filename);
    assert.equal(installed.ok, true, installed.message);
    assert.equal(host.list()[0].running, false, "New providers cannot autostart without permissions");
    assert.equal((await host.start(id)).ok, false);
    assert.equal(host.bridgeOf(id), null, "New provider never receives legacy pool broadcasts");
    assert.equal((await host.authorize(id, { permissions: ["arbitrary"], channels: [channel] })).ok, false);
    assert.equal((await host.authorize(id, { permissions: ["network.outbound"], channels: [channel] })).authorized, true);
    assert.equal((await host.toggle(id, true)).ok, true);
    assert.equal(host.providerSessions().length, 1);
    const first = host.providerSessions()[0], events = [];
    assert.deepEqual(await first.session.listModels({ providerId: "fixture", channel }), [{ id: "fixture-model" }]);
    await first.session.invoke({ providerId: "fixture", channel, model: "fixture-model", input: { messages: [] }, grantId: "fixture-grant", deadlineAt: Date.now() + 5000, onEvent: event => events.push(event) });
    assert.deepEqual(JSON.parse(events.find(event => event.type === "delta").delta.content), { secret: false, nodeOptions: false, pluginId: id });
    assert.equal(events.at(-1).type, "finish");
    const ref = { kind: "extension", pluginId: id, publisherId: "test-publisher", providerId: "fixture", channel };
    assert.throws(() => poolService.open({ ref, invocationId: "denied", accountId: "existing-account", deadlineAt: Date.now() + 5000, authorize: () => true }), error => error.code === "FORWARD_PLUGIN_UNAVAILABLE");
    assert.equal(accountReads, 0, "optional pool permission must be explicitly granted before any account access");
    await host.authorize(id, { permissions: ["network.outbound", "pool.forward-scoped"], channels: [channel] });
    assert.equal((await host.toggle(id, true)).ok, true);
    assert.deepEqual(host.providerSessions()[0].channels, [channel], "suite startup grants only the selected subset");
    const readsBeforeDeniedChannel = accountReads;
    assert.throws(() => poolService.capture({ ...ref, channel: "test-secondary-channel" }, () => true), error => error.code === "FORWARD_PLUGIN_UNAVAILABLE");
    assert.equal(accountReads, readsBeforeDeniedChannel, "declared but ungranted channels fail before account access");
    const scope = poolService.open({ ref, invocationId: "with-pool", accountId: "existing-account", deadlineAt: Date.now() + 5000, authorize: () => true });
    const scopedEvents = [];
    try {
      scope.assertCurrent();
      await scope.session.invoke({ invocationId: "with-pool", providerId: "fixture", channel, model: "fixture-model", input: { pool: true }, grantId: scope.grantId, deadlineAt: Date.now() + 5000, onEvent: event => scopedEvents.push(event) });
      assert.deepEqual(JSON.parse(scopedEvents[0].delta.content).pool, { token: "only-current-account" });
    } finally { scope.close(); scope.close(); }
    assert.equal(poolService.activeGrants, 0);
    assert.equal(poolService.activeRequests, 0);
    let selected = 0, leased = 0;
    const executor = createExtensionExecutor({ poolService, pool: {
      pickAccount() { selected++; return { id: "existing-account" }; },
      accountPlan() { throw new Error("not a probe"); },
      acquireAccount() { leased++; }, releaseAccount() { leased--; }
    } });
    const gatewayEvents = [];
    const fromGateway = await executor.execute({ ref, model: "fixture-model", input: { pool: true },
      authorize: () => true, deadlineAt: null, onEvent: event => gatewayEvents.push(event) });
    assert.equal(fromGateway.ok, true, JSON.stringify(fromGateway));
    assert.equal(selected, 1);
    assert.equal(leased, 0);
    assert.deepEqual(JSON.parse(gatewayEvents[0].delta.content).pool, { token: "only-current-account" });
    assert.equal(poolService.activeRequests, 0);
    assert.equal(poolService.activeGrants, 0);
    pack("1.0.1", { "main.cjs": "process.exit(4);" });
    const failed = await host.install(filename);
    assert.equal(failed.ok, false);
    assert.equal(failed.rollback, true, failed.message);
    assert.equal(host.list()[0].version, "1.0.0");
    assert.equal(host.providerSessions().length, 1);
    assert.notEqual(host.providerSessions()[0].identity.generation, first.identity.generation);
    // 升级后签名清单删掉旧渠道：plugins.json 里残留的旧授权不能让整个插件停用。
    await host.authorize(id, { permissions: ["network.outbound", "pool.forward-scoped"], channels: [channel, "test-secondary-channel"] });
    assert.equal((await host.toggle(id, true)).ok, true);
    assert.deepEqual(host.providerSessions()[0].channels.sort(), [channel, "test-secondary-channel"].sort());
    pack("1.0.1", { "main.cjs": files["main.cjs"].replace(`'${channel}','test-secondary-channel'`, `'${channel}'`) },
      { providers: [{ id: "fixture", channels: [channel] }] });
    const pruned = await host.install(filename);
    assert.equal(pruned.ok, true, pruned.message);
    assert.equal(pruned.requiresAuthorization, false, "removed channel must not revoke the whole plugin");
    assert.equal(host.list()[0].authorized, true);
    assert.equal(host.providerSessions().length, 1);
    assert.deepEqual(host.providerSessions()[0].channels, [channel], "stale authorized channels are pruned from live scope");
    await host.stop(id);
    assert.equal(host.providerSessions().length, 0);
    const entry = path.join(host.pluginDir(id), "main.cjs");
    fs.writeFileSync(entry, "tampered");
    assert.equal((await host.toggle(id, true)).ok, false, "Every launch rechecks installed resources");
    fs.writeFileSync(entry, files["main.cjs"]);
    await host.authorize(id, { permissions: [], channels: [] });
    assert.equal((await host.start(id)).ok, false, "Revocation survives restart attempts");
    const privateData = path.join(host.dataDir(id), "keep.txt");
    fs.writeFileSync(privateData, "plugin data retained");
    assert.equal((await host.uninstall(id)).ok, true);
    assert.equal(fs.readFileSync(privateData, "utf8"), "plugin data retained");
    assert.equal(host.providerSessions().length, 0);
    const legacy = { schema: 1, id: "legacy-fixture", name: "Legacy fixture", version: "1.0.0", entry: "main.cjs" };
    fs.writeFileSync(filename, zip([{ name: "wrapped/manifest.json", data: JSON.stringify(legacy) }, { name: "wrapped/main.cjs", data: "setInterval(()=>{},1000);" }]));
    assert.equal((await host.install(filename)).ok, true, "Safe extraction retains legacy service compatibility");
    assert.equal(host.list().find(item => item.id === legacy.id).running, true);
    await host.uninstall(legacy.id);
    console.log("PASS extension host: signed install, explicit permissions, real stdio model execution, environment isolation, update rollback, stale-channel authorization pruning, tamper rejection, revocation, legacy compatibility");
  } finally {
    poolService.close();
    host.killAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
