// 记忆同步 · 「落地远端版本」的 worker 化（收着做，范围只到写盘）
//
// 为什么需要：_mergeRemote 的「仅远端改」分支对每个文件做 writeAtomic + removeByPath + reindexFile，
// 全部在主线程同步执行。实测单个文件的构成为：写盘 54%（临时文件 + fsyncSync + 两次 rename，
// 同步路径还带 backup 拷贝）、索引删除 9%、reindexFile 37%（其中纯解析仅 0.003ms，绝大部分是
// SQL 与 FTS 触发器维护）。大额变更下这条路径线性放大：实测 1000 个变更文件冻结主线程 10.3s、
// 3000 个冻结 36.8s。
//
// 范围边界（刻意收窄）：
//   进 worker 的只有「把主线程已经决定采纳的远端文件写到本地」——纯机械的文件 I/O。
//   不进来：三方比较 / 冲突判定 / 基线记账（正确性关键，留主线程可测可审）、
//           索引库 SQL（单写者，留主线程）、状态文件、WebDAV 收发。
//   索引写入（removeByPath + reindexFile，约 3ms/文件）由主线程在每批之间做，并让出事件循环。
//
// 常驻会话：一次 merge 只启动一个 worker，批次经消息往返（早先每批新建 worker 时，
// 3000 文件 = 120 次启动，总耗时反而涨 51%）。
//
// worker 引导与 tarpack / rebuild-worker 同款：源码文本经 workerData 传入、落临时目录再 require，
// 不依赖「worker 里能否加载 asar」，开发态与打包态行为一致。
"use strict";
const path = require("node:path");

const WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let store = null;
try {
  const { MemoryStore } = require(workerData.modules.store);
  store = new MemoryStore(workerData.rootDir);
} catch (e) {
  parentPort.postMessage({ type: "fatal", error: String((e && e.message) || e) });
  process.exit(1);
}
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "apply") return;
  const applied = [];
  const failed = [];
  for (const job of msg.jobs) {
    try {
      const text = fs.readFileSync(job.src, "utf8");
      store.writeAtomic(job.rel, text, { backup: true });
      applied.push({ rel: job.rel, size: Buffer.byteLength(text, "utf8") });
    } catch (e) {
      failed.push({ rel: job.rel, message: String((e && e.message) || e) });
    }
  }
  parentPort.postMessage({ type: "result", id: msg.id, applied, failed });
});
`;

/**
 * 打开一个常驻的「落地」会话；用完必须 close()。
 * 返回 { applyBatch(jobs), close() }；jobs: [{ rel, src }]（src 为远端解包树里的绝对路径）
 */
function openApplySession({ rootDir, storePath, timeoutMs }) {
  const { Worker } = require("node:worker_threads");
  const worker = new Worker(WORKER_BOOT, {
    eval: true,
    workerData: { rootDir, modules: { store: storePath || path.join(__dirname, "store.cjs") } },
  });
  const waiting = new Map();
  let seq = 0;
  let closed = false;
  const failAll = (err) => {
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(err); }
    waiting.clear();
  };
  worker.on("message", (m) => {
    if (!m) return;
    if (m.type === "fatal") { failAll(new Error(`同步落地工作线程初始化失败：${m.error || ""}`)); return; }
    if (m.type !== "result") return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    w.resolve({ applied: m.applied || [], failed: m.failed || [] });
  });
  worker.on("error", (e) => failAll(new Error(`同步落地工作线程出错：${String((e && e.message) || e)}`)));
  worker.on("exit", (code) => { if (!closed && code !== 0) failAll(new Error(`同步落地工作线程异常退出（code ${code}）`)); });

  const limit = Number(timeoutMs || 0) > 0 ? Number(timeoutMs) : 5 * 60 * 1000;
  return {
    applyBatch(jobs) {
      if (closed) return Promise.reject(new Error("落地会话已关闭"));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        // 每批独立超时：单批卡死不能让整个 merge 永久挂着
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`同步落地批次超时（${Math.round(limit / 1000)}s）`)); }, limit);
        waiting.set(id, { resolve, reject, timer });
        worker.postMessage({ type: "apply", id, jobs });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      failAll(new Error("落地会话已关闭"));
      try { worker.terminate(); } catch { /* 已退出 */ }
    },
  };
}

module.exports = { openApplySession };