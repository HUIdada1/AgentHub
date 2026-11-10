/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Qoder / 千问办公 **站点表**（唯一事实源）
//
// 依据：Agent2Providers `crates/providers/src/providers/qoder/endpoints.rs`（Site enum）。
// 那家把这四个站点写成枚举方法，本仓库照抄成数据表——**别再在别处写字面量域名**。
//
// ── 为什么千问办公与 Qoder 共用一个协议栈 ─────────────────────────
// 同一套 COSY 信封（`Bearer COSY.<payload>.<sig>`）、同一个聊天路径
// （`/algo/api/v2/service/pro/sse/agent_chat_generation`）、同一把服务端 RSA 公钥、
// 同一个 `client_id`（国内版与 Qoder CN 逐字相同）。差异只有一批**客户端身份常量**
// 与账号接口路径 —— 所以实现只有一份、按站点取值，而不是复制一份。
//
// ── 哪些是实测、哪些是推断（红线：不许把推断写成实测）────────────
// 实测（endpoints.rs 逐条注明来源）：
//   · 主机（web/openapi/gateway）、device 授权页与轮询路径；
//   · 千问办公的 cosyVersion 1.1.52 / clientType 6 / data_policy agree /
//     scene qwork / business product qoder_work / session_type qoder_work /
//     UA qoderwork/1.1.0 / 账号上下文与钱包路径 / 目录场景 qwork；
//   · 千问办公**没有** /jobToken/exchange（设备令牌即对话令牌，refresh_target="c"）。
// 推断（endpoints.rs 自己标注为推断，本项目沿用同一口径）：
//   · 国际版（gateway.qwenwork.ai）除主机 / client_id / redirect_uri 三条外，
//     其余常量按「同一产品的另一个部署」沿用国内版。国际版若对话失败，先怀疑这里。
//
// ── 登录形态 ──────────────────────────────────────────────────
// 四个站点都走**设备授权**（浏览器打开 `{web}/device/selectAccounts`，本机轮询
// `/api/v1/deviceToken/poll`）。`nonce` 必须是**标准 UUID（带横线）**——去掉横线
// 上游会把整条 query 判成非法（400 INVALID_DEVICE_FLOW）。
// 千问办公额外需要 `client_id` 与 `redirect_uri`（Qoder 两站历史上不带）。
"use strict";

/** 千问办公的静态兜底清单（Agent2Providers `qwenwork_fallback_models`，2026-10-31 复核）。
 *  上游目录当时只有这三个；远程目录拿得到时以远程为准。
 *  `id` = 上游 key（请求体 model_config.key 用它），`name` = 展示名。 */
const QWENWORK_FALLBACK_MODELS = [
  { id: "pro", name: "高级", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 131072, maxOutputTokens: 32768 },
  { id: "flash", name: "标准", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 131072, maxOutputTokens: 32768 },
  { id: "qwen3.8-max-preview", name: "Qwen3.8-Max", rate: null, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 131072, maxOutputTokens: 32768 },
];

/** 站点表。键 = 渠道 id（落盘契约，只增不改）。 */
const SITES = {
  // ===== Qoder 中国版 =====
  qoder: {
    id: "qoder", product: "Qoder", label: "中国版", isQwenwork: false,
    webOrigin: "https://qoder.com.cn",
    openApi: "https://openapi.qoder.com.cn",
    gateway: "https://gateway.qoder.com.cn/",
    // 登录页走门户的 sign-in（用 oauth_callback 携带 selectAccounts 地址）
    authBase: "https://qoder.cn",
    authBizVariant: "qoder",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    deviceClientId: "",           // 空 = 不额外发 client_id（历史上不带也能登录）
    deviceRedirect: "",           // 空 = 不发 redirect_uri
    // 客户端身份常量（COSY 头 + 请求体必须一致）
    cosyVersion: "1.1.38",
    cosyClientType: "5",
    cosyDataPolicy: "disagree",
    cosyScene: "",                // 空 = 不发该头
    cosyBusinessProduct: "",
    cosyBusinessType: "",
    sessionType: "qodercli",
    businessProduct: "cli",
    businessVersion: "1.0.0",
    userAgent: "",
    // 账号接口
    userInfoPath: "/api/v1/userinfo",
    usagePath: "",                // 空 = 走 Qoder 的 /api/v2/quota/usage
    walletsPath: "",
    refreshTarget: "",            // 空 = 只发 refresh_token
    // 能力位
    deviceOnly: false,
    supportsPat: true,
    supportsCheckin: true,
    modelScene: "",               // 空 = Qoder 的 app+chat 合并规则
    listAllModels: false,
    maxInputTokens: 0,
    fallbackModels: [],
    // 本机客户端（桌面端导入 / 风控身份 / wasm 签名器提取）
    appDir: "com.qodercn.app.stable",
    homeDir: ".qoder-cn",
    // 签名器从哪家已安装客户端提取 wasm：千问办公没有独立客户端时复用 Qoder 的
    signerProduct: "qoder",
  },
  // ===== Qoder 国际版 =====
  qoder_intl: {
    id: "qoder_intl", product: "Qoder", label: "国际版", isQwenwork: false,
    webOrigin: "https://qoder.com",
    openApi: "https://openapi.qoder.sh",
    // ⚠ 与 endpoints.rs 的 gateway（api3）不同：本仓库既有实现一直用 api2 且已跑通，
    //   按「不动已发布的可用链路」保留 api2。改这里之前先实测 api3 是否也通。
    gateway: "https://api2.qoder.sh/",
    authBase: "https://qoder.com",
    authBizVariant: "qoder",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    deviceClientId: "",
    deviceRedirect: "",
    cosyVersion: "1.1.38",
    cosyClientType: "5",
    cosyDataPolicy: "disagree",
    cosyScene: "",
    cosyBusinessProduct: "",
    cosyBusinessType: "",
    sessionType: "qodercli",
    businessProduct: "cli",
    businessVersion: "1.0.0",
    userAgent: "",
    userInfoPath: "/api/v1/userinfo",
    usagePath: "",
    walletsPath: "",
    refreshTarget: "",
    deviceOnly: false,
    supportsPat: true,
    supportsCheckin: true,
    modelScene: "",
    listAllModels: false,
    maxInputTokens: 0,
    fallbackModels: [],
    appDir: "com.qoder.app.stable",
    homeDir: ".qoder",
    signerProduct: "qoder_intl",
  },
  // ===== 千问办公 国内版 =====
  qwen_office: {
    id: "qwen_office", product: "千问办公", label: "国内版", isQwenwork: true,
    webOrigin: "https://gateway.qwenwork.cn",
    openApi: "https://gateway.qwenwork.cn",
    gateway: "https://gateway.qwenwork.cn/",
    // 千问办公的登录页直接在 gateway 上（它会 302 到 qwenwork.cn 的标准 OAuth 页）
    authBase: "https://gateway.qwenwork.cn",
    authBizVariant: "",
    // 桌面客户端的；与 Qoder CN 的 CLI 生产 client_id 逐字相同
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    deviceClientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    deviceRedirect: "qwenwork-cn://",
    cosyVersion: "1.1.52",
    cosyClientType: "6",
    cosyDataPolicy: "agree",
    cosyScene: "qwork",
    cosyBusinessProduct: "qoder_work",
    cosyBusinessType: "agent",
    sessionType: "qoder_work",
    businessProduct: "qoder_work",
    businessVersion: "1.1.52",
    userAgent: "qoderwork/1.1.0",
    // 账号上下文（用户资料 + 计划 + 额度都在这一份里）
    userInfoPath: "/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    usagePath: "/api/v1/adapter/user/account-context?include=user,plan,quota",
    // 三档积分池（每日 / 每月 / 长期）——**只有国内版公有云个人账号有**
    walletsPath: "/api/v1/adapter/user/wallets",
    refreshTarget: "c",
    deviceOnly: true,
    supportsPat: false,
    supportsCheckin: false,
    modelScene: "qwork",
    listAllModels: true,
    maxInputTokens: 1024000,
    fallbackModels: QWENWORK_FALLBACK_MODELS,
    // 千问办公桌面端的安装目录名未取证 → 不做本机导入（走设备授权）
    appDir: "",
    homeDir: "",
    signerProduct: "qoder",
  },
  // ===== 千问办公 国际版 =====
  qwen_office_intl: {
    id: "qwen_office_intl", product: "千问办公", label: "国际版", isQwenwork: true,
    webOrigin: "https://gateway.qwenwork.ai",
    openApi: "https://gateway.qwenwork.ai",
    gateway: "https://gateway.qwenwork.ai/",
    authBase: "https://gateway.qwenwork.ai",
    authBizVariant: "",
    // 国际版桌面客户端的（EchoBird Edition::QwenWork）
    clientId: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    deviceClientId: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    deviceRedirect: "qwenwork://",
    // 依据 Agent2Providers qoder/endpoints.rs（模块头 + device_client_id）：
    // **国际版与国内版只差主机 / client_id / redirect_uri 三条**，其余客户端常量
    // 沿用国内版是参考实现的既有口径，不是本仓的猜测。
    cosyVersion: "1.1.52",
    cosyClientType: "6",
    cosyDataPolicy: "agree",
    cosyScene: "qwork",
    cosyBusinessProduct: "qoder_work",
    cosyBusinessType: "agent",
    sessionType: "qoder_work",
    businessProduct: "qoder_work",
    businessVersion: "1.1.52",
    userAgent: "qoderwork/1.1.0",
    userInfoPath: "/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    usagePath: "/api/v1/adapter/user/account-context?include=user,plan,quota",
    // 国际版不读钱包（未取证）
    walletsPath: "",
    refreshTarget: "c",
    deviceOnly: true,
    supportsPat: false,
    supportsCheckin: false,
    modelScene: "qwork",
    listAllModels: true,
    maxInputTokens: 1024000,
    fallbackModels: QWENWORK_FALLBACK_MODELS,
    appDir: "",
    homeDir: "",
    signerProduct: "qoder_intl",
  },
};

/** 渠道 id → 站点（未知返回 null；调用方一律走这个，别自己写域名） */
function of(channel) {
  return SITES[channel] || null;
}

/** 该渠道是否走千问办公协议（账号接口/能力位不同） */
function isQwenwork(channel) {
  const s = SITES[channel];
  return !!(s && s.isQwenwork);
}

/** 站点 → 展示名（`Qoder 中国版` / `千问办公 国内版`） */
function displayName(channel) {
  const s = SITES[channel];
  return s ? `${s.product} ${s.label}` : String(channel || "");
}

/** 对话链路实际使用的推理基址（含尾斜杠）。
 *  Qoder 国际版按令牌前缀分流：作业令牌 `jt-` 必须打 api2（打 api3 被判 Login expired）。
 *  其余三站都是一台网关。 */
function inferenceBase(channel, token) {
  const s = SITES[channel];
  if (!s) return "";
  if (channel === "qoder_intl") return String(token || "").startsWith("jt-") ? "https://api2.qoder.sh/" : "https://api3.qoder.sh/";
  return s.gateway;
}

/** 设备授权页地址（人看的那个页面） */
function deviceLoginUrl(channel) {
  const s = SITES[channel];
  if (!s) return "";
  return `${s.webOrigin}/device/selectAccounts`;
}

module.exports = { SITES, QWENWORK_FALLBACK_MODELS, of, isQwenwork, displayName, inferenceBase, deviceLoginUrl };
