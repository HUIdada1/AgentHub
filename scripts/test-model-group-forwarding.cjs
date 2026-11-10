/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 模型组端到端转发回归：「free」= 同一渠道的 m-bad + m-good。
//   · 请求 free 时按成员顺序调用，m-bad 上游 404 后自动换 m-good 成功；
//   · /v1/models 里组名只出现一次；
//   · 成员渠道被关闭后回 503，文案说明是模型组没有可用成员（而不是 404 模型不存在）。
//
// 跑法：node scripts/run-all-tests.cjs 会自动带上本文件；
// 单跑需要 node:sqlite → ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <本文件>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-group-forward-"));

const config = require("../electron/backend/config.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const localConfig = require("../electron/backend/localgw/config.cjs");
const keys = require("../electron/backend/localgw/keys-store.cjs");
const gateway = require("../electron/backend/localgw/server.cjs");
const routing = require("../electron/backend/localgw/routing.cjs");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

const calls = [];
const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  calls.push(body.model);
  if (body.model === "m-bad") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "model not found" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "SUCCESS" } }] })}\n\n`);
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
  // 自定义提供商渠道：与真机上「自定义供应商」同一条执行来源
  store.saveProvider({
    id: "fixture",
    kind: "openai_compat",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    models: [{ model: "m-bad" }, { model: "m-good" }],
  });
  for (let n = 0; n < 2; n++) {
    store.addAccount({ channel: "fixture", uid: `fixture-${n}`, name: `fixture-${n}`, token: `fixture-${n}`, source: "paste" });
  }
  for (const account of store.listAccounts()) {
    pool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  }

  const port = await freePort();
  const c = config.loadConfig();
  c.localgw = localConfig.normalize({
    ...c.localgw,
    port,
    portCandidates: [port],
    concurrency: 2,
    requestTimeoutMs: 10000,
    routing: { strategy: "smart", failover: true, maxRetriesPerRequest: 4 },
    models: {
      groups: {
        free: {
          strategy: "priority",
          members: [
            { channel: "fixture", real_model: "m-bad" },
            { channel: "fixture", real_model: "m-good" },
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
  const postFree = () => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "free", messages: [{ role: "user", content: "hi" }] }),
  });

  try {
    // ---------- 1. 组内故障转移 ----------
    const first = await postFree();
    const firstText = await first.text();
    assert.equal(first.status, 200, firstText);
    assert.ok(firstText.includes("SUCCESS"), firstText);
    assert.deepEqual(calls, ["m-bad", "m-good"], "必须先试第一个成员，404 后自动换下一个成员");

    // ---------- 2. /v1/models 只暴露一个组名 ----------
    const modelsRes = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    const payload = await modelsRes.json();
    assert.equal(payload.data.filter((m) => m.id === "free").length, 1, "组在模型目录里只能出现一次");

    // ---------- 3. 组成员渠道全部关闭 → 503 且文案可解释 ----------
    routing.setChannelEnabled("fixture", false);
    const blocked = await postFree();
    const blockedText = await blocked.text();
    assert.equal(blocked.status, 503);
    assert.ok(blockedText.includes("模型组") && blockedText.includes("没有可用成员"), blockedText);
  } finally {
    await gateway.stop();
  }
  console.log("PASS 模型组端到端：成员顺序优先 → 404 自动换成员 → 组名去重 → 全不可用回 503");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await close(upstream).catch(() => {}); store.close(); fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true }); });
