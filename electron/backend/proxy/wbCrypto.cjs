// 反代网关 · WorkBuddy $wbEncrypted 信封加解密（workbuddy / workbuddy_ai 双渠道共用）
//
// 事实基线（本机 E:\WorkBuddy 5.6.2 客户端 app.asar 实证 + 运行进程内存佐证，逐字节复核）：
//   · 官方客户端 5.6.x 起对登录文件 workbuddy-desktop(-ai).info 做「逐字段加密包装」：
//     被保护字段（nickname / phoneNumber / auth.accessToken / auth.refreshToken …）变成
//     { $wbEncrypted: 1, envelope: <base64> }，envelope 解开是
//     { suite:1, keyId, nonce, authTag, ciphertext }（后四者均 base64）。
//   · 算法：AES-256-GCM，nonce 12B / authTag 16B；AAD = WB-AAD\0 ‖ 01 ‖
//     lenp(fmtId) ‖ lenp("sym-v1") ‖ u32be(suite) ‖ lenp(keyId) ‖ framingCode ‖ 00 ‖ 00，
//     字段级 framing="field"（fmtId WBEV1 / code 2），整文件/keyblob 用 framing="file"（WBEF1 / 1）。
//   · 密钥链：字段明文由「静态保护密钥」直接加密（symmetricKey，编译期注入定制 Electron 原生层，
//     不落成明文文件）。该密钥是 32B 常量，keyId = sha256(key) 前 16 hex = 9127dea1b44020a7，
//     全机器全进程一致（已实测 2 个 WorkBuddy 进程内存同值）。
//   · keyblob（~/.workbuddy/keyblob）存的是「用户主密钥」userKey（32B 随机），由保护密钥以
//     file framing 包裹——它用于 advanced(asym-v1) 路径，本模块的标准字段解密用不到，
//     但保留解包能力以便后续需要。
// 设计口径：保护密钥是公开客户端内嵌常量（等同于 Trae ByteCrypto 的盐表），以常量内置；
//   运行时另从 ~/.workbuddy/keyblob 反解校验，密钥漂移时诚实降级（解不开就返回 null，
//   绝不写出破坏登录态的脏数据）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ===== 加密基元（与官方 process-cpu-sampler.js 逐行对齐） =====

const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const SCHEME = "sym-v1";
const STANDARD_FORMAT_ID = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };

/** 静态保护密钥（symmetricKey），keyId = 9127dea1b44020a7。官方客户端内嵌常量。 */
const PROTECTOR_KEY_B64 = "x0qvnfCRBKXgsf0C0cKx6lhuQGaESTPzJ5chxojUQFU=";
const PROTECTOR_KEY_ID = "9127dea1b44020a7";

function encodeUint32(v) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v);
  return b;
}
function encodeLengthPrefixed(v) {
  const b = Buffer.from(v, "utf8");
  return Buffer.concat([encodeUint32(b.length), b]);
}
function encodeOptionalUint64(v) {
  if (v === undefined) return Buffer.from([0]);
  const b = Buffer.allocUnsafe(9);
  b[0] = 1;
  b.writeBigUInt64BE(v, 1);
  return b;
}
/** AAD（sym-v1）：与官方 buildAuthenticatedContextAad 同构，sequence/final 恒为 absent/false */
function buildAad(keyId, suite, framing) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID[framing]),
    encodeLengthPrefixed(SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE[framing]]),
    encodeOptionalUint64(undefined),
    Buffer.from([0]),
  ]);
}
function deriveKeyId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 保护密钥（Buffer），keyId 自校验，漂移即判不可用 */
function protectorKey() {
  const key = Buffer.from(PROTECTOR_KEY_B64, "base64");
  if (key.length !== 32 || deriveKeyId(key) !== PROTECTOR_KEY_ID) return null;
  return key;
}

// ===== 信封编解码 =====

/** 解信封：input 可为 base64 信封串或已解析的 envelope 对象；framing 默认 field。失败返回 null */
function openEnvelope(input, key, framing = "field") {
  try {
    const env = typeof input === "string" ? JSON.parse(Buffer.from(input, "base64").toString("utf8")) : input;
    if (!env || typeof env !== "object") return null;
    const nonce = Buffer.from(env.nonce, "base64");
    const authTag = Buffer.from(env.authTag, "base64");
    const ciphertext = Buffer.from(env.ciphertext, "base64");
    if (nonce.length !== 12 || authTag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(buildAad(String(env.keyId), Number(env.suite ?? 1), framing));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** 封信封：明文 Buffer → base64 信封串；framing 默认 field */
function sealEnvelope(plaintext, key, keyId, framing = "field") {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAad(keyId, 1, framing));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ===== 字段包装（{ $wbEncrypted:1, envelope }） =====

function isEncryptedWrapper(value) {
  return (
    !!value &&
    typeof value === "object" &&
    value.$wbEncrypted === 1 &&
    typeof value.envelope === "string"
  );
}

/** 解一个被保护字段 → utf8 字符串；非包装/解不开返回 null */
function decryptField(wrapper, framing = "field") {
  if (!isEncryptedWrapper(wrapper)) return null;
  const key = protectorKey();
  if (!key) return null;
  const plain = openEnvelope(wrapper.envelope, key, framing);
  return plain ? plain.toString("utf8") : null;
}

/** 封一个字段值 → { $wbEncrypted:1, envelope } */
function encryptField(text, framing = "field") {
  const key = protectorKey();
  if (!key) throw new Error("保护密钥不可用");
  return { $wbEncrypted: 1, envelope: sealEnvelope(Buffer.from(String(text), "utf8"), key, PROTECTOR_KEY_ID, framing) };
}

// ===== keyblob（用户主密钥，advanced 路径备用） =====

function keyblobPath() {
  return path.join(os.homedir(), ".workbuddy", "keyblob");
}
/** 解包 keyblob → { keyId, key }（userKey）；失败返回 null。framing=file。 */
function unwrapKeyblobMasterKey() {
  try {
    const wire = JSON.parse(fs.readFileSync(keyblobPath(), "utf8"));
    const slot = (wire.slots || []).find((s) => s.type === "static-v1" && (!s.protectorKeyId || s.protectorKeyId === PROTECTOR_KEY_ID));
    if (!slot || typeof slot.wrapped !== "string") return null;
    const key = protectorKey();
    if (!key) return null;
    const master = openEnvelope(slot.wrapped, key, "file");
    if (!master || master.length !== 32 || deriveKeyId(master) !== wire.keyId) return null;
    return { keyId: wire.keyId, key: master };
  } catch {
    return null;
  }
}

/** 探测：保护密钥是否可用 + 给定文件是否含加密包装 */
function cryptoStatus() {
  const key = protectorKey();
  return {
    protectorAvailable: !!key,
    protectorKeyId: key ? PROTECTOR_KEY_ID : "",
    masterKeyAvailable: !!unwrapKeyblobMasterKey(),
  };
}

module.exports = {
  PROTECTOR_KEY_ID,
  protectorKey,
  openEnvelope,
  sealEnvelope,
  isEncryptedWrapper,
  decryptField,
  encryptField,
  unwrapKeyblobMasterKey,
  keyblobPath,
  cryptoStatus,
  deriveKeyId,
};
