// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境下回退到本地 mock（便于独立开发/预览 UI）。
import type {
  SyncConfig, Summary, DeviceMeta, DeviceBreakdown, SyncLog, SyncProgress, SourceHealth, SourceInfo, UsageRecord, TotalMode, AggregateRow,
  PriceEntry, PriceRow, UnpricedModel, ImportPreview, ImportPreviewItem, RemotePricingConfig,
  DataDirInfo, SetDataDirResult, BackupInfo,
} from "../types/sync";
import { mock } from "./sync-mock";

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
    return (await window.agenthub!.invoke(cmd, args)) as T;
  }
  // 浏览器回退：直接走 mock
  return (await mock.invoke(cmd, args)) as T;
}

// ===== 配置 =====
export const loadConfig = () => call<SyncConfig>("sync_load_config");
export const saveConfig = (cfg: SyncConfig) => call<{ ok: boolean; message: string }>("sync_save_config", { config: JSON.parse(JSON.stringify(cfg)) });
export const testWebdav = (cfg: SyncConfig["webdav"]) => call<{ ok: boolean; message: string; latencyMs?: number }>("test_webdav", { config: { ...cfg } });

// ===== 数据源 =====
export const listSources = () => call<SourceInfo[]>("list_sources");
export const detectSource = (source: string) => call<{ ok: boolean; path: string | null; deviceId: string | null }>("detect_source", { source });
export const healthSource = () => call<SourceHealth[]>("health_source");

// ===== 汇总查询 =====
export const getSummary = (mode: TotalMode, deviceId?: string | null, source?: string | null) => call<Summary>("get_summary", { mode, deviceId, source });
export const getDevices = (mode: TotalMode, source?: string | null) => call<DeviceMeta[]>("get_devices", { mode, source });
export const getDeviceBreakdowns = (mode: TotalMode, deviceId?: string | null, source?: string | null) => call<DeviceBreakdown[]>("get_device_breakdowns", { mode, deviceId, source });
export const getTrend = (mode: TotalMode, days: number, deviceId?: string | null, source?: string | null) => call<{ date: string; total: number; cost: number; models?: Record<string, number> }[]>("get_trend", { mode, days, deviceId, source });
// 热力图行后端实际返回 cost（每日费用，DayModal 展示用），类型如实声明
export const getHeatmap = (mode: TotalMode, start: string, end: string, deviceId?: string | null, source?: string | null) => call<{ date: string; total: number; cost?: number; inputTokens?: number; cacheReadTokens?: number; callCount?: number }[]>("get_heatmap", { mode, start, end, deviceId, source });
export const getAggregate = (mode: TotalMode, dim: "model" | "provider" | "device" | "source", from: number | null, to: number | null, source?: string | null) =>
  call<AggregateRow[]>("get_aggregate", { mode, dim, from, to, source });
export const getRecords = (filter: {
  from: number | null; to: number | null; deviceId: string | null; source: string | null;
  model: string | null; provider: string | null; status: string | null; limit: number; offset: number;
}) => call<{ records: UsageRecord[]; total: number }>("get_records", filter);

// ===== 同步 =====
/** opts.mode="backup"：强制本机备份（未配置 WebDAV 时顶栏「立即同步」即此语义） */
export const startSync = (opts?: { mode: "backup" }) => call<void>("start_sync", opts ? { mode: opts.mode } : undefined);
export const cancelSync = () => call<void>("cancel_sync");
export const getSyncProgress = () => call<SyncProgress>("get_sync_progress");
export const getSyncLogs = () => call<SyncLog[]>("get_sync_logs");
export const clearSyncLogs = () => call<void>("clear_sync_logs");

// ===== 本机存储（备份压缩包） =====
export const getBackupInfo = () => call<BackupInfo>("get_backup_info");
export const browseBackupFile = () => call<{ ok: boolean; canceled?: boolean; path: string | null }>("browse_backup_file");
/** 整包还原：覆盖当前数据与设置为备份时点状态；成功后前端需重拉配置与页面数据 */
export const restoreBackup = (path: string) => call<{ ok: boolean; message: string; restoredConfig?: boolean }>("restore_backup", { path });

// ===== 导出 =====
/** 导出筛选条件：与明细页 getRecords 同一套字段；缺省时导出全部明细 */
export interface ExportFilter {
  from: number | null;
  to: number | null;
  deviceId: string | null;
  source: string | null;
  model: string | null;
  provider: string | null;
  status: string | null;
}
export const exportData = (format: "csv" | "json", filter?: ExportFilter | null) =>
  call<{ ok: boolean; path: string | null; message: string }>("export_data", { format, filter: filter ?? null });

// ===== 设备 =====
export const deleteDevice = (deviceId: string) =>
  call<{ ok: boolean; message: string }>("delete_device", { deviceId });

// ===== 计费 =====
export const getPrices = () => call<PriceRow[]>("get_prices");
export const getPriceVersions = (providerId: string | null, modelId: string) =>
  call<PriceEntry[]>("get_price_versions", { providerId, modelId });
export const savePrice = (price: Partial<PriceEntry>) =>
  call<{ ok: boolean; message: string }>("save_price", { price });
export const deleteModelPrices = (providerId: string | null, modelId: string) =>
  call<{ ok: boolean; message: string }>("delete_model_prices", { providerId, modelId });
export const getUnpricedModels = () => call<UnpricedModel[]>("get_unpriced_models");
export const importPricesPreview = (source: "litellm" | "openrouter") =>
  call<ImportPreview>("import_prices_preview", { source });
export const importPricesApply = (items: ImportPreviewItem[], effectiveFrom: number) =>
  call<{ ok: boolean; message: string }>("import_prices_apply", { items, effectiveFrom });
export const pullRemotePricing = (force = false) =>
  call<{ ok: boolean; message: string }>("pull_remote_pricing", { force });
export const getRemotePricingStatus = () =>
  call<RemotePricingConfig & { lastAt: number | null; lastHash: string | null; lastModels: number | null }>("get_remote_pricing_status");

// ===== 其它 =====
export const openDataDir = () => call<void>("sync_open_data_dir");
export const getDataDir = () => call<string>("sync_get_data_dir");
export const getDataDirInfo = () => call<DataDirInfo>("get_data_dir_info");
export const browseDataDir = () => call<{ ok: boolean; canceled?: boolean; path: string | null }>("browse_data_dir");
export const setDataDir = (path: string, migrate: boolean) => call<SetDataDirResult>("set_data_dir", { path, migrate });
export const resetDataDir = () => call<SetDataDirResult>("reset_data_dir");
export const getAppVersion = () => call<string>("get_app_version");
export const getIsPortable = () => call<boolean>("get_is_portable");
export const resetLocalCache = () => call<{ ok: boolean; message: string }>("reset_local_cache");
export const setAutostart = (enabled: boolean) => call<void>("set_autostart", { enabled });

// ===== 软件更新（安装版应用内更新；便携版仅提示手动更新） =====

/** 更新状态快照（主进程 updater.cjs 维护，经 invoke 拉取 + update:event 事件推送） */
export interface UpdateStatus {
  status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
  isPortable: boolean;
  currentVersion: string;
  latestVersion: string;
  percent: number; // 下载进度 0~100
  notes: string; // 更新日志（GitHub Release 说明）
  message: string; // 附加说明（便携版提示 / 错误信息）
}

/** 主进程推送的更新事件：event="state" 时其余字段为完整状态；event="focus-update" 为通知点击跳转信号 */
export interface UpdateEvent extends UpdateStatus {
  event: "state" | "focus-update";
}

export const getUpdateStatus = () => call<UpdateStatus>("get_update_status");
export const checkUpdate = () => call<UpdateStatus>("check_update");
export const downloadUpdate = () => call<UpdateStatus>("download_update");
export const installUpdate = () => call<UpdateStatus>("install_update");
/** GitHub Releases 页（便携版手动下载 / 更新失败兜底） */
export const openReleasePage = () => call<void>("open_release_page");
/** GitHub 仓库主页（设置页常驻地址按钮） */
export const openRepoPage = () => call<void>("open_repo_page");
/** 订阅主进程更新事件，返回取消订阅函数；浏览器环境无订阅源时返回 undefined */
export const onUpdateEvent = (cb: (e: UpdateEvent) => void): (() => void) | undefined =>
  window.agenthub?.onUpdateEvent?.((payload) => cb(payload as UpdateEvent));
