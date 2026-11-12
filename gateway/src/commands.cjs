/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-03（归档版 2026-10-22，本文件自归档恢复并按双模块形态改造）
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Docker 形态的管理命令清单与门控。
//
// 事实源是桌面注册表本身：register() 只依赖 ipcMain.handle 一个 API（实测全部 handler
// 无其它 electron API 依赖），传一个只实现 handle 的收集器即可拿到全量 { 命令 → handler }，
// 不需要把 handler 抽出来重构（那是对已发布核心的高风险改动）。
// 本文件只补充"容器形态能不能用"这层判定：read 只读监视 / write 有副作用 / deny 容器不可用。
//
// 四模块（方案板块 C）：proxy 号池管家（66 条）+ localgw 本地网关（43 条）+ prompts 提示词库（43 条）
// + memory 记忆中枢（125 条）四张注册表同时收集；pet 桌宠不收集（容器无意义，6 条命令显式 DENY）。
// DENY 清单为"表驱动"——不在 READ 里的命令自动归类为 write，DENY 内为容器不可用。
"use strict";

const path = require("node:path");

const PROXY_DIR = path.join(__dirname, "..", "..", "electron", "backend", "proxy");
const LOCALGW_DIR = path.join(__dirname, "..", "..", "electron", "backend", "localgw");
const PROMPTS_DIR = path.join(__dirname, "..", "..", "electron", "backend", "prompts");
const MEMORY_DIR = path.join(__dirname, "..", "..", "electron", "backend", "memory");
const proxyIndex = require(path.join(PROXY_DIR, "index.cjs"));
const localgwIndex = require(path.join(LOCALGW_DIR, "index.cjs"));
const promptsIndex = require(path.join(PROMPTS_DIR, "index.cjs"));
const memoryIndex = require(path.join(MEMORY_DIR, "index.cjs"));

/** 号池管家（proxy）只读命令（无副作用）：监视面板与只读令牌都依赖这份判定。
 *  逐条核对 2026-11-03 版本 66 条命令；新增命令默认按 write 处理，显式加进这里才算只读。 */
const READ = new Set([
  "proxy_status",
  "proxy_pool",
  "proxy_channel_list",
  "proxy_pool_strategy",
  "proxy_pool_tier",
  "proxy_checkin_status",
  "proxy_credits_refresh",
  "proxy_credits_refresh_channel",
  "proxy_scan",
  "proxy_account_refresh",
  "proxy_account_export_cockpit",
  "proxy_oplog_list",
  "proxy_oplog_ops",
  "proxy_provider_list",
  "proxy_provider_test",
  "proxy_provider_fetch_models",
  "proxy_poolsync_status",
  "proxy_autoclaw_captcha_config",
  "proxy_vault_status",
  "proxy_netproxy_list",
  "proxy_netproxy_test",
  "proxy_codearts_welfare_preview",
  // 签到中心：快照与套餐预览是只读；新手福利领取 / 套餐领取是写（不进 READ，落 write 档）。
  // 套餐领取在容器里没有浏览器环境，platform.solveCaptcha 会诚实拒绝 —— 前端按 needCaptcha 提示。
  "proxy_checkin_center",
  "proxy_plans_preview",
  "proxy_checkin_records",
  "proxy_growth_query",
]);
// 注意：plugin_* 不在这里。桌面版的 plugin_* 注册在 electron/backend/ipc.cjs（依赖
// BrowserWindow / dialog），collectCommands() 只收 proxy/localgw/prompts/memory 四个模块，
// 所以 RPC 表里没有这些命令。容器里的插件管理走 gateway/src/index.cjs 的 registerPluginRoutes
// （GET /api/plugins + toggle/uninstall/authorize；安装明确拒绝，见那里的说明）。

/** 本地网关（localgw）只读命令：43 条里逐条核对后的监视/查询集合。
 *  注意 localgw_keys_create/update/delete/revoke/rename/set_status 是写操作（记操作日志），
 *  未列入。 */
const LOCALGW_READ = new Set([
  "localgw_status",
  "localgw_keys_list",
  "localgw_route_get",
  "localgw_channel_test",
  "localgw_accounts_plan",
  "localgw_account_policy",
  "localgw_requests_list",
  "localgw_models_list",
  "localgw_models_snapshot",
  "localgw_models_channel_models",
  // ↑ 2026-11-12 安全收口 C2 主门：`localgw_config_get` **已从本集合移出**（改判 write）。
  //   它返回的是 `localgw.config.get()` 的**整个对象**，含 `security.secret`
  //   （API Key 的 HMAC 签名密钥信封）。留 READ + 靠出口剥段＝"白名单式忘记即泄漏"：
  //   将来该函数新增任何敏感字段都会自动对只读令牌敞开。只读看板的正确入口是
  //   GET /api/config/framework（显式路径白名单），不是这条。
  //   纵深防御仍在：gateway/src/index.cjs 的 RPC 出口对 read 档剥掉 security 段，
  //   防的是"将来有人为图方便把它挪回 READ"。
  "localgw_logs_list",
  "localgw_pot_stats",
  "localgw_stats_overview",
  "localgw_stats_detail",
  "localgw_outbound_get",
  "localgw_outbound_preview",
  "localgw_providers_list",
  "localgw_providers_doctor",
]);

/** 提示词库（prompts）只读命令：43 条里逐条核对后的监视/查询集合。
 *  注意 save/delete/restore/purge/import/export/optimize/cancel/sync 等写操作未列入。 */
const PROMPTS_READ = new Set([
  "prompts_list",
  "prompts_get",
  "prompts_meta",
  "prompts_stats",
  "prompts_history_list",
  "prompts_styles_list",
  "prompts_catalog_index",
  "prompts_catalog_list",
  "prompts_catalog_get",
  "prompts_catalog_stats",
  "prompts_sync_status",
  "prompts_sync_logs",
  "prompts_sync_devices",
]);

/** 记忆中枢（memory）只读命令：125 条里逐条核对后的监视/查询集合。
 *  注意 write/update/delete/pin/star/supersede/unsupersede/toggle 等写操作未列入。 */
const MEMORY_READ = new Set([
  "memory_list",
  "memory_get",
  "memory_stats",
  "memory_recent",
  "memory_heatmap",
  "memory_tags",
  "memory_trash_list",
  "memory_config_get",
  "memory_config_export",
  "memory_root_get",
  "memory_status",
  "memory_graph_stats",
  "memory_token_estimate",
  "memory_agents_list",
  "memory_agents_tools",
  "memory_agent_snippet",
  "memory_bridge_status",
  "memory_sync_status",
  "memory_sync_logs",
  "memory_sync_devices",
  "memory_sync_packs",
  "memory_review_list",
  "memory_dedup_pairs_get",
  "memory_dedup_status",
  "memory_auto_status",
  "memory_auto_report",
  "memory_auto_cost",
  "memory_import_sources",
  "memory_import_preview",
  "memory_import_report",
  "memory_llm_sources",
  "memory_llm_routing",
  "memory_llm_usage",
  "memory_model_list",
  "memory_projects",
  "memory_project_detail",
  "memory_profile_get",
  "memory_gateway_list",
  "memory_health_get",
  "memory_index_status",
  "memory_reports_list",
  "memory_report_read",
  "memory_search",
  "memory_timeline",
  "memory_digest",
]);

const SERVICE_CONTROL_REASON = "网关在容器里由编排管理，不能从界面启停——请用 docker restart 或 compose 命令";
const ZCODE_DEVICE_REASON = "ZCode 设备指纹相关操作需要本机客户端，容器里不可用";
const NO_GUI_REASON = "容器没有桌面环境，无法打开目录——数据在宿主机的 ./gateway-data";
const OAUTH_REASON = "容器内无法完成网页 OAuth（授权回调到不了容器）——请在桌面版登录后经 WebDAV/S3 号池同步灌号，或粘贴含 token 的凭据 JSON";
const NO_GUI_CAPTCHA_REASON = "人机校验需要图形环境，容器里无法弹窗——请在桌面版号池页手动领取";
const PROVIDER_SPAWN_REASON = "第三方 provider 进程托管需要宿主进程管理，容器里不支持——请在桌面版启用（把渠道指向已装的 v2 插件请改用「渠道绑定」，即 localgw_providers_exec）";
// 容器形态只跑 schema v2 的 provider 插件（入口 index.cjs 的 resumeEnabled({schema:2})），
// v1 界面型插件默认不做：专项 §五 三条硬理由——不签名、继承全 process.env、
// plugin-bridge 会把整池明文 token 镜像推给插件；且 ui.url 是 manifest 写死的绝对地址，
// 容器网络内的 127.0.0.1:<port> 对宿主浏览器根本不可达（要做必须由 gateway 反代，本期不做）。
const NO_V1_UI_REASON = "容器版插件只提供模型执行能力（schema v2 provider 型），不带自带界面——桌面窗口的嵌入与打开都不适用；界面型（v1）插件在容器形态默认关闭（留 AGENTHUB_PLUGIN_ALLOW_V1 开关，本期不实现）";


/** 容器形态不可用（号池管家 proxy 命令）：值面向用户（原因 + 替代路径），
 *  前端提示与服务端 403 共用同一份文案 */
const DENY = {
  proxy_start: SERVICE_CONTROL_REASON,
  proxy_stop: SERVICE_CONTROL_REASON,
  proxy_restart: SERVICE_CONTROL_REASON,
  proxy_open_data_dir: NO_GUI_REASON,
  proxy_open_rules_dir: NO_GUI_REASON,
  proxy_account_import_file: "容器无法弹出文件选择框——请用「粘贴 JSON 导入」或管理 API 的 /api/accounts/import",
  proxy_scan_import: "容器内没有可导入的本机登录态——请用 WebDAV/S3 号池同步，或粘贴含 token 的凭据 JSON",
  proxy_oauth_begin: OAUTH_REASON,
  proxy_oauth_submit_callback: OAUTH_REASON,
  proxy_ccswitch_status: "CC Switch 是本机客户端，容器里不可用",
  proxy_ccswitch_register: "CC Switch 是本机客户端，容器里不可用",
  proxy_ide_status: "IDE 切号需要本机客户端，容器里不可用",
  proxy_ide_switch: "IDE 切号需要本机客户端，容器里不可用",
  proxy_oplog_export: "容器里不能导出到本机目录——请到桌面版导出，或直接读宿主机数据目录",
  proxy_autoclaw_sms_send: "短信登录需要图形交互，容器里不可用——请在桌面版登录后经 WebDAV/S3 号池同步",
  proxy_autoclaw_sms_login: "短信登录需要图形交互，容器里不可用——请在桌面版登录后经 WebDAV/S3 号池同步",
  proxy_loomy_sms_send: "短信登录需要图形交互，容器里不可用——请在桌面版登录后经 WebDAV/S3 号池同步",
  proxy_loomy_sms_login: "短信登录需要图形交互，容器里不可用——请在桌面版登录后经 WebDAV/S3 号池同步",
  proxy_zcode_claim_mode: ZCODE_DEVICE_REASON,
  proxy_zcode_device_repair: ZCODE_DEVICE_REASON,
  proxy_zcode_device_status: ZCODE_DEVICE_REASON,
  proxy_zcode_restore_mid: ZCODE_DEVICE_REASON,
  proxy_zcode_switch_rollback: ZCODE_DEVICE_REASON,
  proxy_zcode_solve_captcha: NO_GUI_CAPTCHA_REASON,
};

/** 容器形态不可用（本地网关 localgw 命令） */
const LOCALGW_DENY = {
  localgw_start: SERVICE_CONTROL_REASON,
  localgw_stop: SERVICE_CONTROL_REASON,
  localgw_restart: SERVICE_CONTROL_REASON,
  localgw_set_port: "监听端口由容器编排固定（AGENTHUB_PROXY_PORT），不能在运行中改——请改 compose 后重建",
  localgw_set_autostart: "容器形态下本地网关随进程启停（autostart 恒 true），由编排管理",
  localgw_logs_export: "容器里不能导出到本机目录——请到桌面版导出，或直接读宿主机数据目录",
  localgw_request_cancel: "在途请求由本地网关请求队列管理，管理 API 暂不提供取消——请在桌面版操作或等待超时",
  // 这两条原先被一刀切写在一起，专项 §四 S3 要求拆开：
  //   · providers_enable 会去托管第三方 provider **进程**，容器确实不支持 → 保留 DENY；
  //   · providers_exec 经磁盘核对（localgw/index.cjs:253-257）只做两件事——
  //     services.setBinding / clearBinding，即往 config.localgw.models.serviceBindings
  //     写一条"这个渠道的执行来源是谁"，**不 spawn 任何东西**。它是纯配置写，
  //     所以从 DENY 移到 write 档（做法：从本表删掉这一行，不写进 READ 即自动归 write）。
  //     不放开就等于插件装了也永远 selected=false，容器里没人能把渠道指给插件（专项 G4）。
  localgw_providers_enable: PROVIDER_SPAWN_REASON,
  localgw_stats_cleanup: "清理操作建议在桌面版低峰执行，容器管理面不开放批量清理",
};


/** 容器形态不可用（提示词库 prompts 命令） */
const PROMPTS_DENY = {
  prompts_open_dir: "容器没有桌面环境，无法打开目录——请到桌面版「设置 · 提示词库」查看库目录",
  prompts_set_dir: "容器里不能改库目录（绝对路径只在容器内有效）——请在桌面版设置后同步",
  prompts_optimize_stream: "流式优化需要 SSE 长连接，容器里不支持——请在桌面版使用",
  prompts_optimize: "优化需要调用 LLM，容器里不支持——请在桌面版使用",
  prompts_optimize_cancel: "优化需要调用 LLM，容器里不支持——请在桌面版使用",
  prompts_catalog_import: "导入需要下载线上目录资源，容器里不支持——请在桌面版导入",
  prompts_catalog_refresh: "刷新线上目录需要下载资源，容器里不支持——请在桌面版刷新",
  prompts_catalog_reset: "重置线上目录会删除已导入内容，容器里不支持——请在桌面版操作",
  prompts_catalog_clear_imported: "清理已导入内容会删除本地数据，容器里不支持——请在桌面版操作",
};

/** 桌宠（pet）命令：容器无桌面环境，全部显式不可用（诚实不谎报） */
const PET_DENY = {
  pet_status: "桌宠需要桌面窗口环境，容器里不可用",
  pet_config_save: "桌宠需要桌面窗口环境，容器里不可用",
  pet_set_enabled: "桌宠需要桌面窗口环境，容器里不可用",
  pet_reset_position: "桌宠需要桌面窗口环境，容器里不可用",
  pet_usage_today: "桌宠需要桌面窗口环境，容器里不可用",
  pet_optimize_preview: "桌宠需要桌面窗口环境，容器里不可用",
};

/** 框架层（ipc.cjs）命令：容器无桌面窗口/系统托盘/文件对话框，显式不可用 */
const FRAMEWORK_DENY = {
  window_close: "容器没有桌面窗口，不可用",
  window_minimize: "容器没有桌面窗口，不可用",
  window_toggle_maximize: "容器没有桌面窗口，不可用",
  window_is_maximized: "容器没有桌面窗口，不可用",
  open_data_dir: "容器没有桌面环境，无法打开目录——数据在宿主机的 ./gateway-data",
  open_hub_dir: "容器没有桌面环境，无法打开目录",
  open_external_url: "容器没有桌面环境，无法打开浏览器",
  browse_dir: "容器没有文件选择对话框，不可用",
  probe_agents: "Agent 探测需要调用桌面客户端，容器里不可用",
  plugin_embed: NO_V1_UI_REASON,
  plugin_open: NO_V1_UI_REASON,
  module_toggle: "板块启停由容器编排管理，不能从界面切换——请用 docker restart",
};

/** WebDAV 同步（webdav_*）命令：容器里由 poolsync 统一走，桌面版入口显式不可用 */
const WEBDAV_DENY = {
  webdav_sync: "容器里 WebDAV 同步由 poolsync 统一调度，不支持手动触发——请在桌面版执行",
  webdav_cancel: "容器里 WebDAV 同步由 poolsync 统一调度，不支持取消——请在桌面版操作",
  webdav_test: "容器里 WebDAV 测试由 poolsync 统一调度，不支持手动测试——请在桌面版执行",
  webdav_shared_test: "容器里 WebDAV 测试由 poolsync 统一调度，不支持手动测试——请在桌面版执行",
  webdav_shared_save: "容器里 WebDAV 配置由 /api/config/webdav 统一管理，不支持单独保存——请用管理 API",
  webdav_shared_clear: "容器里 WebDAV 配置由 /api/config/webdav 统一管理，不支持清除——请用管理 API",
  webdav_shared_get: "容器里 WebDAV 配置由 /api/config/webdav 统一管理，不支持单独读取——请用管理 API",
  webdav_status: "容器里 WebDAV 状态由 poolsync 统一调度，不支持查询——请用 /api/config/webdav",
  webdav_devices: "容器里 WebDAV 设备列表由 poolsync 统一调度，不支持查询——请在桌面版查看",
  webdav_logs: "容器里 WebDAV 日志由 poolsync 统一调度，不支持查询——请在桌面版查看",
};

/** 技能仓库（skills_* / sync_* / trash_*）命令：容器无桌面环境，显式不可用 */
const SKILLS_DENY = {
  skills_side_stats: "技能仓库需要桌面环境，容器里不可用",
  sync_plan: "用量统计需要桌面环境，容器里不可用",
  sync_execute: "用量统计需要桌面环境，容器里不可用",
  sync_get_data_dir: "用量统计需要桌面环境，容器里不可用",
  sync_load_config: "用量统计需要桌面环境，容器里不可用",
  sync_open_data_dir: "用量统计需要桌面环境，容器里不可用",
  sync_save_config: "用量统计需要桌面环境，容器里不可用",
  trash_list: "回收站需要桌面环境，容器里不可用",
  trash_restore: "回收站需要桌面环境，容器里不可用",
  trash_purge: "回收站需要桌面环境，容器里不可用",
  watch_status: "监控需要桌面环境，容器里不可用",
  load_config: "配置由 /api/config 统一管理，请用管理 API",
  save_config: "配置由 /api/config 统一管理，请用管理 API",
  get_app_version: "版本信息由 /api/status 提供，请用管理 API",
  get_data_dir: "数据目录由 /api/status 提供，请用管理 API",
  get_is_portable: "容器没有便携模式，不可用",
  get_overview: "总览由 /api/status 提供，请用管理 API",
  get_hub_dir: "技能仓库需要桌面环境，容器里不可用",
  list_skills: "技能仓库需要桌面环境，容器里不可用",
  get_skill: "技能仓库需要桌面环境，容器里不可用",
  remove_skill: "技能仓库需要桌面环境，容器里不可用",
  adopt_hub_skill: "技能仓库需要桌面环境，容器里不可用",
  list_tools: "工具目录需要桌面环境，容器里不可用",
  remove_tool: "工具目录需要桌面环境，容器里不可用",
  repair_mounts: "技能仓库需要桌面环境，容器里不可用",
  toggle_mount: "技能仓库需要桌面环境，容器里不可用",
  list_conflicts: "技能仓库需要桌面环境，容器里不可用",
  resolve_conflict: "技能仓库需要桌面环境，容器里不可用",
  dismiss_conflict: "技能仓库需要桌面环境，容器里不可用",
  get_conflict_diff: "技能仓库需要桌面环境，容器里不可用",
  list_reports: "报告列表由 /api/status 提供，请用管理 API",
  read_report: "报告由 /api/status 提供，请用管理 API",
  check_update: "更新检查由容器编排管理，不可用",
  download_update: "更新由容器编排管理，不可用",
  install_update: "更新由容器编排管理，不可用",
  get_update_status: "更新状态由容器编排管理，不可用",
  open_release_page: "更新由容器编排管理，不可用",
  open_repo_page: "更新由容器编排管理，不可用",
  open_report: "容器没有桌面环境，无法打开报告",
};

/** 记忆中枢（memory）命令：容器无桌面/图形环境，部分命令显式不可用 */
const MEMORY_DENY = {
  memory_open_dir: "容器没有桌面环境，无法打开目录——请到桌面版「记忆中枢 · 设置」查看库目录",
  memory_root_set: "容器里不能改库目录（绝对路径只在容器内有效）——请在桌面版设置后同步",
  memory_agent_inject: "Agent 注入需要写桌面客户端配置（Claude Code/Cursor 等），容器里不可用",
  memory_agent_uninject: "Agent 注入需要写桌面客户端配置，容器里不可用",
  memory_agent_verify: "Agent 连通性验证需要调用桌面客户端，容器里不可用",
  memory_agent_verify_all: "Agent 连通性验证需要调用桌面客户端，容器里不可用",
  memory_agent_custom_save: "自定义 Agent 需要写桌面客户端配置，容器里不可用",
  memory_bridge_restart: "MCP 桥接重启需要宿主进程管理，容器里不可用——请用 docker restart",
  memory_import_apply: "导入需要执行文件系统操作，容器里不支持——请在桌面版导入",
  memory_import_cancel: "导入需要执行文件系统操作，容器里不支持——请在桌面版操作",
  memory_import_cursors_reset: "导入需要执行文件系统操作，容器里不支持——请在桌面版操作",
  memory_import_map_save: "导入需要执行文件系统操作，容器里不支持——请在桌面版操作",
  memory_import_source_detect: "导入需要扫描本地文件系统，容器里不支持——请在桌面版操作",
  memory_import_source_save: "导入需要扫描本地文件系统，容器里不支持——请在桌面版操作",
  memory_index_build: "索引重建是重资源操作，容器里不开放——请在桌面版低峰执行",
  memory_index_rebuild: "索引重建是重资源操作，容器里不开放——请在桌面版低峰执行",
  memory_index_diagnose: "索引诊断需要扫描本地库，容器里不开放——请在桌面版执行",
  memory_index_vacuum: "索引压缩需要停库，容器里不开放——请在桌面版低峰执行",
  memory_distill_run: "蒸馏需要调用 LLM，容器里不支持——请在桌面版执行",
  memory_auto_task_run: "自动化任务需要调用 LLM，容器里不支持——请在桌面版执行",
  memory_auto_pause: "自动化任务需要调用 LLM，容器里不支持——请在桌面版操作",
  memory_auto_cancel: "自动化任务需要调用 LLM，容器里不支持——请在桌面版操作",
  memory_dedup_scan: "去重扫描需要调用 LLM，容器里不支持——请在桌面版执行",
  memory_dedup_pairs_clear: "去重清理需要删除数据，容器里不开放——请在桌面版操作",
  memory_dedup_review_resolve: "去重审核需要调用 LLM，容器里不支持——请在桌面版操作",
  memory_dedup_layer_toggle: "去重层开关需要改配置，容器里不开放——请在桌面版操作",
  memory_profile_generate: "画像生成需要调用 LLM，容器里不支持——请在桌面版执行",
  memory_llm_test_call: "LLM 测试调用需要真实模型，容器里不支持——请在桌面版测试",
  memory_model_save: "模型配置需要写库，容器里不开放——请在桌面版操作",
  memory_model_delete: "模型配置需要写库，容器里不开放——请在桌面版操作",
  memory_model_toggle: "模型配置需要写库，容器里不开放——请在桌面版操作",
  memory_model_batch: "模型配置需要写库，容器里不开放——请在桌面版操作",
  memory_provider_save: "Provider 配置需要写库，容器里不开放——请在桌面版操作",
  memory_provider_delete: "Provider 配置需要写库，容器里不开放——请在桌面版操作",
  memory_provider_toggle: "Provider 配置需要写库，容器里不开放——请在桌面版操作",
  memory_config_save: "配置保存需要写库，容器里不开放——请在桌面版操作",
  memory_config_reset: "配置重置需要写库，容器里不开放——请在桌面版操作",
  memory_config_import: "配置导入需要写库，容器里不开放——请在桌面版操作",
  memory_toggle: "板块启停需要宿主进程管理，容器里不可用——请用 docker restart",
  memory_sync_run: "同步需要访问 WebDAV，容器里不支持——请在桌面版执行",
  memory_sync_cancel: "同步需要访问 WebDAV，容器里不支持——请在桌面版操作",
  memory_export_zip: "导出需要写本地文件，容器里不支持——请在桌面版导出",
  memory_trash_purge: "清空回收站会永久删除，容器里不开放——请在桌面版操作",
  memory_trash_restore: "恢复需要写本地文件，容器里不支持——请在桌面版操作",
  memory_supersede: "标记失效需要写库，容器里不开放——请在桌面版操作",
  memory_unsupersede: "取消失效需要写库，容器里不开放——请在桌面版操作",
  memory_pin: "置顶需要写库，容器里不开放——请在桌面版操作",
  memory_star: "收藏需要写库，容器里不开放——请在桌面版操作",
  memory_write: "写入记忆需要写库，容器里不开放——请在桌面版操作",
  memory_update: "更新记忆需要写库，容器里不开放——请在桌面版操作",
  memory_delete: "删除记忆需要写库，容器里不开放——请在桌面版操作",
  memory_project_merge: "项目合并需要写库，容器里不开放——请在桌面版操作",
  memory_project_rename: "项目重命名需要写库，容器里不开放——请在桌面版操作",
  memory_project_assign: "项目分配需要写库，容器里不开放——请在桌面版操作",
  memory_project_attach: "项目挂载需要写库，容器里不开放——请在桌面版操作",
  memory_project_confirm: "项目确认需要写库，容器里不开放——请在桌面版操作",
  memory_project_suggest: "项目建议需要调用 LLM，容器里不支持——请在桌面版操作",
  memory_project_organize: "项目整理需要调用 LLM，容器里不支持——请在桌面版操作",
};

function modeOf(cmd) {
  if (DENY[cmd] || LOCALGW_DENY[cmd] || PROMPTS_DENY[cmd] || PET_DENY[cmd] || MEMORY_DENY[cmd] ||
      FRAMEWORK_DENY[cmd] || WEBDAV_DENY[cmd] || SKILLS_DENY[cmd]) return "deny";
  return (READ.has(cmd) || LOCALGW_READ.has(cmd) || PROMPTS_READ.has(cmd) || MEMORY_READ.has(cmd)) ? "read" : "write";
}

/** 全量命令表（四模块合并）。register 首行有配置相关的幂等副作用，要求配置已可读（boot 后调用）。 */
function collectCommands() {
  const commands = new Map();
  proxyIndex.register({ handle: (cmd, fn) => commands.set(cmd, fn) });
  localgwIndex.register({ handle: (cmd, fn) => commands.set(cmd, fn) });
  promptsIndex.register({ ipcMain: { handle: (cmd, fn) => commands.set(cmd, fn) }, shell: null });
  memoryIndex.register({ handle: (cmd, fn) => commands.set(cmd, fn) });
  return commands;
}

module.exports = { collectCommands, modeOf, DENY: Object.assign({}, DENY, LOCALGW_DENY, PROMPTS_DENY, PET_DENY, MEMORY_DENY, FRAMEWORK_DENY, WEBDAV_DENY, SKILLS_DENY), READ, LOCALGW_READ, PROMPTS_READ, MEMORY_READ };
