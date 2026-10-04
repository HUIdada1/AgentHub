// 反代网关 · Qoder 凭据层（qoder / qoder_intl 双渠道共用）
//
// 凭据形态（2026-10 实测 0.4.3）：
//   %APPDATA%\com.qoder[.cn].app.stable\Local State  → os_crypt.encrypted_key
//     （base64；剥 5 字节 "DPAPI" 魔数后 CryptUnprotectData(CurrentUser) → 32B AES-256 key）
//   %APPDATA%\com.qoder[.cn].app.stable\auth.v1.dat  → "v10" + nonce(12B) + ciphertext + tag(16B)
//     （AES-256-GCM 解密 → { schemaVersion, token:"dt-…", refreshToken:"drt-…",
//        expiresAt, refreshTokenExpiresAt, user:{id,name,email,phone,avatarUrl} }）
//
// 与 WorkBuddy 的关键差异：
//   · WB 是 JWT（本地可解 exp）；Qoder 的 dt-/drt- 不是 JWT，**到期时间只能从文件/刷新响应读**，
//     因此 expires_at 必须显式落库（否则 credits.cjs 的临期预刷新会静默失效）。
//   · WB 有 .logged-out 标记与历史快照；Qoder 只有当前一份凭据（无考古能力）。
//   · refresh_token 为轮换制：刷新返回新 dt-+drt-，旧 drt- 宽限期内仍可用一次（实测）。
//
// DPAPI 调用方式：Electron 主进程无内置 CryptUnprotectData，走 powershell.exe 一次性进程
// （实测可用；后续可换原生模块优化启动耗时）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const qoderInstall = require("./qoderInstall.cjs");

/** 双渠道目录定义：appId 目录名 + 用户主目录 + 产品 id */
const PRODUCTS = {
  // exeLabel：客户端安装目录名（安装定位见 qoderInstall.cjs：默认路径 / launcher 版本目录 / 注册表兜底）
  // OAuth（PKCE 设备码）常量来自客户端主进程逆向：authBaseUrl / authClientIds.prod / authBizVariant
  qoder: {
    label: "Qoder CN", appDir: "com.qodercn.app.stable", homeDir: ".qoder-cn",
    openApi: "https://openapi.qoder.com.cn", gateway: "https://gateway.qoder.com.cn", exeLabel: qoderInstall.EXE_LABELS.qoder,
    authBase: "https://qoder.cn", clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa", authBizVariant: "qoder",
  },
  qoder_intl: {
    label: "Qoder International", appDir: "com.qoder.app.stable", homeDir: ".qoder",
    openApi: "https://openapi.qoder.sh", gateway: "https://api2.qoder.sh", exeLabel: qoderInstall.EXE_LABELS.qoder_intl,
    authBase: "https://qoder.com", clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa", authBizVariant: "qoder",
  },
};

function roamingDir() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}
function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

/** 渠道 → 本机路径集合；不存在返回 null（探测用） */
function pathsOf(product) {
  const p = PRODUCTS[product];
  if (!p) return null;
  const appData = path.join(roamingDir(), p.appDir);
  const home = path.join(homeDir(), p.homeDir);
  return {
    appData,
    home,
    authFile: path.join(appData, "auth.v1.dat"),
    localState: path.join(appData, "Local State"),
    machineIdFile: path.join(home, ".auth", "machine_id"),
    catalogDir: path.join(home, ".models"),
    projectsDir: path.join(home, "projects"),
  };
}

/**
 * 风控身份（Cosy-MachineToken/Type/Code）—— 由客户端自带的 runtime-info.exe 生成。
 *
 * 为什么必须用它：领取/活动接口会校验这组头，且**缺失或伪造会导致服务端静默降级**
 * （实测：不带 Cosy-ClientType 时 campaigns 返回 claimable:false，看似"没有活动"）。
 * 我们不做逆向——直接调用客户端自己的生成器（与推理链的 wasm 签名器是两套独立机制）。
 *
 * 调用方式（从主进程逆向所得）：
 *   runtime-info.exe --account-stdin      stdin: {"account":"<uid>"}
 *   stdout: {"machineToken":"...","machineType":"...","machineCode":"...","vmInfo":{...}}
 */
function riskIdentityPath(product) {
  const p = PRODUCTS[product];
  if (!p || !p.exeLabel) return "";
  // 安装目录按多候选定位（默认路径 / launcher 版本目录 / 注册表兜底）——
  // 硬编码 %LOCALAPPDATA%\Programs 会在 launcher/自定义路径安装上找不到 runtime-info.exe
  return qoderInstall.runtimeInfoPath(product);
}
/**
 * 取（必要时生成）machine_id。
 * 客户端用 native 模块生成；这里保持同源口径：
 *   ① 优先读客户端已写的 ~/.qoder[-cn]/.auth/machine_id（与桌面端一致，签名才同源）
 *   ② 没有则生成一个 UUID 落盘（OAuth 登录时客户端可能未装，不能因此卡住登录）
 * 注意 machine_id 实测**不被服务端强校验**（伪值也能推理），但仍应尽量与桌面端一致，
 * 以免风控侧出现同一账号两个设备标识。
 */
function ensureMachineId(product) {
  const p = pathsOf(product);
  if (!p) return crypto.randomUUID();
  try {
    const cur = fs.readFileSync(p.machineIdFile, "utf8").trim();
    if (cur) return cur;
  } catch { /* 未登录/未安装 */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(p.machineIdFile), { recursive: true });
    fs.writeFileSync(p.machineIdFile, id, "utf8");
  } catch { /* 写不进去就用内存值，不阻断登录 */ }
  return id;
}

/**
 * 风控身份缓存 —— 按 **product**（而非 uid）缓存。
 *
 * 实测（2026-10-04）：runtime-info.exe 生成的是**机器级**身份，与账号无关——
 * 传入真实 uid / 假 uid / 空 uid，返回的 machineToken 完全相同（type/code 亦同），
 * 仅 accountOutcome 字段变化（空 uid → invalid_input）。且单次耗时约 3.6s（固有成本）。
 * 因此 N 个 Qoder 账号只需生成一次，按 uid 缓存会白白付出 N×3.6s。
 *
 * TTL 用 10 分钟：客户端自身对风控身份有 scheduleRefresh，这里只做去抖，
 * 不改变"每次领取都由服务端重新鉴权"的语义。
 */
const RISK_CACHE_TTL_MS = 10 * 60 * 1000;
const riskCache = new Map(); // product -> { at, value }

function readRiskIdentity(product, uid) {
  const exe = riskIdentityPath(product);
  if (!exe || !fs.existsSync(exe)) return null;
  const hit = riskCache.get(product);
  if (hit && Date.now() - hit.at < RISK_CACHE_TTL_MS) return hit.value;
  try {
    const out = execFileSync(exe, ["--account-stdin"], {
      input: JSON.stringify({ account: String(uid || "") }),
      encoding: "utf8",
      timeout: 20000, // 实测单次约 3.6s；留足余量（慢机器/杀软扫描时会更长）
      windowsHide: true,
      maxBuffer: 1 << 20,
    }).trim();
    if (!out) return null;
    const j = JSON.parse(out);
    if (!j || typeof j.machineToken !== "string" || !j.machineToken) return null;
    const value = { machineToken: j.machineToken, machineType: j.machineType || "", machineCode: j.machineCode || "", vmInfo: j.vmInfo || null };
    riskCache.set(product, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/** 清空风控缓存（切号/退出登录后调用；按 product 缓存故一并清理） */
function clearRiskCache() {
  riskCache.clear();
}

/** 客户端是否安装（本机导入与切号按钮的可用性判据，对齐 ideStatus 先例） */
function detect(product) {
  const p = pathsOf(product);
  if (!p) return null;
  return fs.existsSync(p.authFile) || fs.existsSync(p.appData) ? p : null;
}

function detectAll() {
  const out = {};
  for (const id of Object.keys(PRODUCTS)) out[id] = !!detect(id);
  return out;
}

// ===== DPAPI（powershell 一次性进程）=====

let dpapiCache = null;

/**
 * 用 powershell.exe 调 CryptUnprotectData（CurrentUser）解出 32B AES key。
 * 输入：Local State 的 os_crypt.encrypted_key（base64，含 "DPAPI" 前缀）。
 * 返回 Buffer(32)；失败抛错（调用方降级为「无法解密，请确认 AgentHub 与客户端同一 Windows 用户」）。
 */
function dpapiUnprotectKey(b64) {
  if (dpapiCache && dpapiCache.b64 === b64) return dpapiCache.key;
  const raw = Buffer.from(b64, "base64");
  const magic = raw.subarray(0, 5).toString("ascii");
  if (magic !== "DPAPI") throw new Error(`os_crypt 前缀异常：${magic}`);
  const wrapped = raw.subarray(5); // CryptUnprotectData 吃的是 DPAPI blob，不含 "DPAPI" 魔数
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security | Out-Null",
    `$b=[Convert]::FromBase64String('${wrapped.toString("base64")}')`,
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($k)",
  ].join("; ");
  let out = "";
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    }).trim();
  } catch (e) {
    throw new Error(`DPAPI 解密失败（需与 Qoder 客户端同一 Windows 用户）：${String((e && e.message) || e).slice(0, 120)}`);
  }
  const key = Buffer.from(out, "base64");
  if (key.length !== 32) throw new Error(`DPAPI 返回密钥长度异常：${key.length}`);
  dpapiCache = { b64, key };
  return key;
}

// ===== v10 信封（AES-256-GCM）=====

function decryptV10(blob, key) {
  if (blob.subarray(0, 3).toString("ascii") !== "v10") throw new Error("auth.v1.dat 魔数异常（非 v10 信封）");
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(15, blob.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function encryptV10(plain, key) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from("v10", "ascii"), nonce, ct, c.getAuthTag()]);
}

// ===== 读 / 写凭据 =====

/** 读渠道凭据：{ token, refreshToken, expiresAt(ms), refreshTokenExpiresAt(ms), user, machineId } */
function readCredentials(product) {
  const p = pathsOf(product);
  if (!p) throw new Error(`未知渠道 ${product}`);
  if (!fs.existsSync(p.authFile)) throw new Error(`${PRODUCTS[product].label} 未登录（找不到 auth.v1.dat）`);
  const ls = JSON.parse(fs.readFileSync(p.localState, "utf8"));
  const encKey = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!encKey) throw new Error("Local State 缺少 os_crypt.encrypted_key");
  const key = dpapiUnprotectKey(encKey);
  const store = JSON.parse(decryptV10(fs.readFileSync(p.authFile), key).toString("utf8"));
  let machineId = "";
  try {
    machineId = fs.readFileSync(p.machineIdFile, "utf8").trim();
  } catch { /* 缺失时由调用方生成/留空 */ }
  return {
    token: String(store.token || ""),
    refreshToken: String(store.refreshToken || ""),
    expiresAt: Date.parse(store.expiresAt || "") || 0,
    refreshTokenExpiresAt: Date.parse(store.refreshTokenExpiresAt || "") || 0,
    user: store.user || {},
    machineId,
    product,
  };
}

/**
 * 写回凭据（切号 / 与桌面端保持同步用）。
 * 元数据（machineId 等）**绝不写入此文件**——桌面端刷新时会整体覆盖它（对齐 raccoon 教训）。
 */
function writeCredentials(product, cred) {
  const p = pathsOf(product);
  const ls = JSON.parse(fs.readFileSync(p.localState, "utf8"));
  const key = dpapiUnprotectKey(ls.os_crypt.encrypted_key);
  const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
  const store = {
    schemaVersion: 1,
    token: cred.token,
    refreshToken: cred.refreshToken,
    expiresAt: iso(cred.expiresAt),
    refreshTokenExpiresAt: iso(cred.refreshTokenExpiresAt),
    user: cred.user || {},
  };
  const tmp = p.authFile + ".agenthub.tmp";
  fs.writeFileSync(tmp, encryptV10(Buffer.from(JSON.stringify(store), "utf8"), key));
  fs.renameSync(tmp, p.authFile); // 原子替换，避免桌面端读到半截文件
  return true;
}

// ===== 续期（deviceToken/refresh）=====

/**
 * 刷新设备令牌：POST {openApi}/api/v1/deviceToken/refresh
 * body { refresh_token, machine_id } → { device_token, refresh_token, expires_at, refresh_token_expires_at }
 * 注意：refresh_token 轮换制，成功后**必须同时保存新旧两个 token**。
 * 实测 machine_id 不参与绑定校验（伪造亦通过），此处仍传真实值以保持指纹一致。
 */
async function refreshDeviceToken(product, refreshToken, machineId, opts = {}) {
  const p = PRODUCTS[product];
  if (!p) throw new Error(`未知渠道 ${product}`);
  const url = `${p.openApi}/api/v1/deviceToken/refresh`;
  const body = JSON.stringify({ refresh_token: refreshToken, ...(machineId ? { machine_id: machineId } : {}) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": opts.userAgent || "qoder/0.4.3" },
      body,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 留原文 */ }
    if (!resp.ok || !data || !data.device_token) {
      return { ok: false, status: resp.status, message: (data && (data.message || data.error)) || text.slice(0, 160) };
    }
    return {
      ok: true,
      token: String(data.device_token),
      refreshToken: String(data.refresh_token || refreshToken),
      expiresAt: Date.parse(data.expires_at || "") || 0,
      refreshTokenExpiresAt: Date.parse(data.refresh_token_expires_at || "") || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ===== 模型目录（catalog-v6 本地解密）=====

/** 目录缓存路径：~/.qoder{,-cn}/.models/<uid>/catalog-v6 */
function catalogPath(product, uid) {
  const p = pathsOf(product);
  return p && uid ? path.join(p.catalogDir, uid, "catalog-v6") : null;
}

function readCatalogBlob(product, uid) {
  const f = catalogPath(product, uid);
  if (!f || !fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8"); // 加密文本，交由签名器的 model_cache_decrypt 解
}

module.exports = {
  PRODUCTS,
  pathsOf,
  detect,
  detectAll,
  readCredentials,
  writeCredentials,
  refreshDeviceToken,
  catalogPath,
  readCatalogBlob,
  riskIdentityPath,
  readRiskIdentity,
  clearRiskCache,
  ensureMachineId,
  // 供自测
  decryptV10,
  encryptV10,
  dpapiUnprotectKey,
};
