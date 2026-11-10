"use strict";
// Real management factories, isolated storage and fake refresh responses. No live accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-forward-access-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
const { createForwardAccess } = require("../electron/backend/proxy/forward-access.cjs");
const { PoolBroker } = require("../electron/backend/extensions/pool-broker.cjs");
const { makeAutoClaw } = require("../electron/backend/proxy/autoclaw/management.cjs");
const { makeCatPaw } = require("../electron/backend/proxy/catpaw/management.cjs");
const { makeCodeArts } = require("../electron/backend/proxy/codearts/management.cjs");
const { makeMonkeyCode } = require("../electron/backend/proxy/monkeycode/management.cjs");
const { makeKuku } = require("../electron/backend/proxy/kuku/management.cjs");
const autoclawRefresh = require("../electron/backend/proxy/autoclaw/refresh.cjs");
const codeartsCredentials = require("../electron/backend/proxy/codearts/credentials.cjs");
const codeartsOAuth = require("../electron/backend/proxy/codearts/oauth.cjs");

async function main() {
  const accounts = new Map();
  const secrets = new Map();
  const writes = [];
  let reads = 0, lockedCalls = 0, preflightCalls = 0;
  const originalAutoRefresh = autoclawRefresh.refreshToken;
  const originalCodeartsEnsure = codeartsCredentials.ensureFresh;
  const originalCodeartsOAuthRefresh = codeartsOAuth.refreshCredential;
  const store = {
    getAccount: id => accounts.has(id) ? { ...structuredClone(accounts.get(id)), meta: JSON.stringify(accounts.get(id).meta) } : null,
    accountSecrets(account) { reads++; return structuredClone(secrets.get(account.id)); },
    updateAccount(id, patch) {
      if (!accounts.has(id)) return false;
      writes.push({ id, patch: structuredClone(patch) });
      Object.assign(secrets.get(id), patch);
      return true;
    }
  };
  function add(channel, value, meta = {}) {
    accounts.set(channel, { id: channel, channel, uid: `uid-${channel}`, status: "online", meta });
    secrets.set(channel, { ...value, meta });
    return store.getAccount(channel);
  }
  const rules = { get: () => ({}), rulesDir: () => temporary };
  const auto = makeAutoClaw("autoclaw", { rules, deviceIds: () => ({ machineId: "original-device" }) });
  const catpaw = makeCatPaw();
  const codearts = makeCodeArts({ rules, store });
  const monkeycode = makeMonkeyCode("monkeycode", { httpJson: async () => ({ ok: false, status: 503, data: null }) });
  const accio = require("../electron/backend/proxy/accio/management.cjs").makeAccio("accio", { fetchStream: async () => {}, pumpSse: async () => {}, httpJson: async () => ({}), rules, util: {}, firstByteBudgetMs: () => 30000 });
  const kuku = makeKuku({ rules, util: { uuid: () => "test-id" }, httpJson: async () => ({}), fetchStream: async () => ({}), pumpSse: async () => {}, firstByteBudgetMs: () => 30000 });
  const adapters = new Map([
    ["autoclaw", auto], ["catpaw", catpaw], ["codearts", codearts], ["monkeycode", monkeycode], ["accio", accio], ["kuku", kuku],
    ["loomy", { models: () => ["actual-model"] }],
    ["modelscope", { models: () => ["org/model-a"], modelEntries: () => [{ id: "org/model-a", name: "Public model", private: "not-exported" }] }],
    ["lobster", { models: () => ["MiniMax-M3"] }],
    ["zcode", { models: () => ["paid-model"], readForwardContext: () => ({ deviceMid: "original-mid", provider: "bigmodel", private: "not-exported" }) }],
    ["qoder", { models: () => ["qmodel"], readForwardContext: account => ({ machineId: account.meta.machineId, private: "not-exported" }) }]
  ]);
  let refreshHook;
  const management = {
    get: channel => adapters.get(channel),
    async refreshTokenLocked(channel, account, current) {
      lockedCalls++;
      return refreshHook ? refreshHook(channel, account, current) : adapters.get(channel).refreshToken(account, current);
    }
  };
  const access = createForwardAccess({ store, management,
    ensureFreshSecrets: async (_account, current) => { preflightCalls++; return current; } });
  const identity = { pluginId: "signed-plugin", publisherId: "publisher", sessionId: "session", generation: 1 };
  let allowed = true;
  const broker = new PoolBroker({ getAccount: store.getAccount, ...access, authorize: () => allowed });
  const issue = (channel, purpose = "invoke", lifetime = 10000) => broker.issue({ identity, invocationId: `${channel}-${Math.random()}`, accountId: channel, channel, purpose, deadlineAt: Date.now() + lifetime });
  const read = grant => broker.credentials(identity, grant.grantId);
  const ensure = (grant, reason = "upstream-auth-expired") => broker.ensure(identity, grant.grantId, reason);
  try {
    const count = reads;
    assert.equal(access.policyFor("unaudited-channel", "invoke"), null);
    await assert.rejects(access.readCredentials({ id: "unknown", channel: "unaudited-channel" }), error => error.code === "GRANT_POLICY");
    assert.equal(reads, count, "unknown policy fails before decrypting credentials");

    add("modelscope", { token: "modelscope-session", refreshToken: "private-refresh", unused: "private" });
    assert.deepEqual(await read(issue("modelscope")), { token: "modelscope-session" });
    const modelScopeContext = await broker.context(identity, issue("modelscope", "catalog").grantId);
    assert.deepEqual(modelScopeContext.models, [{ id: "org/model-a", name: "Public model" }]);
    assert.doesNotMatch(JSON.stringify(modelScopeContext), /private|refresh/);
    add("lobster", { token: "lobster-session", refreshToken: "private-refresh", unused: "private" });
    assert.deepEqual(await read(issue("lobster")), { token: "lobster-session" });
    assert.deepEqual((await broker.context(identity, issue("lobster", "catalog").grantId)).models, [{ id: "MiniMax-M3" }]);

    add("loomy", { token: "loomy-session", refreshToken: "private-refresh", unused: "private" });
    const loom = issue("loomy");
    assert.deepEqual(await read(loom), { token: "loomy-session" });
    assert.deepEqual(await broker.context(identity, loom.grantId), { accountId: "loomy", uid: "uid-loomy", models: [{ id: "actual-model" }] });
    assert.deepEqual(await ensure(loom, "preflight"), { token: "loomy-session" });
    assert.equal(preflightCalls, 1);
    assert.equal(writes.length, 0);

    add("monkeycode", { token: "monkey-session", refreshToken: "never-export-monkey" }, { imageId: "image-123", private: "not-exported" });
    const monkey = issue("monkeycode");
    assert.deepEqual(await read(monkey), { session: "monkey-session" });
    add("accio", { token: "accio-session", refreshToken: "private-refresh" });
    assert.deepEqual(await read(issue("accio")), { token: "accio-session" });
    assert.deepEqual((await broker.context(identity, monkey.grantId)).identity, { imageId: "image-123" });
    assert.doesNotMatch(JSON.stringify(await broker.context(identity, monkey.grantId)), /never-export/);

    add("kuku", { token: "BDUSS=bduss-12345678; STOKEN=business-token; PTOKEN=passport-token; BAIDUID=device-cookie" });
    const kukuGrant = issue("kuku");
    const kukuProjection = await read(kukuGrant);
    assert.deepEqual(kukuProjection, {
      bduss: "bduss-12345678", stoken: "business-token", ptoken: "passport-token",
      extras: [["PTOKEN", "passport-token"], ["BAIDUID", "device-cookie"]],
    });
    assert.doesNotMatch(JSON.stringify(kukuProjection), /BDUSS=/, "the forwarding bridge returns parsed fields, not the original Cookie string");
    const beforeKukuRefresh = lockedCalls, beforeKukuWrite = writes.length;
    await assert.rejects(ensure(kukuGrant), error => error.code === "CREDENTIALS_UNAVAILABLE");
    assert.equal(lockedCalls, beforeKukuRefresh + 1, "Kuku refresh uses its original no-refresh management result");
    assert.equal(writes.length, beforeKukuWrite, "Kuku model execution cannot persist or synthesize refreshed credentials");

    for (const channel of ["cline_free", "cline_pass"]) {
      adapters.set(channel, { models: () => [channel === "cline_free" ? "cline-free/model" : "cline-pass/model"] });
      add(channel, { token: "workos:original-cline", refreshToken: "never-export-cline-refresh" }, { clientPath: "never-export-cline-path" });
      const grant = issue(channel);
      assert.deepEqual(await read(grant), { token: "workos:original-cline" });
      const before = preflightCalls;
      assert.deepEqual(await ensure(grant, "preflight"), { token: "workos:original-cline" });
      assert.equal(preflightCalls, before + 1, "Cline delegates to the same original preflight");
      assert.equal(writes.length, 0);
      const catalog = issue(channel, "catalog");
      const calls = preflightCalls;
      await assert.rejects(ensure(catalog, "preflight"), error => error.code === "GRANT_DENIED");
      assert.equal(preflightCalls, calls, "Cline catalog cannot refresh");
    }

    add("catpaw", { token: "original-catpaw-token", refreshToken: "private-refresh" }, { uid: "unrelated-meta-uid", private: "not-exported" });
    assert.deepEqual(await read(issue("catpaw")), { token: "original-catpaw-token", uid: "uid-catpaw" }, "token/uid must come from the original paired parser");
    const catCatalog = require("../electron/backend/proxy/catpaw/catalog.cjs");
    const originalCatList = catCatalog.list;
    const factRows = [{ id: "catalog-model", name: "Catalog model", modelType: 177, secret: "never-export" }];
    const beforeCatFacts = { writes: writes.length, refresh: lockedCalls, preflight: preflightCalls };
    try {
      catCatalog.list = () => factRows;
      assert.deepEqual(catpaw.readForwardModels(), [{ id: "catalog-model", name: "Catalog model", modelType: 177 }]);
      const copy = catpaw.readForwardModels(); copy[0].modelType = 999;
      assert.equal(factRows[0].modelType, 177);
      const facts = await broker.context(identity, issue("catpaw", "catalog").grantId);
      assert.deepEqual(facts.models, [{ id: "catalog-model", name: "Catalog model", modelType: 177 }]);
      assert.doesNotMatch(JSON.stringify(facts), /never-export/);
      for (const value of [NaN, Infinity, -1, 0, 1.5, "177", Number.MAX_SAFE_INTEGER + 1]) {
        catCatalog.list = () => [{ id: "model", name: "Model", modelType: value }];
        await assert.rejects(broker.context(identity, issue("catpaw", "catalog").grantId), error => error.code === "CREDENTIALS_UNAVAILABLE");
      }
      catCatalog.list = () => Array.from({ length: 4097 }, () => factRows[0]);
      await assert.rejects(broker.context(identity, issue("catpaw", "catalog").grantId), error => error.code === "CREDENTIALS_UNAVAILABLE");
      assert.deepEqual({ writes: writes.length, refresh: lockedCalls, preflight: preflightCalls }, beforeCatFacts);
    } finally { catCatalog.list = originalCatList; }

    add("autoclaw", { token: "old", refreshToken: "old-rt" });
    autoclawRefresh.refreshToken = async () => ({ ok: true, token: "new", refreshToken: "new-rt", noPersist: true });
    const autoGrant = issue("autoclaw");
    assert.deepEqual(await ensure(autoGrant), { token: "new" });
    assert.deepEqual(await read(autoGrant), { token: "new" }, "next read must reuse the original noPersist cache");
    assert.equal(secrets.get("autoclaw").token, "old");
    assert.equal(writes.length, 0);
    assert.equal((await broker.context(identity, autoGrant.grantId)).identity.deviceId, "original-device");
    const catalogFile = path.join(temporary, "catalog.json");
    fs.writeFileSync(catalogFile, JSON.stringify({ autoclaw: { models: [{ id: "catalog-only", name: "Catalog display", routeId: "vendor_actual-route", secret: "not-exported" }] } }));
    const withRoutes = await broker.context(identity, autoGrant.grantId);
    assert.deepEqual(withRoutes.models, [{ id: "catalog-only", name: "Catalog display", routeId: "vendor_actual-route" }]);
    assert.doesNotMatch(JSON.stringify(withRoutes), /not-exported/);
    const catalogCopy = auto.readForwardModels(); catalogCopy[0].routeId = "mutated";
    assert.equal(auto.readForwardModels()[0].routeId, "vendor_actual-route", "read-only accessor does not expose the original catalog cache by reference");
    const originalModels = auto.readForwardModels;
    for (const value of [[{ id: "ok", routeId: "bad\nroute" }], [{ id: "ok", routeId: "x".repeat(161) }], [{ id: "ok", name: {} }], Array.from({ length: 4097 }, () => ({ id: "ok" }))]) {
      auto.readForwardModels = () => value;
      await assert.rejects(broker.context(identity, autoGrant.grantId), error => error.code === "CREDENTIALS_UNAVAILABLE");
    }
    auto.readForwardModels = originalModels;
    secrets.get("autoclaw").token = "replacement-login";
    secrets.get("autoclaw").refreshToken = "replacement-rt";
    assert.deepEqual(await read(issue("autoclaw")), { token: "replacement-login" }, "replacement login invalidates the original cache");

    add("zcode", { token: "zcode-jwt", refreshToken: "paid-model-api-key" });
    const zcode = issue("zcode");
    assert.deepEqual(await read(zcode), { token: "zcode-jwt", modelApiKey: "paid-model-api-key" });
    assert.deepEqual((await broker.context(identity, zcode.grantId)).identity, { deviceMid: "original-mid", provider: "bigmodel" });

    add("qoder", { token: "qoder-session", refreshToken: "must-not-export" }, { machineId: "scoped-machine-id" });
    const qoder = issue("qoder");
    assert.deepEqual(await read(qoder), { token: "qoder-session" });
    const qoderContext = await broker.context(identity, qoder.grantId);
    assert.deepEqual(qoderContext.identity, { machineId: "scoped-machine-id" });
    assert.doesNotMatch(JSON.stringify(qoderContext), /must-not-export|not-exported/);

    const credential = {
      access_key_id: "ak", secret_access_key: "sk", security_token: "sts", domain_id: "domain", user_id: "user", user_name: "name",
      expires_at: Date.now() + 3600000, login_type: "WEB", refresh_token: "long-refresh", oauth_context: { privateKey: "NEVER-EXPORT" }
    };
    add("codearts", codeartsCredentials.toStoreFields(credential), { domainId: "domain", userId: "user", userName: "name", oauthContext: credential.oauth_context });
    const signed = await read(issue("codearts"));
    assert.equal(signed.signing.secret_access_key, "sk");
    assert.equal(signed.signing.user_id, "user");
    assert.ok(!JSON.stringify(signed).includes("long-refresh"));
    assert.ok(!JSON.stringify(signed).includes("NEVER-EXPORT"));
    assert.equal("token" in signed, false, "packed OAuth bundle must not be exported");
    codeartsCredentials.ensureFresh = async (_account, _current, force) => {
      const fresh = { ...credential, access_key_id: force ? "forced-ak" : "preflight-ak", refresh_token: "rotated-refresh" };
      return { ok: true, credential: fresh, refreshed: true, fields: codeartsCredentials.toStoreFields(fresh) };
    };
    const beforePreflight = writes.length;
    assert.equal((await ensure(issue("codearts"), "preflight")).signing.access_key_id, "preflight-ak");
    assert.equal(writes.length, beforePreflight + 1, "original CodeArts preflight owns complete persistence");
    const beforeForce = writes.length;
    assert.equal((await ensure(issue("codearts"))).signing.access_key_id, "forced-ak");
    assert.equal(writes.length, beforeForce + 1, "do not duplicate/flatten CodeArts' own whole-bundle write");
    assert.equal(secrets.get("codearts").refreshToken, "rotated-refresh");

    // Exercise the original CodeArts single-flight, not a new bridge lock.
    codeartsCredentials.ensureFresh = originalCodeartsEnsure;
    add("codearts", codeartsCredentials.toStoreFields({ ...credential, expires_at: 1 }), { domainId: "domain", userId: "user", userName: "name" });
    let releaseCodearts, oauthCalls = 0;
    codeartsOAuth.refreshCredential = async existing => {
      oauthCalls++;
      await new Promise(resolve => { releaseCodearts = resolve; });
      return { ...existing, access_key_id: "concurrent-ak", refresh_token: "singleflight-rotated", expires_at: Date.now() + 3600000 };
    };
    const beforeConcurrent = writes.length;
    const both = Promise.all([ensure(issue("codearts"), "preflight"), ensure(issue("codearts"), "preflight")]);
    await new Promise(resolve => setImmediate(resolve));
    releaseCodearts();
    assert.deepEqual((await both).map(value => value.signing.access_key_id), ["concurrent-ak", "concurrent-ak"]);
    assert.equal(oauthCalls, 1);
    assert.equal(writes.length, beforeConcurrent + 1, "shared refresh result must not be mistaken for a replacement login");

    let releaseReplaced;
    codeartsOAuth.refreshCredential = async existing => { await new Promise(resolve => { releaseReplaced = resolve; }); return { ...existing, access_key_id: "stale-codearts", refresh_token: "stale-codearts-rt" }; };
    const replacedCodearts = assert.rejects(ensure(issue("codearts")), error => error.code === "CREDENTIALS_UNAVAILABLE");
    await new Promise(resolve => setImmediate(resolve));
    const replacementFields = codeartsCredentials.toStoreFields({ ...credential, access_key_id: "replacement-ak", refresh_token: "replacement-codearts-rt" });
    Object.assign(secrets.get("codearts"), replacementFields);
    const beforeReplacement = writes.length;
    releaseReplaced();
    await replacedCodearts;
    assert.equal(writes.length, beforeReplacement);
    assert.equal(JSON.parse(secrets.get("codearts").token).accessKeyId, "replacement-ak");

    // A delayed read cannot return a token captured before a replacement login.
    let releaseRead;
    const realRead = auto.readForwardCredentials;
    auto.readForwardCredentials = async (...args) => {
      const value = realRead(...args);
      await new Promise(resolve => { releaseRead = resolve; });
      return value;
    };
    const staleRead = assert.rejects(read(issue("autoclaw")), error => error.code === "CREDENTIALS_CHANGED");
    await new Promise(resolve => setImmediate(resolve));
    secrets.get("autoclaw").token = "another-login";
    releaseRead();
    await staleRead;
    auto.readForwardCredentials = realRead;

    // Revocation does not undo a shared management refresh's successful cache update.
    let releaseRefresh;
    autoclawRefresh.refreshToken = async () => {
      await new Promise(resolve => { releaseRefresh = resolve; });
      return { ok: true, token: "after-revoke", refreshToken: "after-revoke-rt", noPersist: true };
    };
    const pendingGrant = issue("autoclaw");
    const revoked = assert.rejects(ensure(pendingGrant), error => error.code === "GRANT_DENIED");
    await new Promise(resolve => setImmediate(resolve));
    allowed = false;
    broker.revoke(pendingGrant.grantId);
    releaseRefresh();
    await revoked;
    allowed = true;
    assert.deepEqual(await read(issue("autoclaw")), { token: "after-revoke" });

    // The caller owns ordinary refresh persistence even when the grant expires.
    let releaseOrdinary;
    refreshHook = async () => { await new Promise(resolve => { releaseOrdinary = resolve; }); return { ok: true, token: "renewed", refreshToken: "renewed-rt" }; };
    const expires = issue("loomy", "invoke", 30);
    const expired = assert.rejects(ensure(expires), error => ["GRANT_DENIED", "GRANT_EXPIRED"].includes(error.code));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 45));
    releaseOrdinary();
    await expired;
    assert.equal(secrets.get("loomy").token, "renewed", "grant expiry must not discard a successful rotating management refresh");

    // Replacement login/deletion during a refresh must not be overwritten/recreated.
    for (const action of ["replace", "delete"]) {
      add("loomy", { token: "base", refreshToken: "base-rt" });
      let release;
      refreshHook = async () => { await new Promise(resolve => { release = resolve; }); return { ok: true, token: "stale-result", refreshToken: "stale-rt" }; };
      const pending = assert.rejects(ensure(issue("loomy")), error => ["CREDENTIALS_CHANGED", "GRANT_DENIED"].includes(error.code));
      await new Promise(resolve => setImmediate(resolve));
      const before = writes.length;
      if (action === "replace") secrets.get("loomy").token = "new-login";
      else accounts.delete("loomy");
      release();
      await pending;
      assert.equal(writes.length, before);
      if (action === "replace") assert.equal(secrets.get("loomy").token, "new-login");
      else assert.equal(accounts.has("loomy"), false);
    }
    const calls = lockedCalls;
    await assert.rejects(ensure(issue("zcode", "catalog")), error => error.code === "GRANT_DENIED");
    assert.equal(lockedCalls, calls);
    add("loomy", { token: "metadata-session" });
    adapters.get("loomy").modelEntries = () => [{ id: "Actual-ID", name: "Display", rate: 0,
      contextLength: 200000, maxOutputTokens: 8192, capabilities: { images: false, tools: true, private: "secret" },
      privateCredential: "secret" }];
    const descriptors = (await broker.context(identity, issue("loomy", "catalog").grantId)).models;
    assert.deepEqual(descriptors, [{ id: "Actual-ID", name: "Display", rate: 0, contextLength: 200000,
      maxOutputTokens: 8192, capabilities: { images: false, tools: true } }]);
    assert.doesNotMatch(JSON.stringify(descriptors), /private|secret/);
    console.log("PASS original management credential access: noPersist/relogin, paired CatPaw identity, CodeArts OAuth redaction/window/persistence, ZCode model key, grant races and no balance/checkin/switch side effects");
  } finally {
    broker.close();
    autoclawRefresh.refreshToken = originalAutoRefresh;
    codeartsCredentials.ensureFresh = originalCodeartsEnsure;
    codeartsOAuth.refreshCredential = originalCodeartsOAuthRefresh;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
