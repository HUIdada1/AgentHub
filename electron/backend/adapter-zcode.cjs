// ZCode 数据源适配器
// 权威数据源：~/.zcode/cli/db/db.sqlite 的 model_usage 表（只读）
// 设备标识：~/.zcode/v2/telemetry-state.json 的 deviceMid
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ID = "zcode";
const NAME = "ZCode";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 数据目录（默认 ~/.zcode） */
function defaultDir() {
  return path.join(homeDir(), ".zcode");
}

/** 供应商 UUID → 可读名（ZCode 的 provider_id 多为裸 UUID，几乎不命中，见下方模型推断） */
const PROVIDER_MAP = {
  "builtin:zai-start-plan": "智谱 GLM",
  "builtin:bigmodel-coding-plan": "智谱 GLM",
};

/**
 * 模型名 → 供应商名 推断（provider_id 为裸 UUID 时的兜底）。
 * 按模型名前缀匹配，未命中返回 null。
 */
function providerByModel(modelId) {
  const m = String(modelId || "").toLowerCase();
  if (m.startsWith("glm") || m.includes("bigmodel") || m.includes("zhipu") || m.includes("zai-")) return "智谱 GLM";
  if (m.startsWith("deepseek")) return "DeepSeek";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "Qwen";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("openai")) return "OpenAI";
  if (m.startsWith("minimax") || m.startsWith("abab")) return "MiniMax";
  if (m.startsWith("claude")) return "Anthropic";
  if (m.startsWith("gemini")) return "Google";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "Moonshot";
  if (m.startsWith("doubao")) return "字节豆包";
  if (m.startsWith("hunyuan")) return "腾讯混元";
  if (m.startsWith("ernie") || m.includes("wenxin")) return "百度文心";
  if (m.startsWith("stealth")) return "OpenRouter";
  if (m.startsWith("dots3")) return "Dots";
  return null;
}

function providerName(providerId, modelId) {
  if (PROVIDER_MAP[providerId]) return PROVIDER_MAP[providerId];
  const byModel = providerByModel(modelId);
  if (byModel) return byModel;
  const short = String(providerId).slice(0, 8);
  return `未知供应商:${short}`;
}

/** 模型别名规范化：同一模型多种写法归并 */
function normalizeModel(model) {
  let m = String(model).trim().toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.lastIndexOf(":");
  if (colon >= 0) m = m.slice(0, colon);
  m = m.replace(/[ _]/g, "-");
  // 去掉日期/版本快照后缀：-YYYY-MM-DD（如 -2026-07-15）、-YYYYMMDD（8位）、-MMDD（如 -0731）
  m = m.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/g, "");
  return m;
}

/** 时间戳兼容读取：INTEGER(ms) / REAL / TEXT(ISO 或 "%Y-%m-%d %H:%M:%S") */
function valueToMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Math.floor(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const iso = new Date(s).getTime();
    if (!Number.isNaN(iso)) return iso;
    // "%Y-%m-%d %H:%M:%S"（本地时间）
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
    return null;
  }
  return null;
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(path.join(dir, "cli", "db", "db.sqlite"));
}

function getDeviceId(dir) {
  const telemetry = path.join(dir, "v2", "telemetry-state.json");
  try {
    const text = fs.readFileSync(telemetry, "utf8");
    const v = JSON.parse(text);
    return typeof v.deviceMid === "string" ? v.deviceMid : null;
  } catch {
    return null;
  }
}

/**
 * 增量抽取：读取 started_at > since 的记录。
 * 返回 camelCase 的 UsageRecord 数组（与前端结构一致）。
 */
function extract(dir, deviceId, deviceName, since) {
  const dbFile = path.join(dir, "cli", "db", "db.sqlite");
  if (!fs.existsSync(dbFile)) {
    throw new Error(`未找到 ZCode 数据库：${dbFile}`);
  }

  const conn = new DatabaseSync(dbFile, { readOnly: true });
  const out = [];
  try {
    const stmt = conn.prepare(`
      SELECT id, session_id, provider_id, model_id, variant, agent, mode, task_type, status,
             started_at, completed_at, duration_ms,
             input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens
      FROM model_usage
      WHERE started_at > ?
      ORDER BY started_at ASC
    `);
    const rows = stmt.all(since);
    for (const row of rows) {
      const srcId = String(row.id);
      const startedMs = valueToMs(row.started_at) ?? 0;
      const completedMs = valueToMs(row.completed_at);

      out.push({
        id: `${deviceId}:zcode:${srcId}`,
        deviceId,
        deviceName,
        source: ID,
        providerId: providerName(row.provider_id, row.model_id),
        modelId: normalizeModel(row.model_id),
        variant: row.variant ?? undefined,
        taskType: row.task_type ?? undefined,
        sessionId: row.session_id ?? undefined,
        agent: row.agent ?? undefined,
        mode: row.mode ?? undefined,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        reasoningTokens: row.reasoning_tokens ?? 0,
        cacheCreationTokens: row.cache_creation_input_tokens ?? 0,
        cacheReadTokens: row.cache_read_input_tokens ?? 0,
        startedAt: startedMs,
        completedAt: completedMs ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        status: row.status ?? "success",
      });
    }
  } finally {
    conn.close();
  }
  return out;
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, normalizeModel, providerName };
