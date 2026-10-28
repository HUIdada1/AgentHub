/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 外置规则热加载（第②层）
// rules/*.json 首次启动从内置默认值拷贝，用户可直接改文件；chokidar 监听变更即重载内存态，无需重启
// 坏 JSON 回退上次快照并在面板警示（status 里带 error）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.cjs");

// ===== 内置默认规则（上游变更时用户改文件即生效，无需发版） =====
const DEFAULTS = {
  // Trae 模型显示名 → [config_name, model_name]（必填注入字段）
  "model_map.json": {
    "deepseek-v4-flash": ["DeepSeek-V4-Flash", "deepseek_v4_flash__dev"],
    "deepseek-v4": ["DeepSeek-V4", "deepseek_v4__dev"],
    "glm-4.6": ["GLM-4.6", "glm_4_6__dev"],
    "kimi-k2": ["Kimi-K2", "kimi_k2__dev"],
    "doubao-seed-1.6": ["Doubao-Seed-1.6", "doubao_seed_1_6__dev"],
    "qwen3-coder": ["Qwen3-Coder", "qwen3_coder__dev"],
    "minimax-m2": ["MiniMax-M2", "minimax_m2__dev"],
  },
  // WorkBuddy 双区模型目录（倍率/能力后续可由官方目录接口刷新覆盖）
  "wb_models.json": {
    workbuddy: ["claude-sonnet-4.5", "claude-opus-4.1", "gpt-5", "gpt-5-codex", "hy3-preview", "deepseek-v3.2"],
    workbuddy_ai: ["default-model", "fast-model", "deepseek-v4.1-flash", "kimi-k2.8-preview", "glm-5.3", "glm-5.2"],
  },
  // 拉取到的权威模型目录（含倍率/能力/上下文元数据）：各渠道「拉取模型」写回此文件，可手编热生效。
  // 内置默认 = Trae 静态兜底清单（逆向实证 32 个 config_name）+ WB 双区基础目录，
  // 保证从未拉取过时模型目录开箱即用；拉取成功后整段覆盖对应渠道
  "catalog.json": {
    trae: {
      syncedAt: 0,
      // Trae 真实官方目录（2026-09 实证拉取 get_detail_param，39 个 config_name）
      models: [
        "Doubao-Seed-Evolving", "Doubao-Seed-2.1-Pro", "seed-code-pro-0430", "Doubao-Seed-2.1-Turbo",
        "computer_use_subagent", "Doubao-Seed-2.0-Code", "browser_use_subagent",
        "glm-5.3", "glm-5.2", "glm-5-turbo", "glm-5",
        "DeepSeek-V4-Flash-Official", "DeepSeek-V4-Flash", "DeepSeek-V4-Pro-Official", "DeepSeek-V4-Pro",
        "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "minimax-m3",
        "qwen3.8-max", "qwen-3.7-plus", "sagitta", "aquila",
        "custom_model_gemini", "custom_model_placeholder", "custom_model_1M_text", "custom_model_1M",
        "custom_model_doubao_1M", "custom_model_doubao_256k", "custom_model_kimi", "custom_model_claude",
        "custom_model_gpt-5", "custom_model_no-fc", "custom_model_deepseek_chat", "custom_model_deepseek_reasoner",
        "custom_model_deepseek_v4", "file_search_agent", "explore_sub_agent_v2", "summary",
      // 上限未知时写 0：目录刷新会用官方条目里的 context_window_tokens / max_tokens 覆盖。
      // 原先写死 contextLength: 131072 会让下游客户端把 30 万 token 的正常回答误判为上下文溢出
      ].map((id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 })),
    },
    workbuddy: {
      syncedAt: 0,
      models: ["claude-sonnet-4.5", "claude-opus-4.1", "gpt-5", "gpt-5-codex", "hy3-preview", "deepseek-v3.2"]
        .map((id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 })),
    },
    workbuddy_ai: {
      syncedAt: 0,
      // AI 区真实官方目录（2026-09 实证拉取）：gpt-5/gemini-2.5-pro 已不在列，防止内置默认带死模型
      models: [
        "default-model", "fast-model", "balanced-model", "primary-model", "deep-model", "kimi-k2.8-preview",
        "deepseek-v4.1-flash", "deepseek-v4.1-flash-sg", "gpt-6-astra", "hy4-preview-f", "hy4-preview", "hy3",
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gemini-3.5-flash", "glm-5.3", "glm-5.2",
      ].map((id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 })),
    },
    // 商汤小浣熊：默认模型静态兜底（保证开箱即用；拉取 /model_catalog 后整段覆盖对应渠道）
    raccoon: {
      syncedAt: 0,
      models: ["raccoon-chat-ml-5-5"].map((id) => ({
        id,
        name: id,
        rate: null,
        capabilities: { images: false, reasoning: true, tools: true },
        contextLength: 180000,
        maxOutputTokens: 80000,
      })),
    },
    // ModelScope（魔搭 · 阿里）：静态兜底 = 实测 GET /v1/models 的 35 个模型
    // （2026-10-06 拉取，需 Bearer）。⚠ 清单按社区热度精选，**不是全集**：
    //   GLM-5.3-Flash 不在清单内但直调 200（已实测）——故清单仅供开箱展示，
    //   可用性以直调为准。contextLength 取同模型在其它渠道的跨渠道声明值
    //   （DeepSeek-V4.1-Flash/GLM-5.2 等均为 1M）；上游未声明输出上限者记 0（不编造）。
    modelscope: {
      syncedAt: 0,
      models: [
        // —— 对话主力（实测可用，含 tier 计费分档）——
        { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek-V4-Flash-0731", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-ai/DeepSeek-V4-Pro-0813", name: "DeepSeek-V4-Pro-0813", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        // 不在 /v1/models 清单但直调 200（2026-10-06 实测，模型名与其它渠道同名模型一致）
        { id: "ZhipuAI/GLM-5.3-Flash", name: "GLM-5.3-Flash", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "ZhipuAI/GLM-5.2", name: "GLM-5.2", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "ZhipuAI/GLM-4.7-Flash", name: "GLM-4.7-Flash", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Qwen/Qwen3.8-Flash-Next", name: "Qwen3.8-Flash-Next", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        // —— 其余清单内模型（开箱可选）——
        { id: "Qwen/Qwen3.8-27B", name: "Qwen3.8-27B", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5-397B-A17B", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Qwen/Qwen3.5-122B-A10B", name: "Qwen3.5-122B-A10B", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Qwen/Qwen3.5-35B-A3B", name: "Qwen3.5-35B-A3B", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Qwen/Qwen3.5-27B", name: "Qwen3.5-27B", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "MiniMax/MiniMax-M3", name: "MiniMax-M3", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "MiniMax/MiniMax-M1-80k", name: "MiniMax-M1-80k", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 80000, maxOutputTokens: 0 },
        { id: "meituan-longcat/LongCat-Flash-Lite", name: "LongCat-Flash-Lite", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "stepfun-ai/Step-3.5-Flash", name: "Step-3.5-Flash", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "stepfun-ai/Step-3.7-Flash", name: "Step-3.7-Flash", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Shanghai_AI_Laboratory/Intern-S1", name: "Intern-S1", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "Shanghai_AI_Laboratory/Intern-S2-Preview", name: "Intern-S2-Preview", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "mistralai/Mistral-Large-Instruct-2407", name: "Mistral-Large-Instruct-2407", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "nex-agi/Nex-N2.5-Pro", name: "Nex-N2.5-Pro", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "nex-agi/Nex-N2.5-mini", name: "Nex-N2.5-mini", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
      ],
    },
    // LobsterAI（网易有道龙虾）：静态兜底 = **公开端点** GET /api/models/pricing-catalog
    // 的实测目录（2026-10-05 拉取，HTTP 200 / 37KB，无需鉴权）。这是权威源：
    // 官方开源仓库 docs/server-integration/2026-08-27-more-models.md 明写该端点 public。
    // ⚠ 不要用第三方反代项目里的静态表——那份是 2026-08-06 的旧快照且 context_length
    //   是硬编码占位值（131072），与真实值（多为 1000000）差 8 倍。
    // contextWindow 为 null 的模型：官方客户端回落 OpenClaw 默认 200k，但按本仓库约定
    // 「模型上限类字段绝不给编造的默认值」→ 一律记 0（未知），由拉取结果覆盖。
    lobster: {
      syncedAt: 0,
      models: [
        // —— 限时免费（freeAccess=true）——
        { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", rate: 0.05, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", rate: 0.26, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", rate: 0.05, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp", rate: 0.05, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rate: 0.06, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", rate: 0.15, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "MiniMax-M3", name: "MiniMax-M3", rate: 0.24, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        // —— 其余目录（按倍率升序）——
        { id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax-M3.1-Flash-Preview", rate: 0, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "MiniMax-M2.7", name: "MiniMax-M2.7", rate: 0.24, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "qwen3.5-plus-2026-04-20", name: "Qwen3.5-plus", rate: 0.12, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "qwen3.6-plus", name: "Qwen3.6-Plus", rate: 0.34, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "doubao-seed-2-1-turbo-260628", name: "Doubao-Seed-2.1-Turbo", rate: 0.34, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 256000, maxOutputTokens: 0 },
        { id: "kimi-k2.5", name: "Kimi-K2.5", rate: 0.41, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "qwen3.7-plus", name: "Qwen3.7-Plus", rate: 0.53, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "doubao-seed-2-0-code-preview-260215", name: "Doubao-Seed-2.0-Code", rate: 0.54, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "kimi-k2.6", name: "Kimi-K2.6", rate: 0.64, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "glm-5", name: "GLM-5", rate: 0.64, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "doubao-seed-2-1-pro-260915", name: "Doubao-Seed-2.1-Pro", rate: 0.68, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 256000, maxOutputTokens: 0 },
        { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", rate: 0.73, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 262144, maxOutputTokens: 0 },
        { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code", rate: 0.73, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 262144, maxOutputTokens: 0 },
        { id: "qwen3.8-flash", name: "Qwen3.8-Flash", rate: 0.06, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "qwen3.8-omni-flash", name: "Qwen3.8-Omni-Flash", rate: 0.06, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "qwen3.8-max", name: "Qwen3.8-Max", rate: 0.91, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "glm-5v-turbo", name: "GLM-5V-Turbo", rate: 0.96, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "glm-5.1", name: "GLM-5.1", rate: 1.07, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 0, maxOutputTokens: 0 },
        { id: "glm-5.2", name: "GLM-5.2", rate: 1.08, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "glm-5.3", name: "GLM-5.3", rate: 1.08, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "qwen3.7-max", name: "Qwen3.7-Max", rate: 1.33, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "kimi-k2.7-code-highspeed", name: "Kimi-K2.7-Code-Highspeed", rate: 1.46, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 262144, maxOutputTokens: 0 },
        { id: "kimi-k3", name: "Kimi-K3", rate: 20, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1048576, maxOutputTokens: 0 },
      ],
    },
    // ZCode（智谱 GLM 编码套餐）：pinned 静态兜底（zcode-api 3.11.2 实证目录；
    // billing/balance 的 balances[].capabilities 可在线刷新出真实可用模型）
    zcode: {
      syncedAt: 0,
      models: [
        { id: "GLM-5.3", name: "GLM-5.3", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 128000 },
        // 客户端自带能力表实测：.*glm-5\.3(?:-flash)? 为 false，但其后的 .*glm-5\.3-flash 专用规则为 true
        { id: "GLM-5.3-Flash", name: "GLM-5.3-Flash", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 128000 },
        { id: "GLM-5.2", name: "GLM-5.2", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 128000 },
        { id: "GLM-5.1", name: "GLM-5.1", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 64000 },
        { id: "GLM-5-Turbo", name: "GLM-5-Turbo", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 64000 },
        { id: "GLM-4.7", name: "GLM-4.7", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 131072 },
        { id: "GLM-4.6", name: "GLM-4.6", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 131072 },
        { id: "GLM-4.5-Air", name: "GLM-4.5-Air", rate: null, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 131072, maxOutputTokens: 98304 },
      ],
    },
    // ===== Cline 双池：静态兜底（远程目录拉取后整段覆盖对应渠道）=====
    // 取自实测的 recommended-models 响应（2026-09）的稳定主力模型，**不抄全**：
    // 上游清单会变（模型上下架频繁），抄全只会得到一份很快过时的表，其余靠拉取补齐。
    // ⚠ 模型 id 必须带池前缀（cline-free/ / cline-pass/ 是计费通道选择器，剥掉转发 404
    // model not found）；免费池那两条裸 id（z-ai/、poolside/）**同样是免费池成员**
    // （实测免费账号打返回 200，走聚合通道转售）——归池看响应分组，不按前缀猜。
    // 上下文窗口取 Cline 官方目录实测值；上游未声明输出上限者记 0（不编造）。
    cline_free: {
      syncedAt: 0,
      models: [
        { id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "cline-free/solar-pro4", name: "Solar Pro 4（免费）", rate: null, capabilities: { images: true, reasoning: false, tools: true }, contextLength: 128000, maxOutputTokens: 0 },
        { id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1310720, maxOutputTokens: 0 },
        { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1（免费）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 262144, maxOutputTokens: 0 },
      ],
    },
    cline_pass: {
      syncedAt: 0,
      models: [
        { id: "cline-pass/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 1000000, maxOutputTokens: 0 },
        { id: "cline-pass/deepseek-v4-pro", name: "DeepSeek V4 Pro（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 128000, maxOutputTokens: 0 },
        { id: "cline-pass/glm-5.3", name: "GLM-5.3（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "cline-pass/kimi-k3", name: "Kimi K3（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 256000, maxOutputTokens: 0 },
        { id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max（ClinePass）", rate: null, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 256000, maxOutputTokens: 0 },
      ],
    },
  },
  // Trae function 字段按模型分发（实测：
  // 部分模型仅在 solo_agent 下可用，其余走 solo_work_lite；未命中默认 solo_work_lite）
  "function_map.json": {
    "doubao-seed-code": "solo_agent",
    "glm-5.3-flash": "solo_agent",
    "qwen3.8-flash": "solo_agent",
  },
  // WorkBuddy 审核指纹最小改写表（from→to 逐字替换；键名要够长防误伤）
  // 对齐 sanitizeRewrites：上游按整句精确匹配拦截（400 code 11-128），
  // 只保留整句形态的改写——禁止短键全局替换（会把用户正文/代码里的普通词组一并改掉）
  "wb_template_map.json": {
    "You are Claude Code, Anthropic's official CLI for Claude": "You are CodeBuddy, an AI coding assistant tool for Claude",
    "You are Claude Code, Anthropic's official CLI.": "You are CodeBuddy, an AI coding assistant.",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.": "You are a coding agent running in the CodeBuddy CLI, a terminal-based coding assistant.",
    "Main branch (you will usually use this for PRs)": "Default branch (you will usually use this for PRs)",
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues": "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "11128": "11-128",
  },
  // 各渠道默认头 / UA 伪装 / 上游域配置 / 登录端配置
  "headers.json": {
    trae: {
      // agent 域（对话/模型目录）实证只有一个 mchost.guru（AgentHost）；
      // api.trae.cn 只服务 /trae/api/v2/...（ug/pay），打 /api/agent/... 会吃 TLB 404，
      // 故镜像默认留空（官方镜像域可用时在此填写完整 URL）
      chatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
      mirrorChatUrl: "",
      creditsUrl: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
      exchangeUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
      userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
      // 模型目录拉取（实测：get_detail_param 返回 config_info_list[].config_name + display_name）
      modelsUrl: "https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param",
      mirrorModelsUrl: "",
      userAgent: "TraeClient/TTNet",
      appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      ideVersion: "0.1.50",
      ideVersionCode: "20260811",
      clientId: "en1oxy7wnw8j9n",
      // ===== 登录（OAuth 授权页）专用：与对话头上报的版本号不是一套，别混用 =====
      // 登录主机优先由官方 GetLoginGuidance 下发，下面是下发失败时的兜底域
      loginHost: "https://www.trae.cn",
      loginGuidanceUrls: [
        "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
        "https://www.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
      ],
      // 授权地址里的 x_app_version / ExchangeToken 的 IDEVersion
      authAppVersion: "3.5.66",
      pluginVersion: "local",
      deviceBrand: "CREFG-XX",
      osVersion: "Windows 11 Home China",
      // 授权码换令牌的候选上游（依次尝试）
      accountOrigins: ["https://api.trae.cn", "https://api.trae.com.cn"],
      // 签到（user growth 域）上游
      checkinBase: "https://api.trae.cn",
      // ===== 签到专用（依据 12-trae-codebuddy-autoclaw-签到核对.md §3.2 客户端字节实证）=====
      // 客户端 status 与 claim 的请求体都是 {"req_source":N}：SOLO 包（SOLO_CN / SOLO_I18N /
      // SOLO_CN_ENTERPRISE）= 2，普通 TRAE IDE = 1。本机是 TRAE SOLO CN ⇒ 2。
      // 由 adapters.cjs 的 traeReqSource() 读取（缺省/非法值回落 2）。
      checkinReqSource: 2,
      // 设备头 x-app-version 的取值（客户端取 commonParams.app_version，有值才发）。
      // 本机 TRAEWork CN 实测版本 0.1.69（TRAE SOLO CN.exe 的 ProductVersion，12 §3.1）。
      // 由 adapters.cjs 的 traeDeviceHeaders() 读取；brand/type/os-version 的客户端实际取值
      // 尚未取到（12 §9 U2），其中 deviceBrand/osVersion 沿用本段既有值，deviceType 留空不发。
      appVersion: "0.1.69",
    },
    workbuddy: {
      chatUrl: "https://copilot.tencent.com/v2/chat/completions",
      billingBase: "https://www.codebuddy.cn",
      // chat 出站 Origin/Referer 基域（originRefererFor 实证 CN=codebuddy.cn）
      origin: "https://www.codebuddy.cn",
      // 官方桌面端指纹（逆向实证）：三段式 UA 与 IDE 归属头组，少一项都可能被风控判为网关
      // 版本对齐（12 §2/§5.4）：真实客户端是 E:\WorkBuddy 的 WorkBuddy 桌面端 **5.6.2**
      // （不是 D:\CodeBuddy 的 CodeBuddy IDE 1.100.0——12 §2 的渠道映射纠偏）。
      // 客户端取值口径：X-IDE-Version = process.env.WORKBUDDY_APP_VERSION（= 桌面端版本）。
      clientVersion: "5.6.2",
      // cliVersion 客户端实测值**未取到**（12 §9 U4，需抓包/展开 app.asar 的 resolveBundledCliVersion）
      // ⇒ 保留原值不动，仅标注待核。三段式 UA 的第三段就取它，别按 clientVersion 一起改。
      cliVersion: "2.137.1",
      userAgent: "WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.137.1",
      billingUA: "WorkBuddy/5.6.2",
      ideName: "WorkBuddy",
      modelsUrl: "https://copilot.tencent.com/console/enterprises/personal/models",
      // v3 客户端权威目录（主路，含倍率/能力/上下文元数据）：必须用三段式 CLI UA，否则 400 code 12403
      modelsV3Url: "https://copilot.tencent.com/v3/config",
      catalogUA: "WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.137.1",
      // 登录/账号类插件端点的上游域（与计费域不同，必须单独给）
      pluginBase: "https://copilot.tencent.com",
      // 刷新渠道标识（两处口径不一致："plugin" 与 "workbuddy"，实测后固化）
      refreshSource: "plugin",
      // X-Device-Token 设备风控头兜底值（优先级：账号 deviceToken > 此处 > data 目录 device_token.txt）
      deviceToken: "",
    },
    workbuddy_ai: {
      chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
      // 官方国际客户端现行对话路径（优先），404/405 时回退上方 /v2（实测）
      consoleChatUrl: "https://www.workbuddy.ai/console/chat/completions",
      billingBase: "https://www.workbuddy.ai",
      origin: "https://www.workbuddy.ai",
      // 版本对齐（12 §2/§5.4）：国际版客户端是 E:\WorkBuddyAI 的 **WorkBuddy AI 5.8.4**
      // （app.asar 96,397,661 字节；与 CN 5.6.2 同协议，签到链路关键字全部命中）。
      clientVersion: "5.8.4",
      // cliVersion 国际版实测值同样**未取到**（12 §9 U4）⇒ 保留原值待核。
      cliVersion: "2.137.1",
      // 平台段必须 WorkBuddy AI，送错触发 403 code 11140 request illegal
      userAgent: "WorkBuddy/5.8.4 WorkBuddy AI/5.8.4 CLI/2.137.1",
      billingUA: "WorkBuddy/5.8.4",
      ideName: "WorkBuddy",
      modelsUrl: "https://www.workbuddy.ai/console/enterprises/personal/models",
      modelsV3Url: "https://www.workbuddy.ai/v3/config",
      catalogUA: "WorkBuddy/5.8.4 WorkBuddy AI/5.8.4 CLI/2.137.1",
      pluginBase: "https://www.workbuddy.ai",
      refreshSource: "plugin",
      deviceToken: "",
    },
    // ===== Cline 双池（cline_free / cline_pass 共用同一段）=====
    // 同域同协议同伪装头（api.cline.bot），两池只差「收哪个池的模型」，配置无需拆两份。
    // 协议事实（2026-09 实测 + 复核）：
    // ① LLM 端点是 POST {apiBase}/chat/completions（完整路径 /api/v1/chat/completions，
    //    路径只有一个 v1，发成 /api/v1/v1/... 是 404 Not Found）；
    // ② X-CLIENT-TYPE: cline-sdk 是免费池硬门槛（缺它免费池一律 403
    //    only available via Cline product surfaces；cline-cli 会走另一条兼容路径回 500）；
    // ③ 鉴权 Authorization: Bearer workos:<JWT>，workos: 前缀必须原样带（去掉 401）；
    // ④ 伪装头取自官方 CLI 通信实测（User-Agent 非必需，带上更贴近官方客户端，无代价）。
    cline: {
      apiBase: "https://api.cline.bot/api/v1",
      // 模型目录（GET，无需鉴权实测）：一次返回 recommended/free/clinePass/clineCloud 四组
      modelsPath: "/ai/cline/recommended-models",
      // 登录第四步：WorkOS 令牌 → Cline 会话令牌（不能省，WorkOS 给的是身份令牌）
      registerPath: "/auth/register",
      refreshPath: "/auth/refresh",
      // WorkOS 设备授权端点（RFC 8628）
      workosBase: "https://api.workos.com",
      workosClientId: "client_01K3A541FN8TA3EPPHTD2325AR",
      workosDevicePath: "/user_management/authorize/device",
      workosTokenPath: "/user_management/authenticate",
      // 设备授权页兜底（正常情况用上游返回的 verification_uri）
      deviceVerifyFallback: "https://authkit.cline.bot/device",
      // 伪装头（默认值；逐键可覆盖，空串=该头不发）
      upstreamHeaders: {
        "User-Agent": "Cline/3.0.62",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline",
        "X-IS-MULTIROOT": "false",
        "X-CLIENT-TYPE": "cline-sdk",
        "X-CLIENT-VERSION": "3.0.62",
        "X-PLATFORM": "terminal",
        "X-PLATFORM-VERSION": "3.0.62",
        "X-CORE-VERSION": "0.0.70",
      },
      requestTimeoutMs: 0,
    },
    // ===== 商汤小浣熊（Raccoon AI 桌面端）=====
    // 协议事实见 docs/raccoon-反代/会话1~5（静态逆向）。防伪强度低：无签名/无 HMAC/无 pinning。
    // 鉴权 = JWT Bearer + x-client-* 六头 + 受信设备绑定（纯对话/积分调用不触发绑定，仅移动端连接器链路用）。
    raccoon: {
      // LLM 对话域（纯 OpenAI Chat Completions，SSE；上游疑似 LiteLLM 网关，1:1 透传）
      chatUrl: "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions",
      // 模型目录（渲染层 GET /model_catalog，返回 {default_model, models[]}）
      modelsUrl: "https://xiaohuanxiong.com/api/web/llm/v2/model_catalog",
      defaultModel: "raccoon-chat-ml-5-5",
      // 积分/配额/账号域（渲染层 fetchWithAuth，统一 {code,data} 信封）
      balanceUrl: "https://xiaohuanxiong.com/api/web/points/v1/balance",
      settingUrl: "https://xiaohuanxiong.com/api/web/office/v3/setting_info",
      userInfoUrl: "https://xiaohuanxiong.com/api/web/auth/v1/user_info",
      grantUrl: "https://xiaohuanxiong.com/api/web/desktop/v1/login/points/grant",
      // 首次手机端登录奖励端点（一次性新手福利，与 desktop 端点互不共享额度、各领一次；
      // 身份头报 app-android，同一把 Bearer token——从官方安卓包逆向实测）
      mobileGrantUrl: "https://xiaohuanxiong.com/api/web/mobile/v1/login/points/grant",
      refreshUrl: "https://xiaohuanxiong.com/api/web/auth/v1/refresh",
      // x-client-* 六头取值（box-agent 链路 platform 带架构 `desktop-windows-x64`；
      // 浏览器/受信域 platform 不带架构，见 adapters.cjs raccoonIdentity/raccoonWebHeaders）
      clientName: "raccoon-ai",
      // ⚠ 未改：clientVersion 与 webClientVersion 本应同源（客户端 = "v" + app.getVersion()）。
      // 本次任务只授权改 webClientVersion（12 §9 / 11 §6 只实测到 1.1.3 这一个值），
      // 下面这一行的 1.0.35 是否也该同步为 1.1.3 **待抓包核对**，勿盲改。
      clientVersion: "1.0.35",
      // 版本对齐（依据 11 §6 / 12 §9）：客户端实测 "v" + app.getVersion() = v1.1.3（本机 1.1.3）
      webClientVersion: "v1.1.3",
      clientChannel: "official",
    },
    // ===== LobsterAI（网易有道龙虾）=====
    // 协议事实（2026-10-05 实测 + 交叉验证）：
    // 鉴权 = Bearer JWT（OAuth 授权码换发，回环回调 127.0.0.1/auth/callback）+ 设备 uuid + keyfrom 时间戳。
    // 关键约束：① 对话上游**只接受 stream=true**（非流式实测 500）；
    //          ② 签到活动按 clientVersion 门禁——旧版本号返回 slotState=empty（实测 0.1.0 被隐藏、
    //             2026.9.4+ 可见），故 versionUrl 动态取线上版本，取不到才回落 clientVersion；
    //          ③ 部分业务错误藏在 HTTP 200 的 SSE 流里（event:error 帧），chat 必须窥探首块。
    lobster: {
      // 对话域（原生 OpenAI Chat Completions，SSE；上游为龙虾自有网关）
      chatUrl: "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions",
      // 模型目录（GET，需 Bearer；返回 {code,data:[{modelId,modelName,provider,apiFormat,
      // supportsImage,supportsThinking,contextWindow,explicitContextCache,thinkingConfig}]}）
      modelsUrl: "https://lobsterai-server.youdao.com/api/models/available",
      // 模型目录·公开兜底（**无需鉴权**，官方文档 2026-08-27-more-models.md 明写 public）：
      // 含真实 contextWindow/supportsImage/costMultiplier/freeAccess + imageModels/videoModels。
      // 未登录或 Bearer 目录不可用时用它，保证模型清单与真实能力不依赖登录态
      pricingCatalogUrl: "https://lobsterai-server.youdao.com/api/models/pricing-catalog",
      // 积分余额（GET /api/user/profile-summary 的 totalCreditsRemaining；
      // 注意 /api/user/quota 只含 freeCreditsTotal=300，不含活动积分，故不用它）
      balanceUrl: "https://lobsterai-server.youdao.com/api/user/profile-summary",
      // 鉴权控制面（授权码换令牌 / 刷新令牌；两者都不需要 Bearer）
      exchangeUrl: "https://lobsterai-server.youdao.com/api/auth/exchange",
      refreshUrl: "https://lobsterai-server.youdao.com/api/auth/refresh",
      // 每日签到活动（client-activities 三段式：slot → context → actions/check_in）
      activitySlotUrl: "https://lobsterai-server.youdao.com/api/client-activities/slot",
      activityBaseUrl: "https://lobsterai-server.youdao.com/api/client-activities",
      // 签到活动所在位置槽（实测活动 activityCode=daily-check-in-evergreen-prod-20260814，
      // activityType=daily_check_in，rewardCredits=100，常驻至 2126 年）
      checkinPlacement: "desktop_sidebar",
      // 客户端版本号来源（签到活动按版本下发；官方更新接口实测返回 2026.9.23）
      versionUrl: "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update",
      // 登录门户（回环 OAuth 的授权页基址；getlobster.ai 的 DNS 已失效，实际门户在 youdao.com）
      loginPortal: "https://lobsterai.youdao.com",
      // 客户端版本兜底（versionUrl 不可用时用；低于 2026.9.4 会看不到签到活动）
      clientVersion: "2026.9.23",
      // 上报的客户端身份（UA = LobsterAI/<version>）
      clientName: "LobsterAI",
      // 客户端能力头（官方客户端实测值；缺了部分 agent 能力会被降级）
      clientCapabilities: "kimi-k3-agentic-v1",
    },
    // ===== ModelScope（魔搭 · 阿里）=====
    // 协议事实（2026-10-06 全量实测）：
    // ① 对话面 = 官方 OpenAI 兼容网关（api-inference.modelscope.cn/v1），原生支持
    //    stream / tool_calls / reasoning_content，无需签名、无需客户端（与其它渠道本质不同：
    //    这是**官方公开 API**，非逆向）。
    // ② 魔粒控制面 = www.modelscope.cn/openapi/v1/magicubes/*，鉴权是**三头同发**
    //    （Authorization: Bearer + OpenAPI-Token + X-Modelfun-Token）且必须带浏览器
    //    UA/Origin/Referer——缺头会被风控中间件静默忽略（实测）。
    // ③ 每日任务实测：daily_active +200/日、aliyun_bindlogin +50/日 为自动发放；
    //    interaction_like 收藏/喜欢 +2/次（上限 20 次/日）= +40/日 需主动 PUT 星标
    //    （PUT /api/v1/mcpServers/{path}/{name}/stars，实测 200 → 余额即时 +2）。
    // ④ 计费分档实测：交易记录带 model_tier，standard=1 魔粒/次、ultra=2 魔粒/次
    //    （不存在「一律 2/次」——早期口径只对旗舰档成立）。
    // ⑤ 模型清单 ≠ 全集：/v1/models 只收录按热度精选的模型（实测 35 个），
    //    GLM-5.3-Flash 不在清单内但直调 200 —— 验证可用性的 ground truth 是直调。
    modelscope: {
      // ===== 对话面（OpenAI 兼容） =====
      chatUrl: "https://api-inference.modelscope.cn/v1/chat/completions",
      modelsUrl: "https://api-inference.modelscope.cn/v1/models",
      // ===== 鉴权面（OAuth 2.0 + OIDC，2026-10-06 端到端实测） =====
      // 官方文档 https://modelscope.cn/docs/accounts/oauth；元数据 /.well-known/openid-configuration
      // 关键实测：① 动态注册（RFC 7591）POST /oauth/register 只需 client_name+redirect_uris
      //              即返回 client_id/client_secret，**无需鉴权** → AgentHub 可全自动注册
      //           ② access_token 前缀 ms_oauth、475 字符、有效期 30 天
      //           ③ refresh_token **一次性轮换**（用后失效）→ 续期成功必须立即持久化新 refresh
      //           ④ OAuth 错误以 **HTTP 200 + body.error** 返回（如 invalid_grant）
      //              → 判成败必须查 body.error，绝不能只看状态码
      //           ⑤ api-inference scope 实测可调推理（200 + 正常出流 + usage 正常）
      oauthAuthorizeUrl: "https://www.modelscope.cn/oauth/authorize",
      oauthTokenUrl: "https://www.modelscope.cn/oauth/token",
      oauthUserinfoUrl: "https://www.modelscope.cn/oauth/userinfo",
      oauthRegisterUrl: "https://www.modelscope.cn/oauth/register",
      oidcMetadataUrl: "https://modelscope.cn/.well-known/openid-configuration",
      // 申请 scope：openid 必选；profile 取用户信息；api-inference 是调用推理的授权
      oauthScopes: "openid profile api-inference",
      // 互联应用信息（动态注册所得）持久化在账号 meta 里，键名如下
      oauthMetaKeys: { clientId: "oauthClientId", clientSecret: "oauthClientSecret", refreshToken: "oauthRefreshToken" },
      // 令牌引导页（用户自建令牌入口；粘贴兜底路径的直达链接）
      tokenPageUrl: "https://modelscope.cn/my/myaccesstoken",
      // 令牌形态判别：OAuth access_token 以 ms_oauth 开头；用户自建令牌以 ms- 开头
      oauthTokenPrefix: "ms_oauth",
      // ===== 魔粒控制面 =====
      apiBase: "https://www.modelscope.cn",
      // ===== Cookie 通道（/api/v1 族专用，2026-10-06 实测确立）=====
      // 为什么必须用 Cookie：魔搭端点分两族，**严格互斥**（实测穷尽四条路径均不通）：
      //   「OAuth 可用族」推理 /v1/chat + 魔粒 /openapi/v1/magicubes/* + 身份 /oauth/userinfo
      //   「仅 Cookie/ms- 可用族」点赞 /api/v1/mcpServers/*/stars + 令牌管理 /api/v1/users/tokens*
      // 实测：OAuth 调点赞 → 401 "oauth token is not supported by this endpoint"
      //       （改请求头、找 openapi 替代、扩 scope、动态注册声明权限，四条路全失败）
      // 而 ms- 令牌虽能点赞，但不触发 daily_active —— 实测注释：
      //   「Bearer Token 虽能通过 OpenAPI 鉴权，但 OpenAPI 调用不计入日活，daily_active
      //     每日魔粒不会发放；只有 Web 会话（Cookie）活动才触发奖励」
      // ⇒ Cookie 是唯一同时覆盖「点赞」与「日活」的凭据。
      // 做法：OAuth 授权时在应用内窗口捕获 Web Cookie（用户零额外操作）。
      cookieTouchPaths: ["/my/overview", "/", "/home", "/models", "/datasets", "/my/tasks"],
      // 前端每次加载都会调的两个登录事件端点（HAR 抓包确认）——
      // daily_active 即「注册并登陆，每日登录即可获取」，必须补这两下触碰
      cookieLoginEventPaths: ["/api/v1/users/login/info", "/api/v1/users/authorized/check"],
      // 魔粒激活用的 openapi 轻量端点（Cookie 亦可调，作为日活信号补充）
      cookieOpenapiPaths: [
        "/openapi/v1/magicubes/earn/rules",
        "/openapi/v1/magicubes/balance",
        "/openapi/v1/models?page_number=1&page_size=10",
        "/openapi/v1/datasets?page_number=1&page_size=10",
      ],
      // Cookie 过滤域名（只存魔搭自己的，不存第三方）
      cookieDomains: ["modelscope.cn"],
      // 账号 meta 里存 Cookie 的键名
      cookieMetaKey: "msCookie",
      // Cookie 失效判定（上游对未登录返回的业务码/文案）
      cookieDeadRe: "InvalidAuthentication|user not logged in|not logged in|登录已过期|禁止访问",
      balancePath: "/openapi/v1/magicubes/balance",
      earnRulesPath: "/openapi/v1/magicubes/earn/rules",
      transactionsPath: "/openapi/v1/magicubes/transactions",
      // 身份端点（uid 来源：OAuth 用 userinfo.sub；令牌用 users/me.username）
      userInfoPath: "/openapi/v1/users/me",
      // 点赞任务：列 MCP 服务（PUT + 分页体）→ 逐个 PUT 星标
      mcpServersPath: "/api/v1/dolphin/mcpServers",
      starPathPrefix: "/api/v1/mcpServers",
      // 每日任务规则键（实测值，非猜测）
      ruleDailyActive: "daily_active",
      ruleAliyunBind: "aliyun_bindlogin",
      ruleLike: "interaction_like",
      // 点赞目标分页大小（实测 30 可一次拿够 20 个未星标目标）
      mcpPageSize: 30,
      // 列表响应给 Data.McpServer.TotalCount；按总数动态翻页，但保留扫描安全阀，
      // 避免上游总数异常时无限请求。实测热门排序前 3 页可能全部 AlreadyStar=true。
      mcpMaxScanPages: 20,
      // 必须带浏览器上下文，否则风控中间件忽略请求（实测）
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      refererPath: "/my/overview",
      // 点赞间隔（ms）：避免高频被风控，取 400-900ms 更保守
      likeDelayMinMs: 400,
      likeDelayMaxMs: 900,
      // 单轮点赞上限（安全阀：即使上游 daily_cap 异常放大也不超此值）
      likeHardCap: 25,
    },
    // ===== ZCode（智谱 GLM 编码套餐）=====
    // 协议事实：上游是 Anthropic Messages（coding-plan 与 start-plan 统一）；
    // 头组复刻官方 3.12.3 客户端（LLM 面带 X-ZCode-Agent、不带 X-Device-Mid；
    // billing/claim 控制面反之）。appVersion 上游变更时改这里即热生效，无需发版。
    zcode: {
      // ⚠ 未改（本次任务明确要求「不要盲改」）：客户端桌面端版本是 **3.16.3**，而这里的
      // app_version 参数体系是否与桌面端版本同源**未知**（11 §6）——4.1.10 可能是上游下发的
      // 另一套编号。取值待抓包核对后再动，本次仅留注释。
      appVersion: "4.1.10",
      sourceTitle: "cli",
      refererOrigin: "https://zcode.z.ai",
      // coding-plan（付费套餐，凭据 = coding-plan API key "{apiKey}.{secret}"）
      zaiAnthropicBase: "https://api.z.ai/api/anthropic",
      bigmodelAnthropicBase: "https://open.bigmodel.cn/api/anthropic",
      // start-plan（免费/领取的套餐，凭据 = zcodejwttoken）
      startPlanAnthropicBase: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      // billing / claim / OAuth 控制面
      billingBase: "https://zcode.z.ai/api/v1/zcode-plan",
      clientConfigsUrl: "https://zcode.z.ai/api/v1/client/configs",
      eventReportUrl: "https://zcode.z.ai/api/v1/event/report",
      oauthInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
      oauthPollBase: "https://zcode.z.ai/api/v1/oauth/cli/poll",
      oauthTokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
      businessLoginUrl: "https://api.z.ai/api/auth/z/login",
      // zai 业务域（coding-plan API key 解析链：getCustomerInfo / api_keys）
      zaiBizBase: "https://api.z.ai",
      bigmodelBizBase: "https://bigmodel.cn",
      // bigmodel 额度查询（coding-plan API key 路）
      monitorQuotaUrl: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      subscriptionUrl: "https://open.bigmodel.cn/api/biz/subscription/list",
      // OAuth 登录的 provider（zai / bigmodel）
      oauthProvider: "zai",
      // 平台标识（billing/claim 查询参数 platform 的值）
      platform: "win32-x64",
    },
    // ===== Qoder 双区 =====
    // 端点与版本常量放配置（热加载）：客户端升级后只需改 cosyVersion，无需改代码。
    // 实测签名对版本串宽容（0.4.2 ~ 9.9.9 均通过），此值仅用于对齐客户端指纹。
    // 账号与额度池两区互不相通（CN/INTL 各一套账号体系），故各自独立配置。
    qoder: {
      gateway: "https://gateway.qoder.com.cn",
      openApi: "https://openapi.qoder.com.cn",
      // 额度查询域（实测两区不同：CN 走 gateway 亦可，INTL 只在 openapi）
      quotaBase: "https://gateway.qoder.com.cn",
      // 推理端点基址（wasm 会补 ?FetchKeys=…&AgentId=…&Encode=1）
      inferPath: "/algo/api/v2/service/pro/sse/agent_chat_generation",
      quotaPath: "/api/v2/quota/usage",
      refreshPath: "/api/v1/deviceToken/refresh",
      // ⚠ 未改：UA 里的版本段与 cosyVersion 本应同源，但本次任务只授权改 cosyVersion
      // （11 §6 只实测到 CN 客户端 0.4.8），这一行是否同步为 qoder/0.4.8 **待核对**，勿盲改。
      userAgent: "qoder/0.4.3",
      // 版本对齐（依据 11 §6）：本机 Qoder CN 客户端实测 0.4.8（原 0.4.3 已过期）。
      // 该值仅用于对齐客户端指纹（签名对版本串宽容，0.4.2 ~ 9.9.9 均通过）。
      cosyVersion: "0.4.8",
    },
    // ⚠ 未改：qoder_intl 的客户端**未安装**（13-号池现有签到实现基线.md §0 明列
    // 「未安装 → 本轮不排查」），其 0.4.3 是否同样过期**无证据**，禁止臆断；待装 INTL 客户端后再核。
    qoder_intl: {
      gateway: "https://api2.qoder.sh",
      openApi: "https://openapi.qoder.sh",
      // ⚠ INTL 的额度端点在 openapi（gateway 返回 404，实测）
      quotaBase: "https://openapi.qoder.sh",
      inferPath: "/algo/api/v2/service/pro/sse/agent_chat_generation",
      quotaPath: "/api/v2/quota/usage",
      refreshPath: "/api/v1/deviceToken/refresh",
      userAgent: "qoder/0.4.3",
      cosyVersion: "0.4.3",
    },
    // ===== CatPaw（美团）=====
    // 有状态会话协议（round → event(running) → turn(SSE) → 工具循环 → event(completed)）。
    // 客户端身份常量（toolVersion / agentVersion / appKey / source / mode）**必须与真实客户端保持一致**，
    // 上游按它们解释请求语义与工具形态；客户端升级后改这里即热生效，无需发版。
    // permissionMode 是本家固定的绕过权限档（写死在请求体里）。
    catpaw: {
      baseUrl: "https://ai.catpaw.meituan.com",
      source: "CatX",
      mode: "CATX_APP",
      toolVersion: "2.0.2",
      agentVersion: "1.0.1",
      appKey: "fe_com.sankuai.catpaw.external.front",
      permissionMode: "unsafeBypassPermissions",
      // 超时三分档：短请求（round/event/stop，30s/3s）、turn 的 SSE 总预算（15min）
      requestTimeoutMs: 30000,
      stopTimeoutMs: 3000,
      sseTimeoutMs: 900000,
    },
    // ===== AutoClaw 双区（国内版 / 国际版）=====
    // 两地同协议同签名指纹（appId/appKey 逐字相同），仅 userapiBase 与订阅端点不同。
    // 版本号：旧注释称「两域版本号不同（llmVersion 进对话头 X-Version；apiVersion 进 userapi 域
    // X-Version 且是版本门控）」——该口径已被 12 §6.4 的客户端实证推翻：2.2.0 客户端的两个域
    // **共用同一个 gE() 头构造器**，X-Version 恒为 app.getVersion()，故两键取值相同。
    // X-Auth-Sign 仅 userapi 域发：MD5(`${authAppId}&${秒级时间戳}&${authAppKey}`) 小写十六进制。
    autoclaw: {
      userapiBase: "https://autoglm-acceleration-api.zhipuai.cn",
      llmProxyPath: "/autoclaw-proxy/proxy/autoclaw",
      authAppId: "100003",
      authAppKey: "38d2391985e2369a5fb8227d8e6cd5e5",
      // 版本对齐（依据 12 §6.4）：客户端 X-Version = app.getVersion() = **2.2.0**，
      // 且两个域**共用同一个** gE() 头构造器 —— 原注释「两域版本号不同」在 2.2.0 上不成立，
      // 故 llmVersion / apiVersion 一并改为 2.2.0（原 1.17.8 / 1.18.5 均已过期）。
      llmVersion: "2.2.0",
      apiVersion: "2.2.0",
      catalogPath: "/autoclaw-proxy/proxy/autoclaw-model-config",
      taskCompletePath: "/autoclaw-proxy/proxy/autoclaw-task-complete",
      taskListPath: "/autoclaw-proxy/proxy/autoclaw-task-list",
      refreshPath: "/userapi/v1/refresh",
      refreshFallbackPath: "/userapi/v1/agent-refresh",
      sendCodePath: "/userapi/v1/agent-send-code",
      // 结尾斜杠是上游要求的（带不带斜杠是两个路由）
      loginPath: "/userapi/v1/agent-login/",
      userProfilePath: "/userapi/v1/user-profile",
      // 客户端启动同款的「登录」端点：活动福利（Weekly Perks / 登录奖励）没有领取接口，
      // 服务端把发放判据挂在这个动作上（签到后触发，见 autoclaw/checkin.cjs）
      userInfoPath: "/userapi/v1/user-info",
      walletsPath: "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
      walletInstancesPath: "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all",
      pointsExpiringPath: "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw",
      // 订阅端点两区不同（实测）：国内 subscribe-info / 国际 oversea-subscribe-info
      subscribePath: "/agentpay/v1/assistant/subscribe-info",
      oauthCaptchaConfigPath: "/userapi/overseasv1/oauth-captcha-config",
      oauthUrlPath: "/userapi/overseasv1/zai-oauth-url",
      oauthLoginPath: "/userapi/overseasv1/zai-oauth-login",
      // Google 变体（国际版第二登录方式；回调端口按 RFC 8252 loopback 宽松匹配，端口任意）
      oauthGoogleUrlPath: "/userapi/overseasv1/google-oauth-url",
      oauthGoogleLoginPath: "/userapi/overseasv1/google-oauth-login",
    },
    // ⚠ 未改：autoclaw_intl 的客户端**未安装**（13-号池现有签到实现基线.md §0 明列
    // 「未安装 → 本轮不排查」），1.17.8 / 1.18.5 是否同样过期**无实测证据**，禁止臆断。
    // 注：store.cjs 注释称两区共用同一个桌面端登录态文件（%APPDATA%/AutoClaw/auth.json），
    // 若确为同一客户端则两区版本应当一致 —— 该推断待确认后再一并改。
    autoclaw_intl: {
      userapiBase: "https://autoglm-api.autoglm.ai",
      llmProxyPath: "/autoclaw-proxy/proxy/autoclaw",
      authAppId: "100003",
      authAppKey: "38d2391985e2369a5fb8227d8e6cd5e5",
      llmVersion: "1.17.8",
      apiVersion: "1.18.5",
      catalogPath: "/autoclaw-proxy/proxy/autoclaw-model-config",
      taskCompletePath: "/autoclaw-proxy/proxy/autoclaw-task-complete",
      taskListPath: "/autoclaw-proxy/proxy/autoclaw-task-list",
      refreshPath: "/userapi/v1/refresh",
      refreshFallbackPath: "/userapi/v1/agent-refresh",
      sendCodePath: "/userapi/v1/agent-send-code",
      loginPath: "/userapi/v1/agent-login/",
      userProfilePath: "/userapi/v1/user-profile",
      // 客户端启动同款的「登录」端点：活动福利（Weekly Perks / 登录奖励）没有领取接口，
      // 服务端把发放判据挂在这个动作上（签到后触发，见 autoclaw/checkin.cjs）
      userInfoPath: "/userapi/v1/user-info",
      walletsPath: "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
      walletInstancesPath: "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all",
      pointsExpiringPath: "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw",
      subscribePath: "/agentpay/v1/assistant/oversea-subscribe-info",
      oauthCaptchaConfigPath: "/userapi/overseasv1/oauth-captcha-config",
      oauthUrlPath: "/userapi/overseasv1/zai-oauth-url",
      oauthLoginPath: "/userapi/overseasv1/zai-oauth-login",
      // Google 变体（国际版第二登录方式；回调端口按 RFC 8252 loopback 宽松匹配，端口任意）
      oauthGoogleUrlPath: "/userapi/overseasv1/google-oauth-url",
      oauthGoogleLoginPath: "/userapi/overseasv1/google-oauth-login",
    },
    // Accio 双区（国际版 / 国内版）：同网关，差别只在 x-package-region 与登录站点。
    // token 不走 Authorization 头（GET 拼 query / POST 放 body / 推理放 body），见 accio/auth.cjs。
    accio: {
      gatewayBase: "https://phoenix-gw.alibaba.com",
      llmBase: "https://phoenix-gw.alibaba.com/api/adk/llm",
    },
    accio_cn: {
      gatewayBase: "https://phoenix-gw.alibaba.com",
      llmBase: "https://phoenix-gw.alibaba.com/api/adk/llm",
    },
    // CodeArts（华为云）：SDK-HMAC-SHA256 签名 + DPoP + 有状态会话（每账号 3 路并发）。
    // base 域与 token 签发地必须同为 cn-north-4；临时凭据到期前 15 分钟续。见 codearts/。
    codearts: {
      base: "https://snap-access.cn-north-4.myhuaweicloud.com",
      tokenUrl: "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens",
      identityUrl: "https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity",
      webLoginBase: "https://codearts.huaweicloud.com",
      chatPath: "/api/v2/chat/completions",
      region: "cn-north-4",
      pluginName: "snap_vscode",
      pluginVersion: "26.9.101",
      language: "en-us",
      sessionConcurrency: 3,
      refreshMarginMs: 900000,
    },
    // Loomy（讯飞）：无状态 OpenAI 兼容，签名只用于账号域（短信登录），转发走 token + Bearer 双头。
    loomy: {
      xfyunBase: "https://account.xfinfr.com",
      integrationBase: "https://loomyad.xunfei.cn",
      modelBase: "https://loomyad.xunfei.cn/api/v1",
    },
  },
};

const DESC = {
  "model_map.json": "Trae 模型映射（显示名 → config_name/model_name）",
  "function_map.json": "Trae function 字段按模型分发（solo_agent / solo_work_lite）",
  "wb_models.json": "WorkBuddy 双区模型目录（兜底，catalog.json 优先）",
  "catalog.json": "模型权威目录（拉取模型写回：倍率/能力/上下文，可手编）",
  "wb_template_map.json": "WorkBuddy 审核模板最小改写表",
  "headers.json": "渠道默认头 / UA / 上游域",
};

const cache = new Map(); // file -> { data, error }
let watcher = null;

function rulesDir() {
  const d = path.join(store.proxyDir(), "rules");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 只补内置默认里存在、用户文件里缺失的键（递归）；已有值一律不动，用户改动不会被覆盖 */
function mergeMissing(target, defaults) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return target;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target) || target[k] === undefined) {
      target[k] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      mergeMissing(target[k], v);
    }
  }
  return target;
}

/** 首次启动把内置默认值拷贝到 rules/，用户可直接编辑 */
function ensureFiles() {
  const dir = rulesDir();
  for (const [file, data] of Object.entries(DEFAULTS)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      try {
        fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      } catch { /* 写不进去就用内存默认值 */ }
      continue;
    }
    // 升级迁移：新版内置里新增的键（如登录端点）补进用户文件。
    // 不做这一步的话，老装机永远拿不到新键，只能让用户删文件重来
    try {
      const cur = JSON.parse(fs.readFileSync(p, "utf8"));
      const before = JSON.stringify(cur);
      mergeMissing(cur, data);
      migrateFile(file, cur);
      if (JSON.stringify(cur) !== before) fs.writeFileSync(p, JSON.stringify(cur, null, 2), "utf8");
    } catch { /* 文件坏了留给 loadFile 报错并回退内置默认 */ }
  }
}

/** 升级迁移特例一：只删不改——老版本 wb_template_map.json 里的短键全局替换会
 *  改写用户正文（"Claude Code"→"CodeBuddy" 连正常提问都被改），必须从用户文件里移除 */
function migrateFile(file, cur) {
  if (!cur || typeof cur !== "object") return;
  if (file === "wb_template_map.json") {
    for (const bad of ["Claude Code", "Anthropic's official CLI"]) delete cur[bad];
  }
  migrateStaleDefaults(file, cur);
}

/**
 * 升级迁移特例二（2026-10-28）：把**旧版内置默认值**定点改写为新值。
 *
 * 为什么必须有这一步：上面的 `mergeMissing()` 只补「用户文件里缺失的键」，**已有值一律不动**
 * （这是刻意的——保护用户自定义）。于是「内置默认值本身被修正」这类更新，在**已经跑过一次
 * AgentHub 的机器**上永远不生效，只能删文件重来。本次客户端实测版本对齐正属于这一类。
 *
 * 安全边界（不破坏上面那条保护）：
 *   · 只对下面**明确列出的键**生效，其它键一概不碰；
 *   · 只在当前值**含旧默认 token** 时才替换 —— 用户若改成了别的值，不含该 token，一律不动；
 *   · 复合字符串（如三段式 UA `WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1`）也只替换版本段。
 *
 * 依据：docs/号池签到核对-20261028/12-…-签到核对.md §2/§5.4、11-…-签到核对.md §6
 *      （均为本机已安装客户端的实测版本）。 */
const STALE_DEFAULT_REWRITES = {
  "headers.json": [
    // [渠道, 键, 旧内置默认 token, 新值]
    ["workbuddy", "clientVersion", "5.5.4", "5.6.2"],   // 真客户端 = E:\WorkBuddy 5.6.2
    ["workbuddy", "userAgent", "5.5.4", "5.6.2"],
    ["workbuddy", "billingUA", "5.5.4", "5.6.2"],
    ["workbuddy", "catalogUA", "5.5.4", "5.6.2"],
    ["workbuddy_ai", "clientVersion", "5.5.4", "5.8.4"], // 真客户端 = E:\WorkBuddyAI 5.8.4
    ["workbuddy_ai", "userAgent", "5.5.4", "5.8.4"],
    ["workbuddy_ai", "billingUA", "5.5.4", "5.8.4"],
    ["workbuddy_ai", "catalogUA", "5.5.4", "5.8.4"],
    ["autoclaw", "llmVersion", "1.17.8", "2.2.0"],       // X-Version = app.getVersion() = 2.2.0
    ["autoclaw", "apiVersion", "1.18.5", "2.2.0"],
    ["raccoon", "webClientVersion", "v1.0.35", "v1.1.3"], // "v" + app.getVersion() = v1.1.3
    ["qoder", "cosyVersion", "0.4.3", "0.4.8"],           // 客户端取 app.getVersion() = 0.4.8
    // ⚠ 刻意**不**改写（未取证，禁止臆断）：
    //   · qoder.userAgent —— 客户端 UA 的**字符串格式**未取证（11 §6 只拿到 cosyVersion），
    //     "qoder/0.4.3" 只是号池自拟的兜底形态，是否该同步为 qoder/0.4.8 待抓包；
    //   · raccoon.clientVersion —— 该键用在 box-agent 链路的 `x-client-version`（adapters.cjs:1879），
    //     与 web 链路的 `X-Client-Version`（webClientVersion）是否同一口径未核实；
    //   · autoclaw_intl / qoder_intl —— 对应客户端**未安装**，无实测版本，不臆断；
    //   · zcode.appVersion —— 桌面端版本 3.16.3 与 `app_version` 参数体系是否同源未知。
  ],
};

function migrateStaleDefaults(file, cur) {
  const list = STALE_DEFAULT_REWRITES[file];
  if (!list) return;
  for (const [channel, key, from, to] of list) {
    const sec = cur[channel];
    if (!sec || typeof sec !== "object") continue;
    const v = sec[key];
    if (typeof v !== "string" || !v.includes(from)) continue;
    const next = v.split(from).join(to);
    if (next !== v) sec[key] = next;
  }
}

function loadFile(file) {
  const p = path.join(rulesDir(), file);
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    cache.set(file, { data, error: "" });
  } catch (e) {
    // 坏 JSON：保留上次快照，没有快照退回内置默认值，错误交给面板警示
    const prev = cache.get(file);
    cache.set(file, { data: prev ? prev.data : DEFAULTS[file], error: String((e && e.message) || e) });
  }
}

/** 启动加载 + chokidar 热重载（chokidar 不可用时退回 fs.watch，仍保持热加载能力） */
function init() {
  ensureFiles();
  for (const file of Object.keys(DEFAULTS)) loadFile(file);
  if (watcher) return;
  const dir = rulesDir();
  const onChange = (file) => {
    if (file && DEFAULTS[file]) loadFile(file);
  };
  try {
    const chokidar = require("chokidar");
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
    watcher.on("change", (p) => onChange(path.basename(p)));
    watcher.on("add", (p) => onChange(path.basename(p)));
    // 删除也要生效：不监听 unlink 时用户删了文件内存缓存永不失效，继续用旧值直到重启
    watcher.on("unlink", (p) => {
      const f = path.basename(p);
      if (f && DEFAULTS[f]) cache.delete(f); // 清缓存，下次读取回退内置默认值
    });
  } catch {
    try {
      fs.watch(dir, (_ev, file) => onChange(file));
    } catch { /* 热加载不可用时静默，重启仍生效 */ }
  }
}

/** 取规则数据（永远有值：文件 → 上次快照 → 内置默认） */
function get(file) {
  const hit = cache.get(file);
  if (hit) return hit.data;
  return DEFAULTS[file];
}

/** 立即重载单个规则文件（chokidar 事件是异步的，测试等需要确定性重载的场景用） */
function reload(file) {
  if (DEFAULTS[file]) loadFile(file);
}

/** 面板规则文件表：说明 / 大小 / mtime / 状态 */
function list() {
  init();
  const dir = rulesDir();
  return Object.keys(DEFAULTS).map((file) => {
    const p = path.join(dir, file);
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(p);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch { /* 文件缺失也列出（用内置默认） */ }
    const err = (cache.get(file) || {}).error || "";
    return { file, desc: DESC[file] || "", size, mtimeMs, ok: !err, error: err };
  });
}

module.exports = { init, get, list, reload, rulesDir, DEFAULTS };
