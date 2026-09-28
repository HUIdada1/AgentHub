// ZCode 验证码沙箱窗的 preload 桥：页面里 success 回调拿到 captchaVerifyParam 后，
// 经 contextBridge + ipcRenderer 回传主进程（zcodeCapture.cjs 的 solveCaptcha）。
// 沙箱 + contextIsolation，页面（阿里云官方 SDK）拿不到 node 能力，仅暴露两个提交函数。
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__zcodeCaptchaSubmit", (param) => {
  if (param) ipcRenderer.send("zcode-captcha-submit", String(param));
});

contextBridge.exposeInMainWorld("__zcodeCaptchaFail", (message) => {
  ipcRenderer.send("zcode-captcha-fail", String(message || "人机校验失败"));
});
