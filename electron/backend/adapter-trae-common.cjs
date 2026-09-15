// Trae / Trae CN / TRAE SOLO / TRAE SOLO CN 数据源公共工厂
// 用量权威来源：%APPDATA%\<AppName>\ModularData\ai-agent\database.db（SQLCipher 整库加密）
//   chat_turn 表每行对应一次用户与 AI 的交互（一问一答），context 列（TEXT JSON）的
//   token_usage 对象含五桶细分：prompt_tokens / completion_tokens / reasoning_tokens /
//   cache_creation_input_tokens / cache_read_input_tokens。
// 解密：sqlcipher.cjs（koffi FFI + 内置 sqlcipher.dll），密钥为应用内硬编码固定值
//   （四应用通用，与机器/salt 无关，2026-09-11 内存搜索实测提取，详见
//   docs/Trae数据源接入方案-2026-09-11.md）。
// 口径（2026-09-11 本机实测）：
//   - inputTokens = prompt_tokens（含 cache_read，与本项目其余源一致的总口径）；
//   - token_usage 为每 turn 的**累计值**（含上下文窗口重复传入），同 session 后续 turn
//     会把前文重复计入 prompt——这是 Trae 客户端计量方式，统计偏大属预期；
//   - cache_creation 实测全 0；Trae CN 的 cache_read 亦全 0（无缓存机制）；
//   - 模型名缺失（token_usage.name 为空、chat_turn 无 model 列），一期统一归因为
//     源名（trae / trae-cn / trae-solo / trae-solo-cn），供应商按源名归一为 "Trae"。
// 幂等键：turn_id（全局唯一 24 位 hex）。
// 增量：created_at 秒级时间戳（非毫秒），按统一锚点 since 过滤。
// 优雅降级：DLL 缺失/密钥失效/库损坏时抛错由 sync 层记日志，不影响其他源。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlcipher = require("./sqlcipher.cjs");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");
const { rmTempDir, sweepStale } = require("./temp-util.cjs");

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function appDataDir() {
  return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
}

/** 非负有限数字，非法返回 0（db 层 safeToken 之外的适配器侧兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 工厂：id 为 source id，name 为显示名，appDirName 为 %APPDATA% 下的应用目录名，
 * envKey 为自测注入环境变量（覆盖默认应用数据根）。
 * 返回标准适配器契约 { id, name, detect, validate, getDeviceId, extract }。
 */
function makeTraeAdapter(id, name, appDirName, envKey) {
  /** 应用数据根（%APPDATA%\<appDirName>） */
  function defaultRoot() {
    return path.join(appDataDir(), appDirName);
  }

  function resolveRoot() {
    const env = String(process.env[envKey] || "").trim();
    return env ? path.resolve(env) : defaultRoot();
  }

  /** 数据库文件路径 */
  function dbFile(root) {
    return path.join(root, "ModularData", "ai-agent", "database.db");
  }

  /** 数据目录存在即探测成功（与其他源 detect 返回「数据根」一致） */
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

  /** 设备标识：%APPDATA%\<app>\machineid（UUID 文本文件） */
  function getDeviceId(root) {
    try {
      const text = fs.readFileSync(path.join(root, "machineid"), "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * 复制 db + wal + shm 到临时目录（应用可能持有锁；WAL 含最新数据必须带上）。
   * 返回 { dir, db }；调用方负责 open/close 并在 finally 中 rmTempDir(dir)。
   * 复制中途失败（源被独占/磁盘不足）时立即清理半成品目录再抛错，不留残留。
   */
  function copyToTemp(root) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dosage-trae-${id}-`));
    try {
      const src = dbFile(root);
      for (const suffix of ["", "-wal", "-shm"]) {
        const from = src + suffix;
        if (fs.existsSync(from)) {
          fs.copyFileSync(from, path.join(dir, "database.db" + suffix));
        }
      }
    } catch (e) {
      rmTempDir(dir);
      throw e;
    }
    sweepStale("dosage-trae-", dir); // 清理崩溃遗留与旧版本堆积，本轮删不掉下轮再清
    return { dir, db: path.join(dir, "database.db") };
  }

  /**
   * 增量抽取：打开加密库副本，取 chat_turn 中 context 带 token_usage 且 created_at > since 的行。
   * since 为毫秒（统一锚点口径），created_at 为秒级——比较前换算。
   */
  function extract(root, deviceId, deviceName, since) {
    if (!validate(root)) throw new Error(`未找到 ${name} 数据库：${dbFile(root)}`);
    if (!sqlcipher.available()) {
      throw new Error(`${name} 数据源需要 SQLCipher 支持（resources/sqlcipher 缺失或损坏）`);
    }

    const { dir: tmpDir, db: tmpDb } = copyToTemp(root);
    let rows;
    try {
      let db;
      try {
        db = sqlcipher.open(tmpDb);
      } catch (e) {
        throw new Error(`${name} 数据库解密失败（密钥可能已变更）：${e.message}`);
      }

      const sinceSec = Math.floor((since > 0 ? since : 0) / 1000);
      try {
        rows = sqlcipher.queryAll(
          db,
          `SELECT turn_id, session_id, context, created_at, turn_status, agent_type
           FROM chat_turn
           WHERE context IS NOT NULL AND context != '' AND created_at > ${sinceSec}
           ORDER BY created_at`
        );
      } finally {
        sqlcipher.close(db);
      }
    } finally {
      // 临时库用完即删：405MB 每轮一个，不删会在 %TEMP% 每小时堆积；删除失败静默，下轮清扫兜底
      rmTempDir(tmpDir);
    }

    const out = [];
    for (const row of rows) {
      if (!row.turn_id) continue;
      const startedAt = num(row.created_at) * 1000;
      if (!startedAt || startedAt <= since) continue;

      // context JSON → token_usage 五桶
      let usage = null;
      try {
        const ctx = JSON.parse(row.context);
        usage = ctx && typeof ctx === "object" && ctx.token_usage && typeof ctx.token_usage === "object"
          ? ctx.token_usage
          : null;
      } catch {
        continue; // 损坏 JSON 跳过该条，不阻断其余
      }
      if (!usage) continue;

      const input = num(usage.prompt_tokens);
      const output = num(usage.completion_tokens);
      const reasoning = num(usage.reasoning_tokens);
      // 无任何 token 数值的轮次不入库（取消/失败/空轮次）
      if (input === 0 && output === 0 && reasoning === 0) continue;

      const status = row.turn_status === "completed" || row.turn_status === "success"
        ? "success"
        : String(row.turn_status || "success");

      out.push({
        id: `${deviceId}:${id}:${row.turn_id}`,
        deviceId,
        deviceName,
        source: id,
        providerId: providerName("trae", id),
        modelId: normalizeModel(id),
        sessionId: row.session_id || undefined,
        mode: row.agent_type || undefined,
        inputTokens: input,
        outputTokens: output,
        reasoningTokens: reasoning,
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        startedAt,
        completedAt: startedAt,
        status,
      });
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  return { id, name, detect, validate, getDeviceId, extract };
}

module.exports = { makeTraeAdapter };
