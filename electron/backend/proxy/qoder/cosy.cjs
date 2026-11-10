/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-11-10
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// COSY 请求签名（纯 Node crypto，无 wasm / 无新依赖）。
// 依据 Agent2Providers `qoder/cosy.rs`（其正确性已与 Node crypto 逐字节对拍）：
//   1. 身份 JSON → AES-128-CBC（key = iv = 16 字符一次性密钥）→ base64 `info`；
//   2. 同一把一次性密钥用服务端 RSA 公钥（PKCS#1 v1.5）加密 → base64 `cosyKey`；
//   3. {version, requestId, info, cosyVersion, ideVersion} → base64 `payload`；
//   4. MD5(payload \n cosyKey \n 时间戳 \n 请求体 \n 签名路径) → signature；
//   5. `Authorization: Bearer COSY.<payload>.<signature>` + 一组 Cosy-* 头。
//
// 为什么管理侧也要自己实现：千问办公没有独立客户端，wasm 签名器只能从 Qoder 客户端
// 借；而 `prepareInferRequest` 把 URL 硬编码成推理路径，**无法为目录 URL 签名**。
// 目录是 GET（空体），用这套纯 crypto 实现就能解锁远端模型清单（Docker / 无客户端环境同样可用）。
// 与插件 `AgentHub_skill/src/providers/qoder/cosy.cjs` 同源同算法，改动需两侧同步。
"use strict";
const crypto = require("node:crypto");

/** 客户端内置的固定公钥模数（1024 位 hex；不是机密材料，只用于加密一次性 AES 密钥） */
const RSA_MODULUS_HEX = "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const RSA_EXPONENT = "AQAB";
/** 自定义替换字母表（与标准 base64 字母表逐字符对应） */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MACHINE_TYPE = "5";
const CLIENT_IP = "127.0.0.1";
const LOGIN_VERSION = "v2";

let cachedKey = null;
function publicKey() {
  if (cachedKey) return cachedKey;
  const n = Buffer.from(RSA_MODULUS_HEX, "hex").toString("base64url");
  cachedKey = crypto.createPublicKey({ key: { kty: "RSA", n, e: RSA_EXPONENT }, format: "jwk" });
  return cachedKey;
}

/** 请求体编码（`Encode=1` 时使用）：标准 base64 → 尾/中/首三段重排 → 字母表替换 */
function encodeBody(payload) {
  const standard = Buffer.from(payload).toString("base64");
  const bytes = Buffer.from(standard, "ascii");
  const length = bytes.length;
  const third = Math.floor(length / 3);
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  for (let i = 0; i < STD_ALPHABET.length; i++) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  table[0x3d] = 0x24; // '=' → '$'
  const out = Buffer.alloc(length);
  let at = 0;
  for (let i = length - third; i < length; i++) out[at++] = table[bytes[i]];
  for (let i = third; i < length - third; i++) out[at++] = table[bytes[i]];
  for (let i = 0; i < third; i++) out[at++] = table[bytes[i]];
  return out.toString("ascii");
}

/** 参与签名的路径：去掉 `/algo` 前缀、不含查询串 */
function signaturePath(requestUrl) {
  const parsed = new URL(String(requestUrl));
  const path = parsed.pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

function machineOs() {
  const arch = process.arch === "arm64" || process.arch === "aarch64" ? "aarch64" : "x86_64";
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return `${arch}_${platform}`;
}

function aes128CbcBase64(key16, plaintext) {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key16, "utf8"), Buffer.from(key16, "utf8"));
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
}

function rsaEncryptBase64(text) {
  return crypto.publicEncrypt({ key: publicKey(), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(text, "utf8")).toString("base64");
}

/** 构造一套 COSY 头。`site` 必须与请求体里的 session_type / business 同源。 */
function buildAuthHeaders({ url, body, identity, site }) {
  const uid = String(identity?.uid || "");
  const token = String(identity?.token || "");
  if (!uid) throw new Error("COSY：缺少账号 uid");
  if (!token) throw new Error("COSY：缺少访问令牌");
  const name = String(identity?.name || "");
  const email = String(identity?.email || "");
  const machineId = String(identity?.machineId || "");
  const aesKey = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  if (aesKey.length !== 16) throw new Error("COSY：无法生成签名密钥");
  // 键顺序照抄参考实现：uid / security_oauth_token / name / aid / email
  const userInfo = JSON.stringify({ uid, security_oauth_token: token, name, aid: "", email });
  const info = aes128CbcBase64(aesKey, Buffer.from(userInfo, "utf8"));
  const cosyKey = rsaEncryptBase64(aesKey);
  const requestId = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const cosyVersion = String(site?.cosyVersion || site?.version || "1.1.52");
  const clientType = String(site?.cosyClientType || site?.clientType || "6");
  const dataPolicy = String(site?.cosyDataPolicy || site?.dataPolicy || "agree");
  const scene = site?.cosyScene || site?.scene;
  const businessProduct = site?.cosyBusinessProduct || site?.businessProduct;
  const businessType = site?.cosyBusinessType || site?.businessType;
  const payloadSrc = JSON.stringify({ version: "v1", requestId, info, cosyVersion, ideVersion: "" });
  const payload = Buffer.from(payloadSrc, "utf8").toString("base64");
  const sigPath = signaturePath(url);
  const bodyBytes = body ? Buffer.from(body) : Buffer.alloc(0);
  const signature = crypto.createHash("md5")
    .update(payload, "utf8").update("\n")
    .update(cosyKey, "utf8").update("\n")
    .update(timestamp, "utf8").update("\n")
    .update(bodyBytes).update("\n")
    .update(sigPath, "utf8").digest("hex");
  const bodyHash = crypto.createHash("md5").update(bodyBytes).digest("hex");
  const headers = {
    Authorization: `Bearer COSY.${payload}.${signature}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": uid,
    "Cosy-Date": timestamp,
    "Cosy-Version": cosyVersion,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": MACHINE_TYPE,
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": clientType,
    "Cosy-Clientip": site?.isQwenwork && machineId ? machineId : CLIENT_IP,
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": dataPolicy,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": requestId,
  };
  if (scene) headers["Cosy-Scene"] = String(scene);
  if (businessProduct) headers["Cosy-Business-Product"] = String(businessProduct);
  if (businessType) headers["Cosy-Business-Type"] = String(businessType);
  if (site?.userAgent) headers["User-Agent"] = String(site.userAgent);
  return headers;
}

module.exports = { buildAuthHeaders, encodeBody, signaturePath, publicKey, machineOs, RSA_MODULUS_HEX, CUSTOM_ALPHABET };
