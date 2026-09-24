// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境（npm run dev:web 预览 UI）
// 回退到本地 mock。命令清单与 electron/preload.cjs 白名单、backend/ipc.cjs 一一对应
import type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy,
  ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult, CcSwitchAppType,
  MemoryRow, MemoryDetail, MemoryStats, MemoryIndexStatus, MemoryTimelineNode, MemoryProjectCard,
  MemoryAgentCard, MemoryAgentVerify, MemoryBridgeStatus, MemoryConfigEnvelope, MemoryStatusEnvelope,
  MemoryToolRow,
} from "../types";

export type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, UpdateEvent, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, WebDavEvent, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy,
  ProxyAccountStatus, ProxyEvent, ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult,
  MemoryRow, MemoryDetail, MemoryStats, MemoryIndexStatus, MemoryTimelineNode, MemoryProjectCard,
  MemoryAgentCard, MemoryAgentVerify, MemoryBridgeStatus, MemoryConfigEnvelope, MemoryStatusEnvelope,
  MemoryToolRow, MemoryEvent,
} from "../types";

import { mock } from "./mock";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Electron preload 桥接（window.agenthub.invoke / onUpdateEvent） */
declare global {
  interface Window {
    agenthub?: {
      invoke: InvokeFn;
      onUpdateEvent?: (callback: (payload: unknown) => void) => () => void;
    };
  }
}

function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.agenthub;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isElectron()) {
    const res = (await window.agenthub!.invoke(cmd, args)) as unknown;
    // 后端失败的返回也是对象，混进正常数据会把页面打花，这里统一拦下来转异常
    if (res && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
      const msg = (res as { message?: unknown }).message;
      throw new Error(typeof msg === "string" && msg ? msg : `命令 ${cmd} 执行失败`);
    }
    return res as T;
  }
  // 浏览器回退：直接走 mock
  return (await mock.invoke(cmd, args)) as T;
}

// ===== 框架：配置 =====
export const loadConfig = () => call<AppConfig>("load_config");
export const saveConfig = (cfg: AppConfig) =>
  call<{ ok: boolean; message: string }>("save_config", { config: JSON.parse(JSON.stringify(cfg)) });

// ===== 框架：其它 =====
export const getAppVersion = () => call<string>("get_app_version");
export const getDataDir = () => call<string>("get_data_dir");
export const openDataDir = () => call<void>("open_data_dir");
export const getHubDir = () => call<string>("get_hub_dir");
export const openHubDir = () => call<void>("open_hub_dir");
export const browseDir = () => call<{ ok: boolean; canceled?: boolean; path: string | null }>("browse_dir");

// ===== 软件更新 =====
export const getIsPortable = () => call<boolean>("get_is_portable");
export const getUpdateStatus = () => call<UpdateStatus>("get_update_status");
export const checkUpdate = () => call<UpdateStatus>("check_update");
export const downloadUpdate = () => call<UpdateStatus>("download_update");
export const installUpdate = () => call<UpdateStatus>("install_update");
export const openReleasePage = () => call<void>("open_release_page");
export const openRepoPage = () => call<void>("open_repo_page");

/** 订阅主进程广播（更新状态 / WebDAV 进度 / focus-update 跳转信号），返回退订函数 */
export function onUpdateEvent(cb: (payload: unknown) => void): (() => void) | undefined {
  return window.agenthub?.onUpdateEvent?.((payload) => cb(payload));
}

// ===== 技能仓库：WebDAV 跨设备同步 =====
// webdavTest 表单直传 {endpoint, username, password, root}（统一服务器 + 根目录，密码可为掩码）；
// 兼容旧调用：传完整 AppConfig 时取 webdav 段
export const webdavTest = (config?: AppConfig | { endpoint: string; username: string; password: string; root: string }) =>
  call<{ ok: boolean; message: string; latencyMs?: number }>("webdav_test", config ? { config: JSON.parse(JSON.stringify(config)) } : {});
export const webdavSync = () => call<{ ok: boolean; message?: string }>("webdav_sync");
export const webdavCancel = () => call<{ ok: boolean }>("webdav_cancel");
export const webdavStatus = () => call<WebDavStatus>("webdav_status");
export const webdavLogs = () => call<WebDavLog[]>("webdav_logs");
export const webdavDevices = () => call<{ devices: RemoteDevice[]; error?: string }>("webdav_devices");

// ===== 统一 WebDAV（设置 · 数据存储）：一套服务器凭据 + 四模块根目录 =====
export interface SharedWebdavConfig {
  endpoint: string;
  username: string;
  /** 渲染层只拿掩码；保存时传精确掩码 = 未修改（同时是号池压缩包加密口令） */
  password: string;
  roots: { skills: string; usage: string; proxy: string; memory: string };
}
export const webdavSharedGet = () => call<SharedWebdavConfig>("webdav_shared_get");
export const webdavSharedSave = (cfg: SharedWebdavConfig) =>
  call<{ ok: boolean; message: string }>("webdav_shared_save", { config: JSON.parse(JSON.stringify(cfg)) });
export const webdavSharedTest = (cfg: Partial<SharedWebdavConfig>) =>
  call<{ ok: boolean; message: string; latencyMs?: number }>("webdav_shared_test", { config: JSON.parse(JSON.stringify(cfg)) });

// ===== 反代网关：号池 WebDAV 同步（统一服务器 + proxy 根目录；channel 可选 = 只同步某渠道） =====
export interface ProxyPoolSyncStatus {
  running: boolean;
  stage: string;
  stageLabel: string;
  detail: string;
  lastError: string;
  lastSyncAt: number;
  lastSummary: string;
  /** 同步进度百分比（0~100，按阶段锚点） */
  percent: number;
  /** 上次/进行中同步的渠道范围（"" = 全部渠道） */
  channel: string;
  configured: boolean;
  deviceId: string;
  deviceName: string;
}
export const proxyPoolsyncStatus = () => call<ProxyPoolSyncStatus>("proxy_poolsync_status");
export const proxyPoolsyncRun = (channel?: ProxyChannelId | "") =>
  call<{ ok: boolean; message?: string; summary?: string; pulled?: number; added?: number; updated?: number; removed?: number; skipped?: number; uploaded?: boolean }>(
    "proxy_poolsync_run",
    { channel: channel || "" }
  );
export const proxyPoolsyncCancel = () => call<{ ok: boolean }>("proxy_poolsync_cancel");

// ===== 技能仓库：工具适配器 =====
export const listTools = () => call<ToolRow[]>("list_tools");
/** 左栏模块卡片轻量统计（不做全量哈希，切模块即可调） */
export interface SkillsSideStats {
  skillCount: number;
  pendingConflicts: number;
  toolCount: number;
  mountOk: number;
  mountTotal: number;
  tools: { id: string; name: string; dir: string; skillCount: number }[];
}
export const skillsSideStats = () => call<SkillsSideStats>("skills_side_stats");
export const probeAgents = () => call<ProbeRow[]>("probe_agents");
export const removeTool = (id: string, confirm?: boolean) =>
  call<{ ok: boolean; message?: string; builtin?: boolean; mounts?: { skill: string; path: string }[]; sourceCount?: number; openConflicts?: number; unmounted?: number }>("remove_tool", { id, confirm: !!confirm });

// ===== 技能仓库：总览 / 技能库 / 详情 =====
export const getOverview = () => call<Overview>("get_overview");
export const listSkills = () => call<SkillRow[]>("list_skills");
export const getSkill = (name: string) => call<SkillDetail | null>("get_skill", { name });

// ===== 技能仓库：同步 / 报告 =====
export const syncPlan = () => call<SyncPlan>("sync_plan");
export const syncExecute = (plan: SyncPlan) => call<SyncResult>("sync_execute", { plan: JSON.parse(JSON.stringify(plan)) });
export const listReports = () => call<ReportRow[]>("list_reports");
export const readReport = (file: string) => call<{ content: string }>("read_report", { file });
export const openReport = (file: string) =>
  call<{ ok: boolean }>("open_report", { file }).catch(() => ({ ok: false }));

// ===== 技能仓库：冲突 =====
export const listConflicts = () => call<ConflictItem[]>("list_conflicts");
export const getConflictDiff = (id: string) => call<ConflictDiff | null>("get_conflict_diff", { id });
export const resolveConflict = (id: string, choice: string) => call<{ ok: boolean; message: string }>("resolve_conflict", { id, choice });
export const dismissConflict = (id: string) => call<{ ok: boolean }>("dismiss_conflict", { id });

// ===== 技能仓库：挂载 / 回收站 / 自动感知 =====
export const toggleMount = (skill: string, toolId: string, enable: boolean) =>
  call<{ ok: boolean; message: string }>("toggle_mount", { skill, toolId, enable });
export const repairMounts = () => call<{ repaired: number; details: string[] }>("repair_mounts");

export const trashList = () => call<TrashRow[]>("trash_list");
export const trashRestore = (name: string) => call<{ ok: boolean; message?: string; dest?: string }>("trash_restore", { name });
export const trashPurge = () => call<{ purged: number }>("trash_purge");

export const removeSkill = (name: string) => call<{ ok: boolean; message?: string }>("remove_skill", { name });

export const watchStatus = () => call<WatchStatus>("watch_status");
export const adoptHubSkill = (name: string) => call<{ ok: boolean; message?: string; name?: string; mounts?: number }>("adopt_hub_skill", { name });

// ===== 反代网关：服务启停 / 状态 =====
export const proxyStatus = () => call<ProxyGatewayStatus>("proxy_status");
export const proxyStart = () => call<{ ok: boolean; port?: number; already?: boolean; message?: string }>("proxy_start");
export const proxyStop = () => call<{ ok: boolean }>("proxy_stop");
export const proxyRestart = () => call<{ ok: boolean; port?: number; message?: string }>("proxy_restart");

// ===== 反代网关：API Keys =====
export const proxyKeysList = () => call<ProxyKeyRow[]>("proxy_keys_list");
export const proxyKeyCreate = (opts: { name: string; route: ProxyRoute; dailyQuota: number; rateLimit?: number }) =>
  call<ProxyKeyRow & { secret: string }>("proxy_key_create", opts as unknown as Record<string, unknown>);
export const proxyKeyUpdate = (id: string, patch: Partial<Pick<ProxyKeyRow, "name" | "route" | "dailyQuota" | "rateLimit" | "enabled">>) =>
  call<{ ok: boolean; message?: string }>("proxy_key_update", { id, ...patch });
export const proxyKeyDelete = (id: string) => call<{ ok: boolean; message?: string }>("proxy_key_delete", { id });

// ===== 反代网关：号池 / 凭据接入 =====
export const proxyPool = () => call<ProxyChannelView[]>("proxy_pool");
export const proxyPoolStrategy = (channel: ProxyChannelId, strategy: ProxyPoolStrategy) =>
  call<{ ok: boolean; message?: string }>("proxy_pool_strategy", { channel, strategy });
export const proxyAccountAdd = (opts: { channel: ProxyChannelId; name?: string; token: string; refreshToken?: string; uid?: string }) =>
  call<{ ok: boolean; id?: string; message?: string }>("proxy_account_add", opts as unknown as Record<string, unknown>);
export const proxyAccountRemove = (id: string) => call<{ ok: boolean; message?: string }>("proxy_account_remove", { id });
export const proxyAccountToggle = (id: string, enabled: boolean) =>
  call<{ ok: boolean; message?: string }>("proxy_account_toggle", { id, enabled });
/** 重命名账号（自定义备注），WebDAV 同步时 LWW 传播 */
export const proxyAccountRename = (id: string, name: string) =>
  call<{ ok: boolean; message?: string }>("proxy_account_rename", { id, name });
/** 手动解除冷却：cooling 账号立即回 online，releasedModels = 同时豁免的模型级负缓存条数 */
export const proxyAccountCoolOff = (id: string) =>
  call<{ ok: boolean; message?: string; releasedModels?: number }>("proxy_account_cool_off", { id });
export const proxyAccountRefresh = (id: string) =>
  call<{ ok?: boolean; id?: string; credits?: number; expiresAt?: number; message?: string }>("proxy_account_refresh", { id });
export const proxyCreditsRefresh = () =>
  call<{ ok: boolean; total?: number; failed?: number; message?: string }>("proxy_credits_refresh");
/** 只刷新指定渠道的号池额度（号池页右上角「刷新当前渠道」） */
export const proxyCreditsRefreshChannel = (channel: ProxyChannelId) =>
  call<{ ok: boolean; total?: number; failed?: number; results?: { ok: boolean; message?: string; unavailable?: boolean; credits?: number }[] }>(
    "proxy_credits_refresh_channel",
    { channel }
  );
/** 批量签到：status = 查询状态；checkin = 执行签到；trial = 国际版加油包（action 缺省 checkin） */
export const proxyCheckinStatus = (channel?: ProxyChannelId | "", accountId?: string) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[] }>("proxy_checkin_status", { channel, accountId });
export const proxyCheckinRun = (opts: { channel?: ProxyChannelId | ""; accountId?: string; action?: "checkin" | "trial" }) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[]; message?: string }>("proxy_checkin_run", opts as Record<string, unknown>);
/** 扫描本机已装软件的登录态（凭据不出主进程，只回候选信息） */
export const proxyScan = () => call<ProxyScanCandidate[]>("proxy_scan");
/** 导入本机候选；file/uid 用于身份核对（两次扫描之间文件变化时不至于导错账号） */
export const proxyScanImport = (index: number, channel?: ProxyChannelId, file?: string, uid?: string) =>
  call<{ ok: boolean; id?: string; updated?: boolean; message?: string }>("proxy_scan_import", { index, channel, file, uid });
/** 拉起对应渠道的官方登录（授权页由主进程 shell.openExternal 打开，结果经 app:event 回流） */
export const proxyOauthBegin = (channel: ProxyChannelId) =>
  call<{ ok: boolean; url?: string; mode?: string; message?: string }>("proxy_oauth_begin", { channel });
export const proxyOauthCancel = () => call<{ ok: boolean; cancelled?: boolean }>("proxy_oauth_cancel");
/** 兜底：浏览器没跳回回环地址时，把地址栏内容整段粘回来完成登录 */
export const proxyOauthSubmitCallback = (channel: ProxyChannelId, url: string) =>
  call<{ ok: boolean; message?: string }>("proxy_oauth_submit_callback", { channel, url });
/** 粘贴 JSON 批量添加账号（单个对象 / 数组 / {accounts:[...]}，字段容忍别名） */
export const proxyAccountImportJson = (channel: ProxyChannelId, json: string) =>
  call<{ ok: boolean; added?: number; dup?: number; invalid?: number; message?: string }>("proxy_account_import_json", { channel, json });
/** 从 JSON/ZIP 文件添加账号（主进程弹文件选择框；zip 读取包内全部 .json 合并导入） */
export const proxyAccountImportFile = (channel: ProxyChannelId) =>
  call<{ ok: boolean; canceled?: boolean; added?: number; dup?: number; invalid?: number; file?: string; message?: string }>("proxy_account_import_file", { channel });

// ===== 反代网关：模型 / 统计 / 规则 =====
export const proxyModels = () => call<ProxyModel[]>("proxy_models");
export const proxyModelsSync = (channel: string) =>
  call<{ ok: boolean; channel?: string; count?: number; withRate?: number; message?: string }>("proxy_models_sync", { channel });
export const proxyIdeSwitch = (accountId: string) =>
  call<{ ok: boolean; channel?: string; file?: string; backup?: string; message?: string }>("proxy_ide_switch", { accountId });
export const proxyIdeStatus = () => call<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; raccoonInstalled?: boolean; currentUid: string }>("proxy_ide_status");
export const proxyStatsOverview = (days?: number) => call<ProxyStatsOverview>("proxy_stats_overview", { days });
export const proxyStatsTop = (dim: "channel" | "model" | "key" | "account", days?: number) =>
  call<{ name: string; req: number; tokens: number }[]>("proxy_stats_top", { dim, days });
export const proxyStatsDetail = (opts: { page?: number; pageSize?: number; channel?: string; keyId?: string; model?: string }) =>
  call<ProxyStatsDetail>("proxy_stats_detail", opts as Record<string, unknown>);
export const proxyRecent = (limit?: number) => call<ProxyUsageRow[]>("proxy_recent", { limit });
export const proxyRulesList = () => call<ProxyRuleFile[]>("proxy_rules_list");
export const proxyOpenRulesDir = () => call<{ ok: boolean }>("proxy_open_rules_dir");
export const proxyOpenDataDir = () => call<{ ok: boolean }>("proxy_open_data_dir");
export const proxyVaultStatus = () => call<{ encrypted: boolean; driver: string; dataDir: string }>("proxy_vault_status");

// ===== 反代网关：生态接入（CC Switch） =====
export const proxyCcSwitchStatus = () => call<CcSwitchStatus>("proxy_ccswitch_status");
export const proxyCcSwitchRegister = (opts: { appType: CcSwitchAppType; apiKey: string; model: string; port?: number }) =>
  call<CcSwitchRegisterResult>("proxy_ccswitch_register", opts as unknown as Record<string, unknown>);

// ===== 记忆仓库：配置 / 根目录 =====
export const memoryConfigGet = () => call<MemoryConfigEnvelope>("memory_config_get");
export const memoryConfigSave = (entries: Record<string, unknown>, local = false) =>
  call<{ ok: boolean }>("memory_config_save", { entries, local });
export const memoryConfigReset = (keys?: string[]) => call<{ ok: boolean }>("memory_config_reset", { keys });
export const memoryConfigExport = () => call<{ ok: boolean; json: string }>("memory_config_export");
export const memoryConfigImport = (json: string) => call<{ ok: boolean; applied: number }>("memory_config_import", { json });
export const memoryRootGet = () => call<{ root: string; defaultRoot: string }>("memory_root_get");
export const memoryRootSet = (dir: string, migrate = true) =>
  call<{ ok: boolean; root: string; migrated: boolean }>("memory_root_set", { dir, migrate });
export const memoryStatus = () => call<MemoryStatusEnvelope>("memory_status");
export const memoryToggle = (enabled: boolean) => call<{ ok: boolean; enabled: boolean }>("memory_toggle", { enabled });
export const memoryCostsEstimate = () => call<{ estimates: Record<string, string> }>("memory_costs_estimate");

// ===== 记忆仓库：读写 / 浏览 =====
export const memoryStats = () => call<MemoryStats>("memory_stats");
export const memoryList = (opts: {
  project?: string; agent?: string; layer?: string; type?: string; tag?: string;
  page?: number; pageSize?: number; includeSuperseded?: boolean; starred?: boolean; pinned?: boolean;
  after?: number; before?: number;
}) => call<{ rows: MemoryRow[]; total: number; page: number; pageSize: number }>("memory_list", opts as Record<string, unknown>);
export const memoryGet = (id: string) =>
  call<{ memory: MemoryDetail; related: { id: string; title: string; summary: string }[]; timeline: MemoryTimelineNode[] }>("memory_get", { id });
export const memoryWrite = (input: {
  title?: string; body: string; type?: string; layer?: string; project?: string; agent?: string;
  tags?: string[]; importance?: number; supersedes?: string[]; cwd?: string; session?: string;
}) => call<{ ok: boolean; id: string; path: string; anchor?: string | null; project?: string | null; noop?: boolean; superseded?: string[] }>("memory_write", input as unknown as Record<string, unknown>);
export const memoryUpdate = (id: string, patch: {
  title?: string; body?: string; tags?: string[]; importance?: number; summary?: string; pinned?: boolean; starred?: boolean;
}) => call<{ ok: boolean; id: string }>("memory_update", { id, ...patch });
export const memoryDelete = (id: string, purge = false) => call<{ ok: boolean; id: string }>("memory_delete", { id, purge });
export const memoryPin = (id: string, value: boolean) => call<{ ok: boolean }>("memory_pin", { id, value });
export const memoryStar = (id: string, value: boolean) => call<{ ok: boolean }>("memory_star", { id, value });
export const memoryRecent = (opts?: { project?: string; agent?: string; days?: number; limit?: number }) =>
  call<{ rows: MemoryRow[] }>("memory_recent", opts as Record<string, unknown>);
export const memoryHeatmap = (days = 365) => call<{ days: { day: string; count: number }[] }>("memory_heatmap", { days });
export const memoryTags = () => call<{ tags: { name: string; count: number }[] }>("memory_tags");

// ===== 记忆仓库：回收站 =====
export const memoryTrashList = () =>
  call<{ items: { name: string; trashedAt: number; originPath: string; size: number }[] }>("memory_trash_list");
export const memoryTrashRestore = (name: string, dest: string) => call<{ ok: boolean }>("memory_trash_restore", { name, dest });
export const memoryTrashPurge = (days?: number) => call<{ removed: number }>("memory_trash_purge", { days });

// ===== 记忆仓库：项目归类 =====
export const memoryProjects = () =>
  call<{ projects: MemoryProjectCard[]; general: { count: number; latest: number } }>("memory_projects");
export const memoryProjectDetail = (slug: string) =>
  call<{ project: MemoryProjectCard | null; agents: { agent: string; c: number }[]; files: { path: string; c: number }[] }>("memory_project_detail", { slug });
export const memoryProjectMerge = (from: string, to: string) => call<{ ok: boolean; moved: number }>("memory_project_merge", { from, to });
export const memoryProjectRename = (slug: string, name: string, aliases?: string[]) =>
  call<{ ok: boolean }>("memory_project_rename", { slug, name, aliases });
export const memoryProjectAssign = (ids: string[], slug: string | null) =>
  call<{ ok: boolean; moved: number }>("memory_project_assign", { ids, slug });
export const memoryProjectSuggest = () =>
  call<{ items: { id: string; slug: string; name: string; score: number; candidate: string; memoryId: string; title: string; path: string }[] }>("memory_project_suggest");
export const memoryProjectConfirm = (id: string, slug: string | null) =>
  call<{ ok: boolean; memoryId: string; slug: string | null }>("memory_project_confirm", { id, slug });

// ===== 记忆仓库：索引 / 检索 =====
export const memoryIndexStatus = () => call<MemoryIndexStatus>("memory_index_status");
export const memoryIndexBuild = () => call<{ ok: boolean; files: number }>("memory_index_build");
export const memoryIndexRebuild = () => call<{ ok: boolean; files: number; tookMs: number }>("memory_index_rebuild");
export const memoryIndexDiagnose = () =>
  call<{ diagnose: { orphanRows: string[]; unindexed: string[]; fts: { rebuilt: boolean } }; graph: { nodes: number; edges: number; broken: number; isolated: number } }>("memory_index_diagnose");
export const memoryIndexVacuum = () => call<{ ok: boolean; before: number; after: number }>("memory_index_vacuum");
export const memorySearch = (query: string, opts?: {
  project?: string; agent?: string; layer?: string; limit?: number; offset?: number; includeSuperseded?: boolean;
}) => call<{ results: MemoryRow[]; total: number; tookMs: number; text: string }>("memory_search", { query, ...(opts || {}) } as Record<string, unknown>);
export const memorySearchDebug = (query: string, opts?: { project?: string; layer?: string }) =>
  call<{
    tokens: string[]; synonyms: Record<string, string[]>; tookMs: number; total: number;
    results: (MemoryRow & { scoreParts?: Record<string, number> })[]; explain: string;
  }>("memory_search_debug", { query, ...(opts || {}) });
export const memoryTokenEstimate = (texts: string[]) =>
  call<{ per: number[]; total: number; note: string }>("memory_token_estimate", { texts });
export const memoryGraphStats = () =>
  call<{ nodes: number; edges: number; broken: number; isolated: number }>("memory_graph_stats");
export const memoryDigest = (maxLines?: number) =>
  call<{ rows: { project: string | null; title: string; summary: string; created: number; tags: string }[]; counts: { p: string; c: number; latest: number }[]; limit: number; text: string; lines: number }>("memory_digest", { maxLines });
export const memoryTimeline = (args: { id?: string; topic?: string }) =>
  call<{ chain?: MemoryTimelineNode[]; chains?: { root: string; chain: MemoryTimelineNode[] }[]; text: string }>("memory_timeline", args);
export const memorySupersede = (id: string, byId: string, reason?: string) =>
  call<{ ok: boolean; id: string }>("memory_supersede", { id, byId, reason });

// ===== 记忆仓库：Agent 接入 =====
export const memoryAgentsList = () =>
  call<{
    agents: MemoryAgentCard[];
    command: { command: string | null; args: string[]; env: Record<string, string>; hostExists: boolean; bridgeExists: boolean };
    bridge: MemoryBridgeStatus;
  }>("memory_agents_list");
export const memoryAgentVerify = (id: string, skipHandshake = false) => call<MemoryAgentVerify>("memory_agent_verify", { id, skipHandshake });
export const memoryAgentVerifyAll = () => call<MemoryAgentVerify[]>("memory_agent_verify_all");
export const memoryAgentInject = (id: string) =>
  call<{ ok: boolean; steps: { ok: boolean; action: string; file: string; backup?: string | null }[]; configPath: string; instructionPath: string }>("memory_agent_inject", { id });
export const memoryAgentUninject = (id: string) =>
  call<{ ok: boolean; steps: { ok: boolean; action: string; file: string }[] }>("memory_agent_uninject", { id });
export const memoryAgentSnippet = (id: string, format?: string) =>
  call<{
    ok: boolean; json: string; toml: string; cli: string; instruction: string;
    command: { command: string | null; args: string[]; hostExists: boolean; bridgeExists: boolean };
    configPath: string; instructionPath: string; hint: string;
  }>("memory_agent_snippet", { id, format });
export const memoryAgentCustomSave = (entry: { id?: string; name: string; path: string; format?: string; instructionPath?: string }) =>
  call<{ ok: boolean; id: string }>("memory_agent_custom_save", { entry });
export const memoryAgentsTools = () => call<{ tools: MemoryToolRow[] }>("memory_agents_tools");
export const memoryBridgeStatus = () => call<{ bridge: MemoryBridgeStatus; root: string }>("memory_bridge_status");
export const memoryBridgeRestart = () => call<{ ok: boolean; port: number }>("memory_bridge_restart");

// ===== 记忆仓库：报告 / 导出 =====
export const memoryReportsList = () =>
  call<{ reports: { name: string; size: number; mtime: number }[] }>("memory_reports_list");
export const memoryReportRead = (name: string) => call<{ name: string; content: string }>("memory_report_read", { name });
export const memoryExport = (scope?: string) => call<{ content: string; files: number }>("memory_export", { scope });
export const memoryExportZip = () => call<{ file: string; files: number; bytes: number }>("memory_export_zip");
export const memoryOpenDir = (rel?: string) => call<{ path: string }>("memory_open_dir", { rel });

// ===== 记忆仓库：模型与网关（供应商 / 模型池 / 路由 / 三级测试） =====
export const memoryProviderList = () => call<{ providers: Record<string, unknown>[] }>("memory_provider_list");
export const memoryProviderSave = (input: Record<string, unknown>) =>
  call<{ ok: boolean; id: string }>("memory_provider_save", input as Record<string, unknown>);
export const memoryProviderDelete = (id: string) => call<{ ok: boolean; removedModels: number }>("memory_provider_delete", { id });
export const memoryProviderTest = (id: string, modelId?: string) =>
  call<{
    ok: boolean; message?: string;
    l1: { ok: boolean; latencyMs?: number; status?: number; message?: string };
    l2: { ok: boolean; models?: number; message?: string };
    l3: { ok: boolean; status?: number; message?: string };
    suggestion: { apiFormat: string; reason: string } | null;
  }>("memory_provider_test", { id, modelId });
export const memoryProviderFetchModels = (id: string) =>
  call<{ ok: boolean; models: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string }; caps: Record<string, unknown> }[]; message?: string }>("memory_provider_fetch_models", { id });
export const memoryProviderQuirks = (id?: string) => call<{ memo: Record<string, unknown>; log: unknown[] }>("memory_provider_quirks", { id });
export const memoryModelList = (providerId?: string) =>
  call<{ models: Record<string, unknown>[] }>("memory_model_list", { providerId });
export const memoryModelSave = (input: Record<string, unknown>) => call<{ ok: boolean; id: string }>("memory_model_save", input as Record<string, unknown>);
export const memoryModelDelete = (id: string) => call<{ ok: boolean }>("memory_model_delete", { id });
export const memoryModelToggle = (id: string, enabled: boolean) => call<{ ok: boolean; enabled: boolean }>("memory_model_toggle", { id, enabled });
export const memoryModelBatch = (ids: string[], op: "enable" | "disable" | "setTags" | "setEffort", value?: unknown) =>
  call<{ ok: boolean; changed: number }>("memory_model_batch", { ids, op, value });
export const memoryModelProbe = (id: string) => call<{ ok: boolean; caps: Record<string, unknown> }>("memory_model_probe", { id });
export const memoryLlmSources = () =>
  call<{ order: string[]; tagDefs: string[]; sources: { key: string; available: boolean; detail: string }[]; routing: unknown[]; taskEffort: Record<string, string> }>("memory_llm_sources");
export const memoryLlmSourcesSave = (payload: { order?: string[]; routing?: unknown[]; taskEffort?: Record<string, string>; tagDefs?: string[]; degrade?: Record<string, unknown> }) =>
  call<{ ok: boolean }>("memory_llm_sources_save", payload as Record<string, unknown>);
export const memoryLlmRouting = () =>
  call<{ routing: { task: string; tags: string[]; effort: string; chain: { providerId: string; providerName: string; modelId: string; priority: number; source: string }[] }[] }>("memory_llm_routing");
export const memoryLlmRoutingSave = (payload: { routing?: unknown[] }) => call<{ ok: boolean }>("memory_llm_routing_save", payload as Record<string, unknown>);
export const memoryLlmTestCall = (providerId: string, modelId?: string, effort?: string) =>
  call<{ ok: boolean; latencyMs?: number; text?: string; providerId?: string; modelId?: string; effort?: string; usage?: { input: number; output: number }; message?: string; tried?: string[] }>("memory_llm_test_call", { providerId, modelId, effort });
export const memoryLlmUsage = (days?: number) =>
  call<{ usage: { provider: string; model: string; task: string; calls: number; tokensIn: number; tokensOut: number; successRate: number }[]; today: { tokens: number; calls: number } }>("memory_llm_usage", { days });

// ===== 记忆仓库：自动化任务 =====
export const memoryAutoStatus = () => call<Record<string, unknown>>("memory_auto_status");
export const memoryAutoTimeline = (limit?: number) => call<{ entries: Record<string, unknown>[] }>("memory_auto_timeline", { limit });
export const memoryAutoTaskRun = (id: string) =>
  call<{ ok: boolean; task?: string; tokens?: number; detail?: string; ms?: number; message?: string }>("memory_auto_task_run", { id });
export const memoryAutoTaskSave = (id: string, patch: Record<string, unknown>) => call<{ ok: boolean }>("memory_auto_task_save", { id, patch });
export const memoryAutoPause = (opts: { until?: number; resume?: boolean }) => call<Record<string, unknown>>("memory_auto_pause", opts as Record<string, unknown>);
export const memoryAutoCancel = () => call<{ ok: boolean }>("memory_auto_cancel");
export const memoryAutoCost = () => call<Record<string, unknown>>("memory_auto_cost");
export const memoryAutoReport = () => call<{ ok: boolean; file: string }>("memory_auto_report");

// ===== 记忆仓库：深层记忆 / 蒸馏 / 画像 / 待确认队列 =====
export const memoryDistillRun = (opts?: { project?: string }) =>
  call<{ processed: number; updated: number; tokens: number; detail: string; report?: string }>("memory_distill_run", opts as Record<string, unknown>);
export const memoryProfileGet = () =>
  call<{ sections: { name: string; path: string; text: string; exists: boolean }[]; history: { name: string; mtime: number }[]; lastAt: number }>("memory_profile_get");
export const memoryProfileGenerate = () =>
  call<{ processed: number; updated: number; tokens: number; detail: string; report?: string }>("memory_profile_generate");
export const memoryProfileSave = (name: string, text: string) => call<{ ok: boolean }>("memory_profile_save", { name, text });
export const memoryReviewList = (kind: "supersede" | "classify" | "dedup" | "supersede-done") =>
  call<{ items: { id: string; kind: string; payload: Record<string, any>; created: number }[] }>("memory_review_list", { kind });
export const memoryReviewResolve = (id: string, action: "confirm" | "dismiss" | "merge" | "assign" | "newProject" | "general", payload?: Record<string, unknown>) =>
  call<{ ok: boolean }>("memory_review_resolve", { id, action, payload });

// ===== 记忆仓库：WebDAV 同步 =====
export const memorySyncStatus = () =>
  call<{ running: boolean; stage: string; stageLabel: string; percent: number; detail: string; lastSyncAt: number; conflicts: number; tombstones: number; configured: boolean }>("memory_sync_status");
export const memorySyncRun = () =>
  call<{ ok: boolean; uploaded?: number; downloaded?: number; conflicts?: number; merged?: number; message?: string; cancelled?: boolean }>("memory_sync_run");
export const memorySyncCancel = () => call<{ ok: boolean; message?: string }>("memory_sync_cancel");
export const memorySyncLogs = (limit?: number) => call<{ logs: { at: number; stage: string; detail: string }[] }>("memory_sync_logs", { limit });
export const memoryConflictsList = () => call<{ conflicts: Record<string, unknown>[] }>("memory_conflicts_list");
export const memoryConflictsDiff = (index: number) => call<{ ok: boolean; path: string; note: string; localText: string; remoteText: string }>("memory_conflicts_diff", { index });
export const memoryConflictsResolve = (index: number, decision: "keepLocal" | "keepRemote" | "keepBoth" | "merge", mergedText?: string) =>
  call<{ ok: boolean; message?: string }>("memory_conflicts_resolve", { index, decision, mergedText });
export const memorySyncDevices = () => call<{ devices: { deviceId: string; name?: string; lastSyncAt?: number; count?: number }[]; deviceId: string }>("memory_sync_devices");
export const memorySyncPacks = () => call<{ packs: { at: number; bytes: number; files: number; dir: string }[] }>("memory_sync_packs");

// ===== 记忆仓库：去重 =====
export const memoryDedupStatus = () =>
  call<{ total: number; pending: number; done: number; merged: number; queued: number; dedupRate: number; learnedPairs: number; tokensUsed: number; layerCounts: { l1: number; learned: number }; autoDeleteDisabled: boolean }>("memory_dedup_status");
export const memoryDedupScan = (useModel = true) =>
  call<{ scanned: number; merged: number; queued: number; acted: number; tokens: number }>("memory_dedup_scan", { useModel });
export const memoryDedupReviewList = () => call<{ items: { id: string; payload: Record<string, any> }[] }>("memory_dedup_review_list");
export const memoryDedupReviewResolve = (id: string, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss", payload?: Record<string, unknown>) =>
  call<{ ok: boolean; message?: string }>("memory_dedup_review_resolve", { id, action, payload });
export const memoryDedupPairsGet = () => call<{ pairs: { a: string; b: string; aTitle: string; bTitle: string }[] }>("memory_dedup_pairs_get");
export const memoryDedupPairsClear = (pair?: string) => call<{ ok: boolean }>("memory_dedup_pairs_clear", { pair });
export const memoryDedupLayerToggle = (layer: "l1" | "l2" | "l4", enabled: boolean) => call<{ ok: boolean }>("memory_dedup_layer_toggle", { layer, enabled });

// ===== 记忆仓库：导入引擎 =====
export const memoryImportSources = () =>
  call<{ sources: Record<string, unknown>[]; importDir: string }>("memory_import_sources");
export const memoryImportSourceSave = (list: { id: string; name: string; kind: string; path: string; enabled: boolean; table?: string }[]) =>
  call<{ ok: boolean; sources: Record<string, unknown>[] }>("memory_import_source_save", { list });
export const memoryImportSourceDetect = (id: string, path?: string) =>
  call<{ detect: Record<string, unknown> }>("memory_import_source_detect", { id, path });
export const memoryImportPreview = (opts?: { sourceIds?: string[]; limit?: number }) =>
  call<Record<string, unknown>>("memory_import_preview", opts as Record<string, unknown>);
export const memoryImportApply = (opts?: { sourceIds?: string[] }) =>
  call<{ ok: boolean; created: number; merged: number; skipped: number; sensitive: number; failed: number; report?: string; verify?: Record<string, unknown>; message?: string }>("memory_import_apply", opts as Record<string, unknown>);
export const memoryImportCancel = () => call<{ ok: boolean; message?: string }>("memory_import_cancel");
export const memoryImportProgress = () =>
  call<{ phase: string; done: number; total: number; created: number; merged: number; skipped: number; sensitive: number; running: boolean }>("memory_import_progress");
export const memoryImportReport = () => call<{ ok: boolean; files: string[]; content: string }>("memory_import_report");
export const memoryImportCursorsGet = () => call<{ ok: boolean; cursors: Record<string, unknown>; file: string }>("memory_import_cursors_get");
export const memoryImportCursorsReset = (id?: string) => call<{ ok: boolean; cursors: Record<string, unknown> }>("memory_import_cursors_reset", { id });
export const memoryImportMapSave = (id: string, mapping: { table?: string }) => call<{ ok: boolean; sources: Record<string, unknown>[] }>("memory_import_map_save", { id, mapping });
