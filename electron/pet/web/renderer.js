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
// 桌宠渲染层 · WebGL2 渲染器（两 pass：扭曲背景 -> 叠加吸积盘）
//
// 职责边界：
//   · 本文件只管「GPU 侧」：上下文、program、全屏 quad、屏幕纹理、viewport、混合状态、2D 降级；
//   · 具体 uniform 值由 lens.js / disk.js 的 uniforms(state) 给，本文件按反射到的 uniform
//     类型自动挑 uniform1f/2f/3f/1i —— 所以新增 uniform 只在 shader 与 uniforms() 里加，
//     这里不用改，也不会出现"手写名字表跟 GLSL 漂移"的 bug。
//   · 拿不到 WebGL2 或 shader 编译失败时，换成 2D canvas 画静态黑洞（黑圆 + 橙红环），
//     **绝不允许白屏/黑屏**（规格 §1、§5.6）。
//
// 关于几何比（重要，契约文档在这里有一处量纲歧义）：
//   契约 §1 写「黑洞外半径 = size * 0.30」，而规格 §2 的 uniform 表把 u_Rh 也写成
//   `size * 0.30 * dpr`，同时规格 §3.1 又要求 `R_outer = Rh * 3.2` 处羽化到 0 并 discard。
//   这两个说法不能同时成立（若 Rh = 0.30*size，则 R_outer = 0.96*size > 窗口半径 0.5*size，
//   整个窗口都会被扭曲区覆盖、看不到羽化，验收第 1/7 条必然不过；而规格 §7.1 又明确说
//   「R_outer ≈ size*0.30，窗口面积约 28% 参与计算」，正好是 π*0.30² ≈ 0.283）。
//   因此这里的解释是：**size * 0.30 是「可见外半径」（= R_outer）**，视界半径只能反推：
//       Rh = size * 0.30 / 3.2 = size * 0.09375
//   这样 R_outer = 0.30*size 落在窗口内（半径 0.5*size），羽化完整可见，也与 28% 面积吻合。
//   如果后续视觉上觉得黑洞太小/太大，调 CONST.GEOM.OUTER_RATIO（可见外半径占比）即可，
//   其它常量不用动。
"use strict";
window.PetRenderer = (function () {
  // ===== 几何常量 =====
  const GEOM = {
    // 可见外半径 = size * OUTER_RATIO（契约 §1 的「黑洞外半径」，即透镜羽化外缘）
    OUTER_RATIO: 0.3,
    // 交互热区半径（相对窗口边长）。规格 §5.2 给的是 size*0.30*1.55 = size*0.465，
    // 但可见内容最大半径约 0.30*1.14*size，1.55 会让外面一圈"看不见却吃掉点击"的区域过大，
    // 与验收第 8 条（透明区域要能点穿）冲突，这里收到 1.20；想放大热区就调大这个系数。
    HOT_RATIO: 0.3 * 1.2,
  };

  // 全屏 quad：两个 pass 共用。顶点直接给裁剪空间坐标，片元里用 gl_FragCoord 定位。
  const FULLSCREEN_VERT = [
    "#version 300 es",
    "in vec2 a_pos;",
    "void main() {",
    "  gl_Position = vec4(a_pos, 0.0, 1.0);",
    "}",
  ].join("\n");

  // 三角带覆盖整个裁剪空间：(-1,-1) (1,-1) (-1,1) (1,1)
  const QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

  /** 视界半径（设备像素）——与 lens.js 的 OUTER_K 严格对应，见文件头说明 */
  function horizonRadius(sizeDip, dpr) {
    const k = window.PetLens && window.PetLens.OUTER_K ? window.PetLens.OUTER_K : 3.2;
    return (sizeDip * GEOM.OUTER_RATIO * dpr) / k;
  }

  /** 交互热区半径（DIP） */
  function hotRadius(sizeDip) {
    return sizeDip * GEOM.HOT_RATIO;
  }

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh) || "";
      gl.deleteShader(sh);
      throw new Error((type === gl.VERTEX_SHADER ? "vertex" : "fragment") + "-shader-compile-failed: " + info.slice(0, 700));
    }
    return sh;
  }

  /** 编译 + 链接，并把所有 active uniform 反射成 name -> {loc, type} */
  function buildProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    let fs;
    try {
      fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog) || "";
      gl.deleteProgram(prog);
      throw new Error("program-link-failed: " + info.slice(0, 700));
    }
    const uniforms = Object.create(null);
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      const name = String(info.name).replace(/\[0\]$/, "");
      const loc = gl.getUniformLocation(prog, name);
      if (loc) uniforms[name] = { loc: loc, type: info.type };
    }
    return { program: prog, uniforms: uniforms };
  }

  /** 按反射类型投喂 uniform；GLSL 编译器可能把未使用的 uniform 优化掉，缺失就跳过 */
  function applyUniforms(gl, progInfo, values) {
    if (!values) return;
    for (const name in values) {
      const u = progInfo.uniforms[name];
      if (!u) continue;
      const v = values[name];
      switch (u.type) {
        case gl.FLOAT:
          gl.uniform1f(u.loc, v);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2f(u.loc, v[0], v[1]);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3f(u.loc, v[0], v[1], v[2]);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4f(u.loc, v[0], v[1], v[2], v[3]);
          break;
        case gl.INT:
        case gl.BOOL:
        case gl.SAMPLER_2D:
          gl.uniform1i(u.loc, v | 0);
          break;
        default:
          break;
      }
    }
  }

  /**
   * 创建渲染器。拿不到 WebGL2 会自动换成 2D 降级 canvas（返回体里的 canvas 可能不是传进来的那个，
   * 调用方必须用 renderer.canvas 来做样式/尺寸）。
   * @param {HTMLCanvasElement} canvas
   * @param {{log?: Function}} [opts]
   */
  function create(canvas, opts) {
    const log = (opts && opts.log) || function () {};
    const attrs = {
      alpha: true,
      premultipliedAlpha: false, // 契约要求：非预乘，片元里的 alpha 就是覆盖率
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    };
    let gl = null;
    try {
      gl = canvas.getContext("webgl2", attrs);
    } catch (e) {
      log("webgl2-context-threw", String((e && e.message) || e));
    }
    if (!gl) {
      log("webgl2-unavailable", "getContext(webgl2) 返回 null，降级 2D 静态黑洞");
      return createFallback(swapCanvas(canvas), { log: log });
    }

    let lensProg = null;
    let diskProg = null;
    try {
      lensProg = buildProgram(gl, FULLSCREEN_VERT, window.PetLens.FRAGMENT);
      diskProg = buildProgram(gl, FULLSCREEN_VERT, window.PetDisk.FRAGMENT);
    } catch (e) {
      log("shader-build-failed", String((e && e.message) || e));
      try {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e2) {
        /* 忽略：只是为了尽快释放上下文 */
      }
      return createFallback(swapCanvas(canvas), { log: log });
    }

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const aPos = gl.getAttribLocation(lensProg.program, "a_pos");
    if (aPos < 0) {
      log("shader-attr-missing", "a_pos 被优化掉了");
    } else {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let screenTex = null;

    const api = {
      canvas: canvas,
      gl: gl,
      mode: "webgl2",
      /** 屏幕纹理是否已有一帧有效数据（Pass 1 用它决定走采样还是走程序化星空） */
      screenReady: false,

      /** 重建 canvas 绘制尺寸（DIP -> 设备像素）。window resize / Ctrl+滚轮缩放都走这里 */
      resize: function (widthDip, heightDip, dpr) {
        const w = Math.max(1, Math.round(widthDip * dpr));
        const h = Math.max(1, Math.round(heightDip * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        canvas.style.width = widthDip + "px";
        canvas.style.height = heightDip + "px";
        gl.viewport(0, 0, w, h);
      },

      /**
       * 把视频帧上传成屏幕纹理。由 capture.js 在 requestVideoFrameCallback 里调用
       * （不是每帧无条件调，规格 §2 / §7.5）。
       * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap} source
       * @returns {boolean} 是否成功
       */
      uploadScreenTexture: function (source) {
        if (!source) return false;
        try {
          if (!screenTex) {
            screenTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, screenTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, screenTex);
          }
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.bindTexture(gl.TEXTURE_2D, null);
          api.screenReady = true;
          return true;
        } catch (e) {
          log("screen-upload-failed", String((e && e.message) || e));
          return false;
        }
      },

      /** 关掉屏幕采样：删除纹理，Pass 1 立刻回到程序化星空（省 GPU/带宽，规格 §7.2） */
      enableScreenTexture: function (on) {
        if (on) return; // 打开不需要做事：等 capture 上传首帧后 screenReady 自然为 true
        if (screenTex) {
          try {
            gl.deleteTexture(screenTex);
          } catch (e) {
            /* 忽略 */
          }
          screenTex = null;
        }
        api.screenReady = false;
      },

      /** 单帧渲染：Pass 1 -> Pass 2，不清中间 framebuffer */
      render: function (state) {
        const w = canvas.width;
        const h = canvas.height;
        if (!w || !h) return;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0); // 背景全透明（契约硬要求）
        gl.clear(gl.COLOR_BUFFER_BIT);

        // ---- Pass 1：引力透镜背景（覆盖写，不混合）----
        gl.disable(gl.BLEND);
        gl.useProgram(lensProg.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, api.screenReady ? screenTex : null);
        applyUniforms(gl, lensProg, window.PetLens.uniforms(state));
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // ---- Pass 2：吸积盘 + 光子环，加法叠加 ----
        // 为什么用 ONE,ONE 而不是 SRC_ALPHA,ONE：
        //   上下文是 premultipliedAlpha:false（契约要求），浏览器把 canvas 的 rgb 当"直通色"、
        //   再乘 alpha 合成。自发光叠加需要「rgb 直接相加 + alpha 累加覆盖率」，否则视界外的
        //   拱弧会因 alpha 未增长而完全看不见。
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(diskProg.program);
        applyUniforms(gl, diskProg, window.PetDisk.uniforms(state));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disable(gl.BLEND);
      },

      dispose: function () {
        try {
          api.enableScreenTexture(false);
          gl.deleteBuffer(quadBuffer);
          gl.deleteVertexArray(vao);
          gl.deleteProgram(lensProg.program);
          gl.deleteProgram(diskProg.program);
          const lose = gl.getExtension("WEBGL_lose_context");
          if (lose) lose.loseContext();
        } catch (e) {
          /* 注销期异常无需处理 */
        }
      },
    };
    return api;
  }

  /** 把一个已经拿过 WebGL 上下文的 canvas 换成干净的 canvas（降级时用） */
  function swapCanvas(old) {
    const next = document.createElement("canvas");
    next.id = old.id || "pet-canvas";
    next.className = old.className || "";
    next.setAttribute("aria-hidden", "true");
    if (old.parentNode) old.parentNode.replaceChild(next, old);
    return next;
  }

  /**
   * 2D 降级渲染器：静态黑洞（黑圆 + 橙红环 + 光子环 + 柔和光晕）。
   * 只在 resize / opacity 变化时重画，几乎不吃 CPU。
   */
  function createFallback(canvas, opts) {
    const log = (opts && opts.log) || function () {};
    let ctx = null;
    try {
      ctx = canvas.getContext("2d");
    } catch (e) {
      log("fallback-2d-threw", String((e && e.message) || e));
    }
    let sizeDip = 320;
    let dpr = 1;
    let opacity = 1;
    let dirty = true;

    function draw() {
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = "source-over";

      const side = sizeDip;
      const cx = side / 2;
      const cy = side / 2;
      const rVis = side * GEOM.OUTER_RATIO;
      const rh = rVis / (window.PetLens && window.PetLens.OUTER_K ? window.PetLens.OUTER_K : 3.2);
      const cosT = Math.cos(window.PetDisk ? window.PetDisk.CONST.TILT : 1.32);

      // 外围光晕
      const halo = ctx.createRadialGradient(cx, cy, rh * 0.9, cx, cy, rVis);
      halo.addColorStop(0, "rgba(255, 150, 60, 0.50)");
      halo.addColorStop(0.45, "rgba(255, 110, 40, 0.18)");
      halo.addColorStop(1, "rgba(255, 80, 20, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, rVis, 0, Math.PI * 2);
      ctx.fill();

      // 盘环的左右明暗（多普勒）：右亮白 / 左暗橙
      const grad = ctx.createLinearGradient(cx - rh * 2.6, 0, cx + rh * 2.6, 0);
      grad.addColorStop(0, "rgba(150, 48, 14, 0.55)");
      grad.addColorStop(0.55, "rgba(255, 160, 72, 0.85)");
      grad.addColorStop(1, "rgba(255, 242, 222, 0.95)");
      const diskC = window.PetDisk && window.PetDisk.CONST ? window.PetDisk.CONST : { R_IN: 1.45, R_OUT: 3.1 };
      const rIn = rh * diskC.R_IN;
      const rOut = rh * diskC.R_OUT;

      // 直接像：屏幕空间的椭圆环（内缘 R_IN、外缘 R_OUT，屏幕 y 按 cosT 压扁）。
      // 用 evenodd 填充精确画"环" —— 不能用 stroke：椭圆短轴比线宽还小，描边会糊到圆心。
      ctx.fillStyle = grad;
      ctx.globalAlpha = opacity * 0.92;
      try {
        ctx.filter = "blur(" + Math.max(0.6, rh * 0.05).toFixed(2) + "px)";
      } catch (e) {
        /* 老内核不支持 canvas filter：忽略，边缘会略硬 */
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, rOut, rOut * cosT, 0, 0, Math.PI * 2);
      ctx.ellipse(cx, cy, rIn, rIn * cosT, 0, 0, Math.PI * 2);
      ctx.fill("evenodd");
      try {
        ctx.filter = "none";
      } catch (e) {
        /* 忽略 */
      }
      ctx.globalAlpha = opacity;

      // 纯黑视界：盖住椭圆环中间（等价于 WebGL 里"视界内不显示桌面"）
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(cx, cy, rh, 0, Math.PI * 2);
      ctx.fill();

      // 正面像（近侧）横穿黑洞下半：一条更细的亮带（经典观感）
      const rx = rh * (diskC.R_IN + diskC.R_OUT) * 0.5;
      ctx.strokeStyle = grad;
      ctx.lineWidth = rh * 0.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rx * cosT, 0, 0, Math.PI);
      ctx.stroke();

      // 光子环
      ctx.save();
      ctx.shadowColor = "rgba(255, 190, 110, 0.95)";
      ctx.shadowBlur = rh * 0.55;
      ctx.strokeStyle = "rgba(255, 244, 226, 0.95)";
      ctx.lineWidth = Math.max(1, rh * 0.045);
      ctx.beginPath();
      ctx.arc(cx, cy, rh * 1.045, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 外缘柔和羽化（等价于 WebGL pass 的 edge 羽化）：destination-in 乘一层径向 alpha
      const fade = ctx.createRadialGradient(cx, cy, rVis * 0.55, cx, cy, rVis * 0.98);
      fade.addColorStop(0, "rgba(0, 0, 0, 1)");
      fade.addColorStop(0.55, "rgba(0, 0, 0, 0.92)");
      fade.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = fade;
      ctx.beginPath();
      ctx.arc(cx, cy, rVis, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      ctx.globalAlpha = 1;
    }

    log("fallback-2d", "2D 静态黑洞降级生效");

    return {
      canvas: canvas,
      gl: null,
      mode: "fallback2d",
      screenReady: false,
      resize: function (widthDip, heightDip, dprValue) {
        sizeDip = Math.min(widthDip, heightDip);
        dpr = dprValue || 1;
        canvas.width = Math.max(1, Math.round(widthDip * dpr));
        canvas.height = Math.max(1, Math.round(heightDip * dpr));
        canvas.style.width = widthDip + "px";
        canvas.style.height = heightDip + "px";
        dirty = true;
      },
      uploadScreenTexture: function () {
        return false;
      },
      enableScreenTexture: function () {
        /* 2D 降级没有采样纹理 */
      },
      render: function (state) {
        if (state && Math.abs(state.opacity - opacity) > 0.001) {
          opacity = state.opacity;
          dirty = true;
        }
        if (!dirty) return;
        dirty = false;
        draw();
      },
      dispose: function () {
        dirty = false;
      },
    };
  }

  return {
    GEOM: GEOM,
    horizonRadius: horizonRadius,
    hotRadius: hotRadius,
    create: create,
  };
})();
