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
// 本地网关 · 配置层：默认值 + 读取 + 深合并补丁
// 配置落在 framework config.json 的 localgw 段（与 prompts / proxy 同源），
// 权威默认值以本文件 LOCALGW_DEFAULTS 为准；前端 types 里的 LOCALGW_CONFIG_DEFAULTS
// 只是"后端字段缺失时的渲染基线"，两边字段名必须一一对应。
"use strict";
const config = require("../config.cjs");

/** 本地网关模块配置默认值（方案 §7 清单，字段顺序与前端 types 保持一致） */
const LOCALGW_DEFAULTS = {
  // enabled 写死 true：本模块不可禁用（方案决策 5）—— 它是对外 API 的唯一入口，
  // 隐藏或停用入口会让用户找不到"为什么我的 IDE 连不上"
  // 【与 framework config.cjs 的分工，避免误读】：
  //  · framework 的 modules.localgw.enabled（backend/config.cjs 的 moduleOrder 白名单）决定
  //    main.cjs 是否调用本模块的 boot()（即"要不要起 HTTP 服务"）；
  //  · 本字段 localgw.enabled 只是本模块配置段的形状占位，normalize() 恒置 true。
  //  两者语义不同、互不覆盖：前端启停列表不含 localgw，所以只有手改 config.json 的用户
  //  才会碰到 modules.localgw.enabled=false 这条路径。
  enabled: true,
  autostart: false,
  bind: "127.0.0.1",
  port: 9527,
  portCandidates: [9527, 9528, 9529, 9530],
  corsOrigins: ["http://localhost:5174", "tauri://localhost"],
  bodyLimitMb: 4,
  requestTimeoutMs: 120000,
  security: {
    /** 内部签名密钥：留空 = 首次启动生成并落盘（加密存） */
    secret: "",
    adminToken: "",
    readonlyToken: "",
    /** API Key 只存 HMAC + 前缀，永不落明文（方案决策 3） */
    encryptKeysAtRest: true,
  },
  routing: {
    strategy: "score",
    fixedChannel: "",
    failover: true,
    cooldownMs: 120000,
    cooldownCapMs: 900000,
    maxRetriesPerRequest: 3,
    preferChannels: [],
    blockedChannels: [],
    /** 渠道启闭表 { channelId: boolean }：由 routing.setChannelEnabled 写入。
     *  注意它不在前端 types 的 LocalgwConfig.routing 里（前端只读 route_get 的 perChannel 视图），
     *  这里登记为默认值是为了 normalize 时不丢字段、且首次写入前形状稳定。 */
    perChannelEnabled: {},
  },
  models: {
    overrides: {},
    aliases: {},
    custom: {},
    exposeInV1Models: true,
    modelDefaultChannel: "",
  },
  rateLimitPerMin: 300,
  concurrency: 16,
  queueTimeoutMs: 10000,
  apiKeyRatePerMin: 120,
  chatToMemoryEnabled: false,
  injectPrompt: false,
  injectPromptName: "",
  providers: {
    enabled: false,
    dir: "",
    allowlist: [],
  },
  fingerprintObfuscation: true,
  humanizeJitter: true,
  usageRetentionDays: 90,
  logRetentionDays: 30,
};

/** 数值钳制：后端返回的配置可能被手改坏（负数端口、超大并发），落用前统一收敛 */
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 纯对象判定：配置里的 overrides / aliases / custom 一旦被手改成数组或字符串，
 *  后续 Object.entries / 下标访问会给出诡异结果，统一在入口挡住 */
function plainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 监听地址白名单：只接受回环 / 通配 / 合法 IPv4 / IPv6 字面量 / localhost。
 *  为什么收这么紧：bind 直接进 http.listen()，写错（URL、域名、带空格）只会在 start() 时抛
 *  ENOTFOUND/EADDRNOTAVAIL，用户看到的是"启动失败"而不是"地址不合法"。
 *  返回 { ok, bind, warn }：0.0.0.0 / :: 合法但会把服务暴露到局域网，warn 供 UI 红字提示。 */
function normalizeBind(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return { ok: true, bind: LOCALGW_DEFAULTS.bind, warn: "" };
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split(".").every((n) => Number(n) <= 255);
  const v6 = /^[0-9a-f:]*:[0-9a-f:]*$/i.test(s) && s.includes(":");
  if (s === "localhost" || v4 || v6) {
    const loopback = s === "localhost" || s.startsWith("127.") || s === "::1";
    return { ok: true, bind: s, warn: loopback ? "" : "监听地址已超出回环，局域网/公网可直接访问本网关" };
  }
  return { ok: false, bind: LOCALGW_DEFAULTS.bind, warn: "监听地址不合法，已回退 127.0.0.1" };
}

/** 深合并：以默认值为骨架补全缺失字段；数组与原始值整体取 incoming（有则覆盖）。
 *  与 store 侧的 mergeConfigDeep 同语义，保证"后端补字段 / 前端渲染"两侧看到的形状一致。 */
function mergeDeep(base, incoming) {
  if (Array.isArray(base) || Array.isArray(incoming)) {
    return incoming === undefined ? base : incoming;
  }
  if (base && typeof base === "object" && incoming && typeof incoming === "object") {
    const out = { ...base };
    for (const k of Object.keys(incoming)) out[k] = mergeDeep(base[k], incoming[k]);
    return out;
  }
  return incoming === undefined ? base : incoming;
}

/** 归一化：字段级钳制 + 类型纠偏，防止手改 config.json 造成运行时炸裂 */
function normalize(raw) {
  const m = mergeDeep(LOCALGW_DEFAULTS, raw || {});
  m.enabled = true; // 决策 5：不可禁用的唯一落点
  m.bind = normalizeBind(m.bind).bind;
  m.port = clampInt(m.port, LOCALGW_DEFAULTS.port, 1024, 65535);
  m.portCandidates = Array.isArray(m.portCandidates)
    ? m.portCandidates.map((p) => clampInt(p, 9527, 1024, 65535)).filter((p, i, a) => a.indexOf(p) === i)
    : LOCALGW_DEFAULTS.portCandidates.slice();
  if (!m.portCandidates.includes(m.port)) m.portCandidates.unshift(m.port);
  m.corsOrigins = Array.isArray(m.corsOrigins) ? m.corsOrigins.filter((s) => typeof s === "string") : [];
  m.bodyLimitMb = clampInt(m.bodyLimitMb, 4, 1, 64);
  m.requestTimeoutMs = clampInt(m.requestTimeoutMs, 120000, 5000, 1800000);
  // 布尔字段一律显式纠偏：手改 config.json 写成字符串 "false" 会被真值判断当成 true
  m.autostart = m.autostart === true;
  m.fingerprintObfuscation = m.fingerprintObfuscation !== false;
  m.humanizeJitter = m.humanizeJitter !== false;
  m.chatToMemoryEnabled = m.chatToMemoryEnabled === true;
  m.injectPrompt = m.injectPrompt === true;
  m.injectPromptName = typeof m.injectPromptName === "string" ? m.injectPromptName : "";

  m.security = mergeDeep(LOCALGW_DEFAULTS.security, m.security || {});
  m.security.encryptKeysAtRest = true; // 不允许被关：明文落库没有任何合理场景
  m.security.secret = typeof m.security.secret === "string" ? m.security.secret : "";
  m.security.adminToken = typeof m.security.adminToken === "string" ? m.security.adminToken : "";
  m.security.readonlyToken = typeof m.security.readonlyToken === "string" ? m.security.readonlyToken : "";

  m.routing = mergeDeep(LOCALGW_DEFAULTS.routing, m.routing || {});
  const STRATEGIES = ["smart", "fixed", "round-robin", "score"];
  if (!STRATEGIES.includes(m.routing.strategy)) m.routing.strategy = "score";
  m.routing.fixedChannel = typeof m.routing.fixedChannel === "string" ? m.routing.fixedChannel : "";
  m.routing.failover = m.routing.failover !== false;
  m.routing.cooldownMs = clampInt(m.routing.cooldownMs, 120000, 10000, 3600000);
  m.routing.cooldownCapMs = clampInt(m.routing.cooldownCapMs, 900000, 60000, 7200000);
  m.routing.maxRetriesPerRequest = clampInt(m.routing.maxRetriesPerRequest, 3, 1, 10);
  m.routing.preferChannels = Array.isArray(m.routing.preferChannels) ? m.routing.preferChannels.filter((s) => typeof s === "string") : [];
  m.routing.blockedChannels = Array.isArray(m.routing.blockedChannels) ? m.routing.blockedChannels.filter((s) => typeof s === "string") : [];
  m.routing.perChannelEnabled = plainObject(m.routing.perChannelEnabled) ? m.routing.perChannelEnabled : {};

  m.models = mergeDeep(LOCALGW_DEFAULTS.models, m.models || {});
  m.models.exposeInV1Models = m.models.exposeInV1Models !== false;
  m.models.modelDefaultChannel = typeof m.models.modelDefaultChannel === "string" ? m.models.modelDefaultChannel : "";
  // overrides / custom：值必须是 { real_model, channel } 形状的对象；aliases：值必须是字符串
  m.models.overrides = plainObject(m.models.overrides) ? m.models.overrides : {};
  m.models.custom = plainObject(m.models.custom) ? m.models.custom : {};
  m.models.aliases = plainObject(m.models.aliases) ? m.models.aliases : {};

  m.rateLimitPerMin = clampInt(m.rateLimitPerMin, 300, 1, 100000);
  // 并发上限刻意压在 64：网关与号池共用一个 event loop，压测上限给到 16 是建议值
  m.concurrency = clampInt(m.concurrency, 16, 1, 64);
  m.queueTimeoutMs = clampInt(m.queueTimeoutMs, 10000, 1000, 300000);
  m.apiKeyRatePerMin = clampInt(m.apiKeyRatePerMin, 120, 1, 100000);
  m.usageRetentionDays = clampInt(m.usageRetentionDays, 90, 1, 3650);
  m.logRetentionDays = clampInt(m.logRetentionDays, 30, 1, 3650);

  m.providers = mergeDeep(LOCALGW_DEFAULTS.providers, m.providers || {});
  m.providers.allowlist = Array.isArray(m.providers.allowlist) ? m.providers.allowlist : [];
  return m;
}

/** 读当前配置（每次都从 framework config.json 取，保证用户在设置里改完立即生效） */
function get() {
  try {
    const c = config.loadConfig();
    return normalize(c && c.localgw);
  } catch {
    // 配置文件损坏/不可读时也必须给出可用默认值：否则每个请求都会在 get() 上炸
    return normalize({});
  }
}

/** 深合并补丁写回：只写 localgw 段，不动其它模块的配置。
 *  越界入参在这里**显式拒绝**（而不是静默钳制），否则用户改了个非法端口却看到"保存成功"。
 *  返回 { ok, config } 或 { ok:false, message }。 */
function patch(p) {
  const incoming = { ...(p || {}) };
  if (incoming.bind !== undefined) {
    const nb = normalizeBind(incoming.bind);
    if (!nb.ok) return { ok: false, message: "监听地址不合法（只支持 127.0.0.1 / localhost / 合法 IPv4 / IPv6）" };
    incoming.bind = nb.bind;
  }
  if (incoming.port !== undefined) {
    const port = Number(incoming.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, message: "端口必须是 1024~65535 的整数" };
    }
    incoming.port = port;
  }
  if (incoming.routing && incoming.routing.strategy !== undefined) {
    const STRATEGIES = ["smart", "fixed", "round-robin", "score"];
    if (!STRATEGIES.includes(incoming.routing.strategy)) {
      return { ok: false, message: "路由策略只支持 smart / fixed / round-robin / score" };
    }
  }
  const c = config.loadConfig();
  // 读不到完整配置时宁可失败也不写：写一个只有 localgw 段的 config.json 会把其它模块配置整份抹掉
  if (!c || typeof c !== "object") {
    return { ok: false, message: "配置读取失败，已放弃写入以免覆盖其它模块配置" };
  }
  c.localgw = normalize(mergeDeep(c.localgw, incoming));
  try {
    config.saveConfig(c);
  } catch (e) {
    return { ok: false, message: `配置写入失败：${String((e && e.message) || e)}` };
  }
  return { ok: true, config: c.localgw };
}

/** 密文信封 → 明文；解不开时退回密文串本身。
 *  为什么要有这一层：DPAPI 密文（enc:v1:）换机器/换用户后解不开，若此时返回空串，
 *  同一批 API Key 会集体失配（表现为"所有 key 突然无效"）。退回密文串至少保证本机稳定。 */
function revealSecret(stored) {
  const s = String(stored || "");
  if (!s) return "";
  try {
    const dec = typeof config.decryptSecret === "function" ? config.decryptSecret(s) : s;
    return dec || s;
  } catch {
    return s;
  }
}

/** 内部签名密钥：空值时生成 32 字节随机串，落盘前走框架的加密链路（只生成一次）。
 *  返回**明文**密钥（调用方用于 HMAC；config.json 里只留密文信封）。 */
function ensureSecret() {
  const cur = get();
  const stored = (cur.security && cur.security.secret) || "";
  if (stored) return revealSecret(stored);
  const secret = require("node:crypto").randomBytes(32).toString("hex");
  let enc = secret;
  try {
    if (typeof config.encryptSecret === "function") enc = config.encryptSecret(secret) || secret;
  } catch { enc = secret; }
  patch({ security: { ...cur.security, secret: enc } });
  return secret;
}

module.exports = { LOCALGW_DEFAULTS, get, patch, normalize, mergeDeep, ensureSecret, revealSecret, normalizeBind };
