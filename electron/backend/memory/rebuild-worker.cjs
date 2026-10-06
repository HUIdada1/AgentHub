// 记忆中枢 · 索引重建的 worker 化：把「逐文件解析 + 建库 + FTS 重灌」挪出主进程事件循环。
//
// 为什么需要：rebuildIndex 是纯同步 CPU/IO（4750 个文件逐个 readFileSync + frontmatter 解析 +
// 分词 + 同步 SQL 写入，末尾还有 FTS5 全量重灌），实测在主进程上跑 43~56s，期间事件循环被占死——
// 界面、记忆中枢本地 API、连同 9527 模型网关的全部请求一起挂起。
//
// 设计：建旁路库再换（build-aside + transactional swap）
//   1) 主进程 wal_checkpoint 后把索引库复制成旁路库文件（连同既有行与 mem_meta 快照）；
//   2) worker 线程打开旁路库，按生产同款 rebuildIndex 语义重建（DELETE → 逐文件 reindex → rebuildFts），
//      legacy 继承照常生效（旁路库自带旧行）；全程只读记忆树、只写旁路库，主进程可继续服务读写；
//   3) 主进程在 withWrite 内 ATTACH 旁路库，单事务把 mem/mem_link 换掉并重灌 FTS，然后 DETACH；
//   4) 删除旁路库。
//   换入是事务性的：读要么看到旧索引要么看到新索引，不存在中间态；且 meta（调度记账等）不受影响。
//
// worker 引导与 tarpack 同款：主进程把本目录全部 .cjs 源码读到临时目录（打包态源码在 asar 里，
// 主进程读 asar 没问题），worker 只 require 临时目录里的真实磁盘文件——完全不依赖
// 「worker 里能否加载 asar」，开发态与打包态行为一致。临时目录由主进程创建与清理，
// worker 即使被熔断 terminate，清理也照常执行。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { sleepSync } = require("./store.cjs");

/**
 * worker 引导：在 worker 线程里对旁路库执行全量重建。
 * workerData: { entryPath, root, sidecar, deviceId }
 */
const WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
try {
  const { MemoryService } = require(workerData.entryPath);
  const dir = path.dirname(workerData.entryPath);
  const { MemoryIndex } = require(path.join(dir, "indexer.cjs"));
  const { MemorySearch } = require(path.join(dir, "search.cjs"));
  const { MemoryConfig } = require(path.join(dir, "config.cjs"));
  const cfg = new MemoryConfig(workerData.root);
  const svc = new MemoryService(workerData.root, cfg, { deviceId: workerData.deviceId || "rebuild-worker" });
  // 索引指向旁路库：旁路库是主库的文件副本，自带既有行与 meta，rebuildIndex 的 legacy 继承照常生效
  svc.index = new MemoryIndex(workerData.sidecar);
  svc.index.open();
  svc.search = new MemorySearch(svc.index, workerData.root);
  const t0 = Date.now();
  const r = svc.rebuildIndex((p) => {
    // 进度回传：主进程据此刷新进度条（不阻塞，纯消息）
    try { parentPort.postMessage({ type: "progress", done: p.done, total: p.total }); } catch {}
  });
  svc.index.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  svc.index.db.close();
  parentPort.postMessage({ type: "done", ok: true, tookMs: Date.now() - t0, files: r.files, failed: r.failed });
} catch (e) {
  parentPort.postMessage({ type: "done", ok: false, error: String((e && e.message) || e) });
}
`;

/** 把模块目录全部 .cjs 拷进临时目录，返回临时目录（打包态源码在 asar 里，读出来落真实磁盘） */
function prepareWorkerDir(servicePath) {
  const srcDir = path.dirname(servicePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-memory-rebuild-"));
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".cjs")) continue;
      fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(srcDir, f)));
    }
  } catch (e) {
    cleanupWorkerDir(dir);
    throw e;
  }
  return dir;
}

function cleanupWorkerDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败尽力而为 */ }
}

/** 在 worker 线程里对旁路库做全量重建；返回 { files, failed, tookMs } */
function rebuildInWorker({ servicePath, root, sidecar, deviceId, onProgress, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let worker;
    let timer = null;
    let settled = false;
    let workerDir = null;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (worker) worker.terminate(); } catch {}
      if (workerDir) cleanupWorkerDir(workerDir);
      err ? reject(err) : resolve(val);
    };
    try {
      workerDir = prepareWorkerDir(servicePath);
      const { Worker } = require("node:worker_threads");
      worker = new Worker(WORKER_BOOT, {
        eval: true,
        workerData: { entryPath: path.join(workerDir, "service.cjs"), root, sidecar, deviceId },
      });
    } catch (e) {
      done(new Error(`重建工作线程启动失败：${String((e && e.message) || e)}`));
      return;
    }
    // 熔断护栏：worker 卡死时不能让「重建中」永久占着（与 tarpack worker 同纪律）
    const limit = Number(timeoutMs || 0) > 0 ? Number(timeoutMs) : 30 * 60 * 1000;
    timer = setTimeout(() => done(new Error(`重建工作线程超时（${Math.round(limit / 60000)} 分钟）已中止`)), limit);
    worker.on("message", (m) => {
      if (!m) return;
      if (m.type === "progress") { if (typeof onProgress === "function") onProgress(m); return; }
      if (m.type === "done") {
        if (m.ok) done(null, { files: m.files, failed: m.failed || [], tookMs: m.tookMs });
        else done(new Error(m.error || "重建工作线程失败"));
      }
    });
    worker.on("error", (e) => done(new Error(`重建工作线程出错：${String((e && e.message) || e)}`)));
    // 没发 done 就退出（无论哪种原因）都不能悬到熔断才结算
    worker.on("exit", (code) => { if (!settled) done(new Error(`重建工作线程提前退出（code ${code}，未返回结果）`)); });
  });
}

/** 把主库文件复制成旁路库（先 checkpoint，保证 .db 自身是完整快照；WAL 内容不会漏） */
function snapshotDb(mainDbFile, sidecarFile) {
  fs.mkdirSync(path.dirname(sidecarFile), { recursive: true });
  // 清掉可能残留的旁路库与它的 WAL/SHM，避免旧内容混入
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(sidecarFile + suffix, { force: true }); } catch {}
  }
  fs.copyFileSync(mainDbFile, sidecarFile);
}

/**
 * wal_checkpoint(TRUNCATE) 尽力而为：busy（还有其他连接在读写）时截不动 WAL，
 * 旁路库只能拿到上次 checkpoint 时刻的快照——重建语义不受影响（文件是从磁盘现读的），
 * 只有 legacy 继承可能略陈旧，后续 watcher/再次重建自愈。重试几次仍 busy 就放弃，不阻塞主流程。
 */
function checkpointWithRetry(db, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    let busy = 1;
    try {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      busy = row ? Number(row.busy == null ? 0 : row.busy) : 1;
    } catch { busy = 1; }
    if (!busy) return true;
    if (i < attempts - 1) sleepSync(250);
  }
  return false;
}

module.exports = { rebuildInWorker, snapshotDb, checkpointWithRetry, cleanupWorkerDir };
