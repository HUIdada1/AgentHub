/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 请求流水（与号池 oplog.cjs 分开命名空间，避免两张表混在一起）
// 只存"可观测"的元数据：时间 / 密钥前缀 / 渠道 / 模型 / 状态 / 耗时 / token。
// 绝不落请求正文或响应正文（可能含用户隐私），也不落任何凭据。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const proxyStore = require("../proxy/store.cjs");
const lgwConfig = require("./config.cjs");

/** 表：localgw_logs（独立命名空间） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS localgw_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  api_key_prefix TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',
  ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  err_code TEXT NOT NULL DEFAULT '',
  sensitive_hits TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_localgw_logs_ts ON localgw_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_localgw_logs_channel ON localgw_logs(channel);
`;

/** 增量迁移：老库（v1.91.0 之前建的表）没有 sensitive_hits 列。
 *  CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，所以必须单独 ALTER；
 *  重复执行会抛 "duplicate column name"，按惯例包 try/catch 当幂等处理。 */
function migrate() {
  try {
    proxyStore.open().exec("ALTER TABLE localgw_logs ADD COLUMN sensitive_hits TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在（或表刚由 SCHEMA 建好，已带该列）——两种情况都无需处理 */
  }
}

let ready = false;
function ensure() {
  if (ready) return;
  proxyStore.open().exec(SCHEMA);
  migrate();
  ready = true;
}

/** 追加一条流水（失败静默：记日志失败绝不能影响转发本身） */
function insert(row) {
  try {
    ensure();
    const crypto = require("node:crypto");
    proxyStore.open().prepare(
      `INSERT INTO localgw_logs (id, ts, api_key_prefix, channel, model, status, ms, prompt_tokens, completion_tokens, err_code, sensitive_hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      row.ts || Date.now(),
      row.apiKeyPrefix || "",
      row.channel || "",
      row.model || "",
      row.status || "success",
      Math.round(row.ms || 0),
      row.promptTokens || 0,
      row.completionTokens || 0,
      row.errCode || "",
      String(row.sensitiveHits || "").slice(0, 500)
    );
  } catch {
    /* 忽略 */
  }
}

/** 列表（倒序 + 可选筛选）
 *  入参容错：opts 可能是 undefined / null（IPC 直传）——原实现用解构默认值，
 *  传 null 会抛 TypeError，渲染层拿到的是 rejected promise 而不是 {rows,total}。 */
function list(opts) {
  const { limit = 50, offset = 0, channel, status } = opts || {};
  ensure();
  const where = [];
  const args = [];
  if (channel) { where.push("channel = ?"); args.push(String(channel)); }
  if (status) { where.push("status = ?"); args.push(String(status)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = proxyStore.open().prepare(`SELECT COUNT(*) AS n FROM localgw_logs ${clause}`).get(...args);
  const rows = proxyStore.open().prepare(
    `SELECT * FROM localgw_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...args, Math.min(1000, Math.max(1, Math.round(Number(limit) || 50))), Math.max(0, Math.round(Number(offset) || 0)));
  return {
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
    total: totalRow ? totalRow.n : 0,
  };
}

/** 延时统计（avg / p50 / p95 / max）
 *  空数组返回全 0（不能出现 NaN——前端会把它渲染成 "NaN ms"）。 */
function potStats() {
  const empty = { ok: true, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  try {
    ensure();
    // 只统计近 24h 的成功请求：失败请求的耗时没有参考意义
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = proxyStore.open().prepare(
      `SELECT ms FROM localgw_logs WHERE ts >= ? AND status='success' ORDER BY ms ASC`
    ).all(since);
    if (!rows.length) return empty;
    const arr = rows.map((r) => Number(r.ms) || 0);
    const sum = arr.reduce((a, b) => a + b, 0);
    const at = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    return {
      ok: true,
      avgMs: Math.round(sum / arr.length),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: arr[arr.length - 1],
    };
  } catch {
    // 库不可用时统计面板显示 0 而不是让整个 IPC 失败
    return empty;
  }
}

/** GC：超保留期的流水清掉（启动 / 定时调用） */
function gc() {
  try {
    ensure();
    const days = lgwConfig.get().logRetentionDays || 30;
    const before = Date.now() - days * 86400 * 1000;
    const r = proxyStore.open().prepare(`DELETE FROM localgw_logs WHERE ts < ?`).run(before);
    return { ok: true, removed: r ? r.changes : 0 };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), removed: 0 };
  }
}

/** 导出（jsonl / csv）：写到数据目录，返回路径。
 *  format 只认 "csv"，其余一律 jsonl（避免把用户输入拼进文件名 = 路径穿越面）。
 *  单次最多导 1000 行（与 list 的上限一致），truncated 明示"还有更多没导"。 */
function exportTo(format) {
  try {
    ensure();
    const all = list({ limit: 1000, offset: 0 });
    const rows = all.rows;
    const dir = path.join(config.dataDir(), "localgw", "exports");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const truncated = all.total > rows.length;
    if (format === "csv") {
      const head = "ts,apiKeyPrefix,channel,model,status,ms,promptTokens,completionTokens,errCode,sensitiveHits";
      const body = rows.map((r) =>
        [r.ts, r.apiKeyPrefix, r.channel, r.model, r.status, r.ms, r.promptTokens, r.completionTokens, r.errCode, r.sensitiveHits]
          .map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")
      );
      const file = path.join(dir, `localgw-logs-${ts}.csv`);
      fs.writeFileSync(file, `${head}\n${body.join("\n")}\n`, "utf8");
      return { ok: true, path: file, exported: rows.length, total: all.total, truncated };
    }
    const file = path.join(dir, `localgw-logs-${ts}.jsonl`);
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return { ok: true, path: file, exported: rows.length, total: all.total, truncated };
  } catch (e) {
    // 磁盘满 / 无权限：如实回报，不要把异常抛到 IPC 层变成一句笼统的失败
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 今日请求数与 token 合计（status IPC 用；走 SQL 聚合而非内存计数，重启后仍然准） */
function todayTotals() {
  try {
    ensure();
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const r = proxyStore.open().prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t,
              COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END), 0) AS e
       FROM localgw_logs WHERE ts >= ?`
    ).get(d.getTime());
    return {
      todayReq: r ? r.n : 0,
      todayTokens: r ? r.t : 0,
      errCount: r ? r.e : 0,
    };
  } catch {
    return { todayReq: 0, todayTokens: 0, errCount: 0 };
  }
}

module.exports = { insert, list, potStats, gc, exportTo, todayTotals };
