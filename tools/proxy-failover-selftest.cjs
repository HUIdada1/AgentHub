// 反代网关跨渠道故障转移自测（v1.40.0）：503 耗尽 → 渠道降级 → 请求内跳备选 → 降级避让 →
// 半开回切 → 指数退避翻倍 → failover 开关 → 全渠道耗尽带轨迹报错
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-failover-selftest.cjs <临时数据目录>
//
// 时序语义说明：本脚本用 base=1500ms 的压缩节奏，让「半开探测再失败」落在 noteChannelFail
// 的 60s 连败窗内（单次失败即凑满 2 连 → 立刻再降级、streak+1），验证的是 streak 数学与
// 降级状态机本身。产品默认 base=120s 时节奏不同：降级过期后的首次失败距上次失败已超 60s、
// 连败计数重置为 1，不会立即再降级——要在 60s 窗内再连败 2 次才会以 streak+1 翻倍重降，
// 与「连续 2 次真实失败才降级」的防抖动准则自洽。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-failover-test-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const server = require("../electron/backend/proxy/server.cjs");
  // T6 用它推导「拥有该模型的渠道集合」，避免硬编码渠道数/顺序（渠道会持续新增）
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  store.open();
  rules.init();
  assert(Object.keys(server.channelHealthSnapshot()).length === 0, "初始渠道健康快照为空");

  // ===== 假上游：trae / workbuddy_ai 两个渠道的 chatUrl 都指过来，mode 可切换 boom/ok =====
  const http = require("node:http");
  const hits = { trae: 0, wba: 0, wb: 0 };
  const mode = { trae: "boom", wba: "ok", wb: "boom" };
  const fake = http.createServer((req, res) => {
    const url = req.url || "";
    req.on("data", () => {});
    req.on("end", () => {
      const channel = url.includes("/trae/") ? "trae" : url.includes("/wba/") ? "wba" : url.includes("/wb/") ? "wb" : "";
      if (!channel) {
        res.writeHead(404);
        res.end();
        return;
      }
      hits[channel]++;
      if (mode[channel] === "boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":{"message":"upstream 5xx boom"}}');
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
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"' + channel.toUpperCase() + '"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{"content":" ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
          "data: [DONE]\n\n"
        );
      }
    });
  });
  await new Promise((r) => fake.listen(19532, "127.0.0.1", r));

  // headers.json 热加载指向假上游
  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersBackup = fs.readFileSync(headersPath, "utf8");
  const headersCfg = JSON.parse(headersBackup);
  headersCfg.trae.chatUrl = "http://127.0.0.1:19532/trae/chat";
  headersCfg.trae.mirrorChatUrl = "";
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19532/wb/chat";
  // WB AI 的 chat 先试 consoleChatUrl 再试 chatUrl（非 404/405 直接上抛）——必须也指向假上游，
  // 否则请求打到真实上游吃 401，fake 计数恒 0
  headersCfg.workbuddy_ai.consoleChatUrl = "";
  headersCfg.workbuddy_ai.chatUrl = "http://127.0.0.1:19532/wba/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // ===== 种子：trae 余额最高（半开回切时 auto 打分回到它），wba 次之；wb/zcode 无账号 =====
  const t1 = store.addAccount({ channel: "trae", uid: "ft1", name: "T主号", token: "t-token", source: "paste", expiresAt: Date.now() + 7200000 });
  const w1 = store.addAccount({ channel: "workbuddy_ai", uid: "fw1", name: "WBA备号", token: "w-token", source: "paste", expiresAt: Date.now() + 7200000 });
  store.updateAccount(t1, { credits: 1000, creditsAt: Date.now() });
  store.updateAccount(w1, { credits: 900, creditsAt: Date.now() });

  // 降级基础时长 1500ms（测试压缩节奏；「同一波」窗口 = base/2 = 750ms，T1→T4 的间隔已超出，
  // 半开翻倍语义可验证）；wb/zcode 无账号，glm-5.3 在干净目录下归属 trae/workbuddy_ai/zcode
  const cfg = {
    port: 19531, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [],
    channelFailover: true, channelFailoverMax: 3,
    channelCooldownMs: 1500, channelCooldownCapMs: 6000,
  };
  const sr = await server.start(() => cfg);
  assert(sr.ok, "网关启动: " + (sr.message || ""));
  const base = "http://127.0.0.1:19531";
  const k = store.createKey({ name: "failover自测", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const call = (payload) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify(payload),
    });
  const bodyMsg = [{ role: "user", content: "hi" }];

  // ===== T1 请求内跨渠道故障转移：trae 500 打光（单账号）→ 跳 workbuddy_ai 成功 =====
  // 渠道级降级需连续 2 次真实失败（保留账号侧「单次 5xx 不罚号」防雪崩节奏），此时未降级
  let rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T1 主渠道耗尽后跳备选成功: " + rr.status);
  let jb = await rr.json();
  assert(jb.choices[0].message.content === "WBA ok", "T1 内容来自备选渠道: " + JSON.stringify(jb).slice(0, 120));
  assert(hits.trae === 1 && hits.wba === 1, "T1 主渠道打 1 次（单号打光）+ 备选 1 次: " + JSON.stringify(hits));
  let row = store.recentRequests(1)[0];
  assert(row.channel === "workbuddy_ai", "T1 记账归因备选渠道: " + row.channel);
  assert(/failover:trae→/.test(row.error || ""), "T1 记账轨迹 failover:trae→…: " + row.error);
  assert(!server.channelHealthSnapshot().trae, "T1 单次失败不降级（防抖动）");

  // ===== T2 连续第二次真实失败触发渠道降级，本请求仍内跳备选成功 =====
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T2 第二次失败仍内跳成功: " + rr.status);
  await rr.text();
  assert(hits.trae === 2, "T2 连续第二次真实打主渠道: " + JSON.stringify(hits));
  let snap = server.channelHealthSnapshot();
  assert(snap.trae && snap.trae.streak === 0, "T2 连续 2 次失败触发降级（streak=0 起）: " + JSON.stringify(snap.trae));
  row = store.recentRequests(1)[0];
  assert(row.channel === "workbuddy_ai" && /failover:trae→/.test(row.error || ""), "T2 记账轨迹: " + row.error);

  // ===== T2b 降级避让：auto 路由打分避开降级渠道，新请求不再撞它 =====
  const wbaBefore = hits.wba;
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T2b 降级避让后成功: " + rr.status);
  await rr.text();
  assert(hits.trae === 2, "T2b 降级渠道零打扰（不再撞墙）: " + JSON.stringify(hits));
  assert(hits.wba === wbaBefore + 1, "T2b 流量走备选");
  row = store.recentRequests(1)[0];
  assert(row.channel === "workbuddy_ai" && !/failover/.test(row.error || ""), "T2b 主渠道即备选，无 failover 标记: " + row.error);

  // ===== T3 fixed 路由也跳：主渠道降级中被跳过，实际走备选且带 failover 轨迹 =====
  cfg.routeStrategy = "fixed";
  cfg.fixedChannel = "trae";
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T3 fixed 路由降级跳备选成功: " + rr.status);
  await rr.text();
  assert(hits.trae === 2, "T3 fixed 也不撞降级渠道: " + JSON.stringify(hits));
  row = store.recentRequests(1)[0];
  assert(row.channel === "workbuddy_ai" && /failover:trae→/.test(row.error || ""), "T3 fixed 轨迹: " + row.error);
  cfg.routeStrategy = "smart";

  // ===== T4 半开探测失败指数翻倍：到期后探测再失败 streak 逐次 +1 =====
  // T1/T2 已是账号 2 连 5xx，再打一次会触发账号级 3 连熔断（30min）把 t1 下线、
  // 半开探测根本发不出去——每个半开节点前重置账号级状态，单测渠道级语义
  pool.noteSuccess(t1);
  store.updateAccount(t1, { status: "online", coolUntil: 0, coolReason: "" });
  await sleep(1600); // 等 T2 的 1500ms 降级过期（半开窗口）
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T4a 半开探测失败仍跳备选成功: " + rr.status);
  await rr.text();
  assert(hits.trae === 3, "T4a 半开真实探测了主渠道: " + JSON.stringify(hits));
  snap = server.channelHealthSnapshot();
  assert(snap.trae && snap.trae.streak === 1, "T4a 半开再失败 streak=1: " + JSON.stringify(snap.trae));
  const left1 = snap.trae.until - Date.now();
  assert(left1 > 2800 && left1 <= 3000, "T4a 指数退避 2×base(1500ms)=3000ms: " + left1);

  pool.noteSuccess(t1); // 清 T4a 的一连 5xx，防 T4b 的 500 触发账号级 3 连熔断
  store.updateAccount(t1, { status: "online", coolUntil: 0, coolReason: "" });
  await sleep(3100); // 等 streak=1 的 3000ms 过期
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T4b 二次半开失败仍跳备选成功: " + rr.status);
  await rr.text();
  assert(hits.trae === 4, "T4b 半开真实探测了主渠道: " + JSON.stringify(hits));
  snap = server.channelHealthSnapshot();
  assert(snap.trae && snap.trae.streak === 2, "T4b 三连失败 streak=2: " + JSON.stringify(snap.trae));
  const left2 = snap.trae.until - Date.now();
  assert(left2 > 5800 && left2 <= 6000, "T4b 指数退避 4×base=6000ms（封顶）: " + left2);

  // ===== T4c 成功回切清零：恢复后 auto 打分回到余额最充足的主渠道 =====
  mode.trae = "ok";
  // T1/T4a/T4b 三次 trae 500 会如实触发账号级 5xx 熔断（连续 3 次 → cooling 30min），
  // 把主渠道打分的 onlineCount 打成 0——这里重置账号状态与熔断计数，单测渠道级语义
  pool.noteSuccess(t1);
  store.updateAccount(t1, { status: "online", coolUntil: 0, coolReason: "" });
  await sleep(6100); // 等 streak=2 的 6000ms 降级过期
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T4c 半开回切成功: " + rr.status);
  jb = await rr.json();
  assert(jb.choices[0].message.content === "TRAEO", "T4c 内容来自回切的主渠道: " + JSON.stringify(jb).slice(0, 400));
  assert(hits.trae === 5, "T4c 回切后真实打到主渠道: " + JSON.stringify(hits));
  row = store.recentRequests(1)[0];
  assert(row.channel === "trae", "T4c 回切记账归因主渠道: " + row.channel);
  assert(!server.channelHealthSnapshot().trae, "T4c 成功后降级态清零（streak 一并清）");

  // ===== T5 failover 关闭：fixed 主渠道连败 2 次降级，降级中跳无可跳报 503 =====
  mode.trae = "boom";
  cfg.routeStrategy = "fixed";
  cfg.fixedChannel = "trae";
  cfg.channelFailover = false;
  const wbaHitsBefore = hits.wba;
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status >= 500, "T5a 关 failover 后主渠道失败如实报错: " + rr.status);
  await rr.text();
  assert(hits.wba === wbaHitsBefore, "T5a 备选渠道零打扰: " + JSON.stringify(hits));
  assert(!server.channelHealthSnapshot().trae, "T5a 单次失败不降级");
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status >= 500, "T5b 第二次失败仍如实报错: " + rr.status);
  await rr.text();
  assert(hits.trae === 7, "T5b 连败 2 次均真实尝试: " + JSON.stringify(hits));
  assert(server.channelHealthSnapshot().trae, "T5b 连败 2 次触发降级");
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 503, "T5c 降级中跳无可跳报 503: " + rr.status);
  const t5err = (await rr.json()).error.message;
  assert(/降级中/.test(t5err), "T5c 报错含降级原因: " + t5err);
  assert(hits.trae === 7, "T5c 降级渠道不被真实请求: " + JSON.stringify(hits));
  cfg.routeStrategy = "smart";
  cfg.channelFailover = true;

  // ===== T6 全渠道耗尽：报错带完整渠道轨迹（无账号的渠道 poolEmpty 也计入轨迹） =====
  mode.wba = "boom";
  await sleep(1700); // 等 T5b 的 1500ms 降级过期
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status >= 500, "T6 全渠道失败报错: " + rr.status);
  const t6err = (await rr.json()).error.message;
  // 轨迹断言**不硬编码渠道名/条数**：轨迹长度由 channelFailoverMax 预算决定（此处 3），
  // 内容取决于当时「拥有该模型且被路由到」的渠道。原先写死 "已尝试 3 个渠道" +
  // "trae→workbuddy_ai→zcode"，每新增一个拥有 glm-5.3 的渠道就误报
  // （实测：新增 lobster 后轨迹从 trae→workbuddy_ai→zcode 变为 trae→workbuddy_ai→lobster）。
  // 现改为断言**语义不变量**：条数=预算上限、以主渠道 trae 开头、真实打过且失败的两个渠道
  // 相对有序、无账号渠道也计入轨迹（poolEmpty 不静默）。
  const m6 = /已尝试 (\d+) 个渠道（([^）]+)）/.exec(t6err);
  assert(m6, "T6 轨迹格式应含「已尝试 N 个渠道（…）」: " + t6err);
  const trail = m6[2].split("→");
  assert(
    trail.length === cfg.channelFailoverMax,
    `T6 轨迹条数应等于 channelFailoverMax 预算（${cfg.channelFailoverMax}），实际 ${trail.length}：${trail.join("/")}`
  );
  assert(trail[0] === "trae", "T6 轨迹以主渠道 trae 开头: " + trail.join("→"));
  assert(
    trail.includes("trae") && trail.includes("workbuddy_ai") &&
      trail.indexOf("trae") < trail.indexOf("workbuddy_ai"),
    "T6 轨迹含真实打过的 trae→workbuddy_ai 且相对有序: " + trail.join("→")
  );
  // 无账号的渠道（poolEmpty）也必须计入轨迹，不得静默
  const accountChannels = new Set(["trae", "workbuddy_ai"]);
  assert(
    trail.some((c) => !accountChannels.has(c)),
    "T6 无账号渠道（poolEmpty）也应计入轨迹: " + trail.join("→")
  );
  // 轨迹里的渠道必须都真的拥有该模型（防串到无关渠道）
  const owners6 = new Set(adapters.modelOwners("glm-5.3"));
  for (const c of trail) {
    assert(owners6.has(c), `T6 轨迹渠道 ${c} 应拥有该模型（owners=${[...owners6].join("/")}）`);
  }

  // ===== T7 恢复后成功：回切主渠道 + 清零；无账号且目录无此模型的渠道从未被打 =====
  mode.trae = "ok";
  mode.wba = "ok";
  pool.noteSuccess(t1);
  pool.noteSuccess(w1);
  store.updateAccount(t1, { status: "online", coolUntil: 0, coolReason: "" });
  store.updateAccount(w1, { status: "online", coolUntil: 0, coolReason: "" });
  await sleep(3300); // 等 T6 里 trae streak=1 的 3000ms 降级过期
  rr = await call({ model: "glm-5.3", stream: false, messages: bodyMsg });
  assert(rr.status === 200, "T7 恢复后成功: " + rr.status);
  await rr.text();
  snap = server.channelHealthSnapshot();
  assert(!snap.trae, "T7 trae 成功清零: " + JSON.stringify(snap));
  assert(hits.wb === 0, "T7 无账号且目录无此模型的渠道从未被打");

  // ===== 收尾：恢复规则文件，关服务与假上游，清种子 =====
  fs.writeFileSync(headersPath, headersBackup);
  rules.reload("headers.json");
  await new Promise((r) => fake.close(r));
  server.stop();
  store.deleteKey(k.id);
  store.removeAccount(t1);
  store.removeAccount(w1);
  console.log("FAILOVER SELFTEST OK（跨渠道跳转 / 降级避让 / fixed 跳备选 / 半开翻倍 / 成功回切清零 / 开关 / 全渠道轨迹）");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILOVER SELFTEST FAIL:", e);
    process.exit(1);
  });
