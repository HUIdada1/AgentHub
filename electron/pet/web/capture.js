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
// 桌宠渲染层 · 屏幕采样管线（capture.js）
//
// 为什么采样要放在渲染层而不是主进程：
//   MediaStream 对象无法通过 contextBridge 传递，主进程只能给一个 sourceId
//   （见契约 §3 的 captureSource / 内部通道 pet:rpc 的 capture-source）。
//   所以「建流 + 帧同步上传纹理」都在这一层做。
//
// 关键实现点（规格 §2 / §7）：
//   1. 建流用 getUserMedia + chromeMediaSource 约束，分辨率 = 显示器物理尺寸 * 0.5
//      （黑洞只占屏幕很小一块，半分辨率足够，省一半带宽）；
//   2. 上传纹理用 requestVideoFrameCallback 跟视频帧同步，**不是每帧无条件 texImage2D**；
//      rVFC 不可用时回退成按 captureFps 节流的 setInterval；
//   3. 首帧 1.5s 超时 / 建流失败 → onFail 回调，由 renderer 把 u_useScreen 置 0 走程序化星空，
//      **绝不让桌宠白屏**；
//   4. 窗口隐藏 / document.hidden 时 pause() 会暂停 video 与帧回调，恢复时 resume()；
//   5. 是否建流由调用方（app.js）按 fxEnabled && screenSample 决定 —— 本文件被创建就代表"要采"。
//
// 可调参数：
//   FIRST_FRAME_TIMEOUT_MS  首帧超时（毫秒）。电脑忙/远程桌面时可见的首帧可能偏慢，调大更宽容
//   MIN_FPS / MAX_FPS      采样帧率钳制范围（配置允许 15/30/60）
//   UPLOAD_ERROR_LIMIT      连续上传失败多少次后记一条日志（避免日志刷屏）
"use strict";
window.PetCapture = (function () {
  const CONST = {
    FIRST_FRAME_TIMEOUT_MS: 1500,
    MIN_FPS: 15,
    MAX_FPS: 60,
    UPLOAD_ERROR_LIMIT: 5,
  };

  function clamp(v, min, max) {
    const n = typeof v === "number" && isFinite(v) ? v : min;
    return Math.min(max, Math.max(min, n));
  }

  function describe(e) {
    if (!e) return "";
    if (e instanceof Error) return e.name + ": " + e.message;
    try {
      return String(e);
    } catch (e2) {
      return "unknown";
    }
  }

  /**
   * @param {{
   *   host: object,
   *   log?: (kind: string, detail: string) => void,
   *   fps?: number,
   *   maxWidth?: number,
   *   maxHeight?: number,
   *   onFrame: (video: HTMLVideoElement) => boolean,
   *   onReady?: () => void,
   *   onFail?: (reason: string, detail?: string) => void
   * }} opts
   */
  function create(opts) {
    const options = opts || {};
    const log = typeof options.log === "function" ? options.log : function () {};
    const host = options.host || null;
    const onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
    const onReady = typeof options.onReady === "function" ? options.onReady : function () {};
    const onFail = typeof options.onFail === "function" ? options.onFail : function () {};

    const config = {
      fps: clamp(options.fps, CONST.MIN_FPS, CONST.MAX_FPS),
      maxWidth: options.maxWidth || 640,
      maxHeight: options.maxHeight || 640,
    };

    // idle | starting | running | paused
    let state = "idle";
    let gen = 0; // 代次：stop() 会让所有进行中的异步流程失效
    let stream = null;
    let video = null;
    let rvfcId = 0;
    let timerId = 0;
    let uploadErrors = 0;

    function cancelPump() {
      if (rvfcId && video && typeof video.cancelVideoFrameCallback === "function") {
        try {
          video.cancelVideoFrameCallback(rvfcId);
        } catch (e) {
          /* 忽略 */
        }
      }
      rvfcId = 0;
      if (timerId) {
        clearInterval(timerId);
        timerId = 0;
      }
    }

    /** 释放所有资源（不动 state / gen，由调用方决定语义） */
    function release() {
      cancelPump();
      if (video) {
        try {
          video.pause();
        } catch (e) {
          /* 忽略 */
        }
        try {
          video.srcObject = null;
        } catch (e) {
          /* 忽略 */
        }
        try {
          if (video.parentNode) video.parentNode.removeChild(video);
        } catch (e) {
          /* 忽略 */
        }
        video = null;
      }
      if (stream) {
        const tracks = stream.getTracks ? stream.getTracks() : [];
        for (let i = 0; i < tracks.length; i++) {
          try {
            tracks[i].stop();
          } catch (e) {
            /* 忽略 */
          }
        }
        stream = null;
      }
      uploadErrors = 0;
    }

    function fail(reason, detail) {
      release();
      state = "idle";
      log("capture-fail", reason + (detail ? " :: " + detail : ""));
      try {
        onFail(reason, detail || "");
      } catch (e) {
        log("capture-onfail-threw", describe(e));
      }
    }

    /** 把当前视频帧交给 renderer 上传纹理 */
    function upload() {
      if (!video || video.readyState < 2) return false;
      let ok = false;
      try {
        ok = onFrame ? onFrame(video) !== false : false;
      } catch (e) {
        log("capture-frame-cb-threw", describe(e));
        ok = false;
      }
      if (!ok) {
        uploadErrors++;
        if (uploadErrors === CONST.UPLOAD_ERROR_LIMIT) log("capture-upload-failing", "连续 " + uploadErrors + " 次上传失败");
        return false;
      }
      uploadErrors = 0;
      return true;
    }

    /** 帧同步：优先 rVFC（每个新视频帧回调一次，不重复上传）；否则按 fps 节流 */
    function pump() {
      if (state !== "running" || !video) return;
      cancelPump();
      if (typeof video.requestVideoFrameCallback === "function") {
        const step = function () {
          if (state !== "running" || !video) return;
          upload();
          rvfcId = video.requestVideoFrameCallback(step);
        };
        rvfcId = video.requestVideoFrameCallback(step);
      } else {
        const delay = Math.max(16, Math.round(1000 / config.fps));
        timerId = setInterval(upload, delay);
      }
    }

    /** 等第一帧真数据（不是 readyState 一变就算，避免上传一张空白纹理） */
    function waitFirstFrame() {
      return new Promise(function (resolve, reject) {
        let done = false;
        const timer = setTimeout(function () {
          finish(false);
        }, CONST.FIRST_FRAME_TIMEOUT_MS);
        function finish(ok) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (ok) resolve();
          else reject(new Error("no-first-frame"));
        }
        if (!video) {
          finish(false);
          return;
        }
        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback(function () {
            finish(true);
          });
        }
        video.addEventListener(
          "loadeddata",
          function () {
            if (video && video.readyState >= 2) finish(true);
          },
          { once: true }
        );
        if (video.readyState >= 2 && typeof video.requestVideoFrameCallback !== "function") finish(true);
      });
    }

    async function start() {
      if (state !== "idle") return false;
      const my = ++gen;
      state = "starting";
      try {
        if (!host || typeof host.captureSource !== "function") throw new Error("no-host");
        const src = await host.captureSource();
        if (my !== gen) return false;
        if (!src || !src.ok || !src.sourceId) {
          throw new Error("source-unavailable" + (src && src.message ? ": " + src.message : ""));
        }

        const md = navigator.mediaDevices;
        if (!md || typeof md.getUserMedia !== "function") throw new Error("getusermedia-unavailable");

        // 规格 §2 / §7.4：采样分辨率 = 显示器物理尺寸 * 0.5
        stream = await md.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: src.sourceId,
              maxWidth: Math.max(2, Math.round(config.maxWidth)),
              maxHeight: Math.max(2, Math.round(config.maxHeight)),
              maxFrameRate: config.fps,
            },
          },
        });
        if (my !== gen) return false;

        video = document.createElement("video");
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");
        // 1x1 不可见 video：只是为了拿帧，不能影响桌宠的透明布局与鼠标
        video.style.cssText =
          "position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
        video.srcObject = stream;
        (document.body || document.documentElement).appendChild(video);

        try {
          await video.play();
        } catch (e) {
          // muted + autoplay 一般不会走到这里；真失败也不立即判死，继续等首帧（超时会兜底）
          log("capture-play-rejected", describe(e));
        }
        if (my !== gen) return false;

        await waitFirstFrame();
        if (my !== gen) return false;

        state = "running";
        upload(); // 先把刚拿到的这一帧贴上去，避免等下一个帧周期
        try {
          onReady();
        } catch (e) {
          log("capture-onready-threw", describe(e));
        }
        pump();
        return true;
      } catch (e) {
        if (my !== gen) return false;
        fail("start-failed", describe(e));
        return false;
      }
    }

    /** 暂停（窗口隐藏 / document.hidden）：停帧回调 + 暂停 video */
    function pause() {
      if (state !== "running") return;
      cancelPump();
      try {
        if (video) video.pause();
      } catch (e) {
        /* 忽略 */
      }
      state = "paused";
    }

    /** 恢复 */
    function resume() {
      if (state !== "paused") return;
      state = "running";
      try {
        if (video) {
          const p = video.play();
          if (p && typeof p.catch === "function") p.catch(function () {});
        }
      } catch (e) {
        /* 忽略 */
      }
      pump();
    }

    /** 彻底停止：可再次 start() */
    function stop() {
      gen++;
      release();
      state = "idle";
    }

    return {
      start: start,
      pause: pause,
      resume: resume,
      stop: stop,
      getState: function () {
        return state;
      },
      isActive: function () {
        return state === "running" || state === "starting";
      },
    };
  }

  return {
    CONST: CONST,
    create: create,
  };
})();
