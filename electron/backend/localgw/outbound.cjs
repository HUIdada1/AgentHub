/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 出站伪装与清洗（策略解析 + 规则编译 + body 清洗）
// 实施契约：docs/localgw-outbound-contract.md（§2 形状 / §3 档案 / §4.2 签名）
//
// ── 本模块在链路里的位置 ────────────────────────────────────────
// 渠道是在 server 的 failover 循环里才确定的，所以「渠道特有规则」只能在
// forwarder.forward() 里生效：那里 policyFor(channel) 拿到已编译策略，
// sanitizeBody() 洗 body，policy.__headerOps 交给 outbound-hook 在 util/catpaw 出口套头。
//
// ── 三条不能破的约束 ───────────────────────────────────────────
// ① 无配置时行为与改动前**完全一致**：档案默认不生效（profile:""），
//    头覆盖默认无操作，内置脱敏沿用 fingerprintObfuscation 老开关。
// ② 绝不改调用方传进来的 body / headers（一律先拷贝再改）。
// ③ 任何规则异常都不许把请求打坏：编译失败丢弃该条，清洗异常原样放行。
"use strict";
const sanitize = require("../proxy/sanitize.cjs");

/** 单表规则条数上限（与 config.cjs 的 normalize 同口径）：防手改配置把热路径撑爆 */
const MAX_RULES = 200;
/** scope 白名单（§2）：按消息角色判定 */
const SCOPES = ["all", "system", "user", "assistant", "tool"];
/** 正则 flags 允许的字符集（§2） */
const FLAG_CHARS = "gimsuy";
/** 命中摘要里 label 的最大长度（§2）：太长会把请求日志的「敏」列糊成一片 */
const LABEL_MAX = 40;

// ===== 内置 agent 软件模拟档案（只读，§3）=====
//
// ── 收录原则（§3 v1.3）：只放**静态可确定**的形态头 ──────────────
// 「静态」= 不随账号/配置/时间变化的字面量；「动态」= adapter 按账号或配置现场算的。
// 动态值**一律不放进档案**：档案是 merge 覆盖，写死的值会盖掉 adapter 算出的正确值，
// 结果是「伪装反而更假」——版本号与账号不匹配恰好是风控最容易抓的特征。
//
// 因此 zcode / qoder 只给 label + note（+ qoder 那条静态 UA），headers 留空。

/** rules/headers.json 里没有对应段的档案，其版本串的唯一事实源。
 *  客户端升级后改这里即生效，无需发版——但**必须与真实客户端一致**：
 *  版本串对不上时，「伪装」本身就成了新指纹。 */
const CLIENT_VERSIONS = {
  claudeCode: "2.0.17",
  codexCli: "0.50.0",
  cursor: "1.7.52",
  geminiCli: "0.11.3",
};

const PROFILE_DEFS = {
  "claude-code": {
    label: "Claude Code CLI",
    userAgent: `claude-cli/${CLIENT_VERSIONS.claudeCode} (external, cli)`,
    headers: {
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
    },
    removeHeaders: [],
    note: "官方 CLI 形态：UA 前缀 claude-cli 与 x-app 是上游判定客户端类型的依据；版本号为参考值（仓库无事实源），请按你实际使用的客户端版本核对后调整",
  },
  "codex-cli": {
    label: "Codex CLI",
    userAgent: `codex_cli_rs/${CLIENT_VERSIONS.codexCli}`,
    headers: { originator: "codex_cli_rs" },
    removeHeaders: [],
    note: "Rust 版 CLI 形态：originator 是 Codex 专有标识；版本号为参考值（仓库无事实源），请按你实际使用的客户端版本核对后调整",
  },
  cursor: {
    label: "Cursor",
    userAgent: `Cursor/${CLIENT_VERSIONS.cursor}`,
    headers: { "x-cursor-client-version": CLIENT_VERSIONS.cursor },
    removeHeaders: [],
    note: "Cursor 客户端形态：UA 与 x-cursor-client-version 必须同版本；版本号为参考值（仓库无事实源），请按你实际使用的客户端版本核对后调整",
  },
  cline: {
    label: "Cline",
    userAgent: "Cline/3.0.62",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
      "X-IS-MULTIROOT": "false",
      "X-CLIENT-TYPE": "cline-sdk",
      "X-CLIENT-VERSION": "3.0.62",
      "X-PLATFORM": "terminal",
      "X-PLATFORM-VERSION": "3.0.62",
      "X-CORE-VERSION": "0.0.70",
    },
    removeHeaders: [],
    note: "X-CLIENT-TYPE: cline-sdk 是免费池硬门槛（缺它免费池一律 403）",
  },
  "gemini-cli": {
    label: "Gemini CLI",
    userAgent: `GeminiCLI/${CLIENT_VERSIONS.geminiCli}`,
    headers: {},
    removeHeaders: [],
    note: "官方 CLI 形态：上游按 UA 前缀 GeminiCLI 判定；版本号为参考值（仓库无事实源），请按你实际使用的客户端版本核对后调整",
  },
  "trae-cn": {
    label: "Trae SOLO CN",
    userAgent: "TraeClient/TTNet",
    headers: {},
    removeHeaders: [],
    note: "UA 取自 rules/headers.json 的 trae 段",
  },
  "workbuddy-cn": {
    label: "WorkBuddy CN",
    userAgent: "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
    headers: {},
    removeHeaders: [],
    note: "三段式 UA，少一段会被判成网关；取自 rules/headers.json 的 workbuddy 段",
  },
  "workbuddy-ai": {
    label: "WorkBuddy AI",
    userAgent: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
    headers: {},
    removeHeaders: [],
    note: "平台段必须是 WorkBuddy AI，送错触发 403 code 11140；取自 rules 的 workbuddy_ai 段",
  },
  zcode: {
    label: "ZCode",
    userAgent: "",
    headers: {},
    removeHeaders: [],
    note: "该渠道的 UA 与版本头由适配器按账号/配置动态生成，档案不覆盖（写死会让版本号与账号不匹配）",
  },
  qoder: {
    label: "Qoder",
    userAgent: "qoder/0.4.3",
    headers: {},
    removeHeaders: [],
    note: "UA 是静态字面量（取自 rules 的 qoder 段）；Cosy-Version 等版本头由适配器动态生成，档案不覆盖",
  },
};

/** 冻结档案表：契约声明它是「只读」预设，冻结比注释更能保证这一点 */
function freezeProfiles(defs) {
  const out = {};
  for (const [id, p] of Object.entries(defs)) {
    out[id] = Object.freeze({
      label: p.label,
      userAgent: p.userAgent,
      headers: Object.freeze({ ...p.headers }),
      removeHeaders: Object.freeze([...p.removeHeaders]),
      note: p.note,
    });
  }
  return Object.freeze(out);
}

/** 内置档案表（只读）。rules 里已有对应段的档案，其值在 builtinProfile() 里优先从 rules 取 */
const BUILTIN_PROFILES = freezeProfiles(PROFILE_DEFS);

/** 档案 → rules/headers.json 取值口径。
 *  为什么要有这一层：官方客户端版本会随客户端升级而变，rules 是**已经实证过**的单一事实源；
 *  再抄一份字面量进代码，两处必然漂移（改了 rules 而代码里的旧版本还在用）。
 *  这里只取**静态**字段，动态字段（如 zcode 的 appVersion）刻意不取，理由见 §3 收录原则。 */
const RULES_SOURCES = {
  "cline": (h) => {
    const up = plain(h.cline && h.cline.upstreamHeaders) ? h.cline.upstreamHeaders : null;
    if (!up) return null;
    const headers = {};
    let userAgent = "";
    for (const [k, v] of Object.entries(up)) {
      const val = str(v);
      if (!val) continue; // rules 既定语义：空串 = 该头不发
      if (k.toLowerCase() === "user-agent") { userAgent = val; continue; }
      headers[k] = val;
    }
    return { userAgent, headers };
  },
  "trae-cn": (h) => {
    const ua = str(h.trae && h.trae.userAgent);
    return ua ? { userAgent: ua, headers: {} } : null;
  },
  "workbuddy-cn": (h) => {
    const ua = str(h.workbuddy && h.workbuddy.userAgent);
    return ua ? { userAgent: ua, headers: {} } : null;
  },
  "workbuddy-ai": (h) => {
    const ua = str(h.workbuddy_ai && h.workbuddy_ai.userAgent);
    return ua ? { userAgent: ua, headers: {} } : null;
  },
  "qoder": (h) => {
    const ua = str(h.qoder && h.qoder.userAgent);
    return ua ? { userAgent: ua, headers: {} } : null;
  },
};

/** 取内置档案（rules 有值则覆盖字面量）。rules 不可用时静默回落字面量：
 *  档案读不出来不能把出站打挂，伪装缺失只是少一层，请求打不出去才是事故。 */
function builtinProfile(id) {
  const base = BUILTIN_PROFILES[id];
  if (!base) return null;
  const src = RULES_SOURCES[id];
  if (!src) return base;
  try {
    const h = require("../proxy/rules.cjs").get("headers.json") || {};
    const r = src(h);
    if (!r) return base;
    return {
      label: base.label,
      userAgent: r.userAgent || base.userAgent,
      headers: { ...base.headers, ...(r.headers || {}) },
      removeHeaders: base.removeHeaders,
      note: base.note,
    };
  } catch {
    return base;
  }
}

// ===== 小工具 =====

function plain(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" ? v : "";
}

function bump(hits, label, n) {
  if (!hits) return;
  const key = String(label || "").slice(0, LABEL_MAX);
  if (!key) return;
  hits.set(key, (hits.get(key) || 0) + Math.max(1, Number(n) || 1));
}

/** 命中表 → 排序数组（次数降序；同次数保持首次命中顺序） */
function hitList(hits) {
  if (!hits || !hits.size) return [];
  const list = [...hits.entries()].map(([label, count]) => ({ label, count }));
  list.sort((a, b) => b.count - a.count);
  return list;
}

/** 命中表 → 摘要串（与 sanitize.formatHits 同款，直接落 oplog 的 sensitiveHits 列） */
function formatHits(hits) {
  return hitList(hits)
    .map((h) => (h.count > 1 ? `${h.label}×${h.count}` : h.label))
    .join(" · ")
    .slice(0, 500);
}

/** scope 判定：all 不限；其余按消息角色严格相等（§2） */
function scopeAllows(ruleScope, msgScope) {
  const rs = ruleScope || "all";
  if (rs === "all") return true;
  return rs === msgScope;
}

/** scope 纠偏：非法值回 "all"（§4.5 的白名单口径）。
 *  normalize 已经挡过一道，这里再兜一次——policyFor 是导出面，可能被直接喂未归一化的配置，
 *  而非法 scope 若不纠偏会让规则**静默永不命中**（比"当作 all 生效"更难排查）。 */
function safeScope(v) {
  return SCOPES.includes(v) ? v : "all";
}

/** flags 纠偏：只保留 gimsuy 的子集，并**强制带 g**。
 *  强制 g 的理由：清洗规则要替换**全部**出现，只换第一处是静默的漏洗——
 *  用户配 flags:"i" 时最容易踩到（他想要的是"忽略大小写地全换"）。
 *  normalize 已挡一道，这里再兜一次手改配置 / 未归一化入参。 */
function safeFlags(v) {
  const s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) if (FLAG_CHARS.includes(ch) && !out.includes(ch)) out += ch;
  return out.includes("g") ? out : out + "g";
}

function labelOf(r) {
  return String(r.label || r.id || "未命名规则").slice(0, LABEL_MAX);
}

// ===== 规则编译 =====

/** 文案替换表 → 编译后的字面量规则（rewrite 是 keyword 的 literal 特例，§2） */
function compileRewrites(rules, enabled) {
  const out = [];
  if (!enabled) return out;
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!plain(r) || r.enabled === false) continue;
    const from = str(r.from);
    if (!from) continue;
    out.push({ kind: "literal", id: str(r.id), label: labelOf(r), scope: safeScope(r.scope), from, to: str(r.to) });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

/** 关键词表 → 编译后的规则（literal 用 split/join，regex 用 RegExp） */
function compileKeywords(rules, enabled) {
  const out = [];
  if (!enabled) return out;
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!plain(r) || r.enabled === false) continue;
    const pattern = str(r.pattern);
    if (!pattern) continue;
    if (r.mode === "regex") {
      let re = null;
      try { re = new RegExp(pattern, safeFlags(r.flags)); } catch { continue; } // 坏正则丢弃，绝不抛给调用方
      out.push({ kind: "regex", id: str(r.id), label: labelOf(r), scope: safeScope(r.scope), re, to: str(r.replace) });
    } else {
      out.push({ kind: "literal", id: str(r.id), label: labelOf(r), scope: safeScope(r.scope), from: pattern, to: str(r.replace) });
    }
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

/** 头操作预编译（契约 §4.5.1）：set 为「键名 → 已转串的值」，remove 为小写键名集合 */
function compileHeaderOps(headers, removeHeaders) {
  const set = {};
  const remove = new Set();
  for (const k of Array.isArray(removeHeaders) ? removeHeaders : []) {
    const key = k == null ? "" : String(k).trim();
    if (key) remove.add(key.toLowerCase());
  }
  if (plain(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k).trim();
      if (!key) continue;
      // 值为 null/undefined 的键 = 删除该头（并入 remove）；其余一律转串（用户可能填数字/布尔）
      if (v === null || v === undefined) { remove.add(key.toLowerCase()); continue; }
      set[key] = String(v);
    }
  }
  return { set, remove };
}

// ===== 档案解析 =====

/** 用户自定义档案：{ [id]: { label, userAgent, headers, removeHeaders, note } } */
function customProfiles(cfg) {
  const ob = plain(cfg && cfg.outbound) ? cfg.outbound : {};
  const prof = plain(ob.profiles) ? ob.profiles : {};
  const custom = plain(prof.custom) ? prof.custom : {};
  const out = {};
  for (const [id, p] of Object.entries(custom)) {
    const key = String(id).trim();
    if (!key || !plain(p)) continue; // null / 非法值 = 没有这个档案
    out[key] = {
      label: str(p.label) || key,
      userAgent: str(p.userAgent),
      headers: plain(p.headers) ? { ...p.headers } : {},
      removeHeaders: Array.isArray(p.removeHeaders) ? p.removeHeaders.slice() : [],
      note: str(p.note),
    };
  }
  return out;
}

/** 解析档案 id → 生效形态；找不到返回 null（= 只用渠道 adapter 自带形态）。
 *  自定义档案可以覆盖同 id 的内置档案：用户显式建的那条更具体，优先级更高。 */
function resolveProfile(id, cfg) {
  const key = str(id).trim();
  if (!key) return null;
  const custom = customProfiles(cfg)[key];
  if (custom) return custom;
  const b = builtinProfile(key);
  if (!b) return null;
  return {
    label: b.label,
    userAgent: b.userAgent,
    headers: { ...b.headers },
    removeHeaders: [...b.removeHeaders],
    note: b.note,
  };
}

// ===== 策略解析 =====

/**
 * 解析某渠道的生效策略（契约 §4.2）。
 * 合并顺序：内置默认 ← defaults ← perChannel[cid]，再叠加向后兼容的两个老开关。
 * 返回**已编译**的 Policy：headers/removeHeaders/keywords(Matcher[])/rewrites/__headerOps/__rules。
 */
function policyFor(channelId, cfg) {
  const c = plain(cfg) ? cfg : {};
  const ob = plain(c.outbound) ? c.outbound : {};
  const d = plain(ob.defaults) ? ob.defaults : {};
  const per = plain(ob.perChannel) ? ob.perChannel : {};
  const ov = channelId && plain(per[channelId]) ? per[channelId] : {};
  /** 取生效值：渠道覆盖 → 全局默认 → 内置兜底 */
  const pick = (k, fallback) => (ov[k] !== undefined ? ov[k] : (d[k] !== undefined ? d[k] : fallback));

  const mode = pick("mode", "mimic") === "passthrough" ? "passthrough" : "mimic";
  const profileId = str(pick("profile", ""));
  const profile = resolveProfile(profileId, c);

  // 档案 → 用户显式 headers → 移除头。档案走 merge（保留 adapter 已构造的其余头，
  // 鉴权头与渠道签名头原样保留）；用户显式配置比档案更具体，故后写覆盖。
  const headers = {};
  if (profile) {
    if (profile.userAgent) headers["User-Agent"] = String(profile.userAgent);
    for (const [k, v] of Object.entries(profile.headers || {})) headers[k] = String(v);
  }
  const ownHeaders = plain(pick("headers", null)) ? pick("headers", null) : {};
  for (const [k, v] of Object.entries(ownHeaders)) headers[k] = v;
  const removeHeaders = [
    ...(profile && Array.isArray(profile.removeHeaders) ? profile.removeHeaders : []),
    ...(Array.isArray(pick("removeHeaders", null)) ? pick("removeHeaders", null) : []),
  ];

  const rewriteOn = pick("rewriteSanitize", true) !== false;
  const keywordOn = pick("keywordSanitize", true) !== false;
  // 全局规则库与渠道内联规则叠加：先全局后内联（§2）。内联在后，同 label 时它更靠后生效。
  const rewrites = compileRewrites([
    ...(Array.isArray(ob.rewrites) ? ob.rewrites : []),
    ...(Array.isArray(pick("rewrites", null)) ? pick("rewrites", null) : []),
  ], rewriteOn);
  const keywords = compileKeywords([
    ...(Array.isArray(ob.keywords) ? ob.keywords : []),
    ...(Array.isArray(pick("keywords", null)) ? pick("keywords", null) : []),
  ], keywordOn);

  if (mode === "passthrough") {
    // 透传 = 短路一切（§2）。这里把各项能力一并置为关闭，让调用方只看 policy 就够，
    // 不必再各自判 mode——判漏一处就会出现「透传了却还在抖」这类不一致。
    return {
      mode,
      profile: profileId,
      builtinSanitize: false,
      keywordSanitize: false,
      rewriteSanitize: false,
      headerOverride: false,
      jitter: false,
      headers: {},
      removeHeaders: [],
      keywords: [],
      rewrites: [],
      __headerOps: { set: {}, remove: new Set() },
      __rules: [],
    };
  }

  return {
    mode,
    profile: profileId,
    // 向后兼容：老开关关掉 = 新开关也关（§4.5）。老开关是"整机级"意愿，
    // 因此对渠道级覆盖也是硬 AND——用户全局关掉指纹脱敏后，不该被某条渠道配置重新打开。
    builtinSanitize: pick("builtinSanitize", true) !== false && c.fingerprintObfuscation !== false,
    keywordSanitize: keywordOn,
    rewriteSanitize: rewriteOn,
    headerOverride: pick("headerOverride", true) !== false,
    jitter: pick("jitter", true) !== false && c.humanizeJitter !== false,
    headers,
    removeHeaders,
    keywords,
    rewrites,
    __headerOps: compileHeaderOps(headers, removeHeaders),
    // 执行顺序：先 rewrites 后 keywords（§2）。rewrite 是"整句成对改写"，
    // 若先跑剥离层会把待改写句子切碎，改写永远命中不了。
    __rules: [...rewrites, ...keywords],
  };
}

// ===== 清洗执行 =====

function policyRules(policy) {
  if (!policy || policy.mode === "passthrough") return null;
  const rules = policy.__rules;
  return rules && rules.length ? rules : null;
}

/** 套用单条规则。hits 为 Map 时累计命中次数（传 null = 只改不记）。 */
function applyRule(text, r, hits) {
  if (r.kind === "literal") {
    if (!r.from || !text.includes(r.from)) return text;
    if (hits) bump(hits, r.label, text.split(r.from).length - 1);
    return text.split(r.from).join(r.to); // literal 用 split/join：不做 $1 展开（§2）
  }
  const re = r.re;
  // 共享的正则对象带 g，必须显式归零 lastIndex（match/replace 本身也会重置，这里是双保险）
  re.lastIndex = 0;
  const m = text.match(re);
  re.lastIndex = 0;
  if (!m || !m.length) return text;
  if (hits) bump(hits, r.label, m.length);
  return text.replace(re, r.to); // regex 允许 $1 展开（§2）
}

/** 单段文本清洗（契约 §4.2）：scope 见 §2 */
function sanitizeText(text, policy, scope) {
  if (typeof text !== "string" || !text) return { text, changed: false };
  const rules = policyRules(policy);
  if (!rules) return { text, changed: false };
  let out = text;
  for (const r of rules) {
    if (!scopeAllows(r.scope, scope)) continue;
    out = applyRule(out, r, null);
  }
  return out === text ? { text, changed: false } : { text: out, changed: true };
}

/** 供 UI 试跑（localgw_outbound_preview）：多回一份命中明细。
 *  为什么单独一个函数而不是让 sanitizeText 多返回 hits：sanitizeText 的签名在契约里
 *  冻结为 { text, changed }，加字段属于改形状；新增导出是纯增量，不破坏任何既有调用。
 *  scope 省略时**不做 scope 过滤**（试跑要看的是"全部规则叠上去会怎样"）。 */
function previewText(text, policy, scope) {
  const s = typeof text === "string" ? text : String(text == null ? "" : text);
  const rules = policyRules(policy);
  if (!rules) return { text: s, changed: false, hits: [] };
  const only = scope && scope !== "all" ? scope : "";
  const hits = new Map();
  let out = s;
  for (const r of rules) {
    if (only && !scopeAllows(r.scope, only)) continue;
    out = applyRule(out, r, hits);
  }
  return { text: out, changed: out !== s, hits: hitList(hits) };
}

/** content：字符串，或多模态数组（只动带 text 字符串的分片，与 sanitize.cjs 同口径） */
function sanitizeContent(value, policy, scope, hits) {
  if (typeof value === "string") {
    const out = runRules(value, policy, scope, hits);
    return out === value ? { changed: false, value } : { changed: true, value: out };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((part) => {
      if (!plain(part) || typeof part.text !== "string") return part;
      const next = runRules(part.text, policy, scope, hits);
      if (next === part.text) return part;
      changed = true;
      return { ...part, text: next };
    });
    return { changed, value: changed ? out : value };
  }
  return { changed: false, value };
}

function runRules(text, policy, scope, hits) {
  const rules = policyRules(policy);
  if (!rules) return text;
  let out = text;
  for (const r of rules) {
    if (!scopeAllows(r.scope, scope)) continue;
    out = applyRule(out, r, hits);
  }
  return out;
}

/** 就地清洗 messages 数组（调用方已保证是深拷贝副本）。返回是否有变化。 */
function sanitizeMessages(messages, policy, hits) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const msg of messages) {
    if (!plain(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role.trim().toLowerCase() : "";
    // content 与 tool_calls 各自独立判断：工具调用轮的 content 通常是 null，
    // 若以"content 缺失"跳过整条消息，tool_calls 里的被拦字符串会原样漏出。
    if (msg.content !== undefined) {
      const r = sanitizeContent(msg.content, policy, role, hits);
      if (r.changed) { msg.content = r.value; changed = true; }
    }
    if (typeof msg.reasoning_content === "string") {
      const next = runRules(msg.reasoning_content, policy, role, hits);
      if (next !== msg.reasoning_content) { msg.reasoning_content = next; changed = true; }
    }
    if (Array.isArray(msg.tool_calls)) {
      let tc = false;
      const out = msg.tool_calls.map((call) => {
        const fn = call && call.function;
        if (!fn || typeof fn.arguments !== "string") return call;
        // tool_calls 的 arguments 归 "tool" scope（§2：tool 指 role==="tool" 的消息
        // 以及 assistant.tool_calls[].function.arguments），故这里显式传 "tool" 而非消息角色
        const next = runRules(fn.arguments, policy, "tool", hits);
        if (next === fn.arguments) return call;
        tc = true;
        return { ...call, function: { ...fn, arguments: next } };
      });
      if (tc) { msg.tool_calls = out; changed = true; }
    }
  }
  return changed;
}

/**
 * 清洗请求体（契约 §4.2）。
 * policy 为空 / mode==="passthrough" → 原样返回 { body, hits:"", changed:false }（body 同一引用）。
 * 命中时返回**新对象** + 摘要串；未命中同样原样返回（零拷贝沿用原 body）。
 */
function sanitizeBody(body, policy) {
  const untouched = { body, hits: "", changed: false };
  if (!policy || policy.mode === "passthrough") return untouched;
  if (!plain(body) || !Array.isArray(body.messages)) return untouched;
  const rules = policyRules(policy);
  const hasBuiltin = !!policy.builtinSanitize;
  if (!rules && !hasBuiltin) return untouched;

  let next;
  try { next = JSON.parse(JSON.stringify(body)); }
  catch { return untouched; } // 循环引用等异常形态：宁可不动，也不能把请求搞坏

  const hits = new Map();
  let changed = false;
  try {
    // 顺序：**先自定义规则、后内置规则**。
    // 理由：用户配的文案替换要能命中**原文**——内置 sanitize.cjs 自己也会改写
    // "You are Claude Code, Anthropic's official CLI for Claude" 这句。若内置先跑，
    // 用户最想换掉的那句话已经被改过一次，自定义规则再也匹配不上（静默失效）。
    if (rules) changed = sanitizeMessages(next.messages, policy, hits) || changed;
    if (hasBuiltin) {
      const r = sanitize.sanitizeBody(next); // 内置规则集与执行顺序一律走 sanitize.cjs，不在此重写
      if (r) {
        next = r.body;
        changed = true;
        for (const h of r.hits) bump(hits, h.label, h.count);
      }
    }
  } catch {
    return untouched; // 清洗异常一律原样放行：规则问题不该把请求打坏
  }
  if (!changed) return untouched;
  return { body: next, hits: formatHits(hits), changed: true };
}

// ===== 供 UI =====

/** 列出全部可选档案（内置 + 自定义），契约 §4.2 */
function listProfiles(cfg) {
  try {
    const c = plain(cfg) ? cfg : {};
    const custom = customProfiles(c);
    const out = [];
    for (const id of Object.keys(BUILTIN_PROFILES)) {
      // 自定义档案覆盖同 id 的内置档案（与 resolveProfile 同口径）；
      // 否则下拉里会出现两个 value 相同、label 不同的选项
      if (custom[id]) continue;
      const p = builtinProfile(id);
      if (!p) continue;
      out.push({
        id,
        label: p.label,
        builtin: true,
        note: p.note || "",
        userAgent: p.userAgent || "",
        headers: { ...p.headers },
      });
    }
    for (const [id, p] of Object.entries(custom)) {
      out.push({
        id,
        label: p.label,
        builtin: false,
        note: p.note || "",
        userAgent: p.userAgent || "",
        headers: { ...p.headers },
      });
    }
    return out;
  } catch {
    // 档案表读不出来不能把 outbound_get 整个打挂：UI 会因此永久显示"后端通道未接入"，
    // 而真实原因只是某条档案写坏了——宁可少列几条，也要让面板能打开
    return [];
  }
}

/** 生效策略摘要（人话），供渠道列表行展示，契约 §4.2 */
function describePolicy(channelId, cfg) {
  const p = policyFor(channelId, cfg);
  const prof = p.profile ? resolveProfile(p.profile, cfg) : null;
  const profileLabel = prof ? prof.label : (p.profile || "");
  const parts = [];
  if (p.mode === "passthrough") {
    parts.push("全部透传");
  } else {
    const caps = [];
    if (p.builtinSanitize) caps.push("内置指纹");
    if (p.rewriteSanitize && p.rewrites.length) caps.push(`文案替换 ${p.rewrites.length}`);
    if (p.keywordSanitize && p.keywords.length) caps.push(`关键词 ${p.keywords.length}`);
    if (caps.length) parts.push(caps.join(" + "));
    if (p.headerOverride) {
      const nSet = Object.keys(p.__headerOps.set).length;
      const nRm = p.__headerOps.remove.size;
      if (nSet || nRm) parts.push(`头覆盖 ${nSet} / 移除 ${nRm}`);
    }
    if (p.jitter) parts.push("拟人抖动");
    if (!parts.length) parts.push("仅用渠道自带形态");
  }
  return { mode: p.mode, profileLabel, parts };
}

module.exports = {
  BUILTIN_PROFILES,
  policyFor,
  sanitizeBody,
  sanitizeText,
  listProfiles,
  describePolicy,
  // 纯增量导出（不改任何既有签名）：供 localgw_outbound_preview 取命中明细
  previewText,
};
