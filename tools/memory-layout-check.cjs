/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 布局改造校验（无头 DOM 探针，纯代码断言、不截图）：把 dist 装进隐藏窗口，用真实点击/取值断言：
//   ① 仪表盘顶部六张 KPI 恒定一行（同一 offsetTop、单卡宽度受控、栅格真是 6 列）
//   ② Agent 连接状态列表有定高滚动盒（满了自己滚，不撑高卡片）
//   ③ 记忆浏览：列表/热力图是左右滑动的分段切换（滑块位移 + 面板按方向滑入），
//      列表＝表格 + 定高滚动 + 表头粘顶 + 分页；热力图＝周列日历（月份标尺 / 图例 / 悬停看板）
//   ④ 自动化任务时间线定高滚动 + 表头粘顶
//   ⑤ 仪表盘「记忆增长趋势」＝ECharts 折线 + 五档区间筛选（切区间换序列与合计），
//      并与「用量统计 · 用量趋势」逐项对齐（同高 / 同款区间按钮）
//
// 用法（必须用 Electron 本体跑，不能加 ELECTRON_RUN_AS_NODE）：
//   ./node_modules/electron/dist/electron.exe tools/memory-layout-check.cjs
"use strict";

const fs = require("fs");
const path = require("path");

// 逐步日志落盘（appendFileSync 不经 stdout 缓冲，卡在哪一步一眼可见）
const STEP_LOG = path.join(__dirname, "..", "tmp", "layout-steps.log");
function step(msg) {
  fs.appendFileSync(STEP_LOG, `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
try { fs.writeFileSync(STEP_LOG, ""); } catch { /* 忽略 */ }

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
      : "本探针要真开窗口渲染 dist，必须用 Electron 本体跑：./node_modules/electron/dist/electron.exe tools/memory-layout-check.cjs",
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

async function main() {
  const watchdog = setTimeout(() => {
    step("[watchdog] 120s 未完成，疑似某次 executeJavaScript 未返回");
    console.error("[watchdog] 120s 未完成，疑似某次 executeJavaScript 未返回");
    app.exit(3);
  }, 120000);
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

  const gotoPage = (label) =>
    page((text) => {
      const target = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith(text));
      if (!target) return false;
      target.click();
      return new Promise((resolve) => setTimeout(() => resolve(true), 1500));
    }, label);

  const switched = await page(() => {
    const mem = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("记忆仓库"));
    if (!mem) return false;
    mem.click();
    return true;
  });
  check("能切换到记忆仓库模块", switched === true);
  await sleep(1200);

  console.log("[1] 仪表盘：六张 KPI 一行 + Agent 连接状态滚动盒");
  step("phase1 goto dashboard");
  await gotoPage("仪表盘");
  step("phase1 dashboard ready");
  const kpi = await page(() => {
    const grid = document.querySelector(".mem-grid-kpi");
    const cards = [...document.querySelectorAll(".mem-grid-kpi .mem-kpi")];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width));
    const heights = cards.map((c) => Math.round(c.getBoundingClientRect().height));
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
    const value = cards[0] ? getComputedStyle(cards[0].querySelector(".k-value")).fontSize : "";
    return {
      hasGrid: !!grid,
      n: cards.length,
      cols,
      tops,
      sameRow: tops.length > 1 && Math.max(...tops) - Math.min(...tops) <= 1,
      minW: widths.length ? Math.min(...widths) : 0,
      maxW: widths.length ? Math.max(...widths) : 0,
      maxH: heights.length ? Math.max(...heights) : 0,
      valueFont: value,
      leftmost: cards[0] ? Math.round(cards[0].getBoundingClientRect().left) : 0,
    };
  });
  check("仪表盘有 KPI 栅格且是 4 张卡（界面精简后只留决定项）", kpi.hasGrid === true && kpi.n === 4, JSON.stringify(kpi));
  check("KPI 栅格计算样式为 4 列（一行摆满）", kpi.cols === 4, `cols=${kpi.cols}`);
  check("四张卡在同一行（顶边齐平）", kpi.sameRow === true, `tops=${JSON.stringify(kpi.tops)}`);
  check("单卡宽度受控（≤ 340px，四列窗口下不臃肿）", kpi.maxW <= 340 && kpi.maxW > 0, `${kpi.minW}~${kpi.maxW}px`);
  check("单卡高度受控（≤ 90px，不臃肿）", kpi.maxH <= 90 && kpi.maxH > 0, `${kpi.maxH}px`);
  check("KPI 数值字号已压小（≤ 20px）", parseFloat(kpi.valueFont) <= 20, kpi.valueFont);

  step("phase1 agent scroll");
  const agentScroll = await page(() => {
    const box = document.querySelector(".mem-scroll-sm");
    const host = document.querySelector(".memory-scope");
    let cs = null;
    let real = false;
    if (box) {
      cs = getComputedStyle(box);
      real = true;
    } else if (host) {
      // 本机没探到 Agent 时卡片走空态，用探针元素校验同一条 CSS 契约
      const probe = document.createElement("div");
      probe.className = "mem-scroll mem-scroll-sm";
      probe.style.position = "absolute";
      host.appendChild(probe);
      cs = getComputedStyle(probe);
      probe.remove();
    }
    if (!cs) return { ok: false, reason: "no-scope" };
    return {
      ok: true,
      real,
      maxHeight: cs.maxHeight,
      overflowY: cs.overflowY,
      boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
      scrollH: box ? box.scrollHeight : 0,
      clientH: box ? box.clientHeight : 0,
    };
  });
  check("Agent 连接状态列表有定高滚动盒（max-height 260px + overflow auto）",
    agentScroll.ok && agentScroll.maxHeight === "260px" && /auto|scroll/.test(agentScroll.overflowY),
    JSON.stringify(agentScroll));
  check("滚动盒实际高度不超过 260px", !agentScroll.real || agentScroll.boxH <= 262, JSON.stringify(agentScroll));

  step("phase1 agent scroll overflow");
  const agentOverflow = await page(() => {
    const box = document.querySelector(".mem-scroll-sm");
    if (!box) return { ok: false, reason: "no-box" };
    const nodes = [...box.children];
    if (!nodes.length) return { ok: false, reason: "empty" };
    for (let i = 0; i < 4; i++) nodes.forEach((n) => box.appendChild(n.cloneNode(true)));
    const boxH = Math.round(box.getBoundingClientRect().height);
    return { ok: true, boxH, scrollH: box.scrollHeight, clientH: box.clientHeight };
  });
  check("Agent 列表条目灌满后只滚不高（高度仍 ≤260px 且 scrollHeight > clientHeight）",
    agentOverflow.ok && agentOverflow.boxH <= 262 && agentOverflow.scrollH > agentOverflow.clientH,
    JSON.stringify(agentOverflow));

  console.log("[1b] 仪表盘：记忆增长趋势（ECharts 折线 + 区间筛选）");
  // 读一次趋势卡。函数体会被序列化进页面执行，不能引用外部变量；点击与取值必须分开两次调用
  const readTrendCard = () => {
    try {
      const card = [...document.querySelectorAll(".mem-card")].find((c) => c.textContent.includes("记忆增长趋势"));
      if (!card) return { ok: false, reason: "no-trend-card" };
      const tabs = [...card.querySelectorAll(".mem-tabs .mem-tab")];
      const active = tabs.find((t) => t.classList.contains("active"));
      const host = card.querySelector(".mem-chart");
      const canvas = host ? host.querySelector("canvas") : null;
      const hint = card.querySelector(".mem-hint");
      const cs = host ? getComputedStyle(host) : null;
      const tab = tabs[0] || null;
      const tabCs = tab ? getComputedStyle(tab) : null;
      const actCs = active ? getComputedStyle(active) : null;
      const box = canvas ? canvas.getBoundingClientRect() : null;
      // 画布是不是真画上了东西：ECharts 用 2d canvas，直接隔点抽读 alpha 通道
      let painted = -1;
      if (canvas && canvas.width > 0) {
        painted = 0;
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 400) if (data[i] > 0) painted++;
      }
      return {
        ok: true,
        labels: tabs.map((t) => t.textContent.trim()),
        activeLabel: active ? active.textContent.trim() : "",
        range: host ? host.getAttribute("data-range") : "",
        points: host ? Number(host.getAttribute("data-points")) : -1,
        chartH: cs ? cs.height : "",
        canvasW: box ? Math.round(box.width) : 0,
        canvasH: box ? Math.round(box.height) : 0,
        painted,
        hint: hint ? hint.textContent.replace(/\s+/g, " ").trim() : "",
        tabH: tabCs ? tabCs.height : "",
        tabRadius: tabCs ? tabCs.borderRadius : "",
        activeBg: actCs ? actCs.backgroundColor : "",
        activeWeight: actCs ? actCs.fontWeight : "",
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  const clickTab = (label) => {
    const card = [...document.querySelectorAll(".mem-card")].find((c) => c.textContent.includes("记忆增长趋势"));
    const btn = card ? [...card.querySelectorAll(".mem-tab")].find((b) => b.textContent.trim() === label) : null;
    if (!btn) return { ok: false, reason: "no-tab:" + label };
    btn.click();
    return { ok: true };
  };
  const countOf = (hint) => {
    const m = String(hint || "").match(/共 ([\d,]+) 条/);
    return m ? Number(m[1].replace(/,/g, "")) : -1;
  };

  step("phase1b trend read");
  const trend0 = await page(readTrendCard);
  check("趋势卡是 ECharts 折线图 + 五档区间筛选（与用量趋势同档位）",
    trend0.ok === true && trend0.labels.join(",") === "近七天,月,季,半年,年", JSON.stringify(trend0));
  check("默认区间是月（30 天）", trend0.activeLabel === "月" && trend0.range === "30" && trend0.points === 30,
    `active=${trend0.activeLabel} range=${trend0.range} points=${trend0.points}`);
  check("画布尺寸正常且高度与用量趋势齐平（300px）",
    trend0.chartH === "300px" && trend0.canvasW > 100 && trend0.canvasH > 100,
    `${trend0.chartH} / canvas ${trend0.canvasW}x${trend0.canvasH}`);
  check("画布上真画出了曲线（像素非空）", trend0.painted > 0, `painted=${trend0.painted}`);
  check("左上角合计跟着区间走（近 30 天共 N 条）", /^近 30 天共 [\d,]+ 条$/.test(trend0.hint), trend0.hint);
  check("区间按钮与用量趋势同款（高 24px / 圆角 / 选中态底色加粗）",
    trend0.tabH === "24px" && parseFloat(trend0.tabRadius) > 0 && Number(trend0.activeWeight) >= 600 && !/rgba\(0, 0, 0, 0\)/.test(trend0.activeBg),
    JSON.stringify({ h: trend0.tabH, r: trend0.tabRadius, bg: trend0.activeBg, w: trend0.activeWeight }));

  step("phase1b click 近七天");
  const tab7 = await page(clickTab, "近七天");
  check("能点到「近七天」区间", tab7.ok === true, JSON.stringify(tab7));
  await sleep(1200);
  const trend7 = await page(readTrendCard);
  check("切到近七天：选中态与序列长度都跟着变（30 → 7 个点）",
    trend7.ok === true && trend7.activeLabel === "近七天" && trend7.range === "7" && trend7.points === 7,
    `active=${trend7.activeLabel} range=${trend7.range} points=${trend7.points}`);
  check("合计按新窗口重算（近七天共 M 条）", /^近七天共 [\d,]+ 条$/.test(trend7.hint), trend7.hint);
  check("窗口收敛后合计不超过 30 天的合计", countOf(trend7.hint) >= 0 && countOf(trend7.hint) <= countOf(trend0.hint),
    `${countOf(trend7.hint)} <= ${countOf(trend0.hint)}`);
  check("换区间后重画（不是空白画布）", trend7.painted > 0, `painted=${trend7.painted}`);

  step("phase1b click 年");
  const tabYear = await page(clickTab, "年");
  check("能点到「年」区间", tabYear.ok === true, JSON.stringify(tabYear));
  await sleep(1200);
  const trend365 = await page(readTrendCard);
  check("切到年（365 天）：曲线上真铺满一年",
    trend365.ok === true && trend365.activeLabel === "年" && trend365.range === "365" && trend365.points === 365,
    `active=${trend365.activeLabel} range=${trend365.range} points=${trend365.points}`);
  check("365 天窗口的合计 ≥ 30 天窗口的合计", countOf(trend365.hint) >= countOf(trend0.hint), `${countOf(trend365.hint)} vs ${countOf(trend0.hint)}`);

  step("phase1b click back 月");
  await page(clickTab, "月");
  await sleep(1200);
  const trendBack = await page(readTrendCard);
  check("能切回「月」（状态与曲线都还原）",
    trendBack.ok === true && trendBack.activeLabel === "月" && trendBack.points === 30 && trendBack.painted > 0,
    `active=${trendBack.activeLabel} points=${trendBack.points} painted=${trendBack.painted}`);

  console.log("[2] 记忆浏览：左右滑动的分段切换");
  step("phase2 goto browse");
  await gotoPage("记忆浏览");
  step("phase2 browse ready");
  step("phase2 read switch");
  const sw0 = await page(() => {
    const sw = document.querySelector(".mem-switch");
    if (!sw) return { ok: false, reason: "no-switch" };
    const thumb = sw.querySelector(".sw-thumb");
    const items = [...sw.querySelectorAll(".sw-item")].map((b) => b.textContent.trim());
    const thumbBox = thumb ? thumb.getBoundingClientRect() : null;
    const itemBox = sw.querySelector(".sw-item") && sw.querySelector(".sw-item").getBoundingClientRect();
    return {
      ok: true,
      items,
      thumb: thumb ? getComputedStyle(thumb).transform : "",
      thumbW: thumbBox ? Math.round(thumbBox.width) : 0,
      itemW: itemBox ? Math.round(itemBox.width) : 0,
      thumbLeft: thumbBox ? Math.round(thumbBox.left) : 0,
      itemLeft: itemBox ? Math.round(itemBox.left) : 0,
      trackH: Math.round(sw.getBoundingClientRect().height),
    };
  });
  check("分段控件存在且有滑块 + 三个选项（列表 / 热力图 / 回收站）",
    sw0.ok === true && sw0.items.length === 3 && sw0.items[0].includes("列表") && sw0.items[1].includes("热力图") && sw0.items[2].includes("回收站"),
    JSON.stringify(sw0));
  check("初始滑块贴在第一项上", sw0.ok && Math.abs(sw0.thumbLeft - sw0.itemLeft) <= 2, JSON.stringify(sw0));
  check("滑块是一列宽（不是整条轨道）", sw0.ok && sw0.thumbW > 0 && sw0.thumbW <= sw0.itemW + 2, `${sw0.thumbW}/${sw0.itemW}`);

  step("phase2 read list view");
  const listView = await page(() => {
    const cells = [...document.querySelectorAll(".mem-table-list thead th")].map((th) => th.textContent.trim());
    const wrap = document.querySelector(".mem-table-scroll");
    const table = document.querySelector(".mem-table-list");
    const rows = table ? table.querySelectorAll("tbody tr").length : 0;
    const th = table ? table.querySelector("thead th") : null;
    const cs = wrap ? getComputedStyle(wrap) : null;
    const tcs = th ? getComputedStyle(th) : null;
    const pager = document.querySelector(".mem-pager");
    return {
      isList: !!table,
      heads: cells,
      rows,
      maxHeight: cs ? cs.maxHeight : "",
      overflowY: cs ? cs.overflowY : "",
      thPos: tcs ? tcs.position : "",
      thBg: tcs ? tcs.backgroundColor : "",
      pagerText: pager ? pager.textContent.replace(/\s+/g, " ").trim() : "",
      panelCls: table ? table.closest(".mem-view") ? table.closest(".mem-view").className : "" : "",
    };
  });
  check("列表视图是表格（列含时间/标题/项目/Agent/标记/标签/操作 —— 层级·重要·状态已并成一列「标记」）",
    listView.isList === true && listView.heads.length === 7 && listView.heads.includes("时间") && listView.heads.includes("标题") && listView.heads.includes("标记") && listView.heads.includes("操作"),
    JSON.stringify(listView.heads));
  check("列表在定高滚动容器里（max-height 非 none + overflow auto）",
    listView.maxHeight !== "" && listView.maxHeight !== "none" && /auto|scroll/.test(listView.overflowY),
    `${listView.maxHeight} / ${listView.overflowY}`);
  check("表头粘顶（position: sticky）且有实色底", listView.thPos === "sticky" && !/rgba\(0, 0, 0, 0\)/.test(listView.thBg), `${listView.thPos} / ${listView.thBg}`);
  check("列表有数据行（本机记忆库非空）", listView.rows > 0, `rows=${listView.rows}`);

  // 点击与取值分两次执行：一次 executeJavaScript 里既点击又延时读，回调抛错会让 promise
  // 永不 settle（探针整体挂死，CPU 归零、无任何输出），排查代价极高
  step("phase2 list overflow");
  const listOverflow = await page(() => {
    const view = [...document.querySelectorAll(".mem-view")].find((v) => v.querySelector(".mem-table-scroll"));
    const wrap = view ? view.querySelector(".mem-table-scroll") : null;
    const body = wrap ? wrap.querySelector("tbody") : null;
    if (!wrap || !body) return { ok: false, reason: "no-table" };
    const rows = [...body.querySelectorAll("tr")];
    if (!rows.length) return { ok: false, reason: "no-rows" };
    for (let i = 0; i < 12; i++) rows.forEach((r) => body.appendChild(r.cloneNode(true)));
    return { ok: true, boxH: Math.round(wrap.getBoundingClientRect().height), scrollH: wrap.scrollHeight, clientH: wrap.clientHeight };
  });
  check("记忆列表灌满后只滚不高（高度仍受限且 scrollHeight > clientHeight）",
    listOverflow.ok && listOverflow.boxH <= 500 && listOverflow.scrollH > listOverflow.clientH,
    JSON.stringify(listOverflow));

  step("phase2 click heatmap");
  const heatClicked = await page(() => {
    const btn = [...document.querySelectorAll(".mem-switch .sw-item")].find((b) => b.textContent.trim().includes("热力图"));
    if (!btn) return { ok: false, reason: "no-heat-button" };
    btn.click();
    return { ok: true };
  });
  check("能点到「热力图」选项", heatClicked.ok === true, JSON.stringify(heatClicked));
  await sleep(1000);
  const heat = await page(() => {
    try {
      const sw = document.querySelector(".mem-switch");
      const thumb = sw ? sw.querySelector(".sw-thumb") : null;
      const items = sw ? [...sw.querySelectorAll(".sw-item")] : [];
      const second = items[1] ? items[1].getBoundingClientRect() : null;
      const thumbBox = thumb ? thumb.getBoundingClientRect() : null;
      const tf = thumb ? getComputedStyle(thumb).transform : "";
      const m = String(tf).match(/matrix\(([^)]*)\)/);
      const tx = m ? parseFloat(m[1].split(",")[4]) : 0;
      const view = document.querySelector(".mem-view.from-right");
      const cells = document.querySelectorAll(".mem-heat-cell");
      const body = document.querySelector(".mem-heat-body");
      const monthEls = [...document.querySelectorAll(".mem-heat-months span")];
      const months = monthEls.map((s) => s.textContent.trim());
      const legend = document.querySelectorAll(".mem-heat-legend .cells i").length;
      const scroll = document.querySelector(".mem-heat-scroll");
      const scs = scroll ? getComputedStyle(scroll) : null;
      const ages = monthEls.map((s) => parseInt(s.style.left, 10));
      const first = items[0] ? items[0].getBoundingClientRect() : null;
      return {
        ok: true,
        thumbTx: Math.round(tx),
        thumbLeft: thumbBox ? Math.round(thumbBox.left) : -1,
        secondLeft: second ? Math.round(second.left) : -1,
        expectTx: first ? Math.round(first.width + 2) : null,
        panelSlide: !!view,
        cells: cells.length,
        weeks: document.querySelectorAll(".mem-heat-col").length,
        isGrid: !!body && getComputedStyle(body).display === "flex",
        months: months.join(","),
        monthOrdered: ages.every((v, i, a) => i === 0 || v >= a[i - 1]),
        monthMinGap: ages.length > 1 ? Math.min(...ages.slice(1).map((v, i) => v - ages[i])) : 99,
        legend,
        overflowX: scs ? scs.overflowX : "",
        scrolledRight: scroll ? Math.round(scroll.scrollWidth - scroll.scrollLeft - scroll.clientWidth) : -1,
        listGone: document.querySelectorAll(".mem-table-list").length === 0,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  step("phase2 heat done");
  check("点「热力图」后滑块滑到第二项（位移 = 一列宽 + 间隙）",
    heat.ok && heat.expectTx !== null && heat.thumbTx > 0 && Math.abs(heat.thumbTx - heat.expectTx) <= 2
      && heat.secondLeft > 0 && Math.abs(heat.thumbLeft - heat.secondLeft) <= 2,
    JSON.stringify({ tx: heat.thumbTx, expect: heat.expectTx, thumbLeft: heat.thumbLeft, secondLeft: heat.secondLeft }));
  check("面板按滑动方向入场（.mem-view.from-right）", heat.ok && heat.panelSlide === true, JSON.stringify(heat));
  check("热力图渲染成周列日历（约 53 列 × 371 格）", heat.ok && heat.weeks >= 52 && heat.cells >= 360, `weeks=${heat.weeks} cells=${heat.cells}`);
  check("有月份标尺（≥ 10 个月，位置从左到右递增）", heat.ok && heat.months.split(",").length >= 10 && heat.monthOrdered === true, heat.months);
  check("月份标尺不叠字（相邻至少隔 2 周 = 32px）", heat.ok && heat.monthMinGap >= 32, `minGap=${heat.monthMinGap}px`);
  check("有 21 级色阶图例", heat.ok && heat.legend === 21, `legend=${heat.legend}`);
  check("热力图横向可滚且默认贴最右（最新）", heat.ok && /auto|scroll/.test(heat.overflowX) && heat.scrolledRight <= 2, JSON.stringify({ overflowX: heat.overflowX, rest: heat.scrolledRight }));
  check("切到热力图后列表已卸载（两视图互斥）", heat.ok && heat.listGone === true);

  step("phase2 click back to list");
  const backClicked = await page(() => {
    const btn = [...document.querySelectorAll(".mem-switch .sw-item")].find((b) => b.textContent.trim() === "列表");
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  });
  await sleep(1000);
  const back = await page(() => {
    try {
      const view = document.querySelector(".mem-view.from-left");
      const sw = document.querySelector(".mem-switch");
      const thumb = sw ? sw.querySelector(".sw-thumb") : null;
      const tf = thumb ? getComputedStyle(thumb).transform : "";
      const m = String(tf).match(/matrix\(([^)]*)\)/);
      const tx = m ? parseFloat(m[1].split(",")[4]) : 0;
      return { ok: true, slideLeft: !!view, tableBack: !!document.querySelector(".mem-table-list"), thumbTx: Math.round(tx) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  check("能点回「列表」选项", backClicked.ok === true, JSON.stringify(backClicked));
  check("切回列表：面板从左侧滑入且表格回来", back.ok && back.slideLeft === true && back.tableBack === true, JSON.stringify(back));
  check("滑块滑回原位", back.ok && back.thumbTx === 0, `tx=${back.thumbTx}`);

  step("phase2 back done");
  console.log("[3] 自动化任务：时间线定高滚动");
  step("phase3 goto auto");
  await gotoPage("自动化任务");
  step("phase3 auto ready");
  step("phase3 timeline");
  const timeline = await page(() => {
    const card = [...document.querySelectorAll(".mem-card")].find((c) => c.textContent.includes("任务时间线"));
    if (!card) return { ok: false, reason: "no-timeline-card" };
    const wrap = card.querySelector(".mem-table-scroll");
    const table = wrap ? wrap.querySelector(".mem-table") : null;
    const th = table ? table.querySelector("thead th") : null;
    const rows = table ? table.querySelectorAll("tbody tr").length : 0;
    const cs = wrap ? getComputedStyle(wrap) : null;
    const tcs = th ? getComputedStyle(th) : null;
    return {
      ok: true,
      hasWrap: !!wrap,
      rows,
      maxHeight: cs ? cs.maxHeight : "",
      overflowY: cs ? cs.overflowY : "",
      boxH: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
      scrollH: wrap ? wrap.scrollHeight : 0,
      clientH: wrap ? wrap.clientHeight : 0,
      thPos: tcs ? tcs.position : "",
    };
  });
  check("时间线在定高滚动容器里（max-height 非 none + overflow auto）",
    timeline.ok && timeline.hasWrap && timeline.maxHeight !== "none" && /auto|scroll/.test(timeline.overflowY),
    JSON.stringify(timeline));
  check("时间线表头粘顶", timeline.ok && timeline.thPos === "sticky", timeline.thPos);
  check("时间线高度未超过设定上限", timeline.ok && timeline.boxH <= 500, `boxH=${timeline.boxH}`);
  step("phase3 timeline overflow");
  const tlOverflow = await page(() => {
    const card = [...document.querySelectorAll(".mem-card")].find((c) => c.textContent.includes("任务时间线"));
    const wrap = card ? card.querySelector(".mem-table-scroll") : null;
    const body = wrap ? wrap.querySelector("tbody") : null;
    if (!wrap || !body) return { ok: false, reason: "no-table" };
    const rows = [...body.querySelectorAll("tr")];
    if (!rows.length) return { ok: false, reason: "no-rows" };
    for (let i = 0; i < 12; i++) rows.forEach((r) => body.appendChild(r.cloneNode(true)));
    return { ok: true, boxH: Math.round(wrap.getBoundingClientRect().height), scrollH: wrap.scrollHeight, clientH: wrap.clientHeight };
  });
  check("时间线灌满后只滚不高（高度仍受限且 scrollHeight > clientHeight）",
    tlOverflow.ok && tlOverflow.boxH <= 500 && tlOverflow.scrollH > tlOverflow.clientH,
    JSON.stringify(tlOverflow));

  step("phase3 timeline done");
  console.log("[4] 窄窗口下的 KPI 降档（6 → 3 → 2 列，不硬挤成一行）");
  step("phase4 narrow window");
  await gotoPage("仪表盘"); // 量之前先切回仪表盘：v-show 隐藏页的元素 rect 全为 0
  win.setSize(1080, 900);
  await sleep(900);
  const narrowCols = await page(() => {
    const grid = document.querySelector(".mem-grid-kpi");
    if (!grid) return { ok: false };
    const cards = [...grid.querySelectorAll(".mem-kpi")];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    return {
      ok: true,
      visible: cards.length > 0 && cards[0].getBoundingClientRect().width > 0,
      cols: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      rows: new Set(tops).size,
      minW: Math.round(Math.min(...cards.map((c) => c.getBoundingClientRect().width))),
    };
  });
  check("1080 窗口下 KPI 降为 2 列 2 行（不硬挤一行）",
    narrowCols.ok && narrowCols.visible !== false && narrowCols.cols === 2 && narrowCols.rows === 2 && narrowCols.minW >= 120,
    JSON.stringify(narrowCols));
  win.setSize(1440, 960);
  await sleep(600);

  console.log("[5] 与「用量统计 · 用量趋势」逐项对齐（同款趋势图）");
  step("phase5 goto sync overview");
  const toSync = await page(() => {
    const card = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("用量统计"));
    if (!card) return false;
    card.click();
    return true;
  });
  check("能切到用量统计模块", toSync === true);
  await sleep(1800);
  await gotoPage("总览");
  await sleep(1800);
  step("phase5 read usage trend");
  const usageTrend = await page(() => {
    try {
      const card = [...document.querySelectorAll(".card")].find((c) => c.textContent.includes("用量趋势"));
      if (!card) return { ok: false, reason: "no-usage-trend" };
      const groups = [...card.querySelectorAll(".tabs")];
      const group = groups.find((g) => g.textContent.includes("近七天")) || groups[0];
      const tabs = group ? [...group.querySelectorAll(".tab")] : [];
      const active = tabs.find((t) => t.classList.contains("active"));
      const host = card.querySelector(".chart");
      const cs = host ? getComputedStyle(host) : null;
      const box = host ? host.getBoundingClientRect() : null;
      const tabCs = tabs[0] ? getComputedStyle(tabs[0]) : null;
      const actCs = active ? getComputedStyle(active) : null;
      return {
        ok: true,
        labels: tabs.map((t) => t.textContent.trim()),
        chartH: cs ? cs.height : "",
        chartW: box ? Math.round(box.width) : 0,
        tabH: tabCs ? tabCs.height : "",
        tabRadius: tabCs ? tabCs.borderRadius : "",
        activeBg: actCs ? actCs.backgroundColor : "",
        activeWeight: actCs ? actCs.fontWeight : "",
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  check("用量趋势同一套区间档位作对照（近七天/月/季/半年/年）",
    usageTrend.ok === true && usageTrend.labels.join(",") === "近七天,月,季,半年,年", JSON.stringify(usageTrend));
  check("两张趋势图渲染同高", usageTrend.ok && usageTrend.chartH === trend0.chartH,
    `usage=${usageTrend.chartH} mem=${trend0.chartH}`);
  check("区间按钮几何一致（高度 / 圆角 / 选中态底色 / 字重）",
    usageTrend.ok && usageTrend.tabH === trend0.tabH && usageTrend.tabRadius === trend0.tabRadius
      && usageTrend.activeBg === trend0.activeBg && usageTrend.activeWeight === trend0.activeWeight,
    JSON.stringify({
      usage: { h: usageTrend.tabH, r: usageTrend.tabRadius, bg: usageTrend.activeBg, w: usageTrend.activeWeight },
      mem: { h: trend0.tabH, r: trend0.tabRadius, bg: trend0.activeBg, w: trend0.activeWeight },
    }));

  check("无 JS 运行时报错", errors.length === 0, errors.slice(0, 3).join(" || "));

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  step(`done pass=${pass} fail=${failCount}`);
  clearTimeout(watchdog);
  app.exit(failCount ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("布局校验崩溃：", (e && e.stack) || e);
    app.exit(2);
  }),
);
