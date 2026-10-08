// 沙箱自测：真实台账副本上的「项目归类 + gitUrl 回填 + 自愈幂等」端到端。
// 台账与真实路径只读引用（复制台账进隔离 root；git 探测是对真实仓库的只读 `git remote`），
// 不写真实记忆库、不动真实台账。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/verify-project-regroup-e2e.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

async function main() {
  const realIndex = path.join(os.homedir(), "AgentHub", "memory", "projects", "_index.json");
  if (!fs.existsSync(realIndex)) {
    console.log("跳过：本机没有真实台账（projects/_index.json）");
    return;
  }
  const root = path.join(os.tmpdir(), `agenthub-regroup-e2e-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "projects"), { recursive: true });
  fs.copyFileSync(realIndex, path.join(root, "projects", "_index.json"));
  const before = JSON.parse(fs.readFileSync(path.join(root, "projects", "_index.json"), "utf8")).projects.length;

  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_regroup_e2e", onEvent: () => {} }).init();
  console.log(`  隔离实例：${root}（台账副本 ${before} 条，真实台账只读）\n`);

  const r1 = svc.reconcileProjectMetadata();
  console.log(`  自愈 #1：${JSON.stringify(r1)}`);
  const card = (slug) => (svc.projects().projects || []).find((p) => p.slug === slug);
  const byName = (name) => (svc.projects().projects || []).filter((p) => p.name === name);

  check("同一仓库的两张 AgentHub 卡同名", byName("AgentHub").length === 2, JSON.stringify(byName("AgentHub").map((p) => p.slug)));
  check("AgentDrove 两张卡同名", byName("AgentDrove").length === 2, JSON.stringify(byName("AgentDrove").map((p) => p.slug)));
  check("机器串形态的名字不再等于 slug（中文项目名保留原样是正常的）",
    (svc.projects().projects || []).every((p) => !p.name || p.name !== p.slug || !String(p.slug).includes("--")),
    JSON.stringify((svc.projects().projects || []).filter((p) => p.name === p.slug && String(p.slug).includes("--")).map((p) => p.slug)));

  const agenthub = card("huidada1--agenthub");
  check("gitUrl 已回填（github.com/HUIdada1/AgentHub）", !!agenthub && agenthub.gitUrl === "github.com/HUIdada1/AgentHub", JSON.stringify(agenthub && agenthub.gitUrl));
  const alias = card("agenthub");
  check("无远程卡片继承到 gitUrl（同仓库）", !!alias && alias.gitUrl === "github.com/HUIdada1/AgentHub", JSON.stringify(alias && alias.gitUrl));
  check("无远程卡片继承到 remotes", !!alias && (alias.remotes || []).includes("HUIdada1/AgentHub"), JSON.stringify(alias && alias.remotes));
  check("其它有本地路径的项目也拿到 gitUrl",
    (svc.projects().projects || []).filter((p) => (p.localPaths || []).length).every((p) => !!p.gitUrl || (p.remotes || []).length === 0),
    JSON.stringify((svc.projects().projects || []).filter((p) => (p.localPaths || []).length && !p.gitUrl).map((p) => p.slug)));

  // 幂等：再跑一次不应再改任何东西（启动自愈每次启动都会跑）
  const r2 = svc.reconcileProjectMetadata();
  check("自愈幂等（healed=0 且 grouped=0）", r2.healed === 0 && r2.grouped === 0, JSON.stringify(r2));

  // 台账条目数不变（只归类，不合并/不删卡）
  const after = JSON.parse(fs.readFileSync(path.join(root, "projects", "_index.json"), "utf8")).projects.length;
  check("卡片数量不变（只统一显示名，不合并卡片）", after === before, `${before} → ${after}`);

  svc.close();
  console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
  console.log(`（沙箱：${root}；真实记忆库与真实台账未被改动）`);
}

main().catch((e) => { console.error("运行异常：", e); process.exit(1); });
