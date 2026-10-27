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
// 号池状态机单测（审查整改 M2）：
//  ① deriveAccountCredits：-1 不限哨兵 / expiresAt=0 长期有效 / 混合包（过期+不限）/ 全部过期 / 无包→null
//  ② effectiveStatus：cooling/exhausted 到期回 online；未到点不变
//  ③ releaseCool：cooling/exhausted/relogin 三态都收 + 模型级负缓存连带清理（内存 + 落库）
//  ④ updateStatus === releaseCool：状态机唯一写入口（F3 整改的护栏）
//  ⑤ noteCheckin 台账：day 字段与 dayStr 同口径（跨天由前端判过期）
// 跑法（store.cjs 用 node:sqlite，需要 Electron 内建模块）：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-pool-state-machine.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-pool-sm-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
const pool = require(path.join(ROOT, "electron", "backend", "proxy", "pool.cjs"));

process.on("exit", () => { try { store.close(); } catch { /* 报错退出，关不掉不影响结论 */ } });

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const NOW = Date.now();

console.log("[1] deriveAccountCredits：-1 不限哨兵 / expiresAt=0 长期有效 / 混合包 / 全部过期 / 无包");
{
  // 空数组 → null
  ok(pool.deriveAccountCredits([]) === null, "空包 → null（保留调用方旧值）");
  ok(pool.deriveAccountCredits(null) === null, "非数组 → null");
  // -1 不限哨兵（remaining=-1）→ credits=-1
  ok(pool.deriveAccountCredits([{ remaining: -1, expiresAt: 0 }]).credits === -1, "remaining=-1 → 不限");
  // expiresAt=0 长期有效：credits 累计，expiresAt=0
  const r1 = pool.deriveAccountCredits([{ remaining: 100, expiresAt: 0 }]);
  ok(r1.credits === 100 && r1.expiresAt === 0, "expiresAt=0 长期有效");
  // 混合包：过期 + 未过期 → 只算未过期
  const r2 = pool.deriveAccountCredits([
    { remaining: 50, expiresAt: NOW - 86400000 },  // 昨天已过期
    { remaining: 200, expiresAt: NOW + 86400000 }, // 明天到期
  ]);
  ok(r2.credits === 200, "过期包不计入余额");
  ok(r2.expiresAt === NOW + 86400000, "expiresAt = min(未过期包到期)");
  // 全部过期 → expiresAt=0
  const r3 = pool.deriveAccountCredits([
    { remaining: 100, expiresAt: NOW - 86400000 },
  ]);
  ok(r3.credits === 0 && r3.expiresAt === 0, "全部过期 → credits=0, expiresAt=0");
  // allExpired 标记（F19）：credits=0 且 expiresAt=0 与「长期有效」同形，必须靠这个布尔位区分，
  // 否则 pickAccount 的「余额已到期」判据会把「全过期」当有效余额一直调度
  ok(r3.allExpired === true, "全部过期 → allExpired=true（F19 判据）");
  ok(r1.allExpired === false, "长期有效包（expiresAt=0）→ allExpired=false");
  ok(r2.allExpired === false, "混合包（有未过期）→ allExpired=false");
  ok(pool.deriveAccountCredits([{ remaining: -1, expiresAt: 0 }]).allExpired === false, "不限额度包 → allExpired=false");
  // 无到期时间的包（expiresAt 缺省=0）算长期有效，不得被判成全过期
  ok(pool.deriveAccountCredits([{ remaining: 5 }]).allExpired === false, "expiresAt 缺省 → 长期有效，不算全过期");
}

console.log("[2] effectiveStatus：cooling/exhausted 到期回 online");
{
  // 未到点 → 原样
  ok(pool.effectiveStatus({ status: "cooling", cool_until: NOW + 60000 }) === "cooling", "cooling 未到点 → cooling");
  ok(pool.effectiveStatus({ status: "exhausted", cool_until: NOW + 60000 }) === "exhausted", "exhausted 未到点 → exhausted");
  // 已到点 → online
  ok(pool.effectiveStatus({ status: "cooling", cool_until: NOW - 1000 }) === "online", "cooling 到点 → online");
  ok(pool.effectiveStatus({ status: "exhausted", cool_until: NOW - 1000 }) === "online", "exhausted 到点 → online");
  // 无 cool_until（0）→ 原样
  ok(pool.effectiveStatus({ status: "relogin", cool_until: 0 }) === "relogin", "relogin 无 cool_until → relogin");
  // online/disabled → 原样
  ok(pool.effectiveStatus({ status: "online", cool_until: 0 }) === "online", "online → online");
  ok(pool.effectiveStatus({ status: "disabled", cool_until: 0 }) === "disabled", "disabled → disabled");
}

console.log("[3] releaseCool：cooling/exhausted/relogin 三态都收 + 模型级负缓存连带清理");
{
  // 先造一个账号
  const accId = store.addAccount({ channel: "test", uid: "test-uid", name: "Test", token: "tk", refreshToken: "rt" });
  // 造冷却状态
  store.updateAccount(accId, { status: "cooling", coolUntil: NOW + 60000, coolReason: "test" });
  // 造模型级负缓存
  store.upsertModelCooldown(accId, "model-a", NOW + 3600000, "6004 test");
  store.upsertModelCooldown(accId, "model-b", NOW + 7200000, "11102 test");
  // 验证负缓存存在
  ok(store.listModelCooldowns().length >= 2, "负缓存已落库");
  // releaseCool
  const r = pool.releaseCool(accId);
  ok(r.ok === true, "cooling 态 releaseCool 返回 ok");
  ok(r.releasedModels === 2, `释放 2 个模型级负缓存（实际 ${r.releasedModels}）`);
  const after = store.getAccount(accId); // getAccount 返回原始行（cool_until 下划线命名）
  ok(after.status === "online" && after.cool_until === 0 && (after.cool_reason || "") === "", "cooling → online + 清冷却字段");
  ok(store.listModelCooldowns().filter((c) => c.accId === accId).length === 0, "负缓存已清库");
  // 重复调用：不在冷却中
  const r2 = pool.releaseCool(accId);
  ok(r2.ok === false && r2.message === "该账号不在冷却中", "重复 releaseCool 返回 ok:false");
}

console.log("[3b] exhausted / relogin 也收（F3 整改覆盖）");
{
  const accId2 = store.addAccount({ channel: "test", uid: "test-uid2", name: "Test2", token: "tk", refreshToken: "rt" });
  store.updateAccount(accId2, { status: "exhausted", coolUntil: NOW + 86400000, coolReason: "余额不足" });
  const r = pool.releaseCool(accId2);
  ok(r.ok === true, "exhausted 态 releaseCool 返回 ok");
  ok(store.getAccount(accId2).status === "online", "exhausted → online");

  const accId3 = store.addAccount({ channel: "test", uid: "test-uid3", name: "Test3", token: "tk", refreshToken: "rt" });
  store.updateAccount(accId3, { status: "relogin", coolUntil: 0, coolReason: "凭证失效" });
  const r3 = pool.releaseCool(accId3);
  ok(r3.ok === true, "relogin 态 releaseCool 返回 ok");
  ok(store.getAccount(accId3).status === "online", "relogin → online");
}

console.log("[4] updateStatus === releaseCool（F3 唯一写入口护栏）");
{
  ok(typeof pool.updateStatus === "function", "updateStatus 已导出");
  const accId4 = store.addAccount({ channel: "test", uid: "test-uid4", name: "Test4", token: "tk", refreshToken: "rt" });
  store.updateAccount(accId4, { status: "cooling", coolUntil: NOW + 60000, coolReason: "test" });
  const r = pool.updateStatus(accId4);
  ok(r.ok === true && store.getAccount(accId4).status === "online", "updateStatus 与 releaseCool 行为一致");

  // [4b] 「启用被停用的账号」必须能被拉回 online（回归钉子）：
  // releaseCool 只收 cooling/exhausted/relogin 三态，disabled 不在其中——只传 id 时它返回
  // ok:false 且不写库，「启用」按钮就成了静默空操作（点完刷新仍是停用）。调用方必须显式传 patch。
  const accId6 = store.addAccount({ channel: "test", uid: "test-uid6", name: "Test6", token: "tk", refreshToken: "rt" });
  store.updateAccount(accId6, { status: "disabled" });
  ok(pool.updateStatus(accId6).ok === false, "只传 id 时 disabled 不在冷却三态内（返回 ok:false）");
  const r6 = pool.updateStatus(accId6, { status: "online", coolUntil: 0, coolReason: "" });
  ok(r6.ok === true && store.getAccount(accId6).status === "online", "带 patch 的 updateStatus 把 disabled 拉回 online");
  ok(pool.updateStatus("__不存在的账号__", { status: "online" }).ok === false, "账号不存在时带 patch 也不写库");
}

console.log("[5] noteCheckin 台账：day 字段与 dayStr 同口径");
{
  const accId5 = store.addAccount({ channel: "test", uid: "test-uid5", name: "Test5", token: "tk", refreshToken: "rt" });
  store.noteCheckin(accId5, { ok: true, message: "签到成功" }, "checkin");
  const meta = store.getAccount(accId5).meta;
  const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
  ok(parsed.checkin && parsed.checkin.day === store.dayStr(), "checkin.day 与 dayStr() 同口径");
  ok(parsed.checkin.ok === true, "checkin.ok 落库");
}

console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
