/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// MiniMax Code 数据源适配器（用量统计 L2：本机客户端逐次账本）
//
// 权威数据源：~/.minimax/v2/sqlite/runtime-state.sqlite → local_runtime_token_usage
//   （客户端运行时自己的 token 账本，每次模型调用一行）
// 设备标识：~/.minimax/v2/session-handoff/device-id（客户端生成的设备号）
//
// 【口径修订 2026-11-13】MiniMax 客户端记录的 cache_read_tokens（本机样本 2304）
// 实为平台服务端系统前缀（System Prompt / 工具定义）的公共前缀命中，并非用户的主动缓存，
// 且客户端及官方日用量均未对其做缓存折算计费（cost 恒 0、免费积分照常扣减）。
// 若作为缓存计入会导致 MiniMax 产生刺眼的 ~8% 假命中率并污染全局平均统计。
// 故按「缓存口径不可得（No-Cache-Source）」处理：
//   - inputTokens 保持 input + cacheRead（发给模型的总输入上下文 28780，总量 29428 不漏算）；
//   - cacheReadTokens 与 cacheCreationTokens 恒置 0；
//   - 系统根据两桶皆 0 自动将其识别为不可得源，单源命中率显示「-」，且不计入全局命中率。
//
// 【不采】%APPDATA%\MiniMax\logs\api-*.log：只有 URL/状态/耗时，body 仅记长度，无 token 数值。
// 【不采】cost_usd：客户端价目未命中（实测恒 0 且 raw.cost 全 0），成本一律由 model_price 视图重算。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openReadOnly } = require("./temp-util.cjs");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "minimax";
const NAME = "MiniMax Code";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 数据目录（默认 ~/.minimax；~/.mavis 是指向它的符号链接，不单独认） */
function defaultDir() {
  return path.join(homeDir(), ".minimax");
}

/** 运行时数据库（v2 布局；旧版 v1 无 token 账本，不兼容） */
function dbFile(root) {
  return path.join(root || defaultDir(), "v2", "sqlite", "runtime-state.sqlite");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dbFile(dir)) ? dir : null;
}

function validate(dir) {
  try {
    return fs.existsSync(dbFile(dir));
  } catch {
    return false;
  }
}

/** 设备标识：优先客户端自己的 device-id；缺失时用数据目录路径哈希兜底（同机稳定，不跨机撞车） */
function getDeviceId() {
  try {
    const s = fs.readFileSync(path.join(defaultDir(), "v2", "session-handoff", "device-id"), "utf8").trim();
    if (s) return s;
  } catch {
    /* 客户端未生成过，走兜底 */
  }
  return crypto.createHash("sha256").update(defaultDir()).digest("hex").slice(0, 16);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 增量抽取：只读打开运行时库（运行中会锁库，openReadOnly 自动复制 db+wal+shm 到 %TEMP% 再读），
 * 取 ts > since 的行。ts 与 since 同为毫秒，直接比较。
 *
 * 单条损坏不阻断整批：列缺失属于「客户端版本变了」，直接抛错让同步层跳过本源并上报，
 * 不在这种场景里做静默降级（降级会让整段时间的用量悄悄消失）。
 */
function extract(root, deviceId, deviceName, since) {
  const file = dbFile(root);
  if (!fs.existsSync(file)) throw new Error(`${NAME} 数据库不存在：${file}`);

  const db = openReadOnly(file, "dosage-minimax-");
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT session_id, agent_name, framework_type, turn_id, model, ts,
                input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
           FROM local_runtime_token_usage
          WHERE ts > ?
          ORDER BY ts`
      )
      .all(Number(since) || 0);
  } finally {
    try {
      db.close();
    } catch {
      /* 副本连接的关闭失败不影响已取到的行 */
    }
  }

  const out = [];
  for (const row of rows) {
    const startedAt = num(row.ts);
    if (!startedAt || startedAt <= since) continue;

    const input = num(row.input_tokens);
    const output = num(row.output_tokens);
    const cacheRead = num(row.cache_read_tokens);
    const cacheWrite = num(row.cache_write_tokens);
    // 五桶全 0 不入库（取消/失败/空轮次）；半成品行会把锚点推前，后续回填永久漏采
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;

    // 去重键：一次调用 = (会话, 轮次)。turn_id 缺失时退化为 (会话, 时间戳, 模型)，
    // 保证同一行重复抽取时 id 稳定（usage_record 是 INSERT OR REPLACE，同键覆盖天然幂等）
    const turnKey = String(row.turn_id || `${startedAt}:${row.model || ""}`);

    out.push({
      id: `${deviceId}:${ID}:${row.session_id || "nosession"}:${turnKey}`,
      deviceId,
      deviceName,
      source: ID,
      providerId: "MiniMax",
      // model 形如 minimax/MiniMax-M3.1-Flash；normalizeModel 取最后一个 "/" 之后并小写 → minimax-m3.1-flash
      modelId: normalizeModel(row.model),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      agent: row.agent_name ? String(row.agent_name) : undefined,
      mode: row.framework_type ? String(row.framework_type) : undefined,
      inputTokens: input + cacheRead, // 完整输入上下文总量（保持 totalTokens = 29428 保真）
      outputTokens: output,
      reasoningTokens: 0, // Anthropic 的 output 已含 thinking，单列会双计
      cacheCreationTokens: 0,
      cacheReadTokens: 0, // 不计入缓存命中率（服务端公共前缀非用户主动缓存，两桶皆 0 归入不可得源）
      startedAt,
      status: "success",
    });
  }
  return out;
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
