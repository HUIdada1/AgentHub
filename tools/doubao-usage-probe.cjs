// 豆包工作用量探针（只读）
// 用途：验证本机豆包工作数据能解析到哪些用量字段，输出 JSON 供方案评估。
// 边界：不读取 Cookie / 登录态，不联网，不修改豆包任何文件；token 为启发式估算，不是官方计费值。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function defaultDataDir() {
  if (process.env.DOUBAO_DATA_DIR) return path.resolve(process.env.DOUBAO_DATA_DIR);
  const local = process.env.LOCALAPPDATA || process.env.HOME || ".";
  return path.join(local, "Doubao", "User Data", "Default");
}

function estimateTokens(value) {
  if (typeof value !== "string" || !value) return 0;
  let cjk = 0;
  for (const ch of value) if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
  return cjk + Math.ceil((value.length - cjk) / 4);
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function walkTrajectories(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === "trajectory.jsonl") {
        out.push(full);
      }
    }
  }
  return out;
}

function sessionMeta(file) {
  const sessionsRoot = file.split(path.sep + ".sessions" + path.sep)[1] || "";
  const parts = sessionsRoot.split(path.sep);
  return { sessionId: parts[0] || "unknown", agentId: parts[2] || "unknown" };
}

function parseTrajectory(file, deviceId, deviceName) {
  const { sessionId, agentId } = sessionMeta(file);
  const stat = fs.statSync(file);
  const startedAt = Math.floor(stat.mtimeMs);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let context = 2000; // 系统提示词 + 工具清单的粗略基线，仅用于数量级估算
  let index = 0;
  const records = [];
  let toolCalls = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const role = String(item.role || "");
    const content = stringifyContent(item.content);
    if (role === "assistant") {
      index++;
      records.push({
        id: `${deviceId}:doubao:${sessionId}:${agentId}:${index}`,
        deviceId,
        deviceName,
        source: "doubao",
        providerId: "doubao",
        modelId: "doubao-work/unknown",
        sessionId,
        agentId,
        inputTokens: context,
        outputTokens: estimateTokens(content),
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        startedAt,
        completedAt: startedAt,
        status: "success",
        estimated: true,
      });
      const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      toolCalls += calls.length;
      context += estimateTokens(content) + estimateTokens(JSON.stringify(calls));
    } else {
      context += estimateTokens(content);
    }
  }
  return { sessionId, agentId, file, records, toolCalls, messageLines: lines.filter((l) => l.trim()).length };
}

function main() {
  const args = process.argv.slice(2);
  const dataDir = defaultDataDir();
  const sessionsDir = path.join(dataDir, ".doubao", "agent_mode", "workspace", ".sessions");
  const deviceId = `local-${crypto.createHash("sha1").update(process.env.COMPUTERNAME || "doubao").digest("hex").slice(0, 8)}`;
  const deviceName = process.env.COMPUTERNAME || "本机";

  if (!fs.existsSync(sessionsDir)) {
    const result = { ok: false, dataDir, error: "未找到豆包 Agent 会话目录", sessionsDir, capabilities: {} };
    emit(result, args);
    return;
  }

  const files = walkTrajectories(sessionsDir);
  const parsed = files.map((file) => parseTrajectory(file, deviceId, deviceName));
  const records = parsed.flatMap((p) => p.records);
  const totals = records.reduce(
    (acc, r) => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0 },
  );

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataDir,
    sessionsDir,
    device: { deviceId, deviceName },
    capabilities: {
      requestCount: "exact",
      toolCalls: "exact",
      sessionCount: "exact",
      inputTokens: "estimated",
      outputTokens: "estimated",
      perCallTimestamp: "unavailable",
      cacheReadTokens: "unavailable",
      cacheCreationTokens: "unavailable",
      credits: "unavailable-local",
      modelId: "unavailable",
      billingGrade: false,
    },
    summary: {
      sessions: parsed.length,
      llmCalls: records.length,
      toolCalls: parsed.reduce((n, p) => n + p.toolCalls, 0),
      estInputTokens: totals.inputTokens,
      estOutputTokens: totals.outputTokens,
      estTotalTokens: totals.inputTokens + totals.outputTokens,
    },
    sessions: parsed.map((p) => ({
      sessionId: p.sessionId,
      agentId: p.agentId,
      file: p.file.replace(dataDir, "<dataDir>"),
      messageLines: p.messageLines,
      llmCalls: p.records.length,
      toolCalls: p.toolCalls,
      estInputTokens: p.records.reduce((n, r) => n + r.inputTokens, 0),
      estOutputTokens: p.records.reduce((n, r) => n + r.outputTokens, 0),
      startedAt: p.records[0] ? p.records[0].startedAt : null,
    })),
  };
  emit(result, args);
}

function emit(result, args) {
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0 && args[outIndex + 1]) {
    fs.writeFileSync(path.resolve(args[outIndex + 1]), JSON.stringify(result, null, 2), "utf8");
  }
  if (!args.includes("--json")) {
    if (!result.ok) {
      console.log(result.error, result.sessionsDir);
      return;
    }
    const s = result.summary;
    console.log("豆包工作本地用量探针（估算值，非官方账单）");
    console.log(`数据目录：${result.dataDir}`);
    console.log(`会话 ${s.sessions} 个 / 模型调用 ${s.llmCalls} 次 / 工具调用 ${s.toolCalls} 次`);
    console.log(`估算输入 ${s.estInputTokens} tokens，输出 ${s.estOutputTokens} tokens，合计 ${s.estTotalTokens}`);
    console.log("不可得：缓存命中 tokens、额度点数、逐次时间戳、真实模型名");
  }
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
}

main();
