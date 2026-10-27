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
// 从 src/styles/global.css 抽出主题令牌，产出 electron/backend/theme-tokens.json。
//
// ── 为什么要生成一份 ────────────────────────────────────────
// 插件界面是**独立文档**（独立 BrowserWindow / iframe），读不到主壳的 :root 变量。
// 宿主想把「同一套色板」给插件用，就得有一份能在主进程里直接读到的令牌表。
// 手抄一份必然漂移，所以从唯一事实源（global.css）生成。
//
// ── 口径 ────────────────────────────────────────────────────
// · 只取 `--*` 自定义属性，其它声明（color / background 等）不取；
// · dark 块是全集；light 块是**覆盖集**，这里直接合并成完整亮色表（消费方只需二选一）；
// · 值原样保留（含 `var(--x)` 形式的引用）—— 两份表都是完整的，引用能自己解析到；
// · 生成物必须保持**稳定顺序**（按 global.css 里的书写顺序），否则每次跑都产生假 diff。
//
// 用法：node tools/gen-theme-tokens.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "styles", "global.css");
const DST = path.join(ROOT, "electron", "backend", "theme-tokens.json");

/** 抽出 css 里第一个匹配 `selector {` 的声明块内容（不做嵌套括号解析：令牌块是平铺的） */
function blockAfter(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  if (open < 0) return "";
  const close = css.indexOf("}", open);
  if (close < 0) return "";
  return css.slice(open + 1, close);
}

/** 解析声明块里的 `--name: value;` 对，按书写顺序返回（重复名后者覆盖前者，位置取首次出现） */
function parseVars(block) {
  const out = new Map();
  for (const line of block.split("\n")) {
    // 去掉行注释后再匹配，避免注释里的 `--x: y` 被当成声明
    const clean = line.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!clean.startsWith("--")) continue;
    const m = /^(--[A-Za-z0-9_-]+)\s*:\s*(.+?);?\s*$/.exec(clean);
    if (!m) continue;
    const name = m[1];
    const value = m[2].trim().replace(/;$/, "").trim();
    if (!value) continue;
    if (out.has(name)) out.set(name, value);
    else out.set(name, value);
  }
  return out;
}

/** 生成令牌表（纯函数，供自测复用：不写盘、不读第二次） */
function build() {
  const css = fs.readFileSync(SRC, "utf8");
  const dark = parseVars(blockAfter(css, ":root {"));
  const lightOverrides = parseVars(blockAfter(css, ':root[data-theme="light"]'));
  // 亮色表 = 暗色全集 + 亮色覆盖（保持暗色的书写顺序，覆盖只改值、不插队）
  const light = new Map(dark);
  for (const [k, v] of lightOverrides) light.set(k, v);
  return {
    _copyright:
      "作者：沐晖 · 日期：2026-10-28 · 版权声明：本数据归沐晖所有。禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；禁止在未经本人授权的情况下直接搬运（含复制、转载、用于商业项目）。此声明禁止删除。",
    _comment:
      "由 tools/gen-theme-tokens.cjs 从 src/styles/global.css 生成，请勿手改（改了会在 npm test 的主题令牌漂移检查里失败）。用途：主进程把宿主的设计令牌注入插件窗口，让插件页面与主壳同一套色板 —— 插件界面是独立文档，读不到主壳的 :root 变量。light 是「暗色全集 + 亮色覆盖」合并后的完整表，消费方二选一即可。",
    generatedFrom: "src/styles/global.css",
    dark: Object.fromEntries(dark),
    light: Object.fromEntries(light),
  };
}

function main() {
  const data = build();
  const json = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(DST, json, "utf8");
  const n = Object.keys(data.dark).length;
  console.log(`✓ 主题令牌已生成：${path.relative(ROOT, DST)}（暗色 ${n} 项 / 亮色 ${Object.keys(data.light).length} 项）`);
}

if (require.main === module) main();

module.exports = { build, parseVars, blockAfter, SRC, DST };
