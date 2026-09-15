// 把「用量记录同步」的 global.css 转换为 AgentHub 的 styles/sync.css：
// 1. 全部规则作用域化到 .sync-scope（框架样式零影响，模块界面与原应用一致）
// 2. 主题变量块改为引用框架 token（accent/文本/背景随框架主题色与明暗切换）
// 3. 丢弃原应用的页面壳样式（body/滚动条/侧栏/主列布局），只留组件级样式
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SRC = String.raw`E:\idea work\用量记录同步\src\styles\global.css`;
const DST = path.join(__dirname, "..", "src", "styles", "sync.css");

const css = fs.readFileSync(SRC, "utf8");

/** 框架已定义、直接继承的变量（不重复定义，框架主题色/文本色自然生效） */
const INHERIT_VARS = new Set(["--bg", "--text", "--text-2", "--text-3", "--accent", "--accent-strong", "--warn", "--glass-shadow"]);

/** 主题变量映射：用量同步变量 → 框架 token（不存在的一对一给值） */
const VAR_MAP = {
  "--accent-2": "var(--accent)",
  "--accent-soft": "var(--accent-dim)",
  "--accent-soft-2": "var(--accent-dim)",
  "--accent-soft-3": "var(--accent-line)",
  "--border": "var(--line)",
  "--border-strong": "var(--line-strong)",
  "--surface": "var(--panel)",
  "--surface-2": "var(--bg-soft)",
  "--surface-3": "var(--code-bg)",
  "--ok": "var(--accent)",
  "--err": "var(--danger)",
  "--grid": "var(--grid-dot)",
  "--scroll": "var(--text-3)",
  "--shadow": "none",
  "--shadow-lg": "0 14px 44px rgba(0, 0, 0, 0.5)",
  "--glow": "none",
  "--btn-sync-glow": "0 6px 18px var(--accent-dim)",
  "--ambient": "none",
  "--focus-ring": "0 0 0 3px var(--accent-dim)",
  "--sheen": "var(--glass-sheen)",
  "--sheen-sweep": "var(--glass-sheen)",
  "--sheen-line": "var(--accent-line)",
  "--glass-bg": "var(--glass-a)",
  "--glass-bg-strong": "var(--glass-b)",
  "--glass-border": "var(--glass-bd)",
  "--glass-highlight": "var(--glass-hi)",
  "--glass-glow": "none",
  "--glass-glow-strong": "none",
};

/** 解析变量声明块（:root, :root[data-theme="light"] 与 :root[data-theme="dark"]） */
function parseVarBlock(blockBody) {
  const vars = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(blockBody))) vars.set(m[1], m[2].trim());
  return vars;
}

/** 生成 .sync-scope 的变量定义（light 默认 + dark 覆盖，值统一映射到框架 token） */
function buildVarRules(lightBody, darkBody) {
  const light = parseVarBlock(lightBody);
  const dark = parseVarBlock(darkBody);
  const lightOut = [];
  const darkOut = [];
  for (const [name] of light) {
    if (INHERIT_VARS.has(name)) continue; // 继承框架
    const mapped = VAR_MAP[name];
    if (mapped) {
      lightOut.push(`  ${name}: ${mapped};`);
      continue;
    }
    lightOut.push(`  ${name}: ${light.get(name)};`);
  }
  for (const [name] of dark) {
    if (INHERIT_VARS.has(name) || VAR_MAP[name]) continue;
    const dv = dark.get(name);
    if (light.get(name) !== dv) darkOut.push(`  ${name}: ${dv};`);
  }
  return (
    `/* ===== 用量同步模块变量（作用域 .sync-scope；主题色/文本/背景继承框架 token，明暗随框架切换） ===== */\n` +
    `.sync-scope {\n${lightOut.join("\n")}\n}\n` +
    (darkOut.length ? `:root[data-theme="dark"] .sync-scope {\n${darkOut.join("\n")}\n}\n` : "")
  );
}

/** 简单 CSS 分块：返回顶层规则数组 [{selector, body, start, end}]，@media 递归一层。
 *  选择器起始位置会跳过前导注释与空白（否则注释会被拼进选择器） */
function splitTopLevel(src) {
  const rules = [];
  let i = 0;
  const n = src.length;
  let cur = "";
  let curStart = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "{") {
      // 找配对 }
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      // 选择器去掉前导注释/空白：从 curStart 起跳过所有 /* ... */ 与空白
      let selStart = curStart;
      const full = src.slice(curStart, i);
      const stripped = full.replace(/^(\s|\/\*[^]*?\*\/)*/, "");
      selStart = i - stripped.length;
      rules.push({ selector: stripped.trim(), body: src.slice(i + 1, j - 1), start: selStart, end: j });
      cur = "";
      i = j;
      curStart = j;
    } else {
      cur += ch;
      i++;
    }
  }
  return rules;
}

/** 选择器加 .sync-scope 前缀（逗号分组逐个加）；:root 变体转为 :root[x] .sync-scope */
function scopeSelector(sel) {
  return sel
    .split(",")
    .map((part) => {
      const p = part.trim();
      if (!p) return p;
      if (p === ":root") return ".sync-scope";
      const m = p.match(/^:root(\[data-theme="(?:light|dark)"\])$/);
      if (m) return `:root${m[1]} .sync-scope`;
      return `.sync-scope ${p}`;
    })
    .join(",\n");
}

/** 该规则是否丢弃（原应用页面壳/框架已有的全局元素样式） */
const DROP_EXACT = new Set(["*", "html,\nbody,\n#app", "body", "button", ":focus-visible", "::selection"]);
function shouldDrop(sel) {
  const flat = sel.replace(/\s+/g, " ");
  if (flat === "*" || flat === "html, body, #app" || flat === "body" || flat === "button" || flat === ":focus-visible" || flat === "::selection") return true;
  if (/^body::(before|after)$/.test(flat)) return true;
  if (/^::-webkit-scrollbar/.test(flat)) return true;
  // 原应用自身布局壳：侧栏 / 主列 / 内容区 / 顶层网格（AgentHub 有自己的壳）
  if (/^\.(app-shell|sidebar|main-col|content)\b/.test(flat)) return true;
  return false;
}

function transformBody(body) {
  // @media 嵌套：递归处理其中的规则
  const inner = splitTopLevel(body);
  // 若 body 里没有 { 嵌套（普通声明块），直接返回
  if (!/\{/.test(body)) return body;
  let out = "";
  // 用 splitTopLevel 切 inner 规则（body 作为顶层）
  let rest = body;
  let result = "";
  const sub = splitTopLevel(body);
  let lastEnd = 0;
  // 简化：逐条重建（声明块里不会命中 shouldDrop）
  const pieces = [];
  let cursor = 0;
  for (const r of sub) {
    const pre = body.slice(cursor, r.start);
    cursor = r.end;
    if (r.selector.startsWith("@keyframes")) {
      pieces.push(pre + r.selector + "{" + r.body + "}");
      continue;
    }
    if (r.selector.startsWith("@")) {
      pieces.push(pre + r.selector + "{" + transformBody(r.body) + "}");
      continue;
    }
    if (shouldDrop(r.selector)) {
      pieces.push(pre.replace(/\/\*[^]*?\*\//g, (x) => x)); // 保留注释
      continue;
    }
    pieces.push(pre + scopeSelector(r.selector) + " {" + r.body + "}");
  }
  pieces.push(body.slice(cursor));
  return pieces.join("");
}

function main() {
  // 1. 提取两个变量块
  const lightMatch = css.match(/:root,\s*\n:root\[data-theme="light"\]\s*\{([^]*?)\n\}/);
  const darkMatch = css.match(/:root\[data-theme="dark"\]\s*\{([^]*?)\n\}/);
  if (!lightMatch || !darkMatch) throw new Error("变量块未匹配到");
  const varRules = buildVarRules(lightMatch[1], darkMatch[1]);

  // 2. 跳过变量块，处理其余规则
  const afterVars = css.slice(css.indexOf(darkMatch[0]) + darkMatch[0].length);
  const rules = splitTopLevel(afterVars);
  const out = [];
  let cursor = 0;
  for (const r of rules) {
    const pre = afterVars.slice(cursor, r.start);
    cursor = r.end;
    const sel = r.selector.trim();
    if (!sel) {
      out.push(pre);
      continue;
    }
    if (sel.startsWith("@keyframes")) {
      out.push(pre + sel + " {" + r.body + "}");
      continue;
    }
    if (sel.startsWith("@media") || sel.startsWith("@supports")) {
      out.push(pre + sel + " {" + transformBody(r.body) + "}");
      continue;
    }
    if (shouldDrop(sel)) {
      // 保留规则前的注释，丢规则本体
      out.push(pre);
      continue;
    }
    out.push(pre + scopeSelector(sel) + " {" + r.body + "}");
  }
  out.push(afterVars.slice(cursor));

  const header = `/* ===== 用量同步模块样式（原「用量记录同步」global.css，脚本转换生成，勿手改）=====
   作用域：全部规则限定 .sync-scope 内生效，框架与其它模块零影响；
   主题：accent / 文本 / 背景继承框架 token（页面展示形式与原应用一致，仅主题色跟随框架）。
   页面壳（body/侧栏/滚动条等）与框架重复的全局样式已剔除。 */\n\n`;

  fs.writeFileSync(DST, header + varRules + out.join(""), "utf8");
  console.log("sync.css 生成完成，行数:", fs.readFileSync(DST, "utf8").split("\n").length);
}

main();
