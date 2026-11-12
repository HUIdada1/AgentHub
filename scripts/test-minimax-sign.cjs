/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// MiniMax 渠道离线自测（不联网）：把「签名/设备号/公共参数」与「面板/信封判定」钉成固定向量。
//
// 为什么必须有这一份：签名与公共参数是本渠道**唯一的硬约束**——上游不校验 device_id 绑定、
// 也不要求 yy 头，唯独 x-signature 错一位就 401。把它钉成固定期望值，日后谁重构
// sign.cjs 或 adapter 的 call()，都会在这里先炸，而不是等用户报「全部账号失效」。
//
// 跑法：node scripts/test-minimax-sign.cjs
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const sign = require(path.join(__dirname, "..", "electron", "backend", "proxy", "minimax", "sign.cjs"));

// ===== 1. 签名固定向量 =====
// md5("1700000000" + "I*7Cf%WZ#S&%1RlZJ&C2") —— 2026-11-12 用真实账号回测通过的同一算法。
assert.equal(sign.sign(1700000000, ""), "05064c6d0266350eeac121b673536c14", "空 body 的签名向量漂移");
assert.notEqual(sign.sign(1700000000, ""), sign.sign(1700000000, "{}"), "body 不同必须签名不同");
assert.equal(sign.sign(1700000000, ""), sign.sign("1700000000", null), "ts 字符串与空 body 必须同值");

// ===== 2. 账号设备号：8 位十进制、同 uid 稳定、不同 uid 分散 =====
const dev = sign.deviceIdOf("577191951028207624");
assert.match(dev, /^[1-9]\d{7}$/, "device_id 必须是 8 位十进制且不以 0 开头");
assert.equal(dev, sign.deviceIdOf("577191951028207624"), "同 uid 必须稳定（重装不漂移）");
assert.notEqual(dev, sign.deviceIdOf("577191951028207625"), "不同 uid 不应撞同一枚指纹");

// ===== 3. 公共 query：键集合与客户端逐字一致 =====
const required = [
  "device_platform", "biz_id", "app_id", "version_code", "unix", "timezone_offset",
  "is_desktop", "desktop_version", "sys_language", "lang", "uuid", "device_id",
  "os_name", "browser_name", "device_memory", "cpu_core_num", "browser_language",
  "browser_platform", "user_id", "screen_width", "screen_height", "client",
];
const q = sign.commonQuery(dev, { now: 1700000000000, uuid: "00000000-0000-4000-8000-000000000000" });
for (const key of required) assert.ok(Object.hasOwn(q, key), `公共参数缺 ${key}`);
assert.equal(q.biz_id, "3");
assert.equal(q.app_id, "3001");
assert.equal(q.client, "desktop");
assert.equal(q.device_id, dev);
assert.equal(q.unix, "1700000000000", "unix 必须是毫秒");

// queryString 必须保序且编码完整（签名不含 query，但上游按顺序读参数）
const qs = sign.queryString({ a: "1", b: "x y", c: undefined });
assert.equal(qs, "a=1&b=x+y", "undefined 必须被跳过");

// ===== 4. 适配器的信封判定：HTTP 200 也可能失败 =====
const adapters = require(path.join(__dirname, "..", "electron", "backend", "proxy", "management-adapters.cjs"));
const ad = adapters.get("minimax");
assert.ok(ad, "minimax 适配器必须已注册");

// 契约必需方法
for (const m of ["cfg", "models", "queryCredits", "checkin", "checkinStatus", "refreshToken", "tokenExpiresAt"]) {
  assert.equal(typeof ad[m], "function", `适配器缺 ${m}()`);
}
assert.equal(ad.refreshWindowSec, 3600, "预刷新窗口应为 1 小时（access 约 12h）");
assert.deepEqual(ad.models(), ["MiniMax-M3", "MiniMax-M3.1-Flash"], "静态目录必须与插件同一份口径");

// 200 + base_resp.status_code !== 0 → 必须判失败
const badEnvelope = ad.verdict({ ok: true, status: 200, data: { base_resp: { status_code: 1001, status_msg: "余额不足" } } });
assert.equal(badEnvelope.ok, false, "base_resp 非 0 必须判失败");
assert.match(badEnvelope.message, /余额不足/);

// 401 / 402 / 429 的分类
assert.equal(ad.verdict({ ok: false, status: 401 }).authError, true, "401 必须走凭证失效");
assert.equal(ad.verdict({ ok: false, status: 402 }).quota, true, "402 必须走积分不足");
assert.equal(ad.verdict({ ok: false, status: 429 }).rateLimit, true, "429 必须走限流");
assert.equal(ad.verdict({ ok: true, status: 200, data: { base_resp: { status_code: 0 } } }).ok, true, "正常信封必须通过");

// ===== 5. 七日面板解析：今日项与三类状态 =====
const panel = ad.panelOf({
  data: {
    scene: 2,
    days: [
      { day_no: 1, points: 400, is_today: true, status: 3 },
      { day_no: 2, points: 400, is_today: false, status: 1 },
      { day_no: 3, points: 400, is_today: false, status: 1 },
      { day_no: 4, points: 1000, is_today: false, status: 1 },
      { day_no: 5, points: 400, is_today: false, status: 1 },
      { day_no: 6, points: 400, is_today: false, status: 1 },
      { day_no: 7, points: 1000, is_today: false, status: 1 },
    ],
  },
});
assert.equal(panel.days.length, 7, "面板必须 7 天");
assert.equal(panel.today.day_no, 1, "今日项必须按 is_today 命中");
assert.equal(panel.today.status, 3, "已签到的 status 是 3");

// 面板缺 today 时不能抛错（上游换形态时降级而非崩溃）
assert.equal(ad.panelOf({ data: { days: [] } }).today, null);

// ===== 6. tokenExpiresAt：非 JWT 凭据的唯一到期来源 =====
assert.equal(ad.tokenExpiresAt({ meta: { expiresAtMs: 1794512634715 } }), 1794512634715);
assert.equal(ad.tokenExpiresAt({ meta: {} }), 0, "缺失必须回 0（调用方回落 JWT 口径）");
assert.equal(ad.tokenExpiresAt(null), 0, "空 secrets 不得抛错");

// ===== 7. auth.json：读文件优先 + 原子写回（临时目录，绝不碰真实 home）=====
const fs = require("node:fs");
const os = require("node:os");
const pathMod = require("node:path");
const authstore = require(path.join(__dirname, "..", "electron", "backend", "proxy", "minimax", "authstore.cjs"));

const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "mm-auth-"));
const authFile = pathMod.join(tmpDir, "auth.json");
const KEY = "com.minimax.mcode.oauth.prod.cn subj";
function fixture(token, refresh, exp, gen) {
  const body = {
    schemaVersion: 1,
    records: {
      [KEY]: {
        schemaVersion: 1, accessToken: token, refreshToken: refresh, tokenType: "Bearer",
        clientId: "mcode-public", scopes: ["agent.default"], audience: "agent-backend",
        expiresAtMs: exp, generation: gen, loginEpoch: "epoch-1",
      },
      // 同一文件里的另一个账号：写回时**必须原样保留**（多账号共用一份 auth.json）
      "com.minimax.mcode.oauth.prod.cn other": {
        schemaVersion: 1, accessToken: "mmoat_other", refreshToken: "mmort_other",
        clientId: "mcode-public", expiresAtMs: 1, generation: 1, loginEpoch: "epoch-2",
      },
    },
  };
  fs.writeFileSync(authFile, JSON.stringify(body));
}

const authAccount = {
  id: "a1", channel: "minimax", uid: "u1",
  meta: { authFile, region: "cn", clientId: "mcode-public", loginEpoch: "epoch-1", expiresAtMs: Date.now() + 1000 },
};
const authSecrets = { token: "mmoat_old", refreshToken: "mmort_old", meta: authAccount.meta };

// 文件不比库新 → 不采纳（走正常刷新）
fixture("mmoat_old", "mmort_old", Date.now() + 1000, 1);
assert.equal(authstore.adoptNewer(authAccount, authSecrets), null, "文件更旧时必须返回 null");

// 桌面端已刷新（文件到期更晚）→ 直接采纳，不消耗 refresh 轮换
fixture("mmoat_new", "mmort_new", Date.now() + 3600e3, 5);
const adopted = authstore.adoptNewer(authAccount, authSecrets);
assert.equal(adopted && adopted.token, "mmoat_new", "文件更新时必须采纳");
assert.ok(adopted.expiresAtMs > Date.now(), "采纳的凭据必须仍在有效期");

// 写回守卫：文件里的 refreshToken 已被桌面端换过 → 拒绝覆盖（否则顶掉对方刚写的凭据）
const denied = authstore.writeBack(authAccount, authSecrets, { token: "mmoat_x", refreshToken: "mmort_x", expiresAtMs: Date.now() + 7200e3 });
assert.equal(denied.ok, false, "桌面端已轮换时必须拒绝写回");
assert.equal(denied.reason, "rotated-elsewhere");

// 正常写回：只改目标 record，另一条与未知字段原样保留，临时文件不残留
fixture("mmoat_old", "mmort_old", Date.now() + 1000, 1);
const wb = authstore.writeBack(authAccount, authSecrets, { token: "mmoat_next", refreshToken: "mmort_next", expiresAtMs: Date.now() + 7200e3 });
assert.equal(wb.ok, true, "正常情况下必须写回成功");
const after = JSON.parse(fs.readFileSync(authFile, "utf8"));
assert.equal(after.records[KEY].accessToken, "mmoat_next");
assert.equal(after.records[KEY].refreshToken, "mmort_next");
assert.equal(after.records[KEY].generation, 2, "generation 必须递增");
assert.equal(after.records[KEY].scopes[0], "agent.default", "未知字段必须保留");
assert.equal(after.records["com.minimax.mcode.oauth.prod.cn other"].accessToken, "mmoat_other", "其它账号必须原样保留");
assert.equal(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp")).length, 0, "临时文件必须被 rename 掉");

// 文件不存在时不得凭空新建
const missing = authstore.writeBack({ id: "a2", channel: "minimax", meta: { authFile: pathMod.join(tmpDir, "nope.json") } }, { token: "mmoat_old", refreshToken: "mmort_old", meta: {} }, { token: "mmoat_x", refreshToken: "mmort_x", expiresAtMs: Date.now() + 1000 });
assert.equal(missing.ok, false);
assert.equal(missing.reason, "no-record");
assert.equal(fs.existsSync(pathMod.join(tmpDir, "nope.json")), false, "不得新建登录态文件");

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("PASS MiniMax 本体：签名向量 / 设备号 / 公共参数 / 信封判定 / 七日面板 / 到期钩子 / 登录态写回");
