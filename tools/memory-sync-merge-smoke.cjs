/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 同步三方合并判定自测：baseline / local / remote 三方的「变没变」口径
//   ① 只有 mtime 变（内容没变）→ 不算变更：不重写、不误报冲突（跨设备 mtime 天然不同）
//   ② 只有本地改 → 保留本地、不报冲突（修复前会被误报成「双方都改了」而阻断上传）
//   ③ 远端真改 / 远端新增 / 远端删除 → 照常落地
//   ④ 双方都改 → 冲突入队
//   ⑤ hash 相同但某侧缺 size（早年清单）→ 以 hash 为准，不退回含 mtime 的比较
//   ⑥ 无 hash 的旧清单 → 退回整对象比较（保守，宁可多判一次变更）
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-sync-merge-smoke.cjs
// 不依赖 Electron API；node:sqlite 需 Node ≥ 22（Electron 内置 Node 22 可跑）
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemorySync, buildManifest } = require("../electron/backend/memory/sync.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { MemoryConfig } = require("../electron/backend/memory/config.cjs");

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++; failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

const fmOf = (id, title, body) => `---\nid: ${id}\ntype: fact\nlayer: l1\ntitle: ${title}\nproject: quant\nagent: unknown\ncreated: "2026-10-01T00:00:00.000Z"\nupdated: "2026-10-01T00:00:00.000Z"\n---\n\n${body}\n`;
const relOf = (i) => `projects/quant/l1/unknown/2026-10-01-item-${String(i).padStart(4, "0")}.md`;
const put = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); };
const readLocal = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return ""; } };

/** 造一次同步场景：本地树 + 远端树（默认是本地树的副本）+ 基线清单 */
async function scenario(root, { files = 6 } = {}) {
  const remote = `${root}-remote`;
  const dataDir = path.join(root, "..", `data-${path.basename(root)}`);
  for (const d of [root, remote, dataDir]) fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < files; i++) put(root, relOf(i), fmOf(`s${i}`, `item-${i}`, "原始正文"));
  // 基线 = 本机当前态（各文件 mtime 是本机落盘时刻）
  const baseline = await buildManifest(root, { localOnly: [] });
  // 远端树 = 本地树副本，随后把远端 mtime 整体挪走：对端解包/落盘的时刻本机无从相同，
  // 这是修复前把整棵树判成「远端已改」的根因（Windows 的 cpSync 会保留 mtime，必须显式挪）
  fs.cpSync(root, remote, { recursive: true });
  const shift = new Date(Date.now() - 6 * 3600 * 1000);
  for (const rel of Object.keys(baseline)) fs.utimesSync(path.join(remote, rel), shift, shift);
  fs.writeFileSync(path.join(dataDir, "memory-sync-state.json"), JSON.stringify({ deviceId: "smoke", baseline, conflicts: [] }), "utf8");
  fs.writeFileSync(path.join(dataDir, "memory-sync-conflicts.json"), "[]", "utf8");

  const svc = new MemoryService(root, new MemoryConfig(root), { deviceId: "smoke" });
  svc.index.open();
  const events = [];
  const sync = new MemorySync({ service: svc, rootDir: root, dataDir, deviceId: "smoke", deviceName: "smoke", getConfig: () => ({}), moduleWebdav: null, emit: (e) => events.push(e) });
  // 落地次数（含重写）：合并判定说「没变」时这里必须是 0
  const writes = [];
  const realWrite = svc.store.writeAtomic.bind(svc.store);
  svc.store.writeAtomic = (rel, text, opts) => { writes.push(rel); return realWrite(rel, text, opts); };
  return { root, remote, dataDir, baseline, svc, sync, events, writes };
}

async function main() {
  const base = path.join(os.tmpdir(), `agenthub-sync-merge-smoke-${Date.now()}`);

  console.log("[1] 只有 mtime 变（内容没变）→ 不算变更");
  {
    const s = await scenario(path.join(base, "mtime"));
    const r = await s.sync._mergeRemote(s.remote);
    check("不落地任何文件（修复前：整棵树重写）", r.applied === 0, JSON.stringify(r));
    check("不产生冲突", r.conflicts === 0, JSON.stringify(s.sync.state.conflicts || []));
    check("没有触发写盘", s.writes.length === 0, s.writes.join(","));
    check("内容保持原样", readLocal(s.root, relOf(0)).includes("原始正文"));
    s.svc.close();
  }

  console.log("[2] 本地 mtime 与基线也不同（两侧内容都没变）→ 同样不算变更");
  {
    const s = await scenario(path.join(base, "local-mtime"));
    // 本机文件被外部工具重写过时间戳但内容一致：基线里是本机旧 mtime
    const old = new Date(Date.now() - 3600 * 1000);
    for (let i = 0; i < 6; i++) fs.utimesSync(path.join(s.root, relOf(i)), old, old);
    const r = await s.sync._mergeRemote(s.remote);
    check("不落地、不报冲突（修复前：双方都改 → 假冲突，阻断上传）", r.applied === 0 && r.conflicts === 0, JSON.stringify(r));
    s.svc.close();
  }

  console.log("[3] 只有本地改 → 保留本地，不当冲突");
  {
    const s = await scenario(path.join(base, "local-only"));
    put(s.root, relOf(2), fmOf("s2", "item-2", "本地改过的正文"));
    const r = await s.sync._mergeRemote(s.remote);
    check("不报冲突（修复前：远端 mtime 不同被算成也改了 → 假冲突）", r.conflicts === 0, JSON.stringify((s.sync.state.conflicts || []).map((c) => c.path)));
    check("本地改动未被远端旧版覆盖", readLocal(s.root, relOf(2)).includes("本地改过的正文"));
    check("没有写盘（本地就是最新）", s.writes.length === 0, s.writes.join(","));
    s.svc.close();
  }

  console.log("[4] 远端真改 / 远端新增 / 远端删除（其余文件只有 mtime 变）");
  {
    const s = await scenario(path.join(base, "remote-changes"));
    put(s.remote, relOf(1), fmOf("s1", "item-1", "远端改过的正文")); // 改
    put(s.remote, "projects/quant/l1/unknown/2026-10-02-added.md", fmOf("added", "远端新增", "远端加的正文")); // 增
    fs.rmSync(path.join(s.remote, relOf(3))); // 删
    const r = await s.sync._mergeRemote(s.remote);
    check("改：落地远端内容", readLocal(s.root, relOf(1)).includes("远端改过的正文"));
    check("增：远端新增文件落盘", readLocal(s.root, "projects/quant/l1/unknown/2026-10-02-added.md").includes("远端加的正文"));
    check("删：本地文件进回收站（原路径消失）", !fs.existsSync(path.join(s.root, relOf(3))));
    check("计数为已落地 3 项（改+增+删）", r.applied === 3, JSON.stringify(r));
    check("无冲突", r.conflicts === 0, JSON.stringify((s.sync.state.conflicts || []).map((c) => c.path)));
    s.svc.close();
  }

  console.log("[5] 双方都改（内容不同）→ 冲突入队");
  {
    const s = await scenario(path.join(base, "both"));
    put(s.root, relOf(4), fmOf("s4", "item-4", "本地版"));
    put(s.remote, relOf(4), fmOf("s4", "item-4", "远端版"));
    const r = await s.sync._mergeRemote(s.remote);
    check("记录一条冲突", r.conflicts === 1, JSON.stringify(r));
    check("冲突带回双侧文本（裁决要用）", (() => { const c = (s.sync.state.conflicts || [])[0]; return c && c.localText.includes("本地版") && c.remoteText.includes("远端版"); })(), JSON.stringify((s.sync.state.conflicts || [])[0] || {}));
    s.svc.close();
  }

  console.log("[6] hash 相同但某侧缺 size（早年清单）→ 以 hash 为准，不算变更");
  {
    const s = await scenario(path.join(base, "no-size"));
    const cur = await buildManifest(s.root, { localOnly: [] });
    // 远端：内容与本地一致，但条目里没有 size（也无从比 mtime——跨设备的 mtime 本来就不同）
    const remoteManifest = {};
    for (const [rel, e] of Object.entries(cur)) remoteManifest[rel] = { hash: e.hash, mtime: e.mtime + 12345 };
    const r = await s.sync._mergeRemote(s.remote, remoteManifest);
    check("不落地（缺 size 不退回含 mtime 的比较）", r.applied === 0, JSON.stringify(r));
    s.svc.close();
  }

  console.log("[7] 无 hash 的旧清单 → 退回整对象比较（保守，宁可多判一次变更）");
  {
    const s = await scenario(path.join(base, "legacy"));
    const cur = await buildManifest(s.root, { localOnly: [] });
    const stripHash = (m) => Object.fromEntries(Object.entries(m).map(([k, e]) => [k, { size: e.size, mtime: e.mtime }]));
    // 两侧都是旧清单且条目逐字段一致（内容与 mtime 都相同）→ 判为未变
    s.sync.state.baseline = stripHash(cur);
    s.writes.length = 0;
    const same = await s.sync._mergeRemote(s.remote, stripHash(cur));
    check("两侧旧清单一致 → 不落地、不写盘", same.applied === 0 && s.writes.length === 0, JSON.stringify(same));
    // 混版本（本机有 hash / 远端旧清单无 hash）→ 形状不同即判为已改，不静默放过
    s.sync.state.baseline = cur;
    const mixed = await s.sync._mergeRemote(s.remote, stripHash(cur));
    check("混版本清单 → 保守判为远端已改", mixed.applied > 0, JSON.stringify(mixed));
    s.svc.close();
  }

  // ===== 裁决 × 下一次同步：裁决是本地意图，远端还没收到，不能被下一轮合并撤销 =====
  const conflicted = async (dirName) => {
    const s = await scenario(path.join(base, dirName));
    put(s.root, relOf(0), fmOf("s0", "item-0", "本地裁决前版本"));
    put(s.remote, relOf(0), fmOf("s0", "item-0", "远端版本"));
    const r = await s.sync._mergeRemote(s.remote);
    check("首轮产生 1 条冲突", r.conflicts === 1, JSON.stringify(r));
    return s;
  };

  console.log("[8] 裁决 keepLocal → 下一次同步不把本地覆盖回远端旧版");
  {
    const s = await conflicted("resolve-keep-local");
    check("裁决成功", (await s.sync.resolve(0, "keepLocal")).ok === true);
    const r2 = await s.sync._mergeRemote(s.remote);
    check("二次同步不落地（修复前：本地被覆盖回远端旧版，裁决静默撤销）", r2.applied === 0, JSON.stringify(r2));
    check("本地版本仍在", readLocal(s.root, relOf(0)).includes("本地裁决前版本"));
    s.svc.close();
  }

  console.log("[9] 裁决 keepRemote → 下一次同步保持远端版本");
  {
    const s = await conflicted("resolve-keep-remote");
    check("裁决成功", (await s.sync.resolve(0, "keepRemote")).ok === true);
    check("本地已是远端版本", readLocal(s.root, relOf(0)).includes("远端版本"));
    const r2 = await s.sync._mergeRemote(s.remote);
    check("二次同步不落地、不冲突", r2.applied === 0 && r2.conflicts === 0, JSON.stringify(r2));
    check("仍是远端版本", readLocal(s.root, relOf(0)).includes("远端版本"));
    s.svc.close();
  }

  console.log("[10] 裁决合并文本 → 下一次同步不把合并结果覆盖掉");
  {
    const s = await conflicted("resolve-merge");
    const merged = fmOf("s0", "item-0", "本地与远端的合并结果");
    check("裁决成功", (await s.sync.resolve(0, "merge", merged)).ok === true);
    const r2 = await s.sync._mergeRemote(s.remote);
    check("二次同步不落地（修复前：合并结果被远端版覆盖）", r2.applied === 0, JSON.stringify(r2));
    check("合并结果仍在", readLocal(s.root, relOf(0)).includes("本地与远端的合并结果"));
    s.svc.close();
  }

  console.log("[11] 裁决 keepBoth → 远端版另存，本地版本不被覆盖");
  {
    const s = await conflicted("resolve-keep-both");
    check("裁决成功", (await s.sync.resolve(0, "keepBoth")).ok === true);
    const dir = path.dirname(path.join(s.root, relOf(0)));
    const alts = fs.readdirSync(dir).filter((f) => f.includes(".remote-"));
    check("远端版已另存一份", alts.length === 1 && fs.readFileSync(path.join(dir, alts[0]), "utf8").includes("远端版本"), alts.join(","));
    const r2 = await s.sync._mergeRemote(s.remote);
    check("二次同步不落地、不冲突", r2.applied === 0 && r2.conflicts === 0, JSON.stringify(r2));
    check("本地版本仍在（修复前被远端版覆盖）", readLocal(s.root, relOf(0)).includes("本地裁决前版本"));
    check("另存的那份也还在", fs.readdirSync(dir).filter((f) => f.includes(".remote-")).length === 1);
    s.svc.close();
  }

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

main().catch((e) => { console.error("自测崩溃：", (e && e.stack) || e); process.exit(2); });
