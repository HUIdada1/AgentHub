/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境（npm run dev:web 预览 UI）
// 回退到本地 mock。命令清单与 electron/preload.cjs 白名单、backend/ipc.cjs 一一对应
import type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyStatsDim, ProxyStatsAggRow, ProxyStatsKeyRow,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy, ProxyCostTier,
  ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult, CcSwitchAppType, ZcodeDeviceStatusResult, ZcodeClaimModeResult,
  ProxyProvider, ProxyProviderKind, ProxyProviderModel, ProxyProviderTestResult,
  ProxyOpLogList,
  ProxyNetProxyList, ProxyNetProxyItem, ProxyNetProxyTest, ProxyNetProxyMode,
  MemoryRow, MemoryDetail, MemoryStats, MemoryIndexStatus, MemoryTimelineNode, MemoryProjectCard,
  MemoryAgentCard, MemoryAgentVerify, MemoryBridgeStatus, MemoryConfigEnvelope, MemoryStatusEnvelope,
  MemoryToolRow,
  PromptItem, PromptStyle, PromptHistoryItem, PromptSyncStatus, PromptConflict, PromptConflictDiff, PromptStats,
  CatalogItem, CatalogItemDetail, CatalogTemplate, CatalogCategory, CatalogStats,
} from "../types";

export type {
  AppConfig, SkillRow, SkillDetail, Overview, SyncPlan, SyncResult, ConflictItem, ConflictDiff,
  ReportRow, ToolRow, TrashRow, UpdateStatus, UpdateEvent, ProbeRow, RemoveToolPlan,
  WebDavStatus, RemoteDevice, WebDavLog, WebDavEvent, HubExtraRow, WatchStatus,
  ProxyGatewayStatus, ProxyKeyRow, ProxyChannelView, ProxyAccount, ProxyStatsOverview, ProxyStatsDetail,
  ProxyStatsDim, ProxyStatsAggRow, ProxyStatsKeyRow,
  ProxyUsageRow, ProxyModel, ProxyScanCandidate, ProxyRuleFile, ProxyRoute, ProxyChannelId, ProxyPoolStrategy, ProxyCostTier,
  ProxyAccountStatus, ProxyEvent, ProxyCheckinRow, CcSwitchStatus, CcSwitchRegisterResult,
  ProxyOpLogList, ProxyOpLogRow,
  ProxyNetProxyList, ProxyNetProxyItem, ProxyNetProxyTest, ProxyNetProxyMode,
  MemoryRow, MemoryDetail, MemoryStats, MemoryIndexStatus, MemoryTimelineNode, MemoryProjectCard,
  MemoryAgentCard, MemoryAgentVerify, MemoryBridgeStatus, MemoryConfigEnvelope, MemoryStatusEnvelope,
  MemoryToolRow, MemoryEvent,
  PromptItem, PromptStyle, PromptHistoryItem, PromptSyncStatus, PromptConflict, PromptConflictDiff, PromptStats,
  CatalogItem, CatalogItemDetail, CatalogTemplate, CatalogCategory, CatalogStats,
  PromptsEvent,
} from "../types";

import { mock } from "./mock";
import { denyReason, isWebTransport } from "./caps";
import { subscribeWebEvents } from "./events";
import { webInvoke } from "./web-transport";

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

/** 是否运行在 Electron 桌面端（有 preload 桥）。
 *  export 出去供 UI 判定「桌面专属设置项」：Web/容器端（server/index.cjs）没有窗口
 *  也没有 globalShortcut，全局快捷键、轻量模式之类的设置在那里没有意义，
 *  必须隐藏或置灰，而不是让用户点了没反应。 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.agenthub;
}

// ipcRenderer.invoke 走 structuredClone，Vue 的深层响应式 Proxy 会直接抛
// "An object could not be cloned"，这里统一脱壳，各接口不必再自行深拷贝
function toPlain<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** 渲染层看门狗默认时限：主进程 handler 挂起时，超过即按失败 reject，
 *  页面 try/finally 里的 busy/loading 才会必然复位——把「永久卡死」降级为「可重试的超时错误」。
 *  注意：超时只结束渲染端等待，不取消主进程任务本身；
 *  长任务（同步/导入/蒸馏/签到批量/等用户操作的原生对话框）在下方各自显式传 0 关闭看门狗，
 *  它们另有主进程侧互斥、进度事件或取消 IPC 托底。 */
const DEFAULT_TIMEOUT_MS = 45_000;

function invokeWithTimeout<T>(p: Promise<T>, cmd: string, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`命令 ${cmd} 响应超时（${Math.round(timeoutMs / 1000)}s）：主进程可能正忙或已卡住，请稍后重试；持续出现请重启应用`));
    }, timeoutMs);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 后端错误信封（{ok:false,message,code?,tried?}）统一转异常：混进正常数据会把页面打花。
 *  code / tried 必须挂到 Error 上：`no_model`（未配置模型）与「试过哪些模型」是引导弹窗的
 *  判定依据——只留一句 message 时前端只能靠文案匹配猜原因，文案一改就失效。 */
function unwrapResult<T>(cmd: string, res: unknown): T {
  if (res && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
    const env = res as { message?: unknown; code?: unknown; tried?: unknown };
    const msg = env.message;
    const err = new Error(typeof msg === "string" && msg ? msg : `命令 ${cmd} 执行失败`) as Error & { code?: string; tried?: string[] };
    if (typeof env.code === "string" && env.code) err.code = env.code;
    if (Array.isArray(env.tried) && env.tried.length) err.tried = env.tried.map(String);
    throw err;
  }
  return res as T;
}

async function call<T>(cmd: string, args?: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (isElectron()) {
    const res = await invokeWithTimeout(window.agenthub!.invoke(cmd, toPlain(args)), cmd, timeoutMs);
    return unwrapResult<T>(cmd, res);
  }
  // Web 托管形态：deny 命令在调用层拦下（一个函数覆盖全部调用点），文案由服务端能力清单下发
  if (isWebTransport()) {
    const denied = denyReason(cmd);
    if (denied) throw new Error(denied);
    const res = await invokeWithTimeout(webInvoke(cmd, toPlain(args)), cmd, timeoutMs);
    return unwrapResult<T>(cmd, res);
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
// 等用户操作原生目录选择框，时长不可控，关掉看门狗
export const browseDir = () => call<{ ok: boolean; canceled?: boolean; path: string | null }>("browse_dir", {}, 0);

// ===== 无边框窗口：自绘标题栏的窗口控制 =====
// 浏览器预览（dev:web / 静态托管）没有窗口可控制，直接给个已兑现的空结果，免得走 mock 报未知命令
export const windowMinimize = () => (isElectron() ? call<void>("window_minimize") : Promise.resolve());
export const windowToggleMaximize = () =>
  isElectron() ? call<{ maximized: boolean }>("window_toggle_maximize") : Promise.resolve({ maximized: false });
export const windowClose = () => (isElectron() ? call<void>("window_close") : Promise.resolve());
export const windowIsMaximized = () =>
  isElectron() ? call<{ maximized: boolean }>("window_is_maximized") : Promise.resolve({ maximized: false });

// ===== 软件更新 =====
export const getIsPortable = () => call<boolean>("get_is_portable");
export const getUpdateStatus = () => call<UpdateStatus>("get_update_status");
export const checkUpdate = () => call<UpdateStatus>("check_update");
export const downloadUpdate = () => call<UpdateStatus>("download_update");
export const installUpdate = () => call<UpdateStatus>("install_update");
export const openReleasePage = () => call<void>("open_release_page");
export const openRepoPage = () => call<void>("open_repo_page");
/** 用系统默认浏览器打开本项目仓库的链接（设置 · 反馈与需求；主进程侧有域名白名单） */
export const openExternalUrl = (url: string) =>
  call<{ ok: boolean; message?: string }>("open_external_url", { url });

/** 订阅主进程广播（更新状态 / WebDAV 进度 / focus-update 跳转信号），返回退订函数。
 *  Web 托管形态走 SSE（信封同形）；纯静态预览（mock）没有事件源 */
export function onUpdateEvent(cb: (payload: unknown) => void): (() => void) | undefined {
  if (window.agenthub?.onUpdateEvent) return window.agenthub.onUpdateEvent((payload) => cb(payload));
  if (isWebTransport()) return subscribeWebEvents(cb);
  return undefined;
}

// ===== 技能仓库：WebDAV 跨设备同步 =====
// webdavTest 表单直传 {endpoint, username, password, root}（统一服务器 + 根目录，密码可为掩码）；
// 兼容旧调用：传完整 AppConfig 时取 webdav 段
export const webdavTest = (config?: AppConfig | { endpoint: string; username: string; password: string; root: string }) =>
  call<{ ok: boolean; message: string; latencyMs?: number }>("webdav_test", config ? { config: JSON.parse(JSON.stringify(config)) } : {});
// 整目录 WebDAV 传输：长任务，主进程有进度事件 + webdavCancel 托底
export const webdavSync = () => call<{ ok: boolean; message?: string }>("webdav_sync", {}, 0);
export const webdavCancel = () => call<{ ok: boolean }>("webdav_cancel");
export const webdavStatus = () => call<WebDavStatus>("webdav_status");
export const webdavLogs = () => call<WebDavLog[]>("webdav_logs");
export const webdavDevices = () => call<{ devices: RemoteDevice[]; error?: string }>("webdav_devices");

// ===== 统一 WebDAV（设置 · 数据存储）：一套服务器凭据 + 四模块根目录 =====
export interface SharedWebdavConfig {
  /** 存储类型：webdav（默认）| s3（S3 兼容对象存储：OSS/COS/R2/MinIO 等） */
  type: "webdav" | "s3";
  endpoint: string;
  username: string;
  /** 渲染层只拿掩码；保存时传精确掩码 = 未修改。S3 模式下即 SecretKey（同时是号池默认加密口令） */
  password: string;
  /** 号池压缩包加密口令（掩码态；空 = 沿用 password） */
  encryptionPassphrase: string;
  s3: { bucket: string; region: string; pathStyle: boolean };
  /** 各模块在同一台网盘上的隔离根目录；prompts 为提示词库（契约 §1 默认 /agenthub-prompts）。
   *  新增键必须在类型上显式声明：设置页直接 v-model 到 shared.roots.prompts，
   *  漏掉它会让「提示词库根目录」输入框写进一个不存在的字段（保存后被 normalizeShared 丢掉） */
  roots: { skills: string; usage: string; proxy: string; memory: string; prompts: string };
}
export const webdavSharedGet = () => call<SharedWebdavConfig>("webdav_shared_get");
export const webdavSharedSave = (cfg: SharedWebdavConfig) =>
  call<{ ok: boolean; message: string }>("webdav_shared_save", { config: JSON.parse(JSON.stringify(cfg)) });
export const webdavSharedTest = (cfg: Partial<SharedWebdavConfig>) =>
  call<{ ok: boolean; message: string; latencyMs?: number }>("webdav_shared_test", { config: JSON.parse(JSON.stringify(cfg)) });
export const webdavSharedClear = () => call<{ ok: boolean; message: string }>("webdav_shared_clear");

// ===== 四大板块启用开关（issue #91）：主进程唯一写入口（落盘 + 运行时启停 + 托盘/事件刷新） =====
export const moduleToggle = (module: string, enabled: boolean) =>
  call<{ ok: boolean; message: string }>("module_toggle", { module, enabled });

// ===== 号池管家：号池 WebDAV 同步（统一服务器 + proxy 根目录；channel 可选 = 只同步某渠道） =====
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
  // 长任务：主进程 running 互斥 + 进度事件 + proxy_poolsync_cancel 托底
  call<{ ok: boolean; message?: string; summary?: string; pulled?: number; added?: number; updated?: number; removed?: number; skipped?: number; uploaded?: boolean }>(
    "proxy_poolsync_run",
    { channel: channel || "" },
    0
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

export const proxyStatus = () => call<ProxyGatewayStatus>("proxy_status");
// ===== 号池管家：号池 / 凭据接入 =====
export const proxyPool = () => call<ProxyChannelView[]>("proxy_pool");
/** 渠道启闭（「上游启闭」弹窗）：list = 全量含已关闭渠道（带 enabled）；toggle = 写配置 + 广播事件即时生效 */
export const proxyChannelList = () => call<ProxyChannelView[]>("proxy_channel_list");
export const proxyChannelToggle = (channel: ProxyChannelId | string, enabled: boolean) =>
  call<{ ok: boolean; channel?: string; enabled?: boolean; message?: string }>("proxy_channel_toggle", { channel, enabled });
export const proxyPoolStrategy = (channel: ProxyChannelId, strategy: ProxyPoolStrategy) =>
  call<{ ok: boolean; message?: string }>("proxy_pool_strategy", { channel, strategy });
/** 渠道成本档（cost-first 路由排序的标注来源） */
export const proxyPoolTier = (channel: ProxyChannelId, tier: ProxyCostTier) =>
  call<{ ok: boolean; message?: string }>("proxy_pool_tier", { channel, tier });
export const proxyAccountAdd = (opts: { channel: ProxyChannelId; name?: string; token: string; refreshToken?: string; uid?: string }) =>
  call<{ ok: boolean; id?: string; message?: string }>("proxy_account_add", opts as unknown as Record<string, unknown>);
export const proxyAccountRemove = (id: string) => call<{ ok: boolean; message?: string }>("proxy_account_remove", { id });
/** 批量删除（号池列表多选）：主进程逐个走单删链路（墓碑先行 + WebDAV 传播），removed = 实删条数 */
export const proxyAccountRemoveBatch = (ids: string[]) =>
  call<{ ok: boolean; removed?: number; missing?: number; message?: string }>("proxy_account_remove_batch", { ids });
/** 明文导出选中账号（号池多选「导出凭据」）：token/refreshToken 为解密后的明文，
 *  供用户在其它软件里直接使用；落盘由渲染层 Blob 下载完成 */
export const proxyAccountExportPlain = (ids: string[]) =>
  call<{ ok: boolean; accounts?: Record<string, unknown>[]; missing?: string[]; exportedAt?: number; message?: string }>(
    "proxy_account_export_plain",
    { ids }
  );
export const proxyAccountToggle = (id: string, enabled: boolean) =>
  call<{ ok: boolean; message?: string }>("proxy_account_toggle", { id, enabled });
/** 重命名账号（自定义备注），WebDAV 同步时 LWW 传播 */
export const proxyAccountRename = (id: string, name: string) =>
  call<{ ok: boolean; message?: string }>("proxy_account_rename", { id, name });
/** 账号备注（号池列表「备注」弹窗）：落 meta.note，随 WebDAV 快照导出 + 备注新者胜传播 */
export const proxyAccountNote = (id: string, note: string) =>
  call<{ ok: boolean; message?: string }>("proxy_account_note", { id, note });
/** 手动解除冷却：cooling 账号立即回 online，releasedModels = 同时豁免的模型级负缓存条数 */
export const proxyAccountCoolOff = (id: string) =>
  call<{ ok: boolean; message?: string; releasedModels?: number }>("proxy_account_cool_off", { id });
// 单账号上游刷新：主进程 httpJson 60s 硬上限，超过 45s 默认看门狗，豁免
export const proxyAccountRefresh = (id: string) =>
  call<{ ok?: boolean; id?: string; credits?: number; expiresAt?: number; message?: string }>("proxy_account_refresh", { id }, 0);
export const proxyCreditsRefresh = () =>
  // 逐账号串行刷新，账号多必然超 45s
  call<{ ok: boolean; total?: number; failed?: number; message?: string }>("proxy_credits_refresh", {}, 0);
/** 只刷新指定渠道的号池额度（号池页右上角「刷新当前渠道」） */
export const proxyCreditsRefreshChannel = (channel: ProxyChannelId) =>
  call<{ ok: boolean; total?: number; failed?: number; results?: { ok: boolean; message?: string; unavailable?: boolean; credits?: number }[] }>(
    "proxy_credits_refresh_channel",
    { channel },
    0
  );
/** 批量签到：status = 查询状态；checkin = 执行签到；trial = 国际版加油包（action 缺省 checkin）。
 *  逐账号串行 + 随机抖动 + 可能的验证码二段流，主进程 checkinBusy 互斥托底，豁免看门狗 */
export const proxyCheckinStatus = (channel?: ProxyChannelId | "", accountId?: string) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[] }>("proxy_checkin_status", { channel, accountId }, 0);
export const proxyCheckinRun = (opts: { channel?: ProxyChannelId | ""; accountId?: string; action?: "checkin" | "trial" }) =>
  call<{ ok: boolean; action: string; total: number; okCount: number; rows: ProxyCheckinRow[]; message?: string }>("proxy_checkin_run", opts as Record<string, unknown>, 0);
/** 按渠道设置自动签到（号池页「自动签到」弹窗）：时间/抖动写整体配置，保存即生效；读源在 proxy_pool 视图 */
export const proxyCheckinAutoSet = (opts: { channel: ProxyChannelId; enabled: boolean; time: string; jitterMin: number }) =>
  call<{ ok: boolean; channel: ProxyChannelId; enabled: boolean; time: string; jitterMin: number; message?: string }>(
    "proxy_checkin_auto_set",
    opts as unknown as Record<string, unknown>
  );
/** 扫描本机已装软件的登录态（凭据不出主进程，只回候选信息） */
export const proxyScan = () => call<ProxyScanCandidate[]>("proxy_scan");
/** 导入本机候选；file/uid 用于身份核对（两次扫描之间文件变化时不至于导错账号） */
export const proxyScanImport = (index: number, channel?: ProxyChannelId, file?: string, uid?: string) =>
  call<{ ok: boolean; id?: string; updated?: boolean; message?: string }>("proxy_scan_import", { index, channel, file, uid });
/** 拉起对应渠道的官方登录（授权页由主进程 shell.openExternal 打开，结果经 app:event 回流）；
 *  userCode 仅 Cline 设备授权返回（前端显示用户码，供手动输码） */
export const proxyOauthBegin = (channel: ProxyChannelId) =>
  call<{ ok: boolean; url?: string; mode?: string; port?: number; userCode?: string; message?: string }>("proxy_oauth_begin", { channel });
/** AutoClaw 国际版 OAuth：带上前端跑完阿里云滑块的验证串换授权地址（主进程占白名单端口回环等回调） */
export const proxyOauthBeginWithCaptcha = (channel: ProxyChannelId, captchaVerifyParam: string, vendor: "zai" | "google" = "zai") =>
  call<{ ok: boolean; url?: string; mode?: string; port?: number; message?: string }>("proxy_oauth_begin", { channel, captchaVerifyParam, vendor }, 0);
/** AutoClaw 国际版：风控配置（enabled/prefix/sceneId，前端初始化阿里云滑块用） */
export const proxyAutoclawCaptchaConfig = (channel: ProxyChannelId) =>
  call<{ ok: boolean; enabled?: boolean; region?: string; prefix?: string; sceneId?: string; supplier?: string; message?: string }>("proxy_autoclaw_captcha_config", { channel }, 0);
/** AutoClaw 国内版：发送短信验证码（返回 deviceId，登录时必须沿用） */
export const proxyAutoclawSmsSend = (channel: ProxyChannelId, phone: string) =>
  call<{ ok: boolean; deviceId?: string; message?: string }>("proxy_autoclaw_sms_send", { channel, phone }, 0);
/** AutoClaw 国内版：验证码登录（deviceId 沿用发码返回值；code 传 6 位数字字符串，主进程转 JSON number） */
export const proxyAutoclawSmsLogin = (channel: ProxyChannelId, phone: string, code: string, deviceId: string) =>
  call<{ ok: boolean; id?: string; uid?: string; updated?: boolean; message?: string }>("proxy_autoclaw_sms_login", { channel, phone, code, deviceId }, 0);
/** Loomy（讯飞）：发送短信验证码（返回 msgid，登录时必须沿用） */
export const proxyLoomySmsSend = (phone: string) =>
  call<{ ok: boolean; msgid?: string; phoneTail?: string; message?: string }>("proxy_loomy_sms_send", { phone }, 0);
/** Loomy（讯飞）：验证码登录（msgid 沿用发码返回值） */
export const proxyLoomySmsLogin = (phone: string, code: string, msgid: string) =>
  call<{ ok: boolean; id?: string; uid?: string; message?: string }>("proxy_loomy_sms_login", { phone, code, msgid }, 0);
/** CodeArts 每日福利：只读探测可领项（领取走既有的批量签到链路，主进程串行换 token） */
export const proxyCodeartsWelfarePreview = (accountId = "") =>
  call<{ ok: boolean; rows?: { name: string; ok: boolean; message: string }[]; message?: string }>("proxy_codearts_welfare_preview", { accountId }, 0);
export const proxyOauthCancel = () => call<{ ok: boolean; cancelled?: boolean }>("proxy_oauth_cancel");
/** 兜底：浏览器没跳回回环地址时，把地址栏内容整段粘回来完成登录（串行换 token，可能多次上游请求） */
export const proxyOauthSubmitCallback = (channel: ProxyChannelId, url: string) =>
  call<{ ok: boolean; message?: string }>("proxy_oauth_submit_callback", { channel, url }, 0);
/** 粘贴 JSON 批量添加账号（单个对象 / 数组 / {accounts:[...]}，字段容忍别名） */
export const proxyAccountImportJson = (channel: ProxyChannelId, json: string) =>
  call<{ ok: boolean; added?: number; dup?: number; invalid?: number; message?: string }>("proxy_account_import_json", { channel, json });
/** 从 JSON/ZIP 文件添加账号（主进程弹文件选择框等用户操作；zip 读取包内全部 .json 合并导入） */
export const proxyAccountImportFile = (channel: ProxyChannelId) =>
  call<{ ok: boolean; canceled?: boolean; added?: number; dup?: number; invalid?: number; file?: string; message?: string }>("proxy_account_import_file", { channel }, 0);

/** 切号预检事实（确认框展示用）：目标客户端是否在运行 / 安装路径 / 切完是否自动重启 */
export interface IdeSwitchProbe {
  channel: string;
  clientName: string;
  file: string;
  exe: string;
  running: boolean;
  relaunch: boolean;
  note?: string;
  warning?: string;
}

/** 切号（所有渠道首调一律只做只读预检并返回 needConfirm + probe，前端弹确认框展示真实探测事实；
 *  用户确认后传 confirmAck 重调才真正执行——关客户端、等退出、写回、按原状拉起。
 *  预检判定「切不了」时直接回 ok:false，不弹框。确认后关客户端等退出时长不可控，故关闭看门狗） */
export const proxyIdeSwitch = (accountId: string, confirmAck?: boolean) =>
  call<{ ok: boolean; channel?: string; file?: string; backup?: string; needConfirm?: boolean; probe?: IdeSwitchProbe; relaunched?: boolean; message?: string }>("proxy_ide_switch", { accountId, confirmAck }, 0);
export const proxyIdeStatus = () => call<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; raccoonInstalled?: boolean; modelscopeInstalled?: boolean; lobsterInstalled?: boolean; zcodeInstalled?: boolean; qoderInstalled?: boolean; qoderIntlInstalled?: boolean; currentUid: string }>("proxy_ide_status");
/** zcode 切号回滚（切出问题 / 远程连接异常时一键还原最近一次切前状态） */
export const proxyZcodeSwitchRollback = () =>
  call<{ ok: boolean; message?: string }>("proxy_zcode_switch_rollback");
/** zcode 设备指纹诊断（只读）：多号共用一枚指纹 = 一号领取全组 1004 的病灶定位 */
export const proxyZcodeDeviceStatus = () => call<ZcodeDeviceStatusResult>("proxy_zcode_device_status");
/** zcode 设备指纹修复（幂等）：撞车/疑似被烧的账号重派全新随机指纹，claim 1004 的唯一出路 */
export const proxyZcodeDeviceRepair = (all?: boolean) =>
  call<ZcodeDeviceStatusResult & { repaired: number }>("proxy_zcode_device_repair", { all: !!all });
/** zcode 领取模式（人工链路）：live 指纹临时借出为目标账号专属指纹，官方客户端里领周末套餐用。
 *  客户端在跑时首调返回 needConfirm + probe，确认后带 confirmAck 重调（关客户端 → 写指纹 → 自动重开） */
export const proxyZcodeClaimMode = (accountId: string, confirmAck?: boolean) =>
  call<ZcodeClaimModeResult>("proxy_zcode_claim_mode", { accountId, confirmAck }, 0);
/** zcode 恢复本机锚定指纹（领取模式收尾）：anchor.remoteMid 写回 live，手机远程随之恢复 */
export const proxyZcodeRestoreMid = (confirmAck?: boolean) =>
  call<ZcodeClaimModeResult>("proxy_zcode_restore_mid", { confirmAck }, 0);
/** zcode 独立人机校验（过码）：拉起官方验证码沙箱窗口，核销并解除风控。
 *  主进程侧已有 120s 看门狗 + 页面 SDK 15s 加载超时托底，这里留 150s 余量即可 */
export const proxyZcodeSolveCaptcha = (accountId: string) =>
  call<{ ok: boolean; message?: string }>("proxy_zcode_solve_captcha", { accountId }, 150_000);
// ===== 号池管家：操作日志（「日志」页签） =====
export interface ProxyOpLogFilter {
  /** 毫秒时间戳区间（视图层由日期串换算），空/0 = 不限 */
  from?: number | null;
  to?: number | null;
  level?: string;
  op?: string;
  limit?: number;
  offset?: number;
}
export const proxyOpLogList = (filter: ProxyOpLogFilter) => call<ProxyOpLogList>("proxy_oplog_list", filter as Record<string, unknown>);
export const proxyOpLogOps = () => call<string[]>("proxy_oplog_ops");
/** 导出 Excel（.xlsx 落 downloads，文件名含毫秒时间戳）；导出当前筛选全集（无分页） */
export const proxyOpLogExport = (filter: Omit<ProxyOpLogFilter, "limit" | "offset">) =>
  call<{ ok: boolean; path?: string; count?: number; message?: string }>("proxy_oplog_export", filter as Record<string, unknown>);
export const proxyOpenDataDir = () => call<{ ok: boolean }>("proxy_open_data_dir");
export const proxyVaultStatus = () => call<{ encrypted: boolean; driver: string; dataDir: string }>("proxy_vault_status");



// ===== 记忆中枢：配置 / 根目录 =====
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

// ===== 记忆中枢：读写 / 浏览 =====
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

// ===== 记忆中枢：回收站 =====
export const memoryTrashList = () =>
  call<{ items: { name: string; trashedAt: number; originPath: string; size: number }[] }>("memory_trash_list");
export const memoryTrashRestore = (name: string, dest: string) => call<{ ok: boolean }>("memory_trash_restore", { name, dest });
export const memoryTrashPurge = (days?: number) => call<{ removed: number }>("memory_trash_purge", { days });

// ===== 记忆中枢：项目归类 =====
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
/** 关联本地目录到既有项目卡：补全远程地址与本地路径（非 Git 目录只记路径） */
export const memoryProjectAttach = (slug: string, dir: string) =>
  call<{ ok: boolean; message?: string; isRepo?: boolean; addedRemotes?: string[]; localPath?: string }>("memory_project_attach", { slug, dir });

// ===== 记忆中枢：索引 / 检索 =====
export const memoryIndexStatus = () => call<MemoryIndexStatus>("memory_index_status");
export const memoryIndexBuild = () =>
  call<{ ok: boolean; files: number; pruned: number; caseFixed?: number; diagnose?: { consistent: boolean; broken: number; orphan: number; unindexed: number } }>("memory_index_build");
export const memoryIndexRebuild = () => call<{ ok: boolean; files: number; tookMs: number }>("memory_index_rebuild");
export const memoryIndexDiagnose = () =>
  call<{ diagnose: { orphanRows: string[]; unindexed: string[]; fts: { rebuilt: boolean } }; graph: { nodes: number; edges: number; broken: number; isolated: number } }>("memory_index_diagnose");
export const memoryIndexVacuum = () => call<{ ok: boolean; before: number; after: number }>("memory_index_vacuum");
export const memorySearch = (query: string, opts?: {
  project?: string; agent?: string; layer?: string; limit?: number; offset?: number; includeSuperseded?: boolean;
  type?: string; tag?: string; starred?: boolean; pinned?: boolean;
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
export const memoryUnsupersede = (id: string) =>
  call<{ ok: boolean; id: string; message?: string }>("memory_unsupersede", { id });

// ===== 记忆中枢：Agent 接入 =====
export const memoryAgentsList = () =>
  call<{
    agents: MemoryAgentCard[];
    command: { command: string | null; args: string[]; env: Record<string, string>; hostExists: boolean; bridgeExists: boolean };
    bridge: MemoryBridgeStatus;
  }>("memory_agents_list");
// 真拉起桥进程握手，冷启动时长不可控
export const memoryAgentVerify = (id: string, skipHandshake = false) => call<MemoryAgentVerify>("memory_agent_verify", { id, skipHandshake }, 0);
export const memoryAgentVerifyAll = () => call<MemoryAgentVerify[]>("memory_agent_verify_all", {}, 0);
export const memoryAgentInject = (id: string) =>
  call<{ ok: boolean; message?: string; steps: { ok: boolean; action: string; file: string; backup?: string | null }[]; configPath: string; instructionPath: string }>("memory_agent_inject", { id });
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
export const memoryBridgeRestart = () => call<{ ok: boolean; port: number }>("memory_bridge_restart", {}, 0);

// ===== 记忆中枢：报告 / 导出 =====
export const memoryReportsList = () =>
  call<{ reports: { name: string; size: number; mtime: number }[] }>("memory_reports_list");
export const memoryReportRead = (name: string) => call<{ name: string; content: string }>("memory_report_read", { name });
// 全量导出可能打包整个记忆目录，体积不可控
export const memoryExport = (scope?: string) => call<{ content: string; files: number }>("memory_export", { scope }, 0);
export const memoryExportZip = () => call<{ file: string; files: number; bytes: number }>("memory_export_zip", {}, 0);
export const memoryOpenDir = (rel?: string) => call<{ path: string }>("memory_open_dir", { rel });

// ===== 记忆中枢：模型与网关（供应商 / 模型池 / 路由 / 三级测试） =====
export const memoryProviderList = () => call<{ providers: Record<string, unknown>[] }>("memory_provider_list");
export const memoryGatewayList = () =>
  call<{ gateways: { id: string; name: string; baseUrl: string; available: boolean; urlOverride: string; modelCount: number; enabledModelCount: number; fallbackModel: string }[] }>("memory_gateway_list");
export const memoryProviderSave = (input: Record<string, unknown>) =>
  call<{ ok: boolean; id: string }>("memory_provider_save", input as Record<string, unknown>);
export const memoryProviderDelete = (id: string) => call<{ ok: boolean; removedModels: number }>("memory_provider_delete", { id });
// 供应商启用/停用：列表行内开关即时生效（独立通道，不走 save 的 Key 改道防护）
export const memoryProviderToggle = (id: string, enabled: boolean) =>
  call<{ ok: boolean; enabled: boolean }>("memory_provider_toggle", { id, enabled });
// 三级连通测试 / 拉模型 / 真实试调：真实网络调用，主进程 llm client 自带超时但三级连测可能超 45s，豁免
export const memoryProviderTest = (id: string, modelId?: string) =>
  call<{
    ok: boolean; message?: string;
    l1: { ok: boolean; latencyMs?: number; status?: number; message?: string };
    l2: { ok: boolean; models?: number; message?: string };
    l3: { ok: boolean; status?: number; message?: string };
    suggestion: { apiFormat: string; reason: string } | null;
  }>("memory_provider_test", { id, modelId }, 0);
export const memoryProviderFetchModels = (id: string) =>
  call<{ ok: boolean; models: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string }; caps: Record<string, unknown> }[]; message?: string }>("memory_provider_fetch_models", { id }, 0);
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
  call<{ order: string[]; tagDefs: string[]; sources: { key: string; available: boolean; detail: string }[]; routing: unknown[]; taskEffort: Record<string, string>; degrade: Record<string, unknown> }>("memory_llm_sources");
export const memoryLlmSourcesSave = (payload: { order?: string[]; routing?: unknown[]; taskEffort?: Record<string, string>; tagDefs?: string[]; degrade?: Record<string, unknown> }) =>
  call<{ ok: boolean }>("memory_llm_sources_save", payload as Record<string, unknown>);
export const memoryLlmRouting = () =>
  call<{ routing: { task: string; tags: string[]; effort: string; providerId?: string; modelId?: string; chain: { providerId: string; providerName: string; modelId: string; priority: number; source: string }[] }[] }>("memory_llm_routing");
export const memoryLlmRoutingSave = (payload: { routing?: unknown[] }) => call<{ ok: boolean }>("memory_llm_routing_save", payload as Record<string, unknown>);
export const memoryLlmTestCall = (providerId: string, modelId?: string, effort?: string) =>
  // 真实调模型生成，分钟级可能
  call<{ ok: boolean; latencyMs?: number; text?: string; providerId?: string; modelId?: string; effort?: string; usage?: { input: number; output: number }; message?: string; tried?: string[] }>("memory_llm_test_call", { providerId, modelId, effort }, 0);
export const memoryLlmUsage = (days?: number) =>
  call<{ usage: { provider: string; model: string; task: string; calls: number; tokensIn: number; tokensOut: number; successRate: number }[]; today: { tokens: number; calls: number } }>("memory_llm_usage", { days });

// ===== 记忆中枢：自动化任务 =====
export const memoryAutoStatus = () => call<Record<string, unknown>>("memory_auto_status");
export const memoryAutoTimeline = (limit?: number) => call<{ entries: Record<string, unknown>[] }>("memory_auto_timeline", { limit });
export const memoryAutoTaskRun = (id: string) =>
  // 入队即返回（忙时排队）；页面有进度弹窗跟随后端快照托底
  call<{ ok: boolean; queued?: boolean; started?: boolean; task?: string; tokens?: number; detail?: string; ms?: number; message?: string }>("memory_auto_task_run", { id }, 0);
export const memoryAutoTaskSave = (id: string, patch: Record<string, unknown>) => call<{ ok: boolean }>("memory_auto_task_save", { id, patch });
export const memoryAutoPause = (opts: { until?: number; resume?: boolean }) => call<Record<string, unknown>>("memory_auto_pause", opts as Record<string, unknown>);
export const memoryAutoCancel = () => call<{ ok: boolean }>("memory_auto_cancel");
export const memoryAutoCost = () => call<Record<string, unknown>>("memory_auto_cost");
export const memoryAutoReport = () => call<{ ok: boolean; file: string }>("memory_auto_report", {}, 0);

// ===== 记忆中枢：深层记忆 / 蒸馏 / 画像 / 待确认队列 =====
export const memoryDistillRun = (opts?: { project?: string }) =>
  // 蒸馏调模型逐条处理，分钟级长任务
  call<{ processed: number; updated: number; tokens: number; detail: string; report?: string }>("memory_distill_run", opts as Record<string, unknown>, 0);
export const memoryProfileGet = () =>
  call<{ sections: { name: string; path: string; text: string; exists: boolean }[]; history: { name: string; mtime: number }[]; lastAt: number }>("memory_profile_get");
// 画像生成按实现注释「耗时以分钟计」；dim 只生成单个分区（其余分区文件与 pinned 内容不动）
export const memoryProfileGenerate = (dim?: "persona" | "preferences" | "tech" | "habits") =>
  call<{ processed: number; updated: number; tokens: number; detail: string; report?: string }>("memory_profile_generate", dim ? { dim } : {}, 0);
export const memoryProfileSave = (name: string, text: string) => call<{ ok: boolean }>("memory_profile_save", { name, text });
export const memoryReviewList = (kind: "supersede" | "classify" | "dedup" | "supersede-done") =>
  call<{ items: { id: string; kind: string; payload: Record<string, any>; created: number }[] }>("memory_review_list", { kind });
export const memoryReviewResolve = (id: string, action: "confirm" | "dismiss" | "merge" | "assign" | "newProject" | "general", payload?: Record<string, unknown>) =>
  // stale：引用记忆已不存在，后端已自动作废该建议（message 为可读原因）
  call<{ ok: boolean; stale?: boolean; message?: string }>("memory_review_resolve", { id, action, payload });

// ===== 记忆中枢：WebDAV 同步 =====
export const memorySyncStatus = () =>
  call<{ running: boolean; stage: string; stageLabel: string; percent: number; detail: string; lastSyncAt: number; conflicts: number; tombstones: number; configured: boolean }>("memory_sync_status");
export const memorySyncRun = () =>
  // 整目录打包传输：长任务，有 memory_sync_cancel + 进度事件托底
  call<{ ok: boolean; uploaded?: number; downloaded?: number; conflicts?: number; merged?: number; message?: string; cancelled?: boolean }>("memory_sync_run", {}, 0);
export const memorySyncCancel = () => call<{ ok: boolean; message?: string }>("memory_sync_cancel");
export const memorySyncLogs = (limit?: number) => call<{ logs: { at: number; stage: string; detail: string }[] }>("memory_sync_logs", { limit });
export const memoryConflictsList = () => call<{ conflicts: Record<string, unknown>[] }>("memory_conflicts_list");
export const memoryConflictsDiff = (index: number) =>
  call<{ ok: boolean; path: string; note: string; localText: string; remoteText: string; local?: { size: number; mtime: number; hash: string } | null; remote?: { size: number; mtime: number; hash: string } | null }>("memory_conflicts_diff", { index });
export const memoryConflictsResolve = (index: number, decision: "keepLocal" | "keepRemote" | "keepBoth" | "merge", mergedText?: string) =>
  call<{ ok: boolean; message?: string }>("memory_conflicts_resolve", { index, decision, mergedText });
/** 批量按建议裁决：按 path 提交（主进程按 path 反查下标，队列重排也不会裁决错条目），单条失败只跳过该条 */
export const memoryConflictsResolveRecommended = (items: { path: string; decision: "keepLocal" | "keepRemote" }[]) =>
  call<{ ok: boolean; total: number; resolved: number; paths: string[]; failed: { path: string; message: string }[] }>(
    "memory_conflicts_resolve_recommended",
    { items },
  );
export const memorySyncDevices = () => call<{ devices: { deviceId: string; name?: string; lastSyncAt?: number; count?: number }[]; deviceId: string }>("memory_sync_devices");
export const memorySyncPacks = () => call<{ packs: { at: number; bytes: number; files: number; dir: string }[] }>("memory_sync_packs");

// ===== 记忆中枢：去重 =====
export const memoryDedupStatus = () =>
  call<{ total: number; pending: number; done: number; merged: number; queued: number; dedupRate: number; learnedPairs: number; tokensUsed: number; layerCounts: { l1: number; learned: number }; autoDeleteDisabled: boolean }>("memory_dedup_status");
export const memoryDedupScan = (useModel = true) =>
  // 全库扫描 + 模型判定，长任务
  call<{ scanned: number; merged: number; queued: number; acted: number; tokens: number }>("memory_dedup_scan", { useModel }, 0);
export const memoryDedupReviewList = () => call<{ items: { id: string; payload: Record<string, any> }[] }>("memory_dedup_review_list");
export const memoryDedupReviewResolve = (id: string, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss", payload?: Record<string, unknown>) =>
  call<{ ok: boolean; stale?: boolean; message?: string }>("memory_dedup_review_resolve", { id, action, payload });
export const memoryDedupPairsGet = () => call<{ pairs: { a: string; b: string; aTitle: string; bTitle: string }[] }>("memory_dedup_pairs_get");
export const memoryDedupPairsClear = (pair?: string) => call<{ ok: boolean }>("memory_dedup_pairs_clear", { pair });
export const memoryDedupLayerToggle = (layer: "l1" | "l2" | "l4", enabled: boolean) => call<{ ok: boolean }>("memory_dedup_layer_toggle", { layer, enabled });

// ===== 记忆中枢：导入引擎 =====
export const memoryImportSources = () =>
  call<{ sources: Record<string, unknown>[]; importDir: string }>("memory_import_sources");
export const memoryImportSourceSave = (list: { id: string; name: string; kind: string; path: string; enabled: boolean; table?: string }[]) =>
  call<{ ok: boolean; sources: Record<string, unknown>[] }>("memory_import_source_save", { list });
export const memoryImportSourceDetect = (id: string, path?: string) =>
  // 探测可能连接外部数据库，时长不可控
  call<{ detect: Record<string, unknown> }>("memory_import_source_detect", { id, path }, 0);
export const memoryImportPreview = (opts?: { sourceIds?: string[]; limit?: number }) =>
  // 干跑预览同样要扫源，长任务
  call<Record<string, unknown>>("memory_import_preview", opts as Record<string, unknown>, 0);
export const memoryImportApply = (opts?: { sourceIds?: string[] }) =>
  // 主进程后台跑 + 进度事件 + memory_import_cancel 托底
  call<{ ok: boolean; created: number; merged: number; skipped: number; sensitive: number; failed: number; report?: string; verify?: Record<string, unknown>; message?: string }>("memory_import_apply", opts as Record<string, unknown>, 0);
export const memoryImportCancel = () => call<{ ok: boolean; message?: string }>("memory_import_cancel");
export const memoryImportProgress = () =>
  call<{ phase: string; done: number; total: number; created: number; merged: number; skipped: number; sensitive: number; running: boolean }>("memory_import_progress");
export const memoryImportReport = () => call<{ ok: boolean; files: string[]; content: string }>("memory_import_report");
export const memoryImportCursorsGet = () => call<{ ok: boolean; cursors: Record<string, unknown>; file: string }>("memory_import_cursors_get");
export const memoryImportCursorsReset = (id?: string) => call<{ ok: boolean; cursors: Record<string, unknown> }>("memory_import_cursors_reset", { id });
export const memoryImportMapSave = (id: string, mapping: { table?: string }) => call<{ ok: boolean; sources: Record<string, unknown>[] }>("memory_import_map_save", { id, mapping });

// ===== 外置插件 =====
// 命令名与插件包结构固定；宿主不感知具体插件，能力全部由 manifest 描述
export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  installed: boolean;
  invalid: boolean;
  reason: string;
  enabled: boolean;
  running: boolean;
  compatible: boolean;
  compatReason: string;
  lastError: string;
  minAppVersion: string;
  maxAppVersion: string;
  ui: { url: string; title: string } | null;
  /** 侧栏入口声明（label 用作卡片显示名）；未声明则不出现在左侧栏。
   *  卡片位置由宿主固定（所有内置板块之后），插件不能指定插入点 */
  sidebar: { label: string } | null;
  /** 插件声明愿意接收的宿主资源（pool / channels），空数组表示不接 */
  bridgeKinds: string[];
  /** 是否支持内嵌主区域（manifest.ui.embed !== false） */
  embed: boolean;
  /** 宿主数据推送状态；未声明桥接时为 null */
  poolSync: { lastAt: number; lastError: string; imported: number; removed: number } | null;
};
export type PluginInstallResult = {
  ok: boolean;
  canceled?: boolean;
  updated?: boolean;
  id?: string;
  name?: string;
  version?: string;
  warning?: string;
  message?: string;
};
export type PluginEmbedResult = { ok: boolean; id?: string; url?: string; title?: string; message?: string };
export const pluginList = () => call<PluginInfo[]>("plugin_list");
export const pluginInstall = () => call<PluginInstallResult>("plugin_install");
export const pluginUninstall = (id: string) => call<{ ok: boolean; message?: string }>("plugin_uninstall", { id });
export const pluginToggle = (id: string, enabled: boolean) =>
  call<{ ok: boolean; message?: string }>("plugin_toggle", { id, enabled });
export const pluginOpen = (id: string) => call<{ ok: boolean; message?: string }>("plugin_open", { id });
/** 内嵌地址：带一次性令牌，供 iframe 首次免登录 */
export const pluginEmbed = (id: string) => call<PluginEmbedResult>("plugin_embed", { id });
/** 手动把宿主号池/渠道状态推给插件一次 */
export const pluginSyncNow = (id: string) =>
  call<{ ok: boolean; imported?: number; removed?: number; message?: string }>("plugin_sync_now", { id });

// ===== 提示词库（契约 docs/提示词板块/02-实施契约.md §4；通道名与后端注册名、preload 白名单逐字一致） =====
// 命名规则：通道 prompts_xxx_yyy → 封装 promptsXxxYyy（与既有 memory_* 的封装风格一致）。
// 说明：这里的 32 个通道是契约 §4.1/§4.2/§4.3 表格的**全集**（14 + 9 + 9）。
// 返回形状沿用本文件既有信封：成功返回整个 { ok:true, ... }，失败由 unwrapResult 抛错，
// 错误码挂在 err.code 上（§4.2 明确要求按 code 分支，不许按 message 文案匹配）。

// ---- 4.1 库 ----
export const promptsList = (opts?: { includeTrash?: boolean }) =>
  call<{ ok: boolean; items: PromptItem[] }>("prompts_list", opts as Record<string, unknown>);
export const promptsGet = (args: { id: string }) =>
  call<{ ok: boolean; item: PromptItem }>("prompts_get", { id: args.id });
/** 保存单条：带 expectedHash 时后端做乐观锁，内容已被他处改过会回 { ok:false, code:"conflict" }，
 *  由 unwrapResult 抛成 err.code==="conflict"——调用方据此弹「已被其他设备修改」的覆盖确认 */
export const promptsSave = (args: { item: PromptItem; expectedHash?: string }) =>
  call<{ ok: boolean; id: string; hash: string }>("prompts_save", {
    item: JSON.parse(JSON.stringify(args.item)),
    expectedHash: args.expectedHash,
  });
export const promptsDelete = (args: { id: string }) => call<{ ok: boolean }>("prompts_delete", { id: args.id });
export const promptsRestore = (args: { id: string }) => call<{ ok: boolean }>("prompts_restore", { id: args.id });
export const promptsPurge = (args: { id: string }) => call<{ ok: boolean }>("prompts_purge", { id: args.id });
export const promptsEmptyTrash = () => call<{ ok: boolean; count: number }>("prompts_empty_trash");
export const promptsStats = () => call<{ ok: boolean; stats: PromptStats }>("prompts_stats");
export const promptsMeta = () => call<{ ok: boolean; categories: string[]; tags: string[] }>("prompts_meta");
export const promptsExport = (args: { ids?: string[]; format: "md" | "json" }) =>
  call<{ ok: boolean; path: string; count: number }>("prompts_export", { ids: args.ids, format: args.format });
export const promptsImport = (args: { data: string; format: "md" | "json"; onConflict: "new" | "overwrite" | "skip" }) =>
  // 批量导入要逐条解析并写盘，条数一多必然超过默认 45s 看门狗；后端有互斥与进度事件托底
  call<{ ok: boolean; imported: number; overwritten: number; skipped: number }>("prompts_import", { ...args }, 0);
export const promptsOpenDir = () => call<{ ok: boolean }>("prompts_open_dir");
export const promptsSetDir = (args: { dir: string }) => call<{ ok: boolean; dir: string }>("prompts_set_dir", { dir: args.dir });
export const promptsRebuild = () => call<{ ok: boolean; count: number }>("prompts_rebuild");

// ---- 4.2 优化 ----
export const promptsStylesList = () =>
  call<{ ok: boolean; styles: PromptStyle[]; defaultId: string }>("prompts_styles_list");
export const promptsStylesSave = (args: { style: PromptStyle }) =>
  call<{ ok: boolean; id: string }>("prompts_styles_save", { style: JSON.parse(JSON.stringify(args.style)) });
export const promptsStylesDelete = (args: { id: string }) => call<{ ok: boolean }>("prompts_styles_delete", { id: args.id });
export const promptsStylesReset = () => call<{ ok: boolean }>("prompts_styles_reset");
/** 单次优化：真实调模型，时长由调用方传的 timeoutSec（默认 60s）决定，可能超过默认 45s 看门狗，
 *  故关闭渲染层看门狗——后端有 timeoutSec 硬上限 + prompts_optimize_cancel 托底，
 *  失败经 { ok:false, code } 回来（empty_input/too_long/no_model/model_error/timeout/cancelled/empty_result/unknown） */
export type PromptsOptimizeResult = {
  ok: boolean; text: string; styleName: string; model: string; elapsedMs: number;
  tokens?: { in: number; out: number };
  /** 多角度补全的 <ASSUMPTIONS> 块被后端剥离后的结果；其它风格为空数组 */
  assumptions?: string[];
  historyId?: string; unchanged?: boolean; fallback?: boolean;
  /** 本次是否真走了流式（上游不支持时后端自动回退非流式，这里是 false） */
  streamed?: boolean;
  /** 已推过字但最终失败：前端必须清掉半截内容 */
  partial?: boolean;
};

export type PromptsOptimizeArgs = {
  text: string; styleId: string; model?: string;
  maxLength?: number; temperature?: number; maxTokens?: number; timeoutSec?: number; scenario?: string;
  /** 本次额外要求（拼进 user 模板的 {extra}）；为空时整段不出现 */
  extra?: string;
  /** 本次请求 id：用于按 id 取消（流式下能真的中断上游） */
  runId?: string;
};

export const promptsOptimize = (args: PromptsOptimizeArgs) =>
  call<PromptsOptimizeResult>("prompts_optimize", { ...args }, 0);

/** 流式优化：增量经 app:event 的 optimize-delta 事件推送，收尾结果仍由本调用的返回值给出。
 *  delta 不逐 token 推（后端节流 60ms / 120 字符），所以事件数量可控。 */
export const promptsOptimizeStream = (args: PromptsOptimizeArgs) =>
  call<PromptsOptimizeResult>("prompts_optimize_stream", { ...args }, 0);

export const promptsOptimizeCancel = (args?: { runId?: string }) =>
  call<{ ok: boolean; aborted?: number }>("prompts_optimize_cancel", args || {});
export const promptsHistoryList = () => call<{ ok: boolean; items: PromptHistoryItem[] }>("prompts_history_list");
export const promptsHistoryDelete = (args: { id: string }) => call<{ ok: boolean }>("prompts_history_delete", { id: args.id });
export const promptsHistoryClear = () => call<{ ok: boolean }>("prompts_history_clear");

// ---- 4.4 线上目录（精选目录，纯客户端）----
export const promptsCatalogIndex = () =>
  call<{ ok: boolean; categories: CatalogCategory[]; templates: CatalogTemplate[]; version: number; source: string }>(
    "prompts_catalog_index"
  );
export const promptsCatalogList = (args: {
  category?: string; subcategory?: string; templateId?: string; q?: string; page?: number; pageSize?: number;
}) =>
  call<{ ok: boolean; items: CatalogItem[]; total: number; page: number; pageSize: number; counts: Record<string, number> }>(
    "prompts_catalog_list",
    args
  );
export const promptsCatalogGet = (id: string) =>
  call<{ ok: boolean; item?: CatalogItemDetail; message?: string }>("prompts_catalog_get", { id });
export const promptsCatalogStats = () => call<{ ok: boolean; stats: CatalogStats }>("prompts_catalog_stats");
/** 检查更新要逐个尝试 CDN 通道 + 只下变更分片，可能超过默认看门狗，故关闭 */
export const promptsCatalogRefresh = () =>
  call<{ ok: boolean; updated: boolean; version?: number; count?: number; downloaded?: number; failed?: number; message?: string }>(
    "prompts_catalog_refresh",
    {},
    0
  );
/** 导入要等系统文件对话框（用户可能很久才选），关闭看门狗 */
export const promptsCatalogImport = () =>
  call<{ ok: boolean; imported?: number; skipped?: number; total?: number; message?: string }>("prompts_catalog_import", {}, 0);
export const promptsCatalogClearImported = () => call<{ ok: boolean; total?: number }>("prompts_catalog_clear_imported");
export const promptsCatalogReset = () => call<{ ok: boolean; total?: number }>("prompts_catalog_reset");

// ---- 4.3 同步 ----
export const promptsSyncStatus = () => call<{ ok: boolean; status: PromptSyncStatus }>("prompts_sync_status");
/** 整库 WebDAV 三方合并：长任务，主进程有 running 互斥 + 进度事件 + prompts_sync_cancel 托底，关闭看门狗 */
export const promptsSyncRun = () => call<{ ok: boolean; message?: string }>("prompts_sync_run", {}, 0);
export const promptsSyncCancel = () => call<{ ok: boolean }>("prompts_sync_cancel");
export const promptsSyncLogs = () => call<{ ok: boolean; logs: { at: number; text: string }[] }>("prompts_sync_logs");
export const promptsSyncDevices = () =>
  call<{ ok: boolean; devices: { id: string; name: string; appVersion: string; lastSyncAt: number; self: boolean }[] }>(
    "prompts_sync_devices"
  );
export const promptsConflictsList = () => call<{ ok: boolean; items: PromptConflict[] }>("prompts_conflicts_list");
export const promptsConflictDiff = (args: { id: string }) =>
  call<{ ok: boolean; diff: PromptConflictDiff }>("prompts_conflict_diff", { id: args.id });
export const promptsConflictResolve = (args: { id: string; decision: "local" | "remote" | "both" | "merge"; mergedText?: string }) =>
  call<{ ok: boolean }>("prompts_conflict_resolve", { id: args.id, decision: args.decision, mergedText: args.mergedText });
export const promptsConflictsAuto = (args?: { strategy?: string }) =>
  // 批量按策略自动合并整条冲突队列：条数多时耗时不可控，同属长任务
  call<{ ok: boolean; merged: number; remaining: number }>("prompts_conflicts_auto", { strategy: args?.strategy }, 0);

// ---- 4.5 报告历史（契约 §4 之外的 2 个通道，Lead 在后端补注册；前端封装名同规则） ----
// 提示词库有自己的报告目录（<库>/reports/prompts-*.md，契约 §1），不复用技能仓库的 listReports
export const promptsReportsList = () =>
  call<{ ok: boolean; reports: { name: string; path: string; size: number }[] }>("prompts_reports_list");
export const promptsReportRead = (args: { name: string }) =>
  call<{ ok: boolean; text: string }>("prompts_report_read", { name: args.name });
