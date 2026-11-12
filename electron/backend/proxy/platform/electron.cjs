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
// 反代网关 · 平台适配层 · Electron 实现（桌面壳）
// 各模块里散落的 require("electron") 收敛到这里；config 相关一律惰性 require，
// 避免顶层加载顺序耦合（config.cjs 顶层自带 electron 探测）
//
// fetchBinary / localProxyCandidates（2026-11-12 板块 4C 新增）：
// 插件更新器的网络出口。桌面形态的实现与原 electron/backend/plugin-updater.cjs
// 逐行等价（独立 session 分区 "plugin-update" + 本机代理端口候选探测），
// 只是从业务模块搬到这里，业务侧因此能在容器形态换一份实现。
"use strict";

/** 事件订阅：桌面形态的事件主通道是 IPC 推送，这里同样支持订阅（网关 SSE 与语义对齐） */
const emitListeners = new Set();
function onEmit(fn) {
  emitListeners.add(fn);
  return () => emitListeners.delete(fn);
}

// ===== 更新器网络出口 =====
const FETCH_TIMEOUT_MS = 30 * 1000;            // 与原 plugin-updater 同一超时
const MAX_BINARY_BYTES = 200 * 1024 * 1024;    // 与插件包上限一致
const PORT_PROBE_TIMEOUT_MS = 250;             // 本机端口探测：250ms 没连上就当没有
// 和主程序更新器同一组本机代理候选。只试真的在监听的那些，盲试会白白等超时。
const PROXY_CANDIDATES = [
  "http://127.0.0.1:7890",
  "http://127.0.0.1:7897",
  "http://127.0.0.1:10809",
  "socks5://127.0.0.1:10808",
  "http://127.0.0.1:8118",
];

/** 独立分区：代理只作用于更新器自己，不污染主窗口与号池请求的会话 */
function updateSession() {
  try { return require("electron").session.fromPartition("plugin-update", { cache: false }); }
  catch { return null; }
}

/** proxy=null → 交回系统代理（Windows 的 IE 设置 / macOS 网络设置都认这个） */
function setProxy(rule) {
  const ses = updateSession();
  if (!ses) return Promise.resolve();
  return ses.setProxy(rule ? { proxyRules: rule } : { mode: "system" }).catch(() => {});
}

/** 端口有没有在监听。只探本机回环，250ms 没连上就当没有 */
function portOpen(rule, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let target;
    try { target = new URL(rule); } catch { resolve(false); return; }
    const socket = require("node:net").connect({ host: target.hostname, port: Number(target.port) || 80 });
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 桌面形态才有「本机在监听的代理端口」这回事：容器里探 127.0.0.1 探的是自己 */
async function probeLocalProxies() {
  const list = [];
  for (const rule of PROXY_CANDIDATES) {
    if (await portOpen(rule)) list.push(rule);
  }
  return list;
}

/** 上一次真正下发给 session 的代理规则；null=系统代理，undefined=还没设过 */
let appliedProxy;

function fetchBuffer(url, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let request;
    try {
      const { net } = require("electron");
      request = net.request({ method: "GET", url, session: updateSession() || undefined, redirect: "follow" });
    } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { try { request.abort(); } catch { /* 已结束 */ } done(reject, new Error("插件源请求超时")); }, timeoutMs);
    request.on("response", response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        clearTimeout(timer);
        response.resume();
        done(reject, Object.assign(new Error(`插件源返回 HTTP ${response.statusCode}`), { httpStatus: response.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          try { request.abort(); } catch { /* 已结束 */ }
          clearTimeout(timer);
          done(reject, new Error("插件源响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => { clearTimeout(timer); done(resolve, Buffer.concat(chunks)); });
      response.on("error", error => { clearTimeout(timer); done(reject, error); });
    });
    request.on("error", error => { clearTimeout(timer); done(reject, error); });
    request.end();
  });
}

module.exports = {
  // 事件广播：推给所有渲染窗口（events.cjs 的出口）
  emit(payload) {
    try {
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
      }
    } catch { /* 无窗口时静默 */ }
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

  // 人机校验：内嵌沙箱验证窗跑阿里云官方 SDK（zcodeCapture 是本能力的唯一实现）
  solveCaptcha(cfg, opts) {
    return require("../zcodeCapture.cjs").solveCaptcha(cfg, opts);
  },

  version() {
    try { return require("electron").app.getVersion(); } catch { return ""; }
  },

  log(level, msg, meta) {
    const text = meta === undefined ? String(msg) : `${msg} ${JSON.stringify(meta)}`;
    let line = text;
    try { line = require("../redact.cjs").redact(text); } catch { /* redact 不可用时原样 */ }
    (console[level] || console.log)(line);
  },

  openExternal(url) {
    return require("electron").shell.openExternal(String(url)).catch(() => {});
  },

  openPath(p) {
    return require("electron").shell.openPath(String(p)).catch(() => {});
  },

  // ===== 更新器网络出口（板块 4C）=====
  // 与改造前 plugin-updater.cjs 的调用序列逐项一致：先 setProxy(proxyRule) 再 net.request，
  // proxyRule=null 走系统代理，分区仍是 "plugin-update"，超时/大小上限由调用方给。
  // appliedProxy 记忆是必要的：原实现「每个候选 setProxy 一次 + 复用两次尝试」，
  // 收口成单次 fetchBinary 后若不记忆，同一规则会被重复 setProxy（行为等价但多一次往返）。
  fetchBinary(url, opts = {}) {
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_BINARY_BYTES;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : FETCH_TIMEOUT_MS;
    const rule = opts.proxyRule || null;
    if (rule === appliedProxy) return fetchBuffer(url, maxBytes, timeoutMs);
    appliedProxy = rule;
    return setProxy(rule).then(() => fetchBuffer(url, maxBytes, timeoutMs));
  },

  // 桌面形态才有「本机在监听的代理端口」这回事：容器里探 127.0.0.1 探的是自己
  localProxyCandidates() {
    return probeLocalProxies();
  },
};
