// 预加载脚本：通过 contextBridge 暴露安全的 IPC 调用桥给渲染进程
// 白名单机制：只放行后端 ipc.cjs 已注册的命令，防止渲染进程被注入后调用任意通道（纵深防御）
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_COMMANDS = new Set([
  // ===== 框架 =====
  "load_config",
  "save_config",
  "get_app_version",
  "get_data_dir",
  "open_data_dir",
  "get_hub_dir",
  "open_hub_dir",
  "browse_dir",
  // ===== 软件更新 =====
  "get_is_portable",
  "get_update_status",
  "check_update",
  "download_update",
  "install_update",
  "open_release_page",
  "open_repo_page",
  // ===== 技能仓库：WebDAV =====
  "webdav_test",
  "webdav_sync",
  "webdav_cancel",
  "webdav_status",
  "webdav_logs",
  "webdav_devices",
  // ===== 技能仓库：工具适配器 =====
  "list_tools",
  "skills_side_stats",
  "probe_agents",
  "remove_tool",
  // ===== 技能仓库：总览 / 技能库 =====
  "get_overview",
  "list_skills",
  "get_skill",
  // ===== 技能仓库：同步 / 报告 =====
  "sync_plan",
  "sync_execute",
  "list_reports",
  "read_report",
  "open_report",
  // ===== 技能仓库：冲突 / 挂载 / 回收站 / 自动感知 =====
  "list_conflicts",
  "get_conflict_diff",
  "resolve_conflict",
  "dismiss_conflict",
  "toggle_mount",
  "repair_mounts",
  "trash_list",
  "trash_restore",
  "trash_purge",
  "remove_skill",
  "watch_status",
  "adopt_hub_skill",
  // ===== 用量同步（原「用量记录同步」；与框架冲突的 4 个命令加 sync_ 前缀） =====
  "sync_load_config",
  "sync_save_config",
  "test_webdav",
  // 数据源
  "list_sources",
  "detect_source",
  "health_source",
  // 汇总查询
  "get_summary",
  "get_trend",
  "get_heatmap",
  "get_aggregate",
  "get_device_breakdowns",
  "get_records",
  // 同步
  "start_sync",
  "cancel_sync",
  "get_sync_progress",
  "get_sync_logs",
  "clear_sync_logs",
  // 本机存储（备份压缩包）
  "get_backup_info",
  "browse_backup_file",
  "restore_backup",
  // 设备
  "get_devices",
  "delete_device",
  // 导出
  "export_data",
  // 计费
  "get_prices",
  "get_price_versions",
  "save_price",
  "delete_model_prices",
  "get_unpriced_models",
  "import_prices_preview",
  "import_prices_apply",
  "pull_remote_pricing",
  "get_remote_pricing_status",
  // 数据目录与缓存（用量模块自己的数据目录，与框架 get_data_dir 区分开）
  "sync_get_data_dir",
  "sync_open_data_dir",
  "get_data_dir_info",
  "browse_data_dir",
  "set_data_dir",
  "reset_data_dir",
  "reset_local_cache",
  "set_autostart",
  // ===== 反代网关 =====
  "proxy_status",
  "proxy_start",
  "proxy_stop",
  "proxy_restart",
  "proxy_keys_list",
  "proxy_key_create",
  "proxy_key_update",
  "proxy_key_delete",
  "proxy_pool",
  "proxy_pool_strategy",
  "proxy_account_add",
  "proxy_account_remove",
  "proxy_account_toggle",
  "proxy_account_cool_off",
  "proxy_account_refresh",
  "proxy_credits_refresh",
  "proxy_credits_refresh_channel",
  "proxy_checkin_status",
  "proxy_checkin_run",
  "proxy_scan",
  "proxy_scan_import",
  "proxy_oauth_begin",
  "proxy_oauth_cancel",
  "proxy_oauth_submit_callback",
  "proxy_account_import_json",
  "proxy_account_import_file",
  "proxy_models",
  "proxy_models_sync",
  "proxy_ide_switch",
  "proxy_ide_status",
  "proxy_stats_overview",
  "proxy_stats_top",
  "proxy_stats_detail",
  "proxy_recent",
  "proxy_rules_list",
  "proxy_open_rules_dir",
  "proxy_open_data_dir",
  "proxy_vault_status",
  // ===== 反代网关：号池 WebDAV 同步 =====
  "proxy_poolsync_status",
  "proxy_poolsync_run",
  "proxy_poolsync_cancel",
  // ===== 反代网关：生态接入（CC Switch） =====
  "proxy_ccswitch_status",
  "proxy_ccswitch_register",
  // ===== 统一 WebDAV（设置 · 数据存储：共享服务器 + 三模块根目录） =====
  "webdav_shared_get",
  "webdav_shared_save",
  "webdav_shared_test",
]);

contextBridge.exposeInMainWorld("agenthub", {
  invoke: (cmd, args) => {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      return Promise.reject(new Error(`未授权的 IPC 命令：${cmd}`));
    }
    return ipcRenderer.invoke(cmd, args);
  },
  // 主进程广播（更新状态 / WebDAV 进度 / focus-update 跳转信号），返回退订函数
  onUpdateEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
});
