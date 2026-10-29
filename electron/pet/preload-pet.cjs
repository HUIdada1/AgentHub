/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 桌宠窗口专用 preload：只暴露桌宠渲染层需要的最小能力面。
//
// 与主窗口 preload 的差别：
//   · 主窗口用「一命令一白名单」拦 ipcRenderer.invoke —— 因为主界面有 400+ 通道、攻击面大；
//   · 桌宠窗口只承载一个本地静态页面（file://，无远程内容），能力也只有 12 个，
//     没必要铺 12 条独立通道，统一收敛到 pet:ipc（单向）与 pet:rpc（请求/响应）两条，
//     main 侧按 type 分派。少两条通道 = 少两处漏登记白名单的机会。
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

/** 单向（高频，如鼠标进出热区切穿透）：不用 Promise，避免每帧分配 */
function send(type, payload) {
  try {
    ipcRenderer.send("pet:ipc", { type, payload: payload || {} });
  } catch {
    /* 主进程已退出等边界情况：静默，渲染层无需感知 */
  }
}

/** 请求/响应（低频：初始化、保存配置、取采样源） */
function rpc(type, payload) {
  return ipcRenderer.invoke("pet:rpc", { type, payload: payload || {} });
}

contextBridge.exposeInMainWorld("petHost", {
  // ===== 初始化 =====
  boot: () => rpc("boot"),

  // ===== 交互 =====
  setInteractive: (interactive) => send("set-interactive", { interactive: !!interactive }),
  dragStart: () => send("drag-start"),
  dragEnd: () => send("drag-end"),
  contextMenu: (x, y) => send("context-menu", { x: Number(x) || 0, y: Number(y) || 0 }),

  // ===== 配置 / 数据 =====
  patch: (patch) => rpc("patch", { patch }),
  usageToday: () => rpc("usage-today"),
  /** 屏幕捕获源：只返回 sourceId，媒体流由渲染层自己 getUserMedia 建立
   *  （MediaStream 对象无法跨 contextBridge 传递） */
  captureSource: () => rpc("capture-source"),

  // ===== 生命周期 =====
  hide: () => send("hide"),
  close: () => send("close"),
  resetPosition: () => send("reset-position"),

  // ===== 诊断 =====
  log: (kind, detail) => send("log", { kind: String(kind || "info"), detail: String(detail == null ? "" : detail) }),

  /** 主进程广播：config-changed / hidden / shown / usage；返回退订函数 */
  onEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_e, payload) => {
      try {
        callback(payload);
      } catch (err) {
        // 渲染层回调抛错不能顺着 IPC 事件通道冒泡到主进程（会污染后续事件）
        console.error("[pet] onEvent handler failed", err);
      }
    };
    ipcRenderer.on("pet:event", listener);
    return () => ipcRenderer.removeListener("pet:event", listener);
  },
});
