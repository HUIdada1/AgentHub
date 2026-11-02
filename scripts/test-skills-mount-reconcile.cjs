/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-02
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 技能仓库「挂载台账」自测：新增的三个内置适配器 + 台账丢失后的自愈 + 合并不得抹 mounts。
// 现场只用临时目录（AGENT_SKILLS_FAKE_HOME / AGENT_SKILLS_HOME / AGENTHUB_DATA_DIR 三个沙箱钩子），
// 不碰真实 home、不联网、不需要 Electron。
// 运行：node scripts/test-skills-mount-reconcile.cjs
//
// 钉死的不变量（改动前必红）：
//   ① DeepSeek Harness / WorkBuddy / WorkBuddy AI 是内置适配器，默认路径各归各家、互不串台；
//   ② 账本丢了但磁盘链接还在时，reconcileMounts 必须把挂载补回账本，且重复调用幂等；
//   ③ 悬空链接（中央真身不存在）不补账 —— 不给已删除的技能复活；
//   ④ WebDAV 合并台账必须原样保留本机 mounts（两种分支：内容一致 + 冲突保持远端条目）；
//   ⑤ 台账里没有该工具的记录时，「启用」也要能现场建挂载（中央技能库唯一可行的挂载入口）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-skill-mounts-"));
const HOME = path.join(TMP, "home");
const HUB = path.join(TMP, "hub");
process.env.AGENT_SKILLS_FAKE_HOME = HOME; // 工具目录按它展开（adapter.expandPath）
process.env.AGENT_SKILLS_HOME = HUB; // 中央技能仓库
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data"); // 配置目录
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const config = require("../electron/backend/config.cjs");
const adapter = require("../electron/backend/adapter.cjs");
const syncer = require("../electron/backend/syncer.cjs");
const scanner = require("../electron/backend/scanner.cjs");
const hub = require("../electron/backend/hub.cjs");
const mounter = require("../electron/backend/mounter.cjs");
const remotesync = require("../electron/backend/remotesync.cjs");
const { mergeManifests } = remotesync;

const cfg = config.loadConfig();
const DSH = path.join(HOME, ".dsh", "skills");
const WB = path.join(HOME, ".workbuddy", "skills");
const WB_AI = path.join(HOME, ".workbuddy-ai", "skills");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

/** 造一个最小可识别技能目录（扫描层只认 SKILL.md 的 frontmatter） */
function writeSkill(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 自测技能\n---\n\n${body}\n`);
  return dir;
}

/** 建链接（Windows 走 junction）；已存在先删，让每个用例从同一现场起步 */
function makeLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (fs.existsSync(linkPath) || mounter.isLink(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** 把一份技能目录收进中央仓库（走真实 importSkill，台账结构与产品一致） */
function importSkill(name, body) {
  const src = writeSkill(path.join(TMP, "src", name), name, body || `${name} 内容`);
  hub.importSkill({
    name, dir: src, skillName: name, description: "", version: "", treeHash: "", health: [],
    sources: [{ tool: "dsh", name, dir: src }],
  });
  fs.rmSync(src, { recursive: true, force: true });
  return path.join(hub.skillsDir(), name);
}

function mountRows(name) {
  const m = hub.loadManifest();
  return (m.skills[name] && m.skills[name].mounts) || [];
}

function main() {
  // ---------- [1] 三个新内置适配器 ----------
  console.log("\n[1] 内置适配器：DeepSeek Harness / WorkBuddy / WorkBuddy AI");
  {
    const ids = adapter.TOOL_REGISTRY.map((t) => t.id);
    ok(ids.includes("dsh") && ids.includes("workbuddy") && ids.includes("workbuddy-ai"), "三个 id 都在内置注册表里");
    const nameOf = (id) => (adapter.TOOL_REGISTRY.find((t) => t.id === id) || {}).name;
    ok(nameOf("dsh") === "DeepSeek Harness", "显示名 DeepSeek Harness");
    ok(nameOf("workbuddy") === "WorkBuddy", "显示名 WorkBuddy");
    ok(nameOf("workbuddy-ai") === "WorkBuddy AI", "显示名 WorkBuddy AI");
    for (const id of ["dsh", "workbuddy", "workbuddy-ai"]) {
      const t = cfg.tools[id];
      ok(!!t && t.enabled === true, `老配置深合并后自带 ${id}（默认启用）`);
    }
    // 只建 WorkBuddy 一家的目录：扫描目标必须只命中它，不能把 workbuddy-ai 误认成 workbuddy
    fs.mkdirSync(WB, { recursive: true });
    let targets = adapter.resolveScanTargets(cfg);
    ok(targets.some((t) => t.id === "workbuddy" && t.dir === WB), "WorkBuddy 命中 ~/.workbuddy/skills");
    ok(!targets.some((t) => t.id === "workbuddy-ai"), "WorkBuddy AI 目录不存在 → 不参与扫描");
    ok(!targets.some((t) => t.id === "dsh"), "DSH 目录不存在 → 不参与扫描");
    fs.mkdirSync(WB_AI, { recursive: true });
    fs.mkdirSync(DSH, { recursive: true });
    targets = adapter.resolveScanTargets(cfg);
    ok(targets.some((t) => t.id === "dsh" && t.dir === DSH), "DSH 命中 ~/.dsh/skills");
    ok(targets.some((t) => t.id === "workbuddy-ai" && t.dir === WB_AI), "WorkBuddy AI 命中 ~/.workbuddy-ai/skills 且与 WorkBuddy 互不覆盖");
  }

  // ---------- [2] 账空盘实：reconcileMounts 从磁盘补账 ----------
  console.log("\n[2] 挂载台账丢失后自愈（磁盘链接还在）");
  {
    const central = importSkill("alpha");
    ok(mountRows("alpha").length === 0, "初始台账无挂载");
    makeLink(central, path.join(DSH, "alpha"));
    const r1 = syncer.reconcileMounts(cfg);
    ok(r1.added >= 1, `reconcileMounts 补回 ${r1.added} 条挂载`);
    const rows = mountRows("alpha");
    ok(rows.length === 1 && rows[0].tool === "dsh", "补账工具 = dsh");
    ok(rows[0].name === "alpha" && rows[0].enabled === true, "挂载名与启用状态正确");
    ok(path.resolve(rows[0].path) === path.resolve(path.join(DSH, "alpha")), "挂载路径 = 磁盘上的链接位置");
    const r2 = syncer.reconcileMounts(cfg);
    ok(r2.added === 0, "重复调用幂等（不重复记账）");
    // 列表回填的 valid 依据磁盘实检，前端「已挂载/失效」才不会说谎
    const lib = syncer.librarySkills(syncer.survey(cfg));
    const row = lib.find((x) => x.name === "alpha");
    ok(!!row && row.mounts.length === 1 && row.mounts[0].valid === true, "技能库行回填 valid=true");
  }

  // ---------- [3] 悬空链接 / 未登记技能不补账 ----------
  console.log("\n[3] 不该补的绝不补");
  {
    // 链接指向中央仓库里一个 manifest 没登记的名字（模拟已删技能残留）
    const ghostDir = writeSkill(path.join(TMP, "ghost"), "ghost", "将被删掉的真身");
    makeLink(ghostDir, path.join(WB, "ghost"));
    fs.rmSync(ghostDir, { recursive: true, force: true }); // 真身没了 → 悬空
    const before = mountRows("ghost").length;
    const r = syncer.reconcileMounts(cfg);
    ok(r.added === 0 || mountRows("ghost").length === before, "悬空链接不补账（不给已删技能复活）");
    // 链接指向中央仓库之外的位置，也不是挂载
    const outside = writeSkill(path.join(TMP, "outside", "beta"), "beta", "外部目录");
    makeLink(outside, path.join(WB, "beta"));
    const r2 = syncer.reconcileMounts(cfg);
    ok(r2.added === 0, "指向中央仓库之外的链接不算挂载");
  }

  // ---------- [4] WebDAV 台账：远端不存 mounts，本机台账不得被下载覆盖清空 ----------
  console.log("\n[4] 跨设备同步不得碰本机挂载台账");
  {
    const mk = (name, hash, mounts) => ({ name, treeHash: hash, mounts, sources: [], mergeHistory: [], health: [], version: "", description: "" });
    const localMounts = [{ tool: "dsh", name: "a", path: path.join(DSH, "a"), type: "junction", enabled: true }];
    // 分支一：合并产物（推回远端的 manifest.json）必须不含 mounts —— 否则 A 机器的路径会带给 B
    const m1 = mergeManifests(
      { version: 1, skills: { a: mk("a", "H1", localMounts) }, deleted: {} },
      { version: 1, skills: { a: { name: "a", treeHash: "H1", sources: [], mergeHistory: [], health: [] } }, deleted: {} },
      new Set()
    );
    ok(m1.skills.a.mounts === undefined, "合并结果（远端台账）不含 mounts，不把本机路径带给其他设备");
    ok(m1.skills.a.treeHash === "H1", "远端条目内容照旧对齐");
    // 分支二：本机版已上传 → 远端条目被覆盖，但仍不含 mounts
    const m2 = mergeManifests(
      { version: 1, skills: { a: mk("a", "H2", localMounts) }, deleted: {} },
      { version: 1, skills: { a: { name: "a", treeHash: "H1", sources: [], mergeHistory: [], health: [] } }, deleted: {} },
      new Set(["a"])
    );
    ok(m2.skills.a.treeHash === "H2" && m2.skills.a.mounts === undefined, "上传分支：远端条目更新且依旧不含 mounts");

    // 分支三（真根因）：远端新版下载部署覆盖本机旧版时，本机 mounts 必须原样留住。
    // 历史 bug 正是这里写死 mounts: []：链接还在磁盘、账本却空了，技能库全显示未挂载。
    importSkill("epsilon", "旧内容");
    const r0 = syncer.toggleMount("epsilon", "workbuddy", true, cfg);
    ok(r0.ok === true && mountRows("epsilon").length === 1, "epsilon 已有一条本机挂载台账");
    const newSrc = writeSkill(path.join(TMP, "epsilon-new"), "epsilon", "远端新内容");
    const newHash = scanner.treeHash(newSrc);
    const result = { downloads: [] };
    remotesync.deployDownload(
      { name: "epsilon", reason: "远端有更新" },
      newSrc,
      newHash,
      { skills: { epsilon: { version: "2.0.0", description: "远端描述", sources: [], mergeHistory: [], health: [] } } },
      result
    );
    const after = hub.loadManifest().skills.epsilon;
    ok(after.mounts.length === 1 && after.mounts[0].tool === "workbuddy", "下载覆盖后本机挂载台账仍在");
    ok(after.description === "远端描述" && after.treeHash === newHash, "内容确实换成了远端版（不是放弃更新）");
    ok(result.downloads.length === 1, "下载动作被记进同步结果");
    ok(mounter.pointsTo(path.join(WB, "epsilon"), path.join(hub.skillsDir(), "epsilon")), "原挂载链接依旧指向中央真身（新内容）");
  }

  // ---------- [5] 台账无记录时也能「启用」= 现场建挂载 ----------
  console.log("\n[5] 从中央技能库直接挂载（无台账记录）");
  {
    const central = importSkill("gamma");
    ok(mountRows("gamma").length === 0, "初始无台账");
    const r = syncer.toggleMount("gamma", "workbuddy-ai", true, cfg);
    ok(r.ok === true, `启用成功：${r.message}`);
    ok(mounter.pointsTo(path.join(WB_AI, "gamma"), central), "磁盘上出现指向中央真身的链接");
    const rows = mountRows("gamma");
    ok(rows.length === 1 && rows[0].tool === "workbuddy-ai" && rows[0].enabled === true, "台账记下这条新挂载");
    // 目录不存在的工具：如实拒绝，不擅自造目录
    fs.rmSync(path.join(HOME, ".codex"), { recursive: true, force: true });
    const bad = syncer.toggleMount("gamma", "codex", true, cfg);
    ok(bad.ok === false && /没有可用的技能目录/.test(bad.message), "未连接工具如实拒绝");
    ok(!fs.existsSync(path.join(HOME, ".codex", "skills")), "拒绝时不擅自创建工具目录");
    // 停用：只摘链接，中央真身不动
    const off = syncer.toggleMount("gamma", "workbuddy-ai", false, cfg);
    ok(off.ok === true, "停用成功");
    ok(!mounter.isLink(path.join(WB_AI, "gamma")) && fs.existsSync(central), "链接已摘除，中央真身完好");
    ok(mountRows("gamma")[0].enabled === false, "台账标记为已停用");
  }

  // ---------- [6] 修复挂载：先补账再重建 ----------
  console.log("\n[6] 修复挂载会先补账");
  {
    // delta：台账空、磁盘上有一条有效链接 → repairMounts 不该把它当失效重建，但必须先把账补回来
    const central = importSkill("delta");
    makeLink(central, path.join(WB, "delta"));
    const r = syncer.repairMounts(cfg);
    ok(r.reconciled >= 1, `修复时补账 ${r.reconciled} 条`);
    const rows = mountRows("delta");
    ok(rows.length === 1 && rows[0].tool === "workbuddy", "delta 的挂载已入账");
    ok(mounter.verifyAll(hub.loadManifest()).find((x) => x.skill === "delta" && x.tool === "workbuddy").valid === true, "磁盘挂载有效，未被误重建");
  }

  console.log(`\n${failed === 0 ? "OK" : "FAIL"} 技能仓库挂载台账自测：${pass} 项通过，${failed} 项失败`);
}

console.log(`沙箱目录：${TMP}（成功即清理；失败留着看现场）`);
main();
if (failed === 0) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
