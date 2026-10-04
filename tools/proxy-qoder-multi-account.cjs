// 反代网关 · Qoder 多账号互斥探针（P0-1）—— 可重复执行
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-multi-account.cjs [--write-back]
//
// 回答的问题：登录/切换 Qoder 客户端账号，是否会吊销其它已导入账号的凭据？
//
// 方法（对库里**所有** Qoder 账号逐一回测三项）：
//   ① queryCredits（纯 Bearer，无签名）—— 验证 access token 是否仍被接受
//   ② refreshToken（token 轮换）        —— 验证 refresh token 是否仍可用
//   ③ chat（完整 wasm 签名链）          —— 验证端到端推理是否仍可走通
//
// 预期（2026-10-04 实测结论）：三项全部成功 → 账号间无互斥。
// 若某项返回 401/authError，说明该账号被吊销（即存在互斥），脚本会如实报出。
//
// --write-back：把刷新后的最新凭据对写回客户端 auth.v1.dat，
//   使桌面端与 AgentHub 持有同一代凭据（写回前校验 uid 一致，避免串号）。
//
// 数据源：**读真实库**（不隔离）。原因：多账号是"分时登录、逐次导入"积累的，
//   隔离库每次都是空的、只能看到当前登录的那一个账号，互斥对比永远凑不齐 2 个。
//   安全性：本脚本只调用适配器的 queryCredits/refreshToken/chat，三者都**不写库**
//   （refreshToken 只把新凭据返回给调用方；落库发生在 server 层）。故读真实库无副作用。
//   唯一会改状态的是 --write-back（显式传入才写客户端 auth.v1.dat）。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const WRITE_BACK = process.argv.includes("--write-back");

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");

  store.open();
  rules.init();

  const list = store.listAccounts("qoder");
  console.log(`Qoder 账号数: ${list.length}（读真实库；如需补充账号，请到客户端切号后跑一次本机导入）`);
  if (list.length < 2) {
    console.log("  · 少于 2 个账号，无法做互斥对比。");
    console.log("    做法：客户端登录 A → 用「从本机软件导入」加进 AgentHub → 切 B → 再导入 → 切回 A → 跑本脚本。");
    return;
  }
  for (const a of list) console.log(`  · ${String(a.uid).slice(0, 14)}…  ${a.name || "-"}  status=${a.status}`);

  const ad = adapters.get("qoder");
  const results = [];

  for (const acc of list) {
    const sec = store.accountSecrets(store.getAccount(acc.id));
    const tag = String(acc.uid).slice(0, 12);
    const row = { uid: tag, quota: "", refresh: "", chat: "", revoked: false };
    console.log(`\n=== 账号 ${tag}… ===`);

    // ① 额度（纯 Bearer）
    try {
      const q = await ad.queryCredits(acc, sec);
      if (q.authError) { row.quota = "401 失效"; row.revoked = true; }
      else if (q.credits !== undefined) row.quota = `${q.credits} credits`;
      else row.quota = q.unavailable ? "结构未识别" : `异常 ${q.error || ""}`;
    } catch (e) { row.quota = `异常 ${String((e && e.message) || e).slice(0, 50)}`; }
    console.log(`  ① queryCredits : ${row.quota}`);

    // ② 续期（token 轮换）
    let rotated = null;
    try {
      const r = await ad.refreshToken(acc, sec);
      if (r.ok) { row.refresh = "成功轮换"; rotated = r; }
      else { row.refresh = `失败 ${String(r.message || "").slice(0, 50)}`; row.revoked = true; }
    } catch (e) { row.refresh = `异常 ${String((e && e.message) || e).slice(0, 50)}`; row.revoked = true; }
    console.log(`  ② refreshToken : ${row.refresh}`);

    // ③ 推理（完整签名链）
    try {
      const events = [];
      const r = await ad.chat({
        account: acc, secrets: sec, model: "qfmodel",
        body: { messages: [{ role: "user", content: "回复OK" }], max_tokens: 4 },
        emit: (e) => events.push(e), meta: {},
      });
      const text = events.filter((e) => e.type === "delta" && e.delta && e.delta.content).map((e) => e.delta.content).join("");
      row.chat = r.status === 200 ? `200 "${text.slice(0, 10)}"` : `status=${r.status}`;
      if (r.status !== 200) row.revoked = true;
    } catch (e) { row.chat = `失败 ${String((e && e.message) || e).slice(0, 50)}`; row.revoked = true; }
    console.log(`  ③ chat         : ${row.chat}`);

    // --write-back：把最新凭据写回客户端（仅当它就是当前登录账号，避免串号）
    if (WRITE_BACK && rotated) {
      try {
        const cur = auth.readCredentials("qoder");
        if (cur.user && cur.user.id === acc.uid) {
          auth.writeCredentials("qoder", {
            token: rotated.token, refreshToken: rotated.refreshToken,
            expiresAt: rotated.expiresAt, refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
            user: cur.user,
          });
          console.log("  → 已写回客户端 auth.v1.dat（uid 校验通过）");
        } else {
          console.log(`  → 跳过写回：当前客户端登录的是 ${String(cur.user && cur.user.id).slice(0, 12)}…，非本账号`);
        }
      } catch (e) { console.log(`  → 写回失败：${String((e && e.message) || e).slice(0, 60)}`); }
    }
    results.push(row);
  }

  console.log("\n=== 结论 ===");
  for (const r of results) {
    console.log(`  ${r.uid}…  额度=${r.quota}  续期=${r.refresh}  推理=${r.chat}${r.revoked ? "   ⚠️ 被吊销" : ""}`);
  }
  const revoked = results.filter((r) => r.revoked);
  if (revoked.length === 0) {
    console.log("  → 所有账号三项均通过：**账号间无互斥**，切换登录不会吊销其它账号。");
  } else {
    console.log(`  → ${revoked.length} 个账号出现失效：**存在互斥**，需按"冷账号"策略隔离。`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });
