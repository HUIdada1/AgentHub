/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · Anthropic Messages 格式：POST {baseUrl}/v1/messages。
// 特征：顶层 system、messages 只有 user/assistant、max_tokens 必填、认证头 x-api-key + anthropic-version。
"use strict";

const { budgetFor } = require("../ir.cjs");

const PATH = "/v1/messages";
const DEFAULT_VERSION = "2023-06-01";

function headers(provider, apiKey) {
  const out = {
    "Content-Type": "application/json",
    "x-api-key": apiKey || "",
    "anthropic-version": (provider.headers && provider.headers["anthropic-version"]) || DEFAULT_VERSION,
    ...(provider.headers || {}),
  };
  delete out.Authorization;
  return out;
}

function buildUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/messages$/.test(base)) return base;
  // client.addPathHint 会把 anthropic 的 base 补成 /v1 结尾：只缺方法名，补全即可。
  // 原先无条件拼 /v1/messages → 恒为 /v1/v1/messages，该格式 100% 不可用
  if (/\/v1$/.test(base)) return base + "/messages";
  return base + PATH;
}

function encode(req, provider) {
  const quirks = provider.quirks || {};
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: m.content }] })),
  };
  if (req.system) {
    if (quirks.supportsSystemRole === false) {
      // 上游不认顶层 system：合并进第一条 user 消息
      const first = body.messages[0];
      if (first) first.content[0].text = `${req.system}\n\n${first.content[0].text}`;
      else body.messages.unshift({ role: "user", content: [{ type: "text", text: req.system }] });
    } else {
      body.system = req.system;
    }
  }
  if (typeof req.temperature === "number" && quirks.dropUnsupportedParams !== true && quirks.dropTemperature !== true) body.temperature = req.temperature;
  if (req.reasoning.enabled && quirks.supportsThinking !== false) {
    const budget = req.reasoning.customBudget || budgetFor(req.reasoning.effort, null) || 4096;
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  if (req.stream) body.stream = true;
  return body;
}

function decode(responseBody) {
  const data = responseBody || {};
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const reasoning = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join("");
  return {
    text,
    reasoning,
    usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
    finishReason: data.stop_reason || "stop",
    raw: data,
  };
}

module.exports = { id: "anthropic_messages", label: "Anthropic Messages", PATH, buildUrl, headers, encode, decode };
