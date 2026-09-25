// 浏览器 mock：dev:web 纯前端预览用；配置落 localStorage，语义与主进程 config.cjs 对齐
// 技能仓库命令返回贴真实的样例数据（打包产物走不到这里）；未覆盖的命令返回 null 让页面降级
import type { AppConfig, UpdateStatus } from "../types";
import { MODULES } from "../types";

const KEY = "agenthub-config";
const PREVIEW_NOTE = "（浏览器预览 mock 数据，桌面端才真实生效）";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();

function defaultConfig(): AppConfig {
  return {
    theme: "dark",
    fx: false,
    moduleOrder: MODULES.map((m) => m.key),
    tools: {
      zcode: { enabled: true, paths: [".zcode/skills"] },
      codex: { enabled: true, paths: [".codex/skills"] },
      claude: { enabled: true, paths: [".claude/skills"] },
      antigravity: { enabled: true, paths: [".gemini/antigravity/skills", ".gemini/config/skills"] },
      agents: { enabled: false, paths: [".agents/skills"] },
      cursor: { name: "Cursor", icon: "ph-robot", enabled: true, paths: ["C:\\Users\\demo\\.cursor\\skills"] },
    },
    customDirs: ["D:\\我的技能库"],
    mountMode: "junction",
    l3: { enabled: true, threshold: 0.85 },
    trashDays: 7,
    update: { channel: "stable", autoCheck: true, notifiedVersion: "" },
    webdav: {
      endpoint: "https://dav.jianguoyun.com/dav",
      username: "me@example.com",
      password: "••••••••",
      root: "/agent-skills",
      deviceId: "b3f2a1c8-77d2-4e5a-9b01-3f6c8d2e4a7b",
      deviceName: "DESK-01",
    },
    schedule: { minimizeToTray: true, autoStart: true, hourly: false, daily: true, dailyTime: "09:00", notifyOnSuccess: false },
    watch: { enabled: true, intervalSeconds: 15 },
    memory: { enabled: true, rootDir: "" },
    proxy: {
      port: 9527,
      bind: "127.0.0.1",
      restoreOnLaunch: false,
      routeStrategy: "smart",
      fixedChannel: "trae",
      rateLimitPerMin: 120,
      concurrency: 8,
      creditsRefreshMin: 30,
      debugStatus: false,
      modelOverrides: {},
      humanizeJitter: true,
      disabledModels: [],
      modelFallback: {},
      modelAliases: { "gpt-4o": "kimi-k3" },
      autoFallbackEnabled: true,
      fallbackModel: "glm-5.2",
      ccSwitchModel: "",
      checkinAuto: false,
      checkinAutoTime: "09:00",
    },
  };
}

function read(): AppConfig {
  const def = defaultConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "");
    if (!saved || typeof saved !== "object") return def;
    const theme = saved.theme === "light" ? "light" : "dark";
    const order = (Array.isArray(saved.moduleOrder) ? saved.moduleOrder : []).filter((k: string) =>
      def.moduleOrder.includes(k as AppConfig["moduleOrder"][number])
    );
    for (const k of def.moduleOrder) if (!order.includes(k)) order.push(k);
    return { ...def, ...saved, theme, moduleOrder: order };
  } catch {
    return def;
  }
}

/** 预览用更新状态：模拟「检测到新版本」，让设置页更新卡片各分支可被查看 */
function previewStatus(state: UpdateStatus["status"]): UpdateStatus {
  return {
    status: state,
    isPortable: false,
    currentVersion: "0.1.0",
    latestVersion: state === "available" || state === "downloading" || state === "downloaded" ? "0.2.0" : "",
    percent: state === "downloading" ? 42 : state === "downloaded" ? 100 : 0,
    notes:
      state === "available" || state === "downloaded"
        ? `新增 反代网关 请求明细页\n· 技能库支持按来源筛选\n· 修复用量同步偶发重复入库\n${PREVIEW_NOTE}`
        : "",
    message: PREVIEW_NOTE,
  };
}

// ===== 技能仓库样例数据 =====

const TOOLS = [
  { id: "zcode", name: "ZCode", icon: "ph-terminal-window", builtin: true, deletable: false, enabled: true, dir: "C:\\Users\\demo\\.zcode\\skills", candidatePaths: ["~/.zcode/skills"] },
  { id: "codex", name: "Codex CLI", icon: "ph-command", builtin: true, deletable: false, enabled: true, dir: "C:\\Users\\demo\\.codex\\skills", candidatePaths: ["~/.codex/skills"] },
  { id: "claude", name: "Claude Code", icon: "ph-sparkle", builtin: true, deletable: false, enabled: true, dir: "C:\\Users\\demo\\.claude\\skills", candidatePaths: ["~/.claude/skills"] },
  { id: "antigravity", name: "Antigravity", icon: "ph-airplane-tilt", builtin: true, deletable: false, enabled: false, dir: null, candidatePaths: ["~/.gemini/antigravity/skills", "~/.gemini/config/skills"] },
  { id: "agents", name: "通用 ~/.agents", icon: "ph-package", builtin: true, deletable: false, enabled: false, dir: null, candidatePaths: ["~/.agents/skills"] },
  { id: "cursor", name: "Cursor", icon: "ph-robot", builtin: false, deletable: true, enabled: true, dir: "C:\\Users\\demo\\.cursor\\skills", candidatePaths: ["C:\\Users\\demo\\.cursor\\skills"] },
];

// 电脑扫描发现的假结果：Cursor 已注册被过滤，只剩 Qoder
const PROBED = [
  { suggestId: "qoder", name: "Qoder", icon: "ph-command", hitDirs: ["C:\\Users\\demo\\.qoder\\skills"], skillCount: 4 },
];

// 样例技能覆盖五种状态：挂载启用 / 已停止 / 体检报错 / 体检警告 / 待收纳
const SKILLS = [
  {
    name: "design-taste-frontend", skillName: "design-taste-frontend",
    description: "反模板化前端设计技能：从需求推断设计方向，落地不像套模板的界面。",
    version: "1.2.0", treeHash: "a3f19c", health: [], inManifest: true,
    sources: [{ tool: "zcode" }, { tool: "codex", name: "design-taste" }],
    mounts: [
      { tool: "zcode", name: "design-taste-frontend", path: "C:\\Users\\demo\\.zcode\\skills\\design-taste-frontend", type: "junction" as const, enabled: true },
      { tool: "codex", name: "design-taste-frontend", path: "C:\\Users\\demo\\.codex\\skills\\design-taste-frontend", type: "junction" as const, enabled: true },
    ],
    mtimeMs: NOW - 40 * 60000,
  },
  {
    name: "browser-skill", skillName: "browser-skill",
    description: "操作用户已登录浏览器执行自动化：访问页面、填表、抓取与回归测试。",
    version: "0.9.4", treeHash: "77bd21", health: [], inManifest: true,
    sources: [{ tool: "zcode" }],
    mounts: [{ tool: "zcode", name: "browser-skill", path: "C:\\Users\\demo\\.zcode\\skills\\browser-skill", type: "junction" as const, enabled: false }],
    mtimeMs: NOW - 3 * 3600000,
  },
  {
    name: "selftest-core", skillName: "selftest-core",
    description: "核心引擎自测脚本：临时目录造假技能，校验去重、收纳与回收站全链路。",
    version: "", treeHash: "e01a5b",
    health: [{ level: "bad" as const, text: "缺少 SKILL.md，无法解析描述与元信息" }],
    inManifest: true,
    sources: [{ tool: "codex" }],
    mounts: [],
    mtimeMs: NOW - 26 * 3600000,
  },
  {
    name: "yunxiao-git-tasks", skillName: "yunxiao-git-tasks",
    description: "根据 Git 提交记录为云效项目拆分任务、批量创建工作项并登记工时。",
    version: "2.0.1", treeHash: "c49f02",
    health: [{ level: "warn" as const, text: "frontmatter 缺少 author 字段" }],
    inManifest: true,
    sources: [{ tool: "claude" }],
    mounts: [{ tool: "claude", name: "yunxiao-git-tasks", path: "C:\\Users\\demo\\.claude\\skills\\yunxiao-git-tasks", type: "junction" as const, enabled: true }],
    mtimeMs: NOW - 2 * 86400000,
  },
  {
    name: "brandkit", skillName: "brandkit",
    description: "高端品牌套件生成：logo 系统、视觉世界与品牌规范板。",
    version: "", treeHash: "9b7e30", health: [], inManifest: false,
    sources: [{ tool: "zcode" }, { tool: "cursor" }],
    mounts: [],
    mtimeMs: NOW - 12 * 60000,
  },
  // 工具自带系统技能：默认隐藏，搜索时才出现
  {
    name: "skill-creator", skillName: "skill-creator",
    description: "Codex 官方系统技能：创建新技能、改进现有技能的引导流程。",
    version: "1.0.0", treeHash: "5d21aa", health: [], inManifest: false,
    sources: [{ tool: "codex", name: "skill-creator", origin: "system" }],
    mounts: [],
    mtimeMs: NOW - 8 * 3600000,
    origin: "system" as const,
  },
];

// 摆在"同步进行中"的下载阶段，方便看进度条 / 步骤条 / 日志的运行时状态
const WEBDAV_STATUS = {
  running: true,
  configured: true,
  deviceId: "b3f2a1c8-77d2-4e5a-9b01-3f6c8d2e4a7b",
  deviceName: "DESK-01",
  lastSyncAt: ago(130),
  stage: "download",
  stageLabel: "下载技能",
  detail: "下载 code-review（远端有更新，本机未改动）",
  pct: 47,
  lastError: "",
};

const WEBDAV_LOGS = [
  { at: ago(3), text: "[连接检查] 检查远端连接…" },
  { at: ago(3), text: "[拉取清单] 拉取远端台账…" },
  { at: ago(2), text: "[拉取清单] 远端 12 个技能 / 12 个目录，本机 11 个" },
  { at: ago(2), text: "计划：下载 2 · 上传 1 · 冲突 0 · 删远端 0 · 删本机 0" },
  { at: ago(1), text: "[下载技能] 下载 code-review（远端有更新，本机未改动）" },
];

const DEVICES = {
  devices: [
    { id: "b3f2a1c8-77d2-4e5a-9b01-3f6c8d2e4a7b", name: "DESK-01", appVersion: "0.1.0", lastSyncAt: ago(3), self: true },
    { id: "5c9d2e71-1a44-4cbb-8f2a-90b6d3e7c1f4", name: "MACBOOK-AIR", appVersion: "0.1.0", lastSyncAt: ago(95), self: false },
  ],
};

const REPORTS = [
  { file: "webdav-20260913-1542.md", path: "C:\\Users\\demo\\.agent_skills\\reports\\webdav-20260913-1542.md", mtimeMs: NOW - 3 * 60000 },
  { file: "webdav-20260913-0930.md", path: "C:\\Users\\demo\\.agent_skills\\reports\\webdav-20260913-0930.md", mtimeMs: NOW - 375 * 60000 },
];

const TRASH = [
  { name: "old-skill-20260913-091501", path: "C:\\Users\\demo\\.agent_skills\\.trash\\old-skill-20260913-091501", trashedAt: NOW - 6 * 3600000, sizeBytes: 48213 },
];

// 孤儿目录：装了但还没同步收编的技能
const ORPHANS = [
  { name: "gsap-scrolltrigger", tool: "codex", dir: "C:\\Users\\demo\\.codex\\skills\\gsap-scrolltrigger", mtimeMs: NOW - 5 * 86400000 },
  { name: "stitch-design-taste", tool: "zcode", dir: "C:\\Users\\demo\\.zcode\\skills\\stitch-design-taste", mtimeMs: NOW - 26 * 3600000 },
  { name: "yunxiao-git-tasks", tool: "zcode", dir: "C:\\Users\\demo\\.zcode\\skills\\yunxiao-git-tasks", mtimeMs: NOW - 20 * 86400000 },
];

const REPORT_TEXT = "# 技能仓库同步报告\n\n- 设备：DESK-01\n- 下载 2 · 上传 1 · 冲突 0 · 跳过 0\n\n全部动作已记录。";

// ===== 反代网关样例数据（浏览器预览；桌面端数据来自主进程 SQLite） =====

const PROXY_KEYS = [
  { id: "k1", name: "本地主 Key", mask: "sk-9f2c···d41a", secret: "sk-9f2c1e5b8a4d47c2b6f0e3d1a9c87b52e4f6a0d3c1b2a4e6", route: "auto", dailyQuota: 2000, rateLimit: 0, enabled: true, createdAt: NOW - 12 * 86400000, todayReq: 612, todayTokens: 148200 },
  { id: "k2", name: "Trae 专用", mask: "sk-31bc···77e0", secret: "sk-31bc74f0d9e2a6c8b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a1", route: "trae", dailyQuota: 1000, rateLimit: 0, enabled: true, createdAt: NOW - 9 * 86400000, todayReq: 403, todayTokens: 96400 },
  { id: "k3", name: "WorkBuddy 专用", mask: "sk-d07e···a2c9", secret: "sk-d07e2b8d4f6a9c1e3b5d7f9a2c4e6b8d0f2a4c6e8b1d3f5a", route: "workbuddy", dailyQuota: 800, rateLimit: 60, enabled: true, createdAt: NOW - 5 * 86400000, todayReq: 269, todayTokens: 67800 },
  // 旧版本创建的 Key（无加密存档）：列表不带 secret，不能反查完整 Key
  { id: "k4", name: "旧测试 Key", mask: "sk-4419···0b3f", secret: "", route: "auto", dailyQuota: 100, rateLimit: 0, enabled: false, createdAt: NOW - 30 * 86400000, todayReq: 0, todayTokens: 0 },
];

const PROXY_POOL = [
  {
    id: "trae", display: "Trae SOLO CN", domain: "api.trae.cn", poolStrategy: "expire_first",
    summary: { channel: "trae", totalCredits: 72480, accountCount: 2, onlineCount: 2, earliestExpire: NOW + 48 * 86400000, expiringSoon: false, todayReq: 412, todayTokens: 96400, lastCreditsAt: ago(25) },
    accounts: [
      { id: "a1", channel: "trae", uid: "88213476", name: "主账号 · 沐", status: "online", credits: 51230, creditsAt: ago(25), expiresAt: NOW + 48 * 86400000, coolUntil: 0, coolReason: "", source: "oauth", lastUsed: ago(3), todayReq: 301, todayTokens: 70200, createdAt: NOW - 20 * 86400000, hasToken: true },
      { id: "a2", channel: "trae", uid: "90247811", name: "备用号", status: "online", credits: 21250, creditsAt: ago(25), expiresAt: NOW + 21 * 86400000, coolUntil: 0, coolReason: "", source: "paste", lastUsed: ago(40), todayReq: 111, todayTokens: 26200, createdAt: NOW - 6 * 86400000, hasToken: true },
    ],
  },
  {
    id: "workbuddy", display: "WorkBuddy（中国区）", domain: "copilot.tencent.com", poolStrategy: "credit_first",
    summary: { channel: "workbuddy", totalCredits: 34120, accountCount: 2, onlineCount: 1, earliestExpire: NOW + 12 * 86400000, expiringSoon: false, todayReq: 203, todayTokens: 41200, lastCreditsAt: ago(40) },
    accounts: [
      { id: "a3", channel: "workbuddy", uid: "wb_7c21", name: "工作号", status: "online", credits: 34120, creditsAt: ago(40), expiresAt: NOW + 12 * 86400000, coolUntil: 0, coolReason: "", source: "scan", lastUsed: ago(8), todayReq: 203, todayTokens: 41200, createdAt: NOW - 15 * 86400000, hasToken: true },
      { id: "a4", channel: "workbuddy", uid: "wb_9e05", name: "历史快照", status: "cooling", credits: 0, creditsAt: ago(300), expiresAt: 0, coolUntil: NOW + 42000, coolReason: "上游限流", source: "scan", lastUsed: ago(55), todayReq: 0, todayTokens: 0, createdAt: NOW - 15 * 86400000, hasToken: true },
    ],
  },
  {
    id: "workbuddy_ai", display: "WorkBuddy AI（国际版）", domain: "www.workbuddy.ai", poolStrategy: "expire_first",
    summary: { channel: "workbuddy_ai", totalCredits: 8120, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 33 * 86400000, expiringSoon: false, todayReq: 66, todayTokens: 14800, lastCreditsAt: ago(70) },
    accounts: [
      { id: "a5", channel: "workbuddy_ai", uid: "wba_3d88", name: "Trial 加油包", status: "online", credits: 8120, creditsAt: ago(70), expiresAt: NOW + 33 * 86400000, coolUntil: 0, coolReason: "", source: "paste", lastUsed: ago(30), todayReq: 66, todayTokens: 14800, createdAt: NOW - 4 * 86400000, hasToken: true },
    ],
  },
  {
    id: "raccoon", display: "商汤小浣熊", domain: "xiaohuanxiong.com", poolStrategy: "expire_first",
    summary: { channel: "raccoon", totalCredits: 9800, accountCount: 1, onlineCount: 1, earliestExpire: NOW + 29 * 86400000, expiringSoon: true, todayReq: 18, todayTokens: 5200, lastCreditsAt: ago(12) },
    accounts: [
      { id: "a6", channel: "raccoon", uid: "rc_88213", name: "小浣熊 1 号", status: "online", credits: 9800, creditsAt: ago(12), expiresAt: NOW + 29 * 86400000, coolUntil: 0, coolReason: "", source: "json", lastUsed: ago(9), todayReq: 18, todayTokens: 5200, createdAt: NOW - 3 * 86400000, hasToken: true },
    ],
  },
];

const PROXY_USAGE = [
  { id: 5, ts: NOW - 60000, reqId: "r5", keyId: "k1", keyName: "本地主 Key", channel: "trae", accountId: "a1", accountName: "主账号 · 沐", model: "deepseek-v4-flash", promptTokens: 1204, completionTokens: 3841, ttftMs: 820, latencyMs: 1200, status: 200, error: "" },
  { id: 4, ts: NOW - 89000, reqId: "r4", keyId: "k2", keyName: "Trae 专用", channel: "trae", accountId: "a1", accountName: "主账号 · 沐", model: "glm-4.6", promptTokens: 2010, completionTokens: 6233, ttftMs: 1500, latencyMs: 2800, status: 200, error: "" },
  { id: 3, ts: NOW - 140000, reqId: "r3", keyId: "k3", keyName: "WorkBuddy 专用", channel: "workbuddy", accountId: "a3", accountName: "工作号", model: "claude-sonnet-4.5", promptTokens: 890, completionTokens: 2210, ttftMs: 640, latencyMs: 1900, status: 200, error: "" },
  { id: 2, ts: NOW - 220000, reqId: "r2", keyId: "k1", keyName: "本地主 Key", channel: "workbuddy_ai", accountId: "a5", accountName: "Trial 加油包", model: "gpt-5", promptTokens: 312, completionTokens: 0, ttftMs: 0, latencyMs: 300, status: 429, error: "rate limited" },
  { id: 1, ts: NOW - 310000, reqId: "r1", keyId: "k1", keyName: "本地主 Key", channel: "trae", accountId: "a2", accountName: "备用号", model: "kimi-k2", promptTokens: 1560, completionTokens: 4120, ttftMs: 910, latencyMs: 2400, status: 200, error: "" },
];

const PROXY_TREND = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(NOW - (6 - i) * 86400000);
  return { day: d.toISOString().slice(0, 10), req: [186, 242, 210, 305, 268, 391, 681][i], tokens: [42, 55, 48, 71, 60, 88, 156][i] * 1000 };
});

const PROXY_MODELS = [
  { id: "deepseek-v4-flash", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "DeepSeek-V4-Flash", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "glm-4.6", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "GLM-4.6", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "kimi-k2", object: "model", created: 0, owned_by: "trae", sources: ["trae"], name: "Kimi-K2", rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0, enabled: true, override: "", fallback: "" },
  { id: "claude-sonnet-4.5", object: "model", created: 0, owned_by: "workbuddy", sources: ["workbuddy", "workbuddy_ai"], name: "Claude Sonnet 4.5", rate: 1, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 64000, enabled: true, override: "", fallback: "" },
  { id: "gpt-5", object: "model", created: 0, owned_by: "workbuddy", sources: ["workbuddy", "workbuddy_ai"], name: "GPT-5", rate: 0.5, capabilities: { images: true, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 32000, enabled: true, override: "", fallback: "" },
  { id: "gemini-2.5-pro", object: "model", created: 0, owned_by: "workbuddy_ai", sources: ["workbuddy_ai"], name: "Gemini 2.5 Pro", rate: 0.05, capabilities: { images: true, tools: true }, contextLength: 1000000, maxOutputTokens: 64000, enabled: false, override: "", fallback: "" },
  { id: "raccoon-chat-ml-5-5", object: "model", created: 0, owned_by: "raccoon", sources: ["raccoon"], name: "Raccoon Chat ML 5.5", rate: null, capabilities: { reasoning: true, tools: true }, contextLength: 180000, maxOutputTokens: 80000, enabled: true, override: "", fallback: "" },
];

const PROXY_RULES = [
  { file: "model_map.json", desc: "Trae 模型映射（显示名 → config_name/model_name）", size: 642, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "wb_models.json", desc: "WorkBuddy 双区模型目录（兜底，catalog.json 优先）", size: 318, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "catalog.json", desc: "模型权威目录（拉取模型写回：倍率/能力/上下文，可手编）", size: 2048, mtimeMs: NOW - 3600000, ok: true, error: "" },
  { file: "wb_template_map.json", desc: "WorkBuddy 审核模板最小改写表", size: 274, mtimeMs: NOW - 2 * 86400000, ok: true, error: "" },
  { file: "headers.json", desc: "渠道默认头 / UA / 上游域", size: 1204, mtimeMs: NOW - 86400000, ok: true, error: "" },
];


// ===== 记忆仓库：浏览器预览样例（结构对齐 electron/backend/memory 的真实返回） =====
const MEM_PROJECTS = [
  { slug: "HUIdada1--AgentHub", name: "AgentHub", remotes: ["HUIdada1/AgentHub"], aliases: [], localPaths: ["D:\\private\\AgentHub"], origin: "git", updated: NOW - 3600000, count: 42, l2: 6, latest: NOW - 600000, agents: ["zcode", "codex"] },
  { slug: "wechat-mini-order", name: "微信小程序-订单", remotes: [], aliases: ["wx-order"], localPaths: ["E:\\code\\wx-order"], origin: "fuzzy-auto", updated: NOW - 86400000 * 5, count: 12, l2: 1, latest: NOW - 86400000 * 5, agents: ["zcode"] },
];

const MEM_ROWS = [
  { id: "mem_20260924_ab12cd", path: "projects/HUIdada1--AgentHub/l2/decisions/mem_20260924_ab12cd.md", anchor: null, type: "decision", layer: "l2", title: "索引方案选型", summary: "决定下个版本把索引换成 FTS5，配合 bigram 预分词与外部分量表，检索用 ORDER BY rank。", tags: ["索引", "性能", "FTS5"], project: "HUIdada1--AgentHub", agent: "zcode", created: NOW - 3600000, updated: NOW - 3600000, importance: 4, pinned: true, starred: false, superseded: false, validTo: null, supersededBy: null },
  { id: "mem_20260924_cd34ef", path: "projects/HUIdada1--AgentHub/l1/zcode/2026-09-24.md", anchor: "mem_20260924_cd34ef", type: "daily", layer: "l1", title: "记忆仓库方案讨论", summary: "今天讨论了记忆仓库的架构：MCP 接入、WebDAV 同步、两层记忆与渐进式披露。", tags: ["记忆仓库", "MCP"], project: "HUIdada1--AgentHub", agent: "zcode", created: NOW - 7200000, updated: NOW - 7200000, importance: 3, pinned: false, starred: true, superseded: false, validTo: null, supersededBy: null },
  { id: "mem_20260920_ef56gh", path: "projects/HUIdada1--AgentHub/l1/codex/2026-09-20.md", anchor: "mem_20260920_ef56gh", type: "daily", layer: "l1", title: "MCP 配置注入踩坑", summary: "codex 的 config.toml 已有 [mcp_servers] 父表，注入不能重复写父表，只能文本级行增删。", tags: ["MCP", "Codex"], project: "HUIdada1--AgentHub", agent: "codex", created: NOW - 86400000 * 4, updated: NOW - 86400000 * 4, importance: 3, pinned: false, starred: false, superseded: false, validTo: null, supersededBy: null },
  { id: "mem_20260910_ij78kl", path: "projects/HUIdada1--AgentHub/l2/decisions/mem_20260910_ij78kl.md", anchor: null, type: "decision", layer: "l2", title: "早期索引方案（已失效）", summary: "最初打算用 LIKE 模糊查询做检索。", tags: ["索引"], project: "HUIdada1--AgentHub", agent: "zcode", created: NOW - 86400000 * 14, updated: NOW - 86400000 * 14, importance: 2, pinned: false, starred: false, superseded: true, validTo: NOW - 3600000, supersededBy: "mem_20260924_ab12cd" },
];

const MEM_DIGEST_TEXT = [
  "# 记忆索引摘要",
  "共 2 个项目 / 54 条记忆",
  "",
  "## HUIdada1--AgentHub（42 条，最近 2026-09-24）",
  "- 索引方案选型 — 决定下个版本把索引换成 FTS5…（2026-09-24）",
  "- 记忆仓库方案讨论 — 今天讨论了记忆仓库的架构…（2026-09-24）",
  "## wechat-mini-order（12 条，最近 2026-09-19）",
  "- 订单页重构 — 把结算逻辑抽成 composable…（2026-09-19）",
].join("\n");

const MEM_AGENTS = [
  { id: "zcode", name: "ZCode", enabled: true, note: "", configPath: "C:\\Users\\demo\\.zcode\\cli\\config.json", configExists: true, format: "json-mcp.servers", snippetHint: "写入 ~/.zcode/cli/config.json 的 mcp.servers", instructionPath: "C:\\Users\\demo\\.zcode\\AGENTS.md", instructionExists: true, injected: true, verifyConfig: { ok: true, message: "已配置" }, beat: { lastCall: NOW - 600000, calls: 8, writes: 12, searches: 31, errors: 0, lastTool: "memory_search" }, pathReady: true },
  { id: "codex", name: "Codex CLI", enabled: true, note: "", configPath: "C:\\Users\\demo\\.codex\\config.toml", configExists: true, format: "toml-mcp_servers", snippetHint: "写入 ~/.codex/config.toml 的 [mcp_servers.agenthub-memory]", instructionPath: "C:\\Users\\demo\\.codex\\AGENTS.md", instructionExists: true, injected: true, verifyConfig: { ok: true, message: "已配置" }, beat: null, pathReady: true },
  { id: "workbuddy", name: "WorkBuddy", enabled: true, note: "", configPath: "C:\\Users\\demo\\.workbuddy-ai\\mcp.json", configExists: true, format: "json-mcpServers", snippetHint: "写入 ~/.workbuddy-ai/mcp.json 的 mcpServers", instructionPath: "C:\\Users\\demo\\.workbuddy-ai\\AGENTS.md", instructionExists: false, injected: false, verifyConfig: { ok: false, message: "配置文件中没有 agenthub-memory 条目" }, beat: null, pathReady: true },
  { id: "claude", name: "Claude Code", enabled: true, note: "Claude Code 不直接读 AGENTS.md，受控块写 CLAUDE.md", configPath: "C:\\Users\\demo\\.claude.json", configExists: true, format: "json-mcpServers", snippetHint: "写入 ~/.claude.json 的 mcpServers", instructionPath: "C:\\Users\\demo\\.claude\\CLAUDE.md", instructionExists: true, injected: false, verifyConfig: { ok: false, message: "配置文件中没有 agenthub-memory 条目" }, beat: null, pathReady: true },
];

export const mock = {
  async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      // ===== 框架 =====
      case "load_config":
        return read();
      case "save_config":
        localStorage.setItem(KEY, JSON.stringify(args?.config ?? {}));
        return { ok: true, message: "设置保存成功" };
      case "get_app_version":
        return "0.1.0";
      case "get_data_dir":
        return "(浏览器预览)";
      case "open_data_dir":
      case "open_hub_dir":
        return;
      case "get_hub_dir":
        return "C:\\Users\\demo\\.agent_skills";
      case "browse_dir":
        return { ok: true, canceled: true, path: null };

      // ===== 更新 =====
      case "get_update_status":
        return previewStatus("idle");
      case "check_update":
        return previewStatus("available");
      case "download_update":
        return previewStatus("downloaded");
      case "install_update":
        return previewStatus("idle");
      case "open_release_page":
      case "open_repo_page":
        return;
      case "get_is_portable":
        return false;

      // ===== 记忆仓库（浏览器预览：样例数据，结构对齐真实返回） =====
      case "memory_config_get":
        // 浏览器预览也要有 schema：配置页的自动表单由元数据驱动，空 schema 会只剩「模型与网关」一个子板块
        return {
          config: {
            storage: { root: "C:\\Users\\demo\\AgentHub\\memory", atomicWrite: true, backupBeforeWrite: true, backupKeep: 5, maxFileSizeKB: 512, trashKeepDays: 90 },
            index: { dualIndex: true, titleBoost: 3, debounceMs: 2000 },
            search: { recallTopK: 20, finalTopK: 8, timeDecayHalfLife: 30, synonymsEnabled: true, graphExpansionDepth: 1, graphExpansionMax: 5 },
            classify: { fuzzyThreshold: 0.62, gitPreferred: true, autoCreateProject: false, pathReverse: true },
            agents: { enabled: ["zcode", "codex", "workbuddy", "claude"], custom: [], autoVerify: true, verifyInterval: 300, injectAgentsMd: true, coreMaxTokens: 800, digestMaxLines: 200, searchMaxTokens: 1200 },
            deep: { enabled: true, batchSize: 50, personaEnabled: true, personaMinMemories: 30, evidenceRequired: true, distillMaxPerProject: 200 },
            timeline: { enabled: true, autoDetect: true, requireConfirm: true },
            auto: { enabled: true, dailyTokenLimit: 200000, overBudgetAction: "pause", logKeepDays: 30, logKeepCount: 200, tasks: {} },
            dedup: { enabled: true, l1: { enabled: true, normalizeLevel: "full" }, l2: { enabled: true, autoMergeThreshold: 0.9, candidateThreshold: 0.72 }, l3: { topK: 8 }, l4: { enabled: true, autoUpdateThreshold: 0.8, autoDelete: false }, duplicateIdentityTypes: ["incident", "fix", "daily", "log"], pendingWarnThreshold: 50 },
            import: { dryRunFirst: true, batchSize: 200, maxBatchBytes: 104857600, sensitiveSkip: true, md: { observationMarkers: true, extractTags: true }, sources: [] },
            privacy: { redact: false, pause: false, localOnlyProjects: [] },
            sync: { enabled: true, auto: true, intervalMin: 60, packSizeLimitMB: 50, excludeIndex: true },
            ui: { pageSize: 50, defaultTab: "dashboard", realtimeRefresh: true },
          },
          schema: {
            "storage.root": { type: "path", def: "", label: "记忆根目录", group: "存储", hot: false, desc: "空 = 默认 <用户文件夹>/AgentHub/memory" },
            "storage.atomicWrite": { type: "boolean", def: true, label: "原子写", group: "存储", hot: true },
            "storage.backupBeforeWrite": { type: "boolean", def: true, label: "改写前备份 .bak", group: "存储", hot: true },
            "storage.backupKeep": { type: "number", def: 5, min: 1, max: 50, label: "备份保留份数", group: "存储", hot: true },
            "storage.maxFileSizeKB": { type: "number", def: 512, min: 16, max: 8192, label: "单文件上限 (KB)", group: "存储", hot: true },
            "storage.trashKeepDays": { type: "number", def: 90, min: 7, max: 365, label: "回收站保留天数", group: "存储", hot: true },
            "index.dualIndex": { type: "boolean", def: true, label: "双索引（保真+标题加权）", group: "索引", hot: false },
            "index.titleBoost": { type: "number", def: 3, min: 1, max: 10, label: "标题权重倍数", group: "索引", hot: false },
            "index.debounceMs": { type: "number", def: 2000, min: 200, max: 60000, label: "索引增量防抖 (ms)", group: "索引", hot: true },
            "search.finalTopK": { type: "number", def: 8, min: 1, max: 50, label: "最终返回条数", group: "检索", hot: true },
            "search.timeDecayHalfLife": { type: "number", def: 30, min: 0, max: 365, label: "时间衰减半衰期（天）", group: "检索", hot: true },
            "search.synonymsEnabled": { type: "boolean", def: true, label: "同义词表扩展", group: "检索", hot: true },
            "classify.fuzzyThreshold": { type: "number", def: 0.62, min: 0.3, max: 1, step: 0.01, label: "模糊匹配阈值", group: "归类", hot: true },
            "agents.coreMaxTokens": { type: "number", def: 800, min: 200, max: 2000, label: "memory_core token 上限", group: "Agent 接入", hot: true },
            "agents.digestMaxLines": { type: "number", def: 200, min: 50, max: 1000, label: "memory_digest 行数上限", group: "Agent 接入", hot: true },
            "agents.verifyInterval": { type: "number", def: 300, min: 30, max: 3600, label: "连接巡检间隔（秒）", group: "Agent 接入", hot: true },
            "deep.enabled": { type: "boolean", def: true, label: "深层记忆总开关", group: "深层记忆", hot: true },
            "deep.personaMinMemories": { type: "number", def: 30, min: 5, max: 500, label: "画像最少记忆数", group: "深层记忆", hot: true },
            "timeline.requireConfirm": { type: "boolean", def: true, label: "失效判定需人工确认", group: "深层记忆", hot: true },
            "auto.enabled": { type: "boolean", def: true, label: "自动化总开关", group: "自动化", hot: true },
            "auto.dailyTokenLimit": { type: "number", def: 200000, min: 0, label: "日 token 预算（0=不限）", group: "自动化", hot: true },
            "auto.overBudgetAction": { type: "enum", def: "pause", options: ["pause", "ignore"], label: "超预算行为", group: "自动化", hot: true },
            "dedup.l2.autoMergeThreshold": { type: "number", def: 0.9, min: 0.5, max: 1, step: 0.01, label: "L2 自动合并阈值", group: "去重", hot: true },
            "dedup.l4.enabled": { type: "boolean", def: true, label: "L4 语义判定（耗 token）", group: "去重", hot: true },
            "dedup.l4.autoDelete": { type: "boolean", def: false, label: "允许自动删除（默认永久关闭）", group: "去重", hot: true },
            "import.dryRunFirst": { type: "boolean", def: true, label: "导入前必须干跑预览", group: "导入", hot: true },
            "import.batchSize": { type: "number", def: 200, min: 20, max: 2000, label: "每批写入条数", group: "导入", hot: true },
            "privacy.redact": { type: "boolean", def: false, label: "写入前脱敏", group: "隐私", hot: true },
            "privacy.pause": { type: "boolean", def: false, label: "隐私模式（暂停一切采集）", group: "隐私", hot: true },
            "sync.auto": { type: "boolean", def: true, label: "自动定时同步", group: "同步", hot: true },
            "sync.intervalMin": { type: "number", def: 60, min: 5, max: 1440, label: "同步间隔（分钟）", group: "同步", hot: true },
            "sync.excludeIndex": { type: "boolean", def: true, label: "索引库不入同步包", group: "同步", hot: true },
            "ui.pageSize": { type: "number", def: 50, min: 10, max: 500, label: "列表每页条数", group: "界面", hot: true },
            "ui.defaultTab": { type: "enum", def: "dashboard", options: ["dashboard", "browse", "projects", "profile", "agents", "index", "auto", "import", "sync"], label: "默认页签", group: "界面", hot: true },
            "ui.realtimeRefresh": { type: "boolean", def: true, label: "浏览页实时刷新", group: "界面", hot: true },
          },
          root: "C:\\Users\\demo\\AgentHub\\memory",
          diff: [{ key: "search.timeDecayHalfLife", value: 90, default: 30 }],
        };
      case "memory_config_save":
      case "memory_config_reset":
      case "memory_config_import":
        return { ok: true, applied: 0 };
      case "memory_config_export":
        return { ok: true, json: "{}" };
      case "memory_root_get":
        return { root: "C:\\Users\\demo\\AgentHub\\memory", defaultRoot: "C:\\Users\\demo\\AgentHub\\memory" };
      case "memory_root_set":
        return { ok: true, root: String(args?.dir || ""), migrated: !!args?.migrate };
      case "memory_status":
        return { enabled: true, root: "C:\\Users\\demo\\AgentHub\\memory", bridge: { running: true, port: 53842, tokenReady: true, pid: 1234 }, index: { rows: MEM_ROWS.length, fts: MEM_ROWS.length, ftsW: MEM_ROWS.length, consistent: true, projects: 2, today: 2, pending: 3, sizeBytes: 1560000, walBytes: 0, lastBuildAt: NOW - 7200000, lastScanAt: NOW - 60000, rootDir: "C:\\Users\\demo\\AgentHub\\memory" }, verifiedAgents: 1, beats: [{ agent: "zcode", last_call: NOW - 600000, calls: 8, writes: 12, searches: 31, errors: 0, last_tool: "memory_search" }] };
      case "memory_toggle":
        return { ok: true, enabled: !!args?.enabled };
      case "memory_costs_estimate":
        return { estimates: { extract: "每批 20 条约 800 token", distill: "每项目约 3,000 token", profile: "每次约 8,000 token" } };
      case "memory_stats":
        return { total: MEM_ROWS.length, projects: 2, today: 2, yesterday: 1, pending: 3, l2: 2, agents: 1, indexBytes: 1560000, llmToday: 12340, llmCalls: 412 };
      case "memory_list": {
        // 与真实后端同口径的筛选+分页：预览环境若不模拟，筛选/分页/边界 bug 在浏览器里全不可见
        let rows = [...MEM_ROWS] as Record<string, unknown>[];
        if (args?.project) rows = rows.filter((r) => r.project === args.project);
        if (args?.agent) rows = rows.filter((r) => r.agent === args.agent);
        if (args?.layer) rows = rows.filter((r) => r.layer === args.layer);
        if (args?.type) rows = rows.filter((r) => r.type === args.type);
        if (args?.tag) rows = rows.filter((r) => String(r.tags || "").includes(String(args.tag)));
        if (args?.starred) rows = rows.filter((r) => r.starred);
        if (args?.pinned) rows = rows.filter((r) => r.pinned);
        const pageSize = Math.max(1, Number(args?.pageSize) || 50);
        const page = Math.max(0, Number(args?.page) || 0);
        return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), total: rows.length, page, pageSize };
      }
      case "memory_get":
        return { memory: { ...MEM_ROWS[0], body: "决定下个版本把索引换成 FTS5，配合 bigram 预分词与外部分量表，检索用 ORDER BY rank。\n\n另：批量写入必须包事务。" }, related: [{ id: MEM_ROWS[1].id, title: MEM_ROWS[1].title, summary: MEM_ROWS[1].summary }], timeline: [{ id: MEM_ROWS[3].id, title: MEM_ROWS[3].title, created: MEM_ROWS[3].created, validTo: NOW - 3600000, supersededBy: MEM_ROWS[0].id, current: false }, { id: MEM_ROWS[0].id, title: MEM_ROWS[0].title, created: MEM_ROWS[0].created, validTo: null, supersededBy: null, current: true }] };
      case "memory_write":
        return { ok: true, id: "mem_preview_new", path: "projects/HUIdada1--AgentHub/l1/zcode/2026-09-24.md", anchor: "mem_preview_new", project: "HUIdada1--AgentHub" };
      case "memory_update":
        return { ok: true, id: String(args?.id || "") };
      case "memory_delete":
      case "memory_pin":
      case "memory_star":
        return { ok: true };
      case "memory_recent":
        return { rows: MEM_ROWS.slice(0, 3) };
      case "memory_heatmap":
        return { days: Array.from({ length: 120 }, (_, i) => ({ day: new Date(NOW - i * 86400000).toISOString().slice(0, 10), count: (i * 7) % 11 })) };
      case "memory_tags":
        return { tags: [{ name: "索引", count: 12 }, { name: "MCP", count: 9 }, { name: "性能", count: 6 }] };
      case "memory_trash_list":
        return { items: [{ name: "1758672000000-projects__HUIdada1--AgentHub__l1__zcode__2026-09-18.md", trashedAt: NOW - 86400000, originPath: "projects/HUIdada1--AgentHub/l1/zcode/2026-09-18.md", size: 812 }] };
      case "memory_trash_restore":
        return { ok: true };
      case "memory_trash_purge":
        return { removed: 0 };
      case "memory_projects":
        return { projects: MEM_PROJECTS, general: { count: 8, latest: NOW - 10800000 } };
      case "memory_project_detail":
        return { project: MEM_PROJECTS[0], agents: [{ agent: "zcode", c: 30 }, { agent: "codex", c: 12 }], files: [{ path: "projects/HUIdada1--AgentHub/l1/zcode/2026-09-24.md", c: 3 }] };
      case "memory_project_merge":
        return { ok: true, moved: 0 };
      case "memory_project_rename":
      case "memory_project_confirm":
      case "memory_project_assign":
        return { ok: true, moved: 0 };
      case "memory_project_suggest":
        return { items: [{ id: "rq_1", slug: "HUIdada1--AgentHub", name: "AgentHub", score: 0.79, candidate: "记忆仓库设计", memoryId: MEM_ROWS[1].id, title: MEM_ROWS[1].title, path: MEM_ROWS[1].path }] };
      case "memory_index_status":
        return { rows: MEM_ROWS.length, fts: MEM_ROWS.length, ftsW: MEM_ROWS.length, consistent: true, projects: 2, today: 2, pending: 3, sizeBytes: 1560000, walBytes: 20480, lastBuildAt: NOW - 7200000, lastScanAt: NOW - 60000, rootDir: "C:\\Users\\demo\\AgentHub\\memory" };
      case "memory_index_build":
        return { ok: true, files: MEM_ROWS.length, pruned: 0, tookMs: 1163 };
      case "memory_index_rebuild":
        return { ok: true, files: MEM_ROWS.length, tookMs: 1163 };
      case "memory_index_diagnose":
        return { diagnose: { orphanRows: [], unindexed: [], fts: { rebuilt: false } }, graph: { nodes: MEM_ROWS.length, edges: 3, broken: 0, isolated: 1 } };
      case "memory_index_vacuum":
        return { ok: true, before: 1560000, after: 1502000 };
      case "memory_search":
        return { results: MEM_ROWS, total: MEM_ROWS.length, tookMs: 2.3, text: "（预览模式）检索结果见列表" };
      case "memory_search_debug":
        return { tokens: ["索引", "引方", "方案"], synonyms: { "索引": ["index", "fts5"] }, tookMs: 2.3, total: MEM_ROWS.length, results: MEM_ROWS.map((r, i) => ({ ...r, scoreParts: { bm25: 8.2 - i, recency: 1, importance: 1.4, affinity: 1.05, layer: 1.2, graph: 1.6 } })), explain: "评分 = BM25×0.5 + 时间衰减×0.15 + 重要度×0.1 + 亲和×0.15 + 图层×0.05 + 置顶加成" };
      case "memory_token_estimate":
        return { per: [412, 800], total: 1212, note: "按 CJK≈1 token/字、ASCII≈0.25 token/字符估算，非计费值" };
      case "memory_graph_stats":
        return { nodes: MEM_ROWS.length, edges: 3, broken: 0, isolated: 1 };
      case "memory_digest":
        return { rows: MEM_ROWS.map((r) => ({ project: r.project, title: r.title, summary: r.summary, created: r.created, tags: r.tags.join(",") })), counts: [{ p: "HUIdada1--AgentHub", c: 42, latest: NOW - 3600000 }], limit: 200, text: MEM_DIGEST_TEXT, lines: 8 };
      case "memory_timeline":
        return { chain: [{ id: MEM_ROWS[3].id, title: MEM_ROWS[3].title, created: MEM_ROWS[3].created, validTo: NOW - 3600000, supersededBy: MEM_ROWS[0].id, current: false }, { id: MEM_ROWS[0].id, title: MEM_ROWS[0].title, created: MEM_ROWS[0].created, validTo: null, supersededBy: null, current: true }], text: "mem_20260910_ij78kl 早期索引方案（已失效）\n  ↑ 被取代于 mem_20260924_ab12cd 索引方案选型（当前有效）" };
      case "memory_supersede":
        return { ok: true, id: String(args?.id || "") };
      case "memory_agents_list":
        return { agents: MEM_AGENTS, command: { command: "C:\\Program Files\\AgentHub\\AgentHub.exe", args: ["C:\\Program Files\\AgentHub\\resources\\mcp\\mcp-memory-server.cjs"], env: { ELECTRON_RUN_AS_NODE: "1" }, hostExists: true, bridgeExists: true }, bridge: { running: true, port: 53842 } };
      case "memory_agent_verify": {
        const id = String(args?.id || "zcode");
        return { agent: id, name: id, level: args?.skipHandshake ? "configured" : "verified", config: { ok: true, message: "已配置" }, handshake: { ok: !args?.skipHandshake, latencyMs: 42, tools: 11 }, real: { ok: id === "zcode", calls: 8 }, command: { command: "C:\\Program Files\\AgentHub\\AgentHub.exe", args: [], env: {}, hostExists: true, bridgeExists: true }, configPath: "", instructionPath: "", instructionInjected: true };
      }
      case "memory_agent_verify_all":
        return MEM_AGENTS.map((a) => ({ agent: a.id, name: a.name, level: a.injected ? "handshaked" : "detected", config: a.verifyConfig, handshake: { ok: a.injected, latencyMs: 42, tools: 11 }, real: { ok: !!a.beat }, command: { command: "", args: [], env: {}, hostExists: true, bridgeExists: true }, configPath: a.configPath, instructionPath: a.instructionPath, instructionInjected: a.injected }));
      case "memory_agent_inject":
        return { ok: true, steps: [{ ok: true, action: "injected", file: "C:\\Users\\demo\\.zcode\\cli\\config.json" }, { ok: true, action: "appended", file: "C:\\Users\\demo\\.zcode\\AGENTS.md" }], configPath: "", instructionPath: "" };
      case "memory_agent_uninject":
        return { ok: true, steps: [] };
      case "memory_agent_snippet":
        return { ok: true, json: "{\n  \"mcpServers\": {\n    \"agenthub-memory\": {\n      \"type\": \"stdio\",\n      \"command\": \"C:\\\\Program Files\\\\AgentHub\\\\AgentHub.exe\",\n      \"args\": [\"C:\\\\Program Files\\\\AgentHub\\\\resources\\\\mcp\\\\mcp-memory-server.cjs\"],\n      \"env\": { \"ELECTRON_RUN_AS_NODE\": \"1\" }\n    }\n  }\n}", toml: "[mcp_servers.agenthub-memory]\ncommand = \"AgentHub.exe\"\nargs = [\"mcp-memory-server.cjs\"]", cli: "AgentHub.exe mcp-memory-server.cjs", instruction: "<!-- agenthub-memory:begin -->\n## 记忆仓库（AgentHub · 本机项目记忆）\n- 会话开始先调用 memory_core。\n<!-- agenthub-memory:end -->", command: { command: "AgentHub.exe", args: [], hostExists: true, bridgeExists: true }, configPath: "", instructionPath: "", hint: "写入 ~/.zcode/cli/config.json 的 mcp.servers" };
      case "memory_agent_custom_save":
        return { ok: true, id: "custom-preview" };
      case "memory_agents_tools":
        return { tools: [
          { name: "memory_core", description: "取核心记忆（画像+项目）", readOnly: true, destructive: false, idempotent: true, openWorld: false },
          { name: "memory_digest", description: "取摘要索引（≤200 行）", readOnly: true, destructive: false, idempotent: true, openWorld: false },
          { name: "memory_search", description: "检索（返回摘要，省 token）", readOnly: true, destructive: false, idempotent: true, openWorld: false },
          { name: "memory_get", description: "取单条全文", readOnly: true, destructive: false, idempotent: true, openWorld: false },
          { name: "memory_write", description: "写入记忆", readOnly: false, destructive: false, idempotent: true, openWorld: false },
          { name: "memory_forget", description: "删除（进回收站）", readOnly: false, destructive: true, idempotent: false, openWorld: false },
        ] };
      case "memory_bridge_status":
        return { bridge: { running: true, port: 53842 }, root: "C:\\Users\\demo\\AgentHub\\memory" };
      case "memory_bridge_restart":
        return { ok: true, port: 53843 };
      case "memory_reports_list":
        return { reports: [{ name: "distill-2026-09-24.md", size: 2048, mtime: NOW - 3600000 }] };
      case "memory_report_read":
        return { name: String(args?.name || ""), content: "# 蒸馏报告\n\n（预览模式样例）" };
      case "memory_export":
        return { content: "（预览模式）导出内容", files: MEM_ROWS.length };
      case "memory_export_zip":
        return { file: "C:\\Users\\demo\\AppData\\Roaming\\AgentHub\\memory-export\\memory-backup.tar.gz", files: 12, bytes: 128000 };
      case "memory_open_dir":
        return { path: "C:\\Users\\demo\\AgentHub\\memory" };

      // ===== 记忆仓库：模型与网关 / 自动化 / 同步 / 去重 / 导入（预览样例） =====
      case "memory_provider_list":
        return { providers: [
          { id: "gw-local", name: "本机网关（AgentHub 反代）", kind: "gateway", baseUrl: "http://127.0.0.1:9527/v1", apiFormat: "chat_completions", apiKeyMasked: "", hasKey: false, enabled: true, note: "", status: "online", lastCheck: { at: NOW - 600000, ok: true, latencyMs: 412 }, modelCount: 2, enabledModelCount: 2, isGateway: true },
          { id: "prov_demo", name: "我的中转站", kind: "custom", baseUrl: "https://api.example.com", apiFormat: "anthropic_messages", apiKeyMasked: "••••••••sk-4f2a", hasKey: true, enabled: true, note: "", status: "offline", lastCheck: { at: NOW - 3600000, ok: false, latencyMs: 890 }, modelCount: 1, enabledModelCount: 1, isGateway: false },
        ] };
      case "memory_gateway_list":
        return { gateways: [
          { id: "gw-local", name: "本机网关（AgentHub 反代）", baseUrl: "http://127.0.0.1:9527/v1", available: true, urlOverride: "", modelCount: 2, enabledModelCount: 2, fallbackModel: "gpt-4o-mini" },
        ] };
      case "memory_provider_save":
        return { ok: true, id: String((args?.id as string) || "prov_preview") };
      case "memory_provider_delete":
        return { ok: true, removedModels: 2 };
      case "memory_provider_test":
        return {
          ok: true,
          l1: { ok: true, latencyMs: 412, status: 200 },
          l2: { ok: true, models: 18, message: "已识别 18 个模型" },
          l3: { ok: false, status: 404, message: "HTTP 404：{\"error\":\"not_found\"}" },
          suggestion: { apiFormat: "anthropic_messages", reason: "路径不存在（许多中转载体的 Claude 上游只提供 /v1/messages）" },
        };
      case "memory_provider_fetch_models":
        return { ok: true, models: [
          { id: "gpt-4o", tags: ["heavy", "summarize", "distill", "profile", "supersede", "consolidate"], reasoning: { enabled: false, effort: "minimal" }, caps: { vision: true, tools: true } },
          { id: "gpt-4o-mini", tags: ["light", "dedup", "classify", "tag", "extract"], reasoning: { enabled: false, effort: "minimal" }, caps: { vision: true, tools: true } },
          { id: "o3-mini", tags: ["heavy", "distill"], reasoning: { enabled: true, effort: "medium" }, caps: { tools: true } },
        ] };
      case "memory_provider_quirks":
        return { memo: { prov_demo: { supportsReasoningEffort: false, dropped: { reasoning_effort: true } } }, log: [] };
      case "memory_model_list":
        return { models: [
          { id: "m1", providerId: "gw-local", modelId: "gpt-4o-mini", displayName: "轻量（去重/抽取）", enabled: true, reasoning: { enabled: false, effort: "minimal", customBudget: null }, tags: ["light", "dedup", "extract"], priority: 10, temperature: 0.2, maxTokens: 2048 },
          { id: "m2", providerId: "gw-local", modelId: "gpt-4o", displayName: "重型（总结/蒸馏）", enabled: true, reasoning: { enabled: true, effort: "medium", customBudget: null }, tags: ["heavy", "distill", "profile"], priority: 20, temperature: 0.2, maxTokens: 4096 },
          { id: "m3", providerId: "prov_demo", modelId: "claude-3-5-sonnet", displayName: "Sonnet", enabled: true, reasoning: { enabled: true, effort: "high", customBudget: 8192 }, tags: ["heavy", "profile"], priority: 30, temperature: 0.2, maxTokens: 4096 },
        ] };
      case "memory_model_save":
      case "memory_model_delete":
      case "memory_model_batch":
        return { ok: true, id: "m_preview", changed: 1 };
      case "memory_model_toggle":
        return { ok: true, enabled: !!args?.enabled };
      case "memory_model_probe":
        return { ok: true, caps: { vision: true, tools: true, stream: true, jsonMode: true, contextWindow: 128000, lastProbe: { at: NOW, ok: true, sample: "ok" } } };
      case "memory_llm_sources":
        return { order: ["custom", "gateway", "degrade"], tagDefs: ["light", "heavy", "dedup", "classify", "distill", "extract", "tag", "summarize", "profile", "supersede", "consolidate"], sources: [{ key: "custom", available: true, detail: "1 个已启用供应商" }, { key: "gateway", available: true, detail: "本机网关在线" }, { key: "degrade", available: true, detail: "全部失败时的兜底" }], routing: [{ task: "extract", providerId: "gw-local" }, { task: "distill", providerId: "prov_demo", modelId: "claude-3-5-sonnet" }], taskEffort: { extract: "low", tag: "minimal", classify: "minimal", summarize: "low", distill: "medium", profile: "high", dedup: "low" }, degrade: { enabled: true, providerId: "prov_demo", modelId: "claude-3-5-sonnet", effort: "minimal" } };
      case "memory_llm_sources_save":
      case "memory_llm_routing_save":
        return { ok: true };
      case "memory_llm_routing":
        return { routing: [
          { task: "extract", tags: ["extract", "light"], effort: "low", providerId: "gw-local", chain: [{ providerId: "gw-local", providerName: "本机网关", modelId: "gpt-4o-mini", priority: 10, source: "gateway" }] },
          { task: "summarize", tags: ["summarize", "heavy"], effort: "low", chain: [{ providerId: "prov_demo", providerName: "我的中转站", modelId: "claude-3-5-sonnet", priority: 30, source: "custom" }] },
          { task: "supersede", tags: ["supersede", "classify"], effort: "", providerId: "prov_demo", modelId: "claude-3-5-sonnet", chain: [{ providerId: "prov_demo", providerName: "我的中转站", modelId: "claude-3-5-sonnet", priority: 30, source: "custom" }] },
          { task: "distill", tags: ["distill", "heavy"], effort: "medium", providerId: "prov_demo", modelId: "claude-3-5-sonnet", chain: [{ providerId: "prov_demo", providerName: "我的中转站", modelId: "claude-3-5-sonnet", priority: 30, source: "custom" }] },
          { task: "consolidate", tags: ["consolidate", "summarize", "distill"], effort: "", chain: [{ providerId: "prov_demo", providerName: "我的中转站", modelId: "claude-3-5-sonnet", priority: 30, source: "custom" }] },
          { task: "profile", tags: ["profile", "heavy"], effort: "high", chain: [{ providerId: "prov_demo", providerName: "我的中转站", modelId: "claude-3-5-sonnet", priority: 30, source: "custom" }] },
          { task: "dedup", tags: ["dedup", "light"], effort: "low", chain: [{ providerId: "gw-local", providerName: "本机网关", modelId: "gpt-4o-mini", priority: 10, source: "gateway" }] },
          { task: "tag", tags: ["tag", "light"], effort: "minimal", chain: [] },
          { task: "classify", tags: ["classify", "light"], effort: "minimal", chain: [] },
        ] };
      case "memory_llm_test_call":
        return { ok: true, latencyMs: 812, text: "ok", providerId: "gw-local", modelId: String(args?.modelId || "gpt-4o-mini"), effort: String(args?.effort || "minimal"), usage: { input: 12, output: 2 } };
      case "memory_llm_usage":
        return { usage: [
          { provider: "gw-local", model: "gpt-4o-mini", task: "extract", calls: 62, tokensIn: 41200, tokensOut: 9800, successRate: 0.982 },
          { provider: "gw-local", model: "gpt-4o", task: "distill", calls: 12, tokensIn: 30100, tokensOut: 12400, successRate: 0.991 },
        ], today: { tokens: 12340, calls: 412 } };
      case "memory_auto_status":
        return {
          enabled: true, paused: false, pausedUntil: 0, running: null, queue: [],
          todayTokens: 12340, todayCalls: 412, dailyTokenLimit: 200000, overBudget: false,
          pending: { unprocessed: 137, classified: 3, review: 7, dedup: 14 },
          tasks: [
            { id: "extract", name: "抽取结构化信息", needsModel: true, estimate: "每批 20 条约 800 token", enabled: true, intervalMin: 30, daily: null, weekly: null, weeklyTime: null, batchSize: 20, thresholdCount: 20, lastAt: NOW - 720000, nextAt: NOW + 1080000, successRate: 98.2, runs: 62, tokens: 42180 },
            { id: "summarize", name: "生成摘要", needsModel: true, estimate: "每批 20 条约 600 token", enabled: false, intervalMin: 30, daily: null, weekly: null, weeklyTime: null, batchSize: 20, thresholdCount: null, lastAt: 0, nextAt: NOW + 1800000, successRate: null, runs: 0, tokens: 0 },
            { id: "tag", name: "自动打标签", needsModel: true, estimate: "每批 20 条约 400 token", enabled: false, intervalMin: 30, daily: null, weekly: null, weeklyTime: null, batchSize: 20, thresholdCount: null, lastAt: 0, nextAt: NOW + 1800000, successRate: null, runs: 0, tokens: 0 },
            { id: "classify", name: "项目归类建议", needsModel: false, estimate: "0（本地算法）", enabled: true, intervalMin: 60, daily: null, weekly: null, weeklyTime: null, batchSize: null, thresholdCount: null, lastAt: NOW - 180000, nextAt: NOW + 3420000, successRate: 100, runs: 31, tokens: 0 },
            { id: "supersede", name: "失效判定", needsModel: true, estimate: "每组约 1,500 token", enabled: false, daily: "23:00", weekly: null, weeklyTime: null, batchSize: null, thresholdCount: null, lastAt: 0, nextAt: NOW + 43200000, successRate: null, runs: 0, tokens: 0 },
            { id: "distill", name: "L2 蒸馏", needsModel: true, estimate: "每项目约 3,000 token", enabled: false, daily: "23:30", weekly: null, weeklyTime: null, batchSize: null, thresholdCount: null, lastAt: 0, nextAt: NOW + 46800000, successRate: null, runs: 0, tokens: 0 },
            { id: "consolidate", name: "去重合并", needsModel: true, estimate: "每轮约 5,000 token", enabled: false, daily: null, weekly: 0, weeklyTime: "02:00", batchSize: null, thresholdCount: null, lastAt: 0, nextAt: NOW + 172800000, successRate: null, runs: 0, tokens: 0 },
            { id: "profile", name: "人格 / 偏好画像", needsModel: true, estimate: "每次约 8,000 token", enabled: false, daily: null, weekly: 0, weeklyTime: "03:00", batchSize: null, thresholdCount: null, lastAt: 0, nextAt: NOW + 176400000, successRate: null, runs: 0, tokens: 0 },
            { id: "index-scan", name: "索引自愈扫描", needsModel: false, estimate: "0（本地扫描）", enabled: true, intervalMin: 360, daily: null, weekly: null, weeklyTime: null, batchSize: null, thresholdCount: null, lastAt: NOW - 3600000, nextAt: NOW + 18000000, successRate: 100, runs: 8, tokens: 0 },
          ],
        };
      case "memory_auto_timeline":
        return { entries: [
          { task: "extract", at: NOW - 720000, ok: true, ms: 3200, tokens: 812, detail: "处理 20 条，更新 18 条" },
          { task: "index-scan", at: NOW - 3600000, ok: true, ms: 400, tokens: 0, detail: "扫描 42 个文件，补索引 0 条" },
          { task: "classify", at: NOW - 1800000, ok: true, ms: 200, tokens: 0, detail: "扫描 12 条未归类，产出 3 条建议" },
          { task: "distill", at: NOW - 86400000, ok: false, ms: 1200, tokens: 0, detail: "没有可用于任务「distill」的模型" },
        ] };
      case "memory_auto_task_run":
        return { ok: true, task: String(args?.id || ""), tokens: 0, ms: 320, detail: "（预览模式）任务已执行" };
      case "memory_auto_task_save":
      case "memory_auto_cancel":
        return { ok: true };
      case "memory_auto_pause":
        return { paused: !args?.resume };
      case "memory_auto_cost":
        return { today: 12340, todayCalls: 412, month: 158900, limit: 200000, byTask: [{ task: "extract", tokens: 42180 }, { task: "summarize", tokens: 14220 }, { task: "distill", tokens: 10200 }, { task: "tag", tokens: 1340 }], estimates: { extract: "每批 20 条约 800 token" } };
      case "memory_auto_report":
        return { ok: true, file: "C:\\Users\\demo\\AgentHub\\memory\\reports\\auto-2026-09-24.md" };
      case "memory_distill_run":
      case "memory_profile_generate":
        return { processed: 3, updated: 2, tokens: 3041, detail: "（预览模式）蒸馏/画像已完成" };
      case "memory_profile_get":
        return { sections: [
          { name: "persona", path: "profile/persona.md", exists: true, text: "<!-- 本文件由 AgentHub 记忆仓库生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->\n- 偏好第一性原理\n  证据 [3]：mem_20260912_a1, mem_20260918_b3, mem_20260924_c7\n- KISS 至上\n  证据 [5]：mem_20260901_x1, mem_20260902_x2, mem_20260903_x3, mem_20260904_x4, mem_20260905_x5\n- 事实为本\n  证据 [2]：mem_20260910_y1, mem_20260911_y2\n" },
          { name: "preferences", path: "profile/preferences.md", exists: true, text: "- 要求中文输出、简洁\n  证据 [2]：mem_20260901_z1, mem_20260902_z2\n- 方案先行，评审通过才开发\n  证据 [4]：mem_20260903_w1, mem_20260904_w2, mem_20260905_w3, mem_20260906_w4\n" },
          { name: "tech", path: "profile/tech.md", exists: true, text: "- Vue3 + Electron + TS\n  证据 [3]：mem_20260907_v1, mem_20260908_v2, mem_20260909_v3\n- 零第三方依赖\n  证据 [2]：mem_20260910_u1, mem_20260911_u2\n" },
          { name: "habits", path: "profile/habits.md", exists: true, text: "- 多轮迭代，先调研后动手\n  证据 [2]：mem_20260912_t1, mem_20260913_t2\n- 喜欢看实测数据\n  证据 [3]：mem_20260914_s1, mem_20260915_s2, mem_20260916_s3\n" },
        ], history: [{ name: "persona-2026-09-17T00-00-00-000Z.md", mtime: NOW - 7 * 86400000 }], lastAt: NOW - 86400000 };
      case "memory_profile_save":
        return { ok: true };
      case "memory_review_list": {
        // 按 kind 分流：收件箱三个 tab 各取各的队列（原先不分 kind，归类/去重 tab 会拿到失效数据）
        const kind = args?.kind || "supersede";
        if (kind === "classify") {
          return { items: [
            { id: "rq_c1", kind: "classify", created: NOW - 7200000, payload: { memoryId: "mem_20260918_mn90op", slug: "HUIdada1--AgentHub", name: "AgentHub", score: 0.71, candidate: "D--workspace-agenthub", title: "工作区里的 AgentHub 副本" } },
          ] };
        }
        if (kind !== "supersede") return { items: [] };
        return { items: [
          { id: "rq_1", kind: "supersede", created: NOW - 3600000, payload: { oldId: "mem_20260910_ij78kl", newId: "mem_20260924_ab12cd", confidence: 0.92, reason: "后者明确提到全面替换", oldTitle: "早期索引方案", newTitle: "索引方案选型", project: "HUIdada1--AgentHub" } },
        ] };
      }
      case "memory_review_resolve":
        return { ok: true };
      case "memory_sync_status":
        return { running: false, stage: "idle", stageLabel: "空闲", percent: 100, detail: "上次同步完成", lastSyncAt: NOW - 10800000, conflicts: 2, tombstones: 1, configured: true };
      case "memory_sync_run":
        return { ok: true, uploaded: 1, downloaded: 0, conflicts: 0, merged: 0 };
      case "memory_sync_cancel":
        return { ok: true };
      case "memory_sync_logs":
        return { logs: [
          { at: NOW - 10800000, stage: "connect", detail: "连接 dav.example.com" },
          { at: NOW - 10800000, stage: "pull", detail: "探测远端 memory-latest.tar.gz" },
          { at: NOW - 10799000, stage: "merge", detail: "解包远端 → 三方合并" },
          { at: NOW - 10798000, stage: "push", detail: "上传 memory-latest.tar.gz（9.8MB）" },
          { at: NOW - 10797000, stage: "done", detail: "同步完成：上传 9.8MB · 冲突 2 条" },
        ] };
      case "memory_conflicts_list":
        return { conflicts: [
          { index: 0, kind: "memory", path: "projects/HUIdada1--AgentHub/l2/decisions/mem_20260924_ab12cd.md", detectedAt: NOW - 10800000, note: "双方都改了", local: { size: 812, mtime: NOW, hash: "aaa" }, remote: { size: 900, mtime: NOW, hash: "bbb" } },
          { index: 1, kind: "memory", path: "projects/HUIdada1--AgentHub/l1/codex/2026-09-20.md", detectedAt: NOW - 10800000, note: "本地有 / 远端已删", local: { size: 500, mtime: NOW, hash: "ccc" }, remote: null },
        ] };
      case "memory_conflicts_diff":
        return { ok: true, path: "projects/HUIdada1--AgentHub/l2/decisions/mem_20260924_ab12cd.md", note: "双方都改了", localText: "决定下个版本把索引换成 FTS5\n配合 bigram 预分词\n与外部分量表\n", remoteText: "决定下个版本把索引换成 FTS5\n配合 bigram 预分词 + 双索引\n与外部分量表\n" };
      case "memory_conflicts_resolve":
        return { ok: true };
      case "memory_sync_devices":
        return { devices: [{ deviceId: "dev_a1b2c3", name: "DESKTOP-ABC", lastSyncAt: NOW - 10800000, count: 42 }], deviceId: "dev_a1b2c3" };
      case "memory_sync_packs":
        return { packs: [{ at: NOW - 10800000, bytes: 10276044, files: 42, dir: "upload" }] };
      case "memory_dedup_status":
        return { total: 54, pending: 14, done: 30, merged: 8, queued: 2, dedupRate: 14.8, learnedPairs: 3, tokensUsed: 0, layerCounts: { l1: 6, learned: 3 }, autoDeleteDisabled: true };
      case "memory_dedup_scan":
        return { scanned: 14, merged: 0, queued: 1, acted: 1, tokens: 1240 };
      case "memory_dedup_review_list":
        return { items: [
          { id: "rq_d1", payload: { kind: "UPDATE", newId: "mem_new_1", targetId: "mem_old_1", confidence: 0.58, reason: "新记忆多了触发器细节", newTitle: "用 FTS5 双索引（补充）", targetTitle: "用 FTS5 双索引", newSummary: "必须配 6 个触发器", targetSummary: "保真索引 + 加权索引" } },
          { id: "rq_d2", payload: { kind: "DELETE", newId: "mem_new_2", targetId: "mem_old_2", confidence: 0.91, reason: "新记忆信息量更少", newTitle: "索引相关笔记", targetTitle: "索引方案完整记录", newSummary: "简单记一下", targetSummary: "含双索引与触发器细节" } },
        ] };
      case "memory_dedup_review_resolve":
      case "memory_dedup_pairs_clear":
      case "memory_dedup_layer_toggle":
        return { ok: true };
      case "memory_dedup_pairs_get":
        return { pairs: [{ a: "h1", b: "h2", aTitle: "记住的两件事之一", bTitle: "记住的两件事之二" }] };
      case "memory_import_sources":
        return { sources: [
          { id: "zcode-db", name: "ZCode 会话库", kind: "sqlite", path: "C:\\Users\\demo\\.zcode\\cli\\db\\db.sqlite", enabled: true, exists: true, items: 1284, sizeBytes: 327155712, note: "", estimate: "上次已导入至 id=44120（表内现有 47912 行）", cursor: { lastId: 44120 } },
          { id: "zcode-tx", name: "ZCode 实时日志", kind: "jsonl", path: "C:\\Users\\demo\\.zcode\\cli\\agents", enabled: true, exists: true, items: 62, sizeBytes: 81920, note: "", estimate: "已读字节水位合计 80 KB，本次按增量续读", cursor: { files: {} } },
          { id: "claude", name: "Claude Code 会话", kind: "jsonl", path: "C:\\Users\\demo\\.claude\\projects", enabled: true, exists: true, items: 38, sizeBytes: 40960, note: "", estimate: "首次导入，将全量扫描", cursor: null },
          { id: "codex", name: "Codex 会话", kind: "jsonl", path: "C:\\Users\\demo\\.codex\\sessions", enabled: true, exists: true, items: 12, sizeBytes: 20480, note: "", estimate: "首次导入，将全量扫描", cursor: null },
          { id: "workbuddy", name: "WorkBuddy 会话", kind: "jsonl", path: "C:\\Users\\demo\\.workbuddy-ai", enabled: true, exists: true, items: 5, sizeBytes: 10240, note: "", estimate: "首次导入，将全量扫描", cursor: null },
          { id: "notes-md", name: "Markdown 笔记目录", kind: "md", path: "", enabled: false, exists: false, items: 0, sizeBytes: 0, note: "未配置路径", estimate: "", cursor: null },
        ], importDir: "C:\\Users\\demo\\AgentHub\\memory\\_import" };
      case "memory_import_source_save":
        return { ok: true, sources: [] };
      case "memory_import_source_detect":
        return { detect: { ok: true, kind: "jsonl", sizeBytes: 81920, sampleKeys: ["role", "content", "timestamp", "sessionId"], sample: [{ role: "user", content: "样例消息" }] } };
      case "memory_import_preview":
        return { wouldCreate: 1842, wouldMerge: 317, skipDuplicate: 462, classifyFailed: 28, sensitive: 7, estimatedBytes: 88121344, estimatedTokens: 29373781, groups: [{ project: "HUIdada1--AgentHub", count: 612, source: "zcode-db" }, { project: "wechat-mini-order", count: 388, source: "claude" }, { project: "(未归类)", count: 28, source: "codex" }], samples: [{ title: "记忆仓库要用 FTS5 双索引", created: NOW - 4 * 86400000, source: "zcode-db", project: "HUIdada1--AgentHub" }, { title: "订单页重构结论", created: NOW - 9 * 86400000, source: "claude", project: "wechat-mini-order" }], note: "干跑未写入任何文件；确认后再执行导入" };
      case "memory_import_apply":
        return { ok: true, created: 1842, merged: 317, skipped: 462, sensitive: 7, failed: 0, report: "C:\\Users\\demo\\AgentHub\\memory\\_import\\report-2026-09-24T02-14-00.md", verify: { files: 2140, indexed: 2140, coverage: 100, sampleRead: "20/20", orphan: 0, ftsConsistent: true } };
      case "memory_import_cancel":
        return { ok: true };
      case "memory_import_progress":
        return { phase: "idle", done: 0, total: 0, created: 0, merged: 0, skipped: 0, sensitive: 0, running: false };
      case "memory_import_report":
        return { ok: true, files: ["report-2026-09-24T02-14-00.md"], content: "# 导入报告 · 2026-09-24 02:14\n\n新建 1842 条 · 合并 317 条 · 跳过重复 462 条\n敏感跳过 7 条 · 失败 0 条\n\n## 校验\n- 文件数 2140 · 索引行 2140 · 覆盖率 100%\n- 抽样回读 20/20\n" };
      case "memory_import_cursors_get":
        return { ok: true, cursors: { "zcode-db": { source: "sqlite", lastId: 44120, seeded: true } }, file: "C:\\Users\\demo\\AgentHub\\memory\\_import\\cursors.json" };
      case "memory_import_cursors_reset":
      case "memory_import_map_save":
        return { ok: true, cursors: {}, sources: [] };

      // ===== 技能仓库 =====
      case "list_tools":
        return TOOLS;
      case "skills_side_stats":
        return {
          skillCount: SKILLS.length,
          pendingConflicts: 0,
          toolCount: TOOLS.filter((t) => t.enabled).length,
          mountOk: 8,
          mountTotal: 10,
          tools: TOOLS.filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name, dir: t.dir || "", skillCount: 6 })),
        };
      case "probe_agents":
        return PROBED;
      case "remove_tool":
        return { ok: true, mounts: [{ skill: "brandkit", path: "C:\\Users\\demo\\.cursor\\skills\\brandkit" }], sourceCount: 1, openConflicts: 0 };
      case "watch_status":
        return { intervalSeconds: 15, lastScanAt: NOW };
      case "webdav_status":
        return JSON.parse(JSON.stringify(WEBDAV_STATUS));
      case "webdav_logs":
        return WEBDAV_LOGS;
      case "webdav_devices":
        return DEVICES;
      case "list_reports":
        return REPORTS;
      case "read_report":
        return { content: REPORT_TEXT };
      case "trash_list":
        return TRASH;
      case "webdav_test":
        return { ok: true, message: "连接成功（218ms）", latencyMs: 218 };
      case "get_overview":
        return {
          hubDir: "C:\\Users\\demo\\.agent_skills", skillCount: SKILLS.length, manifestCount: 4, sourceCount: 6,
          l1Merged: 2, l2Conflicts: 0,
          tools: TOOLS.filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name, dir: t.dir || "", skillCount: 6, mountCount: 2 })),
          mountHealth: [],
          orphans: ORPHANS, pendingConflicts: [],
          recentReports: [], trashCount: TRASH.length, hubExtra: [],
        };
      case "sync_plan":
        return {
          mode: "junction",
          actions: [
            { type: "import", skill: "brandkit", note: "收纳 zcode:brandkit", sources: [{ tool: "zcode", name: "brandkit", dir: "C:\\Users\\demo\\.zcode\\skills\\brandkit" }] },
            { type: "mount", skill: "brandkit", mountName: "brandkit", toolId: "zcode", parentDir: "C:\\Users\\demo\\.zcode\\skills", replaceReal: true, note: "zcode 版与中央一致，原位转挂载（原目录备份进回收站）" },
            { type: "mount", skill: "browser-skill", mountName: "browser-skill", toolId: "codex", parentDir: "C:\\Users\\demo\\.codex\\skills", replaceReal: false, note: "codex 无此技能 → 发布挂载" },
          ],
          conflicts: [],
          orphans: ORPHANS,
          dedup: { duplicates: [], hints: [] },
          scannedSummary: [
            { id: "zcode", name: "ZCode", dir: "C:\\Users\\demo\\.zcode\\skills", skillCount: 15, mountCount: 0 },
            { id: "codex", name: "Codex CLI", dir: "C:\\Users\\demo\\.codex\\skills", skillCount: 23, mountCount: 0 },
          ],
        };
      case "list_skills":
        return JSON.parse(JSON.stringify(SKILLS));
      case "get_skill":
        return {
          manifest: null,
          dir: "",
          health: [],
          skillMd: "---\nname: brandkit\ndescription: Premium brand-kit skill\n---\n\n# brandkit\n",
          sources: [{ tool: "zcode", name: "brandkit" }, { tool: "cursor", name: "brandkit" }],
        };
      case "list_conflicts":
        return [];

      // ===== 反代网关（预览数据，语义对齐 backend/proxy） =====
      case "proxy_status":
        return {
          running: true, port: 9527, bind: "127.0.0.1", baseUrl: "http://127.0.0.1:9527/v1",
          uptime: 3 * 3600000, active: 1,
          today: { req: 1284, tokens: 312400, successRate: 99.4, ttftAvg: 820 },
          channels: PROXY_POOL.map((c) => ({ id: c.id, display: c.display, ...c.summary })),
          keyCount: PROXY_KEYS.length, vaultOk: true, dbDriver: "node:sqlite",
        };
      case "proxy_start":
        return { ok: true, port: 9527 };
      case "proxy_stop":
      case "proxy_restart":
        return { ok: true, port: 9527 };
      case "proxy_keys_list":
        return JSON.parse(JSON.stringify(PROXY_KEYS));
      case "proxy_ccswitch_status":
        return {
          ok: true,
          installed: true,
          dbPath: "~/.cc-switch/cc-switch.db",
          entries: [
            { appType: "claude", registered: false },
            { appType: "codex", registered: false },
          ],
        };
      case "proxy_ccswitch_register":
        return {
          ok: true,
          action: "inserted",
          backupPath: "~/.cc-switch/backups/cc-switch.db.bak_agenthub_demo",
          dbPath: "~/.cc-switch/cc-switch.db",
          appType: args?.appType,
        };
      case "proxy_key_create":
        return { id: "k-new", name: String(args?.name || "新 Key"), mask: "sk-demo···0000", route: args?.route || "auto", dailyQuota: args?.dailyQuota || 0, rateLimit: 0, enabled: true, createdAt: NOW, todayReq: 0, todayTokens: 0, secret: "sk-demo0000000000000000000000000000000000000000000000" };
      case "proxy_key_update":
      case "proxy_key_delete":
      case "proxy_pool_strategy":
      case "proxy_account_remove":
      case "proxy_account_toggle":
      case "proxy_oauth_cancel":
      case "proxy_oauth_submit_callback":
        return { ok: true };
      case "proxy_pool":
        return JSON.parse(JSON.stringify(PROXY_POOL));
      case "proxy_account_add":
        return { ok: true, id: "a-new" };
      case "proxy_account_refresh":
        return { ok: true, id: args?.id, credits: 51230, expiresAt: NOW + 48 * 86400000 };
      case "proxy_credits_refresh":
        return { ok: true, total: 5, failed: 0 };
      case "proxy_credits_refresh_channel":
        return { ok: true, total: 3, failed: 0, results: [] };
      case "proxy_checkin_status":
        return {
          ok: true,
          action: "status",
          total: 3,
          okCount: 3,
          rows: [
            { accountId: "a1", channel: "trae", name: "主账号 · 沐", uid: "88213476", ok: true, checkedIn: false, enable: true, credits: 120, message: "今日未签到" },
            { accountId: "a2", channel: "workbuddy", name: "工作号", uid: "wb_7c21", ok: true, active: true, checkedIn: true, streakDays: 3, dailyCredit: 100, message: "今日已签到" },
            { accountId: "a3", channel: "workbuddy_ai", name: "国际版号", uid: "wb_9e05", ok: true, unavailable: true, message: "国际版无签到体系" },
          ],
        };
      case "proxy_checkin_run":
        return {
          ok: true,
          action: args?.action || "checkin",
          total: 3,
          okCount: 2,
          rows: [
            { accountId: "a1", channel: "trae", name: "主账号 · 沐", uid: "88213476", ok: true, message: "签到成功", credit: 100 },
            { accountId: "a2", channel: "workbuddy", name: "工作号", uid: "wb_7c21", ok: true, already: true, message: "今天已签到" },
            { accountId: "a3", channel: "workbuddy_ai", name: "国际版号", uid: "wb_9e05", ok: true, unavailable: true, message: "国际版无签到体系" },
          ],
        };
      case "proxy_scan":
        return [
          { channel: "workbuddy", uid: "wb_7c21", name: "工作号", source: "scan", file: "workbuddy-desktop.info", imported: true },
          { channel: "workbuddy_ai", uid: "wb_9e05", name: "国际版号", source: "scan", file: "workbuddy-desktop-ai.info", imported: false },
          { channel: "trae", uid: "88213476", name: "huihui", source: "scan", file: "TRAE SOLO CN · storage.json", imported: false, credits: 51230 },
        ];
      case "proxy_scan_import":
        return { ok: true, id: "a-imp", updated: false };
      case "proxy_oauth_begin":
        return { ok: true, url: "https://www.trae.cn/authorization?...（预览）", mode: args?.channel === "trae" ? "loopback" : "poll" };
      case "proxy_account_import_json":
        return { ok: true, added: 2, dup: 1, invalid: 0, message: "成功导入 2 个账号，1 个同 UID 已存在跳过" };
      case "proxy_account_import_file":
        return { ok: true, canceled: true };
      case "proxy_models":
        return JSON.parse(JSON.stringify(PROXY_MODELS));
      case "proxy_models_sync":
        return { ok: true, channel: args?.channel || "workbuddy", count: 6, withRate: 4 };
      case "proxy_ide_switch":
        return { ok: true, channel: "workbuddy", message: "已写入（预览），重启 WorkBuddy 生效" };
      case "proxy_ide_status":
        return { workbuddyInstalled: true, workbuddyAiInstalled: true, traeInstalled: false, raccoonInstalled: true, currentUid: "wb_7c21" };
      case "proxy_stats_overview":
        return {
          today: { req: 1284, tokens: 312400, successRate: 99.4, ttftAvg: 820 },
          trend: PROXY_TREND,
          tops: {
            channel: [
              { name: "trae", req: 745, tokens: 182000 },
              { name: "workbuddy", req: 421, tokens: 96000 },
              { name: "workbuddy_ai", req: 118, tokens: 34400 },
            ],
            model: [
              { name: "deepseek-v4-flash", req: 512, tokens: 120000 },
              { name: "glm-4.6", req: 233, tokens: 62000 },
              { name: "claude-sonnet-4.5", req: 301, tokens: 88000 },
            ],
            key: [
              { name: "本地主 Key", req: 612, tokens: 148200 },
              { name: "Trae 专用", req: 403, tokens: 96400 },
              { name: "WorkBuddy 专用", req: 269, tokens: 67800 },
            ],
            account: [
              { name: "主账号 · 沐", req: 560, tokens: 132000 },
              { name: "工作号", req: 421, tokens: 96000 },
              { name: "备用号", req: 185, tokens: 50000 },
            ],
          },
        };
      case "proxy_stats_top":
        return [
          { name: "trae", req: 745, tokens: 182000 },
          { name: "workbuddy", req: 421, tokens: 96000 },
        ];
      case "proxy_stats_detail":
        return { total: PROXY_USAGE.length, page: 1, pageSize: 20, rows: JSON.parse(JSON.stringify(PROXY_USAGE)) };
      case "proxy_recent":
        return JSON.parse(JSON.stringify(PROXY_USAGE));
      case "proxy_rules_list":
        return JSON.parse(JSON.stringify(PROXY_RULES));
      case "proxy_open_rules_dir":
      case "proxy_open_data_dir":
        return { ok: true };
      case "proxy_vault_status":
        return { encrypted: true, driver: "node:sqlite", dataDir: "(浏览器预览)" };
      case "webdav_shared_get":
        return {
          endpoint: "https://dav.jianguoyun.com/dav",
          username: "demo@example.com",
          password: "••••••••",
          roots: { skills: "/agent-skills", usage: "/dosage-sync", proxy: "/agenthub-proxy" },
        };
      case "webdav_shared_save":
        return { ok: true, message: "已保存" };
      case "webdav_shared_test":
        return { ok: true, message: "连接成功 · 218ms", latencyMs: 218 };
      case "proxy_poolsync_status":
        return {
          running: false, stage: "idle", stageLabel: "空闲", detail: "", lastError: "",
          lastSyncAt: Date.now() - 3600000, lastSummary: "拉取 1 台设备 · 新增 2 · 刷新 3 · 移除 0 · 已上传",
          percent: 0, channel: "",
          configured: true, deviceId: "demo-device", deviceName: "这台电脑",
        };
      case "proxy_poolsync_run":
        return { ok: true, summary: "拉取 1 台设备 · 新增 2 · 刷新 3 · 移除 0 · 已上传", pulled: 1, added: 2, updated: 3, removed: 0, uploaded: true };
      case "proxy_poolsync_cancel":
        return { ok: true };
      default:
        // 未造的命令走 null 降级（页面按“未检测到后端”处理）
        return null;
    }
  },
};
