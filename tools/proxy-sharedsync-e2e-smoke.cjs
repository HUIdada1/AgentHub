// 共享配置「收-发」双向最小系统验证：
// 本地 mock WebDAV（http://127.0.0.1 随机端口）+ 两个互不相干的沙盒设备（隔离 APPDATA），
// 真实执行 runSharedSync 的完整编排（拉取 → 解封 → applyShared → exportShared → 封套 → 上传）。
//
// 时序：
//   A 发（对端无文件 → 覆盖 404 分支 + 上传）
//   B 收（应用 A 的映射/Key/清单）→ B 增补自己的数据后再发（合并上传）
//   A 收（拿到 B 的增补：映射/Key/清单渠道）
//
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-sharedsync-e2e-smoke.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const SCRIPT = __filename;
const role = process.argv[2] || "";

async function main() {
  if (!role) return runParent();
  return runChild(role); // send | receive | receive2
}

// ===== mock WebDAV：按路径存取，PUT 201 / GET 200|404，其余 200 =====
// state.failGet=true 时 GET 一律 500（模拟网络/服务端故障，PUT 仍可用）：
// 用来验证「远端读不成 → 本轮不上传」，否则本机旧配置会盖掉对端更新的版本
function startMock() {
  const store = new Map();
  const hits = [];
  const state = { failGet: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push(req.method + " " + req.url);
      if (req.method === "PUT") { store.set(req.url, Buffer.concat(chunks)); res.statusCode = 201; res.end(); return; }
      if (req.method === "GET") {
        if (state.failGet) { res.statusCode = 500; res.end("boom"); return; }
        const b = store.get(req.url);
        if (!b) { res.statusCode = 404; res.end(); return; }
        res.statusCode = 200; res.end(b); return;
      }
      res.statusCode = 200; res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, store, hits, state, port: server.address().port })));
}

// ===== 父进程：起 mock，依次派发三个子设备，断言收发结果 =====
async function runParent() {
  const assert = (cond, msg) => { if (!cond) throw new Error("父断言失败: " + msg); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sharedsync-e2e-"));
  const dirA = path.join(tmp, "deviceA");
  const dirB = path.join(tmp, "deviceB");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const mock = await startMock();
  const w = { endpoint: `http://127.0.0.1:${mock.port}/`, username: "u", password: "p", root: "/agenthub-proxy" };
  const wFile = path.join(tmp, "w.json");
  fs.writeFileSync(wFile, JSON.stringify(w), "utf8");

  const runChild = (role2, workdir, extra) => new Promise((resolve, reject) => {
    const argsFile = path.join(tmp, `args-${role2}.json`);
    fs.writeFileSync(argsFile, JSON.stringify(extra || {}), "utf8");
    const p = spawn(process.execPath, [SCRIPT, role2, tmp, wFile], {
      env: { ...process.env, APPDATA: workdir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`子设备 ${role2} 退出码 ${code}\n${out}\n${err}`))));
  });

  try {
    // ---- A 发 ----
    const rA = await runChild("send", dirA);
    console.log("[A 发] 完成");
    const repA = JSON.parse(fs.readFileSync(path.join(tmp, "report-send.json"), "utf8"));
    assert(repA.uploaded === true, "A 应完成上传");
    // 传输层直查：mock 上确实出现了共享配置文件
    const storedPath = "/" + ["agenthub-proxy", "pool", "shared-config.json"].join("/");
    assert(mock.store.get(storedPath) && mock.store.get(storedPath).length > 100, "mock 上存在共享配置密文");

    // ---- B 收 + 发 ----
    await runChild("receive", dirB, { kASecret: repA.kASecret });
    console.log("[B 收+发] 完成");
    const repB = JSON.parse(fs.readFileSync(path.join(tmp, "report-receive.json"), "utf8"));

    // ---- A 收（B 的增补）----
    await runChild("receive2", dirA, { kBSecret: repB.kBSecret });
    console.log("[A 收] 完成");

    // ---- D 拉取失败：远端 GET 500 → 本轮不得上传（避免用本机旧配置盖掉对端更新）----
    const putsBeforeD = mock.hits.filter((h) => h.startsWith("PUT")).length;
    mock.state.failGet = true;
    const dirD = path.join(tmp, "deviceD");
    fs.mkdirSync(dirD, { recursive: true });
    await runChild("pullerror", dirD);
    mock.state.failGet = false;
    const repD = JSON.parse(fs.readFileSync(path.join(tmp, "report-pullerror.json"), "utf8"));
    assert(repD.pullError, "D 应记录拉取失败留痕");
    assert(repD.uploadSkipped === true, "D 拉取失败时本轮必须跳过上传");
    assert(repD.uploaded !== true, "D 不得上传");
    const putsAfterD = mock.hits.filter((h) => h.startsWith("PUT")).length;
    assert(putsAfterD === putsBeforeD, `拉取失败那轮不得产生 PUT（前 ${putsBeforeD} / 后 ${putsAfterD}）`);
    console.log("[D 拉取失败] 完成");

    // ---- 传输层总账：三次上传（A 发、B 发、A2 收后内容未变但记账为空仍会重传一次）----
    const puts = mock.hits.filter((h) => h.startsWith("PUT")).length;
    assert(puts >= 2, `至少两次真实 PUT（实际 ${puts}）`);
    console.log(`\n双向收发最小系统 PASS（mock PUT ${puts} 次，GET ${mock.hits.filter((h) => h.startsWith("GET")).length} 次）`);
    console.log(`沙盒: ${tmp}`);
  } finally {
    mock.server.close();
  }
  process.exit(0);
}

// ===== 子设备：隔离 APPDATA，真实跑 runSharedSync =====
async function runChild(role2) {
  const tmp = process.argv[3];
  const w = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const extra = JSON.parse(fs.readFileSync(path.join(tmp, `args-${role2}.json`), "utf8"));
  const assert = (cond, msg) => { if (!cond) throw new Error(`子设备 ${role2} 断言失败: ` + msg); };

  // APPDATA 已由父进程注入；先设 env 再 require（config 在 require 时解析目录）
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const config = require("../electron/backend/config.cjs");
  const poolsync = require("../electron/backend/proxy/poolsync.cjs");
  store.open();
  rules.init();

  if (role2 === "send") {
    const T2 = Date.now() - 3600000;
    const kA = store.createKey({ name: "A-key", route: "trae", routeOrder: "cost-first", dailyQuota: 3, rateLimit: 0 });
    const cfg = config.loadConfig();
    cfg.proxy.modelAliases = { "qa": "m1" };
    config.saveConfig(cfg);
    fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"),
      JSON.stringify({ trae: { syncedAt: T2, models: [{ id: "m1", name: "A拉取", rate: 0.9, contextLength: 200000 }] } }, null, 2), "utf8");
    rules.reload("catalog.json");

    const result = {};
    await poolsync.runSharedSync(w, {}, result); // 对端无文件：走 404 分支 → 只上传
    assert(result.sharedUploaded === true, "A 上传应发生");
    assert(!result.sharedFrom, "A 是首站，不应有拉取来源");
    fs.writeFileSync(path.join(tmp, "report-send.json"),
      JSON.stringify({ uploaded: true, kAId: kA.id, kASecret: kA.secret }), "utf8");
    console.log("  send: uploaded=true");
    return;
  }

  if (role2 === "receive") {
    // B 自有数据：Key、回退映射、 lobster 清单（T3 更新）；默认 trae 保持 syncedAt 0
    const T3 = Date.now();
    const kB = store.createKey({ name: "B-key", route: "auto", dailyQuota: 0, rateLimit: 0 });
    const cfg = config.loadConfig();
    cfg.proxy.modelFallback = { "m2": "m1" };
    config.saveConfig(cfg);
    const cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    cur.lobster = { syncedAt: T3, models: [{ id: "l1", name: "B拉取", rate: 1, contextLength: 128000 }] };
    fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify(cur, null, 2), "utf8");
    rules.reload("catalog.json");

    const result = {};
    await poolsync.runSharedSync(w, {}, result);
    console.log("  receive result:", JSON.stringify(result));
    assert(result.sharedFrom, "B 应拉取并应用 A 的共享包（记录来源设备）");
    assert(result.sharedFrom, "B 应记录来源设备");
    assert(result.sharedConfigChanged === 1, `B 映射合并应恰好 1 项（实际 ${result.sharedConfigChanged}）`);
    assert(result.sharedKeyAdded === 1, `B 应只补 1 把 Key（实际 ${result.sharedKeyAdded}）`);
    assert(result.sharedCatalogUpdated === 1 && result.sharedCatalogAdded === 0,
      `B 清单应「trae 更新 1、新增 0」（实际 u=${result.sharedCatalogUpdated} a=${result.sharedCatalogAdded}）`);
    assert(result.sharedUploaded === true, "B 合并后应上传");
    // 语义核验
    const hitA = store.findKeyBySecret(extra.kASecret);
    assert(hitA && hitA.route === "trae" && hitA.routeOrder === "cost-first", "A 的 Key 在 B 可鉴权（含路由策略）");
    const cat = rules.get("catalog.json");
    const m1 = (cat.trae.models || []).find((m) => m.id === "m1");
    assert(m1 && m1.rate === 0.9 && m1.contextLength === 200000, "A 的清单及参数在 B 生效");
    assert(cat.lobster && cat.lobster.models[0].id === "l1", "B 自有清单未丢");
    const cfg2 = config.loadConfig();
    assert(cfg2.proxy.modelAliases.qa === "m1" && cfg2.proxy.modelFallback.m2 === "m1", "B 配置=自有回退 + A 的别名");
    fs.writeFileSync(path.join(tmp, "report-receive.json"),
      JSON.stringify({ kBId: kB.id, kBSecret: kB.secret }), "utf8");
    const exB = poolsync.exportShared();
    console.log("  B 导出目录:", Object.entries(exB.catalog).map(([k, v]) => `${k}@${v.syncedAt || 0}(${(v.models || []).length}个)`).join(", "));
    console.log(`  receive: applied 来自 ${result.sharedFrom}；配置+1 Key+1 清单渠道更新1；已回传`);
    return;
  }

  if (role2 === "receive2") {
    // A 二次运行（全新记账）：拉到 B 的增补
    const localCat0 = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    console.log("  A2 本地目录:", Object.entries(localCat0).map(([k, v]) => `${k}@${v.syncedAt || 0}(${(v.models || []).length}个)`).join(", "));
    const result = {};
    await poolsync.runSharedSync(w, {}, result);
    assert(result.sharedFrom, "A 二次应拉取并应用 B 的共享包（记录来源设备）");
    assert(result.sharedConfigChanged === 1, `A 映射合并应恰好 1 项（实际 ${result.sharedConfigChanged}）`);
    assert(result.sharedKeyAdded === 1, `A 应补 1 把 Key（实际 ${result.sharedKeyAdded}）`);
    assert(result.sharedCatalogUpdated === 1 && result.sharedCatalogAdded === 0,
      `A 清单应「lobster 按 syncedAt 新者胜更新 1：本地默认 stub@0 ← B 的真实拉取 T3；无新增」（实际 a=${result.sharedCatalogAdded} u=${result.sharedCatalogUpdated}）`);
    const hitB = store.findKeyBySecret(extra.kBSecret);
    assert(hitB, "B 的 Key 回传后 A 可鉴权");
    const cat = rules.get("catalog.json");
    assert(cat.lobster && cat.lobster.models[0].id === "l1", "B 的清单渠道回传到 A");
    const m1 = (cat.trae.models || []).find((m) => m.id === "m1");
    assert(m1 && m1.rate === 0.9, "A 原有清单未被 B 侧等龄副本覆盖");
    const cfg = config.loadConfig();
    assert(cfg.proxy.modelAliases.qa === "m1" && cfg.proxy.modelFallback.m2 === "m1", "A 配置=自有别名 + B 侧带来的回退");
    console.log(`  receive2: 来自 ${result.sharedFrom}；配置+1 Key+1 清单渠道新增1`);
    return;
  }
  if (role2 === "pullerror") {
    // 远端 GET 报错（由父进程把 mock 切到 500）：可以留痕、可以跳过上传，但不能推自己的版本
    const cfgD = config.loadConfig();
    cfgD.proxy.modelAliases = { "本地新别名": "m-local" };
    config.saveConfig(cfgD);
    const result = {};
    await poolsync.runSharedSync(w, {}, result);
    console.log("  pullerror result:", JSON.stringify(result));
    assert(result.sharedPullError, "应记录 sharedPullError");
    assert(result.sharedUploadSkipped === true, "远端读不成时必须跳过上传（否则会盖掉对端更新）");
    assert(result.sharedUploaded !== true, "不得上传");
    assert(result.sharedDecodeError === undefined, "这是 GET 失败，不是解封失败");
    fs.writeFileSync(path.join(tmp, "report-pullerror.json"),
      JSON.stringify({ pullError: result.sharedPullError, uploadSkipped: result.sharedUploadSkipped, uploaded: result.sharedUploaded === true }), "utf8");
    return;
  }
  throw new Error("未知角色 " + role2);
}

main().then(() => { if (role) process.exit(0); }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
