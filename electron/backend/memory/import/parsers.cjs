/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 导入来源探测与解析器：6 类来源、3 类解析器（SQLite / JSONL / Markdown）。
// 增量靠游标（cursors.json）：SQLite 用行 id 水位，文件用字节水位，MD 用 mtime + hash。
// 解析器一律「先探测体量再读」——大库不整表读进内存。
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

const { parseFrontmatter } = require("../store.cjs");
const { reverseClaudeDirName, reverseSessionDirName } = require("../layout.cjs");

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
  const textPk = columnDefs.find((c) => /^(id|_id)$/i.test(c.name) && !/INT/i.test(String(c.type || "")));
  // 水位列优先级：数值主键 > rowid（可推进）> 文本主键（只能全扫 + 哈希兜底）
  const idCol = numericPk && SAFE_IDENT.test(numericPk.name) ? numericPk.name : withoutRowid ? null : "rowid";
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
  const lastId = Number(cursor && cursor.lastId) || 0;
  const limit = Math.min(Number(opts.batchSize || 500), 2000);
  let rows = [];
  let total = 0;
  const fullScan = !idCol; // 文本主键 + WITHOUT ROWID：没有可靠水位，只能全扫（靠内容哈希幂等）
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
    maxId = Math.max(maxId, Number(cursorValue) || maxId);
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
      origin: `sqlite:${table}#${row[idCol]}`,
    });
    emitted++;
  }
  return {
    items: emitted,
    table,
    total,
    // 本轮用满配额说明后面还有数据，多轮解析要接着读；
    // fullScan（无水位列）不能续读——游标推不动，重读同一批会死循环，靠内容哈希兜底去重
    more: !fullScan && rows.length >= limit,
    note: fullScan ? "该表无可用数值主键（全扫 + 内容哈希去重，重复运行不会重复写入）" : "",
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
  const pending = state.filter((x) => x.prev < x.size);
  // 会话目录名可能编码了工作目录（workbuddy 的 "e-公司项目-商丘水闸前端"）：反解一次给同目录下所有文件用；
  // 解不出来留空，归类交给 layout 兜底，不影响导入
  const dirCwdCache = new Map();
  const cwdOfDir = (dir) => {
    if (dirCwdCache.has(dir)) return dirCwdCache.get(dir);
    const p = opts.pathReverse === false ? "" : reverseSessionDirName(dir);
    dirCwdCache.set(dir, p);
    return p;
  };
  const chosen = (pending.length ? pending : state).slice(0, maxFiles);
  // 配额用满说明还有文件没轮到，下一轮接着做
  let more = chosen.length >= maxFiles;
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
      if (r.shrunk) consumed = 0;
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
  const chosen = (changed.length ? changed : state).slice(0, maxFiles);
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
  return { items: emitted, files: files.length, more: chosen.length >= maxFiles, nextCursor: { ...(cursor || {}), files: seen } };
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
  return { id: "md", parse: parseMarkdown, detect: () => ({ ok: true, kind: "md" }) };
}

module.exports = { probeSource, detectSource, pickParser, parseSqlite, parseJsonl, parseMarkdown, readNewLines, walk, FIELD_ALIASES };
