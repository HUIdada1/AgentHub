/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-03
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Docker 入口 headless 冒烟（方案板块 D/G）：本地兜底，正式平台是容器冒烟。
// 以临时数据目录拉起 gateway/src/index.cjs，验证管理 API / 本地网关端口 / RPC 门控
// / WebDAV 配置写入路径可用后 SIGTERM 停机，最后打印网关日志尾部。
//
// 用法：node tools/gateway-headless-smoke.cjs
//
// **必须可并发跑**（11-12 两次实战教训，方案 §六 T7 附带项）：
// 原实现用固定日志路径 os.tmpdir()/gw-smoke.log + 固定端口 19527/19528，两个实例同时跑会
// 互相串写日志、并报 EADDRINUSE —— 产出的是一份**看起来像代码回归的假失败**（实测把 Lead
// 误导过一次"25 项失败"）。现在：日志名带 pid、端口向系统要空闲端口、开头显式确认端口可用、
// 结尾打印实际端口，占用直接报"端口被占，非代码回归"并退避，不冒充产品缺陷。
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), `agenthub-gw-smoke-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });

const TOKEN = `smoke-full-${process.pid}`;
const RO_TOKEN = `smoke-ro-${process.pid}`;

/** 向系统要一个空闲端口（listen 0 → 记下端口 → 关掉）。
 *  为什么不"优先用 19527"：实测两个冒烟同时启动时，两边都会在"19527 此刻空闲"上达成一致，
 *  于是第二个的网关 EADDRINUSE、断言大面积失败 —— 长得像代码回归，其实只是抢端口。
 *  所以默认**只接受系统分配的随机端口**；要固定端口必须显式设环境变量（自担并发风险）。
 *  关到 spawn 之间理论上仍有窗口，因此再叠两层：① 分到的端口先探一次 livez，
 *  ② 子进程若因 EADDRINUSE 退出，按"环境占用"报并退 2，不冒充产品缺陷。 */
async function freePort(exclude) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", (e) => reject(new Error(`要空闲端口失败：${e.code || e.message}`)));
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
    if (exclude && exclude.has(port)) continue;
    // 已经有网关在这个端口上应答，说明被别的实例/服务占了，换一个
    const taken = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/api/livez", method: "GET", timeout: 700 }, (res) => { res.resume(); res.on("end", () => resolve(true)); });
      r.on("timeout", () => { r.destroy(); resolve(false); });
      r.on("error", () => resolve(false));
      r.end();
    });
    if (!taken) return port;
  }
  throw new Error("12 次都要不到可用的空闲端口（本机端口耗尽或被大量占用），这是环境问题，不是代码回归");
}

let GW_PORT = 0;
let ADMIN_PORT = 0;

/** 用已分配好的端口拉起网关子进程。日志文件名带 pid —— 并发跑时各写各的。 */
function boot() {
  const env = Object.assign({}, process.env, {
    AGENTHUB_ALLOW_PLAINTEXT: "1",
    AGENTHUB_SECRET_KEY: "",
    AGENTHUB_DATA_DIR: DATA,
    AGENTHUB_PROXY_PORT: String(GW_PORT),
    AGENTHUB_ADMIN_PORT: String(ADMIN_PORT),
    AGENTHUB_HOST: "127.0.0.1",
    // 带上两套令牌跑冒烟：既覆盖 adminAuth 的真实路径，也让"只读令牌能不能写"这条
    // 门控断言有地方落地。显式设 ADMIN_HOST=127.0.0.1 是为了不因有令牌而绑到 0.0.0.0
    AGENTHUB_ADMIN_HOST: "127.0.0.1",
    AGENTHUB_ADMIN_TOKEN: TOKEN,
    AGENTHUB_ADMIN_READONLY_TOKEN: RO_TOKEN,
  });
  const logPath = path.join(os.tmpdir(), `gw-smoke-${process.pid}.log`);
  const out = fs.openSync(logPath, "w");
  // Use the runtime running this probe. Resolving a second "node" through PATH
  // can silently launch an older system installation without node:sqlite.
  const child = spawn(process.execPath, ["gateway/src/index.cjs"], { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", out, out] });
  return { child, out, logPath };
}

function req(url, method, bodyObj, token) {
  return new Promise((resolve) => {
    const body = bodyObj === undefined ? null : JSON.stringify(bodyObj);
    const headers = body ? { "content-type": "application/json" } : {};
    headers.authorization = `Bearer ${token === null ? "" : (token || TOKEN)}`;
    const r = http.request({ host: "127.0.0.1", port: ADMIN_PORT, path: url, method: method || "GET", headers, timeout: 6000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: null, body: "timeout" }); });
    r.on("error", (e) => resolve({ status: null, body: String(e.message || e) }));
    if (body) r.write(body);
    r.end();
  });
}

/** 原始 zip 字节上传（安装端点刻意不收 JSON，所以这里绕过 req() 的 JSON 封装） */
function rawInstall(buf, token) {
  return new Promise((resolve) => {
    const r = http.request({
      host: "127.0.0.1", port: ADMIN_PORT, path: "/api/plugins/install", method: "POST",
      headers: { "content-type": "application/zip", authorization: `Bearer ${token || TOKEN}` }, timeout: 20000,
    }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("timeout", () => { r.destroy(); resolve({ status: null, body: "timeout" }); });
    r.on("error", (e) => resolve({ status: null, body: String(e.message) }));
    r.end(buf);
  });
}

function gwGet(url) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: GW_PORT, path: url, timeout: 6000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: null, body: "timeout" }); });
    r.on("error", (e) => resolve({ status: null, body: String(e.message || e) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

/** 响应体断言：r 必须是 {status, body}。
 *  为什么要把签名写死成显式校验：历史上这里收到过一个**布尔**（把 `x===200` 当 r 传进来），
 *  那时 r.status 是 undefined —— 判定就变成 `undefined === expectStatus`。期望值一旦也是
 *  undefined（少传一个参数），结果就是**假绿**：一条根本没跑的断言显示 ✅。
 *  假失败只挡你一次，假绿会让你带着破功能交付，所以这里一律显式判红。 */
function check(name, r, expectStatus, match) {
  if (!r || typeof r !== "object" || typeof r.status !== "number" || typeof r.body !== "string") {
    failed++;
    console.log(`❌ [断言签名误用] ${name} —— check() 第 2 参数必须是 {status,body} 响应对象，收到 ${r === null ? "null" : typeof r}；布尔断言请改用 checkOk()`);
    return false;
  }
  if (typeof expectStatus !== "number") {
    failed++;
    console.log(`❌ [断言签名误用] ${name} —— 期望状态码必须是数字，收到 ${typeof expectStatus}`);
    return false;
  }
  const ok = r.status === expectStatus && (!match || match.test(r.body));
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} [${r.status}] ${name}${ok ? "" : `  body=${String(r.body).slice(0, 160)}`}`);
  return ok;
}

/** 纯布尔断言（不经过响应对象的那类判定走这里，避免和 check() 混用产生上面的假绿） */
function checkOk(name, ok, extra) {
  if (typeof ok !== "boolean") {
    failed++;
    console.log(`❌ [断言签名误用] ${name} —— checkOk() 第 2 参数必须是布尔，收到 ${typeof ok}（响应体断言请用 check()）`);
    return false;
  }
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `  ${extra === undefined ? "" : String(extra).slice(0, 200)}`}`);
  return ok;
}

/** 剥段函数的**函数级**双向验证（切磁盘真实源码，不复制一份逻辑去测）。
 *  为什么不在 HTTP 层验：C2 主门已把 `localgw_config_get` 移出 READ，read 档拿到的直接是 403
 *  —— 响应体都没有，"read 必须还能看到 encryptKeysAtRest"这条在 HTTP 上永远无法成立。
 *  所以：HTTP 层验主门（403），函数层验纵深（既不泄漏、也不剥过头）。 */
function redactUnitChecks() {
  const src = fs.readFileSync(path.join(ROOT, "gateway", "src", "index.cjs"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function redactForReadScope");
  const constStart = src.indexOf("const READ_HIDDEN_KEYS");
  if (start < 0 || constStart < 0) { console.log("❌ [剥段自测] 没切到 redactForReadScope 或名单，用例无效"); return 1; }
  const head = src.slice(constStart, src.indexOf("/** 只读令牌响应", constStart) > 0 ? src.indexOf("/** 只读令牌响应", constStart) : constStart + 2000);
  const body = src.slice(start, src.indexOf("\n}\n", start) + 3);
  const sandbox = { Set: global.Set, Object, Array, JSON, console };
  require("node:vm").runInNewContext(head + "\n" + body + "\n__fn=redactForReadScope;", sandbox);
  const fn = sandbox.__fn;
  if (typeof fn !== "function") { console.log("❌ [剥段自测] 没拿到函数"); return 1; }
  let bad = 0;
  const one = (name, ok, extra) => { if (!ok) bad++; console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `  ${extra}`}`); };

  const full = { ok: true, security: { secret: "enc:v2:deadbeef", adminToken: "ADM", readonlyToken: "RO", encryptKeysAtRest: true }, routing: { strategy: "cost-first" }, models: { serviceBindings: { workbuddy: 1 } } };
  const r1 = fn(full);
  one("剥段①三键全部消失（read 档看不到 secret/adminToken/readonlyToken）",
    !r1.security || (!("secret" in r1.security) && !("adminToken" in r1.security) && !("readonlyToken" in r1.security)),
    JSON.stringify(r1.security));
  one("剥段②非敏感字段必须保留（encryptKeysAtRest 不能被吞 —— 审查 R 的回归闸）",
    r1.security && r1.security.encryptKeysAtRest === true, JSON.stringify(r1.security));
  one("剥段③同级的其它段完全不动（routing / models 原样）",
    r1.routing && r1.routing.strategy === "cost-first" && !!r1.models && !!r1.models.serviceBindings, JSON.stringify(r1).slice(0, 140));
  one("剥段④空数组/空对象/null 不抛错", (() => { try { fn({ a: [], b: {}, c: null, d: undefined }); fn(null); fn("str"); return true; } catch { return false; } })());
  one("剥段⑤嵌套在数组里的 security 也剥（handler 常返回 items[] 形状）",
    (() => { const out = fn({ items: [{ security: { secret: "x", keep: 1 } }] }); return out.items[0].security && !("secret" in out.items[0].security) && out.items[0].security.keep === 1; })(),
    "数组内的 security 没被处理");
  one("剥段⑥业务里别的 `secret` 字段不受影响（只在 security 段名内生效）",
    (() => { const out = fn({ provider: { secret: "not-in-security-section" } }); return out.provider.secret === "not-in-security-section"; })(),
    "误伤了非 security 段的同名字段");
  one("剥段⑦原对象不被就地修改（并发/重复调用安全）",
    (() => { const o = { security: { secret: "s", keep: 1 } }; fn(o); return o.security.secret === "s"; })(),
    "redact 就地改了入参，会影响 full 档复用同一对象");
  return bad;
}

(async () => {

  // 剥段函数级自测放在最前面：不起服务、不占端口，失败就该立刻停
  const redactBad = redactUnitChecks();
  if (redactBad) { console.error(`❌ 剥段函数级自测 ${redactBad} 条不符（纵深防御不可信，先修它）`); process.exit(1); }

  // 端口先向系统要（两个都要，且互不相同），再启动 —— 写死 19527/19528 会让并发跑的第二实例
  // EADDRINUSE，产出"看起来像代码回归"的假失败（实测误导过一次"25 项失败"）
  const fixedGw = Number(process.env.AGENTHUB_PROXY_PORT) || 0;
  const fixedAdmin = Number(process.env.AGENTHUB_ADMIN_PORT) || 0;
  try {
    GW_PORT = fixedGw || (await freePort());
    ADMIN_PORT = fixedAdmin || (await freePort(new Set([GW_PORT])));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2); // 2 = 环境问题，不是代码回归
  }
  if (GW_PORT === ADMIN_PORT) { console.error(`❌ 分到的两个端口相同（${GW_PORT}），拒绝跑`); process.exit(2); }
  console.log(`本机冒烟端口：localgw=${GW_PORT} admin=${ADMIN_PORT} pid=${process.pid}${fixedGw || fixedAdmin ? "（注意：用了显式固定端口，并发跑可能互撞）" : ""}`);
  const { child, out, logPath } = boot();
  // 启动期就退出 = 监听失败之类，直接按环境问题报，不刷 49 条断言红
  let diedEarly = null;
  child.once("exit", (code) => { diedEarly = code; });
  await sleep(2000);

  // 探针就绪轮询：memory 索引初始化可能慢（首次建库），livez 恒 200 前先等管理 API 起来
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = await req("/api/livez");
    if (r.status === 200) { ready = true; break; }
    if (diedEarly !== null) break;
    await sleep(1000);
  }
  if (!ready) {
    try { fs.closeSync(out); } catch { /* 已关 */ }
    const log = fs.readFileSync(logPath, "utf8");
    const portClash = /EADDRINUSE/.test(log);
    console.error(`❌ 管理 API 在 40s 内没有就绪（admin=${ADMIN_PORT} localgw=${GW_PORT}，子进程退出码=${diedEarly}）`);
    if (portClash) {
      console.error("   端口被别的实例占了 —— 这是**环境问题，不是代码回归**，请重跑（随机端口会自动换一个）");
      console.error("   若你显式设了 AGENTHUB_PROXY_PORT / AGENTHUB_ADMIN_PORT，去掉它们即可回到随机端口");
      process.exit(2);
    }
    console.error("   --- 子进程日志尾部 ---\n" + log.slice(-1500));
    process.exit(1);
  }

  console.log("—— 探针 ——");
  check("livez", await req("/api/livez"), 200, /"ok":true/);
  const rz = await req("/api/readyz");
  check("readyz 空池=503", rz, 503, /"ok":false/);

  console.log("—— 状态与能力 ——");
  const st = await req("/api/status");
  check("status（含 localgw 状态）", st, 200, /"localgw"/);
  const cap = await req("/api/capabilities");
  check("capabilities", cap, 200, /"proxy".*"localgw"|"localgw".*"proxy"/);
  if (cap.status === 200) {
    try {
      const j = JSON.parse(cap.body);
      const n = Object.keys(j.commands || {}).length;
      // 分项数字**不写死在这里**：四模块的命令数会随并行开发漂移（实测两天内 277→296→297，
      // memory 125→126），写死必然变成"别人加一条命令就把门禁搞成自相矛盾"。
      // 要精确对账（296/297 这类）归 task-8 的 T3/T4 门禁，那里断言的应是
      // 「capabilities 的键 ⊆ 注册表 ∪ 未注册白名单」，而不是某个具体条数。
      console.log(`   命令表 ${n} 条（下限 277；分项以 gateway/src/commands.cjs 实际注册为准）`);
      if (n < 277) failed++;
    } catch { failed++; }
  }

  console.log("—— 本地网关端口 ——");
  check("无 Key 打 /v1/models 应 401", await gwGet("/v1/models"), 401, /缺少 Bearer Token|Bearer/);

  console.log("—— RPC 门控（read / write / deny / 404）——");
  check("read localgw_status", await req("/api/rpc/localgw_status", "POST", { args: {} }), 200, /"ok":true|"running"/);
  check("read localgw_models_snapshot", await req("/api/rpc/localgw_models_snapshot", "POST", { args: {} }), 200, /"diagnostics":\{/);
  check("write localgw_route_set", await req("/api/rpc/localgw_route_set", "POST", { args: { strategy: "round-robin" } }), 200, /"ok":true|"strategy"/);
  check("deny localgw_start", await req("/api/rpc/localgw_start", "POST", { args: {} }), 403, /编排管理|docker restart/);
  check("deny proxy_open_data_dir", await req("/api/rpc/proxy_open_data_dir", "POST", { args: {} }), 403, /没有桌面环境|gateway-data/);
  check("404 未知命令", await req("/api/rpc/nonexistent_cmd", "POST", { args: {} }), 404, /未知命令/);

  console.log("—— 提示词库 RPC（Web 控制台不遗漏页面）——");
  check("read prompts_list", await req("/api/rpc/prompts_list", "POST", { args: {} }), 200, /"ok":true|"items"/);
  check("read prompts_stats", await req("/api/rpc/prompts_stats", "POST", { args: {} }), 200, /"ok":true|"stats"/);
  check("write prompts_save（空条目应拒绝）", await req("/api/rpc/prompts_save", "POST", { args: { item: {} } }), 200, /"ok":false|标题/);
  check("deny prompts_open_dir", await req("/api/rpc/prompts_open_dir", "POST", { args: {} }), 403, /桌面环境/);

  console.log("—— 记忆中枢 RPC（Web 控制台不遗漏页面）——");
  check("read memory_list", await req("/api/rpc/memory_list", "POST", { args: {} }), 200, /"ok":true|"items"/);
  check("read memory_stats", await req("/api/rpc/memory_stats", "POST", { args: {} }), 200, /"ok":true|"total"/);
  check("deny memory_open_dir", await req("/api/rpc/memory_open_dir", "POST", { args: {} }), 403, /桌面环境/);
  check("deny memory_write", await req("/api/rpc/memory_write", "POST", { args: {} }), 403, /写库/);
  check("deny pet_status（未注册但 DENY 文案已下发）", await req("/api/rpc/pet_status", "POST", { args: {} }), 403, /桌面窗口/);
  check("deny webdav_sync（未注册但 DENY 文案已下发）", await req("/api/rpc/webdav_sync", "POST", { args: {} }), 403, /poolsync/);
  check("deny window_close（未注册但 DENY 文案已下发）", await req("/api/rpc/window_close", "POST", { args: {} }), 403, /桌面窗口/);
  check("deny module_toggle（未注册但 DENY 文案已下发）", await req("/api/rpc/module_toggle", "POST", { args: {} }), 403, /容器编排/);

  console.log("—— 只读令牌：监视可用、写入一律 403（含本轮修好的门控名）——");
  check("ro read memory_list", await req("/api/rpc/memory_list", "POST", { args: {} }, RO_TOKEN), 200, /"ok":true|"items"/);
  // 这条是 :151 那处错标（memory_project_list → memory_projects）的**端到端**回归：
  // 光有静态门禁还不够，要证明只读令牌真的打得开「项目归档」
  check("ro read memory_projects（错标修复的端到端证据）", await req("/api/rpc/memory_projects", "POST", { args: {} }, RO_TOKEN), 200, /"ok":true/);
  check("ro 打 write 档 localgw_route_set → 403", await req("/api/rpc/localgw_route_set", "POST", { args: { strategy: "round-robin" } }, RO_TOKEN), 403, /只读令牌/);
  check("ro 打 providers_exec（本轮改判 write）→ 403", await req("/api/rpc/localgw_providers_exec", "POST", { args: { op: "unbind", channel: "workbuddy" } }, RO_TOKEN), 403, /只读令牌/);
  check("ro 打 webdav PUT → 403", await req("/api/config/webdav", "PUT", { endpoint: "https://x.example/dav" }, RO_TOKEN), 403, /只读令牌/);

  console.log("—— 外置插件 REST 面（4B：装/查/更新/feed）——");
  const pl = await req("/api/plugins");
  check("GET /api/plugins 200", pl, 200);
  checkOk("空态是 [] 而不是 500", /"ok":true/.test(pl.body) && /"plugins":\[\]/.test(pl.body), pl.body.slice(0, 150));
  checkOk("带 4B 新增的 updateStatus / trustOnInstall / feedSource 字段",
    /"updateStatus"/.test(pl.body) && /"trustOnInstall":false/.test(pl.body) && /"feedSource"/.test(pl.body), pl.body.slice(0, 150));
  check("ro 可读插件列表（看板要能看见装了什么）", await req("/api/plugins", "GET", undefined, RO_TOKEN), 200);
  check("ro 可读更新状态（要能看见 lastError 原文）", await req("/api/plugins/update/status", "GET", undefined, RO_TOKEN), 200);
  const stt = await req("/api/plugins/update/status");
  checkOk("更新状态 form=node 且 autoApply=false（容器默认手动）",
    /"form":"node"/.test(stt.body) && /"autoApply":false/.test(stt.body), stt.body.slice(0, 150));
  checkOk("updateStatus.status 里没有 feedSource（feed 事实只在 getSettings 一处产）",
    !/"status":\{[^}]*"feedSource"/.test(stt.body), stt.body.slice(0, 150));
  const fd = await req("/api/plugins/feed");
  check("GET /api/plugins/feed 200", fd, 200);
  checkOk("回显生效值（https）与 lockedByEnv=false", /"feedUrl":"https:/.test(fd.body) && /"lockedByEnv":false/.test(fd.body), fd.body.slice(0, 150));
  check("PUT feed 传 http:// → 400（写入口强制 https）", await req("/api/plugins/feed", "PUT", { feedUrl: "http://insecure.example/i.json" }), 400);
  checkOk("被拒后没有静默生效（来源仍是 default）", /"feedSource":"default"/.test((await req("/api/plugins/feed")).body));
  check("PUT feed 传 https:// → 200", await req("/api/plugins/feed", "PUT", { feedUrl: "https://example.com/plugin-index-linux-x64-glibc.json" }), 200);
  checkOk("改源立刻可见地生效（来源变 config，不是静默失败）", /"feedSource":"config"/.test((await req("/api/plugins/feed")).body));
  check("PUT feed 空值 → 200", await req("/api/plugins/feed", "PUT", { feedUrl: "" }), 200);
  checkOk("清空后回落官方默认源", /"feedSource":"default"/.test((await req("/api/plugins/feed")).body));
  check("ro 改 feed → 403（改 feed＝换执行引擎，必须 full）", await req("/api/plugins/feed", "PUT", { feedUrl: "https://x.example/i.json" }, RO_TOKEN), 403);
  // 恒 501 必须已消失；坏包给的是 plugin-host 的真实原因（zip 解析层），不是我们的兜底文案
  const badInstall = await rawInstall(Buffer.from("PK-not-a-zip"), TOKEN);
  checkOk("POST /api/plugins/install 不再是 501 / 404", badInstall.status !== 501 && badInstall.status !== 404, `status=${badInstall.status}`);
  check("坏包 → 400", badInstall, 400);
  checkOk("坏包带真实失败原因（不是空壳 message）", /central directory|zip|schema|End of/i.test(badInstall.body), badInstall.body.slice(0, 150));
  check("install 收 application/json → 415（教怎么发）", await req("/api/plugins/install", "POST", { zipBase64: "AAA" }), 415);
  checkOk("ro 装插件 → 403（只读不能改执行引擎）", (await rawInstall(Buffer.from("PK"), RO_TOKEN)).status === 403);
  check("deny providers_enable（拆分后仍 DENY）", await req("/api/rpc/localgw_providers_enable", "POST", { args: {} }), 403, /宿主进程管理/);
  check("deny plugin_embed 文案指向 v1 不支持（4F 口径）", await req("/api/rpc/plugin_embed", "POST", { args: {} }), 403, /界面型|v1/);


  // ── C1/C2/C3 安全收口的**永久**三向断言（task-8 留痕已翻转为硬断言）──
  // 三个方向缺一不可：① read 档拿不到（收口有效）② full 档仍拿得到（防"剥过头把功能修坏"）
  // ③ read 档任何响应都不含 security 段（第二道门）。写成永久断言的理由：将来谁摘掉
  // requireFull、或把 localgw_config_get 挪回 READ 却忘了剥段，门禁必须当场红。
  // 两个假绿坑（本轮真踩过，别再踩）：判据必须"非空即泄漏"（ALLOW_PLAINTEXT 下是明文），
  // 且必须先建 API Key 触发 ensureSecret()（否则"读不到"只是前置未满足）。
  await req("/api/rpc/localgw_keys_create", "POST", { args: { name: "smoke-probe", scopes: ["chat"] } });
  const secOfBody = (body, pick) => { try { const j = JSON.parse(body || "{}"); return (pick(j) || {}).security || {}; } catch { return {}; } };
  const secFull = secOfBody((await req("/api/config")).body, (j) => j.config && j.config.localgw);
  checkOk("前置有效：full 令牌读得到 security.secret（否则下面所有 read 断言都是空的）",
    typeof secFull.secret === "string" && secFull.secret.length > 0, `secret 长度=${String(secFull.secret || "").length}`);
  check("C1 read 档 GET /api/config → 403", await req("/api/config", "GET", undefined, RO_TOKEN), 403, /只读令牌/);
  check("C3 read 档 GET /api/backup → 403（整库下载）", await req("/api/backup", "GET", undefined, RO_TOKEN), 403, /只读令牌/);
  check("C2 read 档 RPC localgw_config_get → 403（主门：已移出 READ）", await req("/api/rpc/localgw_config_get", "POST", { args: {} }, RO_TOKEN), 403, /只读令牌/);
  const cfgFull2 = await req("/api/config");
  check("反向：full 档 GET /api/config 仍 200（收口没把合法用途打死）", cfgFull2, 200);
  checkOk("反向：full 档响应里 security 段仍在（剥段未误伤）", /"security"/.test(cfgFull2.body), cfgFull2.body.slice(0, 120));
  const rpcFull2 = await req("/api/rpc/localgw_config_get", "POST", { args: {} });
  check("反向：full 档 RPC localgw_config_get 仍 200", rpcFull2, 200);
  checkOk("反向：full 档 RPC 响应含 security 段", /"security"/.test(rpcFull2.body));
  const secInRead = [];
  for (const c of ["proxy_status", "localgw_status", "memory_stats", "prompts_stats"]) {
    const rr = await req(`/api/rpc/${c}`, "POST", { args: {} }, RO_TOKEN);
    if (rr.status === 200 && /"security"\s*:/.test(rr.body)) secInRead.push(c);
  }
  checkOk("纵深：read 档四条响应均无 security 段", secInRead.length === 0, secInRead.join(","));

  console.log("—— framework 配置白名单（①：容器安全读写通路）——");
  const fw = await req("/api/config/framework");
  check("GET /api/config/framework 200", fw, 200);
  checkOk("framework GET 是只读投影：无 security / 口令 / 绝对路径", !/"security"|"password"|"secret"|\\\\/.test(fw.body), fw.body.slice(0, 140));
  check("read 档也能 GET framework（只读看板的配置视图入口）", await req("/api/config/framework", "GET", undefined, RO_TOKEN), 200);
  check("PUT framework 用只读令牌 → 403", await req("/api/config/framework", "PUT", { config: { theme: "light" } }, RO_TOKEN), 403);
  check("PUT theme=light → 200", await req("/api/config/framework", "PUT", { config: { theme: "light" } }), 200);
  checkOk("刷新后读回 light（真落盘，不是内存假象）", /"theme":"light"/.test((await req("/api/config/framework")).body));
  check("PUT 未列路径 → 400（明确拒绝而非静默丢弃）", await req("/api/config/framework", "PUT", { config: { nosuchkey: 1 } }), 400);
  // 下面几条是 F3 的护栏：白名单必须**路径全等**。pet.theme 与顶层 theme 同名不同物
  // （config.cjs:250 vs :125），一旦有人把实现"简化成键名匹配"，这几条会立刻红。
  checkOk("拒绝 pet.theme（与顶层 theme 同名，键名匹配就会误放开）",
    (await req("/api/config/framework", "PUT", { config: { pet: { theme: "gargantua" } } })).status === 400);
  checkOk("拒绝 localgw.models.serviceBindings（渠道绑定属 providers_exec 的校验通路）",
    (await req("/api/config/framework", "PUT", { config: { localgw: { models: { serviceBindings: { workbuddy: { a: 1 } } } } } })).status === 400);
  checkOk("拒绝 proxy.port 与 proxy.bind（容器由编排固定）",
    (await req("/api/config/framework", "PUT", { config: { proxy: { port: 9999 } } })).status === 400
    && (await req("/api/config/framework", "PUT", { config: { proxy: { bind: "0.0.0.0" } } })).status === 400);
  checkOk("拒绝 modules.localgw.enabled（关掉它=关掉容器唯一对外服务）",
    (await req("/api/config/framework", "PUT", { config: { modules: { localgw: { enabled: false } } } })).status === 400);
  const half = await req("/api/config/framework", "PUT", { config: { fx: true, theme: "not-a-theme" } });
  checkOk("半更新整体拒绝（一条非法就全不写）", half.status === 400 && /未写入任何一项/.test(half.body), `${half.status} ${String(half.body).slice(0, 120)}`);
  checkOk("非法值被拒后 fx 保持原值（确认真的没写）", /"fx":(true|false)/.test((await req("/api/config/framework")).body));
  check("PUT 运行参数（proxy.concurrency）→ 200", await req("/api/config/framework", "PUT", { config: { proxy: { concurrency: 12 } } }), 200);
  checkOk("运行参数读回一致", /"concurrency":12/.test((await req("/api/config/framework")).body));
  checkOk("越界值被拒（concurrency=0 低于下限）",
    (await req("/api/config/framework", "PUT", { config: { proxy: { concurrency: 0 } } })).status === 400);


  console.log("—— 板块7：status 摘要去占位 + 实时通道如实声明 ——");
  const stObj = JSON.parse((await req("/api/status")).body || "{}");
  checkOk("status.prompts 已是真实计数（不再是只有 running 的占位）",
    stObj.prompts && stObj.prompts.available === true && typeof stObj.prompts.total === "number",
    JSON.stringify(stObj.prompts));
  checkOk("status.memory 已是真实计数", stObj.memory && (stObj.memory.available === true || stObj.memory.available === false) && "available" in stObj.memory, JSON.stringify(stObj.memory));
  // 逐位一致：/api/status 的摘要必须等于对应 RPC 的原值（同一个 handler 出来的才谈得上一致）
  const ps = JSON.parse((await req("/api/rpc/prompts_stats", "POST", { args: {} })).body || "{}");
  if (ps.ok) {
    const same = ["total", "today", "week", "conflicts"].every((k) => stObj.prompts[k] === ps.stats[k]);
    checkOk("status.prompts 与 RPC prompts_stats 逐位一致（total/today/week/conflicts）", same, `status=${JSON.stringify(stObj.prompts)} rpc=${JSON.stringify(ps.stats).slice(0, 120)}`);
  } else {
    console.log(`ℹ️ prompts_stats 未就绪（${ps.message}）→ 该项跳过，status 应如实报 available:false = ${stObj.prompts && stObj.prompts.available === false}`);
  }
  const ms = JSON.parse((await req("/api/rpc/memory_stats", "POST", { args: {} })).body || "{}");
  if (ms.ok) {
    const same = ["total", "projects", "today", "pending"].every((k) => stObj.memory[k] === ms[k]);
    checkOk("status.memory 与 RPC memory_stats 逐位一致（total/projects/today/pending）", same, `status=${JSON.stringify(stObj.memory)} rpc=${JSON.stringify(ms).slice(0, 120)}`);
  }
  // 摘要里绝不得出现本机绝对路径或凭据字段（memory_status 有 root、index 有 rootDir）
  checkOk("status 摘要不含本机绝对路径 / 凭据字段", !/[A-Za-z]:\\\\/.test(JSON.stringify(stObj.prompts) + JSON.stringify(stObj.memory)) && !/"root(Dir)?"\s*:/.test(JSON.stringify(stObj.memory)), JSON.stringify(stObj.memory).slice(0, 140));
  // 实时通道如实声明：容器形态 memory/prompts 的广播链路确实缺失，必须报 false
  const capsObj = JSON.parse((await req("/api/capabilities", "GET")).body || "{}");
  checkOk("capabilities.realtime 如实标 memory=false / prompts=false（不许假装有实时）",
    capsObj.realtime && capsObj.realtime.memory === false && capsObj.realtime.prompts === false, JSON.stringify(capsObj.realtime));
  checkOk("capabilities.realtime 标 proxy/localgw 为 true（这两条链是真接通的）",
    capsObj.realtime && capsObj.realtime.proxy === true && capsObj.realtime.localgw === true, JSON.stringify(capsObj.realtime));
  checkOk("status.realtime 与 capabilities.realtime 同一份口径",
    JSON.stringify(stObj.realtime) === JSON.stringify(capsObj.realtime), `${JSON.stringify(stObj.realtime)} vs ${JSON.stringify(capsObj.realtime)}`);
  checkOk("pluginUpdate 通道随更新器加载状态如实变化（当前应 true）",
    capsObj.realtime && typeof capsObj.realtime.pluginUpdate === "boolean", JSON.stringify(capsObj.realtime && capsObj.realtime.pluginUpdate));

  console.log("—— WebDAV 配置写入路径 + ④ 两个副作用（对齐桌面 ipc.cjs:250-267）——");
  const firstSave = await req("/api/config/webdav", "PUT", { endpoint: "http://127.0.0.1:9/dav", username: "smoke", password: "smoke-pw-SECRET" });
  check("PUT /api/config/webdav 200", firstSave, 200, /"ok":true/);
  // 副作用②：首次配置（before 空 → after 有值）自动跑一次同步
  checkOk("首次保存触发自动同步（autoSyncTriggered=true）", /"autoSyncTriggered":true/.test(firstSave.body), firstSave.body.slice(0, 150));
  // 副作用②的反向：已经配过、再改字段**不得**每次都跑（否则每次微调都发一轮全量同步）
  const secondSave = await req("/api/config/webdav", "PUT", { endpoint: "http://127.0.0.1:9/dav", username: "smoke2", password: "smoke-pw-SECRET" });
  check("再次保存 200", secondSave, 200);
  checkOk("非首次保存不再自动同步（照桌面条件，不制造意外流量）", /"autoSyncTriggered":false/.test(secondSave.body), secondSave.body.slice(0, 150));
  // 副作用①：口令可能变更必须通知 poolsync（漏掉会造成"只有容器版同步解不开"的形态不一致）。
  // 直接断言它被调用过：oplog 里应留下首配自动同步的记录；而 onSharedPasswordMaybeChanged
  // 是同步调用、无返回，只能靠"没抛错 + 后续行为"间接证明，这里显式说明局限
  const opl = await req("/api/rpc/proxy_oplog_list", "POST", { args: { limit: 50 } }, RO_TOKEN);
  checkOk("自动同步落了 oplog（运维可见，不静默）", /webdav-save/.test(opl.body), opl.body.slice(0, 160));
  checkOk("oplog 里能看到「口令可能变更」失败才记的告警项不存在（说明①没抛错）", !/口令变更未通知/.test(opl.body), opl.body.slice(0, 160));
  const wvd = await req("/api/config/webdav");
  check("GET /api/config/webdav 200", wvd, 200);
  // 只读看板也会读这个端点：口令必须掩码。断言写成"原文不出现"，而不是"看起来像掩码"，
  // 因为将来若掩码方式变了（长度/字符），只要没漏原值就不该红
  checkOk("GET /api/config/webdav 不回显口令原文（已掩码）", !/smoke-pw-SECRET/.test(wvd.body), wvd.body.slice(0, 180));
  checkOk("同时不回显号池加密口令原文", !/POOL-PASS/.test(wvd.body), wvd.body.slice(0, 120));


  console.log(`—— 停机（SIGTERM 优雅收尾）· 本次实际端口 localgw=${GW_PORT} admin=${ADMIN_PORT} ——`);
  child.kill("SIGTERM");
  const dead = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    child.once("exit", () => { clearTimeout(t); resolve(true); });
  });
  console.log(`${dead ? "✅" : "❌"} SIGTERM 后 8s 内退出`);
  if (!dead) { failed++; child.kill("SIGKILL"); }
  fs.closeSync(out);
  console.log("=== gateway log tail ===");
  console.log(fs.readFileSync(logPath, "utf8").slice(-1800));
  try { fs.unlinkSync(logPath); fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 留个临时文件不拦验收 */ }
  console.log(failed ? `❌ 共 ${failed} 项未通过` : "✅ 全部通过");
  process.exit(failed ? 1 : 0);
})();

