/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 豆包工作 · 本机登录态导入（**直接读客户端本地 Cookie 库，不需要调试端口**）
//
// 依据 Agent2Providers `doubaowork/cookies_db.rs` 与 `client.rs` 模块头。
//
// ── 为什么读本地库而不是 CDP ─────────────────────────────────
// 客户端本身就是 Chromium，Cookie 就在本地 SQLite 里。要求用户「带调试端口重启客户端」
// 只是为了导一次登录态，代价与收益完全不成比例。**只读，绝不写回。**
//
// ── 加密怎么解（Windows）───────────────────────────────────
// Chromium 的 `Cookies` 表里 `encrypted_value` 是 os_crypt 密文：
//   `v10` + 12 字节 nonce + 密文 + 16 字节 tag（AES-256-GCM）
// 密钥在 `Local State` 的 `os_crypt.encrypted_key`，外面裹了一层 DPAPI。
// DPAPI 那一步复用 `qoderAuth.dpapiUnprotectKey`（同一套 CryptUnprotectData）。
//
// 明文布局：`SHA256(host_key)` 32 字节 + Cookie 值（Chromium ≥ v24 的惯例）。
// 按 host_key 校验后再剥掉；对不上就按无前缀处理（宁可多带 32 字节，不要把正常值截掉）。
//
// ── 设备号从哪来（关键，缺它必被风控拦）──────────────────────
// 风控认「这个账号在这台受信设备上」，设备号**只在** `Local State` 的
// `aha.device.device_id` 里 —— Cookie 里没有这个键，协议也不下发。
//
// ── 非 Windows ─────────────────────────────────────────────
// DPAPI 只有 Windows 有（macOS 走 Keychain，未实现）→ 直接报错，由调用方回落粘贴。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/** Cookie 库 / 临时副本大小上限（正常几百 KB；给足余量，防换过的怪文件） */
const MAX_DB_BYTES = 32 * 1024 * 1024;
/** 单条 Cookie 值上限 */
const MAX_COOKIE_BYTES = 16 * 1024;
/** 返回的 Cookie 条数上限（实测豆包域 30 余条） */
const MAX_COOKIES = 256;
/** 只要这些域（`doubao.com` 及其子域） */
const HOST_SUFFIX = "doubao.com";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}
/** 客户端 `User Data` 目录 */
function userDataDir() {
  return path.join(localAppData(), "DoubaoWork", "User Data");
}
/** 所有可能装了登录态的 profile（`Default` / `Profile *`，Default 优先） */
function profiles(userData) {
  const out = [];
  try {
    for (const name of fs.readdirSync(userData)) {
      if (name === "Default" || /^Profile \d+$/.test(name)) out.push(path.join(userData, name));
    }
  } catch { return []; }
  out.sort((a, b) => (path.basename(a) === "Default" ? -1 : path.basename(b) === "Default" ? 1 : 0));
  return out;
}

/** 读 Local State：os_crypt 密钥（DPAPI 解出 32B）与 aha.device.device_id */
function readLocalState(userData) {
  const file = path.join(userData, "Local State");
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
    text = fs.readFileSync(file, "utf8");
  } catch { return null; }
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const device = json?.aha?.device?.device_id;
  const deviceId = typeof device === "string" ? device.trim() : (typeof device === "number" ? String(device) : "");
  return {
    encryptedKey: String(json?.os_crypt?.encrypted_key || ""),
    deviceId: /^[A-Za-z0-9._-]{1,128}$/.test(deviceId) ? deviceId : "",
  };
}

/** v10 信封 → **Buffer** 明文（AES-256-GCM；密钥 32B）。
 *  ⚠ 必须返回 Buffer 而不是字符串：明文前面是 32 字节**二进制** host 前缀，
 *  先转 utf8 再转回来会被非法序列替换成 U+FFFD，前缀比对就永远不命中。 */
function decryptV10(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < 3 + 12 + 16) return Buffer.alloc(0);
  const prefix = blob.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return Buffer.alloc(0);
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { return Buffer.alloc(0); }
}

/** 剥掉 Chromium ≥ v24 的 `SHA256(host_key)` 前缀 → 字符串（对不上就按无前缀处理） */
function stripHostPrefix(bytes, hostKey) {
  if (!bytes || !bytes.length) return "";
  if (bytes.length <= 32) return bytes.toString("utf8");
  const expect = crypto.createHash("sha256").update(String(hostKey || ""), "utf8").digest();
  if (bytes.subarray(0, 32).equals(expect)) return bytes.subarray(32).toString("utf8");
  return bytes.toString("utf8");
}

/** 复制 Cookie 库（含 -wal/-shm）到临时目录，避开客户端的写锁 */
function copyDb(dbFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-doubao-cookies-"));
  const target = path.join(dir, "Cookies");
  fs.copyFileSync(dbFile, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const from = `${dbFile}${suffix}`;
    if (fs.existsSync(from)) { try { fs.copyFileSync(from, `${target}${suffix}`); } catch { /* 忽略 */ } }
  }
  return { dir, target };
}

/** 读一个 profile 的 Cookie（返回 [{name, value, hostKey}]） */
function readProfileCookies(profile, key) {
  const dbFile = path.join(profile, "Network", "Cookies");
  if (!fs.existsSync(dbFile)) return [];
  const st = fs.statSync(dbFile);
  if (!st.isFile() || st.size > MAX_DB_BYTES) return [];
  const { dir, target } = copyDb(dbFile);
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(target, { readOnly: true });
    const rows = db.prepare("SELECT host_key, name, value, encrypted_value FROM cookies").all();
    const out = [];
    for (const row of rows) {
      const hostKey = String(row.host_key || "");
      if (!hostKey.replace(/^\./, "").endsWith(HOST_SUFFIX)) continue;
      let value = String(row.value || "");
      if (!value && row.encrypted_value) {
        const blob = Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value : Buffer.from(row.encrypted_value);
        value = stripHostPrefix(decryptV10(blob, key), hostKey);
      }
      if (!value || Buffer.byteLength(value) > MAX_COOKIE_BYTES) continue;
      if (!/^[A-Za-z0-9_\-.#]+$/.test(String(row.name || ""))) continue;
      out.push({ name: String(row.name), value });
      if (out.length >= MAX_COOKIES) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db && db.close(); } catch { /* 忽略 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 读本机豆包工作登录态。
 * @returns {{ok:true, cookie:string, deviceId:string, profile:string, count:number} | {ok:false, message:string}}
 */
function readDesktopState() {
  if (process.platform !== "win32") return { ok: false, message: "本机登录态导入只支持 Windows（DPAPI 只在 Windows 上可用）" };
  const userData = userDataDir();
  if (!fs.existsSync(userData)) return { ok: false, message: `未找到豆包工作客户端数据目录（${userData}）；请确认已安装并登录过客户端` };
  const state = readLocalState(userData);
  if (!state || !state.encryptedKey) return { ok: false, message: "客户端 Local State 缺少 os_crypt 密钥，无法解密 Cookie" };
  let key;
  try {
    key = require("../qoderAuth.cjs").dpapiUnprotectKey(state.encryptedKey);
  } catch (e) {
    return { ok: false, message: `DPAPI 解密失败（需与豆包工作客户端同一 Windows 用户）：${String((e && e.message) || e).slice(0, 120)}` };
  }
  for (const profile of profiles(userData)) {
    const rows = readProfileCookies(profile, key);
    if (!rows.length) continue;
    const map = new Map();
    for (const row of rows) map.set(row.name, row.value); // 同名后者覆盖（与浏览器一致）
    // 必须含会话标识（sessionid 或 sessionid_ss），否则不是登录态
    if (!map.has("sessionid") && !map.has("sessionid_ss")) continue;
    const cookie = [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    return { ok: true, cookie, deviceId: state.deviceId, profile: path.basename(profile), count: map.size };
  }
  return { ok: false, message: "客户端 Cookie 库里没有豆包登录态（请先在客户端登录一次）" };
}

module.exports = { readDesktopState, readLocalState, readProfileCookies, decryptV10, stripHostPrefix, userDataDir, HOST_SUFFIX };
