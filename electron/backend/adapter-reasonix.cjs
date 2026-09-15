// Reasonix 数据源适配器
// 权威数据源：<state root>/stats/YYYY-MM-DD.jsonl 每日账本（逐次请求聚合，只读）
//   state root 解析：REASONIX_STATE_HOME → REASONIX_HOME → 平台默认
//   （Windows %APPDATA%\reasonix，macOS/Linux ~/.reasonix）
//   仅文件名为合法日期（YYYY-MM-DD.jsonl）的账本参与扫描。
// 口径（互斥桶 → 本项目包含式桶的无损映射，详见 docs/Reasonix数据源接入方案-2026-09-07.md）：
//   账本 cache_miss / cache_hit 是互斥桶，而本项目 inputTokens 含 cacheReadTokens，故：
//   inputTokens         = cache_miss > 0 ? cache_miss + cache_hit : prompt
//   cacheReadTokens     = cache_hit
//   outputTokens        = completion − reasoning（reasoning 是 completion 的子集）
//   reasoningTokens     = reasoning
//   cacheCreationTokens = 0（账本不持久化缓存写入）
//   代入 v_record_cost 后：净输入 = cache_miss、(输出+推理) = completion，计费公式无需改动。
// 不采用：usage-catalog/v1.sqlite（可重建投影，非权威）、~/.reasonix/usage.jsonl（与账本重叠会重复计数）、
//         会话转录 sessions/**/*.jsonl（账本已覆盖）。
// 数据质量：负数 token / reasoning > completion / cache_hit > prompt / turn=true 轮次行 → 跳过并计数。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "reasonix";
const NAME = "Reasonix";

// 记账文件名：仅合法日期参与扫描（与官方「只有日期命名的账本会被发现」一致）
const STATS_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/i;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/**
 * 候选 state root（按优先级）。环境变量支持 ~ 展开与相对路径。
 * Windows 官方路径为 %APPDATA%\reasonix，其他平台 ~/.reasonix。
 */
function candidateRoots() {
  const out = [];
  const expand = (p) => {
    const s = String(p || "").trim();
    if (!s) return null;
    if (s === "~") return homeDir();
    if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(homeDir(), s.slice(2));
    return path.resolve(s);
  };
  for (const key of ["REASONIX_STATE_HOME", "REASONIX_HOME"]) {
    const v = expand(process.env[key]);
    if (v) out.push(v);
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    out.push(path.join(process.env.APPDATA, "reasonix"));
  }
  out.push(path.join(homeDir(), ".reasonix"));
  // 去重保序
  return [...new Set(out)];
}

/** 数据目录：首个真实存在的候选；都不存在返回 null */
function detect() {
  for (const dir of candidateRoots()) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** 校验：必须存在 stats/ 账本目录——无账本即无用量数据，其余目录不足以支撑统计 */
function validate(dir) {
  return !!dir && fs.existsSync(path.join(dir, "stats"));
}

/**
 * 设备标识：Reasonix 无稳定设备文件，逐个尝试常见写法；
 * 全部缺失返回 null，由 sync.cjs 的回退链（zcode deviceMid → UUID）兜底。
 */
function getDeviceId(dir) {
  for (const name of ["device-id", "device_id", ".device-id", "installation_id"]) {
    try {
      const v = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (v) return v;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

/** 读取 config.toml / config.json 的 default_model，作为记录缺 model 字段时的最终兜底 */
function defaultModel(dir) {
  for (const file of ["config.toml", "config.json"]) {
    try {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      // 逐行扫描并排除注释行（行首 # 的 default_model 是已弃用配置，不能当兜底）
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = trimmed.match(/default_model\s*=\s*["']([^"']+)["']/) || trimmed.match(/"default_model"\s*:\s*"([^"]+)"/);
        if (m && m[1]) return m[1];
      }
    } catch {
      /* 文件缺失或不可读，继续 */
    }
  }
  return "";
}

// ---------- 字段读取（多别名容忍：账本字段命名随版本演进，未确认前不做硬假设）----------

/** 取首个非 null/undefined 的候选键 */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** 转非负数字；非法值返回 0 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------

/** 时间戳候选键（同步抽取时的行级过滤与记录映射共用，避免两处漂移） */
const TS_KEYS = ["ts", "timestamp", "time", "at", "createdAt", "created_at", "startedAt", "started_at", "completedAt", "ratedAt"];

/**
 * 时间戳兼容：epoch 秒 / epoch 毫秒 / ISO 字符串。
 * 量级判定：小于 1e11 视为秒（1e11 秒 ≈ 公元 5138 年，远超合理范围）。
 */
function toMs(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** 取账本行的时间戳（ms）；缺失或非法返回 null（此时调用方回退账本日期） */
function recordTs(rec) {
  return toMs(pick(rec, TS_KEYS));
}

/** 本地日期字符串 YYYY-MM-DD（与账本文件名同一口径） */
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 枚举账本文件：按日期倒序无关，最终按文件日期升序返回 */
function findStatsFiles(statsDir, since) {
  let entries;
  try {
    entries = fs.readdirSync(statsDir);
  } catch {
    return [];
  }
  // 多留一天：账本按本地日切分，而 since 是 UTC epoch，跨时区边界时需回看一天
  const minDate = since > 0 ? localDateStr(since - 86400000) : "";
  const out = [];
  for (const name of entries) {
    const m = String(name).match(STATS_FILE_RE);
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (minDate && date < minDate) continue;
    out.push({ date, file: path.join(statsDir, name) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 单条账本行 → UsageRecord；不合规返回 null（不静默钳制为零）。
 * @param rec 原始行对象
 * @param date 账本日期（时间戳缺失时的回退）
 * @param lineNo 行号（去重键组成）
 * @param fallbackModel 配置默认模型（模型名最终兜底）
 * @param ctx 设备上下文
 */
function mapRecord(rec, date, lineNo, fallbackModel, ctx) {
  if (!rec || typeof rec !== "object") return null;
  // turn=true 是轮次标记而非一次 provider call，计入会重复计数
  if (rec.turn === true) return null;

  const cacheHit = num(pick(rec, ["cache_hit", "cacheHit", "cache_read", "cacheRead", "cached_tokens"]));
  const cacheMiss = num(pick(rec, ["cache_miss", "cacheMiss", "cache_miss_tokens", "uncached"]));
  const prompt = num(pick(rec, ["prompt", "prompt_tokens", "promptTokens", "input", "input_tokens"]));
  const completion = num(pick(rec, ["completion", "completion_tokens", "completionTokens", "output", "output_tokens"]));
  const reasoning = num(pick(rec, ["reasoning", "reasoning_tokens", "reasoningTokens", "completion_reasoning_tokens"]));
  const total = num(pick(rec, ["total", "total_tokens", "totalTokens"]));
  const requests = num(pick(rec, ["requests", "requestCount", "request_count", "calls"]));

  // 无用量信号的行不产生记录（避免把纯元数据行计成 0 token 调用）
  const hasUsage = prompt || cacheHit || cacheMiss || completion || reasoning || total || requests;
  if (!hasUsage) return null;

  // 数据质量边界：这些组合无法安全归一化，跳过而非钳制
  if (reasoning > completion) return null;
  const inputTotal = cacheMiss > 0 ? cacheMiss + cacheHit : prompt;
  if (inputTotal < cacheHit) return null;

  // 时间戳：优先记录内字段，缺失回退账本日期本地 12:00（保证按日归档正确）
  const ts = recordTs(rec);
  const [Y, M, D] = date.split("-").map(Number);
  const startedAt = ts !== null ? ts : new Date(Y, M - 1, D, 12, 0, 0).getTime();

  const rawModel = String(pick(rec, ["model", "modelId", "model_id", "modelName", "requestModel", "requestModelId", "requested_model"]) || "").trim();
  const modelId = normalizeModel(rawModel || fallbackModel || "unknown");

  // 供应商：Reasonix 为 DeepSeek 原生，未命中模型前缀时兜底 DeepSeek 而非「未知供应商」
  const provider = providerName("", modelId);
  const providerId = provider.startsWith("未知供应商") ? "DeepSeek" : provider;

  return {
    id: `${ctx.deviceId}:${ID}:${date}:${lineNo}`,
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    source: ID,
    providerId,
    modelId,
    variant: pick(rec, ["effort", "reasoningEffort", "reasoning_effort", "preset", "variant"]),
    taskType: pick(rec, ["taskType", "task_type", "kind"]),
    sessionId: pick(rec, ["sessionId", "session_id", "sessionName", "topicId", "topic_id"]),
    mode: pick(rec, ["mode", "surface", "entry", "entrypoint"]),
    // 互斥桶 → 包含式桶的映射（详见文件头注释）
    inputTokens: inputTotal,
    outputTokens: Math.max(0, completion - reasoning),
    reasoningTokens: reasoning,
    cacheCreationTokens: 0,
    cacheReadTokens: cacheHit,
    startedAt,
    completedAt: ts !== null ? ts : undefined,
    status: String(pick(rec, ["status"]) || "success"),
  };
}

/**
 * 增量抽取：扫描 stats/ 下日期 ≥ since 的账本，逐行归一化为 UsageRecord。
 * 账本为 append-only 日文件，行号天然稳定，配合幂等 id 可安全重复扫描。
 */
function extract(dir, deviceId, deviceName, since) {
  const statsDir = path.join(dir, "stats");
  if (!fs.existsSync(statsDir)) {
    throw new Error(`未找到 Reasonix 账本目录：${statsDir}`);
  }

  const sinceMs = Number.isFinite(since) ? since : 0;
  const fallbackModel = defaultModel(dir);
  const ctx = { deviceId, deviceName };

  const out = [];
  let skipped = 0;
  let files = 0;

  for (const { date, file } of findStatsFiles(statsDir, sinceMs)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // 单文件不可读（占用/权限）跳过，不影响其余账本
    }
    files++;
    let lineNo = 0;
    for (const line of text.split(/\r?\n/)) {
      lineNo++;
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        skipped++; // 损坏行跳过
        continue;
      }
      // 行级增量过滤：回看窗口内的旧文件里，时间戳已被抽取过的行静默跳过。
      // 仅对「有显式时间戳」的行生效——缺失时间戳的行靠账本日期归档，不能因窗口被丢弃。
      const ts = recordTs(rec);
      if (sinceMs > 0 && ts !== null && ts <= sinceMs) continue;
      const row = mapRecord(rec, date, lineNo, fallbackModel, ctx);
      if (row) out.push(row);
      else if (!rec || typeof rec !== "object" || rec.turn !== true) skipped++;
    }
  }

  if (skipped > 0) {
    // 与 Antigravity 系一致写日志：异常行可见但不阻断同步
    const db = require("./db.cjs");
    db.addLog("extract", "warn", `Reasonix 跳过 ${skipped} 行无法归一化或已损坏的账本记录`, `扫描 ${files} 个账本文件`);
  }

  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = {
  id: ID,
  name: NAME,
  detect,
  validate,
  getDeviceId,
  extract,
  // 导出供自测复用（纯函数，不依赖文件系统）
  _internal: { candidateRoots, mapRecord, recordTs, toMs, num, pick, STATS_FILE_RE },
};
