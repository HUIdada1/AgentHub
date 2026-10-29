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
// 桌宠渲染层 · 应用编排（app.js）
//
// 职责：boot -> 建渲染器 -> 起屏幕采样（可选，失败不阻塞）-> rAF 循环
//       -> 鼠标/滚轮/右键 -> 主进程配置事件 -> 隐藏时停 rAF / 采样 -> 任何一步失败都降级不白屏
//
// 通信面：只有 window.petHost（契约 §3）。不依赖 window.agenthub / Node API。
//        浏览器直接打开 index.html 调样式时 petHost 不存在，这里用兜底 host 起渲染
//        （默认 size=320 / enabled / fxEnabled / screenSample / captureFps=30 / diskSpeed=1 /
//         lensStrength=1 / opacity=1），屏幕采样在浏览器里必然不可用 -> 自动走程序化星空。
//
// 窗口坐标映射（规格 §2）：
//   uv.x = (wx + 窗口内设备像素 / dpr) / 显示器宽
//   其中 wx = bounds.x - display.bounds.x（窗口相对显示器的偏移，不是绝对屏幕坐标）。
//   拖动窗口后 wx/wy 会变，必须实时更新，否则黑洞里的桌面会"粘"在窗口上跟着跑。
//   本层取窗口位置的方式（按优先级）：
//     1. window.screenX/screenY（Chromium 的 CSS px，动态跟随 OS 窗口移动，最可靠）；
//        boot 时用 bounds 校准一次，兼容某些环境下给的是物理像素的情况；
//     2. mousemove 的 e.screenX - e.clientX 反推（鼠标事件内两值单位自洽）；
//     3. 都不可用 -> 就用 boot 的 bounds（拖动期间背景会滞后，只影响观感）。
//
// 可调参数：
//   CONST.BOOT_TIMEOUT_MS      boot() 超时（主进程卡住时也别让窗口空着）
//   CONST.TIME_WRAP            u_time 折返周期（秒）。shader 里的噪声坐标会随 time 线性增大，
//                             超过 ~1e5 后 highp float 精度不足会出现条纹抖动，折返一次可避免；
//                             代价是每 TIME_WRAP 秒图案有一次瞬时跳变（默认 1 小时，几乎无感）
//   CONST.WHEEL_STEP           Ctrl+滚轮每档缩放步长（DIP）
//   CONST.SIZE_MIN/MAX         缩放范围（与契约 §1 size 120~900 一致）
//   CONST.SIZE_PATCH_DELAY_MS 缩放 patch 节流（规格 §5.4 的 120ms）
"use strict";
(function () {
  // ===== 可调常量 =====
  const CONST = {
    BOOT_TIMEOUT_MS: 2500,
    TIME_WRAP: 3600,
    WHEEL_STEP: 16,
    SIZE_MIN: 120,
    SIZE_MAX: 900,
    SIZE_PATCH_DELAY_MS: 120,
    CANVAS_SYNC_DELAY_MS: 32,
    LOG_LIMIT: 3,
  };

  // 兜底配置：与契约 §1 默认值一致（其中 enabled 默认 true 只为"浏览器里能直接看到东西"）
  const DEFAULT_CONFIG = {
    enabled: true,
    theme: "gargantua",
    size: 320,
    diskSpeed: 1,
    lensStrength: 1,
    fxEnabled: true,
    screenSample: true,
    captureFps: 30,
    opacity: 1,
  };

  // ===== 运行时状态 =====
  let host = null;
  let bootInfo = null;
  let config = normalizeConfig(null);
  let renderer = null;
  let capture = null;

  const view = {
    widthDip: 320,
    heightDip: 320,
    sizeDip: 320,
    dpr: 1,
    // 窗口相对显示器的偏移（DIP）= contract §2 的 wx / wy
    winX: 0,
    winY: 0,
    dispX: 0,
    dispY: 0,
    dispW: 1920,
    dispH: 1080,
    hotR: 96,
    originMode: "boot", // screenX | pointer | boot
    originScale: 1,
  };

  let time = 0; // 累计秒（传给 u_time）
  let lastTs = 0;
  let rafId = 0;
  let running = false;

  let dragging = false;
  let interactive = false;
  let hover = false;

  let requestedSize = null; // Ctrl+滚轮里"已请求但窗口还没改完"的目标尺寸
  let pendingSize = null;
  let sizeTimer = 0;
  let canvasSyncTimer = 0;

  const logCount = Object.create(null);

  // ===== 通用小工具 =====
  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : d;
  }

  function clampNum(v, min, max, d) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return d;
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

  /** 日志：同 kind 只落前几条，避免拖拽/采样失败时刷爆 pet.log */
  function log(kind, detail) {
    const k = String(kind || "info");
    const n = (logCount[k] || 0) + 1;
    logCount[k] = n;
    if (n > CONST.LOG_LIMIT) return;
    const text = String(detail == null ? "" : detail) + (n > 1 ? " (第 " + n + " 次)" : "");
    try {
      if (host && typeof host.log === "function") host.log(k, text);
    } catch (e) {
      /* IPC 已断：走 console */
    }
    if (n === 1) {
      try {
        console.info("[pet]", k, text);
      } catch (e2) {
        /* 忽略 */
      }
    }
  }

  // ===== 配置 =====
  function normalizeConfig(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const pick = function (name) {
      return src[name] !== undefined ? src[name] : DEFAULT_CONFIG[name];
    };
    return {
      enabled: pick("enabled") !== false,
      theme: "gargantua",
      size: clampNum(pick("size"), CONST.SIZE_MIN, CONST.SIZE_MAX, DEFAULT_CONFIG.size),
      diskSpeed: clampNum(pick("diskSpeed"), 0, 3, DEFAULT_CONFIG.diskSpeed),
      lensStrength: clampNum(pick("lensStrength"), 0, 2.5, DEFAULT_CONFIG.lensStrength),
      fxEnabled: pick("fxEnabled") !== false,
      screenSample: pick("screenSample") !== false,
      captureFps: clampNum(pick("captureFps"), 15, 60, DEFAULT_CONFIG.captureFps),
      opacity: clampNum(pick("opacity"), 0.4, 1, DEFAULT_CONFIG.opacity),
    };
  }

  // ===== petHost（缺失时用兜底实现，便于脱离 Electron 调样式）=====
  function createHost() {
    const real = window.petHost;
    if (real && typeof real.boot === "function") return real;

    try {
      console.info("[pet] window.petHost 不存在，启用浏览器兜底 host（无屏幕采样 / 无真实 IPC）");
    } catch (e) {
      /* 忽略 */
    }

    const noop = function () {};
    let current = normalizeConfig(null);
    const side = Math.max(1, Math.min(window.innerWidth || 320, window.innerHeight || 320));
    return {
      boot: function () {
        const dpr = window.devicePixelRatio || 1;
        return Promise.resolve({
          ok: true,
          config: current,
          bounds: {
            x: Number.isFinite(window.screenX) ? window.screenX : 0,
            y: Number.isFinite(window.screenY) ? window.screenY : 0,
            width: side,
            height: side,
          },
          display: {
            id: 0,
            bounds: {
              x: 0,
              y: 0,
              width: (window.screen && window.screen.width) || side,
              height: (window.screen && window.screen.height) || side,
            },
            scaleFactor: dpr,
          },
          // 浏览器里没有 desktopCapturer，直接声明不支持，省得白等一次失败
          screenSampleSupported: false,
          appVersion: "standalone",
        });
      },
      setInteractive: noop,
      dragStart: noop,
      dragEnd: noop,
      contextMenu: noop,
      patch: function (patch) {
        current = normalizeConfig(Object.assign({}, current, patch || {}));
        return Promise.resolve({ ok: true, config: current });
      },
      usageToday: function () {
        return Promise.resolve({ ok: false, tokens: null, text: "" });
      },
      captureSource: function () {
        return Promise.resolve({ ok: false, message: "standalone" });
      },
      onEvent: function () {
        return noop;
      },
      hide: noop,
      close: noop,
      resetPosition: noop,
      log: function (kind, detail) {
        try {
          console.info("[pet:" + kind + "]", detail);
        } catch (e) {
          /* 忽略 */
        }
      },
    };
  }

  // ===== boot =====
  function loadBootInfo() {
    return new Promise(function (resolve) {
      let settled = false;
      const finish = function (info) {
        if (settled) return;
        settled = true;
        resolve(info || null);
      };
      const timer = setTimeout(function () {
        log("boot-timeout", "petHost.boot() 超过 " + CONST.BOOT_TIMEOUT_MS + "ms，先用默认配置起渲染");
        finish(null);
      }, CONST.BOOT_TIMEOUT_MS);
      let p;
      try {
        p = host.boot();
      } catch (e) {
        clearTimeout(timer);
        log("boot-threw", describe(e));
        finish(null);
        return;
      }
      Promise.resolve(p)
        .then(function (info) {
          clearTimeout(timer);
          finish(info);
        })
        .catch(function (e) {
          clearTimeout(timer);
          log("boot-failed", describe(e));
          finish(null);
        });
    });
  }

  function applyBootInfo(info) {
    bootInfo = info && typeof info === "object" ? info : null;
    const side = Math.max(1, Math.min(window.innerWidth || 320, window.innerHeight || 320));
    const bounds = (bootInfo && bootInfo.bounds) || {
      x: Number.isFinite(window.screenX) ? window.screenX : 0,
      y: Number.isFinite(window.screenY) ? window.screenY : 0,
      width: side,
      height: side,
    };
    const display = (bootInfo && bootInfo.display) || {
      id: 0,
      bounds: {
        x: 0,
        y: 0,
        width: (window.screen && window.screen.width) || 1920,
        height: (window.screen && window.screen.height) || 1080,
      },
      scaleFactor: window.devicePixelRatio || 1,
    };
    const db = display.bounds || {};
    view.dispX = num(db.x, 0);
    view.dispY = num(db.y, 0);
    view.dispW = Math.max(1, num(db.width, 1920));
    view.dispH = Math.max(1, num(db.height, 1080));

    // 契约 §2：窗口相对显示器的偏移，不是屏幕绝对坐标
    const bx = num(bounds.x, view.dispX);
    const by = num(bounds.y, view.dispY);
    view.winX = bx - view.dispX;
    view.winY = by - view.dispY;
    view.dpr = window.devicePixelRatio || num(display.scaleFactor, 1);

    calibrateOrigin(bx, by);
  }

  /**
   * 校准「窗口屏幕坐标」的来源。boot 时窗口应该还在 bounds 位置，
   * 用此时的值反推 window.screenX 的量纲（CSS px vs 物理像素），后面就能持续跟踪拖拽。
   */
  function calibrateOrigin(bootX, bootY) {
    const dpr = view.dpr || 1;
    const sx = window.screenX;
    const sy = window.screenY;
    const near = function (a, b) {
      return Math.abs(a - b) <= 2;
    };
    if (Number.isFinite(sx) && Number.isFinite(sy)) {
      if (near(sx, bootX) && near(sy, bootY)) {
        view.originMode = "screenX";
        view.originScale = 1;
        return;
      }
      if (near(sx / dpr, bootX) && near(sy / dpr, bootY)) {
        view.originMode = "screenX";
        view.originScale = 1 / dpr;
        return;
      }
    }
    // screenX 不可用：退到「鼠标事件反推」，见 updateOriginFromPointer
    view.originMode = "pointer";
    view.originScale = 0;
    log("origin-mode-pointer", "screenX=" + sx + "," + sy + " bounds=" + bootX + "," + bootY + " dpr=" + dpr);
  }

  /** 每帧更新窗口相对显示器的偏移（屏幕采样 uv 映射的正确性靠它） */
  function syncWindowOrigin() {
    if (view.originMode !== "screenX") return;
    const sx = window.screenX;
    const sy = window.screenY;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    view.winX = sx * view.originScale - view.dispX;
    view.winY = sy * view.originScale - view.dispY;
  }

  /** 鼠标事件兜底：e.screenX - e.clientX 就是窗口屏幕原点（两个值单位自洽）
   *  注意：拖拽期间**总是**用指针反推 —— 主进程 16ms 轮询移动窗口，指针事件与窗口移动同帧，
   *  比每帧读 window.screenX 更跟手，避免黑洞里的桌面在拖动时"滞后/发飘"。 */
  function updateOriginFromPointer(e) {
    if (!e) return;
    if (view.originMode !== "pointer" && !dragging) return;
    const ox = e.screenX - e.clientX;
    const oy = e.screenY - e.clientY;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
    if (!view.originScale) {
      const dpr = view.dpr || 1;
      const absX = view.winX + view.dispX;
      if (Math.abs(ox - absX) <= 3) view.originScale = 1;
      else if (Math.abs(ox / dpr - absX) <= 3) view.originScale = 1 / dpr;
      else view.originScale = 1; // 认不出来就按 DIP 处理：至少不会把画面撕掉
    }
    view.winX = ox * view.originScale - view.dispX;
    view.winY = oy * view.originScale - view.dispY;
  }

  // ===== canvas 尺寸 =====
  function syncCanvasSize(force) {
    if (!renderer) return false;
    const w = Math.max(1, window.innerWidth || config.size);
    const h = Math.max(1, window.innerHeight || config.size);
    const dpr = window.devicePixelRatio || view.dpr || 1;
    const changed = !!force || w !== view.widthDip || h !== view.heightDip || dpr !== view.dpr;
    view.widthDip = w;
    view.heightDip = h;
    view.sizeDip = Math.min(w, h);
    view.dpr = dpr;
    view.hotR = PetRenderer.hotRadius(view.sizeDip);
    if (changed) renderer.resize(w, h, dpr);
    return changed;
  }

  function scheduleCanvasSync() {
    if (canvasSyncTimer) return;
    canvasSyncTimer = setTimeout(function () {
      canvasSyncTimer = 0;
      syncCanvasSize(true);
    }, CONST.CANVAS_SYNC_DELAY_MS);
  }

  // ===== 渲染状态 =====
  function buildState() {
    const w = renderer.canvas.width || 1;
    const h = renderer.canvas.height || 1;
    return {
      width: w,
      height: h,
      centerX: w * 0.5,
      centerY: h * 0.5,
      rh: PetRenderer.horizonRadius(view.sizeDip, view.dpr),
      dpr: view.dpr,
      // fxEnabled=false：关掉畸变（lens=0）与屏幕采样（useScreen 自然为 0），
      // 背景退化为程序化静止星空；不建采样流以省 GPU/带宽（规格 §7.2）
      lens: config.fxEnabled ? config.lensStrength : 0,
      opacity: config.opacity,
      diskSpeed: config.diskSpeed,
      time: time % CONST.TIME_WRAP,
      useScreen: modelUseScreen(),
      winX: view.winX,
      winY: view.winY,
      dispW: view.dispW,
      dispH: view.dispH,
    };
  }

  function modelUseScreen() {
    return renderer && renderer.mode === "webgl2" && renderer.screenReady ? 1 : 0;
  }

  // ===== rAF 循环 =====
  function startLoop() {
    if (running || !renderer) return;
    running = true;
    lastTs = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function frame(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const now = ts * 0.001;
    let dt = lastTs ? now - lastTs : 0.016;
    lastTs = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25; // 切后台/断点回来不跳帧
    time += dt;
    syncWindowOrigin();
    renderer.render(buildState());
  }

  // ===== 屏幕采样生命周期 =====
  function shouldCapture() {
    return (
      !!renderer &&
      renderer.mode === "webgl2" &&
      config.fxEnabled &&
      config.screenSample &&
      !document.hidden &&
      !(bootInfo && bootInfo.screenSampleSupported === false)
    );
  }

  function startCapture() {
    if (capture || !shouldCapture()) return;
    const maxW = Math.max(2, Math.round(view.dispW * view.dpr * 0.5));
    const maxH = Math.max(2, Math.round(view.dispH * view.dpr * 0.5));
    log(
      "capture-start",
      "display=" + Math.round(view.dispW) + "x" + Math.round(view.dispH) + " dpr=" + view.dpr +
        " max=" + maxW + "x" + maxH + " fps=" + config.captureFps
    );
    capture = PetCapture.create({
      host: host,
      log: log,
      fps: config.captureFps,
      maxWidth: maxW,
      maxHeight: maxH,
      onFrame: function (video) {
        if (!renderer || renderer.mode !== "webgl2") return false;
        return renderer.uploadScreenTexture(video);
      },
      onReady: function () {
        log("capture-ready", "屏幕采样已出首帧");
      },
      onFail: function (reason, detail) {
        // capture.js 内部已经打过 capture-fail 日志（带 detail），这里只负责释放实例：
        // 下次「显示 / 恢复」时 syncCapture 会重新尝试建流（例如锁屏恢复后权限恢复）
        void reason;
        void detail;
        teardownCapture("capture-failed");
      },
    });
    // 不 await：失败只降级成程序化星空，绝不能阻塞首帧
    const p = capture.start();
    if (p && typeof p.catch === "function") {
      p.catch(function (e) {
        log("capture-start-rejected", describe(e));
      });
    }
  }

  function teardownCapture(reason) {
    if (capture) {
      try {
        capture.stop();
      } catch (e) {
        log("capture-stop-failed", describe(e));
      }
      capture = null;
      log("capture-stop", String(reason || ""));
    }
    if (renderer) renderer.enableScreenTexture(false);
  }

  function syncCapture(reason) {
    if (!renderer) return;
    if (!shouldCapture()) {
      teardownCapture(reason || "not-wanted");
      return;
    }
    if (capture) {
      if (capture.getState() === "paused") capture.resume();
      return;
    }
    startCapture();
  }

  // ===== 配置变更 =====
  function applyConfig(raw, source) {
    const prev = config;
    config = normalizeConfig(raw);
    requestedSize = null;
    if (prev.size !== config.size) scheduleCanvasSync();
    if (prev.fxEnabled !== config.fxEnabled || prev.screenSample !== config.screenSample) {
      syncCapture("config:" + String(source || ""));
    } else if (prev.captureFps !== config.captureFps) {
      teardownCapture("fps-change");
      syncCapture("fps-change");
    }
  }

  // ===== 事件绑定 =====
  function bindHostEvents() {
    if (!host || typeof host.onEvent !== "function") return;
    try {
      host.onEvent(function (payload) {
        if (!payload || typeof payload !== "object") return;
        const ev = String(payload.event || "");
        if (ev === "config-changed") {
          applyConfig(payload.config, "event");
        } else if (ev === "hidden") {
          pauseAll();
        } else if (ev === "shown") {
          resumeAll();
        } else if (ev === "busy") {
          // 契约外的附加事件（优化提示词中）：本层不做 DOM 角标，忽略即可
        }
        // usage / quit-pet 等其余事件本层不需要处理
      });
    } catch (e) {
      log("on-event-failed", describe(e));
    }
  }

  function bindDomEvents() {
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    // mouseleave 不冒泡，必须挂在 documentElement 上（等价于"指针离开窗口"）
    document.documentElement.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("resize", onResize);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", disposeAll);
  }

  function refreshCursor() {
    const cls = document.body && document.body.classList;
    if (!cls) return;
    cls.toggle("dragging", dragging);
    cls.toggle("hot", hover && !dragging);
  }

  function hitTest(clientX, clientY) {
    const w = window.innerWidth || view.sizeDip;
    const h = window.innerHeight || view.sizeDip;
    const dx = clientX - w * 0.5;
    const dy = clientY - h * 0.5;
    const r = view.hotR;
    return dx * dx + dy * dy <= r * r;
  }

  function setInteractive(on) {
    if (interactive === on) return;
    interactive = on;
    try {
      if (host && typeof host.setInteractive === "function") host.setInteractive(on);
    } catch (e) {
      log("set-interactive-failed", describe(e));
    }
  }

  function onMouseMove(e) {
    updateOriginFromPointer(e);
    if (dragging) return; // 拖拽期间不切穿透，避免窗口跟手时反复抖动
    const inside = hitTest(e.clientX, e.clientY);
    if (inside === hover) return;
    hover = inside;
    refreshCursor();
    setInteractive(inside);
  }

  function onMouseDown(e) {
    updateOriginFromPointer(e);
    if (e.button !== 0) return;
    if (!hitTest(e.clientX, e.clientY)) return;
    dragging = true;
    hover = true;
    refreshCursor();
    try {
      if (host && typeof host.dragStart === "function") host.dragStart();
    } catch (err) {
      log("drag-start-failed", describe(err));
    }
    try {
      e.preventDefault();
    } catch (err) {
      /* 忽略 */
    }
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    refreshCursor();
    try {
      if (host && typeof host.dragEnd === "function") host.dragEnd();
    } catch (e) {
      log("drag-end-failed", describe(e));
    }
  }

  function onMouseUp(e) {
    updateOriginFromPointer(e);
    endDrag();
  }

  function onMouseLeave() {
    endDrag();
    if (hover) {
      hover = false;
      refreshCursor();
    }
    setInteractive(false);
  }

  function onWindowBlur() {
    onMouseLeave();
  }

  function onResize() {
    const prevDpr = view.dpr;
    syncCanvasSize(true);
    if (prevDpr !== view.dpr) {
      // 换到不同缩放的显示器：采样约束里的 maxWidth/maxHeight 变了，重建流
      teardownCapture("dpr-change");
      syncCapture("dpr-change");
    }
  }

  function queueSizePatch(size) {
    pendingSize = size;
    if (sizeTimer) return;
    sizeTimer = setTimeout(flushSizePatch, CONST.SIZE_PATCH_DELAY_MS);
  }

  function flushSizePatch() {
    sizeTimer = 0;
    const size = pendingSize;
    pendingSize = null;
    if (size == null || !host || typeof host.patch !== "function") return;
    let p;
    try {
      p = host.patch({ size: size });
    } catch (e) {
      log("patch-size-failed", describe(e));
      requestedSize = null;
      return;
    }
    Promise.resolve(p)
      .then(function (res) {
        if (res && res.ok && res.config) applyConfig(res.config, "patch");
        else requestedSize = null;
      })
      .catch(function (e) {
        log("patch-size-failed", describe(e));
        requestedSize = null;
      });
  }

  function onWheel(e) {
    // 规格 §5.4：只有 Ctrl+滚轮才缩放
    if (!e.ctrlKey) return;
    try {
      e.preventDefault();
    } catch (err) {
      /* 忽略 */
    }
    const base = requestedSize != null ? requestedSize : window.innerWidth || config.size;
    const step = e.deltaY > 0 ? -CONST.WHEEL_STEP : CONST.WHEEL_STEP;
    const next = Math.round(clampNum(base + step, CONST.SIZE_MIN, CONST.SIZE_MAX, base));
    if (next === base) return;
    requestedSize = next;
    queueSizePatch(next);
  }

  function onContextMenu(e) {
    e.preventDefault();
    updateOriginFromPointer(e);
    try {
      if (host && typeof host.contextMenu === "function") {
        host.contextMenu(Math.round(e.clientX), Math.round(e.clientY));
      }
    } catch (err) {
      log("context-menu-failed", describe(err));
    }
  }

  function onVisibilityChange() {
    if (document.hidden) pauseAll();
    else resumeAll();
  }

  // ===== 暂停 / 恢复（窗口隐藏时停 rAF 与采样，规格 §7.3）=====
  function pauseAll() {
    stopLoop();
    if (capture) capture.pause();
    // 隐藏时窗口不可见：把穿透态恢复成默认，避免下次显示时"透明区域还能点"
    hover = false;
    refreshCursor();
    setInteractive(false);
  }

  function resumeAll() {
    if (renderer) syncCanvasSize(false);
    startLoop();
    if (capture) capture.resume();
    else syncCapture("resume");
  }

  function disposeAll() {
    stopLoop();
    if (capture) {
      try {
        capture.stop();
      } catch (e) {
        /* 忽略 */
      }
      capture = null;
    }
    if (renderer) {
      try {
        renderer.dispose();
      } catch (e) {
        /* 忽略 */
      }
      renderer = null;
    }
  }

  // ===== 启动 =====
  async function main() {
    host = createHost();

    window.addEventListener("error", function (e) {
      log("window-error", (e && e.message) || "unknown");
    });
    window.addEventListener("unhandledrejection", function (e) {
      log("unhandled-rejection", describe(e && e.reason));
    });

    const info = await loadBootInfo();
    applyBootInfo(info);
    config = normalizeConfig(info && info.config);

    const canvas = document.getElementById("pet-canvas");
    if (!canvas) {
      log("canvas-missing", "index.html 里找不到 #pet-canvas");
      return;
    }
    try {
      renderer = PetRenderer.create(canvas, { log: log });
    } catch (e) {
      log("renderer-create-failed", describe(e));
      renderer = null;
    }
    if (!renderer) {
      // 极端情况（连 2D canvas 都拿不到）：不抛错、不白屏，留一条日志给主进程
      log("renderer-unavailable", "渲染器创建失败，桌宠将不可见");
      return;
    }
    log(
      "renderer-ready",
      "mode=" + renderer.mode +
        " dpr=" + view.dpr +
        " display=" + Math.round(view.dispW) + "x" + Math.round(view.dispH) +
        " win=" + Math.round(view.winX) + "," + Math.round(view.winY) +
        " size=" + config.size
    );

    syncCanvasSize(true);
    bindDomEvents();
    bindHostEvents();
    syncCapture("boot"); // 失败只降级，不阻塞
    startLoop();
  }

  main().catch(function (e) {
    // 启动链任何一处抛错都不能让窗口白屏：至少把原因落到 pet.log
    try {
      if (host && typeof host.log === "function") host.log("boot-fatal", describe(e));
    } catch (err) {
      /* 忽略 */
    }
    try {
      console.error("[pet] 启动失败", e);
    } catch (err2) {
      /* 忽略 */
    }
  });
})();
