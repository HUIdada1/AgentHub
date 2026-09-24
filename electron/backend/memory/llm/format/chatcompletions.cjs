/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · Chat Completions 格式：POST {baseUrl}/chat/completions（OpenAI 系与绝大多数兼容端点）。
"use strict";

const PATH = "/chat/completions";

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
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base + PATH;
  return base + "/v1" + PATH;
}

function encode(req, provider) {
  const quirks = provider.quirks || {};
  const maxField = quirks.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  const messages = [];
  if (req.system && quirks.supportsSystemRole !== false) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body = { model: req.model, messages };
  body[maxField] = req.maxTokens;
  if (typeof req.temperature === "number" && quirks.dropUnsupportedParams !== true && quirks.dropTemperature !== true) body.temperature = req.temperature;
  if (req.reasoning.enabled && quirks.supportsReasoningEffort !== false) {
    body.reasoning_effort = req.reasoning.effort === "custom" ? "high" : req.reasoning.effort;
  }
  if (req.jsonMode && quirks.supportsJsonMode !== false) body.response_format = { type: "json_object" };
  if (req.stream) {
    body.stream = true;
    if (quirks.streamUsage !== false) body.stream_options = { include_usage: true };
  }
  return body;
}

function decode(responseBody) {
  const data = responseBody || {};
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    text: typeof msg.content === "string" ? msg.content : (msg.content || []).map((c) => c.text || "").join(""),
    reasoning: msg.reasoning_content || msg.reasoning || "",
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
    finishReason: choice.finish_reason || "stop",
    raw: data,
  };
}

module.exports = { id: "chat_completions", label: "Chat Completions", PATH, buildUrl, headers, encode, decode };
