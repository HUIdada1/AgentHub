/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · AI 处理任务实现：抽取（摘要/重要度）、打标、归类建议、失效判定、L2 蒸馏、人格画像。
// 每个任务都是「取素材 → 调模型（走 LlmClient 的标签路由）→ 校验结构 → 回写 MD + 索引 → 记账」，
// 失败一律不破坏已有数据；结构化输出解析失败只跳过本批，不写半成品。
"use strict";

const fs = require("fs");
const path = require("path");

const { newId, normalizeForHash, sha256 } = require("./store.cjs");
const { memoryRelPath } = require("./layout.cjs");
const { normalizeTags } = require("./service.cjs");

const MAX_BODY_FOR_PROMPT = 700;

function extractJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  // 逐字符配平括号，容错模型在 JSON 后附带解释文字
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(slice.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

class MemoryTasks {
  constructor(opts) {
    this.service = opts.service;
    this.client = opts.client;
    this.emit = opts.emit || (() => {});
    this.rootDir = opts.rootDir;
  }

  flat() {
    return this.service.flat();
  }

  _pending(limit, extraWhere = "") {
    const db = this.service.index.db;
    return db.prepare(`
      SELECT id, path, anchor, type, layer, title, summary, tags, project, agent, importance, created
      FROM mem
      WHERE ai_processed = 0 AND (valid_to IS NULL OR valid_to > ?) ${extraWhere}
      ORDER BY created DESC LIMIT ?
    `).all(Date.now(), limit).filter((r) => this._allowedByPrivacy(r));
  }

  /** 隐私白名单：列入 localOnlyProjects 的项目不进模型（本地算法任务不受影响） */
  _allowedByPrivacy(row) {
    const cfg = this.flat();
    const only = cfg["privacy.localOnlyProjects"];
    if (Array.isArray(only) && only.length && row.project && only.includes(row.project)) return false;
    return true;
  }

  _markProcessed(ids) {
    const db = this.service.index.db;
    const stmt = db.prepare("UPDATE mem SET ai_processed = 1 WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const id of ids) stmt.run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- 任务 1~3：抽取（摘要 + 重要度）、打标 ----------

  async runExtract(batchSize) {
    const rows = this._pending(batchSize || 20);
    if (!rows.length) return { processed: 0, tokens: 0, detail: "没有待处理的记忆" };
    const bodies = this._readBodies(rows.map((r) => r.id));
    const items = rows.map((r, i) => ({ i: i + 1, row: r, body: (bodies.get(r.id) || "").slice(0, MAX_BODY_FOR_PROMPT) }));
    const prompt = [
      "以下是用户的一批原始记忆记录。请为每条：",
      "(a) 补一个 ≤120 字的中文摘要（抓住结论与关键细节，不要复述标题）",
      "(b) 判断重要度 1~5（5=重要决策/结论，3=日常记录，1=闲聊）",
      "只输出严格 JSON 数组，形如 [{\"i\":1,\"summary\":\"...\",\"importance\":3}]，不要任何解释文字。",
      "",
      ...items.map((x) => `[${x.i}] 标题：${x.row.title}\n内容：${x.body}`),
    ].join("\n");

    const result = await this.client.call({
      task: "extract",
      system: "你是记忆整理助手，只输出 JSON。",
      messages: [{ role: "user", content: prompt }],
      jsonMode: true,
      maxTokens: Math.min(4000, 300 + items.length * 160),
    });

    const parsed = extractJson(result.text);
    if (!Array.isArray(parsed)) {
      return { processed: 0, tokens: result.usage.input + result.usage.output, detail: "模型返回的结构无法解析，本批跳过（下轮重试）" };
    }
    let done = 0;
    for (const entry of parsed) {
      const target = items.find((x) => Number(entry.i) === x.i);
      if (!target) continue;
      const patch = {};
      if (entry.summary && String(entry.summary).trim()) patch.summary = String(entry.summary).trim().slice(0, 240);
      const imp = Number(entry.importance);
      if (Number.isFinite(imp) && imp >= 1 && imp <= 5 && target.row.importance === 3) patch.importance = Math.round(imp);
      if (Object.keys(patch).length) {
        await this.service.updateMemory(target.row.id, patch);
        done++;
      }
    }
    this._markProcessed(rows.map((r) => r.id));
    return { processed: rows.length, updated: done, tokens: result.usage.input + result.usage.output, detail: `处理 ${rows.length} 条，更新 ${done} 条` };
  }

  async runTag(batchSize) {
    const rows = this._pending(batchSize || 20);
    if (!rows.length) return { processed: 0, tokens: 0, detail: "没有待处理的记忆" };
    const existing = this._topTags(40);
    const bodies = this._readBodies(rows.map((r) => r.id));
    const items = rows.map((r, i) => ({ i: i + 1, row: r, body: (bodies.get(r.id) || "").slice(0, MAX_BODY_FOR_PROMPT) }));
    const prompt = [
      "为每条记忆抽 2~5 个标签（中文优先，专有名词保留原形）。优先复用已有标签；只有确实不覆盖时才造新标签。",
      `已有标签（供复用）：${existing.join("、")}`,
      '只输出严格 JSON 数组，形如 [{"i":1,"tags":["索引","性能"]}]。',
      "",
      ...items.map((x) => `[${x.i}] 标题：${x.row.title}\n内容：${x.body}`),
    ].join("\n");

    const result = await this.client.call({
      task: "tag",
      system: "你是打标签助手，只输出 JSON。",
      messages: [{ role: "user", content: prompt }],
      jsonMode: true,
      maxTokens: Math.min(2500, 200 + items.length * 80),
    });
    const parsed = extractJson(result.text);
    if (!Array.isArray(parsed)) {
      return { processed: 0, tokens: result.usage.input + result.usage.output, detail: "标签结构无法解析，本批跳过" };
    }
    let done = 0;
    for (const entry of parsed) {
      const target = items.find((x) => Number(entry.i) === x.i);
      if (!target || !Array.isArray(entry.tags)) continue;
      const merged = normalizeTags([...(target.row.tags ? String(target.row.tags).split(",") : []), ...entry.tags]);
      if (merged.length) {
        await this.service.updateMemory(target.row.id, { tags: merged });
        done++;
      }
    }
    this._markProcessed(rows.map((r) => r.id));
    return { processed: rows.length, updated: done, tokens: result.usage.input + result.usage.output, detail: `打标 ${done} 条` };
  }

  _topTags(limit) {
    const rows = this.service.index.db.prepare("SELECT tags FROM mem WHERE tags IS NOT NULL AND tags != ''").all();
    const counter = new Map();
    for (const r of rows) for (const t of String(r.tags).split(",")) counter.set(t.trim(), (counter.get(t.trim()) || 0) + 1);
    return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((x) => x[0]).filter(Boolean);
  }

  // ---------- 任务 4：归类建议（纯本地，零 token） ----------

  runClassify() {
    const generalRows = this.service.index.db.prepare(`
      SELECT id, title, path, summary FROM mem
      WHERE (project IS NULL OR project = '') AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY created DESC LIMIT 100
    `).all(Date.now());
    const threshold = Number(this.flat()["classify.fuzzyThreshold"] || 0.62);
    let suggested = 0;
    for (const row of generalRows) {
      const hit = this.service.registry.suggest(row.title, threshold);
      if (!hit) continue;
      const dup = this.service.index.db.prepare(
        "SELECT id FROM review_queue WHERE kind = 'classify' AND status = 'pending' AND json_extract(payload, '$.memoryId') = ?",
      ).get(row.id);
      if (dup) continue;
      this.service.index.reviewAdd("classify", {
        slug: hit.slug, name: hit.name, score: hit.score,
        candidate: row.title, memoryId: row.id, title: row.title, path: row.path,
      });
      suggested++;
    }
    return { processed: generalRows.length, updated: suggested, tokens: 0, detail: `扫描 ${generalRows.length} 条未归类，产出 ${suggested} 条建议` };
  }

  // ---------- 任务 5：失效判定（双时间轴建议，永不自动改） ----------

  async runSupersede(batchSize) {
    if (this.flat()["timeline.enabled"] === false) return { processed: 0, tokens: 0, detail: "双时间轴已关闭（配置项 timeline.enabled）" };
    if (this.flat()["timeline.autoDetect"] === false) return { processed: 0, tokens: 0, detail: "已关闭自动识别取代（配置项 timeline.autoDetect）" };
    const db = this.service.index.db;
    const groups = db.prepare(`
      SELECT COALESCE(project, '') AS project, COUNT(*) AS c FROM mem
      WHERE layer = 'l2' AND valid_to IS NULL AND superseded_by IS NULL
      GROUP BY COALESCE(project, '') HAVING c > 1 LIMIT 5
    `).all().filter((g) => this._allowedByPrivacy({ project: g.project }));
    if (!groups.length) return { processed: 0, tokens: 0, detail: "没有可判定的 L2 记忆组" };
    const requireConfirm = this.flat()["timeline.requireConfirm"] !== false;
    const autoApply = this.flat()["auto.tasks.supersede.autoApplyConfidence"];
    let suggestions = 0;
    let applied = 0;
    let tokens = 0;

    for (const g of groups) {
      const rows = db.prepare(`
        SELECT id, title, summary, created, tags FROM mem
        WHERE layer = 'l2' AND valid_to IS NULL AND superseded_by IS NULL
          AND COALESCE(project, '') = ?
        ORDER BY created DESC LIMIT ?
      `).all(g.project, Math.min(batchSize || 20, 12));
      if (rows.length < 2) continue;
      const prompt = [
        "以下是同一项目下的若干条事实记录。请判断是否存在「后者推翻前者」的关系。",
        "只在事实明确矛盾时判定为推翻；时间不同但都成立的不要判。",
        '只输出严格 JSON，形如 {"pairs":[{"oldId":"mem_x","newId":"mem_y","confidence":0.9,"reason":"≤20字"}]}；没有则输出 {"pairs":[]}。',
        "",
        ...rows.map((r) => `[${r.id}] (${new Date(r.created).toISOString().slice(0, 10)}) ${r.title}：${r.summary || ""}`),
      ].join("\n");
      const result = await this.client.call({
        task: "supersede",
        system: "你是事实一致性判定器，只输出 JSON。",
        messages: [{ role: "user", content: prompt }],
        jsonMode: true,
        maxTokens: 1200,
      });
      tokens += result.usage.input + result.usage.output;
      const parsed = extractJson(result.text) || {};
      const pairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
      for (const p of pairs) {
        if (!p.oldId || !p.newId || p.oldId === p.newId) continue;
        const conf = Number(p.confidence) || 0.5;
        if (!requireConfirm && autoApply && conf >= Number(autoApply)) {
          const r = await this.service.markSuperseded(p.oldId, p.newId, p.reason || "AI 高置信判定");
          if (r.ok) applied++;
          continue;
        }
        this.service.index.reviewAdd("supersede", {
          oldId: p.oldId, newId: p.newId, confidence: conf,
          reason: p.reason || "", project: g.project,
          oldTitle: rows.find((x) => x.id === p.oldId)?.title,
          newTitle: rows.find((x) => x.id === p.newId)?.title,
        });
        suggestions++;
      }
    }
    this.emit({ type: "supersede-suggest", count: suggestions });
    return { processed: groups.length, updated: suggestions + applied, tokens, detail: `产出 ${suggestions} 条待确认 + 自动应用 ${applied} 条` };
  }

  // ---------- 任务 6：L2 蒸馏（按项目，增量优先） ----------

  async runDistill(opts = {}) {
    const cfg = this.flat();
    if (cfg["deep.enabled"] === false) return { processed: 0, tokens: 0, detail: "深层记忆已关闭（配置项 deep.enabled）" };
    const db = this.service.index.db;
    const maxPerProject = Number(cfg["deep.distillMaxPerProject"] || 200);
    const projects = (opts.project
      ? [{ project: opts.project }]
      : db.prepare(`
          SELECT COALESCE(project, '') AS project, COUNT(*) AS c FROM mem
          WHERE layer = 'l1' AND (valid_to IS NULL OR valid_to > ?)
          GROUP BY COALESCE(project, '') ORDER BY c DESC LIMIT 20
        `).all(Date.now())
    ).filter((p) => this._allowedByPrivacy({ project: p.project }));
    if (!projects.length) return { processed: 0, tokens: 0, detail: "没有可蒸馏的项目" };

    let tokens = 0;
    let written = 0;
    let writtenBefore = 0;
    let done = 0;
    const reports = [];

    for (const p of projects) {
      const rows = db.prepare(`
        SELECT id, title, summary, created, tags FROM mem
        WHERE layer = 'l1' AND COALESCE(project, '') = ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY importance DESC, created DESC LIMIT ?
      `).all(p.project, Date.now(), maxPerProject);
      if (rows.length < 5) continue; // 少于 5 条素材蒸馏不出稳定结论
      const prompt = [
        "你是知识蒸馏器。以下是某项目最近的原始记忆记录。",
        "请输出严格 JSON：",
        '{"knowledge":[{"title":"","body":"","tags":[]}],"decisions":[{"title":"","body":"","reason":"","tags":[]}],"glossary":[{"term":"","meaning":""}],"supersedeSuggestions":[{"oldId":"","reason":""}]}',
        "要求：只输出 JSON；每条 body ≤300 字；不要编造原文没有的信息；没有内容就返回空数组。",
        "",
        ...rows.map((r) => `[${r.id}] ${r.title}：${r.summary || ""}`),
      ].join("\n");
      let result;
      try {
        result = await this.client.call({
          task: "distill",
          system: "你是知识蒸馏器，只输出 JSON。",
          messages: [{ role: "user", content: prompt }],
          jsonMode: true,
          maxTokens: 4000,
        });
      } catch (e) {
        reports.push(`${p.project || "(general)"}：跳过（${String(e.message || e).slice(0, 80)}）`);
        continue;
      }
      tokens += result.usage.input + result.usage.output;
      const parsed = extractJson(result.text);
      if (!parsed) {
        reports.push(`${p.project || "(general)"}：结构无法解析，跳过`);
        continue;
      }
      const slug = p.project || null;
      const today = new Date().toISOString().slice(0, 10);
      for (const item of Array.isArray(parsed.knowledge) ? parsed.knowledge : []) {
        const w = await this._writeL2({
          slug, today, type: "knowledge", title: item.title, body: item.body,
          tags: item.tags, project: p.project, evidence: rows.slice(0, 12).map((r) => r.id),
        });
        if (w) written++;
      }
      for (const item of Array.isArray(parsed.decisions) ? parsed.decisions : []) {
        const body = item.reason ? `${item.body}\n\n理由：${item.reason}` : item.body;
        const w = await this._writeL2({
          slug, today, type: "decision", title: item.title, body,
          tags: item.tags, project: p.project, evidence: rows.slice(0, 12).map((r) => r.id),
        });
        if (w) written++;
      }
      if (Array.isArray(parsed.glossary) && parsed.glossary.length) {
        this._appendGlossary(slug, parsed.glossary);
      }
      for (const s of Array.isArray(parsed.supersedeSuggestions) ? parsed.supersedeSuggestions : []) {
        if (!s.oldId) continue;
        this.service.index.reviewAdd("supersede", { oldId: s.oldId, newId: null, confidence: 0.6, reason: s.reason || "蒸馏时的矛盾提示", project: p.project });
      }
      done++;
      reports.push(`${p.project || "(general)"}：素材 ${rows.length} 条 → 新增 L2 ${written - writtenBefore} 条`);
      writtenBefore = written;
    }

    this.service.index.setMeta("lastDistillAt", String(Date.now()));
    const reportFile = this._writeReport("distill", "蒸馏报告", ["## 各项目处理结果", ...reports.map((r) => `- ${r}`), "", `token 消耗：${tokens}`]);
    return { processed: done, updated: written, tokens, detail: `蒸馏 ${done} 个项目，新增 L2 ${written} 条`, report: reportFile };
  }

  async _writeL2({ slug, today, type, title, body, tags, project, evidence }) {
    if (!title || !body) return false;
    const clean = String(body).trim().slice(0, 1200);
    const hash = sha256(normalizeForHash(`${title}\n${clean}`));
    const dup = this.service.index.db.prepare("SELECT id FROM mem WHERE hash = ? AND (valid_to IS NULL OR valid_to > ?)").get(hash, Date.now());
    if (dup) return false;
    const id = newId();
    const existing = this.service.index.db.prepare(
      "SELECT id, summary, path FROM mem WHERE layer='l2' AND type = ? AND title = ? AND COALESCE(project,'') = ? AND (valid_to IS NULL OR valid_to > ?)",
    ).get(type, title, project || "", Date.now());
    if (existing) {
      // 同标题的 L2：走 UPDATE 语义（追加新内容，保留历史）
      const cur = this.service.getById(existing.id);
      await this.service.updateMemory(existing.id, {
        body: `${cur.body}\n\n---\n\n${clean}`,
        tags: normalizeTags([...(cur.tags || []), ...(Array.isArray(tags) ? tags : [])]),
      });
      return true;
    }
    const r = await this.service.writeMemory({
      title,
      body: `${clean}\n\n证据：${(evidence || []).join("、")}`,
      type,
      layer: "l2",
      project: project || undefined,
      agent: "distill",
      tags: Array.isArray(tags) ? tags : [],
      importance: type === "decision" ? 4 : 3,
      summary: clean.slice(0, 120),
    });
    void slug;
    void today;
    return !!r.ok;
  }

  _appendGlossary(slug, items) {
    const rel = slug ? `projects/${slug}/l2/glossary.md` : `general/l2/glossary.md`;
    const file = path.join(this.rootDir, rel);
    const lines = items
      .filter((x) => x && x.term && x.meaning)
      .map((x) => `- ${String(x.term).trim()} :: ${String(x.meaning).trim().slice(0, 200)}`);
    if (!lines.length) return;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const merged = existing ? `${existing.trimEnd()}\n${lines.filter((l) => !existing.includes(l.split(" :: ")[0])).join("\n")}\n` : `${lines.join("\n")}\n`;
    // 词典文件带上稳定 id 的 frontmatter：否则每次重建索引都会给它分配新随机 id
    const head = existing && existing.startsWith("---") ? "" : "---\nid: glossary-entries\ntype: knowledge\nlayer: l2\ntitle: 术语表\n---\n\n";
    this.service.store.writeAtomic(rel, head + merged, { backup: true });
    this.service.reindexFile(rel);
  }

  // ---------- 任务 8：人格画像 ----------

  async runProfile(opts = {}) {
    const cfg = this.flat();
    if (cfg["deep.enabled"] === false) return { processed: 0, tokens: 0, detail: "深层记忆已关闭（配置项 deep.enabled）" };
    if (cfg["deep.personaEnabled"] === false) return { processed: 0, tokens: 0, detail: "画像生成已关闭（配置项 deep.personaEnabled）" };
    const db = this.service.index.db;
    const minMemories = Number(cfg["deep.personaMinMemories"] || 30);
    const total = db.prepare("SELECT COUNT(*) AS c FROM mem WHERE valid_to IS NULL OR valid_to > ?").get(Date.now()).c;
    if (total < minMemories) {
      return { processed: 0, tokens: 0, detail: `记忆还太少（${total}/${minMemories} 条），先积累一些再做画像` };
    }
    const rows = db.prepare(`
      SELECT id, title, summary, layer, project, agent, tags, created FROM mem
      WHERE (layer = 'l2' OR importance >= 4) AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY importance DESC, created DESC LIMIT ?
    `).all(Date.now(), Math.min(Number(cfg["deep.batchSize"] || 50) * 3, 150))
      // 隐私白名单：永不上传项目的内容不能拼进画像 prompt
      .filter((r) => this._allowedByPrivacy(r));

    const prompt = [
      "你是用户画像分析师。基于下面的记忆（含用户手写笔记与项目决策），归纳稳定特征。",
      '只输出严格 JSON：{"persona":[{"trait":"","evidence":["mem_id"]}],"communication":[{"pref":"","evidence":[]}],"tech":[{"pref":"","evidence":[]}],"habits":[{"habit":"","evidence":[]}],"values":[""]}',
      "硬性要求：每条结论必须带 2~5 个真实存在的记忆 id 作为证据；没有证据的结论不要输出；不要编造。",
      "",
      ...rows.map((r) => `[${r.id}] (${r.layer}) ${r.title}：${r.summary || ""}`),
    ].join("\n");

    const result = await this.client.call({
      task: "profile",
      system: "你是用户画像分析师，只输出 JSON。",
      messages: [{ role: "user", content: prompt }],
      jsonMode: true,
      maxTokens: 4000,
    });
    const parsed = extractJson(result.text);
    if (!parsed) return { processed: 0, tokens: result.usage.input + result.usage.output, detail: "画像结构无法解析，已保留上一版" };

    const validIds = new Set(rows.map((r) => r.id));
    const sections = {
      persona: this._renderProfileSection(parsed.persona, "trait", validIds),
      preferences: this._renderProfileSection(parsed.communication, "pref", validIds),
      tech: this._renderProfileSection(parsed.tech, "pref", validIds),
      habits: this._renderProfileSection(parsed.habits, "habit", validIds),
    };
    const historyDir = path.join(this.rootDir, "profile", ".history");
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let written = 0;
    for (const [name, content] of Object.entries(sections)) {
      const rel = `profile/${name}.md`;
      const abs = path.join(this.rootDir, rel);
      if (fs.existsSync(abs)) {
        try { fs.copyFileSync(abs, path.join(historyDir, `${name}-${stamp}.md`)); } catch { /* 留档失败不阻塞 */ }
      }
      const pinned = this._readPinned(abs);
      const merged = pinned.length ? `${content}\n\n${pinned.join("\n")}` : content;
      this.service.store.writeAtomic(rel, merged, { backup: true });
      written++;
    }
    const reportFile = this._writeReport("profile", "画像生成报告", [
      `素材 ${rows.length} 条（L2 + 高重要度）`,
      `生成分区：${written} 个`,
      `token 消耗：${result.usage.input + result.usage.output}`,
    ]);
    return { processed: rows.length, updated: written, tokens: result.usage.input + result.usage.output, detail: `画像已更新（${rows.length} 条素材）`, report: reportFile };
  }

  _renderProfileSection(list, field, validIds) {
    const lines = ["<!-- 本文件由 AgentHub 记忆仓库生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->"];
    for (const item of Array.isArray(list) ? list : []) {
      const text = item && item[field];
      if (!text) continue;
      const evidence = (Array.isArray(item.evidence) ? item.evidence : []).filter((id) => validIds.has(id));
      if (this.flat()["deep.evidenceRequired"] !== false && evidence.length < 1) continue;
      lines.push(`- ${String(text).trim()}`);
      if (evidence.length) lines.push(`  证据 [${evidence.length}]：${evidence.join(", ")}`);
    }
    return lines.join("\n") + "\n";
  }

  _readPinned(abs) {
    try {
      return fs.readFileSync(abs, "utf8").split("\n").filter((l) => l.includes("[pinned]"));
    } catch {
      return [];
    }
  }

  _writeReport(kind, title, lines) {
    const dir = path.join(this.rootDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${kind}-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, `# ${title}\n\n> ${new Date().toLocaleString("zh-CN")}\n\n${lines.join("\n")}\n`, "utf8");
    return file;
  }

  _readBody(row) {
    const detail = this.service.getById(row.id);
    return detail ? `${detail.body}` : "";
  }

  /** 一批条目的正文一次性取回：按 path 分组只读一次文件（原先逐条 = N 次读盘 + N 次解析） */
  _readBodies(ids) {
    const out = new Map();
    const rows = [];
    for (const id of ids) {
      const row = this.service.index.getById(id);
      if (row) rows.push(row);
    }
    const byPath = new Map();
    for (const row of rows) {
      if (!byPath.has(row.path)) byPath.set(row.path, []);
      byPath.get(row.path).push(row);
    }
    for (const [rel, group] of byPath) {
      const text = this.service.store.read(rel);
      if (text == null) continue;
      const parsed = require("./store.cjs").parseFrontmatter(text);
      const sections = require("./store.cjs").parseDailySections(parsed.body);
      for (const row of group) {
        if (row.type === "daily" && row.anchor) {
          const sec = sections.find((s) => s.id === row.anchor);
          out.set(row.id, sec ? sec.body : "");
        } else {
          out.set(row.id, parsed.body.trim());
        }
      }
    }
    return out;
  }
}

module.exports = { MemoryTasks, extractJson };
