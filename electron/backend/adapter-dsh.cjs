// DeepSeek Harness 数据源适配器
// 权威数据源：~/.dsh/tokenledger.sqlite 的 session_rollups 表
// 设备标识：~/.dsh/.anonymous-user-id
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");
const { rmTempDir, sweepStale } = require("./temp-util.cjs");

const ID = "dsh";
const NAME = "DeepSeek Harness";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function defaultDir() {
  return path.join(homeDir(), ".dsh");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(path.join(dir, "tokenledger.sqlite"));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, ".anonymous-user-id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function readRows(dbFile) {
  const conn = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return conn.prepare(`
      SELECT sessionId, day, site, provider, model, inputTokens, outputTokens,
             cacheReadTokens, cacheWriteTokens, reasoningTokens
      FROM session_rollups
      ORDER BY day ASC, sessionId ASC
    `).all();
  } finally {
    conn.close();
  }
}

function readWithWalFallback(dir) {
  const dbFile = path.join(dir, "tokenledger.sqlite");
  try {
    return readRows(dbFile);
  } catch (directError) {
    sweepStale("dosage-sync-dsh-"); // 崩溃遗留的上轮临时副本，本轮顺手清理
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosage-sync-dsh-"));
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = dbFile + suffix;
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempDir, `tokenledger.sqlite${suffix}`));
      }
      return readRows(path.join(tempDir, "tokenledger.sqlite"));
    } catch (fallbackError) {
      throw new Error(`读取 DeepSeek Harness 数据失败：${fallbackError.message || directError.message}`);
    } finally {
      rmTempDir(tempDir); // 删除失败静默：不掩盖正常结果/原始错误，残留由下轮 sweepStale 清理
    }
  }
}

function localDayStart(day) {
  const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [y, m, d] = [+match[1], +match[2], +match[3]];
  // 非法月份/日期（如 2026-13-40）必须拒绝——Date 构造会静默进位到错误的年月
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const value = new Date(y, m - 1, d).getTime();
  return Number.isFinite(value) ? value : null;
}

/** 本地日期字符串 YYYY-MM-DD（与 session_rollups.day 同一口径） */
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** DSH 的 inputTokens 不含缓存读取，归一化后补入缓存读取量以统一缓存命中率口径。 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 DeepSeek Harness 数据库：${path.join(dir, "tokenledger.sqlite")}`);

  // 日粒度记录配毫秒水位线的关键防御：session_rollups 的 startedAt 被压成当天零点，
  // 若按「startedAt <= since 跳过」严格增量，昨天/今天行在锚点推进后发生的迟写更新
  // （跨午夜会话收尾、token 回填）会被永久过滤。改为按「本地日期 ≥ since 前一天」
  // 宽松回扫，重复行靠幂等 id（含 sessionId+day+site+provider+model）在入库时覆盖去重。
  const minDay = since > 0 ? localDateStr(since - 86400000) : "";

  const out = [];
  for (const row of readWithWalFallback(dir)) {
    if (minDay && String(row.day || "") < minDay) continue;
    const startedAt = localDayStart(row.day);
    if (startedAt === null) continue;
    const modelId = normalizeModel(row.model || "unknown");
    const rawInput = row.inputTokens ?? 0;
    const cacheRead = row.cacheReadTokens ?? 0;
    const cacheWrite = row.cacheWriteTokens ?? 0;
    out.push({
      id: `${deviceId}:dsh:${row.sessionId}:${row.day}:${row.site}:${row.provider}:${row.model}`,
      deviceId,
      deviceName,
      source: ID,
      providerId: providerName(row.provider, modelId),
      modelId,
      taskType: row.site || undefined,
      sessionId: row.sessionId || undefined,
      inputTokens: rawInput + cacheRead,
      outputTokens: row.outputTokens ?? 0,
      reasoningTokens: row.reasoningTokens ?? 0,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      startedAt,
      status: "success",
    });
  }
  return out;
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
