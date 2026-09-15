// 反代网关 · 事件广播：请求完成 / OAuth 结果等推送到渲染层（app:event，与更新推送同通道）
"use strict";

let electronWindows = null;
try {
  electronWindows = require("electron").BrowserWindow;
} catch { /* 纯 Node 自测环境 */ }

function emit(payload) {
  if (!electronWindows) return;
  try {
    for (const win of electronWindows.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
    }
  } catch { /* 无窗口时静默 */ }
}

module.exports = { emit };
