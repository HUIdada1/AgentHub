/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 原子写中转名自测：固定 .tmp 名在双写入者下会互相搬走对方的中转文件，统一改成 `.tmp.<pid>`
// 运行：node scripts/test-atomic-tmp-pid.cjs
// 全部落在临时目录里，不碰 ~/.agent_skills、不碰用户配置。
//
// 三段机制证据的分工（第 ①② 段是确定性交错，第 ③ 段是真双进程）：
//   ①② 由本进程按「A 写中转 → B 写中转 → A rename → B rename」这个顺序逐步执行，不靠调度运气，
//      把两种伤害分别钉死：固定名时 A 的中转文件在 rename 之前就被 B 覆盖掉（A 的 rename 照样成功，
//      落盘的却是 B 的数据，A 以为自己的设置保存了）；带 pid 时各写各的、两次 rename 都成功。
//   ③ 再上两个真进程会合后同刻 rename，证明这条顺序在跨进程下确实会发生。这段允许抖动：本机杀软
//      给刚写完的文件留的句柄没有 FILE_SHARE_DELETE，单次 renameSync 偶发 EPERM/EBUSY 而非 ENOENT，
//      所以判据只看「固定名时没能双双成功」「带 pid 时至少一次双双成功」，具体错误码打印出来给人看。
//
// 为什么这是缺陷而不是洁癖：本仓的原子写形态都是「写 tmp → rename 覆盖目标」。两个写入者
// （dev 实例与安装版并存是官方支持的，见 main.cjs 的 AGENTHUB_ALLOW_MULTI 旁路；备份目录与
// ~/.agent_skills、~/.Dosage_sync 都不受该旁路隔离）同刻写同一目标时，固定 tmp 名会让
// A 的 rename 把 B 正在写的那份 .tmp 搬走：B 随后 renameSync 报 ENOENT，或者更糟——
// B 把自己看到的“半成品”当成完整文件收走。
//
// 基线上的实际分布：electron/backend 下这种「写 tmp 再 rename」的原子写共 18 处，其中 8 处本来就
// 带 pid（memory/config.cjs、memory/store.cjs、synonyms.cjs、inject.cjs 用 `.tmp.${pid}`，
// proxy/ideswitch.cjs 两处用 `.tmp-${pid}`，raccoonAuth.cjs 用 `.agenthub-${pid}.tmp`，
// zcodeLocal.cjs 用 `.agenthub-tmp-${pid}`），剩下 10 处用固定名——本 PR 补齐这 10 处，
// 统一成本仓最常见的那个写法。两处清扫过滤（memory/manifest-core.cjs 的 /\.tmp(\.\d+)?$/、
// memory/sync.cjs 的 /\.tmp\.\d+$/）本来就认这个后缀，不需要跟着改。
// 判据只要求「中转名带 pid」，不强迫后缀形状统一：仓里已经有四种写法，都算对。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-atomic-tmp-"));

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

function attempt(fn) {
  try { fn(); return { ok: true, err: "" }; }
  catch (e) { return { ok: false, err: String(e.code || e.message) }; }
}

/**
 * 确定性交错：两个写入者各自的 payload，按 tag 顺序写中转文件，再按 tag 顺序 rename。
 * 固定名时 tmpOf("A") === tmpOf("B")，B 的写入会覆盖 A 已写好的中转文件。
 */
function interleaved(mode) {
  const dir = fs.mkdtempSync(path.join(TMP, `det-${mode}-`));
  const target = path.join(dir, "out.json");
  const tmpOf = (tag) => (mode === "pid" ? `${target}.tmp.${tag}` : `${target}.tmp`);
  const payload = (tag) => JSON.stringify({ tag, body: tag.repeat(2000) });
  fs.writeFileSync(tmpOf("A"), payload("A"));
  // A 写完先确认自己的中转文件里确实是 A 的数据（后面被打动时，这个读回点就是证据）
  const aBefore = JSON.parse(fs.readFileSync(tmpOf("A"), "utf8")).tag;
  fs.writeFileSync(tmpOf("B"), payload("B"));
  const aSeen = JSON.parse(fs.readFileSync(tmpOf("A"), "utf8")).tag; // 与 tmpOf("B") 同路径时读到的是 B
  const ra = attempt(() => fs.renameSync(tmpOf("A"), target));
  const rb = attempt(() => fs.renameSync(tmpOf("B"), target));
  let final = null;
  try { final = JSON.parse(fs.readFileSync(target, "utf8")); } catch { final = null; }
  const stray = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  return { dir, target, aBefore, aSeen, ra, rb, final, stray, sameTmp: tmpOf("A") === tmpOf("B") };
}

// 子进程脚本（纯 ASCII，避免中文经命令行转码）：
//   1) 写 tmp（大 payload，制造可观测的写入窗口）
//   2) 立自己的 written 标记
//   3) 等另一个进程的 written 标记出现（会合，保证两次 rename 的先后不再靠运气）
//   4) rename tmp → target，把结果与异常写回自己的 result 文件
const CHILD = `
const fs = require("node:fs");
const path = require("node:path");
const [dir, tag, mode, other] = process.argv.slice(2);
const target = path.join(dir, "out.json");
const tmp = mode === "pid" ? target + ".tmp." + process.pid : target + ".tmp";
let res = { tag: tag, ok: false, err: "" };
try {
  fs.writeFileSync(tmp, JSON.stringify({ tag: tag, body: tag.repeat(20000) }));
  fs.writeFileSync(path.join(dir, "written." + tag), "x");
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(path.join(dir, "written." + other)) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
  fs.renameSync(tmp, target);
  res.ok = true;
} catch (e) {
  res.err = String(e.code || e.message);
}
fs.writeFileSync(path.join(dir, "result." + tag), JSON.stringify(res));
`;
fs.writeFileSync(path.join(TMP, "child.cjs"), CHILD, "utf8");

function runChild(dir, tag, mode, other) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(TMP, "child.cjs"), dir, tag, mode, other], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code));
  });
}

/** 两个子进程会合后同刻 rename：返回两份 result 与最终落盘内容 */
async function race(mode) {
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`));
  await Promise.all([runChild(dir, "A", mode, "B"), runChild(dir, "B", mode, "A")]);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const a = read("result.A");
  const b = read("result.B");
  let final = null;
  try { final = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8")); } catch { final = null; }
  return { a, b, final, bothOk: !!(a && a.ok && b && b.ok) };
}

(async () => {
  // ===== ① 固定中转名：确定性交错，两种伤害分别钉死 =====
  const det = interleaved("fixed");
  ok(det.sameTmp, `① 固定名时两个写入者的中转路径本来就是同一个（实测 tmpOf(A)===tmpOf(B) 为 ${det.sameTmp}）`);
  ok(det.aBefore === "A", `① A 写完自己的中转文件时读回的是 A（实测 ${det.aBefore}）——下面的覆盖不是装置读错路径`);
  ok(det.aSeen === "B",
    `① B 写同一个中转名，把 A 已经写好的数据整个换掉了（实测 A 的路径上现在读回 ${det.aSeen}）：A 的这次保存已经丢了`);
  ok(det.ra.ok === true,
    `① A 的 renameSync 照样“成功”（实测 ${JSON.stringify(det.ra)}）——它以为自己的设置落盘了，这才是最难发现的一半`);
  ok(det.rb.ok === false && det.rb.err === "ENOENT",
    `① B 随后 renameSync 报 ENOENT（实测 ${JSON.stringify(det.rb)}）：它写好的中转文件已被 A 搬走`);
  ok(det.final && det.final.tag === "B" && det.final.body.length === 2000 && det.final.body[0] === "B",
    `① 最终落盘的是 B 的完整内容（实测 tag=${det.final && det.final.tag}）：目标文件没坏，坏的是 A 的那次写入`);
  ok(det.stray.length === 0, `① 收尾不残留中转文件（实测残留 ${JSON.stringify(det.stray)}）`);

  // ===== ② 带 pid 的中转名：同一套交错必须两个写入者都不互踩 =====
  const detPid = interleaved("pid");
  ok(detPid.sameTmp === false, `② 带 pid 时两个中转路径不同（实测相同为 ${detPid.sameTmp}）`);
  ok(detPid.aSeen === "A",
    `② B 写自己那份中转名之后，A 的路径上读回的仍是 A（实测 ${detPid.aSeen}）：两次写入互不覆盖`);
  ok(detPid.ra.ok && detPid.rb.ok,
    `② 两次 rename 都成功（实测 A=${JSON.stringify(detPid.ra)} B=${JSON.stringify(detPid.rb)}）`);
  ok(detPid.final && (detPid.final.tag === "A" || detPid.final.tag === "B")
    && detPid.final.body.length === 2000 && detPid.final.body[0] === detPid.final.tag,
    `② 目标文件是某一个写入者的**完整**内容，不是两份交织的半截（实测 tag=${detPid.final && detPid.final.tag}）`);
  ok(detPid.stray.length === 0, `② 收尾不残留中转文件（实测残留 ${JSON.stringify(detPid.stray)}）`);

  // ===== ③ 真双进程会合后同刻 rename：证明上面那个顺序在跨进程下确实会发生 =====
  // 这段判据只看「能不能双双成功」，不钉具体错误码：本机杀软给刚写完的文件留的句柄没有
  // FILE_SHARE_DELETE，单次 renameSync 偶发 EPERM/EBUSY 而非 ENOENT，钉死码会让门禁随机发红。
  // 每次的原始结果与落盘 tag 都打印出来，ENOENT 有没有出现过由人看，不由判据猜。
  let fixedS = false, pidS = false, sawEnoent = false;
  for (let i = 0; i < 3 && !fixedS; i++) {
    const r = await race("fixed");
    const oks = [r.a && r.a.ok, r.b && r.b.ok].filter(Boolean).length;
    if ((r.a && r.a.err === "ENOENT") || (r.b && r.b.err === "ENOENT")) sawEnoent = true;
    console.log(`  · 双进程 固定名 第 ${i + 1} 次：A=${JSON.stringify(r.a)} B=${JSON.stringify(r.b)}（成功 ${oks} 个）`);
    if (r.a && r.b && !r.bothOk) fixedS = true;
  }
  ok(fixedS, "③ 双进程固定名：至少一次没能双双成功（三次都双双成功＝会合没生效，这段演示就只是空转）");

  let pidFinalWhole = false;
  for (let i = 0; i < 3 && !pidS; i++) {
    const r = await race("pid");
    console.log(`  · 双进程 带 pid 第 ${i + 1} 次：A=${JSON.stringify(r.a)} B=${JSON.stringify(r.b)} 落盘 tag=${r.final && r.final.tag}`);
    if (r.bothOk) { pidS = true; pidFinalWhole = !!(r.final && r.final.body.length === 20000); }
  }
  ok(pidS, "③ 双进程带 pid：至少一次两个写入者都成功（三次都不成＝这次改动没解除互踩，只是换了个错）");
  ok(pidFinalWhole, "③ 双进程带 pid 且双双成功的那次，落盘内容是完整的（不是两份交织的半截）");
  if (sawEnoent) console.log("  · 双进程固定名下实测出现过 renameSync ENOENT（中转文件被对方整个搬走）");

  // ===== ④ 全仓扫描：原子写形态里不得再留固定中转名（先报命中数，零命中即判红） =====
  {
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".cjs")) files.push(p);
      }
    })(path.join(__dirname, "..", "electron", "backend"));

    const sites = [];
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // 只认「同一个 tmp 变量既 writeFileSync 又被 renameSync」这个形态：remotesync.cjs 的
      // .remote-tmp 是下载目录（不是 rename 源），不该被算进来
      for (const m of src.matchAll(/const tmp = ([^;\n]+);/g)) {
        const after = src.slice(m.index, m.index + 600);
        if (/writeFileSync\(\s*tmp\b/.test(after) && /renameSync\(\s*tmp\b/.test(after)) {
          sites.push({ file: path.relative(path.join(__dirname, ".."), f), expr: m[1].trim() });
          if (!/process\.pid/.test(m[1])) bad.push(`${path.relative(path.join(__dirname, ".."), f)} → ${m[1].trim()}`);
        }
      }
    }
    ok(sites.length >= 14, `④ 扫到 ${sites.length} 处「写 tmp 再 rename」的原子写（少于 14 说明扫描本身失效，判据会假绿）`);
    ok(bad.length === 0, `④ 其中不带 pid 的还剩 ${bad.length} 处${bad.length ? "：" + bad.join(" ; ") : ""}`);
  }

  // ===== ⑤ 这 10 处逐点钉（语句锚点切不到即判红，不让「整体看着改了」蒙过去） =====
  {
    const root = path.join(__dirname, "..");
    const expect = [
      ["electron/backend/config.cjs", "设置落盘"],
      ["electron/backend/hub.cjs", "中央仓库台账（两个安装共享 ~/.agent_skills）"],
      ["electron/backend/sync-config.cjs", "用量同步配置（~/.Dosage_sync，不受多实例隔离）"],
      ["electron/backend/sync.cjs", "备份压缩包（目录用户可自定义）"],
      ["electron/backend/window-state.cjs", "窗口状态"],
      ["electron/backend/memory/httpapi.cjs", "本地 API 运行信息"],
      ["electron/backend/memory/index.cjs", "报告 md"],
      ["electron/backend/proxy/ideswitch.cjs", "WorkBuddy 登录文件"],
      ["electron/backend/proxy/qoderAuth.cjs", "Qoder 桌面登录文件"],
      ["electron/backend/proxy/qoderSigner.cjs", "签名器缓存"],
    ];
    // 期望的那一句用字符串拼接出来，不写正则：转义层数一多，判据自己先错
    const baseOf = {
      "electron/backend/config.cjs": "p", "electron/backend/hub.cjs": "p",
      "electron/backend/sync-config.cjs": "p", "electron/backend/sync.cjs": "target",
      "electron/backend/window-state.cjs": "p", "electron/backend/memory/httpapi.cjs": "this.runtimeFile",
      "electron/backend/memory/index.cjs": "file", "electron/backend/proxy/ideswitch.cjs": "file",
      "electron/backend/proxy/qoderAuth.cjs": "p.authFile", "electron/backend/proxy/qoderSigner.cjs": "out",
    };
    for (const [rel, label] of expect) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      if (rel.endsWith("qoderSigner.cjs")) {
        ok(src.includes("const tmp = `${out}.tmp.${process.pid}.mjs`"), `⑤ ${rel}（${label}）必须保留动态模块扩展名并带进程号`);
        continue;
      }
      const mid = rel.endsWith("qoderAuth.cjs") ? "}.agenthub.tmp.${" : "}.tmp.${";
      const want = "const tmp = `${" + baseOf[rel] + mid + "process.pid}`";
      ok(src.includes(want), `⑤ ${rel}（${label}）必须写成 ${want}`);
    }
    // 正对照的反面：本仓原有的四处不能被这次改动弄坏
    for (const rel of ["electron/backend/memory/config.cjs", "electron/backend/memory/synonyms.cjs",
      "electron/backend/memory/inject.cjs", "electron/backend/memory/store.cjs"]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      ok(/\.tmp\.\$\{process\.pid\}/.test(src), `⑤ ${rel} 原本就带 pid 的那处不能被改回去`);
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用不影响结论 */ }
  console.log(`\n${failed ? "FAIL" : "OK"} 原子写中转名自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`\nFAIL 自测异常中断：${(e && e.stack) || e}`);
  process.exit(1);
});
