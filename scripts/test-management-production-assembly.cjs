"use strict";
// Exercise real production consumers, rejecting the legacy registry at load time.
// All account/config data are temporary. No boot, schedulers, login or live HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-management-assembly-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.LOCALAPPDATA = path.join(temporary, "local");
process.env.APPDATA = path.join(temporary, "roaming");
const proxy = path.resolve(__dirname, "../electron/backend/proxy");
const registryFile = path.join(proxy, "management-adapters.cjs");
const originalLoad = Module._load;
const registries = [], consumers = new Set();
let bridgeRegistry;
Module._load = function(request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (typeof filename === "string" && filename.startsWith(proxy + path.sep)) {
    const relative = path.relative(proxy, filename).replace(/\\/g, "/");
    assert.ok(!/^(adapters|qoderAdapter|qoderSigner|zcodeAnthropic|zcode-official-system)\.cjs$/.test(relative), `production loaded legacy forwarding: ${relative}`);
    assert.ok(!/^[^/]+\/adapter\.cjs$/.test(relative), `production loaded mixed factory: ${relative}`);
  }
  const value = originalLoad.call(this, request, parent, isMain);
  if (filename === registryFile) { registries.push(value); consumers.add(path.relative(path.join(__dirname, ".."), parent.filename).replace(/\\/g, "/")); }
  if (filename === path.join(proxy, "forward-access.cjs")) {
    return { ...value, createForwardAccess(options) { bridgeRegistry = options.management; return value.createForwardAccess(options); } };
  }
  return value;
};
let store, scoped, index;
async function main() {
  try {
    const management = require(registryFile);
    store = require("../electron/backend/proxy/store.cjs");
    const credits = require("../electron/backend/proxy/credits.cjs");
    const pool = require("../electron/backend/proxy/pool.cjs");
    require("../electron/backend/proxy/discovery.cjs");
    require("../electron/backend/proxy/ideswitch.cjs");
    index = require("../electron/backend/proxy/index.cjs");
    const handlers = new Map();
    index.register({ handle(name, callback) { assert.ok(!handlers.has(name)); handlers.set(name, callback); } });
    for (const name of ["proxy_account_add", "proxy_account_remove", "proxy_pool", "proxy_status"]) assert.equal(typeof handlers.get(name), "function");
    const host = { providerSessions: () => [] };
    const { getPoolRuntime } = require("../electron/backend/extensions/pool-runtime.cjs");
    scoped = getPoolRuntime(host);
    assert.equal(getPoolRuntime(host), scoped);
    assert.throws(() => getPoolRuntime({ providerSessions: () => [] }), /another manager/);
    assert.equal(bridgeRegistry, management, "scoped bridge delegates to the same production management owner");
    store.addAccount({ channel: "cline_free", uid: "assembly", token: "fixture-token", source: "paste" });
    const account = store.listAccounts("cline_free")[0];
    pool.updateStatus(account.id, { status: "online", credits: 0 });
    assert.equal(management.get("cline_free").zeroBalanceUsable, true);
    assert.equal(pool.accountPlan("cline_free")[0].eligible, true, "lazy account-plan policy uses the same management registry");

    // Original credits preflight and the registry must share one refresh lock.
    let calls = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const channel = "cline_free";
    const originalAdapter = management.ADAPTERS[channel];
    management.ADAPTERS[channel] = { refreshWindowSec: 1, async refreshToken() { calls++; await barrier; return { ok: true, token: "effective", refreshToken: "rotated", noPersist: true }; } };
    const token = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) })).toString("base64url"), "fixture"].join(".");
    const secrets = { token, refreshToken: "original-rt" }, owner = { id: account.id, uid: account.uid, channel };
    try {
      const first = credits.ensureFreshSecrets(owner, secrets);
      const second = management.refreshTokenLocked(channel, owner, secrets);
      release();
      assert.equal((await first).token, "effective"); assert.equal((await second).token, "effective");
      assert.equal(calls, 1, "no second refresh owner after the production cutover");
    } finally { management.ADAPTERS[channel] = originalAdapter; }
    assert.ok(registries.length >= 6); assert.ok(registries.every(value => value === management));
    for (const name of ["credits", "discovery", "ideswitch", "index", "pool"]) assert.ok(consumers.has(`electron/backend/proxy/${name}.cjs`), `${name} uses the shared owner`);
    assert.ok(consumers.has("electron/backend/extensions/pool-runtime.cjs"));
    assert.ok(!require.cache[path.join(proxy, "adapters.cjs")]);
    console.log(`PASS real production assembly: ${consumers.size} consumers share one management registry, credits/bridge and refresh lock; zero-balance policy preserved; no legacy registry loaded`);
  } finally {
    scoped?.close(); index?.shutdown(); store?.close(); Module._load = originalLoad;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
