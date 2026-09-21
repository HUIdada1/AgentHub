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
      ].map((id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0 })),
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
