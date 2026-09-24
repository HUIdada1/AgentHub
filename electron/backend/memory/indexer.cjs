/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 索引层：node:sqlite + FTS5 external content 双索引 + 触发器自动同步。
// 硬结论来自《性能与准确性专项方案》：bigram 预分词、external content 表、
// 触发器只对索引列变更触发（修正清单 F1）、混合评分放应用层。
// node:sqlite 调用全部收敛在本文件（可行性复核 R2：未来 API 变更只改这里）。
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { tokenize, weightedTitle } = require("./tokenizer.cjs");

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS mem (
  id            TEXT NOT NULL,
  path          TEXT NOT NULL,
  anchor        TEXT,
  type          TEXT,
  layer         TEXT,
  title         TEXT,
  summary       TEXT,
  tags          TEXT,
  project       TEXT,
  agent         TEXT,
  device        TEXT,
  session       TEXT,
  created       INTEGER,
  updated       INTEGER,
  importance    INTEGER DEFAULT 3,
  hash          TEXT,
  size          INTEGER,
  mtime         INTEGER,
  valid_from    INTEGER,
  valid_to      INTEGER,
  superseded_by TEXT,
  refs_text     TEXT,
  dup_index     INTEGER DEFAULT 0,
  dedup_status  TEXT DEFAULT 'pending',
  ai_processed  INTEGER DEFAULT 0,
  pinned        INTEGER DEFAULT 0,
  starred       INTEGER DEFAULT 0,
  t_title       TEXT,
  t_summary     TEXT,
  t_body        TEXT,
  t_tags        TEXT,
  w_title       TEXT,
  PRIMARY KEY (id, path)
);
CREATE INDEX IF NOT EXISTS idx_mem_project ON mem(project);
CREATE INDEX IF NOT EXISTS idx_mem_agent   ON mem(agent);
CREATE INDEX IF NOT EXISTS idx_mem_created ON mem(created);
CREATE INDEX IF NOT EXISTS idx_mem_layer   ON mem(layer);
CREATE INDEX IF NOT EXISTS idx_mem_valid   ON mem(valid_to);
CREATE INDEX IF NOT EXISTS idx_mem_super   ON mem(superseded_by);
CREATE INDEX IF NOT EXISTS idx_mem_hash    ON mem(hash);
CREATE INDEX IF NOT EXISTS idx_mem_dedup   ON mem(dedup_status);
-- session 索引：导入时每条都要按 (session,title) 判「同一件事换了个说法」，
-- 没索引就是每次全表扫描，几万条导入会越跑越慢
CREATE INDEX IF NOT EXISTS idx_mem_session ON mem(session);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  t_title, t_summary, t_body, t_tags,
  content='mem', content_rowid='rowid', tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts_w USING fts5(
  w_title, t_summary, t_body, t_tags,
  content='mem', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON mem BEGIN
  INSERT INTO mem_fts(rowid, t_title, t_summary, t_body, t_tags)
  VALUES (new.rowid, new.t_title, new.t_summary, new.t_body, new.t_tags);
  INSERT INTO mem_fts_w(rowid, w_title, t_summary, t_body, t_tags)
  VALUES (new.rowid, new.w_title, new.t_summary, new.t_body, new.t_tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON mem BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, t_title, t_summary, t_body, t_tags)
  VALUES ('delete', old.rowid, old.t_title, old.t_summary, old.t_body, old.t_tags);
  INSERT INTO mem_fts_w(mem_fts_w, rowid, w_title, t_summary, t_body, t_tags)
  VALUES ('delete', old.rowid, old.w_title, old.t_summary, old.t_body, old.t_tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE OF t_title, t_summary, t_body, t_tags, w_title ON mem BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, t_title, t_summary, t_body, t_tags)
  VALUES ('delete', old.rowid, old.t_title, old.t_summary, old.t_body, old.t_tags);
  INSERT INTO mem_fts(rowid, t_title, t_summary, t_body, t_tags)
  VALUES (new.rowid, new.t_title, new.t_summary, new.t_body, new.t_tags);
  INSERT INTO mem_fts_w(mem_fts_w, rowid, w_title, t_summary, t_body, t_tags)
  VALUES ('delete', old.rowid, old.w_title, old.t_summary, old.t_body, old.t_tags);
  INSERT INTO mem_fts_w(rowid, w_title, t_summary, t_body, t_tags)
  VALUES (new.rowid, new.w_title, new.t_summary, new.t_body, new.t_tags);
END;

CREATE TABLE IF NOT EXISTS mem_link (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS agent_beat (
  agent     TEXT PRIMARY KEY,
  last_call INTEGER,
  last_tool TEXT,
  calls     INTEGER DEFAULT 0,
  writes    INTEGER DEFAULT 0,
  searches  INTEGER DEFAULT 0,
  errors    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_call (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  provider   TEXT,
  model      TEXT,
  task       TEXT,
  tokens_in  INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  ok         INTEGER DEFAULT 1,
  latency_ms INTEGER DEFAULT 0,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_call(ts);

CREATE TABLE IF NOT EXISTS mem_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS review_queue (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT DEFAULT 'pending',
  created    INTEGER NOT NULL,
  resolved   INTEGER,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status, kind);
`;

const MEM_COLS = [
  "id", "path", "anchor", "type", "layer", "title", "summary", "tags",
  "project", "agent", "device", "session", "created", "updated", "importance",
  "hash", "size", "mtime", "valid_from", "valid_to", "superseded_by", "refs_text",
  "dup_index", "dedup_status", "ai_processed", "pinned", "starred",
  "t_title", "t_summary", "t_body", "t_tags", "w_title",
];

class MemoryIndex {
  constructor(dbFile) {
    this.file = dbFile;
    this.db = null;
    /** 库版本高于本程序时进入只读模式：所有写入口都要先看这个标记 */
    this.readOnly = false;
  }

  open() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA mmap_size = 268435456");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec(DDL);
    const v = db.prepare("PRAGMA user_version").get().user_version;
    if (v > SCHEMA_VERSION) {
      // 更新版应用写的库：只读保护，不降级写
      db.exec("PRAGMA query_only = ON");
      this.readOnly = true;
    } else if (v < SCHEMA_VERSION) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db = db;
    this._prepare();
    this.selfCheck();
    return db;
  }

  _prepare() {
    const cols = MEM_COLS.join(", ");
    const marks = MEM_COLS.map(() => "?").join(", ");
    this._upsert = this.db.prepare(`INSERT OR REPLACE INTO mem (${cols}) VALUES (${marks})`);
    this._deleteByIdPath = this.db.prepare("DELETE FROM mem WHERE id = ? AND path = ?");
    this._deleteByPath = this.db.prepare("DELETE FROM mem WHERE path = ?");
    this._getMeta = this.db.prepare("SELECT value FROM mem_meta WHERE key = ?");
    this._setMeta = this.db.prepare("INSERT OR REPLACE INTO mem_meta (key, value) VALUES (?, ?)");
    // 下面几条都在逐条写入/导入的热路径上：每次调用重新 prepare 等于每次重新编译 SQL，
    // 批量导入几万条时这块开销可观，一律在 open 时备好
    this._getById = this.db.prepare("SELECT * FROM mem WHERE id = ? ORDER BY updated DESC LIMIT 1");
    this._findByHashActive = this.db.prepare(
      "SELECT * FROM mem WHERE hash = ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY created DESC LIMIT 1",
    );
    this._findBySessionTitle = this.db.prepare("SELECT id FROM mem WHERE session = ? AND title = ? LIMIT 1");
    this._clearLinks = this.db.prepare("DELETE FROM mem_link WHERE src = ?");
    this._insertLink = this.db.prepare("INSERT OR IGNORE INTO mem_link (src, dst, kind) VALUES (?, ?, ?)");
  }

  /** 仍有效的同内容条目（L1 去重判定） */
  findByHashActive(hash) {
    if (!hash) return null;
    return this._findByHashActive.get(hash, Date.now()) || null;
  }

  /** 同会话同标题（导入的「同一件事换个说法」判定） */
  findBySessionTitle(session, title) {
    if (!session) return null;
    return this._findBySessionTitle.get(session, title) || null;
  }

  close() {
    if (!this.db) return;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 关闭前尽力回收 WAL */ }
    try { this.db.close(); } catch { /* 重复关闭忽略 */ }
    this.db = null;
  }

  getMeta(key) {
    const r = this._getMeta.get(key);
    return r ? r.value : null;
  }

  setMeta(key, value) {
    if (this.readOnly) return false;
    this._setMeta.run(key, String(value));
    return true;
  }

  // 启动自检：FTS 索引与内容表不一致 → 触发器漏建/损坏，自动重建。
  // 注意：external content 表的 COUNT(*) 直接读内容表（实测 2026-09-24：触发器缺失时
  // COUNT 与 mem 完全相同但 MATCH 全空），所以必须看 shadow 表 docsize——每个已索引
  // 文档一行，与 mem 行数不一致即索引残缺。只读模式下不能重建，只报告交给用户处理。
  selfCheck() {
    const mem = this.db.prepare("SELECT COUNT(*) AS c FROM mem").get().c;
    let fts, ftsW;
    try {
      fts = this.db.prepare("SELECT COUNT(*) AS c FROM mem_fts_docsize").get().c;
      ftsW = this.db.prepare("SELECT COUNT(*) AS c FROM mem_fts_w_docsize").get().c;
    } catch {
      // shadow 表都不存在 = FTS 表本身损坏，按不一致处理触发重建
      fts = -1;
      ftsW = -1;
    }
    if (mem !== fts || mem !== ftsW) {
      if (this.readOnly) return { rebuilt: false, skipped: "readonly", before: { mem, fts, ftsW } };
      this.rebuildFts();
      return { rebuilt: true, before: { mem, fts, ftsW } };
    }
    return { rebuilt: false, mem };
  }

  rebuildFts() {
    if (this.readOnly) return 0;
    const t0 = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
      this.db.exec("INSERT INTO mem_fts_w(mem_fts_w) VALUES('delete-all')");
      this.db.prepare("INSERT INTO mem_fts(rowid, t_title, t_summary, t_body, t_tags) SELECT rowid, t_title, t_summary, t_body, t_tags FROM mem").run();
      this.db.prepare("INSERT INTO mem_fts_w(rowid, w_title, t_summary, t_body, t_tags) SELECT rowid, w_title, t_summary, t_body, t_tags FROM mem").run();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Date.now() - t0;
  }

  // entry: 一条记忆（节或文件）。body 原文仅参与分词与 hash，不落库。
  upsertOne(entry, cfg) {
    if (this.readOnly) return false;
    const boost = cfg && cfg.titleBoost ? cfg.titleBoost : 3;
    const row = {
      id: entry.id,
      path: entry.path,
      anchor: entry.anchor || null,
      type: entry.type || "note",
      layer: entry.layer || "l1",
      title: entry.title || "",
      summary: entry.summary || "",
      tags: Array.isArray(entry.tags) ? entry.tags.join(",") : (entry.tags || ""),
      project: entry.project || null,
      agent: entry.agent || "manual",
      device: entry.device || null,
      session: entry.session || null,
      created: entry.created || Date.now(),
      updated: entry.updated || Date.now(),
      importance: entry.importance || 3,
      hash: entry.hash || null,
      size: entry.size || 0,
      mtime: entry.mtime || null,
      valid_from: entry.validFrom || entry.created || Date.now(),
      valid_to: entry.validTo || null,
      superseded_by: entry.supersededBy || null,
      refs_text: Array.isArray(entry.refs) ? entry.refs.join(",") : (entry.refs || null),
      dup_index: entry.dupIndex || 0,
      dedup_status: entry.dedupStatus || "pending",
      ai_processed: entry.aiProcessed ? 1 : 0,
      pinned: entry.pinned ? 1 : 0,
      starred: entry.starred ? 1 : 0,
      t_title: tokenize(entry.title),
      t_summary: tokenize(entry.summary),
      t_body: tokenize(entry.body),
      t_tags: tokenize(Array.isArray(entry.tags) ? entry.tags.join(" ") : entry.tags),
      w_title: weightedTitle(entry.title, boost),
    };
    this._upsert.run(...MEM_COLS.map((c) => row[c]));
    this._replaceLinks(entry.id, entry.refs);
    return true;
  }

  _replaceLinks(id, refs) {
    this._clearLinks.run(id);
    if (!Array.isArray(refs)) return;
    for (const r of refs) {
      const s = String(r);
      const kind = s.startsWith("project:") ? "project" : s.startsWith("topic:") ? "topic" : "mem";
      this._insertLink.run(id, s.replace(/^project:/, "").replace(/^topic:/, ""), kind);
    }
  }

  upsertBatch(entries, cfg) {
    if (this.readOnly) return false;
    this.db.exec("BEGIN");
    try {
      for (const e of entries) this.upsertOne(e, cfg);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  removeByPath(relPath) {
    if (this.readOnly) return false;
    this._deleteByPath.run(relPath);
    return true;
  }

  removeOne(id, relPath) {
    if (this.readOnly) return false;
    this._deleteByIdPath.run(id, relPath);
    return true;
  }

  getById(id) {
    return this._getById.get(id) || null;
  }

  counts() {
    const total = this.db.prepare("SELECT COUNT(*) AS c FROM mem").get().c;
    const projects = this.db.prepare("SELECT COUNT(DISTINCT project) AS c FROM mem WHERE project IS NOT NULL").get().c;
    const today = this.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE created >= ?").get(startOfToday()).c;
    const pending = this.db.prepare("SELECT COUNT(*) AS c FROM review_queue WHERE status = 'pending'").get().c;
    const sizeOnDisk = (() => { try { return fs.statSync(this.file).size; } catch { return 0; } })();
    return { total, projects, today, pending, sizeOnDisk };
  }

  beat(agent, tool, ok) {
    if (this.readOnly) return false;
    this.db.prepare(`
      INSERT INTO agent_beat (agent, last_call, last_tool, calls, writes, searches, errors)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        last_call = excluded.last_call,
        last_tool = excluded.last_tool,
        calls = calls + 1,
        writes = writes + excluded.writes,
        searches = searches + excluded.searches,
        errors = errors + excluded.errors
    `).run(agent, Date.now(), tool, tool === "memory_write" ? 1 : 0, tool === "memory_search" ? 1 : 0, ok ? 0 : 1);
  }

  beats() {
    return this.db.prepare("SELECT * FROM agent_beat ORDER BY last_call DESC").all();
  }

  llmLog(entry) {
    if (this.readOnly) return false;
    this.db.prepare("INSERT INTO llm_call (ts, provider, model, task, tokens_in, tokens_out, ok, latency_ms, detail) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(entry.ts || Date.now(), entry.provider || null, entry.model || null, entry.task || null,
        entry.tokensIn || 0, entry.tokensOut || 0, entry.ok === false ? 0 : 1, entry.latencyMs || 0, entry.detail || null);
  }

  llmUsageToday() {
    const r = this.db.prepare("SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS tokens, COUNT(*) AS calls FROM llm_call WHERE ts >= ?").get(startOfToday());
    return { tokens: r.tokens, calls: r.calls };
  }

  llmUsageByProvider(days) {
    const since = Date.now() - (days || 30) * 86400000;
    return this.db.prepare(`
      SELECT provider, model, task, COUNT(*) AS calls,
             SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS successRate
      FROM llm_call WHERE ts >= ?
      GROUP BY provider, model, task ORDER BY calls DESC
    `).all(since);
  }

  reviewAdd(kind, payload) {
    if (this.readOnly) return null;
    const id = "rq_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    this.db.prepare("INSERT INTO review_queue (id, kind, payload, status, created) VALUES (?, ?, ?, 'pending', ?)")
      .run(id, kind, JSON.stringify(payload), Date.now());
    return id;
  }

  reviewList(status, kind) {
    const rows = status
      ? this.db.prepare("SELECT * FROM review_queue WHERE status = ? ORDER BY created DESC LIMIT 500").all(status)
      : this.db.prepare("SELECT * FROM review_queue ORDER BY created DESC LIMIT 500").all();
    return rows
      .filter((r) => !kind || r.kind === kind)
      .map((r) => ({ ...r, payload: safeParse(r.payload) }));
  }

  reviewResolve(id, resolution) {
    if (this.readOnly) return false;
    this.db.prepare("UPDATE review_queue SET status = 'resolved', resolved = ?, resolution = ? WHERE id = ?")
      .run(Date.now(), resolution, id);
    return true;
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { MemoryIndex, startOfToday };
