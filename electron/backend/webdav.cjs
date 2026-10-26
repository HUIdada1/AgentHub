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
// WebDAV 客户端（原生 fetch 实现）
// 协议子集：PROPFIND / GET / PUT / MKCOL，Basic 认证，XML multistatus 解析
"use strict";

const TIMEOUT_MS = 30000;

// 网络抖动/服务端瞬时错误的重试：仅对幂等方法与可重试状态码生效，退避 800ms / 2400ms
const RETRY_DELAYS_MS = [800, 2400];

/** 可被取消信号打断的 sleep：取消时立即 reject AbortError，而非等退避结束 */
function interruptibleSleep(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error("同步已取消"), { name: "AbortError" }));
    };
    const cleanup = () => {
      if (activeSignal) activeSignal.removeEventListener("abort", onAbort);
    };
    if (activeSignal) {
      if (activeSignal.aborted) return onAbort();
      activeSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// 标准 PROPFIND 请求体（部分 WebDAV 服务器要求非空 body 才返回 207）
const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

function normalizeEndpoint(endpoint) {
  let e = String(endpoint || "").trim();
  if (!e) return "";
  if (!/^https?:\/\//i.test(e)) e = "http://" + e;
  return e.replace(/\/+$/, "");
}

/** 拼接 URL：endpoint + root + 相对路径 */
function joinUrl(endpoint, root, rel) {
  const base = normalizeEndpoint(endpoint);
  const parts = [base];
  if (root) parts.push(String(root).replace(/^\/+|\/+$/g, ""));
  if (rel) parts.push(String(rel).replace(/^\/+|\/+$/g, ""));
  return parts.filter(Boolean).join("/");
}

function authHeader(cfg) {
  const u = cfg.username || "";
  const p = cfg.password || "";
  const token = Buffer.from(`${u}:${p}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

// 当前同步任务的取消信号（sync.cjs 每轮 run 注入）：取消同步时立即中断在途
// 网络请求，否则要等 fetch 完成或 30s 超时（含重试最坏约 90s）才停。
// 本应用同时只有一个同步任务，模块级信号是安全的。
let activeSignal = null;

function setActiveSignal(signal) {
  activeSignal = signal || null;
}

/** s3.cjs 共用同一取消信号（call 时懒加载，避免循环 require） */
function syncActiveSignal() {
  return activeSignal;
}

// ===== S3 兼容存储分派（issue #89）：cfg.__s3 为真走 S3 传输（AK/SK 复用 username/password 字段），
// 七个原语语义与 WebDAV 一一对齐，四个同步引擎零改动
const s3 = require("./s3.cjs");
const isS3 = (cfg) => !!(cfg && cfg.__s3);

// ===== 跨模块同步互斥（issue #92 前置） =====
// activeSignal 只表达「取消当前在途请求」，不表达「有同步在跑」。技能/用量/号池/记忆
// 四个模块各有手动与定时入口，号池定时上线后两模块并发会互相抢取消信号、重复上传。
// 全应用同一时刻只放行一个远端同步任务：抢不到的入口直接跳过（定时任务下轮补跑，
// 手动入口把原因提示给用户）。模块自身的防重入（isRunning / state.running）仍各自保留。
let syncRunTag = null;
let syncRunAt = 0;

/** 尝试占住全应用唯一的远端同步槽位；被占用返回 false（调用方跳过本轮） */
function tryBeginSync(tag) {
  if (syncRunTag) return false;
  syncRunTag = String(tag || "sync");
  syncRunAt = Date.now();
  return true;
}

function endSync() {
  syncRunTag = null;
  syncRunAt = 0;
}

/** 当前占用者标签（null = 空闲），供入口提示与自测 */
function syncBusyTag() {
  return syncRunTag;
}

/** 当前同步已持锁时长（ms，空闲返回 0）：主进程 watchdog 据此记录疑似卡死 */
function syncHeldMs() {
  return syncRunTag ? Date.now() - syncRunAt : 0;
}

/** 网络层异常分类：超时 / 无法连接 / 取消 / 其他，供上层给出明确提示 */
function networkKind(e) {
  if (!e) return "网络错误";
  if (e.name === "AbortError") return activeSignal && activeSignal.aborted ? "已取消" : "连接超时";
  const msg = String(e.message || "");
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "DNS 解析失败（地址域名无法解析）";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝（目标服务未启动或端口不通）";
  if (/ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "网络连接异常";
  return `网络错误（${msg || e.name}）`;
}

/** 把 WebDAV 请求结果统一成带分类的错误消息（仅网络层异常做分类；业务/HTTP 错误保留原文） */
function describeFailure(action, e) {
  if (e && e.name === "AbortError") return `${action}已取消`;
  return `${action}失败：${networkKind(e)}`;
}

/** 判断异常是否来自 fetch 网络层（连接失败/超时/取消），区别于 HTTP 状态错误与本地业务错误 */
function isNetworkError(e) {
  if (!e || typeof e !== "object") return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  // undici 网络层失败固定为 TypeError("fetch failed")，HTTP 状态错误由本模块显式构造
  return e instanceof TypeError;
}

async function request(method, url, cfg, body, headers = {}) {
  // 重试仅针对网络层失败与 5xx/429；4xx（除 429）为确定性错误，立即返回交由上层提示
  for (let attempt = 0; ; attempt++) {
    if (activeSignal && activeSignal.aborted) {
      throw Object.assign(new Error("同步已取消"), { name: "AbortError" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: authHeader(cfg),
          ...(body ? { "Content-Type": "application/octet-stream" } : {}),
          Depth: "1",
          ...headers,
        },
        body: body || undefined,
        signal:
          activeSignal && typeof AbortSignal.any === "function"
            ? AbortSignal.any([controller.signal, activeSignal])
            : controller.signal,
      });
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        // 消费掉响应体以释放连接，再退避重试
        try { await res.arrayBuffer(); } catch { /* 忽略 */ }
        await interruptibleSleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return res;
    } catch (e) {
      // 取消触发的 abort 不重试，直接上抛（sync.cjs 据此走 cancelled 收尾）
      if (activeSignal && activeSignal.aborted) throw e;
      if (attempt < RETRY_DELAYS_MS.length) {
        await interruptibleSleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 解析 PROPFIND 返回的 multistatus XML：逐 response 块提取 href，并依据
 * resourcetype 中是否含 collection 判断目录（部分服务器不给目录 href 加尾斜杠，
 * 仅靠尾斜杠会把目录误判成文件）。兼容任意命名空间前缀。
 */
function parseEntries(xml) {
  const out = [];
  const blockRe = /<(?:[\w.-]+:)?response[\s>]([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  const hrefRe = /<(?:[\w.-]+:)?href>([^<]+)<\/(?:[\w.-]+:)?href>/i;
  const collRe = /<(?:[\w.-]+:)?collection\s*\/?\s*>/i;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const hm = hrefRe.exec(block);
    if (!hm || !hm[1]) continue;
    out.push({ href: hm[1], isCollection: collRe.test(block) });
  }
  return out;
}

/**
 * 列出目录下所有条目。
 * 返回 [{ href, name, isDir, size, modified }]
 */
async function listDav(url, cfg) {
  const res = await request("PROPFIND", url, cfg, PROPFIND_BODY, { "Content-Type": "application/xml; charset=utf-8" });
  if (res.status === 404) return [];
  if (res.status === 207 || res.status === 200) {
    const xml = await res.text();
    const entries = parseEntries(xml);
    const result = [];
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.href)) continue;
      seen.add(e.href);
      result.push({
        href: e.href,
        name: decodeURIComponent(String(e.href).split("/").filter(Boolean).pop() || ""),
        isDir: e.isCollection || String(e.href).endsWith("/"),
        size: 0,
        modified: null,
      });
    }
    return result;
  }
  if (res.status === 405 || res.status === 501) {
    // 服务器不支持 PROPFIND，降级为空
    return [];
  }
  throw new Error(`PROPFIND 失败：HTTP ${res.status}`);
}

/** 分派入口：S3 兼容存储走 s3.cjs，其余走 WebDAV（issue #89） */
async function list(url, cfg) {
  return isS3(cfg) ? s3.list(url, cfg) : listDav(url, cfg);
}

async function getDav(url, cfg) {
  const res = await request("GET", url, cfg);
  if (res.status === 404) return null;
  if (!res.ok) {
    // 409 在 GET 上几乎总是「父集合不存在」而非「冲突」：直接报 409 会把「远端目录没建」
    // 误导成数据冲突，排查方向全错。给出可操作的说明。
    if (res.status === 409) {
      throw new Error(`GET 失败：HTTP 409（父目录不存在）${url}——远端目录尚未创建，请先确保目录存在再读取`);
    }
    throw new Error(`GET 失败：HTTP ${res.status}`);
  }
  // 读取前先看响应头体积：get 是整体入内存（arrayBuffer），远端异常大文件会把主进程 OOM。
  // 超限即中止并说明原因，避免内存耗尽；上限可用 AGENTHUB_WEBDAV_MAX_DOWNLOAD_MB 覆盖（s3.cjs 同值，两处需一致）
  const len = Number(res.headers.get("content-length") || 0);
  const maxMB = Number(process.env.AGENTHUB_WEBDAV_MAX_DOWNLOAD_MB || 0) || 512;
  if (len > maxMB * 1048576) {
    throw new Error(`远端文件约 ${(len / 1048576).toFixed(1)}MB，超过单次下载上限 ${maxMB}MB，已中止（避免内存耗尽；确认需要时可用 AGENTHUB_WEBDAV_MAX_DOWNLOAD_MB 调大）`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function get(url, cfg) {
  return isS3(cfg) ? s3.get(url, cfg) : getDav(url, cfg);
}

/** 读取远端文件并解码为 UTF-8 文本 */
async function getText(url, cfg) {
  const buf = await get(url, cfg);
  return buf == null ? null : buf.toString("utf8");
}

async function putDav(url, cfg, text) {
  const res = await request("PUT", url, cfg, text);
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`PUT 失败：HTTP ${res.status}，服务器拒绝写入，请检查账号写权限和 WebDAV 根目录（${url}）`);
    }
    // 409 在 PUT 上多为「父集合不存在」（也可能是中间缺层），不是数据冲突
    if (res.status === 409) {
      throw new Error(`PUT 失败：HTTP 409（父目录不存在）${url}——请先创建远端目录（ensureDir）再上传`);
    }
    throw new Error(`PUT 失败：HTTP ${res.status}（${url}）`);
  }
}

async function put(url, cfg, text) {
  return isS3(cfg) ? s3.put(url, cfg, text) : putDav(url, cfg, text);
}

/** 删除远端文件/目录（WebDAV DELETE 对集合为递归删除）；404 视为已删除（幂等） */
async function removeDav(url, cfg) {
  const res = await request("DELETE", url, cfg);
  if (res.ok || res.status === 404) return;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`DELETE 失败：HTTP ${res.status}，请检查账号删除权限（${url}）`);
  }
  throw new Error(`DELETE 失败：HTTP ${res.status}（${url}）`);
}

async function remove(url, cfg) {
  return isS3(cfg) ? s3.remove(url, cfg) : removeDav(url, cfg);
}

/** 确保业务目录存在：从 endpoint 已存在路径之后开始逐级 MKCOL。S3 无目录概念，直接放行 */
async function ensureDirDav(url, cfg) {
  const u = new URL(url);
  const endpoint = new URL(normalizeEndpoint(cfg.endpoint));
  if (u.origin !== endpoint.origin) throw new Error(`WebDAV 地址不一致：${url}`);
  const endpointPath = endpoint.pathname.replace(/\/+$/, "");
  const targetPath = u.pathname.replace(/\/+$/, "");
  if (!targetPath.startsWith(endpointPath)) throw new Error(`WebDAV 目录不在 endpoint 下：${url}`);
  const extra = targetPath.slice(endpointPath.length).split("/").filter(Boolean);
  let current = `${endpoint.origin}${endpointPath}`;
  for (const seg of extra) {
    current += "/" + seg;
    const res = await request("MKCOL", current, cfg);
    // 已存在（405/409）、已跳转（301）等均视为成功
    if (!res.ok && res.status !== 405 && res.status !== 409 && res.status !== 301) {
      if (res.status === 403) throw new Error(`WebDAV 无权创建目录：HTTP 403，请检查账号写权限和根目录（${current}）`);
      throw new Error(`创建目录失败：HTTP ${res.status} ${current}`);
    }
  }
}

async function ensureDir(url, cfg) {
  return isS3(cfg) ? s3.ensureDir(url, cfg) : ensureDirDav(url, cfg);
}

/** http 明文传输提醒（账号密码经 Basic 认证发送，https 之外一律明文） */
function insecureHint(cfg) {
  return normalizeEndpoint(cfg.endpoint).toLowerCase().startsWith("http://")
    ? "；当前使用 http://，账号密码将明文传输，建议改用 https"
    : "";
}

/** 测试连接：对根目录 PROPFIND（Depth 0），逐类错误码给出可读提示 */
async function testDav(cfg) {
  const started = Date.now();
  let url;
  try {
    url = joinUrl(cfg.endpoint, cfg.root, "");
  } catch {
    return { ok: false, message: "地址格式无效" };
  }
  let res;
  try {
    res = await request("PROPFIND", url, cfg, PROPFIND_BODY, {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    });
  } catch (e) {
    // 网络层失败：按超时 / DNS / 拒绝连接等分类给出可读提示
    return { ok: false, message: `无法连接：${networkKind(e)}`, latencyMs: Date.now() - started };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `WebDAV 访问被拒绝（HTTP ${res.status}）· ${Date.now() - started}ms，请检查账号密码与账号对根目录的权限`, latencyMs: Date.now() - started };
  }
  if (res.status === 404) {
    return { ok: true, message: `连接成功 · ${Date.now() - started}ms（目录尚未创建，首次同步将自动创建）${insecureHint(cfg)}`, latencyMs: Date.now() - started };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, message: `连接成功 · ${Date.now() - started}ms${insecureHint(cfg)}`, latencyMs: Date.now() - started };
  }
  return { ok: false, message: `连接失败：HTTP ${res.status}（${Date.now() - started}ms）`, latencyMs: Date.now() - started };
}

async function test(cfg) {
  return isS3(cfg) ? s3.test(cfg) : testDav(cfg);
}

module.exports = { joinUrl, normalizeEndpoint, list, get, getText, put, remove, ensureDir, test, setActiveSignal, syncActiveSignal, networkKind, describeFailure, isNetworkError, tryBeginSync, endSync, syncBusyTag, syncHeldMs };
