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
// 桌宠渲染层 · Pass 1：史瓦西点质量引力透镜（GLSL ES 3.00 源码 + JS 侧传参封装）
//
// 算法（规格 §3.3，**不是**鱼眼/桶形畸变）：
//   点质量透镜方程  beta = theta - thetaE^2 / theta
//   · theta  = 屏幕上的像半径（本 pass 直接用设备像素半径近似角半径）
//   · beta   = 该像对应的"背景真实半径"
//   · 所以屏幕半径 theta 处的像素，要去采样背景里半径 |beta| 处的内容：
//     这是纯径向压缩位移，近视界处压缩剧烈、远处趋近恒等映射。
//   · theta -> thetaE 时 beta -> 0（背景被吸进爱因斯坦环）；theta < thetaE 时 beta 为负，
//     这里取 |beta| 并**不翻转方向**，对应爱因斯坦环内圈的次级像（保证画面连续无跳变）。
//   · 输出**预乘 alpha**（rgb 已乘过 alpha）：与 renderer.js 的 premultipliedAlpha:true 配对。
//   · 扭曲画在**主体外侧的环绕带**里（主体 = 黑球 + 吸积盘），带边缘羽化到 0 时
//     「采样位移」也同步收敛回当前像素（否则与画布下方的真实桌面重影）；
//     视界边缘抗锯齿只混合颜色、不乘进 alpha（否则边缘透出一圈未扭曲桌面）。
//   · 采样保持桌面**原色原亮度**，只做几何弯曲，不压暗/不染色。
//   · 禁止写成 uv -= (uv - 0.5) * k * len 这类线性/二次映射（那是鱼眼，验收会判不合格）。
//
// 可调参数（全部集中在下方 CONST，改完全局生效）：
//   OUTER_K        仅用于 Rh 换算（renderer.js 的 horizonRadius）：
//                  Rh = size * 0.30 / OUTER_K。**可见外轮廓已不由它决定**
//   D_R_IN/OUT     吸积盘内/外缘（Rh 单位），必须与 disk.js 的 R_IN/R_OUT 一致
//   D_TILT         盘倾角（与 disk.js 的 TILT 一致），决定"扁椭圆"的压扁程度
//   D_RING_OUT     扭曲环绕带外扩倍数（相对主体外缘）。1.45 = 主体外再扩 45% 后淡出
//   D_DISCARD_K    计算半径上限（Rh 单位，5.6 = 覆盖外环 5.1Rh），超出直接 discard
//   THETA_E_K      爱因斯坦半径系数：thetaE = Rh * THETA_E_K * sqrt(lensStrength)。
//                  调大 → 背景被吸得更紧、环更粗更乱；调小 → 更接近"透明玻璃球"
//   SRC_MAX_K      采样半径上限（× Rh），防止 thetaE 附近采样点飞太远导致画面撕裂
//   STRONG_K/W     强场补偿：紧贴视界 W×Rh 的一圈里再额外把背景拉开 K×Rh，
//                  形成《星际穿越》那种"压缩白环"。K 调大、W 调大都会让白环更明显
//   HORIZON_AA_PX  视界边缘抗锯齿宽度（设备像素）。太小会看到锯齿硬边
//   LIFT_K         透镜放大带来的轻微提亮（0.00 ~ 0.06）；0 = 不提亮
//   STAR_CELL      程序化星场密度（每 DIP 多少格）；只在 u_useScreen=0 的降级底上生效
//   STAR_CUT       星点出现阈值（0~1，越大星越少）
"use strict";
window.PetLens = (function () {
  const CONST = {
    OUTER_K: 3.2,
    // 盘几何：Pass1 的扭曲区域不再是「以黑洞为圆心的大圆」，而是与吸积盘同形的
    // （扁椭圆盘带 + 上下拱弧）。这三项必须与 disk.js 的 R_IN / R_OUT / TILT 逐字一致，
    // 否则背景扭曲区域与可见盘面会错位（工具 tools/verify/pet-verify.cjs 会比对）。
    D_R_IN: 1.15,
    D_R_OUT: 3.0,
    D_TILT: 1.3,
    // 扭曲环绕带的外扩倍数（相对主体外缘：dBody=1 是主体轮廓）。
    // 外扩 18%：主体外一圈明显可见的引力透镜扭曲（背景内容被径向弯折）。
    D_RING_OUT: 1.18,
    D_DISCARD_K: 5.2,
    THETA_E_K: 2.0,
    SRC_MAX_K: 8.0,
    STRONG_K: 1.4,
    STRONG_W: 0.6,
    HORIZON_AA_PX: 1.2,
    LIFT_K: 0.05,
    STAR_CELL: 0.9,
    STAR_CUT: 0.82,
  };

  /** 把 JS 数字转成 GLSL 浮点字面量（必须带小数点，否则 3 会被当成 int 编译失败） */
  function f(v) {
    return Number(v).toFixed(4);
  }

  // 插值进 GLSL 的常量，保证 JS 与着色器只有一份数值来源（避免两边漂移）
  const C = CONST;
  const C_ = {
    outer: f(C.OUTER_K),
    dIn: f(C.D_R_IN),
    dOut: f(C.D_R_OUT),
    dTilt: f(C.D_TILT),
    dRingOut: f(C.D_RING_OUT),
    dDiscard: f(C.D_DISCARD_K),
    thetaE: f(C.THETA_E_K),
    srcMax: f(C.SRC_MAX_K),
    strongK: f(C.STRONG_K),
    strongW: f(C.STRONG_W),
    aaPx: f(C.HORIZON_AA_PX),
    lift: f(C.LIFT_K),
    starCell: f(C.STAR_CELL),
    starCut: f(C.STAR_CUT),
  };

  const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2      u_resolution;   // canvas 设备像素尺寸
uniform vec2      u_center;       // 黑洞中心（设备像素，窗口坐标，y 向下）
uniform float     u_Rh;           // 视界半径（设备像素）
uniform float     u_lens;         // lensStrength 0 ~ 2.5
uniform float     u_opacity;      // 窗口不透明度 0.4 ~ 1
uniform float     u_useScreen;    // 1 = 采样屏幕纹理；0 = 程序化星空
uniform sampler2D u_screenTex;    // 屏幕采样纹理
uniform vec2      u_winOrigin;    // 窗口相对显示器的偏移（DIP）= bounds - display.bounds
uniform vec2      u_dispSize;     // 显示器尺寸（DIP）
uniform float     u_dpr;          // devicePixelRatio
uniform float     u_time;         // 秒（本 pass 目前不随时间变化，保留给星点微动效）

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 程序化深空 + 星场（规格 §3.5）。只用「屏幕 DIP 坐标」做哈希，
// 所以星点是钉在屏幕上的：拖动桌宠时星星不会跟着窗口跑。
vec3 skyColor(vec2 dip) {
  vec2 sp = dip * ${C_.starCell};
  vec2 ip = floor(sp);
  vec2 fp = fract(sp);
  float h = hash21(ip);
  vec2 jitter = vec2(hash21(ip + vec2(11.3000, 0.0000)), hash21(ip + vec2(0.0000, 27.9000)));
  float star = (1.0 - smoothstep(0.0000, 0.1000, length(fp - jitter))) * step(${C_.starCut}, h);
  star *= 0.4500 + 0.5500 * hash21(ip + vec2(5.7000, 1.1000));
  float deep = hash21(vec2(floor(dip.x * 0.0100), floor(dip.y * 0.0100) + 3.7000));
  vec3 bg = mix(vec3(0.0040, 0.0060, 0.0160), vec3(0.0200, 0.0280, 0.0620), smoothstep(0.0000, 1.0000, deep));
  return bg + vec3(0.8000, 0.8600, 1.0000) * star;
}

// 真实桌面采样：保持原色原亮度（只做几何扭曲，不压暗/不染色）。
// 这是「单纯扭曲后面背景」的要求：桌面上有什么颜色，透镜晕里就还是什么颜色。
vec3 sampleDesktop(vec2 uv) {
  return texture(u_screenTex, uv).rgb;
}

void main() {
  // gl_FragCoord 原点在左下，这里统一翻成「y 向下」的窗口设备像素坐标系
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 p = frag - u_center;
  float r = length(p);

  // ---- §3.1 视界内部纯黑不透明：不显示任何桌面内容 ----
  if (r < u_Rh) {
    outColor = vec4(0.0, 0.0, 0.0, u_opacity);
    return;
  }

  // 计算半径上限：要覆盖背面拱弧（R_OUT*1.2 ≈ 3.72Rh），仍远小于窗口对角线，只作性能早退
  if (r > u_Rh * ${C_.dDiscard}) discard;

  // ---- §3.3 史瓦西点质量透镜：径向位移 ----
  float lens = max(u_lens, 0.0);
  float theta = r;
  float thetaE = u_Rh * ${C_.thetaE} * sqrt(max(lens, 0.0001));
  float beta = theta - (thetaE * thetaE) / max(theta, 0.0010);
  float srcR = min(abs(beta), u_Rh * ${C_.srcMax});

  // 强场补偿：紧贴视界的一圈再拉一段，制造明显的「压缩白环」
  float strong = pow(clamp(1.0 - (theta - u_Rh) / (u_Rh * ${C_.strongW}), 0.0, 1.0), 3.0);
  srcR += u_Rh * ${C_.strongK} * lens * strong;

  // ---- 主体外缘距离场（1.0 = 主体轮廓）----
  // 主体 = 吸积盘（扁椭圆盘带 + 上下拱弧，几何与 disk.js 一致）。
  // 扭曲区域 = **整个主体 + 外扩 16% 的柔和羽化带**：
  //   dBody 0~1   → 黑球/盘面覆盖区（底层是扭曲后的桌面，盘叠加在上面）
  //   dBody 1~1.16→ 外缘柔和羽化到透明
  // 这样满足"底层扭曲桌面 + 上层旋转吸积盘"的图层顺序，且外轮廓跟随主体、不是大圆。
  vec2 q = p / max(u_Rh, 0.0010);
  float qr = length(q);
  float cosT = max(cos(${C_.dTilt}), 0.0800);
  float rhoA = length(vec2(q.x, q.y / cosT));
  // 包络：水平方向取盘外缘，上下方向取背面拱弧外缘（2.40Rh，与 disk.js 的 arcB 收尾一致）
  // 用平滑超椭圆代替 max()：max 会在盘带端部/拱弧交界形成尖角，扭曲带上出现白色竖线。
  float dB1 = rhoA / ${C_.dOut};
  float dB2 = qr / 2.4000;
  float dBody = pow(pow(max(dB1, 0.0001), 6.0) + pow(max(dB2, 0.0001), 6.0), 1.0 / 6.0);
  float bodyMask = 1.0 - smoothstep(1.0000, 1.1600, dBody);
  if (bodyMask < 0.0020) discard;

  // ★ 羽化带边缘同时收敛采样位移：alpha 混合的另一侧是画布下方的真实桌面，
  //   若边缘仍保留径向位移，会同时看到"扭曲桌面 + 真实桌面"→ 重影。
  float srcSampleR = mix(theta, srcR, bodyMask);

  vec2 dir = p / max(r, 0.0001);
  vec2 fpos = u_center + dir * srcSampleR;    // 采样点（窗口设备像素）

  // ---- §3.4 窗口设备像素 -> 屏幕 uv ----
  vec2 dip = fpos / u_dpr + u_winOrigin;      // 屏幕 DIP 坐标
  vec2 uv = dip / u_dispSize;

  // 视界边缘抗锯齿：HORIZON_AA_PX=1.2px 在 Rh≈22.5（240px 窗口 @dpr1）时占视界半径 5% 以上，
  // 这里按 Rh 的 2% 做上限钳制（小窗口自动收窄，大窗口仍用 1.2px）。
  float aaPx = min(${C_.aaPx}, u_Rh * 0.0200);
  float horizonAA = smoothstep(u_Rh - aaPx, u_Rh + aaPx, r);

  vec3 col;
  if (u_useScreen > 0.5000) {
    col = sampleDesktop(uv);      // 被扭曲的桌面：保持原色原亮度，只做几何偏移
  } else {
    col = skyColor(dip);          // 降级：程序化星空
  }
  // 透镜放大导致的轻微提亮（越近视界越亮）
  col *= 1.0 + ${C_.lift} * lens * (1.0 - smoothstep(0.0, 2.0, (theta - u_Rh) / u_Rh));
  // 视界边缘：黑 -> 扭曲背景 的颜色过渡（与视界内纯黑无缝衔接）
  col = mix(vec3(0.0, 0.0, 0.0), col, horizonAA);

  // ★ 透明度：
  //   · 主体内（黑球/盘覆盖区）alpha=1 —— 底层扭曲桌面完整存在，盘叠加在上面，
  //     满足「底层扭曲桌面采样 + 上层旋转吸积盘」的图层顺序；
  //   · 外扩羽化带在亮背景上淡出，避免白雾/白条（"顶部白色长方形"）。
  float bgLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float bgAdapt = 1.0 - smoothstep(0.35, 0.85, bgLum);
  float outerPart = smoothstep(1.0000, 1.0600, dBody);
  float alpha = u_opacity * bodyMask * mix(1.0, mix(0.15, 0.95, bgAdapt), outerPart);
  // ★ 预乘 alpha 输出：与 renderer.js 的 premultipliedAlpha:true 严格对应
  outColor = vec4(col * alpha, alpha);
}
`;

  /**
   * 由渲染状态算出本 pass 的全部 uniform 值（纯函数，便于单独调试）。
   * 渲染器用反射到的 uniform 类型自动挑 uniform1f/2f/3f/1i，这里只负责给值。
   * @param {object} s 渲染状态（见 renderer.js / app.js 的 state）
   */
  function uniforms(s) {
    return {
      u_resolution: [s.width, s.height],
      u_center: [s.centerX, s.centerY],
      u_Rh: s.rh,
      u_lens: s.lens,
      u_opacity: s.opacity,
      u_useScreen: s.useScreen, // float：0 / 1
      u_screenTex: 0, // sampler2D 固定用 0 号纹理单元
      u_winOrigin: [s.winX, s.winY],
      u_dispSize: [s.dispW, s.dispH],
      u_dpr: s.dpr,
      u_time: s.time,
    };
  }

  return {
    // 渲染器要用它把 Rh 换算成「可见外半径 = size * 0.30 / OUTER_K」
    OUTER_K: CONST.OUTER_K,
    CONST: CONST,
    FRAGMENT: FRAGMENT,
    uniforms: uniforms,
  };
})();
