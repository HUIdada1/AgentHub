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
/**
 * 本地网关 · 出站伪装与清洗 —— 端到端验证（F）
 *
 * 【必须用 Electron 自带的 node 跑】：本机 `node -v` = 16.20.2，没有 `node:sqlite`、没有全局 fetch，
 * 起不了真实 localgw（号池/密钥/请求日志都要 SQLite）。
 *   跑法：$env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe tools\verify\outbound\e2e.cjs
 *
 * 【覆盖】
 *   F1  真实 HTTP 服务 + 真实 mock 上游：出站 body 已被 rewrites/keywords 改写
 *   F2  出站请求头被覆盖（UA）、被移除、Authorization 未被破坏
 *   F3  oplog 表的 sensitiveHits 列**真的写进了**该值（不是只看 forwarder 返回值）
 *   F4  passthrough 渠道：出站 body 与头原样不动
 *   F5  §4.8 channels 形状：含一个 kind==="custom" 且 policy.mode==="passthrough" 的真实行
 *   F6  **跨渠道 failover 隔离**：第 2 轮必须用当轮渠道的策略，不得复用第 1 轮的
 *
 * 【隔离】全程使用独立的 AGENTHUB_DATA_DIR，不触碰用户真实配置/数据库。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.resolve(__dirname, "../../..");
const OUTDIR = path.join(ROOT, "tmp", "outbound-verify");
const DATA = path.join(OUTDIR, "e2e-data");

// ⚠ 必须在 require 任何 backend 模块之前设定：electron/backend/config.cjs 在模块加载期读它
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.AGENTHUB_DATA_DIR = DATA;
process.env.AGENTHUB_SECRET_KEY = "verify-e2e-secret-0123456789abcdef";

const lgwConfig = require(path.join(ROOT, "electron/backend/localgw/config.cjs"));
const server = require(path.join(ROOT, "electron/backend/localgw/server.cjs"));
const keysStore = require(path.join(ROOT, "electron/backend/localgw/keys-store.cjs"));
const oplog = require(path.join(ROOT, "electron/backend/localgw/oplog.cjs"));
const routing = require(path.join(ROOT, "electron/backend/localgw/routing.cjs"));
const proxyStore = require(path.join(ROOT, "electron/backend/proxy/store.cjs"));

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude";
const REPLACED = "You are CodeBuddy, an AI coding assistant tool for Claude";

let pass = 0;
let fail = 0;
const failures = [];
function assertCheck(name, cond, details) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${details ? "\n      -> " + String(details).replace(/\n/g, "\n      ") : ""}`);
  }
  return cond;
}

/** 起一个「记录一切」的 mock 上游 */
function startUpstream(name) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* 非 JSON 原样留 raw */ }
      calls.push({ name, url: req.url, method: req.method, headers: req.headers, raw, parsed });
      if (name === "fail") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "verify: upstream intentionally failing" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-verify",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "verify-model",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, port: srv.address().port }));
  });
}

function post(port, body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length, authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function postPath(port, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length, "x-api-key": token },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log("=== [outbound-verify] 端到端验证（F） ===");
  console.log(`  隔离数据目录：${path.relative(ROOT, DATA)}`);
  console.log(`  运行环境：node ${process.versions.node} / node:sqlite=${!!(() => { try { require("node:sqlite"); return true; } catch { return false; } })()}`);

  const upOk = await startUpstream("ok");
  const upFail = await startUpstream("fail");
  console.log(`  mock 上游：ok=127.0.0.1:${upOk.port} / fail=127.0.0.1:${upFail.port}`);

  // ---- 注册 3 个自定义供应商渠道 ----
  const mkProvider = (id, display, port) =>
    proxyStore.saveProvider({
      id, display, kind: "custom", baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{ model: "verify-model" }], enabled: true,
    });
  mkProvider("verify-ok", "Verify OK", upOk.port);
  mkProvider("verify-pass", "Verify Passthrough", upOk.port);
  mkProvider("verify-fa-a", "Verify Failover A", upFail.port);
  mkProvider("verify-fa-b", "Verify Failover B", upOk.port);
  // verify-bare：**完全不给 outbound 配置**的自定义渠道，用来钉「custom 不自动透传」的裁决口径
  mkProvider("verify-bare", "Verify Bare", upOk.port);
  for (const id of ["verify-ok", "verify-pass", "verify-fa-a", "verify-fa-b", "verify-bare"]) {
    proxyStore.addAccount({ channel: id, uid: `${id}-uid`, name: `${id} acct`, token: `tok-${id}` });
  }

  // ---- 配置 localgw ----
  const port = 19627;
  const w = lgwConfig.patch({
    bind: "127.0.0.1",
    port,
    portCandidates: [port],
    routing: { strategy: "fixed", fixedChannel: "verify-ok", failover: false, maxRetriesPerRequest: 1, cooldownMs: 60000 },
    outbound: {
      defaults: { mode: "mimic" },
      perChannel: {
        "verify-ok": {
          mode: "mimic",
          headers: { "user-agent": "X-Test/1.0", "x-added": "yes" },
          removeHeaders: ["x-remove-me"],
          rewrites: [{ id: "r1", label: "身份句", from: IDENTITY, to: REPLACED, scope: "system" }],
          keywords: [{ id: "k1", label: "裸错误码", mode: "literal", pattern: "11128", replace: "11-128", scope: "all" }],
        },
        "verify-pass": { mode: "passthrough", headers: { "user-agent": "SHOULD-NOT-APPLY" } },
        "verify-fa-a": { mode: "mimic", headers: { "user-agent": "UA-CHANNEL-A", "x-chan": "A" } },
        "verify-fa-b": { mode: "mimic", headers: { "user-agent": "UA-CHANNEL-B", "x-chan": "B" } },
      },
    },
  });
  assertCheck("配置写入成功（lgwConfig.patch ok）", w && w.ok !== false, JSON.stringify(w && w.message));

  const key = keysStore.create({ name: "verify-e2e", concurrency: 64, ratePerMin: 100000 });
  assertCheck("API Key 创建成功", !!(key && key.rawKey));

  const st = await server.start();
  assertCheck(`localgw HTTP 服务已启动（port=${st && st.port}）`, st && st.ok === true, JSON.stringify(st));
  if (!st || !st.ok) { finish(); return; }

  // ===================== F1–F3：mimic 渠道 =====================
  console.log("\n--- F1/F2/F3：mimic 渠道（真 HTTP + 真 mock 上游 + 真 oplog）---");
  const resp = await post(port, {
    model: "verify-model",
    messages: [
      { role: "system", content: IDENTITY },
      { role: "user", content: "please report code 11128" },
    ],
  }, key.rawKey);
  console.log(`  客户端响应：status=${resp.status} body=${resp.text.slice(0, 160)}`);
  await sleep(150);

  const c1 = upOk.calls[0];
  assertCheck("F0 上游确实收到了出站请求", !!c1, `calls=${upOk.calls.length}`);
  if (c1) {
    console.log(`  上游收到的头：${JSON.stringify({ ua: c1.headers["user-agent"], added: c1.headers["x-added"], rm: c1.headers["x-remove-me"], auth: c1.headers["authorization"] })}`);
    console.log(`  上游收到的 body.messages：${JSON.stringify(c1.parsed && c1.parsed.messages)}`);

    assertCheck(
      "F1a 出站 body 的 system 身份句已被 rewrite 替换",
      c1.parsed && c1.parsed.messages[0].content === REPLACED,
      JSON.stringify(c1.parsed && c1.parsed.messages[0])
    );
    assertCheck(
      "F1b 出站 body 的关键词已被替换（11128 → 11-128）",
      c1.parsed && c1.parsed.messages[1].content === "please report code 11-128",
      JSON.stringify(c1.parsed && c1.parsed.messages[1])
    );
    assertCheck("F2a 出站 UA 被覆盖为 X-Test/1.0", c1.headers["user-agent"] === "X-Test/1.0", String(c1.headers["user-agent"]));
    assertCheck("F2b 新增头 x-added 已出现", c1.headers["x-added"] === "yes", String(c1.headers["x-added"]));
    assertCheck("F2c removeHeaders 指定的 x-remove-me 未发出", c1.headers["x-remove-me"] === undefined, String(c1.headers["x-remove-me"]));
    assertCheck(
      "F2d Authorization 未被破坏（渠道自身的 Bearer 原样送达）",
      c1.headers["authorization"] === "Bearer tok-verify-ok",
      String(c1.headers["authorization"])
    );
  }

  // F3：oplog 真落库（oplog.list 返回 { rows, total }）
  const rows = (oplog.list({ limit: 20, channel: "verify-ok" }) || {}).rows || [];
  const row = rows.find((r) => r.channel === "verify-ok");
  console.log(`  oplog 行：${JSON.stringify(row)}`);
  assertCheck("F3a oplog 里存在本渠道的请求日志行", !!row, `rows=${JSON.stringify(rows.slice(0, 3))}`);
  assertCheck(
    "F3b oplog.sensitiveHits 列**真的写入了**命中摘要（非空且含规则 label）",
    !!row && typeof row.sensitiveHits === "string" && row.sensitiveHits.length > 0 && row.sensitiveHits.includes("身份句"),
    row ? `sensitiveHits=${JSON.stringify(row.sensitiveHits)}` : "无行"
  );
  // 直连 SQLite 复核：绕开 oplog.list 的字段映射层，直接读 sensitive_hits 原始列
  try {
    const raw = proxyStore.open().prepare(
      "SELECT channel, sensitive_hits FROM localgw_logs WHERE channel = ? ORDER BY ts DESC LIMIT 5"
    ).all("verify-ok");
    console.log(`  直连 SQLite 读 sensitive_hits 原始列：${JSON.stringify(raw)}`);
    assertCheck(
      "F3c 直连 SQLite 复核：sensitive_hits 原始列里确实有非空值",
      raw.length > 0 && raw.every((r) => typeof r.sensitive_hits === "string" && r.sensitive_hits.length > 0),
      JSON.stringify(raw)
    );
  } catch (e) {
    assertCheck("F3c 直连 SQLite 复核 sensitive_hits 原始列", false, `无法直连：${e.message}`);
  }

  // ===================== F4：passthrough 渠道 =====================
  console.log("\n--- F4：passthrough 渠道（显式配置透传）---");
  lgwConfig.patch({ routing: { strategy: "fixed", fixedChannel: "verify-pass", failover: false } });
  const before = upOk.calls.length;
  const resp4 = await post(port, { model: "verify-model", messages: [{ role: "system", content: IDENTITY }] }, key.rawKey);
  await sleep(150);
  const c4 = upOk.calls[before];
  assertCheck("F4a passthrough 渠道的上游请求已到达", !!c4, `status=${resp4.status} calls=${upOk.calls.length}`);
  if (c4) {
    console.log(`  passthrough 上游：ua=${JSON.stringify(c4.headers["user-agent"])} body=${JSON.stringify(c4.parsed && c4.parsed.messages)}`);
    assertCheck(
      "F4b passthrough：出站 body 未被改写（身份句原样）",
      c4.parsed && c4.parsed.messages[0].content === IDENTITY,
      JSON.stringify(c4.parsed && c4.parsed.messages[0])
    );
    assertCheck(
      "F4c passthrough：出站头未被覆盖（UA 不是 SHOULD-NOT-APPLY）",
      c4.headers["user-agent"] !== "SHOULD-NOT-APPLY",
      String(c4.headers["user-agent"])
    );
  }

  // ===================== F5：channels 形状（含 custom 行） =====================
  console.log("\n--- F5：§4.8 channels 形状（含 kind===\"custom\" 的真实行）---");
  const matrix = routing.channelMatrix();
  const customRows = matrix.filter((r) => r.kind === "custom");
  console.log(`  channels=${matrix.length}，custom=${customRows.length}`);
  console.log(`  样例 custom 行：${JSON.stringify(customRows[0])}`);
  assertCheck("F5a channelMatrix() 列出了自定义供应商渠道（kind===\"custom\"）", customRows.length >= 3, `custom=${customRows.length}`);
  assertCheck(
    "F5b 存在 kind===\"custom\" 且 policy.mode===\"passthrough\" 的真实行（产品语义可见）",
    customRows.some((r) => r.policy.mode === "passthrough"),
    JSON.stringify(customRows.map((r) => ({ id: r.id, mode: r.policy.mode })))
  );
  assertCheck(
    "F5c 每行恰好 5 个字段、policy 恰好 3 个字段",
    matrix.every((r) =>
      JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["accountCount", "display", "id", "kind", "policy"]) &&
      JSON.stringify(Object.keys(r.policy).sort()) === JSON.stringify(["mode", "parts", "profileLabel"])
    ),
    JSON.stringify(matrix.find((r) => Object.keys(r).length !== 5) || null)
  );
  assertCheck(
    "F5d accountCount 反映真实账号数（5 个渠道各 1 个账号）",
    customRows.filter((r) => r.id.startsWith("verify-")).every((r) => r.accountCount === 1),
    JSON.stringify(customRows.filter((r) => r.id.startsWith("verify-")).map((r) => ({ id: r.id, n: r.accountCount })))
  );
  // B+ 裁决口径：自定义渠道**不自动透传**，未配置时生效 mode 仍是 mimic（只是头操作默认为空）
  const bare = matrix.find((r) => r.id === "verify-bare");
  console.log(`  未配置 outbound 的自定义渠道 verify-bare：${JSON.stringify(bare)}`);
  assertCheck(
    "F5e 未配置 outbound 的自定义渠道生效 mode = mimic（custom 不自动透传）",
    !!bare && bare.policy.mode === "mimic",
    JSON.stringify(bare)
  );
  assertCheck(
    "F5f 未配置 outbound 的自定义渠道头操作默认为空（不出现「头覆盖 N / 移除 N」）",
    !!bare && !bare.policy.parts.some((p) => p.includes("头覆盖")),
    JSON.stringify(bare && bare.policy.parts)
  );

  // ===================== F8：preview hits 元素形状（跨模块契约缺口） =====================
  console.log("\n--- F8：localgw_outbound_preview 的 hits 元素形状 ---");
  const outboundMod = require(path.join(ROOT, "electron/backend/localgw/outbound.cjs"));
  const pv = outboundMod.previewText(`probe ${IDENTITY} 11128`, outboundMod.policyFor("verify-ok", lgwConfig.get()), "");
  console.log(`  previewText 返回：${JSON.stringify({ changed: pv.changed, hits: pv.hits })}`);
  assertCheck(
    "F8a previewText().hits 是数组且元素恰为 {label, count}（不是 string[]）",
    Array.isArray(pv.hits) && pv.hits.length > 0 &&
      pv.hits.every((h) => h && typeof h === "object" && typeof h.label === "string" && typeof h.count === "number" &&
        JSON.stringify(Object.keys(h).sort()) === JSON.stringify(["count", "label"])),
    JSON.stringify(pv.hits)
  );
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src/api/ipc.ts"), "utf8");
  const previewTypeOk = /hits:\s*\{\s*label:\s*string;\s*count:\s*number\s*\}\[\]/.test(ipcSrc);
  assertCheck("F8b src/api/ipc.ts 的 LocalgwOutboundPreviewResult.hits 声明为 {label,count}[]", previewTypeOk,
    (ipcSrc.match(/LocalgwOutboundPreviewResult[\s\S]{0,240}/) || [""])[0]);

  // ===================== F6：跨渠道 failover 隔离 =====================
  console.log("\n--- F6：跨渠道 failover 头策略隔离（本轮必须用当轮渠道的策略）---");
  // A 的上游故意 500 → 第 1 轮 A 失败 → 第 2 轮换到 B
  // 注意：candidates() 在同分时按渠道 id 字典序排，所以必须显式 blockedChannels 排除其它渠道，
  // 否则第二轮会打到 verify-bare（未配置策略，UA 会是 node 默认值）——第一版就踩了这个坑。
  lgwConfig.patch({
    routing: {
      strategy: "fixed", fixedChannel: "verify-fa-a", failover: true, maxRetriesPerRequest: 3,
      blockedChannels: ["verify-bare", "verify-ok", "verify-pass"],
      preferChannels: ["verify-fa-b"],
    },
  });
  const beforeA = upFail.calls.length;
  const beforeB = upOk.calls.length;
  const resp6 = await post(port, { model: "verify-model", messages: [{ role: "user", content: "failover probe" }] }, key.rawKey);
  await sleep(200);
  const faCalls = upFail.calls.slice(beforeA);
  const fbCalls = upOk.calls.slice(beforeB);
  console.log(`  failover 响应：status=${resp6.status} body=${resp6.text.slice(0, 120)}`);
  console.log(`  渠道 A 收到 ${faCalls.length} 次，头=${JSON.stringify(faCalls.map((c) => ({ ua: c.headers["user-agent"], xc: c.headers["x-chan"] })))}`);
  console.log(`  渠道 B 收到 ${fbCalls.length} 次，头=${JSON.stringify(fbCalls.map((c) => ({ ua: c.headers["user-agent"], xc: c.headers["x-chan"] })))}`);

  assertCheck("F6a 第 1 轮确实打到了渠道 A", faCalls.length >= 1, `A 调用数=${faCalls.length}`);
  assertCheck("F6b failover 后确实打到了渠道 B", fbCalls.length >= 1, `B 调用数=${fbCalls.length}`);
  assertCheck(
    "F6c 渠道 A 的请求用的是 A 的策略（UA-CHANNEL-A / x-chan=A）",
    faCalls.length > 0 && faCalls.every((c) => c.headers["user-agent"] === "UA-CHANNEL-A" && c.headers["x-chan"] === "A"),
    JSON.stringify(faCalls.map((c) => c.headers["user-agent"]))
  );
  assertCheck(
    "F6d **渠道 B 的请求用的是 B 的策略，未复用 A 的**（UA-CHANNEL-B / x-chan=B）",
    fbCalls.length > 0 && fbCalls.every((c) => c.headers["user-agent"] === "UA-CHANNEL-B" && c.headers["x-chan"] === "B"),
    JSON.stringify(fbCalls.map((c) => ({ ua: c.headers["user-agent"], xc: c.headers["x-chan"] })))
  );
  const bRow = ((oplog.list({ limit: 10, channel: "verify-fa-b" }) || {}).rows || [])[0];
  assertCheck("F6e failover 成功轮的 oplog 落在渠道 B 上", !!bRow, JSON.stringify(bRow));

  // ===================== F7：并发隔离（真实 server 路径） =====================
  console.log("\n--- F7：并发下策略隔离（真实 server 路径，A/B 交替并发）---");
  lgwConfig.patch({ routing: { strategy: "fixed", fixedChannel: "verify-fa-b", failover: false } });
  const beforeB2 = upOk.calls.length;
  const N = 12;
  const con = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      post(port, { model: "verify-model", messages: [{ role: "user", content: `concurrent ${i}` }] }, key.rawKey)
    )
  );
  await sleep(250);
  const bCalls2 = upOk.calls.slice(beforeB2);
  console.log(`  并发 ${N} 次，全部 200=${con.every((r) => r.status === 200)}，上游收到 ${bCalls2.length} 次`);
  assertCheck(
    "F7 并发下每个出站请求都带本渠道策略（UA-CHANNEL-B），无串台/丢失",
    bCalls2.length === N && bCalls2.every((c) => c.headers["user-agent"] === "UA-CHANNEL-B" && c.headers["x-chan"] === "B"),
    `收到=${bCalls2.length} 异常=${JSON.stringify(bCalls2.filter((c) => c.headers["user-agent"] !== "UA-CHANNEL-B").map((c) => c.headers["user-agent"]))}`
  );

  // ===================== F9：Anthropic /v1/messages 分支 =====================
  console.log("\n--- F9：Anthropic /v1/messages 分支（独立链路，契约 §4.7）---");
  lgwConfig.patch({ routing: { strategy: "fixed", fixedChannel: "verify-ok", failover: false } });
  const beforeMsg = upOk.calls.length;
  const respMsg = await postPath(port, "/v1/messages", {
    model: "verify-model",
    max_tokens: 64,
    system: IDENTITY,
    messages: [{ role: "user", content: "anthropic path 11128" }],
  }, key.rawKey);
  await sleep(150);
  const cMsg = upOk.calls[beforeMsg];
  console.log(`  /v1/messages 响应：status=${respMsg.status} body=${respMsg.text.slice(0, 140)}`);
  assertCheck("F9a /v1/messages 已转发到上游", !!cMsg, `status=${respMsg.status} calls=${upOk.calls.length}`);
  if (cMsg) {
    console.log(`  上游收到（anthropic 路径）body.messages：${JSON.stringify(cMsg.parsed && cMsg.parsed.messages)}`);
    console.log(`  上游收到（anthropic 路径）ua=${JSON.stringify(cMsg.headers["user-agent"])}`);
    const joined = JSON.stringify(cMsg.parsed && cMsg.parsed.messages);
    assertCheck(
      "F9b Anthropic 入向翻译后的 system 身份句已被 rewrite（证明清洗在翻译之后）",
      joined.includes(REPLACED) && !joined.includes("Anthropic's official CLI for Claude"),
      joined
    );
    assertCheck("F9c Anthropic 路径的关键词替换同样生效（11128 → 11-128）", joined.includes("11-128"), joined);
    assertCheck("F9d Anthropic 路径的出站头覆盖同样生效", cMsg.headers["user-agent"] === "X-Test/1.0", String(cMsg.headers["user-agent"]));
  }
  const msgRow = ((oplog.list({ limit: 5, channel: "verify-ok" }) || {}).rows || [])[0];
  assertCheck(
    "F9e /v1/messages 的 oplog 行 sensitiveHits 有值",
    !!msgRow && typeof msgRow.sensitiveHits === "string" && msgRow.sensitiveHits.length > 0,
    JSON.stringify(msgRow)
  );

  finish();
}

function finish() {
  console.log(`\n--- 端到端汇总：${pass} 通过 / ${fail} 失败 ---`);
  if (fail) console.log(`失败项：\n${failures.map((f) => "  - " + f).join("\n")}`);
  try { server.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}

main().catch((e) => {
  console.error("E2E 脚本自身异常：", e && e.stack ? e.stack : e);
  try { server.stop(); } catch { /* ignore */ }
  process.exit(2);
});
