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
// 反代网关 · 平台适配层入口：按运行环境分发到 Electron 或纯 Node 实现
// 上层模块（events / adapters / poolsync / 网关入口等）只许 require 本文件，
// 绝不直接 require("electron")——同一份代码因此能在桌面壳与 headless 容器下运行。
//
// isElectron 判定三条铁律：
//   ① electron 包在纯 Node 下 require 不报错、而是返回可执行文件路径（truthy），
//      不能用 !!require("electron") 判定；
//   ② ELECTRON_RUN_AS_NODE 下 versions.electron 仍在但 electron API 全不可用
//      （require 只拿得到路径字符串；项目自测全走该通道），该模式按 node 处理；
//   ③ 其余以 versions.electron 为准。
"use strict";

const isElectron = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

const impl = isElectron ? require("./electron.cjs") : require("./node.cjs");

// 启动期契约断言（与 adapters 的 assertAdapterContract 同构）：新增平台能力时两个实现
// 缺一即在 require 阶段 fail-fast，而不是运行到调用点才炸出 undefined
// fetchBinary / localProxyCandidates：插件更新器的网络出口（板块 4C）。
//   fetchBinary(url, { maxBytes, timeoutMs, proxyRule }) → Promise<Buffer>
//     · proxyRule 为 null 表示「按形态默认」：桌面=系统代理，容器=直连
//     · 非 2xx 必须带 error.httpStatus；网络类错误必须带 error.networkLike（或消息可判）
//   localProxyCandidates() → Promise<string[]>
//     · 桌面探本机在监听的代理端口；容器恒空集（探 127.0.0.1 只会得到假阴性）
const REQUIRED_PLATFORM_METHODS = ["emit", "onEmit", "getDataDir", "solveCaptcha", "version", "log", "openExternal", "openPath", "fetchBinary", "localProxyCandidates"];
for (const m of REQUIRED_PLATFORM_METHODS) {
  if (typeof impl[m] !== "function") {
    throw new Error(`平台实现（${isElectron ? "electron" : "node"}）缺少必需方法 ${m}()`);
  }
}

module.exports = {
  isElectron,
  form: () => (isElectron ? "electron" : "node"),
  emit: impl.emit,
  onEmit: impl.onEmit,
  getDataDir: impl.getDataDir,
  solveCaptcha: impl.solveCaptcha,
  version: impl.version,
  log: impl.log,
  openExternal: impl.openExternal,
  openPath: impl.openPath,
  fetchBinary: impl.fetchBinary,
  localProxyCandidates: impl.localProxyCandidates,
};
