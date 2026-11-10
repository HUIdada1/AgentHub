"use strict";
// Real signed package -> existing manager -> original SQLite pool -> formal HTTP
// gateway. Ephemeral data, generated test trust root, no production upstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-formal-plugin-"));
process.env.AGENTHUB_DATA_DIR = path.join(directory, "data");
process.env.AGENTHUB_PLUGIN_DIR = path.join(directory, "plugins");
const { zip } = require("./test-extension-package.cjs");
const { signingPayload } = require("../electron/backend/extensions/manifest.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const config = require("../electron/backend/config.cjs");
const localConfig = require("../electron/backend/localgw/config.cjs");
const services = require("../electron/backend/localgw/services.cjs");
const host = require("../electron/backend/plugin-host.cjs");
const scopedPool = require("../electron/backend/extensions/pool-runtime.cjs").getPoolRuntime(host);
const forwarder = require("../electron/backend/localgw/forwarder.cjs");
const { createExtensionExecutor } = require("../electron/backend/localgw/extension-executor.cjs");
const gateway = require("../electron/backend/localgw/server.cjs");
const keys = require("../electron/backend/localgw/keys-store.cjs");
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
let selections = 0, decryptions = 0, standardCalls = 0;
const heldStandard = new Set();
const modelSends = [];
const attemptUpstream = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  assert.ok(payload.attemptId); assert.ok(payload.accountId);
  modelSends.push(payload);
  res.end("accepted model attempt");
});
const originalPick = pool.pickAccount, originalSecrets = store.accountSecrets;
pool.pickAccount = (...args) => { selections++; return originalPick(...args); };
store.accountSecrets = (...args) => { decryptions++; return originalSecrets(...args); };
const upstream = http.createServer(async (req, res) => {
  standardCalls++;
  let body = ""; for await (const chunk of req) body += chunk;
  const content = JSON.parse(body).messages[0].content;
  assert.ok(["custom user prompt", "standard-hold"].includes(content));
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (content === "standard-hold") {
    heldStandard.add(res); res.once("close", () => heldStandard.delete(res)); res.flushHeaders(); return;
  }
  res.end('data: {"choices":[{"delta":{"content":"STANDARD"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
});
async function main() {
  services.configure({ host, poolService: scopedPool,
    executor: createExtensionExecutor({ pool, poolService: scopedPool, onSuccess: pool.noteSuccess, onFailure: forwarder.applyExtensionFailure }) });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const id = "test.formal-provider";
  host.init({ app: { getVersion: () => "1.99.0" }, bindExtensionSession: scopedPool.bindSession,
    extensionPolicy: { trustStore: new Map([["test-key", { publisher: "test-publisher", pluginIds: [id], publicKey }]]) } });
  store.addAccount({ channel: "loomy", uid: "fixture", token: "ephemeral-token", source: "paste" });
  const account = store.listAccounts("loomy")[0];
  pool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  const current = config.loadConfig();
  current.localgw = localConfig.normalize({ ...current.localgw, port: 19527, portCandidates: [19527, 19528, 19529],
    injectPrompt: false, requestTimeoutMs: 10000, streamTotalTimeoutMs: 0,
    security: { ...current.localgw?.security, readonlyToken: "fixture-readonly-token" },
    models: { custom: { "fixture-model": { channel: "loomy", real_model: "fixture-model" } } } });
  config.saveConfig(current);
  const started = await gateway.start(); assert.equal(started.ok, true, started.message);
  const full = keys.create({ scopes: ["*"] }), denied = keys.create({ scopes: ["standard"] });
  const base = `http://127.0.0.1:${started.port}`;
  async function call(body = {}, key = full.rawKey, endpoint = "/v1/chat/completions") {
    const response = await fetch(base + endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "hello" }], ...body }) });
    return { status: response.status, text: await response.text() };
  }
  let result = await call();
  assert.equal(result.status, 503); assert.match(result.text, /FORWARD_PLUGIN_UNAVAILABLE/);
  assert.equal(selections, 0); assert.equal(decryptions, 0);
  result = await call({}, denied.rawKey); assert.equal(result.status, 403);
  assert.equal((await require("../electron/backend/localgw/routing.cjs").testChannel("loomy")).ok, false);
  assert.equal(selections, 0); assert.equal(decryptions, 0, "uninstalled plugin probe cannot read model credentials");

  await new Promise(resolve => attemptUpstream.listen(0, "127.0.0.1", resolve));
  const attemptEndpoint = `http://127.0.0.1:${attemptUpstream.address().port}`;
  const sdk = path.join(__dirname, "../electron/backend/extensions");
  const files = {
    "main.cjs": `const {runStdio,forwardError}=require('./sdk/runtime/provider.cjs');
      runStdio({providers:[{id:'fixture',channels:['loomy'],async listModels(){return [{id:'fixture-model'},{id:'directory-model'}]},async *invoke(request,ctx){
        const credentials=await ctx.pool.credentials();
        if(credentials.token!=='ephemeral-token') throw new Error('wrong original credential');
        const live=await ctx.pool.context();
        if(!(live.models||[]).some(model=>model.id==='directory-model')) throw new Error('live catalog missing from execution context');
        const text=request.input.messages.at(-1).content;
        if(text==='budget-shared') {
          const context=await ctx.pool.context();
          const dispatch=async()=>{const ticket=ctx.attempts.current;
            const response=await fetch(${JSON.stringify(attemptEndpoint)},{method:'POST',signal:ctx.signal,
              body:JSON.stringify({attemptId:ticket.attemptId,number:ticket.number,accountId:context.accountId})});
            await response.text();};
          await dispatch();
          if(ctx.attempts.current.number===1) {
            await ctx.attempts.next('content-remediation'); await dispatch();
            throw forwardError({code:'ACCOUNT_REJECTED',message:'explicit rejection',category:'rate',scope:'invocation',replay:'safe',status:429});
          }
        }
        if(text==='idle') yield {type:'checkpoint',replay:'unsafe'};
        else yield {type:'delta',delta:{content:'PLUGIN'}};
        if(text==='hold'||text==='idle') await new Promise((resolve,reject)=>{if(ctx.signal.aborted)return reject(ctx.signal.reason);ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true})});
        yield {type:'usage',mode:'snapshot',usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}};
        yield {type:'finish',reason:'stop'};
      }}]});`,
    "sdk/runtime/provider.cjs": fs.readFileSync(path.join(sdk, "sdk/provider.cjs")),
    "sdk/runtime/network.cjs": fs.readFileSync(path.join(sdk, "sdk/network.cjs")),
    "sdk/rpc.cjs": fs.readFileSync(path.join(sdk, "rpc.cjs")),
    "sdk/provider-protocol.cjs": fs.readFileSync(path.join(sdk, "provider-protocol.cjs"))
  };
  const manifest = { schema: 2, id, publisher: "test-publisher", name: "Formal gateway fixture", version: "1.0.0",
    host: { api: ">=1.0.0 <2.0.0" }, transport: { kind: "stdio-jsonrpc", version: 1 },
    runtime: { kind: "node", entry: "main.cjs", node: ">=22", platforms: [{ os: process.platform, arch: process.arch, ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] },
    capabilities: ["ai.provider@1"], permissions: { required: ["pool.forward-scoped"], optional: [] },
    contributes: { providers: [{ id: "fixture", channels: ["loomy"], catalogMode: "public" }] }, dataSchema: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, crypto.createHash("sha256").update(data).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId: "test-key", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  const filename = path.join(directory, "fixture.zip");
  fs.writeFileSync(filename, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))]));
  const install = await host.install(filename); assert.equal(install.ok, true, install.message);
  await host.authorize(id, { permissions: ["pool.forward-scoped"], channels: ["loomy"] });
  assert.equal((await host.toggle(id, true)).ok, true);
  assert.equal((await call()).status, 503, "READY does not auto-bind an installed plugin");
  assert.equal(selections, 0); assert.equal(decryptions, 0);
  const ref = { kind: "extension", pluginId: id, publisherId: "test-publisher", providerId: "fixture", channel: "loomy" };
  services.setBinding("loomy", ref);
  const wrong = { ...ref, publisherId: "wrong-publisher" };
  services.setBinding("loomy", wrong);
  assert.equal((await call()).status, 503); assert.equal(selections, 0);
  services.setBinding("loomy", ref);
  result = await call(); assert.equal(result.status, 200, result.text);
  assert.equal(JSON.parse(result.text).choices[0].message.content, "PLUGIN");
  assert.equal(JSON.parse(result.text).usage.total_tokens, 6);
  assert.equal(selections, 1); assert.equal(pool.inFlightCount(account.id), 0);
  const catalogResponse = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${full.rawKey}` } });
  assert.equal(catalogResponse.status, 200);
  assert.ok((await catalogResponse.json()).data.some(row => row.id === "directory-model"), "READY catalog is used without a custom model override");
  const models = require("../electron/backend/localgw/models.cjs");
  const managementDirectory = await models.snapshot();
  assert.ok(managementDirectory.models.some(row => row.id === "directory-model"));
  assert.equal(managementDirectory.diagnostics.complete, true);
  assert.equal(managementDirectory.diagnostics.totalSources, 1);
  assert.equal(managementDirectory.diagnostics.examinedSources, 1);
  assert.equal(managementDirectory.diagnostics.pendingSources, 0);
  assert.deepEqual(managementDirectory.diagnostics.errors, []);
  const restrictedDirectory = await models.snapshot({ audience: "management-fixture-denied", authorizeChannel: () => false });
  assert.ok(!restrictedDirectory.models.some(row => row.id === "directory-model"));
  assert.equal(restrictedDirectory.diagnostics.totalSources, 0, "snapshot diagnostics share the same authorization as its model rows");
  const scopedDirectory = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${denied.rawKey}` } });
  assert.ok(!(await scopedDirectory.json()).data.some(row => row.id === "directory-model"), "model Key cannot borrow another Key's catalog");
  const readonlyDirectory = await fetch(base + "/v1/models", { headers: { authorization: "Bearer fixture-readonly-token" } });
  assert.ok((await readonlyDirectory.json()).data.some(row => row.id === "directory-model"), "readonly directory access is preserved with a separate audience");
  assert.equal((await call({}, "fixture-readonly-token")).status, 403, "readonly directory access never authorizes execution");
  result = await call({ model: "directory-model" }); assert.equal(result.status, 200, result.text);
  assert.match(result.text, /PLUGIN/);
  result = await call({ model: "no-such-model" }); assert.equal(result.status, 404);
  result = await call({ stream: true }); assert.equal(result.status, 200); assert.match(result.text, /PLUGIN/);
  result = await call({ max_tokens: 16 }, full.rawKey, "/v1/messages");
  assert.equal(result.status, 200, result.text); assert.equal(JSON.parse(result.text).content[0].text, "PLUGIN");
  result = await call({ input: "hello", stream: true }, full.rawKey, "/v1/responses");
  assert.equal(result.status, 200); assert.match(result.text, /response.completed/);
  const usedBefore = pool.poolAccounts("loomy", true).find(row => row.id === account.id).lastUsed;
  assert.equal((await require("../electron/backend/localgw/routing.cjs").testChannel("loomy")).ok, true);
  assert.equal(pool.poolAccounts("loomy", true).find(row => row.id === account.id).lastUsed, usedBefore, "gateway probe retains original read-only selection");
  store.addAccount({ channel: "loomy", uid: "budget-secondary", token: "ephemeral-token", source: "paste" });
  const secondary = store.listAccounts("loomy").find(row => row.uid === "budget-secondary");
  pool.updateStatus(secondary.id, { status: "online", coolUntil: 0, coolReason: "" });
  try {
    for (const [limit, expectedStatus] of [[1, 503], [2, 429], [3, 200]]) {
      localConfig.patch({ routing: { failover: true, maxRetriesPerRequest: limit } });
      modelSends.length = 0;
      const attemptResult = await call({ messages: [{ role: "user", content: "budget-shared" }] });
      assert.equal(attemptResult.status, expectedStatus, attemptResult.text);
      assert.equal(modelSends.length, limit, "formal gateway and plugin-internal attempts consume one shared budget");
      assert.deepEqual(modelSends.map(row => row.number), Array.from({ length: limit }, (_, index) => index + 1));
      assert.equal(new Set(modelSends.map(row => row.attemptId)).size, limit);
      if (limit > 1) assert.equal(modelSends[0].accountId, modelSends[1].accountId, "plugin remediation retains the original account");
      if (limit > 2) assert.notEqual(modelSends[1].accountId, modelSends[2].accountId, "gateway failover reuses the same budget on another original account");
      assert.equal(scopedPool.activeRequests, 0); assert.equal(scopedPool.activeGrants, 0);
      assert.equal(pool.inFlightCount(account.id), 0); assert.equal(pool.inFlightCount(secondary.id), 0);
    }
  } finally { store.removeAccount(secondary.id); }
  const requests = require("../electron/backend/localgw/requests.cjs");
  async function until(predicate) {
    for (let i = 0; i < 150 && !predicate(); i++) await tick();
    assert.ok(predicate(), "idle execution reached its expected lifecycle state");
  }
  async function settled(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("idle revocation did not cancel execution")), 2500); })]); }
    finally { clearTimeout(timer); }
  }
  async function revokeIdle(mutate, options = {}) {
    const key = keys.create({ scopes: ["loomy"], ...options });
    const hanging = call({ messages: [{ role: "user", content: "idle" }], stream: true }, key.rawKey);
    await until(() => scopedPool.activeRequests === 1);
    await until(() => [...host.providerSessions()[0].session.active.values()].some(row => row.nextSeq >= 2));
    mutate(key);
    const result = await settled(hanging);
    assert.equal(result.status, 499, result.text);
    await until(() => scopedPool.activeRequests === 0);
    assert.equal(pool.inFlightCount(account.id), 0);
    assert.equal(scopedPool.activeGrants, 0);
    assert.equal(requests.list().length, 0);
    keys.remove(key.apiKey.id);
  }
  // Only normal mutation APIs: never inject requests.cancel to make these pass.
  const readingKey = keys.create({ scopes: ["loomy"] });
  let partialRequest;
  const partialResponse = new Promise((resolve, reject) => {
    partialRequest = http.request(base + "/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${readingKey.rawKey}`, "content-type": "application/json"
    } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    });
    partialRequest.on("error", reject);
    partialRequest.write('{"model":"fixture-model",'); // Intentionally no request end.
  });
  try {
    await until(() => requests.list().some(row => row.keyPrefix === readingKey.apiKey.keyPrefix && row.phase === "读取请求"));
    keys.remove(readingKey.apiKey.id);
    assert.equal((await settled(partialResponse)).status, 499, "revocation also cancels an incomplete HTTP request body");
  } finally { partialRequest.destroy(); }
  await until(() => requests.list().length === 0);
  await revokeIdle(key => keys.setStatus(key.apiKey.id, "disabled"));
  await revokeIdle(key => keys.remove(key.apiKey.id));
  await revokeIdle(key => keys.update(key.apiKey.id, { scopes: ["standard"] }));
  await revokeIdle(key => keys.update(key.apiKey.id, { expiresAt: Date.now() + 100 }));
  await revokeIdle(() => pool.updateStatus(account.id, { status: "disabled" }));
  pool.updateStatus(account.id, { status: "online" });
  await revokeIdle(() => services.setBinding("loomy", { ...ref, publisherId: "replaced-publisher" }));
  services.setBinding("loomy", ref);
  await host.stop(id);
  const selectedBefore = selections, readsBefore = decryptions;
  assert.equal((await call()).status, 503); assert.equal(selections, selectedBefore); assert.equal(decryptions, readsBefore);
  assert.equal((await call({ model: "directory-model" })).status, 503, "historical catalog keeps known missing source distinct from unknown model");
  assert.equal((await call({ model: "no-such-model" })).status, 404);
  const stoppedDirectory = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${full.rawKey}` } });
  assert.ok(!(await stoppedDirectory.json()).data.some(row => row.id === "directory-model"), "stopped source is not advertised");
  assert.equal(services.list().find(row => row.channel === "loomy").ready, false, "historical source survives plugin stop");
  const restart = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const assert=require('node:assert/strict');
    const gateway=require('./electron/backend/localgw/server.cjs');
    const store=require('./electron/backend/proxy/store.cjs');
    const pool=require('./electron/backend/proxy/pool.cjs');
    let reads=0,picks=0;
    const originalSecrets=store.accountSecrets,originalPick=pool.pickAccount;
    store.accountSecrets=(...args)=>{reads++;return originalSecrets(...args)};
    pool.pickAccount=(...args)=>{picks++;return originalPick(...args)};
    (async()=>{
      const started=await gateway.start();assert.equal(started.ok,true,started.message);
      const base='http://127.0.0.1:'+started.port;
      for(const [model,status] of [['directory-model',503],['no-such-model',404]]) {
        const result=await fetch(base+'/v1/chat/completions',{method:'POST',
          headers:{authorization:'Bearer '+${JSON.stringify(full.rawKey)},'content-type':'application/json'},
          body:JSON.stringify({model,messages:[{role:'user',content:'restart fixture'}]})});
        assert.equal(result.status,status,await result.text());
      }
      assert.equal(reads,0);assert.equal(picks,0);
      const directory=await fetch(base+'/v1/models',{headers:{authorization:'Bearer '+${JSON.stringify(full.rawKey)}}});
      assert.ok(!(await directory.json()).data.some(row=>row.id==='directory-model'));
      console.log('PASS cold process HTTP history: known unavailable 503, unknown 404, zero secret reads/selections, no executable cached models');
    })().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
      await gateway.stop();require('./electron/backend/proxy/netproxy.cjs').closeAll();store.close();
    });
  `], { cwd: path.join(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 20000 });
  assert.equal(restart.status, 0, restart.stdout + restart.stderr);
  assert.match(restart.stdout, /PASS cold process HTTP history/);

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  store.saveProvider({ id: "standard", kind: "openai_compat", baseUrl: `http://127.0.0.1:${upstream.address().port}`, models: ["wire"] });
  store.addAccount({ channel: "standard", uid: "key", token: "standard-key", source: "paste" });
  result = await call({ model: "standard/wire", messages: [{ role: "user", content: "custom user prompt" }] });
  assert.equal(result.status, 200, result.text); assert.match(result.text, /STANDARD/); assert.equal(standardCalls, 1);
  const standardAccount = store.listAccounts("standard")[0];
  const standardKey = keys.create({ scopes: ["standard"] });
  const survivorKey = keys.create({ scopes: ["standard", "loomy"] });
  const standardBody = { model: "standard/wire", stream: true, messages: [{ role: "user", content: "standard-hold" }] };
  const victim = call(standardBody, standardKey.rawKey);
  let survivorSettled = false;
  const survivor = call(standardBody, survivorKey.rawKey).then(result => { survivorSettled = true; return result; });
  await until(() => heldStandard.size === 2);
  keys.update(survivorKey.apiKey.id, { scopes: ["standard"] });
  keys.setStatus(standardKey.apiKey.id, "disabled");
  assert.equal((await settled(victim)).status, 499);
  await until(() => heldStandard.size === 1);
  assert.equal(survivorSettled, false, "another Key and a still-authorized narrowed scope keep their idle stream");
  assert.equal(pool.inFlightCount(standardAccount.id), 1);
  keys.remove(survivorKey.apiKey.id);
  assert.equal((await settled(survivor)).status, 499);
  await until(() => heldStandard.size === 0);
  assert.equal(pool.inFlightCount(standardAccount.id), 0);
  assert.equal(require("../electron/backend/extensions/authority-watch.cjs").authority.size, 0);
  assert.equal(pool.inFlightCount(account.id), 0);
  console.log("PASS formal gateway: signed child package, three protocols, directory, real HTTP sends share plugin/account failover budgets, idle Key/scope/expiry/account/source revocation, unaffected Key, original lease cleanup and standard provider cancellation");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await gateway.stop(); scopedPool.close(); host.killAll();
  if (upstream.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  if (attemptUpstream.listening) { attemptUpstream.closeAllConnections(); await new Promise(resolve => attemptUpstream.close(resolve)); }
  require("../electron/backend/proxy/netproxy.cjs").closeAll();
  pool.pickAccount = originalPick; store.accountSecrets = originalSecrets;
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
});
