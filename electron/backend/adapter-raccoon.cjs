// 商汤小浣熊数据源适配器
// 权威数据源：~/.box-agent/sessions/<sessionId>/session.jsonl（逐事件 JSONL 流）
// 设备标识：%APPDATA%\office-raccoon\desktop-device-identity.json 的 clientDeviceId
// 配对键：每个模型请求 = 一对事件，(turn, step) 唯一配对
//   - request/header    → data.{turn, step, header.config.model}
//   - assistant/message → data.{turn, step, message.usage}
// 实测：43 个 step 全部成功配对 model↔usage，无重复、无孤儿
// 口径：reasoning/cache 拆分本地不可得，恒 0（不参与"全部"命中率平均，db.cjs:684-689 自动排除）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel } = require("./adapter-zcode.cjs");

const ID = "raccoon";
const NAME = "商汤小浣熊";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 数据目录（默认 ~/.box-agent） */
function defaultDir() {
  return path.join(homeDir(), ".box-agent");
}

/** 会话日志目录 */
function sessionsDir(dir) {
  return path.join(dir, "sessions");
}

/** 设备标识文件（office-raccoon 桌面客户端目录） */
function deviceIdentityFile() {
  const appData = process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
  return path.join(appData, "office-raccoon", "desktop-device-identity.json");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(sessionsDir(dir));
}

function getDeviceId() {
  try {
    const text = fs.readFileSync(deviceIdentityFile(), "utf8");
    const v = JSON.parse(text);
    return typeof v.clientDeviceId === "string" ? v.clientDeviceId : null;
  } catch {
    return null;
  }
}

/** 解析单个 session.jsonl，产出配对后的 UsageRecord 数组 */
function parseSessionFile(file, deviceId, deviceName, since) {
  const sessionId = path.basename(path.dirname(file));
  const byStep = {}; // key = `${turn}:${step}`
  const out = [];

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，下轮重扫补齐
    }

    const t = item.type;
    const d = item.data || {};
    const turn = d.turn;
    const step = d.step;
    if (turn === undefined || step === undefined) continue;
    const key = `${turn}:${step}`;

    if (t === "request/header") {
      const model = d.header?.config?.model;
      if (model) byStep[key] = byStep[key] || {};
      byStep[key].model = model;
      byStep[key].reqTime = item.time;
    } else if (t === "assistant/message") {
      const u = d.message?.usage;
      if (!u || typeof u.total_tokens !== "number" || u.total_tokens <= 0) continue;
      byStep[key] = byStep[key] || {};
      byStep[key].usage = u;
      byStep[key].msgTime = item.time;
    }
  }

  for (const key of Object.keys(byStep)) {
    const b = byStep[key];
    if (!b.usage) continue; // 无 usage 的 step 跳过（理论不出现，实测 43/43 有）
    const startedMs = b.reqTime ?? b.msgTime ?? 0;
    if (startedMs <= since) continue;

    const completedMs = b.msgTime;
    const durationMs = completedMs !== undefined && completedMs > startedMs ? completedMs - startedMs : undefined;
    const [turn, step] = key.split(":");

    out.push({
      id: `${deviceId}:${ID}:${sessionId}:${key}`,
      deviceId,
      deviceName,
      source: ID,
      providerId: "商汤",
      modelId: normalizeModel(b.model || "unknown"),
      variant: step,
      sessionId,
      inputTokens: b.usage.prompt_tokens ?? 0,
      outputTokens: b.usage.completion_tokens ?? 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      startedAt: startedMs,
      completedAt: completedMs,
      durationMs,
      status: "success",
    });
  }

  return out;
}

/** 增量抽取：遍历 sessions 下各 session.jsonl，mtime 预筛 + 事件时间过滤 */
function extract(dir, deviceId, deviceName, since) {
  const root = sessionsDir(dir);
  if (!fs.existsSync(root)) {
    throw new Error(`未找到小浣熊会话目录：${root}`);
  }

  const out = [];
  const RESCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "session.jsonl");
    if (!fs.existsSync(file)) continue;

    // 文件级快速过滤：mtime 早于重扫窗口起点则跳过，避免每次全量解析
    if (since > 0) {
      try {
        if (fs.statSync(file).mtimeMs <= since - RESCAN_WINDOW_MS) continue;
      } catch {
        /* stat 失败按原逻辑解析 */
      }
    }

    out.push(...parseSessionFile(file, deviceId, deviceName, since));
  }

  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
