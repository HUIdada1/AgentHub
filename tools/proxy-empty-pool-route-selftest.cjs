// 反代网关「空号池渠道抢占候选」自测（issue #86）：cost-first 档下**能出请求的渠道优先**于便宜但空池的渠道。
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-empty-pool-route-selftest.cjs
//
// 背景：cost-first 原先只按成本档排（可用性只算组内分），于是空池/熔断的便宜渠道会抢占主渠道位、
// 吃掉 channelFailoverMax 预算，把唯一有账号的渠道挤出候选队列 → 明明有账号却 503，轨迹里连它都不出现。
//   A1~A8 走真实 HTTP 链路（假上游 + 沙盒 APPDATA）；A9 锁 routeUsable 与 pickAccount 的判据口径；
//   A10 守「上游 400 透传（fatal）时不得反过来说没发过请求」。
// 断言用收集式而非 fail-fast：A/B 时要在一次运行里看全所有红项（方案要求 A2/A2b/A4/A5/A6/A7 同时可见）。
// 说明：A9/A10 是写完自检时补的——A2/A4 用的是「号池全空」的便宜渠道，覆盖不到「号还在但已知余额为 0 /
//      余额已到期」这两条判据；A6/A7 的轨迹口径判定则漏了 fatal 不写轨迹那条路径。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-empty-pool-test-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
    return true;
  }
  fail++;
  fails.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const server = require("../electron/backend/proxy/server.cjs");

  store.open();
  rules.init();

  // ===== 假上游：trae / workbuddy / workbuddy_ai 指向本机（空池渠道不配号，永远打不出去）=====
  const http = require("node:http");
  const hits = { trae: 0, wb: 0, wba: 0 };
  const mode = { wb: "ok" }; // A10 用：把 workbuddy 上游切成 400（参数类不可换错误 → fatal 透传）
  const fake = http.createServer((req, res) => {
    const url = req.url || "";
    req.on("data", () => {});
    req.on("end", () => {
      const channel = url.includes("/tr/") ? "trae" : url.includes("/wba/") ? "wba" : url.includes("/wb/") ? "wb" : "";
      if (!channel) {
        res.writeHead(404);
        res.end();
        return;
      }
      hits[channel]++;
      if (channel === "wb" && mode.wb === "fatal400") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"upstream param bad"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (channel === "trae") {
        res.end(
          "event: metadata\n" + 'data: {"conversation_id":"c1"}\n\n' +
          "event: output\n" + 'data: {"response":"TRAEO"}\n\n' +
          "event: token_usage\n" + 'data: {"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}\n\n' +
          "event: done\n" + 'data: {"finish_reason":"stop"}\n\n'
        );
      } else {
        res.end(
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"content":" "},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
          "data: [DONE]\n\n"
        );
      }
    });
  });
  await new Promise((r) => fake.listen(19541, "127.0.0.1", r));

  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersBackup = fs.readFileSync(headersPath, "utf8");
  const headersCfg = JSON.parse(headersBackup);
  headersCfg.trae.chatUrl = "http://127.0.0.1:19541/tr/chat";
  headersCfg.trae.mirrorChatUrl = "";
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19541/wb/chat";
  headersCfg.workbuddy_ai.consoleChatUrl = "";
  headersCfg.workbuddy_ai.chatUrl = "http://127.0.0.1:19541/wba/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // ===== 目录种子：shared-model 被 5 个渠道共同拥有（免费 / 低成本 / 普通的组合）=====
  const catFile = path.join(rules.rulesDir(), "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
  for (const ch of ["modelscope", "lobster", "trae", "workbuddy", "workbuddy_ai"]) {
    if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
    cat[ch].models = [...(cat[ch].models || []), ent("shared-model")];
  }
  cat.workbuddy_ai.models = [...cat.workbuddy_ai.models, ent("ai-only-model")]; // 单 owner（目录边界）
  cat.lobster.models = [...cat.lobster.models, ent("empty-pair-model")];         // 与 wb_ai 共有的全空组合
  cat.workbuddy_ai.models = [...cat.workbuddy_ai.models, ent("empty-pair-model")];
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
  rules.reload("catalog.json");
  store.setAgentCostTier("trae", "low"); // 便宜档空池渠道：modelscope(free) / lobster(low) / trae(low)
  const costTiers = Object.fromEntries(store.listAgents().map((a) => [a.id, a.costTier || "normal"]));

  // ===== 唯一可用账号在 workbuddy（普通档）；其余渠道号池全空 =====
  const w1 = store.addAccount({ channel: "workbuddy", uid: "ep1", name: "CN号", token: "wb-token", source: "paste", expiresAt: Date.now() + 7200000 });
  store.updateAccount(w1, { credits: 1000, creditsAt: Date.now() });

  const cfg = {
    port: 19542, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [],
    routeOrder: "cost-first", channelFailover: true, channelFailoverMax: 3,
    channelCooldownMs: 120000, channelCooldownCapMs: 600000,
  };
  const sr = await server.start(() => cfg);
  if (!sr.ok) throw new Error("网关启动失败: " + (sr.message || ""));
  const base = "http://127.0.0.1:19542";
  const k = store.createKey({ name: "空池路由自测", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const call = (payload) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify(payload),
    });
  const bodyMsg = [{ role: "user", content: "hi" }];
  const lastRow = () => store.recentRequests(1)[0];
  console.log(`owners(shared-model) = modelscope/lobster/trae/workbuddy/workbuddy_ai | 成本档: ${JSON.stringify(costTiers)} | 唯一账号: workbuddy`);

  try {
    // ===== A1 score 档护栏：可用渠道本来就在最前（这条改动前后都必须绿）=====
    cfg.routeOrder = "score";
    let rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    let body = await rr.text();
    check("A1 score 档直接命中可用渠道", rr.status === 200, `${rr.status} ${body.slice(0, 160)}`);
    check("A1 score 档只打 workbuddy", hits.wb === 1 && hits.trae === 0 && hits.wba === 0, JSON.stringify(hits));
    check("A1 无 failover 标记（主渠道即可用渠道）", !/failover/.test(lastRow().error || ""), String(lastRow().error));

    // ===== A2/A2b cost-first：空池免费/低成本渠道不得抢主渠道与候选预算 =====
    cfg.routeOrder = "cost-first";
    const wbBefore = hits.wb;
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A2 cost-first 有账号就必须出线（旧实现：便宜空池渠道吃掉预算 → 503）", rr.status === 200, `${rr.status} ${body.slice(0, 200)}`);
    check("A2 实际请求落在 workbuddy", hits.wb === wbBefore + 1 && hits.trae === 0 && hits.wba === 0, JSON.stringify(hits));
    check("A2b 记账归因 workbuddy（旧实现是最后一个空池候选）", lastRow().channel === "workbuddy", String(lastRow().channel));
    check("A2b 无 failover 标记（主渠道即可用渠道）", !/failover/.test(lastRow().error || ""), String(lastRow().error));

    // ===== A4 关掉故障转移（队列截到 1）：主渠道本身必须是能出请求的那个 =====
    cfg.channelFailover = false;
    const wbBefore4 = hits.wb;
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A4 单候选也必须是可用渠道", rr.status === 200, `${rr.status} ${body.slice(0, 200)}`);
    check("A4 打的是 workbuddy", hits.wb === wbBefore4 + 1 && lastRow().channel === "workbuddy", `${JSON.stringify(hits)} / ${lastRow().channel}`);
    cfg.channelFailover = true;

    // ===== A5 key 钉死空池渠道：候选队列仍要靠可用性把它救回来 =====
    store.updateKey(k.id, { route: "workbuddy_ai" });
    const wbBefore5 = hits.wb;
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A5 钉空池渠道后应跳备选成功", rr.status === 200, `${rr.status} ${body.slice(0, 200)}`);
    check("A5 跳到了 workbuddy", hits.wb === wbBefore5 + 1 && lastRow().channel === "workbuddy", JSON.stringify(hits));
    check("A5 轨迹如实记 failover:workbuddy_ai→…", /failover:workbuddy_ai→/.test(lastRow().error || ""), String(lastRow().error));
    store.updateKey(k.id, { route: "auto" });

    // ===== A6 单 owner 且空池：失败文案必须带渠道名与原因（旧实现只有「渠道暂不可用」）=====
    rr = await call({ model: "ai-only-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A6 单 owner 空池应 503", rr.status === 503, String(rr.status));
    check("A6 文案要报渠道名与原因", /workbuddy_ai/.test(body) && /无可用账号/.test(body), body.slice(0, 240));

    // ===== A7 全候选零上游请求：文案必须明说（否则明细行的渠道列会被读成「用它发过请求」）=====
    rr = await call({ model: "empty-pair-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A7 双 owner 全空应 503", rr.status === 503, String(rr.status));
    check("A7 文案要明说没发过上游请求", /未发起任何上游请求/.test(body), body.slice(0, 240));
    check("A7 轨迹要列全候选", /workbuddy_ai/.test(body) && /lobster/.test(body), body.slice(0, 240));

    // ===== A8 全部不可用：轨迹仍列出全部候选、条数 = channelFailoverMax（守 T6 / issue #74）=====
    store.updateAccount(w1, { status: "disabled" });
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A8 全渠道不可用应 503", rr.status === 503, String(rr.status));
    const m8 = /已尝试 (\d+) 个渠道（([^）]+)）/.exec(body);
    check("A8 轨迹格式应含「已尝试 N 个渠道（…）」", !!m8, body.slice(0, 240));
    if (m8) {
      check(`A8 轨迹条数 = channelFailoverMax=3`, Number(m8[1]) === 3, `实际 ${m8[1]}：${m8[2]}`);
      check("A8 空池便宜渠道也要计入轨迹", /modelscope/.test(m8[2]) && /lobster/.test(m8[2]) && /trae/.test(m8[2]), m8[2]);
    }
    store.updateAccount(w1, { status: "online", coolUntil: 0, coolReason: "" });

    // ===== A10 上游 400（fatal 透传）时不得反过来说「没发过请求」=====
    mode.wb = "fatal400";
    const wbBefore10 = hits.wb;
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    mode.wb = "ok";
    check("A10 确实打到了上游", hits.wb === wbBefore10 + 1, JSON.stringify(hits));
    check("A10 上游 400 应透传", rr.status === 400, String(rr.status));
    check("A10 文案不得声称没发过请求", !/未发起任何上游请求/.test(body), body.slice(0, 240));

    // ===== A3 免费渠道有号时仍优先（成本档语义在「都可用」时不变）=====
    const t1 = store.addAccount({ channel: "trae", uid: "ep2", name: "免费号", token: "tr-token", source: "paste", expiresAt: Date.now() + 7200000 });
    store.updateAccount(t1, { credits: 5, creditsAt: Date.now() });
    store.setAgentCostTier("trae", "free");
    const wbBefore3 = hits.wb;
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("A3 免费渠道有号时应成功", rr.status === 200, `${rr.status} ${body.slice(0, 200)}`);
    check("A3 免费渠道优先（余额远低于普通档也要先走）", hits.trae === 1 && hits.wb === wbBefore3, JSON.stringify(hits));
    check("A3 记账归因 trae", lastRow().channel === "trae", String(lastRow().channel));

    // ===== A9 routeUsable 与 pickAccount 判据同口径 =====
    if (typeof server.routeUsable !== "function") {
      check("A9 routeUsable 已导出", false, "旧实现没有 routeUsable（这条也算红）");
    } else {
      const mk = (channel, opts) => store.addAccount({ channel, uid: "ep-" + channel, name: channel + "号", token: opts.token, source: "paste", expiresAt: opts.expiresAt || 0 });
      const rcNoToken = mk("raccoon", { token: "" });
      check("A9 无 token 的号不算可用", server.routeUsable("raccoon") === false);
      const zcDead = mk("zcode", { token: "z-token" });
      store.updateAccount(zcDead, { credits: 0, creditsAt: Date.now() });
      check("A9 已知余额为 0 的号不算可用（pickAccount 会跳过并标 exhausted）", server.routeUsable("zcode") === false);
      const qdExpired = mk("qoder", { token: "q-token", expiresAt: Date.now() - 1000 });
      store.updateAccount(qdExpired, { credits: 5, creditsAt: Date.now() });
      check("A9 余额已到期的号不算可用", server.routeUsable("qoder") === false);
      const lbOk = mk("lobster", { token: "l-token", expiresAt: Date.now() + 7200000 });
      store.updateAccount(lbOk, { credits: 5, creditsAt: Date.now() });
      check("A9 有 online + 有 token + 未耗尽未过期才算可用", server.routeUsable("lobster") === true);
      store.removeAccount(rcNoToken);
      store.removeAccount(zcDead);
      store.removeAccount(qdExpired);
      store.removeAccount(lbOk);
    }
  } finally {
    fs.writeFileSync(headersPath, headersBackup);
    rules.reload("headers.json");
    await new Promise((r) => fake.close(r));
    server.stop();
    store.deleteKey(k.id);
    store.removeAccount(w1);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log("失败项：");
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log("EMPTY-POOL ROUTE SELFTEST OK（score 不受影响 / cost-first 可用优先 / 免费用量语义保留 / 文案与轨迹如实）");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error((e && e.stack) || e);
    process.exit(1);
  });
