/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · CodeArts DPoP proof（RFC 9449 的 DPoP 头）：一个 ES256 的 JWS，头部嵌公钥 JWK，
// 载荷声明「这个方法、这个地址、这个时刻、这个一次性 id」。
//
// 上游的理由：令牌端点不靠客户端密钥认证，而是要求调用方证明「我手里有这把私钥」——
// 每次请求现签一份 proof，服务端用 proof 头部里那把公钥验签。所以私钥是登录态的一部分，
// 必须与 refresh token、PKCE verifier 一起长期保存（见 credentials）。
//
// Node 关键细节：用 crypto 的 EC 能力 + dsaEncoding:'ieee-p1363'（DER→raw R||S 转换是关键）。
// 上游只收 ES256 这一种算法；jti 用 32 字节随机数的十六进制；s 不做 low-S 归一（与 Go 的 ecdsa.Sign 一致）。
// 验收标准：能用嵌入的公钥验签通过、字段齐备（不是与 Go 逐字节相同——签名本就不该逐字节相同）。
"use strict";

const crypto = require("node:crypto");

const DPOP_ALG = "ES256";
const DPOP_TYP = "dpop+jwt";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// JWK 的 x/y 必须是 32 字节定长（大整数去掉前导零后要补齐，不补会短一截被上游判成非法点）
function pad32(bytes) {
  const b = Buffer.from(bytes);
  if (b.length === 32) return b;
  if (b.length > 32) return b.slice(b.length - 32);
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

// 由私钥（32 字节标量）推出公钥 JWK
function publicJwkOf(privateKey) {
  const point = crypto.createECDH("prime256v1");
  point.setPrivateKey(pad32(privateKey));
  const uncompressed = point.getPublicKey(null, "uncompressed"); // 0x04 || X || Y
  const x = uncompressed.slice(1, 33);
  const y = uncompressed.slice(33, 65);
  return { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) };
}

// 新生成一把 P-256 密钥，返回可直接落盘的那份 {privateKeyJwk, publicKeyJwk}
function generateKeyPair() {
  for (let i = 0; i < 8; i++) {
    const seed = crypto.randomBytes(32);
    try {
      const point = crypto.createECDH("prime256v1");
      point.setPrivateKey(seed);
      const pubJwk = publicJwkOf(seed);
      const privateJwk = { ...pubJwk, d: b64url(seed) };
      return { privateKeyJwk: privateJwk, publicKeyJwk: pubJwk };
    } catch {
      continue; // 随到的 32 字节落到 [1, n-1] 之外（概率约 2^-128），重试只是兜底
    }
  }
  throw new Error("无法生成本机 P-256 密钥，请重试");
}

// 从私钥 JWK 恢复签名能力；落盘的公钥若存在且与私钥不符说明凭据被改坏，宁可报错也不签出对不上的 proof
function keyFromPair(pair) {
  const priv = pair && pair.privateKeyJwk;
  if (!priv || priv.kty !== "EC" || priv.crv !== "P-256" || !String(priv.d || "").trim()) {
    throw new Error("CodeArts DPoP 私钥不完整（需要 EC / P-256 / d）");
  }
  const scalar = Buffer.from(String(priv.d).trim(), "base64url");
  const key = { privateKey: scalar, publicJwk: publicJwkOf(scalar) };
  const recordedX = pair.publicKeyJwk && String(pair.publicKeyJwk.x || "").trim();
  if (recordedX) {
    const norm = (v) => {
      try { return Buffer.from(String(v).trim(), "base64url").toString("base64url"); } catch { return String(v).trim(); }
    };
    if (norm(recordedX) !== norm(key.publicJwk.x) || norm(pair.publicKeyJwk.y || "") !== norm(key.publicJwk.y)) {
      throw new Error("CodeArts DPoP 公私钥不一致，请重新登录");
    }
  }
  return key;
}

// 现签一份 proof；method 与 endpoint 必须与即将发出的请求逐字一致（上游会比对，对不上就是 401）
function proof(pair, method, endpoint, nowMs) {
  const key = keyFromPair(pair);
  const header = { alg: DPOP_ALG, typ: DPOP_TYP, jwk: key.publicJwk };
  const jti = crypto.randomBytes(32).toString("hex");
  const payload = {
    htm: String(method || "POST").toUpperCase(),
    htu: String(endpoint || ""),
    iat: Math.floor((Number(nowMs) || Date.now()) / 1000),
    jti,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // JWS ES256 只对 signingInput 哈希一次。crypto.sign("sha256", digest) 会把 digest 再哈希一次，
  // 签出的 proof 任何标准验证方都验不过（华为 STS 报 STS5.1804 decode DPoP failed）。
  const signature = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: crypto.createPrivateKey({ key: buildPkcs8(key.privateKey), format: "der", type: "pkcs8" }),
    dsaEncoding: "ieee-p1363", // DER → raw R||S 的关键
  });
  return `${signingInput}.${b64url(signature)}`;
}

// 把 32 字节私钥标量包成 SEC1/PKCS8 DER（Node createPrivateKey 接受的形态）
function buildPkcs8(scalar) {
  // secp256r1 私钥 OID + 简单构造：用 ECDH 导出再包一层。为稳妥起见用 createPrivateKey 支持的 JWK 形态：
  const jwk = {
    kty: "EC", crv: "P-256",
    x: publicJwkOf(scalar).x, y: publicJwkOf(scalar).y, d: b64url(scalar),
  };
  return crypto.createPrivateKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "pkcs8" });
}

module.exports = { generateKeyPair, proof, keyFromPair, publicJwkOf };
