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
// worker 引导与 rebuild-worker 同款：把模块目录的 .cjs 拷进临时目录再 require——打包态的源码在
// asar 里，worker 不依赖「worker 里能否加载 asar」，开发态与打包态行为一致（复用的是 store.cjs
// 本体，因此写盘的路径越界检查、备份、原子写四步与主线程完全同一份实现，不是另写一套）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let store = null;
try {
  const { MemoryStore } = require(workerData.entry);
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
      // src：远端解包树里的文件（take-remote 路径）；
      // content：主线程已经算好的文本（daily 三方自动合并路径——合并结果只有主线程能算）
      const text = typeof job.content === "string" ? job.content : fs.readFileSync(job.src, "utf8");
      store.writeAtomic(job.rel, text, { backup: true });
      applied.push({ rel: job.rel, size: Buffer.byteLength(text, "utf8") });
    } catch (e) {
      failed.push({ rel: job.rel, message: String((e && e.message) || e) });
    }
  }
  parentPort.postMessage({ type: "result", id: msg.id, applied, failed });
});
`;

/** 把模块目录的全部 .cjs 拷进临时目录（打包态源码在 asar 里，读出来落真实磁盘再 require）。
 *  只拷顶层 .cjs：store.cjs 的依赖（config.cjs → config-schema.cjs）都在顶层。 */
function prepareWorkerDir(srcDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sync-apply-"));
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".cjs")) continue;
      fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(srcDir, f)));
    }
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败尽力而为 */ }
    throw e;
  }
  return dir;
}

/**
 * 打开一个常驻的「落地」会话；用完必须 close()。
 * 返回 { applyBatch(jobs), close() }；jobs: [{ rel, src }] 或 [{ rel, content }]
 *   src      —— 远端解包树里的绝对路径（take-remote：内容以远端为准）
 *   content  —— 主线程已算好的文本（daily 三方自动合并：结果只有主线程能算）
 */
function openApplySession({ rootDir, timeoutMs }) {
  const { Worker } = require("node:worker_threads");
  let workerDir = null;
  let worker = null;
  try {
    workerDir = prepareWorkerDir(__dirname);
    worker = new Worker(WORKER_BOOT, {
      eval: true,
      workerData: { rootDir, entry: path.join(workerDir, "store.cjs") },
    });
  } catch (e) {
    cleanupWorkerDir(workerDir);
    throw e;
  }
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
  // 线程退出/出错都算会话终结：临时源码目录一并清掉（caller 的 close() 仍可再调，幂等）
  worker.on("exit", (code) => {
    closed = true;
    workerDir = cleanupWorkerDir(workerDir);
    if (code !== 0) failAll(new Error(`同步落地工作线程异常退出（code ${code}）`));
  });

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
      // 源码副本不再需要（require 已进内存），这里直接清：terminate 是异步的，
      // 只靠 exit 钩子的话，「同步完立刻退出进程」这种路径会漏掉一次清理
      workerDir = cleanupWorkerDir(workerDir);
    },
  };
}

function cleanupWorkerDir(dir) {
  if (!dir) return null;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败尽力而为 */ }
  return null;
}

module.exports = { openApplySession };
