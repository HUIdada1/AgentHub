// 记忆中枢「一键采纳建议」沙箱自测：解包 mtime 往返 + 批量按建议裁决全分支
// 运行：node scripts/test-memory-conflict-batch.cjs
// 只碰临时目录，不需要 SQLite / WebDAV / Electron
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mem-batch-"));
const tarpack = require("../electron/backend/tarpack.cjs");
const { MemorySync } = require("../electron/backend/memory/sync.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

/** 造一个只落在临时目录、依赖全打桩的 syncer */
function makeSyncer(rootDir, dataDir) {
  return new MemorySync({
    rootDir,
    dataDir,
    getConfig: () => ({}),
    moduleWebdav: () => null,
    service: {
      store: {
        // 对齐真实 store.writeAtomic 的语义：backup 时先复制出 <target>.bak.<ts>
        writeAtomic(rel, text, { backup = false } = {}) {
          const target = path.join(rootDir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (backup && fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak.${Date.now()}`);
          fs.writeFileSync(target, text);
        },
        moveToTrash(rel) { fs.rmSync(path.join(rootDir, rel), { force: true }); },
      },
      index: { removeByPath() {}, setMeta() {} },
      reindexFile() {},
      withWrite: (fn) => fn(),
    },
  });
}

async function main() {
  // ---------- 1. 解包还原原始 mtime ----------
  console.log("\n[1] tarpack 解包 mtime 往返");
  {
    const src = path.join(TMP, "src");
    fs.mkdirSync(path.join(src, "projects"), { recursive: true });
    const oldFile = path.join(src, "projects", "2026-09-01.md");
    const newFile = path.join(src, "general.md");
    fs.writeFileSync(oldFile, "旧文件内容\n");
    fs.writeFileSync(newFile, "新文件内容\n");
    const oldSec = Math.floor(new Date("2026-09-01T10:00:00Z").getTime() / 1000);
    const newSec = Math.floor(new Date("2026-09-20T10:00:00Z").getTime() / 1000);
    fs.utimesSync(oldFile, oldSec, oldSec);
    fs.utimesSync(newFile, newSec, newSec);

    const pkg = path.join(TMP, "pack.tar.gz");
    tarpack.packDir(src, pkg);
    const dest = path.join(TMP, "unpacked");
    const n = tarpack.unpack(pkg, dest);
    ok(n === 2, `解包文件数 2（实际 ${n}）`);

    const gotOld = Math.round(fs.statSync(path.join(dest, "projects", "2026-09-01.md")).mtimeMs / 1000);
    const gotNew = Math.round(fs.statSync(path.join(dest, "general.md")).mtimeMs / 1000);
    ok(gotOld === oldSec, `旧文件 mtime 还原为 09-01（实际 ${new Date(gotOld * 1000).toISOString()}）`);
    ok(gotNew === newSec, `新文件 mtime 还原为 09-20（实际 ${new Date(gotNew * 1000).toISOString()}）`);
    ok(gotNew > gotOld, "远端新旧相对关系保住（「保留远端」的判据成立）");
    ok(fs.readFileSync(path.join(dest, "general.md"), "utf8") === "新文件内容\n", "解包内容未受影响");
  }

  // ---------- 2. 批量按建议裁决 ----------
  console.log("\n[2] resolveMany 按 path 反查下标 + 失败跳过");
  const rootDir = path.join(TMP, "memory-root");
  const dataDir = path.join(TMP, "memory-data");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [rel, text] of Object.entries({ "a.md": "本地A", "b.md": "本地B", "c.md": "本地C" })) {
    fs.writeFileSync(path.join(rootDir, rel), text);
  }

  const syncer = makeSyncer(rootDir, dataDir);
  syncer.state.conflicts = [
    // a：双方都改，建议保留远端
    { kind: "memory", path: "a.md", note: "双方都改了", detectedAt: 1, local: { size: 9, mtime: 100, hash: "ha" }, remote: { size: 9, mtime: 200, hash: "hA" }, localText: "本地A", remoteText: "远端A" },
    // b：本地有 / 远端已删，建议保留本地
    { kind: "memory", path: "b.md", note: "本地有 / 远端已删", detectedAt: 2, local: { size: 9, mtime: 100, hash: "hb" }, remote: null },
    // c：远端新增 / 本地不存在，建议保留远端
    { kind: "memory", path: "c.md", note: "远端新增 / 本地不存在", detectedAt: 3, local: null, remote: { size: 9, mtime: 300, hash: "hc" }, remoteText: "远端C" },
  ];

  // 故意乱序提交，并混入两条不合法项，验证按 path 定位而不是按下标
  const res = await syncer.resolveMany([
    { path: "c.md", decision: "keepRemote" },
    { path: "ghost.md", decision: "keepLocal" },   // 队列里不存在
    { path: "a.md", decision: "keepRemote" },
    { path: "a.md", decision: "keepBoth" },         // 批量只允许两档，应判参数不完整
    { path: "b.md", decision: "keepLocal" },
  ]);

  ok(res.total === 5, `total 计入全部提交项（实际 ${res.total}）`);
  ok(res.resolved === 3, `成功 3 条（实际 ${res.resolved}）`);
  ok(res.failed.length === 2, `失败 2 条（实际 ${res.failed.length}）`);
  ok(res.failed.some((f) => f.path === "ghost.md" && /队列已变化/.test(f.message)), "不存在的 path 报「队列已变化」");
  ok(res.failed.some((f) => f.path === "a.md" && /参数不完整/.test(f.message)), "非法 decision 报「参数不完整」且不误伤它条");

  ok(fs.readFileSync(path.join(rootDir, "a.md"), "utf8") === "远端A", "a：保留远端 → 本地落成远端内容");
  ok(fs.readFileSync(path.join(rootDir, "b.md"), "utf8") === "本地B", "b：保留本地 → 本地内容不动");
  ok(fs.readFileSync(path.join(rootDir, "c.md"), "utf8") === "远端C", "c：保留远端 → 新建出远端内容");
  ok((syncer.state.conflicts || []).length === 0, `裁决成功后三条全部出队（实际剩 ${(syncer.state.conflicts || []).length}）`);

  const reports = fs.readdirSync(path.join(rootDir, "reports")).filter((f) => f.startsWith("conflict-"));
  ok(reports.length === 1, "「保留本地」的远端版本留档到 reports/（不静默丢弃）");
  ok(fs.readdirSync(rootDir).some((f) => f.startsWith("a.md.bak.")), "「保留远端」覆盖前本地版本备份为 .bak（带时间戳）");
  ok(syncer.state.baseline["a.md"] && syncer.state.baseline["a.md"].hash, "裁决后基线已回写（下一轮同步不会把同一条再判成冲突）");

  // ---------- 3. 裁决后队列已空 → 再点一次必须明确报「已被处理」而不是静默成功 ----------
  console.log("\n[3] 幂等/重入");
  const again = await syncer.resolveMany([{ path: "a.md", decision: "keepRemote" }]);
  ok(again.resolved === 0 && again.failed.length === 1, "队列已空时再裁决 → 0 成功 1 失败，不谎报成功");

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});