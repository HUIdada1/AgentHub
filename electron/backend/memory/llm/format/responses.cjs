/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · Responses 格式：POST {baseUrl}/responses（OpenAI 新接口）。
// 字段差异：顶层 instructions、input、max_output_tokens、reasoning.effort。
"use strict";

const PATH = "/responses";

function headers(provider, apiKey) {
  const out = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey || ""}`,
    ...(provider.headers || {}),
  };
  delete out["x-api-key"];
  return out;
}

function buildUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/responses$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base + PATH;
  return base + "/v1" + PATH;
}

function encode(req, provider) {
  const quirks = provider.quirks || {};
  const input = req.messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: [{ type: "input_text", text: m.content }],
  }));
  const body = { model: req.model, input, max_output_tokens: req.maxTokens };
  if (req.system && quirks.supportsSystemRole !== false) body.instructions = req.system;
  if (typeof req.temperature === "number" && quirks.dropUnsupportedParams !== true && quirks.dropTemperature !== true) body.temperature = req.temperature;
  if (req.reasoning.enabled && quirks.supportsReasoningEffort !== false) {
    body.reasoning = { effort: req.reasoning.effort === "custom" ? "high" : req.reasoning.effort };
  }
  if (req.stream) body.stream = true;
  return body;
}

function decode(responseBody) {
  const data = responseBody || {};
  const text =
    typeof data.output_text === "string" && data.output_text
      ? data.output_text
      : (data.output || [])
          .flatMap((o) => o.content || [])
          .filter((c) => c.type === "output_text" || c.type === "text")
          .map((c) => c.text || "")
          .join("");
  return {
    text,
    reasoning: data.reasoning?.summary || "",
    usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
    finishReason: data.status || "completed",
    raw: data,
  };
}

module.exports = { id: "responses", label: "Responses", PATH, buildUrl, headers, encode, decode };
