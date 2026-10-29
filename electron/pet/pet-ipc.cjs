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
// 桌宠模块 · IPC 注册（两条通道族，互不相通）
//
//  A. 主窗口通道（pet_status / pet_config_save / ...）：
//     由「设置 · 桌宠组件」页调用，通道名已登记在 electron/preload.cjs 的 ALLOWED_COMMANDS。
//  B. 桌宠窗口聚合通道（pet:ipc 单向 / pet:rpc 请求响应）：
//     只有桌宠窗口的 webContents 能用（isPetSender 校验），按 msg.type 分派。
//     收敛成两条是为了让主窗口白名单只需要 6 条，而不是把 12 个渲染层能力全铺开。
"use strict";

/** 统一信封：任何异常都转成 { ok:false, message }，绝不让异常穿透（穿透后渲染层只能看到一串 invoke 错误） */
function wrap(fn) {
  return async (_e, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  };
}

/**
 * @param {import("electron").IpcMain} ipcMain
 * @param {{
 *   mainHooks: {
 *     status: Function, saveConfig: Function, setEnabled: Function,
 *     resetPosition: Function, usageToday: Function, optimizePreview: Function
 *   },
 *   petHooks: {
 *     isSender: (event: any) => boolean,
 *     ipc: (type: string, payload: object, event: any) => void,
 *     rpc: (type: string, payload: object, event: any) => Promise<any>
 *   }
 * }} hooks
 */
function register(ipcMain, hooks) {
  const main = hooks.mainHooks || {};
  const pet = hooks.petHooks || {};

  // ===== A. 主窗口（设置面板）=====
  const h = (channel, fn) => {
    if (typeof fn !== "function") return;
    ipcMain.handle(channel, wrap(fn));
  };
  h("pet_status", () => main.status());
  h("pet_config_save", (args) => main.saveConfig(args.patch));
  h("pet_set_enabled", (args) => main.setEnabled(!!args.enabled));
  h("pet_reset_position", () => main.resetPosition());
  h("pet_usage_today", () => main.usageToday());
  h("pet_optimize_preview", () => main.optimizePreview());

  // ===== B. 桌宠窗口聚合通道 =====
  ipcMain.on("pet:ipc", (event, msg) => {
    try {
      if (!pet.isSender || !pet.isSender(event)) return;
      const type = String((msg && msg.type) || "");
      if (!type) return;
      pet.ipc(type, (msg && msg.payload) || {}, event);
    } catch {
      /* 单向通道吞错：渲染层的鼠标事件不该让主进程抛异常 */
    }
  });
  ipcMain.handle("pet:rpc", async (event, msg) => {
    try {
      if (!pet.isSender || !pet.isSender(event)) return { ok: false, message: "未授权的调用来源" };
      const type = String((msg && msg.type) || "");
      if (!type) return { ok: false, message: "缺少消息类型" };
      return await pet.rpc(type, (msg && msg.payload) || {}, event);
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
