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
  // 出站伪装与清洗（形状见 docs/localgw-outbound-contract.md §2）。
  // 为什么单列一段而不是散在顶层：它按 channelId 索引（每渠道一份策略），
  // 且带三张用户可编辑的表（perChannel / keywords+rewrites / profiles.custom），
  // 散在顶层会让「哪些字段属于出站伪装」在配置里看不出来。
  outbound: {
    /** 全局默认策略：未单独配置的渠道继承它（7 个字段，§2） */
    defaults: {
      mode: "mimic", // mimic=伪装(套官方客户端形态) | passthrough=全透传(头+body 都不动)
      profile: "", // 档案 id；"" = 不额外套档案，仅用渠道 adapter 自带形态
      builtinSanitize: true,
      keywordSanitize: true,
      rewriteSanitize: true,
      headerOverride: true,
      jitter: true,
    },
    /** 按渠道覆盖：{ [channelId]: Partial<Policy> }，缺字段继承 defaults */
    perChannel: {},
    /** 全局共享关键词规则（所有渠道叠加使用） */
    keywords: [],
    /** 全局共享文案替换规则 */
    rewrites: [],
    /** agent 软件模拟档案：内置表在 outbound.cjs 里，这里只存用户自定义 */
    profiles: { custom: {} },
  },
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

// ===== outbound 段纠偏（形状见 docs/localgw-outbound-contract.md §2）=====
// 单独成组而不是塞进 normalize()：这一段有 3 张用户可编辑的表 + 2 张规则表，
// 逐字段纠偏写进主流程会把「监听/路由/模型」那些更常读的字段淹掉。

/** 单表规则条数上限（§4.5）：防手改配置把出站热路径撑爆 */
const OUTBOUND_MAX_RULES = 200;
/** scope 白名单（§2） */
const OUTBOUND_SCOPES = ["all", "system", "user", "assistant", "tool"];
/** 正则 flags 允许的字符集（§2） */
const OUTBOUND_FLAG_CHARS = "gimsuy";
/** 渠道级策略里的布尔字段（§4.5：显式 !== false 纠偏，与 fingerprintObfuscation 同款写法）。
 *  契约 §4.5 写的是「6 个布尔字段」，按 §2 的 Policy 表实际是 5 个（下表）+ 规则条目的
 *  enabled（在 normalizeKeywordRule / normalizeRewriteRule 里纠偏），合起来 6 处布尔纠偏。 */
const OUTBOUND_BOOL_FIELDS = ["builtinSanitize", "keywordSanitize", "rewriteSanitize", "headerOverride", "jitter"];

/** §4.5.1 硬不变式：normalize 的返回值里绝不允许出现 null。
 *  做法是**按已知形状逐层兜底**，刻意不写通用「递归删 null」——将来某个合法字段真的用
 *  null 表示「未设置」时，通用递归会把它误删。这里只清掉 mergeDeep 从手改 config.json
 *  带进来的顶层 null（已知形状的 null 在各子归一化函数里已被就地消化）。 */
function dropNulls(o) {
  if (!plainObject(o)) return o;
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return o;
}

/** 正则 flags 纠偏：只保留 gimsuy 中出现的字符，空则按契约默认 "g" */
function normalizeOutboundFlags(v) {
  const s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) if (OUTBOUND_FLAG_CHARS.includes(ch) && !out.includes(ch)) out += ch;
  return out || "g";
}

/** 请求头名数组纠偏：转字符串、去空白、丢空串、去重（大小写不敏感） */
function normalizeHeaderNames(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const k of v) {
    if (k === null || k === undefined) continue;
    const key = String(k).trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(key);
  }
  return out;
}

/** 请求头覆盖表纠偏：§4.5.1 规定 headers[key] = null 表示「删除该头覆盖」，
 *  所以 null/undefined 直接不写进结果（而不是留个 null 让下游到处判空）。 */
function normalizeOutboundHeaders(v) {
  if (!plainObject(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const key = String(k).trim();
    if (!key) continue;
    if (val === null || val === undefined) continue;
    if (typeof val === "string") { out[key] = val; continue; }
    // 用户可能填数字/布尔；其余（对象/数组）不是合法头值，丢弃
    if (typeof val === "number" || typeof val === "boolean") { out[key] = String(val); continue; }
  }
  return out;
}

/** 关键词规则纠偏；返回 null = 丢弃该条 */
function normalizeKeywordRule(r, i) {
  if (!plainObject(r)) return null;
  const pattern = typeof r.pattern === "string" ? r.pattern : "";
  if (!pattern) return null; // pattern 非字符串或空 → 丢弃
  const mode = r.mode === "regex" ? "regex" : "literal";
  const flags = normalizeOutboundFlags(r.flags);
  if (mode === "regex") {
    // 坏正则**丢弃该条**而不是让整份配置读失败：一条手改坏的规则不该把网关打死
    try { new RegExp(pattern, flags); } catch { return null; }
  }
  return {
    id: typeof r.id === "string" && r.id ? r.id : `k${i}`,
    label: typeof r.label === "string" ? r.label : "",
    enabled: r.enabled !== false,
    mode,
    pattern,
    flags,
    replace: typeof r.replace === "string" ? r.replace : "",
    scope: OUTBOUND_SCOPES.includes(r.scope) ? r.scope : "all",
  };
}

function normalizeKeywordRules(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length && out.length < OUTBOUND_MAX_RULES; i++) {
    const r = normalizeKeywordRule(v[i], i);
    if (r) out.push(r);
  }
  return out;
}

/** 文案替换规则纠偏；返回 null = 丢弃该条 */
function normalizeRewriteRule(r, i) {
  if (!plainObject(r)) return null;
  const from = typeof r.from === "string" ? r.from : "";
  if (!from) return null; // from 非字符串或空 → 丢弃
  return {
    id: typeof r.id === "string" && r.id ? r.id : `r${i}`,
    label: typeof r.label === "string" ? r.label : "",
    enabled: r.enabled !== false,
    from,
    to: typeof r.to === "string" ? r.to : "",
    scope: OUTBOUND_SCOPES.includes(r.scope) ? r.scope : "all",
  };
}

function normalizeRewriteRules(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length && out.length < OUTBOUND_MAX_RULES; i++) {
    const r = normalizeRewriteRule(v[i], i);
    if (r) out.push(r);
  }
  return out;
}

/** 渠道级策略补丁（perChannel[cid]）：**按已知字段重建**，未知键一并丢弃。
 *  这样既满足 §4.5「perChannel 必须是纯对象」，也让 §4.5.1 的「结果里无 null」自动成立。 */
function normalizePolicyPatch(v) {
  const o = {};
  if (v.mode !== undefined) o.mode = v.mode === "passthrough" ? "passthrough" : "mimic";
  if (v.profile !== undefined) o.profile = typeof v.profile === "string" ? v.profile : "";
  for (const b of OUTBOUND_BOOL_FIELDS) if (v[b] !== undefined) o[b] = v[b] !== false;
  if (v.headers !== undefined) o.headers = normalizeOutboundHeaders(v.headers);
  if (v.removeHeaders !== undefined) o.removeHeaders = normalizeHeaderNames(v.removeHeaders);
  if (v.keywords !== undefined) o.keywords = normalizeKeywordRules(v.keywords);
  if (v.rewrites !== undefined) o.rewrites = normalizeRewriteRules(v.rewrites);
  return o;
}

/** perChannel：null = 删除该渠道策略，回到继承 defaults（§4.5.1） */
function normalizePerChannel(v) {
  if (!plainObject(v)) return {};
  const out = {};
  for (const [cid, patch] of Object.entries(v)) {
    const id = String(cid).trim();
    if (!id) continue;
    if (patch === null || patch === undefined) continue; // §4.5.1：删除该渠道策略
    if (!plainObject(patch)) continue; // 手改成字符串/数组 → 丢弃，回落继承
    out[id] = normalizePolicyPatch(patch);
  }
  return out;
}

/** 自定义档案：null = 删除该档案（§4.5.1） */
function normalizeCustomProfiles(v) {
  if (!plainObject(v)) return {};
  const out = {};
  for (const [id, p] of Object.entries(v)) {
    const key = String(id).trim();
    if (!key) continue;
    if (p === null || p === undefined) continue; // §4.5.1：删除该自定义档案
    if (!plainObject(p)) continue;
    out[key] = {
      label: typeof p.label === "string" ? p.label : key,
      userAgent: typeof p.userAgent === "string" ? p.userAgent : "",
      headers: normalizeOutboundHeaders(p.headers),
      removeHeaders: normalizeHeaderNames(p.removeHeaders),
      note: typeof p.note === "string" ? p.note : "",
    };
  }
  return out;
}

/** outbound 段归一化总入口。§4.5.1 的 null 清理必须在 mergeDeep **之后**执行。 */
function normalizeOutbound(raw) {
  const out = mergeDeep(LOCALGW_DEFAULTS.outbound, plainObject(raw) ? raw : {});

  const d = plainObject(out.defaults) ? out.defaults : { ...LOCALGW_DEFAULTS.outbound.defaults };
  d.mode = d.mode === "passthrough" ? "passthrough" : "mimic";
  d.profile = typeof d.profile === "string" ? d.profile : "";
  // 布尔字段一律显式纠偏：手改 config.json 写成字符串 "false" 会被真值判断当成 true
  d.builtinSanitize = d.builtinSanitize !== false;
  d.keywordSanitize = d.keywordSanitize !== false;
  d.rewriteSanitize = d.rewriteSanitize !== false;
  d.headerOverride = d.headerOverride !== false;
  d.jitter = d.jitter !== false;
  // defaults 理论上不含 headers/removeHeaders/keywords/rewrites（§2 的 7 字段形状），
  // 但手写配置可能加，归一化一遍免得它们带着 null/非法值进 policyFor
  if (d.headers !== undefined) d.headers = normalizeOutboundHeaders(d.headers);
  if (d.removeHeaders !== undefined) d.removeHeaders = normalizeHeaderNames(d.removeHeaders);
  if (d.keywords !== undefined) d.keywords = normalizeKeywordRules(d.keywords);
  if (d.rewrites !== undefined) d.rewrites = normalizeRewriteRules(d.rewrites);
  out.defaults = dropNulls(d);

  out.perChannel = normalizePerChannel(out.perChannel);
  out.keywords = normalizeKeywordRules(out.keywords);
  out.rewrites = normalizeRewriteRules(out.rewrites);

  const prof = plainObject(out.profiles) ? out.profiles : { ...LOCALGW_DEFAULTS.outbound.profiles };
  prof.custom = normalizeCustomProfiles(prof.custom);
  out.profiles = dropNulls(prof);

  return dropNulls(out);
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
  // 出站伪装与清洗（§4.5）：在 mergeDeep 之后做 null 清理，满足 §4.5.1 的「结果里无 null」不变式
  m.outbound = normalizeOutbound(m.outbound);
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

/** outbound 补丁的越界校验：返回空串 = 通过，否则返回给渲染层的错误文案。
 *  为什么显式拒绝而不是交给 normalize 静默纠偏：用户点了「保存」却什么都没变，
 *  比报错更难查（§4.8 明确要求越界/类型错误回 { ok:false, message }）。
 *  规则**内容**（pattern/正则/scope）刻意不在这里校验——那些按 §4.5 由 normalize 丢弃坏条目，
 *  一条写坏的规则不该让整次保存失败。 */
function validateOutboundPatch(v) {
  if (!plainObject(v)) return "出站配置必须是对象";
  const d = v.defaults;
  if (d !== undefined) {
    if (!plainObject(d)) return "outbound.defaults 必须是对象";
    if (d.mode !== undefined && d.mode !== "mimic" && d.mode !== "passthrough") return "出站模式只支持 mimic / passthrough";
    if (d.profile !== undefined && typeof d.profile !== "string") return "outbound.defaults.profile 必须是字符串";
    for (const b of OUTBOUND_BOOL_FIELDS) {
      if (d[b] !== undefined && typeof d[b] !== "boolean") return `outbound.defaults.${b} 必须是布尔值`;
    }
  }
  if (v.perChannel !== undefined) {
    if (!plainObject(v.perChannel)) return "outbound.perChannel 必须是对象";
    for (const [cid, patch] of Object.entries(v.perChannel)) {
      if (patch === null) continue; // null = 删除该渠道策略（§4.5.1），是合法入参
      if (!plainObject(patch)) return `outbound.perChannel.${cid} 必须是对象或 null`;
      if (patch.mode !== undefined && patch.mode !== "mimic" && patch.mode !== "passthrough") {
        return `outbound.perChannel.${cid}.mode 只支持 mimic / passthrough`;
      }
      if (patch.profile !== undefined && typeof patch.profile !== "string") return `outbound.perChannel.${cid}.profile 必须是字符串`;
      for (const b of OUTBOUND_BOOL_FIELDS) {
        if (patch[b] !== undefined && typeof patch[b] !== "boolean") return `outbound.perChannel.${cid}.${b} 必须是布尔值`;
      }
      for (const arr of ["removeHeaders", "keywords", "rewrites"]) {
        if (patch[arr] !== undefined && !Array.isArray(patch[arr])) return `outbound.perChannel.${cid}.${arr} 必须是数组`;
      }
      if (patch.headers !== undefined && !plainObject(patch.headers)) return `outbound.perChannel.${cid}.headers 必须是对象`;
    }
  }
  for (const arr of ["keywords", "rewrites"]) {
    if (v[arr] !== undefined && !Array.isArray(v[arr])) return `outbound.${arr} 必须是数组`;
  }
  if (v.profiles !== undefined) {
    if (!plainObject(v.profiles)) return "outbound.profiles 必须是对象";
    if (v.profiles.custom !== undefined) {
      if (!plainObject(v.profiles.custom)) return "outbound.profiles.custom 必须是对象";
      for (const [id, p] of Object.entries(v.profiles.custom)) {
        if (p === null) continue; // null = 删除该自定义档案（§4.5.1）
        if (!plainObject(p)) return `outbound.profiles.custom.${id} 必须是对象或 null`;
      }
    }
  }
  return "";
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
  if (incoming.outbound !== undefined) {
    const bad = validateOutboundPatch(incoming.outbound);
    if (bad) return { ok: false, message: bad };
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
