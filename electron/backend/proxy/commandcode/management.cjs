/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Account management only. No model invocation or conversation entry points.
//
// Command Code（api.commandcode.ai）：**无状态转发 + 粘贴式 API Key**。
// 依据 Agent2Providers `crates/providers/src/providers/commandcode/`（endpoints.rs /
// credentials.rs / models.rs / mod.rs 模块头）。
//
// ── 本家没有的东西（如实声明，别照抄别家）────────────────────────
//   · **没有续期**：单个静态 `user_` key，上游没有 refresh 接口；
//   · **没有 OAuth / 设备码**：粘贴式凭证，登录页只能自取 key；
//   · **不查余额**：`/alpha/billing/credits` 只用于 key 探活（capabilities.usage=false）；
//   · **没有签到**：没有可自动领的奖励活动。
//   · 单一域名，**没有国内 / 国际两套**，故只有一个渠道 id。
"use strict";
const path = require("node:path");
const fs = require("node:fs");

/** 默认基址（endpoints.rs DEFAULT_BASE_URL） */
const BASE_URL = "https://api.commandcode.ai";
/** 本实现实际对齐的 wire 协议版本（endpoints.rs PROTOCOL_VERSION，对齐 command-code@1.53.1） */
const PROTOCOL_VERSION = "1.53.1";
/** 官方 CLI 的 User-Agent 常量（一个字都不能改） */
const CLI_USER_AGENT = "cli";
/** CLI 环境标识默认值 */
const CLI_ENVIRONMENT = "production";
/** key 前缀（上游唯一硬性形态） */
const KEY_PREFIX = "user_";

/** 内置兜底清单（models.rs FALLBACK_MODELS，26 项；id 是转发时直接下发的名字，逐字保留） */
const FALLBACK_MODELS = [
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.4-mini", "GPT-5.4 Mini"],
  ["gpt-5.3-codex", "GPT-5.3 Codex"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6"],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5"],
  ["zai-org/GLM-5.1", "GLM 5.1"],
  ["zai-org/GLM-5", "GLM 5"],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3"],
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7"],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5"],
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview"],
  ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus"],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max"],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash"],
  ["stepfun/Step-3.5-Flash", "Step 3.5 Flash"],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro"],
  ["xiaomi/mimo-v2.5", "MiMo V2.5"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
];

/** 形态检查：以 `user_` 开头、其后至少一个合法字符、整串都在字符集内（credentials.rs） */
function shapeOk(key) {
  const text = String(key || "").trim();
  if (!text.startsWith(KEY_PREFIX)) return false;
  const rest = text.slice(KEY_PREFIX.length);
  return rest.length > 0 && /^[A-Za-z0-9_-]+$/.test(rest);
}

/** 展示用脱敏形态（只露前缀与尾 4 位） */
function masked(key) {
  const text = String(key || "").trim();
  if (text.length <= 12) return `${KEY_PREFIX}…`;
  return `${KEY_PREFIX}…${text.slice(-4)}`;
}

/**
 * 工厂：deps = { httpJson, rules, util, store }
 */
function makeCommandCode(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).commandcode || {};
  const base = () => String(cfg().baseUrl || BASE_URL).replace(/\/+$/, "");
  const version = () => String(cfg().protocolVersion || PROTOCOL_VERSION);
  const cliEnv = () => String(cfg().cliEnvironment || CLI_ENVIRONMENT);

  /** CLI 客户端头（生成 / 指纹 / 生命周期 / 目录四处共用同一张表，endpoints.rs cli_headers） */
  function cliHeaders(token) {
    return {
      "User-Agent": CLI_USER_AGENT,
      "x-command-code-version": version(),
      "x-cli-environment": cliEnv(),
      ...(token ? { Authorization: `Bearer ${String(token).trim()}` } : {}),
    };
  }

  return {
    id: "commandcode",
    cfg,
    /** 目录索引：catalog.json 的 commandcode 段（fetchModels 写入）；为空时用内置 26 项 */
    models() {
      const cat = (rules.get("catalog.json") || {}).commandcode || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      if (rows.length) return rows.map((m) => String(m.id)).filter(Boolean);
      return FALLBACK_MODELS.map(([id]) => id);
    },
    /** 拉取目录：GET /provider/v1/models（需 Bearer；失败回落内置清单，绝不写空目录） */
    async fetchModels(account, secrets) {
      const token = String((secrets && secrets.token) || "").trim();
      if (!token) return { ok: false, message: "缺少 API Key" };
      const r = await httpJson(`${base()}/provider/v1/models`, {
        method: "GET", headers: { ...cliHeaders(token), Accept: "application/json" },
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "API Key 无效或已被吊销" };
      if (!r.ok || !r.data) {
        // 上游抖动不清空目录：回落内置清单（与 models.rs「失败时回落到内置清单」同口径）
        return { ok: true, models: FALLBACK_MODELS.map(([id, name]) => ({ id, name })), message: `目录接口 HTTP ${r.status || 0}，已使用内置清单` };
      }
      const rows = Array.isArray(r.data.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && typeof row.id === "string" ? row.id.trim() : "";
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        // 上游目录不返回结构化能力位：工具与思考是一等字段 → true；
        // 图片位没有目录依据，保守 false（报错方向只能选「少报」）
        out.push({ id, name: String(row.name || id), rate: null, capabilities: { tools: true, reasoning: true, images: false }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!out.length) return { ok: true, models: FALLBACK_MODELS.map(([id, name]) => ({ id, name })), message: "目录为空，已使用内置清单" };
      return { ok: true, models: out };
    },
    /** 不查余额：/alpha/billing/* 只在添加账号时探活（capabilities.usage=false） */
    async queryCredits() {
      return { unavailable: true, message: "Command Code 不提供余额接口（billing 端点仅用于 API Key 探活）" };
    },
    /** 没有可自动领的奖励活动 */
    async checkinStatus() {
      return { unavailable: true, message: "Command Code 没有签到 / 领取活动" };
    },
    async checkin() {
      return { ok: false, unavailable: true, message: "Command Code 没有签到 / 领取活动" };
    },
    async trial() {
      return { ok: false, message: "Command Code 无加油包领取动作" };
    },
    /** 静态 API Key，上游没有 refresh 接口 */
    async refreshToken() {
      return { ok: false, noRefresh: true, terminal: false, message: "Command Code 使用静态 API Key，无续期接口；失效请重新粘贴" };
    },
    /** key 探活（best-effort）：只有拿到 401/403 才判无效；网络失败/5xx 一律放行 */
    async verifyKey(token) {
      const key = String(token || "").trim();
      if (!shapeOk(key)) return { ok: false, message: "API Key 形态不正确（需 user_ 开头，其后为字母/数字/下划线/连字符）" };
      const r = await httpJson(`${base()}/alpha/billing/credits`, {
        method: "GET", headers: { ...cliHeaders(key), Accept: "application/json" },
      }).catch(() => null);
      if (r && (r.status === 401 || r.status === 403)) return { ok: false, message: "API Key 无效或已被吊销（上游 401/403）" };
      return { ok: true, verified: !!(r && r.ok) };
    },
    /** 账号展示名（脱敏 key，不落明文） */
    mask: masked,
    shapeOk,
  };
}

module.exports = { makeCommandCode, FALLBACK_MODELS, shapeOk, masked, BASE_URL, PROTOCOL_VERSION, CLI_USER_AGENT };
