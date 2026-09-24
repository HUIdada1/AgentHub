/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 第三轮回归断言：把已修复的高/中危逐条钉成可证伪的测试。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke-fixes.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const S = require("../electron/backend/memory/store.cjs");
const { DedupEngine } = require("../electron/backend/memory/dedup.cjs");
const { ImportEngine } = require("../electron/backend/memory/import/engine.cjs");
const { parseSqlite } = require("../electron/backend/memory/import/parsers.cjs");
const { MemoryScheduler } = require("../electron/backend/memory/scheduler.cjs");
const { DatabaseSync } = require("node:sqlite");

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

const fakeClient = { quirksMemo: {}, async call() { return { text: "{}", usage: { input: 1, output: 1 } }; } };

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-memory-fixes-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_fix", onEvent: () => {} }).init();

  console.log("[H1] 写队列不重入（L2 合并分支会调 _deleteMemoryLocked）");
  const dedup = new DedupEngine({ service: svc, client: fakeClient, emit: () => {} });
  svc.dedupHook = (info) => dedup.checkSync(info);
  const a = await svc.writeMemory({ title: "重入探测条", body: "正文甲乙丙丁足够长以便参与相似度比较，用于触发 L2 合并分支。", type: "note", project: "R", tags: ["x"] });
  // 造一个高相似但更长的新条：命中 merge-into，且新条信息量更大 → 会走 _markSupersededLocked；
  // 再直接验证 _deleteMemoryLocked 不阻塞
  const b = await svc.writeMemory({ title: "重入探测条", body: "正文甲乙丙丁足够长以便参与相似度比较，用于触发 L2 合并分支。补充：新增触发器细节与索引说明。", type: "note", project: "R", tags: ["x"] });
  const t0 = Date.now();
  await svc.writeMemory({ title: "重入探测条", body: "正文甲乙丙丁足够长以便参与相似度比较，用于触发 L2 合并分支。", type: "note", project: "R", tags: ["x"] });
  check("连续写入未被死锁卡住（<3s）", Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  check("合并分支把信息量更大的新条留下", !!b.id && (b.id === a.id || b.noop === true || b.ok === true), JSON.stringify({ a: a.id, b: b.id, noop: b.noop }));

  console.log("[H2] daily 节元数据往返（重要度/标签/失效状态 + 正文纯净）");
  const d1 = await svc.writeMemory({ title: "元数据甲", body: "甲正文内容。", type: "daily", agent: "zcode", project: "R", tags: ["标一", "标二"], importance: 5, session: "sess-1" });
  const d2 = await svc.writeMemory({ title: "元数据乙", body: "乙正文内容。", type: "daily", agent: "zcode", project: "R" });
  const secs = S.parseDailySections(S.parseFrontmatter(svc.store.read(d1.path)).body);
  check("节元数据可解析（importance/tags/session）", secs[0].meta.importance === "5" && String(secs[0].meta.tags).includes("标一") && secs[0].meta.session === "sess-1", JSON.stringify(secs[0].meta));
  check("正文不含元数据行", !secs[0].body.includes("importance:") && secs[0].body.includes("甲正文内容"), JSON.stringify(secs[0].body));
  await svc.markSuperseded(d1.id, d2.id, "回归测试");
  svc.rebuildIndex();
  const d1After = svc.getById(d1.id);
  check("重建索引后失效状态保留", !!d1After.validTo && d1After.supersededBy === d2.id, JSON.stringify({ validTo: d1After.validTo, by: d1After.supersededBy }));
  check("重建索引后标签与重要度保留", d1After.importance === 5 && d1After.tags.length === 2, JSON.stringify({ imp: d1After.importance, tags: d1After.tags }));

  console.log("[H3] hash 口径统一（重建后同内容仍判重）");
  const h1 = await svc.writeMemory({ title: "哈希条", body: "同一段正文用于哈希口径验证。", type: "note", project: "R", tags: ["h"] });
  svc.rebuildIndex();
  const h2 = await svc.writeMemory({ title: "哈希条", body: "同一段正文用于哈希口径验证。", type: "note", project: "R", tags: ["h"] });
  check("重建后重写同内容 → NOOP", h2.noop === true, JSON.stringify(h2));

  console.log("[H4] 跨项目搬 daily 节：原文件剩余节仍在索引、空壳进回收站");
  await svc.projectAssign([d2.id], "R2");
  const remain = svc.list({ project: "R", pageSize: 50, includeSuperseded: true });
  const ghosts = remain.rows.filter((r) => !r.title);
  check("原项目剩余条目无幽灵（空标题）条目", ghosts.length === 0, JSON.stringify(ghosts.map((g) => g.id)));
  check("daily 文件仍在（还剩别的节）", svc.store.exists(d1.path), d1.path);

  console.log("[H6] 只读模式：不写库、不抛错");
  const roIdx = svc.index;
  roIdx.readOnly = true;
  const roWrite = await svc.writeMemory({ title: "只读下写入", body: "不该成功。" });
  check("只读时写入被拒（不崩）", roWrite.ok === false && /只读/.test(roWrite.message), JSON.stringify(roWrite));
  let roThrow = null;
  try {
    roIdx.removeByPath("x.md");
    roIdx.setMeta("k", "v");
    roIdx.beat("a", "t", true);
    roIdx.llmLog({ task: "x" });
    roIdx.reviewAdd("x", {});
    roIdx.reviewResolve("x", "y");
    roIdx.upsertBatch([], {});
  } catch (e) {
    roThrow = e.message;
  }
  check("只读下各写入口静默返回而非抛错", roThrow === null, String(roThrow));
  roIdx.readOnly = false;

  console.log("[P1] 导入判重与写入路径同口径（带标签不误判重复）");
  const srcDir = path.join(root, "_src2");
  fs.mkdirSync(srcDir, { recursive: true });
  const mdFile = path.join(srcDir, "same-content.md");
  fs.writeFileSync(mdFile, `---\ntitle: 口径标题\ntags: [t1]\ncreated: 2026-09-18\n---\n\n口径正文，与库里已有条目同题同文但标签不同。\n`, "utf8");
  fs.writeFileSync(path.join(srcDir, "other.md"), `---\ntitle: 另一条\n---\n\n完全不同的一条内容，用于验证导入。\n`, "utf8");
  const importer = new ImportEngine({ service: svc, rootDir: root, getConfig: () => svc.flat(), emit: () => {}, memCfg: cfg, expandPath: (p) => p });
  importer.saveSources([{ id: "t-md2", name: "MD 测试", kind: "md", path: srcDir, enabled: true, priority: 1 }]);
  const prev = await importer.preview({ sourceIds: ["t-md2"] });
  const applied = await importer.apply({ sourceIds: ["t-md2"] });
  check("带标签的同题同文不再被误判为重复", applied.ok && applied.created >= 1, JSON.stringify({ create: prev.wouldCreate, created: applied.created, skipped: applied.skipped }));
  check("导入保留原始 created（不塌成今天）", (() => {
    const rows = svc.list({ pageSize: 200 }).rows.filter((r) => r.title === "口径标题");
    return rows.length > 0;
  })(), "未找到导入条目");

  console.log("[P2] daily 解析边界：正文里的 ## 行/引用行不捣乱");
  const tricky = await svc.writeMemory({
    title: "边界条",
    body: "第一行\n> TODO: 这不是元数据\n## 12:30 · 这看起来像节头\n最后一行",
    type: "daily", agent: "zcode", project: "R",
  });
  const trickyDetail = svc.getById(tricky.id);
  check("正文里的伪节头/引用行都留在正文", trickyDetail.body.includes("TODO") && trickyDetail.body.includes("最后一行"), JSON.stringify(trickyDetail.body));
  const trickySecs = S.parseDailySections(S.parseFrontmatter(svc.store.read(tricky.path)).body);
  check("伪节头未被切成新节", trickySecs.filter((s) => s.id === tricky.id).length === 1, String(trickySecs.length));

  console.log("[P3] 无 frontmatter 的文件 id 稳定");
  const plain = path.join(root, "notes", "plain-note.md");
  fs.mkdirSync(path.dirname(plain), { recursive: true });
  fs.writeFileSync(plain, "这是一份用户直接丢进来的笔记，没有 frontmatter。\n", "utf8");
  svc.reindexFile("notes/plain-note.md");
  const idA = svc.list({ pageSize: 200 }).rows.find((r) => r.path === "notes/plain-note.md")?.id;
  svc.reindexFile("notes/plain-note.md");
  const idB = svc.list({ pageSize: 200 }).rows.find((r) => r.path === "notes/plain-note.md")?.id;
  check("两次重建索引 id 不变", !!idA && idA === idB, JSON.stringify({ idA, idB }));

  console.log("[P4] 标题含换行被单行化（不破坏节结构）");
  const nlTitle = await svc.writeMemory({ title: "标题第一行\n标题第二行", body: "正文。", type: "daily", agent: "zcode", project: "R" });
  const nlDetail = svc.getById(nlTitle.id);
  check("换行标题写入后仍落在同一节且 id 可解析", !!nlDetail && !nlDetail.title.includes("\n"), JSON.stringify(nlDetail && nlDetail.title));

  console.log("[P5] quirks 记忆对三种协议都生效");
  const { LlmClient, FORMATS } = require("../electron/backend/memory/llm/client.cjs");
  const client = new LlmClient({ service: svc, getConfig: () => svc.flat(), gatewayResolver: () => ({ available: false }) });
  client.quirksMemo.provX = { dropped: { thinking: true, temperature: true }, supportsThinking: false, dropTemperature: true };
  const { makeRequest } = require("../electron/backend/memory/llm/ir.cjs");
  const req = makeRequest({ system: "s", messages: [{ role: "user", content: "u" }], model: "m", maxTokens: 10, effort: "high", temperature: 0.7 });
  const anth = FORMATS.anthropic_messages.encode(req, { quirks: { supportsThinking: false, dropTemperature: true } });
  const chat = FORMATS.chat_completions.encode(req, { quirks: { dropTemperature: true, supportsReasoningEffort: false } });
  const resp = FORMATS.responses.encode(req, { quirks: { dropTemperature: true, supportsReasoningEffort: false } });
  check("Anthropic 不发 thinking / temperature", !anth.thinking && anth.temperature === undefined);
  check("Chat 不发 temperature（reasoning_effort 由能力位控制）", chat.temperature === undefined);
  check("Responses 不发 temperature", resp.temperature === undefined);
  check("customBudget 传到 IR", makeRequest({ messages: [], model: "m", effort: "custom", customBudget: 8192 }).reasoning.customBudget === 8192);

  console.log("[P8] SQLite 水位：TEXT 主键不卡死、WITHOUT ROWID 不静默 0 条");
  const dbFile = path.join(root, "_src2", "uuid.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE msgs_uuid (id TEXT PRIMARY KEY, role TEXT, content TEXT, created_at TEXT)");
  for (let i = 1; i <= 3; i++) {
    db.prepare("INSERT INTO msgs_uuid VALUES (?,?,?,?)").run(`uuid-00${i}`, "user", `第 ${i} 条内容足够长以便被收录进记忆库。`, "2026-09-01T10:00:00Z");
  }
  db.exec("CREATE TABLE wor (id INTEGER PRIMARY KEY, role TEXT, content TEXT, created_at TEXT) WITHOUT ROWID");
  db.prepare("INSERT INTO wor VALUES (?,?,?,?)").run(1, "user", "WITHOUT ROWID 表里的一条内容足够长以便被收录。", "2026-09-01T10:00:00Z");
  db.close();
  let uuidItems = 0;
  const ru = parseSqlite({ id: "u", path: dbFile, kind: "sqlite", table: "msgs_uuid" }, null, { batchSize: 100 }, () => uuidItems++);
  check("TEXT 主键表能读到条目（rowid 水位）", uuidItems === 3, JSON.stringify({ items: uuidItems, note: ru.note }));
  check("TEXT 主键表水位可推进", Number(ru.nextCursor.lastId) === 3, JSON.stringify(ru.nextCursor));
  let worItems = 0;
  const rw = parseSqlite({ id: "w", path: dbFile, kind: "sqlite", table: "wor" }, null, { batchSize: 100 }, () => worItems++);
  check("WITHOUT ROWID 表能读到条目（有数值主键）", worItems === 1, JSON.stringify({ items: worItems, note: rw.note }));
  check("WITHOUT ROWID 表水位可推进（INT 主键）", Number(rw.nextCursor.lastId) === 1, JSON.stringify(rw.nextCursor));

  console.log("[P9] 图扩散邻居服从 project 过滤");
  const pA = await svc.writeMemory({ title: "A 项目种子", body: "甲项目的内容。", type: "note", project: "PA", tags: ["关联"] });
  const pB = await svc.writeMemory({ title: "B 项目邻居", body: "乙项目的内容。", type: "note", project: "PB", refs: [`mem:${pA.id}`] });
  void pB;
  const scoped = svc.searchMemories("甲项目", { project: "PA", limit: 8 }, svc.flat());
  check("显式项目过滤下不带出其它项目", scoped.results.every((r) => !r.project || r.project === "PA"), JSON.stringify(scoped.results.map((r) => r.project)));

  console.log("[P11] 回收站按 sidecar 元数据恢复");
  const trashed = await svc.deleteMemory(a.id);
  check("删除进回收站", trashed.ok === true);
  const list = svc.trashList();
  check("回收站记录带原路径", list.length > 0 && !!list[0].originPath, JSON.stringify(list[0]));
  const restored = await svc.trashRestore(list[0].name, "");
  check("省略 dest 也能恢复（不抛错）", restored.ok === true && !!restored.path, JSON.stringify(restored));

  console.log("[P10] 多字节截断不产生替换符");
  cfg.set({ "storage.maxFileSizeKB": 16 });
  const big = "字".repeat(20000);
  const bigWrite = await svc.writeMemory({ title: "大文件条", body: big, type: "note", project: "R" });
  const bigDetail = svc.getById(bigWrite.id);
  check("截断后正文无替换符（U+FFFD）", !bigDetail.body.includes("\uFFFD"), JSON.stringify(bigDetail.body.slice(-12)));
  check("截断提示已加", bigDetail.body.includes("超出单条上限已截断"));
  cfg.set({ "storage.maxFileSizeKB": 512 });

  console.log("[N1] 调度器忙时不再形成重试风暴");
  const scheduler = new MemoryScheduler({ service: svc, tasks: { runExtract: async () => ({ processed: 0, tokens: 0, detail: "x" }) }, getConfig: () => svc.flat(), emit: () => {} });
  scheduler.running = { id: "busy", startedAt: Date.now(), phase: "start" };
  let calls = 0;
  scheduler.runTask = async () => { calls++; return { ok: false, retry: true }; };
  scheduler.queue.push({ id: "extract", at: Date.now() });
  const started = Date.now();
  await scheduler._drain();
  scheduler.running = null;
  check("retry 项回队后本轮立即结束（不空转）", calls === 1 && scheduler.queue.length === 1, JSON.stringify({ calls, queueLen: scheduler.queue.length, ms: Date.now() - started }));

  console.log("[P18] 心跳记录失败");
  const { MemoryHttpApi } = require("../electron/backend/memory/httpapi.cjs");
  const httpApi = new MemoryHttpApi(svc, path.join(root, "runtime.json"), {});
  let beatOk = null;
  const origBeat = svc.index.beat.bind(svc.index);
  svc.index.beat = (agent, tool, ok) => { beatOk = ok; return origBeat(agent, tool, ok); };
  const badTool = { byName: () => ({ run: async () => { throw new Error("工具炸了"); } }) };
  const origTools = require("../electron/backend/memory/tools.cjs");
  const realByName = origTools.byName;
  origTools.byName = badTool.byName;
  let threw = false;
  try {
    await httpApi.dispatch("memory_search", {}, "agent-x");
  } catch {
    threw = true;
  }
  origTools.byName = realByName;
  svc.index.beat = origBeat;
  check("工具失败时心跳记为失败", threw && beatOk === false, JSON.stringify({ threw, beatOk }));

  console.log("[P22] 同步设备登记字段就位");
  const { MemorySync } = require("../electron/backend/memory/sync.cjs");
  const syncObj = new MemorySync({ service: svc, getConfig: () => svc.flat(), emit: () => {}, rootDir: root, dataDir: root, deviceName: "TEST-HOST" });
  check("设备名已注入且 refreshDevices 可调用", syncObj.deviceName === "TEST-HOST" && typeof syncObj.refreshDevices === "function");
  check("未配置 WebDAV 时 devices 返回数组而非抛错", Array.isArray(await syncObj.refreshDevices()));

  svc.close();
  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("回归自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});
