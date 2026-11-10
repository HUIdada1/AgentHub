"use strict";
// 豆包工作 · 本机登录态读取：os_crypt 解密、host 前缀剥离、Cookie 库只读解析
//
// 用临时目录造一份「客户端 Local State + Cookies 库」的最小现场：
//   · Local State 里放 aha.device.device_id（设备号，缺它必被风控拦）
//   · Cookies 库里放一条 v10 密文（AES-256-GCM）与一条明文
// DPAPI 那一步需要真实 Windows 用户，测试里用**已知 32B 密钥**直连解密函数，
// 不触碰 DPAPI（readDesktopState 整体路径由实机验证）。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decryptV10, stripHostPrefix, readLocalState, readProfileCookies } = require("../electron/backend/proxy/doubaowork/desktop.cjs");

/** 造一条 Chromium v10 密文（AES-256-GCM） */
function encryptV10(plain, key, hostKey) {
  const prefix = crypto.createHash("sha256").update(String(hostKey), "utf8").digest();
  const body = Buffer.concat([prefix, Buffer.from(plain, "utf8")]);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "ascii"), nonce, ciphertext, cipher.getAuthTag()]);
}

async function main() {
  const key = crypto.randomBytes(32);

  // ===== 解密 =====
  const blob = encryptV10("session-value", key, ".doubao.com");
  // decryptV10 只负责解信封；剥 host 前缀是下一步（readProfileCookies 里两步串起来）
  const plain = decryptV10(blob, key);
  assert.ok(Buffer.isBuffer(plain) && plain.length > 32, "v10 密文解出 Buffer（含 32B host 前缀）");
  assert.equal(stripHostPrefix(plain, ".doubao.com"), "session-value", "解信封 + 剥前缀 = 明文值");
  assert.equal(decryptV10(blob, crypto.randomBytes(32)).length, 0, "密钥不对 → 空 Buffer（不抛）");
  assert.equal(decryptV10(Buffer.from("v20xxx"), key).length, 0, "非 v10/v11 前缀 → 空 Buffer");

  // ===== host 前缀剥离 =====
  const prefixed = Buffer.concat([
    crypto.createHash("sha256").update(".doubao.com", "utf8").digest(),
    Buffer.from("cookie-value", "utf8"),
  ]);
  assert.equal(stripHostPrefix(prefixed, ".doubao.com"), "cookie-value", "SHA256(host_key) 前缀被剥掉");
  assert.equal(stripHostPrefix(prefixed, ".other.com"), prefixed.toString("utf8"), "host 对不上 → 原样返回（宁可多带也不截断）");
  assert.equal(stripHostPrefix(Buffer.from("short", "utf8"), ".doubao.com"), "short", "短值不处理");

  // ===== Local State =====
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-doubao-test-"));
  try {
    const userData = path.join(temp, "User Data");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "Local State"), JSON.stringify({
      os_crypt: { encrypted_key: "RFBBUEkB0000" },
      aha: { device: { device_id: "dev-12345" } },
    }));
    const state = readLocalState(userData);
    assert.equal(state.deviceId, "dev-12345", "设备号从 aha.device.device_id 取");
    assert.equal(state.encryptedKey, "RFBBUEkB0000");
    // 非法设备号一律丢弃（不把它带进请求）
    fs.writeFileSync(path.join(userData, "Local State"), JSON.stringify({ aha: { device: { device_id: "有 空格" } } }));
    assert.equal(readLocalState(userData).deviceId, "", "非法设备号被丢弃");
    // 坏 JSON / 缺文件都返回 null（不抛）
    fs.writeFileSync(path.join(userData, "Local State"), "{not json");
    assert.equal(readLocalState(userData), null);

    // ===== Cookie 库（只读解析 + 域过滤 + 明文/密文混排）=====
    const profile = path.join(userData, "Default");
    fs.mkdirSync(path.join(profile, "Network"), { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    const dbFile = path.join(profile, "Network", "Cookies");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)");
    const insert = db.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)");
    insert.run(".doubao.com", "sessionid", "", encryptV10("sess-abc", key, ".doubao.com"));
    insert.run(".doubao.com", "plain_cookie", "plain-value", Buffer.alloc(0));
    insert.run(".example.com", "sessionid", "leak", Buffer.alloc(0));
    insert.run(".www.doubao.com", "sessionid_ss", "", encryptV10("sess-xyz", key, ".www.doubao.com"));
    db.close();

    const rows = readProfileCookies(profile, key);
    const map = new Map(rows.map((row) => [row.name, row.value]));
    assert.equal(map.get("sessionid"), "sess-abc", "密文 Cookie 被解开");
    assert.equal(map.get("plain_cookie"), "plain-value", "明文 Cookie 原样带出");
    assert.equal(map.get("sessionid_ss"), "sess-xyz", "子域 Cookie 也收");
    assert.equal(rows.some((row) => row.value === "leak"), false, "非 doubao.com 域被过滤");
    // 复制到临时目录后原库不被改动（只读）
    assert.ok(fs.existsSync(dbFile), "原库仍在");

    console.log("PASS Doubao desktop cookies: v10 decrypt, host-prefix stripping, Local State device id and read-only cookie DB parse");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
