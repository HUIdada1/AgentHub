// 反代网关 · ZCode 领取奖励的人机校验（阿里云无痕验证码 V3 · 官方 SDK 实跑）
//
// 设计立场（三案评审裁决）：不实现无头自动求解（happy-dom/jsdom 指纹对抗是灰色地带，
// 一旦被阿里风控标记即整池失效，且 2500+ 行高维护代码）。领取奖励是低频操作，
// 走「内嵌沙箱 BrowserWindow 跑阿里云官方 SDK」：无感验证优先，8s 不过转交互式弹窗。
// 事实基线：zcode-switch captcha.html + src/captcha.js（initAliyunCaptcha /
// startTracelessVerification / success(captchaVerifyParam) 流程逐行对齐）。
"use strict";
const { BrowserWindow, ipcMain } = require("electron");

// 同一时刻只允许一个验证窗（多账号连跑领取时排队，互不取消）
let pending = null;

/** 验证窗页面（内联 HTML：加载阿里云官方 SDK，无感优先、超时或失败转交互式） */
function captchaHtml(sceneId, region, prefix) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ZCode 人机校验</title>
<style>
  html,body{margin:0;background:#0f172a;color:#e2e8f0;font-family:system-ui,"PingFang SC","Microsoft YaHei UI",sans-serif;user-select:none}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px;padding:24px;box-sizing:border-box}
  .icon-wrap{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.25)}
  .dot{width:12px;height:12px;border-radius:50%;background:#38bdf8;animation:pulse 1.2s infinite}
  .dot.ok{background:#22c55e}.dot.err{background:#ef4444}
  @keyframes pulse{50%{opacity:.35}}
  .cap-card{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
  #cap-status{font-size:14px;font-weight:500;color:#f8fafc}
  #cap-detail{font-size:12px;color:#94a3b8;max-width:320px;word-break:break-all;line-height:1.5}
  #cap-btn{margin-top:6px;padding:9px 24px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;font-weight:500;cursor:pointer;box-shadow:0 4px 12px rgba(37,99,235,0.3);transition:all .2s}
  #cap-btn:hover{background:#1d4ed8}
  #cap-btn[hidden]{display:none}
</style></head><body><div class="wrap">
<div class="icon-wrap"><div class="dot" id="cap-dot"></div></div>
<div class="cap-card">
  <div id="cap-status">正在准备人机校验…</div>
  <div id="cap-detail">请在弹出的阿里云验证码界面完成验证</div>
</div>
<div id="cap-holder"></div>
<button id="cap-btn" hidden>点击完成验证</button>
</div>
<script>
  var SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
  var $dot = document.getElementById("cap-dot"), $status = document.getElementById("cap-status"),
      $detail = document.getElementById("cap-detail"), $btn = document.getElementById("cap-btn");
  function status(t, tone){ $status.textContent = t; $dot.className = "dot" + (tone === "ok" ? " ok" : tone === "err" ? " err" : ""); }
  function detail(t){ $detail.textContent = t || ""; }
  var submitted = false, timer = 0;
  function submitParam(param){
    if (submitted || !param) return;
    submitted = true;
    clearTimeout(timer);
    status("校验通过，正在恢复账号…", "ok");
    detail("验证码核销完成，窗口即将自动关闭");
    window.__zcodeCaptchaSubmit(String(param));
  }
  function interactive(why){
    clearTimeout(timer);
    status("请点击下方按钮完成验证");
    detail("无感验证未通过或需交互确认");
    $btn.hidden = false;
    $btn.focus();
    if (why && typeof why === "string") detail(why.slice(0, 120));
  }
  function fail(msg){ status(msg, "err"); detail("可关闭本窗口后重新点击「过码」"); window.__zcodeCaptchaFail(msg); }
  function loadSdk(){
    return new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = SDK_URL;
      s.onload = resolve;
      s.onerror = function(){ reject(new Error("验证码 SDK 加载失败（请检查网络后重试）")); };
      document.head.appendChild(s);
    });
  }
  loadSdk().then(function(){
    window.AliyunCaptchaConfig = { region: ${JSON.stringify(region || "")}, prefix: ${JSON.stringify(prefix || "")} };
    status("正在进行人机校验…");
    window.initAliyunCaptcha({
      SceneId: ${JSON.stringify(sceneId || "")},
      mode: "popup",
      language: "zh-CN",
      showErrorTip: false,
      element: "#cap-holder",
      button: "#cap-btn",
      getInstance: function(instance){
        if (instance && typeof instance.startTracelessVerification === "function") {
          instance.startTracelessVerification();
          timer = setTimeout(function(){ interactive(); }, 4000);
        } else { interactive(); }
      },
      success: function(param){ submitParam(typeof param === "string" ? param : (param && param.captchaVerifyParam)); },
      fail: function(p){ interactive(p); },
      onError: function(p){ interactive(p); }
    });
  }).catch(function(e){ fail(e && e.message || "验证码 SDK 初始化失败"); });
</script></body></html>`;
}

/**
 * 跑一次人机校验，拿 captchaVerifyParam。
 * @param {{sceneId:string, region?:string, prefix?:string}} cfg 上游 client/configs 下发的 captcha 段
 * @param {{forceShow?:boolean}} [opts]
 * @returns {Promise<{ok:true, verifyParam:string, region:string} | {ok:false, message:string}>}
 */
function solveCaptcha(cfg, opts) {
  if (!cfg || !cfg.sceneId) return Promise.resolve({ ok: false, message: "验证码配置缺失（sceneId 为空）" });
  if (pending) {
    return pending.then(() => solveCaptcha(cfg, opts), () => solveCaptcha(cfg, opts)); // 排队：前一个结束后接着跑
  }
  const forceShow = !!(opts && opts.forceShow);
  const run = new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 440,
      height: 380,
      show: forceShow,
      center: true,
      resizable: false,
      maximizable: false,
      alwaysOnTop: forceShow,
      autoHideMenuBar: true,
      title: "ZCode 人机校验（阿里云验证码）",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: require("path").join(__dirname, "zcodeCapturePreload.cjs"),
      },
    });
    if (forceShow) {
      try { win.focus(); } catch { /* 忽略 */ }
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { ipcMain.removeAllListeners("zcode-captcha-submit"); ipcMain.removeAllListeners("zcode-captcha-fail"); } catch { /* 已清 */ }
      try { win.destroy(); } catch { /* 已关 */ }
      resolve(result);
    };
    // 非强制显示时，先等 1.2s，未完成则转显示
    const showTimer = forceShow ? null : setTimeout(() => {
      try { if (!win.isDestroyed() && !settled) { win.show(); win.focus(); } } catch { /* 已关 */ }
    }, 1200);
    ipcMain.once("zcode-captcha-submit", (_e, param) => {
      if (showTimer) clearTimeout(showTimer);
      done({ ok: true, verifyParam: String(param || ""), region: String(cfg.region || "") });
    });
    ipcMain.once("zcode-captcha-fail", (_e, message) => {
      if (showTimer) clearTimeout(showTimer);
      done({ ok: false, message: String(message || "人机校验失败") });
    });
    win.on("closed", () => done({ ok: false, message: "已取消人机校验" }));
    win.webContents.on("did-fail-load", (_e, code, desc) => done({ ok: false, message: `验证页加载失败：${desc || code}` }));
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(captchaHtml(cfg.sceneId, cfg.region, cfg.prefix))}`).catch((e) => done({ ok: false, message: String((e && e.message) || e) }));
  });
  pending = run.finally(() => {
    pending = null;
  });
  return run;
}

module.exports = { solveCaptcha };
