/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关：API 门面
// 所有 IPC 封装都集中在 api/ipc.ts 末尾（localgw_* 段），这里只做命名空间收敛，
// 让 localgw 的页面统一写 `import * as localgwApi from "../../api/localgw"`，
// 而不必在 ipc.ts 那一长串导出里翻找。新增通道时两处同步（ipc.ts 加封装、此处 re-export）。
export {
  // 状态 / 控制
  localgwStatus as status,
  localgwStart as start,
  localgwStop as stop,
  localgwSetPort as setPort,
  localgwSetAutostart as setAutostart,
  localgwRestart as restart,
  // 密钥
  localgwKeysList as keysList,
  localgwKeysCreate as keysCreate,
  localgwKeysRevoke as keysRevoke,
  localgwKeysRename as keysRename,
  // 路由 / 渠道
  localgwRouteGet as routeGet,
  localgwRouteSet as routeSet,
  localgwChannelToggle as channelToggle,
  localgwChannelTest as channelTest,
  // 模型目录
  localgwModelsList as modelsList,
  localgwModelsSetOverride as modelsSetOverride,
  localgwModelsSetAlias as modelsSetAlias,
  localgwModelsAddCustom as modelsAddCustom,
  // 删除单条模型规则（overrides / aliases / custom）：config_patch 是加性合并删不掉，
  // 后端为此单开通道，见 models.cjs 的 removeRule
  localgwModelsRemoveRule as modelsRemoveRule,
  // 配置
  localgwConfigGet as configGet,
  localgwConfigPatch as configPatch,
  // 出站伪装与清洗（契约 §4.8）：get 读配置+可选档案+渠道清单，set 深合并补丁，preview 试跑清洗
  localgwOutboundGet as outboundGet,
  localgwOutboundSet as outboundSet,
  localgwOutboundPreview as outboundPreview,
  // 日志 / 监控
  localgwLogsList as logsList,
  localgwLogsExport as logsExport,
  localgwPotStats as potStats,
  // Provider 扩展点（决策 2：本期返回未启用）
  // ⚠️ 用法警示：后端这 4 条通道固定返回 { ok:false, message:"provider 扩展点未启用" }，
  //    而 ipc.ts 的 unwrapResult 会把 ok:false 统一转成 **异常抛出**。
  //    所以 `const r = await providersList(); if (!r.ok) ...` 永远走不到——
  //    必须 try/catch，并把「未启用」当正常提示展示，不能弹错误框。
  //    当前无任何页面调用（保留门面只为与 ipc.ts 通道清单对齐）。
  localgwProvidersList as providersList,
} from "./ipc";

export type {
  LocalgwStatus,
  LocalgwKeyRow,
  LocalgwRoute,
  LocalgwModelRow,
  LocalgwLogRow,
  // 出站伪装与清洗（契约 §4.8 的返回形状）
  LocalgwOutboundGetResult,
  LocalgwOutboundProfileOption,
  LocalgwOutboundChannelRow,
  LocalgwOutboundPreviewResult,
} from "./ipc";

// 出站配置的形状类型（契约 §2）从 types 直出：页面同时要读配置与写补丁，两处形状必须同源
export type {
  LocalgwOutboundConfig,
  LocalgwOutboundPolicy,
  LocalgwOutboundDefaults,
  LocalgwKeywordRule,
  LocalgwRewriteRule,
  LocalgwProfile,
  LocalgwRuleScope,
} from "../types";
