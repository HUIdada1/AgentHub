"use strict";
// Compare retained management contracts to their original mixed implementation,
// then load/execute the new registry while actively forbidding forwarding imports.
// Uses only temporary data and mocked management HTTP; no production accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const proxy = path.join(root, "electron/backend/proxy");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-management-isolation-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
const forwarding = new Set(["chat", "chatOnce", "chatOpenai", "chatSession", "rewriteBody", "mapModel", "stateful", "classifyError", "functionForModel"]);
const printer = ts.createPrinter({ removeComments: true });
let compared = 0;
function parse(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(proxy, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0, `${file} syntax`);
  return source;
}
function objectOf(source, name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && ts.isObjectLiteralExpression(node.initializer)) found = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const returned = node.body.statements.find(item => ts.isReturnStatement(item) && item.expression && ts.isObjectLiteralExpression(item.expression));
      if (returned) found = returned.expression;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `object ${name} in ${source.fileName}`);
  return found;
}
function compareObject(beforeFile, afterFile, name, exceptions = [], reviewedAccessors = []) {
  const before = parse(beforeFile), after = parse(afterFile);
  const members = source => new Map(objectOf(source, name).properties.map(property => [property.name.getText(source), property]));
  const old = members(before), current = members(after);
  assert.deepEqual([...current.keys()].sort(), [...old.keys()].filter(key => !forwarding.has(key)).concat(reviewedAccessors).sort(), `${name} management surface`);
  for (const [key, property] of current) {
    if (reviewedAccessors.includes(key)) continue; // Separate read-only bridge checks, never an exclusion for original methods.
    if (exceptions.includes(key)) continue;
    assert.equal(printer.printNode(ts.EmitHint.Unspecified, property, after), printer.printNode(ts.EmitHint.Unspecified, old.get(key), before), `${name}.${key} preserved`);
    compared++;
  }
}

for (const [directory, factory] of [["autoclaw", "makeAutoClaw"], ["cline", "makeCline"], ["loomy", "makeLoomy"], ["kuku", "makeKuku"]]) {
  // These providers have already moved their private model execution to the
  // external plugin. Their management factory is intentionally no longer
  // compared against a deleted mixed adapter; the runtime checks below still
  // require the management surface and forbid forwarding methods/imports.
  if (["autoclaw", "cline", "loomy"].includes(directory)) continue;
  compareObject(`${directory}/adapter.cjs`, `${directory}/management.cjs`, factory, [], ["autoclaw", "catpaw"].includes(directory) ? ["readForwardModels"] : ["monkeycode"].includes(directory) ? ["readForwardModels", "readForwardContext", "readForwardCredentials"] : ["accio"].includes(directory) ? ["readForwardModels"] : directory === "codearts" ? ["readForwardModels", "readForwardContext"] : directory === "kuku" ? ["readForwardCredentials"] : []);
}
// CodeArts has no retained mixed adapter after execution moved to the plugin.
// Its management surface is validated by production assembly and forward-access
// tests; attempting to compare against a deleted execution file would test the
// migration artifact rather than the management contract.
// makeQoder is now **site-aware** (qoder / qoder_intl / qwen_office / qwen_office_intl,
// see qoder/sites.cjs). The methods that take a site branch intentionally differ from the
// pre-refactor mixed adapter, so they are listed as exceptions and re-checked by the
// explicit site-matrix assertions below instead of by textual equality.
const QODER_SITE_AWARE = ["cfg", "models", "fetchModels", "queryCredits", "checkin", "checkinStatus", "refreshToken"];
compareObject("qoderAdapter.cjs", "qoderManagement.cjs", "makeQoder", QODER_SITE_AWARE, ["readForwardContext"]);
// ModelScope's old mixed object held both the management surface and the
// gateway executor. The executor moved to the plugin; management now lives
// behind makeModelScope(channel) (dual-site, modelscope/modelscope_intl).
// LobsterAI still has a plain object literal, so it stays on the strict compare.
compareObject("adapters.cjs", "management-adapters.cjs", "lobster");
const modelscopeManagement = objectOf(parse("management-adapters.cjs"), "makeModelScope");
const modelscopeMethods = new Set(modelscopeManagement.properties.map(property => property.name.getText()));
for (const method of ["cfg", "models", "fetchModels", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken", "chatHeaders", "apiHeaders"])
  assert.ok(modelscopeMethods.has(method), `modelscope management method ${method} retained`);
for (const method of forwarding) assert.ok(!modelscopeMethods.has(method), `modelscope management method ${method} is not forwarding`);
// ZCode's old mixed object contained the gateway executor and management
// operations together. The executor is deleted from this module; the management
// surface now lives behind makeZcode(channel) (dual-region, zcode/zcode_intl).
const zcodeManagement = objectOf(parse("management-adapters.cjs"), "makeZcode");
const zcodeMethods = new Set(zcodeManagement.properties.map(property => property.name.getText()));
for (const method of ["readForwardContext", "cfg", "models", "fetchModels", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken", "userInfo", "solveCaptcha"])
  assert.ok(zcodeMethods.has(method), `zcode management method ${method} retained`);
for (const method of forwarding) assert.ok(!zcodeMethods.has(method), `zcode management method ${method} is not forwarding`);
for (const name of ["modelscope", "lobster"]) {
  const mixed = objectOf(parse("adapters.cjs"), name);
  const methods = new Set(mixed.properties.map(property => property.name.getText()));
  for (const method of forwarding) assert.ok(!methods.has(method), `${name} host adapter must not expose ${method}`);
}
for (const [name, required] of [["trae", ["fetchModels", "queryCredits", "checkinStatus", "checkin"]], ["raccoon", ["fetchModels", "queryCredits", "checkinStatus", "checkin", "claimOnboarding", "readForwardContext"]]]) {
  const managed = objectOf(parse("management-adapters.cjs"), name);
  const methods = new Set(managed.properties.map(property => property.name.getText()));
  for (const method of required) assert.ok(methods.has(method), `${name} management method ${method} retained`);
  for (const method of forwarding) assert.ok(!methods.has(method), `${name} management method ${method} is not forwarding`);
  const source = fs.readFileSync(path.join(proxy, "adapters.cjs"), "utf8");
  assert.doesNotMatch(source, new RegExp(`const ${name}\\s*=\\s*\\{`), `${name} private adapter removed`);
}
// WorkBuddy's forwarding factory has moved to AgentHub_skill; only its
// management factory remains in the host registry.

// Method equality alone can miss changed helpers (refresh locks, device IDs,
// caches or model-name lookup). Preserve every retained top-level function too.
const originalRegistry = parse("adapters.cjs"), managementRegistry = parse("management-adapters.cjs");
const originalFunctions = new Map(originalRegistry.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]));
let comparedHelpers = 0;
for (const node of managementRegistry.statements.filter(ts.isFunctionDeclaration)) {
  if (node.name.text === "makeWorkBuddy") continue; // Management methods and the fixed probe are checked separately.
  if (node.name.text === "readDeviceTokenFile") continue; // Device fallback is no longer part of forwarding code.
  if (node.name.text === "makeZcode") continue; // Dual-region management factory (zcode/zcode_intl); methods verified above via makeZcode surface.
  if (node.name.text === "makeModelScope") continue; // Dual-site management factory (modelscope/modelscope_intl); methods verified above via makeModelScope surface.
  if (["zcodeDeviceMid", "resolveAccountDeviceMid", "zcodeCtlHeaders", "zcodeBillingHeaders",
    "setPendingCaptcha", "getPendingCaptcha"].includes(node.name.text)) continue; // ZCode account management, device identity and verification flow remain in the host.
  assert.ok(originalFunctions.has(node.name.text), `unreviewed management helper ${node.name.text}`);
  assert.equal(printer.printNode(ts.EmitHint.Unspecified, node, managementRegistry),
    printer.printNode(ts.EmitHint.Unspecified, originalFunctions.get(node.name.text), originalRegistry), `${node.name.text} helper preserved`);
  comparedHelpers++;
}
const variables = source => new Map(source.statements.filter(ts.isVariableStatement).flatMap(statement =>
  statement.declarationList.declarations.map(node => [node.name.getText(source), node])));
const originalVariables = variables(originalRegistry);
const reviewedDeclarations = new Set(["trae", "raccoon", "modelscope", "lobster", "zcode", "qoder", "ADAPTERS", "REQUIRED_ADAPTER_METHODS",
  "{ makeCatPaw }", "qoderAuth", "qoderSigner", "{ makeQoder }", "{ makeAutoClaw }", "{ makeCline }", "{ makeLoomy }",
  "{ makeAccio }", "{ makeCodeArts }", "{ makeKuku }", "{ makeMonkeyCode }", "{ createSwitchProbe }",
  "autoclawDeps", "clineDeps", "loomyDeps", "kukuDeps", "monkeycodeDeps", "accioDeps", "codeartsDeps", "qoderDeps"]);
reviewedDeclarations.add("zcode_intl"); // Dual-region instance (zcode_intl) mounted alongside zcode; same makeZcode factory surface.
reviewedDeclarations.add("modelscope_intl"); // Dual-site instance (modelscope_intl) mounted alongside modelscope; same makeModelScope factory surface.
reviewedDeclarations.add("makeModelScope"); // Dual-site management factory; surface asserted above.
reviewedDeclarations.add("{ makeCommandCode }"); // Stateless NDJSON channel (paste-only API key); surface asserted in the runtime checks below.
reviewedDeclarations.add("commandcodeDeps");
reviewedDeclarations.add("{ makeOfficeAce }"); // OpenAI-compatible two-layer credential channel; surface asserted below.
reviewedDeclarations.add("officeaceDeps");
reviewedDeclarations.add("{ makeAtomCode }"); // AtomGit channel (polling OAuth + call-count quota); surface asserted below.
reviewedDeclarations.add("atomcodeDeps");
for (const name of ["{ makeOrcaTerm }", "{ makeAStudio }", "{ makeDoubaoWork }"]) reviewedDeclarations.add(name);
reviewedDeclarations.add("SESSION_CHANNELS_ENABLED");
for (const name of ["{ makeKiro }", "{ makeAntigravity }"]) reviewedDeclarations.add(name);
reviewedDeclarations.add("BINARY_PROTOCOL_ENABLED"); // Dependency bag for the Command Code management factory (same shape as the other *Deps entries).
reviewedDeclarations.add("deviceTokenCache");
reviewedDeclarations.add("zcodeLocal"); // Device identity, credentials and account-management helpers remain in the host.
reviewedDeclarations.add("zcodeRegion"); // Dual-region site table (zcode/zcode_intl) is host-side account-identity source.
reviewedDeclarations.add("pendingCaptchaTokens"); // One-shot human-verification state belongs to account management.
reviewedDeclarations.add("workbuddy");
reviewedDeclarations.add("workbuddy_ai");
let comparedState = 0;
for (const [name, node] of variables(managementRegistry)) {
  if (reviewedDeclarations.has(name)) continue;
  assert.ok(originalVariables.has(name), `unreviewed management state ${name}`);
  assert.equal(printer.printNode(ts.EmitHint.Unspecified, node, managementRegistry),
    printer.printNode(ts.EmitHint.Unspecified, originalVariables.get(name), originalRegistry), `${name} state initialization preserved`);
  comparedState++;
}

const originalLoad = Module._load;
const loaded = new Set();
Module._load = function (request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (typeof filename === "string" && filename.startsWith(proxy + path.sep)) {
    const relative = path.relative(proxy, filename).replace(/\\/g, "/");
    assert.ok(!/^(adapters|qoderAdapter|qoderSigner|zcodeAnthropic|zcode-official-system)\.cjs$/.test(relative), `management loaded mixed/forwarding module: ${relative}`);
    assert.ok(!/^[^/]+\/adapter\.cjs$/.test(relative), `management loaded mixed adapter: ${relative}`);
    assert.ok(!/^(catpaw\/(openai|upstreamHttp|conversation|turnExecutor|turn|images|messages|tools|fingerprint)|monkeycode\/(chat|stream|protocol|probe)|autoclaw\/prompt|accio\/(protocol|stream|chat)|codearts\/(session|stream_fault)|kuku\/(chat|stream))\.cjs$/.test(relative), `management loaded forwarding dependency: ${relative}`);
    loaded.add(relative);
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    const management = require("../electron/backend/proxy/management-adapters.cjs");
    assert.deepEqual(management.consistencyReport(), { channelsWithoutAdapter: [], adaptersWithoutChannel: [] });
    assert.deepEqual(management.REQUIRED_ADAPTER_METHODS, ["cfg", "models", "queryCredits"]);
    for (const [channel, adapter] of Object.entries(management.ADAPTERS)) {
      management.assertAdapterContract(channel, adapter);
      for (const key of forwarding) assert.equal(key in adapter, false, `${channel} must not expose ${key}`);
      assert.ok(Array.isArray(adapter.models()), `${channel} management catalog`);
    }
    assert.equal(typeof management.get("workbuddy").probeChat, "function");
    assert.equal(typeof management.get("workbuddy_ai").probeChat, "function");
    for (const channel of ["monkeycode", "monkeycode_intl"]) {
      assert.equal((await management.get(channel).queryCredits()).unavailable, true);
      assert.equal((await management.get(channel).refreshToken()).noRefresh, true);
    }

    // Preserve the noPersist cache across refresh, subsequent balance reads,
    // retry with the effective token, and a real replacement login token.
    const { makeAutoClaw } = require("../electron/backend/proxy/autoclaw/management.cjs");
    const balance = require("../electron/backend/proxy/autoclaw/balance.cjs");
    const refresh = require("../electron/backend/proxy/autoclaw/refresh.cjs");
    const oldBalance = balance.queryBalance, oldRefresh = refresh.refreshToken;
    const tokens = [];
    balance.queryBalance = async env => { tokens.push(env.token); return { credits: 17 }; };
    refresh.refreshToken = async () => ({ ok: true, token: "new", refreshToken: "new-rt", noPersist: true });
    try {
      const adapter = makeAutoClaw("autoclaw", {
        rules: { get: () => ({ autoclaw: {} }), rulesDir: () => temporary },
        deviceIds: () => ({ machineId: "stable-existing-machine" }),
      });
      const account = { id: "account", meta: {} };
      const old = { token: "old", refreshToken: "old-rt" };
      assert.equal((await adapter.refreshToken(account, old)).noPersist, true);
      await adapter.queryCredits(account, old);
      await adapter.queryCredits(account, { token: "new", refreshToken: "new-rt" });
      await adapter.queryCredits(account, { token: "replacement-login", refreshToken: "replacement-rt" });
      assert.deepEqual(tokens, ["new", "new", "replacement-login"]);
      assert.deepEqual(old, { token: "old", refreshToken: "old-rt" });
    } finally { balance.queryBalance = oldBalance; refresh.refreshToken = oldRefresh; }

    // ===== 控制面解析：Kiro 目录/额度、Antigravity 目录/额度（注入假 httpJson）=====
    const { makeKiro } = require("../electron/backend/proxy/kiro/management.cjs");
    const { makeAntigravity } = require("../electron/backend/proxy/antigravity/management.cjs");
    const kiroCalls = [];
    const kiroLive = makeKiro({
      rules: { get: () => ({ kiro: {} }) },
      httpJson: async (url) => {
        kiroCalls.push(url);
        if (url.includes("List-Available-Models")) return { ok: true, status: 200, data: { defaultModel: { modelId: "auto" }, models: [
          { modelId: "claude-sonnet-4.5", modelName: "Claude Sonnet 4.5", tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }, supportedInputTypes: ["TEXT", "IMAGE"] },
          { modelId: "auto", modelName: "Auto", tokenLimits: { maxInputTokens: 100000 } },
          { modelId: "claude-sonnet-4.5", modelName: "dup" },
        ] } };
        if (url.includes("Get-Usage-Limits")) return { ok: true, status: 200, data: { usageBreakdownList: [
          { freeTrialInfo: { freeTrialStatus: "ACTIVE", usageLimitWithPrecision: 500, currentUsageWithPrecision: 120, freeTrialExpiry: 1.9e12 } },
          { bonuses: [{ status: "ACTIVE", usageLimit: 100, currentUsage: 10, displayName: "Bonus", expiresAt: 1.9e12 }, { status: "EXPIRED", usageLimit: 999 }] },
        ] } };
        return { ok: false, status: 404, data: null };
      },
    });
    const kiroModels = await kiroLive.fetchModels({ meta: {} }, { token: "tk", meta: { profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/x" } });
    assert.equal(kiroModels.ok, true, "Kiro catalog parses without SigV4 (bearer + tokentype only)");
    assert.deepEqual(kiroModels.models.map((m) => m.id), ["auto", "claude-sonnet-4.5"], "default model first, duplicates removed");
    assert.equal(kiroModels.models[1].capabilities.images, true, "IMAGE in supportedInputTypes → images");
    assert.equal(kiroModels.models[1].contextLength, 200000);
    assert.ok(kiroCalls[0].includes("management.eu-central-1.kiro.dev"), "region comes from the profile ARN");
    assert.ok(kiroCalls[0].includes("profileArn="));
    const kiroCredits = await kiroLive.queryCredits({ meta: {} }, { token: "tk", meta: {} });
    assert.equal(kiroCredits.credits, 380 + 90, "free trial 380 + active bonus 90");
    assert.equal(kiroCredits.packages.length, 2, "expired bonuses are skipped");

    const antiCalls = [];
    const antiLive = makeAntigravity({
      rules: { get: () => ({ antigravity: {} }) },
      httpJson: async (url) => {
        antiCalls.push(url);
        if (url.includes("fetchAvailableModels")) return { ok: true, status: 200, data: {
          models: {
            "gemini-3-pro": { displayName: "Gemini 3 Pro", supportsThinking: true, maxTokens: 1000000, maxOutputTokens: 65536 },
            "gemini-2.5-pro": { displayName: "hidden generation" },
            "claude-sonnet-4.5": { displayName: "Claude Sonnet 4.5", supportsImages: true },
            "old-model": { displayName: "deprecated" },
          },
          deprecatedModelIds: { "old-model": { newModelId: "gemini-3-pro" } },
        } };
        if (url.includes("retrieveUserQuotaSummary")) return { ok: true, status: 200, data: { groups: [
          { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.72, resetTime: "2026-11-10T12:00:00Z" }] },
          { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.4 }] },
        ] } };
        return { ok: false, status: 404, data: null };
      },
    });
    const antiModels = await antiLive.fetchModels({ meta: {} }, { token: "g", meta: { project: "p1" } });
    assert.equal(antiModels.ok, true);
    assert.deepEqual(antiModels.models.map((m) => m.id).sort(), ["claude-sonnet-4.5", "gemini-3-pro"], "deprecated and gemini-2.x entries are filtered out");
    assert.equal(antiModels.models.find((m) => m.id === "gemini-3-pro").capabilities.reasoning, true);
    assert.ok(antiCalls[0].startsWith("https://sandbox-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"), "sandbox first");
    const antiCredits = await antiLive.queryCredits({ meta: {} }, { token: "g", meta: {} });
    assert.equal(antiCredits.packages.length, 2, "one row per bucket");
    assert.equal(antiCredits.credits, 40, "the tightest window (40%) is the headline figure");
    assert.match(antiCredits.packages[0].name, /Gemini Models · 5h/);

    // ===== Kiro / Antigravity：二进制帧与 Google 信封 =====
    const kr = management.get("kiro");
    assert.ok(kr, "kiro adapter mounted");
    assert.equal(kr.models().length, 8, "Kiro falls back to the built-in static list before any refresh");
    assert.equal((await kr.fetchModels({ meta: {} }, { token: "" })).ok, false, "no token → refuses instead of hitting the network");
    assert.equal((await kr.checkinStatus()).unavailable, true, "Kiro has no check-in");
    assert.equal(kr.regionOfProfile("arn:aws:codewhisperer:eu-central-1:1:profile/x"), "eu-central-1");
    assert.equal(kr.readForwardCredentials({}, { token: "t", meta: { profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/x" } }).region, "eu-central-1");
    const ag = management.get("antigravity");
    assert.ok(ag, "antigravity adapter mounted");
    assert.equal(ag.models().length, 5, "Antigravity falls back to the built-in static list before any refresh");
    assert.equal((await ag.queryCredits({ meta: {} }, { token: "" })).authError, true, "no token → auth error, not a fabricated reading");
    assert.equal(ag.sanitizeUserAgent("antigravity/2.0.0"), "antigravity/4.3.0", "UA version floor is enforced");
    assert.equal(ag.readForwardCredentials({}, { token: "t", meta: { project: "p", enterprise: true } }).enterprise, true);

    // ===== 会话式三渠道：各自的「不适用」要如实回报 =====
    const ot = management.get("orcaterm");
    assert.ok(ot, "orcaterm adapter mounted");
    assert.equal(ot.models().length, 9, "OrcaTerm model list is the built-in 9 (upstream has no catalog API)");
    assert.equal((await ot.fetchModels()).ok, false, "no catalog endpoint → honest refusal");
    assert.equal((await ot.checkinStatus()).unavailable, true, "OrcaTerm has no check-in");
    assert.equal(ot.readForwardCredentials({}, { token: "t", meta: { uin: "7" } }).uin, "7", "uin is projected to the plugin");
    const as = management.get("astudio");
    assert.ok(as, "astudio adapter mounted");
    assert.equal((await as.queryCredits({ meta: {} }, { token: "t", meta: {} })).unavailable, true, "no web session → balance unavailable");
    assert.equal((await as.refreshToken()).noRefresh, true, "AStudio has no refresh API");
    const db = management.get("doubaowork");
    assert.ok(db, "doubaowork adapter mounted");
    assert.equal((await db.queryCredits()).unavailable, true, "doubao balance is not wired in this version (honest)");
    assert.equal((await db.refreshToken()).noRefresh, true, "cookie session has no refresh");
    assert.match(db.uidOfCookie("sessionid=abc; other=1"), /^db_[0-9a-f]{16}$/, "cookie-derived uid is a hash, never the raw cookie");

    // ===== AtomCode：额度是「每窗口调用次数」；签到是领取免费 CodingPlan =====
    const ac = management.get("atomcode");
    assert.ok(ac, "atomcode adapter mounted");
    assert.deepEqual(ac.models(), [], "no built-in fallback catalog (nominal list ≠ reachable list)");
    assert.equal((await ac.checkin({ meta: {} }, { token: "" })).ok, false, "checkin needs a token");
    assert.equal((await ac.refreshToken({ meta: {} }, {})).terminal, true, "no refresh token → terminal relogin");
    const { planTierFromName, classifyTierResponse } = require("../electron/backend/proxy/atomcode/management.cjs");
    assert.equal(planTierFromName("CodingPlan Max-体验版"), "Max");
    assert.equal(planTierFromName("CodingPlan Lite-体验版"), "Lite");
    assert.equal(classifyTierResponse({ duplicate: true, success: false }).kind, "already", "duplicate is success semantics");
    assert.equal(classifyTierResponse({ success: true }).kind, "granted");
    assert.equal(classifyTierResponse({ success: false }).kind, "refused");

    // ===== OfficeAce：OpenAI 兼容 + 两层凭据 =====
    const oa = management.get("officeace");
    assert.ok(oa, "officeace adapter mounted");
    assert.equal(typeof oa.readForwardCredentials, "function", "officeace projects baseUrl to the plugin");
    assert.equal((await oa.queryCredits({ meta: {} }, { token: "t", meta: {} })).unavailable, true, "no control-plane creds → honestly unavailable");
    assert.equal((await oa.refreshToken()).noRefresh, true, "gateway Basic never expires");
    assert.equal((await oa.fetchModels({ meta: {} }, { token: "t", meta: {} })).ok, false, "no baseUrl → refuses instead of hitting an empty URL");

    // ===== Command Code：无状态、粘贴式 key、三样能力如实 unavailable =====
    const cc = management.get("commandcode");
    assert.ok(cc, "commandcode adapter mounted");
    assert.equal(cc.models().length, 26, "commandcode built-in fallback catalog is 26 entries");
    assert.equal((await cc.queryCredits()).unavailable, true, "no balance API");
    assert.equal((await cc.checkinStatus()).unavailable, true, "no check-in");
    assert.equal((await cc.refreshToken()).noRefresh, true, "static key has no refresh");
    assert.equal((await cc.verifyKey("nope")).ok, false, "shape check rejects keys without the user_ prefix");

    // ===== 千问办公：国内版启用；国际版暂时隐藏（QWEN_OFFICE_INTL_ENABLED=false）=====
    const qoderSites = require("../electron/backend/proxy/qoder/sites.cjs");
    assert.equal(management.get("qwen_office_intl"), undefined, "qwen_office_intl stays hidden while QWEN_OFFICE_INTL_ENABLED=false");
    for (const channel of ["qwen_office"]) {
      const adapter = management.get(channel);
      assert.ok(adapter, `${channel} adapter mounted`);
      const cfg = adapter.cfg();
      assert.equal(cfg.openApi, qoderSites.SITES[channel].openApi, `${channel} openApi from site table`);
      assert.ok(cfg.openApi.includes("qwenwork.cn"), `${channel} must not borrow the other site host`);
      // 千问办公没有每日领取活动 → 如实 unavailable（不伪造「已领取」）
      assert.equal((await adapter.checkinStatus()).unavailable, true, `${channel} has no daily campaign`);
      assert.equal((await adapter.checkin({ meta: {} }, { token: "t" })).unavailable, true, `${channel} checkin is unavailable`);
      // 目录兜底：站点表的静态三条（对外名 = 客户端展示名，上游 key 在 upstreamKey）
      assert.deepEqual(adapter.models(), ["高级", "标准", "Qwen3.8-Max"], `${channel} static fallback models`);
      assert.equal((await adapter.fetchModels({ uid: "u" }, { token: "t" })).ok, false, `${channel} remote catalog fails honestly with a fake token`);
      // 续期缺 refreshToken → 明确失败，不静默成功
      assert.equal((await adapter.refreshToken({ meta: {} }, {})).ok, false, `${channel} refresh needs a refresh token`);
    }
    // 站点表本身：四站域名互不相同、Qoder 两站不受影响
    assert.equal(qoderSites.SITES.qoder.openApi, "https://openapi.qoder.com.cn");
    assert.equal(qoderSites.SITES.qoder_intl.openApi, "https://openapi.qoder.sh");
    assert.equal(qoderSites.inferenceBase("qoder_intl", "jt-abc"), "https://api2.qoder.sh/", "job tokens must use api2");
    assert.equal(qoderSites.inferenceBase("qoder_intl", "dt-abc"), "https://api3.qoder.sh/", "device tokens use api3");
    assert.equal(qoderSites.SITES.qwen_office.deviceRedirect, "qwenwork-cn://");
    assert.equal(qoderSites.SITES.qwen_office_intl.deviceRedirect, "qwenwork://");

    const signer = require("../electron/backend/proxy/qoderManagementSigner.cjs");
    assert.equal(typeof signer.createSession, "function");
    const source = fs.readFileSync(path.join(proxy, "qoderManagementSigner.cjs"), "utf8");
    assert.ok(!source.includes("prepareInferRequest"), "management signer has no inference request wrapper");
    console.log(`PASS ${compared} original management properties, ${comparedHelpers} helpers and ${comparedState} state declarations preserved; ${Object.keys(management.ADAPTERS).length} channels load without mixed/forwarding adapters (${loaded.size} management/shared modules); noPersist refresh cache retained`);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
