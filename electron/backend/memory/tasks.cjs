/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · AI 处理任务实现：抽取（摘要/重要度）、打标、归类建议、失效判定、L2 蒸馏、人格画像。
// 每个任务都是「取素材 → 调模型（走 LlmClient 的标签路由）→ 校验结构 → 回写 MD + 索引 → 记账」，
// 失败一律不破坏已有数据；结构化输出解析失败只跳过本批，不写半成品。
"use strict";

const fs = require("fs");
const path = require("path");

const { parseFrontmatter, parseDailySections } = require("./store.cjs");
const { normalizeTags } = require("./service.cjs");
const { parsePinnedLines, mergePinned } = require("./pinned.cjs");
const profileCache = require("./profile-cache.cjs");

const MAX_BODY_FOR_PROMPT = 700;

// 结构化大输出（L2 蒸馏 / 人格画像）的输出预算：即使用户没开思考，思考型模型（glm-5.3-flash 这类）
// 也会先写一坨 reasoning_content，它与 JSON 一起计入 output token —— 4000 时几十条素材必被截断，
// 截断的 JSON 配不平括号、整轮白跑（L2 一直空着的第二个根因）。8000 给「思考 + 完整 JSON」留足余量，
// 没用满的额度不计费。
const BIG_JSON_MAX_TOKENS = 8000;
// 配套超时：思考 + 长 JSON 常在 60~120 秒之间，全局默认 60s 会把「正在正常生成的调用」掐死
const BIG_JSON_TIMEOUT_SEC = 180;

/** 结构化输出的 token 预算：思考型模型先写一段 reasoning_content（实测 2~3k token）再写 JSON，
 *  所以预算里必须有「思考底数」——只按条数算（如 20 条给 1800）会在第一次调用就被截断，
 *  截断的 JSON 配不平 → 整批白跑（extract 历史上约四分之一的失败就是这个）。 */
function jsonBudgetFor(count, perItem) {
  return Math.min(BIG_JSON_MAX_TOKENS, 2600 + count * perItem);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    /* 尝试清洗尾随逗号与控制字符 */
  }
  try {
    const cleaned = s.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function extractJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  // 逐字符配平括号，容错模型在 JSON 后附带解释文字。
  let depth = 0;
  let startIdx = -1;
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
    else if (c === "{" || c === "[") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth < 0) {
        depth = 0;
        startIdx = -1;
      } else if (depth === 0 && startIdx >= 0) {
        const parsed = safeParse(slice.slice(startIdx, i + 1));
        if (parsed) return parsed;
        startIdx = -1;
      }
    }
  }
  // 截断挽救（输出撞 maxTokens 上限）：截取到最后一个完整的对象结尾，自动补全闭合符号
  if (startIdx >= 0) {
    const lastBrace = slice.lastIndexOf("}");
    if (lastBrace > startIdx) {
      const sub = slice.slice(startIdx, lastBrace + 1);
      const stack = [];
      let subInStr = false;
      let subEsc = false;
      for (let j = 0; j < sub.length; j++) {
        const ch = sub[j];
        if (subInStr) {
          if (subEsc) subEsc = false;
          else if (ch === "\\") subEsc = true;
          else if (ch === '"') subInStr = false;
          continue;
        }
        if (ch === '"') subInStr = true;
        else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "}" || ch === "]") {
          if (stack.length && stack[stack.length - 1] === ch) stack.pop();
        }
      }
      const repaired = sub + stack.reverse().join("");
      const recovered = safeParse(repaired);
      if (recovered) return recovered;
    }
  }
  return null;
}

/** 从模型输出里取出条目数组：兼容 {"items":[...]} 与裸数组 [...] 两种形态。
 *  同时兼容常见别名 data / results / list / memories / records 及数字键字典形态。 */
function pickItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["items", "data", "results", "list", "result", "memories", "records", "tags"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    const keys = Object.keys(parsed);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys.map((k) => {
        const v = parsed[k];
        if (Array.isArray(v)) return { i: Number(k), tags: v };
        if (v && typeof v === "object") return { i: Number(k), ...v };
        return { i: Number(k), value: v };
      });
    }
  }
  return null;
}

/** 条目有效性：必须能对上本轮素材的序号。
 *  兼容模型使用 id / index / no / item 等别名字段作为序号。 */
function validEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const rawIdx = e.i ?? e.id ?? e.index ?? e.no ?? e.item;
    const i = Number(rawIdx);
    if (Number.isFinite(i) && i >= 1) {
      out.push({ ...e, i: Math.floor(i) });
    }
  }
  return out;
}

class MemoryTasks {
  constructor(opts) {
    this.service = opts.service;
    this.client = opts.client;
    this.emit = opts.emit || (() => {});
    this.rootDir = opts.rootDir;
    /** 调度器注入的进度回调（(percent, phase) => void）；独立调用（自检脚本）时为 null */
    this.onProgress = opts.onProgress || null;
  }

  /** 上报运行进度：多项目/多组任务按 i/N 报真实推进，单次调用任务按阶段报 */
  _progress(percent, phase) {
    if (typeof this.onProgress === "function") this.onProgress(percent, phase);
  }

  flat() {
    return this.service.flat();
  }

  /** 待处理记忆的统一取数口径（任务与 pendingCounts 共用，避免两套数字对不上）。
   *
   *  两条排除规则，都是「让 AI 别做无意义功」：
   *  1. layer='l2'：AI 自己蒸馏出来的结论，summary 在 _writeL2 写入时就生成了，
   *     再送去 extract 等于「让 AI 给 AI 的结论写摘要」。实测占积压 26%（7621/28985）。
   *  2. 正文短于 auto.minBodyBytes：一句话提问（「npm install 为什么这么慢？」）
   *     提炼不出结论，摘要只能复述原文。默认 0 不过滤，保持历史行为。 */
  _minBodyBytes() {
    const n = Number(this.flat()["auto.minBodyBytes"] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  _pending(limit, extraWhere = "") {
    const db = this.service.index.db;
    return db.prepare(`
      SELECT id, path, anchor, type, layer, title, summary, tags, project, agent, importance, created
      FROM mem
      WHERE ai_processed = 0 AND COALESCE(layer, 'l1') != 'l2'
        AND (valid_to IS NULL OR valid_to > ?)
        AND COALESCE(size, 0) >= ? ${extraWhere}
      ORDER BY created DESC LIMIT ?
    `).all(Date.now(), this._minBodyBytes(), limit).filter((r) => this._allowedByPrivacy(r));
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

  /** 单次任务内的批次数：由 models.maxInflight 决定（上限 8）。
   *
   *  为什么需要多批：调度器每个 intervalMin 才跑一次、一次只处理 batchSize 条，
   *  积压两万条时吞吐被「间隔 × 批量」卡死（20 条/30 分钟 = 960 条/天 ≈ 30 天）。
   *  单批加大到 50 条行不通 —— 实测 3 批里 2 批 out=8000、条目 0/50（输出撞上限被截断），
   *  所以只能靠「多批并行」而不是「单批变大」。 */
  _batchConcurrency() {
    const n = Number(this.flat()["models.maxInflight"] || 0);
    return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 1;
  }

  /** 把 items 按 perBatch 切片，逐批并发执行 fn，返回每批结果（顺序与切片一致）。
   *  进度按「完成批数」上报，而不是按批次序号 —— 并发下完成顺序是乱的。
   *  ⚠️ 切片后必须把序号重编成批内 1..n：模型只认 prompt 里给它的序号，
   *  沿用全局序号（第二批是 [21]..[40]）会让模型返回的 [1]..[20] 一条都对不上，
   *  整批静默丢弃。 */
  async _runBatches(items, perBatch, from, to, fn) {
    const chunks = [];
    for (let i = 0; i < items.length; i += perBatch) chunks.push(items.slice(i, i + perBatch));
    let finished = 0;
    return Promise.all(chunks.map(async (chunk, idx) => {
      const local = chunk.map((x, k) => ({ ...x, i: k + 1 }));
      const r = await fn(local, idx);
      finished++;
      this._progress(from + Math.round((finished / chunks.length) * (to - from)), `完成 ${finished}/${chunks.length} 批`);
      return r;
    }));
  }

  async runExtract(batchSize) {
    const perBatch = batchSize || 20;
    const conc = this._batchConcurrency();
    const rows = this._pending(perBatch * conc);
    if (!rows.length) return { processed: 0, tokens: 0, detail: "没有待处理的记忆" };
    this._progress(12, `读取 ${rows.length} 条待处理记忆（${conc} 批并行）`);
    const bodies = this._readBodies(rows.map((r) => r.id));
    const items = rows.map((r, i) => ({ i: i + 1, row: r, body: (bodies.get(r.id) || "").slice(0, MAX_BODY_FOR_PROMPT) }));

    const results = await this._runBatches(items, perBatch, 12, 88, (chunk) => this._extractBatch(chunk));

    // 全部批次都调用失败（模型不可用）→ 上抛，走 runTask 的 catch：
    // 「N 批全部结构无法解析」会掩盖真正原因，用户需要看到「没有可用模型」
    const errs = results.filter((r) => r.error);
    if (errs.length === results.length) throw new Error(errs[0].error);

    const tokens = results.reduce((s, r) => s + r.tokens, 0);
    const ids = results.flatMap((r) => r.ids);
    const done = results.reduce((s, r) => s + r.done, 0);
    if (ids.length) this._markProcessed(ids);

    const failed = results.filter((r) => !r.ok).length;
    const truncated = results.filter((r) => r.truncated).length;
    const parts = [`处理 ${rows.length} 条，更新 ${done} 条`];
    if (failed) parts.push(`${failed}/${results.length} 批结构无法解析（下轮重试）`);
    if (truncated) parts.push(`${truncated} 批输出被截断`);
    return {
      ok: failed === results.length ? false : undefined,
      processed: rows.length,
      updated: done,
      tokens,
      detail: parts.join("，"),
    };
  }

  /** 抽取单批：调模型 → 解析 → 逐条写回。返回 { ok, tokens, done, ids, truncated, error } */
  async _extractBatch(items) {
    const prompt = [
      "以下是用户的一批原始记忆记录。请为每条：",
      "(a) 补一个 ≤120 字的中文摘要（抓住结论与关键细节，不要复述标题）",
      "(b) 判断重要度 1~5（5=重要决策/结论，3=日常记录，1=闲聊）",
      '只输出严格 JSON 对象，形如 {"items":[{"i":1,"summary":"...","importance":3}]}；',
      `items 必须包含全部 ${items.length} 条，不要任何解释文字。`,
      "",
      ...items.map((x) => `[${x.i}] 标题：${x.row.title}\n内容：${x.body}`),
    ].join("\n");

    const budget = jsonBudgetFor(items.length, 160);
    let result;
    try {
      result = await this.client.call({
        task: "extract",
        system: "你是记忆整理助手，只输出 JSON。",
        messages: [{ role: "user", content: prompt }],
        jsonMode: true,
        maxTokens: budget,
        timeoutSec: BIG_JSON_TIMEOUT_SEC,
      });
    } catch (e) {
      return { ok: false, tokens: 0, done: 0, ids: [], error: String(e.message || e) };
    }
    const tokens = result.usage.input + result.usage.output;

    // jsonMode 下模型只能输出对象（response_format=json_object），所以取 items 而不是裸数组；
    // 条目还必须能对上本轮序号，否则是模型复述 prompt 被误抓成的 [1] 这类垃圾
    const entries = validEntries(pickItems(extractJson(result.text)));
    if (!entries.length) {
      // 截断与"模型没按格式吐"要分开说：前者是输出预算问题，后者要看模型本身
      const truncated = result.finishReason === "length" || (result.usage && result.usage.output >= budget - 100);
      return { ok: false, tokens, done: 0, ids: [], truncated };
    }
    let done = 0;
    // 只标记模型实际返回过的条目：漏返回的（target 为 undefined）保持 pending，
    // 下轮重试。曾经整批标记 done，模型漏掉的条目被静默消耗、永远不再处理。
    const processedIds = [];
    for (const entry of entries) {
      const target = items.find((x) => Number(entry.i) === x.i);
      if (!target) continue;
      const patch = {};
      if (entry.summary && String(entry.summary).trim()) patch.summary = String(entry.summary).trim().slice(0, 240);
      const imp = Number(entry.importance);
      if (Number.isFinite(imp) && imp >= 1 && imp <= 5 && target.row.importance === 3) patch.importance = Math.round(imp);
      // 只把真正写入的条目标记为已处理：给了序号却全无有效内容（空摘要、越界重要度）
      // 属于模型没干活，标记了就等于把这条记忆静默吞掉
      if (Object.keys(patch).length) {
        processedIds.push(target.row.id);
        await this.service.updateMemory(target.row.id, patch);
        done++;
      }
    }
    // 单批无有效写入不算致命（其余批可能正常），但这一批的条目保持 pending 下轮重试
    return { ok: processedIds.length > 0, tokens, done, ids: processedIds };
  }

  async runTag(batchSize) {
    const perBatch = batchSize || 20;
    const conc = this._batchConcurrency();
    const rows = this._pending(perBatch * conc);
    if (!rows.length) return { processed: 0, tokens: 0, detail: "没有待处理的记忆" };
    this._progress(12, `读取 ${rows.length} 条待打标记忆（${conc} 批并行）`);
    const existing = this._topTags(40);
    const bodies = this._readBodies(rows.map((r) => r.id));
    const items = rows.map((r, i) => ({ i: i + 1, row: r, body: (bodies.get(r.id) || "").slice(0, MAX_BODY_FOR_PROMPT) }));

    const results = await this._runBatches(items, perBatch, 12, 88, (chunk) => this._tagBatch(chunk, existing));

    const errs = results.filter((r) => r.error);
    if (errs.length === results.length) throw new Error(errs[0].error);

    const tokens = results.reduce((s, r) => s + r.tokens, 0);
    const ids = results.flatMap((r) => r.ids);
    const done = results.reduce((s, r) => s + r.done, 0);
    if (ids.length) this._markProcessed(ids);

    const failed = results.filter((r) => !r.ok).length;
    const truncated = results.filter((r) => r.truncated).length;
    const parts = [`打标 ${done} 条`];
    if (failed) parts.push(`${failed}/${results.length} 批结构无法解析（下轮重试）`);
    if (truncated) parts.push(`${truncated} 批输出被截断`);
    return {
      ok: failed === results.length ? false : undefined,
      processed: rows.length,
      updated: done,
      tokens,
      detail: parts.join("，"),
    };
  }

  /** 打标单批。existing 是已有标签池（供复用），各批共用同一份快照 */
  async _tagBatch(items, existing) {
    const prompt = [
      "为每条记忆抽 2~5 个标签（中文优先，专有名词保留原形）。优先复用已有标签；只有确实不覆盖时才造新标签。",
      `已有标签（供复用）：${existing.join("、")}`,
      '只输出严格 JSON 对象，形如 {"items":[{"i":1,"tags":["索引","性能"]}]}；',
      `items 必须包含全部 ${items.length} 条。`,
      "",
      ...items.map((x) => `[${x.i}] 标题：${x.row.title}\n内容：${x.body}`),
    ].join("\n");

    const budget = jsonBudgetFor(items.length, 80);
    let result;
    try {
      result = await this.client.call({
        task: "tag",
        system: "你是打标签助手，只输出 JSON。",
        messages: [{ role: "user", content: prompt }],
        jsonMode: true,
        maxTokens: budget,
        timeoutSec: BIG_JSON_TIMEOUT_SEC,
      });
    } catch (e) {
      return { ok: false, tokens: 0, done: 0, ids: [], error: String(e.message || e) };
    }
    const tokens = result.usage.input + result.usage.output;
    const entries = validEntries(pickItems(extractJson(result.text)));
    if (!entries.length) {
      const truncated = result.finishReason === "length" || (result.usage && result.usage.output >= budget - 100);
      return { ok: false, tokens, done: 0, ids: [], truncated };
    }
    let done = 0;
    // 只标记模型实际返回过的条目（同上：漏返回的保持 pending 下轮重试）
    const processedIds = [];
    for (const entry of entries) {
      const target = items.find((x) => Number(entry.i) === x.i);
      if (!target || !Array.isArray(entry.tags)) continue;
      const merged = normalizeTags([...(target.row.tags ? String(target.row.tags).split(",") : []), ...entry.tags]);
      if (merged.length) {
        processedIds.push(target.row.id);
        await this.service.updateMemory(target.row.id, { tags: merged });
        done++;
      }
    }
    return { ok: processedIds.length > 0, tokens, done, ids: processedIds };
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
    // 判重 SQL 备好复用：循环内 prepare 等于每行重新编译
    const dupStmt = this.service.index.db.prepare(
      "SELECT id FROM review_queue WHERE kind = 'classify' AND status = 'pending' AND json_extract(payload, '$.memoryId') = ?",
    );
    this._progress(15, `本地匹配 ${generalRows.length} 条未归类`);
    for (let i = 0; i < generalRows.length; i++) {
      const row = generalRows[i];
      if (i % 10 === 9 || i === generalRows.length - 1) this._progress(15 + Math.round(((i + 1) / Math.max(1, generalRows.length)) * 70), `本地匹配 ${i + 1}/${generalRows.length} 条`);
      const hit = this.service.registry.suggest(row.title, threshold);
      if (!hit) continue;
      if (dupStmt.get(row.id)) continue;
      const clsPayload = {
        slug: hit.slug, name: hit.name, score: hit.score,
        candidate: row.title, memoryId: row.id, title: row.title, path: row.path,
      };
      this.service.autoConfirmReview("classify", this.service.index.reviewAdd("classify", clsPayload), clsPayload);
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
    // auto.tasks 是 map 类型整键（WHOLE_KEYS），flat() 不拆它——点路径读恒为 undefined，
    // 曾导致「requireConfirm=false 时高置信自动应用」分支是死代码。按 map 结构取子对象。
    const autoApply = (this.flat()["auto.tasks"]?.supersede || {}).autoApplyConfidence;
    let suggestions = 0;
    let applied = 0;
    let dropped = 0;
    let tokens = 0;
    /** 结构解析失败的组数：此前 extractJson 失败会静默退化成「没有矛盾」，
     *  模型一直吐垃圾时用户只看到「产出 0 条待确认」，无从判断是没矛盾还是解析挂了。 */
    let parseFailed = 0;
    // 组内取数 SQL 备好复用（5 组 × 每次 prepare = 5 次无谓编译）
    const rowsStmt = db.prepare(`
      SELECT id, title, summary, created, tags FROM mem
      WHERE layer = 'l2' AND valid_to IS NULL AND superseded_by IS NULL
        AND COALESCE(project, '') = ?
      ORDER BY created DESC LIMIT ?
    `);

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      this._progress(12 + Math.round((gi / groups.length) * 72), `判定第 ${gi + 1}/${groups.length} 组（${g.project || "通用"}）`);
      const rows = rowsStmt.all(g.project, Math.min(batchSize || 20, 12));
      if (rows.length < 2) continue;
      const knownIds = new Set(rows.map((r) => r.id));
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
        maxTokens: BIG_JSON_MAX_TOKENS,
        timeoutSec: BIG_JSON_TIMEOUT_SEC,
      });
      tokens += result.usage.input + result.usage.output;
      const parsedRaw = extractJson(result.text);
      if (!parsedRaw) parseFailed++;
      const parsed = parsedRaw || {};
      const pairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
      for (const p of pairs) {
        if (!p.oldId || !p.newId || p.oldId === p.newId) continue;
        // 模型复述长 id 会偶发漂移（mem_20260822_xxx 写成 mem_20260817_xxx 这类日期错位，后缀却是对的）：
        // 错 id 入队后既查不到记忆也无法裁决，只会在收件箱堆成"处理必失败"的死项。必须逐字命中本轮素材才收。
        if (!knownIds.has(p.oldId) || !knownIds.has(p.newId)) { dropped++; continue; }
        const conf = Number(p.confidence) || 0.5;
        if (!requireConfirm && autoApply && conf >= Number(autoApply)) {
          const r = await this.service.markSuperseded(p.oldId, p.newId, p.reason || "AI 高置信判定");
          if (r.ok) applied++;
          continue;
        }
        const supPayload = {
          oldId: p.oldId, newId: p.newId, confidence: conf,
          reason: p.reason || "", project: g.project,
          oldTitle: rows.find((x) => x.id === p.oldId)?.title,
          newTitle: rows.find((x) => x.id === p.newId)?.title,
        };
        this.service.autoConfirmReview("supersede", this.service.index.reviewAdd("supersede", supPayload), supPayload);
        suggestions++;
      }
    }
    this.emit({ type: "supersede-suggest", count: suggestions });
    return { processed: groups.length, updated: suggestions + applied, tokens, detail: `产出 ${suggestions} 条待确认 + 自动应用 ${applied} 条${dropped ? `，丢弃 ${dropped} 条引用不存在的无效建议` : ""}${parseFailed ? `，${parseFailed} 组结构无法解析被跳过` : ""}` };
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
    let dropped = 0;
    /** 结构解析失败的项目数：此前只写进报告文件，IPC 的 detail 里没有，
     *  用户只看得到「蒸馏 N 个项目」而不知道有项目被跳过（成功率的假象同源）。 */
    let parseFailed = 0;
    /** 模型调用尝试/失败计数与首个错误：区分「部分项目失败」与「全局失败」。
     *  此前逐项目 catch 后 continue、IPC 返回的 detail 恒为成功文案，
     *  前端 ProjectsView 的失败提示是死代码（用户看到「蒸馏 0 个项目」却不知道是没配模型）。 */
    let modelTried = 0;
    let modelFailed = 0;
    let firstModelError = null;
    const reports = [];

    for (let pi = 0; pi < projects.length; pi++) {
      const p = projects[pi];
      this._progress(8 + Math.round((pi / projects.length) * 80), `蒸馏第 ${pi + 1}/${projects.length} 个项目（${p.project || "通用"}）`);
      const rows = db.prepare(`
        SELECT id, title, summary, created, tags FROM mem
        WHERE layer = 'l1' AND COALESCE(project, '') = ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY importance DESC, created DESC LIMIT ?
      `).all(p.project, Date.now(), maxPerProject);
      if (rows.length < 5) continue; // 少于 5 条素材蒸馏不出稳定结论
      const knownIds = new Set(rows.map((r) => r.id));
      const prompt = [
        "你是知识蒸馏器。以下是某项目最近的原始记忆记录。",
        "请输出严格 JSON：",
        '{"knowledge":[{"title":"","body":"","tags":[]}],"decisions":[{"title":"","body":"","reason":"","tags":[]}],"glossary":[{"term":"","meaning":""}],"supersedeSuggestions":[{"oldId":"","reason":""}]}',
        "要求：只输出 JSON，不要解释、不要 Markdown 围栏；",
        // 素材可达 200 条，不封顶时模型会把 4000 output token 全写满并截断 → JSON 配不平 → 整轮蒸馏白跑
        // （L2 一直空着的第二个根因）。所以既限条数又限长度，并要求合并同类项。
        "数量上限：knowledge ≤6 条、decisions ≤4 条、glossary ≤10 条、supersedeSuggestions ≤10 条；素材多时合并同类项，宁少勿多；",
        "每条 body ≤120 字；不要编造原文没有的信息；没有内容就返回空数组。",
        "",
        ...rows.map((r) => `[${r.id}] ${r.title}：${r.summary || ""}`),
      ].join("\n");
      let result;
      modelTried++;
      try {
        result = await this.client.call({
          task: "distill",
          system: "你是知识蒸馏器，只输出 JSON。",
          messages: [{ role: "user", content: prompt }],
          jsonMode: true,
          maxTokens: BIG_JSON_MAX_TOKENS,
          // 思考型模型先想后写，大 JSON 的输出时长经常超过全局 60s；这两个任务本来就慢，单独给足时间
          timeoutSec: BIG_JSON_TIMEOUT_SEC,
        });
      } catch (e) {
        modelFailed++;
        if (!firstModelError) firstModelError = e;
        reports.push(`${p.project || "(general)"}：跳过（${String(e.message || e).slice(0, 80)}）`);
        continue;
      }
      tokens += result.usage.input + result.usage.output;
      const parsed = extractJson(result.text);
      if (!parsed) {
        parseFailed++;
        // 截断与"模型没按格式吐"要分开说：前者是素材太多/输出预算问题，后者要看模型本身
        const truncated = result.finishReason === "length" || (result.usage && result.usage.output >= BIG_JSON_MAX_TOKENS - 100);
        reports.push(`${p.project || "(general)"}：结构无法解析${truncated ? "（输出被 maxTokens 截断，可调小「单项目蒸馏素材上限」）" : ""}，跳过`);
        continue;
      }
      const slug = p.project || null;
      for (const item of Array.isArray(parsed.knowledge) ? parsed.knowledge : []) {
        const w = await this._writeL2({
          type: "knowledge", title: item.title, body: item.body,
          tags: item.tags, project: p.project, evidence: rows.slice(0, 12).map((r) => r.id),
        });
        if (w) written++;
      }
      for (const item of Array.isArray(parsed.decisions) ? parsed.decisions : []) {
        const body = item.reason ? `${item.body}\n\n理由：${item.reason}` : item.body;
        const w = await this._writeL2({
          type: "decision", title: item.title, body,
          tags: item.tags, project: p.project, evidence: rows.slice(0, 12).map((r) => r.id),
        });
        if (w) written++;
      }
      if (Array.isArray(parsed.glossary) && parsed.glossary.length) {
        this._appendGlossary(slug, parsed.glossary);
      }
      for (const s of Array.isArray(parsed.supersedeSuggestions) ? parsed.supersedeSuggestions : []) {
        if (!s.oldId) continue;
        // 同 runSupersede：模型复述长 id 会漂移（日期位数错位、后缀却对），
        // 必须逐字命中本轮素材，否则入队就是一条查不到、点不动的死建议
        if (!knownIds.has(s.oldId)) { dropped++; continue; }
        const supPayload = { oldId: s.oldId, newId: null, confidence: 0.6, reason: s.reason || "蒸馏时的矛盾提示", project: p.project };
        this.service.autoConfirmReview("supersede", this.service.index.reviewAdd("supersede", supPayload), supPayload);
      }
      done++;
      reports.push(`${p.project || "(general)"}：素材 ${rows.length} 条 → 新增 L2 ${written - writtenBefore} 条`);
      writtenBefore = written;
    }

    const reportFile = this._writeReport("distill", "蒸馏报告", ["## 各项目处理结果", ...reports.map((r) => `- ${r}`), "", `token 消耗：${tokens}`]);
    // 全局失败：所有真正调模型的批次都失败（典型是「一个可用模型都没配」）。
    // 报告已落盘（含逐项目原因）再上抛：既不丢排障线索，也让前端能弹「去设置配置」。
    // 部分失败保持原有容错语义（单项目失败不毁整轮），只在 detail 里如实带出跳过数。
    if (modelTried > 0 && modelFailed === modelTried) {
      const err = firstModelError || new Error("蒸馏失败：所有项目都没能调用模型");
      err.partial = { processed: done, updated: written, tokens, report: reportFile, failed: modelFailed };
      throw err;
    }
    this.service.index.setMeta("lastDistillAt", String(Date.now()));
    return {
      processed: done,
      updated: written,
      tokens,
      detail: `蒸馏 ${done} 个项目，新增 L2 ${written} 条${dropped ? `，丢弃 ${dropped} 条引用不存在的无效建议` : ""}${parseFailed ? `，${parseFailed} 个项目结构无法解析被跳过` : ""}${modelFailed ? `，${modelFailed} 个项目因模型调用失败被跳过` : ""}`,
      report: reportFile,
    };
  }

  async _writeL2({ type, title, body, tags, project, evidence }) {
    if (!title || !body) return false;
    const clean = String(body).trim().slice(0, 1200);
    // 判重交给 writeMemory 内部的 L1 哈希兜底（此前的预检公式与 contentHash 不同、
    // 且没算证据后缀与 tags，永远匹配不上，属死代码）
    const existing = this.service.index.db.prepare(
      "SELECT id, summary, path FROM mem WHERE layer='l2' AND type = ? AND title = ? AND COALESCE(project,'') = ? AND (valid_to IS NULL OR valid_to > ?)",
    ).get(type, title, project || "", Date.now());
    if (existing) {
      // 同标题的 L2：走 UPDATE 语义（追加新内容，保留历史）
      const cur = this.service.getById(existing.id);
      if (!cur) return false; // 查询与回读之间行被删/索引变更：跳过，交由下轮重试
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
    return !!r.ok;
  }

  _appendGlossary(slug, items) {
    const rel = slug ? `projects/${slug}/l2/glossary.md` : `general/l2/glossary.md`;
    const file = path.join(this.rootDir, rel);
    const lines = items
      .filter((x) => x && x.term && x.meaning)
      .map((x) => `- ${String(x.term).trim()} :: ${String(x.meaning).trim().slice(0, 200)}`);
    if (!lines.length) return;
    // 项目表写入前先查通用表：同名术语不再各项目重复收一份（跨文件去重只对「通用 → 项目」单向生效，
    // 同名术语在不同项目的专属解释不同，反向合并会误伤）
    const termOf = (l) => l.replace(/^- /, "").split(" :: ")[0].trim();
    const generalTerms = new Set();
    if (slug) {
      const generalFile = path.join(this.rootDir, "general", "l2", "glossary.md");
      if (fs.existsSync(generalFile)) {
        for (const l of fs.readFileSync(generalFile, "utf8").split("\n")) {
          if (l.startsWith("- ")) generalTerms.add(termOf(l));
        }
      }
    }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const existingTerms = new Set();
    for (const l of existing.split("\n")) {
      if (l.startsWith("- ")) existingTerms.add(termOf(l));
    }
    // 按术语名精确比对：原先用 existing.includes("- 术语") 属子串匹配，
    // 已有「索引优化」时新术语「索引」会被误判为已存在而静默丢弃
    const kept = lines.filter((l) => !existingTerms.has(termOf(l)) && !generalTerms.has(termOf(l)));
    if (!kept.length) return;
    const merged = existing ? `${existing.trimEnd()}\n${kept.join("\n")}\n` : `${kept.join("\n")}\n`;
    // 词典文件带上稳定 id 的 frontmatter：否则每次重建索引都会给它分配新随机 id
    const head = existing && existing.startsWith("---") ? "" : "---\nid: glossary-entries\ntype: knowledge\nlayer: l2\ntitle: 术语表\n---\n\n";
    this.service.store.writeAtomic(rel, head + merged, { backup: true });
    this.service.reindexFile(rel);
  }

  // ---------- 任务 8：人格画像 ----------

  async runProfile(opts = {}) {
    // dim：只生成某一个分区（persona/preferences/tech/habits）；空 = 全量。
    // 单维度时 prompt 要求其余字段输出空数组（省 token），写入时也只落该分区文件——
    // 其它分区（含用户手改的 pinned 条目）原样不动。
    const dim = ["persona", "preferences", "tech", "habits"].includes(opts.dim) ? opts.dim : "";
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
      dim ? `本次只归纳「${dim}」这一段：其余字段一律输出空数组 []，不要编造。` : "",
      "硬性要求：每条结论必须带 2~5 个真实存在的记忆 id 作为证据；没有证据的结论不要输出；不要编造。",
      // 素材可达 150 条：不封顶时思考型模型会把输出预算写满并截断 → JSON 配不平 → 整轮白跑
      // （画像连续两周没更新的直接原因）。与蒸馏同一口径：先限条数，再限单条长度。
      "数量上限：persona ≤8 条、communication ≤8 条、tech ≤8 条、habits ≤8 条、values ≤6 条；每条 ≤60 字，宁少勿多；",
      "",
      ...rows.map((r) => `[${r.id}] (${r.layer}) ${r.title}：${r.summary || ""}`),
    ].filter(Boolean).join("\n");

    this._progress(40, `调用模型归纳画像（素材 ${rows.length} 条）`);
    const result = await this.client.call({
      task: "profile",
      system: "你是用户画像分析师，只输出 JSON。",
      messages: [{ role: "user", content: prompt }],
      jsonMode: true,
      maxTokens: BIG_JSON_MAX_TOKENS,
      timeoutSec: BIG_JSON_TIMEOUT_SEC,
    });
    const parsed = extractJson(result.text);
    const tokens = result.usage.input + result.usage.output;
    if (!parsed || typeof parsed !== "object") {
      const truncated = result.finishReason === "length" || (result.usage && result.usage.output >= BIG_JSON_MAX_TOKENS - 100);
      return { ok: false, processed: 0, tokens, detail: `画像结构无法解析${truncated ? "（输出被 maxTokens 截断，可调小「单次处理条数」）" : ""}，已保留上一版` };
    }

    const validIds = new Set(rows.map((r) => r.id));
    const sections = {
      persona: this._renderProfileSection(parsed.persona, "trait", validIds),
      preferences: this._renderProfileSection(parsed.communication, "pref", validIds),
      tech: this._renderProfileSection(parsed.tech, "pref", validIds),
      habits: this._renderProfileSection(parsed.habits, "habit", validIds),
    };
    // 空结果保护：模型返回 {} 或全部条目都因证据不足被过滤时，不能拿空内容覆盖上一版画像
    // （此前只看 parsed 是否为 null，{} 能一路写下去，把已有画像洗成只剩一行注释）
    const hasContent = (s) => String(s || "").split("\n").some((l) => l.startsWith("- "));
    const dims = dim ? [dim] : Object.keys(sections);
    if (!dims.some((name) => hasContent(sections[name]))) {
      return { ok: false, processed: 0, tokens, detail: "画像结果为空（模型未给出带证据的结论），已保留上一版" };
    }
    // 单维度只写目标分区文件；其它分区（含 pinned 手改内容）原样不动
    const targets = dim ? { [dim]: sections[dim] } : sections;
    const historyDir = path.join(this.rootDir, "profile", ".history");
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let written = 0;
    for (const [name, content] of Object.entries(targets)) {
      const rel = `profile/${name}.md`;
      const abs = path.join(this.rootDir, rel);
      if (fs.existsSync(abs)) {
        try { fs.copyFileSync(abs, path.join(historyDir, `${name}-${stamp}.md`)); } catch { /* 留档失败不阻塞 */ }
      }
      const pinned = this._readPinned(abs);
      const merged = mergePinned(content, pinned);
      this.service.store.writeAtomic(rel, merged, { backup: true });
      written++;
    }
    try {
      // dataDir 只有框架配置一处来源（构造 options 从不传它），直接取
      const dataDir = require("../config.cjs").dataDir();
      if (dataDir) {
        profileCache.syncStoreToCache(this.service.store, dataDir);
      }
    } catch {}
    const reportFile = this._writeReport("profile", "画像生成报告", [
      `素材 ${rows.length} 条（L2 + 高重要度）`,
      dim ? `生成分区：${dim}（单维度）` : `生成分区：${written} 个`,
      `token 消耗：${result.usage.input + result.usage.output}`,
    ]);
    return { processed: rows.length, updated: written, tokens: result.usage.input + result.usage.output, detail: dim ? `画像已更新（${dim} · ${rows.length} 条素材）` : `画像已更新（${rows.length} 条素材）`, report: reportFile };
  }

  _renderProfileSection(list, field, validIds) {
    const lines = ["<!-- 本文件由 AgentHub 记忆中枢生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->"];
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
      return parsePinnedLines(fs.readFileSync(abs, "utf8"));
    } catch {
      return [];
    }
  }

  _writeReport(kind, title, lines) {
    const dir = path.join(this.rootDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${kind}-${new Date().toISOString().slice(0, 10)}.md`);
    // 走原子写：报告写一半崩溃不会留下半个文件（与蒸馏/画像的写入口径一致）
    this.service.store.writeAtomic(`reports/${kind}-${new Date().toISOString().slice(0, 10)}.md`,
      `# ${title}\n\n> ${new Date().toLocaleString("zh-CN")}\n\n${lines.join("\n")}\n`);
    return file;
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
      const parsed = parseFrontmatter(text);
      const sections = parseDailySections(parsed.body);
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

module.exports = { MemoryTasks, extractJson, pickItems, validEntries };
