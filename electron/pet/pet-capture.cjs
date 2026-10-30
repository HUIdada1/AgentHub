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
// 桌宠模块 · 屏幕捕获源代理
//
// 渲染层不能直接调 desktopCapturer（它在主进程/预加载里才有），
// 且「拍哪块屏」必须由主进程按窗口所在显示器决定 —— 多屏下窗口在副屏时，
// 抓到主屏画面会让黑洞里的桌面与背后真实桌面错位。
"use strict";
const { desktopCapturer, screen } = require("electron");

/**
 * 取窗口所在显示器的捕获源。
 * @param {object} opts
 * @param {number} [opts.displayId] 显示器 id（不传则按窗口位置反查）
 * @param {{x:number,y:number,width:number,height:number}} [opts.windowBounds] 窗口 bounds（DIP）
 * @returns {Promise<{ok:boolean, sourceId?:string, displayId?:string, message?:string}>}
 */
async function getScreenSource(opts = {}) {
  try {
    let displayId = opts.displayId;
    if (!displayId && opts.windowBounds) {
      const b = opts.windowBounds;
      const d = screen.getDisplayNearestPoint({
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
      });
      displayId = d && d.id;
    }
    // thumbnailSize 必填（Electron 25+ 不给会抛错）：只要 1x1，我们不使用缩略图，
    // 建流用的 chromeMediaSourceId 与缩略图无关
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    if (!sources || !sources.length) {
      return { ok: false, message: "系统拒绝提供屏幕捕获源（可能缺少屏幕录制权限）" };
    }
    // 多屏下「匹配不到窗口所在显示器」不能静默退回 sources[0]：那会把另一块屏的画面
    // 采进黑洞（与背后真实桌面错位），而且渲染层以为成功、永远不会降级。
    // 只有 Electron 不提供 display_id（老版本）时才允许退回首个源。
    const hasDisplayIds = sources.some((s) => s.display_id != null && s.display_id !== "");
    const matched =
      hasDisplayIds && displayId != null
        ? sources.find((s) => String(s.display_id) === String(displayId))
        : null;
    if (hasDisplayIds && displayId != null && !matched) {
      return { ok: false, message: `未找到窗口所在显示器的捕获源（display_id=${displayId}）` };
    }
    const hit = matched || sources[0];
    return { ok: true, sourceId: hit.id, displayId: String(hit.display_id || displayId || "") };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = { getScreenSource };
