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
// 反代网关 · 平台适配层 · 纯 Node 实现（Docker headless 形态）
// 无 Electron 环境时：能做的做（结构化日志），不能做的诚实拒绝（人机校验交回 needCaptcha）。
// 日志统一过 redact——容器日志会被 docker logs / 采集器落盘，凭据明文不得进日志。
//
// fetchBinary / localProxyCandidates（2026-11-12 板块 4C 新增）：
// 插件更新器的网络出口，用 undici（容器由 gateway/package.json 提供，桌面由根 package.json 提供）。
// 代理口径与桌面**刻意不同**：只认调用方从 HTTPS_PROXY / HTTP_PROXY 等环境变量里挑出的规则，
// 绝不探本机端口——容器里的 127.0.0.1 是容器自己，探 7897/7890 只会得到假阴性并白等超时。
"use strict";

let redact = (s) => String(s);
try { redact = require("../redact.cjs").redact; } catch { /* redact 不可用时原样输出 */ }

const FETCH_TIMEOUT_MS = 30 * 1000;            // 与桌面实现同一默认值
const MAX_BINARY_BYTES = 200 * 1024 * 1024;    // 与插件包上限一致

/** 关掉本次调用建的代理连接池（更新器是小流量，不做 LRU 缓存） */
async function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  try { await dispatcher.close(); } catch { /* 已关闭或从未连上 */ }
}

/** 错误链下钻：undici 的真实原因常挂在 cause 上（connect ECONNREFUSED / ENOTFOUND…） */
function describeChain(error) {
  const parts = [];
  let cur = error;
  for (let i = 0; i < 5 && cur; i++) {
    const text = String(cur.code || cur.message || cur);
    if (text && !parts.includes(text)) parts.push(text);
    cur = cur.cause;
  }
  return parts.join(" → ") || "连接失败";
}

/**
 * 归一化拉取异常：调用方（plugin-updater.fetchWithProxyFallback）靠两条信息决策——
 * ①有 httpStatus 就别换代理（换也解决不了）；②网络类错误要继续试下一个候选。
 * undici 把真因埋在 cause 里，直接抛出去会变成 `TypeError: fetch failed`，
 * 两条判据都落空 → 这里显式补齐（桌面实现不经此函数，行为完全不变）。
 */
function normalizeFetchError(cause, timeoutMs) {
  const name = String((cause && cause.name) || "");
  if (name === "AbortError" || name === "TimeoutError") {
    return Object.assign(new Error(`插件源请求超时（${Math.round(timeoutMs / 1000)} 秒）`), { networkLike: true, cause });
  }
  return Object.assign(new Error(`插件源请求失败：${describeChain(cause)}`), { networkLike: true, cause });
}

function log(level, msg, meta) {
  const text = meta === undefined ? String(msg) : `${msg} ${JSON.stringify(meta)}`;
  (console[level] || console.log)(redact(text));
}

// request 事件每请求一条，日志按 5% 采样；订阅者（SSE）永远收到全部事件
const REQUEST_LOG_SAMPLE = 0.05;

/** 事件订阅（网关 SSE 广播用）：返回退订函数 */
const emitListeners = new Set();
function onEmit(fn) {
  emitListeners.add(fn);
  return () => emitListeners.delete(fn);
}

module.exports = {
  emit(payload) {
    const t = payload && payload.type;
    if (!t) return;
    if (t !== "request" || Math.random() < REQUEST_LOG_SAMPLE) log("log", `[gateway] ${t}`, payload);
    for (const fn of emitListeners) {
      try {
        fn(payload);
      } catch {
        /* 单个订阅者异常不影响其它 */
      }
    }
  },

  onEmit,

  getDataDir() {
    return require("../../config.cjs").dataDir();
  },

  // 无图形环境：不假装能过人机校验，交回 needCaptcha 让调用方走人工
  // （桌面版号池页手动领取，账号经 WebDAV/S3 号池同步过来）
  solveCaptcha() {
    return Promise.resolve({
      ok: false,
      needCaptcha: true,
      message: "无图形环境无法过人机校验；请在桌面版号池页手动领取（账号经号池同步过来）",
    });
  },

  version() {
    // 上四级即仓库根（electron/backend/proxy/platform → 容器内 /app），读根 package.json 的版本
    try { return require("../../../../package.json").version || ""; } catch { return ""; }
  },

  log,

  // 无图形环境：打开外链/目录的调用点均为桌面 IPC，容器形态不可达，安静忽略
  openExternal() { return Promise.resolve(); },
  openPath() { return Promise.resolve(); },

  // ===== 更新器网络出口（板块 4C）=====
  /**
   * 容器形态没有「本机代理端口」这回事：127.0.0.1 是容器自己，探 7897/7890 只会
   * 白等 250ms×5 再得到假阴性。代理一律由调用方从 HTTPS_PROXY / HTTP_PROXY 等
   * 环境变量里挑出规则传进来（见 plugin-updater.proxyCandidates）。
   */
  localProxyCandidates() {
    return Promise.resolve([]);
  },

  /**
   * 拉一个 URL 成 Buffer。语义与桌面实现逐条对齐：
   *   · 非 2xx → error.httpStatus 已置位（调用方据此**不**换代理，换也没用）
   *   · 超过 maxBytes → 「插件源响应超过大小限制」
   *   · 超时 → 「插件源请求超时」
   *   · 其余网络错误 → 消息里带上真实 cause 的 code（ECONNREFUSED / ENOTFOUND…），
   *     否则 undici 的 `TypeError: fetch failed` 会让调用方认不出这是网络类错误、
   *     从而错过「换下一个代理重试」的分支。
   */
  async fetchBinary(url, opts = {}) {
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_BINARY_BYTES;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : FETCH_TIMEOUT_MS;
    const rule = String(opts.proxyRule || "").trim();
    // 延迟 require：容器由 gateway/package.json 提供 undici，桌面由根 package.json 提供；
    // 顶层 require 会让「没装 undici」的安装包在启动期就崩（与 netproxy.agentFor 同一理由）
    const { fetch: undiciFetch, ProxyAgent, Socks5ProxyAgent } = require("undici");
    let dispatcher = null;
    if (rule) {
      const scheme = /^(socks5h?):\/\//i.test(rule) ? "socks5" : /^(https?):\/\//i.test(rule) ? "http" : "";
      if (!scheme) {
        const error = new Error(`插件源代理协议不支持（只认 http/https/socks5）：${rule}`);
        error.code = "ERR_PROXY_UNSUPPORTED";
        throw error;
      }
      const Ctor = scheme === "socks5" ? Socks5ProxyAgent : ProxyAgent;
      if (typeof Ctor !== "function") {
        const error = new Error(`当前 undici 版本不支持该代理类型（${scheme}）：${rule}`);
        error.code = "ERR_PROXY_UNSUPPORTED";
        throw error;
      }
      dispatcher = new Ctor(rule);
    }
    let response;
    try {
      response = await undiciFetch(url, {
        method: "GET",
        redirect: "follow",
        dispatcher: dispatcher || undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      await closeDispatcher(dispatcher);
      throw normalizeFetchError(cause, timeoutMs);
    }
    try {
      if (response.status < 200 || response.status >= 300) {
        try { await response.body?.cancel(); } catch { /* 已消费 */ }
        throw Object.assign(new Error(`插件源返回 HTTP ${response.status}`), { httpStatus: response.status });
      }
      const chunks = [];
      let size = 0;
      const body = response.body;
      if (body && typeof body[Symbol.asyncIterator] === "function") {
        for await (const chunk of body) {
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += piece.length;
          if (size > maxBytes) throw new Error("插件源响应超过大小限制");
          chunks.push(piece);
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error("插件源响应超过大小限制");
        return buffer;
      }
      return Buffer.concat(chunks);
    } finally {
      await closeDispatcher(dispatcher);
    }
  },
};
