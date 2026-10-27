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
// 号池 · cockpit-tools 账号导入导出兼容自测（离线纯函数，不打上游、不碰数据库）
// 覆盖：平台映射表、秒/毫秒换算、cockpit 结构体归一（zcode 双 token / trae 家族 / workbuddy）、
//       转移包展开与跳过、号池 row -> cockpit 结构体、转移包组装、结构体特征判别。
"use strict";

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

const pm = require("../electron/backend/proxy/platformMap.cjs");

// ===== 1) 映射表 =====
eq(pm.COCKPIT_SCHEMA, "cockpit-tools.account-transfer", "转移包 schema 常量");
eq(pm.COCKPIT_VERSION, 1, "转移包版本");
eq(pm.AH_CHANNEL_TO_COCKPIT.trae, "trae", "号池 trae -> cockpit trae");
eq(pm.AH_CHANNEL_TO_COCKPIT.workbuddy_ai, "workbuddy", "号池 workbuddy_ai -> cockpit workbuddy");
eq(pm.AH_CHANNEL_TO_COCKPIT.qoder_intl, "qoder", "号池 qoder_intl -> cockpit qoder");
eq(pm.AH_CHANNEL_TO_COCKPIT.raccoon, undefined, "号池独有渠道无 cockpit 平台");
eq(pm.COCKPIT_TO_AH_CHANNEL.trae_solo_cn, "trae", "trae 家族四键归并到号池 trae");
eq(pm.COCKPIT_TO_AH_CHANNEL.workbuddy, "workbuddy", "cockpit workbuddy -> 号池 workbuddy");
eq(pm.COCKPIT_TO_AH_CHANNEL.claude_manager, undefined, "号池不支持 claude_manager");

// ===== 2) 时间换算 =====
eq(pm.secToMs(1720000000), 1720000000000, "秒 -> 毫秒");
eq(pm.secToMs(0), 0, "0 秒 -> 0");
eq(pm.secToMs(null), 0, "null -> 0");
eq(pm.msToSec(1720000000000), 1720000000, "毫秒 -> 秒（向下取整）");
eq(pm.msToSec(1720000000999), 1720000000, "毫秒 -> 秒丢弃零头");
eq(pm.msToSec(0), undefined, "0 毫秒 -> undefined（导出省略）");

// ===== 3) cockpit 结构体 -> 号池账号 =====
(function testNormalizeTrae() {
  const raw = {
    email: "a@example.com", user_id: "u-trae-1", nickname: "主力号",
    access_token: "AT", refresh_token: "RT",
    expires_at: 1800000000, created_at: 1700000000, last_used: 1700000100,
    tags: ["工作"], account_note: "备注A",
  };
  const acc = pm.normalizeCockpitAccount(raw, "trae_solo_cn");
  eq(acc.channel, "trae", "trae_solo_cn 归入号池 trae");
  eq(acc.token, "AT", "access_token -> token");
  eq(acc.refreshToken, "RT", "refresh_token -> refreshToken");
  eq(acc.uid, "u-trae-1", "user_id -> uid");
  eq(acc.name, "主力号", "nickname -> name");
  eq(acc.expiresAt, 1800000000000, "expires_at 秒转毫秒");
  eq(acc.createdAt, 1700000000000, "created_at 秒转毫秒");
  eq(acc.updatedAt, 1700000100000, "last_used -> updatedAt 毫秒");
  eq(acc.meta.email, "a@example.com", "email 落 meta");
  eq(acc.meta.note, "备注A", "account_note -> meta.note");
  eq(acc.meta.tags, ["工作"], "tags 落 meta");
  eq(acc.source, "json", "source=json");
})();

(function testNormalizeZcode() {
  const raw = {
    auth_mode: "oauth", provider: "zai", email: "z@example.com", user_id: "u-z-1",
    display_name: "zcode号", access_token: "ACCESS", refresh_token: "REFRESH",
    zcode_jwt_token: "JWT", created_at: 1700000000, last_used: 1700000200,
  };
  const acc = pm.normalizeCockpitAccount(raw, "zcode");
  eq(acc.channel, "zcode", "zcode 平台 -> 号池 zcode");
  eq(acc.token, "JWT", "zcode 主 token 取 zcode_jwt_token");
  eq(acc.refreshToken, "REFRESH", "refresh_token -> refreshToken");
  eq(acc.meta.provider, "zai", "provider 落 meta");
  eq(acc.meta.sw.accessToken, "ACCESS", "access_token 落 meta.sw 供续期");
})();

(function testNormalizeZcodeApiKeyOnly() {
  // 32 位 apiKey.secret 形态：应归到 refreshToken（与 normalizeAccountJson 同口径）
  const raw = {
    auth_mode: "api_key", provider: "zai", email: "k@example.com",
    access_token: "0123456789abcdef0123456789abcdef.secretpart",
    created_at: 1700000000, last_used: 1700000000,
  };
  const acc = pm.normalizeCockpitAccount(raw, "zcode");
  eq(acc.token, "", "apiKey.secret 不留在 token");
  eq(acc.refreshToken, "0123456789abcdef0123456789abcdef.secretpart", "apiKey.secret 归到 refreshToken");
})();

(function testNormalizeMissingCredential() {
  eq(pm.normalizeCockpitAccount({ email: "x@example.com" }, "trae"), null, "无凭据结构体返回 null");
  eq(pm.normalizeCockpitAccount(null, "trae"), null, "null 返回 null");
  eq(pm.normalizeCockpitAccount({ access_token: "AT" }, "unknown_platform"), null, "未映射平台返回 null");
})();

(function testNormalizeDerivedUid() {
  const raw = { access_token: "AT", refresh_token: "RT", created_at: 1, last_used: 1 };
  const acc = pm.normalizeCockpitAccount(raw, "trae");
  ok(acc.uid && acc.uid.length === 16, "缺 uid 时用 refreshToken 派生 16 位");
})();

// ===== 4) 转移包识别与展开 =====
(function testBundle() {
  const bundle = {
    schema: pm.COCKPIT_SCHEMA, version: 1, exported_at: "2026-10-27T00:00:00.000Z",
    summary: { platform_count: 4, account_count: 3 },
    platforms: {
      zcode: { account_count: 1, exported_data: [{ zcode_jwt_token: "J", access_token: "A", provider: "zai", email: "z@e.com", created_at: 1, last_used: 1 }] },
      trae: { account_count: 1, exported_data: [{ access_token: "AT", refresh_token: "RT", email: "t@e.com", created_at: 1, last_used: 1 }] },
      codex: { account_count: 1, exported_data: [{ access_token: "AO" }] },
      claude_manager: { account_count: 0, exported_data: [] },
    },
  };
  ok(pm.isCockpitTransferBundle(bundle), "识别转移包");
  ok(!pm.isCockpitTransferBundle({ schema: "other" }), "非转移包不误判");
  const { groups, skipped } = pm.expandTransferBundle(bundle);
  eq(groups.map((g) => g.platformId).sort(), ["trae", "zcode"], "只展开号池支持的平台");
  eq(skipped.sort(), ["claude_manager", "codex"], "未映射平台记入 skipped");

  // 形态宽容：data / accounts / 直接数组
  const loose = pm.expandTransferBundle({ platforms: {
    trae: { data: [{ access_token: "A" }] },
    workbuddy: { accounts: [{ access_token: "B" }] },
    qoder: [{ access_token: "C" }],
  } });
  eq(loose.groups.length, 3, "data/accounts/直接数组三种形态都展开");
  eq(loose.groups.find((g) => g.platformId === "qoder").channel, "qoder", "qoder 直接数组 -> 号池 qoder");
})();

// ===== 5) 号池 row -> cockpit 结构体 =====
(function testToCockpit() {
  const row = {
    channel: "zcode", uid: "u-z", name: "z号", token: "JWT", refreshToken: "REF",
    expiresAt: 1800000000000, createdAt: 1700000000000, updatedAt: 1700000100000,
    meta: { provider: "zai", email: "z@e.com", aw: { accessToken: "A" }, sw: { accessToken: "A2" } },
  };
  const out = pm.toCockpitAccount(row);
  eq(out.zcode_jwt_token, "JWT", "号池 token -> zcode_jwt_token");
  eq(out.access_token, "A2", "meta.sw.accessToken -> access_token");
  eq(out.refresh_token, "REF", "refreshToken -> refresh_token");
  eq(out.user_id, "u-z", "uid -> user_id");
  eq(out.display_name, "z号", "name -> display_name");
  eq(out.expires_at, 1800000000, "毫秒 -> 秒");
  eq(out.created_at, 1700000000, "createdAt 毫秒 -> 秒");
  eq(out.last_used, 1700000100, "updatedAt 毫秒 -> 秒");

  const traeRow = { channel: "trae", uid: "u-t", name: "t号", token: "AT", refreshToken: "RT", createdAt: 1700000000000, updatedAt: 1700000000000, meta: { email: "t@e.com" } };
  const t = pm.toCockpitAccount(traeRow);
  eq(t.access_token, "AT", "trae token -> access_token");
  eq(t.nickname, "t号", "trae name -> nickname");
  eq(t.expires_at, undefined, "无到期则省略 expires_at");

  eq(pm.toCockpitAccount({ channel: "raccoon", token: "X" }), null, "号池独有渠道导出返回 null");
})();

// ===== 6) 转移包组装 =====
(function testBuildBundle() {
  const rows = [
    { id: "1", channel: "zcode", uid: "z1", name: "z1", token: "J1", refreshToken: "R1", createdAt: 1700000000000, updatedAt: 1700000000000, meta: { email: "z1@e.com" } },
    { id: "2", channel: "trae", uid: "t1", name: "t1", token: "A1", refreshToken: "R1", createdAt: 1700000000000, updatedAt: 1700000000000, meta: {} },
    { id: "3", channel: "raccoon", uid: "r1", name: "r1", token: "X", refreshToken: "", createdAt: 1, updatedAt: 1, meta: {} },
  ];
  const { bundle, skipped } = pm.buildTransferBundle(rows);
  eq(bundle.schema, pm.COCKPIT_SCHEMA, "组装包 schema");
  eq(bundle.version, 1, "组装包 version");
  eq(bundle.summary.platform_count, 2, "platform_count 只算可导出平台");
  eq(bundle.summary.account_count, 2, "account_count 只算可导出账号");
  eq(Object.keys(bundle.platforms).sort(), ["trae", "zcode"], "平台键正确");
  eq(bundle.platforms.zcode.account_count, 1, "zcode 平台计数");
  eq(bundle.platforms.zcode.exported_data[0].zcode_jwt_token, "J1", "zcode 导出含 jwt");
  eq(skipped.map((s) => s.channel), ["raccoon"], "raccoon 记入 skipped");
  ok(typeof bundle.exported_at === "string" && bundle.exported_at.includes("T"), "exported_at 为 ISO 串");
})();

// ===== 7) 结构体特征判别 =====
(function testLooksLike() {
  ok(pm.looksLikeCockpitZcode({ zcode_jwt_token: "J", provider: "zai" }), "识别 zcode 结构体");
  ok(!pm.looksLikeCockpitZcode({ zcode_jwt_token: "J" }), "缺 provider/auth_mode 不算 zcode 结构体");
  ok(pm.looksLikeCockpitStruct({ access_token: "A", created_at: 1 }), "识别 trae 家族结构体");
  ok(!pm.looksLikeCockpitStruct({ access_token: "A", channel: "trae" }), "带号池 channel 字段不误判");
  ok(!pm.looksLikeCockpitStruct({ access_token: "A" }), "缺结构体伴生字段不误判（避免吞号池格式）");
  ok(!pm.looksLikeCockpitStruct({ email: "x@e.com" }), "无凭据不算结构体");
})();

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
