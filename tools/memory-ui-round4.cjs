/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · v1.27.0 整改的 DOM 校验（无头，不截图）：把 dist 装进隐藏窗口，真实点击 + 真实样式断言：
//   ① 自动化页「正在执行」卡片：任务名是中文、进度条带数字百分比、条宽与数字一致；
//   ② 任务时间线的任务列是中文名（不再是 extract / distill 这类英文 id）；
//   ③ 九个页面（含默认隐藏的四页）+ 配置板块：不再有把 mem-chip 当按钮用的动作型元素（chip 选择器除外）；
//   ④ 所有按钮的类都在全局按钮类（btn/btn-cta/btn-ghost/btn-outline/btn-link）或既有控件类之内；
//   ⑤ 按钮尺寸命中标准规格（高度 30 / 圆角 8 / 字号 12 / 字重 600），行内文字按钮 26；
//   ⑥ memory.css 不含任何 .btn 覆盖（按钮样式完全来自 global.css，与用量统计同源）；
//   ⑦ 全程无 JS 报错。
//
// 用法（必须用 Electron 本体跑，不能加 ELECTRON_RUN_AS_NODE）：
//   ./node_modules/electron/dist/electron.exe tools/memory-ui-round4.cjs
"use strict";

const fs = require("fs");
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
  const inElectronRuntime = !!(process.versions && process.versions.electron);
  console.error(
    inElectronRuntime
      ? "检测到 ELECTRON_RUN_AS_NODE 模式：去掉该环境变量后重跑（本探针需要创建窗口）"
      : "本探针要真开窗口渲染 dist，必须用 Electron 本体跑：./node_modules/electron/dist/electron.exe tools/memory-ui-round4.cjs",
  );
  process.exit(2);
}
if (electronModule && typeof electronModule === "object") {
  ({ app, BrowserWindow } = electronModule);
}

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return true;
  }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = ["仪表盘", "记忆浏览", "项目归档", "深层画像", "Agent 接入", "检索与索引", "自动化", "导入与去重", "WebDAV同步"];
/** 全局按钮类 ∪ 模块内既有的选择器/图标控件类（分段控件 sw-item、页签、弹窗关闭钮等） */
const CTRL_WHITELIST = /\b(btn|btn-cta|btn-ghost|btn-outline|btn-link|btn-sm|sw-item|mem-chip|mem-dlg-close|tab|tab-config|icon-btn|cfg-subtab)\b/;

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

  const page = (fn, ...args) =>
    win.webContents.executeJavaScript(
      `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`,
      true,
    );

  const clickTab = (label) =>
    page((labelText) => {
      const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith(labelText));
      if (!target) return false;
      target.click();
      return true;
    }, label);

  /** 把 9 个页签全部勾回（配置页 → 界面 → 显示的页签 → 保存 → 完成）：一次性覆盖所有页面，含默认隐藏的四页 */
  async function setAllTabs() {
    await page(() => {
      const btn = [...document.querySelectorAll(".tabs button.tab-config")].find((b) => !b.textContent.includes("完成"));
      if (btn) btn.click();
    });
    await sleep(1400);
    await page(() => {
      const sub = [...document.querySelectorAll(".cfg-subtab")].find((b) => b.textContent.includes("界面"));
      if (sub) sub.click();
    });
    await sleep(800);
    await page((wantedJson) => {
      const wanted = new Set(JSON.parse(wantedJson));
      const field = [...document.querySelectorAll(".mem-field")].find((f) => ((f.querySelector(".f-label") || {}).textContent || "").includes("显示的页签"));
      if (!field) return "no-field";
      const chips = [...field.querySelectorAll('.mem-chip.click[role="checkbox"]')];
      if (!chips.length) return "no-chips";
      for (const chip of chips) {
        const name = chip.textContent.trim();
        const on = chip.classList.contains("accent");
        if (wanted.has(name) !== on) chip.click();
      }
      return "ok";
    }, JSON.stringify(PAGES));
    await sleep(500);
    await page(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("保存配置") && !b.disabled);
      if (btn) btn.click();
    });
    await sleep(1600);
    await page(() => {
      const btn = [...document.querySelectorAll(".tabs button.tab-config")].find((b) => b.textContent.includes("完成"));
      if (btn) btn.click();
    });
    await sleep(1200);
  }

  // 进入记忆仓库
  const switched = await page(() => {
    const mem = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("记忆仓库"));
    if (!mem) return false;
    mem.click();
    return true;
  });
  check("能切换到记忆仓库模块", switched === true);
  await sleep(1400);

  console.log("[1] 自动化页「正在执行」卡片（中文名 + 数字百分比）");
  check("能打开自动化页", (await clickTab("自动化")) === true);
  await sleep(1500);
  const ran = await page(() => {
    const btns = [...document.querySelectorAll(".mem-tile-foot button")];
    const run = btns.find((b) => b.textContent.trim() === "立即执行");
    if (!run) return false;
    run.click();
    return true;
  });
  check("能点任务卡「立即执行」（预览模式会模拟一段运行中）", ran === true);
  await sleep(900);
  const running = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const cards = scope ? [...scope.querySelectorAll(".mem-card")] : [];
    const card = cards.find((c) => c.textContent.includes("正在执行"));
    if (!card) return null;
    const pctChip = [...card.querySelectorAll(".mem-chip")].find((c) => /^\d+\s*%$/.test(c.textContent.trim()));
    const bar = card.querySelector(".mem-progress > i");
    return {
      text: card.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
      percentText: pctChip ? pctChip.textContent.trim() : "",
      barWidth: bar ? bar.style.width : "",
      hasBar: !!bar,
    };
  });
  check("出现「正在执行」卡片", !!running, JSON.stringify(running));
  if (running) {
    check("任务名是中文（含「抽取结构化信息」，不含英文 id extract）", running.text.includes("抽取结构化信息") && !/\bextract\b/.test(running.text), running.text);
    check("进度条带数字百分比", /^\d+\s*%$/.test(running.percentText), running.percentText);
    const pct = Number((running.percentText || "").replace("%", ""));
    const width = Number((running.barWidth || "").replace("%", ""));
    check("进度条宽度与百分比数字一致（±1）", Number.isFinite(pct) && Number.isFinite(width) && Math.abs(pct - width) <= 1, `${running.percentText} vs ${running.barWidth}`);
  }

  console.log("[2] 任务时间线的任务列（中文任务名）");
  const timeline = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const card = scope ? [...scope.querySelectorAll(".mem-card")].find((c) => c.textContent.includes("任务时间线")) : null;
    const row = card ? card.querySelector("tbody tr") : null;
    if (!row) return null;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent.trim());
    return { task: cells[1] || "", all: cells.join(" | ") };
  });
  check("时间线有数据行", !!timeline, JSON.stringify(timeline));
  if (timeline) {
    check("任务列是中文名（如「抽取结构化信息」）", /[\u4e00-\u9fa5]/.test(timeline.task) && !/^[a-z-]+$/.test(timeline.task), timeline.task);
  }

  console.log("[3] 全量页签（含默认隐藏四页）后逐页扫按钮");
  await setAllTabs();
  const tabsNow = await page(() => [...document.querySelectorAll(".tabs button.tab")].map((b) => b.textContent.trim()).filter((t) => t && t !== "配置" && t !== "完成"));
  check("九个页签已勾回", Array.isArray(tabsNow) && tabsNow.length === 9, JSON.stringify(tabsNow));

  const offenders = [];
  const chipLeft = [];
  let btnTotal = 0;
  for (const label of PAGES) {
    await clickTab(label);
    await sleep(950);
    const res = await page(() => {
      const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
        const p = s.closest(".page");
        return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
      });
      if (!scope) return { total: 0, list: [], chips: [] };
      // 选择器 chip（多选/单选）保留胶囊形态是刻意的，不算动作按钮
      const chips = [...scope.querySelectorAll(".mem-chip.click")].filter((el) => {
        const role = el.getAttribute("role") || "";
        return role !== "checkbox" && role !== "radio";
      });
      const buttons = [...scope.querySelectorAll("button")];
      return {
        total: buttons.length,
        list: buttons.map((b) => ({ cls: b.className, text: b.textContent.trim().slice(0, 18) })),
        chips: chips.map((el) => el.textContent.trim().slice(0, 20)),
      };
    });
    btnTotal += res.total;
    for (const b of res.list) {
      if (!CTRL_WHITELIST.test(b.cls)) offenders.push(`「${label}」${b.text} → ${b.cls}`);
    }
    for (const c of res.chips) chipLeft.push(`「${label}」${c}`);
  }
  check("九个页面共取到按钮（>50 个）", btnTotal > 50, String(btnTotal));
  check("所有按钮的类都在全局按钮类或既有控件类之内（无自造按钮样式）", offenders.length === 0, offenders.slice(0, 5).join(" | "));
  check("没有动作型 mem-chip.click 残留（选择器 chip 除外）", chipLeft.length === 0, chipLeft.slice(0, 5).join(" | "));

  console.log("[4] 配置页「记忆仓库」板块（模型与网关等）同样统一");
  await page(() => {
    const btn = [...document.querySelectorAll(".tabs button.tab-config")].find((b) => !b.textContent.includes("完成"));
    if (btn) btn.click();
  });
  await sleep(1800);
  const cfgPanel = await page(() => {
    const scope = [...document.querySelectorAll(".cfg-sec.memory-scope")].find((s) => s.offsetParent !== null);
    if (!scope) return null;
    const chips = [...scope.querySelectorAll(".mem-chip.click")].filter((el) => {
      const role = el.getAttribute("role") || "";
      return role !== "checkbox" && role !== "radio";
    });
    const buttons = [...scope.querySelectorAll("button")];
    return {
      total: buttons.length,
      list: buttons.map((b) => ({ cls: b.className, text: b.textContent.trim().slice(0, 18) })),
      chips: chips.map((el) => el.textContent.trim().slice(0, 20)),
    };
  });
  check("配置页能取到记忆仓库板块", !!cfgPanel && cfgPanel.total > 5, JSON.stringify(cfgPanel && cfgPanel.total));
  if (cfgPanel) {
    const bad = cfgPanel.list.filter((b) => !CTRL_WHITELIST.test(b.cls)).map((b) => `${b.text} → ${b.cls}`);
    check("配置板块里的按钮同样是标准类", bad.length === 0, bad.slice(0, 5).join(" | "));
    check("配置板块无动作型 mem-chip.click（多选 chip 除外）", cfgPanel.chips.length === 0, cfgPanel.chips.slice(0, 3).join(" | "));
  }
  await page(() => {
    const btn = [...document.querySelectorAll(".tabs button.tab-config")].find((b) => b.textContent.includes("完成"));
    if (btn) btn.click();
  });
  await sleep(1200);

  console.log("[5] 按钮尺寸命中标准控件规格（与用量统计同款）");
  await clickTab("仪表盘");
  await sleep(1000);
  const spec = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const b = scope ? [...scope.querySelectorAll("button.btn-outline")].find((x) => x.textContent.includes("自动化任务")) : null;
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { height: cs.height, radius: cs.borderRadius, size: cs.fontSize, weight: cs.fontWeight, cls: b.className };
  });
  check("抽到标准描边按钮（自动化任务 →）", !!spec, JSON.stringify(spec));
  if (spec) {
    check("高度 30px（--ctl-h）", spec.height === "30px", spec.height);
    check("圆角 8px（--r-sm）", spec.radius === "8px", spec.radius);
    check("字号 12px / 字重 600（与用量统计按钮同规格）", spec.size === "12px" && spec.weight === "600", `${spec.size}/${spec.weight}`);
  }
  await clickTab("记忆浏览");
  await sleep(900);
  const ghostSpec = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const b = scope ? [...scope.querySelectorAll("button.btn-ghost")].find((x) => /重置筛选|更多筛选/.test(x.textContent)) : null;
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { height: cs.height, radius: cs.borderRadius, cls: b.className };
  });
  check("次级按钮（更多筛选 / 重置筛选）也是 30px + 8px 圆角", !!ghostSpec && ghostSpec.height === "30px" && ghostSpec.radius === "8px", JSON.stringify(ghostSpec));
  const linkSpec = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const b = scope ? [...scope.querySelectorAll("button.btn-link")].find((x) => x.textContent.trim() === "⋯") : null;
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { height: cs.height, color: cs.color, cls: b.className };
  });
  check("行内文字按钮（⋯）高度 26px", !!linkSpec && linkSpec.height === "26px", JSON.stringify(linkSpec));

  console.log("[6] memory.css 不含任何 .btn 覆盖（样式与用量统计同源）");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles", "memory.css"), "utf8");
  const overrides = (css.match(/^[^{}]*\.btn[a-z-]*[^{}]*\{/gm) || []).map((s) => s.trim());
  check("memory.css 无 .btn / .btn-xxx 选择器", overrides.length === 0, overrides.slice(0, 3).join(" / "));

  console.log("[7] 运行期无 JS 报错");
  check("控制台无 error", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log(" - " + f);
  }
  win.destroy();
  app.exit(failCount ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
  console.error("探针异常：", e && e.stack ? e.stack : e);
  app.exit(2);
});
