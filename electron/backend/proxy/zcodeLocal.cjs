// 反代网关 · ZCode 本机文件与 enc:v1 加密（zcode 渠道的地基模块）
//
// 事实基线（本机实测 + 示例项目 zcode-account-switcher / zcode-switch 双重互证）：
//   · 登录态由 ~/.zcode/v2/credentials.json 承载：平铺 map，值为 enc:v1 密文。
//     关键键：zcodejwttoken（billing/claim/start-plan 对话的 Bearer，payload 无 exp）、
//     oauth:active_provider（zai/bigmodel）、oauth:{p}:access_token / refresh_token / user_info、
//     account-provider:coding-plan:account:{family}:account:{uid}:api-key（coding-plan 对话凭据）、
//     web-remote-control:external-relay:pass_hash（移动端远程连接密钥——切号红线，绝不许丢）。
//   · enc:v1 = AES-256-GCM，格式 enc:v1:<nonce_b64url>.<tag_b64url>.<cipher_b64url>，
//     key = sha256(secret)，secret = 环境变量 ZCODE_CREDENTIAL_SECRET 或
//     "zcode-credential-fallback:{platform}:{homedir}:{username}"（platform 用 Node 语义 win32）。
//   · ~/.zcode/v2/account-profiles/profiles.json 是官方多账号档案：每档案带 cred_file
//     （完整 credentials 快照）与明文 provider_api_keys（coding-plan 的 {apiKey}.{secret}
//     与 start-plan JWT 直接可读，无需解密）。
//   · 新代际判定：provider_config.json 存在时 config.json 不再承载 provider，切号不写它。
//   · 移动端远程连接地址三要素：relay 服务地址（服务端下发）+ deviceSid（setting.json
//     的 webRemoteControlExternalRelayDevice.deviceSid）+ pass_hash（credentials.json）。
//     三者都与账号无关——切号只做「合并式写回凭据白名单键」，这三样一律不碰，
//     另加 telemetry-state.json 的 deviceMid 不动（与官方客户端同机多账号的真实行为一致）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync, spawn } = require("node:child_process");
const config = require("../config.cjs");

const ENC_PREFIX = "enc:v1:";
const NONCE_SIZE = 12;

// ===== enc:v1 加解密 =====

/** 加密密钥来源串：环境变量优先，否则按官方回退公式拼（本机实测可解真实 credentials.json） */
function defaultSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let username = "unknown";
  try { username = os.userInfo().username; } catch { /* 拿不到用 unknown */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret || defaultSecret())).digest();
}

function isEnc(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** 解 enc:v1；非 enc 值原样返回（明文兜底），格式错误抛错 */
function encDecrypt(value, secret) {
  if (!isEnc(value)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("enc:v1 格式不正确（应为 nonce.tag.cipher 三段）");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(parts[0], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
}

function encEncrypt(plain, secret) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), nonce);
  const text = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ENC_PREFIX + [nonce, cipher.getAuthTag(), text].map((b) => Buffer.from(b).toString("base64url")).join(".");
}

/** 宽容解密：解不开返回 ""（调用方按缺失处理，绝不因一个键解不动拖垮整份文件） */
function tryDecrypt(value, secret) {
  try {
    return encDecrypt(value, secret);
  } catch {
    return "";
  }
}

// ===== 路径 =====

/** v2 数据目录（ZCODE_V2_DIR 供自测脚本沙箱覆盖） */
function v2Dir() {
  return process.env.ZCODE_V2_DIR || path.join(os.homedir(), ".zcode", "v2");
}

function paths() {
  const dir = v2Dir();
  return {
    dir,
    credentials: path.join(dir, "credentials.json"),
    config: path.join(dir, "config.json"),
    telemetry: path.join(dir, "telemetry-state.json"),
    setting: path.join(dir, "setting.json"),
    providerConfig: path.join(dir, "provider_config.json"),
    planCache: path.join(dir, "coding-plan-cache.json"),
    profilesJson: path.join(dir, "account-profiles", "profiles.json"),
    profilesDir: path.join(dir, "account-profiles"),
  };
}

/** 新代际判定：provider_config.json 存在时 provider 凭据在 credentials.json 的 account-provider 键里，
 *  config.json 不再是登录驱动源（切号不写它） */
function isNewGen() {
  return fs.existsSync(paths().providerConfig);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 原子写 JSON：tmp + rename + 0o600（凭据文件权限与官方客户端一致） */
function atomicWriteJson(file, obj) {
  const tmp = `${file}.agenthub-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ===== 读取：live 登录态与多账号档案 =====

/** JWT payload 解析（不验签）：zcodejwt 的 uid 取 user_id/sub */
function jwtPayload(token) {
  try {
    const parts = String(token || "").trim().split(".");
    if (parts.length < 2) return {};
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function uidFromJwt(token) {
  const p = jwtPayload(token);
  return String(p.user_id || p.sub || "");
}

/** coding-plan 键名解析：account-provider:coding-plan:account:{family}:account:{uid}:api-key */
function parseCodingPlanKeyName(keyName) {
  const m = /^account-provider:coding-plan:account:(zai-(?:individual|team)-coding-plan):account:([0-9a-fA-F-]{36}):api-key$/.exec(String(keyName || ""));
  return m ? { family: m[1], uid: m[2] } : null;
}

/**
 * 解析一份 credentials.json 对象为账号凭据集（解密全部已知 enc 键）。
 * 返回 {
 *   provider, jwt, accessToken, refreshToken, userInfo:{...}|null,
 *   codingPlanKeys: [{ keyName, family, uid, plain }],   // plain = "{apiKey}.{secret}" 明文
 *   relayPassHashEnc,   // web-remote-control pass_hash 的 enc:v1 原样值（不切密直接搬运用）
 *   relayKeys: {name: encValue}, // 全部 web-remote-control: 前缀键（设备键，切号保留）
 *   unknownKeys,        // 未识别的键名列表（合并写回时原样保留的审计线索）
 *   decryptOk,          // 主凭据是否解得开（密钥不对时诚实降级）
 * }
 */
function parseCredentials(json) {
  const out = {
    provider: "", jwt: "", accessToken: "", refreshToken: "", userInfo: null,
    codingPlanKeys: [], relayPassHashEnc: "", relayKeys: {}, unknownKeys: [], decryptOk: false,
  };
  if (!json || typeof json !== "object") return out;
  const secret = defaultSecret();
  for (const [key, value] of Object.entries(json)) {
    if (key.startsWith("web-remote-control:")) {
      out.relayKeys[key] = value; // 设备键一律按 enc 原样保留（不解密，密钥错了也能搬运）
      if (key === "web-remote-control:external-relay:pass_hash") out.relayPassHashEnc = String(value || "");
      continue;
    }
    if (key === "zcodejwttoken") {
      out.jwt = tryDecrypt(value, secret);
      if (out.jwt) out.decryptOk = true;
      continue;
    }
    if (key === "oauth:active_provider") {
      out.provider = tryDecrypt(value, secret);
      continue;
    }
    let m = /^oauth:(zai|bigmodel):access_token$/.exec(key);
    if (m) { out.accessToken = tryDecrypt(value, secret); continue; }
    m = /^oauth:(zai|bigmodel):refresh_token$/.exec(key);
    if (m) { out.refreshToken = tryDecrypt(value, secret); continue; }
    m = /^oauth:(zai|bigmodel):user_info$/.exec(key);
    if (m) {
      const plain = tryDecrypt(value, secret);
      try { out.userInfo = plain ? JSON.parse(plain) : null; } catch { out.userInfo = null; }
      out.userInfoRaw = plain;
      continue;
    }
    if (key.startsWith("account-provider:coding-plan:")) {
      const info = parseCodingPlanKeyName(key);
      const plain = tryDecrypt(value, secret);
      if (info && plain) out.codingPlanKeys.push({ keyName: key, family: info.family, uid: info.uid, plain });
      continue;
    }
    // oauth:login_attribution 与其余未识别键：保留线索，合并写回时原样携带
    out.unknownKeys.push(key);
  }
  return out;
}

/** 读当前 live 登录态（credentials.json）；文件不存在/坏 JSON 返回 null */
function readLive() {
  const file = paths().credentials;
  const json = readJson(file);
  if (!json) return null;
  return { file, raw: json, ...parseCredentials(json) };
}

/**
 * 读官方多账号档案（account-profiles/profiles.json + 各 cred_file）。
 * 每档案产出：{ profileId, uid, name, email, avatar, family, providerApiKeys（明文表）,
 *   cred（cred_file 解密后的凭据集，同 parseCredentials 返回）, file }
 * 档案的 provider_api_keys 是明文：builtin:zai-coding-plan = "{apiKey}.{secret}"、
 * builtin:zai-start-plan = start-plan JWT——导入链路可不解 enc:v1 直接拿到对话凭据。
 */
function readProfiles() {
  const p = paths();
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p.profilesJson, "utf8"));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    return [];
  }
  const out = [];
  for (const prof of list) {
    if (!prof || typeof prof !== "object") continue;
    const credFile = String(prof.cred_file || "");
    let cred = null;
    if (credFile && /^[\w.-]+$/.test(credFile)) {
      const json = readJson(path.join(p.profilesDir, credFile));
      if (json) cred = parseCredentials(json);
    }
    const apiKeys = {};
    const rawKeys = prof.provider_api_keys && typeof prof.provider_api_keys === "object" ? prof.provider_api_keys : {};
    for (const [k, v] of Object.entries(rawKeys)) {
      if (typeof v === "string" && v.trim()) apiKeys[k] = v.trim();
    }
    out.push({
      profileId: String(prof.id || ""),
      uid: String(prof.user_id || ""),
      name: String(prof.name || ""),
      email: String(prof.email || ""),
      avatar: String(prof.avatar || ""),
      family: String(prof.family || ""),
      providerApiKeys: apiKeys,
      cred,
      file: credFile,
    });
  }
  return out;
}

// ===== meta.sw 切号快照的加密封装（值逐个走 AgentHub DPAPI 信封，meta 落库不明文） =====
// 前缀撞名陷阱（必须显式处理）：zcode 的 enc:v1: 密文与 AgentHub DPAPI 信封前缀同为 enc:v1:，
// config.encryptSecret 对"已是密文形态"的值直接跳过封装（撞名透传）。若把 zcode enc 串原样塞进 meta，
// 读侧 decryptSecret 会把它当自己的信封去解密——safeStorage 可用的环境里必然解不开 → 静默回 ""，
// relay pass_hash 这类 enc 原样值会无声丢失。规避：seal 前加 "ZCV1:" 命名空间前缀，unseal 时先剥再走 DPAPI。
const ZSEAL_PREFIX = "ZCV1:";

function seal(plain) {
  const s = String(plain || "");
  return s ? ZSEAL_PREFIX + config.encryptSecret(s) : "";
}

function unseal(sealed) {
  const raw = String(sealed || "");
  if (!raw) return "";
  // 兼容读：无命名空间前缀的是外部/早期写入形态
  const s = raw.startsWith(ZSEAL_PREFIX) ? raw.slice(ZSEAL_PREFIX.length) : raw;
  // config.decryptSecret：DPAPI 信封→明文（解不开回 ""）；非信封明文→原样回。
  // 撞名边界（zcode enc:v1: 原样串）：它不是 DPAPI 信封，decryptSecret 会回 ""，
  // 但 seal 侧对它同样原样放行（encryptSecret 跳过密文形态）——读写对称，直接回 s。
  try {
    const plain = config.decryptSecret(s);
    if (plain) return plain;
    return s.startsWith("enc:v1:") ? s : "";
  } catch {
    return s.startsWith("enc:v1:") ? s : "";
  }
}

/** config.json 的 provider apiKey 明文表（旧代际登录驱动源）：provider[builtin:*].options.apiKey */
function extractConfigApiKeys(configJson) {
  const out = {};
  const prov = configJson && typeof configJson === "object" ? configJson.provider : null;
  if (!prov || typeof prov !== "object") return out;
  for (const [slot, v] of Object.entries(prov)) {
    const key = v && typeof v === "object" && v.options && typeof v.options === "object" ? v.options.apiKey : "";
    if (typeof key === "string" && key.trim()) out[slot] = key.trim();
  }
  return out;
}

/** 从凭据集里挑主 coding-plan key：zai-individual 优先，其次 zai-team，其余按序；档案明文表兜底 */
function pickPlanKey(codingPlanKeys, profileApiKeys, expectedUid) {
  const allList = Array.isArray(codingPlanKeys) ? codingPlanKeys : [];
  // 账号身份与凭据必须同源：提供了 expectedUid 时只用属于该 UID 的 coding-plan 凭据。
  // 无匹配绝不退而取别的账号的 key——那会把 A 账号的付费额度记到 B 账号名下（串号）
  const list = expectedUid ? allList.filter((k) => k.uid === expectedUid) : allList;
  const indiv = list.find((k) => /zai-individual/.test(k.family));
  if (indiv) return { plain: indiv.plain, uid: indiv.uid };
  const team = list.find((k) => /zai-team/.test(k.family));
  if (team) return { plain: team.plain, uid: team.uid };
  if (list.length) return { plain: list[0].plain, uid: list[0].uid };
  const keys = profileApiKeys || {};
  for (const slot of ["builtin:zai-coding-plan", "builtin:bigmodel-coding-plan"]) {
    if (keys[slot]) return { plain: keys[slot], uid: "" };
  }
  return { plain: "", uid: "" };
}

/**
 * 凭据集 → 号池账号记录（discovery 本机扫描与 index JSON/ZIP 导入共用同一组装逻辑）。
 * extra: { profileApiKeys?, jwtFallback?, uid?, name?, email?, avatar?, provider? }
 * 返回 { uid, name, token, refreshToken, meta }（token = zcodejwt，refreshToken = 主 coding-plan key）
 */
function accountRecord(parsed, extra) {
  const ex = extra || {};
  const jwt = parsed.jwt || ex.jwtFallback || "";
  const info = parsed.userInfo || {};
  // 权威 UID 判定优先级：extra.uid (档案声明) > uidFromJwt(jwt) > info.user_id
  const expectedUid = String(ex.uid || "") || uidFromJwt(jwt) || String(info.user_id || "");
  const planKey = pickPlanKey(parsed.codingPlanKeys, ex.profileApiKeys, expectedUid);
  const uid = expectedUid || planKey.uid || "";
  const email = String(info.email || ex.email || "");
  const name = String(ex.name || info.name || email || (uid ? `ZCode ${uid.slice(0, 6)}` : ""));
  // 账号级独立设备指纹：优先透传 extra.deviceMid；若是本机当前登录账号，沿用当前 live telemetry 的 deviceMid；
  // 否则根据 uid 派生确定性 UUIDv4，保持该账号单号单机、终生固定且互不关联
  const mid = (() => {
    if (ex.deviceMid) return String(ex.deviceMid);
    const live = readLive();
    const liveUid = live && (uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid));
    const telemetryMid = (() => {
      const t = readJson(paths().telemetry);
      return String((t && t.deviceMid) || "");
    })();
    if (telemetryMid && uid && liveUid && uid === liveUid) return telemetryMid;
    if (uid) {
      const h = crypto.createHash("sha256").update(`zcode-device:${uid}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    return telemetryMid || "";
  })();
  return {
    uid,
    name,
    token: jwt,
    refreshToken: planKey.plain,
    meta: {
      provider: parsed.provider || String(ex.provider || "zai"),
      email,
      avatar: String(info.avatar || info.avatarUrl || ex.avatar || ""),
      ...(mid ? { deviceMid: mid } : {}),
      sw: buildSwitchSnapshot(parsed, "", uid),
    },
  };
}

/** 账号 meta.sw 快照 → 切号写回所需的明文结构；快照缺失/解不开返回 null */
function readSwitchSnapshot(acc) {
  let meta = (acc && acc.meta) || {};
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta || "{}"); } catch { meta = {}; }
  }
  const sw = meta && meta.sw && typeof meta.sw === "object" ? meta.sw : null;
  if (!sw) return null;
  const secrets = require("./store.cjs").accountSecrets(acc);
  const jwt = acc.token || secrets.token || "";
  if (!jwt) return null;
  let codingPlanKeys = [];
  try {
    const arr = JSON.parse(unseal(sw.codingPlanKeys) || "[]");
    if (Array.isArray(arr)) codingPlanKeys = arr.filter((k) => k && k.keyName && k.plain);
  } catch { /* 空按无 key 处理 */ }
  return {
    provider: String(meta.provider || sw.provider || "zai"),
    jwt,
    accessToken: unseal(sw.accessToken),
    refreshToken: unseal(sw.refreshToken),
    userInfoRaw: unseal(sw.userInfo),
    codingPlanKeys,
    relayPassHashEnc: unseal(sw.relayPassHash), // enc:v1 原样值（live 没有时的兜底注入源）
  };
}

/** 凭据集 → meta.sw 快照（入库前调用；accessToken/userInfo 等敏感值逐个 DPAPI 加密） */
function buildSwitchSnapshot(parsed, fallbackRelayEnc, targetUid) {
  if (!parsed) return null;
  const allKeys = Array.isArray(parsed.codingPlanKeys) ? parsed.codingPlanKeys : [];
  // 快照只保留属于该账号 UID 的 coding-plan 凭据：targetUid 明确时严格过滤（无匹配即空，
  // 切号合并写会先清场再写入，快照若混入别号 key 会在切号后把别号凭据写回 live）
  const relevantKeys = targetUid ? allKeys.filter((k) => k.uid === targetUid) : allKeys;
  return {
    accessToken: seal(parsed.accessToken),
    refreshToken: seal(parsed.refreshToken),
    userInfo: seal(parsed.userInfoRaw || (parsed.userInfo ? JSON.stringify(parsed.userInfo) : "")),
    codingPlanKeys: seal(JSON.stringify(relevantKeys.map((k) => ({ keyName: k.keyName, plain: k.plain })))),
    relayPassHash: seal(parsed.relayPassHashEnc || fallbackRelayEnc || ""),
  };
}

// ===== 合并式写回（切号红线核心） =====

/**
 * 把目标账号凭据合并写进 live credentials.json——只动凭据白名单键：
 *   删：全部 account-provider:coding-plan:* 键（当前账号的 coding-plan 凭据清场）与所有 oauth:* 凭据
 *   写：oauth:active_provider / oauth:{p}:access_token / oauth:{p}:refresh_token（有才写）/
 *       oauth:{p}:user_info / zcodejwttoken / 目标账号的 account-provider 键（全部 enc 重加密）
 *   保：web-remote-control:* 前缀键（live 有就以 live 为准；live 没有才用快照兜底注入）、
 *       oauth:login_attribution、全部未知键——一个字节不动
 * 移动端远程地址不变的机理：relay 寻址三要素（服务地址/deviceSid/pass_hash）全部不在
 * 本次写入范围内；pass_hash 所属的前缀键组以 live 原值保留，deviceSid 在 setting.json（不碰）、
 * deviceMid 在 telemetry-state.json（不碰）。
 */
function mergeWriteCredentials(target, liveJson) {
  const secret = defaultSecret();
  const out = { ...liveJson };
  // ① 清场：当前账号的 coding-plan 键全部删除
  for (const key of Object.keys(out)) {
    if (key.startsWith("account-provider:coding-plan:")) delete out[key];
  }
  // 清理所有已知的 oauth provider 凭据键，防止跨账号/跨 provider 残留脏数据（如旧账号的 refresh_token）
  for (const prov of ["zai", "bigmodel"]) {
    delete out[`oauth:${prov}:access_token`];
    delete out[`oauth:${prov}:refresh_token`];
    delete out[`oauth:${prov}:user_info`];
  }
  // ② 凭据键写入（enc 重加密）
  const p = target.provider === "bigmodel" ? "bigmodel" : "zai";
  out["oauth:active_provider"] = encEncrypt(p, secret);
  if (target.accessToken) out[`oauth:${p}:access_token`] = encEncrypt(target.accessToken, secret);
  if (target.refreshToken) out[`oauth:${p}:refresh_token`] = encEncrypt(target.refreshToken, secret);
  if (target.userInfoRaw) out[`oauth:${p}:user_info`] = encEncrypt(target.userInfoRaw, secret);
  out["zcodejwttoken"] = encEncrypt(target.jwt, secret);
  for (const k of target.codingPlanKeys || []) {
    out[k.keyName] = encEncrypt(k.plain, secret);
  }
  // ③ relay 键：live 已有则天然保留（没被上面动过）；live 缺失且快照有兜底值才注入
  if (!Object.keys(out).some((k) => k.startsWith("web-remote-control:")) && target.relayPassHashEnc) {
    out["web-remote-control:external-relay:pass_hash"] = target.relayPassHashEnc;
  }
  return out;
}

/** 写后回读校验三连：jwt 落位且属目标账号 + relay 键原值保留 + 原有非凭据根键一个不少 */
function verifyCredentialsWritten(file, target, beforeJson) {
  const json = readJson(file);
  if (!json) return { ok: false, message: "回读解析失败" };
  const parsed = parseCredentials(json);
  if (!parsed.jwt || parsed.jwt !== target.jwt) return { ok: false, message: "zcodejwttoken 与写入值不一致" };
  const uid = uidFromJwt(target.jwt);
  if (uid && uidFromJwt(parsed.jwt) !== uid) return { ok: false, message: "写入后的账号 uid 与目标不一致" };
  // relay 校验：切前 live 有的前缀键，写后必须逐字节相同（远程连接地址不变的直接证据）
  const beforeRelay = Object.keys(beforeJson || {}).filter((k) => k.startsWith("web-remote-control:"));
  for (const k of beforeRelay) {
    if (json[k] !== beforeJson[k]) return { ok: false, message: `远程连接凭据键 ${k} 被改变，已拒绝生效` };
  }
  // 原有键保留校验：凭据白名单之外的键一个不许丢
  const WHITELIST = new Set([
    "oauth:active_provider", "oauth:zai:access_token", "oauth:zai:refresh_token", "oauth:zai:user_info",
    "oauth:bigmodel:access_token", "oauth:bigmodel:refresh_token", "oauth:bigmodel:user_info", "zcodejwttoken",
  ]);
  for (const k of Object.keys(beforeJson || {})) {
    if (WHITELIST.has(k) || k.startsWith("account-provider:coding-plan:")) continue;
    if (!(k in json)) return { ok: false, message: `原有键丢失：${k}` };
  }
  return { ok: true, message: "" };
}

/** setting.json 对齐 provider 家族域（官方客户端按它决定 provider 家族入口）；只写这两个键 */
function alignFamilyDomain(provider) {
  const file = paths().setting;
  const json = readJson(file);
  if (!json) return { ok: false, message: "setting.json 不存在或不可解析" };
  json.providerFamilyDomain = provider;
  json.providerFamilyDomainUpdatedAt = Date.now() / 1000;
  try {
    atomicWriteJson(file, json);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 删 coding-plan 套餐缓存（旧账号的套餐缓存会让客户端按错套餐展示） */
function resetPlanCache() {
  try {
    fs.rmSync(paths().planCache, { force: true });
  } catch { /* 不存在即目的达成 */ }
}

// ===== 进程控制（跨平台支持：Windows / macOS / Linux） =====

/** 同步安全休眠（零 CPU 消耗，替代死循环忙等打满单核） */
function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 降级兜底 */ }
  }
}

/** ZCode 是否在跑（跨平台探测：Windows 用 tasklist，Unix 用 pgrep） */
function isZcodeRunning() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', { encoding: "utf8", windowsHide: true });
      return /^ZCode\.exe\s/im.test(out);
    }
    const out = execSync("pgrep -x ZCode || pgrep -x zcode || pgrep -i zcode", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return Boolean(out && out.trim());
  } catch {
    return false;
  }
}

/** 强杀全部 ZCode 进程并等待退出（默认 8s 超时；杀不掉返回 false） */
function killZcode(timeoutMs = 8000) {
  if (!isZcodeRunning()) return true;
  try {
    if (process.platform === "win32") {
      execSync("taskkill /F /IM ZCode.exe /T", { encoding: "utf8", windowsHide: true });
    } else {
      execSync("pkill -9 -x ZCode || pkill -9 -x zcode || pkill -9 -i zcode", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    }
  } catch { /* 进程可能刚退出 */ }
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (!isZcodeRunning()) return true;
    syncSleep(200); // 200ms 粒度无损休眠，不占 CPU
  }
  return !isZcodeRunning();
}

/** 安装路径候选表 + 运行中进程反查 */
function findZcodeExe() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    // Windows 候选
    path.join(process.env.ProgramFiles || "C:\\Program Files", "ZCode", "ZCode.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "ZCode", "ZCode.exe"),
    path.join(localAppData, "Programs", "ZCode", "ZCode.exe"),
    "E:\\ZCode\\ZCode.exe",
    "D:\\Program Files\\ZCode\\ZCode.exe",
    // macOS 候选
    "/Applications/ZCode.app/Contents/MacOS/ZCode",
    path.join(home, "Applications", "ZCode.app", "Contents", "MacOS", "ZCode"),
    // Linux 候选
    "/usr/bin/zcode",
    "/usr/local/bin/zcode",
    "/opt/ZCode/zcode",
    path.join(home, ".local", "share", "ZCode", "zcode"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 下一个 */ }
  }
  // Windows 下运行中进程反查（PowerShell 一次调用）
  if (process.platform === "win32") {
    try {
      const out = execSync('powershell -NoProfile -Command "Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"', {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch { /* 反查失败按未找到处理 */ }
  } else {
    // Unix 平台 which 探测
    try {
      const out = execSync("which zcode || which ZCode", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch { /* 未找到 */ }
  }
  return "";
}

/** 启动客户端（分离进程，不阻塞主进程） */
function launchZcode(exe) {
  const file = exe || findZcodeExe();
  if (!file) return { ok: false, message: "未找到 ZCode 可执行文件，请手动启动客户端" };
  try {
    const child = spawn(file, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, file };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = {
  ENC_PREFIX, isEnc, defaultSecret, encDecrypt, encEncrypt, tryDecrypt,
  v2Dir, paths, isNewGen, readJson, atomicWriteJson,
  jwtPayload, uidFromJwt, parseCodingPlanKeyName, parseCredentials, readLive, readProfiles,
  extractConfigApiKeys, pickPlanKey, accountRecord,
  readSwitchSnapshot, buildSwitchSnapshot, seal, unseal,
  mergeWriteCredentials, verifyCredentialsWritten, alignFamilyDomain, resetPlanCache,
  isZcodeRunning, killZcode, findZcodeExe, launchZcode,
};
