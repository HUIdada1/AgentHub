// 反代网关 · 外置规则热加载（方案 §6.6 第②层）
// rules/*.json 首次启动从内置默认值拷贝，用户可直接改文件；chokidar 监听变更即重载内存态，无需重启
// 坏 JSON 回退上次快照并在面板警示（status 里带 error）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.cjs");

// ===== 内置默认规则（上游变更时用户改文件即生效，无需发版） =====
const DEFAULTS = {
  // Trae 模型显示名 → [config_name, model_name]（方案 §2.1 必填注入字段）
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
  // 内置默认 = Trae 静态兜底清单（参考项目逆向实证 32 个 config_name）+ WB 双区基础目录，
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
  },
  // Trae function 字段按模型分发（TraeWorkAssistant models_sync.rs 实证：
  // 部分模型仅在 solo_agent 下可用，其余走 solo_work_lite；未命中默认 solo_work_lite）
  "function_map.json": {
    "doubao-seed-code": "solo_agent",
    "glm-5.3-flash": "solo_agent",
    "qwen3.8-flash": "solo_agent",
  },
  // WorkBuddy 审核指纹最小改写表（from→to 逐字替换；键名要够长防误伤）
  // 对齐参考项目 sanitizeRewrites：上游按整句精确匹配拦截（400 code 11-128），
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
      // agent 域（对话/模型目录）实证只有一个 mchost.guru（参考项目 AgentHost）；
      // api.trae.cn 只服务 /trae/api/v2/...（ug/pay），打 /api/agent/... 会吃 TLB 404，
      // 故镜像默认留空（官方镜像域可用时在此填写完整 URL）
      chatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
      mirrorChatUrl: "",
      creditsUrl: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
      exchangeUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
      userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
      // 模型目录拉取（参考项目实证：get_detail_param 返回 config_info_list[].config_name + display_name）
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
    },
    workbuddy: {
      chatUrl: "https://copilot.tencent.com/v2/chat/completions",
      billingBase: "https://www.codebuddy.cn",
      // chat 出站 Origin/Referer 基域（参考项目 headers.go originRefererFor 实证 CN=codebuddy.cn）
      origin: "https://www.codebuddy.cn",
      // 官方桌面端指纹（参考项目逆向实证）：三段式 UA 与 IDE 归属头组，少一项都可能被风控判为网关
      clientVersion: "5.5.4",
      cliVersion: "2.137.1",
      userAgent: "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
      billingUA: "WorkBuddy/5.5.4",
      ideName: "WorkBuddy",
      modelsUrl: "https://copilot.tencent.com/console/enterprises/personal/models",
      // v3 客户端权威目录（主路，含倍率/能力/上下文元数据）：必须用三段式 CLI UA，否则 400 code 12403
      modelsV3Url: "https://copilot.tencent.com/v3/config",
      catalogUA: "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
      // 登录/账号类插件端点的上游域（与计费域不同，必须单独给）
      pluginBase: "https://copilot.tencent.com",
      // 刷新渠道标识（两参考项目不一致：workbuddy2api="plugin"、TWA="workbuddy"，实测后固化）
      refreshSource: "plugin",
      // X-Device-Token 设备风控头兜底值（优先级：账号 deviceToken > 此处 > data 目录 device_token.txt）
      deviceToken: "",
    },
    workbuddy_ai: {
      chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
      // 官方国际客户端现行对话路径（优先），404/405 时回退上方 /v2（参考项目实证）
      consoleChatUrl: "https://www.workbuddy.ai/console/chat/completions",
      billingBase: "https://www.workbuddy.ai",
      origin: "https://www.workbuddy.ai",
      clientVersion: "5.5.4",
      cliVersion: "2.137.1",
      // 平台段必须 WorkBuddy AI，送错触发 403 code 11140 request illegal
      userAgent: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      billingUA: "WorkBuddy/5.5.4",
      ideName: "WorkBuddy",
      modelsUrl: "https://www.workbuddy.ai/console/enterprises/personal/models",
      modelsV3Url: "https://www.workbuddy.ai/v3/config",
      catalogUA: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      pluginBase: "https://www.workbuddy.ai",
      refreshSource: "plugin",
      deviceToken: "",
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
      refreshUrl: "https://xiaohuanxiong.com/api/web/auth/v1/refresh",
      // x-client-* 六头取值（box-agent 链路 platform 带架构 `desktop-windows-x64`；
      // 浏览器/受信域 platform 不带架构，见 adapters.cjs raccoonIdentity/raccoonWebHeaders）
      clientName: "raccoon-ai",
      clientVersion: "1.0.35",
      webClientVersion: "v1.0.35",
      clientChannel: "official",
    },
    // ===== LobsterAI（网易有道龙虾）=====
    // 协议事实（2026-10-05 实测 + 参考实现 lobsterai2api@21c39a4 交叉验证）：
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
      // 必须带浏览器上下文，否则风控中间件忽略请求（实测）
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      refererPath: "/my/overview",
      // 点赞间隔（ms）：避免高频被风控，参考实现用 200-400ms，这里取更保守的 400-900ms
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
      userAgent: "qoder/0.4.3",
      cosyVersion: "0.4.3",
    },
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

/** 升级迁移特例：只删不改——老版本 wb_template_map.json 里的短键全局替换会
 *  改写用户正文（"Claude Code"→"CodeBuddy" 连正常提问都被改），必须从用户文件里移除 */
function migrateFile(file, cur) {
  if (file !== "wb_template_map.json" || !cur || typeof cur !== "object") return;
  for (const bad of ["Claude Code", "Anthropic's official CLI"]) delete cur[bad];
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
