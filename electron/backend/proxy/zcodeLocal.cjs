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
//     三者都与账号无关——切号只做「合并式写回凭据白名单键」，这三样一律不碰。
//   · telemetry-state.json 的 deviceMid 是周末套餐领取资格的设备维判据（服务端规则：
//     可领 = 账号本周未领 ∧ 该指纹本周未被任何领取消耗），但它同时也是移动端远程连接的
//     设备身份：客户端把 deviceMid 拼进远程链接的 mid 参数、relay WS 连接的 ?mid= 查询参数
//     与 X-Device-ID 头、设备注册消息的 device_mid——服务端把 deviceSid 与 deviceMid 绑定
//     校验，指纹变更会被判会话冲突踢线（relay 下发 KICKED，客户端只重连不换身份，永不自愈；
//     本机 2026-09-29 实证：切号换指纹后远程当天失效，反查 app.asar 代码坐实）。
//     因此 live 指纹必须终生恒定（anchor.remoteMid 锚定），切号绝不碰它；每号一枚的专属
//     指纹只体现在账号 meta.deviceMid（AgentHub 自身领取请求头按号注入），官方客户端里
//     领套餐走「领取模式」人工窗口：临时借出 → 人工领取 → 恢复锚定值（见 applyDeviceMid）。
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

/** coding-plan 键名解析：account-provider:coding-plan:account:{family}:account:{uid}:api-key
 *  家族与 uid 都按实际取值放宽：除 zai-individual/team-coding-plan 外，BigModel 系的键名形如
 *  `bigmodel-individual-coding-plan`，uid 也可能是 17 位数字（如 79231753711524355）而非 UUID。
 *  原正则只认 zai-* + 36 位 UUID，会让这类 key 解析失败 → 在 parseCredentials 里被静默丢弃
 *  （if (info && plain)），导致 refresh_enc 恒空、对话只能退回 start-plan 通道。 */
function parseCodingPlanKeyName(keyName) {
  const m = /^account-provider:coding-plan:account:([a-z0-9-]+-coding-plan):account:([0-9a-zA-Z-]+):api-key$/.exec(String(keyName || ""));
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

/** 账号级专属指纹的确定性派生：sha256("zcode-device:" + uidId) → UUIDv4 形态（终生稳定、互不关联） */
function derivedDeviceMid(uidId) {
  const h = crypto.createHash("sha256").update(`zcode-device:${uidId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
  // 账号级独立设备指纹（周末套餐领取资格的设备维判据，号间必须两两相异）：
  //   ① 显式透传 extra.deviceMid；
  //   ② 非本机当前登录账号 → 按 uid 派生确定性 UUIDv4（单号单机、终生固定、互不关联）；
  //   ③ 是当前登录账号时，只有 live 指纹没被池内其它账号占用才沿用；撞车（adopt 陷阱：
  //      上一号烧掉的共享指纹被新号继承，一进来就 1004）则派生专属指纹隔离。
  const mid = (() => {
    if (ex.deviceMid) return String(ex.deviceMid);
    const live = readLive();
    const liveUid = live && (uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid));
    const telemetryMid = (() => {
      const t = readJson(paths().telemetry);
      return String((t && t.deviceMid) || "");
    })();
    if (telemetryMid && uid && liveUid && uid === liveUid) {
      let heldByOther = false;
      try {
        heldByOther = require("./store.cjs")
          .listAccounts("zcode")
          .some((a) => a.uid !== uid && String((a.meta && a.meta.deviceMid) || "") === telemetryMid);
      } catch { /* 库未开按无撞车处理 */ }
      if (!heldByOther) return telemetryMid;
    }
    if (uid) return derivedDeviceMid(uid);
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
    deviceMid: String(meta.deviceMid || ""), // 账号专属设备指纹（切号时写入 telemetry-state.json）
    accountId: String(acc.id || ""),
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
 * 本次写入范围内；pass_hash 所属的前缀键组以 live 原值保留，deviceSid 在 setting.json（不碰）。
 * （deviceMid 在 telemetry-state.json，由切号编排层单独随账号切换，与本函数无关。）
 */
// ===== 远程连接与工作区持久化锚点（终生保手机远程连接 + 全账号共享项目/会话，自适应开源无硬编码） =====
function anchorPath() {
  const dir = path.join(config.dataDir(), "proxy");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "zcode-remote-anchor.json");
}

function readAnchor() {
  const file = anchorPath();
  return readJson(file);
}

function saveAnchor(data) {
  const file = anchorPath();
  atomicWriteJson(file, data);
}

/** 从最近的切号备份中自愈查找设备 sid（适配开源与各种 Windows 机器，零硬编码） */
function findLatestBackupDeviceSid() {
  try {
    const root = path.join(config.dataDir(), "proxy", "zcode-switch-backup");
    if (!fs.existsSync(root)) return "";
    const dirs = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
    for (const d of dirs) {
      const sf = path.join(root, d, "setting.json");
      if (fs.existsSync(sf)) {
        const j = readJson(sf);
        if (j && j.webRemoteControlExternalRelayDevice && j.webRemoteControlExternalRelayDevice.deviceSid) {
          const sid = String(j.webRemoteControlExternalRelayDevice.deviceSid).trim();
          if (sid) return sid;
        }
      }
    }
  } catch {}
  return "";
}

/** 从最近的切号备份中自愈查找 pass_hash 密文（适配开源与各种 Windows 机器，零硬编码） */
function findLatestBackupPassHashEnc() {
  try {
    const root = path.join(config.dataDir(), "proxy", "zcode-switch-backup");
    if (!fs.existsSync(root)) return "";
    const dirs = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
    for (const d of dirs) {
      const cf = path.join(root, d, "credentials.json");
      if (fs.existsSync(cf)) {
        const j = readJson(cf);
        if (j && j["web-remote-control:external-relay:pass_hash"]) {
          const h = String(j["web-remote-control:external-relay:pass_hash"]).trim();
          if (h) return h;
        }
      }
    }
  } catch {}
  return "";
}

/**
 * 从历史切号备份里找「最早的 live 指纹」作为远程锚定值（remoteMid）初值：
 * 备份目录名是切号时间戳，升序取第一份含 deviceMid 的 telemetry-state.json——
 * 最早的那份最接近 deviceSid 在服务端首次注册时绑定的指纹。找不到返回 ""。
 */
function findOriginalMidFromBackups() {
  try {
    const root = path.join(config.dataDir(), "proxy", "zcode-switch-backup");
    if (!fs.existsSync(root)) return "";
    const dirs = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b));
    for (const d of dirs) {
      const tf = path.join(root, d, "telemetry-state.json");
      if (fs.existsSync(tf)) {
        const j = readJson(tf);
        const mid = String((j && j.deviceMid) || "").trim();
        if (mid) return mid;
      }
    }
  } catch {}
  return "";
}

/** 获取或初始化本机持久化 Anchor（确保手机远程连接与项目会话在任何 Windows 电脑上终生固定） */
function getOrCreateAnchor() {
  let anchor = readAnchor();
  if (!anchor || typeof anchor !== "object") anchor = {};
  const p = paths();
  const liveSetting = readJson(p.setting) || {};
  const bakSetting = readJson(p.setting + ".bak") || {};
  const liveCred = readJson(p.credentials) || {};

  // 1. deviceSid 提取：live setting -> setting.bak -> 历史切号备份自愈（无硬编码，自适应宿主真实值）
  if (!anchor.deviceSid) {
    anchor.deviceSid =
      (liveSetting.webRemoteControlExternalRelayDevice && String(liveSetting.webRemoteControlExternalRelayDevice.deviceSid || "").trim()) ||
      (bakSetting.webRemoteControlExternalRelayDevice && String(bakSetting.webRemoteControlExternalRelayDevice.deviceSid || "").trim()) ||
      findLatestBackupDeviceSid() ||
      "";
  }

  // 2. passHashEnc 提取：live credentials -> 历史切号备份自愈（无硬编码，自适应宿主真实值）
  if (!anchor.passHashEnc) {
    anchor.passHashEnc =
      (liveCred["web-remote-control:external-relay:pass_hash"] && String(liveCred["web-remote-control:external-relay:pass_hash"]).trim()) ||
      findLatestBackupPassHashEnc() ||
      "";
  }

  // 3. 项目列表合并（动态自适应当前机器的全部已有项目路径）
  const projectSet = new Set(Array.isArray(anchor.projects) ? anchor.projects : []);
  for (const list of [liveSetting.recentProjects, bakSetting.recentProjects]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "string" && item.trim()) projectSet.add(item.trim());
      }
    }
  }
  anchor.projects = Array.from(projectSet);

  // 4. 工作区会话列表提取（动态自适应当前机器的全部已有工作区）
  if (!Array.isArray(anchor.sessions) || anchor.sessions.length <= 1) {
    if (Array.isArray(bakSetting.lastWorkspaceSession) && bakSetting.lastWorkspaceSession.length > 1) {
      anchor.sessions = bakSetting.lastWorkspaceSession;
    } else if (Array.isArray(liveSetting.lastWorkspaceSession) && liveSetting.lastWorkspaceSession.length > 1) {
      anchor.sessions = liveSetting.lastWorkspaceSession;
    }
  }

  // 5. 远程上下文（动态自适应当前机器已有上下文，若无则留空）
  if (!anchor.remoteContext) {
    anchor.remoteContext =
      liveSetting.webRemoteControlLastEnabledContext ||
      bakSetting.webRemoteControlLastEnabledContext ||
      null;
  }

  // 6. 本机远程锚定指纹（remoteMid）：relay 把 deviceMid 当设备身份（远程链接 mid 参数 +
  //    WS 连接 ?mid= 与 X-Device-ID 头），必须终生恒定——变更会被服务端判会话冲突踢线。
  //    初始化优先级：历史切号备份里最早的 live 指纹（最接近 deviceSid 首次注册时的值）→
  //    当前 live 指纹。锚定后终生不变；「领取模式」的临时借出在恢复时回到这里。
  if (!anchor.remoteMid) {
    const liveMid = String((readJson(p.telemetry) || {}).deviceMid || "");
    anchor.remoteMid = findOriginalMidFromBackups() || liveMid || "";
    if (anchor.remoteMid) anchor.remoteMidSavedAt = Date.now();
  }

  // 只要提取到了有效数据，就持久化 Anchor，保证即使未来误删 setting 也能随时自愈
  if (anchor.deviceSid || anchor.passHashEnc || anchor.remoteMid || (anchor.projects && anchor.projects.length)) {
    try {
      saveAnchor(anchor);
    } catch {}
  }
  return anchor;
}

/**
 * 把目标账号凭据合并写进 live credentials.json——只动凭据白名单键：
 *   删：全部 account-provider:coding-plan:* 键（当前账号的 coding-plan 凭据清场）与所有 oauth:* 凭据
 *   写：oauth:active_provider / oauth:{p}:access_token / oauth:{p}:refresh_token（有才写）/
 *       oauth:{p}:user_info / zcodejwttoken / 目标账号的 account-provider 键（全部 enc 重加密）
 *   保：web-remote-control:* 前缀键（手机远程连接属于本机全局设备标识，永远锁定 Anchor 原值）
 */
function mergeWriteCredentials(target, liveJson) {
  const secret = defaultSecret();
  const out = { ...liveJson };
  const anchor = getOrCreateAnchor();

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
  // ③ relay 键：手机远程连接属于本机硬件设备标识，绝不允许随切号改变！
  // 优先无条件锁定 Anchor 中的 passHashEnc；若 Anchor 缺失则以 live/快照兜底
  const passHash = anchor.passHashEnc || liveJson["web-remote-control:external-relay:pass_hash"] || target.relayPassHashEnc;
  if (passHash) {
    out["web-remote-control:external-relay:pass_hash"] = passHash;
  }
  return out;
}

/** 写后回读校验三连：jwt 落位且属目标账号 + relay 键原值保留 + 原有非凭据根键一个不少 */
function verifyCredentialsWritten(file, target, beforeJson) {
  const json = readJson(file);
  if (!json) return { ok: false, message: "回读 credentials.json 解析失败" };
  const parsed = parseCredentials(json);
  if (!parsed.jwt || parsed.jwt !== target.jwt) return { ok: false, message: "zcodejwttoken 与写入值不一致" };
  const uid = uidFromJwt(target.jwt);
  if (uid && uidFromJwt(parsed.jwt) !== uid) return { ok: false, message: "写入后的账号 uid 与目标不一致" };

  // relay 校验：pass_hash 必须与 anchor 或切前原值保持一致（断言手机连接不失效）
  const anchor = getOrCreateAnchor();
  const currentPassHash = json["web-remote-control:external-relay:pass_hash"];
  const expectedPassHash = anchor.passHashEnc || (beforeJson && beforeJson["web-remote-control:external-relay:pass_hash"]);
  if (expectedPassHash && currentPassHash !== expectedPassHash) {
    return { ok: false, message: "远程连接 pass_hash 被改变，已拒绝生效" };
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

/** setting.json 对齐 provider 家族域 + 全局固化手机远程连接与全部项目/会话 */
function alignFamilyDomain(provider) {
  const file = paths().setting;
  const bakFile = file + ".bak";
  const json = readJson(file) || {};
  let bakJson = {};
  if (fs.existsSync(bakFile)) {
    try { bakJson = JSON.parse(fs.readFileSync(bakFile, "utf8")) || {}; } catch {}
  }
  const anchor = getOrCreateAnchor();

  // ① provider 家族域与更新时间（关键红线：ZCode settingService 使用严格 Zod int 校验，必须为整型毫秒，严禁产生浮点数）
  json.providerFamilyDomain = provider;
  json.providerFamilyDomainUpdatedAt = Math.floor(Date.now());

  // ② 全账号共享并合并全部项目列表（recentProjects 永不丢失）
  const projectSet = new Set();
  const mergedProjects = [];
  const candidateProjects = (json.recentProjects || [])
    .concat(bakJson.recentProjects || [])
    .concat(anchor.projects || []);
  for (const item of candidateProjects) {
    if (item && typeof item === "string" && !projectSet.has(item)) {
      projectSet.add(item);
      mergedProjects.push(item);
    }
  }
  json.recentProjects = mergedProjects;

  // ③ 全账号共享并保留已打开的工作区会话（lastWorkspaceSession 永不丢失，所有历史 tasks 完整可见）
  if (!Array.isArray(json.lastWorkspaceSession) || json.lastWorkspaceSession.length <= 1) {
    if (Array.isArray(bakJson.lastWorkspaceSession) && bakJson.lastWorkspaceSession.length > 1) {
      json.lastWorkspaceSession = bakJson.lastWorkspaceSession;
    } else if (Array.isArray(anchor.sessions) && anchor.sessions.length > 1) {
      json.lastWorkspaceSession = anchor.sessions;
    }
  }

  // ④ 手机远程连接设备标识强力固化（杜绝 partial state，手机链接永远不换）
  const targetSid =
    anchor.deviceSid ||
    (json.webRemoteControlExternalRelayDevice && String(json.webRemoteControlExternalRelayDevice.deviceSid || "").trim()) ||
    (bakJson.webRemoteControlExternalRelayDevice && String(bakJson.webRemoteControlExternalRelayDevice.deviceSid || "").trim()) ||
    "";
  if (targetSid) {
    json.webRemoteControlExternalRelayDevice = { deviceSid: targetSid };
  }

  // ⑤ 远程控制上下文保留
  const context = anchor.remoteContext || bakJson.webRemoteControlLastEnabledContext || json.webRemoteControlLastEnabledContext;
  if (context) {
    json.webRemoteControlLastEnabledContext = context;
  }

  // ⑥ 更新持久化 Anchor
  try {
    saveAnchor({
      ...anchor,
      ...(targetSid ? { deviceSid: targetSid } : {}),
      projects: json.recentProjects,
      sessions: json.lastWorkspaceSession,
      ...(context ? { remoteContext: context } : {}),
    });
  } catch {}

  try {
    atomicWriteJson(file, json);
    atomicWriteJson(bakFile, json);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 写后回读校验 setting.json：schema 字段合规 + deviceSid 保留 + 项目列表非空 */
function verifySettingWritten() {
  const file = paths().setting;
  const json = readJson(file);
  if (!json) return { ok: false, message: "回读 setting.json 解析失败" };
  if (!Number.isInteger(json.providerFamilyDomainUpdatedAt)) {
    return { ok: false, message: "providerFamilyDomainUpdatedAt 必须为整型，防止 ZCode schema 校验失败" };
  }
  const anchor = getOrCreateAnchor();
  if (anchor.deviceSid && (!json.webRemoteControlExternalRelayDevice || json.webRemoteControlExternalRelayDevice.deviceSid !== anchor.deviceSid)) {
    return { ok: false, message: "远程连接 deviceSid 与本机锚定值不一致" };
  }
  return { ok: true, message: "" };
}

/** 删 coding-plan 套餐缓存（旧账号的套餐缓存会让客户端按错套餐展示） */
function resetPlanCache() {
  try {
    fs.rmSync(paths().planCache, { force: true });
  } catch { /* 不存在即目的达成 */ }
}

/**
 * 把指定 deviceMid 写进 live telemetry-state.json（原子写，保留其它字段）。
 * 【仅限「领取模式」人工窗口调用】该文件是移动端远程连接的设备身份：deviceMid 变更会被
 * relay 判会话冲突踢线（KICKED，客户端只重连不换身份，永不自愈）——所以本函数绝不允许
 * 出现在切号流程里；只有「临时借出指纹领周末套餐 → 领完恢复锚定值」这一条人工链路可用，
 * 且借出期间手机远程不可用，恢复锚定值后即回到服务端绑定的正常状态。
 * mid 为空按「恢复锚定值」语义处理（无锚则派生兜底）；写入后回读校验。
 * 指纹来源不在库里的账号档案中落一份（meta.deviceMid），后续切回来与代理调用继续复用同一枚。
 */
function applyDeviceMid(target) {
  const p = paths().telemetry;
  const cur = readJson(p) || {};
  const oldMid = String(cur.deviceMid || "");
  let mid = String((target && target.deviceMid) || "");
  let persisted = false;
  if (!mid) {
    mid = derivedDeviceMid(String((target && target.accountId) || "") || crypto.randomUUID());
    // 派生兜底发生时把指纹回存账号档案：本次切换与以后所有请求共用同一枚
    try {
      if (target && target.accountId) {
        const store = require("./store.cjs");
        const row = store.getAccount(target.accountId);
        if (row) {
          const meta = typeof row.meta === "string" ? (() => { try { return JSON.parse(row.meta); } catch { return {}; } })() : { ...(row.meta || {}) };
          if (!meta.deviceMid) {
            meta.deviceMid = mid;
            store.updateAccount(row.id, { meta });
            persisted = true;
          }
        }
      }
    } catch { /* 回存失败不阻断切号 */ }
  }
  if (oldMid === mid) return { ok: true, unchanged: true, from: oldMid, to: mid, persisted };
  const next = { ...cur, deviceMid: mid };
  atomicWriteJson(p, next);
  const back = readJson(p);
  if (!back || String(back.deviceMid || "") !== mid) {
    return { ok: false, message: "telemetry-state.json 回读校验失败（deviceMid 未落位）" };
  }
  return { ok: true, from: oldMid, to: mid, persisted };
}

/**
 * 把本机锚定指纹（anchor.remoteMid）写回 live telemetry-state.json——「领取模式」的收尾动作。
 * 锚定值缺失返回失败（没有可恢复的目标）；与现值相同为幂等无操作。
 */
function restoreRemoteMid() {
  const anchor = getOrCreateAnchor();
  const target = String(anchor.remoteMid || "");
  if (!target) return { ok: false, message: "本机锚定指纹不存在（anchor 未初始化 remoteMid），无法恢复" };
  const r = applyDeviceMid({ deviceMid: target });
  if (!r.ok) return r;
  return { ok: true, unchanged: !!r.unchanged, from: r.from, to: r.to, anchorMid: target };
}

/** 领取模式状态速查（同步、零网络）：锚定值 / 当前 live 值 / 是否处于借出（领取模式）中 */
function remoteMidState() {
  const anchor = getOrCreateAnchor();
  const anchorMid = String(anchor.remoteMid || "");
  const liveMid = String((readJson(paths().telemetry) || {}).deviceMid || "");
  return {
    anchorMid,
    anchorSavedAt: Number(anchor.remoteMidSavedAt) || 0,
    liveMid,
    // 借出中 = live 与锚定值不一致（含锚定值缺失时的任何 live 值都视为不可信，由调用方另行引导）
    claimMode: !!(liveMid && anchorMid && liveMid !== anchorMid),
  };
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

// ===== 客户端自带的模型能力表（模态自动识别） =====
/**
 * 官方客户端 zcode-builtin.json 的模型能力规则：
 *   config.modelConfigRules.modelRules[] = { modelMatch: 正则, config.properties.inputFormat:
 *     { supportsText, supportsImage, supportsVideo, supportsAudio, supportsPdf } }
 * 语义（实测）：按文件顺序取**最后一个匹配项**——具体规则覆盖通用规则
 * （如 .*glm-5\.3(?:-flash)? 为 false，紧随其后的 .*glm-5\.3-flash 为 true，与官方客户端实测行为一致）。
 * 这是"某模型是否支持图片输入"最权威的本地来源：官方客户端 UI 即依据它决定能否附图。
 */
let _capCache = { file: "", mtimeMs: 0, rules: [] };

/** 找最新的 zcode-builtin.json（runtime/provider/<平台>/<版本>/endpoint-XXXX/，层级名含版本与 endpoint 哈希，故扫描） */
function findClientBuiltin() {
  const root = path.join(v2Dir(), "runtime", "provider");
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "zcode-builtin.json") {
        try { hits.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* 忽略 */ }
      }
    }
  };
  walk(root, 0);
  hits.sort((a, b) => b.m - a.m);
  return hits[0] || null;
}

/** 读取客户端能力规则（按文件 mtime 缓存）；无文件或结构变化时返回 [] */
function readClientModelRules() {
  const hit = findClientBuiltin();
  if (!hit) return [];
  if (_capCache.file === hit.p && _capCache.mtimeMs === hit.m) return _capCache.rules;
  let rules = [];
  try {
    const j = JSON.parse(fs.readFileSync(hit.p, "utf8"));
    const list = ((((j || {}).config || {}).modelConfigRules) || {}).modelRules || [];
    rules = list
      .map((r) => {
        const cfg = (r || {}).config || {};
        const props = cfg.properties || {};
        const opts = cfg.optionSpecs || {};
        const maxOut = (opts.maxOutputTokens || {}).max;
        return {
          re: (r && r.modelMatch) || "",
          fmt: props.inputFormat || null,
          contextWindow: Number(props.contextWindow) || undefined,
          maxOutputTokens: Number(maxOut) || undefined,
        };
      })
      .filter((r) => r.re);
  } catch { rules = []; }
  _capCache = { file: hit.p, mtimeMs: hit.m, rules };
  return rules;
}

/**
 * 解析模型 id 的元数据（按属性取"最后一个定义该属性的匹配规则"）。
 * 注意：这是**逐属性**覆盖而非整条规则覆盖——官方表里通用规则给窗口/上限，专用规则只补图片/PDF 能力，
 * 例：.*glm-5\.3(?:-flash)? 给 contextWindow=1000000 / maxOutputTokens.max=128000，
 * 其后的 .*glm-5\.3-flash 只给 inputFormat，因此窗口与上限应沿用前者。
 * 返回 { inputFormat, contextWindow, maxOutputTokens }；无匹配返回 null。
 */
function resolveModelMeta(modelId) {
  const id = String(modelId || "");
  if (!id) return null;
  let hit = null;
  for (const r of readClientModelRules()) {
    let re;
    try { re = new RegExp("^(?:" + r.re + ")$", "i"); } catch { continue; }
    if (!re.test(id)) continue;
    hit = {
      inputFormat: r.fmt || (hit && hit.inputFormat) || null,
      contextWindow: r.contextWindow !== undefined ? r.contextWindow : (hit && hit.contextWindow),
      maxOutputTokens: r.maxOutputTokens !== undefined ? r.maxOutputTokens : (hit && hit.maxOutputTokens),
    };
  }
  return hit;
}

/** 兼容旧调用：只要输入模态 */
function resolveModelInputFormat(modelId) {
  const m = resolveModelMeta(modelId);
  return m ? m.inputFormat : null;
}

module.exports = {
  ENC_PREFIX, isEnc, defaultSecret, encDecrypt, encEncrypt, tryDecrypt,
  v2Dir, paths, isNewGen, readJson, atomicWriteJson,
  jwtPayload, uidFromJwt, parseCodingPlanKeyName, parseCredentials, readLive, readProfiles,
  extractConfigApiKeys, pickPlanKey, accountRecord,
  readSwitchSnapshot, buildSwitchSnapshot, seal, unseal,
  anchorPath, readAnchor, saveAnchor, getOrCreateAnchor, findOriginalMidFromBackups,
  mergeWriteCredentials, verifyCredentialsWritten, verifySettingWritten, alignFamilyDomain, resetPlanCache,
  derivedDeviceMid, applyDeviceMid, restoreRemoteMid, remoteMidState,
  isZcodeRunning, killZcode, findZcodeExe, launchZcode,
  readClientModelRules, resolveModelInputFormat, resolveModelMeta,
};
