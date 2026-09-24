/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 前端 DOM 校验（无头，不截图）：把 dist 装进隐藏窗口，用真实点击/悬停断言：
//   ① 页签条不再有「模型与网关」；② 配置页存在该子板块且渲染出模型面板；
//   ③ 侧栏「记忆概况」是记忆专属行（不是反代网关的渠道行）；
//   ④ 每页都有小问号，悬停真的弹气泡且配色在亮/暗两套主题下都够读；
//   ⑤ 仪表盘含「模型调用统计」卡；全程无 JS 报错。
//
// 用法（必须用 Electron 本体跑，不能加 ELECTRON_RUN_AS_NODE）：
//   ./node_modules/electron/dist/electron.exe tools/memory-ui-check.cjs
//
// 实现约定：页面脚本一律以**真实函数**传入（page(fn, ...args) 内部 toString 后执行），
// 不再用内联模板字符串拼 JS —— 那种写法一旦出现嵌套反引号就会变成加载期语法错误，
// 而且报错位置在加载阶段、堆栈指向本文件，很难定位。
"use strict";

const path = require("path");

let app = null;
let BrowserWindow = null;
let electronModule = null;
try {
  electronModule = require("electron");
} catch {
  electronModule = null;
}
if (typeof electronModule === "string") {
  // 两种误用都会走到这里（require("electron") 只给出 exe 路径）：
  // ① 普通 Node 跑；② Electron 但带了 ELECTRON_RUN_AS_NODE —— 用 process.versions.electron 区分
  const inElectronRuntime = !!(process.versions && process.versions.electron);
  console.error(
    inElectronRuntime
      ? "检测到 ELECTRON_RUN_AS_NODE 模式：去掉该环境变量后重跑（本探针需要创建窗口）"
      : "本探针要真开窗口渲染 dist，必须用 Electron 本体跑：./node_modules/electron/dist/electron.exe tools/memory-ui-check.cjs",
  );
  process.exit(2);
}
if (electronModule && typeof electronModule === "object") {
  ({ app, BrowserWindow } = electronModule);
}
if (!app || !BrowserWindow) {
  console.error("检测到 ELECTRON_RUN_AS_NODE 模式：请去掉该环境变量后重跑（本探针需要创建窗口）");
  process.exit(2);
}

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 记忆仓库九个页签（PageTabs 的按钮不挂 data-page，按文字前缀定位）
const PAGES = [
  ["dashboard", "仪表盘"],
  ["browse", "记忆浏览"],
  ["projects", "项目归档"],
  ["profile", "深层画像"],
  ["agents", "Agent 接入"],
  ["index", "检索与索引"],
  ["auto", "自动化任务"],
  ["import", "导入与去重"],
  ["sync", "WebDAV 同步"],
];

async function main() {
  const indexFile = path.join(__dirname, "..", "dist", "index.html");
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: { contextIsolation: false, nodeIntegration: false, offscreen: true },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });

  await win.loadFile(indexFile);
  await sleep(2500);

  /** 在页面里执行一段真实函数（参数走 JSON 序列化） */
  const page = (fn, ...args) =>
    win.webContents.executeJavaScript(
      `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`,
      true,
    );

  console.log("[1] 记忆仓库页签（模型与网关应已并入配置页）");
  const switched = await page(() => {
    const mem = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("记忆仓库"));
    if (!mem) return false;
    mem.click();
    return true;
  });
  check("能切换到记忆仓库模块", switched === true);
  await sleep(1200);

  const pageTabs = await page(() => [...document.querySelectorAll(".tabs button.tab")].map((b) => b.textContent.trim()).filter(Boolean));
  check("页签条不再含「模型与网关」", Array.isArray(pageTabs) && !pageTabs.some((t) => t.includes("模型与网关")), JSON.stringify(pageTabs));
  check(
    "页签条仍含其余九页（记忆浏览 / WebDAV 同步）",
    Array.isArray(pageTabs) && pageTabs.some((t) => t.includes("记忆浏览")) && pageTabs.some((t) => t.includes("WebDAV")),
    JSON.stringify(pageTabs),
  );

  console.log("[2] 侧栏「记忆概况」（应显示记忆专属内容）");
  const sidebar = await page(() => {
    const head = document.querySelector(".side-overview .ov-title");
    const hint = document.querySelector(".side-overview .ov-hint");
    const rows = [...document.querySelectorAll(".side-overview .ov-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim());
    return { title: head ? head.textContent.trim() : "", hint: hint ? hint.textContent.trim() : "", rows };
  });
  check("概况标题为「记忆概况」", sidebar.title === "记忆概况", sidebar.title);
  check("概况提示显示条数", /条记忆/.test(sidebar.hint || ""), sidebar.hint);
  const joined = (sidebar.rows || []).join(" | ");
  check("出现记忆专属行（记忆总量 / 待处理 / 索引健康）", /记忆总量/.test(joined) && /待处理/.test(joined) && /索引健康/.test(joined), joined.slice(0, 220));
  check("不再显示反代网关渠道行", !/空号池|渠道/.test(joined), joined.slice(0, 160));

  console.log("[3] 各页小问号与提示气泡");
  const marks = {};
  for (const [id, label] of PAGES) {
    marks[id] = await page((labelText) => {
      const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith(labelText));
      if (!target) return -1;
      target.click();
      return new Promise((resolve) => setTimeout(() => resolve(document.querySelectorAll(".memory-scope .mem-qa").length), 700));
    }, label);
  }
  check("九页页签都能点到", Object.values(marks).every((n) => n >= 0), JSON.stringify(marks));
  check("每页至少 3 个小问号", Object.values(marks).every((n) => n >= 3), JSON.stringify(marks));

  const tip = await page(() => {
    const qa = document.querySelector(".memory-scope .mem-qa");
    if (!qa) return { ok: false, reason: "no-q-mark" };
    qa.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    qa.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => {
      const popper = document.querySelector(".el-popper.glass-popper");
      if (!popper) return resolve({ ok: false, reason: "no-popper" });
      const cs = getComputedStyle(popper);
      const body = popper.querySelector(".mem-tip-body");
      const bcs = body ? getComputedStyle(body) : null;
      resolve({
        ok: true,
        className: popper.className,
        color: cs.color,
        background: cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 40) : cs.backgroundColor,
        lineHeight: bcs ? bcs.lineHeight : "",
        text: popper.textContent.trim().slice(0, 40),
      });
    }, 900));
  });
  check("悬停弹出提示气泡", tip.ok === true, JSON.stringify(tip));
  if (tip.ok) {
    check("气泡带 mem-tip 类（宽度/排版受控）", String(tip.className).includes("mem-tip"), tip.className);
    check("气泡文字色非透明且非纯黑默认值", !!tip.color && tip.color !== "rgb(0, 0, 0)" && !/rgba\(0, 0, 0, 0\)/.test(tip.color), tip.color);
    check("气泡有毛玻璃背景", !!tip.background && tip.background !== "none", tip.background);
    check("气泡正文行高 ≈1.7（可读性）", /1\.7|2\d(\.\d+)?px/.test(String(tip.lineHeight)), tip.lineHeight);
    check("气泡有实际文案", (tip.text || "").length > 6, tip.text);
  }

  console.log("[4] 配置页：模型与网关是常驻区块（不再有那个子页签按钮）");
  const cfg = await page(() => {
    const btn = document.querySelector(".tabs button.tab-config");
    if (!btn) return { ok: false, reason: "no-config-button" };
    btn.click();
    return new Promise((resolve) => setTimeout(() => {
      const subtabs = [...document.querySelectorAll(".cfg-subtabs .cfg-subtab")].map((b) => b.textContent.trim());
      const body = document.querySelector(".cfg-body");
      const titles = [...document.querySelectorAll(".cfg-body .mem-card-title")].map((t) => t.textContent.trim()).join(" | ");
      // 首屏区块：模型面板的「添加供应商」按钮在打开配置页后应当已经可见（无需再点页签）
      const addProvider = [...document.querySelectorAll(".cfg-body button")].some((b) => b.textContent.includes("添加供应商"));
      // 开关形态：模块内布尔开关都应是 el-switch 胶囊，且没有裸勾选框
      const scopes = document.querySelectorAll(".memory-scope");
      let switches = 0;
      let rawChecks = 0;
      scopes.forEach((sc) => {
        switches += sc.querySelectorAll(".el-switch").length;
        rawChecks += sc.querySelectorAll('input[type="checkbox"]:not(.el-switch__input):not(.el-checkbox__original)').length;
      });
      resolve({ ok: true, subtabs, titles: titles.slice(0, 240), addProvider, switches, rawChecks, hasBody: !!body });
    }, 1200));
  });
  check("配置页子页签条不含「模型与网关」", cfg.ok === true && Array.isArray(cfg.subtabs) && !cfg.subtabs.some((t) => t.includes("模型与网关")), JSON.stringify(cfg.subtabs));
  check("配置页子页签仍有各分组（存储 / 索引 / 检索…）", cfg.ok === true && cfg.subtabs.length > 4, JSON.stringify(cfg.subtabs));
  if (cfg.ok) {
    check("模型面板常驻首屏（无需点页签即可见「添加供应商」）", cfg.addProvider === true, JSON.stringify({ titles: cfg.titles }));
    check("模型区块标题在配置页存在", /模型与网关/.test(cfg.titles), cfg.titles);
    check("页面至少有一个胶囊开关（el-switch）", cfg.switches > 0, `el-switch=${cfg.switches}`);
    check("模块内没有裸勾选框（EP 组件内部 input 除外）", cfg.rawChecks === 0, `raw=${cfg.rawChecks}`);
  }

  console.log("[4b] 自动化任务的开关形态（用量统计同款胶囊）");
  const autoSw = await page(() => {
    const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith("自动化任务"));
    if (target) target.click();
    return new Promise((resolve) => setTimeout(() => {
      const scopes = [...document.querySelectorAll(".memory-scope")].filter((sc) => sc.offsetParent !== null || sc.getClientRects().length);
      let switches = 0;
      let rawChecks = 0;
      scopes.forEach((sc) => {
        switches += sc.querySelectorAll(".el-switch").length;
        rawChecks += sc.querySelectorAll('input[type="checkbox"]:not(.el-switch__input):not(.el-checkbox__original)').length;
      });
      const first = document.querySelector(".memory-scope:not([style*='display: none']) .el-switch .el-switch__core");
      const core = first ? getComputedStyle(first) : null;
      resolve({ switches, rawChecks, coreW: core ? core.width : "", coreH: core ? core.height : "" });
    }, 1200));
  });
  check("自动化页开关为胶囊（含任务开关与隐私开关）", autoSw.switches >= 10, JSON.stringify(autoSw));
  check("自动化页无裸勾选框（EP 组件内部 input 除外）", autoSw.rawChecks === 0, JSON.stringify(autoSw));
  check("开关尺寸为 32×18 胶囊（与用量统计一致）", autoSw.coreW.includes("32") && autoSw.coreH.includes("18"), `${autoSw.coreW}×${autoSw.coreH}`);

  console.log("[5] 仪表盘「模型调用统计」卡");
  const dash = await page(() => {
    const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith("仪表盘"));
    if (target) target.click();
    return new Promise((resolve) => setTimeout(() => {
      const titles = [...document.querySelectorAll(".memory-scope .mem-card-title")].map((t) => t.textContent.replace(/\s+/g, " ").trim());
      resolve({ titles, hasUsage: titles.some((t) => t.includes("模型调用统计")) });
    }, 1500));
  });
  check("仪表盘含「模型调用统计」卡", dash.hasUsage === true, JSON.stringify(dash.titles).slice(0, 240));

  console.log("[6] 亮色主题下的提示气泡配色");
  const light = await page(() => {
    document.documentElement.setAttribute("data-theme", "light");
    const qa = document.querySelector(".memory-scope .mem-qa");
    if (!qa) return { ok: false, reason: "no-q-mark" };
    qa.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    qa.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => {
      const popper = document.querySelector(".el-popper.glass-popper.mem-tip");
      if (!popper) return resolve({ ok: false, reason: "no-popper" });
      const body = popper.querySelector(".mem-tip-body") || popper;
      const cs = getComputedStyle(body);
      const pcs = getComputedStyle(popper);
      const qcs = getComputedStyle(qa);
      // 气泡底是半透明毛玻璃渐变：先取渐变里的第一个 rgba，再与主题底色合成，才能算亮度差
      const parseRgba = (v) => {
        const found = String(v).match(/rgba?\([^)]*\)/g) || [];
        if (!found.length) return null;
        const inner = (found[0].match(/\(([^)]*)\)/) || [])[1] || "";
        const parts = inner.split(",").map((x) => Number(x.trim()));
        if (!parts.length || !Number.isFinite(parts[0])) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };
      const pageBg = parseRgba(getComputedStyle(document.documentElement).getPropertyValue("--bg")) || { r: 255, g: 255, b: 255, a: 1 };
      const glass = parseRgba(pcs.backgroundImage) || parseRgba(pcs.backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      const composited = {
        r: glass.r * glass.a + pageBg.r * (1 - glass.a),
        g: glass.g * glass.a + pageBg.g * (1 - glass.a),
        b: glass.b * glass.a + pageBg.b * (1 - glass.a),
      };
      const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const textRgb = parseRgba(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      resolve({
        ok: true,
        textColor: cs.color,
        bg: "渐变首色 " + JSON.stringify(glass) + " 合成后 " + JSON.stringify(composited),
        qaColor: qcs.color,
        contrast: Math.abs(lum(textRgb) - lum(composited)) > 60,
      });
    }, 900));
  });
  check("亮色下气泡仍弹出", light.ok === true, JSON.stringify(light));
  if (light.ok) {
    check("亮色下气泡文字与底色对比充足", light.contrast === true, JSON.stringify(light));
    check("亮色下小问号颜色非透明", !!light.qaColor && !/rgba\(0, 0, 0, 0\)/.test(light.qaColor), light.qaColor);
  }

  check("无 JS 运行时报错", errors.length === 0, errors.slice(0, 3).join(" || "));

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  app.exit(failCount ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("UI 校验崩溃：", (e && e.stack) || e);
    app.exit(2);
  }),
);
