// Codex 数据源适配器
// 权威数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 归档补充源：~/.codex/archived_sessions/rollout-*.jsonl（会话被归档后移入，内容不再变化；
//   归档文件 mtime 保留会话最后写入时间，不可用于增量判断，遵循 sync.cjs 的「文件名→大小」清单）
// 设备标识：~/.codex/installation_id
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "codex";
const NAME = "Codex";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function defaultDir() {
  return path.join(homeDir(), ".codex");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(path.join(dir, "sessions"));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, "installation_id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function findRolloutFiles(root) {
  const out = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function findRollouts(dir) {
  return findRolloutFiles(path.join(dir, "sessions"));
}

function findArchivedRollouts(dir) {
  return findRolloutFiles(path.join(dir, "archived_sessions"));
}

/** 归档目录清单：绝对路径 → 文件大小。归档文件内容不可变，大小相同即视为已处理。 */
function buildArchivedIndex(dir) {
  const index = {};
  for (const file of findArchivedRollouts(dir)) {
    try {
      index[file] = fs.statSync(file).size;
    } catch {
      /* stat 失败的文件本轮略过，下轮清单重建后重试 */
    }
  }
  return index;
}

function firstModel(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.model === "string" && value.model.trim()) return value.model;
  for (const child of Object.values(value)) {
    const found = firstModel(child);
    if (found) return found;
  }
  return null;
}

function sessionIdFromFile(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  return match ? match[1] : path.basename(file, ".jsonl");
}

/** 解析单个 rollout 文件产出记录；since 过滤事件时间，与调用方对 mtime 的跳过配合。 */
function parseRolloutFile(file, deviceId, deviceName, since) {
  const events = [];
  let sessionId = sessionIdFromFile(file);
  let model = null;
  // fallback 序号须混入文件维度：会话 resume 后同一 sessionId 会写入新的
  // rollout 文件，纯文件内序号会让两个文件的无 ordinal 事件 id 碰撞，被去重吞掉
  const fileSeqSalt = crypto.createHash("sha1").update(file).digest("hex").slice(0, 8);
  let fallbackSequence = 0;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item.type === "session_meta" && typeof item.payload?.id === "string") {
      sessionId = item.payload.id;
    }
    if (!model) model = firstModel(item);

    if (item.type !== "event_msg" || item.payload?.type !== "token_count") continue;
    const usage = item.payload.info?.last_token_usage;
    if (!usage || typeof usage !== "object") continue;
    fallbackSequence++;
    const startedAt = new Date(item.timestamp).getTime();
    if (!Number.isFinite(startedAt) || startedAt <= since) continue;

    // ordinal 前提：Codex 的 ordinal 是全 session 单调递增的（resume 后的新文件延续编号），
    // 故带 ordinal 的事件不存在跨文件碰撞；仅无 ordinal 的 fallback 分支需要文件盐
    events.push({
      sequence: item.ordinal ?? `${fileSeqSalt}:${fallbackSequence}`,
      startedAt,
      usage,
    });
  }

  const modelId = normalizeModel(model || "unknown");
  const out = [];
  for (const event of events) {
    const usage = event.usage;
    out.push({
      id: `${deviceId}:codex:${sessionId}:${event.sequence}`,
      deviceId,
      deviceName,
      source: ID,
      providerId: providerName("openai", modelId),
      modelId,
      sessionId,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.reasoning_output_tokens ?? 0,
      cacheCreationTokens: usage.cache_write_input_tokens ?? 0,
      cacheReadTokens: usage.cached_input_tokens ?? 0,
      startedAt: event.startedAt,
      completedAt: event.startedAt,
      status: "success",
    });
  }
  return out;
}

/** 增量抽取：只采 event_msg/token_count 的 last_token_usage，累计值不入库。 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 Codex 会话目录：${path.join(dir, "sessions")}`);

  const out = [];
  for (const file of findRollouts(dir)) {
    // rollout 文件为 append-only（会话期间追加、此后不再修改）：mtime 早于回扫窗口起点的
    // 文件不可能包含 startedAt > since 的事件，直接跳过，避免每次同步全量读盘解析
    if (since > 0) {
      try {
        if (fs.statSync(file).mtimeMs <= since) continue;
      } catch {
        /* stat 失败按原逻辑全量解析 */
      }
    }
    out.push(...parseRolloutFile(file, deviceId, deviceName, since));
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** 归档会话抽取：清单缺失/大小不符的文件全量解析（since=0，不过滤时间）。幂等由 id 保证。 */
function extractArchived(dir, deviceId, deviceName, knownIndex) {
  const archivedRoot = path.join(dir, "archived_sessions");
  if (!fs.existsSync(archivedRoot)) {
    throw new Error(`未找到 Codex 归档会话目录：${archivedRoot}`);
  }

  const out = [];
  for (const file of findArchivedRollouts(dir)) {
    if (knownIndex) {
      let size = -1;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue; // stat 失败按未处理跳过，下轮重试
      }
      if (knownIndex[file] === size) continue; // 大小一致：内容不可变，无需重读
    }
    out.push(...parseRolloutFile(file, deviceId, deviceName, 0));
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, findArchivedRollouts, buildArchivedIndex, extractArchived };