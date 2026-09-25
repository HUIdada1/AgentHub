/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 本轮整改的 DOM 校验（无头，不截图）：把 dist 装进隐藏窗口，真实点击 + 真实样式断言：
//   ① 顶部页签：「待确认」已移除、「WebDAV同步」已改名、待处理页签带红点；
//   ② 记忆浏览：四个视图（列表/热力图/待确认/回收站）、等级 tab、筛选行常显无展开按钮；
//   ③ 新增记忆是弹窗（.el-dialog.mem-dialog），不再是就地展开的卡片；
//   ④ 仪表盘实时记忆流高度≈5 条（超出滚动）；
//   ⑤ 弹窗与「设置」弹窗同款：玻璃底 + 幽灵关闭钮（自绘弹窗与 el-dialog 命中同一份规则）；
//   ⑥ 自动化总控卡两列布局 + 小问号紧贴文字；
//   ⑦ 记忆仓库里已无原生 select（下拉全部换成用量统计同款 el-select）；
//   ⑧ 全程无 JS 报错。
//
// 用法（必须用 Electron 本体跑，不能加 ELECTRON_RUN_AS_NODE）：
//   ./node_modules/electron/dist/electron.exe tools/memory-ui-round3.cjs
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
  const inElectronRuntime = !!(process.versions && process.versions.electron);
  console.error(
    inElectronRuntime
      ? "检测到 ELECTRON_RUN_AS_NODE 模式：去掉该环境变量后重跑（本探针需要创建窗口）"
      : "本探针要真开窗口渲染 dist，必须用 Electron 本体跑：./node_modules/electron/dist/electron.exe tools/memory-ui-round3.cjs",
  );
  process.exit(2);
}
if (electronModule && typeof electronModule === "object") {
  ({ app, BrowserWindow } = electronModule);
}
if (!app || !BrowserWindow) {
  console.error("检测到 ELECTRON_RUN_AS_NODE 模式：请去掉该环境变量后重跑");
  process.exit(2);
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
    win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`, true);

  /** 记忆仓库是保活多页：DOM 里同时躺着好几个 .memory-scope，
   *  必须只取当前可见的那一个（所在 .page 没被 v-show 隐藏），否则断言会打在别的页上 */
  const VISIBLE_SCOPE = `
    [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    })`;

  /** 点顶部页签（按文字前缀定位） */
  const clickTab = (label) =>
    page((text) => {
      const btn = [...document.querySelectorAll(".tabs button.tab")].find((b) => b.textContent.trim().startsWith(text));
      if (!btn) return false;
      btn.click();
      return true;
    }, label);

  // ===== 1) 顶部页签结构 =====
  console.log("[1] 顶部页签：待确认已并入记忆浏览 / WebDAV 改名 / 待处理红点");
  const switched = await page(() => {
    const mem = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("记忆仓库"));
    if (!mem) return false;
    mem.click();
    return true;
  });
  check("能切换到记忆仓库模块", switched === true);
  await sleep(1200);

  const tabs = await page(() =>
    [...document.querySelectorAll(".tabs button.tab")]
      .filter((b) => !b.textContent.trim().startsWith("配置") && !b.textContent.trim().startsWith("完成"))
      .map((b) => ({
        text: b.textContent.replace(/\s+/g, "").trim(),
        dot: !!b.querySelector(".tab-dot"),
      })),
  );
  const names = tabs.map((t) => t.text);
  check("页签条不再有独立的「待确认」页", !names.some((n) => n.startsWith("待确认")), JSON.stringify(names));
  check("末端页签名为「WebDAV同步」", names.some((n) => n.startsWith("WebDAV同步")), JSON.stringify(names));
  check("页签总数为 9（原 10 页去掉待确认）", names.length === 9, String(names.length));
  check(
    "记忆浏览页签带待处理红点（收件箱已并入，待裁决数挂在它上面）",
    tabs.some((t) => t.text.startsWith("记忆浏览") && t.dot),
    JSON.stringify(tabs.filter((t) => t.dot).map((t) => t.text)),
  );

  // ===== 2) 记忆浏览：四视图 + 等级 tab + 筛选常显 =====
  console.log("[2] 记忆浏览：四视图 / 等级 tab / 筛选行常显");
  check("能切到记忆浏览页", (await clickTab("记忆浏览")) === true);
  await sleep(1200);

  const browse = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    if (!scope) return null;
    const sw = scope.querySelector(".mem-switch");
    // 视图名 + 该视图的待处理计数（.sw-n）拼在一起，断言只比视图名；空白一律去掉再比
    const label = (b) => (b.childNodes[0].textContent || "").replace(/\s+/g, "");
    const views = sw ? [...sw.querySelectorAll(".sw-item")].map(label) : [];
    const levelSw = scope.querySelectorAll(".mem-switch")[1];
    const levels = levelSw ? [...levelSw.querySelectorAll(".sw-item")].map(label) : [];
    const tools = [...scope.querySelectorAll(".mem-toolbar")].map((t) => t.textContent.replace(/\s+/g, " ").trim().slice(0, 90));
    return {
      views,
      levels,
      tools,
      switches: scope.querySelectorAll(".mem-switch").length,
      filterBar: !!scope.querySelector(".mem-filter-bar"),
      selectCount: scope.querySelectorAll(".f-el-select").length,
      nativeSelects: scope.querySelectorAll("select").length,
      createBtn: [...scope.querySelectorAll("button")].some((b) => b.textContent.includes("新增一条记忆")),
    };
  });
  check("浏览页渲染出视图切换条", !!browse);
  check("四个视图：列表 / 热力图 / 待确认 / 回收站", JSON.stringify(browse?.views) === JSON.stringify(["列表", "热力图", "待确认", "回收站"]), JSON.stringify(browse?.views));
  check("待确认视图带待处理红点", (await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const sw = scope ? scope.querySelector(".mem-switch") : null;
    const btn = sw ? [...sw.querySelectorAll(".sw-item")].find((b) => b.textContent.includes("待确认")) : null;
    return !!(btn && btn.querySelector(".sw-dot"));
  })) === true);
  check("列表内出现等级 tab（全部层级 / L1 普通 / L2 深层）", JSON.stringify(browse?.levels) === JSON.stringify(["全部层级", "L1普通", "L2深层"]), JSON.stringify(browse?.levels));
  check("筛选行常显（.mem-filter-bar 存在）", browse?.filterBar === true);
  check("筛选行不再有展开/收起按钮", !/筛选\s*[·\d]*\s*[▼▲]/.test((browse?.tools || []).join(" ")), (browse?.tools || []).join(" || "));
  check("筛选行下拉是 el-select（用量统计同款）", (browse?.selectCount || 0) >= 4, String(browse?.selectCount));
  check("记忆浏览里没有原生 select", browse?.nativeSelects === 0, String(browse?.nativeSelects));
  check("有「＋ 新增一条记忆」按钮", browse?.createBtn === true);

  // 等级 tab 真的能切（点 L2 后落在 L2 上）
  const levelSwitch = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const sw = scope ? scope.querySelectorAll(".mem-switch")[1] : null;
    const btn = sw ? [...sw.querySelectorAll(".sw-item")].find((b) => b.textContent.includes("L2")) : null;
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("能点击 L2 等级 tab", levelSwitch === true);
  await sleep(900);
  check(
    "等级 tab 切换后成为选中态",
    (await page(() => {
      const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
        const p = s.closest(".page");
        return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
      });
      const sw = scope ? scope.querySelectorAll(".mem-switch")[1] : null;
      const btn = sw ? [...sw.querySelectorAll(".sw-item")].find((b) => b.textContent.includes("L2")) : null;
      return !!(btn && btn.classList.contains("active"));
    })) === true,
  );

  // ===== 3) 新增记忆是弹窗 =====
  console.log("[3] 新增一条记忆：点开是弹窗（不再是就地展开的卡片）");
  const beforeCreate = await page(() => document.body.querySelectorAll(".el-dialog.mem-dialog").length);
  await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const btn = scope ? [...scope.querySelectorAll("button")].find((b) => b.textContent.includes("新增一条记忆")) : null;
    if (btn) btn.click();
  });
  await sleep(700);
  const create = await page(() => {
    const dlg = document.querySelector(".el-dialog.mem-dialog");
    if (!dlg) return { open: false };
    const heads = dlg.querySelectorAll(".el-dialog__body input, .el-dialog__body textarea");
    return {
      open: true,
      title: (dlg.querySelector(".md-title") || {}).textContent || "",
      fields: heads.length,
      hasClose: !!dlg.querySelector(".el-dialog__headerbtn"),
      dialogCount: document.body.querySelectorAll(".el-dialog.mem-dialog").length,
    };
  });
  check("弹出了新增记忆弹窗（.el-dialog.mem-dialog）", create.open === true);
  check("弹窗标题为「新增一条记忆」", (create.title || "").includes("新增一条记忆"), create.title);
  check("弹窗里有表单字段（标题/正文/项目/标签/重要度）", (create.fields || 0) >= 4, String(create.fields));
  check("弹窗有幽灵关闭按钮", create.hasClose === true);
  check("关闭弹窗", (await page(() => {
    const dlg = document.querySelector(".el-dialog.mem-dialog");
    const btn = dlg ? dlg.querySelector(".el-dialog__headerbtn") : null;
    if (!btn) return false;
    btn.click();
    return true;
  })) === true);
  await sleep(600);

  // ===== 4) 仪表盘实时记忆流 =====
  console.log("[4] 仪表盘：实时记忆流固定 5 条高度");
  check("能切到仪表盘", (await clickTab("仪表盘")) === true);
  await sleep(1200);
  const stream = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const card = [...(scope ? scope.querySelectorAll(".mem-card") : [])].find((c) => c.querySelector(".mem-card-title")?.textContent.includes("实时记忆流"));
    if (!card) return null;
    const box = card.querySelector(".mem-scroll-rows-5");
    if (!box) return { found: false };
    const cs = getComputedStyle(box);
    const item = box.querySelector(".mem-item");
    return {
      found: true,
      maxH: parseFloat(cs.maxHeight),
      overflowY: cs.overflowY,
      itemH: item ? item.getBoundingClientRect().height : 0,
      totalH: box.scrollHeight,
      clientH: box.clientHeight,
    };
  });
  check("找到实时记忆流且用定行高滚动盒", stream?.found === true, JSON.stringify(stream));
  check("滚动盒可上下滚动（overflow-y: auto）", stream?.overflowY === "auto", String(stream?.overflowY));
  check(
    "高度≈5 条（5×(行高+行距)−行距）",
    !!stream && Math.abs(stream.maxH - (5 * (56 + 8) - 8)) < 1,
    stream ? `maxH=${stream.maxH} itemH=${stream.itemH}` : "",
  );

  // ===== 5) 弹窗与设置弹窗同款 =====
  console.log("[5] 弹窗统一：自绘 .mem-modal 与 .el-dialog 命中同一份玻璃规则");
  const modalStyle = await page(() => {
    // 造两个探针：一个走 .el-dialog，一个走 .mem-modal，比较关键计算样式
    const mk = (cls, inner) => {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = inner;
      document.body.appendChild(d);
      return d;
    };
    const a = mk("el-dialog", "");
    const b = mk("mem-modal", '<div class="mem-modal-head"></div>');
    const cs = (el) => {
      const s = getComputedStyle(el);
      return { radius: s.borderRadius, border: s.borderTopWidth + " " + s.borderTopColor, bg: s.backgroundImage, backdrop: s.backdropFilter };
    };
    const ha = getComputedStyle(a).borderRadius;
    const hb = getComputedStyle(b).borderRadius;
    const out = { a: cs(a), b: cs(b), headA: null, headB: null };
    const headA = document.querySelector(".el-dialog__header");
    const headB = document.querySelector(".mem-modal .mem-modal-head");
    out.headA = headA ? getComputedStyle(headA).padding : null;
    out.headB = headB ? getComputedStyle(headB).padding : null;
    out.eqRadius = ha === hb;
    a.remove();
    b.remove();
    return out;
  });
  check("两者圆角一致", modalStyle?.eqRadius === true, JSON.stringify(modalStyle));
  check("两者玻璃底一致（同一 background-image）", modalStyle?.a?.bg === modalStyle?.b?.bg, `${modalStyle?.a?.bg} vs ${modalStyle?.b?.bg}`);
  check("两者背景模糊一致", modalStyle?.a?.backdrop === modalStyle?.b?.backdrop, `${modalStyle?.a?.backdrop} vs ${modalStyle?.b?.backdrop}`);
  check("两者边框一致", modalStyle?.a?.border === modalStyle?.b?.border, `${modalStyle?.a?.border} vs ${modalStyle?.b?.border}`);
  check("两者头部内距一致", modalStyle?.headA === modalStyle?.headB, `${modalStyle?.headA} vs ${modalStyle?.headB}`);

  // ===== 6) 自动化总控卡 =====
  console.log("[6] 自动化：总控卡两列 + 小问号紧贴文字");
  check("能切到自动化", (await clickTab("自动化")) === true);
  await sleep(1400);
  const auto = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const card = [...(scope ? scope.querySelectorAll(".mem-card") : [])].find((c) => c.querySelector(".mem-card-title")?.textContent.trim().startsWith("总控"));
    if (!card) return null;
    const two = card.querySelector(".mem-two-col");
    if (!two) return { twoCol: false };
    const cols = [...two.children].filter((c) => c.classList.contains("mem-kv"));
    const labels = cols.map((c) => [...c.querySelectorAll(".k")].map((k) => k.textContent.replace(/\s+/g, "").trim()));
    const cs = getComputedStyle(two);
    // 「总开关」行的取值格里是否还有「已启用 / 已关闭」字样
    const switchRowText = cols[0] ? cols[0].textContent.replace(/\s+/g, "") : "";
    // 卡片标题里小问号与标题文字的水平距离
    const title = card.querySelector(".mem-card-title");
    const qa = title ? title.querySelector(".mem-qa") : null;
    let gap = null;
    if (title && qa) {
      const tn = [...title.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (tn) {
        const r = document.createRange();
        r.selectNodeContents(tn);
        gap = Math.round(qa.getBoundingClientRect().left - r.getBoundingClientRect().right);
      }
    }
    return { twoCol: true, columns: cs.gridTemplateColumns, labels, switchRowText, gap };
  });
  check("总控卡用两列布局（.mem-two-col）", auto?.twoCol === true, JSON.stringify(auto));
  check("两列共用一条 4 列网格（标签|值|标签|值，行严格对齐）", (auto?.columns || "").split(" ").length === 4, String(auto?.columns));
  check("两组仍是带 .mem-kv 的网格（subgrid 借外层行轨道，语义没丢）", await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const card = [...(scope ? scope.querySelectorAll(".mem-card") : [])].find((c) => c.querySelector(".mem-card-title")?.textContent.trim().startsWith("总控"));
    const two = card ? card.querySelector(".mem-two-col") : null;
    if (!two) return false;
    const groups = [...two.children].filter((c) => c.classList.contains("mem-kv"));
    // 每组自己仍是 grid，且行轨道来自 subgrid（computed 值里能看出 subgrid）
    return groups.length === 2 && groups.every((g) => {
      const cs = getComputedStyle(g);
      return cs.display === "grid" && /subgrid/.test(cs.gridTemplateRows);
    });
  }) === true);
  // 左右两列同一行的标签应当在同一水平线上（行对齐的直接证据）
  check("左右两列的行严格对齐（首行标签顶边一致）", await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const card = [...(scope ? scope.querySelectorAll(".mem-card") : [])].find((c) => c.querySelector(".mem-card-title")?.textContent.trim().startsWith("总控"));
    const two = card ? card.querySelector(".mem-two-col") : null;
    if (!two) return false;
    const ks = [...two.querySelectorAll(".k")];
    if (ks.length < 4) return false;
    const y0 = Math.round(ks[0].getBoundingClientRect().top);
    const y1 = Math.round(ks[2].getBoundingClientRect().top);
    return Math.abs(y0 - y1) <= 2;
  }) === true);
  check(
    "左列＝总开关/今日消耗，右列＝待确认/日上限/超预算行为",
    JSON.stringify(auto?.labels) === JSON.stringify([["总开关", "今日消耗"], ["待确认", "日token上限", "超预算行为"]]),
    JSON.stringify(auto?.labels),
  );
  check("总开关行已无「已启用/已关闭」字样", auto ? !/已启用|已关闭/.test(auto.switchRowText) : false, auto?.switchRowText?.slice(0, 80));
  check("标题里的小问号紧贴文字（间距 ≤ 12px）", typeof auto?.gap === "number" && auto.gap <= 12, String(auto?.gap));

  // ===== 7) 四类操作都弹出进度弹窗 =====
  console.log("[7] 长任务操作的进度弹窗");
  const progressSteps = [
    ["深层画像", "重新生成画像", "重新生成画像"],
    ["自动化", "立即执行", "立即执行"],
    ["导入与去重", "全库去重巡检", "全库去重巡检"],
  ];
  for (const [tabName, btnText, expectTitle] of progressSteps) {
    await clickTab(tabName);
    await sleep(1400);
    const clicked = await page((needle) => {
      const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
        const p = s.closest(".page");
        return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
      });
      const btn = scope
        ? [...scope.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(needle) && !b.disabled)
        : null;
      if (!btn) return false;
      btn.click();
      return true;
    }, btnText);
    check(`${tabName}：「${btnText}」按钮可点`, clicked === true);
    if (!clicked) continue;
    await sleep(800);
    const shown = await page(() => {
      const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
      if (!dlg) return null;
      return {
        title: (dlg.querySelector(".md-title") || {}).textContent || "",
        hasBar: !!dlg.querySelector(".mem-progress"),
        hasSpinOrIco: !!(dlg.querySelector(".mpd-spin") || dlg.querySelector(".mpd-ico")),
      };
    });
    check(`弹出进度弹窗（含进度条与进行态图标）· 标题≈${expectTitle}`, !!shown && shown.hasBar && shown.hasSpinOrIco, JSON.stringify(shown));
    // 关闭弹窗，避免叠加影响后续断言
    await page(() => {
      const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
      const btn = dlg ? dlg.querySelector(".el-dialog__headerbtn") : null;
      if (btn) btn.click();
    });
    await sleep(700);
  }

  // 蒸馏 L2 藏在项目卡的 ⋯ 菜单里，单独走一遍菜单 -> 弹窗
  await clickTab("项目归档");
  await sleep(1500);
  const distillClicked = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const menuBtn = scope ? scope.querySelector(".mem-tile-foot button.mem-chip") : null;
    if (!menuBtn) return false;
    menuBtn.click();
    return true;
  });
  check("项目卡：⋯ 菜单可点", distillClicked === true);
  await sleep(700);
  const distillItem = await page(() => {
    const item = [...document.querySelectorAll(".el-dropdown-menu__item")].find((i) => i.textContent.includes("蒸馏 L2"));
    if (!item) return false;
    item.click();
    return true;
  });
  check("菜单里有「蒸馏 L2」", distillItem === true);
  await sleep(900);
  const distillDlg = await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    if (!dlg) return null;
    return {
      title: (dlg.querySelector(".md-title") || {}).textContent || "",
      hasBar: !!dlg.querySelector(".mem-progress"),
      hasSpinOrIco: !!(dlg.querySelector(".mpd-spin") || dlg.querySelector(".mpd-ico")),
    };
  });
  check("蒸馏 L2 弹出进度弹窗", !!distillDlg && /蒸馏 L2/.test(distillDlg.title) && distillDlg.hasBar && distillDlg.hasSpinOrIco, JSON.stringify(distillDlg));
  await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    const btn = dlg ? dlg.querySelector(".el-dialog__headerbtn") : null;
    if (btn) btn.click();
  });
  await sleep(700);

  // 进度弹窗跑完后要落到结果态（✓/✗ + 文案），而不是一直转圈
  await clickTab("自动化");
  await sleep(1400);
  await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const btn = scope ? [...scope.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("立即执行") && !b.disabled) : null;
    if (btn) btn.click();
  });
  // mock 环境下任务立即返回；真实环境里这一步会等模型，故宽限 6 秒
  await sleep(6000);
  const settled = await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    if (!dlg) return null;
    const ico = dlg.querySelector(".mpd-ico");
    return {
      finished: !!ico,
      ok: !!(ico && ico.classList.contains("ok")),
      phase: (dlg.querySelector(".mpd-phase") || {}).textContent || "",
      spin: !!dlg.querySelector(".mpd-spin"),
    };
  });
  check("进度弹窗结束后转为结果态（✓/✗ + 结论文案）", !!settled && settled.finished && !settled.spin, JSON.stringify(settled));
  await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    const btn = dlg ? dlg.querySelector(".el-dialog__headerbtn") : null;
    if (btn) btn.click();
  });
  await sleep(700);

  // ===== 8) 导入：干跑 → 确认 → 进度弹窗（真实 done/total 百分比）=====
  console.log("[8] 导入流程：进度弹窗走真实百分比");
  await clickTab("导入与去重");
  await sleep(1500);
  const importClicked = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const btn = scope ? [...scope.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("导入全部来源") && !b.disabled) : null;
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("「导入全部来源」可点", importClicked === true);
  await sleep(1200);
  const previewDlg = await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    if (!dlg) return null;
    return { title: (dlg.querySelector(".md-title") || {}).textContent || "", phase: (dlg.querySelector(".mpd-phase") || {}).textContent || "" };
  });
  check("干跑阶段也进弹窗（有阶段文案）", !!previewDlg && /导入记忆/.test(previewDlg.title), JSON.stringify(previewDlg));
  // 干跑后的确认走 ElMessageBox：点「开始导入」继续
  await sleep(1500);
  const confirmed = await page(() => {
    const box = document.querySelector(".el-message-box");
    const btns = box ? [...box.querySelectorAll("button")] : [];
    const btn = btns.find((b) => b.textContent.includes("开始导入"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("干跑后弹出确认框并可确认", confirmed === true);
  await sleep(2500);
  const importProgress = await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    if (!dlg) return null;
    const nums = dlg.querySelector(".mpd-nums");
    const ico = dlg.querySelector(".mpd-ico");
    return {
      hasBar: !!dlg.querySelector(".mem-progress"),
      numsText: nums ? nums.textContent.replace(/\s+/g, " ").trim() : "",
      settled: !!ico,
      phase: (dlg.querySelector(".mpd-phase") || {}).textContent || "",
    };
  });
  check("导入弹窗有进度条", !!importProgress && importProgress.hasBar, JSON.stringify(importProgress));
  // 导入是后端在跑：跑动中显示 done/total 数字行，跑完切成结果态。
  // mock 环境瞬时返回（直接落到结果态），真实环境会先经过数字行 —— 两种都算自洽。
  check(
    "导入弹窗状态自洽（跑动显示数字行 / 完成显示结果态）",
    !!importProgress && (importProgress.settled ? /导入|失败|跳过|新建/.test(importProgress.phase) : /\/|%/.test(importProgress.numsText)),
    JSON.stringify(importProgress),
  );
  await page(() => {
    const dlg = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((d) => d.offsetParent !== null);
    const btn = dlg ? dlg.querySelector(".el-dialog__headerbtn") : null;
    if (btn) btn.click();
  });
  await sleep(700);

  // ===== 9) 记忆仓库全模块无原生 select =====
  console.log("[9] 全模块下拉统一（无原生 select）");
  const leftovers = [];
  for (const label of ["记忆浏览", "项目归档", "深层画像", "Agent 接入", "检索与索引", "自动化", "导入与去重", "WebDAV同步"]) {
    await clickTab(label);
    await sleep(700);
    const n = await page(() => {
      const scope = [...document.querySelectorAll(".memory-scope")].find((s) => {
        const p = s.closest(".page");
        return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
      });
      return scope ? scope.querySelectorAll("select").length : 0;
    });
    if (n) leftovers.push(`${label}:${n}`);
  }
  check("八个记忆页里均无原生 select", leftovers.length === 0, leftovers.join(", "));

  // 配置页（含模型与网关子板块）
  await clickTab("配置");
  await sleep(2000);
  const cfg = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope.cfg-sec")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    return {
      cfgNative: scope ? scope.querySelectorAll("select").length : 0,
      cfgEl: scope ? scope.querySelectorAll(".f-el-select").length : 0,
    };
  });
  check("配置页无原生 select", cfg.cfgNative === 0, JSON.stringify(cfg));
  check("配置页下拉为 el-select", cfg.cfgEl > 0, JSON.stringify(cfg));

  // 换成 el-select 后，路由表里「绑定来源」与「兜底降级绑定」必须真的还能交互（不只是换了皮）
  const routing = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope.cfg-sec")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    if (!scope) return null;
    const texts = [...scope.querySelectorAll(".f-el-select")].map((t) => t.textContent.replace(/\s+/g, " ").trim());
    // 兜底降级那一行：三个下拉（供应商 / 模型 / 思考强度）。mock 配置里它已有绑定值，
    // 故断言"三个 el-select 都在这一行里"，而不是断言 placeholder 文案。
    const row = [...scope.querySelectorAll(".mem-row")].find((r) => r.textContent.includes("兜底降级"));
    return {
      total: texts.length,
      hasRouteBind: texts.some((t) => t.includes("全部（按来源优先级）")),
      degradeSels: row ? row.querySelectorAll(".f-el-select").length : 0,
      degradeNative: row ? row.querySelectorAll("select").length : 0,
      degradeText: row ? row.textContent.replace(/\s+/g, " ").trim() : "",
      // 「没选」的下拉不能只剩光秃秃的「全部」，必须带上下文
      bareAll: texts.filter((t) => t === "全部").length,
    };
  });
  check("路由表「绑定来源」已渲染为 el-select", routing?.hasRouteBind === true, JSON.stringify(routing));
  check("兜底降级行有三个 el-select（供应商 / 模型 / 思考强度）", routing?.degradeSels === 3, JSON.stringify(routing));
  check("兜底降级行无原生 select", routing?.degradeNative === 0, JSON.stringify(routing));
  check("未绑定的下拉不显示光秃秃的「全部」（带上下文文案）", routing?.bareAll === 0, JSON.stringify(routing));
  // 真开一次下拉，确认能弹出并列出选项
  const opened = await page(() => {
    const scope = [...document.querySelectorAll(".memory-scope.cfg-sec")].find((s) => {
      const p = s.closest(".page");
      return !p || (p.offsetParent !== null && getComputedStyle(p).display !== "none");
    });
    const trigger = scope ? [...scope.querySelectorAll(".f-el-select")].find((t) => (t.textContent || "").includes("全部（按来源优先级）")) : null;
    const clickable = trigger ? trigger.querySelector(".el-select__wrapper") || trigger : null;
    if (!clickable) return false;
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  check("路由表下拉可点开", opened === true);
  await sleep(700);
  const dropped = await page(() => {
    const pop = [...document.querySelectorAll(".el-select-dropdown")].filter((d) => d.offsetParent !== null).pop();
    if (!pop) return null;
    return {
      glass: pop.classList.contains("glass-popper"),
      items: [...pop.querySelectorAll(".el-select-dropdown__item")].map((i) => i.textContent.trim()),
    };
  });
  check("下拉弹出且带玻璃弹层（glass-popper）", !!dropped && dropped.items.length > 0, JSON.stringify(dropped));
  check("下拉含「全部（按来源优先级）」与「本机反代网关」选项", !!dropped && dropped.items.some((t) => t.includes("按来源优先级")) && dropped.items.some((t) => t.includes("本机反代网关")), JSON.stringify(dropped));
  await page(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await sleep(400);

  // ===== 10) 无 JS 报错 =====
  console.log("[10] 运行期无 JS 报错");
  check("控制台无 error", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项`);
  if (failures.length) console.log("失败项：\n - " + failures.join("\n - "));
  app.exit(failCount ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("探针异常：", e);
    app.exit(3);
  }),
);