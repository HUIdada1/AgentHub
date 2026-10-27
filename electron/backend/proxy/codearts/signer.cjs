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
// 反代网关 · 华为云 SDK-HMAC-SHA256 请求签名（CodeArts Agent 上游那套 AK/SK/STS 签名）
//
// 算法：
//   canonicalRequest = method \n canonicalURI \n canonicalQuery \n canonicalHeaders \n signedHeaders \n payloadHash
//   stringToSign     = "SDK-HMAC-SHA256" \n X-Sdk-Date \n sha256hex(canonicalRequest)
//   signature        = hmacSHA256hex(secretKey, stringToSign)
//   Authorization    = SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=<…>, Signature=<…>
//
// 为什么这里有一整套 URL 解析，而不是直接用 Node 的 URL/URLSearchParams：签名要对字节负责，
// 而上游服务端走 Go net/url —— 路径先按 % 解码再由 canonicalURI 重编码
// （于是 %2F 会变成真分隔符），query 先按 ParseQuery 解码（+ 是空格、坏 % 让那一对键值整个丢掉）再重编码。
// Node 的规范化规则与这些不同，照它算出来的规范串与上游对不上就是 401 且错得毫无提示，所以按 Go 语义手写。
//
// 三条容易写错的细节：
//   1. canonicalURI 强制补尾斜杠（/api/v2/chat/completions 签的是 /api/v2/chat/completions/，少这个斜杠直接 401）；
//   2. 未保留字符集是 JS encodeURIComponent 那一组（含 !'()* 这三个），不是 RFC3986 的 A-Za-z0-9-_.~；
//   3. 参与签名的头集合 = 发出去的全部头（X-Sdk-Date / X-Security-Token / X-Domain-Id / 可选 Host 都在内），
//      Authorization 本身不参与。
"use strict";

const crypto = require("node:crypto");

const SIGNING_ALGORITHM = "SDK-HMAC-SHA256";
const HEADER_XSDK_DATE = "X-Sdk-Date";
const HEADER_AUTHORIZATION = "Authorization";
const HEADER_CONTENT_SHA256 = "X-Sdk-Content-Sha256";
const HEADER_SECURITY_TOKEN = "X-Security-Token";
const HEADER_DOMAIN_ID = "X-Domain-Id";
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// 未保留字符集：与 JS encodeURIComponent 一致（也就等于 Go net/url 的 unreserved 口径）
function unreserved(byte) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
    || byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x21 || byte === 0x7e
    || byte === 0x2a || byte === 0x27 || byte === 0x28 || byte === 0x29;
}

// 按字节百分号编码、大写十六进制
function encodeComponent(bytes) {
  const HEX = "0123456789ABCDEF";
  let out = "";
  for (const byte of bytes) {
    if (unreserved(byte)) out += String.fromCharCode(byte);
    else out += "%" + HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
  }
  return out;
}

function unhex(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
}

// Go net/url.unescape 的 query 分量语义：+ 当空格，%XX 解一个字节，转义坏了返回 null（调用方丢这一对键值）
function queryUnescape(input) {
  const bytes = Buffer.from(input, "latin1");
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x25) {
      if (i + 2 >= bytes.length) return null;
      const hi = unhex(bytes[i + 1]);
      const lo = unhex(bytes[i + 2]);
      if (hi < 0 || lo < 0) return null;
      out.push((hi << 4) | lo);
      i += 3;
    } else if (b === 0x2b) {
      out.push(0x20);
      i += 1;
    } else {
      out.push(b);
      i += 1;
    }
  }
  return Buffer.from(out);
}

// Go net/url.unescape(encodePath) 的语义：按 %XX 解字节，但 + 是字面量（不折成空格）
function pathUnescape(input) {
  const bytes = Buffer.from(input, "latin1");
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x25) {
      if (i + 2 >= bytes.length) return null;
      const hi = unhex(bytes[i + 1]);
      const lo = unhex(bytes[i + 2]);
      if (hi < 0 || lo < 0) return null;
      out.push((hi << 4) | lo);
      i += 3;
    } else {
      out.push(b);
      i += 1;
    }
  }
  return Buffer.from(out);
}

// 拆出 scheme://authority 之后的 path 与 raw query
function parseUrl(url) {
  const schemeIdx = url.indexOf("://");
  if (schemeIdx < 0) throw new Error(`上游地址缺少 scheme：${url}`);
  const rest = url.slice(schemeIdx + 3);
  let cut = rest.length;
  for (const ch of ["/", "?", "#"]) {
    const idx = rest.indexOf(ch);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  const authority = rest.slice(0, cut);
  const tail = rest.slice(cut);
  if (!authority) throw new Error(`上游地址缺少主机名：${url}`);
  const beforeFragment = tail.split("#")[0];
  const qIdx = beforeFragment.indexOf("?");
  const rawPath = qIdx < 0 ? beforeFragment : beforeFragment.slice(0, qIdx);
  const rawQuery = qIdx < 0 ? "" : beforeFragment.slice(qIdx + 1);
  const path = pathUnescape(rawPath);
  if (!path) throw new Error(`上游地址路径转义非法：${rawPath}`);
  return { authority, path, rawQuery };
}

// canonicalURI：逐段按未保留集重编码，并保证以 / 结尾（空路径给 /）
function canonicalUri(pathBytes) {
  if (!pathBytes || !pathBytes.length) return "/";
  const segments = [];
  let cur = [];
  for (const byte of pathBytes) {
    if (byte === 0x2f) {
      segments.push(encodeComponent(Buffer.from(cur)));
      cur = [];
    } else {
      cur.push(byte);
    }
  }
  segments.push(encodeComponent(Buffer.from(cur)));
  let escaped = segments.join("/");
  if (!escaped.endsWith("/")) escaped += "/";
  return escaped;
}

// Go net/url.ParseQuery 的逐对语义：含 ; 的那对丢弃、空串丢弃、第一个 = 分键值、解不开就丢这一对
function queryPairs(raw) {
  const pairs = [];
  for (const part of raw.split("&")) {
    if (!part || part.includes(";")) continue;
    const eq = part.indexOf("=");
    const keyStr = eq < 0 ? part : part.slice(0, eq);
    const valStr = eq < 0 ? "" : part.slice(eq + 1);
    const key = queryUnescape(keyStr);
    if (!key) continue;
    const value = queryUnescape(valStr);
    if (!value) continue;
    pairs.push([key, value]);
  }
  return pairs;
}

// canonicalQueryString：按键排序、同键多值再按值排序、键与值都用未保留集编码
function canonicalQueryString(raw) {
  const pairs = queryPairs(raw);
  if (!pairs.length) return "";
  const encoded = pairs.map(([k, v]) => [encodeComponent(k), encodeComponent(v)]);
  encoded.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function hmacSha256Hex(key, message) {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
}
function sdkDateNow() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}
function requestCarriesBody(method) {
  return ["PUT", "PATCH", "POST"].includes(String(method).toUpperCase());
}

// 头集合：按插入顺序保名值，同名（大小写无关）覆盖前值、位置不变
class Headers {
  constructor(input) {
    this.items = [];
    for (const [name, value] of input || []) this.set(name, value);
  }
  set(name, value) {
    const lower = String(name).toLowerCase();
    for (const item of this.items) {
      if (item.name.toLowerCase() === lower) {
        item.value = String(value);
        return;
      }
    }
    this.items.push({ name: String(name), value: String(value) });
  }
  containsName(name) {
    const lower = String(name).toLowerCase();
    return this.items.some((i) => i.name.toLowerCase() === lower);
  }
  valueOf(name) {
    const lower = String(name).toLowerCase();
    const hit = this.items.find((i) => i.name.toLowerCase() === lower);
    return hit ? hit.value : undefined;
  }
}

// 一次签名的全部中间量（canonical_request / string_to_sign 只为排障对账用）
function signMaterial(method, url, headers, body, credential, includeHost) {
  if (!credential || !credential.access_key_id || !credential.secret_access_key) {
    throw new Error("凭据不完整：access key 与 secret key 都得有");
  }
  const parsed = parseUrl(url);
  const out = new Headers(headers);
  if (credential.security_token) out.set(HEADER_SECURITY_TOKEN, credential.security_token);
  if (credential.domain_id) out.set(HEADER_DOMAIN_ID, credential.domain_id);
  if (!out.containsName(HEADER_XSDK_DATE)) out.set(HEADER_XSDK_DATE, sdkDateNow());
  if (includeHost && !out.containsName("host")) out.set("Host", parsed.authority);
  const date = out.valueOf(HEADER_XSDK_DATE) || "";

  const canonical = out.items.map((i) => ({ name: i.name.toLowerCase(), value: i.value.trim() }));
  canonical.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const canonicalHeaders = canonical.map((c) => `${c.name}:${c.value}\n`).join("");
  const signedHeaders = canonical.map((c) => c.name).join(";");

  let payloadHash = sha256Hex(body || Buffer.alloc(0));
  const overrideHash = canonical.find((c) => c.name === HEADER_CONTENT_SHA256.toLowerCase());
  if (overrideHash && overrideHash.value) {
    payloadHash = overrideHash.value;
  } else if (!requestCarriesBody(method)) {
    payloadHash = EMPTY_BODY_SHA256;
  }

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri(parsed.path),
    canonicalQueryString(parsed.rawQuery),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [SIGNING_ALGORITHM, date, sha256Hex(Buffer.from(canonicalRequest, "utf8"))].join("\n");
  const signature = hmacSha256Hex(credential.secret_access_key, stringToSign);
  out.set(HEADER_AUTHORIZATION,
    `${SIGNING_ALGORITHM} Access=${credential.access_key_id}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return { headers: out.items.map((i) => [i.name, i.value]), canonicalRequest, stringToSign, signedHeaders, signature };
}

// 给请求签名，返回应当发出去的头集合（入参头 + 注入项 + Authorization）
function sign(method, url, headers, body, credential, includeHost) {
  return signMaterial(method, url, headers, body, credential, includeHost).headers;
}

module.exports = { sign, signMaterial, parseUrl, canonicalUri, canonicalQueryString, encodeComponent, sdkDateNow };
