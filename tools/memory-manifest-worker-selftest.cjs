// 记忆中枢 · 清单构建 worker 化自测（纯 Node，无 electron 依赖）
// 跑法：node tools/memory-manifest-worker-selftest.cjs
//
// 覆盖（对应 perf/memory-sync-worker 的审核发现）：
//   V1 正确性：worker 版清单 ≡ 同步版（深比较）；排除目录/后缀、隐私白名单均缺席
//   V2 效果：worker 版执行期间主进程事件循环最大卡顿应显著小于同步版
//   V3 语义：读不到的文件不得以「空哈希条目」进清单（与旧版跳过语义一致）
//   V4 卫生：worker 引导用毕清理临时源码目录，%TEMP% 不留残骸
//
// 说明：断言对象是**发货路径**（sync.cjs 导出的 buildManifest 本体）。早前这里自己拼了一份
// worker 引导，于是 V4 测的其实是被测自造的那份 harness——发货路径因主线程 terminate() 抢跑
// 而每个实例漏一个 agenthub-manifest-*（本机实测累积 313 个），自测却始终全绿。
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const CORE = path.join(ROOT, "electron", "backend", "memory", "manifest-core.cjs");
const SYNC = path.join(ROOT, "electron", "backend", "memory", "sync.cjs");
const manifestCore = require(CORE);
const { buildManifest } = require(SYNC);

let pass = 0;
let fail = 0;
const failures = [];
async function T(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

/** 造沙箱记忆树：正常文件 + 排除项 + 永不上传项目 */
function makeTree() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "mf-selftest-"));
  const mk = (rel, size = 512) => {
    const p = path.join(tree, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, crypto.randomBytes(size).toString("hex").slice(0, size));
  };
  for (let d = 0; d < 6; d++) for (let f = 0; f < 50; f++) mk(`l1/2026-10/d${d}/note-${f}.md`);
  mk("projects/ok/p1.md");
  mk("projects/ok/p2.md");
  for (let f = 0; f < 10; f++) mk(`projects/secret/s-${f}.md`); // 永不上传项目
  mk(".trash/dead.md");
  mk("index/db.sqlite");
  mk("node_modules/x.js");
  mk("l1/a.md.bak");
  mk("l1/b.md.tmp");
  return tree;
}

/** 事件循环卡顿探针：每 4ms 心跳，记录最大间隔 */
function gapProbe() {
  const gaps = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, 4);
  return {
    stop: () => {
      clearInterval(timer);
      gaps.push(Date.now() - last); // 尾间隔：整段阻塞时心跳一次都没跑成，这里即总阻塞
      return { maxGap: Math.max(...gaps) };
    },
  };
}

/** worker 版清单：直接驱动发货路径（sync.cjs 的 buildManifest），不再自造一份引导 */
function buildViaWorker(dir, opts) {
  return buildManifest(dir, opts);
}

async function main() {
  const tree = makeTree();
  const LOCAL_ONLY = ["secret"];
  console.log(`沙箱树: ${tree}\n`);

  try {
    const expected = manifestCore.buildManifestSync(tree, { localOnly: LOCAL_ONLY });

    await T("V1a 排除项与隐私白名单均缺席（排除目录/后缀、永不上传项目）", () => {
      const keys = Object.keys(expected);
      assert.ok(keys.length > 0, "清单不应为空");
      assert.ok(!keys.some((k) => k.includes("projects/secret")), "永不上传项目必须缺席");
      assert.ok(!keys.some((k) => /(^|\/)(\.trash|index|node_modules)\//.test(k)), "排除目录缺席");
      assert.ok(!keys.some((k) => /\.bak$|\.tmp$/.test(k)), ".bak/.tmp 缺席");
      assert.ok(keys.some((k) => k.startsWith("projects/ok/")), "非白名单项目应正常收录");
    });

    await T("V1b 抽检哈希与直算一致", () => {
      const probe = Object.keys(expected)[0];
      const direct = crypto.createHash("sha256").update(fs.readFileSync(path.join(tree, probe))).digest("hex");
      assert.strictEqual(expected[probe].hash, direct, "抽检哈希应一致");
    });

    const probeW = gapProbe();
    const actual = await buildViaWorker(tree, { localOnly: LOCAL_ONLY });
    const gapWorker = probeW.stop();

    await T("V1c worker 版清单与同步版深比较一致", () => {
      assert.deepStrictEqual(actual, expected, "worker 版清单必须与同步版深比较一致");
    });

    await T("V2 worker 版事件循环卡顿不劣于同步版（基线足够大时要求显著更小）", async () => {
      const probeS = gapProbe();
      await new Promise((r) => setImmediate(r)); // 让心跳先跑起来
      manifestCore.buildManifestSync(tree, { localOnly: LOCAL_ONLY });
      const gapSync = probeS.stop();
      console.log(`      同步版最大卡顿 ${gapSync.maxGap}ms / worker 版 ${gapWorker.maxGap}ms`);
      // 比值判定只在「基线卡顿足够大」时才有意义：CI 快机器上冷热缓存差异会让同步版
      // 只阻塞十几毫秒（本地实测 194ms、CI 实测 22ms），此时比值随机性大。
      // 故：基线 >= 40ms 才要求显著更小（< 1/3）；否则退化为「不劣化」断言，
      // 仍能守住「清单构建不再占住主线程事件循环」这一核心语义。
      const BASELINE_MIN_MS = 40;
      if (gapSync.maxGap < BASELINE_MIN_MS) {
        assert.ok(
          gapWorker.maxGap <= gapSync.maxGap + 15,
          `基线卡顿过小（${gapSync.maxGap}ms < ${BASELINE_MIN_MS}ms），退化为不劣化断言：worker ${gapWorker.maxGap}ms 不应明显更大`
        );
        console.log(`      基线过小（<${BASELINE_MIN_MS}ms），退化为「不劣化」断言`);
      } else {
        assert.ok(
          gapWorker.maxGap < gapSync.maxGap / 3,
          `worker 版应显著更小（同步 ${gapSync.maxGap}ms / worker ${gapWorker.maxGap}ms）`
        );
      }
    });

    await T("V3 读不到的文件不得以空哈希条目进清单（与旧版跳过语义一致）", () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "mf-unreadable-"));
      try {
        fs.writeFileSync(path.join(d, "ok.md"), "hello");
        fs.mkdirSync(path.join(d, "weird.md")); // 列得出来但 readFileSync 失败（目录冒充文件）
        const m = manifestCore.buildManifestSync(d, {});
        assert.ok(m["ok.md"], "正常文件应收录");
        assert.ok(!("weird.md" in m), "读不到的文件必须整条缺席（不得进空哈希条目）");
        for (const [k, v] of Object.entries(m)) assert.strictEqual(v.hash.length, 64, `${k} 的哈希应为 64 位`);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    await T("V4 worker 引导用毕清理临时源码目录（%TEMP% 不留残骸）", async () => {
      const count = () => fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith("agenthub-manifest-")).length;
      const before = count();
      await buildViaWorker(tree, { localOnly: LOCAL_ONLY });
      await new Promise((r) => setTimeout(r, 300)); // 等 worker 线程 finally 跑完
      assert.strictEqual(count(), before, "不应新增 agenthub-manifest-* 残留目录");
    });

    await T("V5 docstring 不得声称未实现的让出行为", () => {
      const src = fs.readFileSync(SYNC, "utf8");
      assert.ok(!/每 40 个文件让出一轮/.test(src), "不应声称未实现的让出");
      assert.ok(!/async 化 \+ 周期性让出/.test(src), "不应以「周期性让出」作为已实现特性宣称");
    });
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
  console.log("[OK] 清单构建 worker 化自测全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
