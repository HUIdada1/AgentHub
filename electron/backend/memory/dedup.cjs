/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 四层递进去重：L1 精确哈希 / L2 文本近似 / L3 BM25 候选 / L4 语义判定（LLM）。
// 铁律：永不自动删除。L4 的 DELETE 与低置信 UPDATE 一律进人工确认队列；
// 「两条都留」写回学习表，下次同一对直接跳过，省 token（§25）。
"use strict";

const { tokenizeList } = require("./tokenizer.cjs");

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

function editRatio(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m && !n) return 1;
  if (!m || !n) return 0;
  if (Math.abs(m - n) / Math.max(m, n) > 0.4) return 0;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** 信息量打分（合并同类条时「保留信息量更大的」判据）；service 与 dedup 共用这一份，避免两处口径漂移 */
function informationScore({ len, tagCount, hasCode, hasEvidence, created, now }) {
  const lengthPart = Math.min(1, len / 600) * 0.4;
  const tagPart = Math.min(1, tagCount / 5) * 0.2;
  const codePart = hasCode ? 0.15 : 0;
  const evidencePart = hasEvidence ? 0.1 : 0;
  const freshPart = Math.max(0, 1 - (now - created) / (90 * 86400000)) * 0.15;
  return lengthPart + tagPart + codePart + evidencePart + freshPart;
}

class DedupEngine {
  constructor(opts) {
    this.service = opts.service;
    this.client = opts.client;
    this.emit = opts.emit || (() => {});
    this.tokensUsed = 0;
  }

  flat() {
    return this.service.flat();
  }

  _learnedPairs() {
    try {
      return JSON.parse(this.service.index.getMeta("dedup_pairs") || "[]");
    } catch {
      return [];
    }
  }

  _learn(ha, hb) {
    if (!ha || !hb) return;
    const key = [ha, hb].sort().join("|");
    const list = this._learnedPairs();
    if (list.includes(key)) return;
    list.push(key);
    this.service.index.setMeta("dedup_pairs", JSON.stringify(list.slice(-500)));
  }

  learnedList() {
    const list = this._learnedPairs();
    return list.map((key) => {
      const [a, b] = key.split("|");
      const find = (hash) => this.service.index.db.prepare("SELECT id, title FROM mem WHERE hash = ? LIMIT 1").get(hash);
      return { a, b, aTitle: find(a)?.title || "", bTitle: find(b)?.title || "" };
    });
  }

  clearLearned(pair) {
    if (!pair) {
      this.service.index.setMeta("dedup_pairs", "[]");
      return { ok: true, cleared: "all" };
    }
    const list = this._learnedPairs().filter((k) => k !== pair);
    this.service.index.setMeta("dedup_pairs", JSON.stringify(list));
    return { ok: true, cleared: pair };
  }

  /** 写入路径的同步去重检查（L1 + L2），< 50ms */
  checkSync({ title, body, tags, project, hash, type }) {
    const cfg = this.flat();
    if (cfg["dedup.enabled"] === false) return { action: "add" };

    if (cfg["dedup.l1.enabled"] !== false && hash) {
      // 复用 indexer 的常驻语句（findByHashActive）：这条检查在 writeMemory 的写入路径上，
      // 每条写入都会跑一次，原地 prepare 等于每次重新编译 SQL（indexer._prepare 的同款问题）
      const hit = this.service.index.findByHashActive(hash);
      if (hit) {
        // 「允许同身份多条目」判的是本条记忆的类别（duplicateIdentityTypes 是类别白名单），
        // 不是白名单里是否含 "daily" 字面量——原写法恒为 true，L1 命中永远不跳过。
        const typeRepeatable = this._identityTypes().includes(type);
        return typeRepeatable ? { action: "add", dupIndex: (hit.dup_index || 0) + 1, mergedFrom: hit.id } : { action: "skip", targetId: hit.id };
      }
    }

    if (cfg["dedup.l2.enabled"] !== false && title) {
      const cand = this.candidateByBm25(title, project, 3);
      const wDice = Number(cfg["dedup.l2.wDice"] ?? 0.5);
      const wEdit = Number(cfg["dedup.l2.wEdit"] ?? 0.3);
      const wTitle = Number(cfg["dedup.l2.wTitle"] ?? 0.2);
      const mergeAt = Number(cfg["dedup.l2.autoMergeThreshold"] ?? 0.9);
      const candAt = Number(cfg["dedup.l2.candidateThreshold"] ?? 0.72);
      const myTokens = new Set(tokenizeList(`${title} ${body || ""}`.slice(0, 2000)));
      for (const c of cand) {
        const otherTokens = new Set(tokenizeList(`${c.title} ${c.summary || ""}`.slice(0, 2000)));
        const score = wDice * dice(myTokens, otherTokens) + wEdit * editRatio(title, c.title) + wTitle * (title === c.title ? 1 : 0);
        if (score >= mergeAt) return { action: "merge-into", targetId: c.id, score: Math.round(score * 1000) / 1000 };
        if (score >= candAt) return { action: "queue-l4", targetId: c.id, score: Math.round(score * 1000) / 1000 };
      }
    }
    return { action: "add" };
  }

  _identityTypes() {
    const list = this.flat()["dedup.duplicateIdentityTypes"];
    return Array.isArray(list) ? list : ["incident", "fix", "daily", "log"];
  }

  candidateByBm25(text, project, k) {
    const tokens = tokenizeList(text).slice(0, 12);
    if (!tokens.length) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    const ftsTable = this.flat()["index.dualIndex"] !== false ? "mem_fts_w" : "mem_fts";
    // 参数顺序必须与 _bm25Stmt 里 WHERE 占位符一致：MATCH → valid_to → [project] → LIMIT
    const params = [match, Date.now()];
    if (project) params.push(project);
    params.push(Math.max(1, Math.min(Number(k || 8), 30)));
    try {
      return this._bm25Stmt(ftsTable, project ? 1 : 0).all(...params);
    } catch {
      return [];
    }
  }

  /** 候选查询的常驻语句（indexer._prepare 同款原则）：valid_to 的时间戳此前内联在 SQL 里，
      语句每毫秒都独一无二、永远无法缓存；改成绑定参数后 SQL 只剩 fts 表×是否按项目过滤
      4 个变体。checkSync L2 在写入热路径上（每条带标题的记忆都跑），备好后不再每次编译。 */
  _bm25Stmt(ftsTable, byProject) {
    if (!this._bm25Stmts) this._bm25Stmts = new Map();
    const key = `${ftsTable}|${byProject}`;
    let stmt = this._bm25Stmts.get(key);
    if (!stmt) {
      const where = [`${ftsTable} MATCH ?`, "(m.valid_to IS NULL OR m.valid_to > ?)"];
      if (byProject) where.push("m.project = ?");
      stmt = this.service.index.db.prepare(`
        SELECT m.id, m.title, m.summary, m.hash, m.tags, m.created, m.project, rank
        FROM ${ftsTable} JOIN mem m ON m.rowid = ${ftsTable}.rowid
        WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?
      `);
      this._bm25Stmts.set(key, stmt);
    }
    return stmt;
  }

  /** L4：LLM 四操作判定；返回 judgements */
  async judgeL4(newItem, candidates) {
    const cfg = this.flat();
    const prompt = [
      "你是记忆去重判定器。给定一条【新记忆】和若干条【已有记忆】，逐一判定。",
      "规则：",
      "- ADD：全新信息，没有已有记忆覆盖它",
      "- UPDATE：与某条讲同一件事，但新记忆信息更全、更准或修正了它",
      "- DELETE：与某条讲同一件事，但新记忆信息量更少或已被推翻",
      "- NONE：与某条完全等价，无需操作",
      "约束：1) 一次只对一个已有记忆判定；2) UPDATE/DELETE 必须给出目标 id；3) 不确定时输出 NONE（宁可漏判，不可误删）；4) 只输出 JSON。",
      "",
      "【新记忆】",
      `标题：${newItem.title}`,
      `内容：${String(newItem.body || "").slice(0, 800)}`,
      `项目：${newItem.project || "-"}  标签：${(newItem.tags || []).join(",")}`,
      "",
      "【已有记忆】",
      ...candidates.map((c) => `[${c.id}] 标题：${c.title}\n内容：${String(c.summary || "").slice(0, 300)}`),
      "",
      '输出格式：{"judgements":[{"target_id":"mem_X","event":"ADD|UPDATE|DELETE|NONE","confidence":0.0,"reason":"≤20字"}]}',
    ].join("\n");
    const result = await this.client.call({
      task: "dedup",
      system: "你是记忆去重判定器，只输出 JSON。",
      messages: [{ role: "user", content: prompt }],
      jsonMode: true,
      maxTokens: 1200,
    });
    this.tokensUsed += result.usage.input + result.usage.output;
    const text = String(result.text || "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed.judgements) ? parsed.judgements : [];
    } catch {
      return [];
    }
  }

  /**
   * 全库巡检（定时任务 consolidate 的入口）。
   * useModel=true 时对 L3 候选跑 L4；DELETE 与低置信 UPDATE 进人工队列。
   */
  async scanAll(opts = {}) {
    const cfg = this.flat();
    if (cfg["dedup.enabled"] === false) return { scanned: 0, merged: 0, queued: 0, acted: 0, tokens: 0 };
    const db = this.service.index.db;
    const pending = db.prepare(`
      SELECT id, title, summary, tags, project, layer, created, hash FROM mem
      WHERE dedup_status = 'pending' AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY created DESC LIMIT ?
    `).all(Date.now(), Number(cfg["dedup.l4.batchSize"] || 20) * 5);

    let scanned = 0;
    let merged = 0;
    let queued = 0;
    /** 巡检进度回调（调度器注入）：按条推进，用于「正在执行」卡片的百分比 */
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    // 隐私白名单：localOnlyProjects 的项目自身不进 LLM，其内容也不能作为候选进别人的 prompt
    const only = cfg["privacy.localOnlyProjects"];
    const isLocalOnly = (r) => !!(Array.isArray(only) && only.length && r && r.project && only.includes(r.project));
    // 学习表本轮不会变化（scanAll 内不调用 _learn），在循环外读一次即可：
    // 放进循环会让每行都 JSON.parse 一次最长 500 条的数组，几万条巡检退化成 O(N×M)
    const learned = this._learnedPairs();
    // 每行至少执行一次的标记语句：巡检热路径上原地 prepare 等于每行重新编译 SQL，循环外备好
    const markDone = db.prepare("UPDATE mem SET dedup_status = 'done' WHERE id = ?");
    for (const row of pending) {
      scanned++;
      if (onProgress && (scanned % 5 === 0 || scanned === pending.length)) onProgress(scanned, pending.length);
      const cand = this.candidateByBm25(row.title, row.project, cfg["dedup.l3.topK"] || 8).filter((c) => c.id !== row.id && !isLocalOnly(c));
      if (!cand.length) {
        markDone.run(row.id);
        continue;
      }
      const usable = cand.filter((c) => !learned.includes([row.hash, c.hash].sort().join("|")));
      if (!usable.length) {
        markDone.run(row.id);
        continue;
      }
      // FTS5 rank 越负越相似（与 search.cjs 的 -rank 口径一致）：强匹配要进 L4，弱匹配跳过。
      // 原公式 1-|rank|/10 方向写反——越相似的候选得分越低，永远进不了 L4
      const topScore = Math.min(1, -(usable[0].rank || 0) / 10);
      const minScore = Number(cfg["dedup.l4.minCandidateScore"] ?? 0.62);
      if (isLocalOnly(row) || !opts.useModel || cfg["dedup.l4.enabled"] === false || topScore < minScore) {
        markDone.run(row.id);
        continue;
      }
      let judgements = [];
      try {
        judgements = await this.judgeL4(row, usable.slice(0, 6));
      } catch (e) {
        this.emit({ type: "dedup", detail: `L4 判定失败（本批跳过）：${String(e.message || e).slice(0, 80)}` });
        continue;
      }
      const autoUpdate = Number(cfg["dedup.l4.autoUpdateThreshold"] ?? 0.8);
      // 铁律：删除记忆永不自动执行（原本就没有自动删除的代码路径；曾经的 dedup.l4.autoDelete
      // 配置项是假开关，已从 schema 移除——DELETE 判定一律进人工确认队列）
      for (const j of judgements) {
        const target = usable.find((c) => c.id === j.target_id);
        if (!target) continue;
        const conf = Number(j.confidence) || 0.5;
        if (j.event === "ADD" || j.event === "NONE") continue;
        if (j.event === "UPDATE" && conf >= autoUpdate && cfg["timeline.requireConfirm"] === false) {
          await this.service.markSuperseded(target.id, row.id, j.reason || "去重自动合并（高置信）");
          merged++;
        } else {
          // 同一对 (kind,newId,targetId) 已在待确认队列就不再重复进队：
          // 巡检每轮都会重扫 pending 条目，不判重会把队列刷出 N 份相同的确认项
          const dupPending = db.prepare(
            "SELECT id FROM review_queue WHERE kind = 'dedup' AND status = 'pending' AND json_extract(payload, '$.kind') = ? AND json_extract(payload, '$.newId') = ? AND json_extract(payload, '$.targetId') = ?",
          ).get(j.event, row.id, target.id);
          if (dupPending) continue;
          const dedupPayload = {
            kind: j.event,
            newId: row.id,
            targetId: target.id,
            confidence: conf,
            reason: j.reason || "",
            newTitle: row.title,
            targetTitle: target.title,
            newSummary: row.summary,
            targetSummary: target.summary,
          };
          this.service.autoConfirmReview("dedup", this.service.index.reviewAdd("dedup", dedupPayload), dedupPayload);
          queued++;
        }
      }
      markDone.run(row.id);
    }
    this.emit({ type: "dedup", scanned, merged, queued, tokens: this.tokensUsed });
    return { scanned, merged, queued, acted: merged + queued, tokens: this.tokensUsed };
  }

  /** 写入路径的异步补判（L3→L4），memory_write 返回后调用 */
  async resolveQueued(id) {
    const row = this.service.index.db.prepare("SELECT * FROM mem WHERE id = ?").get(id);
    if (!row) return { ok: false };
    const cand = this.candidateByBm25(row.title, row.project, 5).filter((c) => c.id !== id);
    if (!cand.length) return { ok: true, action: "add" };
    let judgements = [];
    try {
      judgements = await this.judgeL4(row, cand);
    } catch {
      return { ok: false, message: "判定失败（保留为独立记忆）" };
    }
    // NONE 表示「完全等价、无需操作」，不是待裁决动作：把它塞进确认队列会产出无意义的待办
    const target = judgements.find((j) => j.event !== "ADD" && j.event !== "NONE" && cand.some((c) => c.id === j.target_id));
    if (!target) {
      this.service.index.db.prepare("UPDATE mem SET dedup_status = 'done' WHERE id = ?").run(id);
      return { ok: true, action: "add" };
    }
    const conf = Number(target.confidence) || 0.5;
    const autoUpdate = Number(this.flat()["dedup.l4.autoUpdateThreshold"] ?? 0.8);
    if (target.event === "UPDATE" && conf >= autoUpdate && this.flat()["timeline.requireConfirm"] === false) {
      await this.service.markSuperseded(target.target_id, id, target.reason || "去重自动合并");
      this.service.index.db.prepare("UPDATE mem SET dedup_status = 'merged' WHERE id = ?").run(id);
      return { ok: true, action: "merged", targetId: target.target_id };
    }
    const dedupPayload = {
      kind: target.event,
      newId: id,
      targetId: target.target_id,
      confidence: conf,
      reason: target.reason || "",
      newTitle: row.title,
      targetTitle: cand.find((c) => c.id === target.target_id)?.title || "",
    };
    this.service.autoConfirmReview("dedup", this.service.index.reviewAdd("dedup", dedupPayload), dedupPayload);
    this.service.index.db.prepare("UPDATE mem SET dedup_status = 'queued' WHERE id = ?").run(id);
    return { ok: true, action: "queued", targetId: target.target_id };
  }

  status() {
    const db = this.service.index.db;
    const byStatus = db.prepare("SELECT dedup_status AS s, COUNT(*) AS c FROM mem GROUP BY dedup_status").all();
    const total = byStatus.reduce((s, r) => s + r.c, 0) || 1;
    const get = (k) => (byStatus.find((r) => r.s === k) || { c: 0 }).c;
    const queued = db.prepare("SELECT COUNT(*) AS c FROM review_queue WHERE status = 'pending'").get().c;
    const skipped = get("done");
    return {
      total,
      pending: get("pending"),
      done: skipped,
      merged: get("merged"),
      queued,
      dedupRate: Math.round((get("merged") / total) * 1000) / 10,
      learnedPairs: this._learnedPairs().length,
      layerCounts: {
        l1: this.service.index.db.prepare("SELECT COALESCE(SUM(dup_index),0) AS c FROM mem").get().c,
        learned: this._learnedPairs().length,
      },
      tokensUsed: this.tokensUsed,
      autoDeleteDisabled: true,
    };
  }

  /** 人工队列裁决：采纳新 / 留旧 / 都留 / 编辑合并 */
  async resolveQueue(id, action, payload) {
    const row = this.service.index.db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
    if (!row) return { ok: false, message: "队列项不存在" };
    // 与 service.confirmSuggestion 同口径：payload 损坏时显式失败，不冒英文异常
    let data;
    try {
      data = JSON.parse(row.payload || "{}");
    } catch {
      return { ok: false, message: "队列项数据损坏，无法解析" };
    }
    if (!data || typeof data !== "object") return { ok: false, message: "队列项数据损坏，无法解析" };
    const svc = this.service;
    if (action === "adoptNew") {
      // DELETE 也需人工确认才会走到这，两臂同处理：采纳新记忆 = 把旧记忆标失效
      await svc.markSuperseded(data.targetId, data.newId, data.reason || "人工采纳新记忆");
      svc.index.reviewResolve(id, "adoptNew");
      return { ok: true };
    }
    if (action === "keepOld") {
      const target = svc.getById(data.targetId);
      const fresh = svc.getById(data.newId);
      if (target && fresh) {
        // 把新记忆的来源并入旧记忆，然后删掉新记忆
        const targetBody = (target.body || "").trim();
        const freshBody = (fresh.body || "").trim();
        const merged = freshBody
          ? (targetBody ? `${targetBody}\n\n（来自 ${fresh.id} · ${fresh.agent || "未知"}）\n${freshBody}` : freshBody)
          : targetBody;
        await svc.updateMemory(target.id, { body: merged });
        await svc.deleteMemory(fresh.id);
      }
      svc.index.reviewResolve(id, "keepOld");
      return { ok: true };
    }
    if (action === "keepBoth") {
      const a = svc.getById(data.targetId);
      const b = svc.getById(data.newId);
      if (a && b) this._learn(a.hash, b.hash);
      svc.index.db.prepare("UPDATE mem SET dedup_status = 'done' WHERE id = ?").run(data.newId);
      svc.index.reviewResolve(id, "keepBoth");
      return { ok: true };
    }
    if (action === "merge" && payload && typeof payload.text === "string") {
      await svc.updateMemory(data.newId, { body: payload.text });
      await svc.markSuperseded(data.targetId, data.newId, "人工编辑合并");
      svc.index.reviewResolve(id, "merged");
      return { ok: true };
    }
    if (action === "dismiss") {
      svc.index.reviewResolve(id, "dismissed");
      return { ok: true };
    }
    return { ok: false, message: "未知裁决动作" };
  }
}

module.exports = { DedupEngine, dice, editRatio, informationScore };
