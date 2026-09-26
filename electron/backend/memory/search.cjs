/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 检索层：FTS5 双索引 + ORDER BY rank + 应用层混合评分 + 同义词扩展 + 图扩散。
// 纪律（专项方案）：不用 bm25() 排序函数、不用子查询过滤、混合评分不在 SQL 里。
"use strict";

const fs = require("fs");
const path = require("path");

const { andQuery, phraseQuery, tokenizeList } = require("./tokenizer.cjs");

function loadSynonyms(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

// 同义词扩展：词 → 含自身的词组（多轮检索 + 降权合并，修正清单采纳）
function expandQuery(tokens, synonyms) {
  const groups = [];
  for (const t of tokens) {
    const group = new Set([t]);
    for (const [key, list] of Object.entries(synonyms)) {
      const words = [key, ...(Array.isArray(list) ? list : [])].map((x) => String(x).toLowerCase());
      if (words.includes(t.toLowerCase())) for (const w of words) group.add(w);
    }
    groups.push([...group]);
  }
  return groups;
}

class MemorySearch {
  constructor(index, rootDir) {
    this.index = index;
    this.synonymsFile = path.join(rootDir, "index", "synonyms.json");
  }

  // 主检索：超取 recallTopK → 应用层重排 → 返回 finalTopK（只回摘要，不回全文）
  search(query, opts = {}, cfg = {}) {
    const db = this.index.db;
    if (!db) return { results: [], total: 0, tookMs: 0 };
    const t0 = Date.now();

    const limit = Math.min(Math.max(1, opts.limit || cfg["search.finalTopK"] || 8), 50);
    const offset = Math.max(0, Number(opts.offset) || 0);
    // 翻页时召回窗口要盖住 offset，否则第 2 页起永远为空（召回上限 200 不变）
    const recall = Math.min(Math.max(limit + offset, cfg["search.recallTopK"] || 20), 200);
    const includeSuperseded = !!opts.includeSuperseded;

    const match = this._buildMatch(query, cfg);
    if (!match) return { results: [], total: 0, tookMs: Date.now() - t0 };

    const where = ["mem_fts_w MATCH ?"];
    const params = [match];
    if (opts.project) { where.push("m.project = ?"); params.push(opts.project); }
    if (opts.agent) { where.push("m.agent = ?"); params.push(opts.agent); }
    if (opts.layer) { where.push("m.layer = ?"); params.push(opts.layer); }
    // 与 list() 同口径的四个过滤：类别精确 / 标签包含（逗号包裹防子串误命中）/ 星标 / 置顶
    if (opts.type) { where.push("m.type = ?"); params.push(opts.type); }
    if (opts.tag) {
      where.push("(',' || m.tags || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${String(opts.tag).replace(/[%_\\]/g, (mm) => "\\" + mm)},%`);
    }
    if (opts.starred) where.push("m.starred = 1");
    if (opts.pinned) where.push("m.pinned = 1");
    if (!includeSuperseded) where.push("(m.valid_to IS NULL OR m.valid_to > " + Date.now() + ")");

    // index.dualIndex=false → 退回保真索引（标题加权只在双索引模式下启用）
    const useWeighted = cfg["index.dualIndex"] !== false;
    const ftsTable = useWeighted ? "mem_fts_w" : "mem_fts";
    const matchWhere = where.map((w) => w.replace("mem_fts_w", ftsTable));
    const sql = `
      SELECT m.id, m.path, m.anchor, m.project, m.agent, m.layer, m.type,
             m.title, m.summary, m.tags, m.created, m.updated, m.importance,
             m.pinned, m.starred, m.valid_to, m.superseded_by, rank
      FROM ${ftsTable}
      JOIN mem m ON m.rowid = ${ftsTable}.rowid
      WHERE ${matchWhere.join(" AND ")}
      ORDER BY rank
      LIMIT ?`;
    params.push(recall);

    let rows = [];
    let hitTotal = 0;
    let lastFallbackReason = "";
    try {
      rows = db.prepare(sql).all(...params);
      // rank 序取的是召回量，真实命中总数另算一次（界面「共 N 条」不能显示成召回上限）；
      // 召回窗口没装满时命中数就等于行数，不必再跑一次同条件的 COUNT
      if (rows.length < recall) {
        hitTotal = rows.length;
      } else {
        const countParams = params.slice(0, params.length - 1);
        hitTotal = db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable} JOIN mem m ON m.rowid = ${ftsTable}.rowid WHERE ${matchWhere.join(" AND ")}`).get(...countParams).c;
      }
    } catch (firstError) {
      // MATCH 语法容错：用户输入含特殊字符（或同义词表被改坏）时按字面量重试一次。
      // 这里不能完全静默：调试台和日志要能看到"这次走了降级路径"
      lastFallbackReason = String(firstError && firstError.message || firstError);
      const fallback = phraseQuery(query);
      if (!fallback) return { results: [], total: 0, tookMs: Date.now() - t0 };
      params[0] = fallback;
      try {
        rows = db.prepare(sql).all(...params);
        hitTotal = rows.length;
      } catch { rows = []; hitTotal = 0; }
    }

    const scored = this._rescore(rows, opts, cfg);
    const graphBoosted = this._graphExpand(scored, cfg, opts).sort((a, b) => b.score - a.score);
    const finalRows = graphBoosted.slice(offset, offset + limit);

    return {
      fallback: lastFallbackReason || undefined,
      results: finalRows.map((r) => ({
        id: r.id, path: r.path, anchor: r.anchor, project: r.project, agent: r.agent,
        layer: r.layer, type: r.type, title: r.title, summary: r.summary,
        tags: splitTags(r.tags),
        created: r.created, updated: r.updated, importance: r.importance,
        pinned: !!r.pinned, starred: !!r.starred,
        superseded: !!r.superseded_by || (r.valid_to != null && r.valid_to <= Date.now()),
        score: Math.round(r.score * 1000) / 1000,
        scoreParts: r.scoreParts,
      })),
      total: hitTotal || rows.length,
      tookMs: Date.now() - t0,
    };
  }

  _buildMatch(query, cfg) {
    const tokens = tokenizeList(query);
    if (!tokens.length) return "";
    const useSynonyms = cfg["search.synonymsEnabled"] !== false;
    if (!useSynonyms) return andQuery(query);
    const synonyms = loadSynonyms(this.synonymsFile);
    const groups = expandQuery(tokens, synonyms);
    // 每组内 OR，组间 AND；扩展词与原词同组同权（FTS5 无法对 OR 加权，降权在多轮合并实现成本高，此处以组内 OR 近似）
    return groups
      .map((g) => (g.length === 1 ? `"${g[0]}"` : "(" + g.map((w) => `"${w}"`).join(" OR ") + ")"))
      .join(" AND ");
  }

  _rescore(rows, opts, cfg) {
    const now = Date.now();
    const w = {
      bm25: num(cfg["search.weightBm25"], 0.5),
      recency: num(cfg["search.weightRecency"], 0.15),
      importance: num(cfg["search.weightImportance"], 0.1),
      affinity: num(cfg["search.weightAffinity"], 0.15),
      layer: num(cfg["search.weightLayer"], 0.05),
    };
    const halfLifeMs = num(cfg["search.timeDecayHalfLife"], 30) * 86400000;
    const ranks = rows.map((r) => -r.rank);
    const maxRank = Math.max(...ranks, 1e-9);
    return rows.map((r) => {
      const bm25Norm = -r.rank / maxRank;
      const age = Math.max(0, now - (r.created || now));
      const recency = halfLifeMs > 0 ? Math.exp(-0.693 * age / halfLifeMs) : 1;
      const importance = (r.importance || 3) / 5;
      let affinity = 0;
      if (opts.project && r.project === opts.project) affinity += 0.7;
      if (opts.agent && r.agent === opts.agent) affinity += 0.3;
      const layer = r.layer === "l2" ? 1 : 0.4;
      const pinBoost = r.pinned ? 0.5 : 0;
      const parts = {
        bm25: w.bm25 * bm25Norm,
        recency: w.recency * recency,
        importance: w.importance * importance,
        affinity: w.affinity * affinity,
        layer: w.layer * layer,
        graph: 0,
        pinned: pinBoost,
      };
      const score = parts.bm25 + parts.recency + parts.importance + parts.affinity + parts.layer + parts.pinned;
      return { ...r, score, scoreParts: parts };
    }).sort((a, b) => b.score - a.score);
  }

  /** 图扩散：沿 refs/双链把命中的邻居按 depth 跳扩进来（邻居去重，权重随跳数衰减） */
  _graphExpand(scored, cfg, opts) {
    const depth = Math.min(num(cfg["search.graphExpansionDepth"], 1), 3);
    const max = num(cfg["search.graphExpansionMax"], 5);
    if (!depth || !max || !scored.length) return scored;
    const db = this.index.db;
    const known = new Set(scored.map((r) => r.id));
    const weight = num(cfg["search.weightGraph"], 0.05);
    const fetchStmt = db.prepare("SELECT * FROM mem WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)");
    const getNei = db.prepare("SELECT dst AS id FROM mem_link WHERE src = ? UNION SELECT src AS id FROM mem_link WHERE dst = ?");
    const extra = [];
    let frontier = scored.slice(0, 10).map((r) => r.id);
    for (let hop = 1; hop <= depth && extra.length < max; hop++) {
      const next = [];
      for (const id of frontier) {
        for (const n of getNei.all(id, id)) {
          if (known.has(n.id)) continue;
          known.add(n.id);
          const row = fetchStmt.get(n.id, Date.now());
          if (!row) continue;
          // 邻居也要服从显式过滤：在 projA 里检索不该带出 projB 的关联记忆
          if (opts && opts.project && row.project !== opts.project) continue;
          if (opts && opts.agent && row.agent !== opts.agent) continue;
          if (opts && opts.layer && row.layer !== opts.layer) continue;
          if (opts && opts.type && row.type !== opts.type) continue;
          if (opts && opts.tag && !("," + (row.tags || "") + ",").includes("," + String(opts.tag) + ",")) continue;
          if (opts && opts.starred && !row.starred) continue;
          if (opts && opts.pinned && !row.pinned) continue;
          const w = weight / hop;
          row.score = w;
          row.scoreParts = { bm25: 0, recency: 0, importance: 0, affinity: 0, layer: 0, graph: w, pinned: 0 };
          extra.push(row);
          next.push(n.id);
          if (extra.length >= max) break;
        }
        if (extra.length >= max) break;
      }
      if (!next.length) break;
      frontier = next;
    }
    return scored.concat(extra);
  }

  // 演化链：数据语义为 A 被 B 取代 → A.superseded_by = B.id，链形态 A → B → C。
  // 从任意节点出发，先反查"谁的 superseded_by = 我"走到链首，再沿 superseded_by 走到链尾。
  timeline(id) {
    const db = this.index.db;
    const start = db.prepare("SELECT * FROM mem WHERE id = ?").get(id);
    if (!start) return [];
    let head = start;
    let guard = 0;
    while (guard++ < 50) {
      const prev = db.prepare("SELECT * FROM mem WHERE superseded_by = ?").get(head.id);
      if (!prev) break;
      head = prev;
    }
    const chain = [];
    const seen = new Set();
    let node = head;
    guard = 0;
    while (node && guard++ < 50 && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push(node);
      node = node.superseded_by ? db.prepare("SELECT * FROM mem WHERE id = ?").get(node.superseded_by) : null;
    }
    return chain.map((r) => ({
      id: r.id, title: r.title, created: r.created,
      validFrom: r.valid_from, validTo: r.valid_to, supersededBy: r.superseded_by,
      current: r.id === id,
    }));
  }

  // memory_digest：每项目最近 N 条 + 关键标签，总行数受限（纯 SQL，不走 FTS）
  digest(maxLines, perProject) {
    const db = this.index.db;
    const limit = Math.min(Math.max(20, maxLines || 200), 1000);
    const per = perProject || 2;
    // 行数上限真的要落到 SQL：一行摘要 ≈ 2 行文本，多留一倍余量
    const maxRows = Math.max(per, Math.floor(limit / 2));
    const rows = db.prepare(`
      SELECT project, title, summary, created, tags FROM (
        SELECT project, title, summary, created, tags,
               ROW_NUMBER() OVER (PARTITION BY project ORDER BY pinned DESC, created DESC) AS rn
        FROM mem
        WHERE layer = 'l1' AND (valid_to IS NULL OR valid_to > ?)
      ) WHERE rn <= ?
      ORDER BY project, rn
      LIMIT ?
    `).all(Date.now(), per, maxRows);
    const counts = db.prepare(`
      SELECT COALESCE(project, '(general)') AS p, COUNT(*) AS c, MAX(created) AS latest
      FROM mem WHERE valid_to IS NULL OR valid_to > ? GROUP BY p ORDER BY latest DESC
    `).all(Date.now());
    return { rows, counts, limit };
  }

  recent(opts = {}) {
    const db = this.index.db;
    const days = Math.min(Math.max(1, opts.days || 7), 365);
    const since = Date.now() - days * 86400000;
    const where = ["created >= ?", "(valid_to IS NULL OR valid_to > ?)"];
    const params = [since, Date.now()];
    if (opts.project) { where.push("project = ?"); params.push(opts.project); }
    if (opts.agent) { where.push("agent = ?"); params.push(opts.agent); }
    return db.prepare(`
      SELECT id, path, anchor, project, agent, layer, type, title, summary, tags, created, importance
      FROM mem WHERE ${where.join(" AND ")}
      ORDER BY pinned DESC, created DESC LIMIT ?
    `).all(...params, Math.min(opts.limit || 50, 500)).map((r) => ({ ...r, tags: splitTags(r.tags) }));
  }

  // 浏览列表（非检索）：分页 + 过滤
  list(opts = {}) {
    const db = this.index.db;
    const where = ["1=1"];
    const params = [];
    if (opts.project) { where.push("project = ?"); params.push(opts.project); }
    if (opts.agent) { where.push("agent = ?"); params.push(opts.agent); }
    if (opts.layer) { where.push("layer = ?"); params.push(opts.layer); }
    if (opts.type) { where.push("type = ?"); params.push(opts.type); }
    if (opts.tag) {
      where.push("(',' || tags || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${String(opts.tag).replace(/[%_\\]/g, (m) => "\\" + m)},%`);
    }
    if (!opts.includeSuperseded) where.push("(valid_to IS NULL OR valid_to > " + Date.now() + ")");
    if (opts.starred) where.push("starred = 1");
    if (opts.pinned) where.push("pinned = 1");
    if (opts.after) { where.push("created >= ?"); params.push(opts.after); }
    if (opts.before) { where.push("created < ?"); params.push(opts.before); }
    const page = Math.max(0, opts.page || 0);
    const size = Math.min(Math.max(10, opts.pageSize || 50), 500);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM mem WHERE ${where.join(" AND ")}`).get(...params).c;
    const rows = db.prepare(`
      SELECT id, path, anchor, project, agent, layer, type, title, summary, tags,
             created, updated, importance, pinned, starred, valid_to, superseded_by
      FROM mem WHERE ${where.join(" AND ")}
      ORDER BY pinned DESC, created DESC
      LIMIT ? OFFSET ?
    `).all(...params, size, page * size);
    // tags 在库里是逗号分隔串，对外统一成数组：与 search/recent 同一口径，
    // 否则前端得同时兼容两种形态（历史上就是这么踩的）
    return { rows: rows.map((r) => ({ ...r, tags: splitTags(r.tags) })), total, page, pageSize: size };
  }

  heatmap(days) {
    const db = this.index.db;
    const since = Date.now() - (days || 365) * 86400000;
    return db.prepare(`
      SELECT date(created / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
      FROM mem WHERE created >= ?
      GROUP BY day ORDER BY day
    `).all(since);
  }

  // 链接图统计与诊断
  graphStats() {
    const db = this.index.db;
    const nodes = db.prepare("SELECT COUNT(*) AS c FROM mem").get().c;
    const edges = db.prepare("SELECT COUNT(*) AS c FROM mem_link").get().c;
    const broken = db.prepare(`
      SELECT COUNT(*) AS c FROM mem_link l WHERE l.kind = 'mem' AND NOT EXISTS (SELECT 1 FROM mem m WHERE m.id = l.dst)
    `).get().c;
    const isolated = db.prepare(`
      SELECT COUNT(*) AS c FROM mem m WHERE NOT EXISTS (SELECT 1 FROM mem_link l WHERE l.src = m.id OR l.dst = m.id)
    `).get().c;
    return { nodes, edges, broken, isolated };
  }

  diagnose(rootDir, walkFiles) {
    const db = this.index.db;
    const files = new Set(walkFiles());
    const indexed = db.prepare("SELECT DISTINCT path FROM mem").all().map((r) => r.path);
    const orphanRows = indexed.filter((p) => !files.has(p));
    const indexedSet = new Set(indexed);
    const unindexed = [...files].filter((p) => !indexedSet.has(p));
    return { orphanRows, unindexed, fts: this.index.selfCheck() };
  }
}

/** 库里的 tags 是逗号分隔串，对外统一成数组 */
function splitTags(v) {
  if (Array.isArray(v)) return v;
  return String(v == null ? "" : v).split(",").map((x) => x.trim()).filter(Boolean);
}

function num(v, def) {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

module.exports = { MemorySearch, loadSynonyms };
