// 统一用量模型与配置类型 —— 前后端共用结构（Node 侧对应 electron/backend）

/** 统一用量明细（所有数据源归一化后的结构） */
export interface UsageRecord {
  id: string; // 全局唯一 = `${deviceId}:${source}:${源记录id}`
  deviceId: string; // 电脑标识（ZCode 取 deviceMid）
  deviceName: string; // 用户起的电脑名
  source: string; // 软件源："zcode" | "raccoon" | "codex" | "dsh" | "workbuddy" | "workbuddy-ai" | "reasonix" | "codebuddy" | "qoder" | "qoder-cn" | ...
  providerId: string; // 供应商
  modelId: string; // 具体模型
  variant?: string; // 变体（reasoning 档位 low/max/high）
  taskType?: string;
  sessionId?: string;
  agent?: string;
  mode?: string;

  // 原始 token 分解（不预判口径）
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  credits?: number; // 额度点（Qoder / Antigravity 系官方模型按 credits 计量，不进 token 总量；其余源无此字段）

  startedAt: number; // epoch ms
  completedAt?: number;
  durationMs?: number;
  status: string; // success | error | cancelled ...

  // 费用（getRecords 返回；同步分片不含这些字段——费用是查询时按价格版本动态计算的派生数据）
  costNative?: number; // 该记录币种的原生成本
  costCurrency?: "CNY" | "USD";
  costDisplay?: number; // 显示币种成本
  priced?: boolean; // false = 模型未配置价格（费用计 0）
}

/** 统计口径（platform 口径从未实现，已移除；旧配置值在后端归一化为 compact） */
export type TotalMode = "full" | "compact";

/** 总量口径定义 */
export const TOTAL_MODES: Record<TotalMode, { label: string; desc: string }> = {
  full: { label: "完整口径", desc: "输入 + 输出 + 推理" },
  compact: { label: "简洁口径", desc: "输入 + 输出" },
};

/** 聚合结果（某维度下的分项统计） */
export interface AggregateRow {
  key: string; // 维度键（模型名 / 供应商名 / 设备名 / 日期）
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number; // 按当前口径计算的总量
  count: number; // 记录条数
  cost: number; // 费用（显示币种，Antigravity 配额点不计入）
  unpricedRecords: number; // 未配置价格的记录条数
}

/** 总览摘要 */
export interface Summary {
  totalTokens: number; // 当前范围总量（全部设备或所选设备）
  todayTokens: number; // 今日总量
  cacheHitRate: number; // 缓存命中率（0~1）
  todayCacheHitRate: number; // 今日缓存命中率（0~1）
  cacheReadTokens: number; // 缓存命中量
  inputTokens: number; // 输入总量
  outputTokens: number; // 输出总量
  reasoningTokens: number; // 推理总量
  cacheCreationTokens: number; // 缓存写入量
  todayInputTokens: number; // 今日输入总量
  todayCacheReadTokens: number; // 今日缓存命中量
  recordCount: number; // 明细条数
  todayRecordCount: number; // 今日调用次数
  totalCost: number; // 累计费用（显示币种）
  todayCost: number; // 今日费用
  monthCost: number; // 本月费用（1 日至今）
  monthCostPrev: number; // 上月 1 日至上月同日（同期对比）
  unpricedRecords: number; // 未配置价格且有 token 的记录数
  unpricedTokens: number; // 上述记录的 token 总量
  unpricedModels: number; // 未配置价格的模型数
}

export interface DeviceBreakdown {
  deviceId: string;
  deviceName: string;
  isLocal: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  recordCount: number;
  cost: number; // 费用（显示币种）
}

/** 设备元信息 */
export interface DeviceMeta {
  deviceId: string;
  deviceName: string;
  source: string;
  lastSyncAt: number | null;
  online: boolean;
  totalTokens: number;
  isLocal: boolean;
}

/** WebDAV 配置 */
export interface WebDavConfig {
  endpoint: string; // 如 https://dav.example.com/dav
  username: string;
  password: string;
  root: string; // 根目录，如 /dosage-sync
  preset: string; // feiniu | nextcloud | nutstore | synology | custom
}

/** 本机存储（备份压缩包）配置 */
export interface LocalBackupConfig {
  /** 备份目录；空 = 跟随数据缓存目录 */
  dir: string;
}

/** 数据源配置 */
export interface SourceConfig {
  source: string; // zcode / codex / dsh / workbuddy / workbuddy-ai / reasonix / ...
  enabled: boolean;
  dataDir: string | null; // 数据目录（null 表示自动探测）
}

/** 数据源清单项（由后端 list_sources 下发，name 的唯一事实源是适配器） */
export interface SourceInfo {
  id: string;
  name: string;
  enabled: boolean;
  /** 是否在顶栏显示（由 sourceVisibility 决定） */
  visible: boolean;
}

/**
 * 工具栏切换项自定义配置：控制顶栏各数据源 Tab 的显示/隐藏与排列顺序。
 * 与 sources[].enabled（是否同步）相互独立：隐藏 ≠ 停用，排序 ≠ 启用。
 * 顶层顺序 order 的条目为「源 id」或「组条目 `g:${组key}`」（两级结构）；
 * 旧版本只认识扁平源 id，遇到新配置自动退化为平铺展示，数据不受影响。
 */
export interface SourceVisibility {
  /** 有序的顶层条目列表：源 id 或 `g:组key`（未列出的源按适配器注册顺序补在末尾） */
  order: string[];
  /** 被隐藏（不在顶栏显示）的源 id 列表 */
  hidden: string[];
  /** 组内子项顺序（{ 组key: [源id...] }）；缺失时回退 SOURCE_GROUPS 内置默认顺序 */
  groupOrder?: Record<string, string[]>;
  /** 是否已完成首次初始化（首次启动自动探测后置 true，避免重复覆盖用户自定义） */
  initialized: boolean;
}

/** 内置源家族分组：顶栏/工具栏两级结构的展示层定义（归属固定，用户只调顺序与显隐） */
export interface SourceGroupDef {
  key: string; // 组唯一键；顶层 order 中以 `g:${key}` 表示
  label: string; // 组缩略名（顶栏 pill 与设置页组卡片显示）
  items: string[]; // 组内源 id（同时是组内默认顺序：主程序在前）
}

/** 内置固定分组（WorkBuddy 系 / Trae 系 / Qoder 系 / Antigravity 系）；其余源为独立源不进组 */
export const SOURCE_GROUPS: SourceGroupDef[] = [
  { key: "workbuddy", label: "WorkBuddy", items: ["workbuddy", "workbuddy-ai", "codebuddy"] },
  { key: "trae", label: "Trae", items: ["trae", "trae-cn", "trae-solo", "trae-solo-cn"] },
  { key: "qoder", label: "Qoder", items: ["qoder", "qoder-cn"] },
  { key: "antigravity", label: "Antigravity", items: ["antigravity", "antigravity-ide"] },
];

/** 顶层 order 中组条目的前缀 */
export const GROUP_PREFIX = "g:";

/** 查询源所属内置组；独立源返回 null */
export function sourceGroupOf(sourceId: string): SourceGroupDef | null {
  return SOURCE_GROUPS.find((g) => g.items.includes(sourceId)) ?? null;
}

/** 工具栏顶层条目：独立源 或 组（children 已按组内顺序排列） */
export type TopBarItem =
  | { kind: "source"; source: SourceInfo }
  | { kind: "group"; key: string; label: string; children: SourceInfo[] };

/** 调度配置 */
export interface ScheduleConfig {
  hourly: boolean; // 每小时同步
  hourlyInterval: number; // 小时数
  daily: boolean; // 每天固定时间
  dailyTime: string; // "23:30"
  autoStart: boolean; // 开机自启
  minimizeToTray: boolean; // 关闭最小化到托盘
  notifyOnSuccess: boolean; // 同步成功也弹系统通知（默认关，仅失败通知）
}

/** 用量同步模块配置（原「用量记录同步」AppConfig；主题/软件更新归框架统一管理，不在此持有） */
export interface SyncConfig {
  deviceName: string; // 本机电脑名
  webdav: WebDavConfig;
  localBackup: LocalBackupConfig; // 本机存储（备份压缩包）
  sources: SourceConfig[];
  /** 工具栏切换项显隐与排序（用户可自定义，持久化） */
  sourceVisibility: SourceVisibility;
  schedule: ScheduleConfig;
  totalMode: TotalMode; // 总量口径
  billing: BillingConfig; // 计费设置
}

/** 计费设置 */
export interface BillingConfig {
  enabled: boolean; // 关闭时隐藏费用页入口与所有费用元素
  displayCurrency: "CNY" | "USD"; // 显示币种
  usdToCny: number; // USD→CNY 汇率（手动，改后全部历史费用即时重算）
  importProxy: string; // 价格源导入代理（留空=系统代理/直连）
  remotePricing: RemotePricingConfig; // 远程价格源自动拉取（来源 remote）
}

/** 远程价格源（参考 sub2api pricing.remote_url/hash_url；三层来源中优先级居中：手动 > 远程 > 内置） */
export interface RemotePricingConfig {
  enabled: boolean;
  url: string; // 价格表 JSON 地址（LiteLLM 兼容格式）
  hashUrl: string; // 哈希校验文件地址（可选，远程无变化时短路由）
  intervalHours: number; // 检查间隔（小时，随数据同步顺带触发）
}

/** 同步日志 */
export interface SyncLog {
  id: number;
  time: number; // epoch ms
  kind: string; // extract | package | upload | download | merge
  level: "ok" | "error" | "info" | "warn";
  message: string;
  detail?: string;
}

/** 同步阶段 */
export type SyncStage = "idle" | "extract" | "package" | "upload" | "download" | "merge" | "done" | "cancelled" | "error";

/** 同步进度快照 */
export interface SyncProgress {
  running: boolean;
  restoring?: boolean; // 正在从备份压缩包整包还原（与同步/备份互斥）
  stage: SyncStage;
  stageLabel: string;
  percent: number; // 0~100
  message: string;
  lastSyncAt?: number | null;
  localOnly?: boolean; // 本地模式（未配置 WebDAV 或强制备份）：跳过远程上传/拉取
  backupOnly?: boolean; // 强制备份模式（opts.mode=backup），完成提示为「备份完成」
}

/** 本机存储备份信息（设置页「本机存储」） */
export interface BackupInfo {
  ok: boolean;
  message?: string;
  dir: string; // 解析后的备份目录
  isDefault: boolean; // 是否跟随数据缓存目录
  lastBackupAt: number | null; // 上次备份时间（压缩包 mtime，无包时回退 meta 记录）
  archiveExists: boolean;
  archiveSize: number;
}

/** 数据源健康状态 */
export interface SourceHealth {
  source: string;
  name: string;
  detected: boolean;
  dataDir: string | null;
  readable: boolean;
  lastSyncAt: number | null;
}

/** 数据缓存目录信息（设置页「数据缓存目录」） */
export interface DataDirInfo {
  dataDir: string; // 当前生效的数据目录
  defaultDataDir: string; // 默认目录（用户主目录/.Dosage_sync）
  isCustom: boolean; // 是否已自定义（非默认）
}

/** 设置数据缓存目录的结果 */
export interface SetDataDirResult {
  ok: boolean;
  message: string;
  migrated?: boolean; // 是否迁移了旧缓存数据
  dataDir?: string;
  defaultDataDir?: string;
}

/** 模型价格版本（model_price 表一行） */
export interface PriceEntry {
  id: number;
  providerId: string | null; // null = 不限供应商（通配）
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
  currency: "CNY" | "USD";
  effectiveFrom: number; // epoch ms（含）
  effectiveTo: number | null; // epoch ms（不含）；null = 至今
  updatedAt: number;
  updatedBy: string;
  source: "manual" | "remote" | "builtin"; // manual=手动 > remote=远程拉取 > builtin=内置种子
}

/** 价格表行：每个模型（+供应商维度）的最新版本段 */
export interface PriceRow extends PriceEntry {
  versions: number; // 该模型共有几个价格版本
  active: boolean; // 当前时刻是否生效中（false = 待生效）
}

/** 未配置价格且有 token 消耗的模型 */
export interface UnpricedModel {
  providerId: string;
  modelId: string;
  records: number;
  tokens: number;
  firstSeen: number;
}

/** 导入预览条目（新增/变更共用；changes 带 prev） */
export interface ImportPreviewItem {
  providerId: string | null;
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
  currency: "CNY" | "USD";
  prev?: PriceEntry;
}

/** 价格源导入预览 */
export interface ImportPreview {
  ok: boolean;
  message?: string;
  sourceName?: string;
  resolvedUrl?: string;
  additions: ImportPreviewItem[];
  changes: ImportPreviewItem[];
  missing: { modelId: string }[];
}
