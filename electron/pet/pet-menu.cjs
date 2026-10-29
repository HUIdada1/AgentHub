/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 桌宠模块 · 右键菜单
//
// 用 Electron 原生 Menu 而不是渲染层自绘 HTML 菜单，理由：
//   1. 桌宠窗口可能只有 200px 见方，HTML 菜单会被窗口裁掉；原生菜单不受窗口尺寸限制；
//   2. 窗口默认「点击穿透」，要原生菜单只需把窗口切成可交互——自绘菜单还得处理"菜单超出窗口后
//      鼠标离开窗口 → 穿透恢复 → 菜单点不到"这一整套竞态；
//   3. 用户对系统菜单的视觉与键盘操作预期天然一致。
//
// 菜单项按 pet.rightMenu.* 动态显隐（用户可在「设置 · 桌宠组件」里自定义右击功能）。
"use strict";
const { Menu } = require("electron");
const petConfig = require("./pet-config.cjs");
const petActions = require("./pet-actions.cjs");

/** 由 index.cjs 注入：把配置改动应用到窗口 */
let applyConfigFn = () => {};
function setApplyConfig(fn) {
  if (typeof fn === "function") applyConfigFn = fn;
}

const SIZE_PRESETS = [
  { label: "小（180 px）", size: 180 },
  { label: "中（240 px）", size: 240 },
  { label: "大（360 px）", size: 360 },
  { label: "特大（520 px）", size: 520 },
];

/** 改配置并应用到窗口（菜单里的勾选项都走它） */
function patchAndApply(patch) {
  try {
    const next = petConfig.patch(patch, { silent: true });
    applyConfigFn(next);
    return next;
  } catch (e) {
    petActions.notify("卡冈图雅", `设置保存失败：${String((e && e.message) || e)}`);
    return null;
  }
}

/**
 * 构建并弹出菜单。
 * @param {BrowserWindow} win 桌宠窗口
 * @param {{ x?: number, y?: number, hwnd?: any }} opts x/y 为相对窗口的 DIP 坐标；hwnd 为弹菜单前的目标窗口
 */
function popup(win, opts = {}) {
  const cfg = petConfig.get();
  const usage = petActions.usageToday();
  const items = [];

  // ① 今日 token 用量：直接以只读行展示（点开面板反而多一步），成本/条数在提示里
  if (cfg.rightMenu.tokenUsage) {
    items.push({ label: usage.text, enabled: false });
    items.push({ type: "separator" });
  }

  // ② 优化提示词
  if (cfg.rightMenu.optimizePrompt) {
    items.push({
      label: "优化提示词（读当前输入框）",
      enabled: true,
      click: () => {
        // 不 await：菜单回调用 async 会让 Electron 认为 click 未完成；错误已在动作内部通知
        petActions.optimizePrompt({ hwnd: opts.hwnd }).catch(() => {});
      },
    });
  }

  // ③ 外观：大小 / 置顶 / 透明度
  items.push({
    label: "大小",
    submenu: SIZE_PRESETS.map((p) => ({
      label: p.label,
      type: "radio",
      checked: Math.abs(cfg.size - p.size) < 8,
      click: () => patchAndApply({ size: p.size }),
    })),
  });
  items.push({
    label: "置顶显示",
    type: "checkbox",
    checked: !!cfg.alwaysOnTop,
    click: () => patchAndApply({ alwaysOnTop: !cfg.alwaysOnTop }),
  });
  items.push({
    label: "特效（引力扭曲 + 屏幕采样）",
    type: "checkbox",
    checked: !!cfg.fxEnabled,
    // 关掉特效 = 不建采样流、不做畸变，GPU/CPU 立刻降下来（低配机器 / 远程桌面场景）
    click: () => patchAndApply({ fxEnabled: !cfg.fxEnabled }),
  });

  items.push({ type: "separator" });

  // ④ 隐藏 / 重置位置
  if (cfg.rightMenu.hide) {
    items.push({ label: "隐藏桌宠", click: () => petActions.actions.hide() });
  }
  if (cfg.rightMenu.resetPosition) {
    items.push({ label: "重置位置", click: () => petActions.actions.resetPosition() });
  }

  // ⑤ 关闭桌宠（真关：窗口销毁 + 总开关置 false；下次在「设置 · 桌宠组件」里重新打开）
  if (cfg.rightMenu.closePet) {
    items.push({ type: "separator" });
    items.push({
      label: "关闭桌宠",
      click: () => petActions.actions.closePet(),
    });
  }

  const menu = Menu.buildFromTemplate(items);
  try {
    menu.popup({ window: win, x: Math.round(opts.x || 0), y: Math.round(opts.y || 0) });
  } catch {
    // 窗口已销毁 / 坐标越界时退回不定位弹出（仍能操作）
    try { menu.popup({ window: win }); } catch { /* 窗口没了 */ }
  }
  return menu;
}

module.exports = { popup, setApplyConfig, SIZE_PRESETS };
