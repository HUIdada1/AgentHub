// OpenSquilla（阿里百炼开源桌面版）数据源适配器
// 权威数据源：%APPDATA%\@opensquilla\desktop-electron\opensquilla\state\sessions.db（SQLite 明文，WAL 模式）
//   usage_events 表每行对应一次 LLM 调用（每 event 恰好 1 个 usage_event_item，
//   本机实测 ensemble 分裂未发生），五桶齐全：input_tokens / output_tokens /
//   reasoning_tokens / cache_read_tokens / cache_write_tokens。
// 口径（2026-09-14 本机实测）：
//   - inputTokens = 总输入口径（含 cache_read），与本项目其余源一致；
//   - status='unknown' 的失败重试行 total_tokens 全 0，SQL 层 total_tokens > 0 一并排除；
//   - run_kind 全收：session_turn（对话）/ session_naming（自动命名）/
//     onboarding_probe（系统探测）均为真实消耗；
//   - provider 用事件原文（本机为 tokenrhythm 中转站）；model 经 normalizeModel
//     去供应商前缀与日期快照后缀（deepseek-v4-pro-0813 → deepseek-v4-pro，
//     与本项目既有快照归并口径一致）。
// 设备标识：root/state/install_telemetry.json 的 install_id；缺失回退
//   gateway-ownership 下第一个 profile hash 目录名；再缺失返回 null（上层兜底）。
// 幂等键：event_id（全局唯一 32 位 hex）。
// 增量：started_at_ms 毫秒时间戳，按统一锚点 since 过滤。
// 优雅降级：受 schema 演进（yoyo 迁移活跃）影响缺列时按缺失列回退 0/空串，
//   表面目全非（连 event_id/started_at_ms 都没有）才抛错，由 sync 层记日志跳过该源。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeModel } = require("./adapter-zcode.cjs");

const ID = "opensquilla";
const NAME = "OpenSquilla";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function appDataDir() {
  return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
}

/** 应用数据 home（settings committed.json 的 home 字段指向这里） */
function defaultRoot() {
  return path.join(appDataDir(), "@opensquilla", "desktop-electron", "opensquilla");
}

/** 自测注入环境变量覆盖（临时目录隔离，不触碰真实数据） */
function resolveRoot() {
  const env = String(process.env.OPEN_SQUILLA_HOME || "").trim();
  return env ? path.resolve(env) : defaultRoot();
}

function dbFile(root) {
  return path.join(root, "state", "sessions.db");
}

/** 数据库文件存在即探测成功（与其他源 detect 返回「数据根」一致） */
function detect() {
  const root = resolveRoot();
  return fs.existsSync(dbFile(root)) ? root : null;
}

/** 校验：数据库文件存在且非空 */
function validate(root) {
  try {
    return !!root && fs.statSync(dbFile(root)).size > 0;
  } catch {
    return false;
  }
}

/** 设备标识三级兜底：install_telemetry.install_id → gateway-ownership profile hash → null */
function getDeviceId(root) {
  try {
    const telemetry = path.join(root, "state", "install_telemetry.json");
    const text = fs.readFileSync(telemetry, "utf8");
    const v = JSON.parse(text);
    if (typeof v.install_id === "string" && v.install_id) return v.install_id;
  } catch {
    /* 继续回退 */
  }
  try {
    const gw = path.join(root, "..", "gateway-ownership");
    const names = fs.readdirSync(gw, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (names.length > 0) return names[0].name;
  } catch {
    /* 继续回退 */
  }
  return null;
}

/** 非负有限数字，非法返回 0（db 层 safeToken 之外的适配器侧兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 行 → 事件：五桶映射（cache_write → cacheCreationTokens）。
 * 五桶全 0 的轮次不入库（取消/失败/空轮次，SQL 已过滤但在映射层二次防御）。
 * ctx: { deviceId, deviceName }
 */
function mapRow(ctx, row) {
  if (!row || !row.event_id) return null;
  const input = num(row.input_tokens);
  const output = num(row.output_tokens);
  const reasoning = num(row.reasoning_tokens);
  if (input === 0 && output === 0 && reasoning === 0) return null;

  const startedAt = Number(row.started_at_ms);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const completedAt = Number(row.completed_at_ms);

  const provider = String(row.provider || "").trim();
  const model = String(row.model || "").trim();
  return {
    id: `${ctx.deviceId}:opensquilla:${row.event_id}`,
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    source: ID,
    providerId: provider || "未知供应商:opensquilla",
    modelId: model ? normalizeModel(model) : "unknown",
    sessionId: row.session_id || undefined,
    agent: row.agent_id || undefined,
    mode: row.run_kind || undefined,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheCreationTokens: num(row.cache_write_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    startedAt,
    completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : undefined,
    status: "success",
  };
}

/**
 * 增量抽取：只读打开原库，取 usage_events 中 total_tokens > 0 且 started_at_ms > since 的行。
 * since 为毫秒（统一锚点口径），started_at_ms 亦为毫秒。
 * 列级防御：yoyo 迁移可能增删列——缺失列回退 0/空串；event_id/started_at_ms
 * 不存在才判定库面目全非并抛错。
 */
function extract(root, deviceId, deviceName, since) {
  const db = dbFile(root);
  if (!validate(root)) throw new Error(`未找到 ${NAME} 数据库：${db}`);

  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    let cols;
    try {
      cols = new Set(conn.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name));
    } catch {
      throw new Error(`${NAME} 库中缺少 usage_events 表`);
    }
    if (!cols.has("event_id") || !cols.has("started_at_ms")) {
      throw new Error(`${NAME} usage_events 表结构与发展预期不符（缺 event_id/started_at_ms）`);
    }
    const pick = (c) => (cols.has(c) ? c : "0");
    const pickText = (c) => (cols.has(c) ? c : "''");
    const totalExpr = cols.has("total_tokens")
      ? "total_tokens"
      : `(${pick("input_tokens")} + ${pick("output_tokens")} + ${pick("reasoning_tokens")} + ${pick("cache_read_tokens")} + ${pick("cache_write_tokens")})`;
    const sql = `SELECT event_id,
        ${pickText("session_id")} AS session_id,
        ${pickText("agent_id")} AS agent_id,
        ${pickText("run_kind")} AS run_kind,
        ${pickText("provider")} AS provider,
        ${pickText("model")} AS model,
        started_at_ms,
        ${pick("completed_at_ms")} AS completed_at_ms,
        ${pick("input_tokens")} AS input_tokens,
        ${pick("output_tokens")} AS output_tokens,
        ${pick("reasoning_tokens")} AS reasoning_tokens,
        ${pick("cache_read_tokens")} AS cache_read_tokens,
        ${pick("cache_write_tokens")} AS cache_write_tokens
      FROM usage_events
      WHERE (${totalExpr}) > 0 AND started_at_ms > ?
      ORDER BY started_at_ms`;

    const rows = conn.prepare(sql).all(Math.floor(since > 0 ? since : 0));
    const ctx = { deviceId, deviceName };
    const out = [];
    for (const row of rows) {
      const rec = mapRow(ctx, row);
      // startedAt <= since 的行不重复入库（与 Trae 同款二次防御）
      if (rec && rec.startedAt > since) out.push(rec);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  } finally {
    conn.close();
  }
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, _internal: { mapRow, num } };