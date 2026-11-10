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
//  端口：localgw 19527 / admin 19528（可用环境变量 AGENTHUB_PROXY_PORT/AGENTHUB_ADMIN_PORT 覆盖）
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), `agenthub-gw-smoke-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });

const GW_PORT = Number(process.env.AGENTHUB_PROXY_PORT) || 19527;
const ADMIN_PORT = Number(process.env.AGENTHUB_ADMIN_PORT) || 19528;

const env = Object.assign({}, process.env, {
  AGENTHUB_ALLOW_PLAINTEXT: "1",
  AGENTHUB_SECRET_KEY: "",
  AGENTHUB_DATA_DIR: DATA,
  AGENTHUB_PROXY_PORT: String(GW_PORT),
  AGENTHUB_ADMIN_PORT: String(ADMIN_PORT),
  AGENTHUB_HOST: "127.0.0.1",
});

const logPath = path.join(os.tmpdir(), "gw-smoke.log");
const out = fs.openSync(logPath, "w");
// Use the runtime running this probe. Resolving a second "node" through PATH
// can silently launch an older system installation without node:sqlite.
const child = spawn(process.execPath, ["gateway/src/index.cjs"], { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", out, out] });

function req(url, method, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj === undefined ? null : JSON.stringify(bodyObj);
    const headers = body ? { "content-type": "application/json" } : {};
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
function check(name, r, expectStatus, match) {
  const ok = r.status === expectStatus && (!match || match.test(r.body));
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} [${r.status}] ${name}${ok ? "" : `  body=${String(r.body).slice(0, 160)}`}`);
}

(async () => {
  await sleep(9000);

  // 探针就绪轮询：memory 索引初始化可能慢（首次建库），livez 恒 200 前先等管理 API 起来
  for (let i = 0; i < 30; i++) {
    const r = await req("/api/livez");
    if (r.status === 200) break;
    await sleep(1000);
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
      console.log(`   命令表 ${n} 条（proxy 66 + localgw 43 + prompts 43 + memory 125 = 277）`);
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

  console.log("—— WebDAV 配置写入路径 ——");
  const wd = await req("/api/config/webdav", "PUT", { endpoint: "http://127.0.0.1:9/dav", username: "smoke", password: "smoke" });
  check("PUT /api/config/webdav", wd, 200, /"ok":true/);

  console.log("—— 停机（SIGTERM 优雅收尾）——");
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
  console.log(failed ? `❌ 共 ${failed} 项未通过` : "✅ 全部通过");
  process.exit(failed ? 1 : 0);
})();
