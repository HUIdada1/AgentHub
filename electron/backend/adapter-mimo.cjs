// Xiaomi MiMo 数据源适配器
// 权威数据源：~/.local/share/mimocode/mimocode.db 的 message 表（只读；引擎为 opencode 风格的 MiMoCode）
// 口径（2026-09-22 本机实测）：assistant 消息 data.tokens =
//   { total, input, output, reasoning, cache:{ write, read } }，total = 五项之和；
//   input 为新鲜输入（不含缓存读），cache.read 是系统提示等长上下文的命中量（官方消息按
//   提示全量缓存，新消息仅计几 token）；user 消息无 tokens 字段，不采集。
//   入库时 inputTokens = input + cache.read，对齐全系统基线「input_tokens 含 cache_read_tokens」
//   （db.cjs 净输入/计费均按相减拆分，口径错位会导致命中率超 100%、计费为负）。
//   providerID "mr" 为小米路由（模型含官方 mimo-v2.6-* 与第三方路由模型如 deepseek-v4.1-flash），
//   模型已含在 modelId 中，provider 恒记「小米 MiMo」（与 grok 恒 xAI 同策）。
// 时间：startedAt 取 data.time.created（毫秒，与 message.time_created 列一致）；
//   tokens 在轮次结束回填，回填场景由同步引擎 24h 回扫窗口覆盖（同 grok）。
// 幂等键：deviceId:mimo:msgId——tokens 回填时同 id 覆盖更新。
// 五桶全 0 不输出：锚点只被已成型消息推进，防止半成品消息把锚点推走后漏采回填。
// 设备标识：~/.local/share/mimocode/installation_id（UUID）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel } = require("./adapter-zcode.cjs");
const { openReadOnly } = require("./temp-util.cjs");

const ID = "mimo";
const NAME = "Xiaomi MiMo";
const PROVIDER = "小米 MiMo";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 数据目录（默认 ~/.local/share/mimocode） */
function defaultDir() {
  return path.join(homeDir(), ".local", "share", "mimocode");
}

/** 自测注入环境变量覆盖（临时目录隔离，不触碰真实 ~/.local/share/mimocode） */
function resolveRoot() {
  const env = String(process.env.MIMO_HOME || "").trim();
  return env ? path.resolve(env) : defaultDir();
}

function dbFile(dir) {
  return path.join(dir, "mimocode.db");
}

function detect() {
  const dir = resolveRoot();
  return fs.existsSync(dbFile(dir)) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(dbFile(dir));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, "installation_id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 非负有限数字，非法返回 0（与 grok/opensquilla 同款兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一条 assistant 消息 → 事件记录；tokens 缺失/五桶全 0/时间非法返回 null */
function mapRow(deviceId, deviceName, row, data) {
  const t = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
  const cache = data.tokens && typeof data.tokens.cache === "object" ? data.tokens.cache : {};
  const input = num(t.input);
  const output = num(t.output);
  const reasoning = num(t.reasoning);
  const cacheWrite = num(cache.write);
  const cacheRead = num(cache.read);
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return null;

  const startedAt = Number(row.time_created);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const completedAt = Number(data.time && data.time.completed);

  return {
    id: `${deviceId}:mimo:${row.id}`,
    deviceId,
    deviceName,
    source: ID,
    providerId: PROVIDER,
    modelId: data.modelID ? normalizeModel(data.modelID) : "unknown",
    sessionId: typeof row.session_id === "string" && row.session_id ? row.session_id : undefined,
    agent: typeof data.agent === "string" && data.agent ? data.agent : undefined,
    mode: typeof data.mode === "string" && data.mode ? data.mode : undefined,
    // 口径对齐：全系统基线 input_tokens 含 cache_read_tokens（db.cjs 计费/净输入相减），
    // opencode 的 input 为新鲜输入，故入库前并入 cache.read；总量仍与源端 total 一致不重复
    inputTokens: input + cacheRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    startedAt,
    completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : undefined,
    status: "success",
  };
}

/**
 * 增量抽取：time_created > since 的 assistant 消息。
 * since 为毫秒（统一锚点口径）；data 损坏（半截 JSON）跳过该行，下轮回扫补采。
 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) {
    throw new Error(`未找到 ${NAME} 数据库：${dbFile(dir)}`);
  }
  // MiMoCode 引擎运行中可能锁库：openReadOnly 复制三件套到临时副本再读（exit 钩子兜底清理）
  const conn = openReadOnly(dbFile(dir), "dosage-sync-mimo-");
  const out = [];
  try {
    const rows = conn
      .prepare("SELECT id, session_id, time_created, data FROM message WHERE time_created > ? ORDER BY time_created ASC")
      .all(since);
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!data || data.role !== "assistant") continue;
      const rec = mapRow(deviceId, deviceName, row, data);
      if (rec && rec.startedAt > since) out.push(rec);
    }
  } finally {
    conn.close();
  }
  return out;
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, _internal: { mapRow, num } };
