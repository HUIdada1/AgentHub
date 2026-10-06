// 最小闭环验收：在隔离临时目录起真实的「记忆中枢服务 + HTTP 接口」（UI 实际调用的那套），
// 用 UI 同款 POST /call 走完整用户流程，断言前端会拿到的字段。不触碰已安装应用与真实记忆库。
//
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/verify-memory-project-meta-e2e.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { MemoryHttpApi } = require("../electron/backend/memory/httpapi.cjs");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  fail++; failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}
/**
 * 跨平台同路径判定：realpath 解 8.3 短名 / 链接 / 大小写，win32 再折叠大小写。
 * 直接比 path.resolve 会在 CI 上假失败（runner 的 TEMP 以短名 C:\Users\RUNNER~1 暴露，
 * 而 os.tmpdir() 给长名，git 给正斜杠形式）。
 */
function samePath(a, b) {
  const norm = (x) => {
    const raw = String(x || "");
    let r = raw;
    try { r = fs.realpathSync.native(raw); } catch { /* 路径不存在或平台不支持：退回原名 */ }
    r = path.resolve(r);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** UI 同款调用：POST /call { tool, args, agent } + Bearer */
function call(port, token, tool, args) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ tool, args: args || {}, agent: "dsh" }), "utf8");
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: "/call",
      headers: { "content-type": "application/json; charset=utf-8", "content-length": body.length, authorization: "Bearer " + token },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("响应非 JSON: " + d.slice(0, 120))); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
const cardOf = (res, slug) => (res.result.projects || []).find((p) => p.slug === slug);

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-meta-e2e-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_e2e_api", onEvent: () => {} }).init();
  const api = new MemoryHttpApi(svc, path.join(root, "runtime.json"), { onEvent: () => {} });
  const { port } = await api.start();
  console.log(`  已启动隔离实例：记忆库 ${root}，HTTP 127.0.0.1:${port}\n`);

  // 造一个虚构仓库（含 origin + upstream，模拟 fork/上游）
  const repo = path.join(os.tmpdir(), `agenthub-e2e-repo-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/demo-org/demo-app.git"]);
  git(["remote", "add", "upstream", "https://github.com/upstream-org/demo-app.git"]);

  console.log("[A] 项目列表接口：全新库应为空");
  const empty = await call(port, api.token, "memory_projects");
  check("memory_projects 返回结构正确", empty.ok === true && Array.isArray(empty.result.projects), JSON.stringify(empty).slice(0, 120));

  console.log("\n[B] 写一条带 cwd 的记忆（UI 上就是「Agent 写记忆」）");
  const w = await call(port, api.token, "memory_write", {
    title: "闭环验收：带 cwd 写入", content: "以 project + cwd 写入，项目卡应自动补上远程与本地路径。",
    type: "note", project: "DemoApp", cwd: repo, tags: ["e2e"], importance: 3,
  });
  check("写入成功", w.ok === true && !!w.result.path, JSON.stringify(w).slice(0, 160));

  console.log("\n[C] 项目卡字段（前端渲染所依赖的数据）");
  const list1 = await call(port, api.token, "memory_projects");
  const card1 = cardOf(list1, "demoapp");
  check("卡片存在且 slug 为显式项目名", !!card1 && card1.slug === "demoapp", JSON.stringify(card1 && card1.slug));
  check("远程仓库 = 2 个（origin + upstream）", card1 && card1.remotes.length === 2, JSON.stringify(card1 && card1.remotes));
  check("远程含 fork 与上游", card1 && card1.remotes.includes("demo-org/demo-app") && card1.remotes.includes("upstream-org/demo-app"), JSON.stringify(card1 && card1.remotes));
  check("本地路径 = 1 个（git root）", card1 && card1.localPaths.length === 1, JSON.stringify(card1 && card1.localPaths));
  check("前端分支判定用 origin 字段存在", card1 && typeof card1.origin === "string", JSON.stringify(card1 && card1.origin));

  console.log("\n[D] 身份只认 origin：只有 upstream 的仓库不得当身份");
  const onlyUp = path.join(os.tmpdir(), `agenthub-e2e-uponly-${Date.now()}`);
  fs.mkdirSync(onlyUp, { recursive: true });
  execFileSync("git", ["-C", onlyUp, "init", "-q"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", onlyUp, "remote", "add", "upstream", "https://github.com/other-org/unrelated.git"], { windowsHide: true, stdio: "ignore" });
  const w2 = await call(port, api.token, "memory_write", { title: "只有 upstream", content: "该仓库只配了 upstream，不应被当成项目身份。", type: "note", project: "UpOnly", cwd: onlyUp });
  const card2 = cardOf(await call(port, api.token, "memory_projects"), "uponly");
  check("只有 upstream 时 slug 仍是显式项目名", !!card2 && card2.slug === "uponly", JSON.stringify(card2 && card2.slug));
  // 方案 A：身份必须有 origin。只有 upstream 的目录不得把该 upstream 当成本项目身份展示
  check("只有 upstream 时不显示远程（不冒充别人仓库）", card2 && card2.remotes.length === 0, JSON.stringify(card2 && card2.remotes));
  // 该目录名是随机临时名、且仓库无 origin，两条归属证明都不成立 ⇒ 不应记为项目路径
  check("无法证明归属的 cwd 不记为项目路径", card2 && card2.localPaths.length === 0, JSON.stringify(card2 && card2.localPaths));

  console.log("\n[E] 过浅路径：家目录 cwd 不得记为项目路径");
  const home = os.homedir();
  await call(port, api.token, "memory_write", { title: "家目录 cwd", content: "会话可能在家目录启动，这种 cwd 不该记为项目路径。", type: "note", project: "ShallowProbe", cwd: home });
  const card3 = cardOf(await call(port, api.token, "memory_projects"), "shallowprobe");
  check("家目录未被记为本地路径", card3 && card3.localPaths.length === 0, JSON.stringify(card3 && card3.localPaths));

  console.log("\n[F] 存量自愈 + 纠正（启动时那条路径的服务端等价调用）");
  // 造一个只有 frontmatter 证据的老项目：台账空，记忆文件带 cwd/git
  svc.registry.upsert({ slug: "legacy-demo", name: "LegacyDemo", origin: "explicit", localPaths: [home, repo] });
  const legacyRel = "projects/legacy-demo/l1/probe/2026-01-01-old.md";
  const legacyAbs = path.join(root, legacyRel);
  fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
  const S = require("../electron/backend/memory/store.cjs");
  fs.writeFileSync(legacyAbs, S.serializeFrontmatter({
    id: "mem_legacy_e2e_api", type: "note", layer: "l1", title: "老记忆", project: "legacy-demo",
    agent: "probe", created: new Date().toISOString(), updated: new Date().toISOString(),
    validFrom: new Date().toISOString(), tags: "probe", importance: 3, summary: "老记忆",
    cwd: repo, git: "demo-org/demo-app",
  }) + "\n\n老项目只有 frontmatter 证据，自愈应补回并把过浅路径剔除。\n", "utf8");
  svc.reindexFile(legacyRel);
  const heal = svc.reconcileProjectMetadata();
  const card4 = cardOf(await call(port, api.token, "memory_projects"), "legacy-demo");
  check("自愈补回远程", card4 && card4.remotes.length >= 1, JSON.stringify(card4 && card4.remotes));
  check("自愈剔除家目录、保留真项目路径",
    card4 && !card4.localPaths.includes(home) && card4.localPaths.some((x) => samePath(x, repo)),
    JSON.stringify({ heal, paths: card4 && card4.localPaths }));
  check("纠正计入 pruned", heal.pruned >= 1, JSON.stringify(heal));
  check("自愈幂等", svc.reconcileProjectMetadata().healed === 0);

  console.log("\n[G] 健康检查与鉴权（UI/桥的连接前提）");
  const hz = await new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/healthz" }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ code: r.statusCode, body: d })); }));
  check("/healthz 200", hz.code === 200, JSON.stringify(hz).slice(0, 100));
  const bad = await new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ tool: "memory_projects", args: {} }));
    const rq = http.request({ host: "127.0.0.1", port, method: "POST", path: "/call", headers: { "content-length": body.length, authorization: "Bearer wrong" } }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(r.statusCode)); });
    rq.write(body); rq.end();
  });
  check("错误令牌被拒（401）", bad === 401, String(bad));

  api.stop();
  svc.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(onlyUp, { recursive: true, force: true });

  console.log(`\n最小闭环结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log("失败项："); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error("崩溃:", (e && e.stack) || e); process.exit(2); });