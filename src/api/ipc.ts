// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境（npm run dev:web 预览 UI）
// 回退到本地 mock。命令清单与 electron/preload.cjs 白名单、backend/ipc.cjs 一一对应
import type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy,
  ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult, CcSwitchAppType,
} from "../types";

export type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, UpdateEvent, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, WebDavEvent, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy,
  ProxyAccountStatus, ProxyEvent, ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult,
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

// ===== 统一 WebDAV（设置 · 数据存储）：一套服务器凭据 + 三模块根目录 =====
export interface SharedWebdavConfig {
  endpoint: string;
  username: string;
  /** 渲染层只拿掩码；保存时传精确掩码 = 未修改（同时是号池压缩包加密口令） */
  password: string;
  roots: { skills: string; usage: string; proxy: string };
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
export const proxyIdeStatus = () => call<{ workbuddyInstalled: boolean; currentUid: string }>("proxy_ide_status");
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
