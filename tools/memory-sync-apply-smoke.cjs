/**
 * AgentHub 记忆中枢 · 同步「落地」路径自测（P0 全链路）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 同步落地自测：验证 _mergeRemote 的「仅远端改」落地路径
//   ① 批量 worker 落地后，文件内容与索引行都正确
//   ② 退化路径（worker 不可用）仍能落地，且失败明细带 rel
//   ③ daily 三方自动合并同样走批量落地（不再主线程逐文件写盘）
//   ④ 落地前守卫：批次排队期间本地被改写 → 升级为冲突而不是被静默覆盖
// 用法：node tools/memory-sync-apply-smoke.cjs
// 不依赖 Electron API；node:sqlite 需 Node ≥ 22。
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
const dailyOf = (date, sections) => {
  const parts = [`---\nagent: unknown\nproject: quant\nprojectName: quant\ndate: ${date}\n---\n`];
  for (const s of sections) parts.push(`\n## ${s.time} · ${s.title}\n<!-- mem:${s.id} -->\n> importance: 3 · tags: \n\n${s.body}\n`);
  return parts.join("");
};
const readLocal = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return ""; } };

async function scenario(root, { breakWorker = false, injectBeforeFirstApply = false, dailyBothChanged = false, totalFiles = 60, remoteOnlyFile = "", injectTarget = "" } = {}) {
  const remote = `${root}-remote`;
  const dataDir = path.join(root, "..", `data-${path.basename(root)}`);
  for (const d of [root, remote, dataDir]) fs.mkdirSync(d, { recursive: true });
  const put = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); };
  const N = totalFiles;
  const relOf = (i) => `projects/quant/l1/unknown/2026-10-01-item-${String(i).padStart(4, "0")}.md`;
  const dailyRel = "general/l1/unknown/2026-10-01.md";
  const baseSec = { time: "08:00", title: "基线节", id: "sec_base_1", body: "基线内容" };

  for (let i = 0; i < N; i++) put(root, relOf(i), fmOf(`s${i}`, `item-${i}`, "原始正文"));
  if (dailyBothChanged) put(root, dailyRel, dailyOf("2026-10-01", [baseSec]));
  const baseline = await buildManifest(root, { localOnly: [] });

  fs.cpSync(root, remote, { recursive: true });
  for (let i = 0; i < N; i++) put(remote, relOf(i), fmOf(`s${i}`, `item-${i}`, "远端改过的正文"));
  // 只在远端存在的新文件（远端新增）：本地清单与基线里都没有它
  if (remoteOnlyFile) put(remote, remoteOnlyFile, fmOf("remote-new", "远端新增", "远端新增的正文"));
  if (dailyBothChanged) {
    put(root, dailyRel, dailyOf("2026-10-01", [baseSec, { time: "09:00", title: "本地节", id: "sec_local_1", body: "本地内容" }]));
    put(remote, dailyRel, dailyOf("2026-10-01", [baseSec, { time: "10:00", title: "远端节", id: "sec_remote_1", body: "远端内容" }]));
  }

  fs.writeFileSync(path.join(dataDir, "memory-sync-state.json"), JSON.stringify({ deviceId: "smoke", baseline, conflicts: [] }), "utf8");
  fs.writeFileSync(path.join(dataDir, "memory-sync-conflicts.json"), "[]", "utf8");

  // 注入目标：默认最后一个文件（属于最后一个批次，注入发生在其落地之前）；
  // 守卫补全那条用「只存在于远端的文件」当目标
  const target = injectTarget || relOf(N - 1);
  let touched = false;

  const workerMod = require("../electron/backend/memory/sync-apply-worker.cjs");
  const realOpen = workerMod.openApplySession;
  if (breakWorker) {
    workerMod.openApplySession = () => { throw new Error("smoke 注入：worker 不可用"); };
  } else if (injectBeforeFirstApply) {
    // 确定性注入：本地清单快照已算完（merge 已进入落地阶段），在第一批真正落盘之前改写目标文件。
    // 这正好复现「决策用的快照说本地没变，但批次排队期间本地被 MCP 桥等独立进程改写」的窗口。
    workerMod.openApplySession = (opts) => {
      const session = realOpen(opts);
      let injected = false;
      return {
        applyBatch: (jobs) => {
          if (!injected) {
            injected = true;
            fs.writeFileSync(path.join(root, target), fmOf("local-new", "本地新建", "同步期间被本地改写"), "utf8");
            touched = true;
          }
          return session.applyBatch(jobs);
        },
        close: () => session.close(),
      };
    };
  }

  const svc = new MemoryService(root, new MemoryConfig(root), { deviceId: "smoke" });
  svc.index.open();
  const events = [];
  const sync = new MemorySync({ service: svc, rootDir: root, dataDir, deviceId: "smoke", deviceName: "smoke", getConfig: () => ({}), moduleWebdav: null, emit: (e) => events.push(e) });

  const res = await sync._mergeRemote(remote, await buildManifest(remote, { localOnly: [] }));
  workerMod.openApplySession = realOpen;

  const indexed = (rel) => svc.index.db.prepare("SELECT COUNT(*) c FROM mem WHERE path = ?").get(rel).c;
  let landed = 0, indexedCount = 0;
  for (let i = 0; i < N; i++) {
    if (readLocal(root, relOf(i)).includes("远端改过的正文")) landed++;
    if (indexed(relOf(i)) > 0) indexedCount++;
  }
  return { res, landed, indexedCount, N, events, touched, target, dailyRel, dailyContent: dailyBothChanged ? readLocal(root, dailyRel) : "", sync, root };
}

async function main() {
  const base = path.join(os.tmpdir(), `agenthub-sync-apply-smoke-${Date.now()}`);
  console.log("[1] 正常路径：批量 worker 落地");
  {
    const r = await scenario(path.join(base, "normal"));
    check("60 个远端变更文件全部落地", r.landed === r.N, `落盘 ${r.landed}/${r.N}`);
    check("全部建立索引行", r.indexedCount === r.N, `索引 ${r.indexedCount}/${r.N}`);
    check("applied 计数与落盘一致", r.res.applied === r.N, JSON.stringify(r.res));
    check("无失败明细", r.res.applyFailed === 0, JSON.stringify(r.res));
    check("未触发退化", !r.events.some((e) => String(e.detail || "").includes("改用主线程落地")));
    r.sync.service.close();
  }

  console.log("[2] 退化路径：worker 不可用");
  {
    const r = await scenario(path.join(base, "fallback"), { breakWorker: true });
    check("退化后仍全部落地", r.landed === r.N, `落盘 ${r.landed}/${r.N}`);
    check("退化后仍全部建索引", r.indexedCount === r.N, `索引 ${r.indexedCount}/${r.N}`);
    check("发出「改用主线程落地」事件", r.events.some((e) => String(e.detail || "").includes("改用主线程落地")));
    check("失败明细为空（退化路径本身成功）", r.res.applyFailed === 0, JSON.stringify(r.res));
    r.sync.service.close();
  }

  console.log("[3] daily 三方自动合并走同一批量落地");
  {
    const r = await scenario(path.join(base, "daily"), { dailyBothChanged: true });
    check("daily 合并结果落地（含远端节）", r.dailyContent.includes("远端内容"));
    check("daily 合并保留本地节", r.dailyContent.includes("本地内容"));
    check("daily 建立索引行", r.sync.service.index.db.prepare("SELECT COUNT(*) c FROM mem WHERE path = ?").get(r.dailyRel).c > 0);
    check("daily 也计入 applied", r.res.applied === r.N + 1, JSON.stringify(r.res));
    r.sync.service.close();
  }

  console.log("[4] 落地前守卫：批次排队期间本地被改写 → 升级为冲突");
  {
    const r = await scenario(path.join(base, "guard"), { totalFiles: 200, injectBeforeFirstApply: true });
    check("注入生效（目标文件在落地前被改写）", r.touched);
    const guardHit = (r.sync.state.conflicts || []).some((c) => /同步期间本地又被修改/.test(c.note || ""));
    check("守卫触发：升级为冲突", guardHit, JSON.stringify((r.sync.state.conflicts || []).map((c) => `${c.path}:${c.note}`)));
    check("被改写的文件未被远端版本覆盖", readLocal(r.root, r.target).includes("同步期间被本地改写"));
    check("其余文件正常落地", r.landed === r.N - 1, `落盘 ${r.landed}/${r.N - 1}`);
    r.sync.service.close();
  }

  console.log("[5] 守卫补全：窗口内本地新建同名文件（快照里本地没有）→ 也升级为冲突");
  {
    const remoteOnly = "projects/quant/l1/unknown/2026-10-03-remote-new.md";
    const r = await scenario(path.join(base, "guard-new"), { remoteOnlyFile: remoteOnly, injectBeforeFirstApply: true, injectTarget: remoteOnly });
    check("注入生效（远端要新增的文件在落地前被本地先建出来）", r.touched);
    const hit = (r.sync.state.conflicts || []).some((c) => c.path === remoteOnly && /同步期间本地又被修改/.test(c.note || ""));
    check("守卫触发：升级为冲突", hit, JSON.stringify((r.sync.state.conflicts || []).map((c) => `${c.path}:${c.note}`)));
    check("本地新建的那份没被远端版本覆盖", readLocal(r.root, remoteOnly).includes("同步期间被本地改写"));
    check("冲突条目带 size/mtime（冲突页要显示）", (() => {
      const c = (r.sync.state.conflicts || []).find((x) => x.path === remoteOnly);
      return !!(c && c.local && c.local.size > 0 && c.local.mtime > 0);
    })(), JSON.stringify((r.sync.state.conflicts || []).find((x) => x.path === remoteOnly) || {}));
    check("不计入 applied（其余文件照常落地）", r.res.applied === r.N, JSON.stringify(r.res));
    r.sync.service.close();
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