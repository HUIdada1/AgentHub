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
// 反代网关 · OfficeAce（华为云果办）控制面签名：**V11-HMAC-SHA256**
//
// 为什么不复用 codearts/signer.cjs：两家同属华为云、算法同名，但**规范化规则有三处
// 实测差异**（依据 Agent2Providers officeace/signer.rs 文件头，那里用 signer_vectors.json
// 对拍过真实 signV4/signV11）：
//   1. **未保留集更严**：codearts 把 `! ' ( ) *` 留在字面量里，OfficeAce 的 JS 签名器
//      先 encodeURIComponent、再把这五个字符也转义（quota.mjs 的 rfc3986）；
//   2. **查询串按 WHATWG 口径**：走 URL.searchParams（键值先解码再重新编码、`+` 折成
//      空格、按 (键, 值) 排序），不是 Go ParseQuery 的「坏 % 丢一对」语义；
//   3. **V11 的派生密钥按「小写十六进制字符串」参与 HMAC**，不是 32 字节原始 key。
//
// 算法：
//   canonicalRequest = METHOD \n canonicalURI \n canonicalQuery \n
//                      canonicalHeaders \n signedHeaders \n payloadHash
//   scope        = <YYYYMMDD>/<region>/apic
//   signingKey   = hmacSha256(hmacSha256(AK, SK), scope ++ 0x01)[..32] 的 **hex 串**
//   stringToSign = "V11-HMAC-SHA256" \n X-Sdk-Date \n scope \n sha256hex(canonicalRequest)
//   signature    = hmacSha256hex(signingKey_hex_string, stringToSign)
"use strict";
const crypto = require("node:crypto");

const V11_ALGORITHM = "V11-HMAC-SHA256";
/** 标准华为云签名（控制面的 client-permission-validate / IAM projects 用它） */
const SDK_ALGORITHM = "SDK-HMAC-SHA256";
const SCOPE_SERVICE = "apic";
const HEADER_XSDK_DATE = "X-Sdk-Date";
const HEADER_SECURITY_TOKEN = "X-Security-Token";
const HEADER_PROJECT_ID = "X-Project-ID";
const HEADER_AUTHORIZATION = "Authorization";
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** 控制面默认区域（与网关同区） */
const DEFAULT_REGION = "cn-southwest-2";

/** RFC3986：encodeURIComponent 之后再把 `! ' ( ) *` 也转义（OfficeAce 的 rfc3986） */
function rfc3986(text) {
  return encodeURIComponent(String(text)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** canonicalURI：逐段 rfc3986，并保证以 / 结尾（空路径给 /） */
function canonicalUri(path) {
  const raw = String(path || "/");
  const segments = raw.split("/").map((segment) => rfc3986(safeDecode(segment)));
  let escaped = segments.join("/");
  if (!escaped.startsWith("/")) escaped = `/${escaped}`;
  if (!escaped.endsWith("/")) escaped += "/";
  return escaped;
}
function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** canonicalQuery：WHATWG 口径（searchParams 解码再编码、`+` 折空格、按 (键,值) 排序） */
function canonicalQuery(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const pairs = [...params.entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)]);
  pairs.sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function hmac(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest();
}
function sdkDateNow() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

/** 头集合：同名（大小写无关）覆盖前值、位置不变 */
class HeaderBag {
  constructor(input) {
    this.items = [];
    for (const [name, value] of input || []) this.set(name, value);
  }
  set(name, value) {
    const lower = String(name).toLowerCase();
    const hit = this.items.find((item) => item.name.toLowerCase() === lower);
    if (hit) { hit.value = String(value); return; }
    this.items.push({ name: String(name), value: String(value) });
  }
  has(name) {
    const lower = String(name).toLowerCase();
    return this.items.some((item) => item.name.toLowerCase() === lower);
  }
  get(name) {
    const lower = String(name).toLowerCase();
    const hit = this.items.find((item) => item.name.toLowerCase() === lower);
    return hit ? hit.value : "";
  }
}

/**
 * 签一次 V11 请求。
 * @param {object} req { method, url, headers:[[k,v]], body:Buffer|string, credential:{accessKeyId,secretAccessKey,securityToken,projectId}, region }
 * @returns {Array<[string,string]>} 应当发出去的头（入参头 + 注入项 + Authorization）
 */
function signV11(req) {
  const cred = req.credential || {};
  if (!cred.accessKeyId || !cred.secretAccessKey) throw new Error("凭据不完整：accessKeyId 与 secretAccessKey 都得有");
  const url = new URL(req.url);
  const out = new HeaderBag(req.headers);
  if (cred.securityToken) out.set(HEADER_SECURITY_TOKEN, cred.securityToken);
  if (cred.projectId) out.set(HEADER_PROJECT_ID, cred.projectId);
  if (!out.has(HEADER_XSDK_DATE)) out.set(HEADER_XSDK_DATE, sdkDateNow());
  if (!out.has("Host")) out.set("Host", url.host);
  const date = out.get(HEADER_XSDK_DATE);

  const canonical = out.items.map((item) => ({ name: item.name.toLowerCase(), value: item.value.trim() }));
  canonical.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const canonicalHeaders = canonical.map((item) => `${item.name}:${item.value}\n`).join("");
  const signedHeaders = canonical.map((item) => item.name).join(";");
  const body = req.body == null ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body), "utf8");
  const payloadHash = body.length ? sha256Hex(body) : EMPTY_BODY_SHA256;
  const canonicalRequest = [
    String(req.method || "GET").toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const region = req.region || DEFAULT_REGION;
  const scope = `${date.slice(0, 8)}/${region}/${SCOPE_SERVICE}`;
  const stringToSign = [V11_ALGORITHM, date, scope, sha256Hex(Buffer.from(canonicalRequest, "utf8"))].join("\n");
  // 派生密钥：hmac(AK, SK) → hmac(step1, scope+0x01)[..32] → **hex 串**当密钥
  const step1 = hmac(Buffer.from(String(cred.accessKeyId), "utf8"), String(cred.secretAccessKey));
  const seed = Buffer.concat([Buffer.from(scope, "utf8"), Buffer.from([1])]);
  const derived = hmac(step1, seed).subarray(0, 32);
  const signingKeyHex = derived.toString("hex");
  const signature = crypto.createHmac("sha256", Buffer.from(signingKeyHex, "utf8")).update(stringToSign, "utf8").digest("hex");
  out.set(HEADER_AUTHORIZATION,
    `${V11_ALGORITHM} Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return { headers: out.items.map((item) => [item.name, item.value]), canonicalRequest, stringToSign, signature, signedHeaders };
}

/** 只要头（常用入口） */
function sign(req) {
  return signV11(req).headers;
}

/**
 * 标准华为云签名（**SDK-HMAC-SHA256**）：`client-permission-validate` 与 `/v3/projects`
 * 走这一套，额度/签到那几个 `/v1/subscription*` 走 V11。
 *
 * 差异（signer.rs :: sign_material 的 Algorithm::Sdk 分支）：
 *   stringToSign = "SDK-HMAC-SHA256" \n X-Sdk-Date \n sha256hex(canonicalRequest)
 *   signature    = hmacSha256hex(secretAccessKey, stringToSign)   ← 不用派生密钥、无 scope
 *   Authorization = "SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=…, Signature=…"
 * 规范头要把**内部连续空白折成一个空格**（参考实现是 `split_whitespace().join(" ")`，
 * 不是只 trim）；其余（canonicalURI / canonicalQuery / payloadHash）与 V11 共用。
 */
function signSdk(req) {
  const cred = req.credential || {};
  if (!cred.accessKeyId || !cred.secretAccessKey) throw new Error("凭据不完整：accessKeyId 与 secretAccessKey 都得有");
  const url = new URL(req.url);
  const out = new HeaderBag(req.headers);
  if (cred.securityToken) out.set(HEADER_SECURITY_TOKEN, cred.securityToken);
  if (cred.projectId) out.set(HEADER_PROJECT_ID, cred.projectId);
  if (!out.has(HEADER_XSDK_DATE)) out.set(HEADER_XSDK_DATE, sdkDateNow());
  if (!out.has("Host")) out.set("Host", url.host);
  const date = out.get(HEADER_XSDK_DATE);

  const canonical = out.items.map((item) => ({
    name: item.name.toLowerCase(),
    value: String(item.value).split(/\s+/).filter(Boolean).join(" "),
  }));
  canonical.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const canonicalHeaders = canonical.map((item) => `${item.name}:${item.value}\n`).join("");
  const signedHeaders = canonical.map((item) => item.name).join(";");
  const body = req.body == null ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body), "utf8");
  const payloadHash = body.length ? sha256Hex(body) : EMPTY_BODY_SHA256;
  const canonicalRequest = [
    String(req.method || "GET").toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [SDK_ALGORITHM, date, sha256Hex(Buffer.from(canonicalRequest, "utf8"))].join("\n");
  const signature = crypto.createHmac("sha256", Buffer.from(String(cred.secretAccessKey), "utf8"))
    .update(stringToSign, "utf8").digest("hex");
  out.set(HEADER_AUTHORIZATION, `${SDK_ALGORITHM} Access=${cred.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return { headers: out.items.map((item) => [item.name, item.value]), canonicalRequest, stringToSign, signature, signedHeaders };
}

module.exports = { sign, signV11, signSdk, rfc3986, canonicalUri, canonicalQuery, sdkDateNow, DEFAULT_REGION, EMPTY_BODY_SHA256, SDK_ALGORITHM };
