/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 核心服务层：写记忆、读记忆、失效替换、回收站、项目操作、索引维护、
// 概览与统计。上层（IPC / 本地 HTTP API / 自动化任务）都调本文件，不直接碰 store/index。
// 纪律：单写者——所有写操作经 withWrite 串行队列；MD 先落盘成功才更新索引。
"use strict";

const fs = require("fs");
const path = require("path");

const { MemoryStore, newId, sha256, normalizeForHash, estimateTokens, contentHash, parseFrontmatter, parseDailySections, isIndexableRel } = require("./store.cjs");
const { MemoryIndex, startOfToday } = require("./indexer.cjs");
const { MemorySearch } = require("./search.cjs");
const layout = require("./layout.cjs");
const { redact } = require("./redact.cjs");
const { SCHEMA } = require("./config-schema.cjs");
const { ensureSynonyms } = require("./synonyms.cjs");

// schema 里声明为 map / list / providerlist / modeltable 的键要保持整体，不拆点路径。
// 该判定只依赖静态 SCHEMA：flat() 在每次写入/读取时都会被调用，提前算一次，避免每轮重建 Set。
const WHOLE_KEYS = new Set(
  Object.entries(SCHEMA)
    .filter(([, meta]) => ["map", "list", "providerlist", "modeltable", "orderlist"].includes(meta.type))
    .map(([key]) => key),
);

class MemoryService {
  constructor(rootDir, cfg, options = {}) {
    this.root = rootDir;
    this.cfg = cfg;
    this.store = new MemoryStore(rootDir);
    this.index = new MemoryIndex(path.join(rootDir, "index", "memory.sqlite"));
    this.search = new MemorySearch(this.index, rootDir);
    this.registry = new layout.ProjectRegistry(rootDir);
    this.deviceId = options.deviceId || "local";
    this.options = options;
    this.onEvent = options.onEvent || (() => {});
    this._writeChain = Promise.resolve();
    // 写后异步补判（asyncDedupHook）用的一次性定时器：退出时统一清理，避免 close 之后
    // 回调仍访问已关闭的 sqlite 句柄，也避免进程退出阶段悬着待触发定时器。
    this._timers = new Set();
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
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.index.close();
  }

  // 写队列：所有写操作串行（§21.6），避免多入口并发改同一文件
  withWrite(fn) {
    const next = this._writeChain.then(() => fn());
    this._writeChain = next.catch(() => {});
    return next;
  }

  /**
   * 批量写入上下文（导入专用）：窗口内的写入共享一次延迟落盘（store 层攒改动，收尾统一写盘）。
   * 导入同一个 daily 文件动辄几千条，逐条「读全文→改→整份重写」是 O(n²) 写放大；
   * 攒批后同一个文件一批只读写一遍。
   * 收尾的落盘单独进写队列（此时 fn 已跑完，不会与窗口内的写入自等待）。
   */
  async withWriteBatch(fn) {
    this.store.beginDeferred();
    let result;
    try {
      result = await fn();
    } finally {
      await this.withWrite(() => this.store.endDeferred());
    }
    return result;
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
    let files = [];
    let cwd = "";
    if (text != null) {
      const parsed = parseFrontmatter(text);
      if (parsed.fm) {
        if (parsed.fm.cwd) cwd = String(parsed.fm.cwd);
        if (Array.isArray(parsed.fm.files)) {
          files = parsed.fm.files;
        } else if (typeof parsed.fm.files === "string") {
          files = parsed.fm.files.split(",").map((x) => x.trim()).filter(Boolean);
        }
      }
      if (row.type === "daily" && row.anchor) {
        const sec = parseDailySections(parsed.body).find((s) => s.id === row.anchor);
        body = sec ? sec.body : "";
        if (sec && sec.meta && sec.meta.files) {
          files = Array.isArray(sec.meta.files) ? sec.meta.files : String(sec.meta.files).split(",").map((x) => x.trim()).filter(Boolean);
        }
      } else {
        body = parsed.body.trim();
      }
    }
    return {
      id: row.id, path: row.path, anchor: row.anchor, type: row.type, layer: row.layer,
      title: row.title, summary: row.summary,
      tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
      project: row.project, projectName: this.projectNameOf(row.project), agent: row.agent, device: row.device, session: row.session,
      created: row.created, updated: row.updated, importance: row.importance,
      hash: row.hash, size: row.size,
      validFrom: row.valid_from, validTo: row.valid_to, supersededBy: row.superseded_by,
      refs: row.refs_text ? row.refs_text.split(",").filter(Boolean) : [],
      pinned: !!row.pinned, starred: !!row.starred,
      dedupStatus: row.dedup_status, aiProcessed: !!row.ai_processed,
      body,
      bodyMissing: text == null,
      files, cwd,
    };
  }

  _checkFreshness(m) {
    if (!m || !Array.isArray(m.files) || !m.files.length) {
      return { isStale: false, staleFiles: [] };
    }
    const baseDir = m.cwd || (this.registry.get(m.project) || {}).path || process.cwd();
    const staleFiles = [];
    for (const item of m.files) {
      if (!item || typeof item !== "string") continue;
      const anchor = parseFileAnchor(item);
      const relPath = anchor.file;
      const recordedMtime = anchor.mtime;
      const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(baseDir, relPath);
      try {
        if (!fs.existsSync(absPath)) {
          staleFiles.push(`${relPath} (已删除/重命名)`);
        } else if (recordedMtime > 0) {
          const stat = fs.statSync(absPath);
          if (stat.mtimeMs - recordedMtime > 2000) {
            staleFiles.push(`${relPath} (代码已更新)`);
          }
        }
      } catch { /* 忽略 stat 异常 */ }
    }
    return {
      isStale: staleFiles.length > 0,
      staleFiles,
    };
  }

  list(opts) { return this._withProjectName(this.search.list(opts || {})); }

  /** 列表/检索结果补上项目显示名（slug 是机器标识，界面要显示 name） */
  _withProjectName(page) {
    if (!page || !Array.isArray(page.rows)) return page;
    return { ...page, rows: page.rows.map((r) => ({ ...r, projectName: this.projectNameOf(r.project) })) };
  }

  /** slug → 项目台账里的显示名；台账里没有（历史脏 slug / 未登记）时原样返回 slug */
  projectNameOf(slug) {
    if (!slug) return "";
    const hit = this.registry.get(slug);
    return (hit && hit.name) || String(slug);
  }

  searchMemories(query, opts, cfg) {
    const r = this.search.search(query, opts || {}, cfg || this.flat());
    // 检索结果与浏览列表共用同一张表格，显示名口径必须一致
    if (r && Array.isArray(r.results)) {
      r.results = r.results.map((x) => ({ ...x, projectName: this.projectNameOf(x.project) }));
    }
    return r;
  }
  recent(opts) {
    const rows = this.search.recent(opts || {});
    return Array.isArray(rows) ? rows.map((r) => ({ ...r, projectName: this.projectNameOf(r.project) })) : rows;
  }
  heatmap(days) { return this.search.heatmap(days); }
  timeline(id) { return this.search.timeline(id); }
  graphStats() { return this.search.graphStats(); }
  digest(maxLines) { return this.search.digest(maxLines || this.flat()["agents.digestMaxLines"]); }

  /**
   * 待确认建议的自动按推荐确认（review.autoConfirm* 三开关，默认关）：
   * 开启后对应建议在入队时立即按推荐执行——语义与人工裁决完全一致（supersede=确认失效、
   * classify=按 slug 归入/无推荐则忽略、dedup=采纳新记忆并标旧失效），绝不物理删除。
   * 执行失败时建议保留 pending，回落到收件箱由人工处理。产出点在 reviewAdd 之后调用本方法。
   */
  autoConfirmReview(kind, queueId, payload) {
    if (!queueId) return;
    const cfg = this.flat();
    try {
      if (kind === "supersede" && cfg["review.autoConfirmSupersede"]) {
        void this.markSuperseded(payload.oldId, payload.newId, payload.reason || "自动按推荐确认失效")
          .then((r) => { if (r && r.ok) this.index.reviewResolve(queueId, "confirmed"); })
          .catch(() => {});
      } else if (kind === "classify" && cfg["review.autoConfirmClassify"]) {
        if (payload.slug) {
          void this.projectAssign([payload.memoryId], payload.slug)
            .then(() => this.index.reviewResolve(queueId, `assign:${payload.slug}`))
            .catch(() => {});
        } else {
          this.index.reviewResolve(queueId, "dismissed");
        }
      } else if (kind === "dedup" && cfg["review.autoConfirmDedup"]) {
        void this.markSuperseded(payload.targetId, payload.newId, payload.reason || "自动按推荐采纳新记忆")
          .then(() => this.index.reviewResolve(queueId, "adoptNew"))
          .catch(() => {});
      }
    } catch { /* 开关判定或执行异常不影响建议入队 */ }
  }

  flat() {
    // 把嵌套配置拍平成点路径（引擎读取口径与 schema 一致）。
    // schema 里声明为 map / list / providerlist / modeltable 的键保持整体——
    // 它们本来就是「一个键装一组数据」，拆成点路径会让 taskEffort.distill 这类读取口径失真。
    const out = {};
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        const isLeafObject = v && typeof v === "object" && !Array.isArray(v);
        if (isLeafObject && !WHOLE_KEYS.has(key)) { walk(v, key); continue; }
        // schema 删除某键后，旧配置文件里的残留同名键必须被安全忽略，
        // 否则引擎会读到一个「已从表单消失但仍生效」的幽灵旋钮（dedup.l4.autoDelete 就是这么踩的）
        if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) continue;
        out[key] = v;
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
   * @param {object} opts 批量导入专用的旁路开关，默认全关、行为与过去完全一致：
   *                      silent 不广播 memory-new / forceDedup 同内容一律判重 /
   *                      skipHooks 跳过同步去重与调度阈值钩子 / noBackup 免 .bak
   */
  async writeMemory(input, opts = {}) {
    return this.withWrite(async () => {
      const cfg = this.flat();
      if (this.index.readOnly) {
        return { ok: false, message: "索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再写入" };
      }
      if (cfg["privacy.pause"]) {
        return { ok: false, message: "隐私模式已开启，写入被暂停（可在记忆中枢设置中关闭）" };
      }
      // 空内容校验必须在标题兜底之前：title 会先被兜底成「未命名记忆」，
      // 之后再判 `!body && !title` 永远判不中，全空白写入会漏进来
      const rawTitle = String(input.title || "").replace(/[\r\n]+/g, " ").trim();
      const rawBody = String(input.body || "").trim();
      if (!rawBody && !rawTitle) return { ok: false, message: "内容为空" };
      // 标题也要封顶（body 有 maxFileSizeKB 而 title 没有：超长标题会膨胀 FTS 与列表渲染）
      const title = (rawTitle || firstLine(input.body) || "未命名记忆").slice(0, 200);
      let body = rawBody;
      // storage.maxFileSizeKB：单条记忆超限就截断并标注（避免一条把当天文件撑爆）
      const maxKb = Number(cfg["storage.maxFileSizeKB"] || 512);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (maxKb > 0 && bodyBytes > maxKb * 1024) {
        body = truncateUtf8(body, maxKb * 1024) + "\n\n…（超出单条上限已截断）";
      }

      let redactHits = [];
      let safeTitle = title;
      // 调用方自带的 summary 与 body/title 同口径脱敏：它原样入索引并分词进 FTS，
      // 漏脱敏就等于 privacy.redact 从摘要旁路被绕开（buildSummary 的输入是脱敏后的 body，无需再处理）
      let safeSummary = String(input.summary || "");
      if (cfg["privacy.redact"] !== false) {
        const rules = cfg["privacy.redactRules"];
        const rb = redact(body, rules, "mask");
        const rt = redact(title, rules, "mask");
        const rs = safeSummary ? redact(safeSummary, rules, "mask") : { text: "", hits: [] };
        body = rb.text;
        safeTitle = rt.text;
        safeSummary = rs.text;
        redactHits = rb.hits.concat(rt.hits, rs.hits);
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
        // gitPreferred 之前漏传：配置项「Git 地址优先」是假旋钮，关掉后仍走 git 探测
        { fuzzyThreshold: cfg["classify.fuzzyThreshold"], autoCreateProject: cfg["classify.autoCreateProject"], gitPreferred: cfg["classify.gitPreferred"] },
      );

      const tags = normalizeTags(input.tags);
      const summary = String(safeSummary || buildSummary(body, finalTitle)).slice(0, 240);
      const hash = contentHash({ title: finalTitle, body, tags, level: cfg["dedup.l1.normalizeLevel"] });
      // validFrom 在 MD 与索引两处必须同值（此前 MD 用 input.validFrom、索引写死 now，重建后跳变）
      const validFromMs = input.validFrom ? Date.parse(input.validFrom) || now : now;

      // 同步去重（L1 哈希 / L2 文本近似）：写入路径必须 < 50ms，L3/L4 留给异步补判
      let dedupVerdict = null;
      if (!opts.skipHooks && typeof this.dedupHook === "function") {
        try {
          dedupVerdict = this.dedupHook({ title: finalTitle, body, tags, project: cls.slug, hash, type });
        } catch { /* 去重失败不阻断写入 */ }
      }

      const dup = this._findByHash(hash);
      // forceDedup：导入历史数据时不认「同身份可多条」——那是给日常记录留的口子，
      // 套在批量导入上会让同一批里重复出现的内容成倍落库（实测一条内容最多写了 91 份）
      const repeatable = !opts.forceDedup && this._allowsDuplicate(type, cfg);
      if (dup && !input.allowDuplicate && !repeatable) {
        return { ok: true, id: dup.id, path: dup.path, anchor: dup.anchor, hash, noop: true, redacted: redactHits, dedup: "L1 命中已有记忆" };
      }
      const dupIndex = dup ? dup.dup_index + 1 : 0;

      const id = newId(new Date(now));
      const dateStr = isoDate(now);
      // 索引 path 以磁盘真实大小写为准（canonicalRel）：目录是历史大写时（AgentHub）
      // 否则 slug 小写会拼出 projects/agenthub/… 与 watcher 的 reindexFile 路径分叉，
      // 造成同一 id 两条 path（界面显示两遍、删一条留幽灵）
      const rel = this.store.canonicalRel(layout.memoryRelPath({ slug: cls.slug, layer, agent, type, dateStr, id }));
      const projectName = cls.name;

      // 关联文件与修改时间戳锚定（用于时效性过时检测）
      let anchoredFiles = [];
      const baseDir = input.cwd || (this.registry.get(cls.slug) || {}).path || process.cwd();
      if (Array.isArray(input.files)) {
        for (const f of input.files) {
          if (!f || typeof f !== "string") continue;
          const trimmed = f.trim();
          if (parseFileAnchor(trimmed).mtime > 0) {
            anchoredFiles.push(trimmed); // 已是「路径@时间戳」锚定串，原样保留
          } else {
            const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
            try {
              if (fs.existsSync(abs)) {
                const stat = fs.statSync(abs);
                const displayRel = path.isAbsolute(trimmed) ? path.relative(baseDir, abs).replace(/\\/g, "/") : trimmed.replace(/\\/g, "/");
                anchoredFiles.push(`${displayRel}@${Math.floor(stat.mtimeMs)}`);
              } else {
                anchoredFiles.push(trimmed.replace(/\\/g, "/"));
              }
            } catch {
              anchoredFiles.push(trimmed.replace(/\\/g, "/"));
            }
          }
        }
      }

      const fileRefs = anchoredFiles.map((x) => `file:${parseFileAnchor(x).file}`);
      const mergedRefs = Array.from(new Set((Array.isArray(input.refs) ? input.refs : []).concat(fileRefs)));

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
        refs: mergedRefs,
        files: anchoredFiles.length ? anchoredFiles : undefined,
        cwd: input.cwd || "",
        // git 元数据不再以「归类来源是否 git」为条件：显式项目在带 cwd 时同样会探测到远程，
        // 卡住条件的写法会让这类项目永远写不出 git 字段，存量自愈也无据可依
        git: (this.registry.get(cls.slug) || {}).remotes?.[0] || "",
        pinned: !!input.pinned,
        starred: !!input.starred,
      };

      const writeOpts = {
        backup: opts.noBackup ? false : cfg["storage.backupBeforeWrite"] !== false,
        backupKeep: cfg["storage.backupKeep"] || 5,
        atomic: cfg["storage.atomicWrite"] !== false,
      };
      if (type === "daily") {
        await this.store.withLock(rel, () => {
          this.store.appendDaily(rel, { agent, project: cls.slug || "", projectName: projectName || "", date: dateStr },
            { id, time: hhmm(now), title: finalTitle, meta: { importance: fm.importance, tags, session: input.session || "", files: anchoredFiles.length ? anchoredFiles : undefined }, body }, writeOpts);
        });
      } else {
        await this.store.withLock(rel, () => {
          this.store.writeStandalone(rel, fm, body, writeOpts);
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
          // 异步补判：不阻塞 memory_write 返回；句柄登记到 _timers，close() 时统一清理
          const timer = setTimeout(() => {
            this._timers.delete(timer);
            this.asyncDedupHook(id).catch(() => {});
          }, 50);
          this._timers.add(timer);
        }
      }
      if (!opts.skipHooks) this._maybeTriggerAiThreshold();
      // 归类建议（general-suggest）是给「随手写的新记忆」用的：批量导入历史时逐条生成，
      // 只会把人工确认队列灌爆，一律跳过
      if (!opts.skipHooks && cls.origin === "general-suggest" && cls.suggestion) {
        const suggestPayload = { ...cls.suggestion, memoryId: id, title: finalTitle, path: rel };
        this.autoConfirmReview("classify", this.index.reviewAdd("classify", suggestPayload), suggestPayload);
      }

      // 导入期间不逐条广播：渲染进程每条都要回查统计与索引，几万条事件会把界面淹掉
      if (!opts.silent) this.onEvent({ type: "memory-new", id, project: cls.slug, agent, title: finalTitle });
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
    // 走 index 的常驻语句：导入时这里会被调用几万次，每次 prepare 等于每次重新编译 SQL
    return this.index.findByHashActive(hash);
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
      // 编辑路径与写入路径同口径：标题封顶 200（否则超长标题可经 update 绕过写入时的上限膨胀 FTS），
      // 正文超 storage.maxFileSizeKB 同样截断（update 不该成为绕过单条上限的后门）
      const nextTitle = patch.title != null
        ? String(patch.title).replace(/[\r\n]+/g, " ").trim().slice(0, 200)
        : current.title;
      let nextBody = patch.body != null ? String(patch.body) : current.body;
      const maxKb = Number(cfg["storage.maxFileSizeKB"] || 512);
      if (maxKb > 0 && Buffer.byteLength(nextBody, "utf8") > maxKb * 1024) {
        nextBody = truncateUtf8(nextBody, maxKb * 1024) + "\n\n…（超出单条上限已截断）";
      }
      const next = {
        title: nextTitle,
        body: nextBody,
        summary: patch.summary != null ? String(patch.summary).slice(0, 240) : current.summary,
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
        // cwd/git 只存在 MD frontmatter（索引行没有这两个字段位）：从现文件取回透传，
        // 硬编码空串会让一次编辑抹掉写入时的溯源元数据
        const curFm = parseFrontmatter(this.store.read(row.path) || "").fm;
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
          refs: current.refs,
          cwd: typeof curFm.cwd === "string" ? curFm.cwd : "",
          git: typeof curFm.git === "string" ? curFm.git : "",
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
    if (reason) this.index.reviewAdd("supersede-done", { id, byId, reason, at: now }, "resolved", "done");
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
      let rel = destRel || (this.store.trashMeta(name) || {}).originPath;
      if (!rel) return { ok: false, message: "回收站文件缺少原路径记录" };
      // abs() 只拦越界，拦不住指向 index/、reports/ 等保留路径的覆盖写：
      // 恢复目标必须是可索引的 .md，否则一次还原能用 MD 内容毁掉索引库等内部文件
      if (!isIndexableRel(rel)) return { ok: false, message: `还原目标不是合法记忆路径：${rel}` };
      if (this.store.exists(rel)) {
        const ext = path.extname(rel);
        const base = rel.slice(0, -ext.length);
        rel = `${base}_restore_${Date.now()}${ext}`;
      }
      const restored = this.store.restoreFromTrash(name, rel);
      if (!restored) return { ok: false, message: "回收站文件不存在或还原失败" };
      this.reindexFile(rel);
      return { ok: true, path: rel };
    });
  }

  trashPurge(keepDays) { return { removed: this.store.purgeTrash(keepDays || this.flat()["storage.trashKeepDays"] || 90) }; }

  // ---------- 项目 ----------

  /**
   * 存量项目元数据自愈：从已落盘的记忆 frontmatter 里回收 cwd/git，补回项目台账。
   *
   * 为什么需要：显式项目名写入（早期实现）提前返回、不探测 Git，于是项目卡永久缺远程与本地路径；
   * 而 frontmatter 里其实存过 cwd/git（写入时记下的）。这些信息不该要求用户手改 JSON 找回。
   *
   * 远程或本地路径**任一缺失**都尝试补（只补远程会漏掉「有远程但没路径」的卡）；
   * 每个项目最多读 limitPerProject 个文件，够用即停。主进程专用：索引重建跑在 worker 里，
   * 在那里写台账会与主进程竞争同一文件。
   *
   * 同时**纠正**：记忆里混进过浅路径（家目录/盘符根/家目录下的通用目录）时予以剔除——
   * 这类路径不是项目根，留在卡上只会误导。剔除用 setMeta（覆盖式），因为 upsert 是并集、
   * 只增不减，清不掉已写入的无效值。
   */
  reconcileProjectMetadata({ limitPerProject = 50 } = {}) {
    if (this.index.readOnly) return { healed: 0, skipped: "read-only" };
    const cfg = this.flat();
    const gitPreferred = cfg["classify.gitPreferred"] !== false;
    let healed = 0;
    let pruned = 0;
    for (const p of this.registry.list()) {
      const hadRemotes = (p.remotes || []).filter(Boolean);
      const hadPathsRaw = (p.localPaths || []).filter(Boolean);
      const manual = new Set((p.manualPaths || []).filter(Boolean));
      // 台账里的路径**不天然可信**：历史版本写入时没做归属校验，脏值（会话 cwd 里的无关目录）
      // 就是这么进来的。可信的只有两类：
      //   ① manualPaths —— 用户手动关联过（显式断言，永不自愈删除）
      //   ② 能通过归属证明的（目录名匹配项目名，或该仓库 origin 与项目远程一致）
      // 其余一律按「未验证」处理，证明不了就剔除。
      const hadPaths = hadPathsRaw.filter((x) => layout.isProjectDirCandidate(x));
      let rows = [];
      try {
        rows = this.index.db.prepare(
          "SELECT path FROM mem WHERE project = ? AND path IS NOT NULL ORDER BY created DESC LIMIT ?",
        ).all(String(p.slug).toLowerCase(), limitPerProject);
      } catch {
        continue;
      }
      const remotes = new Set(hadRemotes);
      const candidates = new Set();
      for (const r of rows) {
        const text = this.store.read(r.path);
        if (text == null) continue;
        let fm;
        try { fm = parseFrontmatter(text).fm || {}; } catch { continue; }
        if (fm.git) remotes.add(String(fm.git));
        if (fm.cwd) {
          const cwd = String(fm.cwd);
          candidates.add((gitPreferred && layout.findGitRoot(cwd)) || cwd);
        }
      }
      // 用「已记录路径 + 候选」一起探远程补全身份（fork/上游），再据此判定归属
      if (gitPreferred) {
        for (const dir of [...new Set([...hadPaths, ...candidates])]) {
          for (const d of layout.displayRemotesFor(dir)) remotes.add(d);
        }
      }
      const identity = { slug: p.slug, name: p.name, aliases: p.aliases || [], remotes: [...remotes] };
      const keep = (x) => manual.has(x) || layout.isPathForProject(x, identity);
      const finalPaths = [...new Set([...hadPaths.filter(keep), ...[...candidates].filter(keep)])];
      // 身份纠正：无 origin 的项目不得留着远程（历史写入可能已污染）
      const identityRemotes = new Set();
      for (const dir of finalPaths) for (const d of layout.displayRemotesFor(dir)) identityRemotes.add(d);
      const hasOrigin = identityRemotes.size > 0;
      const finalRemotes = hasOrigin ? [...remotes] : [];
      // 幂等判据比对「存储值 vs 最终值」：候选路径每轮都会从 frontmatter 被重新发现，
      // 若拿中间集合判定就会永远「有变化」，自愈每轮写一次台账（实测踩过）。
      const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      if (sameSet(finalRemotes, hadRemotes) && sameSet(finalPaths, hadPathsRaw)) continue;
      const prunedSomething = hadPathsRaw.some((x) => !finalPaths.includes(x)) || hadRemotes.some((x) => !finalRemotes.includes(x));
      this.registry.setMeta(p.slug, { remotes: finalRemotes, localPaths: finalPaths, manualPaths: [...manual] });
      if (prunedSomething) pruned++;
      healed++;
    }
    return { healed, pruned };
  }

  /**
   * 正式关联入口：把一个本地目录关联到既有项目卡（不新建卡、不改 slug）。
   *
   * 供「项目归档」卡片的维护菜单调用，替代「让用户手改台账」：
   * 目录存在即记录本地路径；是 Git 仓库则额外补上全部远程地址。
   * 非 Git 目录、未装 Git 都按「只关联路径」成功返回，不阻断用户。
   */
  projectAttachPath(slug, dir) {
    const entry = this.registry.get(slug);
    if (!entry) return { ok: false, message: "项目不存在" };
    const target = String(dir || "").trim();
    if (!target) return { ok: false, message: "未选择目录" };
    let st;
    try { st = fs.statSync(target); } catch { return { ok: false, message: "目录不存在或不可访问" }; }
    if (!st.isDirectory()) return { ok: false, message: "请选择目录而不是文件" };
    const cfg = this.flat();
    const gitPreferred = cfg["classify.gitPreferred"] !== false;
    const root = gitPreferred ? layout.findGitRoot(target) : null;
    // 身份口径与归类一致：有 origin 才记远程（只挂 upstream 的目录不算本项目身份）
    const remotes = gitPreferred ? layout.displayRemotesFor(target) : [];
    const localPath = root || target;
    // 过浅的目录（家目录/盘符根/家目录下的通用目录）不是项目根：明确拒绝并说明，
    // 而不是默默记下一条没意义的路径（用户手选也照样挡，语义上它不成立）
    if (!layout.isProjectDirCandidate(localPath)) {
      return { ok: false, message: "该目录过浅（家目录或盘符根），不是项目根目录：请选择具体项目所在的文件夹" };
    }
    this.registry.upsert({
      slug: entry.slug,
      name: entry.name,
      remotes,
      localPaths: [localPath],
      // 标记为用户手动关联：这是可信断言，自愈不得以「缺归属证明」为由清除
      manualPaths: [localPath],
    });
    const after = this.registry.get(entry.slug) || entry;
    return {
      ok: true,
      project: after,
      isRepo: !!root,
      addedRemotes: remotes,
      localPath,
      // 是仓库但没有 origin：如实告知，避免用户以为「关联了却没识别到」
      noOrigin: !!root && remotes.length === 0,
    };
  }

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
        const newRel = this.store.canonicalRel(layout.memoryRelPath({
          slug: target ? target.slug : null, layer: row.layer, agent: row.agent,
          type: row.type, dateStr: isoDate(row.created), id: row.id,
        }));
        // 目标就是当前位置：原地重写后再 moveToTrash 会把记忆自己送进回收站。
        // newRel 必须先按磁盘真名归一（目录还是历史大写时，小写 slug 拼出的路径与 row.path 只差大小写，
        // 精确比较拦不住 → 同一个物理文件被写一遍又进回收站）
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
    // 大小写孪生（AgentHub / agenthub）在 NTFS 上是同一个项目目录：放过去会把目标项目的文件
    // 当「残留」整目录进回收站（老代码只认精确相等，靠上游 slug 精确匹配才侥幸拦住）
    if (String(fromSlug).toLowerCase() === String(toSlug).toLowerCase()) return { ok: false, message: "不能把项目并入自身" };
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
      const newRel = this.store.canonicalRel(layout.memoryRelPath({
        slug: target.slug, layer: row.layer, agent: row.agent, type: row.type,
        dateStr: isoDate(row.created), id: row.id,
      }));
      // 同 P0 修复：目标即当前位置时跳过，防自删（newRel 已按磁盘真名归一，大小写差异不再漏判）
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
    // payload 可能因历史脏数据/手工改库而损坏：直接 JSON.parse 抛出会让整个 IPC 调用炸掉，
    // 这里显式失败并返回可读原因（reviewList 走的是 safeParse，此处口径对齐）
    let payload;
    try {
      payload = JSON.parse(item.payload);
    } catch {
      return { ok: false, message: "待确认项数据损坏，无法解析" };
    }
    if (!payload || typeof payload !== "object") return { ok: false, message: "待确认项数据损坏，无法解析" };
    if (slug) this.registry.upsert({ slug, name: slug, origin: "manual" });
    this.index.reviewResolve(queueId, slug ? `assign:${slug}` : "dismiss");
    return { ok: true, memoryId: payload.memoryId, slug: slug || null };
  }

  // ---------- 索引维护 ----------

  reindexFile(rel, legacyRows, opts = {}) {
    // 入口先归一为磁盘真实大小写：watcher 拿到的是目录真名（projects/AgentHub/…），
    // 而 slug 小写路径（projects/agenthub/…）也会走到这里。两者若不归一，
    // 同一文件会在索引里留下两条只差大小写的 path（同 id 双 path）。
    rel = this.store.canonicalRel(rel);
    // 索引范围外的路径（reports 留档、_import 报告、备份）一律不入库：扫描看不见它们，
    // 一旦成行就是永远清不掉的「孤儿行」。顺带清掉历史遗留的这类脏行。
    if (!isIndexableRel(rel)) {
      this.index.removeByPath(rel);
      return { skipped: "out-of-scope" };
    }
    const text = this.store.read(rel);
    if (text == null) {
      this.index.removeByPath(rel);
      return { removed: true };
    }
    const cfg = this.flat();
    const { fm, body } = parseFrontmatter(text);
    const sections = parseDailySections(body);
    // project 折小写后统一分发给两个分支（daily 与非 daily 同一口径）：历史文件的 frontmatter
    // 里还是大写（v1.41.0 之前写的），只剩一边折会让同一项目一半行大写、一半行小写，
    // 项目卡按 slug 精确关联时只统计到一半
    const fmProject = fm.project ? String(fm.project).toLowerCase() : null;
    if (!fm.id && !sections.length && !body.trim()) {
      // 空壳文件（迁移/删除后的残留）：清索引，不造随机 id 的条目
      this.index.removeByPath(rel);
      return { skipped: "empty" };
    }
    // 置顶/星标/设备/会话/去重序号/AI 处理标记都只存在索引里（文件没有对应字段位），
    // 重建前先按 id 捞出旧行继承，否则一次外部编辑/重建就把用户状态全部抹掉
    // （ai_processed 归零会让 tasks._pending 把它们当成没处理过，重复烧模型）。
    // legacyRows：rebuildIndex 清表前下发的旧行快照——清表后这里查库恒空，继承会静默失效
    //
    // 重建模式（opts.legacyReady）下不再回库兜底：调用方已经把「该 path 的全部旧行」按 id 装进
    // legacyRows 传下来了，快照里没有就是「确实没有旧行」。原先写成 `legacyRows || 查库`，
    // 对每个「快照里没有的文件」（新文件、或清表后空库首建）都会回库 prepare + all 查一次——
    // 实测 4751 个文件里绝大部分都走了这条空查询，是重建耗时里排名第二的浪费。
    const oldById = opts.legacyReady ? (legacyRows || new Map()) : (legacyRows || new Map(
      this.index.db.prepare("SELECT id, pinned, starred, device, session, dup_index, ai_processed, created, hash, dedup_status FROM mem WHERE path = ?").all(rel)
        .map((r) => [r.id, r])
    ));
    if (fm.type === "daily" || (!fm.id && sections.length)) {
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
          project: fmProject, agent: fm.agent || "manual",
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
          aiProcessed: old && old.hash === hash ? !!old.ai_processed : false,
          body: sec.body + "\n" + sec.title,
        });
      }
      // 删旧 + 插新放同一事务：中途抛错不会留下残缺索引
      // 重建模式下这两项都省掉：rebuildIndex 开头已清空全表（removeByPath 查的删的全是空），
      // 且外层已开一个大事务（逐文件再开事务 = 每次提交刷一遍 WAL，实测占重建耗时 29%）
      if (opts.skipRemove && opts.skipTx) {
        for (const row of rows) this.index.upsertOne(row, cfg);
      } else {
        const own = !opts.skipTx;
        if (own) this.index.db.exec("BEGIN");
        try {
          if (!opts.skipRemove) this.index.removeByPath(rel);
          for (const row of rows) this.index.upsertOne(row, cfg);
          if (own) this.index.db.exec("COMMIT");
        } catch (e) {
          if (own) this.index.db.exec("ROLLBACK");
          throw e;
        }
      }
      return { sections: true, count: rows.length };
    }
    // projects/<slug>/ 下的文件如果 frontmatter 缺 project 字段（glossary.md 等系统产出没有该字段位），
    // 按路径归属：否则全部落成「通用」，L2 列表里多份同标题的术语表分不清归属。
    // 折小写与 classify 产出的 slug 同口径：目录真名可能是历史大写（projects/AgentHub/），
    // 不折会让同一项目在 project 列里出现 AgentHub / agenthub 两种取值、项目卡随之裂开
    const pathSlug = ((rel.match(/^projects\/([^/]+)\//) || [])[1] || "").toLowerCase() || null;
    // 术语表标题带项目短名（slug 取最后一段）：否则 L2 列表里 N 份都叫「术语表」的记录无法分辨
    const glossarySlug = (rel.match(/^projects\/([^/]+)\/l2\/glossary\.md$/) || [])[1];
    const fmTitle = glossarySlug ? `术语表 · ${glossarySlug.split("--").pop()}` : fm.title;
    // 无 frontmatter 的文件（用户手丢的 md）用路径派生的稳定 id：随机 id 每次重建都会变，
    // 引用/待确认队列/前端列表 key 全部指向失效
    const rowId = fm.id || `file_${sha256(rel).slice(0, 12)}`;
    const old = oldById.get(rowId);
    // 不信任文件里的 fm.hash（导出/导入可能带脏值）：内容指纹永远现场重算
    const hash = contentHash({ title: fmTitle || "", body, tags: fm.tags, level: cfg["dedup.l1.normalizeLevel"] });
    // 与 daily 分支同口径：重建模式下跳过空转的 removeByPath 与逐文件事务（见该处注释）
    const ownTx = !opts.skipTx;
    if (ownTx) this.index.db.exec("BEGIN");
    try {
      if (!opts.skipRemove) this.index.removeByPath(rel);
      this.index.upsertOne({
      id: rowId, path: rel, anchor: null, type: fm.type || "note", layer: fm.layer || "l1",
      title: fmTitle || firstLine(body) || path.basename(rel), summary: fm.summary || body.slice(0, 240),
      tags: fm.tags, project: fmProject || pathSlug, agent: fm.agent || "manual",
      device: fm.device || (old ? old.device : null),
      session: fm.session || (old ? old.session : null),
      created: fm.created ? Date.parse(fm.created) || Date.now() : Date.now(),
      updated: fm.updated ? Date.parse(fm.updated) || Date.now() : Date.now(),
      importance: fm.importance || 3,
      hash,
      size: Buffer.byteLength(body, "utf8"), validFrom: fm.validFrom ? Date.parse(fm.validFrom) : undefined,
      validTo: fm.validTo ? Date.parse(fm.validTo) : null, supersededBy: fm.supersededBy || null,
      refs: fm.refs,
      // 文件里写了就以文件为准（用户手改过），否则继承旧行的索引态：置顶/星标/去重序号/AI 标记
      pinned: fm.pinned != null ? fm.pinned : (old ? old.pinned : false),
      starred: fm.starred != null ? fm.starred : (old ? old.starred : false),
      dupIndex: old ? old.dup_index : 0,
      dedupStatus: old ? (old.hash === hash ? old.dedup_status : "pending") : "pending",
      // 重建时内容没变就保住 AI 处理标记（否则一次全量重建让全部条目重烧模型）；
      // 内容真变了则作废——旧结论对应的是旧正文
      aiProcessed: old ? (old.hash === hash ? !!old.ai_processed : false) : false,
      body: body + "\n" + (fmTitle || ""),
      }, cfg);
      if (ownTx) this.index.db.exec("COMMIT");
    } catch (e) {
      if (ownTx) this.index.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }

  /**
   * 全量重建索引（同步版）。
   *
   * 性能要点（实测 44s → 目标 12~15s，4751 文件）：
   *  - 整个逐文件循环包在**一个大事务**里：原先每文件一对 BEGIN/COMMIT，每次提交都刷 WAL，
   *    实测占重建耗时约 29%；
   *  - 重建期间**摘掉 mem_ai 触发器**：末尾本来就要 rebuildFts() 全量重灌，逐行维护 FTS 是重复劳动
   *    （实测再省约 17%）。摘除必须用 try/finally 保证恢复——恢复失败会让后续单文件写入不再进 FTS，
   *    所以恢复后还要断言触发器确实存在，缺失就用 rebuildFts() 兜底；
   *  - 逐文件跳过 removeByPath（清表已做过，那一步查的删的全是空）与逐文件事务（见 reindexFile 开关）；
   *  - 传 legacyReady：快照里没有就是没有，不再回库做必然为空的查询。
   */
  rebuildIndex(progress) {
    const t0 = Date.now();
    const files = this.store.walkMemoryFiles();
    const db = this.index.db;
    // 旧行先按路径快照：下面的 DELETE 清表后，reindexFile 的「按 id 捞旧行继承用户状态」
    // 查到的是空表，pinned/starred/session/device/去重序号/AI 标记会在全量重建时全部归零
    const legacyByPath = new Map();
    for (const r of db.prepare("SELECT id, path, pinned, starred, device, session, dup_index, ai_processed, created, hash, dedup_status FROM mem").all()) {
      let bucket = legacyByPath.get(r.path);
      if (!bucket) legacyByPath.set(r.path, (bucket = new Map()));
      bucket.set(r.id, r);
    }
    db.exec("BEGIN");
    try { db.exec("DELETE FROM mem"); db.exec("DELETE FROM mem_link"); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }

    // 摘掉 INSERT 触发器（FTS 末尾统一重灌）；DDL 不能进事务，放在大事务之外
    const hadTrigger = this.index.dropInsertTrigger();

    const failed = [];
    let done = 0;
    let bodyError = null;
    try {
      db.exec("BEGIN");
      try {
        // 批量只读遍历窗口：这些 rel 全部来自 walkMemoryFiles()（自己遍历出来的，天然在 root 内），
        // 逐文件再往上找祖先做 realpath 逃逸检查是重复劳动——实测 4751 个文件白花 0.7s。
        // 窗口只覆盖这里的读；写路径（writeMemory/删除）仍走完整检查。
        this.store.withTrustedWalk(() => {
          for (const rel of files) {
            try {
              // 单个坏文件不能中止整批（此前一遇异常就停在残缺态，搜索静默漏结果）
              this.reindexFile(rel, legacyByPath.get(rel), { skipRemove: true, skipTx: true, legacyReady: true });
            } catch (e) {
              failed.push({ rel, message: String(e.message || e).slice(0, 160) });
            }
            done++;
            if (progress && done % 200 === 0) progress({ done, total: files.length });
          }
        });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      bodyError = e;
    } finally {
      // 无论如何都要把触发器装回去；装回后校验一次，缺失则全量重灌兜底
      if (hadTrigger) {
        try {
          if (!this.index.restoreInsertTrigger()) this.index.rebuildFts();
        } catch {
          try { this.index.rebuildFts(); } catch { /* 兜底失败也不掩盖原始错误 */ }
        }
      }
    }
    if (bodyError) throw bodyError;

    this.index.rebuildFts();
    const tookMs = Date.now() - t0;
    this.index.setMeta("lastBuildAt", String(Date.now()));
    return { files: files.length, failed, tookMs };
  }

  /**
   * 把旁路库（worker 离线重建好的整库快照）换入当前索引：ATTACH + 单事务。
   *
   * 为什么不用「关连接 → 改名替换文件 → 重开」：Windows 上 rename 覆盖已存在文件会失败
   * （需要两次 rename，中间有非原子窗口，崩在中间就是库缺失）；而 ATTACH 换入是单事务，
   * 读要么看到旧索引要么看到新索引，且不动 mem_meta（调度记账、同步基线等全保留）。
   *
   * 只换 mem / mem_link 两张表并重灌 FTS：meta 由主库自己说了算——旁路库是重建开始时的快照，
   * 期间调度器可能已往主库写过记账，用快照覆盖会把这段时间的记账抹回去。
   */
  swapInRebuiltIndex(sidecarFile) {
    if (this.index.readOnly) throw new Error("索引库处于只读模式，无法换入");
    const db = this.index.db;
    const t0 = Date.now();
    db.exec(`ATTACH '${String(sidecarFile).replace(/'/g, "''")}' AS rebuilt`);
    try {
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM main.mem");
        db.exec("DELETE FROM main.mem_link");
        db.exec("INSERT INTO main.mem SELECT * FROM rebuilt.mem");
        db.exec("INSERT INTO main.mem_link SELECT * FROM rebuilt.mem_link");
        // FTS5 的 delete-all 命令不接受限定表名（main.mem_fts(main.mem_fts) 会语法错）
        db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
        db.exec("INSERT INTO mem_fts_w(mem_fts_w) VALUES('delete-all')");
        db.exec("INSERT INTO mem_fts(rowid, t_title, t_summary, t_body, t_tags) SELECT rowid, t_title, t_summary, t_body, t_tags FROM main.mem");
        db.exec("INSERT INTO mem_fts_w(rowid, w_title, t_summary, t_body, t_tags) SELECT rowid, w_title, t_summary, t_body, t_tags FROM main.mem");
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      try { db.exec("DETACH rebuilt"); } catch { /* 事务失败时 DETACH 可能已随回滚失效，忽略 */ }
    }
    this.index.setMeta("lastBuildAt", String(Date.now()));
    return { tookMs: Date.now() - t0 };
  }

  diagnose() {
    return this.search.diagnose(this.root, () => this.store.walkMemoryFiles());
  }

  /** 清掉索引里磁盘已不存在的行（含范围外的历史脏行）：与 diagnose 同口径。
   *  只补不删的话诊断里的孤儿行永远消不掉，用户点了修复也只看到同一句差异。 */
  pruneOrphans(onDisk) {
    if (this.index.readOnly) return 0;
    const files = onDisk instanceof Set ? onDisk : new Set(this.store.walkMemoryFiles());
    // 比对折大小写：磁盘遍历给的是目录真名（projects/AgentHub/…），而历史脏行可能是
    // projects/agenthub/…。按字符串精确比对时它既不在 files 里、也不是孤儿（文件确实存在），
    // 两边都漏 —— index-scan 反复扫也清不掉它。
    const folded = new Set([...files].map((p) => String(p).toLowerCase()));
    const paths = this.index.db.prepare("SELECT DISTINCT path FROM mem").all().map((r) => r.path);
    let pruned = 0;
    for (const rel of paths) {
      if (folded.has(String(rel).toLowerCase())) continue;
      this.index.removeByPath(rel);
      pruned++;
    }
    return pruned;
  }

  /**
   * 索引大小写归一（存量数据自愈）：行 path 收敛为磁盘真名 + project 列折小写 + 台账合并重复条目。
   *
   * 写入口径分叉（v1.42.1 之前：writeMemory 拼小写 slug 路径、watcher 拿目录真名）在 NTFS 上
   * 给同一个文件留下两条只差大小写的行（同 id、同内容），界面显示两遍、删一条留幽灵；
   * 项目卡的条数也按 project 的大小写裂成两半。pruneOrphans 折大小写比对之后这些行不再被误删
   * （文件确实存在），于是必须有人把它们收口——就在这里：以磁盘真名为准重索引，另一行的
   * 用户状态（置顶/星标/AI 处理标记/去重序号）合并进重索引的行，不丢。
   * 与 reindexFile 同样只处理索引范围内的行；磁盘已无的行是孤儿，交给 pruneOrphans。
   * 幂等：磁盘口径已经一致时零改动（代价是两次全表读，6 小时一次的自愈扫描里可忽略）。
   * @returns {number} 收敛掉的多余行数 + project 被折小写的行数
   */
  normalizeCase(onDisk) {
    if (this.index.readOnly) return 0;
    const files = onDisk instanceof Set ? onDisk : new Set(this.store.walkMemoryFiles());
    const byFold = new Map();
    for (const rel of files) byFold.set(String(rel).toLowerCase(), rel);

    const rows = this.index.db.prepare(
      "SELECT id, path, pinned, starred, device, session, dup_index, ai_processed, created, hash, dedup_status FROM mem",
    ).all();
    const groups = new Map(); // 磁盘真名 → 该文件的全部索引行
    for (const r of rows) {
      const truePath = byFold.get(String(r.path).toLowerCase());
      if (!truePath) continue; // 孤儿行：pruneOrphans 的活
      const g = groups.get(truePath);
      if (g) g.push(r);
      else groups.set(truePath, [r]);
    }

    let fixed = 0;
    for (const [truePath, list] of groups) {
      if (!list.some((r) => r.path !== truePath)) continue; // 全部已是磁盘口径
      // 状态合并：布尔取或、去重序号取最大；hash 一致才继承去重状态（reindexFile 的口径），
      // 去重结论优先取非默认值——两行里总有一行还是初始的 "pending"，直接 find 会把它当结论
      const hashes = new Set(list.map((r) => r.hash).filter(Boolean));
      const sameHash = hashes.size === 1 ? [...hashes][0] : null;
      const settled = list.map((r) => r.dedup_status).filter((s) => s && s !== "pending");
      const merged = {
        pinned: list.some((r) => !!r.pinned) ? 1 : 0,
        starred: list.some((r) => !!r.starred) ? 1 : 0,
        ai_processed: list.some((r) => !!r.ai_processed) ? 1 : 0,
        device: (list.find((r) => r.device) || {}).device || null,
        session: (list.find((r) => r.session) || {}).session || null,
        dup_index: Math.max(...list.map((r) => Number(r.dup_index) || 0)),
        created: Math.min(...list.map((r) => Number(r.created) || Date.now())),
        hash: sameHash,
        dedup_status: sameHash ? settled[0] || "pending" : "pending",
      };
      // 组内每个 id 都建桶：重索引的 id 可能来自 frontmatter，也可能是 file_<hash> 派生，两者都能继承
      const legacy = new Map(list.map((r) => [r.id, merged]));
      // 先删非磁盘口径的行、再重索引：removeByPath 会按 id 连带清掉 mem_link，
      // 而这些行与磁盘口径行是同一个 id，放在重索引之后会把刚重建的链接（相关记忆/图谱边）清空
      for (const r of list) if (r.path !== truePath) this.index.removeByPath(r.path);
      try {
        this.reindexFile(truePath, legacy);
      } catch {
        continue; // 坏文件本轮跳过：磁盘口径的旧行还在（reindexFile 自己的事务没提交），下轮扫描再补
      }
      fixed += list.length - 1;
    }

    // project 列折小写：slug 自 v1.41.0 起一律小写，历史行还留着目录真名的大小写，
    // 不折的话项目卡（按 slug 精确关联）会漏掉这批行、条数显示不全。
    // 用 JS 的 toLowerCase 而不是 SQL 的 lower()：后者只折 ASCII，与 sanitizeSlug 的口径对不上
    const restRows = this.index.db.prepare("SELECT id, path, project FROM mem WHERE project IS NOT NULL").all();
    const pending = [];
    for (const r of restRows) {
      const foldedProject = String(r.project).toLowerCase();
      if (foldedProject !== r.project) pending.push([foldedProject, r.id, r.path]);
    }
    if (pending.length) {
      const foldProject = this.index.db.prepare("UPDATE mem SET project = ? WHERE id = ? AND path = ?");
      this.index.db.exec("BEGIN");
      try {
        for (const args of pending) foldProject.run(...args);
        this.index.db.exec("COMMIT");
      } catch (e) {
        this.index.db.exec("ROLLBACK");
        throw e;
      }
      fixed += pending.length;
    }
    // 台账同批收口：卡片与索引行必须同一时刻归一，否则中间态会出现「一张卡但条数只剩一半」
    this.registry.normalize();
    return fixed;
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
    let shownProjects = 0;
    for (const [slug, items] of grouped) {
      if (lines.length >= maxLines - 2) {
        // 报「还剩几个项目」而不是 grouped.size（总数），否则一个没展示时也会说「还有 N 个项目未展示」
        lines.push(`…还有 ${grouped.size - shownProjects} 个项目未展示`);
        break;
      }
      const c = byProject.get(slug) || { c: items.length, latest: 0 };
      lines.push(`## ${slug}（${c.c} 条，最近 ${isoDate(c.latest || Date.now())}）`);
      for (const it of items) {
        lines.push(`- ${it.title} — ${(it.summary || "").slice(0, 60)}（${isoDate(it.created)}）`);
      }
      shownProjects++;
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
      type: args.type || null,
      tag: args.tag || null,
      starred: !!args.starred,
      pinned: !!args.pinned,
      limit: args.limit || cfg["search.finalTopK"] || 8,
      includeSuperseded: !!args.includeSuperseded,
    }, cfg);
    const lines = [`检索「${args.query}」命中 ${res.total} 条，返回 ${res.results.length} 条（${res.tookMs}ms）`];
    for (const r of res.results) {
      let staleNotice = "";
      let staleDetail = "";
      try {
        const full = this.getById(r.id);
        const fresh = this._checkFreshness(full);
        if (fresh.isStale) {
          staleNotice = " ⚠️[关联代码已更新可能过时]";
          staleDetail = `    ⚠️ 时效预警：关联文件 ${fresh.staleFiles.join(", ")}，当前代码可能已演进，请以磁盘最新代码为准！`;
        }
      } catch { /* 容错 */ }
      lines.push(`[${r.score}] ${r.title}${r.superseded ? "（已失效）" : ""}${staleNotice}`);
      lines.push(`    ${(r.summary || "").slice(0, 120)}`);
      if (staleDetail) {
        lines.push(staleDetail);
      }
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
      let fresh = { isStale: false, staleFiles: [] };
      try { fresh = this._checkFreshness(m); } catch { /* 容错 */ }
      let rawBody = m.body;
      if (fresh.isStale) {
        rawBody = `> ⚠️【时效警示】本记忆关联的代码文件在此记录后已被外部修改（${fresh.staleFiles.join(", ")}）。当前代码可能已演进，本条仅作为历史参考，严禁根据此条旧记忆回退或覆盖现有代码！\n\n${rawBody}`;
      }
      const remaining = Math.max(400, (maxChars || MAX_BODY_DEFAULT) - used);
      const body = rawBody.length > remaining ? rawBody.slice(0, remaining) + "\n…（已截断）" : rawBody;
      used += body.length;
      out.push({
        id: m.id, title: m.title, project: m.project, agent: m.agent, layer: m.layer,
        created: m.created, tags: m.tags, body, truncated: body.length < rawBody.length,
        path: `${m.path}${m.anchor ? "#" + m.anchor : ""}`,
        stale: fresh.isStale,
        staleFiles: fresh.staleFiles,
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
      return { ok: false, message: "记忆中枢处于隐私模式，写入被暂停" };
    }
    const r = await this.writeMemory({
      title: args.title,
      body: args.content || args.body || "",
      type: args.type || "daily",
      project: args.project,
      agent: agent || "unknown",
      tags: args.tags,
      importance: args.importance,
      files: args.files,
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

/** 解析「路径@毫秒时间戳」锚定串：只有末尾 @纯数字 才算时间戳锚定。
 *  @scope/pkg、assets/icon@2x.png 这类路径本身含 @ 的文件不能被误切——
 *  写入锚定与时效检查必须共用同一口径，否则会误报「已删除/重命名」或静默漏检。 */
function parseFileAnchor(item) {
  const s = String(item || "");
  const m = /^(.+)@(\d+)$/.exec(s);
  return m ? { file: m[1], mtime: Number(m[2]) } : { file: s, mtime: 0 };
}

module.exports = { MemoryService, normalizeTags, buildSummary, isoDate };
