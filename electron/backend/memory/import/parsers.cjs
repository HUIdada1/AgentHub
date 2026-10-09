/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 导入来源探测与解析器：5 类来源、5 类解析器
// （SQLite / JSONL / Markdown / Trae 系加密会话库 / Antigravity 会话日志）。
// 增量靠游标（cursors.json）：SQLite 与 Trae 系用行 id 水位，文件用字节水位，MD 用 mtime + hash。
// 解析器一律「先探测体量再读」——大库不整表读进内存。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

const { parseFrontmatter } = require("../store.cjs");
const { reverseClaudeDirName, reverseSessionDirName } = require("../layout.cjs");
const { rmTempDir, sweepStale, openReadOnly } = require("../../temp-util.cjs");

const FIELD_ALIASES = {
  role: ["role", "type", "speaker", "author"],
  content: ["content", "text", "message", "body"],
  time: ["timestamp", "created_at", "time", "ts", "createdAt"],
  session: ["sessionId", "session_id", "conversationId", "uuid", "conversation_id"],
  tool: ["tool_calls", "toolCalls", "function_call"],
};

const NOTE_MARKER = /^[-*]\s+\[([a-zA-Z]+)\]\s+(.+)$/;
const INLINE_TAG = /#([\u4e00-\u9fa5A-Za-z0-9_-]+)/g;
const WIKILINK = /\[\[([^\]]+)\]\]/g;

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((acc, seg) => (acc && typeof acc === "object" ? acc[seg] : undefined), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function flattenContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : part && typeof part === "object" ? part.text || "" : ""))
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") return value.text || "";
  return "";
}

// 会话库里混着 harness 注入的块（<system-reminder> 装环境/身份说明、<environment_context> 装工作目录）：
// 那是运行时元信息而不是用户或助手说过的话，导入成记忆只会污染检索。
// 判据只认「整条以该标签开头」——正文里夹带的照收（那通常是有上下文的真实内容）
function isHarnessNoise(text) {
  return /^<(system-reminder|environment_context)[\s>]/.test(String(text == null ? "" : text).trim());
}

/**
 * 事件流会话文件（Codex rollout / 部分 ZCode 日志）外层是 {timestamp,type,payload} 信封，
 * 说话的那条在 payload 里。payload 里没有 role+content 的都是事件（工具调用、心跳、用量记录），
 * 一律按非消息处理——否则整份文件会因为读不到 content 而一条都导不出来。
 */
function unwrapEnvelope(obj) {
  const p = obj && obj.payload;
  if (p && typeof p === "object" && p.role && p.content !== undefined) return p;
  return obj;
}

// ---------- 探测 ----------

function probeSource(source) {
  const p = source.path;
  const out = { ...source, exists: false, sizeBytes: 0, items: 0, format: source.kind, note: "" };
  if (!p) return { ...out, note: "未配置路径" };
  // Trae 系与 Antigravity 是「一个来源覆盖多个应用目录」的复合来源：体量不能按单一路径 stat，
  // 各自走发现函数（下面的 statSync 对大目录会白扫一遍）
  if (source.kind === "trae") return probeTrae(source);
  if (source.kind === "antigravity") return probeAntigravity(source);
  try {
    const st = fs.statSync(p);
    out.exists = true;
    if (st.isDirectory()) {
      const files = walk(p, source.ext ? [source.ext] : [".jsonl", ".md", ".json"]).slice(0, 5000);
      out.files = files.length;
      out.sizeBytes = files.reduce((s, f) => {
        try { return s + fs.statSync(f).size; } catch { return s; }
      }, 0);
      out.items = files.length;
    } else {
      out.sizeBytes = st.size;
      out.items = 1;
    }
  } catch {
    out.exists = false;
  }
  return out;
}

function walk(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(full);
    }
  }
  return out.sort();
}

/** 深度探测：SQLite 表结构 / JSONL 行数与时间范围 / MD 文件数 */
function detectSource(source) {
  const p = source.path;
  if (!p || !fs.existsSync(p)) return { ok: false, message: "路径不存在" };
  if (source.kind === "trae") return detectTrae(p);
  if (source.kind === "antigravity") return detectAntigravity(p);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const files = walk(p, [".jsonl", ".md", ".json"]);
    return { ok: true, kind: "dir", files: files.length, sample: files.slice(0, 5).map((f) => path.relative(p, f)) };
  }
  const ext = path.extname(p).toLowerCase();
  if (ext === ".sqlite" || ext === ".db") return detectSqlite(p);
  if (ext === ".jsonl") return detectJsonl(p);
  return { ok: true, kind: ext.replace(".", ""), files: 1 };
}

function detectSqlite(file) {
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const info = [];
    for (const t of tables) {
      let cols = [];
      try {
        cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      } catch {
        continue;
      }
      let count = 0;
      try {
        count = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      } catch {
        count = 0;
      }
      info.push({ table: t, columns: cols, count, matched: matchMessageTable(cols) });
    }
    info.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0) || b.count - a.count);
    return { ok: true, kind: "sqlite", tables: info, suggested: info.find((x) => x.matched) || info[0] || null };
  } catch (e) {
    return { ok: false, message: `打开 SQLite 失败：${e.message}` };
  } finally {
    try { if (db) db.close(); } catch { /* 已关闭 */ }
  }
}

// 列名签名打分：含 role+content → 消息表；含 title/session → 会话表
function matchMessageTable(columns) {
  const lower = columns.map((c) => String(c).toLowerCase());
  const has = (k) => lower.some((c) => c.includes(k));
  const score = (has("role") ? 2 : 0) + (has("content") || has("text") || has("message") ? 2 : 0) + (has("session") ? 1 : 0) + (has("time") || has("created") ? 1 : 0);
  return score >= 4;
}

function detectJsonl(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    fd = null;
    const head = buf.toString("utf8").split("\n").slice(0, 5).filter(Boolean);
    const sample = head.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return { ok: true, kind: "jsonl", sizeBytes: size, sampleKeys: sample.length ? Object.keys(sample[0]) : [], sample };
  } catch (e) {
    return { ok: false, message: `读取失败：${e.message}` };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
  }
}

// 在真实列名里按别名候选挑一列（列名不区分大小写）
function matchColumn(columns, semantic) {
  const lower = columns.map((c) => String(c).toLowerCase());
  for (const alias of FIELD_ALIASES[semantic] || [semantic]) {
    const idx = lower.indexOf(String(alias).toLowerCase());
    if (idx >= 0) return columns[idx];
  }
  const partial = lower.findIndex((c) => c.includes(String(semantic).toLowerCase()));
  return partial >= 0 ? columns[partial] : null;
}

// ---------- SQLite 解析器 ----------

function parseSqlite(source, cursor, opts, onItem) {
  let db = null;
  try {
    db = new DatabaseSync(source.path, { readOnly: true });
  } catch (e) {
    return { items: 0, nextCursor: cursor, note: `打开库失败（可能被占用或 WAL 待恢复）：${e.message}` };
  }
  try {
    return parseSqliteInner(db, source, cursor, opts, onItem);
  } finally {
    try { db.close(); } catch { /* 关闭失败无碍下一轮 */ }
  }
}

// 表名/列名来自用户可写的 import.sources 配置，最终拼进 SQL——只认安全标识符
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseSqliteInner(db, source, cursor, opts, onItem) {
  // 表名优先取游标里记下的：多轮解析/多次导入会反复进来，每次都 detectSqlite 要遍历所有表
  // 跑 COUNT(*)，对十万行级的库是纯浪费
  const table = source.table || (cursor && cursor.table) || (detectSqlite(source.path).suggested || {}).table;
  if (!table) return { items: 0, total: 0, nextCursor: cursor, note: "未识别到消息表" };
  if (!SAFE_IDENT.test(table)) return { items: 0, total: 0, nextCursor: cursor, note: "表名含非法字符，已拒绝" };
  let columnDefs = [];
  try {
    columnDefs = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch (e) {
    return { items: 0, total: 0, nextCursor: cursor, note: `读取表结构失败：${e.message}` };
  }
  const columns = columnDefs.map((c) => c.name);
  // WITHOUT ROWID 表没有 rowid 可用；没有数值主键的表（如 TEXT uuid）不能拿它当水位
  const withoutRowid = (() => {
    try {
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table);
      return !!(ddl && ddl.sql && /WITHOUT\s+ROWID/i.test(ddl.sql));
    } catch {
      return false;
    }
  })();
  // 水位列必须真的单调：优先 PRAGMA 声明的 INTEGER PRIMARY KEY（rowid 别名），
  // 其次才是名字恰好叫 id/_id 的整型列；/id$/i 会误中 session_id 这类非单调外键
  const declaredIntPk = columnDefs.find((c) => Number(c.pk) > 0 && /INT/i.test(String(c.type || "")));
  const namedIntId = columnDefs.find((c) => /^(id|_id)$/i.test(c.name) && /INT/i.test(String(c.type || "")));
  const numericPk = declaredIntPk || namedIntId;
  // 文本主键：只认「单列主键且非整型」。多列主键单取一列做水位会在页边界漏行，宁可不分页
  const pkCols = columnDefs.filter((c) => Number(c.pk) > 0);
  const textPk = pkCols.length === 1 && !/INT/i.test(String(pkCols[0].type || "")) ? pkCols[0] : null;
  const numericKey = numericPk && SAFE_IDENT.test(numericPk.name) ? numericPk.name : null;
  const textKey = textPk && SAFE_IDENT.test(textPk.name) ? textPk.name : null;
  // 水位列优先级：数值主键 > rowid（可推进）> WITHOUT ROWID 下的文本主键（按主键序分页）
  // > 无任何可用键（只能全扫首批，靠内容哈希去重）
  const idCol = numericKey || (withoutRowid ? textKey : "rowid");
  const isTextKey = !!(withoutRowid && textKey && idCol === textKey);
  const roleCol = matchColumn(columns, "role");
  const contentCol = matchColumn(columns, "content");
  const timeCol = matchColumn(columns, "time");
  const sessionCol = matchColumn(columns, "session");
  const cwdCol = matchColumn(columns, "cwd");
  // ZCode 会话库：正文在 part.data 的 JSON 里、role 在 message.data 里，常规列提取必然颗粒无收
  // （表识别会选中 part 表，因为它有 message_id，但那张表只有 data 列）。按结构特征改走专用路径
  if (!contentCol && looksLikeZcodeDb(db, columns)) {
    return parseZcodeParts(db, source, cursor, opts, onItem);
  }
  const limit = Math.min(Number(opts.batchSize || 500), 2000);
  // 文本主键的水位是字符串：必须原样回传、原样绑定，不能经 Number 转换，
  // 否则比较永远不会成立，分页在第二轮就卡死
  const rawLast = cursor && cursor.lastId;
  const lastId = isTextKey ? String(rawLast == null ? "" : rawLast) : Number(rawLast) || 0;
  let rows = [];
  let total = 0;
  const fullScan = !idCol; // 真的没有任何可用键：只读首批（靠内容哈希幂等）
  // 只在真的用 rowid 当水位时才 SELECT rowid（WITHOUT ROWID 或数值主键表都没有这一列）
  const selectCols = idCol === "rowid" ? "rowid AS __rowid, *" : "*";
  try {
    rows = fullScan
      ? db.prepare(`SELECT ${selectCols} FROM ${table} LIMIT ?`).all(limit)
      : db.prepare(`SELECT ${selectCols} FROM ${table} WHERE ${idCol} > ? ORDER BY ${idCol} ASC LIMIT ?`).all(lastId, limit);
    total = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch (e) {
    return { items: 0, total: 0, nextCursor: cursor, note: `查询失败：${e.message}` };
  }
  let emitted = 0;
  let maxId = lastId;
  for (const row of rows) {
    const cursorValue = fullScan ? 0 : idCol === "rowid" ? row.__rowid : row[idCol];
    // 文本主键已按 SQLite 的 BINARY 序排好，直接取当前行的键即可；
    // 不在 JS 侧比大小，避免 JS 的 UTF-16 序与 SQLite 的字节序口径不一致
    if (isTextKey) maxId = cursorValue == null ? maxId : String(cursorValue);
    else maxId = Math.max(maxId, Number(cursorValue) || maxId);
    const content = flattenContent(row[contentCol]);
    if (!content || content.length < 20) continue;
    const role = String(row[roleCol] || "unknown");
    if (role === "system" || role === "tool" || role === "developer") continue;
    if (isHarnessNoise(content)) continue;
    onItem({
      source: source.id,
      title: content.split("\n")[0].slice(0, 80),
      body: content,
      role,
      session: sessionCol ? row[sessionCol] : "",
      created: parseTime(row[timeCol]),
      cwd: cwdCol ? row[cwdCol] || "" : "",
      origin: `sqlite:${table}#${fullScan ? emitted : row[idCol]}`,
    });
    emitted++;
  }
  return {
    items: emitted,
    table,
    total,
    // 本轮用满配额说明后面还有数据，多轮解析要接着读；
    // fullScan（无可用键）不能续读——游标推不动，重读同一批会死循环，靠内容哈希兜底去重
    more: !fullScan && rows.length >= limit,
    note: fullScan ? "该表无可用的主键/rowid（全扫 + 内容哈希去重，重复运行不会重复写入）" : "",
    nextCursor: { ...(cursor || {}), lastId: maxId, table, cursorColumn: idCol || "(full-scan)" },
  };
}

// ZCode 会话库的结构特征：主表只有 data(JSON) + 若干 *_id 外键，硬编码存在 message 表
function looksLikeZcodeDb(db, columns) {
  const lower = columns.map((c) => String(c).toLowerCase());
  if (!lower.includes("data")) return false;
  if (!lower.some((c) => c.endsWith("_id"))) return false;
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'").get();
  } catch {
    return false;
  }
}

/**
 * ZCode 会话库（part + message 两表）：一条 part 的正文是 part.data 里的一段 JSON，
 * 只有 type=text 才是"说过的话"（tool / reasoning / step-start 都不是）；
 * role 与工作目录在 message.data 里，两份 data 靠 part.message_id 关联。
 * 这是 ZCode 唯一能还原成对话的一手数据（transcript 只有流式增量，拼不出干净消息）。
 * 水位用 part.rowid —— 该表是普通行存表，rowid 单调可用。
 */
function parseZcodeParts(db, source, cursor, opts, onItem) {
  const lastId = Number(cursor && cursor.lastId) || 0;
  const limit = Math.min(Number(opts.batchSize || 500), 2000);
  let rows = [];
  try {
    // SQL 层先把非正文的行滤掉：part 表十万行里只有一万多条是 text，其余是工具调用/推理/步骤标记。
    // 全量拉回来再逐行 JSON.parse 要多花几十秒，而 LIKE 只是一次字符串扫描；JS 侧仍按 type 精确校验
    rows = db.prepare(
      `SELECT p.rowid AS __rowid, p.session_id AS __session, p.time_created AS __ts, p.data AS __pdata, m.data AS __mdata
         FROM part p LEFT JOIN message m ON m.id = p.message_id
        WHERE p.rowid > ? AND p.data LIKE '%"type":"text"%' ORDER BY p.rowid ASC LIMIT ?`,
    ).all(lastId, limit);
  } catch (e) {
    return { items: 0, nextCursor: cursor, note: `查询 part 失败：${e.message}` };
  }
  let emitted = 0;
  let maxId = lastId;
  for (const row of rows) {
    maxId = Math.max(maxId, Number(row.__rowid) || maxId);
    let part = null;
    try { part = JSON.parse(row.__pdata); } catch { continue; }
    if (!part || part.type !== "text") continue;
    const content = String(part.text || "").trim();
    if (!content || content.length < 20) continue;
    if (isHarnessNoise(content)) continue;
    let msg = null;
    try { msg = JSON.parse(row.__mdata); } catch { /* 关联不到 message：role 留空 */ }
    const role = String((msg && msg.role) || "unknown");
    if (role === "system" || role === "tool" || role === "developer") continue;
    const envInfo = msg && msg.contextSnapshot && msg.contextSnapshot.envInfo;
    onItem({
      source: source.id,
      title: content.split("\n")[0].slice(0, 80),
      body: content,
      role,
      session: row.__session || "",
      created: Number(row.__ts) || 0,
      cwd: (envInfo && envInfo.cwd) || "",
      origin: `zcode:part#${row.__rowid}`,
    });
    emitted++;
  }
  return {
    items: emitted,
    more: rows.length >= limit,
    nextCursor: { ...(cursor || {}), lastId: maxId, table: "part", cursorColumn: "rowid", source: "zcode" },
    note: "",
  };
}

// ---------- Trae 系解析器（SQLCipher 加密会话库，Trae / Trae CN / TRAE SOLO / SOLO CN 四应用同构） ----------
//
// 数据源：%APPDATA%\<应用>\ModularData\ai-agent\database.db，整库加密（解密通道见 backend/sqlcipher.cjs）。
// 一条消息的正文与角色分在两张表、靠 message_id 关联 chat_message：
//   · 用户话 → chat_message_general.content，形如 [{"type":"text","text_content":"…"}]（image 等类型不是文字）
//   · 助手话 → chat_message_task.content，形如 {messages:[{plan_item:{thought:"…"}}]}（thought 才是正文）
// 水位用 chat_message.id（INTEGER PRIMARY KEY AUTOINCREMENT，单调可用）。
// 铁律：一律先复制 db + wal + shm 到临时目录再解密——应用可能正持锁，最新数据还在 WAL 里。

const TRAE_DB_SUBPATH = path.join("ModularData", "ai-agent", "database.db");

// sqlcipher 是可选能力（koffi + 内置 DLL）：拿不到时 Trae 来源软失败并说明原因，不影响其它来源
let sqlcipherModule = null;
function requireSqlcipher() {
  if (!sqlcipherModule) sqlcipherModule = require("../../sqlcipher.cjs");
  return sqlcipherModule;
}

/** Trae 系会话库发现：三种路径填法都认（指到 database.db / 指到某个应用数据根 / 指到 %APPDATA% 这类父目录） */
function discoverTraeDbs(root) {
  const out = [];
  if (!root) return out;
  const candidates = [];
  if (/\.db$/i.test(root)) candidates.push(root);
  candidates.push(path.join(root, TRAE_DB_SUBPATH));
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(path.join(root, e.name, TRAE_DB_SUBPATH));
    }
  } catch {
    /* 目录读不到：按没有库处理 */
  }
  for (const file of candidates) {
    if (out.some((d) => d.file === file)) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(file).size;
    } catch {
      continue;
    }
    // 应用名取 ModularData 上一级目录名（Trae / Trae CN / TRAE SOLO / TRAE SOLO CN）：游标键与展示都用它
    out.push({ app: path.basename(path.dirname(path.dirname(path.dirname(file)))), file, sizeBytes });
  }
  return out;
}

function probeTrae(source) {
  const dbs = discoverTraeDbs(source.path);
  return {
    ...source,
    exists: dbs.length > 0,
    items: dbs.length,
    sizeBytes: dbs.reduce((s, d) => s + d.sizeBytes, 0),
    format: source.kind,
    databases: dbs.map((d) => ({ app: d.app, file: d.file, sizeBytes: d.sizeBytes })),
    note: dbs.length
      ? `已识别 ${dbs.map((d) => d.app).join(" / ")} 的加密会话库`
      : "未找到 Trae 系会话库（期望 <应用>/ModularData/ai-agent/database.db）",
  };
}

/** 深度探测：只列识别到的库——加密库复制一份要几十秒（主库 400MB 级），探测只回答「路径填对没有」 */
function detectTrae(root) {
  const dbs = discoverTraeDbs(root);
  if (!dbs.length) return { ok: false, message: "未找到 Trae 系会话库（期望 <应用>/ModularData/ai-agent/database.db）" };
  return {
    ok: true,
    kind: "trae",
    databases: dbs.map((d) => ({ app: d.app, file: d.file, sizeBytes: d.sizeBytes })),
    hint: "加密库由 AgentHub 内置 SQLCipher 解密读取，表结构在导入干跑里校验",
  };
}

/** db + wal + shm 复制到临时目录（调用方负责 rmTempDir） */
function copyDbToTemp(file, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const base = path.basename(file);
    for (const ext of ["", "-wal", "-shm"]) {
      const from = file + ext;
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, base + ext));
    }
  } catch (e) {
    rmTempDir(dir);
    throw e;
  }
  sweepStale(prefix, dir); // 崩溃遗留的副本目录每轮随手清，删不掉的留下轮再清
  return dir;
}

/** chat_message_general.content：文字在 type=text 的 text_content 里（image 等其它类型不是说过的话） */
function traeUserText(content) {
  if (!content) return "";
  let arr = null;
  try {
    arr = JSON.parse(String(content));
  } catch {
    return "";
  }
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((x) => x && typeof x.text_content === "string" && (!x.type || x.type === "text"))
    .map((x) => x.text_content.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** chat_message_task.content：正文在 messages[].plan_item.thought（工具调用、状态、计时都不是说过的话） */
function traeAssistantText(content) {
  if (!content) return "";
  let o = null;
  try {
    o = JSON.parse(String(content));
  } catch {
    return "";
  }
  const msgs = o && Array.isArray(o.messages) ? o.messages : [];
  const parts = [];
  for (const m of msgs) {
    const thought = m && m.plan_item && typeof m.plan_item.thought === "string" ? m.plan_item.thought.trim() : "";
    if (thought) parts.push(thought);
  }
  // 同一段思考可能挂在多条 plan_item 上（多轮状态更新），去重后再拼
  return [...new Set(parts)].join("\n\n").trim();
}

/** 读一个 Trae 会话库的一批新消息；任一环节失败都返回 note 交给引擎如实上报，不抛错 */
function readTraeDb(entry, lastId, limit, onItem) {
  const out = { ok: false, lastId, more: false, note: "" };
  let sqlcipher = null;
  try {
    sqlcipher = requireSqlcipher();
  } catch (e) {
    return { ...out, note: `Trae 需要 SQLCipher 支持：${e.message}` };
  }
  if (!sqlcipher.available()) return { ...out, note: "Trae 需要 SQLCipher 支持（resources/sqlcipher 缺失或损坏）" };
  let tmpDir = "";
  let db = null;
  try {
    tmpDir = copyDbToTemp(entry.file, "agenthub-trae-import-");
    db = sqlcipher.open(path.join(tmpDir, path.basename(entry.file)));

    // 会话标题与工程目录（小表，一次读全）：cwd 决定记忆归到哪个项目
    const projects = new Map();
    for (const r of sqlcipher.queryAll(db, "SELECT project_id, absolute_path FROM project")) {
      projects.set(String(r.project_id), String(r.absolute_path || ""));
    }
    const sessions = new Map();
    for (const r of sqlcipher.queryAll(db, "SELECT session_id, project_id FROM chat_session")) {
      sessions.set(String(r.session_id), { cwd: projects.get(String(r.project_id)) || "" });
    }
    // 值都经 Number 收敛后拼进 SQL：sqlcipher 通路没有参数绑定（prepare 直传 SQL）
    const from = Math.max(0, Math.floor(Number(lastId) || 0));
    // 库重建/清空自愈：客户端重装或清本地数据后 chat_message.id 从 1 重新开始，旧水位
    // （m.id > from）会把所有新行永久挡在外面（静默零导入，且没有任何提示）。取库内最大 id
    // 比对，收缩即视为重建 → 本轮从 0 全量重读；万一因删行误判，重复内容由导入侧内容 hash 去重兜底。
    // （jsonl / antigravity 通道有同款 shrunk 自愈，此处补上对齐）
    let floor = from;
    if (from > 0) {
      const mx = sqlcipher.queryAll(db, "SELECT COALESCE(MAX(id), 0) AS __max FROM chat_message");
      if ((Number(mx && mx[0] && mx[0].__max) || 0) < from) floor = 0;
    }
    const rows = sqlcipher.queryAll(
      db,
      `SELECT m.id AS __id, m.session_id AS __session, m.message_role AS __role,
              m.created_at AS __ts, g.content AS __general, t.content AS __task
         FROM chat_message m
         LEFT JOIN chat_message_general g ON g.message_id = m.message_id AND g.deleted_at = 0
         LEFT JOIN chat_message_task t ON t.message_id = m.message_id AND t.deleted_at = 0
        WHERE m.id > ${floor} AND m.deleted_at = 0
        ORDER BY m.id ASC LIMIT ${limit}`,
    );

    let maxId = floor;
    for (const row of rows) {
      const id = Number(row.__id) || 0;
      maxId = Math.max(maxId, id);
      const role = String(row.__role || "");
      // 角色与表不总是一一对应（SOLO 有变体）：先按角色的正表取，取不到再试另一张
      const body =
        role === "user"
          ? traeUserText(row.__general) || traeAssistantText(row.__task)
          : traeAssistantText(row.__task) || traeUserText(row.__general);
      if (!body || body.length < 20) continue;
      if (isHarnessNoise(body)) continue;
      const session = String(row.__session || "");
      onItem({
        title: body.split("\n")[0].slice(0, 80),
        body,
        role: role === "user" ? "user" : "assistant",
        session,
        created: parseTime(row.__ts),
        cwd: (sessions.get(session) || {}).cwd || "",
        origin: `trae:${entry.app}:${id}`,
      });
    }
    return { ok: true, lastId: maxId, more: rows.length >= limit, note: "" };
  } catch (e) {
    return { ...out, note: `读取失败：${e.message}` };
  } finally {
    try {
      if (db) sqlcipher.close(db);
    } catch {
      /* 关闭失败无碍下一轮 */
    }
    if (tmpDir) rmTempDir(tmpDir);
  }
}

function parseTrae(source, cursor, opts, onItem) {
  const dbs = discoverTraeDbs(source.path);
  if (!dbs.length) return { items: 0, nextCursor: cursor, note: "未找到 Trae 系会话库" };
  const files = { ...((cursor && cursor.files) || {}) };
  const limit = Math.min(Number(opts.batchSize || 500), 2000);
  let emitted = 0;
  let more = false;
  let note = "";
  for (const entry of dbs) {
    const r = readTraeDb(entry, Number((files[entry.app] || {}).lastId) || 0, limit, (item) => {
      onItem({ source: source.id, ...item });
      emitted++;
    });
    if (r.note) note = r.note;
    if (r.ok) files[entry.app] = { lastId: r.lastId, table: "chat_message", app: entry.app, file: entry.file };
    // 单轮配额用满：带着新游标留给下一轮，本轮不再往下读别的库（保证多库之间公平推进）
    if (r.more) {
      more = true;
      break;
    }
  }
  return { items: emitted, more, files: dbs.length, note, nextCursor: { ...(cursor || {}), files } };
}

// ---------- Antigravity 解析器（Antigravity / Antigravity IDE 会话日志） ----------
//
// 数据源：~/.gemini/<应用>/brain/<会话 id>/.system_generated/logs/ 下的会话日志（JSONL，每行一条 step）：
//   · transcript.jsonl      流式转录（{step_index, source, type, status, created_at, content?, thinking?, tool_calls?}）
//   · transcript_full.jsonl 同结构、带完整工具输出（transcript 缺失/为空时兜底）
//   · overview.txt          Antigravity IDE 只写这一份（内容同 JSONL 结构）
// 只要两种角色：USER_EXPLICIT|USER_INPUT（用户）与 MODEL|PLANNER_RESPONSE 带 content（模型回复）；
// 工具调用/工具结果/思考/系统消息都不是「说过的话」，一律不收。
// 工程目录优先取 <应用>/conversation_summaries.db 的 workspace_uris（IDE 版没有该库，
// 退回用户输入附加元数据里的 Active Document）。增量按文件字节水位——日志是追加写的。

const AG_LOG_FILES = ["transcript.jsonl", "transcript_full.jsonl", "overview.txt"];

/** Antigravity 应用目录发现：支持指到 ~/.gemini（默认）、指到某个应用根、指到 brain 目录 */
function discoverAntigravityApps(root) {
  const out = [];
  if (!root) return out;
  const candidates = [];
  if (path.basename(root).toLowerCase() === "brain") candidates.push(path.dirname(root));
  candidates.push(root, path.join(root, "antigravity"), path.join(root, "antigravity-ide"));
  for (const dir of candidates) {
    if (out.includes(dir)) continue;
    try {
      if (fs.statSync(path.join(dir, "brain")).isDirectory()) out.push(dir);
    } catch {
      /* 不是应用根：跳过 */
    }
  }
  return out;
}

/** 一个应用下的会话：每条会话取一份可用日志（按 AG_LOG_FILES 顺序找第一份非空的） */
function listAntigravitySessions(appDir) {
  const brain = path.join(appDir, "brain");
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(brain, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const id of dirs) {
    const logsDir = path.join(brain, id, ".system_generated", "logs");
    let file = "";
    for (const name of AG_LOG_FILES) {
      try {
        if (fs.statSync(path.join(logsDir, name)).size > 0) {
          file = path.join(logsDir, name);
          break;
        }
      } catch {
        /* 不存在就试下一个 */
      }
    }
    out.push({ app: path.basename(appDir), id, file });
  }
  return out;
}

/** file:///e%3A/idea%20work 这类 workspace_uri → 本机路径（只在 Windows 盘符前去掉多余斜杠） */
function uriToPath(uri) {
  try {
    const s = String(uri || "");
    if (!/^file:\/\//i.test(s)) return "";
    return decodeURIComponent(s.replace(/^file:\/\//i, "")).replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return "";
  }
}

/** conversation_summaries.db → { 会话 id → 工程目录 }（库被占用/结构变体时返回空表，归类退回 Active Document） */
function readAntigravitySummaries(appDir) {
  const file = path.join(appDir, "conversation_summaries.db");
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  let conn = null;
  try {
    conn = openReadOnly(file, "agenthub-ag-sum-");
    for (const r of conn.prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries").all()) {
      let cwd = "";
      try {
        const uris = JSON.parse(String(r.workspace_uris || "[]"));
        for (const u of Array.isArray(uris) ? uris : []) {
          cwd = uriToPath(u);
          if (cwd) break;
        }
      } catch {
        /* workspace_uris 不是 JSON：留空 */
      }
      map.set(String(r.conversation_id), { cwd });
    }
  } catch {
    /* 读不到就当没有：不影响导入本身 */
  } finally {
    try {
      if (conn) conn.close();
    } catch {
      /* 已关闭 */
    }
  }
  return map;
}

/** 用户输入里的附加元数据带上活动文件（IDE 版没有 summaries 库时用它推工程目录） */
function antigravityCwdFromMeta(raw) {
  const m = String(raw || "").match(/Active Document:\s*([^\r\n]+)/);
  if (!m) return "";
  const p = m[1].replace(/\s*\([A-Z_]+\)\s*$/, "").trim();
  try {
    return p ? path.dirname(p) : "";
  } catch {
    return "";
  }
}

/** 用户输入正文：请求体在 <USER_REQUEST> 里，附加元数据/设置变更不是用户说的话 */
function cleanAntigravityUserInput(raw) {
  const text = String(raw || "");
  const requests = [...text.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/g)].map((m) => m[1].trim()).filter(Boolean);
  if (requests.length) return requests.join("\n");
  return text.split(/<ADDITIONAL_METADATA>/i)[0].trim();
}

/** 一行日志 → 0~1 条记忆（只认用户输入与模型回复两种；其余是工具/思考/系统消息） */
function antigravityItem(obj, session, summaries) {
  const src = String(obj.source || "");
  const type = String(obj.type || "");
  const raw = typeof obj.content === "string" ? obj.content : "";
  if (!raw.trim()) return null;
  const base = {
    session: session.id,
    created: parseTime(obj.created_at),
    origin: `antigravity:${session.app}:${session.id}#${obj.step_index == null ? "" : obj.step_index}`,
  };
  if (src === "USER_EXPLICIT" && type === "USER_INPUT") {
    const body = cleanAntigravityUserInput(raw);
    if (body.length < 20 || isHarnessNoise(body)) return null;
    return {
      ...base,
      title: body.split("\n")[0].slice(0, 80),
      body,
      role: "user",
      cwd: (summaries.get(session.id) || {}).cwd || antigravityCwdFromMeta(raw),
    };
  }
  if (src === "MODEL" && type === "PLANNER_RESPONSE") {
    const body = raw.trim();
    if (body.length < 20 || isHarnessNoise(body)) return null;
    return {
      ...base,
      title: body.split("\n")[0].slice(0, 80),
      body,
      role: "assistant",
      cwd: (summaries.get(session.id) || {}).cwd || "",
    };
  }
  return null;
}

function probeAntigravity(source) {
  const apps = discoverAntigravityApps(source.path);
  let logs = 0;
  let sizeBytes = 0;
  for (const appDir of apps) {
    for (const s of listAntigravitySessions(appDir)) {
      if (!s.file) continue;
      logs++;
      try {
        sizeBytes += fs.statSync(s.file).size;
      } catch {
        /* 忽略取不到大小的日志 */
      }
    }
  }
  return {
    ...source,
    exists: apps.length > 0,
    items: logs,
    sizeBytes,
    format: source.kind,
    apps: apps.map((d) => path.basename(d)),
    note: apps.length
      ? `已识别 ${apps.map((d) => path.basename(d)).join(" / ")} 的 ${logs} 份会话日志`
      : "未找到 Antigravity 会话目录（期望 <根>/antigravity[-ide]/brain）",
  };
}

function detectAntigravity(root) {
  const apps = discoverAntigravityApps(root);
  if (!apps.length) return { ok: false, message: "未找到 Antigravity 会话目录（期望 <根>/antigravity[-ide]/brain）" };
  return {
    ok: true,
    kind: "antigravity",
    apps: apps.map((appDir) => {
      const sessions = listAntigravitySessions(appDir);
      return {
        app: path.basename(appDir),
        conversations: sessions.length,
        withLog: sessions.filter((s) => s.file).length,
        logNames: [...new Set(sessions.filter((s) => s.file).map((s) => path.basename(s.file)))],
        summariesDb: fs.existsSync(path.join(appDir, "conversation_summaries.db")),
      };
    }),
    hint: "旧版 .pb 会话整文件加密、密钥不在本机，解析器只读日志型的 .jsonl/.txt",
  };
}

function parseAntigravity(source, cursor, opts, onItem) {
  const apps = discoverAntigravityApps(source.path);
  if (!apps.length) return { items: 0, nextCursor: cursor, note: "未找到 Antigravity 会话目录" };
  const files = { ...((cursor && cursor.files) || {}) };
  const maxFiles = Number(opts.maxFiles || 200);
  const state = [];
  for (const appDir of apps) {
    const summaries = readAntigravitySummaries(appDir);
    for (const s of listAntigravitySessions(appDir)) {
      if (!s.file) continue;
      const key = `${s.app}/${s.id}/${path.basename(s.file)}`;
      let size = 0;
      try {
        size = fs.statSync(s.file).size;
      } catch {
        /* 取不到大小按已读完处理 */
      }
      state.push({ ...s, key, prev: Number(files[key] || 0), size, summaries });
    }
  }
  // 单轮配额优先给还有新增内容的日志（与 parseJsonl/parseMarkdown 同口径），
  // 否则前 maxFiles 份已读完的日志每轮都占满配额，排在后面的会话永远轮不到
  const pending = state.filter((x) => x.prev !== x.size);
  const chosen = pending.slice(0, maxFiles);
  let emitted = 0;
  let more = pending.length > chosen.length;
  for (const x of chosen) {
    let consumed = x.prev;
    try {
      const r = readNewLines(x.file, x.prev, (line) => {
        let obj = null;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        const item = antigravityItem(obj, x, x.summaries);
        if (!item) return;
        onItem({ source: source.id, ...item });
        emitted++;
      }, { maxChunkBytes: Number(opts.maxChunkBytes || 8 * 1024 * 1024) });
      // 单份日志超过单轮字节上限：下一轮接着读
      if (r.truncated) more = true;
      // 日志变小（被轮转/覆盖）→ 游标回退到 0，本轮马上重读
      if (r.shrunk) {
        consumed = 0;
        more = true;
      } else {
        consumed = r.consumed;
      }
    } catch {
      consumed = x.prev;
    }
    files[x.key] = consumed;
  }
  return { items: emitted, more, files: state.length, nextCursor: { ...(cursor || {}), files } };
}

// ---------- JSONL 解析器（按字节增量 + 末行截断） ----------

function readNewLines(file, fromByte, onLine, opts = {}) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= fromByte) return { lines: 0, size, consumed: fromByte, shrunk: size < fromByte };
    const maxChunk = Number(opts.maxChunkBytes || 8 * 1024 * 1024);
    const readBytes = Math.min(size - fromByte, maxChunk);
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, fromByte);
    const text = buf.toString("utf8");
    const parts = text.split("\n");
    const complete = parts.slice(0, -1);
    if (complete.length === 0) {
      if (readBytes === size - fromByte) {
        // 读到文件末尾且无末尾换行符的最后一行：正常消费并推进至末尾
        if (text.trim()) onLine(text);
        return { lines: text.trim() ? 1 : 0, size, consumed: size, shrunk: false, truncated: false };
      }
      // 单行超过 maxChunkBytes（8MB）：向下扫描下一个换行符推进，防止原地死循环
      let nextLf = -1;
      const scanBuf = Buffer.alloc(64 * 1024);
      let scanPos = fromByte + readBytes;
      while (scanPos < size) {
        const n = fs.readSync(fd, scanBuf, 0, Math.min(scanBuf.length, size - scanPos), scanPos);
        if (n <= 0) break;
        const idx = scanBuf.subarray(0, n).indexOf(0x0a);
        if (idx >= 0) {
          nextLf = scanPos + idx;
          break;
        }
        scanPos += n;
      }
      const consumed = nextLf >= 0 ? nextLf + 1 : size;
      return { lines: 0, size, consumed, shrunk: false, truncated: consumed < size, skippedOversized: true };
    }
    for (const line of complete) if (line.trim()) onLine(line);
    const consumed = fromByte + Buffer.byteLength(complete.map((l) => l + "\n").join(""), "utf8");
    return { lines: complete.length, size, consumed, shrunk: false, truncated: readBytes < size - fromByte };
  } finally {
    fs.closeSync(fd);
  }
}

// 事件流会话文件的工作目录只写在头部的 session_meta 里：增量续读时那段已越过游标，
// 必须单独回读文件头，否则续读进来的消息会整段丢掉项目归属
function readHeadCwd(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString("utf8").split("\n").slice(0, 5)) {
      try {
        const o = JSON.parse(line);
        const c = o && o.payload && o.payload.cwd;
        if (typeof c === "string" && c) return c;
      } catch { /* 非 JSON 行：跳过 */ }
    }
  } catch { /* 读不到就算了，归类退回 general */ } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
  }
  return "";
}

function parseJsonl(source, cursor, opts, onItem) {
  const files = fs.statSync(source.path).isDirectory() ? walk(source.path, [".jsonl"]) : [source.path];
  const cursors = { ...((cursor && cursor.files) || {}) };
  let emitted = 0;
  let scannedFiles = 0;
  const maxFiles = Number(opts.maxFiles || 200);
  // 单轮配额优先给「还没读完的文件」：否则前 maxFiles 个已读完的文件每轮都占满配额，
  // 排在后面的文件永远轮不到（文件数超过上限的来源会整段漏导）
  const state = files.map((file) => {
    const key = path.relative(source.path, file).replace(/\\/g, "/");
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 取不到大小按已读完处理 */ }
    return { file, key, prev: Number(cursors[key] || 0), size };
  });
  const pending = state.filter((x) => x.prev !== x.size); // 含变小的文件：需回退游标从 0 重读
  // 会话目录名可能编码了工作目录（workbuddy 的 "e-公司项目-商丘水闸前端"）：反解一次给同目录下所有文件用；
  // 解不出来留空，归类交给 layout 兜底，不影响导入
  const dirCwdCache = new Map();
  const cwdOfDir = (dir) => {
    if (dirCwdCache.has(dir)) return dirCwdCache.get(dir);
    const p = opts.pathReverse === false ? "" : reverseSessionDirName(dir);
    dirCwdCache.set(dir, p);
    return p;
  };
  const chosen = pending.slice(0, maxFiles);
  // 配额用满说明还有文件没轮到，下一轮接着做。
  // 判据必须是「还没轮到的文件数」，不能是 chosen.length >= maxFiles——所有文件都读完时
  // 会恒为真，引擎会白跑满 60 轮空转（每轮重扫整个目录）
  let more = pending.length > chosen.length;
  for (const { file, key, prev } of chosen) {
    scannedFiles++;
    let consumed = prev;
    // 文件级工作目录：先看目录名，头部 session_meta 出现时以它为准
    let fileCwd = cwdOfDir(path.basename(path.dirname(file)));
    if (prev > 0) fileCwd = readHeadCwd(file) || fileCwd;
    try {
      const r = readNewLines(file, prev, (line) => {
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        const metaCwd = obj && obj.payload && obj.payload.cwd;
        if (typeof metaCwd === "string" && metaCwd) fileCwd = metaCwd;
        const node = unwrapEnvelope(obj);
        const content = flattenContent(pick(node, FIELD_ALIASES.content) || node);
        if (!content || content.length < 20) return;
        const role = String(pick(node, FIELD_ALIASES.role) || "unknown");
        // developer 是 harness 塞进去的权限/沙箱说明，不是对话内容
        if (role === "system" || role === "tool" || role === "developer") return;
        if (isHarnessNoise(content)) return;
        onItem({
          source: source.id,
          title: content.split("\n")[0].slice(0, 80),
          body: content,
          role,
          session: pick(node, FIELD_ALIASES.session) || pick(obj, FIELD_ALIASES.session) || "",
          created: parseTime(pick(node, FIELD_ALIASES.time)) || parseTime(pick(obj, FIELD_ALIASES.time)),
          cwd: pick(node, "cwd") || pick(obj, "cwd") || fileCwd || "",
          origin: `${key}`,
        });
        emitted++;
      }, { maxChunkBytes: Number(opts.maxChunkBytes || 8 * 1024 * 1024) });
      // 单文件超过单轮字节上限：这份文件还有后半截，下一轮接着读
      if (r.truncated) more = true;
      // 文件变小（被轮转/覆盖）→ 游标回退到 0，并让本轮马上重读，别拖到下次导入
      if (r.shrunk) { consumed = 0; more = true; }
      else consumed = r.consumed;
    } catch {
      consumed = prev;
    }
    cursors[key] = consumed;
  }
  return { items: emitted, files: scannedFiles, more, nextCursor: { ...(cursor || {}), files: cursors } };
}

// ---------- Markdown 解析器 ----------

function parseMarkdown(source, cursor, opts, onItem) {
  const files = fs.statSync(source.path).isDirectory() ? walk(source.path, opts.ext || [".md"]) : [source.path];
  const seen = { ...((cursor && cursor.files) || {}) };
  let emitted = 0;
  const rules = opts.md || {};
  // 与 parseJsonl 同口径：单轮限量、游标持久化，多轮自然追平（巨型笔记目录不一次全读）
  const maxFiles = Number(opts.maxFiles || 200);
  // 单轮配额优先给「有变更的文件」：否则前 maxFiles 个没动过的老文件每轮都占满配额，
  // 排在后面的新文件永远轮不到（与 parseJsonl 同口径）
  const state = files.map((file) => {
    const key = path.relative(source.path, file).replace(/\\/g, "/");
    let mtime = 0;
    try { mtime = Math.round(fs.statSync(file).mtimeMs); } catch { /* 取不到按已处理处理 */ }
    const prev = seen[key];
    return { file, key, mtime, changed: !mtime || !prev || prev.mtime !== mtime };
  });
  const changed = state.filter((x) => x.changed);
  // 只跑有变更的文件：原先无变更时回退到 state（全量），会让引擎每轮重解析并重报整份笔记目录
  // （60 轮 × 全目录），写入侧虽有哈希去重兜底，但白烧 CPU 与索引查询
  const chosen = changed.slice(0, maxFiles);
  for (const { file, key, mtime } of chosen) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(text);
    const observations = [];
    if (rules.observationMarkers !== false) {
      for (const line of body.split("\n")) {
        const m = NOTE_MARKER.exec(line.trim());
        if (m) observations.push({ category: m[1].toLowerCase(), text: m[2].trim() });
      }
    }
    const tags = new Set(Array.isArray(fm.tags) ? fm.tags.map(String) : String(fm.tags || "").split(/[,，\s]+/).filter(Boolean));
    if (rules.extractTags !== false) {
      const matches = body.match(INLINE_TAG);
      for (const t of matches || []) tags.add(t.replace("#", ""));
    }
    const wiki = [];
    if (rules.extractWikiLinks) {
      const m = body.match(WIKILINK);
      for (const x of m || []) wiki.push(String(x).replace(/\[\[|\]\]/g, ""));
    }
    const base = path.basename(file).replace(/\.md$/i, "");
    // classify.pathReverse：关闭后不再从会话目录名反解项目（目录名歧义大时用户会想关）
    const projectCandidate = fm.project
      || (opts.pathReverse === false ? "" : reverseClaudeDirName(path.basename(path.dirname(file))))
      || "";
    // 观测行另成条目，但整篇正文不能因此丢掉（此前有标记就只收标记行）
    const proseItem = body.trim()
      ? [{
          source: source.id,
          title: fm.title || base,
          body: body.trim(),
          type: fm.category === "decision" ? "decision" : "note",
          tags: [...tags],
          created: parseTime(fm.created || fm.date) || mtime,
          project: projectCandidate,
          origin: key,
          refs: wiki,
        }]
      : [];
    const items = (observations.length
      ? observations.map((o) => ({
          source: source.id,
          title: o.text.slice(0, 80),
          body: o.text,
          type: o.category === "decision" ? "decision" : "note",
          tags: [...tags],
          created: parseTime(fm.created || fm.date) || mtime,
          project: projectCandidate,
          origin: key,
        }))
      : proseItem).concat(observations.length ? proseItem : []);
    for (const it of items) {
      if (!String(it.body || "").trim()) continue;
      onItem(it);
      emitted++;
    }
    seen[key] = { mtime, at: Date.now() };
  }
  return { items: emitted, files: files.length, more: changed.length > chosen.length, nextCursor: { ...(cursor || {}), files: seen } };
}

function parseTime(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function pickParser(source) {
  const kind = source.kind || "";
  if (kind === "sqlite") return { id: "sqlite", parse: parseSqlite, detect: detectSqlite };
  if (kind === "jsonl") return { id: "jsonl", parse: parseJsonl, detect: detectJsonl };
  if (kind === "trae") return { id: "trae", parse: parseTrae, detect: detectTrae };
  if (kind === "antigravity") return { id: "antigravity", parse: parseAntigravity, detect: detectAntigravity };
  return { id: "md", parse: parseMarkdown, detect: () => ({ ok: true, kind: "md" }) };
}

module.exports = {
  probeSource,
  detectSource,
  pickParser,
  parseSqlite,
  parseJsonl,
  parseMarkdown,
  parseTrae,
  parseAntigravity,
  readNewLines,
  walk,
  FIELD_ALIASES,
  // 发现函数给自测与「深度探测」复用（engine 的增量文案按库名/会话数说话）
  discoverTraeDbs,
  discoverAntigravityApps,
  listAntigravitySessions,
};
