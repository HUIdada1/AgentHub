// 全局类型与常量：三大模块 / 子页面 / 应用配置 / 技能仓库数据结构
// MODULES 是左栏导航的唯一事实源，App.vue 据此装配各模块视图组件
export type ModuleKey = "skills" | "sync" | "proxy";
export type Theme = "dark" | "light";

export interface PageDef {
  id: string;
  name: string;
  /** 右侧计数徽标：静态兜底值，技能仓库的待裁决徽标由 store 实时计算覆盖 */
  badge?: string;
}

export interface ModuleDef {
  key: ModuleKey;
  name: string;
  pages: PageDef[];
}

// ===== 技能仓库：数据结构（跟 electron/backend 返回一一对应） =====

export type HealthIssue = { level: "warn" | "bad"; text: string };

export type SkillSource = { tool: string; originalName?: string; name?: string; dir?: string; firstSeen?: string; origin?: string };

export type SkillMount = {
  tool: string;
  name: string;
  path: string;
  type: "junction" | "symlink" | "copy";
  enabled: boolean;
};

export type SkillRow = {
  name: string;
  skillName: string;
  description: string;
  version: string;
  treeHash: string;
  health: HealthIssue[];
  sources: SkillSource[];
  inManifest: boolean;
  mounts: SkillMount[];
  mtimeMs: number;
  /** user=用户安装；system=工具自带（默认隐藏，搜索可见，永不收纳）；hub-extra=中央仓库有目录但未登记 */
  origin?: "user" | "system" | "hub-extra";
};

// 中央巡检：仓库里躺着但 manifest 没记账的目录
export type HubExtraRow = {
  name: string;
  isLink: boolean;
  hasSkillMd: boolean;
  mtimeMs: number;
  health: HealthIssue[];
};

export type Overview = {
  hubDir: string;
  skillCount: number;
  manifestCount: number;
  sourceCount: number;
  l1Merged: number;
  l2Conflicts: number;
  tools: { id: string; name: string; dir: string; skillCount: number; mountCount: number }[];
  mountHealth: { skill: string; tool: string; name: string; path: string; type: string; enabled: boolean; isLink: boolean; valid: boolean }[];
  orphans: OrphanRow[];
  pendingConflicts: ConflictItem[];
  recentReports: ReportRow[];
  trashCount: number;
  hubExtra: HubExtraRow[];
};

export type ReportRow = { file: string; path: string; mtimeMs: number };

export type SyncAction = {
  type: "import" | "mount" | "skip" | "error" | "conflict";
  skill: string;
  mountName?: string;
  toolId?: string;
  parentDir?: string;
  dir?: string;
  replaceReal?: boolean;
  note: string;
  sources?: { tool: string; name: string; dir: string }[];
};

export type SyncPlan = {
  mode: "junction" | "copy";
  actions: SyncAction[];
  conflicts: ConflictItem[];
  orphans: OrphanRow[];
  dedup: { duplicates: { kept: { name: string; tool: string }; removed: { name: string; tool: string }; rule: string; basis: string }[]; hints: { a: string; b: string; sim: number }[] };
  scannedSummary: { id: string; name: string; dir: string; skillCount: number; mountCount: number }[];
};

export type SyncResult = {
  mode: string;
  summary: { imported: number; merged: number; conflicts: number; skipped: number; mounted: number; repaired: number; cleaned: number };
  imports: { name: string; sources: string; action: string; path: string }[];
  merges: { kept: string; removed: string; basis: string }[];
  conflicts: { title: string; detail: string }[];
  mounts: { skill: string; dir: string; action: string; outcome: string }[];
  manifestDiff: string[];
  reportFile: string;
};

export type ConflictItem = {
  id: string;
  kind: "content" | "diff-link" | "norm" | "remote";
  skill?: string;
  toolId?: string;
  dir?: string;
  title: string;
  detail: string;
  a?: string;
  b?: string;
  localHash?: string;
  remoteHash?: string;
  at: string;
  resolved?: { at: string; choice: string };
};

export type ConflictDiff = {
  item: ConflictItem;
  left: { label: string; path: string; md: string };
  right: { label: string; path: string; md: string };
};

export type ToolRow = {
  id: string;
  name: string;
  icon: string;
  builtin: boolean;
  deletable: boolean;
  enabled: boolean;
  dir: string | null;
  candidatePaths: string[];
};

// 电脑扫描发现的第三方 agent：用户确认了才落配置（suggestId 已避开现有工具 id）
export type ProbeRow = { suggestId: string; name: string; icon: string; hitDirs: string[]; skillCount: number };

// 删除自定义工具前的干跑结果：有未裁决冲突必须先裁决
export type RemoveToolPlan = {
  builtin: boolean;
  mounts: { skill: string; path: string }[];
  sourceCount: number;
  openConflicts: number;
};

// 孤儿目录：工具目录里真实存在、但中央仓库 manifest 还没记录的技能目录
export type OrphanRow = { name: string; tool: string; dir: string; mtimeMs?: number };

export type TrashRow = { name: string; path: string; trashedAt: number; sizeBytes: number };

// 自动感知状态：技能库/同步中心展示"每 X 秒自动扫描"用
export type WatchStatus = { intervalSeconds: number; lastScanAt: number };

export type SkillDetail = {
  manifest: {
    name: string;
    version: string;
    description: string;
    treeHash: string;
    skillName: string;
    sources: SkillSource[];
    mounts: SkillMount[];
    mergeHistory: { at: string; action: string; detail: string }[];
    health?: HealthIssue[];
  } | null;
  dir: string;
  health: HealthIssue[];
  skillMd: string;
  /** 未收纳技能：探测到的工具目录来源 */
  sources?: SkillSource[];
};

// ===== WebDAV 跨设备同步 =====

export type WebDavStatus = {
  running: boolean;
  configured: boolean;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string;
  stage: "idle" | "connect" | "pull" | "download" | "upload" | "push" | "done" | "cancelled" | "error";
  stageLabel: string;
  detail: string;
  pct?: number;
  lastError: string;
};

export type RemoteDevice = { id: string; name: string; appVersion: string; lastSyncAt: string; self: boolean };

export type WebDavLog = { at: string; text: string };

export type WebDavEvent = { event: "webdav"; stage: string; detail: string; pct?: number; running: boolean };

// ===== 全局设置弹窗：左下角设置按钮打开的三个模块（弹窗左列按钮切换） =====

export type SettingsTab = "general" | "webdav" | "data";

export const SETTINGS_TABS: { key: SettingsTab; name: string; icon: string; desc: string }[] = [
  { key: "general", name: "通用", icon: "ph-sliders-horizontal", desc: "外观 · 模块顺序 · 更新" },
  { key: "webdav", name: "WebDAV 同步", icon: "ph-cloud", desc: "统一服务器 · 号池同步" },
  { key: "data", name: "数据与备份", icon: "ph-database", desc: "备份压缩包 · 缓存目录" },
];

// ===== 应用配置：框架（主题 / 模块顺序）+ 技能仓库 + 更新 =====

export interface AppConfig {
  theme: Theme;
  /** 界面动效开关（仅展示层）：默认关闭，用户在设置里开启后本机记住；
      false 时恢复系统鼠标指针并停用装饰动画，业务逻辑不受影响 */
  fx: boolean;
  moduleOrder: ModuleKey[];
  tools: Record<string, { enabled: boolean; paths: string[]; name?: string; icon?: string }>;
  customDirs: string[];
  mountMode: "junction" | "copy";
  l3: { enabled: boolean; threshold: number };
  trashDays: number;
  /** 软件更新：channel 更新通道；autoCheck 定时自动检查开关；notifiedVersion 由主进程维护（前端只读回传） */
  update: UpdateConfig;
  webdav: {
    endpoint: string;
    username: string;
    password: string;
    root: string;
    deviceId: string;
    deviceName: string;
  };
  schedule: {
    minimizeToTray: boolean;
    autoStart: boolean;
    hourly: boolean;
    daily: boolean;
    dailyTime: string;
    notifyOnSuccess: boolean;
  };
  watch: { enabled: boolean };
  /** 反代网关设置（框架整体设置的一部分；端口改动需重启监听，其余热生效） */
  proxy: ProxyConfig;
}

export interface UpdateConfig {
  channel: string;
  autoCheck: boolean;
  notifiedVersion: string;
}

/** 反代网关设置（与 electron/backend/config.cjs defaultConfig().proxy 保持一致） */
export interface ProxyConfig {
  port: number;
  bind: string;
  /** 网关开关的上次状态：启动应用时是否随之启动（默认 false，即首次打开是关闭的） */
  restoreOnLaunch: boolean;
  routeStrategy: "smart" | "fixed";
  /** fixed 策略下的优先渠道（渠道 id；渠道可扩充，故为字符串） */
  fixedChannel: string;
  rateLimitPerMin: number;
  concurrency: number;
  creditsRefreshMin: number;
  debugStatus: boolean;
  /** 模型 → 渠道 id 的 per-model 覆盖（渠道可扩充，故为字符串值） */
  modelOverrides: Record<string, string>;
  /** 拟人抖动：每次上游请求前随机停 40~220ms，模拟真实客户端节奏 */
  humanizeJitter: boolean;
  /** 禁用的模型（请求直接 400） */
  disabledModels: string[];
  /** 模型 → 回退模型（未知模型/号池耗尽时自动切换，单跳；旧版 per-model 配置，优先于全局回退） */
  modelFallback: Record<string, string>;
  /** 自定义模型映射：别名 → 目标模型 id（请求入口先解析别名再路由，响应 model 字段保持请求值） */
  modelAliases: Record<string, string>;
  /** 不可用时自动切换模型（统一设置，默认开）：模型未知或号池耗尽时切到 fallbackModel */
  autoFallbackEnabled: boolean;
  /** 全局统一回退模型（autoFallbackEnabled 开启且 per-model 未配置时生效） */
  fallbackModel: string;
  /** 定时自动签到（默认关）：每天到点自动跑全渠道签到/领加油包 */
  checkinAuto: boolean;
  /** 每日自动签到时间（HH:mm） */
  checkinAutoTime: string;
  /** 生态接入默认模型（注册进 CC Switch 时使用，缺省取 fallbackModel） */
  ccSwitchModel: string;
}

// ===== 反代网关：数据结构（跟 electron/backend/proxy/* 返回一一对应） =====

export type ProxyChannelId = "trae" | "workbuddy" | "workbuddy_ai" | "raccoon";
/** Key 路由：auto 或任一渠道 id（渠道后续扩充即为普通字符串，保留字面量仅为补全提示） */
export type ProxyRoute = "auto" | ProxyChannelId | (string & {});
export type ProxyAccountStatus = "online" | "cooling" | "exhausted" | "relogin" | "disabled";
export type ProxyPoolStrategy = "expire_first" | "credit_first" | "round_robin";

export interface ProxyKeyRow {
  id: string;
  name: string;
  mask: string;
  route: ProxyRoute;
  dailyQuota: number;
  rateLimit: number;
  enabled: boolean;
  createdAt: number;
  todayReq: number;
  todayTokens: number;
  /** 完整 Key（后端 DPAPI 解密后随列表返回，供随时查看 / 复制；旧版本创建的 Key 无存档则为空） */
  secret?: string;
}

// ===== 反代网关：生态接入（CC Switch） =====
/** CC Switch 里的应用入口：claude / codex（Claude Code / Codex CLI）与 claude-desktop（Claude Desktop 3P，独立入口） */
export type CcSwitchAppType = "claude" | "codex" | "claude-desktop";
export interface CcSwitchEntry {
  appType: CcSwitchAppType;
  registered: boolean;
  name?: string;
}
export interface CcSwitchStatus {
  installed: boolean;
  /** 库在但 providers 表缺失等异常（按未注册展示，注册时会被更准确的报错拦截） */
  incompatible?: boolean;
  dbPath?: string;
  /** 各应用的本地代理接管状态：只有开启接管，OpenAI Chat 上游才会被 CC Switch 转换协议；
   *  claudeDesktop 表示 CC Switch 全局代理网关在线（Desktop 映射模式依赖它常驻，借 claude 行 proxy_enabled 判断） */
  takeover?: { claude: boolean; codex: boolean; claudeDesktop: boolean };
  entries?: CcSwitchEntry[];
}
export interface CcSwitchRegisterResult {
  ok?: boolean;
  action?: "inserted" | "updated";
  backupPath?: string;
  dbPath?: string;
  appType?: CcSwitchAppType;
  /** 写入 CC Switch 的真实条目名（与列表里显示的一致，如「AgentHub 网关（Claude Code）」） */
  name?: string;
  message?: string;
}

export interface ProxyAccount {
  id: string;
  channel: ProxyChannelId;
  uid: string;
  name: string;
  status: ProxyAccountStatus;
  credits: number;
  creditsAt: number;
  expiresAt: number;
  coolUntil: number;
  coolReason: string;
  /** 最近一次上游错误（号池状态气泡展示用；只留最新一条，无则为 null） */
  lastError?: { at: number; message: string } | null;
  /** 生效中的模型级负缓存（6004/11102 只罚"账号×模型"不落账号状态；空数组 = 无） */
  modelCool?: { model: string; until: number; reason: string }[];
  source: "scan" | "oauth" | "paste";
  lastUsed: number;
  todayReq: number;
  todayTokens: number;
  createdAt: number;
  hasToken: boolean;
}

export interface ProxyPoolSummary {
  channel: ProxyChannelId;
  totalCredits: number;
  accountCount: number;
  onlineCount: number;
  earliestExpire: number;
  expiringSoon: boolean;
  todayReq: number;
  todayTokens: number;
  lastCreditsAt: number;
}

export interface ProxyChannelView {
  id: ProxyChannelId;
  display: string;
  domain: string;
  poolStrategy: ProxyPoolStrategy;
  summary: ProxyPoolSummary;
  accounts: ProxyAccount[];
}

export interface ProxyGatewayStatus {
  running: boolean;
  port: number;
  bind: string;
  baseUrl: string;
  uptime: number;
  active: number;
  today: { req: number; tokens: number; successRate: number; ttftAvg: number };
  channels: (ProxyPoolSummary & { id: ProxyChannelId; display: string })[];
  keyCount: number;
  vaultOk: boolean;
  dbDriver: string;
}

export interface ProxyUsageRow {
  id: number;
  ts: number;
  reqId: string;
  keyId: string;
  keyName: string;
  channel: string;
  accountId: string;
  accountName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  latencyMs: number;
  status: number;
  error: string;
}

export interface ProxyStatsOverview {
  today: { req: number; tokens: number; successRate: number; ttftAvg: number };
  trend: { day: string; req: number; tokens: number }[];
  tops: Record<"channel" | "model" | "key" | "account", { name: string; req: number; tokens: number }[]>;
}

export interface ProxyStatsDetail {
  total: number;
  page: number;
  pageSize: number;
  rows: ProxyUsageRow[];
}

export interface ProxyModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  sources: ProxyChannelId[];
  /** 目录元数据（catalog.json）：显示名 / 倍率（积分倍率，null=未知）/ 能力 / 上下文长度 */
  name?: string;
  rate?: number | null;
  capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean };
  contextLength?: number;
  maxOutputTokens?: number;
  /** 管理态（proxy_models 返回时合并）：启用 / per-model 渠道覆盖 / 回退模型 */
  enabled: boolean;
  override: "" | ProxyChannelId;
  fallback: string;
}

export interface ProxyScanCandidate {
  channel: ProxyChannelId;
  uid: string;
  name: string;
  credits?: number;
  expiresAt?: number;
  source: string;
  file: string;
  /** Trae 本地登录态已加密：检测到但需走 OAuth / 粘贴 */
  encrypted?: boolean;
  imported: boolean;
}

export interface ProxyRuleFile {
  file: string;
  desc: string;
  size: number;
  mtimeMs: number;
  ok: boolean;
  error: string;
}

/** 主进程推送的反代网关事件（app:event，event="proxy"） */
export interface ProxyEvent {
  event: "proxy";
  type: "request" | "status" | "credits" | "oauth-done" | "poolsync";
  ok?: boolean;
  message?: string;
  id?: string;
  uid?: string;
  /** poolsync 事件：同步进度（stage/detail/percent/running） */
  stage?: string;
  detail?: string;
  percent?: number;
  running?: boolean;
}

/** 签到批量结果行（proxy_checkin_status / proxy_checkin_run 返回） */
export interface ProxyCheckinRow {
  accountId: string;
  channel: ProxyChannelId;
  name: string;
  uid: string;
  ok: boolean;
  /** 服务对该账号不开放（如 Trae code 1001 / 国际版无签到体系）：不是失败，幂等处理 */
  unavailable?: boolean;
  /** 已签到 / 已领取过：幂等成功 */
  already?: boolean;
  checkedIn?: boolean;
  enable?: boolean;
  active?: boolean;
  streakDays?: number;
  dailyCredit?: number;
  todayCredit?: number;
  credits?: number;
  credit?: number;
  consecutiveDays?: number;
  checkinDates?: string[];
  weekProgress?: boolean[];
  claimed?: boolean;
  success?: boolean;
  reward?: unknown;
  message?: string;
}

/** 更新状态快照（主进程 electron/backend/updater.cjs 维护，经 invoke 拉取 + app:event 事件推送） */
export interface UpdateStatus {
  /** idle 未检查 | checking 检查中 | up-to-date 已是最新 | available 有新版本
   *  downloading 下载中 | downloaded 已下载待安装 | error 出错 */
  status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
  /** 便携版：无安装目录可覆盖，不支持自动更新，仅提示手动下载 */
  isPortable: boolean;
  currentVersion: string;
  latestVersion: string;
  /** 下载进度百分比（0~100） */
  percent: number;
  /** 更新说明（已由主进程从 GitHub 渲染后的 HTML 还原为纯文本） */
  notes: string;
  message: string;
}

/** 主进程推送的更新事件：event="state" 时其余字段为完整状态；event="focus-update" 为通知/托盘点击的跳转信号 */
export interface UpdateEvent extends UpdateStatus {
  event: "state" | "focus-update" | "usage-local-synced";
}

/** 三大模块 → 子页面映射（内置顺序即默认导航顺序，可在「设置 · 通用」中调整）
 *  skills 的 skill-detail 为技能详情页：从技能库点卡片进入，不在横条菜单中展示；
 *  各模块的「配置」是隐藏页面（id=config，不走横条菜单），由横条右侧「配置」按钮切换 */
export const MODULES: ModuleDef[] = [
  {
    key: "skills",
    name: "技能仓库",
    pages: [
      { id: "dashboard", name: "仪表盘" },
      { id: "library", name: "中央技能库" },
      { id: "dedup", name: "去重与冲突" },
      { id: "sync", name: "同步中心" },
      { id: "webdav", name: "WebDAV 同步" },
    ],
  },
  {
    key: "sync",
    name: "用量统计",
    pages: [
      { id: "overview", name: "总览" },
      { id: "detail", name: "用量明细" },
      { id: "costs", name: "费用" },
      { id: "billing", name: "计费规则" },
      { id: "log", name: "同步日志" },
    ],
  },
  {
    key: "proxy",
    name: "反代网关",
    pages: [
      { id: "home", name: "总览" },
      { id: "keys", name: "API Keys" },
      { id: "agents", name: "号池" },
      { id: "models", name: "模型目录" },
      { id: "stats", name: "用量统计" },
      { id: "poolsync", name: "号池同步" },
      { id: "ccswitch", name: "生态接入" },
    ],
  },
];
