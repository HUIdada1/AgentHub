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
    watch: { enabled: true },
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
];

const PROXY_RULES = [
  { file: "model_map.json", desc: "Trae 模型映射（显示名 → config_name/model_name）", size: 642, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "wb_models.json", desc: "WorkBuddy 双区模型目录（兜底，catalog.json 优先）", size: 318, mtimeMs: NOW - 86400000, ok: true, error: "" },
  { file: "catalog.json", desc: "模型权威目录（拉取模型写回：倍率/能力/上下文，可手编）", size: 2048, mtimeMs: NOW - 3600000, ok: true, error: "" },
  { file: "wb_template_map.json", desc: "WorkBuddy 审核模板最小改写表", size: 274, mtimeMs: NOW - 2 * 86400000, ok: true, error: "" },
  { file: "headers.json", desc: "渠道默认头 / UA / 上游域", size: 1204, mtimeMs: NOW - 86400000, ok: true, error: "" },
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
        return { workbuddyInstalled: true, currentUid: "wb_7c21" };
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
