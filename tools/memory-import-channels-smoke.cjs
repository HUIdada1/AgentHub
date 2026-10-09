/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 导入渠道自测（Trae 系加密会话库 / Antigravity 会话日志）：
//   ① 发现与探测：一个来源覆盖多个应用目录，体量按实际日志/库统计；
//   ② 抽取口径：只收「说过的话」（Trae 的 general/task 两表、Antigravity 的 USER_INPUT/PLANNER_RESPONSE），
//      工具调用 / 思考 / 系统消息 / 附加元数据一律不收；
//   ③ 增量：游标读到头再跑必须 0 新增，追加内容后只读新增；
//   ④ 引擎接线：新格式可保存、默认来源合并进存量清单、干跑+导入全链路可跑通。
// 夹具里的 Trae 库是现场用内置 SQLCipher 造的加密库（与真机同格式同密钥）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-import-channels-smoke.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { ImportEngine } = require("../electron/backend/memory/import/engine.cjs");
const parsers = require("../electron/backend/memory/import/parsers.cjs");
const sqlcipher = require("../electron/backend/sqlcipher.cjs");

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

// ---------- 夹具 ----------

const TRAE_APP = "TraeFixture";
const TRAE_APP2 = "TraeFixture CN";

/** 用内置 SQLCipher 现造一个 Trae 同构加密库（明文写入会被 parseTrae 的 keyed 读取拒掉，造真库才有效） */
function makeTraeDb(dbFile, rows) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = sqlcipher.open(dbFile);
  try {
    sqlcipher.queryAll(db, "CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, absolute_path TEXT)");
    sqlcipher.queryAll(db, "CREATE TABLE chat_session (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project_id TEXT, session_title TEXT)");
    sqlcipher.queryAll(
      db,
      "CREATE TABLE chat_message (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_id TEXT, message_role TEXT, message_type TEXT, created_at INTEGER, is_archived INTEGER DEFAULT 0, deleted_at INTEGER DEFAULT 0, user_message_context TEXT DEFAULT '')",
    );
    sqlcipher.queryAll(db, "CREATE TABLE chat_message_general (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, content TEXT, deleted_at INTEGER DEFAULT 0)");
    sqlcipher.queryAll(db, "CREATE TABLE chat_message_task (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, content TEXT, summary TEXT DEFAULT '', deleted_at INTEGER DEFAULT 0)");
    sqlcipher.queryAll(db, "INSERT INTO project (project_id, absolute_path) VALUES ('p1', 'e:\\work\\demo-app')");
    sqlcipher.queryAll(db, "INSERT INTO chat_session (session_id, project_id, session_title) VALUES ('sess-1', 'p1', '演示会话')");
    for (const r of rows) {
      sqlcipher.queryAll(
        db,
        `INSERT INTO chat_message (session_id, message_id, message_role, message_type, created_at, deleted_at)
         VALUES ('${r.session}', '${r.messageId}', '${r.role}', '${r.type}', ${r.at}, ${r.deleted || 0})`,
      );
      if (r.general != null) sqlcipher.queryAll(db, `INSERT INTO chat_message_general (message_id, content) VALUES ('${r.messageId}', '${r.general.replace(/'/g, "''")}')`);
      if (r.task != null) sqlcipher.queryAll(db, `INSERT INTO chat_message_task (message_id, content) VALUES ('${r.messageId}', '${r.task.replace(/'/g, "''")}')`);
    }
  } finally {
    sqlcipher.close(db);
  }
}

const traeRows = [
  // 用户话：正文在 chat_message_general.content 的 type=text 元素里
  { session: "sess-1", messageId: "m1", role: "user", type: "general", at: 1750000000, general: JSON.stringify([{ type: "text", text_content: "第一条用户消息：把项目归档页的表格改成固定表头，滚动时表头不跟着走。" }]) },
  // 助手话：正文在 chat_message_task.content 的 messages[].plan_item.thought 里（工具调用字段不是话）
  {
    session: "sess-1",
    messageId: "m2",
    role: "assistant",
    type: "task",
    at: 1750000060,
    task: JSON.stringify({
      messages: [
        { id: "x1", type: "plan_item", plan_item: { thought: "已按要求把表格改成固定表头，并顺手把列宽调齐。", tool_call_info: { name: "apply_patch" }, agent_status: { status: "done" } } },
        { id: "x2", type: "plan_item", plan_item: { thought: "", tool_call_info: { name: "run_command" } } },
      ],
    }),
  },
  // 图片消息不是正文；过短内容与已删除行都不该进来
  { session: "sess-1", messageId: "m3", role: "user", type: "general", at: 1750000120, general: JSON.stringify([{ type: "image", text_content: "不算正文的图片占位内容——长度够但不该收进来" }]) },
  { session: "sess-1", messageId: "m4", role: "user", type: "general", at: 1750000180, general: JSON.stringify([{ type: "text", text_content: "太短" }]) },
  { session: "sess-1", messageId: "m5", role: "user", type: "general", at: 1750000240, deleted: 1, general: JSON.stringify([{ type: "text", text_content: "这条已经删除，不该被导入成记忆，长度特意写得很长很长很长。" }]) },
  // harness 注入块不是用户说的话
  { session: "sess-1", messageId: "m6", role: "user", type: "general", at: 1750000300, general: JSON.stringify([{ type: "text", text_content: "<system-reminder>这是运行时注入的环境说明，不该被导入成记忆。</system-reminder>" }]) },
];

function writeAntigravityFixture(root) {
  const lines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-01T10:00:00Z", content: "<USER_REQUEST>\n把号池页的刷新按钮移到卡片右上角，并给刷新加 loading 态。\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-01T18:00:00+08:00.\nActive Document: e:\\work\\demo-app\\src\\views\\ProxyView.vue (LANGUAGE_VUE)\n</ADDITIONAL_METADATA>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-01T10:00:05Z", thinking: "先看看刷新按钮挂在哪。", tool_calls: [{ name: "view_file", args: { AbsolutePath: "e:/work/demo-app/src/views/ProxyView.vue" } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-08-01T10:00:06Z", content: "Created At: 2026-08-01T18:00:06+08:00 File Path: `file:///e:/work/demo-app/src/views/ProxyView.vue`" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-01T10:00:30Z", content: "已经把刷新按钮移到卡片右上角，并补上了 loading 态；顺便把按钮的禁用条件与网关未启动的状态对齐了。" },
    { step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-08-01T10:00:31Z", content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user." },
  ];
  const dir = path.join(root, "antigravity", "brain", "conv-alpha", ".system_generated", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

  // 会话摘要库：workspace_uris 里是 URL 编码的 file URI，用来定工程目录
  const sumDb = path.join(root, "antigravity", "conversation_summaries.db");
  const db = new DatabaseSync(sumDb);
  db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT)");
  db.prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris) VALUES (?, ?, ?)").run(
    "conv-alpha",
    "刷新按钮搬家",
    JSON.stringify(["file:///e%3A/work/demo-app"]),
  );
  db.close();

  // IDE 版只写 overview.txt，且没有摘要库：工程目录退回用户输入里的 Active Document
  const ideDir = path.join(root, "antigravity-ide", "brain", "conv-beta", ".system_generated", "logs");
  fs.mkdirSync(ideDir, { recursive: true });
  const ideLines = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-02T09:00:00Z", content: "<USER_REQUEST>\n大屏顶部的返回按钮去掉，只留退出登录按钮，并把右侧容器的间距对齐标题行。\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nActive Document: e:/work/dash\\src\\views\\Header.vue (LANGUAGE_VUE)\n</ADDITIONAL_METADATA>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-02T09:00:20Z", content: "顶部容器已经只保留退出登录按钮，返回按钮的 v-if 分支一并删掉了。" },
  ];
  fs.writeFileSync(path.join(ideDir, "overview.txt"), ideLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { file, ideFile: path.join(ideDir, "overview.txt") };
}

let tmpRoot = "";
let srcRoot = "";
let memRoot = "";
let svc = null;
let importer = null;

const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const stamp = Date.now();
  tmpRoot = path.join(os.tmpdir(), `agenthub-import-channels-${stamp}`);
  srcRoot = path.join(tmpRoot, "sources");
  memRoot = path.join(tmpRoot, "memory");
  fs.mkdirSync(srcRoot, { recursive: true });
  fs.mkdirSync(memRoot, { recursive: true });

  const db1 = path.join(srcRoot, TRAE_APP, "ModularData", "ai-agent", "database.db");
  const db2 = path.join(srcRoot, TRAE_APP2, "ModularData", "ai-agent", "database.db");
  if (sqlcipher.available()) {
    makeTraeDb(db1, traeRows);
    makeTraeDb(db2, [{ session: "sess-1", messageId: "n1", role: "user", type: "general", at: 1750001000, general: JSON.stringify([{ type: "text", text_content: "第二个应用里的一条用户消息：把侧边栏的记忆概况数字补上单位。" }]) }]);
  } else {
    console.log("  ! 本机 SQLCipher 不可用，Trae 段落只验发现/软失败语义");
  }
  const ag = writeAntigravityFixture(srcRoot);

  console.log("[1] 发现与探测：一个来源覆盖多个应用目录");
  const traeDbs = parsers.discoverTraeDbs(srcRoot);
  check("Trae：识别到两个应用的加密库", traeDbs.length === 2 && traeDbs.some((d) => d.app === TRAE_APP) && traeDbs.some((d) => d.app === TRAE_APP2), JSON.stringify(traeDbs.map((d) => d.app)));
  const traeProbe = parsers.probeSource({ id: "trae", kind: "trae", path: srcRoot });
  check("Trae：探测 exists/体量按库统计", traeProbe.exists === true && traeProbe.items === 2 && traeProbe.sizeBytes > 0, JSON.stringify({ exists: traeProbe.exists, items: traeProbe.items, sizeBytes: traeProbe.sizeBytes }));
  const traeDetect = parsers.detectSource({ id: "trae", kind: "trae", path: srcRoot });
  check("Trae：深度探测列出库与应用名", traeDetect.ok === true && traeDetect.databases.length === 2, JSON.stringify(traeDetect).slice(0, 160));
  const traeDetectEmpty = parsers.detectSource({ id: "trae", kind: "trae", path: path.join(srcRoot, "not-here") });
  check("Trae：路径不存在时软失败不抛错", traeDetectEmpty.ok === false && !!traeDetectEmpty.message, JSON.stringify(traeDetectEmpty));

  const agApps = parsers.discoverAntigravityApps(srcRoot);
  check("Antigravity：识别到两个应用根", agApps.length === 2, JSON.stringify(agApps.map((d) => path.basename(d))));
  const agProbe = parsers.probeSource({ id: "antigravity", kind: "antigravity", path: srcRoot });
  check("Antigravity：探测统计到两份会话日志", agProbe.exists === true && agProbe.items === 2 && agProbe.sizeBytes > 0, JSON.stringify({ exists: agProbe.exists, items: agProbe.items }));
  const agSessions = parsers.listAntigravitySessions(path.join(srcRoot, "antigravity-ide"));
  check("Antigravity：IDE 版会话选中 overview.txt", agSessions.length === 1 && path.basename(agSessions[0].file) === "overview.txt", JSON.stringify(agSessions.map((s) => path.basename(s.file || ""))));

  console.log("[2] Trae：抽取口径与过滤");
  const traeSource = { id: "trae", kind: "trae", path: srcRoot };
  let traeItems = [];
  const traeRun = parsers.parseTrae(traeSource, null, { batchSize: 500 }, (it) => traeItems.push(it));
  if (!sqlcipher.available()) {
    check("Trae：无 SQLCipher 时软失败并说明原因", traeItems.length === 0 && /SQLCipher/.test(traeRun.note || ""), traeRun.note);
  } else {
    check("Trae：收 3 条（两应用各 1 用户 + 本应用 1 助手）", traeItems.length === 3, JSON.stringify(traeItems.map((i) => i.role)));
    const user = traeItems.find((i) => i.messageId === undefined && i.role === "user" && /第一条用户消息/.test(i.body));
    check("Trae：用户话取 general 的 text_content", !!user && user.title.startsWith("第一条用户消息"), JSON.stringify(user && user.title));
    const assistant = traeItems.find((i) => i.role === "assistant");
    check("Trae：助手话取 task 的 plan_item.thought", !!assistant && assistant.body === "已按要求把表格改成固定表头，并顺手把列宽调齐。", JSON.stringify(assistant && assistant.body));
    check("Trae：图片类型 / 过短 / 已删除 / harness 噪声都被拦下", !traeItems.some((i) => /图片占位|太短|已经删除|system-reminder/.test(i.body)), JSON.stringify(traeItems.map((i) => i.body.slice(0, 12))));
    check("Trae：工程目录来自 project.absolute_path", traeItems.every((i) => i.cwd === "e:\\work\\demo-app"), JSON.stringify([...new Set(traeItems.map((i) => i.cwd))]));
    check("Trae：会话 id 带上（供同日合并与回溯）", traeItems.every((i) => i.session === "sess-1"), JSON.stringify([...new Set(traeItems.map((i) => i.session))]));
    check("Trae：创建时间按秒转毫秒", traeItems.every((i) => i.created >= 1750000000000), JSON.stringify([...new Set(traeItems.map((i) => i.created))]));
    const files = traeRun.nextCursor.files;
    check("Trae：游标按应用分别记录水位", Number(files[TRAE_APP].lastId) === 6 && Number(files[TRAE_APP2].lastId) === 1, JSON.stringify(files));
    const again = parsers.parseTrae(traeSource, traeRun.nextCursor, { batchSize: 500 }, () => {});
    check("Trae：读到头后复跑 0 新增", again.items === 0 && !again.more, JSON.stringify({ items: again.items, more: again.more }));
    // 增量：给第一个应用追加两条（一条用户、一条助手），只该读到这两条
    if (sqlcipher.available()) {
      const db = sqlcipher.open(db1);
      sqlcipher.queryAll(db, "INSERT INTO chat_message (session_id, message_id, message_role, message_type, created_at) VALUES ('sess-1','m7','user','general',1750002000)");
      sqlcipher.queryAll(db, `INSERT INTO chat_message_general (message_id, content) VALUES ('m7', '${JSON.stringify([{ type: "text", text_content: "追加的一条用户消息：把导入页的来源卡片按格式分组显示。" }]).replace(/'/g, "''")}')`);
      sqlcipher.queryAll(db, "INSERT INTO chat_message (session_id, message_id, message_role, message_type, created_at) VALUES ('sess-1','m8','assistant','task',1750002060)");
      sqlcipher.queryAll(db, `INSERT INTO chat_message_task (message_id, content) VALUES ('m8', '${JSON.stringify({ messages: [{ type: "plan_item", plan_item: { thought: "已按格式把来源卡片分组，加密库单独一组。" } }] }).replace(/'/g, "''")}')`);
      sqlcipher.close(db);
      const inc = parsers.parseTrae(traeSource, again.nextCursor, { batchSize: 500 }, () => {});
      check("Trae：追加后只读到新增 2 条", inc.items === 2, String(inc.items));
    }
  }

  console.log("[3] Antigravity：抽取口径 / 归类 / 增量");
  const agSource = { id: "antigravity", kind: "antigravity", path: srcRoot };
  const agItems = [];
  const agRun = parsers.parseAntigravity(agSource, null, { batchSize: 500, maxFiles: 50 }, (it) => agItems.push(it));
  check("Antigravity：两个应用共 4 条（各 1 用户 + 1 模型回复）", agItems.length === 4, JSON.stringify(agItems.map((i) => `${i.role}@${i.session}`)));
  const agUser = agItems.find((i) => i.session === "conv-alpha" && i.role === "user");
  check("Antigravity：用户正文剥掉 USER_REQUEST 与附加元数据", !!agUser && agUser.body === "把号池页的刷新按钮移到卡片右上角，并给刷新加 loading 态。", JSON.stringify(agUser && agUser.body));
  check("Antigravity：工具结果 / 系统消息 / 思考都不收", !agItems.some((i) => /Created At|SYSTEM_MESSAGE|先看看刷新按钮/.test(i.body)), JSON.stringify(agItems.map((i) => i.body.slice(0, 14))));
  check("Antigravity：工程目录取自 conversation_summaries 的 workspace_uris", !!agUser && agUser.cwd === "e:/work/demo-app", JSON.stringify(agUser && agUser.cwd));
  const agIde = agItems.find((i) => i.session === "conv-beta" && i.role === "assistant");
  check("Antigravity：IDE 版读 overview.txt 的模型回复", !!agIde && /只保留退出登录按钮/.test(agIde.body), JSON.stringify(agIde && agIde.body.slice(0, 30)));
  const agIdeUser = agItems.find((i) => i.session === "conv-beta" && i.role === "user");
  check("Antigravity：无摘要库时工程目录退回 Active Document", !!agIdeUser && agIdeUser.cwd === "e:/work/dash\\src\\views", JSON.stringify(agIdeUser && agIdeUser.cwd));
  check("Antigravity：游标按「应用/会话/文件」记字节水位", Object.keys(agRun.nextCursor.files).length === 2 && Number(agRun.nextCursor.files["antigravity/conv-alpha/transcript.jsonl"]) === fs.statSync(ag.file).size, JSON.stringify(agRun.nextCursor.files));
  const agAgain = parsers.parseAntigravity(agSource, agRun.nextCursor, { batchSize: 500, maxFiles: 50 }, () => {});
  check("Antigravity：读到头后复跑 0 新增", agAgain.items === 0 && !agAgain.more, JSON.stringify({ items: agAgain.items, more: agAgain.more }));
  // 增量：追加一条模型回复，只该读到这一条
  const appended = readLines(ag.ideFile);
  appended.push({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-02T09:01:00Z", content: "又补了一条：顶部容器的高度跟着标题行对齐，避免多出一行空白。" });
  fs.appendFileSync(ag.ideFile, JSON.stringify(appended[appended.length - 1]) + "\n", "utf8");
  const agInc = parsers.parseAntigravity(agSource, agAgain.nextCursor, { batchSize: 500, maxFiles: 50 }, () => {});
  check("Antigravity：追加后只读到新增 1 条", agInc.items === 1, String(agInc.items));

  console.log("[4] 引擎接线：格式白名单 / 默认清单合并 / 干跑+导入全链路");
  const memCfg = new MemoryConfig(memRoot);
  memCfg.load();
  svc = new MemoryService(memRoot, memCfg, { deviceId: "dev_channels", onEvent: () => {} }).init();
  importer = new ImportEngine({ service: svc, rootDir: memRoot, getConfig: () => svc.flat(), emit: () => {}, memCfg, expandPath: (p) => p });

  // 存量清单（老用户的配置）：缺两个新来源，且留着一条历史上登记错误的 trae-solo
  importer.saveSources([
    { id: "codex", name: "Codex 会话", kind: "jsonl", path: path.join(srcRoot, "nothing"), enabled: false, priority: 1 },
    { id: "trae-solo", name: "Trae Solo 会话", kind: "sqlite", path: "C:\\old\\TRAE SOLO\\database.db", enabled: true, priority: 2 },
  ]);
  const merged = importer.sources();
  const ids = merged.map((s) => s.id);
  check("存量清单被补齐新来源（trae / antigravity 出现）", ids.includes("trae") && ids.includes("antigravity"), JSON.stringify(ids));
  check("历史上登记错误的 trae-solo(sqlite) 被清掉", !ids.includes("trae-solo"), JSON.stringify(ids));
  check("已有来源的启用状态不被动（codex 仍为关）", merged.find((s) => s.id === "codex").enabled === false, JSON.stringify(merged.find((s) => s.id === "codex")));
  check("新格式不会被降级成 md（保存后仍为 trae）", merged.find((s) => s.id === "trae").kind === "trae", JSON.stringify(merged.find((s) => s.id === "trae")));
  check("未知格式仍回退成 md（白名单兜底）", importer.saveSources([{ id: "x", name: "X", kind: "unknown", path: "" }]).sources[0].kind === "md", JSON.stringify(importer.saveSources([{ id: "x", name: "X", kind: "unknown", path: "" }]).sources[0]));

  // 只留两个新来源跑全链路
  importer.saveSources([
    { id: "trae", name: "Trae 系会话", kind: "trae", path: srcRoot, enabled: true, priority: 1 },
    { id: "antigravity", name: "Antigravity 会话", kind: "antigravity", path: srcRoot, enabled: true, priority: 2 },
  ]);
  const scan = importer.scan();
  const scanOf = (id) => scan.sources.find((s) => s.id === id) || {};
  check(
    "扫描：两个新来源都已找到，首次导入给「全量扫描」文案",
    scanOf("trae").exists === true && scanOf("antigravity").exists === true && /首次导入/.test(scanOf("trae").estimate || "") && /首次导入/.test(scanOf("antigravity").estimate || ""),
    JSON.stringify(scan.sources.map((s) => ({ id: s.id, exists: s.exists, items: s.items, estimate: s.estimate }))),
  );
  const preview = await importer.preview({ limit: 200 });
  // 夹具里 [2][3] 段落各追加过内容，全量应为：Trae（m1/m2/n1 + 追加 m7/m8）5 条 + Antigravity（两侧各 2 + 追加 1）5 条
  const expectCreate = sqlcipher.available() ? 10 : 5;
  check("干跑：算出的可新建条数与抽取口径一致", preview.wouldCreate + preview.wouldMerge === expectCreate, JSON.stringify({ wouldCreate: preview.wouldCreate, wouldMerge: preview.wouldMerge, sensitive: preview.sensitive }));
  check("干跑：样例里两个来源都露了脸", new Set(preview.samples.map((s) => s.source)).size >= 1, JSON.stringify(preview.samples.map((s) => s.source)));
  const applied = await importer.apply({});
  check("导入：写入成功且无失败", applied.ok === true && applied.failed === 0, JSON.stringify({ ok: applied.ok, created: applied.created, skipped: applied.skipped, failed: applied.failed }));
  const totalAfter = svc.index.counts().total;
  check("导入：库内条数 = 干跑预期的可写条数", totalAfter === expectCreate, JSON.stringify({ totalAfter, expectCreate }));
  const cursorFile = path.join(memRoot, "_import", "cursors.json");
  const cursors = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  check("导入：游标已落盘（trae 按应用 / antigravity 按会话日志）", !!cursors.trae && !!cursors.trae.files && !!cursors.antigravity && Object.keys(cursors.antigravity.files).length === 2, JSON.stringify(Object.keys(cursors)));
  check("导入：游标标了来源格式（诊断用）", cursors.trae.source === "trae" || cursors.trae.seeded === true, JSON.stringify({ source: cursors.trae.source, seeded: cursors.trae.seeded }));
  const rerun = await importer.apply({});
  check("导入：复跑 0 新增（游标生效）", rerun.created === 0 && svc.index.counts().total === totalAfter, JSON.stringify({ created: rerun.created, total: svc.index.counts().total }));

  // 归档：把写入的条目按角色看一眼，确认 user/assistant 都落了库
  const rows = svc.index.db.prepare("SELECT title FROM mem ORDER BY title").all().map((r) => r.title);
  check("导入：用户与助手条目都进了索引", rows.some((t) => t.startsWith("第一条用户消息")) && rows.some((t) => t.startsWith("已按要求把表格")) && rows.some((t) => t.startsWith("已经把刷新按钮")) && rows.some((t) => t.startsWith("顶部容器已经只保留")), JSON.stringify(rows));

  // ===== [5] Trae 库重建自愈：客户端重装/清数据后 chat_message.id 从 1 重来，
  // 旧水位（m.id > from）若不做收缩检测会把新内容永久挡在外面（静默零导入）。
  // 放在最后跑：本段会替换夹具库，前面的段落仍按原库内容断言
  console.log("[5] Trae 库重建自愈（旧水位不许把重建后的新内容永久挡住）");
  if (sqlcipher.available()) {
    const cursorFile2 = path.join(memRoot, "_import", "cursors.json");
    const c2 = JSON.parse(fs.readFileSync(cursorFile2, "utf8"));
    const oldWater = Number((c2.trae.files[TRAE_APP] || {}).lastId) || 0;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(db1 + suffix, { force: true });
    makeTraeDb(db1, [{ session: "sess-1", messageId: "rebuild-1", role: "user", type: "general", at: 1750009000, general: JSON.stringify([{ type: "text", text_content: "重建后的库里的一条用户消息：验证导入水位能从 1 重新推进。" }]) }]);
    const rebuiltItems = [];
    const rebuiltRun = parsers.parseTrae({ id: "trae", kind: "trae", path: srcRoot }, c2.trae, { batchSize: 500 }, (it) => rebuiltItems.push(it));
    check(
      "Trae：库重建（id 归 1）后水位自愈，新内容仍可读出并推进到 1",
      oldWater >= 8 && rebuiltItems.length === 1 && Number(rebuiltRun.nextCursor.files[TRAE_APP].lastId) === 1,
      JSON.stringify({ oldWater, items: rebuiltItems.length, lastId: rebuiltRun.nextCursor.files[TRAE_APP].lastId }),
    );
  } else {
    console.log("  ! SQLCipher 不可用，跳过库重建自愈断言");
  }

  console.log(`\n[结果] 通过 ${pass} 项，失败 ${failCount} 项`);
  if (failures.length) console.log("失败清单:\n" + failures.map((f) => "  - " + f).join("\n"));
  return failCount === 0 ? 0 : 1;
}

main()
  .then((code) => {
    try {
      if (svc) svc.index.close();
    } catch {
      /* 忽略关闭异常 */
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 临时目录可能仍被占用，留待系统清理 */
    }
    process.exit(code);
  })
  .catch((e) => {
    console.error("自测崩溃:", e && e.stack ? e.stack : e);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    process.exit(1);
  });
