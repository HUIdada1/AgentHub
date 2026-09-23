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

const OAUTH_PORT = 17388; // 首选回环端口；被占用时退到系统随机端口（授权地址里会带实际端口）
const OAUTH_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 1500;

// ===== 路径工具 =====

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}
function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}
function wbAuthDir() {
  return path.join(localAppData(), "CodeBuddyExtension", "Data", "Public", "auth");
}

/** Trae 四件套的应用目录名（与官方安装目录同名；渠道只认自己那一份） */
const TRAE_APP_DIRS = {
  // 渠道 trae 代理的就是 Trae SOLO CN；同机上的 Trae / TRAE SOLO 登录态与 SOLO 接口不通用，不混入
  trae: ["TRAE SOLO CN"],
  trae_cn: ["Trae CN"],
  trae_solo_cn: ["TRAE SOLO CN"],
};
function traeStoragePaths(appDirs) {
  return appDirs
    .map((n) => path.join(roamingAppData(), n, "User", "globalStorage", "storage.json"))
    .filter((p) => fs.existsSync(p));
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
        // 官方已启用 $wbEncrypted 加密包装时解不开，如实标记而不是塞一个坏 token
        if (parsed && hasEncryptedWrapper(parsed)) {
          out.push({ channel, uid: "", name: "", token: "", refreshToken: "", source: "scan", encrypted: true, file: f });
          continue;
        }
        const token = extractWbToken(parsed, raw);
        if (!token) continue;
        const uid = pick(parsed, /^(uid|userId|user_id|sub)$/i) || uidFromJwt(token);
        out.push({
          channel,
          uid,
          name: pick(parsed, /^(nickname|displayName|userName|name)$/i),
          token,
          refreshToken: pick(parsed, /^(refreshToken|refresh_token)$/i),
          expiresAt: util.toMs(pick(parsed, /^(expiresAt|expires_at|expiresAtMs)$/i)),
          // WB 头矩阵元数据（X-Domain / X-Enterprise-Id 的真值来源）
          meta: {
            domain: pick(parsed, /^(domain|Domain)$/i),
            enterpriseId: pick(parsed, /^(enterpriseId|enterprise_id)$/i),
            editionType: pick(parsed, /^editionType$/i),
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

/** 全量扫描（本机四渠道候选） */
function scanAll() {
  return [...scanTrae(), ...scanWorkBuddy(), ...scanRaccoon()];
}

/** 导入扫描结果入池：同渠道同 uid 已存在则更新凭据（刷新 token），否则新建 */
function importCandidate(candidate, channelOverride) {
  const channel = channelOverride || candidate.channel;
  if (!candidate.token) {
    throw new Error(
      candidate.encrypted
        ? "该本地登录态是加密信封，离线解不开，请改用「OAuth 登录」"
        : "该候选不含可用凭据"
    );
  }
  const existing = store.listAccounts(channel).find((a) => a.uid && a.uid === candidate.uid);
  if (existing) {
    store.updateAccount(existing.id, {
      token: candidate.token,
      refreshToken: candidate.refreshToken || undefined,
      expiresAt: candidate.expiresAt || undefined,
      meta: candidate.meta || undefined,
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
    meta: candidate.meta,
  });
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
  return { ok: true };
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

// ===== 商汤小浣熊：授权码 + 手动粘贴回调 URL =====
// 官方登录走客户端深链回调（office-raccoon://auth/callback?code=xxx），AgentHub 无法代收深链；
// 但授权页（/code/authorize）可以在浏览器打开，用户登录后复制地址栏的深链 URL 粘回来，
// 从 URL 里提取一次性授权码，调 /auth/v1/login_with_authorization_code 换 token。
// 与 Trae 的「手动粘贴回调地址」兜底路径完全同构，复用 oauthSession.submit。

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

/** 小浣熊 OAuth：打开官方授权页，用户登录后复制地址栏深链 URL 粘回完成兑换 */
async function beginRaccoonOAuth(channel, onDone) {
  const state = crypto.randomBytes(16).toString("hex");
  const c = raccoonCfg();
  const authUrl = `${String(c.authPageBase || "https://xiaohuanxiong.com").replace(/\/+$/, "")}/code/authorize?login_source=desktop&appname=${encodeURIComponent(c.authAppName || "办公小浣熊客户端")}`;

  oauthSession = {
    mode: "manual",
    channel,
    state,
    onDone,
    timer: setTimeout(() => finishOAuth({ ok: false, message: "登录超时（3 分钟）" }), OAUTH_TIMEOUT_MS),
    // 用户粘贴地址栏深链 URL（office-raccoon://auth/callback?code=xxx）完成登录
    submit: async (rawInput) => {
      if (!oauthSession || oauthSession.channel !== channel) return { ok: false, message: "当前没有进行中的登录" };
      const q = parseCallbackInput(rawInput);
      const code = q && (q.get("code") || q.get("authCode") || q.get("authorization_code"));
      if (!code) return { ok: false, message: "无法从粘贴的内容里提取授权码：请整段复制浏览器地址栏内容（形如 office-raccoon://auth/callback?code=…）" };
      try {
        const cred = await exchangeRaccoonAuthCode(code);
        if (!cred.ok) {
          finishOAuth({ ok: false, message: cred.message });
          return { ok: false, message: cred.message };
        }
        // uid 从 access_token 的 iss 解（与 scanRaccoon 同口径），office_identity 入 meta
        const uid = raccoonAuth.tokenUid(cred.token) || "";
        const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
        if (existing) {
          store.updateAccount(existing.id, {
            token: cred.token,
            refreshToken: cred.refreshToken,
            status: "online",
            coolUntil: 0,
            coolReason: "",
            meta: { officeIdentity: cred.officeIdentity || "" },
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
          meta: { officeIdentity: cred.officeIdentity || "" },
        });
        finishOAuth({ ok: true, id, uid });
        return { ok: true, id, uid, updated: false };
      } catch (e) {
        const msg = String((e && e.message) || e);
        finishOAuth({ ok: false, message: msg });
        return { ok: false, message: msg };
      }
    },
  };
  return { ok: true, url: authUrl, mode: "manual" };
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
  try {
    session.onDone(result);
  } catch { /* 回调里的异常不吞掉登录结果 */ }
}

/**
 * 开始 OAuth：按渠道选流程
 * @returns {Promise<{ok:boolean,url?:string,message?:string,mode?:string}>} url 由主进程 shell.openExternal 打开
 */
async function beginOAuth(channel, onDone) {
  const ch = String(channel || "trae");
  if (oauthSession) throw new Error("已有进行中的登录，请先完成或取消");
  if (!adapters.get(ch)) throw new Error(`未知渠道 ${ch}`);
  if (ch === "raccoon") return beginRaccoonOAuth(ch, onDone);
  if (ch === "trae") return beginTraeOAuth(ch, onDone);
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
  return true;
}

module.exports = {
  scanAll,
  scanWorkBuddy,
  scanTrae,
  importCandidate,
  beginOAuth,
  submitCallbackUrl,
  cancelOAuth,
  byteCryptoDecrypt,
  OAUTH_PORT,
  wbAuthDir,
  traeStoragePaths,
};
