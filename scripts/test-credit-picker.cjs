/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 跨渠道「积分优先」选号器回归（credit-picker.cjs）：
//   · 三档顺序：免费 → 有效到期（按 expiresAt 升序）→ 永久/未知垫底；
//   · 跨渠道：声明顺序靠后的免费号压过排在前面的永久号；到期早压过积分多；
//   · 排除：本轮已试账号 / 渠道关闭 / 渠道冷却 / 账号级目录白名单；
//   · 组成员级排重（同渠道不同实际模型分开判死）；
//   · 显式渠道指定（模型覆盖 / 渠道锁定）优先 + 故障转移回落；
//   · preview 给出可用顺序与不可用原因，且全程只读（不改 lastUsed）。
//
// 跑法：node scripts/run-all-tests.cjs 会自动带上本文件；
// 单跑需要 node:sqlite → ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <本文件>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credit-picker-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

const store = require("../electron/backend/proxy/store.cjs");
const routing = require("../electron/backend/localgw/routing.cjs");
const creditPicker = require("../electron/backend/localgw/credit-picker.cjs");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  passed++;
  console.log(`PASS ${name}`);
}

const now = Date.now();
const DAY = 86400000;
function provider(id) {
  store.saveProvider({ id, kind: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", models: [{ model: "m1" }, { model: "m2" }] });
}
function account(channel, { token, credits, expiresAt = 0, billingKind = "unknown" }) {
  return store.addAccount({ channel, uid: `${channel}-${token}`, name: token, token, source: "paste", expiresAt, meta: { gateway: { billingKind } } });
}
function setCredits(id, credits) { store.updateAccount(id, { credits, creditsAt: now }); }

for (const id of ["cp_a", "cp_b", "cp_c", "cp_d"]) provider(id);
const aFree = account("cp_a", { token: "tok-a-free", credits: 5, expiresAt: now + DAY, billingKind: "free" });
const aSoon = account("cp_a", { token: "tok-a-soon", credits: 10, expiresAt: now + 2 * DAY, billingKind: "paid" });
const aLate = account("cp_a", { token: "tok-a-late", credits: 999, expiresAt: now + 9 * DAY, billingKind: "paid" });
const bSoon = account("cp_b", { token: "tok-b-soon", credits: 20, expiresAt: now + 3 * DAY, billingKind: "paid" });
const bLate = account("cp_b", { token: "tok-b-late", credits: 999, expiresAt: now + 30 * DAY, billingKind: "paid" });
const cPermanent = account("cp_c", { token: "tok-c-perm", credits: 9999, expiresAt: 0, billingKind: "permanent" });
const dUnknown = account("cp_d", { token: "tok-d-unknown", credits: 9999, expiresAt: 0, billingKind: "unknown" });
setCredits(aFree, 5); setCredits(aSoon, 10); setCredits(aLate, 999);
setCredits(bSoon, 20); setCredits(bLate, 999); setCredits(cPermanent, 9999); setCredits(dUnknown, 9999);
for (const id of [aFree, aSoon, aLate, bSoon, bLate, cPermanent, dUnknown]) {
  store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "" });
}

const B = (channel, realModel = "m1", extra = {}) => ({ channel, realModel, ...extra });
const byChannel = (channel) => (binding) => binding.channel === channel;

// ---------- 1. 三档：免费 > 到期近 > 到期远 > 永久/未知 ----------
check("跨渠道：声明顺序靠后的免费号仍然第一（免费档压过一切）", () => {
  const bindings = [B("cp_c"), B("cp_d"), B("cp_b"), B("cp_a")];
  const hit = creditPicker.pick({ bindings });
  assert.equal(hit.binding.channel, "cp_a");
  assert.equal(hit.row.account.id, aFree);
});

check("同渠道内：免费号先于到期号，且不是按积分数额排", () => {
  const hit = creditPicker.pick({ bindings: [B("cp_a")] });
  assert.equal(hit.row.account.id, aFree, "免费号 credits=5 也要压过 paid 999");
});

check("跨渠道：到期早的压过积分多的（bSoon 20 分 / +3d 先于 aLate 999 分 / +9d）", () => {
  const bindings = [B("cp_b"), B("cp_a")];
  const tried = new Map([["cp_a", new Set([aFree, aSoon])]]);
  const hit = creditPicker.pick({ bindings, triedAccounts: tried, scopeOf: (b) => b.channel });
  assert.equal(hit.row.account.id, bSoon);
});

check("永久 / 未知合并垫底：同档内按绑定声明顺序（不比金额）", () => {
  const hit1 = creditPicker.pick({ bindings: [B("cp_d"), B("cp_c")] });
  assert.equal(hit1.row.account.id, dUnknown, "同档按声明顺序：cp_d 在前");
  const hit2 = creditPicker.pick({ bindings: [B("cp_c"), B("cp_d")] });
  assert.equal(hit2.row.account.id, cPermanent);
  // 只要有会过期的额度，永久/未知都不许插队
  const hit3 = creditPicker.pick({ bindings: [B("cp_c"), B("cp_d"), B("cp_b")] });
  assert.equal(hit3.row.account.id, bSoon);
});

// ---------- 2. 排除条件 ----------
check("排除：本轮已试账号不参与，且不影响同渠道其它号", () => {
  const bindings = [B("cp_a")];
  const tried = new Map([["cp_a", new Set([aFree, aSoon])]]);
  const hit = creditPicker.pick({ bindings, triedAccounts: tried, scopeOf: (b) => b.channel });
  assert.equal(hit.row.account.id, aLate);
});

check("排除：账号级目录白名单（catalogExcludeAccounts）剔除指定账号", () => {
  const hit = creditPicker.pick({
    bindings: [B("cp_a")],
    catalogExcludeAccounts: () => [aFree],
  });
  assert.equal(hit.row.account.id, aSoon, "免费号被目录白名单排除后应落到次优");
});

check("排除：本轮已排除渠道（密钥范围 / 故障转移已试）", () => {
  const hit = creditPicker.pick({ bindings: [B("cp_a"), B("cp_b")], excludeChannels: new Set(["cp_a"]) });
  assert.equal(hit.binding.channel, "cp_b");
  assert.equal(hit.row.account.id, bSoon);
});

check("排除：渠道关闭后不参与", () => {
  routing.setChannelEnabled("cp_b", false);
  try {
    const hit = creditPicker.pick({ bindings: [B("cp_b"), B("cp_a")] });
    assert.equal(hit.binding.channel, "cp_a");
  } finally { routing.setChannelEnabled("cp_b", true); }
});

check("排除：渠道冷却中不参与，恢复后回到候选", () => {
  routing.markFailed("cp_a");
  try {
    const hit = creditPicker.pick({ bindings: [B("cp_a"), B("cp_b")] });
    assert.equal(hit.binding.channel, "cp_b");
  } finally { routing.markSucceeded("cp_a"); }
  const restored = creditPicker.pick({ bindings: [B("cp_a"), B("cp_b")] });
  assert.equal(restored.binding.channel, "cp_a");
});

check("排除：组成员级排重按「渠道+实际模型」分键，同渠道第二个模型仍可作为候选", () => {
  const bindings = [B("cp_a", "m1", { groupName: "g" }), B("cp_a", "m2", { groupName: "g" })];
  const tried = new Map([[routing.groupMemberKey(bindings[0]), new Set([aFree])]]);
  const hit = creditPicker.pick({ bindings, triedAccounts: tried, scopeOf: (b) => routing.groupMemberKey(b) });
  assert.equal(hit.binding.realModel, "m2");
  assert.equal(hit.row.account.id, aFree);
});

check("全部不可用：回 null（调用方据此 503）", () => {
  const hit = creditPicker.pick({ bindings: [B("cp_a")], excludeChannels: new Set(["cp_a"]) });
  assert.equal(hit, null);
});

// ---------- 3. 显式指定优先 ----------
check("显式渠道指定：先只在该渠道挑；挑不到且开故障转移才回落全部", () => {
  const explicit = creditPicker.pickWithExplicit({ bindings: [B("cp_b"), B("cp_a")], explicitChannel: "cp_b", failover: true });
  assert.equal(explicit.binding.channel, "cp_b");
  assert.equal(explicit.row.account.id, bSoon);
  const fallback = creditPicker.pickWithExplicit({ bindings: [B("cp_b"), B("cp_a")], explicitChannel: "ghost", failover: true });
  assert.equal(fallback.binding.channel, "cp_a");
  const strict = creditPicker.pickWithExplicit({ bindings: [B("cp_b"), B("cp_a")], explicitChannel: "ghost", failover: false });
  assert.equal(strict, null, "故障转移关闭时必须直接失败，不能偷偷换渠道");
});

// ---------- 4. 只读预览 ----------
check("preview：可用在前（按同一排序），不可用在后并带原因", () => {
  const rows = creditPicker.preview({ bindings: [B("cp_b"), B("ghost"), B("cp_a")] });
  assert.deepEqual(rows.filter((r) => r.row).map((r) => r.binding.channel), ["cp_a", "cp_b"]);
  const blocked = rows.filter((r) => !r.row);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].binding.channel, "ghost");
  assert.ok(blocked[0].reason.includes("没有可用账号"), blocked[0].reason);
});

check("preview / pick 全程只读：不更新 lastUsed、不改账号状态", () => {
  const before = store.listAccounts().find((a) => a.id === aFree);
  const stale = creditPicker.preview({ bindings: [B("cp_a")] });
  assert.ok(stale.length > 0 && stale[0].row);
  const after = store.listAccounts().find((a) => a.id === aFree);
  assert.equal(after.lastUsed, before.lastUsed);
  assert.equal(after.status, before.status);
});

console.log(`\n全部通过：${passed} 项`);
store.close();
fs.rmSync(dataDir, { recursive: true, force: true });
