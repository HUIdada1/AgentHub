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

/** 验证窗页面（内联 HTML：加载阿里云官方 SDK，无感优先、8s 超时转按钮触发交互式） */
function captchaHtml(sceneId, region, prefix) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>人机校验</title>
<style>
  html,body{margin:0;background:#0b0d0f;color:#cfd8e3;font-family:system-ui,"Microsoft YaHei UI",sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px}
  .dot{width:10px;height:10px;border-radius:50%;background:#5aa2ff;animation:pulse 1.2s infinite}
  .dot.ok{background:#44e07f}.dot.err{background:#f26d6d}
  @keyframes pulse{50%{opacity:.35}}
  #cap-status{font-size:14px}
  #cap-detail{font-size:12px;color:#7c8794;max-width:320px;text-align:center;word-break:break-all}
  #cap-btn{padding:8px 22px;border:none;border-radius:8px;background:#5aa2ff;color:#fff;font-size:14px;cursor:pointer}
  #cap-btn[hidden]{display:none}
</style></head><body><div class="wrap">
<div class="dot" id="cap-dot"></div>
<div id="cap-status">正在准备人机校验…</div>
<div id="cap-detail"></div>
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
    status("校验通过，正在领取…", "ok");
    window.__zcodeCaptchaSubmit(String(param));
  }
  function interactive(why){
    clearTimeout(timer);
    status("无感验证未通过，请点击下方按钮完成验证");
    $btn.hidden = false;
    $btn.focus();
    if (why) detail(typeof why === "string" ? why.slice(0, 120) : "");
  }
  function fail(msg){ status(msg, "err"); window.__zcodeCaptchaFail(msg); }
  function loadSdk(){
    return new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = SDK_URL;
      s.onload = resolve;
      s.onerror = function(){ reject(new Error("验证码 SDK 加载失败（检查网络后重试）")); };
      document.head.appendChild(s);
    });
  }
  loadSdk().then(function(){
    window.AliyunCaptchaConfig = { region: ${JSON.stringify(region || "")}, prefix: ${JSON.stringify(prefix || "")} };
    status("正在进行无感验证…");
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
          timer = setTimeout(function(){ interactive(); }, 8000);
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
 * @returns {Promise<{ok:true, verifyParam:string, region:string} | {ok:false, message:string}>}
 */
function solveCaptcha(cfg) {
  if (!cfg || !cfg.sceneId) return Promise.resolve({ ok: false, message: "验证码配置缺失（sceneId 为空）" });
  if (pending) {
    return pending.then(() => solveCaptcha(cfg), () => solveCaptcha(cfg)); // 排队：前一个结束后接着跑
  }
  const run = new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 420,
      height: 360,
      show: false,
      autoHideMenuBar: true,
      title: "ZCode 人机校验",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 沙箱窗只跑阿里云官方 SDK，不注入任何 node 能力；结果经 ipc 通道回传
        preload: require("path").join(__dirname, "zcodeCapturePreload.cjs"),
      },
    });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { ipcMain.removeAllListeners("zcode-captcha-submit"); ipcMain.removeAllListeners("zcode-captcha-fail"); } catch { /* 已清 */ }
      try { win.destroy(); } catch { /* 已关 */ }
      resolve(result);
    };
    // 无感验证可能直接通过：窗口先隐藏，8s 内如果页面还在跑（未 submit）说明转交互式，显示出来
    const showTimer = setTimeout(() => {
      try { if (!win.isDestroyed() && !settled) win.show(); } catch { /* 已关 */ }
    }, 1200);
    ipcMain.once("zcode-captcha-submit", (_e, param) => {
      clearTimeout(showTimer);
      done({ ok: true, verifyParam: String(param || ""), region: String(cfg.region || "") });
    });
    ipcMain.once("zcode-captcha-fail", (_e, message) => {
      clearTimeout(showTimer);
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
