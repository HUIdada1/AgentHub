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

// 记忆仓库默认页签（PageTabs 的按钮不挂 data-page，按文字前缀定位）。
// 界面精简后默认只开六个：深层画像 / Agent 接入 / 检索与索引 / 导入与去重属「装一次 / 排障才来」，
// 由配置页「界面 · 页签显隐与排序」按需勾回，故不在默认清单里。
const PAGES = [
  ["dashboard", "仪表盘"],
  ["browse", "记忆浏览"],
  ["review", "待确认"],
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

  // 页签条末尾还有一个「配置」按钮（隐藏配置页的入口），不算记忆页签
  const pageTabs = await page(() => [...document.querySelectorAll(".tabs button.tab")].map((b) => b.textContent.trim()).filter((t) => t && t !== "配置"));
  check("页签条不再含「模型与网关」", Array.isArray(pageTabs) && !pageTabs.some((t) => t.includes("模型与网关")), JSON.stringify(pageTabs));
  check(
    "页签条含全部十个页面（页签显隐已移除，不再有隐藏页）",
    Array.isArray(pageTabs) && pageTabs.length === 10
      && pageTabs.some((t) => t.includes("待确认"))
      && pageTabs.some((t) => t.includes("深层画像"))
      && pageTabs.some((t) => t.includes("Agent 接入"))
      && pageTabs.some((t) => t.includes("检索与索引"))
      && pageTabs.some((t) => t.includes("导入与去重")),
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
  check("出现记忆专属行（记忆总量 / 待确认 / 索引健康）", /记忆总量/.test(joined) && /待确认/.test(joined) && /索引健康/.test(joined), joined.slice(0, 220));
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
  check("十个页签都能点到", Object.values(marks).every((n) => n >= 0), JSON.stringify(marks));
  const minQa = (id) => (id === "review" ? 2 : 3); // 收件箱是裁决台，说明集中在队列标题里
  check("每页小问号数量达标（收件箱 ≥2，其余 ≥3）", Object.entries(marks).every(([id, n]) => n >= minQa(id)), JSON.stringify(marks));

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
      // 开关形态：模块内布尔开关都应是 .switch 胶囊（用量统计同款），且没有裸勾选框
      const scopes = document.querySelectorAll(".memory-scope");
      let switches = 0;
      let rawChecks = 0;
      scopes.forEach((sc) => {
        switches += sc.querySelectorAll(".switch").length;
        rawChecks += sc.querySelectorAll('input[type="checkbox"]:not(.el-checkbox__original)').length;
      });
      resolve({ ok: true, subtabs, titles: titles.slice(0, 240), addProvider, switches, rawChecks, hasBody: !!body });
    }, 1200));
  });
  check("配置页子页签条不含「模型与网关」", cfg.ok === true && Array.isArray(cfg.subtabs) && !cfg.subtabs.some((t) => t.includes("模型与网关")), JSON.stringify(cfg.subtabs));
  check("配置页子页签仍有各分组（存储 / 索引 / 检索…）", cfg.ok === true && cfg.subtabs.length > 4, JSON.stringify(cfg.subtabs));
  if (cfg.ok) {
    check("模型面板常驻首屏（无需点页签即可见「添加供应商」）", cfg.addProvider === true, JSON.stringify({ titles: cfg.titles }));
    check("模型区块标题在配置页存在", /模型与网关/.test(cfg.titles), cfg.titles);
    check("页面至少有一个胶囊开关（.switch）", cfg.switches > 0, `switch=${cfg.switches}`);
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
        switches += sc.querySelectorAll(".switch").length;
        rawChecks += sc.querySelectorAll('input[type="checkbox"]:not(.el-checkbox__original)').length;
      });
      const first = document.querySelector(".memory-scope:not([style*='display: none']) .switch");
      const core = first ? getComputedStyle(first) : null;
      resolve({ switches, rawChecks, coreW: core ? core.width : "", coreH: core ? core.height : "" });
    }, 1200));
  });
  check("自动化页开关为胶囊（含任务开关与隐私开关）", autoSw.switches >= 10, JSON.stringify(autoSw));
  check("自动化页无裸勾选框（EP 组件内部 input 除外）", autoSw.rawChecks === 0, JSON.stringify(autoSw));
  check("开关尺寸为 40×22 胶囊（与用量统计一致）", autoSw.coreW.includes("40") && autoSw.coreH.includes("22"), `${autoSw.coreW}×${autoSw.coreH}`);

  console.log("[4c] 配置页不再有页签显隐编辑器（功能已按用户要求移除）");
  const tabEditor = await page(() => {
    // 配置页是隐藏页：先从页签条进配置，再切到「界面」子页签
    const tabs = [...document.querySelectorAll(".tabs button.tab")];
    const cfgBtn = tabs.find((b) => b.textContent.trim() === "配置");
    if (!cfgBtn) return { ok: false, reason: "no-config-button" };
    cfgBtn.click();
    return new Promise((resolve) => setTimeout(() => {
      const sub = [...document.querySelectorAll(".cfg-subtab")].find((b) => b.textContent.includes("界面"));
      if (!sub) return resolve({ ok: false, reason: "no-ui-subtab" });
      sub.click();
      setTimeout(() => {
        const scope = [...document.querySelectorAll(".memory-scope")].find((el) => el.getBoundingClientRect().width > 0);
        const buttons = scope ? [...scope.querySelectorAll("button.mem-chip.click")].map((b) => b.textContent.trim()) : [];
        resolve({
          ok: true,
          short: buttons.filter((t) => t === "移除" || t === "↑" || t === "↓").length,
          addables: buttons.filter((t) => t.startsWith("＋")).map((t) => t.replace("＋", "").trim()),
        });
      }, 700);
    }, 1500));
  });
  check("配置页没有页签显隐编辑器（无 移除/↑/↓/＋ 编辑按钮）",
    tabEditor.ok === true && tabEditor.short === 0 && (tabEditor.addables || []).length === 0,
    JSON.stringify(tabEditor));

  console.log("[5] 仪表盘「AI 花费」卡（原「模型调用统计」，与「自动化成本」已合并）");
  const gotoDash = await page(() => {
    const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith("仪表盘"));
    if (target) target.click();
    return true;
  });
  await sleep(1200);
  const dash = await page(() => {
    const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith("仪表盘"));
    if (target) target.click();
    return new Promise((resolve) => setTimeout(() => {
      const titles = [...document.querySelectorAll(".memory-scope .mem-card-title")].map((t) => t.textContent.replace(/\s+/g, " ").trim());
      resolve({
        titles,
        hasUsage: titles.some((t) => t.includes("AI 花费")),
        // 四张 KPI：记忆总数 / 已连通 Agent / 今日新增 / 待确认
        kpiCount: document.querySelectorAll(".memory-scope .mem-grid-kpi .mem-kpi").length,
        kpiLabels: [...document.querySelectorAll(".memory-scope .mem-grid-kpi .mem-kpi .k-label")].map((e) => e.textContent.trim()),
      });
    }, 1500));
  });
  check("仪表盘含「AI 花费」卡", dash.hasUsage === true, JSON.stringify(dash.titles).slice(0, 240));
  check("仪表盘 KPI 为四张（记忆总量 / 已连通 Agent / 今日新增 / 待确认）", dash.kpiCount === 4 && dash.kpiLabels.some((t) => t.includes("待确认")), JSON.stringify(dash.kpiLabels));

  console.log("[5b] 待确认收件箱：三类队列的分段控件");
  const review = await page(() => {
    const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith("待确认"));
    if (!target) return { ok: false, reason: "no-tab" };
    target.click();
    return new Promise((resolve) => setTimeout(() => {
      // 页面 v-show 保活：必须先在「可见的」memory-scope 里找，否则会命中隐藏页（浏览页也有 is-3 分段控件）
      const scope = [...document.querySelectorAll(".memory-scope")].find((el) => el.getBoundingClientRect().width > 0);
      const sw = scope ? scope.querySelector(".mem-switch.is-3") : null;
      const items = sw ? [...sw.querySelectorAll(".sw-item")].map((b) => b.textContent.trim()) : [];
      const thumb = sw ? getComputedStyle(sw.querySelector(".sw-thumb")).transform : "";
      resolve({ ok: !!sw, items, thumb });
    }, 900));
  });
  check("收件箱有三分段控件（事实失效 / 项目归类 / 去重）", review.ok && review.items.length === 3 && review.items.join("|").includes("事实失效") && review.items.join("|").includes("去重"), JSON.stringify(review));

  const reviewDedup = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((el) => el.getBoundingClientRect().width > 0);
    const sw = scope ? scope.querySelector(".mem-switch.is-3") : null;
    const item = sw ? [...sw.querySelectorAll(".sw-item")].find((b) => b.textContent.includes("去重")) : null;
    if (!item) return { ok: false, reason: "no-dedup-item" };
    item.click();
    return new Promise((resolve) => setTimeout(() => {
      const texts = [...(scope ? scope.querySelectorAll(".mem-tile-foot button") : [])].map((b) => b.textContent.trim());
      resolve({ ok: true, buttons: texts });
    }, 700));
  });
  check("切到「去重」tab 渲染出裁决按钮（采纳新记忆 / 保留旧记忆 / 两条都留）",
    reviewDedup.ok === true && reviewDedup.buttons.includes("采纳新记忆") && reviewDedup.buttons.includes("两条都留"),
    JSON.stringify(reviewDedup));

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
