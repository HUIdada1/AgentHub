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
// 全局类型与常量：五大模块 / 子页面 / 应用配置 / 技能仓库数据结构
// MODULES 是左栏导航的唯一事实源，App.vue 据此装配各模块视图组件
export type ModuleKey = "skills" | "sync" | "proxy" | "memory" | "prompts";
export type Theme = "dark" | "light";

export interface PageDef {
  id: string;
  name: string;
  /** 右侧计数徽标：静态兜底值，技能仓库的待裁决徽标由 store 实时计算覆盖 */
  badge?: string;
  /** 禁用页签（提示词库的「线上提示词库」）：置灰不可点、点击只提示不切页。
   *  为什么用声明式字段而不是在 PageTabs 里按 id 特判：以后任何模块要挂占位页都能直接复用，
   *  且「这个页现在不可用」这一事实留在 MODULES 这个唯一事实源里，不会散落在组件里 */
  disabled?: boolean;
  /** 禁用原因文案（禁用页签点击时的提示语）；未填时组件回落到「待版本更新」 */
  disabledTip?: string;
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
  /** diff-link 专有：链接现状（指向哪份、还在不在、中央有没有），面板据此决定给哪几个动词 */
  link?: {
    linkPath: string;
    target: string;
    resolved: string | null;
    isLink: boolean;
    resolves: boolean;
    hasSkillMd: boolean;
    centralPath: string;
    centralExists: boolean;
    sameAsCentral: boolean;
    targetInsideHub: boolean;
  };
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

// ===== 全局设置弹窗：左下角设置按钮打开的模块（弹窗左列按钮切换） =====

export type SettingsTab = "general" | "webdav" | "data" | "models" | "timing" | "feedback" | "plugins";

export const SETTINGS_TABS: { key: SettingsTab; name: string; icon: string; desc: string }[] = [
  { key: "general", name: "通用", icon: "ph-sliders-horizontal", desc: "外观 · 模块顺序 · 更新" },
  { key: "webdav", name: "WebDAV 同步", icon: "ph-cloud", desc: "统一服务器 · 号池同步" },
  { key: "timing", name: "同步时间", icon: "ph-clock-countdown", desc: "各板块自动同步 / 刷新周期" },
  { key: "data", name: "数据与备份", icon: "ph-database", desc: "备份压缩包 · 缓存目录" },
  // 模型与网关：平台级配置（供应商 / 模型池 / 来源优先级 / 网关），
  // 记忆中枢只是当前消费方之一，未来新增板块统一复用这里
  { key: "models", name: "模型与网关", icon: "ph-cpu", desc: "供应商 · 模型池 · 来源优先级" },
  { key: "feedback", name: "反馈与需求", icon: "ph-chat-circle-dots", desc: "问题反馈 · 功能建议" },
];

// ===== 应用配置：框架（主题 / 模块顺序）+ 技能仓库 + 更新 =====

export interface AppConfig {
  theme: Theme;
  /** 界面动效总开关（仅展示层）：默认开启，用户在设置里关闭后本机记住；
      false 时恢复系统鼠标指针并停用装饰动画，业务逻辑不受影响 */
  fx: boolean;
  /** 粒子尘场（界面动效的子开关，默认关闭）：最底层 canvas 尘粒，
      持续重绘并驱动毛玻璃重新采样，是背景层最吃性能的一项 */
  fxParticles: boolean;
  /** 光池追随（界面动效的子开关，默认关闭）：鼠标互动光影——
      两团跟随光标游走的光斑、玻璃壳随光标的反光、卡片悬停聚光与液态背景的光标视差 */
  fxPools: boolean;
  /** 个性化鼠标样式（界面动效的子开关，默认开启）：液滴光标 + 点击涟漪；
      关闭后恢复系统指针，业务逻辑不受影响 */
  fxCursor: boolean;
  moduleOrder: ModuleKey[];
  /** 四大板块启用开关（issue #91）：关闭后左上角置灰不可点、后台完全不运行；
      唯一写入口是 module_toggle IPC，这里的值只作展示同步 */
  modules: Record<ModuleKey, { enabled: boolean }>;
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
    /** 全局快捷键：唤起/收起主窗口（默认 Alt+`，两键）。必须是「功能键+字符键」组合；
     *  注意 ~ 会被归一成 `（~ 需要 Shift，实际是三键组合）；空串 = 不注册。
     *  冲突时弹气泡提示并持续重试，解除后自动恢复。 */
    shortcutToggle: string;
    /** 轻量模式：关窗时销毁窗口（释放整个渲染进程），托盘常驻期间后端照旧跑。
     *  仅在 minimizeToTray 开启时有意义。默认关（与改造前行为一致）。 */
    lightweightMode: boolean;
    autoStart: boolean;
    hourly: boolean;
    daily: boolean;
    dailyTime: string;
    notifyOnSuccess: boolean;
  };
  watch: { enabled: boolean; intervalSeconds: number };
  /** 反代网关设置（框架整体设置的一部分；端口改动需重启监听，其余热生效） */
  proxy: ProxyConfig;
  /** 记忆中枢：框架侧只管启用开关与根目录指针，其余配置在 <仓库>/config/memory.config.json */
  memory: MemoryPointerConfig;
  /** 提示词库：内置板块，配置与技能/号池同源（走 app.save() 落 framework config.json）。
   *  字段与 electron/backend/config.cjs 的 defaultConfig().prompts 一一对应 */
  prompts: PromptsConfig;
}

/** 提示词库配置段（契约 §2 冻结字段；新增键由后端 mergeConfig 深合并补默认，缺字段也不炸） */
export interface PromptsConfig {
  // ===== 同步 =====
  /** 自动同步（WebDAV）总开关，默认 true */
  syncAuto: boolean;
  /** 自动同步周期（小时，1~24，默认 4）；「设置 · 同步时间 · 提示词库」里的数字输入框读写它 */
  syncIntervalHours: number;
  /** 三方合并策略 */
  mergeStrategy: "newer-wins" | "local-wins" | "remote-wins" | "longer-wins" | "manual";
  /** 删除冲突处理：tombstone=以墓碑为准（删除胜）；keep-modified=本地改过的保留 */
  onDeleteConflict: "tombstone" | "keep-modified";
  /** 是否同步版本历史，默认 true */
  syncVersions: boolean;
  // ===== 库 =====
  /** 库根目录；空 = 默认 ~/AgentHub/prompts（由后端 promptsLibDir() 解析） */
  rootDir: string;
  /** 每条提示词保留的历史版本数，默认 20 */
  versionKeep: number;
  /** 回收站保留天数，默认 30 */
  trashDays: number;
  /** 单条提示词大小上限（KB），默认 1024 */
  itemMaxKB: number;
  /** 新建提示词的默认分类 */
  defaultCategory: string;
  // ===== 优化 =====
  /** 默认风格 id（内置风格见 styles.cjs），默认 builtin-general */
  defaultStyleId: string;
  /** 默认模型；空 = 跟随模型与网关默认 */
  defaultModel: string;
  /** 输出长度上限（字符），默认 800 */
  maxLength: number;
  /** 采样温度，默认 0.7 */
  temperature: number;
  /** 最大输出 token，默认 4096 */
  maxTokens: number;
  /** 单次优化超时（秒），默认 60 */
  timeoutSec: number;
  /** 目标场景描述（渲染进系统模板） */
  scenario: string;
  /** 优化历史上限（条），默认 50 */
  historyLimit: number;
  /** 流式输出，默认 true；上游不支持时后端自动回退非流式 */
  stream: boolean;
}

/** 提示词库配置的默认值（契约 §2 冻结值）。
 *  单一事实源放这里而不是页面层：stores/app.ts 的深合并基线与配置页首帧渲染都要用它，
 *  让 store 反向依赖 views 会把分层搞乱；页面层由 promptTypes.ts re-export 出去。
 *  权威默认值仍以 electron/backend/config.cjs 的 defaultConfig().prompts 为准（后端负责补键）。 */
export const PROMPTS_CONFIG_DEFAULTS: PromptsConfig = {
  syncAuto: true,
  syncIntervalHours: 4,
  mergeStrategy: "newer-wins",
  onDeleteConflict: "tombstone",
  syncVersions: true,
  rootDir: "",
  versionKeep: 20,
  trashDays: 30,
  itemMaxKB: 1024,
  defaultCategory: "未分类",
  defaultStyleId: "builtin-general",
  defaultModel: "",
  maxLength: 800,
  temperature: 0.7,
  maxTokens: 4096,
  timeoutSec: 60,
  scenario: "通用 AI 助手",
  historyLimit: 50,
  stream: true,
};

export interface MemoryPointerConfig {
  enabled: boolean;
  rootDir: string;
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
  /** 渠道成本感知排序：score=按打分（现状）/ cost-first=按成本档升序（免费→低成本→普通，组内按打分） */
  routeOrder: "score" | "cost-first";
  rateLimitPerMin: number;
  concurrency: number;
  creditsRefreshMin: number;
  /** 请求流水保留期（天，1~3650）：启动 GC 与用量统计页「清理」共用，
   *  默认 90 = 该保留期此前在 proxy/store.cjs 的 gc() 里写死的那个数 */
  usageRetentionDays: number;
  /** 积分包「即将到期」预警阈值（天，0~3650，0=关闭预警）。号池到期徽标与逐包明细共用这一个值，
   *  默认 1 = 该阈值此前在 pool.cjs 里硬编码的那个数 */
  expiringSoonDays: number;
  /** 号池定时同步（poolsyncSchedule）：hourly 每小时档 / daily 每天固定时刻，全关 = 仅手动；
   *  API Keys 与模型映射随号池同步走，自动同步让新设备开箱即得 */
  poolsyncSchedule: { hourly: boolean; hourlyInterval: number; daily: boolean; dailyTime: string };
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
  /** 反向模型映射：统一请求模型名 → { [渠道 id]: 渠道实际模型名 }（渠道确定后解析并转发实际模型，响应 model 字段保持统一请求名） */
  modelReverseAliases: Record<string, Record<string, string>>;
  /** 模型参数自定义覆盖：modelId → 自定义参数（上下文长度、最大输出、思考强度） */
  modelCustom: Record<string, ModelCustomEntry>;
  /** 不可用时自动切换模型（统一设置，默认开）：模型未知或号池耗尽时切到 fallbackModel */
  autoFallbackEnabled: boolean;
  /** 全局统一回退模型（autoFallbackEnabled 开启且 per-model 未配置时生效） */
  fallbackModel: string;
  /** 跨渠道故障转移：渠道降级/耗尽时请求内自动跳其他渠道（默认开） */
  channelFailover: boolean;
  /** 单请求最多尝试渠道数（含主渠道；范围 1~10、超出按 10；上游尝试预算随上限放大：每模型 max(6, 本值+1) 次、渠道间共享，failover 关闭恒 6） */
  channelFailoverMax: number;
  /** 渠道降级基础时长（毫秒），失败翻倍防半开震荡 */
  channelCooldownMs: number;
  /** 渠道降级指数退避封顶（毫秒） */
  channelCooldownCapMs: number;
  /** 按渠道自动签到：{ [渠道 id]: 规则 }，号池页各渠道工具栏各自设置（默认全关） */
  checkinAutoRules: Record<string, ProxyCheckinAutoRule>;
  /** 渠道启闭（「上游启闭」弹窗）：{ [渠道 id]: true|false }，缺省 = 启用；关闭的渠道全部页面动态隐藏 */
  channelEnabled: Record<string, boolean>;
  /** 生态接入默认模型（注册进 CC Switch 时使用，缺省取 fallbackModel） */
  ccSwitchModel: string;
}

/** 按渠道自动签到规则（proxy.checkinAutoRules 的值；号池页「自动签到」弹窗读写） */
export interface ProxyCheckinAutoRule {
  enabled: boolean;
  /** 每日执行时间 HH:mm */
  time: string;
  /** 抖动分钟数：到点后随机延迟 0~jitterMin 分钟执行（当天内固定，默认 0 = 不抖） */
  jitterMin: number;
}

// ===== 反代网关：数据结构（跟 electron/backend/proxy/* 返回一一对应） =====

export type ProxyChannelId = "trae" | "workbuddy" | "workbuddy_ai" | "raccoon" | "modelscope" | "lobster" | "zcode" | "catpaw" | "qoder" | "qoder_intl" | "autoclaw" | "autoclaw_intl" | "cline_free" | "cline_pass" | "accio" | "accio_cn" | "codearts" | "loomy";
/** Key 路由：auto 或任一渠道 id（渠道后续扩充即为普通字符串，保留字面量仅为补全提示） */
export type ProxyRoute = "auto" | ProxyChannelId | (string & {});
export type ProxyAccountStatus = "online" | "cooling" | "exhausted" | "relogin" | "disabled";
export type ProxyPoolStrategy = "expire_first" | "credit_first" | "round_robin";
/** 渠道成本档（cost-first 路由排序用；'' = 未标注按 normal 解释） */
export type ProxyCostTier = "free" | "low" | "normal";
/** per-key 路由策略（'' = 跟随全局） */
export type ProxyRouteOrder = "" | "score" | "cost-first";

export interface ProxyKeyRow {
  id: string;
  name: string;
  mask: string;
  route: ProxyRoute;
  /** per-key 路由策略覆盖（'' = 跟随全局默认） */
  routeOrder: ProxyRouteOrder;
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
/** live 配置的实际指向（真实流量路径的地面真相）：gateway=直连 AgentHub 网关；
 *  ccswitch=经 CC Switch 本地代理（需其运行）；other=指向其它地址；unset=未配置服务地址 */
export interface CcSwitchLiveRoute {
  url: string;
  target: "gateway" | "ccswitch" | "other" | "unset";
}
export interface CcSwitchStatus {
  installed: boolean;
  /** 库在但 providers 表缺失等异常（按未注册展示，注册时会被更准确的报错拦截） */
  incompatible?: boolean;
  dbPath?: string;
  /** proxy_config 两列语义（实测）：enabled=接管开关的持久化意图（CC Switch 退出仍为 1，下次启动自动恢复）；
   *  claudeDesktop 借 claude 行 proxy_enabled=当前是否接管中（Desktop 映射依赖它常驻）。
   *  即 enabled=1 而 CC Switch 未运行时，live 已被恢复为直连，此开关不代表流量正经过它 */
  takeover?: { claude: boolean; codex: boolean; claudeDesktop: boolean };
  /** 各应用 live 配置当前实际指向（Claude Code 读 ~/.claude/settings.json，Codex 读 ~/.codex/config.toml） */
  live?: { claude: CcSwitchLiveRoute; codex: CcSwitchLiveRoute };
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

/** 单个积分包/加油包明细：上游按包发放，逐包各有面值/已用/到期。
 *  expired / expiringSoon 是「时间态」，由主进程按 proxy.expiringSoonDays 出视图时现算，
 *  不落库——写进库的"今天"会被刷新时刻冻结，隔天再看全是旧的。 */
export interface ProxyCreditPackage {
  /** 包唯一标识（同账号内稳定，列表 key 用）；上游缺失时回落 pack{i} */
  code: string;
  /** 包名/来源（如 Trae 的 display_desc、WorkBuddy 的 PackageName） */
  name: string;
  /** ⚠ -1 = 「上游不给这一包的总额」（界面渲染「—」），**不是**「额度不限」；
   *  后者只由 remaining === -1 表达。两者混为一谈时，一个只是缺面值字段的包会把整个
   *  账号的余额派生成无限并绕开 cost-first 路由。 */
  total: number;
  /** 已用（total 未知时为 0） */
  used: number;
  /** 剩余；-1 = 额度不限 */
  remaining: number;
  /** 到期时间戳（毫秒）；0 = 无到期 / 长期有效 */
  expiresAt: number;
  /** 已过期（expiresAt > 0 且 <= now） */
  expired?: boolean;
  /** 即将到期（now < expiresAt < now + expiringSoonDays 天） */
  expiringSoon?: boolean;
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
  /** 今日签到结果（行内按钮三态与详情弹窗数据源；只留当天一条，跨天按 day 判为过期） */
  checkin?: ProxyCheckinRecord | null;
  /** 生效中的模型级负缓存（6004/11102 只罚"账号×模型"不落账号状态；空数组 = 无） */
  modelCool?: { model: string; until: number; reason: string }[];
  /** 逐包明细（有包的渠道才有；无包的渠道这个字段不出，界面回落账号级聚合行） */
  packages?: ProxyCreditPackage[];
  source: "scan" | "oauth" | "paste";
  /** 账号备注（备注弹窗写入；落 meta.note，副行展示 + 随 WebDAV 同步） */
  note?: string;
  lastUsed: number;
  todayReq: number;
  todayTokens: number;
  createdAt: number;
  hasToken: boolean;
  /** 本机 agent 客户端当前登录的就是这个账号（主进程按本地登录态 uid 比对，号池列表打「本机登录」徽标） */
  liveHere?: boolean;
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

/** 渠道降级状态（号池视图 / 网关状态里随渠道返回；null = 正常） */
export interface ProxyChannelHealth {
  /** 降级截止时刻（毫秒时间戳），到期自动回切 */
  until: number;
  /** 降级原因（渠道耗尽 / 上游边缘拦截 / 限流等） */
  reason: string;
  /** 连续降级次数（驱动指数退避翻倍） */
  streak: number;
}

export interface ProxyChannelView {
  id: ProxyChannelId;
  display: string;
  domain: string;
  poolStrategy: ProxyPoolStrategy;
  /** 成本档（cost-first 路由排序用；空串 = 未标注按 normal） */
  costTier: ProxyCostTier | "";
  /** 该渠道的自动签到规则（读源；写走 proxy_checkin_auto_set） */
  checkinAuto: ProxyCheckinAutoRule;
  summary: ProxyPoolSummary;
  accounts: ProxyAccount[];
  /** 降级状态：null = 正常 */
  health: ProxyChannelHealth | null;
  /** 渠道启闭（「上游启闭」弹窗）：缺省/true = 启用；false = 已关闭（全部页面动态隐藏） */
  enabled?: boolean;
}

// ===== 自定义提供商（中转站 / 自建 OpenAI 兼容端点） =====

/** 提供商的上游协议形态。值集合与后端 provider.cjs 的 KINDS 同源，漂移由
 *  scripts/test-provider-ui.cjs 断言守住。这一版只做 OpenAI Chat 一种：另两种形态需要
 *  入站协议面与出站互转模块，随后续 PR 进来。 */
export type ProxyProviderKind = "openai_compat";
/** 渠道 kind：内置生态渠道（builtin）或自建提供商的协议形态 */
export type ProxyChannelKind = "builtin" | ProxyProviderKind;

/** models 条目：字符串 = 裸名且上游同名；对象 = 可带「客户端名 → 上游真名」映射与目录元数据 */
export type ProxyProviderModel = string | {
  model: string;
  /** 上游真实模型名，缺省 = model。`slug/model` 路由时发给上游的是这个 */
  upstream?: string;
  /** 额外的可请求名：原名与别名都命中同一上游模型，但别名不出现在 /v1/models */
  aliases?: string[];
  /** 思考档位声明：supportedEfforts 决定客户端要的档位能否原样透传，不支持时按此降级 */
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
  name?: string;
  rate?: number;
  capabilities?: Record<string, boolean | string | number>;
  contextLength?: number;
  maxOutputTokens?: number;
};

/** 提供商条目（管理页的模型表按对象处理；字符串简写只在读侧兼容，写侧一律展开成对象） */
export type ProxyProviderModelRow = Exclude<ProxyProviderModel, string>;

/** 「Key 管理」弹窗的运行态视图。刻意不复用 ProxyAccount：它的 channel 是
 *  ProxyChannelId 那个闭合字面量联合，而提供商的 slug 是运行期数据、编译期无从枚举。 */
export interface ProxyProviderKey {
  id: string;
  name: string;
  status: ProxyAccountStatus;
  hasToken: boolean;
  coolUntil: number;
  coolReason: string;
  todayReq: number;
  lastUsed: number;
}

export interface ProxyProvider {
  /** 路由前缀，创建后不可改（accounts.channel 以它为键） */
  id: string;
  display: string;
  domain?: string;
  kind: ProxyChannelKind;
  enabled: boolean;
  baseUrl: string;
  models: ProxyProviderModel[];
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  updatedAt: number;
  keyCount?: number;
  onlineCount?: number;
  /** Key 管理的数据源：号池视图只按内置渠道迭代、不含提供商，列表顺带把脱敏运行态带回来 */
  keys?: ProxyProviderKey[];
}

export interface ProxyProviderTestResult {
  ok: boolean;
  message?: string;
  status?: number;
  ms?: number;
  model?: string;
  sample?: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 号池总览（原反代网关运行状态）：转发服务下线后只保留号池聚合指标与各渠道余额 */
export interface ProxyGatewayStatus {
  channels: (ProxyPoolSummary & { id: ProxyChannelId; display: string })[];
  channelCount: number;
  accountCount: number;
  onlineCount: number;
  expiringSoonCount: number;
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
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  ttftMs: number;
  latencyMs: number;
  status: number;
  error: string;
}

/** 统计区间：毫秒闭区间 + 生效粒度（auto 由后端按跨度决策后回填） */
export interface ProxyStatsRange {
  from: number;
  to: number;
  granularity: "hour" | "day";
}

/** 富字段聚合行：TOP 排行与各 Key 用量共用（tokens = prompt + completion，缓存 token 是 prompt 的子集） */
export interface ProxyStatsAggRow {
  /** 分组身份 id：channel/model 为值本身，key/account 为 key_id/account_id——
   *  名字可改且可能撞名，前端列表 key 必须绑它而不是 name */
  id: string;
  name: string;
  req: number;
  ok: number;
  err: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokens: number;
  ttftAvg: number;
  latencyAvg: number;
}

/** 各 Key 用量行：Key 名可改，keyId 才是身份；lastTs 供「最近使用」列 */
export interface ProxyStatsKeyRow extends ProxyStatsAggRow {
  keyId: string;
  lastTs: number;
}

/** 时间序列点（后端已按粒度补零，图表 x 轴连续） */
export interface ProxyStatsPoint {
  t: number;
  label: string;
  req: number;
  ok: number;
  err: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokens: number;
  ttftAvg: number;
  latencyAvg: number;
}

/** 区间 KPI 汇总 */
export interface ProxyStatsSummary {
  req: number;
  ok: number;
  err: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  ttftAvg: number;
  ttftP50: number;
  latencyAvg: number;
  channels: number;
  models: number;
  keys: number;
  accounts: number;
}

export type ProxyStatsDim = "channel" | "model" | "key" | "account";

export interface ProxyStatsOverview {
  range: ProxyStatsRange;
  summary: ProxyStatsSummary;
  series: ProxyStatsPoint[];
  tops: Record<ProxyStatsDim, ProxyStatsAggRow[]>;
  keys: ProxyStatsKeyRow[];
  status: { name: string; key: string; value: number }[];
  tokenMix: { name: string; key: string; value: number }[];
}

export interface ProxyStatsDetail {
  total: number;
  page: number;
  pageSize: number;
  /** 当前筛选命中的 token 汇总（与 total 同口径，供表尾量化筛选结果） */
  agg: { req: number; promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number; tokens: number };
  rows: ProxyUsageRow[];
}

/** 反代网关操作日志（proxy_oplog_list / proxy_oplog_export 的行；op_logs 表） */
export interface ProxyOpLogRow {
  id: number;
  ts: number;
  /** info = 成功/常规；warn = 降级/需人工/4xx；error = 失败/5xx/网络 */
  level: string;
  /** 操作分类（代理请求 / 签到 / 网关启停 / API Key / 号池账号 / 网关配置 / OAuth 登录 / 模型目录 / 切换账号 / 生态接入 / 号池同步 / 自动签到 / 冷却与风控） */
  op: string;
  message: string;
  channel: string;
  /** 对象（账号名 / Key 名 / uid 等业务主体） */
  target: string;
  /** 详情（上游错误轨迹等，列表里 tooltip 展示） */
  detail: string;
}

export interface ProxyOpLogList {
  rows: ProxyOpLogRow[];
  total: number;
}

// ===== 反代网关 · 网络代理（出口池；netproxy.json）=====

/** 一次连通性测试的结果（落进条目 lastTest，也在测试接口直接返回） */
export interface ProxyNetProxyTest {
  success: boolean;
  /** 目标站点返回的状态码（连不上为 null） */
  status: number | null;
  /** 出口 IP（附加信息，拿不到为空串） */
  ip: string;
  durationMs: number;
  /** 失败原因（成功为空串） */
  error: string;
  /** 测试时刻（仅落盘的 lastTest 有） */
  at?: number;
}

export interface ProxyNetProxyItem {
  id: string;
  name: string;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  /** 密码只回「有没有」，明文永不出后端 */
  hasPassword: boolean;
  enabled: boolean;
  lastTest: ProxyNetProxyTest | null;
  createdAt: number;
  updatedAt: number;
}

/** 出口策略：off 直连 · fixed 固定一条 · rotate 轮询启用条目 */
export type ProxyNetProxyMode = "off" | "fixed" | "rotate";

export interface ProxyNetProxyList {
  ok: boolean;
  mode: ProxyNetProxyMode;
  fixedId: string;
  settings: {
    testUrl: string;
    timeoutMs: number;
    /** 默认值（「恢复默认」回填用） */
    defaultTestUrl: string;
    defaultTimeoutMs: number;
  };
  items: ProxyNetProxyItem[];
}

export interface ModelCustomEntry {
  /** 自定义上下文长度（Token） */
  contextLength?: number;
  /** 自定义最大输出 Token */
  maxOutputTokens?: number;
  /** 自定义思考强度（"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | string） */
  reasoningEffort?: string;
}

export interface ProxyModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  sources: ProxyChannelId[];
  /** 各渠道适配器声明的原始模型 id；反向映射目标必须从这里选，不能从融合后的 sources 反推 */
  channelModelIds?: Partial<Record<ProxyChannelId, string[]>>;
  /** 目录元数据（catalog.json）：显示名 / 倍率（积分倍率，null=未知）/ 能力 / 上下文长度 */
  name?: string;
  rate?: number | null;
  capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean };
  contextLength?: number;
  maxOutputTokens?: number;
  /** 管理态（proxy_models 返回时合并）：启用 / per-model 渠道覆盖 / 回退模型 / 自定义参数 */
  enabled: boolean;
  override: "" | ProxyChannelId;
  fallback: string;
  custom?: ModelCustomEntry;
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

/** zcode 账号级设备指纹（deviceMid）诊断行：周末套餐领取资格的设备维判据 */
export interface ZcodeDeviceRow {
  id: string;
  name: string;
  uid: string;
  deviceMid: string;
  /** 指纹缩略（前 8 位）供列表展示 */
  short: string;
  /** 该账号是否为本机 ZCode 客户端当前登录账号 */
  isLive: boolean;
  /** 与同池其它账号共用同一枚指纹的行下标（互为指认） */
  conflictWith: number[];
  /** 指纹等于 live 指纹但本人不是当前登录号：任何消耗都在烧 live 号的资格 */
  liveShared: boolean;
  /** 本周资格大概率已被消耗（撞车组或 live 共享）：preview 有套餐但 claim 必 1004 */
  burnedLikely: boolean;
}

export interface ZcodeDeviceStatusResult {
  ok: boolean;
  /** 本机 telemetry-state.json 当前 deviceMid */
  liveMid: string;
  /** 本机远程锚定指纹（anchor.remoteMid，终生恒定；远程链接 mid 参数的合法值） */
  anchorMid?: string;
  /** 锚定值落锚时间（毫秒时间戳，0 = 未知） */
  anchorSavedAt?: number;
  /** 指纹借出中（领取模式）：live ≠ 锚定值，手机远程不可用 */
  claimMode?: boolean;
  rows: ZcodeDeviceRow[];
  /** 本次修复重派的账号数（repair 专有） */
  repaired?: number;
  message?: string;
}

/** zcode 领取模式/恢复锚定指纹的返回（proxy_zcode_claim_mode / proxy_zcode_restore_mid） */
export interface ZcodeClaimModeResult {
  ok: boolean;
  channel?: string;
  /** 客户端在跑且未确认：为 true 时前端弹确认框，用户确认后带 confirmAck 重调 */
  needConfirm?: boolean;
  probe?: {
    channel: string;
    clientName: string;
    file: string;
    exe: string;
    running: boolean;
    relaunch: boolean;
    note?: string;
    warning?: string;
  };
  /** 借出/恢复的指纹变化（from → to） */
  from?: string;
  to?: string;
  /** 目标指纹与 live 相同（幂等无操作） */
  unchanged?: boolean;
  /** 本机锚定指纹（领取期间不可变更的事实源） */
  anchorMid?: string;
  /** 客户端是否已自动重启 */
  relaunched?: boolean;
  message?: string;
}

/** 账号今日签到记录（主进程 meta.checkin 持久化）：号池行内按钮三态 + 详情弹窗的数据源 */
export interface ProxyCheckinRecord {
  /** 记录所属日期 YYYY-MM-DD（本地时区）：与今天不一致即视为过期，按钮回到待签到 */
  day: string;
  /** 记录时刻（毫秒时间戳） */
  at: number;
  /** 执行的动作：checkin=签到 / trial=加油包 */
  action: "checkin" | "trial";
  ok: boolean;
  /** 已签到 / 已领取过（幂等成功） */
  already?: boolean;
  /** 服务对该账号不开放（视为完成，不是失败） */
  unavailable?: boolean;
  /** zcode 领取奖励需人机校验（自动 tick 跳过，视为失败待人工） */
  needCaptcha?: boolean;
  /** zcode 1004：设备指纹本周已被消耗 */
  deviceBurned?: boolean;
  /** 本次获得积分/Credits */
  credit?: number;
  /** 连续签到天数 */
  streakDays?: number;
  /** 结果说明 / 失败原因（截 400 字） */
  message?: string;
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
  /** zcode 领取奖励：需要人机校验（滑块/点选）；自动签到 tick 里出现时表示要到号池页手动领取 */
  needCaptcha?: boolean;
  /** zcode 领取奖励 1004：设备指纹本周已被消耗，须「指纹修复」换新指纹后重试 */
  deviceBurned?: boolean;
  /** zcode 渠道：账号当前可领取的奖励套餐列表（adapters.cjs 组装） */
  plans?: { planId: string; name: string; description: string; priority: number; endsAt: number }[];
  /** zcode 领取奖励：已领取过时的下次可领窗口（毫秒时间戳） */
  nextAt?: number;
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

/** 五大模块 → 子页面映射（内置顺序即默认导航顺序，可在「设置 · 通用」中调整）
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
    name: "号池管家",
    // 原「反代网关」已停止维护，转发链路（API Keys / 模型目录 / 用量统计 / 自定义提供商 /
    // 生态接入 / 网络代理）随之上线归档，只保留号池管理相关的五个页面。
    pages: [
      { id: "home", name: "总览" },
      { id: "agents", name: "号池" },
      { id: "expiry", name: "积分日历" },
      { id: "poolsync", name: "号池同步" },
      { id: "proxylog", name: "日志" },
    ],
  },
  {
    key: "memory",
    name: "记忆中枢",
    pages: [
      { id: "dashboard", name: "仪表盘" },
      // 待确认收件箱（事实失效 / 项目归类 / 去重三类人工裁决）不是独立页签：
      // 它是「记忆浏览」内的第四个视图（列表 / 热力图 / 待确认 / 回收站），条目带待处理红点
      { id: "browse", name: "记忆浏览" },
      { id: "projects", name: "项目归档" },
      { id: "profile", name: "深层画像" },
      // 接入与迁移：Agent 接入 + 导入历史 + 多机同步三段合一（原来三个独立页签）
      { id: "hub", name: "接入与迁移" },
      // 旧三段页签保留定义：老配置的 ui.tabs 显式勾选过它们的用户仍能打开（默认白名单已切到 hub）
      { id: "agents", name: "Agent 接入" },
      { id: "index", name: "检索与索引" },
      { id: "auto", name: "自动化" },
      { id: "import", name: "导入与去重" },
      { id: "sync", name: "WebDAV同步" },
    ],
  },
  {
    key: "prompts",
    name: "提示词库",
    pages: [
      { id: "optimize", name: "优化提示词" },
      // 优化历史独立成页：主优化视图不再塞右侧抽屉，历史留痕有整页空间浏览与筛选
      { id: "history", name: "优化历史" },
      { id: "library", name: "个人提示词库" },
      // 线上提示词库：纯客户端精选目录（内置基线 + 远程分片增量 + 用户导入）。
      // 不做账号/云端收藏/投稿——没有服务端，任何要「用户身份」的能力都得先建后端。
      { id: "online", name: "线上提示词库" },
      { id: "sync", name: "WebDAV 同步" },
    ],
  },
];

// ===== 记忆中枢：数据结构（与 electron/backend/memory 的返回一一对应） =====

export type MemoryLayer = "l1" | "l2";

export type MemoryRow = {
  id: string;
  /** 相对仓库根的 MD 路径 */
  path: string;
  /** daily 文件的节锚点（非 daily 为 null） */
  anchor?: string | null;
  type: string;
  layer: MemoryLayer;
  title: string;
  summary: string;
  tags: string[];
  project: string | null;
  /** 项目显示名（后端按台账解析；slug 是机器标识，界面展示用这个） */
  projectName?: string | null;
  agent: string;
  device?: string | null;
  session?: string | null;
  created: number;
  updated?: number;
  importance: number;
  pinned?: boolean;
  starred?: boolean;
  /** 已失效（双时间轴） */
  superseded?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
  /** 「被谁取代」的目标标题（详情接口带出，目标被清理时后端回落为 id） */
  supersededByTitle?: string | null;
  /** 检索得分（仅搜索接口返回） */
  score?: number;
  scoreParts?: Record<string, number>;
};

export type MemoryDetail = MemoryRow & {
  body: string;
  hash?: string;
  refs?: string[];
  dedupStatus?: string;
  aiProcessed?: boolean;
  bodyMissing?: boolean;
};

export type MemoryStats = {
  total: number;
  projects: number;
  today: number;
  yesterday: number;
  pending: number;
  l2: number;
  agents: number;
  indexBytes: number;
  llmToday: number;
  llmCalls: number;
};

export type MemoryIndexStatus = {
  rows: number;
  fts: number;
  ftsW: number;
  consistent: boolean;
  projects: number;
  today: number;
  pending: number;
  sizeBytes: number;
  walBytes: number;
  lastBuildAt: number;
  lastScanAt: number;
  rootDir: string;
};

export type MemoryTimelineNode = {
  id: string;
  title: string;
  created: number;
  validFrom?: number | null;
  validTo?: number | null;
  supersededBy?: string | null;
  current: boolean;
};

export type MemoryProjectCard = {
  slug: string;
  name: string;
  remotes: string[];
  /** 完整 git 地址（host/owner/repo，来自 origin 探测；老卡可能为空） */
  gitUrl?: string;
  aliases: string[];
  localPaths: string[];
  origin: string;
  updated: number;
  count: number;
  l2: number;
  latest: number;
  agents: string[];
};

export type MemoryAgentCard = {
  id: string;
  name: string;
  custom?: boolean;
  optional?: boolean;
  enabled: boolean;
  note?: string;
  configPath: string;
  configExists: boolean;
  format: string;
  snippetHint?: string;
  instructionPath: string;
  instructionExists: boolean;
  injected: boolean;
  verifyConfig: { ok: boolean; message: string };
  beat: { lastCall: number; calls: number; writes: number; searches: number; errors: number; lastTool: string } | null;
  pathReady: boolean;
};

export type MemoryAgentVerify = {
  agent: string;
  name: string;
  /** none < detected < configured < handshaked < verified */
  level: "none" | "detected" | "configured" | "handshaked" | "verified";
  config: { ok: boolean; message: string };
  handshake: { ok: boolean; message?: string; latencyMs?: number; tools?: number; serverInfo?: Record<string, unknown> };
  real: { ok: boolean; message?: string; lastCall?: number; calls?: number; writes?: number; searches?: number; errors?: number; lastTool?: string };
  command: { command: string | null; args: string[]; env: Record<string, string>; hostExists: boolean; bridgeExists: boolean };
  configPath: string;
  instructionPath: string;
  instructionInjected: boolean;
};

export type MemoryBridgeStatus = { running: boolean; port: number; tokenReady?: boolean; pid?: number };

export type MemoryConfigFieldMeta = {
  type: string;
  def: unknown;
  label: string;
  group: string;
  hot?: boolean;
  desc?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tier?: "basic" | "advanced" | "internal";
};

export type MemoryConfigEnvelope = {
  config: Record<string, any>;
  schema: Record<string, MemoryConfigFieldMeta>;
  root: string;
  diff: { key: string; value: unknown; default: unknown }[];
};

export type MemoryStatusEnvelope = {
  enabled: boolean;
  root: string;
  bridge: MemoryBridgeStatus;
  index: MemoryIndexStatus | null;
  verifiedAgents: number;
  beats: { agent: string; last_call: number; calls: number; writes: number; searches: number; errors: number; last_tool: string }[];
};

export type MemoryToolRow = {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type MemoryBeatsRow = { agent: string; last_call: number; calls: number; writes: number; searches: number; errors: number; last_tool: string };

/** 记忆中枢事件（event="memory"，type 区分：新记忆/索引/桥/任务/配置等） */
export interface MemoryEvent {
  event: "memory";
  type: string;
  [key: string]: unknown;
}

// ===== 提示词库：数据结构（与 electron/backend/prompts 的返回一一对应，字段名逐字照契约 §3） =====

/** 提示词里的变量占位（正文中写 {{name}}，渲染时按 def 兜底填充） */
export type PromptVariable = { name: string; label?: string; def?: string; required?: boolean };

/** 单条历史版本快照；by 区分人工保存与同步自动合并，便于在详情页标注来源 */
export type PromptVersion = { version: number; body: string; at: number; note?: string; by?: "user" | "sync-merge" };

export type PromptItem = {
  id: string;
  name: string;
  description: string;
  /** 正文（不含 frontmatter；落盘时由后端拼装） */
  body: string;
  variables: PromptVariable[];
  category: string;
  tags: string[];
  /** local=本机新建；optimized=优化产出；online=线上库（二期）；imported=导入 */
  source: "local" | "optimized" | "online" | "imported";
  /** 来源引用（线上库 id / 导入文件名等） */
  originRef?: string;
  originMeta?: { author?: string; license?: string; url?: string; version?: string };
  /** 血缘：优化产出时记录父版本 hash / 风格 / 模型 / 原始输入，用于回溯「这条从哪来」 */
  lineage?: { parentHash?: string; styleId?: string; model?: string; inputText?: string };
  /** 当前版本号（与 versions 的最后一项对应） */
  version: number;
  /** 历史版本（按 version 升序；上限由 config.prompts.versionKeep 控制） */
  versions: PromptVersion[];
  favorite: boolean;
  pinned?: boolean;
  useCount: number;
  lastUsedAt: number;
  /** 内容哈希：乐观锁与三方合并的判定依据（后端算，前端只回传） */
  hash: string;
  createdAt: number;
  updatedAt: number;
  /** 软删除时间戳（进回收站）；未删除为 undefined */
  deletedAt?: number;
};

export type PromptStyle = {
  id: string;
  name: string;
  description: string;
  /** 系统提示词模板（可含 {{scenario}} / {{maxLength}} 等占位） */
  systemTemplate: string;
  userTemplate?: string;
  maxLength?: number;
  temperature?: number;
  /** 内置风格：不可删除，只能改（「恢复内置默认」会重置它们） */
  builtin: boolean;
  isDefault?: boolean;
};

export type PromptHistoryItem = {
  id: string;
  at: number;
  styleId: string;
  styleName: string;
  model: string;
  inputText: string;
  outputText: string;
  /** 输入/输出被截断标记（历史只留前 16KB，截断后详情页要提示） */
  inputTruncated?: boolean;
  outputTruncated?: boolean;
  elapsedMs: number;
  tokens?: { in: number; out: number };
  /** 已保存进库时记录新条目 id（详情页「已入库」据此判定） */
  savedToLibrary?: string;
  applied?: boolean;
  /** 多角度补全的假设清单（正文里已剥离，这里留档以便回溯「当时模型替用户猜了什么」） */
  assumptions?: string[];
  /** 失败时留存的错误码/文案，成功为 undefined */
  error?: string;
};

// ===== 线上提示词库（精选目录）=====
// 与个人库的 PromptItem 是两套结构：目录条目是「只读内容」，收录时才转成 PromptItem。

/** 目录卡片（列表用；不含正文——60 条正文约 19KB，没必要每屏都传） */
export type CatalogItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  subcategory?: string;
  tags: string[];
  templateId?: string;
  lang: "zh" | "en" | "multi";
  license: string;
  version: number;
  updatedAt: number;
  variableCount: number;
  /** 卡片上只展示前 3 个变量名 */
  variableNames: string[];
};

/** 目录详情（抽屉用；带正文与完整变量表） */
export type CatalogItemDetail = Omit<CatalogItem, "variableCount" | "variableNames"> & {
  body: string;
  variables: PromptVariable[];
  author?: string;
  sourceUrl?: string;
  models?: string[];
};

/** 模板：给方法论，不只给文本（抄 awesome-gpt-image-2 的四件套） */
export type CatalogTemplate = {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  useWhen: string;
  guidance: string[];
  pitfalls: string[];
  itemIds: string[];
};

export type CatalogCategory = {
  id: string;
  name: string;
  description?: string;
  subs: { id: string; name: string }[];
};

export type CatalogStats = {
  version: number;
  updatedAt: number;
  count: number;
  /** 用户导入的条数（单独计数：来源不同，责任也不同） */
  imported: number;
  categories: number;
  templates: number;
  /** builtin=内置基线；cache=已拉过远程；none=目录缺失 */
  source: "builtin" | "cache" | "none";
  lastCheckAt: number;
  lastError: string;
  remote: string;
};

export type PromptSyncStatus = {
  running: boolean;
  configured: boolean;
  stage: "idle" | "connect" | "pull" | "merge" | "push" | "done" | "cancelled" | "error";
  stageLabel: string;
  detail: string;
  pct?: number;
  lastSyncAt: number;
  lastError: string;
  /** 本轮自动合并条数（概况卡「已自动合并 N 条」的数据源） */
  autoMerged: number;
  /** 待人工裁决的冲突数（页签红点数据源） */
  pendingConflicts: number;
};

export type PromptConflict = {
  id: string;
  /** content=正文冲突；delete=删除冲突；remote=远端新增同名 */
  kind: "content" | "delete" | "remote";
  name: string;
  title: string;
  detail: string;
  /** 已按策略自动合并（无需人工）；false 时留在裁决队列 */
  autoMerged: boolean;
  strategy?: string;
  kept?: "local" | "remote";
  discardedAt?: number;
  localHash?: string;
  remoteHash?: string;
  at: number;
  resolved?: { at: number; choice: string };
};

export type PromptConflictDiff = {
  item: PromptConflict;
  left: { label: string; body: string; updatedAt: number };
  right: { label: string; body: string; updatedAt: number };
};

export type PromptStats = {
  total: number;
  today: number;
  week: number;
  optimized: number;
  favorited: number;
  trash: number;
  conflicts: number;
  lastSyncAt: number;
};

/** 提示词库事件（event="prompts"；走既有 app:event 通道，字段按契约 §4.4） */
export interface PromptsEvent {
  event: "prompts";
  type: "sync-stage" | "sync-done" | "sync-error" | "library-changed" | "history-changed"
    | "optimize-start" | "optimize-delta" | "optimize-done" | "catalog-updated";
  stage?: PromptSyncStatus["stage"];
  stageLabel?: string;
  detail?: string;
  pct?: number;
  running?: boolean;
  autoMerged?: number;
  pendingConflicts?: number;
  message?: string;
  /** 一次优化请求的 id（start / delta / done 三态共用，前端据此过滤别人的流） */
  runId?: string;
  /** 增量正文（仅 optimize-delta；后端已节流 60ms / 120 字符） */
  delta?: string;
  /** 收尾是否成功（仅 optimize-done） */
  ok?: boolean;
  /** 收尾错误码（仅 optimize-done） */
  code?: string;
}
