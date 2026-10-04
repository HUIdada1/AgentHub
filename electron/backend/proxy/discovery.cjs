// 反代网关 · 凭据接入：本机软件导入（首选）→ OAuth 登录（兜底）→ 手动粘贴
//
// 三条渠道各自独立的登录方式（参考 cockpit-tools 的实证口径）：
//   trae        Trae SOLO CN：PKCE(S256) + 本地回环回调 http://127.0.0.1:<port>/authorize
//               登录主机由官方 GetLoginGuidance 下发（失败才用 www.trae.cn 兜底），
//               授权地址必须带 auth_from=solo / hide_saas_login / code_challenge，缺一不可
//   workbuddy   WorkBuddy（中国区）：官方 state 轮询
//   workbuddy_ai WorkBuddy AI（国际版）：同一套 state 轮询，换上游域
//
// 本机导入：
//   WorkBuddy 读 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy*.info
//              （中国区 workbuddy-desktop.info / 国际版 workbuddy-desktop-ai.info，
//                凭据在 auth.accessToken；出现 $wbEncrypted 说明官方已开启加密，如实提示）
//   Trae SOLO CN 读 %APPDATA%\<App>\User\globalStorage\storage.json，
//              iCubeAuthInfo 是 ByteCrypto(AES-128-CBC) 信封，按官方算法离线解开取 JWT
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const util = require("./util.cjs");
const adapters = require("./adapters.cjs");
const raccoonAuth = require("./raccoonAuth.cjs");
const zcodeLocal = require("./zcodeLocal.cjs");
const wbCrypto = require("./wbCrypto.cjs");
const qoderAuth = require("./qoderAuth.cjs");

const OAUTH_PORT = 17388; // 首选回环端口；被占用时退到系统随机端口（授权地址里会带实际端口）
const OAUTH_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 1500;

// ===== 路径工具（跨平台适配：Windows / macOS / Linux） =====

function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(os.homedir(), "AppData", "Local");
}

function roamingAppData() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(os.homedir(), "AppData", "Roaming");
}

function wbAuthCandidateDirs() {
  const dirs = [];
  if (process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  if (process.platform === "darwin") {
    dirs.push(path.join(os.homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  if (process.platform === "linux") {
    if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, "CodeBuddyExtension", "Data", "Public", "auth"));
    dirs.push(path.join(os.homedir(), ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"));
    if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, "CodeBuddyExtension", "Data", "Public", "auth"));
    dirs.push(path.join(os.homedir(), ".config", "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  dirs.push(path.join(localAppData(), "CodeBuddyExtension", "Data", "Public", "auth"));
  return dirs;
}

function wbAuthDir() {
  const candidates = wbAuthCandidateDirs();
  for (const d of candidates) {
    try {
      if (fs.existsSync(d)) return d;
    } catch { /* 忽略权限错误继续 */ }
  }
  return candidates[0];
}

/** Trae 四件套的应用目录名（与官方安装目录同名；渠道只认自己那一份） */
const TRAE_APP_DIRS = {
  // 渠道 trae 代理的就是 Trae SOLO CN；同机上的 Trae / TRAE SOLO 登录态与 SOLO 接口不通用，不混入
  trae: ["TRAE SOLO CN", "Trae", "trae"],
  trae_cn: ["Trae CN", "Trae", "trae"],
  trae_solo_cn: ["TRAE SOLO CN", "Trae", "trae"],
};

function traeStoragePaths(appDirs) {
  const roots = [];
  if (process.env.APPDATA) roots.push(process.env.APPDATA);
  if (process.platform === "darwin") roots.push(path.join(os.homedir(), "Library", "Application Support"));
  if (process.platform === "linux") {
    if (process.env.XDG_CONFIG_HOME) roots.push(process.env.XDG_CONFIG_HOME);
    roots.push(path.join(os.homedir(), ".config"));
  }
  roots.push(roamingAppData());

  const out = [];
  for (const root of roots) {
    for (const n of appDirs) {
      const p = path.join(root, n, "User", "globalStorage", "storage.json");
      try {
        if (fs.existsSync(p) && !out.includes(p)) out.push(p);
      } catch { /* 忽略单个路径异常 */ }
    }
  }
  return out;
}

// ===== Trae ByteCrypto（storage.json 里 iCubeAuthInfo 的信封格式） =====
// 结构：6 字节头 + 32 字节随机 key 材料 + AES-128-CBC(PKCS7) 密文；
// 明文 = SHA512(正文) || 正文。key/iv 由 SHA512(SHA512(key材料) ‖ salt) 的前 32 字节切出，salt = A xor B。
// 两套常量来自官方客户端内置密钥表（与参考项目一致），不做联网获取。

const BC_HEADER_LEN = 6;
const BC_KEY_LEN = 32;
const BC_PREFIX_AES = Buffer.from([116, 99, 5, 16, 0, 0]);
const BC_PREFIX_AES_PRIVATE = Buffer.from([18, 57, 32, 32, 2, 3]);
const BC_AES_A = Buffer.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const BC_AES_B = Buffer.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);
const BC_AES_PRIVATE_A = Buffer.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209]);
const BC_AES_PRIVATE_B = Buffer.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170]);

function sha512(buf) {
  return crypto.createHash("sha512").update(buf).digest();
}

/** 解 ByteCrypto 信封；不是该格式或校验不过返回 null（交给上层走 OAuth） */
function byteCryptoDecrypt(raw) {
  if (!Buffer.isBuffer(raw) || raw.length <= BC_HEADER_LEN + BC_KEY_LEN) return null;
  const header = raw.subarray(0, BC_HEADER_LEN);
  let saltA;
  let saltB;
  if (header.equals(BC_PREFIX_AES)) {
    saltA = BC_AES_A;
    saltB = BC_AES_B;
  } else if (header.equals(BC_PREFIX_AES_PRIVATE)) {
    saltA = BC_AES_PRIVATE_A;
    saltB = BC_AES_PRIVATE_B;
  } else {
    return null;
  }
  const keyMaterial = raw.subarray(BC_HEADER_LEN, BC_HEADER_LEN + BC_KEY_LEN);
  const ciphertext = raw.subarray(BC_HEADER_LEN + BC_KEY_LEN);
  if (!ciphertext.length || ciphertext.length % 16 !== 0) return null;
  const salt = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) salt[i] = saltA[i] ^ saltB[i];
  const merged = crypto.createHash("sha512").update(Buffer.concat([sha512(keyMaterial), salt])).digest();
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", merged.subarray(0, 16), merged.subarray(16, 32));
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (out.length < 64) return null;
    if (!sha512(out.subarray(64)).equals(out.subarray(0, 64))) return null; // 摘要不符 = 密钥不对
    return out.subarray(64);
  } catch {
    return null;
  }
}

/** 值可能是对象 / JSON 字符串 / base64(ByteCrypto)，统一还原成 JSON 值 */
function parseLooseValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* 继续按 ByteCrypto 试 */ }
  try {
    const dec = byteCryptoDecrypt(Buffer.from(text, "base64"));
    if (!dec) return null;
    return JSON.parse(dec.toString("utf8"));
  } catch {
    return null;
  }
}

/** 在对象里按键名正则取第一个字符串/数字值（BFS，比递归 dig 更容易命中浅层） */
function pick(node, re) {
  const v = util.dig(node, re);
  return v == null ? "" : String(v);
}

// ===== 本地扫描：候选凭据 =====

/**
 * 扫描 WorkBuddy 双区的本机登录态。
 * 中国区与国际版共用同一个 auth 目录，靠文件名区分：workbuddy-desktop.info = 中国区，
 * workbuddy-desktop-ai.info = 国际版；目录里还有 workbuddy-desktop.<时间>.<pid>.<uuid>.info
 * 形式的历史快照（以前登录过的别的账号），一并作为候选但不与当前登录态抢位
 */
function scanWorkBuddy() {
  const out = [];
  const dir = wbAuthDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^workbuddy.*\.info$/i.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    const channel = /-ai\.info$/i.test(f) ? "workbuddy_ai" : "workbuddy";
    const isHistory = !/^workbuddy-desktop(-ai)?\.info$/i.test(f);
    {
      try {
        // 官方登出标记：文件还在但已被标记登出，这份快照作废
        if (fs.existsSync(`${full}.logged-out`)) continue;
        const raw = fs.readFileSync(full, "utf8");
        const parsed = (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })();
        // 官方 $wbEncrypted 加密包装：先用内置保护密钥解开（5.6.x 起），解不开才如实标记 encrypted
        let effective = parsed;
        if (parsed && hasEncryptedWrapper(parsed)) {
          const dec = decryptWbFields(parsed);
          if (!dec) {
            out.push({ channel, uid: "", name: "", token: "", refreshToken: "", source: "scan", encrypted: true, file: f });
            continue;
          }
          effective = dec;
        }
        const token = extractWbToken(effective, typeof effective === "string" ? effective : "");
        if (!token) continue;
        const uid = pick(effective, /^(uid|userId|user_id|sub)$/i) || uidFromJwt(token);
        out.push({
          channel,
          uid,
          name: pick(effective, /^(nickname|displayName|userName|name)$/i),
          token,
          refreshToken: pick(effective, /^(refreshToken|refresh_token)$/i),
          expiresAt: util.toMs(pick(effective, /^(expiresAt|expires_at|expiresAtMs)$/i)),
          // WB 头矩阵元数据（X-Domain / X-Enterprise-Id 的真值来源）
          meta: {
            domain: pick(effective, /^(domain|Domain)$/i),
            enterpriseId: pick(effective, /^(enterpriseId|enterprise_id)$/i),
            editionType: pick(effective, /^editionType$/i),
          },
          source: "scan",
          file: isHistory ? `${f}（历史快照）` : f,
        });
      } catch { /* 单个快照坏了不影响其他 */ }
    }
  }
  // 同一渠道同一 uid 只留一份：当前登录态优先于历史快照
  const byKey = new Map();
  for (const c of out) {
    const key = `${c.channel}:${c.uid || c.file}`;
    const cur = byKey.get(key);
    const curIsHistory = !!cur && /（历史快照）/.test(cur.file);
    const nextIsHistory = /（历史快照）/.test(c.file);
    if (!cur || (curIsHistory && !nextIsHistory)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/** 递归找 $wbEncrypted（官方加密包装的标记键） */
function hasEncryptedWrapper(node) {
  if (!node || typeof node !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(node, "$wbEncrypted")) return true;
  return Object.values(node).some((v) => (v && typeof v === "object" ? hasEncryptedWrapper(v) : false));
}

/**
 * 解开官方 $wbEncrypted 字段包装：返回一个「字段已还原为明文」的深度变换结果（原对象不动），
 * 供扫描/写回前读取凭据。保护密钥不可用时返回 null（上层按 encrypted 诚实降级）。
 * 注意：嵌套在加密字符串内部的字段不再二次还原（官方包装粒度就是整个字段值）。
 */
function decryptWbFields(node) {
  if (!wbCrypto.protectorKey()) return null;
  const walk = (n) => {
    if (wbCrypto.isEncryptedWrapper(n)) {
      return wbCrypto.decryptField(n);
    }
    if (Array.isArray(n)) {
      return n.map(walk);
    }
    if (n && typeof n === "object") {
      const out = {};
      for (const [k, v] of Object.entries(n)) out[k] = walk(v);
      return out;
    }
    return n;
  };
  return walk(node);
}

/** 从 auth 文件里取 access token：JSON 走别名递归，裸串走 "<uid>+<token>" 或直接当 token */
function extractWbToken(parsed, raw) {
  const fromJson = parsed ? findTokenInJson(parsed) : "";
  if (fromJson) return normalizeWbToken(fromJson).token;
  const text = String(raw || "").trim();
  if (!text) return "";
  return normalizeWbToken(text).token;
}

function findTokenInJson(node, depth = 0) {
  if (!node || depth > 4) return "";
  if (typeof node === "string") return "";
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findTokenInJson(v, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  for (const key of ["accessToken", "access_token", "token", "jwt"]) {
    const v = node[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const key of ["auth", "session", "data", "account"]) {
    const hit = findTokenInJson(node[key], depth + 1);
    if (hit) return hit;
  }
  return "";
}

/** "<uid>+<token>" → 拆成两段；普通 token 原样返回 */
function normalizeWbToken(raw) {
  const s = String(raw || "").trim().replace(/^Bearer\s+/i, "");
  const plus = s.indexOf("+");
  if (plus > 0 && plus < s.length - 8) {
    const head = s.slice(0, plus);
    const tail = s.slice(plus + 1);
    // 头段是纯 uid（数字/短标识），尾段才是 token
    if (/^[A-Za-z0-9_-]{1,64}$/.test(head) && tail.length > 16) return { uid: head, token: tail };
  }
  return { uid: "", token: s };
}

/** 从 JWT 第二段取 sub（WorkBuddy 客户端按 uid 建目录，sub 即 uid） */
function uidFromJwt(token) {
  const dec = util.jwtDecode(token);
  return dec.uid || "";
}

/**
 * 扫描 Trae 本机登录态：iCubeAuthInfo 走 ByteCrypto 解密拿 JWT，
 * iCubeServerData 的明文商业化 JSON 顺带给出积分与到期，零请求即可预览
 */
function scanTrae() {
  const out = [];
  const channels = { trae: TRAE_APP_DIRS.trae, trae_solo_cn: TRAE_APP_DIRS.trae_solo_cn };
  const seenPaths = new Set();
  for (const [channel, dirs] of Object.entries(channels)) {
    const paths = traeStoragePaths(dirs).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const p of paths) {
      if (seenPaths.has(p)) continue;
      seenPaths.add(p);
      const candidate = readTraeStorage(p, channel);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function readTraeStorage(storagePath, channel) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  } catch {
    return null;
  }
  // provider id 可被租户替换，按前缀动态发现（icube-dc: 是设备密钥，usertag 是标签表）
  const authKey = Object.keys(data).find((k) => /^iCubeAuthInfo:\/\//.test(k) && !/^iCubeAuthInfo:\/\/(usertag|icube-dc)/.test(k));
  let token = "";
  let refreshToken = "";
  let uid = "";
  let name = "";
  let expiresAt = 0;
  let hasEnvelope = false;
  if (authKey) {
    hasEnvelope = true;
    const auth = parseLooseValue(data[authKey]);
    if (auth) {
      token = pick(auth, /^(accesstoken|access_token|token|jwt)$/i);
      refreshToken = pick(auth, /^(refreshtoken|refresh_token)$/i);
      uid = pick(auth, /^(userid|user_id|uid|id)$/i);
      name = pick(auth, /^(nickname|username|name|email)$/i);
      // 官方信封键是 expiredAt（ISO 串，无 s 的 d 结尾），老版本是 expiresAt —— 两种都要认
      expiresAt = util.toMs(pick(auth, /^(expiredat|expiresat|tokenexpireat|expireat)$/i));
      // 旧版把刷新令牌埋在 exchangeResponse.Result 里
      if (!refreshToken) {
        const ex = auth.exchangeResponse || auth.exchange_response;
        refreshToken = pick(ex, /^(refreshtoken|refresh_token)$/i);
      }
    }
  }
  // 明文商业化 JSON：余额 / 订阅名 / 到期（离线即可预览，不必等 OAuth）
  let credits = 0;
  const serverKey = Object.keys(data).find((k) => /^iCubeServerData:\/\//.test(k));
  if (serverKey) {
    const sd = parseLooseValue(data[serverKey]);
    if (sd) {
      credits = Number(util.dig(sd, /remain|balance|credit|quota/i)) || 0;
      if (!expiresAt) expiresAt = util.toMs(util.dig(sd, /expire|end_time|deadline/i));
    }
  }
  // uid 兜底：gtm.users 首条
  if (!uid) {
    const users = parseLooseValue(data["icube_gtm.users"]);
    if (Array.isArray(users) && users.length) uid = String(users[0].uid || users[0].id || "");
  }
  if (!token && !hasEnvelope) return null;
  return {
    channel,
    uid,
    name,
    token,
    refreshToken,
    credits,
    expiresAt,
    source: "scan",
    // true = 检测到登录态但解不开（官方换过密钥表时的诚实降级，引导走 OAuth）
    encrypted: !token && hasEnvelope,
    file: `${path.basename(path.dirname(path.dirname(path.dirname(storagePath))))} · storage.json`,
  };
}

// ===== 商汤小浣熊（Raccoon AI 桌面端）本机登录态扫描 =====
// 登录文件 ~/.box-agent/config/auth.json（明文 JSON：access_token / refresh_token / office_identity）。
// 这是「从本机软件导入」通路的实现（ProxyAgentsView 的 local tab 走 scanAll → 这里）。

/** 小浣熊本地凭据目录（~/.box-agent/config） */
function boxAgentConfigDir() {
  return path.join(os.homedir(), ".box-agent", "config");
}

/** 扫描 ~/.box-agent/config/auth.json：读明文 JWT 与 refresh_token，office_identity 作 meta 存池 */
function scanRaccoon() {
  const out = [];
  const file = path.join(boxAgentConfigDir(), "auth.json");
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return out; // 未安装 / 未登录 / 非 JSON
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const token = String(parsed.access_token || "").trim();
  if (!token) return out;
  const dec = raccoonJwtPayload(token);
  // uid 取小浣熊 JWT 的 iss（账户 ID，十六进制缩写，跨登录稳定 → 号池去重正确）；
  // 缺失才退回 sid（会话 ID，每次登录变化）。util.jwtDecode 只认 data.id/auth_id/sub/user_id，
  // 小浣熊顶层 iss/sid/name 读不出，故本地解析。
  const uid = String(dec.iss || dec.sid || "");
  const name = String(parsed.name || parsed.nickname || dec.name || (uid ? `账号 ${uid}` : ""));
  out.push({
    channel: "raccoon",
    uid,
    name,
    token,
    refreshToken: String(parsed.refresh_token || "").trim(),
    // 余额无到期日（积分分笔到期）；access 3h / refresh 30d，到期由刷新链路自动续
    expiresAt: 0,
    // office_identity 决定是否带 X-Org-Code；sid 存下来供"被顶号"人工排查
    meta: { officeIdentity: String(parsed.office_identity || "").trim(), sid: String(dec.sid || "") },
    source: "scan",
    file: "auth.json",
  });
  return out;
}

/** 小浣熊 JWT payload 本地解析（不进 store，仅扫描用）：读顶层 exp/iss/jti/name/sid */
function raccoonJwtPayload(token) {
  try {
    const t = String(token || "").trim().replace(/^Bearer\s+/i, "");
    const parts = t.split(".");
    if (parts.length < 2) return {};
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

/**
 * Qoder 本机登录态扫描（qoder / qoder_intl 双区）。
 *
 * 凭据来源：%APPDATA%\com.qoder[.cn].app.stable\
 *   ├─ auth.v1.dat  v10 信封（AES-256-GCM），密钥在 Local State 的 os_crypt.encrypted_key
 *   │               （剥 "DPAPI" 魔数后 CryptUnprotectData CurrentUser）——需与客户端同一 Windows 用户
 *   └─ ~/.qoder{,-cn}/.auth/machine_id  设备标识（签名与续期都要用，必须随账号落库）
 *
 * 与 WB 扫描的差异：
 *   · 无 .logged-out 标记、无历史快照——只有当前一份凭据（多账号采集靠分时登录）
 *   · 解密失败多为「AgentHub 与客户端不同 Windows 用户」，如实回报而非静默跳过
 *   · 渠道启用门：未启用的区不产出候选（对齐 store.QODER_INTL_ENABLED）
 */
function scanQoder() {
  const out = [];
  for (const product of Object.keys(qoderAuth.PRODUCTS)) {
    // 渠道启用门：暂停的区不产出候选（避免导入后无法签名的死账号）
    if (!store.CHANNELS.some((c) => c.id === product)) continue;
    const paths = qoderAuth.pathsOf(product);
    if (!paths || !fs.existsSync(paths.authFile)) continue;
    try {
      const c = qoderAuth.readCredentials(product);
      if (!c.token || !c.user || !c.user.id) continue;
      out.push({
        channel: product,
        uid: String(c.user.id),
        name: String(c.user.name || c.user.email || ""),
        token: c.token,
        refreshToken: c.refreshToken,
        expiresAt: c.expiresAt || undefined,
        // machineId 必须随账号入 meta：签名（QoderContext）与续期（deviceToken/refresh）都要用
        meta: { machineId: c.machineId || "", product },
        source: "scan",
        file: `auth.v1.dat（${qoderAuth.PRODUCTS[product].label}）`,
      });
    } catch (e) {
      // 如实回报解密失败原因（常见：与客户端不同 Windows 用户 / 未登录）
      out.push({
        channel: product,
        uid: "",
        name: "",
        token: "",
        refreshToken: "",
        source: "scan",
        encrypted: true,
        file: `auth.v1.dat（${qoderAuth.PRODUCTS[product].label}）：${String((e && e.message) || e).slice(0, 90)}`,
      });
    }
  }
  return out;
}

/** 全量扫描（本机全渠道候选） */
function scanAll() {
  return [...scanTrae(), ...scanWorkBuddy(), ...scanRaccoon(), ...scanZcode(), ...scanQoder()];
}

// ===== ZCode 本机登录态扫描 =====
// 两个来源：① ~/.zcode/v2/credentials.json（当前 live 登录态，enc:v1 全键解密）
//           ② ~/.zcode/v2/account-profiles/profiles.json（官方多账号档案：
//              每档案 cred_file 解密拿 oauth 键，provider_api_keys 明文直接给对话凭据）
// uid 口径：coding-plan 键名里的 account uuid > zcodejwt payload user_id > 档案 user_id。

/** 凭据集 → 扫描候选（token 不回显，proxy_scan 出口已脱敏，导入时按候选标识回读） */
function zcodeCandidateFrom(parsed, extra) {
  const record = zcodeLocal.accountRecord(parsed, extra);
  return {
    channel: "zcode",
    ...record,
    expiresAt: 0, // zcodejwt 无 exp；coding-plan key 长期有效
    source: "scan",
    file: (extra && extra.file) || "credentials.json",
  };
}

function scanZcode() {
  const out = [];
  const seen = new Set();
  // ① 当前 live 登录态
  const live = zcodeLocal.readLive();
  if (live) {
    if (live.jwt || live.codingPlanKeys.length) {
      const c = zcodeCandidateFrom(live, { file: "credentials.json（当前登录）" });
      if (c.uid || c.token || c.refreshToken) {
        out.push(c);
        if (c.uid) seen.add(c.uid);
      }
    } else if (Object.keys(live.raw || {}).length) {
      // 文件存在但主凭据一个都解不开：官方可能换了密钥派生式，诚实降级引导 OAuth
      out.push({ channel: "zcode", uid: "", name: "", token: "", refreshToken: "", source: "scan", encrypted: true, file: "credentials.json" });
    }
  }
  // ② 官方多账号档案（每档案一份凭据快照 + 明文 provider_api_keys）
  for (const prof of zcodeLocal.readProfiles()) {
    const cred = prof.cred;
    if (!cred) continue;
    const jwtFallback = prof.providerApiKeys["builtin:zai-start-plan"] || prof.providerApiKeys["builtin:bigmodel-start-plan"] || "";
    const c = zcodeCandidateFrom(cred, {
      profileApiKeys: prof.providerApiKeys,
      jwtFallback,
      uid: prof.uid,
      name: prof.name,
      email: prof.email,
      avatar: prof.avatar,
      provider: prof.family,
      file: `account-profiles/${prof.file || prof.profileId}`,
    });
    if (!c.uid && !c.token && !c.refreshToken) continue;
    if (c.uid && seen.has(c.uid)) continue; // live 已占位的 uid 不重复出候选
    if (c.uid) seen.add(c.uid);
    out.push(c);
  }
  return out;
}

/**
 * 本机 agent 客户端「当前登录态」速查：渠道 → { uid, name }。
 * 与 scanAll 的差异：只要「正在登录的那一份」，历史快照（WorkBuddy 带时间戳文件）与
 * 多账号档案（ZCode account-profiles）都不算——号池列表用它给账号打「本机登录」徽标。
 *   trae        mtime 最新的 storage.json（iCubeAuthInfo 里的 uid）
 *   workbuddy   workbuddy-desktop.info（非历史快照）
 *   workbuddy_ai workbuddy-desktop-ai.info
 *   raccoon     ~/.box-agent/config/auth.json（JWT iss）
 *   zcode       ~/.zcode/v2/credentials.json（live 登录态）
 */
function currentLocalLogins() {
  const out = {};
  try {
    // traeStoragePaths 已按 mtime 倒序，第一份即本机最近一次使用的登录态
    const hit = traeStoragePaths(TRAE_APP_DIRS.trae)
      .map((p) => readTraeStorage(p, "trae"))
      .find((c) => c && !c.encrypted && c.uid);
    if (hit) out.trae = { uid: hit.uid, name: hit.name || "" };
  } catch { /* 单渠道探测失败不影响其他 */ }
  try {
    for (const c of scanWorkBuddy()) {
      if (c.encrypted || !c.uid) continue;
      if (out[c.channel]) continue;
      if (/（历史快照）/.test(c.file || "")) continue;
      out[c.channel] = { uid: c.uid, name: c.name || "" };
    }
  } catch { /* 同上 */ }
  try {
    const r = scanRaccoon()[0];
    if (r && r.uid) out.raccoon = { uid: r.uid, name: r.name || "" };
  } catch { /* 同上 */ }
  try {
    const live = zcodeLocal.readLive();
    if (live) {
      const rec = zcodeLocal.accountRecord(live, {});
      const uid = String(rec.uid || zcodeLocal.uidFromJwt(live.jwt) || "");
      if (uid) out.zcode = { uid, name: String(rec.name || "") };
    }
  } catch { /* 同上 */ }
  return out;
}

/** 导入扫描结果入池：同渠道同 uid 已存在则更新凭据（刷新 token），否则新建 */
function importCandidate(candidate, channelOverride) {
  const channel = channelOverride || candidate.channel;
  if (!candidate.token && !candidate.refreshToken) {
    // 各渠道的"解不开"含义不同，提示要能指向真正可执行的下一步。
    // Qoder：原因（冒号后的部分）+ 指引（同一 Windows 用户）都给——只给技术原因用户无从下手，
    // 只给指引又会丢掉上游的真实失败信息（例如 os_crypt 前缀异常）。
    const isQoder = channel === "qoder" || channel === "qoder_intl";
    if (candidate.encrypted && isQoder) {
      const reason = String(candidate.file || "").split("：").slice(1).join("：").trim();
      throw new Error(
        `Qoder 登录态解密失败${reason ? `：${reason}` : ""}。请确认 AgentHub 与 Qoder 客户端以同一 Windows 用户运行，且客户端已登录`
      );
    }
    throw new Error(
      candidate.encrypted
        ? "该本地登录态是加密信封，离线解不开，请改用「OAuth 登录」"
        : "该候选不含可用凭据"
    );
  }
  let meta = candidate.meta || {};
  if (channel === "raccoon" && !meta.deviceId) {
    const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${candidate.uid || "anon"}`).digest("hex");
    meta = { ...meta, deviceId: `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}` };
  }
  const existing = store.listAccounts(channel).find((a) => a.uid && a.uid === candidate.uid);
  if (existing) {
    const curMeta = readAccountMeta(existing.id);
    store.updateAccount(existing.id, {
      token: candidate.token,
      refreshToken: candidate.refreshToken || undefined,
      expiresAt: candidate.expiresAt || undefined,
      meta: { ...curMeta, ...meta, deviceId: curMeta.deviceId || meta.deviceId },
      status: "online",
      coolUntil: 0,
      coolReason: "",
    });
    return { id: existing.id, updated: true };
  }
  const id = store.addAccount({
    channel,
    uid: candidate.uid,
    name: candidate.name,
    token: candidate.token,
    refreshToken: candidate.refreshToken,
    source: "scan",
    expiresAt: candidate.expiresAt,
    meta,
  });
  if (channel === "raccoon" && candidate.token && meta.deviceId) {
    bindRaccoonDevice(candidate.token, meta.deviceId).catch(() => {});
  }
  return { id, updated: false };
}

// ===== OAuth 会话（同一时刻只允许一个） =====

let oauthSession = null; // { mode, channel, state, verifier, server?, timer, done, ... }

function traeCfg() {
  return rules.get("headers.json").trae || {};
}

/** 账号级稳定设备指纹：15 位纯数字 deviceId + 64 hex machineId（与对话请求同源） */
function deviceFingerprint(seed) {
  const h = crypto.createHash("sha256").update(String(seed || "")).digest("hex");
  return { deviceId: Array.from(h.replace(/[a-f]/g, "")).slice(0, 15).join("").padEnd(15, "0"), machineId: h };
}

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

/** 从 GetLoginGuidance 响应里取登录主机（字段名各版本不一，宽容取） */
function extractLoginHost(data) {
  const hit = util.dig(data, /^(loginhost|login_host|loginurl|login_url|host)$/i);
  if (!hit) return "";
  let s = String(hit).trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  try {
    return new URL(s).origin;
  } catch {
    return "";
  }
}

/**
 * 官方登录主机下发：POST GetLoginGuidance（CN 三个域依次试），拿不到就用配置里的兜底域。
 * 写死 www.trae.cn 是不够的——不同账号/区域会下发不同的登录域，用错了就是"授权页打不开/登不上"
 */
async function requestLoginGuidance() {
  const c = traeCfg();
  const urls = Array.isArray(c.loginGuidanceUrls) && c.loginGuidanceUrls.length
    ? c.loginGuidanceUrls
    : [
        "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://www.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
      ];
  const trace = util.uuid();
  const body = JSON.stringify({ loginTraceID: trace, login_trace_id: trace });
  for (const u of urls) {
    const r = await adapters
      .httpJson(u, { method: "POST", headers: { "content-type": "application/json", "user-agent": c.userAgent || "TraeClient/TTNet" }, body })
      .catch(() => null);
    const host = r && r.data ? extractLoginHost(r.data) : "";
    if (host) return host;
  }
  return c.loginHost || "https://www.trae.cn";
}

/**
 * 构造授权地址：必须与官方 IDE 同参。
 * auth_from=solo + hide_saas_login 决定落到 SOLO 登录页；缺 code_challenge 会走不了 PKCE；
 * 少 login_channel / plugin_version / 设备字段则被风控当成非官方客户端。
 */
function buildTraeAuthUrl(host, opts) {
  const c = traeCfg();
  const url = new URL("/authorization", host);
  const q = url.searchParams;
  q.set("login_version", "1");
  q.set("auth_from", "solo");
  q.set("login_channel", "native_ide");
  q.set("plugin_version", c.pluginVersion || "local");
  q.set("auth_type", "local");
  q.set("client_id", c.clientId || "en1oxy7wnw8j9n");
  q.set("redirect", "0");
  q.set("login_trace_id", opts.traceId);
  q.set("state", opts.state); // 官方页若原样回传即可强校验（不回传时走 trace_id/回环兜底）
  q.set("auth_callback_url", opts.callbackUrl);
  q.set("machine_id", opts.machineId);
  q.set("device_id", opts.deviceId);
  q.set("x_device_id", opts.deviceId);
  q.set("x_machine_id", opts.machineId);
  q.set("x_device_brand", c.deviceBrand || "CREFG-XX");
  q.set("x_device_type", "windows");
  q.set("x_os_version", c.osVersion || "Windows 11 Home China");
  q.set("x_env", "prod");
  q.set("x_app_version", c.authAppVersion || "3.5.66");
  q.set("x_app_type", "stable");
  q.set("code_challenge", opts.challenge);
  q.set("code_challenge_method", "S256");
  q.set("hide_saas_login", "true");
  return url.toString();
}

const OK_PAGE = (text) => `<meta charset=utf-8><body style="font-family:system-ui,'Microsoft YaHei UI',sans-serif;background:#0b0d0f;color:#44e07f;display:grid;place-items:center;height:100vh;margin:0">${text}</body>`;
const ERR_PAGE = (text) => `<meta charset=utf-8><body style="font-family:system-ui,'Microsoft YaHei UI',sans-serif;background:#0b0d0f;color:#f26d6d;display:grid;place-items:center;height:100vh;margin:0">${text}</body>`;
// 官方授权页登录前会先空参探测回调地址可达性，回 200 挂起页并继续等待。
// 脚本把 fragment 里的参数（#refreshToken=…）转成 query 后自动重载——官方某些回流形态把参数放在 hash 里，
// hash 不会发给服务器，只能靠页面脚本回捞（参考项目 callback_pending_html 同款）
const PENDING_PAGE = `<meta charset=utf-8><body style="font-family:system-ui,'Microsoft YaHei UI',sans-serif;background:#0b0d0f;color:#97a1ac;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div id="hint" style="font-size:14px;line-height:2">正在等待授权结果…<br>请回到官方授权页完成登录，本页将自动完成回调</div><script>(function(){if(window.location.hash&&window.location.hash.length>1){var hash=window.location.hash.slice(1);window.location.replace(window.location.origin+window.location.pathname+'?'+hash);return;}document.getElementById('hint').textContent='未检测到授权参数：请回到官方授权页完成登录；若已登录仍停在本页，请复制地址栏整段链接粘回应用。';})();</script></body>`;

/** 回环服务：绑定首选端口，占用则退到系统随机端口（授权地址里带的是实际端口，不写死） */
function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener("listening", onListening);
      if (e && e.code === "EADDRINUSE") {
        // 首选端口被占：换随机端口再试一次（第二次仍失败才算错）
        server.once("error", reject);
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(e);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(OAUTH_PORT, "127.0.0.1");
  });
}

/**
 * 回调校验（参考项目实证：官方页不回传我们自定义的 state，只回 refreshToken/userInfo/userJwt，
 * 还可能带官方自己的 login_trace_id）。校验只挡明确的外来请求：
 * ① 带 state → 必须与本次会话一致（state 是我们自定义的，官方永不回传，回传了却不一致=外来请求）；
 * ② login_trace_id 不一致 → 参考项目只告警继续处理（官方可能自行改写），不拦截；
 * ③ 都没有 → 回环地址只在本机可达，凭据参数齐全即接受。
 * 校验不通过只拒绝本次请求，不结束会话（本地探测/误打端口不能杀掉正在等待的登录）
 */
function validateTraeCallback(q, session) {
  const state = q.get("state");
  if (state != null && state !== "") {
    return state === session.state ? { ok: true } : { ok: false, message: "state 校验不通过（非本次发起的授权回调）" };
  }
  const traceId = q.get("login_trace_id") || q.get("loginTraceID");
  if (traceId != null && traceId !== "") {
    return traceId === session.traceId ? { ok: true } : { ok: false, message: "login_trace_id 校验不通过（非本次发起的授权会话）" };
  }
  // 既无 state 也无 traceId 时：仅放行须经 PKCE code_verifier 校验的 authCode 模式，杜绝未经授权直接注入裸 Token
  const hasAuthCode = !!(q.get("authCode") || q.get("code") || q.get("authCodeInfo") || q.get("auth_code_info"));
  if (hasAuthCode) {
    return { ok: true };
  }
  return { ok: false, message: "安全拦截：回调缺少会话校验标识（state/login_trace_id），拒绝直接注入裸凭据" };
}

/** 解回调里 URL 编码的 JSON 参数（userInfo / userJwt / authCodeInfo），参考项目 parse_json_param */
function parseJsonParam(raw) {
  if (!raw) return null;
  for (const val of [raw, decodeURIComponent(raw)]) {
    try {
      const obj = JSON.parse(val);
      if (obj && typeof obj === "object") return obj;
    } catch { /* 继续 */ }
  }
  return null;
}

/** authCodeInfo（URL 编码 JSON）里挖授权码，参考项目 extract_auth_code_from_auth_code_info */
function authCodeFromInfo(raw) {
  const info = parseJsonParam(raw);
  if (!info) return "";
  const v = info.AuthCode || info.authCode || info.auth_code || info.code || (info.Result && (info.Result.AuthCode || info.Result.authCode)) || (info.result && (info.result.authCode || info.result.auth_code));
  return v ? String(v) : "";
}

/** 回调参数 → 账号凭据：优先 accessToken，其次 userJwt.Token / refreshToken 换 token，最后 authCode（含 authCodeInfo）换 token。
 *  回调里的 loginHost 优先作为换令牌上游（参考项目用回调 host 选 ExchangeToken 域） */
async function resolveTraeCredentials(q, session) {
  let accessToken = String(q.get("accessToken") || "").replace(/^Cloud-IDE-JWT\s+/i, "");
  let refreshToken = q.get("refreshToken") || "";
  const userInfo = parseJsonParam(q.get("userInfo"));
  const userJwt = parseJsonParam(q.get("userJwt"));
  // 官方回调用 URL 编码的 JSON 承载 userInfo（UserID/ScreenName/TenantID）与 userJwt（Token/RefreshToken）
  if (!refreshToken && userJwt) refreshToken = String(userJwt.RefreshToken || userJwt.refreshToken || userJwt.refresh_token || "");
  if (!accessToken && userJwt) accessToken = String(userJwt.Token || userJwt.token || userJwt.access_token || "").replace(/^Cloud-IDE-JWT\s+/i, "");
  const authCode = q.get("authCode") || q.get("code") || authCodeFromInfo(q.get("authCodeInfo") || q.get("auth_code_info"));
  const cbHost = q.get("loginHost") || q.get("login_host") || q.get("host") || q.get("consoleHost") || "";
  const extra = {
    uid: userInfo ? String(userInfo.UserID || userInfo.user_id || userInfo.uid || "") : "",
    name: userInfo ? String(userInfo.ScreenName || userInfo.nickname || userInfo.name || "") : "",
    tenantId: userInfo ? String(userInfo.TenantID || userInfo.tenant_id || "") : "",
  };
  if (accessToken) return { accessToken, refreshToken, extra };
  const adapter = adapters.get("trae");
  let lastErr = "";
  if (refreshToken) {
    const r = await adapter.refreshToken(null, { token: "", refreshToken }, cbHost ? [cbOrigin(cbHost)] : []);
    if (r.ok) return { accessToken: r.token, refreshToken: r.refreshToken || refreshToken, extra };
    lastErr = r.message || "refreshToken 换取令牌失败";
  }
  if (authCode) {
    const r = await exchangeTraeAuthCode(authCode, session.verifier, cbHost);
    if (r.ok) return { accessToken: r.token, refreshToken: r.refreshToken, extra };
    lastErr = r.message || "授权码换取令牌失败";
  }
  throw new Error(lastErr || "回调未携带凭据（accessToken / refreshToken / authCode 都没有）");
}

/** 回调给的登录主机 → API origin（换令牌候选域的头一个） */
function cbOrigin(host) {
  let s = String(host || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s).origin;
  } catch {
    return "";
  }
}

/** 授权码换令牌：CN 走 /trae/api/v3/oauth/ExchangeToken + PKCE code_verifier；回调带的 loginHost 优先 */
async function exchangeTraeAuthCode(authCode, codeVerifier, cbHost) {
  const c = traeCfg();
  const origins = Array.isArray(c.accountOrigins) && c.accountOrigins.length ? c.accountOrigins : ["https://api.trae.cn", "https://api.trae.com.cn"];
  const o = cbOrigin(cbHost);
  const candidates = [...(o ? [o] : []), ...origins.filter((x) => String(x).replace(/\/+$/, "") !== o)];
  const body = JSON.stringify({
    ClientID: c.clientId || "en1oxy7wnw8j9n",
    AuthCode: authCode,
    CodeVerifier: codeVerifier,
    IDEVersion: c.authAppVersion || "3.5.66",
  });
  let lastMsg = "";
  for (const origin of candidates) {
    const r = await adapters
      .httpJson(`${String(origin).replace(/\/$/, "")}/trae/api/v3/oauth/ExchangeToken`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": c.userAgent || "TraeClient/TTNet", "x-cloudide-token": "" },
        body,
      })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const d = r.data && (r.data.data || r.data);
    const token = d && (d.access_token || d.accessToken);
    if (r.ok && token) {
      return { ok: true, token: String(token).replace(/^Cloud-IDE-JWT\s+/i, ""), refreshToken: String((d.refresh_token || d.refreshToken) || "") };
    }
    lastMsg = (r.data && (r.data.message || r.data.msg)) || r.message || `HTTP ${r.status}`;
  }
  return { ok: false, message: lastMsg };
}

/** 落库：同渠道同 uid 已存在则更新凭据（重复登录/回调重放不产生重复行）。
 *  extra（回调 userInfo 解析出的 uid/昵称/租户）优先于网络查询，省一次 GetUserInfo */
async function saveTraeAccount(accessToken, refreshToken, channel, extra) {
  const adapter = adapters.get("trae");
  const cbUid = String((extra && extra.uid) || "");
  const cbName = String((extra && extra.name) || "");
  const info = cbUid
    ? { uid: cbUid, name: cbName }
    : await adapter.userInfo(accessToken).catch(() => ({ uid: util.jwtDecode(accessToken).uid, name: "" }));
  const uid = String(info.uid || util.jwtDecode(accessToken).uid || cbUid || "");
  const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
  if (existing) {
    store.updateAccount(existing.id, { token: accessToken, refreshToken, status: "online", coolUntil: 0, coolReason: "" });
    return { id: existing.id, uid };
  }
  const id = store.addAccount({
    channel,
    uid,
    name: info.name || cbName || (uid ? `Trae ${String(uid).slice(-6)}` : "Trae 账号"),
    token: accessToken,
    refreshToken,
    source: "oauth",
    meta: extra && extra.tenantId ? { enterpriseId: extra.tenantId } : undefined,
  });
  return { id, uid };
}

// ===== 商汤小浣熊：内嵌授权窗截获深链回调（授权码不经过官方客户端） =====
// 官方登录的收尾是深链回调 office-raccoon://auth/callback?code=xxx（一次性授权码）。
// 在系统浏览器里打开授权页时，这个深链会被操作系统交给本机的官方客户端（或让用户手动选择），
// 授权码被官方客户端消费掉 → AgentHub 既拿不到回调、粘贴同一段 URL 换码还会回 200035
// （授权码不存在/已消费），这就是「oauth 登录收不到回调」的根因。
// 因此这里改为：授权页在 AgentHub 自己的内嵌授权窗里打开，窗口层拦截一切 office-raccoon://
// 跳转、就地提取授权码（不进系统浏览器、不惊动官方客户端）→ 换 token 入池。
// 其余渠道本就不经过深链：trae 回环 HTTP / workbuddy·zcode 服务端轮询，回调天然只到 AgentHub。
// 手动粘贴深链 URL 保留为兜底（窗口被关、页面形态变化时用），复用 oauthSession.submit。

function raccoonCfg() {
  return rules.get("headers.json").raccoon || {};
}

/** 授权码换 token：POST /auth/v1/login_with_authorization_code（会话1 §1.1） */
async function exchangeRaccoonAuthCode(code) {
  const c = raccoonCfg();
  const r = await adapters
    .httpJson(`${String(c.authApiBase || "https://xiaohuanxiong.com/api/web").replace(/\/+$/, "")}/auth/v1/login_with_authorization_code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization_code: String(code || "") }),
    })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  const d = r.data && (r.data.data || r.data);
  const token = d && (d.access_token || d.accessToken);
  if (r.ok && token) {
    return {
      ok: true,
      token: String(token),
      refreshToken: String((d.refresh_token || d.refreshToken) || ""),
      officeIdentity: String(d.office_identity || ""),
    };
  }
  const code200035 = Number((r.data && r.data.code) || 0) === 200035;
  return {
    ok: false,
    message: code200035
      ? "授权码已失效或已被消费（一次性），请回到官方授权页重新登录获取新码"
      : (r.data && (r.data.message || r.data.msg)) || r.message || `HTTP ${r.status}`,
  };
}

/** 绑定可信设备：POST /auth/v1/devices_current_bind（杜绝 200811 device_bind_required） */
async function bindRaccoonDevice(token, deviceId) {
  if (!token || !deviceId) return { ok: false };
  const c = raccoonCfg();
  const base = String(c.authApiBase || "https://xiaohuanxiong.com/api/web").replace(/\/+$/, "");
  const seed = crypto.createHash("sha256").update(deviceId).digest("hex");
  const deviceName = "DESKTOP-" + seed.slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const body = JSON.stringify({
    client_device_id_source: "unknown",
    client_device_id: deviceId,
    client_platform: "desktop-windows",
    client_version: c.clientVersion || "1.0.36",
    device_name: deviceName,
    os: "windows",
    os_version: "10.0.26200",
    application: "desktop",
    push_permission: "unknown",
  });
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "X-Client-Platform": "desktop-windows",
    "X-Client-Device-ID": deviceId,
    "X-Client-Version": c.clientVersion || "1.0.36",
  };
  const r = await adapters.httpJson(`${base}/auth/v1/devices_current_bind`, { method: "POST", headers, body }).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
  return { ok: !!(r && r.ok), data: r && r.data };
}

/** 小浣熊 OAuth：内嵌授权窗 + 深链截获（主操作）；手动粘贴深链 URL（兜底） */
async function beginRaccoonOAuth(channel, onDone, helpers) {
  const state = crypto.randomBytes(16).toString("hex");
  const c = raccoonCfg();
  const authUrl = `${String(c.authPageBase || "https://xiaohuanxiong.com").replace(/\/+$/, "")}/code/authorize?login_source=desktop&appname=${encodeURIComponent(c.authAppName || "办公小浣熊客户端")}`;
  const openWindow = helpers && helpers.openAuthWindow;

  /** 授权码 → 兑换凭据 → 落库（深链截获与手动粘贴共用；opts.keepSession 时提取失败不杀会话，允许重粘） */
  const redeem = async (rawCode, opts) => {
    const code = String(rawCode || "").trim();
    if (!code) {
      const message = "未能从回调里提取授权码，请回到授权页重新登录获取新码";
      if (!(opts && opts.keepSession)) finishOAuth({ ok: false, message });
      return { ok: false, message };
    }
    try {
      const cred = await exchangeRaccoonAuthCode(code);
      if (!cred.ok) {
        finishOAuth({ ok: false, message: cred.message });
        return { ok: false, message: cred.message };
      }
      // uid 从 access_token 的 iss 解（与 scanRaccoon 同口径），office_identity 入 meta
      const uid = raccoonAuth.tokenUid(cred.token) || "";
      const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
      const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${uid || "anon"}`).digest("hex");
      const deviceId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;

      // 官方可信设备绑定：将该 deviceId 注册绑定为该账号的可信设备，彻底杜绝切号或客户端心跳报 200811 device_bind_required
      await bindRaccoonDevice(cred.token, deviceId).catch(() => {});
      if (existing) {
        const curMeta = readAccountMeta(existing.id);
        store.updateAccount(existing.id, {
          token: cred.token,
          refreshToken: cred.refreshToken,
          status: "online",
          coolUntil: 0,
          coolReason: "",
          meta: { ...curMeta, officeIdentity: cred.officeIdentity || "", deviceId: curMeta.deviceId || deviceId },
        });
        finishOAuth({ ok: true, id: existing.id, uid });
        return { ok: true, id: existing.id, uid, updated: true };
      }
      const id = store.addAccount({
        channel,
        uid,
        name: uid ? `账号 ${uid.slice(0, 6)}` : "小浣熊账号",
        token: cred.token,
        refreshToken: cred.refreshToken,
        source: "oauth",
        meta: { officeIdentity: cred.officeIdentity || "", deviceId },
      });
      finishOAuth({ ok: true, id, uid });
      return { ok: true, id, uid, updated: false };
    } catch (e) {
      const msg = String((e && e.message) || e);
      finishOAuth({ ok: false, message: msg });
      return { ok: false, message: msg };
    }
  };

  const session = {
    mode: "window",
    channel,
    state,
    onDone,
    timer: setTimeout(() => finishOAuth({ ok: false, message: "登录超时（3 分钟）" }), OAUTH_TIMEOUT_MS),
    closeWindow: null,
    // 手动兜底：整段粘贴 office-raccoon://auth/callback?code=xxx 深链
    submit: async (rawInput) => {
      if (!oauthSession || oauthSession.channel !== channel) return { ok: false, message: "当前没有进行中的登录" };
      const q = parseCallbackInput(rawInput);
      const code = q && (q.get("code") || q.get("authCode") || q.get("authorization_code"));
      if (!code) return { ok: false, message: "无法从粘贴的内容里提取授权码：请整段复制浏览器地址栏内容（形如 office-raccoon://auth/callback?code=…）" };
      return redeem(code);
    },
  };
  oauthSession = session;

  // 深链 → 授权码（两处截获点共用）：office-raccoon://auth/callback?code=…
  const redeemDeeplink = (deepUrl) => {
    const q = parseCallbackInput(deepUrl);
    const code = q && (q.get("code") || q.get("authCode") || q.get("authorization_code"));
    void redeem(code);
  };

  if (typeof openWindow === "function") {
    const opened = openWindow({
      title: "商汤小浣熊 · 官方授权登录",
      url: authUrl,
      onCaptured: redeemDeeplink,
      // 用户关窗 = 放弃本次登录（已完成兑换的会话在最后一步收尾，不会走到这里）
      onClosed: () => {
        if (oauthSession === session) finishOAuth({ ok: false, message: "已关闭授权窗口，登录未完成" });
      },
    });
    if (!opened || opened.ok === false) {
      const msg = (opened && opened.message) || "授权窗口创建失败";
      finishOAuth({ ok: false, message: msg });
      return { ok: false, message: msg };
    }
    session.closeWindow = opened.close || null;
    session.attachCancel = () => {
      try { if (session.closeWindow) session.closeWindow(); } catch { /* 已关 */ }
    };
  }
  return { ok: true, mode: "window" };
}

// ===== ZCode：服务端中介 CLI 轮询登录（无回环端口） =====
// 流程（复刻官方 3.12.3 startOAuthWithPolling，zcode-api src/auth/oauth.ts 实证）：
//   ① 本机生成 32B hex poll_token，POST /oauth/cli/init {provider} 换 {flow_id, authorize_url}
//   ② 授权地址拼「桌面中转页」参数（zai 用 redirect_uri / bigmodel 用 redirect），浏览器完成授权
//   ③ GET /oauth/cli/poll/{flow_id} 按服务端下发的间隔轮询，ready 得
//      {token(zcodejwt), user, {provider}:{access_token,refresh_token}}
//   ④ 落库后后台跑激活链：business login 触发服务端初始化 billing plan →
//      轮询 plans 就绪 → 解析 coding-plan API key（getCustomerInfo → api_keys find-or-create → copy 取 secret）
// 手动兜底：粘贴 zcode://zai-auth/callback?code=… 深链，走 /oauth/token 授权码兑换。

function zcodeCfg() {
  return rules.get("headers.json").zcode || {};
}

/** ZCode 控制面公共头（控制面带 X-Device-Mid；与 adapters.zcodeCtlHeaders 同构，独立一份防循环依赖） */
function zcodeCtlHeaders(c, bearerToken) {
  const ver = c.appVersion || "4.1.10";
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "User-Agent": `ZCode/${ver}`,
    "HTTP-Referer": c.refererOrigin || "https://zcode.z.ai",
    "X-Title": `Z Code@${c.sourceTitle || "cli"}`,
    "X-ZCode-App-Version": ver,
    "X-Platform": c.platform || "win32-x64",
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Os-Category": "windows",
  };
  const mid = (() => {
    const t = zcodeLocal.readJson(zcodeLocal.paths().telemetry);
    return String((t && t.deviceMid) || "");
  })();
  if (mid) h["X-Device-Mid"] = mid;
  if (bearerToken) h["authorization"] = `Bearer ${bearerToken}`;
  return h;
}

/** 桌面中转页参数：官方客户端在 authorize_url 上拼的 zcode:// 弹跳地址（授权完成服务端落标记，poll 才翻 ready） */
function zcodeInterstitial(c) {
  const u = new URL("/app/oauth/login", c.refererOrigin || "https://zcode.z.ai");
  u.searchParams.set("redirect", "zcode://oauth/callback");
  u.searchParams.set("app_version", c.appVersion || "4.1.10");
  return u.toString();
}

/**
 * Qoder 登录（PKCE 设备码轮询）—— 逆向自客户端 startDeviceFlow()，已实测端点。
 *
 * 与其它渠道的形态差异：
 *   · 不需要回环端口，也不靠 state 轮询换 accessToken——它**直接轮询出完整凭据对**
 *     { token, refresh_token }（即 dt-/drt-），一步到位，比 WB/ZCode 都简单。
 *   · 授权页是 Qoder 官方登录页，用 oauth_callback 参数携带 PKCE 回调地址。
 *
 * 流程（客户端同款）：
 *   ① verifier = 64 位随机；challenge = base64url(sha256(verifier))
 *   ② 打开 {authBase}/users/sign-in?biz_variant=qoder&oauth_callback=<selectAccounts URL>
 *      selectAccounts URL = {authBase}/device/selectAccounts?challenge=&challenge_method=S256
 *                           &nonce=&machine_id=&client_id=
 *   ③ 轮询 GET {openApi}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
 *      · 404 = 用户还没完成登录（客户端同款分支）→ 继续等
 *      · 200 且含 { token, refresh_token } → 成功
 *
 * machine_id 是签名与续期都要用的，必须在此时就取到并落库：
 * 客户端用 native 模块生成；这里复用 qoderAuth 的读取/生成逻辑（同源同口径）。
 */
async function beginQoderOAuth(channel, onDone) {
  const c = qoderAuth.PRODUCTS[channel] || qoderAuth.PRODUCTS.qoder;
  const authBase = String(c.authBase || "https://qoder.cn").replace(/\/+$/, "");
  const openApi = String(c.openApi || "").replace(/\/+$/, "");
  const clientId = c.clientId || "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
  const bizVariant = c.authBizVariant || "qoder";

  const { verifier, challenge } = pkcePair();
  const nonce = util.uuid();
  const machineId = qoderAuth.ensureMachineId(channel);

  const selectUrl = new URL("/device/selectAccounts", authBase);
  selectUrl.searchParams.set("challenge", challenge);
  selectUrl.searchParams.set("challenge_method", "S256");
  selectUrl.searchParams.set("nonce", nonce);
  selectUrl.searchParams.set("machine_id", machineId);
  selectUrl.searchParams.set("client_id", clientId);

  const loginUrl = new URL("/users/sign-in", authBase);
  loginUrl.searchParams.set("biz_variant", bizVariant);
  loginUrl.searchParams.set("oauth_callback", selectUrl.toString());

  const pollUrl = new URL("/api/v1/deviceToken/poll", openApi);
  pollUrl.searchParams.set("nonce", nonce);
  pollUrl.searchParams.set("verifier", verifier);
  pollUrl.searchParams.set("challenge_method", "S256");

  oauthSession = {
    mode: "poll",
    channel,
    state: nonce,
    onDone,
    server: null,
    timer: null,
    intervalMs: 1000, // 客户端常量 V6 = 1000ms
    deadline: Date.now() + OAUTH_TIMEOUT_MS,
  };

  const tick = async () => {
    const session = oauthSession;
    if (!session || session.state !== nonce) return;
    if (Date.now() > session.deadline) {
      finishOAuth({ ok: false, message: "登录超时（3 分钟），请重新发起" });
      return;
    }
    const r = await adapters
      .httpJson(pollUrl.toString(), { method: "GET", headers: { Accept: "application/json" } })
      .catch(() => null);

    // 404 = 尚未完成登录（客户端同款：继续轮询）。网络错误/5xx 也继续等，由 deadline 兜底。
    if (r && r.ok && r.data && typeof r.data.token === "string" && typeof r.data.refresh_token === "string") {
      try {
        const saved = await saveQoderAccount(channel, {
          token: r.data.token,
          refreshToken: r.data.refresh_token,
          machineId,
        });
        finishOAuth({ ok: true, id: saved.id, uid: saved.uid });
      } catch (e) {
        finishOAuth({ ok: false, message: String((e && e.message) || e) });
      }
      return;
    }
    // 明确的终局错误（非 404/408/429 的 4xx）才中止，其余继续等
    if (r && r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 408 && r.status !== 429) {
      finishOAuth({ ok: false, message: `登录轮询失败（HTTP ${r.status}）` });
      return;
    }
    if (oauthSession && oauthSession.state === nonce) session.timer = setTimeout(tick, session.intervalMs);
  };
  oauthSession.timer = setTimeout(tick, 1000);

  return { ok: true, url: loginUrl.toString(), mode: "poll" };
}

/**
 * Qoder OAuth 结果落库。
 * 与扫描导入共用同一套字段口径（meta.machineId 必需；expires_at 落 token 到期）。
 *
 * 两处必须做对（实测踩出来的）：
 *   · uid/name 需拉一次 /api/v1/userinfo——OAuth 轮询只回凭据，不含用户资料；
 *   · 轮询响应**不含到期时间**，故紧接着调一次 refresh 换取 expires_at /
 *     refresh_token_expires_at（顺便验证这对凭据当场可用；refresh 是轮换制，
 *     返回的即最新一代，直接落库）。
 */
async function saveQoderAccount(channel, cred) {
  const c = qoderAuth.PRODUCTS[channel] || qoderAuth.PRODUCTS.qoder;
  let user = {};
  try {
    const r = await adapters.httpJson(new URL("/api/v1/userinfo", c.openApi).toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${cred.token}`, Accept: "application/json", "User-Agent": "Qoder" },
    });
    if (r && r.ok && r.data) user = r.data.user || r.data.data || r.data;
  } catch { /* userinfo 拿不到不阻断登录：uid 缺失时下面兜底 */ }
  const uid = String(user.id || user.user_id || user.uid || "").trim();
  if (!uid) throw new Error("登录成功但取不到账号 uid（userinfo 不可用），请改用「从本机软件导入」");
  const name = String(user.name || user.nickname || user.email || "").trim();
  // userinfo 实测字段：{id, name, username, avatar, source}——**没有独立的 email 字段**，
  // 邮箱是塞在 name 里的（如 "user@example.com"）。故 name 含 @ 时同时当作邮箱记录，
  // 与其它渠道的 meta.email 口径保持一致（UI 会优先显示邮箱）。
  const email = String(user.email || (name.includes("@") ? name : ""));

  // 用 refresh 换取到期时间（轮询响应没有这两个字段）。
  // 失败不阻断登录：没有到期时间的账号仍可用，只是临期预刷新与 PoolSync 仲裁少了依据。
  let token = cred.token;
  let refreshToken = cred.refreshToken;
  let expiresAt = 0;
  let refreshTokenExpiresAt = 0;
  try {
    const rr = await qoderAuth.refreshDeviceToken(channel, refreshToken, cred.machineId);
    if (rr && rr.ok) {
      token = rr.token || token;
      refreshToken = rr.refreshToken || refreshToken;
      expiresAt = rr.expiresAt || 0;
      refreshTokenExpiresAt = rr.refreshTokenExpiresAt || 0;
    }
  } catch { /* 拿不到到期时间不影响入池 */ }

  const existing = store.listAccounts(channel).find((a) => a.uid === uid);
  const meta = { machineId: cred.machineId, product: channel, email, avatar: String(user.avatar || "") };
  if (existing) {
    const oldMeta = readAccountMeta(existing.id);
    store.updateAccount(existing.id, {
      token,
      refreshToken,
      expiresAt: expiresAt || undefined,
      meta: { ...oldMeta, ...meta },
      status: "online",
      coolUntil: 0,
      coolReason: "",
    });
    return { id: existing.id, uid, updated: true };
  }
  const id = store.addAccount({
    channel,
    uid,
    name,
    token,
    refreshToken,
    source: "oauth",
    expiresAt: expiresAt || undefined,
    meta,
  });
  return { id, uid, updated: false };
}

async function beginZcodeOAuth(channel, onDone) {
  const c = zcodeCfg();
  const provider = String(c.oauthProvider || "zai");
  const pollToken = crypto.randomBytes(32).toString("hex");
  const initR = await adapters
    .httpJson(c.oauthInitUrl, {
      method: "POST",
      headers: { ...zcodeCtlHeaders(c, pollToken) },
      body: JSON.stringify({ provider }),
    })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  const d = initR.data && (initR.data.data || initR.data);
  const flowId = d && String(d.flow_id || "");
  const authorizeUrlRaw = d && String(d.authorize_url || "");
  if (!initR.ok || !flowId || !authorizeUrlRaw) {
    const msg = (initR.data && (initR.data.message || initR.data.msg)) || initR.message || `HTTP ${initR.status || 0}`;
    return { ok: false, message: `ZCode 登录初始化失败：${msg}` };
  }
  const intervalMs = Math.max(1000, Number(d.poll_interval_sec) * 1000 || 1500);
  const expiresAt = Number(d.expires_at) * 1000 || 0;
  const authUrl = (() => {
    try {
      const u = new URL(authorizeUrlRaw);
      u.searchParams.set(provider === "zai" ? "redirect_uri" : "redirect", zcodeInterstitial(c));
      return u.toString();
    } catch {
      return authorizeUrlRaw;
    }
  })();

  oauthSession = {
    mode: "poll",
    channel,
    state: flowId,
    pollToken,
    provider,
    intervalMs,
    server: null,
    onDone,
    timer: null,
    deadline: Math.min(Date.now() + OAUTH_TIMEOUT_MS, expiresAt || Date.now() + OAUTH_TIMEOUT_MS),
    // 手动兜底：粘贴 zcode:// 深链回调（授权码换 token）
    submit: async (rawInput) => {
      const text = String(rawInput || "").trim();
      const m = /[?&]code=([^&#]+)/.exec(text);
      if (!m) return { ok: false, message: "无法从粘贴内容提取授权码：请复制形如 zcode://zai-auth/callback?code=… 的整段链接" };
      const state = (/[?&]state=([^&#]+)/.exec(text) || [])[1] || "";
      try {
        const cred = await exchangeZcodeAuthCode(decodeURIComponent(m[1]), decodeURIComponent(state));
        if (!cred.ok) {
          finishOAuth({ ok: false, message: cred.message });
          return { ok: false, message: cred.message };
        }
        const saved = await saveZcodeAccount(channel, cred);
        finishOAuth({ ok: true, id: saved.id, uid: saved.uid });
        return { ok: true, id: saved.id, uid: saved.uid, updated: saved.updated };
      } catch (e) {
        const msg = String((e && e.message) || e);
        finishOAuth({ ok: false, message: msg });
        return { ok: false, message: msg };
      }
    },
  };
  pollZcodeToken();
  return { ok: true, url: authUrl, mode: "poll" };
}

function pollZcodeToken() {
  const session = oauthSession;
  if (!session) return;
  const c = zcodeCfg();
  const tick = async () => {
    if (!oauthSession || oauthSession.state !== session.state) return;
    if (Date.now() > session.deadline) {
      finishOAuth({ ok: false, message: "登录超时（3 分钟）" });
      return;
    }
    const r = await adapters
      .httpJson(`${c.oauthPollBase}/${encodeURIComponent(session.state)}`, {
        method: "GET",
        headers: zcodeCtlHeaders(c, session.pollToken),
      })
      .catch(() => null);
    // 网络错误/5xx/408/429 按 pending 继续等；4xx 其余与信封 code 非 0 是终局错误
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      finishOAuth({ ok: false, message: `登录轮询失败（HTTP ${r.status}）` });
      return;
    }
    if (r && r.ok && r.data) {
      const code = Number(r.data.code ?? 0);
      if (code !== 0) {
        finishOAuth({ ok: false, message: `登录轮询失败（code ${code}）${r.data.message || r.data.msg || ""}` });
        return;
      }
      const d = r.data.data || {};
      const status = String(d.status || "pending");
      if (status === "ready") {
        const p = session.provider === "bigmodel" ? "bigmodel" : "zai";
        const prov = (d[p] && typeof d[p] === "object" ? d[p] : {}) || {};
        const cred = {
          jwt: String(d.token || "").trim(),
          accessToken: String(prov.access_token || "").trim(),
          refreshToken: String(prov.refresh_token || "").trim(),
          provider: p,
          user: d.user && typeof d.user === "object" ? d.user : {},
        };
        if (!cred.jwt || !cred.accessToken) {
          finishOAuth({ ok: false, message: "登录返回缺少凭据字段（token/access_token）" });
          return;
        }
        try {
          const saved = await saveZcodeAccount(session.channel, cred);
          finishOAuth({ ok: true, id: saved.id, uid: saved.uid });
        } catch (e) {
          finishOAuth({ ok: false, message: String((e && e.message) || e) });
        }
        return;
      }
      if (status === "failed") {
        finishOAuth({ ok: false, message: "授权失败，请重新发起登录" });
        return;
      }
    }
    if (oauthSession && oauthSession.state === session.state) oauthSession.timer = setTimeout(tick, session.intervalMs);
  };
  session.timer = setTimeout(tick, session.intervalMs);
}

/** 授权码兑换（手动粘贴 zcode:// 深链的兜底路径） */
async function exchangeZcodeAuthCode(code, state) {
  const c = zcodeCfg();
  const provider = String(c.oauthProvider || "zai");
  const r = await adapters
    .httpJson(c.oauthTokenUrl, {
      method: "POST",
      headers: zcodeCtlHeaders(c, ""),
      body: JSON.stringify({ provider, code, redirect_uri: "zcode://zai-auth/callback", state }),
    })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  const d = r.data && (r.data.data || r.data);
  const jwt = d && String(d.token || d.zcode_token || "").trim();
  const prov = (d && typeof d[provider] === "object" ? d[provider] : null) || d || {};
  const accessToken = String(prov.access_token || prov.accessToken || "").trim();
  if (r.ok && jwt && accessToken) {
    return {
      ok: true,
      jwt,
      accessToken,
      refreshToken: String(prov.refresh_token || prov.refreshToken || "").trim(),
      provider,
      user: (d && d.user) || {},
    };
  }
  return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || r.message || `授权码兑换失败 HTTP ${r.status || 0}` };
}

/** OAuth 凭据落库（同 uid 更新既有行），并后台激活 coding-plan */
async function saveZcodeAccount(channel, cred) {
  const uid = String(cred.user.user_id || cred.user.uid || "") || zcodeLocal.uidFromJwt(cred.jwt);
  const email = String(cred.user.email || "");
  const name = String(cred.user.name || cred.user.nickname || email || (uid ? `ZCode ${uid.slice(0, 6)}` : "ZCode 账号"));
  const deviceMid = (cred.meta && cred.meta.deviceMid) || util.uuid();
  const meta = {
    provider: cred.provider,
    email,
    avatar: String(cred.user.avatar || cred.user.avatar_url || ""),
    deviceMid,
    codingPlanResolved: false,
    sw: {
      accessToken: zcodeLocal.seal(cred.accessToken),
      refreshToken: zcodeLocal.seal(cred.refreshToken),
      userInfo: zcodeLocal.seal(JSON.stringify(cred.user || {})),
      codingPlanKeys: zcodeLocal.seal("[]"),
      relayPassHash: "",
    },
  };
  const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
  let id;
  let updated = false;
  if (existing) {
    // 合并 meta：保留旧 meta 里可能存在的 relayPassHash、历史画像与专属 deviceMid
    const oldMeta = readAccountMeta(existing.id);
    const existingCodingPlanKeys = (oldMeta.sw && oldMeta.sw.codingPlanKeys) ? oldMeta.sw.codingPlanKeys : "";
    const merged = {
      ...oldMeta,
      ...meta,
      deviceMid: oldMeta.deviceMid || meta.deviceMid,
      sw: {
        ...(oldMeta.sw || {}),
        ...meta.sw,
        codingPlanKeys: existingCodingPlanKeys || meta.sw.codingPlanKeys,
        relayPassHash: (oldMeta.sw && oldMeta.sw.relayPassHash) || "",
      },
    };
    store.updateAccount(existing.id, { token: cred.jwt, meta: merged, status: "online", coolUntil: 0, coolReason: "" });
    id = existing.id;
    updated = true;
  } else {
    id = store.addAccount({
      channel,
      uid,
      name,
      token: cred.jwt,
      refreshToken: "",
      source: "oauth",
      meta,
    });
  }
  // 后台激活链：business login 初始化 billing plan → 解析 coding-plan API key（失败不阻塞账号可用性）
  activateZcodeAccount(id, { accessToken: cred.accessToken, jwt: cred.jwt, provider: cred.provider }).catch(() => {});
  return { id, uid, updated };
}

function readAccountMeta(id) {
  try {
    const row = store.getAccount(id);
    const m = JSON.parse((row && row.meta) || "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

/**
 * 登录后激活链（zcode-account-switcher oauth.js + zcode-api resolver.ts 实证）：
 * 新账号必须补 POST z/login 触发服务端初始化 billing plan，否则额度查询/claim 全为空；
 * 然后经 getCustomerInfo → 默认机构/默认项目 → find-or-create「zcode-api-key」→ copy 取 secret
 * 解析出 coding-plan 凭据（{apiKey}.{secret}），写入 refresh_enc 与 meta.sw.codingPlanKeys。
 * 全程后台执行，任何一步失败只标 meta.codingPlanResolved=false（start-plan 通道仍可用）。
 */
async function activateZcodeAccount(accountId, cred) {
  const c = zcodeCfg();
  const mark = (patch) => {
    const meta = readAccountMeta(accountId);
    store.updateAccount(accountId, { meta: { ...meta, ...patch } });
  };
  // ① business login（0/3/10s 三次重试；服务端初始化是异步的）
  for (const delay of [0, 3000, 10000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const r = await adapters
      .httpJson(c.businessLoginUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: cred.accessToken }),
      })
      .catch(() => null);
    const bizToken = r && r.data && (r.data.access_token || r.data.accessToken || (r.data.data && r.data.data.access_token));
    if (r && r.ok && bizToken) {
      cred.bizToken = String(bizToken);
      break;
    }
    if (r && r.data && (r.data.code === 0 || r.data.code === 200 || r.data.success === true)) break; // 成功但无 token：plan 初始化已触发
  }
  // ② 等 billing plans 就绪（1/3/6/15/30/60s 渐进轮询）
  const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
  let plansReady = false;
  for (const delay of [1000, 3000, 6000, 15000, 30000, 60000]) {
    await new Promise((r) => setTimeout(r, delay));
    const r = await adapters
      .httpJson(`${c.billingBase}/billing/current?${qs}`, { method: "GET", headers: zcodeCtlHeaders(c, cred.jwt) })
      .catch(() => null);
    const plans = r && r.data && r.data.data && Array.isArray(r.data.data.plans) ? r.data.data.plans : [];
    if (plans.length) {
      plansReady = true;
      break;
    }
  }
  // ③ coding-plan API key 解析链（bizToken 必需；bigmodel 路直接用 accessToken 作 authorization）
  if (!cred.bizToken && cred.provider === "zai") {
    mark({ codingPlanResolved: false, codingPlanError: "business login 未取到 bizToken" });
    return;
  }
  try {
    const bizBase = cred.provider === "bigmodel" ? c.bigmodelBizBase : c.zaiBizBase;
    const authorization = cred.provider === "bigmodel" ? cred.accessToken : `Bearer ${cred.bizToken}`;
    const bizHeaders = { "content-type": "application/json", authorization };
    const unwrap = (r) => {
      const body = r && r.data;
      const code = body && (body.code ?? body.status);
      if (!r || !r.ok || (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200")) {
        throw new Error((body && (body.msg || body.message)) || `biz API HTTP ${(r && r.status) || 0}`);
      }
      return body.data ?? body;
    };
    const info = unwrap(await adapters.httpJson(`${bizBase}/api/biz/customer/getCustomerInfo`, { method: "GET", headers: bizHeaders }));
    const orgs = Array.isArray(info.organizations) ? info.organizations : Array.isArray(info.orgs) ? info.orgs : [];
    if (!orgs.length) throw new Error("getCustomerInfo 返回无机构");
    const org = orgs.find((o) => String(o.organizationName || o.name || "").includes("默认机构")) || orgs[0];
    const orgId = String(org.organizationId || org.id || org.orgId || "");
    const projects = Array.isArray(org.projects) ? org.projects : [];
    const proj = projects.find((p) => String(p.projectName || p.name || "").includes("默认项目")) || projects[0];
    const projectId = proj && String(proj.projectId || proj.id || "");
    if (!orgId || !projectId) throw new Error("默认机构/默认项目缺失");
    const keysUrl = `${bizBase}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
    let apiKey = "";
    try {
      const list = unwrap(await adapters.httpJson(keysUrl, { method: "GET", headers: bizHeaders }));
      const found = (Array.isArray(list) ? list : []).find((k) => k && k.name === "zcode-api-key" && typeof k.apiKey === "string" && k.apiKey);
      if (found) apiKey = found.apiKey;
    } catch { /* 列表失败走创建 */ }
    if (!apiKey) {
      const created = unwrap(await adapters.httpJson(keysUrl, { method: "POST", headers: bizHeaders, body: JSON.stringify({ name: "zcode-api-key" }) }));
      if (typeof created.apiKey !== "string" || !created.apiKey) throw new Error("API key 创建返回缺 apiKey 字段");
      apiKey = created.apiKey;
    }
    const copy = unwrap(await adapters.httpJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, { method: "GET", headers: bizHeaders }));
    const secret = String(copy.secretKey || copy.secret_key || "");
    if (!secret) throw new Error("API key copy 返回缺 secretKey");
    const fullKey = `${apiKey}.${secret}`;
    const uid = String((store.getAccount(accountId) || {}).uid || "");
    const keyName = `account-provider:coding-plan:account:zai-individual-coding-plan:account:${uid}:api-key`;
    const meta = readAccountMeta(accountId);
    store.updateAccount(accountId, {
      refreshToken: fullKey,
      meta: {
        ...meta,
        codingPlanResolved: true,
        sw: { ...(meta.sw || {}), codingPlanKeys: zcodeLocal.seal(JSON.stringify([{ keyName, plain: fullKey }])) },
      },
    });
  } catch (e) {
    mark({ codingPlanResolved: false, codingPlanError: String((e && e.message) || e).slice(0, 200) });
  }
}

/** Trae SOLO CN：PKCE + 本地回环回调 */
async function beginTraeOAuth(channel, onDone) {
  const state = crypto.randomBytes(16).toString("hex");
  const traceId = util.uuid();
  const { verifier, challenge } = pkcePair();
  const fp = deviceFingerprint(`${channel}:${state}`);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname !== "/authorize") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    handleTraeCallback(u.searchParams, res);
  });

  const handleTraeCallback = async (q, res) => {
    const session = oauthSession;
    if (!session) {
      if (res) res.end(ERR_PAGE("登录会话已结束，请返回应用重新发起"));
      return;
    }
    // 官方页主动报错（error / error_code）：明确失败，结束会话
    const errParam = q.get("error") || q.get("error_code") || q.get("errorCode") || q.get("err");
    if (errParam) {
      const desc = q.get("error_description") || q.get("error_desc") || q.get("errorDescription") || q.get("message") || "";
      const msg = desc ? `授权失败：${errParam}（${desc}）` : `授权失败：${errParam}`;
      if (res) {
        res.statusCode = 400;
        res.end(ERR_PAGE(msg));
      }
      finishOAuth({ ok: false, message: msg });
      return;
    }
    if (q.get("isRedirect") === "false" || q.get("is_redirect") === "false") {
      if (res) {
        res.statusCode = 400;
        res.end(ERR_PAGE("回调参数 isRedirect=false：授权未完成，请回到官方页完成登录"));
      }
      finishOAuth({ ok: false, message: "回调参数 isRedirect=false，授权未完成" });
      return;
    }
    const hasCred = ["accessToken", "access_token", "refreshToken", "refresh_token", "authCode", "auth_code", "authCodeInfo", "auth_code_info", "code", "token"].some((k) => q.get(k));
    if (!hasCred) {
      // 官方授权页在用户登录前会先空参探测回调地址可达性（参考项目实证）：
      // 回 200 挂起页继续等待，绝不能按失败处理——老实现在这里报错并结束会话，
      // 登录完成后真正的回调打进来时服务器已经关了，「登录后无法回调」就是这么来的
      if (res) res.end(PENDING_PAGE);
      return;
    }
    // 校验只挡明确的外来请求；不通过只拒绝本次请求、不结束会话
    const v = validateTraeCallback(q, session);
    if (!v.ok) {
      if (res) {
        res.statusCode = 400;
        res.end(ERR_PAGE(`登录失败：${v.message}`));
      }
      return;
    }
    try {
      const cred = await resolveTraeCredentials(q, session);
      const r = await saveTraeAccount(cred.accessToken, cred.refreshToken, session.channel, cred.extra);
      if (res) res.end(OK_PAGE("登录成功，已加入 Trae 号池，可关闭本页"));
      finishOAuth({ ok: true, id: r.id, uid: r.uid });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (res) res.end(ERR_PAGE(`登录失败：${msg}`));
      finishOAuth({ ok: false, message: msg });
    }
  };

  let port;
  try {
    port = await listenLoopback(server);
  } catch (e) {
    return { ok: false, message: `回环端口监听失败：${(e && e.message) || e}` };
  }
  const callbackUrl = `http://127.0.0.1:${port}/authorize`;
  const host = await requestLoginGuidance();
  const url = buildTraeAuthUrl(host, {
    callbackUrl,
    traceId,
    state,
    challenge,
    deviceId: fp.deviceId,
    machineId: fp.machineId,
  });

  oauthSession = {
    mode: "loopback",
    channel,
    state,
    traceId,
    verifier,
    server,
    host,
    callbackUrl,
    onDone,
    timer: setTimeout(() => finishOAuth({ ok: false, message: "登录超时（3 分钟）" }), OAUTH_TIMEOUT_MS),
    // 手动粘贴回调地址的入口（浏览器没跳到回环地址时的兜底，参考项目同款）
    submit: async (rawInput) => {
      if (!oauthSession) return { ok: false, message: "当前没有进行中的登录" };
      const q = parseCallbackInput(rawInput);
      if (!q) return { ok: false, message: "无法解析回调地址：请整段复制浏览器地址栏内容（需包含 refreshToken / authCode 等参数）" };
      const v = validateTraeCallback(q, oauthSession);
      if (!v.ok) return { ok: false, message: v.message };
      await handleTraeCallback(q, null);
      return { ok: true };
    },
  };
  return { ok: true, url, mode: "loopback", port, host };
}

/** 解析用户粘贴的回调内容：完整 URL / 裸查询串 / 裸 path?query / hash 形态（#refreshToken=…）。
    必须至少带一个凭据字段才算解析成功 —— 否则整段 URL 会被当成一个参数名，静默解析出空值 */
function parseCallbackInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const CRED_KEYS = ["accessToken", "access_token", "refreshToken", "refresh_token", "authCode", "auth_code", "authCodeInfo", "code", "token"];
  const fromQuery = (qs) => {
    const q = new URLSearchParams(qs);
    return CRED_KEYS.some((k) => q.get(k)) ? q : null;
  };
  try {
    const u = new URL(text);
    const fromSearch = fromQuery(u.search);
    if (fromSearch) return fromSearch;
    // 官方部分回流形态把参数放在 #hash 里（参考项目挂起页脚本会把 hash 转成 query 再回打）
    const fromHash = fromQuery(u.hash.replace(/^#/, ""));
    if (fromHash) return fromHash;
    return null;
  } catch { /* 不是完整 URL，继续按裸串解析 */ }
  const qIdx = text.indexOf("?");
  const q = qIdx >= 0 ? fromQuery(text.slice(qIdx + 1)) : null;
  if (q) return q;
  const hIdx = text.indexOf("#");
  return hIdx >= 0 ? fromQuery(text.slice(hIdx + 1)) : null;
}

// ===== WorkBuddy 双区：官方 state 轮询登录 =====

function wbPluginBase(channel) {
  const c = rules.get("headers.json")[channel] || {};
  if (c.pluginBase) return String(c.pluginBase).replace(/\/+$/, "");
  try {
    return new URL(c.chatUrl || c.billingBase || c.origin || "").origin;
  } catch {
    return "";
  }
}

const WB_NO_AUTH_HEADERS = {
  "x-no-authorization": "true",
  "x-no-user-id": "true",
  "x-no-enterprise-id": "true",
  "x-no-department-info": "true",
};

function wbHeaders(channel, extra) {
  const c = rules.get("headers.json")[channel] || {};
  return {
    "content-type": "application/json",
    "user-agent": c.userAgent || "WorkBuddy",
    "origin": wbPluginBase(channel),
    "referer": `${wbPluginBase(channel)}/`,
    ...WB_NO_AUTH_HEADERS,
    ...(extra || {}),
  };
}

/**
 * WorkBuddy 登录：向官方插件端点申请 state 与授权页地址，用户浏览器完成登录后，
 * 本进程按 state 轮询换 token（设备码式，无需回环端口，天然跨网络可用）
 */
async function beginWorkBuddyOAuth(channel, onDone) {
  const base = wbPluginBase(channel);
  if (!base) return { ok: false, message: `渠道 ${channel} 未配置上游域，无法发起登录` };

  const platform = (rules.get("headers.json")[channel] || {}).authPlatform || "workbuddy";
  const r = await adapters
    .httpJson(`${base}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`, { method: "POST", headers: wbHeaders(channel), body: "{}" })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  const d = (r.data && (r.data.data || r.data)) || null;
  const state = d && String(d.state || d.State || "");
  if (!r.ok || !state) {
    return {
      ok: false,
      message: `无法获取登录 state（HTTP ${r.status}）：${(r.data && (r.data.message || r.data.msg)) || r.message || "上游未返回 state"}`,
    };
  }
  const authUrl = String((d && (d.authUrl || d.auth_url || d.url)) || "") || `${base}/login?state=${encodeURIComponent(state)}`;
  const sessionId = util.uuid();
  const url = decorateWorkBuddyAuthUrl(authUrl, channel, sessionId);

  oauthSession = {
    mode: "poll",
    channel,
    state,
    server: null,
    onDone,
    timer: null,
    // 轮询模式的定时器一直在重置，必须用绝对截止时间判超时，否则会无限轮询下去
    deadline: Date.now() + OAUTH_TIMEOUT_MS,
    // poll 模式没有回调地址可粘贴，给个明确提示而不是静默失败
    submit: async () => ({ ok: false, message: "WorkBuddy 登录无需粘贴回调地址，请在浏览器完成授权后回到本窗口等待" }),
  };
  pollWorkBuddyToken(base, channel, state);
  return { ok: true, url, mode: "poll" };
}

/** 授权页追加客户端版本与登录会话 id（官方桌面客户端恒带这两个参数） */
function decorateWorkBuddyAuthUrl(authUrl, channel, sessionId) {
  const c = rules.get("headers.json")[channel] || {};
  if (!c.clientVersion) return authUrl;
  try {
    const u = new URL(authUrl);
    u.searchParams.set("version", String(c.clientVersion));
    u.searchParams.set("loginSessionId", sessionId);
    return u.toString();
  } catch {
    return authUrl;
  }
}

function pollWorkBuddyToken(base, channel, state) {
  const tick = async () => {
    if (!oauthSession || oauthSession.state !== state) return; // 已取消或已结束
    if (oauthSession.deadline && Date.now() > oauthSession.deadline) {
      finishOAuth({ ok: false, message: "登录超时（3 分钟）" });
      return;
    }
    const r = await adapters
      .httpJson(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { method: "GET", headers: wbHeaders(channel) })
      .catch(() => null);
    const d = r && r.data ? r.data.data || r.data : null;
    const code = Number((r && r.data && r.data.code) ?? 0);
    const token = d && (d.accessToken || d.access_token);
    if (r && r.ok && token && (code === 0 || code === 200)) {
      try {
        const saved = await saveWorkBuddyAccount(channel, base, state, {
          token: String(token),
          refreshToken: String(d.refreshToken || d.refresh_token || ""),
          expiresAt: tokenExpiry(d),
          domain: String(d.domain || ""),
          tokenType: String(d.tokenType || "Bearer"),
        });
        finishOAuth({ ok: true, id: saved.id, uid: saved.uid });
      } catch (e) {
        finishOAuth({ ok: false, message: String((e && e.message) || e) });
      }
      return;
    }
    if (oauthSession && oauthSession.state === state) oauthSession.timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  if (oauthSession) oauthSession.timer = setTimeout(tick, POLL_INTERVAL_MS);
}

function tokenExpiry(d) {
  const explicit = util.toMs(d.expiresAt ?? d.expires_at);
  if (explicit) return explicit;
  const secs = Number(d.expiresIn ?? d.expires_in ?? 0);
  return secs > 0 ? Date.now() + secs * 1000 : 0;
}

/** 换到 token 后补齐账号信息（uid / 昵称 / 企业），并落库 */
async function saveWorkBuddyAccount(channel, base, state, cred) {
  const info = await fetchWorkBuddyAccount(base, channel, state, cred.token).catch(() => null);
  const uid = String((info && info.uid) || uidFromJwt(cred.token) || "");
  const name = String((info && info.name) || uid || "WorkBuddy 账号");
  const meta = {
    domain: String((info && info.domain) || cred.domain || ""),
    enterpriseId: String((info && info.enterpriseId) || ""),
    tokenType: cred.tokenType || "Bearer",
  };
  const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
  if (existing) {
    store.updateAccount(existing.id, {
      token: cred.token,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt || undefined,
      meta,
      status: "online",
      coolUntil: 0,
      coolReason: "",
    });
    return { id: existing.id, uid };
  }
  const id = store.addAccount({
    channel,
    uid,
    name,
    token: cred.token,
    refreshToken: cred.refreshToken,
    source: "oauth",
    expiresAt: cred.expiresAt,
    meta,
  });
  return { id, uid };
}

async function fetchWorkBuddyAccount(base, channel, state, token) {
  const r = await adapters.httpJson(`${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    method: "GET",
    headers: { ...wbHeaders(channel), authorization: `Bearer ${token}` },
  });
  const d = r.data && (r.data.data || r.data);
  if (!r.ok || !d) return null;
  return {
    uid: String(d.uid || d.userId || d.user_id || ""),
    name: String(d.nickname || d.name || d.email || ""),
    enterpriseId: String(d.enterpriseId || d.enterprise_id || ""),
    domain: String(d.domain || ""),
  };
}

// ===== 会话收尾 =====

function finishOAuth(result) {
  const session = oauthSession;
  if (!session) return;
  oauthSession = null;
  if (session.timer) clearTimeout(session.timer);
  if (session.server) {
    try {
      session.server.close();
    } catch { /* 已关 */ }
  }
  // 收尾副作用（如小浣熊授权窗：登录结束一律关窗，无论成功/失败/超时）
  if (typeof session.attachCancel === "function") {
    try { session.attachCancel(result); } catch { /* 收尾异常不吞掉登录结果 */ }
  }
  try {
    session.onDone(result);
  } catch { /* 回调里的异常不吞掉登录结果 */ }
}

/**
 * 开始 OAuth：按渠道选流程
 * @returns {Promise<{ok:boolean,url?:string,message?:string,mode?:string}>} url 由主进程 shell.openExternal 打开
 */
async function beginOAuth(channel, onDone, helpers) {
  const ch = String(channel || "trae");
  if (oauthSession) throw new Error("已有进行中的登录，请先完成或取消");
  if (!adapters.get(ch)) throw new Error(`未知渠道 ${ch}`);
  if (ch === "raccoon") return beginRaccoonOAuth(ch, onDone, helpers);
  if (ch === "trae") return beginTraeOAuth(ch, onDone);
  if (ch === "zcode") return beginZcodeOAuth(ch, onDone);
  if (ch === "qoder" || ch === "qoder_intl") return beginQoderOAuth(ch, onDone);
  return beginWorkBuddyOAuth(ch, onDone);
}

/** 手动提交回调地址（浏览器没跳回回环地址时的兜底路径） */
async function submitCallbackUrl(input, channel) {
  const session = oauthSession;
  if (!session) return { ok: false, message: "当前没有进行中的登录" };
  if (channel && session.channel !== channel) return { ok: false, message: "进行中的登录属于其他渠道" };
  if (typeof session.submit !== "function") return { ok: false, message: "该渠道不支持手动提交回调地址" };
  return session.submit(input);
}

function cancelOAuth() {
  const session = oauthSession;
  if (!session) return false;
  oauthSession = null;
  if (session.timer) clearTimeout(session.timer);
  if (session.server) {
    try {
      session.server.close();
    } catch { /* 已关 */ }
  }
  if (typeof session.attachCancel === "function") {
    try { session.attachCancel({ ok: false, cancelled: true }); } catch { /* 已关 */ }
  }
  return true;
}

module.exports = {
  scanAll,
  scanWorkBuddy,
  scanTrae,
  scanZcode,
  currentLocalLogins,
  importCandidate,
  beginOAuth,
  submitCallbackUrl,
  cancelOAuth,
  bindRaccoonDevice,
  byteCryptoDecrypt,
  validateTraeCallback,
  OAUTH_PORT,
  wbAuthDir,
  wbAuthCandidateDirs,
  traeStoragePaths,
};
