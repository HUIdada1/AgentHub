/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 额度到期口径回归自测（issue #152 的验收用例）
//
// 背景：accounts.expires_at 被「登录 token 有效期」与「积分到期时间」两种语义共用。
// AutoClaw 的余额接口明确返回 expiresAt: 0（积分无统一到期），但旧实现用 `||` 把 0
// 当成「adapter 没提供」，刷新时把登录写入的 token 有效期永久回填；随后 pickAccount()
// 每个请求都按「余额已到期」把账号标成 exhausted，且该分支写 coolUntil: 0，使
// effectiveStatus() 的次日 04:00 复活判据（要求 cool_until 非 0）永远不成立 ——
// 账号就此在「刷新余额短暂复活 → 下一个请求立刻秒死」之间循环。
//
// 本自测锁住三件事，防止口径回潮：
//   ① adapter 明确返回 expiresAt: 0 → 落库必须为 0（不得回填旧 token 到期）；
//   ② adapter 缺省 expiresAt（undefined/null）→ 沿用库内旧值（不得把「没给」误清成 0）；
//   ③「余额已到期」分支必须写次日 04:00 的复活锚点，且 expires_at=0 的号可正常被选中。
//
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-credits-expiry-selftest.cjs <临时数据目录>
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credit-expiry-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub；CI 另用 AGENTHUB_DATA_DIR 沙箱
// 非 Windows 本机直跑时 APPDATA 不生效，补一个数据目录沙箱，避免自测读写真实用户库（CI 已显式传入，不覆盖）
if (!process.env.AGENTHUB_DATA_DIR) process.env.AGENTHUB_DATA_DIR = tmp;

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/management-adapters.cjs");
  const credits = require("../electron/backend/proxy/credits.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  store.open();

  const origGet = adapters.get;
  try {
    // ① AutoClaw：明确 0 = 无到期，必须清掉登录写入的 token 有效期
    const tokenExp = Date.now() + 24 * 3600 * 1000;
    const autoId = store.addAccount({
      channel: "autoclaw",
      uid: "expiry-auto",
      name: "AutoClaw 自测",
      token: "auto-token",
      source: "paste",
      expiresAt: tokenExp,
    });
    adapters.get = (ch) =>
      ch === "autoclaw" ? { queryCredits: async () => ({ credits: 123.45, expiresAt: 0 }) } : origGet.call(adapters, ch);
    const r1 = await credits.refreshAccount(autoId);
    const a1 = store.getAccount(autoId);
    assert(a1.expires_at === 0, `expiresAt:0 必须落库为 0（实际 ${a1.expires_at}，旧实现会回填 ${tokenExp}）`);
    assert(r1.expiresAt === 0, `刷新返回的 expiresAt 必须为 0（实际 ${r1.expiresAt}）`);
    assert(a1.status === "online", `余额正常时账号应保持 online（实际 ${a1.status}）`);

    // ② 字段缺省 = adapter 没提供：沿用库内旧到期，不得误清
    const keepExp = Date.now() + 10 * 24 * 3600 * 1000;
    const traeId = store.addAccount({
      channel: "trae",
      uid: "expiry-trae",
      name: "Trae 自测",
      token: "trae-token",
      source: "paste",
      expiresAt: keepExp,
    });
    adapters.get = (ch) =>
      ch === "trae" ? { queryCredits: async () => ({ credits: 50 }) } : origGet.call(adapters, ch);
    await credits.refreshAccount(traeId);
    const a2 = store.getAccount(traeId);
    assert(a2.expires_at === keepExp, `缺省 expiresAt 必须沿用旧值 ${keepExp}（实际 ${a2.expires_at}）`);

    // ③ 余额已到期：标 exhausted 的同时必须给出「次日 04:00」复活锚点，不能写 0
    const expiredId = store.addAccount({
      channel: "trae",
      uid: "expiry-expired",
      name: "已到期自测",
      token: "expired-token",
      source: "paste",
      expiresAt: Date.now() - 1000,
    });
    store.updateAccount(expiredId, { credits: 999, creditsAt: Date.now(), status: "online", coolUntil: 0 });
    const picked = pool.pickAccount("trae", "expire_first", [traeId], 0);
    const a3 = store.getAccount(expiredId);
    assert(picked === null, "余额已到期的账号不应被选中");
    assert(a3.status === "exhausted", `余额已到期应标 exhausted（实际 ${a3.status}）`);
    assert(a3.cool_until > Date.now(), `cool_until 必须是未来的复活锚点（实际 ${a3.cool_until}）`);
    const revive = new Date(a3.cool_until);
    assert(
      revive.getHours() === 4 && revive.getMinutes() === 0 && revive.getSeconds() === 0,
      `cool_until 必须落在次日 04:00（实际 ${revive.toString()}）`
    );

    // ④ expires_at = 0（无到期）的号必须正常可调度
    const noExpId = store.addAccount({
      channel: "raccoon",
      uid: "expiry-none",
      name: "无到期自测",
      token: "raccoon-token",
      source: "paste",
      expiresAt: 0,
    });
    store.updateAccount(noExpId, { credits: 10, creditsAt: Date.now(), status: "online" });
    const picked2 = pool.pickAccount("raccoon", "expire_first", [], 0);
    assert(picked2 && picked2.id === noExpId, "expires_at=0 的账号必须可被选中（0 = 无到期/长期有效）");
  } finally {
    adapters.get = origGet;
  }

  console.log("proxy-credits-expiry-selftest: 全部断言通过（#152 到期口径 ①~④）");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
