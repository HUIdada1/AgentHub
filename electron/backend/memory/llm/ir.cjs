/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 统一消息模型（IR）与流式事件归一。
// 上层任务只认 IR：{ system, messages, maxTokens, temperature, reasoning{effort,budget}, stream, model }
// 三种上游格式各自 encode/decode（见同目录 anthropic/chatcompletions/responses）。
// 说明：与 proxy 模块的协议实现「同源不同文件」——本轮不抽取共享层，以免改动现有 proxy 逻辑
// （可剥离优先）；记忆侧的格式层只服务本模块调用，不参与网关转发路径。
"use strict";

const EFFORT_BUDGET = { minimal: 512, low: 1024, medium: 4096, high: 16384 };

/** 把 effort 归一到协议可表达的预算（custom 用显式预算） */
function budgetFor(effort, customBudget) {
  if (effort === "custom") return Number(customBudget) > 0 ? Number(customBudget) : EFFORT_BUDGET.medium;
  return EFFORT_BUDGET[effort] || null;
}

/** 统一 IR：把任务侧的简单入参转成结构化请求 */
function makeRequest({ system, messages, model, maxTokens, temperature, effort, reasoningEnabled, customBudget, stream, jsonMode }) {
  const effortValue = reasoningEnabled === false ? "off" : effort || "off";
  return {
    system: system || "",
    messages: (messages || []).map((m) => ({ role: m.role, content: String(m.content == null ? "" : m.content) })),
    model,
    maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : 2048,
    temperature: typeof temperature === "number" ? temperature : 0.2,
    reasoning: {
      enabled: effortValue !== "off",
      effort: effortValue,
      customBudget: Number(customBudget) > 0 ? Number(customBudget) : null,
      budget: budgetFor(effortValue, customBudget),
    },
    stream: !!stream,
    jsonMode: !!jsonMode,
  };
}

/** 从上游响应体抽出统一结果 { text, reasoning, usage, finishReason, raw } */
function normalizeResult(decoded) {
  return {
    text: decoded.text || "",
    reasoning: decoded.reasoning || "",
    usage: { input: decoded.usage?.input || 0, output: decoded.usage?.output || 0 },
    finishReason: decoded.finishReason || "stop",
    raw: decoded.raw,
  };
}

/** 从 400/404 等错误体判断该上游不认哪个参数（兼容性自动修正的依据） */
function detectUnsupportedParam(status, bodyText) {
  if (status !== 400 && status !== 422) return null;
  const text = String(bodyText || "").toLowerCase();
  const candidates = ["reasoning_effort", "reasoning", "thinking", "max_tokens", "max_completion_tokens", "temperature", "response_format", "stream_options", "system"];
  for (const c of candidates) {
    if (text.includes(c) && (text.includes("unknown") || text.includes("unsupported") || text.includes("not support") || text.includes("invalid") || text.includes("unexpected"))) {
      return c;
    }
  }
  return null;
}

/** 该端点看起来像哪种协议（L3 测试用：拿 404/400 反推正确格式） */
function guessFormatFromFailure(status, bodyText) {
  const text = String(bodyText || "").toLowerCase();
  if (status === 404) return { guess: "anthropic_messages", reason: "路径不存在（许多中转载体的 Claude 上游只提供 /v1/messages）" };
  if (status === 400 && (text.includes("messages") || text.includes("anthropic"))) {
    return { guess: "anthropic_messages", reason: "上游抱怨 messages/system 字段，疑似 Anthropic Messages 格式" };
  }
  if (status === 400 && (text.includes("input") || text.includes("instructions"))) {
    return { guess: "responses", reason: "上游抱怨 input/instructions 字段，疑似 Responses 格式" };
  }
  return null;
}

module.exports = { EFFORT_BUDGET, budgetFor, makeRequest, normalizeResult, detectUnsupportedParam, guessFormatFromFailure };
