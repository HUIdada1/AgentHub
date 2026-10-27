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
// 号池渠道 <-> cockpit-tools 平台映射（账号导入/导出兼容层，纯函数，离线可测）
// 背景：cockpit-tools 的账号转移包是 `cockpit-tools.account-transfer` v1，
//   每个平台的 exported_data 是该平台账号结构体的 serde 序列化数组
//   （snake_case 字段、秒级时间戳、UTF-8 无 BOM）。
// 本模块只做「形态转换」，不碰磁盘/网络/数据库，供 index.cjs 编排层调用。

"use strict";

const crypto = require("node:crypto");

// ===== 转移包 schema 常量（与 cockpit-tools/src/services/accountTransferService.ts 对齐） =====
const COCKPIT_SCHEMA = "cockpit-tools.account-transfer";
const COCKPIT_VERSION = 1;

// ===== 号池 channel -> cockpit PlatformId =====
// 号池独有渠道（raccoon / cline_* / catpaw / accio* / codearts / loomy / lobster / modelscope /
// autoclaw*）无 cockpit 对应平台，不出现在本表 —— 导出转移包时被跳过（见 buildTransferBundle）。
const AH_CHANNEL_TO_COCKPIT = {
  trae: "trae",
  workbuddy: "workbuddy",
  workbuddy_ai: "workbuddy",
  zcode: "zcode",
  qoder: "qoder",
  qoder_intl: "qoder",
};

// cockpit PlatformId -> 号池 channel
// trae 家族 4 键归并到号池 trae；workbuddy 只能映射一个号池渠道（CN 版为主）。
const COCKPIT_TO_AH_CHANNEL = {
  trae: "trae",
  trae_solo: "trae",
  trae_cn: "trae",
  trae_solo_cn: "trae",
  workbuddy: "workbuddy",
  zcode: "zcode",
  qoder: "qoder",
};

// cockpit-tools 里号池不认识的平台（导入转移包时记入 skipped_platforms，不报错、不拖垮整包）
// grok 在 cockpit 里本就是元数据导出、不可转移，一并归入跳过。

/** 取第一个非空字符串（trim 后） */
function firstStr(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/** 秒级时间戳 -> 毫秒（cockpit 是秒级 i64，号池一律毫秒；非法值回 0） */
function secToMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000);
}

/** 毫秒时间戳 -> 秒（导出用；0 返回 undefined 表示省略） */
function msToSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n / 1000);
}

/**
 * 把 cockpit 平台账号结构体（一条）归一化为号池 addAccount 入参。
 * platformId 是 cockpit 平台 id（已确认在 COCKPIT_TO_AH_CHANNEL 里）。
 * 返回 null 表示该条无法导入（缺凭据），由上层按 invalid 计数。
 */
function normalizeCockpitAccount(raw, platformId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const channel = COCKPIT_TO_AH_CHANNEL[platformId];
  if (!channel) return null;

  const meta = {};
  let token = "";
  let refreshToken = "";
  let uid = "";
  let name = "";

  if (platformId === "zcode") {
    // zcode 号池主 token = zcode_jwt_token（billing/claim/对话 Bearer），
    // access_token 是 oauth 访问令牌（存 meta.sw.accessToken 供续期/快照用）。
    const zjwt = firstStr(raw.zcode_jwt_token, raw.zcodeJwtToken, raw.zcodejwttoken);
    const access = firstStr(raw.access_token, raw.accessToken);
    token = zjwt || access;
    refreshToken = firstStr(raw.refresh_token, raw.refreshToken, raw.api_key, raw.apiKey);
    // zcode 智能识别：token 是 32 位 apiKey.secret（2 段非 JWT）时归到 refreshToken（与 normalizeAccountJson 同口径）
    if (token && !refreshToken && /^[a-f0-9]{32}\.[a-zA-Z0-9_-]+$/i.test(token)) {
      refreshToken = token;
      token = "";
    }
    if (!token && !refreshToken) return null;
    uid = firstStr(raw.user_id, raw.userId, raw.uid);
    name = firstStr(raw.display_name, raw.displayName, raw.nickname, raw.email, raw.name);
    const provider = firstStr(raw.provider, "zai");
    meta.provider = provider;
    if (raw.email) meta.email = String(raw.email);
    if (access && access !== token) meta.sw = { accessToken: access, _plain: true };
    if (raw.api_key) meta.apiKey = String(raw.api_key);
    if (raw.auth_mode) meta.authMode = String(raw.auth_mode);
    if (raw.avatar_url) meta.avatar = String(raw.avatar_url);
  } else {
    // trae / workbuddy / qoder 家族：标准 OAuth 结构体
    token = firstStr(raw.access_token, raw.accessToken, raw.token);
    refreshToken = firstStr(raw.refresh_token, raw.refreshToken, raw.api_key, raw.apiKey);
    if (!token && !refreshToken) return null;
    uid = firstStr(raw.user_id, raw.userId, raw.uid);
    name = firstStr(raw.nickname, raw.display_name, raw.displayName, raw.email, raw.name);
    if (raw.email) meta.email = String(raw.email);
    if (raw.enterprise_id) meta.enterpriseId = String(raw.enterprise_id);
    if (raw.enterprise_name) meta.enterpriseName = String(raw.enterprise_name);
    if (raw.domain) meta.domain = String(raw.domain);
    if (raw.plan_type) meta.planType = String(raw.plan_type);
  }

  // 通用：备注 / 标签 / 时间
  const note = firstStr(raw.account_note, raw.accountNote, raw.notes);
  if (note) meta.note = note;
  if (Array.isArray(raw.tags) && raw.tags.length) meta.tags = raw.tags.map(String);
  // cockpit 没有独立 uid 时用凭据派生（与 normalizeAccountJson 一致）
  if (!uid && refreshToken) {
    uid = crypto.createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
  }

  return {
    channel,
    uid,
    name: name.slice(0, 64),
    token,
    refreshToken,
    expiresAt: secToMs(raw.expires_at ?? raw.expiresAt),
    source: "json",
    meta: Object.keys(meta).length ? meta : undefined,
    createdAt: secToMs(raw.created_at ?? raw.createdAt),
    updatedAt: secToMs(raw.last_used ?? raw.lastUsed ?? raw.updated_at ?? raw.updatedAt),
  };
}

/** 判断一段 JSON 文本/对象是不是 cockpit-tools 账号转移包 */
function isCockpitTransferBundle(parsed) {
  return !!(
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.schema === COCKPIT_SCHEMA &&
    parsed.platforms &&
    typeof parsed.platforms === "object"
  );
}

/**
 * 展开转移包为 [{ channel, platformId, items: [...] }]，未映射平台记入 skipped。
 * 对 platforms.<id> 的形态宽容：{account_count, exported_data} / {data} / {accounts} / 直接数组。
 */
function expandTransferBundle(bundle) {
  const platforms = bundle.platforms || {};
  const groups = [];
  const skipped = [];
  for (const [pid, section] of Object.entries(platforms)) {
    const channel = COCKPIT_TO_AH_CHANNEL[pid];
    if (!channel) {
      skipped.push(pid);
      continue;
    }
    let items = [];
    if (Array.isArray(section)) items = section;
    else if (section && typeof section === "object") {
      const data = section.exported_data ?? section.data ?? section.accounts;
      if (Array.isArray(data)) items = data;
      else if (data && typeof data === "object") items = [data];
    }
    if (items.length) groups.push({ channel, platformId: pid, items });
  }
  return { groups, skipped };
}

/**
 * 判断对象是否像 cockpit 单平台账号结构体（trae/workbuddy/qoder 家族特征）。
 * 判据（缺一不可，避免误吞号池自有格式）：
 *   · 有 access_token（cockpit 家族必填字段之一）；
 *   · 没有号池自有 channel 字段（号池导出 row 一定带 channel）；
 *   · 带 snake_case 结构体时间戳或 user_id（cockpit 结构体的固定伴生字段）。
 */
function looksLikeCockpitStruct(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (item.channel) return false;
  if (!firstStr(item.access_token, item.accessToken)) return false;
  return (
    item.created_at !== undefined ||
    item.last_used !== undefined ||
    item.user_id !== undefined
  );
}

/** 判断对象是否像 cockpit zcode 结构体 */
function looksLikeCockpitZcode(item) {
  return !!(
    item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    !item.channel &&
    (item.zcode_jwt_token !== undefined || item.zcodeJwtToken !== undefined) &&
    (item.provider !== undefined || item.auth_mode !== undefined)
  );
}

/**
 * 号池账号（明文凭据 row，proxy_account_export_plain 的产物）-> cockpit 平台结构体。
 * channel 必须能映射到 cockpit 平台，否则返回 null（由上层跳过）。
 */
function toCockpitAccount(row) {
  const platformId = AH_CHANNEL_TO_COCKPIT[String(row && row.channel)];
  if (!platformId || !row) return null;
  const createdAt = msToSec(row.createdAt);
  const lastUsed = msToSec(row.updatedAt) ?? createdAt ?? Math.floor(Date.now() / 1000);
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};

  if (platformId === "zcode") {
    const out = {
      auth_mode: meta.authMode ? String(meta.authMode) : "oauth",
      provider: String(meta.provider || "zai"),
      email: String(meta.email || ""),
      user_id: row.uid ? String(row.uid) : undefined,
      display_name: row.name ? String(row.name) : undefined,
      access_token: String((meta.sw && meta.sw.accessToken) || row.token || ""),
      refresh_token: row.refreshToken ? String(row.refreshToken) : undefined,
      zcode_jwt_token: String(row.token || ""),
      created_at: createdAt ?? Math.floor(Date.now() / 1000),
      last_used: lastUsed,
    };
    const expSec = msToSec(row.expiresAt);
    if (expSec !== undefined) out.expires_at = expSec;
    return out;
  }

  // trae / workbuddy / qoder 家族通用结构体
  const out = {
    email: String(meta.email || ""),
    user_id: row.uid ? String(row.uid) : undefined,
    nickname: row.name ? String(row.name) : undefined,
    access_token: String(row.token || ""),
    refresh_token: row.refreshToken ? String(row.refreshToken) : undefined,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    last_used: lastUsed,
  };
  const expSec = msToSec(row.expiresAt);
  if (expSec !== undefined) out.expires_at = expSec;
  if (platformId === "workbuddy") {
    if (meta.enterpriseId) out.enterprise_id = String(meta.enterpriseId);
    if (meta.enterpriseName) out.enterprise_name = String(meta.enterpriseName);
    if (meta.domain) out.domain = String(meta.domain);
  }
  if (meta.planType) out.plan_type = String(meta.planType);
  return out;
}

/**
 * 组装 cockpit-tools 账号转移包。
 * rows: 明文凭据 row 数组（proxy_account_export_plain 的 accounts）。
 * 返回 { bundle, skipped: [{id, channel, name}] }，skipped 是无对应平台的号池账号。
 */
function buildTransferBundle(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const platforms = {};
  const skipped = [];
  let accountCount = 0;
  for (const row of list) {
    const acc = toCockpitAccount(row);
    if (!acc) {
      skipped.push({ id: row && row.id, channel: row && row.channel, name: row && row.name });
      continue;
    }
    const pid = AH_CHANNEL_TO_COCKPIT[String(row.channel)];
    if (!platforms[pid]) platforms[pid] = [];
    platforms[pid].push(acc);
    accountCount++;
  }
  const platformEntries = {};
  for (const [pid, arr] of Object.entries(platforms)) {
    platformEntries[pid] = { account_count: arr.length, exported_data: arr };
  }
  const bundle = {
    schema: COCKPIT_SCHEMA,
    version: COCKPIT_VERSION,
    exported_at: new Date().toISOString(),
    summary: {
      platform_count: Object.keys(platformEntries).length,
      account_count: accountCount,
    },
    platforms: platformEntries,
  };
  return { bundle, skipped };
}

module.exports = {
  COCKPIT_SCHEMA,
  COCKPIT_VERSION,
  AH_CHANNEL_TO_COCKPIT,
  COCKPIT_TO_AH_CHANNEL,
  secToMs,
  msToSec,
  normalizeCockpitAccount,
  isCockpitTransferBundle,
  expandTransferBundle,
  looksLikeCockpitStruct,
  looksLikeCockpitZcode,
  toCockpitAccount,
  buildTransferBundle,
};
