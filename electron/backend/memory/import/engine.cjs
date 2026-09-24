/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 导入引擎：来源探测 → 干跑预览（不落盘）→ 分批幂等写入 → 校验报告。
// 幂等三层：来源游标（不重读）+ 内容哈希（不重写）+ 身份键（跨来源同一条只写一次）。
// 铁律：默认先干跑；中断已提交批次不回滚；导入产物进 _import/ 记录。
"use strict";

const fs = require("fs");
const path = require("path");

const { probeSource, detectSource, pickParser } = require("./parsers.cjs");
const { contentHash } = require("../store.cjs");
const { detect: detectSensitive } = require("../redact.cjs");

const DEFAULT_SOURCES = [
  { id: "zcode-db", name: "ZCode 会话库", kind: "sqlite", path: "~/.zcode/cli/db/db.sqlite", enabled: true, priority: 1 },
  // zcode-tx 是 ZCode 运行时的流式日志（两万多条逐 token 增量 + 工具台账），内容与会话库完全重复，
  // 且拼不回干净消息；ZCode 的对话统一由 zcode-db 提供，这里默认关闭
  { id: "zcode-tx", name: "ZCode 实时日志（流式增量，与会话库重复）", kind: "jsonl", path: "~/.zcode/cli/agents", enabled: false, priority: 2 },
  { id: "claude", name: "Claude Code 会话", kind: "jsonl", path: "~/.claude/projects", enabled: true, priority: 3 },
  { id: "codex", name: "Codex 会话", kind: "jsonl", path: "~/.codex/sessions", enabled: true, priority: 4 },
  { id: "workbuddy", name: "WorkBuddy 会话", kind: "jsonl", path: "~/.workbuddy-ai", enabled: true, priority: 5 },
  { id: "notes-md", name: "Markdown 笔记目录", kind: "md", path: "", enabled: false, priority: 6 },
];

class ImportEngine {
  constructor(opts) {
    this.service = opts.service;
    this.rootDir = opts.rootDir;
    this.getConfig = opts.getConfig;
    this.emit = opts.emit || (() => {});
    this.expandPath = opts.expandPath || ((p) => p);
    this.memCfg = opts.memCfg;
    this.dir = path.join(opts.rootDir, "_import");
    this.cursorFile = path.join(this.dir, "cursors.json");
    this.running = false;
    this.cancelFlag = false;
    this.state = { phase: "idle", done: 0, total: 0, created: 0, merged: 0, skipped: 0, sensitive: 0, startedAt: 0 };
  }

  _loadCursors() {
    try {
      return JSON.parse(fs.readFileSync(this.cursorFile, "utf8"));
    } catch {
      return {};
    }
  }

  _saveCursors(cursors) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.cursorFile, JSON.stringify(cursors, null, 2), "utf8");
  }

  sources() {
    const cfg = this.getConfig();
    const configured = cfg["import.sources"];
    const list = Array.isArray(configured) && configured.length ? configured : DEFAULT_SOURCES;
    return list.map((s) => ({ ...s, path: s.path ? this.expandPath(s.path) : "" }));
  }

  /** 保存来源清单（路径/格式/启用/优先级/表映射），落 memory.config.local.json */
  saveSources(list) {
    if (!Array.isArray(list)) return { ok: false, message: "来源清单必须是数组" };
    const cleaned = list.map((s, i) => ({
      id: String(s.id || `src-${i + 1}`),
      name: String(s.name || s.id || `来源 ${i + 1}`),
      kind: ["sqlite", "jsonl", "md", "json"].includes(s.kind) ? s.kind : "md",
      path: String(s.path || ""),
      enabled: s.enabled !== false,
      priority: Number(s.priority) || i + 1,
      table: s.table || "",
    }));
    if (this.memCfg) this.memCfg.set({ "import.sources": cleaned });
    return { ok: true, sources: cleaned };
  }

  /** 探测：6 类来源的存在性 / 体量 / 增量预判 */
  scan() {
    const cursors = this._loadCursors();
    const out = this.sources().map((s) => {
      const probe = probeSource(s);
      const cursor = cursors[s.id] || null;
      return {
        ...probe,
        enabled: s.enabled !== false,
        cursor,
        estimate: this._estimateIncrement(s, cursor),
      };
    });
    return { sources: out, importDir: this.dir };
  }

  _estimateIncrement(source, cursor) {
    if (!source.path || !fs.existsSync(source.path)) return "";
    if (source.kind === "sqlite" && cursor && cursor.lastId) {
      try {
        const d = detectSource(source);
        const tbl = d.suggested;
        if (!tbl) return "";
        return `上次已导入至 ${cursor.table || ""} id=${cursor.lastId}（表内现有 ${tbl.count} 行）`;
      } catch {
        return "";
      }
    }
    if (source.kind === "jsonl" && cursor && cursor.files) {
      const total = Object.values(cursor.files).reduce((a, b) => a + Number(b || 0), 0);
      return `已读字节水位合计 ${(total / 1024).toFixed(0)} KB，本次按增量续读`;
    }
    if (source.kind === "md" && cursor && cursor.files) {
      return `已记录 ${Object.keys(cursor.files).length} 个文件的 mtime，本次只读变更文件`;
    }
    return "首次导入，将全量扫描";
  }

  /**
   * 干跑预览：解析 + 归类 + 去重判定，产出清单，不写任何文件。
   * @param {object} opts { sourceIds?: string[], limit?: number, rules?: object }
   */
  async preview(opts = {}) {
    const cfg = this.getConfig();
    const sources = this.sources().filter((s) => s.enabled !== false && (!opts.sourceIds || opts.sourceIds.includes(s.id)));
    const rules = { md: { observationMarkers: cfg["import.md.observationMarkers"] !== false, extractTags: cfg["import.md.extractTags"] !== false, extractWikiLinks: false }, ...(opts.rules || {}) };
    const limit = Number(opts.limit || 5000);
    const maxBatchBytes = Number(cfg["import.maxBatchBytes"] || 104857600);
    const dryRunState = { samples: [], groups: new Map(), wouldCreate: 0, wouldMerge: 0, skipDuplicate: 0, classifyFailed: 0, sensitive: 0, bytes: 0 };

    for (const source of sources) {
      if (this.cancelFlag) break;
      if (!source.path || !fs.existsSync(source.path)) continue;
      const parser = pickParser(source);
      let parsed = 0;
      let result;
      try {
        result = parser.parse(source, this._loadCursors()[source.id], { ...cfg, batchSize: 200, md: rules.md, maxChunkBytes: Math.min(maxBatchBytes, 8 * 1024 * 1024), maxFiles: 300 }, (item) => {
          parsed++;
          if (parsed > limit) return; // 预览只统计前 limit 条，避免大库干跑卡住
          const verdict = this._dryRunVerdict(item, cfg);
          if (verdict === "sensitive") dryRunState.sensitive++;
          else if (verdict === "duplicate") dryRunState.skipDuplicate++;
          else if (verdict === "merge") dryRunState.wouldMerge++;
          else dryRunState.wouldCreate++;
          const project = item.project || "(未归类)";
          const g = dryRunState.groups.get(project) || { project, count: 0, source: source.id };
          g.count++;
          dryRunState.groups.set(project, g);
          dryRunState.bytes += Buffer.byteLength(String(item.body || ""), "utf8");
          if (dryRunState.samples.length < 5) {
            dryRunState.samples.push({ title: item.title, created: item.created, source: source.id, project: item.project || "" });
          }
        });
      } catch (e) {
        result = { items: 0, note: String(e.message || e) };
      }
      void result;
    }

    this._lastPreviewAt = Date.now();
    return {
      ok: true,
      sources: sources.map((s) => s.id),
      wouldCreate: dryRunState.wouldCreate,
      wouldMerge: dryRunState.wouldMerge,
      skipDuplicate: dryRunState.skipDuplicate,
      classifyFailed: dryRunState.groups.get("(未归类)")?.count || 0,
      sensitive: dryRunState.sensitive,
      estimatedBytes: dryRunState.bytes,
      estimatedTokens: estimateBytesAsTokens(dryRunState.bytes),
      groups: [...dryRunState.groups.values()].sort((a, b) => b.count - a.count),
      samples: dryRunState.samples,
      note: "干跑未写入任何文件；确认后再执行导入",
    };
  }

  /**
   * 干跑判定。seen 是本轮导入已处理过的内容指纹（干跑预览不传）：
   * 写入是异步的，同一份内容在索引里落定之前查不到，只靠索引判重会让同一批内的重复漏过去。
   */
  _dryRunVerdict(item, cfg, seen) {
    if (cfg["import.sensitiveSkip"] !== false) {
      const hits = detectSensitive(`${item.title}\n${item.body}`, cfg["privacy.redactRules"]);
      if (hits.length) return "sensitive";
    }
    // 与写入路径同一口径：标题 + 正文 + 标签（此前丢 tags，会把本该新建的条目误判成重复而丢弃）
    const hash = contentHash({ title: item.title, body: item.body, tags: item.tags || [], level: cfg["dedup.l1.normalizeLevel"] });
    if (seen) {
      if (seen.has(hash)) return "duplicate";
      seen.add(hash);
    }
    if (this.service.index.findByHashActive(hash)) return "duplicate";
    const sameSession = item.session ? this.service.index.findBySessionTitle(item.session, item.title) : null;
    return sameSession ? "merge" : "create";
  }

  progress() {
    return { ...this.state, running: this.running };
  }

  cancel() {
    if (!this.running) return { ok: false, message: "没有正在进行的导入" };
    this.cancelFlag = true;
    return { ok: true };
  }

  /**
   * 执行导入：分批写入 + 每批更新游标（中断后重跑不重复）。
   */
  async apply(opts = {}) {
    if (this.running) return { ok: false, message: "导入已在进行中" };
    const cfg = this.getConfig();
    const sources = this.sources().filter((s) => s.enabled !== false && (!opts.sourceIds || opts.sourceIds.includes(s.id)));
    // import.dryRunFirst：默认必须先干跑过（前端预览过就算），避免"一键导入"盲写
    if (cfg["import.dryRunFirst"] !== false && !opts.confirmed) {
      const fresh = this._lastPreviewAt && Date.now() - this._lastPreviewAt < 10 * 60000;
      if (!fresh) {
        return { ok: false, message: "按设置需先「干跑预览」再导入（10 分钟内有效）", needPreview: true };
      }
    }
    const batchSize = Math.max(20, Math.min(Number(cfg["import.batchSize"] || 1000), 2000));
    const cursors = this._loadCursors();
    this.running = true;
    this.cancelFlag = false;
    this.state = { phase: "scan", done: 0, total: 0, created: 0, merged: 0, skipped: 0, sensitive: 0, startedAt: Date.now() };
    this.emit({ type: "import", phase: "scan", detail: "开始导入扫描" });

    const stats = { created: 0, merged: 0, skipped: 0, sensitive: 0, failed: 0 };
    const queued = [];
    let chain = Promise.resolve();
    // 本轮已处理过的内容指纹：写入是异步的，同一批里先后出现的相同内容在索引里还查不到，
    // 只靠索引判重会漏，于是同一份内容被反复入队反复落库
    const seenHashes = new Set();
    // 导入专用写入选项：整批共用一个延迟落盘窗口（同一个 daily 文件一批只读写一遍），
    // 且不跑 L2/L4 去重钩子、不发 memory-new。历史数据的语义合并交给随后的去重巡检，
    // 不在导入里做——那样每条都要 BM25 候选 + 模型判定，几万条会把 token 和界面一起打爆
    const importWriteOpts = { silent: true, forceDedup: true, skipHooks: true, noBackup: true };
    const flush = async () => {
      if (!queued.length) return;
      const batch = queued.splice(0, batchSize);
      try {
        await this.service.withWriteBatch(async () => {
          for (const item of batch) {
            try {
              const r = await this.service.writeMemory({
                title: item.title,
                body: item.body,
                type: item.type || "daily",
                layer: "l1",
                project: item.project || undefined,
              cwd: item.cwd || undefined,
                agent: item.sourceAgent || agentFromSource(item),
                tags: item.tags || [],
                importance: item.importance || 3,
                session: item.session || "",
                refs: item.refs || [],
                createdAt: item.created || 0,
                allowDuplicate: false,
              }, importWriteOpts);
              if (r.noop) stats.skipped++;
              else stats.created++;
            } catch {
              stats.failed++;
            }
          }
        });
      } catch (e) {
        // 整批落盘失败（磁盘/权限）：这批 MD 没写进去，记失败并如实上报，不静默吞掉
        stats.failed += batch.length;
        this.state.done += batch.length;
        this.emit({ type: "import", phase: "commit", detail: `批次落盘失败：${String(e.message || e)}`, ...stats });
        return;
      }
      this.state.done += batch.length;
      this.state.created = stats.created;
      this.state.merged = stats.merged;
      this.state.skipped = stats.skipped;
      this.emit({ type: "import", phase: "commit", done: this.state.done, total: this.state.total, ...stats });
    };

    try {
      for (const source of sources) {
        if (this.cancelFlag) break;
        if (!source.path || !fs.existsSync(source.path)) continue;
        const parser = pickParser(source);
        this.state.phase = "preview";
        this.emit({ type: "import", phase: "preview", detail: `解析来源：${source.name}` });
        // 每次解析都现取游标：下面 while 每轮都会推进 cursors[source.id]，
        // 游标若固定在循环外，第二轮起又会从字节 0 重读整个来源——同一批数据被反复解析、
        // 反复入队（前端看到的 total 就是这么涨到源数据几倍的）
        const parseInto = (sourceObj) => parser.parse(sourceObj, cursors[source.id], {
          ...cfg,
          batchSize: 2000,
          md: { observationMarkers: cfg["import.md.observationMarkers"] !== false, extractTags: cfg["import.md.extractTags"] !== false, extractWikiLinks: false },
          pathReverse: cfg["classify.pathReverse"] !== false,
          maxChunkBytes: Math.min(Number(cfg["import.maxBatchBytes"] || 104857600), 8 * 1024 * 1024),
          maxFiles: 300,
        }, (item) => {
          if (this.cancelFlag) return;
          const verdict = this._dryRunVerdict(item, cfg, seenHashes);
          if (verdict === "sensitive") {
            stats.sensitive++;
            return;
          }
          if (verdict === "duplicate") {
            stats.skipped++;
            this.state.done++;
            return;
          }
          if (verdict === "merge") stats.merged++;
          if (this.cancelFlag) return;
          item.sourceAgent = source.id.split("-")[0];
          queued.push(item);
          this.state.total++;
          if (queued.length >= batchSize * 2) {
            // 写操作串行排队：解析回调是同步的，必须保证批次不交叉
            chain = chain.then(() => flush()).catch(() => {});
          }
        });
        let res;
        try {
          // 解析器用 more 报告「本轮配额用满、后面还有」，续读到读完为止。
          // 判据不能用产出条数：ZCode 会话库十万行 part 里只有一万多条正文，
          // 按产出数第一轮就"读不满一批"停住，要十几次导入才追得完
          res = parseInto(source);
          let rounds = 0;
          while (res && res.more && !this.cancelFlag && rounds++ < 60) {
            cursors[source.id] = res.nextCursor;
            res = parseInto(source);
          }
        } catch (e) {
          stats.failed++;
          this.emit({ type: "import", phase: "commit", detail: `来源「${source.name}」解析失败：${String(e.message || e)}`, ...stats });
          continue;
        }
        if (res && res.note && !res.items) {
          // 解析器的软失败（表结构不符 / 库被占用等）：不推进游标、记失败并向用户说明
          stats.failed++;
          this.emit({ type: "import", phase: "commit", detail: `来源「${source.name}」未读到内容：${res.note}`, ...stats });
          continue;
        }
        await chain;
        await flush();
        // 游标推进：只有解析成功才写水位，失败下轮重读
        if (res && res.nextCursor && !this.cancelFlag) {
          cursors[source.id] = res.nextCursor;
          cursors[source.id].source = source.kind || "file";
          cursors[source.id].seeded = true;
          this._saveCursors(cursors);
        }
      }
      await chain;
      await flush();
      this.state.phase = "verify";
      this.emit({ type: "import", phase: "verify", detail: "校验写入结果" });
      const verify = this.verify();
      this.state.phase = "done";
      this.running = false;
      const report = this._writeReport(stats, verify);
      this.emit({ type: "import", phase: "done", ...stats, report });
      return { ok: true, ...stats, report, verify, cancelled: this.cancelFlag };
    } catch (e) {
      // 整轮级异常：先把已入队未落盘的条目刷完，再报错（不然这批数据白读）
      try {
        await chain;
        await flush();
      } catch { /* 刷盘失败也要把错误如实上报 */ }
      this.running = false;
      this.emit({ type: "import", phase: "error", detail: String(e.message || e) });
      return { ok: false, message: String(e.message || e), ...stats };
    }
  }

  /** 校验：计数一致 / 索引覆盖 / 抽样回读 / 检索可达 / 孤儿检测 */
  verify() {
    const svc = this.service;
    const files = svc.store.walkMemoryFiles();
    const fileSet = new Set(files);
    const indexed = svc.index.db.prepare("SELECT COUNT(*) AS c FROM mem").get().c;
    const sample = svc.index.db.prepare("SELECT id, path, hash FROM mem ORDER BY RANDOM() LIMIT 20").all();
    let sampleOk = 0;
    for (const s of sample) {
      const text = svc.store.read(s.path);
      if (text != null) sampleOk++;
    }
    // 覆盖率 = 索引行里「MD 文件真实存在」的占比。
    // 此前算的是「索引行 / 文件数」——daily 是一个文件装多条（上千条挤一个文件），
    // 这么算必然几千个百分点，报告里的覆盖率一直是错的
    const orphan = svc.index.db.prepare("SELECT path FROM mem").all().filter((r) => !fileSet.has(r.path)).length;
    return {
      files: files.length,
      indexed,
      coverage: indexed ? Math.round(((indexed - orphan) / indexed) * 1000) / 10 : 100,
      sampleRead: `${sampleOk}/${sample.length}`,
      orphan,
      ftsConsistent: svc.indexStatus().consistent,
    };
  }

  _writeReport(stats, verify) {
    const dir = this.dir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `report-${stamp}.md`);
    const lines = [
      `# 导入报告 · ${new Date().toLocaleString("zh-CN")}`,
      "",
      `新建 ${stats.created} 条 · 合并 ${stats.merged} 条 · 跳过重复 ${stats.skipped} 条`,
      `敏感跳过 ${stats.sensitive} 条 · 失败 ${stats.failed} 条`,
      "",
      "## 校验",
      `- 文件数 ${verify.files} · 索引行 ${verify.indexed} · 覆盖率 ${verify.coverage}%`,
      `- 抽样回读 ${verify.sampleRead}`,
      `- 孤儿索引行 ${verify.orphan}`,
      `- FTS 一致 ${verify.ftsConsistent ? "是" : "否（已自动重建）"}`,
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return file;
  }

  report() {
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.startsWith("report-")).sort().reverse() : [];
    if (!files.length) return { ok: true, files: [], content: "" };
    const latest = path.join(this.dir, files[0]);
    return { ok: true, files, content: fs.readFileSync(latest, "utf8") };
  }

  cursors() {
    return { ok: true, cursors: this._loadCursors(), file: this.cursorFile };
  }

  resetCursor(id) {
    const cursors = this._loadCursors();
    if (id) delete cursors[id];
    else for (const k of Object.keys(cursors)) delete cursors[k];
    this._saveCursors(cursors);
    return { ok: true, cursors };
  }

  /** 动态映射：把用户挑选的表名存进来源配置，解析器据此读增量 */
  mapSave(sourceId, mapping) {
    const list = this.sources();
    const entry = list.find((s) => s.id === sourceId);
    if (!entry) return { ok: false, message: "来源不存在" };
    if (mapping && mapping.table) entry.table = String(mapping.table);
    return this.saveSources(list);
  }
}

function agentFromSource(item) {
  const s = String(item.source || "import");
  return s.split("-")[0] || "import";
}

// 字节数 → token 粗估（CJK 为主时约 1 token/3 字节）
function estimateBytesAsTokens(bytes) {
  return Math.round(Number(bytes || 0) / 3);
}

module.exports = { ImportEngine, DEFAULT_SOURCES };
