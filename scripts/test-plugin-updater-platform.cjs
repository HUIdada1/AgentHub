/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 板块 4C「更新器平台化」离线自测（专项 §四 S2、§八 V1、§十 第 5 条 T8）
//
// 三件事，逐条可复核：
//   ① 容器 require 链纯净：把裸名 "electron" 拦成 MODULE_NOT_FOUND，
//      再 require plugin-updater.cjs 整条链必须起得来（V1：否则容器启动崩第二个包）。
//   ② 无头形态网络出口真能用：platform/node.cjs 的 fetchBinary
//      对本地 http 服务跑「成功 / 404 / 超大小 / 超时 / 代理协议不支持」五种结果，
//      并且错误对象带得上 httpStatus / networkLike（调用方靠这两个字段决定换不换代理）。
//   ③ 无头形态不探本机代理端口：localProxyCandidates() 必须是空集。
//
// 跑法：node scripts/test-plugin-updater-platform.cjs
//      （需要 Node ≥18：全局 fetch / AbortSignal.timeout；仓库自测按既有约定优先用 Electron-as-node）
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "electron", "backend");

// ===== ① require 链纯净：拦掉 electron =====
function requireWithoutElectron(relFromRoot) {
  const hits = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron" || request === "undici") {
      hits.push({ pkg: request, requiredBy: parent && parent.filename ? path.relative(ROOT, parent.filename) : "(entry)" });
      const e = new Error(`Cannot find module '${request}'`);
      e.code = "MODULE_NOT_FOUND";
      throw e;
    }
    return origLoad.apply(this, arguments);
  };
  try {
    const mod = require(path.join(ROOT, relFromRoot));
    return { mod, hits };
  } finally {
    Module._load = origLoad;
  }
}

// 顶层 require 的 electron 才是容器杀手：延迟到函数里的 require("electron") 在桌面路径上
// 才可达（容器形态 form()==="node"，压根不会走到 electron.cjs），
// 所以这里同时断言「源码里没有顶层 electron」这条静态事实。
function topLevelRequires(source) {
  const out = [];
  const re = /^\s*(?:const|let|var)[^\n=]*\brequire\(\s*["']([^"']+)["']\s*\)/gm;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

function checkStaticPurity() {
  const updaterSrc = fs.readFileSync(path.join(BACKEND, "plugin-updater.cjs"), "utf8");
  const ups = topLevelRequires(updaterSrc);
  assert.ok(!ups.includes("electron"), `plugin-updater.cjs 不得顶层 require("electron")，实际顶层有：${JSON.stringify(ups)}`);
  assert.ok(!ups.includes("node:net"), "portOpen 已移到平台层，业务侧不该再自己连 socket");
  // 平台层入口按形态分发，两个实现都不得顶层碰 electron（node.cjs 尤其）
  const nodeSrc = fs.readFileSync(path.join(BACKEND, "proxy", "platform", "node.cjs"), "utf8");
  assert.ok(!topLevelRequires(nodeSrc).includes("electron"), "platform/node.cjs 不得顶层 require electron");
  assert.ok(!topLevelRequires(nodeSrc).includes("undici"), "platform/node.cjs 的 undici 必须延迟 require（没装 undici 的安装包不得在启动期崩）");
  console.log("PASS ① 静态：plugin-updater 与 platform/node 顶层均不触达 electron（undici 延迟加载）");
}

// 容器形态下**允许**存在的 electron 触达点：函数内 + try/catch 包住的惰性探测。
// 这类点在没有 electron 的环境里自己吞掉异常，不会把 require 链打断，
// 属于 4C 之前就有的既有设计（gateway 现在也正是这么加载起来的），不是本次回归。
// 新增文件一律不得进这个名单——4C 的红线是「新代码不得顶层 require electron」。
const ALLOWED_LAZY_ELECTRON = /^(electron[/\\]backend[/\\]config\.cjs)$/;

function checkRequireChainPurity() {
  // 容器形态下整条 updater 链必须在没有 electron 的环境里加载成功
  const { mod: updater, hits } = requireWithoutElectron(path.join("electron", "backend", "plugin-updater.cjs"));
  assert.ok(updater, "require 整条更新器链必须成功（这是 V1 的验收：容器不得二次崩）");
  const offenders = hits.filter(h => h.pkg === "electron" && !ALLOWED_LAZY_ELECTRON.test(h.requiredBy));
  assert.deepEqual(offenders, [], `4C 相关文件仍触达 electron（应全部收口到 platform/electron.cjs）：${JSON.stringify(offenders)}`);
  assert.deepEqual(hits.filter(h => h.pkg === "undici"), [], "undici 必须延迟 require，不得进启动链");
  assert.equal(typeof updater.init, "function");
  assert.equal(typeof updater.check, "function");
  assert.equal(typeof updater.apply, "function");
  assert.equal(typeof updater.getStatus, "function");
  // 对外契约不许缩水：桌面 main.cjs / ipc.cjs 用的就是这几个名字
  assert.equal(updater.DEFAULT_FEED, "https://github.com/UltimateREN/AgentHub_skill/releases/latest/download/plugin-index.json");
  const platform = require(path.join(BACKEND, "proxy", "platform", "index.cjs"));
  assert.equal(platform.form(), "node", "纯 Node 下必须是 node 形态（否则本文件的容器断言无意义）");
  console.log(`PASS ① 运行期：无 electron 环境 require 整条更新器链成功（form()=node；已核 ${hits.length} 处受保护惰性点，越线 0 处）`);
}

// ===== ② / ③ 无头 fetchBinary =====
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function checkFetchBinary() {
  const platform = require(path.join(BACKEND, "proxy", "platform", "index.cjs"));
  const payload = Buffer.from(JSON.stringify({ schema: 1, plugins: [] }), "utf8");
  const server = await listen((req, res) => {
    if (req.url === "/index.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(payload); return; }
    if (req.url === "/big.zip") {
      res.writeHead(200);
      // 分块往外灌，永不结束：靠大小上限拦停
      const chunk = Buffer.alloc(64 * 1024, 7);
      const pump = () => { if (!res.write(chunk)) res.once("drain", pump); else pump(); };
      pump();
      return;
    }
    if (req.url === "/gone") { res.writeHead(404); res.end("nope"); return; }
    if (req.url === "/slow") { return; /* 永不响应，留给超时 */ }
    res.writeHead(500); res.end("boom");
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 成功：原样拿到字节
    const got = await platform.fetchBinary(`${base}/index.json`, { maxBytes: 1024 * 1024, timeoutMs: 3000, proxyRule: null });
    assert.ok(Buffer.isBuffer(got), "fetchBinary 必须回 Buffer");
    assert.deepEqual(JSON.parse(got.toString("utf8")), { schema: 1, plugins: [] });

    // 非 2xx：必须带 httpStatus（调用方据此「不换代理」）
    await assert.rejects(() => platform.fetchBinary(`${base}/gone`, { maxBytes: 1024, timeoutMs: 3000 }), (error) => {
      assert.equal(error.httpStatus, 404, `httpStatus 应透传，实际 ${error.httpStatus}`);
      assert.match(String(error.message), /HTTP 404/);
      return true;
    });

    // 超大小：立即拦停，不回 Buffer
    await assert.rejects(() => platform.fetchBinary(`${base}/big.zip`, { maxBytes: 256 * 1024, timeoutMs: 5000 }), (error) => {
      assert.match(String(error.message), /超过大小限制/);
      assert.equal(error.httpStatus, undefined, "超大小不是 HTTP 状态错误，不该带 httpStatus");
      return true;
    });

    // 超时：错误必须可被判为网络类（否则调用方会直接判死、不再试下一个代理）
    await assert.rejects(() => platform.fetchBinary(`${base}/slow`, { maxBytes: 1024, timeoutMs: 300 }), (error) => {
      assert.equal(error.networkLike, true, "超时必须标 networkLike，否则不会换代理重试");
      assert.match(String(error.message), /请求超时/);
      return true;
    });

    // 连不上（端口没人听）：真因必须浮到 message 与 networkLike 上
    await assert.rejects(() => platform.fetchBinary(`http://127.0.0.1:1/x`, { maxBytes: 1024, timeoutMs: 1500 }), (error) => {
      assert.equal(error.networkLike, true, "连接失败必须标 networkLike");
      assert.equal(error.httpStatus, undefined, "连不上不是 HTTP 状态错误，不该带 httpStatus");
      assert.match(String(error.message), /插件源请求失败/);
      return true;
    });

    // 代理协议不支持：报错而不是静默直连（静默直连会把内网包发到公网）
    await assert.rejects(() => platform.fetchBinary(`${base}/index.json`, { maxBytes: 1024, timeoutMs: 3000, proxyRule: "ftp://127.0.0.1:21" }), (error) => {
      assert.equal(error.code, "ERR_PROXY_UNSUPPORTED");
      return true;
    });
    console.log("PASS ② node fetchBinary：成功 / 404+httpStatus / 超大小 / 超时+networkLike / 连不上 / 代理协议拒绝");

    // ③ 容器形态绝不探本机代理端口
    assert.deepEqual(await platform.localProxyCandidates(), [], "node 形态的 localProxyCandidates 必须是空集");
    console.log("PASS ③ node 形态 localProxyCandidates() = []（不探本机 7897 之类，避免假阴性）");
  } finally {
    server.closeAll?.();
    server.close();
  }
}

// ===== ④ 容器保守默认：自动链路默认关，手动入口不受影响 =====
function checkAutoApplyGate() {
  const updater = require(path.join(BACKEND, "plugin-updater.cjs"));
  delete process.env.AGENTHUB_PLUGIN_AUTO_UPDATE;
  assert.equal(updater.autoApplyAllowed(), false, "容器形态默认不得跑自动更新（专项 §四 S2 / §七 R3）");
  process.env.AGENTHUB_PLUGIN_AUTO_UPDATE = "1";
  assert.equal(updater.autoApplyAllowed(), true, "显式设 AGENTHUB_PLUGIN_AUTO_UPDATE=1 才放行");
  delete process.env.AGENTHUB_PLUGIN_AUTO_UPDATE;
  const status = updater.getStatus();
  assert.ok("autoApply" in status && "form" in status, "status 要带 autoApply/form，前端才能诚实显示");
  console.log("PASS ④ 容器自动链路默认关（手动 check/apply 不受此闸约束）");
}

// ===== ⑤ 桌面实现（platform/electron.cjs）本身的形状 =====
// 纯 Node 下也能 require 它（顶层不碰 electron），所以这里可以直接把桌面分支的
// 导出契约与「本机端口探测」跑起来验一遍——不这么做，electron 分支里的
// 笔误（例如方法名自调用）要等到用户真在桌面上点更新才炸。
async function checkElectronImplShape() {
  const impl = require(path.join(BACKEND, "proxy", "platform", "electron.cjs"));
  const nodeImpl = require(path.join(BACKEND, "proxy", "platform", "index.cjs"));
  for (const m of ["fetchBinary", "localProxyCandidates"]) {
    assert.equal(typeof impl[m], "function", `platform/electron.cjs 缺少 ${m}()`);
    assert.equal(typeof nodeImpl[m], "function", `平台入口未导出 ${m}()（index.cjs 的白名单漏了）`);
  }
  const startedAt = Date.now();
  const list = await impl.localProxyCandidates();
  assert.ok(Array.isArray(list), "localProxyCandidates 必须回数组");
  for (const rule of list) assert.match(String(rule), /^(https?|socks5):\/\/127\.0\.0\.1:/, `候选必须来自本机端口清单，实际 ${rule}`);
  assert.ok(Date.now() - startedAt < 5000, "本机端口探测必须有界（5 个候选 × 250ms，不得挂住）");

  // 没有 electron API 时 fetchBinary 必须是「拒绝的 promise」，不能同步抛、更不能拖崩进程
  await assert.rejects(() => impl.fetchBinary("https://example.invalid/x", { maxBytes: 1024, timeoutMs: 500 }));
  console.log(`PASS ⑤ 桌面实现形状：两方法齐备、探测有界（${list.length} 个在监听）、无 electron 时按 promise 拒绝`);
}

// ===== ⑥ feed 口径：部署期环境变量 > config > 内置，且只认 https =====
function checkFeedResolution() {
  const updater = require(path.join(BACKEND, "plugin-updater.cjs"));
  delete process.env.AGENTHUB_PLUGIN_FEED;
  // 基线取「本机 config 说了算」的值，避免断言绑死某台机器的配置
  const baseline = updater.getSettings().feedUrl;
  assert.ok(/^https:\/\//.test(baseline), `生效 feed 必须是 https，实际 ${baseline}`);

  // 下面是 4B/4D 共用的那份契约：三个字段名与取值口径一次锁死，避免两边各猜一套。
  //
  // ⚠ 必须**逐字段 assert**，不可以「JSON.stringify 出来一样」代替：本板块真踩过一次 ——
  //   pickFeed 的键从 source 改成 feedSource 时漏改消费点，值变成 undefined，
  //   而 **JSON.stringify 会把值为 undefined 的键静默丢掉**，快照比对只表现为"少一个字段"，
  //   很容易当成无关差异糊过去，其实字段已经哑了。逐字段断言会当场炸出 actual=undefined。
  const mirror = "https://mirror.internal/agenthub/plugin-index-linux-x64-glibc.json";
  const expectBaselineSource = baseline === updater.DEFAULT_FEED ? "default" : "config";
  const s0 = updater.getSettings();
  assert.equal(typeof s0.then, "undefined", "getSettings 必须同步返回（gateway 在 GET /api/plugins 里每次调）");
  assert.equal(s0.feedSource, expectBaselineSource, "没设 env 时来源应当是 config/default");
  assert.equal(s0.lockedByEnv, false, "env 没设就不算被锁，PUT 应放行");

  process.env.AGENTHUB_PLUGIN_FEED = mirror;
  const sEnv = updater.getSettings();
  assert.deepEqual({ feedUrl: sEnv.feedUrl, feedSource: sEnv.feedSource, lockedByEnv: sEnv.lockedByEnv },
    { feedUrl: mirror, feedSource: "env", lockedByEnv: true },
    "https 的部署期 feed 应压过 config 并上报 lockedByEnv（容器怎么取源由编排层决定）");
  const only = o => ({ feedUrl: o.feedUrl, feedSource: o.feedSource, lockedByEnv: o.lockedByEnv });
  assert.deepEqual(only(updater.getFeedSource()), only(sEnv), "getFeedSource() 与 getSettings() 的 feed 三项必须同口径");

  for (const bad of ["http://mirror.internal/index.json", "不是个 URL", "", "   "]) {
    process.env.AGENTHUB_PLUGIN_FEED = bad;
    const s = updater.getSettings();
    assert.equal(s.feedUrl, baseline, `非 https / 畸形值必须被拒并回落上一级：${JSON.stringify(bad)}`);
    // 关键语义：只有「env 真的赢了」才算锁。env 写了但被 https 校验判废 → 生效的是 config，
    // 这时 lockedByEnv 必须是 false，否则入口层会拒掉一次本可以生效的 PUT（改了却说不能改）。
    assert.equal(s.lockedByEnv, false, `被拒的 env 值不得谎称锁定：${JSON.stringify(bad)}`);
    assert.equal(s.feedSource, expectBaselineSource, `被拒的 env 值不得冒充来源：${JSON.stringify(bad)}`);
  }
  delete process.env.AGENTHUB_PLUGIN_FEED;
  assert.equal(updater.getSettings().feedUrl, baseline, "清掉变量后回到 config 口径（桌面不读 env = 行为与改造前一致）");

  // config 那一层**不加严**：桌面今天就用过局域网明文 feed 源，4C 只收口网络出口不改校验。
  // 这条断言防的是「顺手给 config 也加了 https 过滤」——那会让老桌面的更新源凭空失效。
  const config = require(path.join(BACKEND, "config.cjs"));
  const originalLoad = config.loadConfig;
  try {
    config.loadConfig = () => ({ plugins: { feedUrl: "http://lan.example/plugin-index.json" } });
    const sCfg = updater.getSettings();
    assert.equal(sCfg.feedSource, "config", "config 有值时来源应上报 config");
    assert.equal(sCfg.feedUrl, "http://lan.example/plugin-index.json", "config 层的明文地址必须照旧生效（桌面既有行为，不得在这里收紧）");
    assert.equal(sCfg.lockedByEnv, false);
  } finally {
    config.loadConfig = originalLoad;
  }
  assert.equal(updater.getSettings().feedUrl, baseline, "还原 config 后口径回到本机值");

  const st = updater.getStatus();
  assert.equal(st.form, "node");
  assert.equal(st.autoApply, false, "容器形态 status.autoApply 默认 false，前端据此诚实显示");
  console.log("PASS ⑥ feed 契约：feedUrl/feedSource/lockedByEnv 三字段同步可读；只有 env 真赢才算锁定");
}

async function main() {
  checkStaticPurity();
  checkRequireChainPurity();
  await checkFetchBinary();
  checkAutoApplyGate();
  checkFeedResolution();
  await checkElectronImplShape();
  console.log("PASS plugin-updater platform: 4C 容器 require 链纯净 + node 出口可用 + 自动链路保守默认");
}

main().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
