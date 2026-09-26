/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 自动化调度器：9 个任务注册表 + 60s tick + 记账持久化 + 时间回拨保护 +
// 追赶式补跑 + 忙时跳过不推进记账 + 串行任务队列 + 单日 token 预算闸门 + 可取消。
// 结构照搬 usage-scheduler.cjs（可行性复核 §4.1 已验证的五个设计）。
"use strict";

const TASK_DEFS = [
  { id: "extract", name: "抽取结构化信息", needsModel: true, defaultInterval: 30, estimate: "每批 20 条约 800 token" },
  { id: "summarize", name: "生成摘要", needsModel: true, defaultInterval: 30, estimate: "每批 20 条约 600 token" },
  { id: "tag", name: "自动打标签", needsModel: true, defaultInterval: 30, estimate: "每批 20 条约 400 token" },
  { id: "classify", name: "项目归类建议", needsModel: false, defaultInterval: 60, estimate: "0（本地算法）" },
  { id: "supersede", name: "失效判定", needsModel: true, daily: "23:00", estimate: "每组约 1,500 token" },
  { id: "distill", name: "L2 蒸馏", needsModel: true, daily: "23:30", estimate: "每项目约 3,000 token" },
  { id: "consolidate", name: "去重合并", needsModel: true, weekly: 0, weeklyTime: "02:00", estimate: "每轮约 5,000 token" },
  { id: "profile", name: "人格 / 偏好画像", needsModel: true, weekly: 0, weeklyTime: "03:00", estimate: "每次约 8,000 token" },
  { id: "index-scan", name: "索引自愈扫描", needsModel: false, defaultInterval: 360, estimate: "0（本地扫描）" },
];

const TICK_MS = 60000;
const FIRST_TICK_DELAY_MS = 90000;

class MemoryScheduler {
  constructor(opts) {
    this.service = opts.service;
    this.tasks = opts.tasks;
    this.getConfig = opts.getConfig;
    this.emit = opts.emit || (() => {});
    this.timer = null;
    this.queue = [];
    this.running = null;
    this.cancelled = false;
    this.history = [];
    this.paused = false;
    this.pausedUntil = 0;
    this._lastTickAt = 0;
    this._draining = false;
  }

  // ---------- 状态 ----------

  taskConfig(id) {
    const cfg = this.getConfig();
    const t = (cfg["auto.tasks"] || {})[id] || {};
    const def = TASK_DEFS.find((x) => x.id === id) || { id };
    return { ...def, ...t };
  }

  state(id) {
    const last = Number(this.service.index.getMeta(`mem_sched_${id}`) || 0);
    return { lastAt: last, nextAt: this._nextAt(id, last) };
  }

  _nextAt(id, last) {
    const t = this.taskConfig(id);
    const now = Date.now();
    // 与 _isDue 同口径：按天/按周的任务「当天/当周跑过就不再跑」，所以显示的下次时间也要跳过本次周期，
    // 否则手动跑过一次之后页面仍显示「下次 今晚 23:30」，而到点根本不会跑（两套口径，用户被误导）
    const ranInSameCycle = (d) => !!last && new Date(last).toDateString() === d.toDateString();
    if (t.weekly !== undefined) {
      const d = new Date();
      const [hh, mm] = String(t.weeklyTime || "03:00").split(":").map(Number);
      const candidate = new Date(d);
      const diff = (t.weekly - d.getDay() + 7) % 7;
      candidate.setDate(d.getDate() + diff);
      candidate.setHours(hh || 3, mm || 0, 0, 0);
      if (candidate.getTime() <= now || ranInSameCycle(candidate)) candidate.setDate(candidate.getDate() + 7);
      return candidate.getTime();
    }
    if (t.daily) {
      const d = new Date();
      const [hh, mm] = String(t.daily).split(":").map(Number);
      const candidate = new Date(d);
      candidate.setHours(hh || 23, mm || 0, 0, 0);
      if (candidate.getTime() <= now || ranInSameCycle(candidate)) candidate.setDate(candidate.getDate() + 1);
      return candidate.getTime();
    }
    const intervalMin = Number(t.intervalMin || t.defaultInterval || 30);
    return (last || now) + intervalMin * 60000;
  }

  status() {
    const cfg = this.getConfig();
    const usage = this.service.index.llmUsageToday();
    const limit = Number(cfg["auto.dailyTokenLimit"] ?? 200000);
    const pending = this.pendingCounts();
    return {
      enabled: cfg["auto.enabled"] !== false,
      paused: this.paused,
      pausedUntil: this.pausedUntil,
      running: this.running ? { id: this.running.id, startedAt: this.running.startedAt, phase: this.running.phase } : null,
      queue: this.queue.map((q) => q.id),
      todayTokens: usage.tokens,
      todayCalls: usage.calls,
      dailyTokenLimit: limit,
      overBudget: limit > 0 && usage.tokens >= limit,
      pending,
      tasks: TASK_DEFS.map((d) => {
        const t = this.taskConfig(d.id);
        const st = this.state(d.id);
        const stats = this.taskStats(d.id);
        return {
          id: d.id,
          name: d.name,
          needsModel: d.needsModel,
          estimate: d.estimate,
          enabled: t.enabled !== false,
          intervalMin: t.intervalMin || t.defaultInterval || null,
          daily: t.daily || null,
          weekly: t.weekly !== undefined ? t.weekly : null,
          weeklyTime: t.weeklyTime || null,
          batchSize: t.batchSize || null,
          thresholdCount: t.thresholdCount || null,
          lastAt: st.lastAt,
          nextAt: st.nextAt,
          successRate: stats.successRate,
          runs: stats.runs,
          tokens: stats.tokens,
        };
      }),
    };
  }

  taskStats(id) {
    const rows = this.history.filter((h) => h.task === id);
    if (!rows.length) return { runs: 0, successRate: null, tokens: 0 };
    const ok = rows.filter((r) => r.ok).length;
    return {
      runs: rows.length,
      successRate: Math.round((ok / rows.length) * 1000) / 10,
      tokens: rows.reduce((s, r) => s + (r.tokens || 0), 0),
    };
  }

  pendingCounts() {
    const db = this.service.index.db;
    const unprocessed = db.prepare("SELECT COUNT(*) AS c FROM mem WHERE ai_processed = 0 AND (valid_to IS NULL OR valid_to > ?)").get(Date.now()).c;
    const classified = db.prepare("SELECT COUNT(*) AS c FROM mem WHERE (project IS NULL OR project = '') AND (valid_to IS NULL OR valid_to > ?)").get(Date.now()).c;
    const review = db.prepare("SELECT COUNT(*) AS c FROM review_queue WHERE status = 'pending'").get().c;
    const pendingDedup = db.prepare("SELECT COUNT(*) AS c FROM mem WHERE dedup_status = 'pending'").get().c;
    return { unprocessed, classified, review, dedup: pendingDedup };
  }

  timeline(limit) {
    return this.history.slice(-(limit || 50)).reverse();
  }

  // ---------- 生命周期 ----------

  start() {
    if (this.timer) return;
    this._lastTickAt = Date.now();
    this.timer = setInterval(() => {
      this._tick().catch((e) => this.emit({ type: "task", phase: "error", detail: String(e.message || e) }));
    }, TICK_MS);
    this._firstTick = setTimeout(() => this._tick().catch(() => {}), FIRST_TICK_DELAY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this._firstTick) clearTimeout(this._firstTick);
    this.timer = null;
    this._firstTick = null;
  }

  /** 停表并等在途任务收尾（应用退出路径；超时兜底——索引缺行由 index-scan 自愈） */
  async stopAndDrain(timeoutMs = 8000) {
    this.stop();
    this.cancelled = true; // drain 队列不再取新任务
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  pause(until) {
    this.paused = true;
    this.pausedUntil = until || 0;
    this.emit({ type: "task", phase: "paused", detail: until ? `暂停到 ${new Date(until).toLocaleString("zh-CN")}` : "已暂停自动化" });
  }

  resume() {
    this.paused = false;
    this.pausedUntil = 0;
    this.emit({ type: "task", phase: "resumed" });
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    this.emit({ type: "task", phase: "cancelled", detail: "已取消排队中的任务" });
    return { ok: true };
  }

  // ---------- tick ----------

  async _tick() {
    const cfg = this.getConfig();
    if (cfg["auto.enabled"] === false) return;
    const now = Date.now();
    if (this.paused) {
      if (this.pausedUntil && now >= this.pausedUntil) this.resume();
      else return;
    }
    // 时间回拨保护：系统时间被调早时不误触发
    if (now < this._lastTickAt - 5 * 60000) {
      for (const d of TASK_DEFS) this.service.index.setMeta(`mem_sched_${d.id}`, String(now));
    }
    this._lastTickAt = now;

    if (this.running) return; // 忙时跳过且不推进记账：结束后自然补跑

    // 与任务同 tick 的周期工作：自动同步 + Agent 连接巡检（各自按自己的间隔节流）
    await this.maybeAutoSync(now).catch(() => {});
    await this.maybeVerifyAgents(now).catch(() => {});

    const due = [];
    for (const def of TASK_DEFS) {
      const t = this.taskConfig(def.id);
      if (t.enabled === false) continue;
      const last = Number(this.service.index.getMeta(`mem_sched_${def.id}`) || 0);
      if (this._isDue(def.id, last, now)) due.push(def.id);
    }
    if (!due.length) return;

    const budget = this._budgetGate(due);
    for (const id of budget.allowed) this.queue.push({ id, at: now });
    if (budget.blocked.length) {
      this.emit({ type: "auto-paused", detail: `已达单日 token 上限，跳过：${budget.blocked.join("、")}` });
      // 达上限时推进记账，避免每 tick 都尝试
      for (const id of budget.blocked) this.service.index.setMeta(`mem_sched_${id}`, String(now));
    }
    await this._drain();
  }

  _isDue(id, last, now) {
    const t = this.taskConfig(id);
    if (t.weekly !== undefined) {
      const d = new Date(now);
      if (d.getDay() !== Number(t.weekly)) return false;
      const [hh, mm] = String(t.weeklyTime || "03:00").split(":").map(Number);
      const todayTarget = new Date(d).setHours(hh || 3, mm || 0, 0, 0);
      if (now < todayTarget) return false;
      const lastDate = last ? new Date(last).toDateString() : "";
      return lastDate !== d.toDateString();
    }
    if (t.daily) {
      const d = new Date(now);
      const [hh, mm] = String(t.daily).split(":").map(Number);
      if (now < new Date(d).setHours(hh || 23, mm || 0, 0, 0)) return false;
      const lastDate = last ? new Date(last).toDateString() : "";
      return lastDate !== d.toDateString();
    }
    const interval = Number(t.intervalMin || t.defaultInterval || 30) * 60000;
    return !last || now - last >= interval;
  }

  _budgetGate(ids) {
    const cfg = this.getConfig();
    const limit = Number(cfg["auto.dailyTokenLimit"] ?? 200000);
    if (!limit) return { allowed: ids, blocked: [] };
    const used = this.service.index.llmUsageToday().tokens;
    if (used < limit) return { allowed: ids, blocked: [] };
    const action = cfg["auto.overBudgetAction"] || "pause";
    if (action === "ignore") return { allowed: ids, blocked: [] };
    const allowed = [];
    const blocked = [];
    for (const id of ids) {
      const def = TASK_DEFS.find((d) => d.id === id);
      if (def && def.needsModel) blocked.push(id);
      else allowed.push(id);
    }
    return { allowed, blocked };
  }

  // ---------- 执行 ----------

  async _drain() {
    if (this._draining) return; // 同时只允许一条 drain，后到的队列项由它在下一圈取走
    this._draining = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const item = this.queue.shift();
        const r = await this.runTask(item.id, { auto: true });
        if (r && r.retry) {
          // 已有任务在跑：把项放回队尾就结束本轮（下一 tick 再来）。
          // 绝不能在同一个 while 里立刻重试——那会形成微任务死循环，定时器与 I/O 全被饿死
          this.queue.unshift(item);
          break;
        }
        if (r && r.skipped === "budget") {
          this.emit({ type: "task", task: item.id, phase: "skipped", detail: `超预算跳过：${item.id}` });
          break; // 超预算：本轮剩下的模型任务也别跑了，下轮 tick 再试
        }
      }
      this.cancelled = false;
    } finally {
      this._draining = false;
    }
  }

  async runTask(id, opts = {}) {
    const def = TASK_DEFS.find((d) => d.id === id);
    if (!def) return { ok: false, message: `未知任务：${id}` };
    // 预算闸门在真正执行前再判一次：手动触发与阈值触发都可能绕过 _tick 里那一次
    const gate = this._budgetGate([id]);
    if (gate.blocked.length && !opts.ignoreBudget) {
      const msg = `已达单日 token 上限（${this.service.index.llmUsageToday().tokens}），本轮跳过「${def.name}」`;
      this.emit({ type: "auto-paused", detail: msg });
      return { ok: false, message: msg, skipped: "budget" };
    }
    if (this.running) return { ok: false, message: `已有任务在跑：${this.running.id}`, retry: true };
    const t = this.taskConfig(id);
    const startedAt = Date.now();
    this.running = { id, startedAt, phase: "start" };
    this.emit({ type: "task", task: id, phase: "start", detail: `开始执行「${def.name}」` });

    const record = { task: id, at: startedAt, ok: false, ms: 0, tokens: 0, detail: "" };
    try {
      const batch = Number(opts.batchSize || t.batchSize || 20);
      const result = await this._dispatch(id, batch);
      record.ok = true;
      record.tokens = result.tokens || 0;
      record.detail = result.detail || "";
      record.processed = result.processed || 0;
      record.updated = result.updated || 0;
      if (result.report) record.report = result.report;
      this.emit({ type: "task", task: id, phase: "done", detail: record.detail, tokens: record.tokens, ...result });
    } catch (e) {
      record.detail = String(e.message || e);
      record.errorCode = e.code || "";
      this.emit({ type: "task", task: id, phase: "error", detail: record.detail, taskId: id });
    } finally {
      record.ms = Date.now() - startedAt;
      this.running = null;
      this.history.push(record);
      const keep = Number(this.getConfig()["auto.logKeepCount"] || 200);
      if (this.history.length > keep) this.history = this.history.slice(-keep);
      // 记账（mem_sched_<id>）决定"下次什么时候到期"：
      //   自动执行无论成败都推进 —— 否则失败的任务下一 tick 立刻重试，形成每 60 秒一次的报错风暴；
      //   手动「立即执行」只在成功时推进 —— 否则一次失败的试跑会把当天还没到点的按天任务顶掉
      //   （蒸馏手动失败后当天 23:30 不再跑，L2 白等一天）。
      if (record.ok || opts.auto) this.service.index.setMeta(`mem_sched_${id}`, String(Date.now()));
      this.pruneHistory();
      this.service.index.setMeta("mem_sched_history", JSON.stringify(this.history.slice(-200)));
    }
    return record;
  }

  _dispatch(id, batch) {
    const tasks = this.tasks;
    switch (id) {
      case "extract":
      case "summarize":
        return tasks.runExtract(batch);
      case "tag":
        return tasks.runTag(batch);
      case "classify":
        return Promise.resolve(tasks.runClassify());
      case "supersede":
        return tasks.runSupersede(batch);
      case "distill":
        return tasks.runDistill({});
      case "consolidate":
        return this._runConsolidate();
      case "profile":
        return tasks.runProfile({});
      case "index-scan":
        return Promise.resolve(this._runIndexScan());
      default:
        throw new Error(`任务 ${id} 未实现`);
    }
  }

  async _runConsolidate() {
    if (!this.dedup) return { processed: 0, tokens: 0, detail: "去重引擎未装载" };
    const r = await this.dedup.scanAll({ useModel: true });
    return { processed: r.scanned, updated: r.acted, tokens: r.tokens, detail: `巡检 ${r.scanned} 条：自动合并 ${r.merged} / 进队列 ${r.queued}` };
  }

  _runIndexScan() {
    if (this.service.index.readOnly) {
      return { processed: 0, updated: 0, tokens: 0, detail: "索引库只读模式，跳过自愈扫描" };
    }
    const files = this.service.store.walkMemoryFiles();
    const onDisk = new Set(files);
    let fixed = 0;
    const indexed = new Set(this.service.index.db.prepare("SELECT DISTINCT path FROM mem").all().map((r) => r.path));
    for (const rel of files) {
      if (!indexed.has(rel)) {
        this.service.reindexFile(rel);
        fixed++;
      }
    }
    // 反向自愈：索引有、磁盘无（应用关闭期间文件被外部移动/删除，watcher 没看到，
    // 或历史误索引的范围外文件）→ 清掉失效行，否则搜索结果永远指向不存在的文件
    const pruned = this.service.pruneOrphans(onDisk);
    const stat = this.service.index.selfCheck();
    return { processed: files.length, updated: fixed, tokens: 0, detail: `扫描 ${files.length} 个文件，补索引 ${fixed} 条，清失效 ${pruned} 条${stat.rebuilt ? "，并重建了 FTS" : ""}` };
  }

  /** 自动定时同步：sync.auto + sync.intervalMin（此前只有手动按钮，配置项是"假旋钮"） */
  async maybeAutoSync(now) {
    const cfg = this.getConfig();
    if (cfg["sync.enabled"] === false || cfg["sync.auto"] === false) return;
    if (!this.syncer || typeof this.syncer.run !== "function") return;
    if (this.syncer.running) return;
    if (!this.syncer.configured()) return;
    const interval = Math.max(5, Number(cfg["sync.intervalMin"] || 60)) * 60000;
    const last = Number(this.service.index.getMeta("mem_last_sync_at") || 0);
    if (last && now - last < interval) return;
    this.service.index.setMeta("mem_last_sync_at", String(now));
    this.emit({ type: "sync", stage: "connect", detail: "定时同步启动", running: true, percent: 1 });
    const r = await this.syncer.run();
    this.emit({ type: "sync", stage: r && r.ok ? "done" : "error", detail: r && r.ok ? "定时同步完成" : `定时同步失败：${(r && r.message) || ""}`, running: false, percent: 100 });
  }

  /** 连接状态巡检：agents.verifyInterval 到点后重测已注入 Agent 的配置态 */
  async maybeVerifyAgents(now) {
    const cfg = this.getConfig();
    if (cfg["agents.autoVerify"] === false) return;
    if (!this.verifyHook) return;
    const interval = Math.max(30, Number(cfg["agents.verifyInterval"] || 300)) * 1000;
    const last = Number(this.service.index.getMeta("mem_last_verify_at") || 0);
    if (last && now - last < interval) return;
    this.service.index.setMeta("mem_last_verify_at", String(now));
    try {
      await this.verifyHook();
    } catch { /* 巡检失败下轮再来 */ }
  }

  /** 加载上次历史（进程重启后时间线不空） */
  loadHistory() {
    try {
      const raw = this.service.index.getMeta("mem_sched_history");
      if (raw) this.history = JSON.parse(raw) || [];
    } catch {
      this.history = [];
    }
    this.pruneHistory();
  }

  /** 任务日志按保留天数裁剪（配置项 auto.logKeepDays 的真正落点） */
  pruneHistory() {
    const days = Number(this.getConfig()["auto.logKeepDays"] || 30);
    if (!days) return;
    const cutoff = Date.now() - days * 86400000;
    this.history = this.history.filter((h) => (h.at || 0) >= cutoff);
  }

  /** 触发阈值：新增 L1 达阈值时立即跑（不等定时）；任务关着/自动化暂停/总开关关着就不触发 */
  maybeTriggerByThreshold() {
    if (this.paused) return false;
    if (this.getConfig()["auto.enabled"] === false) return false;
    const t = this.taskConfig("extract");
    if (t.enabled === false) return false;
    const threshold = Number(t.thresholdCount || 20);
    const count = this.service.index.db.prepare("SELECT COUNT(*) AS c FROM mem WHERE ai_processed = 0 AND (valid_to IS NULL OR valid_to > ?)").get(Date.now()).c;
    if (count >= threshold && !this.queue.some((q) => q.id === "extract")) {
      this.queue.push({ id: "extract", at: Date.now() });
      void this._drain();
      return true;
    }
    return false;
  }
}

module.exports = { MemoryScheduler, TASK_DEFS };
