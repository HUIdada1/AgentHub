/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · v1.28.0 整改回归断言（真实 service / 真实索引 / 真实索引库文件）：
//   A. 待确认队列口径统一：失效留档（supersede-done）不再占待确认
//      a. markSuperseded 带原因时，留档行直接写 resolved（不再进收件箱等用户点）
//      b. counts().pending 与 scheduler.pendingCounts().review 只算 supersede/classify/dedup 三类，两边同源
//      c. 旧库遗留的 pending 留档行：打开索引时一次性归位为 resolved（历史数据不再虚增红点）
//   B. 冲突差异透传双侧元信息（供界面判定「哪边更新更全」并给建议）
//      a. local / remote 的 size·mtime·hash 原样透传；单侧不存在时给 null 不抛错
//      b. remoteText 原样返回、localText 缺失时回退读盘；越界下标返回 ok:false
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke-v1280.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { MemoryScheduler } = require("../electron/backend/memory/scheduler.cjs");
const { MemorySync } = require("../electron/backend/memory/sync.cjs");
const { MemoryIndex } = require("../electron/backend/memory/indexer.cjs");

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return true;
  }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-memory-v1280-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_v1280", onEvent: () => {} }).init();

  console.log("[A] 待确认队列口径：失效留档不再占待确认（v1.28.0）");
  const m1 = await svc.writeMemory({ title: "旧事实甲", body: "甲正文内容，用于失效留档口径验证。", type: "note", project: "R", tags: ["x"] });
  const m2 = await svc.writeMemory({ title: "新事实乙", body: "乙正文内容，用于失效留档口径验证。", type: "note", project: "R", tags: ["y"] });
  await svc.markSuperseded(m1.id, m2.id, "被乙取代");

  const archiveRows = svc.index.reviewList(null, "supersede-done");
  check("失效留档行已生成", archiveRows.length === 1, String(archiveRows.length));
  check(
    "留档行直接写 resolved（status/resolved/resolution 三件齐全）",
    archiveRows[0] && archiveRows[0].status === "resolved" && archiveRows[0].resolved > 0 && archiveRows[0].resolution === "done",
    JSON.stringify(archiveRows[0] && { status: archiveRows[0].status, resolved: archiveRows[0].resolved, resolution: archiveRows[0].resolution }),
  );
  check("待确认列表里查不到失效留档", svc.index.reviewList("pending", "supersede-done").length === 0);
  check("counts().pending 不把留档算进去（当前为 0）", svc.index.counts().pending === 0, String(svc.index.counts().pending));

  svc.index.reviewAdd("classify", { memoryId: m2.id, slug: "r", name: "R" });
  check("真待办照常计数（counts().pending = 1）", svc.index.counts().pending === 1, String(svc.index.counts().pending));

  const sched = new MemoryScheduler({ service: svc, tasks: {}, getConfig: () => ({}), emit: () => {} });
  const pend = sched.pendingCounts();
  check(
    "调度器 review 计数与索引统计同源（红点 = 面板）",
    pend.review === svc.index.counts().pending,
    JSON.stringify({ scheduler: pend.review, index: svc.index.counts().pending }),
  );

  // 旧库遗留：直接把一条 pending 的留档行塞进库（模拟升级前写入的数据）
  svc.index.db
    .prepare("INSERT INTO review_queue (id, kind, payload, status, created) VALUES (?, ?, ?, 'pending', ?)")
    .run("rq_legacy_archive", "supersede-done", "{}", Date.now());
  check("旧库遗留行存在时，计数口径也不受它影响（仍为 1）", svc.index.counts().pending === 1, String(svc.index.counts().pending));

  // 打开索引时的一次性归位：独立库文件（close 会落盘 WAL），再新开一个索引实例（等价于应用重启）
  const legacyDbFile = path.join(root, "index", "legacy-probe.sqlite");
  const seed = new MemoryIndex(legacyDbFile);
  seed.open();
  seed.db
    .prepare("INSERT INTO review_queue (id, kind, payload, status, created) VALUES (?, ?, ?, 'pending', ?)")
    .run("rq_legacy_only", "supersede-done", "{}", Date.now());
  const beforeReopen = seed.db.prepare("SELECT status FROM review_queue WHERE id = ?").get("rq_legacy_only");
  check("前置条件：独立库里确实躺着一条 pending 留档行", beforeReopen && beforeReopen.status === "pending", JSON.stringify(beforeReopen));
  seed.db.close();

  const reopened = new MemoryIndex(legacyDbFile);
  reopened.open();
  const legacyRow = reopened.db.prepare("SELECT * FROM review_queue WHERE id = ?").get("rq_legacy_only");
  check(
    "重开索引后遗留留档行归位为 resolved（带 resolved 时间戳）",
    legacyRow && legacyRow.status === "resolved" && legacyRow.resolved > 0,
    JSON.stringify(legacyRow && { status: legacyRow.status, resolved: legacyRow.resolved }),
  );
  check("归位后该行不在待确认列表里", reopened.reviewList("pending").filter((r) => r.kind === "supersede-done").length === 0);
  reopened.db.close();

  console.log("[B] 冲突差异透传双侧元信息（界面据此给裁决建议）");
  const rel = "projects/r/l1/probe.md";
  const localFile = path.join(root, rel);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, "本地正文甲\n", "utf8");
  const sync = new MemorySync({
    service: svc,
    getConfig: () => ({}),
    emit: () => {},
    rootDir: root,
    dataDir: path.join(root, "sync-data"),
    moduleWebdav: null,
  });
  sync.state.conflicts = [
    {
      kind: "memory",
      path: rel,
      note: "双侧都改过",
      detectedAt: Date.now(),
      local: { size: 7, mtime: 1700000000000, hash: "hash-local" },
      remote: { size: 9, mtime: 1700000600000, hash: "hash-remote" },
      remoteText: "远端正文乙\n",
    },
  ];
  const d = sync.conflictDiff(0);
  check("双侧元信息原样透传（size / mtime / hash）", d.local && d.remote && d.local.mtime === 1700000000000 && d.remote.size === 9 && d.remote.hash === "hash-remote", JSON.stringify({ local: d.local, remote: d.remote }));
  check("remoteText 原样返回（逐行合并用）", d.remoteText === "远端正文乙\n", JSON.stringify(d.remoteText));
  check("localText 缺失时回退读盘", d.localText === "本地正文甲\n", JSON.stringify(d.localText));

  sync.state.conflicts = [
    { kind: "memory", path: rel, note: "远端新增 / 本地不存在", detectedAt: Date.now(), local: null, remote: { size: 9, mtime: 1700000600000, hash: "hash-remote" } },
  ];
  const d2 = sync.conflictDiff(0);
  check("单侧不存在时给 null 且不抛错（本地缺失一侧为空串）", d2.local === null && d2.remote && d2.remote.size === 9 && d2.localText === "", JSON.stringify({ local: d2.local, localText: d2.localText }));
  check("越界下标返回 ok:false", sync.conflictDiff(99).ok === false, JSON.stringify(sync.conflictDiff(99)));

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log(" - " + f);
    process.exit(1);
  }
  // 临时根目录尽力清理：service 的索引句柄到进程退出前仍开着，Windows 下删不掉也不影响结论
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* 留给系统清理 */ }
}

main().catch((e) => {
  console.error("套件异常：", e && e.stack ? e.stack : e);
  process.exit(2);
});
