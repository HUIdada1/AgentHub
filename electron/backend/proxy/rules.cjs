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
    workbuddy_ai: ["claude-sonnet-4.5", "gpt-5", "gemini-2.5-pro"],
  },
  // WorkBuddy 审核模板黑名单 from→to 最小改写（指纹清洗，方案 §2.2）
  "wb_template_map.json": {
    "You are Claude Code, Anthropic's official CLI.": "You are CodeBuddy, an AI coding assistant.",
    "Claude Code": "CodeBuddy",
    "Anthropic's official CLI": "an AI coding assistant",
  },
  // 各渠道默认头 / UA 伪装 / 上游域配置
  "headers.json": {
    trae: {
      chatUrl: "https://api.trae.cn/api/agent/v3/llm_utils_chat",
      mirrorChatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
      creditsUrl: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
      exchangeUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
      userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
      userAgent: "TraeClient/TTNet",
      appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      ideVersion: "0.1.50",
      ideVersionCode: "20260811",
      clientId: "en1oxy7wnw8j9n",
    },
    workbuddy: {
      chatUrl: "https://copilot.tencent.com/v2/chat/completions",
      billingBase: "https://www.codebuddy.cn",
      origin: "https://www.workbuddy.cn",
      userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
      modelsUrl: "https://copilot.tencent.com/console/enterprises/personal/models",
    },
    workbuddy_ai: {
      chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
      billingBase: "https://www.workbuddy.ai",
      origin: "https://www.workbuddy.ai",
      userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
      modelsUrl: "https://www.workbuddy.ai/console/enterprises/personal/models",
    },
  },
};

const DESC = {
  "model_map.json": "Trae 模型映射（显示名 → config_name/model_name）",
  "wb_models.json": "WorkBuddy 双区模型目录",
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

/** 首次启动把内置默认值拷贝到 rules/，用户可直接编辑 */
function ensureFiles() {
  const dir = rulesDir();
  for (const [file, data] of Object.entries(DEFAULTS)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      try {
        fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      } catch { /* 写不进去就用内存默认值 */ }
    }
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
