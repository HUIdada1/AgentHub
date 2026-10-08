// 沙箱自测：记忆清理（cleanupScan / cleanupRun）——隔离临时库构造五类异常记忆，逐类断言；
// 不触碰已安装应用与真实记忆库。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/verify-cleanup-e2e.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}
/** 路径比较：NTFS 大小写不敏感，比对时统一折叠（索引给小写 slug、磁盘给目录真名） */
const fold = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-cleanup-e2e-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_cleanup_e2e", onEvent: () => {} }).init();
  console.log(`  隔离实例：记忆库 ${root}\n`);

  const w = (title, body, project) => svc.writeMemory({
    title, body, type: "note", layer: "l1", agent: "manual", project, tags: ["e2e"], importance: 3,
  });
  const abs = (rel) => path.join(root, rel);
  const inIndex = (id) => !!svc.index.getById(id);

  // ---- 造数据：五类（报错两类：目录 / 真文件但读取失败）----
  const kSuperseded = await w("旧事实", "项目用 React。", "projA");
  const kNew = await w("新事实", "项目改用 Vue3。", "projA");
  await svc.markSuperseded(kSuperseded.id, kNew.id, "e2e");

  const kMissing = await w("文件丢了的记忆", "正文仍在索引里。", "projB");
  fs.rmSync(abs(kMissing.path), { force: true });

  // 报错 A：路径被换成目录（read 返回 null，且移不进回收站 → 只清索引行）
  const kErrorDir = await w("被换成目录的记忆", "读取必失败。", "projB");
  fs.rmSync(abs(kErrorDir.path), { force: true });
  fs.mkdirSync(abs(kErrorDir.path), { recursive: true });

  // 报错 B：真文件但读取失败（用 read 桩模拟权限/损坏：不进回收站说不通，必须进）
  const kErrorFile = await w("读不出来的记忆", "文件在，读取被桩掉。", "projB");
  const origRead = svc.store.read.bind(svc.store);
  svc.store.read = (rel) => (fold(rel) === fold(kErrorFile.path) ? null : origRead(rel));

  const kConflict = await w("冲突记忆", "同步冲突未裁决。", "projC");

  const shellRel = "projects/projC/l1/manual/2020-01-01-shell.md";
  fs.mkdirSync(path.dirname(abs(shellRel)), { recursive: true });
  fs.writeFileSync(abs(shellRel), "---\ntitle: 空壳残留\n---\n", "utf8");
  const shellReal = svc.store.canonicalRel(shellRel);

  const kKeep = await w("正常记忆不该被清", "这是一条完全正常的记忆。", "projD");
  const kKeep2 = await w("第二条正常记忆", "也不该被清。", "projD");

  // ---- ① 开关全关：什么都不该删 ----
  console.log("① 开关全关（默认）");
  const scanOff = svc.cleanupScan({ conflictPaths: [kConflict.path] });
  check("扫描给出五类计数（默认关只统计不执行）", typeof scanOff.counts.superseded === "number" && typeof scanOff.counts.invalid === "number", JSON.stringify(scanOff.counts));
  const rOff = await svc.cleanupRun({ conflictPaths: [kConflict.path] });
  check("全关时执行：零删除", rOff.ok && rOff.total === 0, JSON.stringify(rOff.removed));
  check("全关时异常记忆与正常记忆都还在", inIndex(kSuperseded.id) && inIndex(kConflict.id) && fs.existsSync(abs(shellReal)) && inIndex(kKeep.id));
  check("全关时 enabled 全 false", Object.values(scanOff.enabled).every((v) => v === false), JSON.stringify(scanOff.enabled));

  // ---- ② 开五个开关：扫描计数 ----
  console.log("② 开启五类开关后扫描");
  cfg.set({
    "cleanup.autoDeleteSuperseded": true,
    "cleanup.autoDeleteMissing": true,
    "cleanup.autoDeleteError": true,
    "cleanup.autoDeleteConflict": true,
    "cleanup.autoDeleteInvalid": true,
  });
  const scan = svc.cleanupScan({ conflictPaths: [kConflict.path] });
  check("失效 1 条（新事实不受影响）", scan.counts.superseded === 1, JSON.stringify(scan.counts));
  check("不存在 1 条", scan.counts.missing === 1, JSON.stringify(scan.counts));
  check("报错 2 条（目录 + 读取失败）", scan.counts.error === 2, JSON.stringify(scan.counts));
  check("冲突 1 条", scan.counts.conflict === 1, JSON.stringify(scan.counts));
  check("无效 1 条（空壳文件）", scan.counts.invalid === 1, JSON.stringify(scan.counts));
  check("被取代的那条 id 命中", scan.items.superseded.length === 1 && scan.items.superseded[0].id === kSuperseded.id, JSON.stringify(scan.items.superseded));
  check("正常记忆不在任何一类里", [scan.items.missing, scan.items.error, scan.items.invalid, scan.items.conflict, scan.items.superseded]
    .every((arr) => arr.every((x) => fold(typeof x === "string" ? x : x.path) !== fold(kKeep.path) && fold(typeof x === "string" ? x : x.path) !== fold(kKeep2.path))));

  // ---- ③ 执行清理 ----
  console.log("③ 执行清理");
  const r = await svc.cleanupRun({ conflictPaths: [kConflict.path] });
  check("五类：失效 1 / 不存在 1 / 报错 2 / 冲突 1 / 无效 1",
    r.ok && r.removed.superseded === 1 && r.removed.missing === 1 && r.removed.error === 2 && r.removed.conflict === 1 && r.removed.invalid === 1,
    JSON.stringify(r.removed));
  check("失效记忆的索引行已清", !inIndex(kSuperseded.id));
  check("失效记忆的检索结果里不再出现", svc.searchMemories("React", { includeSuperseded: true }, cfg.all()).results.every((x) => x.id !== kSuperseded.id));
  check("不存在记忆的索引行已清", !inIndex(kMissing.id));
  check("报错记忆（目录）的索引行已清、目录原地保留", !inIndex(kErrorDir.id) && fs.statSync(abs(kErrorDir.path)).isDirectory());
  check("报错记忆（文件）的索引行已清", !inIndex(kErrorFile.id));
  check("冲突记忆的索引行已清", !inIndex(kConflict.id));
  check("两条正常记忆原样保留", inIndex(kKeep.id) && inIndex(kKeep2.id) && fs.existsSync(abs(kKeep.path)));
  check("空壳文件已从原处移走", !fs.existsSync(abs(shellReal)));

  // 回收站：失效 / 报错(文件) / 冲突 / 无效 四份；normal 不在、missing 与 报错(目录) 不在
  const trash = svc.trashList();
  const trashFold = trash.map((t) => fold(t.originPath));
  check("回收站收到四份", trash.length === 4, JSON.stringify(trash.map((t) => t.originPath)));
  check("回收站含失效记忆原文件", trashFold.includes(fold(kSuperseded.path)));
  check("回收站含报错（可读失败的文件）", trashFold.includes(fold(kErrorFile.path)));
  check("回收站含冲突记忆原文件", trashFold.includes(fold(kConflict.path)));
  check("回收站含无效（空壳）文件", trashFold.includes(fold(shellReal)));
  check("回收站不含正常记忆", !trashFold.includes(fold(kKeep.path)) && !trashFold.includes(fold(kKeep2.path)));
  check("回收站不含 missing 与 报错目录（没有可入站的内容）",
    !trashFold.includes(fold(kMissing.path)) && !trashFold.includes(fold(kErrorDir.path)));

  // 冲突清理由调度器负责把记录摘掉：这里验证返回值带出被删路径，供 dropConflicts 使用
  check("返回被删冲突路径（供同步模块摘记录）", Array.isArray(r.conflictPaths) && r.conflictPaths.length === 1 && fold(r.conflictPaths[0]) === fold(kConflict.path), JSON.stringify(r.conflictPaths));

  // ---- ④ 回收站到期彻底删除（30 天）----
  console.log("④ 回收站到期彻底删除");
  const purged0 = svc.trashPurge(30);
  check("未到期：一个都不删", purged0.removed === 0, JSON.stringify(purged0));
  const trashDir = abs(".trash");
  const victim = fs.readdirSync(trashDir).find((f) => f.endsWith(".meta.json"));
  const meta = JSON.parse(fs.readFileSync(path.join(trashDir, victim), "utf8"));
  meta.trashedAt = Date.now() - 40 * 86400000;
  fs.writeFileSync(path.join(trashDir, victim), JSON.stringify(meta), "utf8");
  const purged1 = svc.trashPurge(30);
  check("到期后删 1 份", purged1.removed === 1, JSON.stringify(purged1));
  check("被删的是那一份（文件与 sidecar 都没了）",
    !fs.existsSync(path.join(trashDir, victim)) && !fs.existsSync(path.join(trashDir, victim.replace(/\.meta\.json$/, ""))));
  check("其余三份仍在回收站", fs.readdirSync(trashDir).filter((f) => !f.endsWith(".meta.json")).length === 3, JSON.stringify(fs.readdirSync(trashDir)));
  check("默认保留期 30 天（配置 schema 默认值）", Number(svc.flat()["storage.trashKeepDays"]) === 30, String(svc.flat()["storage.trashKeepDays"]));

  // ---- ⑤ 调度器接线：cleanup 任务在任务表里，且按开关真正删记忆 ----
  console.log("⑤ 调度器接线（cleanup 任务）");
  const { MemoryScheduler } = require("../electron/backend/memory/scheduler.cjs");
  const sched = new MemoryScheduler({ service: svc, tasks: {}, getConfig: () => svc.flat(), emit: () => {} });
  const st = sched.status();
  const taskRow = (st.tasks || []).find((t) => t.id === "cleanup");
  check("任务表含「异常记忆清理」", !!taskRow && taskRow.name === "异常记忆清理", JSON.stringify((st.tasks || []).map((t) => t.id)));
  check("默认开启、节奏每天 04:00、不调模型", !!taskRow && taskRow.enabled === true && taskRow.daily === "04:00" && taskRow.needsModel === false, JSON.stringify(taskRow));

  // 再造一条失效记忆：任务跑一次应把它清掉（证明任务真的按开关执行，而不是空转）
  const kSup2 = await w("又要失效", "被取代。", "projE");
  const kNew2 = await w("新的", "取代前者。", "projE");
  await svc.markSuperseded(kSup2.id, kNew2.id, "e2e-sched");
  const rec = await sched.runTask("cleanup");
  check("任务执行成功", rec.ok === true, JSON.stringify(rec));
  check("任务详情含清理计数与回收站保留天数", /失效 1/.test(rec.detail) && /30 天/.test(rec.detail), rec.detail);
  check("失效记忆被任务清掉", !inIndex(kSup2.id));

  // 五类开关全关：任务只清回收站，不扫五类（记忆不动）
  cfg.set({
    "cleanup.autoDeleteSuperseded": false, "cleanup.autoDeleteMissing": false, "cleanup.autoDeleteError": false,
    "cleanup.autoDeleteConflict": false, "cleanup.autoDeleteInvalid": false,
  });
  const kSup3 = await w("开关关了不该删", "被取代但开关关。", "projE");
  const kNew3 = await w("新的一条", "取代前者。", "projE");
  await svc.markSuperseded(kSup3.id, kNew3.id, "e2e-sched");
  const rec2 = await sched.runTask("cleanup");
  check("全关时任务详情说明开关未开启", rec2.ok === true && /未开启/.test(rec2.detail), rec2.detail);
  check("全关时失效记忆原地不动", inIndex(kSup3.id));
  sched.stop();

  svc.store.read = origRead;
  svc.close();
  console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
  console.log(`（沙箱：${root}，真实记忆库未被触碰）`);
}

main().catch((e) => { console.error("运行异常：", e); process.exit(1); });
