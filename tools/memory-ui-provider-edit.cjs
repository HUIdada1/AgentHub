/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 自定义供应商「编辑」弹窗（v1.54.0 改造）的 DOM/交互校验：
//   ① 供应商列表的启用/停用状态显示（停用行 chip + is-off 弱化 + 行尾 40×22 开关）；
//   ② 「编辑」弹窗形态：头部名称输入 + 启用开关、Base URL / API 格式下拉 / API Key（眼睛）/ 备注；
//   ③ 模型列表：每行 模型 ID + 能力 chips + 连接测试/编辑/删除图标按钮 + 启用开关；
//   ④ 模型「编辑」二级小弹窗（显示名/思考强度/标签/优先级/温度/最大Tokens/开关）；
//   ⑤ 关掉二级弹窗主弹窗仍在、行内开关可点；⑥ 全程无 JS 报错。
//
// 用法（必须用 Electron 本体跑，不能加 ELECTRON_RUN_AS_NODE）：
//   ./node_modules/electron/dist/electron.exe tools/memory-ui-provider-edit.cjs
"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");

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
  await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  await sleep(2500);
  const page = (fn, ...args) =>
    win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`, true);

  // 进入记忆中枢 → 配置页
  await page(() => {
    const mem = [...document.querySelectorAll(".module-card")].find((c) => c.textContent.includes("记忆中枢"));
    if (mem) mem.click();
  });
  await sleep(1500);
  await page(() => {
    const btn = [...document.querySelectorAll(".tabs button.tab-config")].find((b) => !b.textContent.includes("完成"));
    if (btn) btn.click();
  });
  await sleep(1800);

  console.log("[1] 供应商列表：启用/停用状态显示");
  const list = await page(() => {
    const rows = [...document.querySelectorAll(".prov-tbl tbody tr")].filter((tr) => tr.querySelector(".actions"));
    return rows.map((tr) => ({
      name: (tr.querySelector(".p-name b") || {}).textContent || "",
      offChip: !!tr.querySelector(".p-name .mem-chip.warn"),
      isOffClass: tr.classList.contains("is-off"),
      switchOn: !!tr.querySelector(".actions .switch.on"),
      switchCount: tr.querySelectorAll(".actions .switch").length,
      hasMore: [...tr.querySelectorAll(".actions .btn-link")].some((b) => b.textContent.includes("查看更多")),
      nameColor: getComputedStyle(tr.querySelector(".p-name b")).color,
    }));
  });
  check("列表渲染出两行供应商（mock）", list.length === 2, JSON.stringify(list.map((r) => r.name)));
  check("操作列不再有「查看更多」按钮", list.every((r) => !r.hasMore), JSON.stringify(list.map((r) => r.hasMore)));
  check("每行行尾一个启用开关", list.every((r) => r.switchCount === 1), JSON.stringify(list.map((r) => r.switchCount)));
  const off = list.find((r) => r.offChip);
  check("停用供应商带「已停用」chip 且行挂 is-off", !!off && off.isOffClass === true && off.switchOn === false, JSON.stringify(off));
  const on = list.find((r) => !r.offChip);
  check("启用供应商开关为 on 且无停用 chip", !!on && on.switchOn === true && on.isOffClass === false, JSON.stringify(on));
  check("停用行名称文字被弱化（颜色与启用行不同）", !!off && !!on && off.nameColor !== on.nameColor, `${off && off.nameColor} vs ${on && on.nameColor}`);

  console.log("[2] 「编辑」弹窗：示例图形态（连接信息 + 模型列表）");
  await page(() => {
    const rows = [...document.querySelectorAll(".prov-tbl tbody tr")].filter((tr) => tr.querySelector(".actions"));
    const edit = [...rows[0].querySelectorAll(".btn-link")].find((b) => b.textContent.trim() === "编辑");
    if (edit) edit.click();
  });
  await sleep(900);
  const dlg = await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => getComputedStyle(x).display !== "none" && x.querySelector(".prov-edit-head"));
    if (!d) return null;
    const nameInput = d.querySelector(".prov-name-input");
    const keyRow = d.querySelector(".prov-key-row");
    const rows = [...d.querySelectorAll(".pm-row")];
    const firstRow = rows[0];
    return {
      name: nameInput ? nameInput.value : "",
      headSwitch: !!d.querySelector(".prov-edit-head .switch"),
      headIcon: !!d.querySelector(".prov-edit-icon"),
      inputs: [...d.querySelectorAll(".f-input")].length,
      formatSelect: d.querySelectorAll(".f-el-select").length,
      formatText: (d.querySelector(".f-el-select") || {}).textContent || "",
      keyEye: !!keyRow && !!keyRow.querySelector(".icon-btn i"),
      keyType: keyRow ? keyRow.querySelector("input.f-input").type : "",
      models: rows.length,
      rowNames: rows.map((r) => (r.querySelector(".pm-name") || {}).textContent || ""),
      rowChips: rows.map((r) => [...r.querySelectorAll(".pm-caps .mem-chip")].map((c) => c.textContent.trim())),
      rowIcons: rows.map((r) => r.querySelectorAll(".pm-ops .btn-link i").length),
      rowSwitch: rows.map((r) => r.querySelectorAll(".pm-ops .switch").length),
      addBtn: [...d.querySelectorAll("button")].some((b) => b.textContent.includes("添加模型")),
      fetchBtn: [...d.querySelectorAll("button")].some((b) => b.textContent.includes("自动拉取模型")),
      footSave: [...d.querySelectorAll(".md-foot button")].some((b) => b.textContent.includes("保存")),
      rowOff: rows.map((r) => r.classList.contains("is-off")),
    };
  });
  check("编辑弹窗打开且头部含名称输入框", !!dlg && dlg.name.length > 0, JSON.stringify(dlg && dlg.name));
  check("头部有供应商图标与启用开关", !!dlg && dlg.headIcon && dlg.headSwitch, JSON.stringify(dlg && { i: dlg.headIcon, s: dlg.headSwitch }));
  check("Base URL / API Key / 备注三个输入框", !!dlg && dlg.inputs === 3, JSON.stringify(dlg && dlg.inputs));
  check("API 格式为下拉（el-select）且带端点路径", !!dlg && dlg.formatSelect === 1 && /Chat Completions|Anthropic/.test(dlg.formatText), dlg && dlg.formatText);
  check("API Key 行有显示/隐藏眼睛按钮且默认 password", !!dlg && dlg.keyEye === true && dlg.keyType === "password", JSON.stringify(dlg && { e: dlg.keyEye, t: dlg.keyType }));
  check("模型列表渲染该供应商两个模型", !!dlg && dlg.models === 2 && dlg.rowNames.includes("claude-3-5-sonnet"), JSON.stringify(dlg && dlg.rowNames));
  check("每行右侧三个图标按钮（测试/编辑/删除）", !!dlg && dlg.rowIcons.every((n) => n === 3), JSON.stringify(dlg && dlg.rowIcons));
  check("每行行尾一个启用开关", !!dlg && dlg.rowSwitch.every((n) => n === 1), JSON.stringify(dlg && dlg.rowSwitch));
  const caps = (dlg && dlg.rowChips) || [];
  check("模型行显示上下文/视觉 chips（1M、200K、视觉）", caps.some((c) => c.includes("1M")) && caps.some((c) => c.includes("200K")) && caps.some((c) => c.includes("视觉")), JSON.stringify(caps));
  check("停用模型行被弱化（is-off）", !!dlg && dlg.rowOff.filter(Boolean).length === 1, JSON.stringify(dlg && dlg.rowOff));
  check("「＋ 添加模型」「自动拉取模型」按钮在列", !!dlg && dlg.addBtn && dlg.fetchBtn, JSON.stringify(dlg && { a: dlg.addBtn, f: dlg.fetchBtn }));
  check("底部保留「保存」按钮", !!dlg && dlg.footSave, JSON.stringify(dlg && dlg.footSave));

  console.log("[3] 眼睛按钮切换 Key 明文/掩码");
  const eye = await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => x.querySelector(".prov-edit-head"));
    const btn = d.querySelector(".prov-key-row .icon-btn");
    btn.click();
    return new Promise((resolve) => setTimeout(() => {
      resolve({ type: d.querySelector(".prov-key-row input.f-input").type, cls: d.querySelector(".prov-key-row .icon-btn i").className });
    }, 250));
  });
  check("点击后输入框变 text 且图标换 eye-slash", eye.type === "text" && eye.cls.includes("eye-slash"), JSON.stringify(eye));

  console.log("[4] 模型行「编辑」→ 二级小弹窗");
  await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => x.querySelector(".prov-edit-head"));
    const rows = [...d.querySelectorAll(".pm-row")];
    const editBtn = [...rows[0].querySelectorAll(".pm-ops .btn-link")][1];
    editBtn.click();
  });
  await sleep(800);
  const modelDlg = await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => (x.querySelector(".md-title") || {}).textContent && x.querySelector(".md-title").textContent.includes("编辑模型"));
    if (!d) return null;
    return {
      title: d.querySelector(".md-title").textContent.trim(),
      inputs: d.querySelectorAll(".f-input").length,
      selects: d.querySelectorAll(".f-el-select").length,
      switch: !!d.querySelector(".switch"),
      tagsHint: (d.querySelector(".mem-hint") || {}).textContent || "",
      foot: [...d.querySelectorAll(".md-foot button")].map((b) => b.textContent.trim()),
    };
  });
  check("二级弹窗标题为「编辑模型 · xxx」", !!modelDlg && modelDlg.title.includes("claude-3-5-sonnet"), modelDlg && modelDlg.title);
  check("含显示名/优先级/温度/最大Tokens 输入框（≥4）与思考强度下拉", !!modelDlg && modelDlg.inputs >= 4 && modelDlg.selects >= 1, JSON.stringify(modelDlg && { i: modelDlg.inputs, s: modelDlg.selects }));
  check("含启用开关与可用标签提示", !!modelDlg && modelDlg.switch === true && modelDlg.tagsHint.includes("可用标签"), JSON.stringify(modelDlg && { s: modelDlg.switch, h: modelDlg.tagsHint.slice(0, 20) }));
  check("二级弹窗底部为保存/取消", !!modelDlg && modelDlg.foot.join("/") === "保存/取消", JSON.stringify(modelDlg && modelDlg.foot));

  console.log("[5] 关闭二级弹窗后主弹窗仍在；行内开关可点");
  await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => (x.querySelector(".md-title") || {}).textContent && x.querySelector(".md-title").textContent.includes("编辑模型"));
    [...d.querySelectorAll(".md-foot button")].find((b) => b.textContent.trim() === "取消").click();
  });
  await sleep(700);
  const stillOpen = await page(() => {
    // Element Plus 关闭弹窗时把 .el-overlay 设为 display:none，dialog 自身仍是 block —— 用 rects 判真实可见
    const visible = (x) => x.getClientRects().length > 0 && !!(x.closest(".el-overlay") || {}).getClientRects().length;
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => visible(x) && x.querySelector(".prov-edit-head"));
    const modelDlgOpen = [...document.querySelectorAll(".el-dialog.mem-dialog")].some(
      (x) => visible(x) && (x.querySelector(".md-title") || {}).textContent && x.querySelector(".md-title").textContent.includes("编辑模型"),
    );
    return { stillOpen: !!d, modelDlgOpen };
  });
  check("关闭二级弹窗后供应商编辑弹窗仍在", stillOpen.stillOpen === true && stillOpen.modelDlgOpen === false, JSON.stringify(stillOpen));
  const toggled = await page(() => {
    const d = [...document.querySelectorAll(".el-dialog.mem-dialog")].find((x) => x.querySelector(".prov-edit-head"));
    const sw = d.querySelector(".pm-row .pm-ops .switch");
    const before = sw.classList.contains("on");
    sw.click();
    return new Promise((resolve) => setTimeout(() => resolve({ before }), 400));
  });
  check("模型行开关可点击（无异常）", typeof toggled.before === "boolean", JSON.stringify(toggled));

  console.log("[6] 运行期无 JS 报错");
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
