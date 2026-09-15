// Grok 数据源适配器
// 权威数据源：~/.grok/sessions/<urlencoded-cwd>/<sessionId>/usage.json（Grok CLI 逐会话用量账本，
//   会话进行中随 updatedAt 持续落盘，与 Code X / codexhost 是否在运行无关）
// 口径（2026-09-14 本机实测）：
//   - 按 (turn × modelUsage 模型) 粒度入库：同一轮 fork 多个模型（如会话中途切 grok-4.6）
//     各自独立成条，五桶互不混计；turn.modelUsage 缺失时回退轮级五桶 + primaryModelId；
//   - 模型名走全项目统一规范化（normalizeModel），provider 恒为 xAI（usage.json 不含供应商字段）；
//   - 时间戳用 turn.endedAt（ISO，毫秒精度）：账本无逐次开始时间，startedAt 即 endedAt；
//   - 五桶全 0 的轮次不采集（无实际消耗）；turns 缺失/损坏的账本跳过该会话不阻断其余源；
//   - 仅写入 usage.json 的会话才有账本（Grok 托盘级会话/被中断会话不落账本，与官方记账一致）。
// 设备标识：~/.grok/agent_id；缺失返回 null（上层回退链兜底）。
// 幂等键：设备:grok:sessionId:turnNumber:normalizeModel(model)——同一账本重写时同 id 覆盖更新。
// 增量：endedAt 毫秒锚点统一 since 过滤；账本文件 mtime 早于回扫窗口起点时整文件跳过。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel } = require("./adapter-zcode.cjs");

const ID = "grok";
const NAME = "Grok";
const PROVIDER = "xAI";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function defaultDir() {
  return path.join(homeDir(), ".grok");
}

/** 自测注入环境变量覆盖（临时目录隔离，不触碰真实 ~/.grok） */
function resolveRoot() {
  const env = String(process.env.GROK_HOME || "").trim();
  return env ? path.resolve(env) : defaultDir();
}

function sessionsDir(dir) {
  return path.join(dir, "sessions");
}

/** 数据根存在即探测成功（与其他源 detect 返回「数据根」一致） */
function detect() {
  const dir = resolveRoot();
  return fs.existsSync(dir) ? dir : null;
}

/** 校验：sessions 目录存在 */
function validate(dir) {
  try {
    return !!dir && fs.statSync(sessionsDir(dir)).isDirectory();
  } catch {
    return false;
  }
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, "agent_id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 递归收集 sessions 下全部 usage.json（Grok 目录结构固定两级：项目目录 → 会话目录） */
function findUsageFiles(dir) {
  const out = [];
  const pending = [sessionsDir(dir)];
  while (pending.length) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name === "usage.json") out.push(full);
    }
  }
  return out;
}

/** 非负有限数字，非法返回 0（与 opensquilla 同款兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** ISO 时间串 → 毫秒；非法返回 null */
function isoMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 一轮 turn 的某模型用量 → 事件记录；五桶全 0 或时间戳非法返回 null。
 */
function mapEntry(ctx, sessionId, turn, modelId, usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const reasoning = num(usage.reasoningTokens);
  const cacheRead = num(usage.cachedReadTokens);
  const cacheWrite = num(usage.cacheCreationTokens);
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return null;

  const endedAt = isoMs(turn.endedAt);
  if (endedAt === null || endedAt <= 0) return null;
  const model = modelId ? normalizeModel(modelId) : "unknown";

  return {
    id: `${ctx.deviceId}:grok:${sessionId}:${turn.turnNumber}:${model}`,
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    source: ID,
    providerId: PROVIDER,
    modelId: model,
    sessionId,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    startedAt: endedAt,
    status: "success",
  };
}

/**
 * 增量抽取：遍历 usage.json，按 turn × model 出事件，endedAt > since 才入库。
 * since 为毫秒（统一锚点口径），endedAt 亦为毫秒。
 * 单账本损坏（JSON 解析失败/turns 缺失）静默跳过，不影响其余会话。
 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 ${NAME} 会话目录：${sessionsDir(dir)}`);
  const ctx = { deviceId, deviceName };
  const out = [];

  for (const file of findUsageFiles(dir)) {
    // 账本 append-only（每轮结束追加写入）：mtime 早于 since 的文件不可能含 endedAt > since 的轮次，
    // 直接跳过避免每次同步全量读盘解析（与 codex rollout 同款优化）
    if (since > 0) {
      try {
        if (fs.statSync(file).mtimeMs <= since) continue;
      } catch {
        /* stat 失败按原逻辑全量解析 */
      }
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // 账本写入中断产生的半截 JSON：跳过，下次同步补采
    }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.turns)) continue;
    const sessionId = typeof doc.sessionId === "string" && doc.sessionId
      ? doc.sessionId
      : path.basename(path.dirname(file));

    for (const turn of doc.turns) {
      if (!turn || typeof turn !== "object") continue;
      const entries = (turn.modelUsage && typeof turn.modelUsage === "object")
        ? Object.entries(turn.modelUsage)
        : [[turn.primaryModelId || "unknown", turn]];
      for (const [modelId, usage] of entries) {
        const rec = mapEntry(ctx, sessionId, turn, modelId, usage);
        // endedAt <= since 的轮次不重复入库（与 Trae 同款二次防御）
        if (rec && rec.startedAt > since) out.push(rec);
      }
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, _internal: { mapEntry, num, isoMs } };