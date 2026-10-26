/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// S3 兼容对象存储传输层（issue #89）：与 webdav.cjs 同一组「按路径的文件级原语」，
// 供 webdav.cjs 按 cfg.__s3 分派——四个同步引擎（技能/用量/号池/记忆）零改动。
// 零 npm 依赖：AWS SigV4 手写签名（node:crypto），阿里云 OSS / 腾讯云 COS /
// Cloudflare R2 / MinIO / 群晖等 S3 兼容服务均可直连。
// 语义映射：list→ListObjectsV2（Delimiter=/ 判目录 + 自动翻页）、get/getText→GET object
// （404 → null，与 WebDAV 语义一致）、put→PUT object、remove→DELETE object +
// 前缀批量删（目录语义）、ensureDir→no-op（S3 无目录概念）、test→ListObjectsV2(max-keys=1)。
// cfg 形状（moduleWebdav 注入）：{ __s3: true, endpoint, username(AK), password(SK),
//   root, bucket, region, pathStyle }——username/password 复用为 AK/SK，让各引擎的
// 「endpoint/账号/密码齐全才算已配置」判断对 S3 原样成立。
"use strict";
const crypto = require("node:crypto");
const { URL } = require("node:url");

const TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [800, 2400]; // 与 webdav.cjs 同款退避（仅 5xx/429 与网络层失败）

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** AWS UriEncode：逐字节，保留 [A-Za-z0-9-._~]，'/' 按需保留（canonical URI 不编码斜杠） */
function uriEncode(str, encodeSlash = true) {
  const bytes = Buffer.from(String(str), "utf8");
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/" && !encodeSlash) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** 从逻辑 URL（joinUrl 产物：endpoint/root/rel，不含 bucket）拆出请求要素：
 *  bucketBase = 桶根（path-style 为 origin/bucket，虚拟.host 为 bucket.host），
 *  keyEncoded = 对象 key 的百分号编码路径（u.pathname 已编码，直接用于签名与请求） */
function parts(url, cfg) {
  const u = new URL(url);
  const keyEncoded = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const key = decodeURIComponent(keyEncoded);
  const bucketBase = cfg.pathStyle === true
    ? `${u.origin}/${uriEncode(cfg.bucket)}`
    : `${u.protocol}//${cfg.bucket}.${u.host}`;
  return { u, key, keyEncoded, bucketBase, requestUrl: `${bucketBase}/${keyEncoded}` };
}

/** SigV4 请求头（全程 UTC）。AK/SK 读自 username/password（moduleWebdav 注入口径），
 *  保留 accessKeyId/secretKey 直传别名（自测可读性） */
function authHeaders(method, requestUrl, cfg, payload, query, extraHeaders = {}) {
  const accessKey = cfg.accessKeyId || cfg.username || "";
  const secretKey = cfg.secretKey || cfg.password || "";
  const u = new URL(requestUrl);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = String(cfg.region || "us-east-1");
  const payloadHash = sha256Hex(payload || "");
  // AWS 规范：签名头名一律小写（fetch 会归一大小写，但 canonical headers 必须按小写签名）
  const headers = {};
  for (const [k, v] of Object.entries({
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  })) headers[k.toLowerCase()] = String(v);
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((k) => `${k}:${String(headers[k]).trim()}\n`)
    .join("");
  const canonicalQuery = Object.keys(query || {})
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const canonicalRequest = [
    method,
    u.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex")}`;
  return headers;
}

/** 取消信号：与 webdav.cjs 共用同一模块级信号（call 时懒 require 避开循环加载） */
function activeSignal() {
  try { return require("./webdav.cjs").syncActiveSignal(); } catch { return null; }
}

function isNetworkError(e) {
  return !!e && typeof e === "object" && (e.name === "AbortError" || e.name === "TimeoutError" || e instanceof TypeError);
}

async function request(method, requestUrl, cfg, body, query, extraHeaders = {}) {
  const payload = body == null ? "" : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"));
  for (let attempt = 0; ; attempt++) {
    const sig = activeSignal();
    if (sig && sig.aborted) throw Object.assign(new Error("同步已取消"), { name: "AbortError" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = authHeaders(method, requestUrl, cfg, payload, query, extraHeaders);
      // query 既要参与签名，也必须真的拼到请求 URL 上（否则服务端收不到参数、签名也对不上）
      const canonicalQuery = Object.keys(query || {})
        .sort()
        .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
        .join("&");
      const fetchUrl = canonicalQuery ? `${requestUrl}?${canonicalQuery}` : requestUrl;
      const res = await fetch(fetchUrl, {
        method,
        headers: { ...headers, ...(payload.length ? { "Content-Type": "application/octet-stream" } : {}) },
        body: payload.length ? payload : undefined, // 空 Buffer 也是 truthy，GET/HEAD 不能带 body
        signal: sig && typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, sig]) : controller.signal,
      });
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        try { await res.arrayBuffer(); } catch { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return res;
    } catch (e) {
      const sig2 = activeSignal();
      if (sig2 && sig2.aborted) throw e;
      if (attempt < RETRY_DELAYS_MS.length && isNetworkError(e)) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 解析 ListObjectsV2 XML：本应用只用 Key / CommonPrefixes/Prefix / IsTruncated / NextContinuationToken。
 *  注意 keys/dirs 保持**服务器返回的 XML 转义原形**（不在此处反转义）：
 *  - list() 消费时自行 xmlUnescape（拿到人类可读的文件名）；
 *  - remove() 直接把原形回填进 <Delete> 请求体——XML 转义形式在 XML 中正好合法。
 *  两处口径不同是有意为之，改动时须同时看这两个消费方。 */
function parseListXml(xml) {
  const keys = [];
  const keyRe = /<Key>([\s\S]*?)<\/Key>/g;
  let m;
  while ((m = keyRe.exec(xml)) !== null) keys.push(m[1]);
  const dirs = [];
  const cpRe = /<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g;
  while ((m = cpRe.exec(xml)) !== null) {
    const pm = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(m[0]);
    if (pm) dirs.push(pm[1]);
  }
  return {
    keys,
    dirs,
    truncated: /<IsTruncated>true<\/IsTruncated>/i.test(xml),
    token: (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml) || [])[1] || "",
  };
}

function stripPrefix(name, prefix) {
  return prefix ? name.replace(new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "") : name;
}

/** ListObjectsV2 的 XML 里 Key 只做 XML 实体转义、不做百分号编码——
 *  对它 decodeURIComponent 会把字面 %XX 序列解坏（甚至 URIError 炸掉整次列举），
 *  这里只反转义 XML 实体（&amp; 必须最后） */
function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 列目录（Delimiter=/ 判目录 + 自动翻页）：返回与 webdav.list 同形的条目 */
async function list(url, cfg) {
  const { key, bucketBase } = parts(url, cfg);
  const prefix = key ? key + "/" : "";
  const out = [];
  const seen = new Set();
  let token = "";
  for (;;) {
    const query = { "list-type": "2", prefix, delimiter: "/", "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const res = await request("GET", bucketBase, cfg, "", query);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`PROPFIND 失败：HTTP ${res.status}`);
    const parsed = parseListXml(await res.text());
    for (const k of parsed.keys) {
      const name = stripPrefix(xmlUnescape(k), prefix);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // href 与 WebDAV 侧保持同一契约（「可直接使用的完整 URL」）：name 已 XML 反转义，
      // 拼回 URL 前必须百分号编码，否则含空格/中文/& 的文件名会得到非法 URL
      out.push({ href: url.replace(/\/+$/, "") + "/" + encodeURIComponent(name), name, isDir: false, size: 0, modified: null });
    }
    for (const d of parsed.dirs) {
      const name = stripPrefix(xmlUnescape(d), prefix).replace(/\/+$/, "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ href: url.replace(/\/+$/, "") + "/" + encodeURIComponent(name), name, isDir: true, size: 0, modified: null });
    }
    if (!parsed.truncated || !parsed.token) break;
    token = parsed.token;
  }
  return out;
}

async function get(url, cfg) {
  const { requestUrl } = parts(url, cfg);
  const res = await request("GET", requestUrl, cfg, "", {});
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 403) throw new Error("GET 失败：HTTP 403，请检查 AccessKeyId / SecretKey 与桶权限");
    throw new Error(`GET 失败：HTTP ${res.status}`);
  }
  // 与 webdav.cjs getDav 同一道体积护栏（读取前按响应头判断，防远端异常大文件把主进程内存打爆）
  const len = Number(res.headers.get("content-length") || 0);
  const maxMB = Number(process.env.AGENTHUB_WEBDAV_MAX_DOWNLOAD_MB || 0) || 512;
  if (len > maxMB * 1048576) {
    throw new Error(`远端文件约 ${(len / 1048576).toFixed(1)}MB，超过单次下载上限 ${maxMB}MB，已中止（避免内存耗尽）`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function getText(url, cfg) {
  const buf = await get(url, cfg);
  return buf == null ? null : buf.toString("utf8");
}

async function put(url, cfg, text) {
  const { requestUrl } = parts(url, cfg);
  const res = await request("PUT", requestUrl, cfg, text, {});
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    if (res.status === 403) throw new Error(`PUT 失败：HTTP 403，服务器拒绝写入，请检查 AccessKeyId/SecretKey 写权限与桶名`);
    throw new Error(`PUT 失败：HTTP ${res.status}`);
  }
}

/** 删除远端「文件或目录」：先删本 key（404 幂等），再按前缀批量删子对象（目录语义；
 *  文件时前缀列举通常为空集）。与 webdav.remove 的「DELETE 集合即递归删」对齐。 */
async function remove(url, cfg) {
  const { key, requestUrl, bucketBase } = parts(url, cfg);
  const res = await request("DELETE", requestUrl, cfg, "", {});
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    if (res.status === 403) throw new Error("DELETE 失败：HTTP 403，请检查 AccessKeyId/SecretKey 删除权限");
    throw new Error(`DELETE 失败：HTTP ${res.status}`);
  }
  const prefix = key ? key + "/" : "";
  if (!prefix) return;
  for (;;) {
    const lres = await request("GET", bucketBase, cfg, "", { "list-type": "2", prefix, "max-keys": "1000" });
    if (!lres.ok) return; // 列举失败不阻断（与 404 幂等同口径，下轮同步自愈）
    const parsed = parseListXml(await lres.text());
    if (!parsed.keys.length) return;
    // POST /?delete 批量删（S3 规范要求 Content-MD5）
    const xmlBody = "<Delete>" + parsed.keys.map((k) => `<Object><Key>${k}</Key></Object>`).join("") + "</Delete>";
    const md5 = crypto.createHash("md5").update(xmlBody, "utf8").digest("base64");
    const dres = await request("POST", bucketBase, cfg, xmlBody, { delete: "" }, { "content-md5": md5 });
    if (!dres.ok && dres.status !== 200 && dres.status !== 204) {
      throw new Error(`DELETE 失败：HTTP ${dres.status}（批量删除 ${parsed.keys.length} 个子对象）`);
    }
    if (!parsed.truncated || !parsed.token) return;
  }
}

/** ensureDir：S3 无目录概念，no-op（与引擎的逐级建目录调用兼容） */
async function ensureDir() {
  return;
}

/** 测试连接：ListObjectsV2(max-keys=1)，按状态码给可读提示（同 webdav.test 返回形状） */
async function test(cfg) {
  const started = Date.now();
  if (!cfg.bucket) return { ok: false, message: "请填写桶名（Bucket）" };
  try {
    const { bucketBase } = parts(`${cfg.endpoint.replace(/\/+$/, "")}/${cfg.root || ""}/`, cfg);
    const res = await request("GET", bucketBase, cfg, "", { "list-type": "2", "max-keys": "1" });
    if (res.status === 200) {
      const insecure = String(cfg.endpoint || "").toLowerCase().startsWith("http://")
        ? "；当前使用 http://，SecretKey 将明文传输，建议改用 https"
        : "";
      return { ok: true, message: `连接成功 · ${Date.now() - started}ms${insecure}`, latencyMs: Date.now() - started };
    }
    if (res.status === 403) {
      return { ok: false, message: `S3 访问被拒绝（HTTP 403）· ${Date.now() - started}ms，请检查 AccessKeyId / SecretKey`, latencyMs: Date.now() - started };
    }
    if (res.status === 404) {
      return { ok: false, message: `桶不存在（HTTP 404），请检查桶名`, latencyMs: Date.now() - started };
    }
    return { ok: false, message: `连接失败：HTTP ${res.status}（${Date.now() - started}ms）`, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, message: `无法连接：${networkKind(e)}`, latencyMs: Date.now() - started };
  }
}

/** 网络层异常分类（与 webdav.cjs 同口径） */
function networkKind(e) {
  if (!e) return "网络错误";
  if (e.name === "AbortError") return "已取消";
  const msg = String(e.message || "");
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "DNS 解析失败（地址域名无法解析）";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝（目标服务未启动或端口不通）";
  if (/ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "网络连接异常";
  return `网络错误（${msg || e.name}）`;
}

module.exports = { list, get, getText, put, remove, ensureDir, test, networkKind, uriEncode };
