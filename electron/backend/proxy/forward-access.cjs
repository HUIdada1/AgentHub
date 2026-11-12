"use strict";
// Management-owned access to the existing singleton. No model HTTP, request
// construction, second account store, refresh scheduler, or adapter instantiation.
const SIGNING = ["access_key_id", "secret_access_key", "security_token", "domain_id", "user_id", "user_name", "expires_at", "login_type"];
const CONTEXT = ["accountId", "uid", "models", "maxConcurrent", "identity.deviceId", "identity.deviceMid", "identity.machineId", "identity.imageId", "identity.osVersion", "identity.platform", "identity.clientChannel", "identity.officeIdentity", "identity.provider"];
// WorkBuddy 的官方客户端只在账号带企业身份时才发 X-Enterprise-Id / X-Tenant-Id / X-Domain；
// 这三项不是凭据，但属于账号身份，按渠道单独放行，不能污染其它渠道的通用投影。
const WORKBUDDY_CONTEXT = ["enterpriseId", "domain"];
const PUBLIC_MODEL_FIELDS = ["name", "rate", "capabilities", "contextLength", "maxOutputTokens"];
// Fail closed until a channel's credential/identity consumers have been audited.
// These are access policies, not provider implementations or model routing rules.
const POLICIES = Object.freeze(Object.fromEntries([
  ["loomy", ["token"]],
  ["catpaw", ["token", "uid"]],
  ["autoclaw", ["token"]],
  ["autoclaw_intl", ["token"]],
  // WorkBuddy 国内版 / 国际版：对话只需 Bearer token；uid / enterpriseId / domain 走 context 投影，
  // 会话/链路头由插件按官方客户端 buildVlmGatewayHeaders 现场生成。
  ["workbuddy", ["token"]],
  ["workbuddy_ai", ["token"]],
  ["codearts", SIGNING.map(key => `signing.${key}`)],
  ["zcode", ["token", "modelApiKey"]],
  ["zcode_intl", ["token", "modelApiKey"]],
  ["qoder", ["token"]],
  ["qoder_intl", ["token"]],
  // 千问办公双站与 Qoder 同一套凭据形态（设备令牌 dt-/drt-，无额外凭据字段）
  ["qwen_office", ["token"]],
  ["qwen_office_intl", ["token"]],
  ["cline_free", ["token"]],
  ["cline_pass", ["token"]],
  // Kuku's Cookie parser remains in the core management adapter. The plugin
  // receives only the parsed, request-scoped fields it needs for model calls.
  ["kuku", ["bduss", "stoken", "extras", "ptoken"]],
  // MonkeyCode execution needs the previously discovered task-container image
  // id. It is a read-only account meta projection; discovery/persistence stays
  // in the host management singleton until the external provider is ready.
  ["monkeycode", ["session"]],
  ["monkeycode_intl", ["session"]],
  ["accio", ["token"]],
  ["accio_cn", ["token"]],
  ["commandcode", ["token"]],
  // OfficeAce：转发只需要网关 Basic 那一对（`token` 落的是 base64(key:secret)，
  // 由适配器在导入时拼好；控制面 AK/SK 不投影给插件）
  ["officeace", ["token", "baseUrl"]],
  // AtomCode：OAuth bearer 即可（网关免签名；UA 由插件按规则发）
  ["atomcode", ["token"]],
  // OrcaTerm：token + uin（建会话与对话都要 user.id）
  ["orcaterm", ["token", "uin"]],
  // AStudio：模型 bearer
  ["astudio", ["token"]],
  // 豆包工作：Cookie + 设备标识（缺 device_id 必被风控拦）
  ["doubaowork", ["token", "deviceId", "clientVersion", "webId", "chromiumVersion", "channel"]],
  // Kiro：token + profileArn + region（推理端点按 region 选）
  ["kiro", ["token", "profileArn", "region"]],
  // Antigravity：token + project（cloudaicompanionProject）+ 账号形态
  ["antigravity", ["token", "project", "enterprise"]],
  ["modelscope", ["token"]],
  ["modelscope_intl", ["token"]],
  // MiniMax Code 双区：签名（x-timestamp / x-signature）必须由**真正发请求的那一层**算——
  // 它依赖 body 原文，宿主代算必然与最终发出的字符串分叉。故这里只投影 bearer。
  // device_id 属请求指纹而非凭据，由插件按账号 uid 派生（见 minimax/sign.cjs 的 deviceIdOf）。
  ["minimax", ["token"]],
  ["minimax_intl", ["token"]],
  ["lobster", ["token"]],
  ["trae", ["token"]],
  ["raccoon", ["token"]],
].map(([channel, fields]) => [channel, Object.freeze({ credentials: Object.freeze(fields),
    context: Object.freeze(["workbuddy", "workbuddy_ai"].includes(channel) ? [...CONTEXT, ...WORKBUDDY_CONTEXT] : [...CONTEXT]),
    modelFields: Object.freeze(["autoclaw", "autoclaw_intl"].includes(channel) ? ["id", "name", "routeId"] : channel === "catpaw" ? ["id", "name", "modelType"] : ["monkeycode", "monkeycode_intl"].includes(channel) ? ["id", "name", "model", "upstreamId", "interfaceType", "cliName"] : ["accio", "accio_cn"].includes(channel) ? ["id", "name", "upstreamKey", "protocolKind", "reasoningEfforts"] : channel === "codearts" ? ["id", "name", "source", "images"] : ["id"]) })])));

function denied(code = "CREDENTIALS_UNAVAILABLE") {
  return Object.assign(new Error("Scoped account credentials unavailable"), { code });
}
function pick(source, fields) {
  const result = {};
  for (const key of fields) {
    const value = source?.[key];
    if (value !== undefined) {
      if (!["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw denied();
      if (typeof value === "string" && Buffer.byteLength(value) > 1024 * 1024) throw denied();
      result[key] = value;
    }
  }
  return result;
}

function createForwardAccess({ store, management, ensureFreshSecrets }) {
  if (!store || typeof store.getAccount !== "function" || typeof store.accountSecrets !== "function" || typeof store.updateAccount !== "function"
    || !management || typeof management.get !== "function" || typeof management.refreshTokenLocked !== "function" || typeof ensureFreshSecrets !== "function") {
    throw new TypeError("Forward access requires the existing management singleton and pure refresh service");
  }
  function current(account, scope) {
    if (!account || !Object.hasOwn(POLICIES, account.channel)) throw denied("GRANT_POLICY");
    const live = store.getAccount(account.id);
    if (!live || live.channel !== account.channel || live.status === "disabled" || scope && (scope.accountId !== live.id || scope.channel !== live.channel || Date.now() >= scope.expiresAt)) throw denied("GRANT_DENIED");
    return live;
  }
  function raw(account, scope) {
    const live = current(account, scope);
    const adapter = management.get(live.channel);
    if (!adapter) throw denied();
    const secrets = store.accountSecrets(live);
    // getAccount returns the DB row (meta is JSON); original adapters receive a
    // parsed account view. Use the existing decrypt/parser, never parse credentials twice.
    return { account: { ...live, meta: secrets.meta || {} }, adapter, secrets };
  }
  function credentialStamp(account) {
    const live = store.getAccount(account.id);
    if (!live || live.channel !== account.channel) throw denied("GRANT_DENIED");
    const value = store.accountSecrets(live);
    // Compared only in memory: never logged or returned to the plugin.
    return JSON.stringify([value?.token, value?.refreshToken, live.uid, value?.meta]);
  }
  function assertUnchanged(account, stamp, scope) {
    const live = current(account, scope);
    if (credentialStamp(live) !== stamp) throw denied("CREDENTIALS_CHANGED");
    return live;
  }
  function refreshTarget(account, stamp) {
    const live = store.getAccount(account.id);
    if (!live || live.channel !== account.channel) throw denied("GRANT_DENIED");
    if (credentialStamp(live) !== stamp) throw denied("CREDENTIALS_CHANGED");
    return live;
  }
  async function effective(account, secrets, adapter) {
    return typeof adapter.readForwardCredentials === "function" ? adapter.readForwardCredentials(account, secrets) : secrets;
  }
  function project(channel, value) {
    if (channel === "codearts") return { signing: pick(value?.signing, SIGNING) };
    if (channel === "raccoon") return pick(value, ["token"]);
    if (channel === "zcode" || channel === "zcode_intl") return pick({ token: value?.token, modelApiKey: value?.refreshToken }, ["token", "modelApiKey"]);
    if (channel === "kuku") {
      const bduss = String(value?.bduss || "");
      const stoken = String(value?.stoken || "");
      const ptoken = String(value?.ptoken || "");
      const extras = value?.extras;
      if (Buffer.byteLength(bduss) > 1024 * 1024 || Buffer.byteLength(stoken) > 1024 * 1024
        || Buffer.byteLength(ptoken) > 1024 * 1024 || !Array.isArray(extras) || extras.length > 4096) throw denied();
      const copied = extras.map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2) throw denied();
        const [name, item] = pair;
        if (typeof name !== "string" || typeof item !== "string"
          || /[\x00-\x1f\x7f;]/.test(name) || /[\x00-\x1f\x7f;]/.test(item)
          || Buffer.byteLength(name) > 4096 || Buffer.byteLength(item) > 1024 * 1024) throw denied();
        return [name, item];
      });
      const result = { bduss, stoken, ptoken, extras: copied };
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw denied();
      return result;
    }
    return pick(value, POLICIES[channel].credentials);
  }
  async function readCredentials(account, scope) {
    const state = raw(account, scope);
    const stamp = credentialStamp(state.account);
    const value = await effective(state.account, state.secrets, state.adapter);
    assertUnchanged(state.account, stamp, scope);
    return project(state.account.channel, value);
  }
  async function ensureCredentials(account, _projected, reason, scope) {
    if (scope?.purpose !== "invoke" || !["preflight", "upstream-auth-expired"].includes(reason)) throw denied("GRANT_DENIED");
    const state = raw(account, scope);
    const { adapter, secrets } = state;
    const stamp = credentialStamp(state.account);
    let next;
    if (typeof adapter.ensureForwardCredentials === "function") {
      // CodeArts reuses its original ensureFresh single-flight and whole-bundle
      // persistence, with a bridge-only replacement-login check before writing.
      next = await adapter.ensureForwardCredentials(state.account, secrets, reason === "upstream-auth-expired");
    } else if (reason === "preflight") {
      next = await ensureFreshSecrets(state.account, secrets);
    } else {
      const result = await management.refreshTokenLocked(state.account.channel, state.account, secrets);
      // Do not write refresh output over a replacement login or resurrect a deleted account.
      // A shared refresh owns its persistence even if this grant expires while awaiting it.
      refreshTarget(state.account, stamp);
      if (!result?.ok) throw denied();
      if (!result.noPersist) store.updateAccount(state.account.id, { token: result.token, refreshToken: result.refreshToken });
      next = { ...secrets, token: result.token, refreshToken: result.refreshToken };
    }
    if (!next) throw denied();
    const live = current(state.account, scope);
    const returnedStamp = JSON.stringify([next.token, next.refreshToken, state.account.uid, next.meta]);
    const liveStamp = credentialStamp(live);
    if (liveStamp !== stamp && liveStamp !== returnedStamp) throw denied("CREDENTIALS_CHANGED");
    // Original preflight may persist by design; do not roll it back on cancellation.
    // Read the returned effective value, not the old DB token in noPersist channels.
    const value = await effective({ ...live, meta: next.meta || {} }, next, adapter);
    current(live, scope);
    return project(live.channel, value);
  }
  /** WorkBuddy 官方客户端的企业身份头只取账号元数据里的这两个字段；
   *  缺失时不发，绝不合成空值或占位头。 */
  function accountIdentity(channel, account) {
    if (!["workbuddy", "workbuddy_ai"].includes(channel)) return {};
    const meta = account?.meta && typeof account.meta === "object" && !Array.isArray(account.meta) ? account.meta : {};
    const result = {};
    for (const key of WORKBUDDY_CONTEXT) {
      const value = meta[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) throw denied();
      result[key] = value;
    }
    return result;
  }
  async function readContext(account, scope) {
    const state = raw(account, scope);
    const stamp = credentialStamp(state.account);
    const identity = typeof state.adapter.readForwardContext === "function" ? await state.adapter.readForwardContext(state.account) : {};
    const live = assertUnchanged(state.account, stamp, scope);
    const metadata = typeof state.adapter.modelEntries === "function" ? state.adapter.modelEntries() : [];
    const byId = new Map(metadata.map(entry => [String(entry.id).toLowerCase(), entry]));
    const entries = typeof state.adapter.readForwardModels === "function"
      ? state.adapter.readForwardModels() : metadata.length ? metadata : state.adapter.models().map(id => ({ id }));
    if (!Array.isArray(entries) || entries.length > 4096) throw denied();
    const fields = POLICIES[live.channel].modelFields;
    const models = entries.map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw denied();
      const result = {};
      for (const field of fields) {
        if (entry[field] === undefined) continue;
        const value = entry[field];
        if (field === "modelType") {
          if (!Number.isSafeInteger(value) || value <= 0) throw denied();
          result[field] = value;
          continue;
        }
        if (field === "reasoningEfforts") {
          if (!Array.isArray(value) || value.length > 32 || !value.every(item => typeof item === "string" && item.length > 0 && item.length <= 64 && !/[\x00-\x1f\x7f]/.test(item))) throw denied();
          result[field] = [...value];
          continue;
        }
        if (field === "images") {
          if (typeof value !== "boolean") throw denied();
          result[field] = value;
          continue;
        }
        if (typeof value !== "string" || !value || value.length > (field === "name" ? 256 : 160) || /[\x00-\x1f\x7f]/.test(value)) throw denied();
        result[field] = value;
      }
      if (!result.id) throw denied();
      const facts = { ...(typeof management.modelMetadata === "function" ? management.modelMetadata(result.id, live.channel) : {}),
        ...byId.get(result.id.toLowerCase()), ...entry };
      for (const field of PUBLIC_MODEL_FIELDS) {
        const value = facts[field];
        if (value === undefined) continue;
        if (field === "name") {
          if (typeof value === "string" && value && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) result.name = value;
        } else if (field === "capabilities") {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            result.capabilities = {};
            for (const key of ["images", "tools", "reasoning", "audio", "video", "pdf"]) if (typeof value[key] === "boolean") result.capabilities[key] = value[key];
          }
        } else if (field === "rate") {
          if (value === null || typeof value === "number" && Number.isFinite(value) && value >= 0) result.rate = value;
        } else if (Number.isSafeInteger(value) && value >= 0) result[field] = value;
      }
      return result;
    });
    if (Buffer.byteLength(JSON.stringify(models)) > 1024 * 1024) throw denied();
    current(live, scope);
    const concurrent = Number(identity?.maxConcurrent);
    const context = {
      accountId: live.id,
      uid: String(live.uid || ""),
      models,
      identity: pick(identity, live.channel === "raccoon" ? ["deviceId", "osVersion", "platform", "clientChannel", "officeIdentity"]
        : live.channel === "zcode" || live.channel === "zcode_intl" ? ["deviceMid", "provider"] : ["deviceId", "deviceMid", "machineId", "imageId"]),
    };
    if (Number.isFinite(concurrent) && concurrent > 0) context.maxConcurrent = Math.min(64, Math.floor(concurrent));
    Object.assign(context, accountIdentity(live.channel, state.account));
    return context;
  }
  return Object.freeze({ readCredentials, ensureCredentials, readContext,
    policyFor: (channel, purpose) => ["invoke", "catalog"].includes(purpose) && Object.hasOwn(POLICIES, channel) ? POLICIES[channel] : null });
}
module.exports = { createForwardAccess };
