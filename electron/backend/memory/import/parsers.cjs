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
const { reverseClaudeDirName } = require("../layout.cjs");

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
  const table = source.table || (detectSqlite(source.path).suggested || {}).table;
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
    if (role === "system" || role === "tool") continue;
    onItem({
      source: source.id,
      title: content.split("\n")[0].slice(0, 80),
      body: content,
      role,
      session: sessionCol ? row[sessionCol] : "",
      created: parseTime(row[timeCol]),
      origin: `sqlite:${table}#${row[idCol]}`,
    });
    emitted++;
  }
  return {
    items: emitted,
    table,
    total,
    note: fullScan ? "该表无可用数值主键（全扫 + 内容哈希去重，重复运行不会重复写入）" : "",
    nextCursor: { ...(cursor || {}), lastId: maxId, table, cursorColumn: idCol || "(full-scan)" },
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

function parseJsonl(source, cursor, opts, onItem) {
  const files = fs.statSync(source.path).isDirectory() ? walk(source.path, [".jsonl"]) : [source.path];
  const cursors = { ...((cursor && cursor.files) || {}) };
  let emitted = 0;
  let scannedFiles = 0;
  const maxFiles = Number(opts.maxFiles || 200);
  // 从头取（walk 升序）：游标按文件持久化，本轮做前 N 个、下轮接着做；
  // 原先 slice(-maxFiles) 永远只碰尾部，超帽的最老文件永远漏导
  for (const file of files.slice(0, maxFiles)) {
    const key = path.relative(source.path, file).replace(/\\/g, "/");
    const prev = Number(cursors[key] || 0);
    scannedFiles++;
    let consumed = prev;
    try {
      const r = readNewLines(file, prev, (line) => {
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        const content = flattenContent(pick(obj, FIELD_ALIASES.content) || obj);
        if (!content || content.length < 20) return;
        const role = String(pick(obj, FIELD_ALIASES.role) || "unknown");
        if (role === "system" || role === "tool") return;
        onItem({
          source: source.id,
          title: content.split("\n")[0].slice(0, 80),
          body: content,
          role,
          session: pick(obj, FIELD_ALIASES.session) || "",
          created: parseTime(pick(obj, FIELD_ALIASES.time)),
          origin: `${key}`,
        });
        emitted++;
      }, { maxChunkBytes: Number(opts.maxChunkBytes || 8 * 1024 * 1024) });
      if (r.shrunk) consumed = 0;
      else consumed = r.consumed;
    } catch {
      consumed = prev;
    }
    cursors[key] = consumed;
  }
  return { items: emitted, files: scannedFiles, nextCursor: { ...(cursor || {}), files: cursors } };
}

// ---------- Markdown 解析器 ----------

function parseMarkdown(source, cursor, opts, onItem) {
  const files = fs.statSync(source.path).isDirectory() ? walk(source.path, opts.ext || [".md"]) : [source.path];
  const seen = { ...((cursor && cursor.files) || {}) };
  let emitted = 0;
  const rules = opts.md || {};
  // 与 parseJsonl 同口径：单轮限量、游标持久化，多轮自然追平（巨型笔记目录不一次全读）
  const maxFiles = Number(opts.maxFiles || 200);
  for (const file of files.slice(0, maxFiles)) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const key = path.relative(source.path, file).replace(/\\/g, "/");
    const prev = seen[key];
    if (prev && prev.mtime === Math.round(st.mtimeMs)) continue;
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
          created: parseTime(fm.created || fm.date) || Math.round(st.mtimeMs),
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
          created: parseTime(fm.created || fm.date) || Math.round(st.mtimeMs),
          project: projectCandidate,
          origin: key,
        }))
      : proseItem).concat(observations.length ? proseItem : []);
    for (const it of items) {
      if (!String(it.body || "").trim()) continue;
      onItem(it);
      emitted++;
    }
    seen[key] = { mtime: Math.round(st.mtimeMs), at: Date.now() };
  }
  return { items: emitted, files: files.length, nextCursor: { ...(cursor || {}), files: seen } };
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
