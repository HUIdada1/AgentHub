"use strict";
// 崩溃/异常取证日志（main 与 backend 共用）：追加写 userData/logs/crash.log。
// 行格式与 main.cjs 取证块（PR #40）一致：[ISO] [pid=N] kind detail。
// main 侧为什么需要它之外还有本模块：app.on("child-process-gone") 只覆盖 Chromium 子进程，
// ELECTRON_RUN_AS_NODE 子进程（会话流水 worker 等）死亡不触发任何事件——
// 实测 worker 连崩 25 次（crashpad 25 个同签名 dump）而主进程日志零痕迹。
// 超 1MB 截断保留尾部（只读尾部 512KB 再重写，不做整文件读取）：取证只服务近期排查，
// 防止长期累积（文本日志最坏 ~KB/天，上限仅兜底）。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const MAX_BYTES = 1024 * 1024;

function logDir() {
  // 测试 / 纯 Node 场景可显式指定目录；否则优先 Electron app（主进程），回落 %APPDATA%\AgentHub
  if (process.env.AGENTHUB_CRASHLOG_DIR) return process.env.AGENTHUB_CRASHLOG_DIR;
  let dir = "";
  try {
    const electron = require("electron");
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === "function") dir = app.getPath("userData");
  } catch { /* ELECTRON_RUN_AS_NODE / 纯 Node 下无 electron 模块 */ }
  if (!dir) dir = path.join(process.env.APPDATA || os.homedir(), "AgentHub");
  return path.join(dir, "logs");
}

function write(kind, detail) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "crash.log");
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) {
        // 只读尾部（而非整文件）：日志可能因历史版本/异常循环涨到很大，
        // 截断动作本身不能变成一次大分配——取证链路必须永远是最廉价的
        const keep = MAX_BYTES >> 1;
        const fd = fs.openSync(file, "r");
        try {
          const buf = Buffer.allocUnsafe(keep);
          const read = fs.readSync(fd, buf, 0, keep, st.size - keep);
          const tail = buf.subarray(0, read);
          const nl = tail.indexOf(10); // 丢弃被截断的残行，从下一个完整行开始
          fs.writeFileSync(file, nl >= 0 ? tail.subarray(nl + 1) : tail);
        } finally {
          try { fs.closeSync(fd); } catch { /* 已关 */ }
        }
      }
    } catch { /* 文件尚不存在则直接写 */ }
    // 非字符串明细（对象/错误等）序列化后再落盘：String({}) 只会得到 "[object Object]"，
    // 把调用方想要的上下文丢光；序列化失败退回 String（脏输入绝不抛）
    let raw = "";
    if (detail != null) {
      if (typeof detail === "string") raw = detail;
      else { try { raw = JSON.stringify(detail); } catch { raw = String(detail); } }
    }
    const text = raw.replace(/\s+/g, " ").trim().slice(0, 3000);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [pid=${process.pid}] ${kind}${text ? " " + text : ""}\n`);
  } catch { /* 取证日志自身绝不反噬主流程 */ }
}

module.exports = { write };
