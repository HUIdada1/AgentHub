/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 用量统计（区间聚合 / 明细分页 / 手动静默清理）
//
// 数据源**只有** localgw_logs 一张表（oplog.cjs 建的，转发时落账）——本模块一行都不写，
// 只读+现算聚合，绝不新开第二套统计存储：两份口径迟早会漂，而「统计和流水对不上」
// 是最难排查也最伤信任的一类 bug（旧版反代网关就吃过 stats.db 与 usage_requests 两份数的亏）。
//
// 为什么把聚合放在这里而不是 oplog.cjs：oplog 是「转发链路的落账口」，它只需要 insert/list/GC；
// 统计是「读侧的分析口」，会随页面需求变（加维度、改粒度），两者变更频率完全不同，
// 混在一起会让转发核心被分析需求拖着改。共用的是**表**，不是模块。
//
// 口径约定（前后端已写死，改这里要同步 src/api/ipc.ts 的 LocalgwStatsOverview）：
//   · kpis.successRate 是 **0~100 的百分数**（与 localgw_status.errRate 的 0~1 不同，
//     后者沿用 server.status 的历史口径，不要再互相「对齐」——对齐的结果是必有一处 ×100 错）
//   · kpis 的 avg/p50/p95 只统计 status='success' 的行：失败请求的耗时没有参考意义
//     （与 oplog.potStats 同一口径，否则同一个页面里两块延迟数会互相打脸）
//   · err = req - 成功数，与 successRate 严格互补；用「非 success」而不是「= error」，
//     这样后续真落 cancelled 状态时统计不会把它算成成功
"use strict";
const proxyStore = require("../proxy/store.cjs");
const lgwConfig = require("./config.cjs");
const oplog = require("./oplog.cjs");
// 清理是不可恢复的删数据，落一条号池操作日志（本地网关没有自己的操作日志表，
// 前端「日志」页读的就是号池那张 proxy_oplog_list）
const proxyOplog = require("../proxy/oplog.cjs");

const DAY_MS = 86400000;
/** 区间上限：与设置里的保留期上限（3650 天）不是一回事——这里防的是前端传
 *  from=0/to=now 时按天铺桶铺出上万个点把渲染层打爆 */
const MAX_RANGE_DAYS = 400;
/** 趋势桶上限：按天最多 400 个点，按小时最多 48 个点（跨度 ≤2 天才走小时），正常到不了 */
const MAX_BUCKETS = 420;

/**
 * 保证 localgw_logs 存在。
 *
 * 为什么绕道 oplog.list：建表语句在 oplog.cjs 里（单一事实源），但它没导出 ensure()。
 * 与其在这里抄一份 SCHEMA（抄一份就有两个事实源，加列时必漏一处），不如借它的读接口
 * 触发一次建表——代价是首次调用多两条查询，换来的是 schema 永远只有一份。
 * 失败不抛：让后续查询自己去报错（那时错误里带的是真实的表名/SQL，比这里的新造错误更有用）。
 */
let ensured = false;
function ensureTable() {
  if (ensured) return;
  try {
    oplog.list({ limit: 1, offset: 0 });
    ensured = true;
  } catch { /* 交给下面的查询报真实错误 */ }
}

/** 本地零点（统计区间一律按本地日历切，与 store.dayStartMs 同口径） */
function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 区间归一：range 决定跨度，custom 用调用方给的 from/to。
 * 返回 { range, from, to, granularity }；granularity 由跨度反推（today 必为小时，
 * ≤2 天走小时、否则走天）——不让前端传粒度：前端只关心「今天/7天/30天/自定义」，
 * 多一个入参就多一种前端传错的可能。
 */
function resolveRange(input) {
  const o = input || {};
  const now = Date.now();
  const raw = String(o.range || "today");
  const range = raw === "7d" || raw === "30d" || raw === "custom" ? raw : "today";
  let from;
  let to = now;
  if (range === "custom") {
    from = Number(o.from);
    to = Number(o.to);
    // custom 缺参不报错而是回落今天：统计页只是「看一眼」，弹错反而打断用户；
    // 但回显的 range 会如实变成 today，前端筛选栏跟着一起回到今天，不产生「显示 30 天却是今天数据」的错位
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
      return { range: "today", ...spanOf("today", now), granularity: "hour" };
    }
  } else if (range === "7d") {
    from = dayStart(now - 6 * DAY_MS);
  } else if (range === "30d") {
    from = dayStart(now - 29 * DAY_MS);
  } else {
    from = dayStart(now);
  }
  if (to < from) { const t = from; from = to; to = t; } // 传反了就地交换，不报错
  if (to - from > MAX_RANGE_DAYS * DAY_MS) from = to - MAX_RANGE_DAYS * DAY_MS;
  to = Math.round(to);
  from = Math.round(from);
  return {
    range,
    from,
    to,
    granularity: range === "today" ? "hour" : to - from <= 2 * DAY_MS ? "hour" : "day",
  };
}

/** 三个预置档的起止（custom 缺参回落 today 时复用，避免两处各写一遍差一天） */
function spanOf(range, now) {
  if (range === "7d") return { from: dayStart(now - 6 * DAY_MS), to: now };
  if (range === "30d") return { from: dayStart(now - 29 * DAY_MS), to: now };
  return { from: dayStart(now), to: now };
}

/** 桶起点：按粒度把时间戳落到「整点」或「本地零点」 */
function bucketStart(ts, granularity) {
  const d = new Date(ts);
  if (granularity === "hour") d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 趋势序列：先在 JS 里把区间铺成等距桶（缺失的补 0），再把 SQL 的分组结果填进去。
 * 为什么不直接 GROUP BY 让数据库出结果：数据库中没数据的时段不会出现行，
 * 折线图会把这些时段「拉直」——用户看到的是「这段时间没请求」，画出来却是「平滑上升」。
 * 补齐是统计图的正确性要求，不是美观问题。
 */
function series(from, to, granularity) {
  const step = granularity === "hour" ? 3600000 : DAY_MS;
  const buckets = [];
  const index = new Map();
  let t = bucketStart(from, granularity);
  for (let i = 0; t <= to && i < MAX_BUCKETS; i++, t += step) {
    const b = { key: t, ts: t, req: 0, tokens: 0, err: 0 };
    buckets.push(b);
    index.set(t, b);
    // 按天跨夏令时会有 23/25 小时的天：用日历推进一步而不是加 86400000，否则桶会漂到 01:00
    if (granularity === "day") {
      const d = new Date(t);
      d.setDate(d.getDate() + 1);
      t = d.getTime() - step; // 下面的 for 再 += step 正好落到次日零点
    }
  }
  const rows = proxyStore.open().prepare(
    `SELECT ts, status, prompt_tokens, completion_tokens FROM localgw_logs WHERE ts >= ? AND ts <= ?`
  ).all(from, to);
  for (const r of rows) {
    const b = index.get(bucketStart(Number(r.ts) || 0, granularity));
    if (!b) continue; // 区间外（bucketStart 向左偏出下界）：忽略而不是造桶，避免图尾多一个孤立点
    b.req += 1;
    b.tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0);
    if (r.status !== "success") b.err += 1;
  }
  return buckets;
}

/**
 * 单维排行（渠道 / 模型 / 状态）。
 * 返回的桶同时带 `key` 与维度名字段：前端契约用 `key`（LocalgwStatsBucket），
 * 而页面表格更愿意直接读 channel/model/status。两个都给 = 前端不必为了显示而反查字典，
 * 也不给后续「把 byChannel 换成 byProvider」之类的重构留字段名歧义。
 */
function rankBy(column, from, to) {
  const rows = proxyStore.open().prepare(
    `SELECT ${column} AS k,
            COUNT(*) AS req,
            SUM(prompt_tokens + completion_tokens) AS tokens,
            SUM(CASE WHEN status <> 'success' THEN 1 ELSE 0 END) AS err
     FROM localgw_logs WHERE ts >= ? AND ts <= ? GROUP BY ${column} ORDER BY req DESC`
  ).all(from, to);
  return rows.map((r) => {
    const k = String(r.k || "");
    const req = Number(r.req) || 0;
    const err = Number(r.err) || 0;
    const tokens = Number(r.tokens) || 0;
    const bucket = { key: k || "—", req, tokens, err, count: req };
    if (column === "channel") bucket.channel = k || "—";
    if (column === "model") bucket.model = k || "—";
    if (column === "status") bucket.status = k || "—";
    return bucket;
  });
}

/** TOP 排行：直接截前 N 条，不再单独查库（同一份聚合结果，避免第二次扫描） */
function topOf(list, limit) {
  return list.slice(0, Math.max(1, limit)).map((b) => ({
    name: b.key,
    req: b.req,
    tokens: b.tokens,
    err: b.err,
  }));
}

/** 区间总览：KPI / 趋势 / 三维排行 / TOP */
function overview(input) {
  ensureTable();
  const { range, from, to, granularity } = resolveRange(input);
  const agg = proxyStore.open().prepare(
    `SELECT COUNT(*) AS req,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok,
            COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct
     FROM localgw_logs WHERE ts >= ? AND ts <= ?`
  ).get(from, to);
  const req = Number(agg && agg.req) || 0;
  const ok = Number(agg && agg.ok) || 0;
  const promptTokens = Number(agg && agg.pt) || 0;
  const completionTokens = Number(agg && agg.ct) || 0;
  // 延迟只取成功行并按 ms 升序取分位（与 oplog.potStats 同口径）；空集回 0，绝不回 NaN
  const msRows = proxyStore.open().prepare(
    `SELECT ms FROM localgw_logs WHERE ts >= ? AND ts <= ? AND status = 'success' ORDER BY ms ASC`
  ).all(from, to);
  const ms = msRows.map((r) => Number(r.ms) || 0);
  const at = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : 0);
  const byChannel = rankBy("channel", from, to);
  const byModel = rankBy("model", from, to);
  const byStatus = rankBy("status", from, to);
  return {
    // 区间回显：前端筛选栏拿它对显示（custom 缺参回落 today 时也如实回 today）
    range,
    from,
    to,
    kpis: {
      req,
      tokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      // 0~100 的百分数，保留一位小数（与 store.shapeAgg 的 successRate 同算法）
      successRate: req ? Math.round((ok / req) * 1000) / 10 : 0,
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
    },
    trend: series(from, to, granularity),
    byChannel,
    byModel,
    byStatus,
    top: { models: topOf(byModel, 10), channels: topOf(byChannel, 10) },
  };
}

/**
 * 明细分页：筛选条件与统计页下拉一一对应。
 * model/channel/status/keyPrefix 一律**精确匹配**（不是 LIKE）：它们是下拉/前缀选择器，
 * 模糊匹配会让「选 gpt-4o」把 gpt-4o-mini 也带进来，而页面标题写着具体模型名。
 * keyPrefix 例外地按前缀匹配——它的语义就是前缀（keys 表只存前缀，明文不留库）。
 */
function detail(input) {
  ensureTable();
  const o = input || {};
  const { from, to } = resolveRange(o);
  const where = ["ts >= ?", "ts <= ?"];
  const vals = [from, to];
  if (o.channel) { where.push("channel = ?"); vals.push(String(o.channel)); }
  if (o.model) { where.push("model = ?"); vals.push(String(o.model)); }
  if (o.status) { where.push("status = ?"); vals.push(String(o.status)); }
  if (o.keyPrefix) { where.push("api_key_prefix LIKE ? ESCAPE '\\'"); vals.push(`${likeArg(String(o.keyPrefix))}%`); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = Number((proxyStore.open().prepare(`SELECT COUNT(*) AS n FROM localgw_logs ${clause}`).get(...vals) || {}).n) || 0;
  const size = Math.min(1000, Math.max(1, Math.round(Number(o.limit) || 50)));
  const offset = Math.max(0, Math.round(Number(o.offset) || 0));
  const rows = proxyStore.open().prepare(
    `SELECT * FROM localgw_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...vals, size, offset);
  return {
    // 字段形状与 oplog.list 完全一致（同一前端类型 LocalgwLogRow 两处复用）
    rows: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      apiKeyPrefix: r.api_key_prefix,
      channel: r.channel,
      model: r.model,
      status: r.status,
      ms: r.ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      errCode: r.err_code,
      sensitiveHits: r.sensitive_hits || "",
    })),
    total,
  };
}

/** LIKE 参数转义：前缀里的 % 与 _ 是用户输入的字面量，不转义会变成通配（查 `a_` 会命中 `ab`） */
function likeArg(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 手动清理：mode=expired 按设置里的保留期清（与 oplog.gc 同一条线），mode=all 清空整表。
 * 删的是不可恢复的用户数据，所以落一条操作日志——统计页的提示只活几秒，日志才是事后能查的凭据。
 */
function cleanup(input) {
  ensureTable();
  const mode = (input && input.mode) === "all" ? "all" : "expired";
  let deleted = 0;
  if (mode === "all") {
    deleted = Number((proxyStore.open().prepare(`DELETE FROM localgw_logs`).run() || {}).changes) || 0;
  } else {
    const days = Number(lgwConfig.get().logRetentionDays) || 30;
    const before = Date.now() - days * DAY_MS;
    deleted = Number((proxyStore.open().prepare(`DELETE FROM localgw_logs WHERE ts < ?`).run(before) || {}).changes) || 0;
  }
  try {
    proxyOplog.log("info", "用量统计",
      mode === "all" ? `手动清空本地网关请求流水（${deleted} 条）` : `按保留期手动清理本地网关请求流水（${deleted} 条）`,
      { target: "localgw_logs" });
  } catch { /* 日志失败不影响删除结果（数据已经删了，报错也回不去） */ }
  return { ok: true, deleted, mode };
}

module.exports = { overview, detail, cleanup, resolveRange, __test: { bucketStart, likeArg } };
