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
// 通用上游 HTTP、超时与 SSE 读取；不包含任何供应商协议或账号操作。
"use strict";
const config = require("../config.cjs");
const util = require("../proxy/util.cjs");
const netproxy = require("../proxy/netproxy.cjs");
const transport = require("../proxy/transport-context.cjs");
function proxyConfig() {
  try { return (config.loadConfig && config.loadConfig().proxy) || {}; }
  catch { return {}; }
}
const FIRST_BYTE_MS = 30000; // 首 token 30s 超时判失败。实测成功请求 TTFT P99≈8.7s、最大 20.2s，
// 10s 会误杀慢模型/thinking 首包（上游无首字节总超时，读空闲容忍 300s，这里取全覆盖+余量的折中）
const FIRST_BYTE_MAX_MS = 180000; // 首字节预算封顶（超长 prompt 的 prefill 可能上百秒）
const FIRST_BYTE_PER_10K_MS = 1000; // 每 1 万输入 token 追加的预算
const STREAM_IDLE_MS = 300000; // 流中读超时 300s

/** 从配置读取超时值（0/缺省/非法 → 内置默认；保证可运行时调整且不被脏配置打穿） */
function timeoutMs(key, fallback) {
  const n = Number((proxyConfig() || {})[key]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** 估算输入规模（按序列化字符数折算 token，中英混排约 3 字符/token；宁高勿低，避免误杀超大 prompt） */
function estimateInputTokens(payload) {
  return Math.ceil(String(payload == null ? "" : payload).length / 3);
}

/**
 * 按 prompt 规模算首字节预算：基准 30s + 每 1 万输入 token 追加 1s，封顶 180s。
 * 固定 30s 打不过超大 prompt：实测 54 万 token 的蒸馏请求，同一批 prompt 在 WorkBuddy CN 渠道
 * 首字节就要 35–38s，于是每次都被判"首字节超时"，连续 3 次即把账号熔断 30 分钟。
 * 小请求仍是 30s 起步，不放松对真正卡死上游的判定。
 */
function firstByteBudgetMs(payload) {
  const base = timeoutMs("firstByteBaseMs", FIRST_BYTE_MS);
  const cap = timeoutMs("firstByteMaxMs", FIRST_BYTE_MAX_MS);
  const extra = Math.floor(estimateInputTokens(payload) / 10000) * FIRST_BYTE_PER_10K_MS;
  return Math.min(base + extra, cap);
}

// ===== HTTP 基础 =====

/** 流式请求：首字节超时内必须拿到响应头并开始产出，否则 abort 判失败（可故障转移）
 *  opts.firstByteMs 由调用方按 prompt 规模给定（缺省 FIRST_BYTE_MS） */
async function fetchStream(url, opts) {
  const { firstByteMs, ...rest } = opts || {};
  const budgetMs = Math.max(1000, Number(firstByteMs) || timeoutMs("firstByteBaseMs", FIRST_BYTE_MS));
  const ctrl = new AbortController();
  // 到点置位：调用方据此区分「网关首字节预算掐断」与「上游自己断流」——两者都表现为
  // body 读失败，只有这个标志能把截断如实归因并给出可执行文案（issue #107 的根因即在
  // 调用方既没解除计时器、又无法分辨这次失败是超时还是断流）
  let budgetFired = false;
  const timer = setTimeout(() => { budgetFired = true; ctrl.abort(); }, budgetMs);
  let resp;
  try {
    // redirect 默认 follow，但**必须允许调用方覆盖**：Qoder 的请求头带签名且签名覆盖
    // path+query，301 重定向后签名必然失效（实测 gateway http→301 https 真实存在），
    // 故它传 redirect:"error" 要明确报错而非跟随。原先写死 "follow" 会吃掉该参数。
    // 统一出口兜底：header 值必须是 ByteString，中文机器名/设备名会让 fetch 在发请求前抛错。
    // 只在值含非 Latin-1 时改写，ASCII 请求逐字节不变（issue #148）。
    resp = await netproxy.fetchThrough(url, { redirect: "follow", ...rest, headers: util.byteSafeHeaders(rest.headers), signal: transport.signalFor(rest.signal ? AbortSignal.any([rest.signal, ctrl.signal]) : ctrl.signal) });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = budgetFired;
    // 走了出口就把它带进文案：代理不通与上游不通在日志里必须能一眼分开（netproxy 挂上来的标记）
    const via = e && e.netproxy ? `（出口：${e.netproxy.name}）` : "";
    throw Object.assign(
      new Error(timedOut ? `上游首字节超时（${Math.round(budgetMs / 1000)}s）` : `网络错误：${e.message}${via}`),
      {
        network: true,
        // 首字节超时是"这次请求太大 / 上游这一刻慢"，不是账号故障：分类器据此**不计入熔断**、
        // 也不落账号冷却，否则一次慢请求就能把整条渠道冻结半小时（实测事故根因）
        firstByteTimeout: timedOut,
        netproxy: e?.netproxy,
      }
    );
  }
  if (!resp.ok) {
    const text = await transport.readText(resp).catch(() => "");
    clearTimeout(timer);
    const err = Object.assign(new Error(`上游 HTTP ${resp.status}：${text.slice(0, 200)}`), {
      status: resp.status,
      body: text,
      // 上游明示的限流等待（Retry-After 三头族，P1-2），分类器据此对齐墙钟
      retryAfterMs: util.parseRetryAfterHeaders(resp.headers),
    });
    throw err;
  }
  return { resp, cancelTimer: () => clearTimeout(timer), budgetFired: () => budgetFired };
}

/** 普通 JSON 请求（额度查询 / token 刷新），默认 60s 总超时（上游 120s 口径的折中：含冷启动排队）；
 *  超时值可经 proxy.httpJsonTimeoutMs 配置（0/缺省回退 60s 内置默认） */
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const budget = timeoutMs("httpJsonTimeoutMs", 60000);
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    // 同 fetchStream：header 值统一转 ByteString（仅非 Latin-1 项变化）
    const resp = await netproxy.fetchThrough(url, { ...opts, headers: util.byteSafeHeaders(opts && opts.headers), signal: opts?.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal });
    const text = await transport.readText(resp, 8 * 1024 * 1024, budget);
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应留原文 */ }
    return { status: resp.status, ok: resp.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 逐块读 SSE：web stream 异步迭代 + 空闲判死（默认 300s，可经 proxy.streamIdleMs 配置）；
 *  客户端断连后继续消费至 EOF（保 usage 完整） */
async function pumpSse(resp, onEvent) {
  const scanner = new util.SseScanner(onEvent);
  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  const idleMs = timeoutMs("streamIdleMs", STREAM_IDLE_MS);
  // 单个 idle 定时器循环重置：原来每读一个 chunk 就新挂一个定时器且旧的不清，
  // 长流（几千 chunk）会同时挂几千个待触发定时器，高并发时随流量线性膨胀
  let idleTimer = null;
  const armIdle = () =>
    new Promise((_, rej) => {
      idleTimer = setTimeout(() => rej(Object.assign(new Error(`流中读超时（${Math.round(idleMs / 1000)}s）`), { idleTimeout: true })), idleMs);
    });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), armIdle()]);
      clearTimeout(idleTimer);
      idleTimer = null;
      if (read.done) break;
      scanner.feed(decoder.decode(read.value, { stream: true }));
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    try { reader.cancel().catch(() => {}); } catch { /* 正常完成或已取消无需处理 */ }
  }
  scanner.feed(decoder.decode());
  scanner.flush();
}


module.exports = { timeoutMs, estimateInputTokens, firstByteBudgetMs, fetchStream, httpJson, pumpSse, FIRST_BYTE_MS, FIRST_BYTE_MAX_MS };
