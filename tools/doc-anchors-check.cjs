/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * 文档锚点自检（方案 v2 §八 阶段5 ⑨；蓝本 tmp/check-4f-anchors.cjs）。
 *
 * 它治的是这一类病：文档写着「见 plugin-updater.cjs:6 的顶层 require」，而代码早就把那行
 * 挪走/删掉 —— 读者按行号跳过去看到的是毫不相干的一行，比没写更坏。本轮已经实证三次
 * "我刚才看到的 ≠ 现在是这样"（闭包 253→261、命令表 296→297、compose 两行→十三行），
 * 所以行号引用必须**机器核对**，不能凭记忆写、也不能靠人记得改。
 *
 * 与蓝本的关键差别（这是提升为正式工具的意义）：
 *  蓝本是一张**硬编码断言表**（要验哪几行得手写进去），等于把"记得更新文档"换成
 *  "记得更新断言表"，一样会漏。这里改成**反向抽取**：扫文档，把里面每一处
 *  `路径:行号` / `路径:起-止` 自动找出来，逐条对磁盘核对。写文档的人不需要维护第二份清单。
 *  另保留一张 NAMED 表做更强的"这一行必须还含某个标识符"检查（蓝本的原能力，不丢）。
 *
 * 扫描范围**默认只含"活的说明书"**：gateway/README.md、根 README*.md、deploy/**\/*.md。
 * 故意**不扫** docs/docker-上线/ —— 那些是带日期的方案快照与评估证据集，行号是"当时的事实"，
 * 按设计就会随代码漂移；把它们纳入会让门禁永久红，而永久红的门禁等于没有门禁。
 * （要临时核对时用 --include 手动加。）
 *
 * 用法：node tools/doc-anchors-check.cjs [--quiet] [--include <相对路径>]...
 * 退出码：0 = 全部锚点成立；1 = 有失效锚点；2 = 环境错误（目录/文件读不到）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const QUIET = process.argv.includes("--quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };
const args = process.argv.slice(2);
const extraIncludes = args.reduce((acc, a, i) => (a === "--include" && args[i + 1] ? acc.concat(args[i + 1]) : acc), []);

const DEFAULT_TARGETS = [
  "gateway/README.md",
  "README.md",
  "README.en.md",
  "deploy/README.md",
  "deploy/compose.yml",
  "deploy/remote-access.md",
  "deploy/backup-restore.md",
  "deploy/upgrade.md",
  "deploy/nas-群晖.md",
  "deploy/caddy/Caddyfile",
];

/** 更强的一层：这些行的**内容**必须还含指定标识符（蓝本原能力，防止行号还在但语义已挪走）。
 *  只收录已被文档引用过、且一旦漂移会误导人的关键点；新增前先确认文档真的依赖它。
 *  `line: 0` 表示"全文存在该标识符即可"（不锁行号）—— 用于 `index.cjs` 这种
 *  **每个板块都在改的热点文件**：给它锁行号等于每交一个板块就要来修一次这张表，
 *  而修不及时就是 CI 假红（task-17 加了 4 行就把 :302/:303 顶到 :311/:312，实证过一次）。
 *  热点文件真正需要守的是"这条语义还在不在"，不是"还在不在第 303 行"。 */
const NAMED = [
  ["gateway/src/index.cjs", 0, "resumeEnabled"],
  ["gateway/src/index.cjs", 0, "Provider transport only"],
  ["electron/backend/plugin-updater.cjs", 9, "顶层 require"],
  ["electron/backend/extensions/package.cjs", 132, "verifyManifest"],
  ["electron/backend/extensions/manifest.cjs", 146, "platforms"],
  ["electron/backend/localgw/services.cjs", 15, "未就绪"],
  ["electron/backend/localgw/config.cjs", 716, "ensureSecret"],
];


/** 解析文档里的文件引用，返回**候选路径列表**（按可信度排序）。
 *  三种写法都要能认，否则会产出假失效（首跑就误报了 3 条）：
 *   ① 仓库根相对：`electron/backend/plugin-host.cjs:402` —— 直接命中；
 *   ② 裸文件名：`ipc.cjs:250` —— 上下文已给归属，按索引找；多个同名就逐个试，
 *      谁的行号能对上就用谁（`index.cjs:664` 这种必须靠"试"而不是猜，猜错就是假失效）；
 *   ③ 相对某层目录：`extensions/manifest.cjs:146`（真实路径是 electron/backend/extensions/…）
 *      —— 用后缀匹配。
 *  任何一种解析成功的，都仍会提示"建议写全路径"。 */
const INDEX_ROOTS = ["electron", "src", "gateway", "tools", "deploy", "scripts", ".github", "build"];
let allFiles = null;
function buildIndex() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel, depth + 1);
      else if (/\.(cjs|js|mjs|ts|vue|json|ya?ml|md|txt)$/i.test(e.name) || /Dockerfile|Caddyfile|\.env\.example$/.test(e.name)) out.push(rel);
    }
  };
  for (const r of INDEX_ROOTS) walk(r, 0);
  return out;
}
function candidatesFor(file) {
  if (!allFiles) allFiles = buildIndex();
  const clean = file.replace(/^\.\//, "");
  if (linesOf(clean) !== null) return { exact: true, list: [clean] };
  const base = path.basename(clean);
  const byName = allFiles.filter((p) => path.basename(p) === base);
  const norm = (s) => s.replace(/\\/g, "/");
  // 后缀匹配（含"目录/文件"这种半路径写法）
  const bySuffix = byName.filter((p) => norm(p).endsWith(norm(clean)));
  const list = bySuffix.length ? bySuffix : byName;
  return { exact: false, list, ambiguous: list.length > 1 };
}
const lineOf = (file) => {


  try { return fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/); } catch { return null; }
};
const lineCache = new Map();
const linesOf = (file) => {
  if (!lineCache.has(file)) lineCache.set(file, lineOf(file));
  return lineCache.get(file);
};

/** 从一段文本里抠锚点：`a/b.cjs:12`、`a/b.cjs:12-30`、`a/b.vue:8`，
 *  路径允许出现在反引号或裸文里；只认"像源码/配置"的后缀，避免把 deploy/data:1 之类误判。 */
const ANCHOR_RE = /([A-Za-z0-9_.\-/]+\.(?:cjs|js|mjs|ts|vue|json|md|yml|yaml|Dockerfile|Caddyfile|example))[:\s]*(\d{1,5})(?:\s*[-–~]\s*(\d{1,5}))?/g;
/** `gateway/Dockerfile` 这类无扩展名规律的文件名单独兜一下 */
const NAMED_FILE_RE = /((?:gateway|electron|src|tools|deploy|scripts)\/[A-Za-z0-9_./-]*Dockerfile)[:\s]*(\d{1,5})(?:\s*[-–~]\s*(\d{1,5}))?/g;

function extractAnchors(text, docFile) {
  const out = [];
  for (const re of [ANCHOR_RE, NAMED_FILE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const file = m[1].replace(/^\.\//, "");
      const from = Number(m[2]);
      const to = m[3] ? Number(m[3]) : from;
      if (!Number.isFinite(from) || from <= 0) continue;
      out.push({ doc: docFile, file, from, to, raw: m[0] });
    }
  }
  return out;
}

/** 自检：证明本工具**真的会红**，而不是永远绿的摆设。
 *  用合成文档跑同一套检查管线（不读磁盘上的真文档、不改任何产品文件）：
 *  四种失效必须全部被抓到，一条正常锚点必须不被误报。
 *  这是 task-8 立下的规矩在工具层的固化 —— 每条断言都要能负向验证。 */
function selfTest() {
  // 找一个真实存在的空白行来构造"指向空行"的失效锚点（凭印象挑行号会挑到非空行，
  // 我第一次试就是这么把用例做废的）
  const probeFile = "gateway/src/commands.cjs";
  const pl = linesOf(probeFile) || [];
  const blankAt = pl.findIndex((l, i) => i > 3 && !l.trim()) + 1;
  if (!blankAt || blankAt <= 0) { console.error("自检前置：找不到可对照的空白行"); return 1; }
  const cases = [
    { name: "行号越界", text: `见 ${probeFile}:99999`, wantBad: true },
    { name: "文件不存在", text: "见 electron/backend/__nope_ghost__.cjs:10", wantBad: true },
    { name: "指向空行", text: `见 ${probeFile}:${blankAt}`, wantBad: true },
    { name: "区间起止颠倒", text: `见 ${probeFile}:50-20`, wantBad: true },
    { name: "正常锚点不误报", text: `见 ${probeFile}:23`, wantBad: false },
  ];
  let wrong = 0;
  for (const c of cases) {
    const found = extractAnchors(c.text, "(self-test)");
    let bad = 0;
    for (const a of found) {
      const cand = candidatesFor(a.file);
      if (!cand.list.length) { bad++; continue; }
      if (a.to < a.from) { bad++; continue; }
      const fitted = cand.list.map((p) => ({ p, lines: linesOf(p) }))
        .find(({ lines }) => lines && a.to <= lines.length && String(lines[a.from - 1] || "").trim() !== "");
      if (!fitted) bad++;
    }
    if (found.length === 0) { console.error(`  ❌ 自检 ${c.name}：抽取器根本没抽出锚点，用例无效`); wrong++; continue; }
    const ok = c.wantBad ? bad > 0 : bad === 0;
    if (!ok) { console.error(`  ❌ 自检 ${c.name}：期望 ${c.wantBad ? "判红" : "判绿"}，实得 ${bad ? "判红" : "判绿"}`); wrong++; }
    else console.log(`  ✅ 自检 ${c.name} → ${c.wantBad ? "如期判红" : "如期不误报"}`);
  }
  // 存在性分支（line:0）也要有正反例：只锁行号的那类判据我已经栽过一次，
  // 新加一条判定路径却不验它，等于给自己留下一个"永远绿"的分支。
  const presence = (file, needle) => (linesOf(file) || []).some((l) => l.includes(needle));
  const pFile = "gateway/src/index.cjs";
  const okPresent = presence(pFile, "resumeEnabled");
  const okAbsent = !presence(pFile, "__definitely_not_a_real_symbol_zzz__");
  console.log(`  ${okPresent ? "✅" : "❌"} 自检 存在性判定：真实符号应判"在"`);
  console.log(`  ${okAbsent ? "✅" : "❌"} 自检 存在性判定：编造符号应判"不在"`);
  if (!okPresent || !okAbsent) wrong++;
  return { wrong, total: cases.length + 2 };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log("锚点自检工具的鉴别力验证：");
    const st = selfTest(); // 必须取对象：`cases` 在 selfTest 作用域里，main 里直接引用会 ReferenceError
    const w = st.wrong;
    console.log(w ? `\n❌ 自检未通过 ${w} 项：本工具的判定不可信` : `\n✅ 自检通过：${st.total} 类用例判定全部正确（含存在性判定的正反例）`);

    process.exit(w ? 1 : 0);
  }
  const targets = [...DEFAULT_TARGETS, ...extraIncludes].filter((rel) => {

    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return true;
    say(`  （跳过不存在的目标 ${rel}）`);
    return false;
  });
  if (!targets.length) { console.error("没有任何可扫的文档目标"); process.exit(2); }

  let anchors = [];
  for (const rel of targets) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const found = extractAnchors(text, rel);
    say(`  ${rel.padEnd(30)} 抽出 ${found.length} 处行号引用`);
    anchors = anchors.concat(found);
  }

  let bad = 0;
  const loosen = new Set();
  const seen = new Set();
  for (const a of anchors) {
    const key = `${a.doc}|${a.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.to < a.from) { console.error(`  ❌ ${a.doc} 引用了 ${a.raw} —— 行区间起止颠倒`); bad++; continue; }
    const cand = candidatesFor(a.file);
    if (!cand.list.length) { console.error(`  ❌ ${a.doc} 引用了 ${a.raw} —— 仓库里找不到这个文件名`); bad++; continue; }
    if (!cand.exact) loosen.add(`${a.file} → ${cand.list.join(" / ")}`);
    // 多个同名候选时，用"行号是否落在该文件内且该行非空"来选定；全都不满足才算失效
    const fitted = cand.list.map((p) => ({ p, lines: linesOf(p) })).find(({ lines }) =>
      lines && a.to <= lines.length && String(lines[a.from - 1] || "").trim() !== "");
    if (!fitted) {
      const detail = cand.list.map((p) => `${p}(${(linesOf(p) || []).length} 行)`).join(", ");
      console.error(`  ❌ ${a.doc} 引用了 ${a.raw} —— 所有候选文件都容不下这个行号：${detail}`);
      bad++; continue;
    }
  }
  for (const w of loosen) say(`  ⚠️ 引用不是仓库根相对路径，建议补全：${w}`);



  // NAMED 层：行号在，但内容必须还含关键字
  for (const [file, n, needle] of NAMED) {
    const lines = linesOf(file);
    if (!lines) { console.error(`  ❌ NAMED 锚点 ${file}:${n} 的文件不存在`); bad++; continue; }
    if (n === 0) {
      // 只要求"该标识符在文件里仍然存在"（热点文件不锁行号，见 NAMED 表上方说明）
      const present = lines.some((l) => l.includes(needle));
      if (!present) { console.error(`  ❌ NAMED（存在性）${file} 已找不到「${needle}」—— 语义被删或改名，引用它的文档要一起订正`); bad++; }
      continue;
    }
    const actual = (lines[n - 1] || "").trim();
    if (!actual.includes(needle)) {
      console.error(`  ❌ NAMED 锚点 ${file}:${n} 需含「${needle}」，实际是「${actual.slice(0, 90)}」`);
      bad++;
    }
  }


  say(`\n共核对 ${seen.size} 处文档锚点 + ${NAMED.length} 处具名锚点`);
  if (bad) { console.error(`❌ ${bad} 处失效：文档里的行号与磁盘不一致，必须订正文档（不是改代码去迁就文档）`); process.exit(1); }
  console.log("✅ 全部锚点与磁盘一致");
  process.exit(0);
}

main();
