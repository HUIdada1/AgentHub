/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 主题令牌生成物（electron/backend/theme-tokens.json）的漂移检查。
// 纯读盘 + 纯函数，不联网、不启动 Electron。
//
// 为什么要有这条：令牌表是**生成物**，但生成脚本不会在每次 build 时自动跑。
// 有人改了 src/styles/global.css 的色板却忘了重跑生成脚本时，插件界面会继续用旧色板
// —— 这种漂移肉眼极难发现（两个窗口要并排看才知道色号不一致），必须由测试钉死。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const gen = require("../tools/gen-theme-tokens.cjs");

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fails.push(name);
}

const ROOT = path.join(__dirname, "..");
const DST = path.join(ROOT, "electron", "backend", "theme-tokens.json");

// ===== 1. 生成物存在且是合法 JSON =====
ok("生成物存在", fs.existsSync(DST));
let committed = null;
try {
  committed = JSON.parse(fs.readFileSync(DST, "utf8"));
  pass++;
} catch (e) {
  fails.push(`生成物不是合法 JSON：${(e && e.message) || e}`);
}

// ===== 2. 与 global.css 当前内容一致（漂移检查的核心）=====
const fresh = gen.build();
if (committed) {
  const sameDark = JSON.stringify(committed.dark) === JSON.stringify(fresh.dark);
  const sameLight = JSON.stringify(committed.light) === JSON.stringify(fresh.light);
  ok("暗色令牌表与 global.css 一致（未漂移）", sameDark);
  ok("亮色令牌表与 global.css 一致（未漂移）", sameLight);
  if (!sameDark || !sameLight) {
    const a = sameDark ? committed.light : committed.dark;
    const b = sameDark ? fresh.light : fresh.dark;
    const diff = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] !== b[k]) diff.push(`${k}: 生成物=${a[k]} 现状=${b[k]}`);
    }
    fails.push(`  漂移明细（跑 node tools/gen-theme-tokens.cjs 重新生成）：\n      ${diff.slice(0, 12).join("\n      ") || "（键集不同）"}`);
  }
}

// ===== 3. 表本身的质量 =====
const dark = fresh.dark || {};
const light = fresh.light || {};
ok("暗色表非空", Object.keys(dark).length > 0);
ok("亮色表非空", Object.keys(light).length > 0);
ok("暗色/亮色键集一致（亮色是覆盖集合并后的完整表）",
  JSON.stringify(Object.keys(dark)) === JSON.stringify(Object.keys(light)));
ok("每个键都是 -- 开头", Object.keys(dark).every((k) => k.startsWith("--")));
ok("每个值都是非空字符串", Object.values(dark).every((v) => typeof v === "string" && v.trim() !== ""));
ok("含 --bg（插件窗口底色靠它）", typeof dark["--bg"] === "string" && dark["--bg"].trim() !== "");
ok("亮暗两套的 --bg 确实不同", dark["--bg"] !== light["--bg"]);
ok("含 --accent", typeof dark["--accent"] === "string" && typeof light["--accent"] === "string");

// ===== 4. 消费侧不倒退：plugin-host 不能再用写死的暗色底 =====
const hostSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "plugin-host.cjs"), "utf8");
ok("plugin-host 不再写死暗色 backgroundColor", !/backgroundColor:\s*"#0a0c0f"/.test(hostSrc));
ok("plugin-host 从生成物取底色", /themeBackground\(\)/.test(hostSrc));
ok("plugin-host 注入主题令牌", /insertCSS\(/.test(hostSrc));

// ===== 5. 解析器自身的边界 =====
ok("blockAfter 找不到选择器时返回空串", gen.blockAfter("a{}", ":root {") === "");
ok("blockAfter 缺右括号时返回空串", gen.blockAfter(":root { --a: 1;", ":root {") === "");
{
  const vars = gen.parseVars("--a: 1;\n/* --b: 2; */\n--c: 3;\n不是变量: 4;\n");
  ok("parseVars 只取 -- 开头", vars.size === 2 && vars.has("--a") && vars.has("--c"));
  ok("parseVars 忽略注释里的声明", !vars.has("--b"));
  ok("parseVars 保留书写顺序", [...vars.keys()].join(",") === "--a,--c");
}

// ===== 汇总 =====
if (fails.length) {
  console.error(`✗ 主题令牌检查：${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 主题令牌检查：${pass} 项全部通过（暗色 ${Object.keys(dark).length} 项 / 亮色 ${Object.keys(light).length} 项）`);
