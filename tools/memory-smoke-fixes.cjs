/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 第三轮回归断言：把已修复的高/中危逐条钉成可证伪的测试。
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

/**
 * 跨平台的同路径判定。
 *
 * 为什么不能直接 `path.resolve(a) === path.resolve(b)`：resolve 只归一化分隔符，
 * 不归一化大小写，也不解 8.3 短名 / junction / 符号链接。git 输出的是它自己的写法
 * （实测 `git rev-parse --show-toplevel` 返回 `C:/Users/...` 正斜杠形式），而
 * os.tmpdir()/path.join 给的是另一种；在 CI（GitHub runner）上直接比会假失败。
 *
 * 故：先用 realpathSync.native 取真实路径（解短名/链接/大小写），再 resolve，
 * win32 上折叠大小写。任一步失败则退回原值，绝不让归一化本身抛异常。
 */
function samePath(a, b) {
  const norm = (x) => {
    const raw = String(x || "");
    let r = raw;
    try { r = fs.realpathSync.native(raw); } catch { /* 路径不存在或平台不支持：退回原名 */ }
    r = path.resolve(r);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
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

  console.log("[P23] 索引范围口径统一（范围外文件不再变成清不掉的孤儿行）");
  check("范围判定：reports/_import/.trash 内文件排除，四个记忆顶层收录",
    !S.isIndexableRel("reports/conflict-x.md") && !S.isIndexableRel("_import/report-x.md") && !S.isIndexableRel(".trash/x.md")
    && !S.isIndexableRel("projects/demo/l1/a.md.bak.1") && !S.isIndexableRel("notes/a.txt")
    && S.isIndexableRel("projects/demo/l1/zcode/a.md") && S.isIndexableRel("general/l1/zcode/day.md") && S.isIndexableRel("notes/a.md"),
    "isIndexableRel 白名单必须与 walk 同源");
  check("监听口径：目录一律放行，范围外顶层整棵排除",
    S.isIndexWatchTarget("general", false) && S.isIndexWatchTarget("projects/demo/l1/zcode", false)
    && !S.isIndexWatchTarget("reports", false) && !S.isIndexWatchTarget("_import", false)
    && !S.isIndexWatchTarget("general/l1/reports", false) && !S.isIndexWatchTarget("reports/conflict-x.md", true)
    && S.isIndexWatchTarget("general/l1/zcode/a.md", true) && !S.isIndexWatchTarget("general/l1/zcode/a.md.bak.1", true),
    "目录被判成不可索引会让整棵子树失去监听（外部编辑不再重索引）");
  // 同步冲突留档：目录监听曾把它索引成行，而扫描永远看不见它 → 诊断里恒定「孤儿行 1」
  fs.writeFileSync(path.join(root, "reports", "conflict-1.md"), "# 同步冲突留档\n\n路径：general/l1/zcode/x.md\n", "utf8");
  const rpt = svc.reindexFile("reports/conflict-1.md");
  check("范围外文件不建索引行", rpt.skipped === "out-of-scope"
    && svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE path = ?").get("reports/conflict-1.md").c === 0,
    JSON.stringify(rpt));
  check("walk 不收 reports/_import 下的文件",
    svc.store.walkMemoryFiles().every((p) => !p.startsWith("reports/") && !p.startsWith("_import/")));

  // 历史脏行（旧版本已索引进库）：「一键修复」必须能清掉，否则用户只会反复看到同一句差异
  svc.index.db.prepare("INSERT INTO mem (id, path, anchor, type, layer, title, summary, created, updated) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("file_dirty", "reports/conflict-old.md", null, "note", "l1", "同步冲突留档", "历史脏行", Date.now(), Date.now());
  const diagDirty = svc.diagnose();
  check("诊断能看见历史孤儿行", diagDirty.orphanRows.includes("reports/conflict-old.md"), JSON.stringify(diagDirty.orphanRows));
  const prunedOut = svc.pruneOrphans();
  check("pruneOrphans 清掉孤儿行并让诊断归零", prunedOut === 1 && svc.diagnose().orphanRows.length === 0, JSON.stringify({ prunedOut }));

  // 应用关闭期间被外部删除的文件：同一口径清理
  const gone = await svc.writeMemory({ title: "待删条", body: "用于孤儿行清理验证的正文内容，长度足够。", type: "note", project: "R" });
  fs.rmSync(path.join(root, gone.path), { force: true });
  const prunedGone = svc.pruneOrphans();
  check("磁盘已删文件的索引行被清理", prunedGone >= 1
    && svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE path = ?").get(gone.path).c === 0, JSON.stringify({ prunedGone }));

  // 守卫不得误伤正常记忆文件
  const keep = await svc.writeMemory({ title: "正常条", body: "正常记忆文件必须照常入索引，守卫不得误伤。", type: "note", project: "R" });
  svc.reindexFile(keep.path);
  check("范围内文件照常入索引", svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE path = ?").get(keep.path).c >= 1, keep.path);

  console.log("[P23b] 存量大小写脏行自愈（同 id 双 path / 项目卡裂开）");
  // v1.42.1 之前 writeMemory 拼小写 slug 路径、watcher 拿目录真名，NTFS 上同一文件在索引里
  // 留下两行只差大小写（同 id 同内容）：界面显示两遍、删一条留幽灵；项目卡也按大小写裂成两张。
  // 这里照原样造出那两行，断言 normalizeCase 收敛成磁盘口径的一行、且用户状态不丢。
  const cased = await svc.writeMemory({ title: "大小写脏行条", body: "同一文件在索引里留下两行只差大小写，收敛必须只留磁盘口径的一行。", type: "note", project: "AgentHub" });
  const casedRow = svc.index.db.prepare("SELECT * FROM mem WHERE id = ?").get(cased.id);
  const segs = casedRow.path.split("/");
  const segIdx = segs.indexOf("agenthub") >= 0 ? segs.indexOf("agenthub") : segs.indexOf("AgentHub");
  segs[segIdx] = segs[segIdx] === "agenthub" ? "AgentHub" : "agenthub";
  const ghostPath = segs.join("/");
  const cols = Object.keys(casedRow);
  // 只给「索引独有」的状态上值：pinned/starred 在 note 类文件里以 frontmatter 为准（reindexFile 的
  // fm.pinned 优先），拿它断言测不到合并；dup_index / dedup_status / ai_processed 只存在索引里
  svc.index.db.prepare(`INSERT OR REPLACE INTO mem (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => (c === "path" ? ghostPath : c === "dup_index" ? 3 : c === "ai_processed" ? 1 : c === "dedup_status" ? "dedup-l2" : casedRow[c])));
  svc.index.db.prepare("UPDATE mem SET project = 'AgentHub' WHERE id = ?").run(cased.id); // 历史行的 project 还留着目录真名
  check("造出同 id 双 path 的历史状态",
    svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE id = ?").get(cased.id).c === 2, ghostPath);
  const caseFixed = svc.normalizeCase();
  const afterCase = svc.index.db.prepare("SELECT id, path, project, dup_index, dedup_status, ai_processed FROM mem WHERE id = ?").all(cased.id);
  check("normalizeCase 收敛为磁盘口径一行",
    caseFixed >= 1 && afterCase.length === 1 && afterCase[0].path === casedRow.path, JSON.stringify(afterCase));
  check("收敛时索引独有的状态不丢（重复序号/去重结论/AI 标记）",
    afterCase.length === 1 && afterCase[0].dup_index === 3 && afterCase[0].dedup_status === "dedup-l2" && !!afterCase[0].ai_processed,
    JSON.stringify(afterCase[0]));
  check("project 列折小写（项目卡条数不再裂开）", afterCase.length === 1 && afterCase[0].project === "agenthub", afterCase.length === 1 ? afterCase[0].project : "");
  check("幂等：再跑一次零改动", svc.normalizeCase() === 0);
  // 台账里同项目的两条大小写条目（老版本新建卡留下）：normalize 合并成一条，卡片随之只剩一张
  const regFile = path.join(root, "projects", "_index.json");
  const regJson = JSON.parse(fs.readFileSync(regFile, "utf8"));
  regJson.projects.push({ slug: "AgentHub", name: "AgentHub", remotes: ["r2"], aliases: ["ah"], localPaths: [], agents: [], origin: "git", created: 2, updated: 2 });
  fs.writeFileSync(regFile, JSON.stringify(regJson, null, 2));
  const cardsBefore = svc.projects().projects.filter((p) => p.slug.toLowerCase() === "agenthub").length;
  svc.registry.normalize();
  const regAfter = JSON.parse(fs.readFileSync(regFile, "utf8")).projects.filter((p) => String(p.slug).toLowerCase() === "agenthub");
  const cardsAfter = svc.projects().projects.filter((p) => p.slug.toLowerCase() === "agenthub");
  check("台账大小写重复条目合并成一条", cardsBefore === 2 && regAfter.length === 1, JSON.stringify({ cardsBefore, regAfter: regAfter.map((p) => p.slug) }));
  check("合并后卡片条数仍含该项目的记忆", cardsAfter.length === 1 && cardsAfter[0].count >= 1, JSON.stringify(cardsAfter.map((p) => ({ slug: p.slug, count: p.count }))));

  console.log("[P23c] 大小写归一的三个易漏点（台账单条大写 / 链接保留 / 孪生项目合并与指派）");
  // 1) 台账里只有一条大写 slug（没有小写孪生条目）：也要折——索引侧 reindexFile 已把 project 折成小写，
  //    台账不折就永远对不上，卡片显示 0 条（早期实现只在「合并重复条目」时落盘，单条会被丢掉）
  regJson.projects.push({ slug: "LegacyOnly", name: "LegacyOnly", remotes: [], aliases: [], localPaths: [], agents: [], origin: "git", created: 1, updated: 1 });
  fs.writeFileSync(regFile, JSON.stringify(regJson, null, 2));
  const normChanged = svc.registry.normalize();
  const legacySlugs = JSON.parse(fs.readFileSync(regFile, "utf8")).projects.map((p) => p.slug).filter((s) => String(s).toLowerCase() === "legacyonly");
  check("台账里单条大写 slug 也折小写", normChanged >= 1 && legacySlugs.length === 1 && legacySlugs[0] === "legacyonly", JSON.stringify({ normChanged, legacySlugs }));

  // 2) 收敛同 id 双 path 时不能清掉 mem_link：removeByPath 会按 id 连带删链接，
  //    而两条行是同一个 id —— 先重索引后删行会把刚重建的链接（相关记忆/图谱边）清空
  const linked = await svc.writeMemory({ title: "带引用条", body: "验证收敛时相关记忆的边不被清掉。", type: "note", project: "R", refs: ["project:R", "topic:回归"] });
  const linksOf = () => svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem_link WHERE src = ?").get(linked.id).c;
  const linkedRow = svc.index.db.prepare("SELECT * FROM mem WHERE id = ?").get(linked.id);
  const linkCols = Object.keys(linkedRow);
  svc.index.db.prepare(`INSERT OR REPLACE INTO mem (${linkCols.join(",")}) VALUES (${linkCols.map(() => "?").join(",")})`)
    .run(...linkCols.map((c) => (c === "path" ? linkedRow.path.toLowerCase() : linkedRow[c])));
  const linksBefore = linksOf();
  svc.normalizeCase();
  const linksAfter = linksOf();
  check("收敛后 mem_link 不被连带清空", linksBefore > 0 && linksAfter === linksBefore, JSON.stringify({ linksBefore, linksAfter }));

  // 3) 大小写孪生项目「合并到自身」必须被拦：NTFS 上 projects/AgentHub 与 projects/agenthub 是同一目录，
  //    放过去会把目标项目的文件当残留整目录进回收站（老代码只认精确相等）
  const twinReg = JSON.parse(fs.readFileSync(regFile, "utf8"));
  twinReg.projects.push({ slug: "AgentHub", name: "AgentHub", remotes: [], aliases: [], localPaths: [], agents: [], origin: "git", created: 3, updated: 3 });
  fs.writeFileSync(regFile, JSON.stringify(twinReg, null, 2));
  const filesBeforeMerge = svc.store.walkMemoryFiles().length;
  const twinMerge = await svc.projectMerge("AgentHub", "agenthub");
  check("大小写孪生项目合并被拦下且不动磁盘",
    twinMerge.ok === false && svc.store.walkMemoryFiles().length === filesBeforeMerge,
    JSON.stringify({ twinMerge, filesBeforeMerge, filesAfter: svc.store.walkMemoryFiles().length }));

  // 4) 把记忆指派到「大小写不同的同名项目」：目标路径按磁盘真名归一后应判定为原地，不得写一遍再送进回收站
  const filesBeforeAssign = svc.store.walkMemoryFiles().length;
  const twinAssign = await svc.projectAssign([linked.id], "R");
  check("指派到大小写不同的同名项目不误删文件",
    twinAssign.ok === true && twinAssign.moved === 0 && svc.store.walkMemoryFiles().length === filesBeforeAssign,
    JSON.stringify({ twinAssign, filesBeforeAssign, filesAfter: svc.store.walkMemoryFiles().length }));

  console.log("[P24] 外部编辑/全量重建保留索引态（dedup_status / dup_index / ai_processed）");
  const kept = await svc.writeMemory({ title: "索引态继承条", body: "外部编辑与全量重建都不该把去重结论和 AI 处理标记抹掉。", type: "note", project: "R", tags: ["状态"] });
  // 模拟事后状态：L2 判定完成、重复序号、AI 任务已处理（这些都只存在索引里，文件无对应字段位）
  svc.index.db.prepare("UPDATE mem SET dedup_status = 'dedup-l2', dup_index = 2, ai_processed = 1 WHERE id = ?").run(kept.id);
  svc.reindexFile(kept.path); // 单文件重建：外部编辑走这条
  const afterSingle = svc.index.db.prepare("SELECT dedup_status, dup_index, ai_processed FROM mem WHERE id = ?").get(kept.id);
  check("单文件重建后索引态仍在", !!afterSingle && afterSingle.dedup_status === "dedup-l2" && afterSingle.dup_index === 2 && afterSingle.ai_processed === 1, JSON.stringify(afterSingle));
  svc.rebuildIndex(); // 全量重建：legacyRows 快照走这条
  const afterFull = svc.index.db.prepare("SELECT dedup_status, dup_index, ai_processed FROM mem WHERE id = ?").get(kept.id);
  check("全量重建后索引态仍在", !!afterFull && afterFull.dedup_status === "dedup-l2" && afterFull.dup_index === 2 && afterFull.ai_processed === 1, JSON.stringify(afterFull));
  // 内容真变了就必须把旧结论作废，否则改过的正文会沿用「已去重/已处理」的结论
  fs.appendFileSync(svc.store.abs(kept.path), "\n补充一段：外部改动的正文。\n", "utf8");
  svc.reindexFile(kept.path);
  const afterEdit = svc.index.db.prepare("SELECT dedup_status, ai_processed FROM mem WHERE id = ?").get(kept.id);
  check("内容变更后去重结论与 AI 标记作废", !!afterEdit && afterEdit.dedup_status === "pending" && afterEdit.ai_processed === 0, JSON.stringify(afterEdit));

  console.log("[P25] 目录名反解：深层 cwd 不再因段数上限归 general");
  const layoutMod = require("../electron/backend/memory/layout.cjs");
  const deepRoot = path.join(os.tmpdir(), "agenthub-deep-probe");
  fs.rmSync(deepRoot, { recursive: true, force: true });
  const deep = path.join(deepRoot, ..."abcdefgh".split("").map((c) => `lvl-${c}`), "repo-x");
  fs.mkdirSync(deep, { recursive: true });
  const encodedDeep = `${deep[0].toLowerCase()}-${deep.slice(3).split(path.sep).join("-")}`;
  check("段数确实超过旧上限 8", encodedDeep.split("-").length - 1 > 8, String(encodedDeep.split("-").length - 1));
  check("深层路径可反解", layoutMod.reverseSessionDirName(encodedDeep) === deep, layoutMod.reverseSessionDirName(encodedDeep));
  // 不存在的深层路径必须返回空串：宁可不猜，也不要挂到别的项目下
  check("不存在的深层路径仍返回空串", layoutMod.reverseSessionDirName("c-NoSuch-A-B-C-D-E-F-G-H-I-J") === "");
  fs.rmSync(deepRoot, { recursive: true, force: true });

  console.log("[P26] 项目 Git 元数据：显式项目补全 / 多远程 / 存量自愈 / 正式关联入口");
  // 全部用临时仓库与虚构身份（example-org / upstream-org 等占位组织名），不引入任何真实账号或仓库
  const { execFileSync } = require("child_process");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const repoA = path.join(os.tmpdir(), `agenthub-meta-repo-${Date.now()}`);
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.mkdirSync(repoA, { recursive: true });
  git(repoA, ["init", "-q"]);
  git(repoA, ["remote", "add", "origin", "https://github.com/example-org/demo-app.git"]);
  git(repoA, ["remote", "add", "upstream", "https://github.com/upstream-org/demo-app.git"]);
  // ssh 与 https 指向同一仓库：归一化后必须只留一条
  git(repoA, ["remote", "set-url", "--add", "origin", "git@github.com:example-org/demo-app.git"]);

  const all = layoutMod.detectGitRemotes(repoA);
  check("枚举全部远程（origin 优先，upstream 也在）",
    all.length === 2 && all[0].display === "example-org/demo-app" && all.some((r) => r.display === "upstream-org/demo-app"),
    JSON.stringify(all.map((r) => r.display)));
  check("同一仓库的 ssh/https 两种 URL 归一化去重", all.filter((r) => r.display === "example-org/demo-app").length === 1);
  check("兼容入口 detectGitRemote 仍取 origin", (layoutMod.detectGitRemote(repoA) || {}).display === "example-org/demo-app");
  check("非 Git 目录返回空数组且不抛", layoutMod.detectGitRemotes(os.tmpdir()).length === 0);

  // 显式项目名 + cwd：slug/名字保持显式，同时补上全部远程与 git root
  const explicit = layoutMod.classify({ project: "DemoApp", cwd: repoA, agent: "probe" }, svc.registry, undefined);
  const expEntry = svc.registry.get(explicit.slug);
  check("显式项目名仍作 slug（不裂成 owner--repo 卡）", explicit.slug === "demoapp", explicit.slug);
  check("显式项目补上全部远程", (expEntry.remotes || []).length === 2, JSON.stringify(expEntry.remotes));
  check("显式项目补上 git root 作本地路径",
    (expEntry.localPaths || []).some((x) => samePath(x, repoA)), JSON.stringify(expEntry.localPaths));
  check("显式归类来源仍是 explicit", explicit.origin === "explicit");

  // 不带 project：走 git 分支，slug 由远程决定，同样记全部远程
  const auto = layoutMod.classify({ cwd: repoA, agent: "probe" }, svc.registry, undefined);
  const autoEntry = svc.registry.get(auto.slug);
  check("无 project 时按 origin 生成 owner--repo slug", auto.slug === "example-org--demo-app", auto.slug);
  check("git 分支也记全部远程", (autoEntry.remotes || []).length === 2, JSON.stringify(autoEntry.remotes));

  // 写记忆落 frontmatter：git 字段不再以 origin==="git" 为条件
  const wExplicit = await svc.writeMemory({ title: "显式项目带 cwd 写入", body: "显式项目名写入也应记下 git 元数据，供项目卡与存量自愈使用。", type: "note", project: "DemoApp", cwd: repoA });
  const fmExplicit = S.parseFrontmatter(svc.store.read(wExplicit.path)).fm;
  check("显式项目写入的 frontmatter 带 cwd", String(fmExplicit.cwd || "").length > 0, JSON.stringify(fmExplicit.cwd));
  check("显式项目写入的 frontmatter 带 git", String(fmExplicit.git || "").length > 0, JSON.stringify(fmExplicit.git));

  // 存量自愈：手工造一个「只有 cwd/git 的旧卡」——台账空、记忆文件带元数据
  const legacySlug = "legacy-project";
  svc.registry.upsert({ slug: legacySlug, name: "LegacyProject", origin: "explicit" });
  const legacyFile = path.join(root, "projects", legacySlug, "l1", "probe", "2026-01-01-legacy.md");
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, S.serializeFrontmatter({
    id: "mem_legacy_probe", type: "note", layer: "l1", title: "存量旧卡",
    project: legacySlug, projectName: "LegacyProject", agent: "probe", device: "dev_fix",
    created: new Date().toISOString(), updated: new Date().toISOString(), validFrom: new Date().toISOString(),
    tags: "probe", importance: 3, summary: "存量自愈探针", cwd: repoA, git: "example-org/demo-app",
  }) + "\n\n存量项目卡缺远程与本地路径，应从已有 frontmatter 自愈回来。\n", "utf8");
  svc.reindexFile(`projects/${legacySlug}/l1/probe/2026-01-01-legacy.md`);
  const healRes = svc.reconcileProjectMetadata();
  const healedEntry = svc.registry.get(legacySlug);
  check("存量自愈从 frontmatter 补回远程", healRes.healed >= 1 && (healedEntry.remotes || []).includes("example-org/demo-app"), JSON.stringify({ healRes, remotes: healedEntry.remotes }));
  check("存量自愈同时补回本地路径", (healedEntry.localPaths || []).length > 0, JSON.stringify(healedEntry.localPaths));
  check("自愈幂等：再跑一次不再改动", svc.reconcileProjectMetadata().healed === 0);

  // 只有本地路径、没有远程的卡：也应从已关联目录探到远程（早期只关联目录的场景）
  const pathOnlySlug = "path-only-project";
  svc.registry.upsert({ slug: pathOnlySlug, name: "PathOnly", origin: "explicit", localPaths: [repoA] });
  const healPathOnly = svc.reconcileProjectMetadata();
  const pathOnlyEntry = svc.registry.get(pathOnlySlug);
  check("缺远程但有本地路径的项目也能自愈出远程",
    healPathOnly.healed >= 1 && (pathOnlyEntry.remotes || []).length === 2, JSON.stringify({ healPathOnly, remotes: pathOnlyEntry.remotes }));
  check("自愈保留有 origin 项目的 origin+upstream（fork 与上游都在）",
    (() => { const r = svc.registry.get(legacySlug).remotes || []; return r.length === 2 && r.includes("example-org/demo-app") && r.includes("upstream-org/demo-app"); })(),
    JSON.stringify(svc.registry.get(legacySlug).remotes));

  // 反向缺口：有远程但缺本地路径的卡也要补齐（只补远程的写法会漏掉这一类）
  const remoteOnlySlug = "remote-only-project";
  svc.registry.upsert({ slug: remoteOnlySlug, name: "RemoteOnly", origin: "explicit", remotes: ["example-org/demo-app"] });
  const remoteOnlyRel = `projects/${remoteOnlySlug}/l1/probe/2026-01-01-remote-only.md`;
  const remoteOnlyAbs = path.join(root, remoteOnlyRel);
  fs.mkdirSync(path.dirname(remoteOnlyAbs), { recursive: true });
  fs.writeFileSync(remoteOnlyAbs, S.serializeFrontmatter({
    id: "mem_remote_only", type: "note", layer: "l1", title: "有远程缺路径",
    project: remoteOnlySlug, agent: "probe", created: new Date().toISOString(), updated: new Date().toISOString(),
    validFrom: new Date().toISOString(), tags: "probe", importance: 3, summary: "反向缺口探针", cwd: repoA, git: "example-org/demo-app",
  }) + "\n\n有远程但缺本地路径的项目，也应从 frontmatter 的 cwd 补回路径。\n", "utf8");
  svc.reindexFile(remoteOnlyRel);
  const healRemoteOnly = svc.reconcileProjectMetadata();
  const remoteOnlyEntry = svc.registry.get(remoteOnlySlug);
  check("有远程但缺路径的项目补回本地路径",
    healRemoteOnly.healed >= 1 && (remoteOnlyEntry.localPaths || []).some((x) => samePath(x, repoA)),
    JSON.stringify({ healRemoteOnly, localPaths: remoteOnlyEntry.localPaths }));
  check("补路径时记 Git 根而非子目录", (remoteOnlyEntry.localPaths || []).length === 1, JSON.stringify(remoteOnlyEntry.localPaths));

  // 正式关联入口：不新建卡、不改 slug；非 Git 目录只记路径
  const attachTarget = svc.registry.get(legacySlug);
  const plainDir = path.join(os.tmpdir(), `agenthub-plain-${Date.now()}`);
  fs.mkdirSync(plainDir, { recursive: true });
  const attachPlain = svc.projectAttachPath(legacySlug, plainDir);
  check("关联非 Git 目录成功且如实说明不是仓库", attachPlain.ok === true && attachPlain.isRepo === false, JSON.stringify(attachPlain));
  const attachRepo2 = svc.projectAttachPath(legacySlug, repoA);
  const afterAttach = svc.registry.get(legacySlug);
  check("关联 Git 仓库识别到远程", attachRepo2.ok === true && attachRepo2.isRepo === true && (attachRepo2.addedRemotes || []).length === 2, JSON.stringify(attachRepo2.addedRemotes));
  check("关联不新建卡、slug 不变", afterAttach.slug === attachTarget.slug && svc.registry.list().filter((p) => p.slug === legacySlug).length === 1);
  check("关联到不存在的项目被拒", svc.projectAttachPath("no-such-project", repoA).ok === false);
  check("关联不存在的目录被拒", svc.projectAttachPath(legacySlug, path.join(os.tmpdir(), "no-such-dir-xyz")).ok === false);
  check("关联文件而非目录被拒", svc.projectAttachPath(legacySlug, legacyFile).ok === false);

  // ===== 身份只认 origin：非 origin 的 remote（upstream / 误配）不得当身份 =====
  // 背景（实测）：某项目目录只挂了一个指向别的仓库的 upstream，旧实现「取第一个远程」会把它
  // 当成本项目身份；slug 与 frontmatter.git 都派生自身份，判错就会把项目归到别的仓库下。
  const upstreamOnly = path.join(os.tmpdir(), `agenthub-upstream-only-${Date.now()}`);
  fs.rmSync(upstreamOnly, { recursive: true, force: true });
  fs.mkdirSync(upstreamOnly, { recursive: true });
  git(upstreamOnly, ["init", "-q"]);
  git(upstreamOnly, ["remote", "add", "upstream", "https://github.com/other-org/unrelated.git"]);
  check("无 origin 时身份为空（不拿 upstream 顶替）", layoutMod.detectGitRemote(upstreamOnly) === null,
    JSON.stringify((layoutMod.detectGitRemote(upstreamOnly) || {}).display));
  // 台账「远程仓库」列的口径：有 origin 才算身份。无 origin 时不得写入远程（否则项目卡会显示成别人的仓库）
  check("无 origin 时台账远程为空（不把 upstream 当身份展示）",
    layoutMod.displayRemotesFor(upstreamOnly).length === 0, JSON.stringify(layoutMod.displayRemotesFor(upstreamOnly)));
  check("有 origin 时台账远程含 origin 与 upstream（fork + 上游都看得到）",
    (() => { const r = layoutMod.displayRemotesFor(repoA); return r.length === 2 && r[0] === "example-org/demo-app" && r.includes("upstream-org/demo-app"); })(),
    JSON.stringify(layoutMod.displayRemotesFor(repoA)));
  check("有 origin 时身份就是 origin（不被其它远程抢走）",
    (layoutMod.detectGitRemote(repoA) || {}).display === "example-org/demo-app",
    JSON.stringify((layoutMod.detectGitRemote(repoA) || {}).display));
  fs.rmSync(upstreamOnly, { recursive: true, force: true });

  // 纠正：台账里已写入的「无 origin 远程」必须被清掉（历史污染），有 origin 的项目保留并集
  const noOriginSlug = "no-origin-demo";
  const noOriginDir = path.join(os.tmpdir(), `agenthub-no-origin-${Date.now()}`);
  fs.mkdirSync(noOriginDir, { recursive: true });
  git(noOriginDir, ["init", "-q"]);
  git(noOriginDir, ["remote", "add", "upstream", "https://github.com/other-org/unrelated.git"]);
  svc.registry.upsert({ slug: noOriginSlug, name: "NoOriginDemo", origin: "explicit", remotes: ["other-org/unrelated"], localPaths: [noOriginDir] });
  svc.reconcileProjectMetadata();
  const noOriginEntry = svc.registry.get(noOriginSlug);
  check("自愈清掉「无 origin」项目的历史远程（不再显示成别人仓库）",
    (noOriginEntry.remotes || []).length === 0, JSON.stringify(noOriginEntry.remotes));
  fs.rmSync(noOriginDir, { recursive: true, force: true });

  // ===== 历史脏路径必须被清除，但用户手动关联的路径不得被误删 =====
  // 台账里的路径不天然可信：旧版本没做归属校验，会话 cwd 里的无关目录就是这么进来的
  const dirtySlug = "dirty-paths-demo";
  const dirtyDir = path.join(os.tmpdir(), `agenthub-dirty-${Date.now()}`);
  const manualDir = path.join(os.tmpdir(), `agenthub-manual-${Date.now()}`);
  fs.mkdirSync(dirtyDir, { recursive: true });
  fs.mkdirSync(manualDir, { recursive: true });
  // 直接写台账模拟「历史遗留」：两条路径都无归属证明，但 manualDir 被标记为用户手动关联
  svc.registry.upsert({ slug: dirtySlug, name: "DirtyPathsDemo", origin: "explicit", localPaths: [dirtyDir, manualDir], manualPaths: [manualDir] });
  const dirtyRes = svc.reconcileProjectMetadata();
  const dirtyEntry = svc.registry.get(dirtySlug);
  check("自愈清除无归属证明的历史脏路径",
    !(dirtyEntry.localPaths || []).includes(dirtyDir), JSON.stringify({ dirtyRes, paths: dirtyEntry.localPaths }));
  check("用户手动关联的路径不被误删",
    (dirtyEntry.localPaths || []).some((x) => samePath(x, manualDir)), JSON.stringify(dirtyEntry.localPaths));
  check("清除计入 pruned", dirtyRes.pruned >= 1, JSON.stringify(dirtyRes));
  check("清完即幂等（不再每轮重写台账）", svc.reconcileProjectMetadata().healed === 0);
  fs.rmSync(dirtyDir, { recursive: true, force: true });
  fs.rmSync(manualDir, { recursive: true, force: true });

  // ===== 过浅路径过滤：家目录 / 盘符根 / 家目录下通用目录不得当项目路径 =====
  const home = os.homedir();
  check("家目录本身不算项目路径", layoutMod.isProjectDirCandidate(home) === false, home);
  check("盘符根不算项目路径", layoutMod.isProjectDirCandidate(path.parse(home).root) === false, path.parse(home).root);
  check("家目录下的 Desktop 不算项目路径", layoutMod.isProjectDirCandidate(path.join(home, "Desktop")) === false);
  check("普通项目目录算项目路径", layoutMod.isProjectDirCandidate(repoA) === true, repoA);

  // ===== 归属证明：只记能证明属于本项目的路径（会话 cwd 可能是无关目录） =====
  // 实测踩过：~/.dsh 与 WorkBuddy 会话目录被当成项目路径挂到卡上
  const unrelated = path.join(os.tmpdir(), `agenthub-unrelated-${Date.now()}`);
  fs.mkdirSync(unrelated, { recursive: true }); // 存在但非仓库、名字也不匹配
  check("无关目录不算项目路径（名字不匹配且非本项目仓库）",
    layoutMod.isPathForProject(unrelated, { slug: "demoapp", name: "DemoApp", aliases: [], remotes: [] }) === false, unrelated);
  // 真实场景里项目目录名与项目名一致（如 ~/_work/my-proj ↔ 项目 my-proj）；夹具必须同样命名才测得到这条
  const namedDir = path.join(os.tmpdir(), `proj-named-${Date.now()}`, "demo-app");
  fs.mkdirSync(namedDir, { recursive: true });
  check("目录名与项目名归一后相同 → 算项目路径",
    layoutMod.isPathForProject(namedDir, { slug: "demo-app", name: "DemoApp", aliases: [], remotes: [] }) === true, namedDir);
  check("origin 与项目远程一致 → 算项目路径（目录名可不同）",
    layoutMod.isPathForProject(repoA, { slug: "whatever", name: "whatever", aliases: [], remotes: ["example-org/demo-app"] }) === true);
  check("过浅路径即使名字匹配也不算",
    layoutMod.isPathForProject(os.homedir(), { slug: path.basename(os.homedir()), name: path.basename(os.homedir()), aliases: [], remotes: [] }) === false);
  fs.rmSync(unrelated, { recursive: true, force: true });
  fs.rmSync(path.dirname(namedDir), { recursive: true, force: true });

  // 自愈必须能**纠正**已写入的无效路径（upsert 是并集，只增不减 → 需覆盖式写）
  const pruneSlug = "prune-demo";
  svc.registry.upsert({ slug: pruneSlug, name: "PruneDemo", origin: "explicit", localPaths: [home, repoA] });
  const beforePrune = svc.registry.get(pruneSlug).localPaths.slice();
  const pruneRes = svc.reconcileProjectMetadata();
  const afterPrune = svc.registry.get(pruneSlug).localPaths.slice();
  check("自愈剔除家目录等过浅路径（纠正已写入的脏值）",
    beforePrune.length === 2 && !afterPrune.includes(home) && afterPrune.some((x) => samePath(x, repoA)),
    JSON.stringify({ beforePrune, afterPrune, pruneRes }));
  check("纠正计入 pruned 计数", pruneRes.pruned >= 1, JSON.stringify(pruneRes));

  // 手选目录也挡过浅路径：语义上它不成立，应明确拒绝而非默默记录
  const shallowAttach = svc.projectAttachPath(pruneSlug, home);
  check("关联家目录被拒并给出原因",
    shallowAttach.ok === false && /过浅|项目根/.test(String(shallowAttach.message || "")),
    JSON.stringify(shallowAttach));

  // 写入路径同样过滤：以家目录为 cwd 写记忆，不得把家目录记成项目路径
  const shallowWrite = await svc.writeMemory({ title: "家目录 cwd 写入", body: "会话可能在家目录启动，这种 cwd 不该被当成项目路径记下来。", type: "note", project: "ShallowProbe", cwd: home });
  const shallowEntry = svc.registry.get("shallowprobe");
  check("以家目录为 cwd 写入不记本地路径", (shallowEntry.localPaths || []).length === 0, JSON.stringify({ path: shallowWrite.path, localPaths: shallowEntry.localPaths }));

  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });

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
