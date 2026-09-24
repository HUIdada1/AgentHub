/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 核心服务层：写记忆、读记忆、失效替换、回收站、项目操作、索引维护、
// 概览与统计。上层（IPC / 本地 HTTP API / 自动化任务）都调本文件，不直接碰 store/index。
// 纪律：单写者——所有写操作经 withWrite 串行队列；MD 先落盘成功才更新索引。
"use strict";

const fs = require("fs");
const path = require("path");

const { MemoryStore, newId, sha256, normalizeForHash, estimateTokens, contentHash, parseFrontmatter, parseDailySections } = require("./store.cjs");
const { MemoryIndex, startOfToday } = require("./indexer.cjs");
const { MemorySearch } = require("./search.cjs");
const layout = require("./layout.cjs");
const { redact } = require("./redact.cjs");
const { SCHEMA } = require("./config-schema.cjs");
const { ensureSynonyms } = require("./synonyms.cjs");

class MemoryService {
  constructor(rootDir, cfg, options = {}) {
    this.root = rootDir;
    this.cfg = cfg;
    this.store = new MemoryStore(rootDir);
    this.index = new MemoryIndex(path.join(rootDir, "index", "memory.sqlite"));
    this.search = new MemorySearch(this.index, rootDir);
    this.registry = new layout.ProjectRegistry(rootDir);
    this.deviceId = options.deviceId || "local";
    this.onEvent = options.onEvent || (() => {});
    this._writeChain = Promise.resolve();
  }

  init() {
    this.store.ensureTree();
    ensureSynonyms(this.root);
    this.index.open();
    if (!this.index.readOnly) this.index.setMeta("lastScanAt", String(Date.now()));
    const projectFile = path.join(this.root, "projects", "_index.json");
    if (!fs.existsSync(projectFile)) {
      const r = this.registry;
      r.list();
      r.upsert({ slug: "__placeholder__", name: "__placeholder__" });
      r.remove("__placeholder__");
    }
    return this;
  }

  close() {
    this.index.close();
  }

  // 写队列：所有写操作串行（§21.6），避免多入口并发改同一文件
  withWrite(fn) {
    const next = this._writeChain.then(() => fn());
    this._writeChain = next.catch(() => {});
    return next;
  }

  // ---------- 读 ----------

  getById(id) {
    const row = this.index.getById(id);
    if (!row) return null;
    return this._hydrate(row);
  }

  _hydrate(row) {
    const text = this.store.read(row.path);
    let body = "";
    if (text != null) {
      const parsed = parseFrontmatter(text);
      if (row.type === "daily" && row.anchor) {
        const sec = parseDailySections(parsed.body).find((s) => s.id === row.anchor);
        body = sec ? sec.body : "";
      } else {
        body = parsed.body.trim();
      }
    }
    return {
      id: row.id, path: row.path, anchor: row.anchor, type: row.type, layer: row.layer,
      title: row.title, summary: row.summary,
      tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
      project: row.project, agent: row.agent, device: row.device, session: row.session,
      created: row.created, updated: row.updated, importance: row.importance,
      hash: row.hash, size: row.size,
      validFrom: row.valid_from, validTo: row.valid_to, supersededBy: row.superseded_by,
      refs: row.refs_text ? row.refs_text.split(",").filter(Boolean) : [],
      pinned: !!row.pinned, starred: !!row.starred,
      dedupStatus: row.dedup_status, aiProcessed: !!row.ai_processed,
      body,
      bodyMissing: text == null,
    };
  }

  list(opts) { return this.search.list(opts || {}); }
  searchMemories(query, opts, cfg) { return this.search.search(query, opts || {}, cfg || this.flat()); }
  recent(opts) { return this.search.recent(opts || {}); }
  heatmap(days) { return this.search.heatmap(days); }
  timeline(id) { return this.search.timeline(id); }
  graphStats() { return this.search.graphStats(); }
  digest(maxLines) { return this.search.digest(maxLines || this.flat()["agents.digestMaxLines"]); }

  flat() {
    // 把嵌套配置拍平成点路径（引擎读取口径与 schema 一致）。
    // schema 里声明为 map / list / providerlist / modeltable 的键保持整体——
    // 它们本来就是「一个键装一组数据」，拆成点路径会让 taskEffort.distill 这类读取口径失真。
    const wholeKeys = new Set(
      Object.entries(SCHEMA)
        .filter(([, meta]) => ["map", "list", "providerlist", "modeltable", "orderlist"].includes(meta.type))
        .map(([key]) => key),
    );
    const out = {};
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        const isLeafObject = v && typeof v === "object" && !Array.isArray(v);
        if (isLeafObject && !wholeKeys.has(key)) walk(v, key);
        else out[key] = v;
      }
    };
    walk(this.cfg.all ? this.cfg.all() : this.cfg);
    return out;
  }

  // ---------- 写 ----------

  /**
   * 写一条记忆。幂等：同 hash 且仍有效 → 返回既有条目（dupIndex 递增场景见 allowDuplicate）。
   * @param {object} input { title, body, type?, layer?, project?, agent?, tags?, importance?,
   *                         cwd?, session?, refs?, supersedes?, validFrom?, pinned?, starred?, allowDuplicate? }
   */
  async writeMemory(input) {
    return this.withWrite(async () => {
      const cfg = this.flat();
      if (this.index.readOnly) {
        return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再写入" };
      }
      if (cfg["privacy.pause"]) {
        return { ok: false, message: "隐私模式已开启，写入被暂停（可在记忆仓库设置中关闭）" };
      }
      // 标题也要封顶（body 有 maxFileSizeKB 而 title 没有：超长标题会膨胀 FTS 与列表渲染）
      const title = (String(input.title || "").replace(/[\r\n]+/g, " ").trim() || firstLine(input.body) || "未命名记忆").slice(0, 200);
      let body = String(input.body || "").trim();
      if (!body && !title) return { ok: false, message: "内容为空" };
      // storage.maxFileSizeKB：单条记忆超限就截断并标注（避免一条把当天文件撑爆）
      const maxKb = Number(cfg["storage.maxFileSizeKB"] || 512);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (maxKb > 0 && bodyBytes > maxKb * 1024) {
        body = truncateUtf8(body, maxKb * 1024) + "\n\n…（超出单条上限已截断）";
      }

      let redactHits = [];
      let safeTitle = title;
      if (cfg["privacy.redact"] !== false) {
        const rules = cfg["privacy.redactRules"];
        const rb = redact(body, rules, "mask");
        const rt = redact(title, rules, "mask");
        body = rb.text;
        safeTitle = rt.text;
        redactHits = rb.hits.concat(rt.hits);
      }
      const finalTitle = safeTitle;

      const type = input.type || "daily";
      const layer = input.layer || (["decision", "knowledge", "insight", "profile"].includes(type) ? "l2" : "l1");
      const agent = input.agent || "manual";
      // 导入历史记忆时带上原时间（钳制到 2000 年至今，防脏数据把热力图打成空白）；
      // 未传则取当前时间
      const now = clampTime(input.createdAt) || Date.now();

      const cls = layout.classify(
        { project: input.project, cwd: input.cwd, agent },
        this.registry,
        { fuzzyThreshold: cfg["classify.fuzzyThreshold"], autoCreateProject: cfg["classify.autoCreateProject"] },
      );

      const tags = normalizeTags(input.tags);
      const summary = String(input.summary || buildSummary(body, finalTitle)).slice(0, 240);
      const hash = contentHash({ title: finalTitle, body, tags, level: cfg["dedup.l1.normalizeLevel"] });
      // validFrom 在 MD 与索引两处必须同值（此前 MD 用 input.validFrom、索引写死 now，重建后跳变）
      const validFromMs = input.validFrom ? Date.parse(input.validFrom) || now : now;

      // 同步去重（L1 哈希 / L2 文本近似）：写入路径必须 < 50ms，L3/L4 留给异步补判
      let dedupVerdict = null;
      if (typeof this.dedupHook === "function") {
        try {
          dedupVerdict = this.dedupHook({ title: finalTitle, body, tags, project: cls.slug, hash, type });
        } catch { /* 去重失败不阻断写入 */ }
      }

      const dup = this._findByHash(hash);
      if (dup && !input.allowDuplicate && !this._allowsDuplicate(type, cfg)) {
        return { ok: true, id: dup.id, path: dup.path, anchor: dup.anchor, hash, noop: true, redacted: redactHits, dedup: "L1 命中已有记忆" };
      }
      const dupIndex = dup ? dup.dup_index + 1 : 0;

      const id = newId(new Date(now));
      const dateStr = isoDate(now);
      const rel = layout.memoryRelPath({ slug: cls.slug, layer, agent, type, dateStr, id });
      const projectName = cls.name;
      const fm = {
        id, type, layer,
        title: finalTitle,
        project: cls.slug || "",
        projectName: projectName || "",
        agent,
        session: input.session || "",
        device: this.deviceId,
        created: new Date(now).toISOString(),
        updated: new Date(now).toISOString(),
        validFrom: new Date(validFromMs).toISOString(),
        validTo: "",
        supersededBy: "",
        tags,
        importance: clampInt(input.importance, 1, 5, 3),
        summary,
        refs: Array.isArray(input.refs) ? input.refs : [],
        cwd: input.cwd || "",
        git: cls.origin === "git" ? (this.registry.get(cls.slug) || {}).remotes?.[0] || "" : "",
        pinned: !!input.pinned,
        starred: !!input.starred,
      };

      const opts = {
        backup: cfg["storage.backupBeforeWrite"] !== false,
        backupKeep: cfg["storage.backupKeep"] || 5,
        atomic: cfg["storage.atomicWrite"] !== false,
      };
      if (type === "daily") {
        await this.store.withLock(rel, () => {
          this.store.appendDaily(rel, { agent, project: cls.slug || "", projectName: projectName || "", date: dateStr },
            { id, time: hhmm(now), title: finalTitle, meta: { importance: fm.importance, tags, session: input.session || "" }, body }, opts);
        });
      } else {
        await this.store.withLock(rel, () => {
          this.store.writeStandalone(rel, fm, body, opts);
        });
      }

      const entry = {
        id, path: rel, anchor: type === "daily" ? id : null, type, layer, title: finalTitle, summary, tags,
        project: cls.slug, agent, device: this.deviceId, session: input.session || null,
        created: now, updated: now, importance: fm.importance, hash,
        size: Buffer.byteLength(body, "utf8"), validFrom: validFromMs, refs: fm.refs,
        dupIndex, dedupStatus: "pending", pinned: fm.pinned, starred: fm.starred, body: body + "\n" + finalTitle,
      };
      try {
        this.index.upsertOne(entry, cfg);
      } catch (e) {
        this.onEvent({ type: "index", detail: `索引更新失败（MD 已写入，可重建索引恢复）：${e.message}` });
      }

      let superseded = [];
      if (Array.isArray(input.supersedes) && input.supersedes.length) {
        superseded = await this._applySupersede(input.supersedes, id);
      }
      // L2 判为高相似：新条更全 → 取代旧条；旧条更全 → 保留旧条并撤销本次写入
      if (dedupVerdict && dedupVerdict.action === "merge-into" && dedupVerdict.targetId && dedupVerdict.targetId !== id) {
        const old = this.index.getById(dedupVerdict.targetId);
        // 判据与 dedup.informationScore 同源（长度为主、标签为辅），避免两处口径漂移
        const { informationScore } = require("./dedup.cjs");
        const scoreOf = (text, tagStr) => informationScore({
          len: String(text || "").length,
          tagCount: tagStr ? String(tagStr).split(",").filter(Boolean).length : 0,
          hasCode: /```/.test(String(text || "")),
          hasEvidence: false,
          created: Date.now(),
          now: Date.now(),
        });
        const oldBody = old ? this.getById(old.id)?.body || "" : "";
        if (old && scoreOf(body, tags.join(",")) >= scoreOf(oldBody, old.tags)) {
          await this._markSupersededLocked(old.id, id, `L2 相似度 ${dedupVerdict.score}，新条信息量更大`);
          superseded.push(old.id);
        } else if (old) {
          await this._deleteMemoryLocked(id, { purge: true });
          return { ok: true, id: old.id, path: old.path, anchor: old.anchor, hash, noop: true, dedup: `L2 相似度 ${dedupVerdict.score}，保留信息量更大的旧条` };
        }
      } else if (dedupVerdict && (dedupVerdict.action === "queue-l4" || dedupVerdict.action === "merge-into")) {
        this.index.db.prepare("UPDATE mem SET dedup_status = 'queued' WHERE id = ?").run(id);
        if (typeof this.asyncDedupHook === "function") {
          // 异步补判：不阻塞 memory_write 返回
          setTimeout(() => this.asyncDedupHook(id).catch(() => {}), 50);
        }
      }
      this._maybeTriggerAiThreshold();
      if (cls.origin === "general-suggest" && cls.suggestion) {
        this.index.reviewAdd("classify", { ...cls.suggestion, memoryId: id, title: finalTitle, path: rel });
      }

      this.onEvent({ type: "memory-new", id, project: cls.slug, agent, title: finalTitle });
      return {
        ok: true, id, path: rel, anchor: type === "daily" ? id : null,
        project: cls.slug, projectName, superseded, duplicates: dupIndex,
        redacted: redactHits, tokens: estimateTokens(body + title),
      };
    });
  }

  _allowsDuplicate(type, cfg) {
    const list = cfg["dedup.duplicateIdentityTypes"];
    return Array.isArray(list) && list.includes(type);
  }

  /** 新增记忆达阈值时让调度器立刻跑一轮（不等定时） */
  _maybeTriggerAiThreshold() {
    if (typeof this.thresholdHook === "function") {
      try {
        this.thresholdHook();
      } catch { /* 触发失败不影响写入 */ }
    }
  }

  _findByHash(hash) {
    if (!hash) return null;
    return this.index.db.prepare(
      "SELECT * FROM mem WHERE hash = ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY created DESC LIMIT 1",
    ).get(hash, Date.now()) || null;
  }

  async updateMemory(id, patch) {
    return this.withWrite(async () => {
      if (this.index.readOnly) {
        return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再编辑" };
      }
      const row = this.index.getById(id);
      if (!row) return { ok: false, message: "记忆不存在" };
      const cfg = this.flat();
      const current = this._hydrate(row);
      const next = {
        title: patch.title != null ? String(patch.title) : current.title,
        body: patch.body != null ? String(patch.body) : current.body,
        summary: patch.summary != null ? String(patch.summary) : current.summary,
        tags: patch.tags != null ? normalizeTags(patch.tags) : current.tags,
        importance: patch.importance != null ? clampInt(patch.importance, 1, 5, current.importance) : current.importance,
        pinned: patch.pinned != null ? !!patch.pinned : current.pinned,
        starred: patch.starred != null ? !!patch.starred : current.starred,
      };
      // 编辑路径必须与写入路径同口径脱敏，否则 privacy.redact 对 update 形同虚设
      let redactHits = [];
      if (cfg["privacy.redact"] !== false) {
        const rules = cfg["privacy.redactRules"];
        const rb = redact(next.body, rules, "mask");
        const rt = redact(next.title, rules, "mask");
        const rs = redact(next.summary, rules, "mask");
        next.body = rb.text;
        next.title = rt.text;
        next.summary = rs.text;
        redactHits = rb.hits.concat(rt.hits).concat(rs.hits);
      }
      const now = Date.now();
      const opts = { backup: cfg["storage.backupBeforeWrite"] !== false, backupKeep: cfg["storage.backupKeep"] || 5 };

      if (row.type === "daily" && row.anchor) {
        let updated = false;
        await this.store.withLock(row.path, () => {
          updated = this.store.updateDailySection(row.path, row.anchor, (sec) => ({
            ...sec,
            title: next.title,
            meta: { ...sec.meta, importance: next.importance, tags: next.tags.join(", ") },
            body: next.body,
          }), opts);
        });
        // 文件没改成而索引照改 = 索引与事实源永久分叉，必须显式失败
        if (!updated) return { ok: false, message: "目标节已不存在（可能被外部修改）：请先重建索引再编辑" };
      } else {
        const fm = { ...current, ...next };
        const fmOut = {
          id: fm.id, type: fm.type, layer: fm.layer, title: next.title,
          project: current.project || "", projectName: current.project || "", agent: current.agent,
          session: current.session || "", device: current.device || this.deviceId,
          created: new Date(current.created).toISOString(), updated: new Date(now).toISOString(),
          validFrom: new Date(current.validFrom || current.created).toISOString(),
          validTo: current.validTo ? new Date(current.validTo).toISOString() : "",
          supersededBy: current.supersededBy || "",
          tags: next.tags, importance: next.importance, summary: next.summary,
          refs: current.refs, cwd: "", git: "",
          pinned: next.pinned, starred: next.starred,
        };
        await this.store.withLock(row.path, () => {
          this.store.writeStandalone(row.path, fmOut, next.body, opts);
        });
      }

      const hash = contentHash({ title: next.title, body: next.body, tags: next.tags, level: cfg["dedup.l1.normalizeLevel"] });
      this.index.upsertOne({
        id, path: row.path, anchor: row.anchor, type: row.type, layer: row.layer,
        title: next.title, summary: next.summary, tags: next.tags,
        project: row.project, agent: row.agent, device: row.device, session: row.session,
        created: row.created, updated: now, importance: next.importance, hash,
        size: Buffer.byteLength(next.body, "utf8"),
        validFrom: row.valid_from, validTo: row.valid_to, supersededBy: row.superseded_by,
        refs: current.refs, dupIndex: row.dup_index, dedupStatus: row.dedup_status,
        aiProcessed: !!row.ai_processed, pinned: next.pinned, starred: next.starred,
        body: next.body + "\n" + next.title,
      }, cfg);
      return { ok: true, id, path: row.path, hash, redacted: redactHits };
    });
  }

  async setFlag(id, key, value) {
    if (key !== "pinned" && key !== "starred") return { ok: false, message: "不支持的标记" };
    return this.updateMemory(id, { [key]: value });
  }

  async deleteMemory(id, { purge = false } = {}) {
    if (this.index.readOnly) {
      return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再删除" };
    }
    return this.withWrite(() => this._deleteMemoryLocked(id, { purge }));
  }

  // 已在写队列内的删除（writeMemory / 去重裁决复用，避免 withWrite 重入自等待）
  async _deleteMemoryLocked(id, { purge = false } = {}) {
    const row = this.index.getById(id);
    if (!row) return { ok: false, message: "记忆不存在" };
    if (row.type === "daily" && row.anchor) {
      const text = this.store.read(row.path);
      if (text) {
        const sections = parseDailySections(parseFrontmatter(text).body);
        if (sections.length <= 1) {
          if (purge) this.store.removeFile(row.path);
          else this.store.moveToTrash(row.path);
        } else {
          this.store.updateDailySection(row.path, row.anchor, () => null, { backup: true });
        }
      }
    } else if (purge) {
      this.store.removeFile(row.path);
    } else {
      this.store.moveToTrash(row.path);
    }
    this.index.removeOne(id, row.path);
    this.onEvent({ type: "deleted", id, path: row.path });
    return { ok: true, id, purged: !!purge };
  }

  async markSuperseded(id, byId, reason) {
    if (this.index.readOnly) {
      return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再操作" };
    }
    return this.withWrite(() => this._markSupersededLocked(id, byId, reason));
  }

  // 已在写队列内的失效标记（writeMemory 的 supersedes 路径复用，避免重入自等待）
  async _markSupersededLocked(id, byId, reason) {
    if (id === byId) return { ok: false, message: "记忆不能让自身失效" };
    const row = this.index.getById(id);
    if (!row) return { ok: false, message: "被失效的记忆不存在" };
    const now = Date.now();
    if (row.type === "daily" && row.anchor) {
      let updated = false;
      await this.store.withLock(row.path, () => {
        updated = this.store.updateDailySection(row.path, row.anchor, (sec) => ({
          ...sec, meta: { ...sec.meta, supersededBy: byId || "" },
        }), { backup: true });
      });
      if (!updated) return { ok: false, message: "目标节已不存在（可能被外部修改）：请先重建索引再操作" };
    } else {
      const text = this.store.read(row.path);
      if (text) {
        const { fm, body } = parseFrontmatter(text);
        fm.validTo = new Date(now).toISOString();
        fm.supersededBy = byId || "";
        await this.store.withLock(row.path, () => this.store.writeStandalone(row.path, fm, body, { backup: true }));
      }
    }
    this.index.db.prepare("UPDATE mem SET valid_to = ?, superseded_by = ? WHERE id = ?").run(now, byId || null, id);
    if (reason) this.index.reviewAdd("supersede-done", { id, byId, reason, at: now });
    this.onEvent({ type: "supersede", id, byId });
    return { ok: true, id, validTo: now };
  }

  async _applySupersede(ids, newId) {
    const done = [];
    for (const oldId of ids) {
      const r = await this._markSupersededLocked(oldId, newId, "write 时显式声明 supersedes");
      if (r.ok) done.push(oldId);
    }
    return done;
  }

  // ---------- 回收站 ----------

  trashList() { return this.store.listTrash(); }

  async trashRestore(name, destRel) {
    if (this.index.readOnly) {
      return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再还原" };
    }
    return this.withWrite(async () => {
      const rel = destRel || (this.store.trashMeta(name) || {}).originPath;
      const restored = this.store.restoreFromTrash(name, rel);
      if (!restored || !rel) return { ok: false, message: "回收站文件不存在或缺少原路径记录" };
      this.reindexFile(rel);
      return { ok: true, path: rel };
    });
  }

  trashPurge(keepDays) { return { removed: this.store.purgeTrash(keepDays || this.flat()["storage.trashKeepDays"] || 90) }; }

  // ---------- 项目 ----------

  projects() {
    const db = this.index.db;
    const stats = db.prepare(`
      SELECT COALESCE(project, '') AS project, COUNT(*) AS count, MAX(created) AS latest,
             SUM(CASE WHEN layer = 'l2' THEN 1 ELSE 0 END) AS l2,
             GROUP_CONCAT(DISTINCT agent) AS agents
      FROM mem WHERE valid_to IS NULL OR valid_to > ?
      GROUP BY COALESCE(project, '')
    `).all(Date.now());
    const bySlug = new Map(stats.map((s) => [s.project, s]));
    const general = bySlug.get("") || { project: "", count: 0, latest: 0, l2: 0, agents: "" };
    const list = this.registry.list().map((p) => {
      const st = bySlug.get(p.slug) || { count: 0, latest: 0, l2: 0, agents: "" };
      return {
        slug: p.slug, name: p.name, remotes: p.remotes || [], aliases: p.aliases || [],
        localPaths: p.localPaths || [], origin: p.origin, updated: p.updated,
        count: st.count, l2: st.l2, latest: st.latest,
        agents: String(st.agents || "").split(",").filter(Boolean),
      };
    });
    return { projects: list, general: { count: general.count, latest: general.latest } };
  }

  projectDetail(slug) {
    const entry = this.registry.get(slug);
    const agents = this.index.db.prepare(
      "SELECT agent, COUNT(*) AS c FROM mem WHERE project = ? GROUP BY agent ORDER BY c DESC",
    ).all(slug);
    const daily = this.index.db.prepare(
      "SELECT path, COUNT(*) AS c FROM mem WHERE project = ? AND type = 'daily' GROUP BY path ORDER BY path DESC LIMIT 200",
    ).all(slug);
    return { project: entry, agents, files: daily };
  }

  async projectAssign(ids, slug) {
    if (this.index.readOnly) {
      return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再操作" };
    }
    return this.withWrite(async () => {
      const target = slug
        ? this.registry.get(slug) || this.registry.upsert({ slug: layout.sanitizeSlug(slug), name: slug, origin: "manual" })
        : null;
      let moved = 0;
      for (const id of ids) {
        const row = this.index.getById(id);
        if (!row) continue;
        const newRel = layout.memoryRelPath({
          slug: target ? target.slug : null, layer: row.layer, agent: row.agent,
          type: row.type, dateStr: isoDate(row.created), id: row.id,
        });
        // 目标就是当前位置：原地重写后再 moveToTrash 会把记忆自己送进回收站
        if (newRel === row.path) continue;
        if (row.type === "daily" && row.anchor) {
          const text = this.store.read(row.path);
          if (text) {
            const { fm, body } = parseFrontmatter(text);
            const parsed = parseDailySections(body);
            const sec = parsed.find((s) => s.id === row.anchor);
            const rest = parsed.filter((s) => s.id !== row.anchor);
            rest.preamble = parsed.preamble; // filter 产生新数组，前言要显式带过去
            if (sec) {
              this.store.writeAtomic(row.path, renderRemaining(fm, rest), { backup: true });
              this.store.appendDaily(newRel, {
                agent: row.agent, project: target ? target.slug : "", projectName: target ? target.name : "", date: isoDate(row.created),
              }, sec, { backup: true });
            }
          }
        } else {
          const text = this.store.read(row.path);
          if (text) {
            const { fm, body } = parseFrontmatter(text);
            fm.project = target ? target.slug : "";
            fm.projectName = target ? target.name : "";
            this.store.writeStandalone(newRel, fm, body, { backup: true });
            this.store.moveToTrash(row.path);
          }
        }
        this._afterMove(row.path, newRel);
        moved++;
      }
      return { ok: true, moved };
    });
  }

  async projectMerge(fromSlug, toSlug) {
    if (fromSlug === toSlug) return { ok: false, message: "不能把项目并入自身" };
    if (this.index.readOnly) {
      return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再操作" };
    }
    return this.withWrite(async () => {
      const target = this.registry.get(toSlug);
      if (!target) return { ok: false, message: "目标项目不存在" };
      const rows = this.index.db.prepare("SELECT id FROM mem WHERE project = ?").all(fromSlug);
      const r = await this.projectAssignSilent(rows.map((x) => x.id), toSlug);
      const from = this.registry.get(fromSlug);
      if (from) {
        const srcDir = this.store.abs(`projects/${fromSlug}`);
        const dstDir = this.store.abs(`projects/${toSlug}`);
        try {
          if (fs.existsSync(srcDir) && !fs.existsSync(dstDir)) {
            fs.renameSync(srcDir, dstDir);
          } else if (fs.existsSync(srcDir)) {
            // 残留文件（未索引的附件/备份）进回收站而不是 rmSync 永久删除
            const leftovers = [];
            const walk = (dir) => {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.isFile()) leftovers.push(path.relative(this.store.root, full).replace(/\\/g, "/"));
              }
            };
            walk(srcDir);
            for (const rel of leftovers) this.store.moveToTrash(rel);
            fs.rmSync(srcDir, { recursive: true, force: true });
          }
        } catch { /* 目录清理失败不影响记忆归属 */ }
      }
      this.registry.remove(fromSlug);
      return { ok: true, moved: r.moved };
    });
  }

  async projectAssignSilent(ids, slug) {
    // 与 projectAssign 同逻辑但已在写队列内（供 merge 复用，避免重入死等）
    const target = this.registry.get(slug);
    let moved = 0;
    for (const id of ids) {
      const row = this.index.getById(id);
      if (!row) continue;
      const newRel = layout.memoryRelPath({
        slug: target.slug, layer: row.layer, agent: row.agent, type: row.type,
        dateStr: isoDate(row.created), id: row.id,
      });
      // 同 P0 修复：目标即当前位置时跳过，防自删
      if (newRel === row.path) continue;
      const text = this.store.read(row.path);
      if (text) {
        const { fm, body } = parseFrontmatter(text);
        if (row.type === "daily" && row.anchor) {
          const parsed = parseDailySections(body);
          const sec = parsed.find((s) => s.id === row.anchor);
          const rest = parsed.filter((s) => s.id !== row.anchor);
          rest.preamble = parsed.preamble; // filter 产生新数组，前言要显式带过去
          if (sec) {
            this.store.writeAtomic(row.path, renderRemaining(fm, rest), { backup: true });
            this.store.appendDaily(newRel, { agent: row.agent, project: slug, projectName: target.name, date: isoDate(row.created) }, sec, { backup: true });
          }
        } else {
          fm.project = slug;
          fm.projectName = target.name;
          this.store.writeStandalone(newRel, fm, body, { backup: true });
          this.store.moveToTrash(row.path);
        }
        this._afterMove(row.path, newRel);
        moved++;
      }
    }
    return { moved };
  }

  /** 搬家收尾：原文件还有别的节就重索引原文件；空了就进回收站；新文件重索引 */
  _afterMove(oldRel, newRel) {
    const remain = this.store.read(oldRel);
    if (remain == null || !require("./store.cjs").parseFrontmatter(remain).body.trim()) {
      this.index.removeByPath(oldRel);
      if (remain != null) this.store.moveToTrash(oldRel);
    } else {
      this.index.removeByPath(oldRel);
      this.reindexFile(oldRel);
    }
    this.index.removeByPath(newRel);
    this.reindexFile(newRel);
  }

  projectRename(slug, name, aliases) {
    const entry = this.registry.upsert({
      slug, name: name || slug, aliases: Array.isArray(aliases) ? aliases : [],
    });
    return { ok: true, project: entry };
  }

  projectSuggestions() {
    return this.index.reviewList("pending", "classify").map((r) => ({ id: r.id, ...r.payload }));
  }

  confirmSuggestion(queueId, slug) {
    const item = this.index.db.prepare("SELECT * FROM review_queue WHERE id = ?").get(queueId);
    if (!item) return { ok: false, message: "待确认项不存在" };
    const payload = JSON.parse(item.payload);
    if (slug) this.registry.upsert({ slug, name: slug, origin: "manual" });
    this.index.reviewResolve(queueId, slug ? `assign:${slug}` : "dismiss");
    return { ok: true, memoryId: payload.memoryId, slug: slug || null };
  }

  // ---------- 索引维护 ----------

  reindexFile(rel) {
    const text = this.store.read(rel);
    if (text == null) {
      this.index.removeByPath(rel);
      return { removed: true };
    }
    const cfg = this.flat();
    const { fm, body } = parseFrontmatter(text);
    const sections = parseDailySections(body);
    if (!fm.id && !sections.length && !body.trim()) {
      // 空壳文件（迁移/删除后的残留）：清索引，不造随机 id 的条目
      this.index.removeByPath(rel);
      return { skipped: "empty" };
    }
    if (fm.type === "daily" || (!fm.id && sections.length)) {
      // 置顶/星标/设备/会话/去重序号只存在索引里（daily 文件没有对应字段位），重建前
      // 先按 id 捞出旧行继承，否则一次外部编辑/重建就把用户状态全部抹掉
      const oldById = new Map(
        this.index.db.prepare("SELECT id, pinned, starred, device, session, dup_index, created, hash, dedup_status FROM mem WHERE path = ?").all(rel)
          .map((r) => [r.id, r])
      );
      const rows = [];
      for (const sec of sections) {
        if (!sec.id) continue;
        const old = oldById.get(sec.id);
        const hash = contentHash({ title: sec.title, body: sec.body, tags: parseTagString(sec.meta.tags), level: cfg["dedup.l1.normalizeLevel"] });
        // created 的真实来源是「文件日期 + 节头时间」（appendDaily 从不写 fm.created，
        // 直接 Date.now() 会把全部节的创建时间刷成重建时刻，热力图/时间衰减全失真）
        const dateTime = fm.date ? Date.parse(`${fm.date}T${sec.time || "00:00"}`) : NaN;
        rows.push({
          id: sec.id, path: rel, anchor: sec.id, type: "daily", layer: "l1",
          title: sec.title, summary: sec.body.slice(0, 240), tags: parseTagString(sec.meta.tags),
          project: fm.project || null, agent: fm.agent || "manual",
          created: Number.isFinite(dateTime) ? dateTime : (old && old.created) || (fm.created ? Date.parse(fm.created) || Date.now() : Date.now()),
          updated: Date.now(), importance: Number(sec.meta.importance) || 3,
          hash,
          size: Buffer.byteLength(sec.body, "utf8"),
          supersededBy: sec.meta.supersededBy || null,
          validTo: sec.meta.supersededBy ? Date.now() : null,
          device: (old && old.device) || null,
          session: sec.meta.session || (old && old.session) || null,
          pinned: old ? !!old.pinned : false,
          starred: old ? !!old.starred : false,
          dupIndex: old ? old.dup_index : 0,
          dedupStatus: old && old.hash === hash ? old.dedup_status : "pending",
          body: sec.body + "\n" + sec.title,
        });
      }
      // 删旧 + 插新放同一事务：中途抛错不会留下残缺索引
      this.index.db.exec("BEGIN");
      try {
        this.index.removeByPath(rel);
        for (const row of rows) this.index.upsertOne(row, cfg);
        this.index.db.exec("COMMIT");
      } catch (e) {
        this.index.db.exec("ROLLBACK");
        throw e;
      }
      return { sections: true, count: rows.length };
    }
    this.index.db.exec("BEGIN");
    try {
      this.index.removeByPath(rel);
      this.index.upsertOne({
      // 无 frontmatter 的文件（用户手丢的 md）用路径派生的稳定 id：随机 id 每次重建都会变，
      // 引用/待确认队列/前端列表 key 全部指向失效
      id: fm.id || `file_${sha256(rel).slice(0, 12)}`, path: rel, anchor: null, type: fm.type || "note", layer: fm.layer || "l1",
      title: fm.title || firstLine(body) || path.basename(rel), summary: fm.summary || body.slice(0, 240),
      tags: fm.tags, project: fm.project || null, agent: fm.agent || "manual", device: fm.device,
      session: fm.session, created: fm.created ? Date.parse(fm.created) || Date.now() : Date.now(),
      updated: fm.updated ? Date.parse(fm.updated) || Date.now() : Date.now(),
      importance: fm.importance || 3,
      // 不信任文件里的 fm.hash（导出/导入可能带脏值）：内容指纹永远现场重算
      hash: contentHash({ title: fm.title || "", body, tags: fm.tags, level: cfg["dedup.l1.normalizeLevel"] }),
      size: Buffer.byteLength(body, "utf8"), validFrom: fm.validFrom ? Date.parse(fm.validFrom) : undefined,
      validTo: fm.validTo ? Date.parse(fm.validTo) : null, supersededBy: fm.supersededBy || null,
      refs: fm.refs, pinned: fm.pinned, starred: fm.starred,
      body: body + "\n" + (fm.title || ""),
      }, cfg);
      this.index.db.exec("COMMIT");
    } catch (e) {
      this.index.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }

  rebuildIndex(progress) {
    const t0 = Date.now();
    const files = this.store.walkMemoryFiles();
    const db = this.index.db;
    db.exec("BEGIN");
    try { db.exec("DELETE FROM mem"); db.exec("DELETE FROM mem_link"); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    let done = 0;
    // 单个坏文件不能中止整批（此前一遇异常就停在残缺态，搜索静默漏结果）
    const failed = [];
    for (const rel of files) {
      try {
        this.reindexFile(rel);
      } catch (e) {
        failed.push({ rel, message: String(e.message || e).slice(0, 160) });
      }
      done++;
      if (progress && done % 200 === 0) progress({ done, total: files.length });
    }
    this.index.rebuildFts();
    const tookMs = Date.now() - t0;
    this.index.setMeta("lastBuildAt", String(Date.now()));
    return { files: files.length, failed, tookMs };
  }

  diagnose() {
    return this.search.diagnose(this.root, () => this.store.walkMemoryFiles());
  }

  vacuum() {
    const before = (() => { try { return fs.statSync(this.index.file).size; } catch { return 0; } })();
    this.index.db.exec("VACUUM");
    const after = (() => { try { return fs.statSync(this.index.file).size; } catch { return 0; } })();
    return { ok: true, before, after };
  }

  indexStatus() {
    const db = this.index.db;
    const counts = this.index.counts();
    const fts = db.prepare("SELECT COUNT(*) AS c FROM mem_fts").get().c;
    const ftsW = db.prepare("SELECT COUNT(*) AS c FROM mem_fts_w").get().c;
    const size = (() => { try { return fs.statSync(this.index.file).size; } catch { return 0; } })();
    const wal = (() => { try { return fs.statSync(this.index.file + "-wal").size; } catch { return 0; } })();
    return {
      rows: counts.total, fts, ftsW, consistent: counts.total === fts && counts.total === ftsW,
      projects: counts.projects, today: counts.today, pending: counts.pending,
      sizeBytes: size, walBytes: wal,
      lastBuildAt: Number(this.index.getMeta("lastBuildAt") || 0),
      lastScanAt: Number(this.index.getMeta("lastScanAt") || 0),
      rootDir: this.root,
    };
  }

  stats() {
    const counts = this.index.counts();
    const devices = this.index.beats();
    const dayStart = startOfToday();
    const yesterday = this.index.db.prepare(
      "SELECT COUNT(*) AS c FROM mem WHERE created >= ? AND created < ?",
    ).get(dayStart - 86400000, dayStart).c;
    const l2 = this.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE layer = 'l2'").get().c;
    const llm = this.index.llmUsageToday();
    return {
      total: counts.total, projects: counts.projects, today: counts.today, yesterday,
      pending: counts.pending, l2, agents: devices.length, indexBytes: counts.sizeOnDisk,
      pendingWarnThreshold: Number(this.flat()["dedup.pendingWarnThreshold"] || 50),
      llmToday: llm.tokens, llmCalls: llm.calls,
    };
  }

  // 目录体积统计（仪表盘健康区）
  diskUsage() {
    let total = 0, files = 0;
    for (const rel of this.store.walkMemoryFiles()) {
      try { total += fs.statSync(this.store.abs(rel)).size; files++; } catch { /* 文件消失跳过 */ }
    }
    let indexBytes = 0;
    try { indexBytes = fs.statSync(this.index.file).size; } catch { /* 库未建时 0 */ }
    return { mdBytes: total, files, indexBytes };
  }

  // ---------- Agent 面向接口（MCP 工具的真实实现） ----------

  // 三级披露第一级：画像 + 当前项目汇总（≤ coreMaxTokens）
  coreMemory(opts = {}) {
    const cfg = this.flat();
    const maxTokens = cfg["agents.coreMaxTokens"] || 800;
    const parts = [];
    const profileFiles = ["persona", "preferences", "tech", "habits"];
    for (const name of profileFiles) {
      const text = this.store.read(`profile/${name}.md`);
      if (text) parts.push(parseFrontmatter(text).body.trim());
    }
    const project = opts.project || null;
    const rows = project
      ? this.index.db.prepare(`
          SELECT title, summary FROM mem
          WHERE layer = 'l2' AND project = ? AND (valid_to IS NULL OR valid_to > ?)
          ORDER BY importance DESC, created DESC LIMIT 12
        `).all(project, Date.now())
      : this.index.db.prepare(`
          SELECT project, title, summary FROM mem
          WHERE layer = 'l2' AND (valid_to IS NULL OR valid_to > ?)
          ORDER BY importance DESC, created DESC LIMIT 12
        `).all(Date.now());
    const lines = parts.filter(Boolean);
    if (rows.length) {
      lines.push("## 关键结论");
      for (const r of rows) lines.push(`- ${r.title}：${r.summary || ""}`.slice(0, 200));
    }
    const text = lines.join("\n").trim() || "（尚未生成画像与深层记忆，可先积累 L1 记忆后蒸馏）";
    return { text: truncateByTokens(text, maxTokens), tokens: estimateTokens(text) };
  }

  // 三级披露第二级：全局索引概览（≤ digestMaxLines 行）
  digestText(maxLinesOverride) {
    const cfg = this.flat();
    const maxLines = Number(maxLinesOverride) > 0 ? Number(maxLinesOverride) : (cfg["agents.digestMaxLines"] || 200);
    const { rows, counts } = this.digest(maxLines);
    const byProject = new Map();
    for (const c of counts) byProject.set(c.p || "(general)", c);
    const total = counts.reduce((s, c) => s + c.c, 0);
    const lines = [`# 记忆索引摘要`, `共 ${counts.length} 个项目 / ${total} 条记忆`, ""];
    const grouped = new Map();
    for (const r of rows) {
      const key = r.project || "(general)";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    for (const [slug, items] of grouped) {
      if (lines.length >= maxLines - 2) {
        lines.push(`…还有 ${grouped.size} 个项目未展示`);
        break;
      }
      const c = byProject.get(slug) || { c: items.length, latest: 0 };
      lines.push(`## ${slug}（${c.c} 条，最近 ${isoDate(c.latest || Date.now())}）`);
      for (const it of items) {
        lines.push(`- ${it.title} — ${(it.summary || "").slice(0, 60)}（${isoDate(it.created)}）`);
      }
    }
    const text = lines.slice(0, maxLines).join("\n");
    return { text, lines: Math.min(lines.length, maxLines), tokens: estimateTokens(text) };
  }

  searchForAgent(args, agent) {
    const cfg = this.flat();
    const maxTokens = cfg["agents.searchMaxTokens"] || 1200;
    const res = this.search.search(args.query, {
      project: args.project || null,
      agent: args.agent || null,
      layer: args.layer || null,
      limit: args.limit || cfg["search.finalTopK"] || 8,
      includeSuperseded: !!args.includeSuperseded,
    }, cfg);
    const lines = [`检索「${args.query}」命中 ${res.total} 条，返回 ${res.results.length} 条（${res.tookMs}ms）`];
    for (const r of res.results) {
      lines.push(`[${r.score}] ${r.title}${r.superseded ? "（已失效）" : ""}`);
      lines.push(`    ${(r.summary || "").slice(0, 120)}`);
      lines.push(`    id=${r.id} project=${r.project || "-"} agent=${r.agent} date=${isoDate(r.created)}`);
    }
    const text = truncateByTokens(lines.join("\n"), maxTokens);
    return { text, count: res.results.length, total: res.total, tookMs: res.tookMs, ids: res.results.map((r) => r.id) };
  }

  getMany(ids, maxChars) {
    const out = [];
    let used = 0;
    for (const id of Array.isArray(ids) ? ids.slice(0, 10) : []) {
      const m = this.getById(id);
      if (!m) { out.push({ id, missing: true }); continue; }
      const remaining = Math.max(400, (maxChars || MAX_BODY_DEFAULT) - used);
      const body = m.body.length > remaining ? m.body.slice(0, remaining) + "\n…（已截断）" : m.body;
      used += body.length;
      out.push({
        id: m.id, title: m.title, project: m.project, agent: m.agent, layer: m.layer,
        created: m.created, tags: m.tags, body, truncated: body.length < m.body.length,
        path: `${m.path}${m.anchor ? "#" + m.anchor : ""}`,
      });
    }
    const primary = out.find((x) => !x.missing);
    let related = [];
    if (primary) related = this.relatedTo(primary.id, 3);
    return { items: out, related };
  }

  relatedTo(id, limit) {
    const db = this.index.db;
    const rows = db.prepare(`
      SELECT DISTINCT m.id, m.title, m.summary FROM mem_link l
      JOIN mem m ON (m.id = CASE WHEN l.src = ? THEN l.dst ELSE l.src END)
      WHERE (l.src = ? OR l.dst = ?) AND m.id != ? AND (m.valid_to IS NULL OR m.valid_to > ?)
      LIMIT ?
    `).all(id, id, id, id, Date.now(), limit || 3);
    if (rows.length) return rows;
    const self = this.index.getById(id);
    if (!self) return [];
    return db.prepare(`
      SELECT id, title, summary FROM mem
      WHERE project = ? AND id != ? AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY created DESC LIMIT ?
    `).all(self.project, id, Date.now(), limit || 3);
  }

  timelineFor(args) {
    if (args.id) {
      const chain = this.timeline(args.id);
      return { chain, text: renderTimeline(chain) };
    }
    const res = this.search.search(args.topic || "", { limit: 5 }, this.flat());
    const chains = res.results.filter((r) => r.superseded || r.importance >= 3).slice(0, 3)
      .map((r) => ({ root: r.id, chain: this.timeline(r.id) }))
      .filter((x) => x.chain.length > 1);
    return { chains, text: chains.map((c) => renderTimeline(c.chain)).join("\n\n") || "（未发现演化链）" };
  }

  async writeFromAgent(args, agent) {
    if (this.flat()["privacy.pause"]) {
      return { ok: false, message: "记忆仓库处于隐私模式，写入被暂停" };
    }
    const r = await this.writeMemory({
      title: args.title,
      body: args.content || args.body || "",
      type: args.type || "daily",
      project: args.project,
      agent: agent || "unknown",
      tags: args.tags,
      importance: args.importance,
      supersedes: args.supersedes,
      cwd: args.cwd,
      session: args.session,
    });
    if (!r.ok) throw new Error(r.message || "写入失败");
    return {
      ok: true, id: r.id, path: r.path,
      superseded: r.superseded || [],
      noop: !!r.noop,
      note: r.noop ? "内容与已有记忆完全相同，未重复写入" : "已写入摘要索引，正文按需用 memory_get 精读",
      redacted: r.redacted || [],
    };
  }

  statusForAgent() {
    const s = this.indexStatus();
    return {
      ok: true,
      root: s.rootDir,
      memories: s.rows,
      indexConsistent: s.consistent,
      projects: s.projects,
      today: s.today,
      pendingReview: s.pending,
    };
  }
}

const MAX_BODY_DEFAULT = 6000;

function renderTimeline(chain) {
  if (!chain || !chain.length) return "（无演化记录）";
  return chain.map((n, i) => {
    const arrow = i ? "  ↑ 被取代于 " : "";
    const state = n.supersededBy ? "（已失效）" : "（当前有效）";
    return `${arrow}${n.id} ${n.title}${state}${n.validTo ? " · 失效于 " + isoDate(n.validTo) : ""}`;
  }).join("\n");
}

function truncateByTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  // CJK≈1 token/字、ASCII≈0.25：按字符预算折算后裁剪
  const budgetChars = Math.max(200, Math.floor(maxTokens / 0.7));
  return text.slice(0, budgetChars) + "\n…（超出 token 上限已截断）";
}

function renderRemaining(fm, sections) {
  const { renderDailyFile } = require("./store.cjs");
  return renderDailyFile(fm, sections);
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
}

function buildSummary(body, title) {
  const clean = String(body || "").replace(/[#>*`\[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return title;
  return clean.length <= 120 ? clean : clean.slice(0, 118) + "…";
}

function normalizeTags(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[,，\s]+/);
  const out = [];
  for (const t of arr) {
    const s = String(t).replace(/^#/, "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 12);
}

function parseTagString(s) {
  if (!s) return [];
  return String(s).split(/[,，]\s*/).map((x) => x.trim()).filter(Boolean);
}

/** 时间戳钳制：早于 2000 年或晚于现在的值一律丢弃（导入脏数据兜底） */
function clampTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 946684800000) return 0;
  if (n > Date.now() + 86400000) return 0;
  return Math.round(n);
}

/** 按字节上限截断，但不切在多字节字符中间（UTF-8 半截会产生替换符并污染索引） */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return String(text);
  const sliced = buf.slice(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded;
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

module.exports = { MemoryService, normalizeTags, buildSummary, isoDate };
