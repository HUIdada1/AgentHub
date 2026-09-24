/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 导入批量写入自测：游标多轮不重读、同批去重、同文件合并落盘、会话屏障、噪声过滤、耗时。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-import-batch-smoke.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { ImportEngine } = require("../electron/backend/memory/import/engine.cjs");
const { parseFrontmatter, parseDailySections } = require("../electron/backend/memory/store.cjs");
const { parseJsonl, parseSqlite } = require("../electron/backend/memory/import/parsers.cjs");
const layout = require("../electron/backend/memory/layout.cjs");

let pass = 0;
let failCount = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const stamp = Date.now();
  const root = path.join(os.tmpdir(), `agenthub-import-batch-${stamp}`);
  const srcRoot = path.join(os.tmpdir(), `agenthub-import-src-${stamp}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(srcRoot, { recursive: true, force: true });
  fs.mkdirSync(srcRoot, { recursive: true });

  // 源数据：1200 条唯一内容（会落进同一个 daily 文件）、1 条与第 5 条完全重复、1 条 harness 噪声。
  // 1200 > 解析器单轮 500 的上限，正好压住「多轮解析用没用新游标」这条线
  const srcFile = path.join(srcRoot, "session.jsonl");
  const lines = [];
  const bodyOf = (i) => `第 ${i} 条测试消息，内容长度足够触发解析：${"x".repeat(30)}`;
  const timeOf = (i) => new Date(Date.parse("2026-09-20T10:00:00Z") + i * 1000).toISOString();
  for (let i = 0; i < 1200; i++) {
    lines.push(JSON.stringify({ role: "user", content: bodyOf(i), timestamp: timeOf(i), session: "sess-batch-1" }));
  }
  lines.push(JSON.stringify({ role: "user", content: bodyOf(5), timestamp: timeOf(9999), session: "sess-batch-1" }));
  lines.push(JSON.stringify({
    role: "user",
    content: '<system-reminder data-role="user-context">这是 harness 注入的上下文块，不该被导入成记忆</system-reminder>',
    timestamp: timeOf(10000),
    session: "sess-batch-1",
  }));
  fs.writeFileSync(srcFile, lines.join("\n") + "\n", "utf8");

  const memCfg = new MemoryConfig(root);
  memCfg.load();
  const svc = new MemoryService(root, memCfg, { deviceId: "dev_batch", onEvent: () => {} }).init();
  const store = svc.store;

  // 计数落盘次数：批量落盘的意义就是「一个文件一批只写一遍」
  const origWriteAtomic = store.writeAtomic.bind(store);
  let writes = 0;
  let writeBytes = 0;
  store.writeAtomic = (rel, content, opts) => {
    writes++;
    writeBytes += Buffer.byteLength(String(content), "utf8");
    return origWriteAtomic(rel, content, opts);
  };

  const importer = new ImportEngine({
    service: svc, rootDir: root, getConfig: () => svc.flat(), emit: () => {}, memCfg, expandPath: (p) => p,
  });

  console.log("[1] 导入：游标多轮不重读 + 同批去重 + 噪声过滤");
  importer.saveSources([{ id: "t-jsonl", name: "批量 JSONL", kind: "jsonl", path: srcFile, enabled: true, priority: 1 }]);
  await importer.preview({ sourceIds: ["t-jsonl"] });
  const t0 = Date.now();
  const r = await importer.apply({ sourceIds: ["t-jsonl"] });
  const took = Date.now() - t0;

  check("导入成功", r.ok === true, JSON.stringify({ ok: r.ok, message: r.message }));
  check("库内条数 = 唯一内容数（1200）", svc.index.counts().total === 1200, String(svc.index.counts().total));
  check(
    "入队总数 = 1200（多轮解析没有重读来源）",
    importer.progress().total === 1200,
    String(importer.progress().total),
  );
  check("同批重复被拦下（skipped ≥ 1）", r.skipped >= 1, JSON.stringify({ skipped: r.skipped, created: r.created }));
  check("harness 噪声被过滤", r.created === 1200, String(r.created));
  check("无重复落库（唯一 hash = 总行数）", (() => {
    const row = svc.index.db.prepare("SELECT COUNT(*) total, COUNT(DISTINCT hash) uniq FROM mem").get();
    return Number(row.total) === Number(row.uniq);
  })(), JSON.stringify(svc.index.db.prepare("SELECT COUNT(*) total, COUNT(DISTINCT hash) uniq FROM mem").get()));

  // 同一天的多条挤在同一个 daily 文件：批量后该文件只应被写很少几次
  const grouped = svc.index.db.prepare("SELECT path, COUNT(*) c FROM mem GROUP BY path ORDER BY c DESC LIMIT 1").get();
  const dailyRel = grouped.path;
  const dailyAbs = svc.store.abs(dailyRel);
  check("1200 条落在同一个 daily 文件", Number(grouped.c) === 1200, JSON.stringify(grouped));
  check("落盘次数远小于条数（批量生效）", writes < 40, `writes=${writes} created=${r.created}`);
  const dailySections = parseDailySections(parseFrontmatter(fs.readFileSync(dailyAbs, "utf8")).body);
  check("daily 文件节数与库内一致", dailySections.length === 1200, String(dailySections.length));
  console.log(`  · 耗时 ${took} ms / ${r.created} 条（${Math.round((r.created / Math.max(1, took)) * 1000)} 条每秒），落盘 ${writes} 次共 ${Math.round(writeBytes / 1024)} KB`);

  console.log("[2] 幂等重跑（游标已推进）");
  const again = await importer.apply({ sourceIds: ["t-jsonl"] });
  check("重跑不新增", again.created === 0, JSON.stringify({ created: again.created, skipped: again.skipped }));
  check("重跑后库内条数不变", svc.index.counts().total === 1200, String(svc.index.counts().total));

  console.log("[3] 写入选项语义");
  const dupTitle = "重复写入语义";
  const dupBody = "同一份内容写两次，用来验证默认放行与导入强制判重的区别";
  const w1 = await svc.writeMemory({ title: dupTitle, body: dupBody, type: "daily", agent: "workbuddy" });
  const w2 = await svc.writeMemory({ title: dupTitle, body: dupBody, type: "daily", agent: "workbuddy" });
  check("默认路径仍放行 daily 同内容多条（行为未变）", !w1.noop && !w2.noop, JSON.stringify({ w1: !!w1.noop, w2: !!w2.noop }));
  const w3 = await svc.writeMemory({ title: dupTitle, body: dupBody, type: "daily", agent: "workbuddy" }, { forceDedup: true });
  check("forceDedup 下同内容判重（noop）", w3.noop === true, JSON.stringify(w3));
  const beforeSilent = svc.index.counts().total;
  const w4 = await svc.writeMemory({ title: "静默写入", body: "带 silent 的写入不该广播 memory-new", type: "daily", agent: "workbuddy" }, { silent: true });
  check("silent 下仍正常落库", !w4.noop && svc.index.counts().total === beforeSilent + 1, JSON.stringify(w4));

  console.log("[4] 延迟落盘会话：屏障与缓存一致性");
  const rel = "general/l1/workbuddy/2026-09-21.md";
  const fm = { id: "file-batch", type: "daily", layer: "l1", agent: "workbuddy", project: "" };
  const sec = (id, t, title, body) => ({ id, time: t, title, meta: {}, body });
  store.beginDeferred();
  store.appendDaily(rel, fm, sec("s1", "10:00", "第一节", "AAA"), {});
  store.appendDaily(rel, fm, sec("s2", "10:01", "第二节", "BBB"), {});
  check("会话内文件尚未落盘", !fs.existsSync(store.abs(rel)));
  const mid = parseDailySections(parseFrontmatter(store.read(rel)).body);
  check("会话内 read 能看到攒好的两节（读屏障）", mid.length === 2, String(mid.length));
  store.appendDaily(rel, fm, sec("s3", "10:02", "第三节", "CCC"), {});
  store.endDeferred();
  const finalSecs = parseDailySections(parseFrontmatter(store.read(rel)).body);
  check("会话结束后三节都在", finalSecs.length === 3, String(finalSecs.length));

  store.beginDeferred();
  store.appendDaily(rel, fm, sec("s4", "10:03", "第四节", "DDD"), {});
  store.updateDailySection(rel, "s4", () => null, {});
  store.endDeferred();
  const afterDel = parseDailySections(parseFrontmatter(store.read(rel)).body);
  check("会话内删除生效（缓存不会把删掉的节写回）", afterDel.length === 3 && !afterDel.some((s) => s.id === "s4"), String(afterDel.length));

  console.log("[5] 批量窗口内的写队列不自等待");
  let batched = null;
  await svc.withWriteBatch(async () => {
    const a = await svc.writeMemory({ title: "窗口内写入 A", body: "批量窗口内的写入不该与写队列自等待", type: "daily", agent: "workbuddy", createdAt: Date.parse("2026-09-22T09:00:00Z") });
    const b = await svc.writeMemory({ title: "窗口内写入 B", body: "第二条同样落在同一天的文件里", type: "daily", agent: "workbuddy", createdAt: Date.parse("2026-09-22T09:05:00Z") });
    batched = [a, b];
  });
  const boxed = parseDailySections(parseFrontmatter(fs.readFileSync(svc.store.abs(batched[0].path), "utf8")).body);
  check("批量窗口内两条都落库", batched.every((x) => x && x.ok) && !batched.some((x) => x.noop), JSON.stringify(batched));
  check("批量窗口收尾已落盘", boxed.length === 2, String(boxed.length));

  console.log("[6] 会话目录名反解与 cwd 归类");
  const home = os.homedir();
  check("反解盘符路径（真实存在）", layout.reverseSessionDirName(`${home[0].toLowerCase()}-${home.slice(3).split(path.sep).join("-")}`) === home, home);
  check("反解不存在的路径返回空串（不猜）", layout.reverseSessionDirName("z-NoSuchDrive-nowhere-at-all") === "", "z-NoSuchDrive-nowhere-at-all");
  check("无盘符前缀返回空串", layout.reverseSessionDirName("projects") === "", "projects");
  check("带连字符的项目名逐段消歧", (() => {
    // 造一个真实目录，用它的编码名反解回来：段里的 "-" 必须靠 existsSync 消歧
    const proj = path.join(srcRoot, "demoProj");
    fs.mkdirSync(proj, { recursive: true });
    const encoded = `${proj[0].toLowerCase()}-${proj.slice(3).split(path.sep).join("-")}`;
    return layout.reverseSessionDirName(encoded) === proj;
  })(), "见上");

  // 端到端：源目录名编码了工作目录 + 该项目已在台账里 → 记忆应落进 projects/<slug>/
  const projDir = path.join(srcRoot, "demoProj");
  const encodedDir = `${projDir[0].toLowerCase()}-${projDir.slice(3).split(path.sep).join("-")}`;
  const encodedSrc = path.join(srcRoot, "enc");
  fs.mkdirSync(path.join(encodedSrc, "projects", encodedDir), { recursive: true });
  fs.writeFileSync(path.join(encodedSrc, "projects", encodedDir, "s1.jsonl"), [
    JSON.stringify({ role: "user", content: "把这条会话按工作目录归到 demoProj 项目去，内容要够长", timestamp: "2026-09-25T10:00:00Z" }),
    JSON.stringify({ role: "assistant", content: "好的，这条回复也应该落在同一个项目目录下，验证归类一致", timestamp: "2026-09-25T10:01:00Z" }),
  ].join("\n") + "\n", "utf8");
  svc.registry.upsert({ slug: "demoProj", name: "demoProj" });
  importer.saveSources([
    { id: "t-jsonl", name: "批量 JSONL", kind: "jsonl", path: srcFile, enabled: true, priority: 1 },
    { id: "t-enc", name: "编码目录名来源", kind: "jsonl", path: encodedSrc, enabled: true, priority: 2 },
  ]);
  await importer.preview({ sourceIds: ["t-enc"] });
  const encRun = await importer.apply({ sourceIds: ["t-enc"] });
  const encRows = svc.index.db.prepare("SELECT path FROM mem WHERE project = 'demoProj'").all();
  check("反解出的工作目录被用来归类", encRun.ok && encRows.length === 2 && encRows.every((r) => String(r.path).startsWith("projects/demoProj/")), JSON.stringify({ ok: encRun.ok, created: encRun.created, rows: encRows.map((r) => r.path) }));

  console.log("[7] Codex 事件流：session_meta 的 cwd（含增量续读回读文件头）");
  const cxFile = path.join(srcRoot, "rollout.jsonl");
  const cxCwd = projDir;
  fs.writeFileSync(cxFile, [
    JSON.stringify({ timestamp: "2026-09-25T11:00:00Z", type: "session_meta", payload: { session_id: "sess-cx", cwd: cxCwd } }),
    JSON.stringify({ timestamp: "2026-09-25T11:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 的第一条用户消息，内容要够长才能通过过滤" }] } }),
  ].join("\n") + "\n", "utf8");
  const cx1 = [];
  const cxr1 = parseJsonl({ id: "t-cx", path: cxFile }, null, {}, (it) => cx1.push(it));
  check("事件流消息可解析", cx1.length === 1 && cx1[0].role === "user", JSON.stringify(cx1.map((x) => x.title)));
  check("cwd 取自 session_meta", cx1[0] && cx1[0].cwd === cxCwd, cx1[0] && cx1[0].cwd);
  fs.appendFileSync(cxFile, JSON.stringify({ timestamp: "2026-09-25T11:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: "续读进来的这条消息同样要带着工作目录，否则项目归属会丢" }] } }) + "\n", "utf8");
  const cx2 = [];
  parseJsonl({ id: "t-cx", path: cxFile }, cxr1.nextCursor, {}, (it) => cx2.push(it));
  check("续读条目仍带 cwd（回读文件头）", cx2.length === 1 && cx2[0].cwd === cxCwd, JSON.stringify({ n: cx2.length, cwd: cx2[0] && cx2[0].cwd }));

  console.log("[8] ZCode 会话库：part.data 正文 + message.data 的 role");
  const zdbPath = path.join(srcRoot, "zcode-db.sqlite");
  const zdb = new DatabaseSync(zdbPath);
  zdb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  zdb.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)");
  const insM = zdb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const insP = zdb.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  const zt = Date.parse("2026-09-25T12:00:00Z");
  insM.run("m1", "sess-z1", zt, JSON.stringify({ role: "user", contextSnapshot: { envInfo: { cwd: cxCwd } } }));
  insM.run("m2", "sess-z1", zt + 1000, JSON.stringify({ role: "assistant" }));
  insM.run("m3", "sess-z1", zt + 2000, JSON.stringify({ role: "system" }));
  insP.run("p1", "m1", "sess-z1", zt, JSON.stringify({ type: "text", text: "ZCode 会话库里这条用户正文应该被导入，长度足够" }), 0);
  insP.run("p2", "m1", "sess-z1", zt, JSON.stringify({ type: "tool", name: "read" }), 1);
  insP.run("p3", "m2", "sess-z1", zt + 1000, JSON.stringify({ type: "text", text: "助手回复的正文同样要入库，这条长度也够用" }), 0);
  insP.run("p4", "m2", "sess-z1", zt + 1000, JSON.stringify({ type: "reasoning", text: "思考过程不算记忆，虽然它也很长很长很长" }), 1);
  insP.run("p5", "m3", "sess-z1", zt + 2000, JSON.stringify({ type: "text", text: "system 角色的正文不该被导入，长度够也没用" }), 0);
  zdb.close();
  const zItems = [];
  const zr = parseSqlite({ id: "t-z", path: zdbPath, kind: "sqlite", table: "part" }, null, { batchSize: 500 }, (it) => zItems.push(it));
  check("只收 type=text 的正文（工具/推理/step 都不要）", zItems.length === 2, JSON.stringify(zItems.map((x) => x.role)));
  check("role 从 message.data 关联得到", zItems.every((x) => x.role === "user" || x.role === "assistant"), JSON.stringify(zItems.map((x) => x.role)));
  check("cwd 从 contextSnapshot 带出", zItems[0] && zItems[0].cwd === cxCwd, zItems[0] && zItems[0].cwd);
  check("游标用 part.rowid 且可推进", Number(zr.nextCursor && zr.nextCursor.lastId) > 0, JSON.stringify(zr.nextCursor));
  const zItems2 = [];
  const zr2 = parseSqlite({ id: "t-z", path: zdbPath, kind: "sqlite", table: "part" }, zr.nextCursor, { batchSize: 500 }, (it) => zItems2.push(it));
  check("续读不重复产出", zItems2.length === 0, String(zItems2.length));

  svc.index.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(srcRoot, { recursive: true, force: true });

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：\n- " + failures.join("\n- "));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("自测异常：", e);
  process.exitCode = 1;
});
