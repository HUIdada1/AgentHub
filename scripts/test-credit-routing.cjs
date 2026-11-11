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
// 跨渠道「积分优先」端到端回归（无需真实账号：自定义提供商 + 本机假上游）：
//   · 模型组 strategy=credit：免费号 → 快到期 → 晚到期 → 永久号 依次命中；
//   · 全局策略 credit-first：同一对外名映射到两个渠道时按同样规则选号；
//   · 选中的号被真正执行（假上游按 Authorization 区分是哪个号）——证明「定号后不被执行器换掉」；
//   · 请求日志的 attempts 带上实际账号 id，便于核对。
//
// 跑法：node scripts/run-all-tests.cjs 会自动带上本文件；
// 单跑需要 node:sqlite → ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <本文件>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credit-routing-"));

const config = require("../electron/backend/config.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const localConfig = require("../electron/backend/localgw/config.cjs");
const keys = require("../electron/backend/localgw/keys-store.cjs");
const gateway = require("../electron/backend/localgw/server.cjs");
const oplog = require("../electron/backend/localgw/oplog.cjs");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假上游：只记录（模型名 + 授权头），一律返回成功 SSE —— 用授权头区分「实际用了哪个号」 */
const calls = [];
const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  calls.push({ model: body.model, auth: String(req.headers.authorization || "") });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function main() {
  const upstreamPort = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  for (const id of ["fr_a", "fr_b"]) {
    store.saveProvider({ id, kind: "openai_compat", baseUrl, models: [{ model: "shared" }] });
  }
  const now = Date.now();
  const DAY = 86400000;
  const make = (channel, token, { credits, expiresAt = 0, billingKind = "unknown" }) => {
    const id = store.addAccount({ channel, uid: `${channel}-${token}`, name: token, token, source: "paste", expiresAt, meta: { gateway: { billingKind } } });
    store.updateAccount(id, { credits, creditsAt: now, status: "online", coolUntil: 0, coolReason: "" });
    return id;
  };
  const freeId = make("fr_a", "token-free", { credits: 5, expiresAt: now + DAY, billingKind: "free" });
  const soonId = make("fr_a", "token-soon", { credits: 10, expiresAt: now + 2 * DAY, billingKind: "paid" });
  const lateId = make("fr_a", "token-late", { credits: 999, expiresAt: now + 9 * DAY, billingKind: "paid" });
  const permId = make("fr_b", "token-perm", { credits: 9999, billingKind: "permanent" });
  const idOf = (token) => ({ "token-free": freeId, "token-soon": soonId, "token-late": lateId, "token-perm": permId })[token];

  const port = await freePort();
  const c = config.loadConfig();
  // 同一对外名 abc-alias 映射到两个自定义渠道（走全局 credit-first）：
  // 反向别名让合并目录里出现一个跨渠道同名模型，且各渠道解析出真实发送名 shared。
  c.proxy = { ...(c.proxy || {}), modelReverseAliases: { "abc-alias": { fr_a: "shared", fr_b: "shared" } } };
  c.localgw = localConfig.normalize({
    ...c.localgw,
    port,
    portCandidates: [port],
    concurrency: 2,
    requestTimeoutMs: 10000,
    routing: { strategy: "credit-first", failover: true, maxRetriesPerRequest: 3 },
    models: {
      groups: {
        abc: {
          strategy: "credit",
          members: [
            { channel: "fr_b", real_model: "shared" },
            { channel: "fr_a", real_model: "shared" },
          ],
        },
      },
    },
    outbound: { defaults: { mode: "passthrough", jitter: false } },
  });
  config.saveConfig(c);

  const started = await gateway.start();
  assert.equal(started.ok, true, started.message);
  const key = keys.create({ scopes: ["*"], concurrency: 8, ratePerMin: 1000 }).rawKey;
  const base = `http://127.0.0.1:${started.port}`;
  const ask = (model) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  const lastAuth = () => calls[calls.length - 1]?.auth || "";
  const expectToken = (token) => assert.equal(lastAuth(), `Bearer ${token}`, `应使用 ${token}`);

  try {
    // ---------- 1. 全局 credit-first：同名模型跨渠道，免费号排在永久号前面 ----------
    const globalRes = await ask("abc-alias");
    assert.equal(globalRes.status, 200, await globalRes.text());
    expectToken("token-free");

    // ---------- 2. 组 strategy=credit：同一规则（成员顺序把永久号排第一也不影响） ----------
    const groupRes = await ask("abc");
    assert.equal(groupRes.status, 200, await groupRes.text());
    expectToken("token-free");

    // ---------- 3. 免费号不可用 → 组内下一个候选：到期近的压过积分多的 ----------
    store.updateAccount(freeId, { status: "cooling", coolUntil: now + 3600000, coolReason: "测试" });
    const soonRes = await ask("abc");
    assert.equal(soonRes.status, 200, await soonRes.text());
    expectToken("token-soon");

    // ---------- 4. 再下一个：晚到期（999 分）仍先于跨渠道的永久号 ----------
    store.updateAccount(soonId, { status: "cooling", coolUntil: now + 3600000, coolReason: "测试" });
    const lateRes = await ask("abc");
    assert.equal(lateRes.status, 200, await lateRes.text());
    expectToken("token-late");

    // ---------- 5. 会过期的额度全不可用 → 永久号垫底命中 ----------
    store.updateAccount(lateId, { status: "cooling", coolUntil: now + 3600000, coolReason: "测试" });
    const permRes = await ask("abc");
    assert.equal(permRes.status, 200, await permRes.text());
    expectToken("token-perm");

    // ---------- 6. 日志：每次尝试都记下实际账号 id（定号结果可核对） ----------
    await sleep(80);
    const logged = oplog.list({ limit: 10 }).rows
      .filter((row) => row.status === "success")
      .sort((a, b) => a.ts - b.ts)
      .map((row) => row.attempts?.[0]?.accountId || "");
    assert.deepEqual(logged, [freeId, freeId, soonId, lateId, permId], "日志 attempts.accountId 应与实际执行的号一致");
  } finally {
    await gateway.stop();
  }
  console.log("PASS 积分优先端到端：全局/组两条链路 → 免费→快到期→晚到期→永久 → 定号被执行器真正采用 → 日志可核对");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await close(upstream).catch(() => {}); store.close(); fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true }); });
