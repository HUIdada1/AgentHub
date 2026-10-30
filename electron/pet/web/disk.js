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
// 桌宠渲染层 · Pass 2：吸积盘 + 光子环（GLSL ES 3.00 源码 + JS 侧传参封装）
//
// 三层像叠加（规格 §4.1，这是「卡冈图雅」的关键轮廓）：
//   (a) 直接像：盘正面，屏幕 y 按 cos(TILT) 压扁成扁椭圆"糖环"。盘正面挡在黑洞前方，
//       所以它**允许**盖住视界下半部分（经典观感：黑洞下半被亮盘横穿）；
//       盘背面的像在视界里被黑洞本体挡住（occult 掩掉），只有近侧可以横穿。
//   (b) 上下拱起的背面像：盘背面被引力弯折到黑洞上/下方。屏幕半径 r 越小 → 采到盘越外缘。
//   (c) 光子环：r ≈ 1.045 Rh 的极细亮环，全周。
//
// 输出：**预乘 alpha**（rgb 已乘 alpha），与 renderer.js 的 premultipliedAlpha:true +
//       blendFunc(ONE,ONE) 配对；覆盖率用平滑衰减而不是硬阈值，避免外圈随噪声旋转出现亮度台阶。
//
// 可调参数（全部集中在下方 CONST，改完全局生效）：
//   R_IN / R_OUT   盘内/外缘（Rh 为单位）。R_IN 一定要 > 1：盘内缘要露出视界
//   TILT           视角倾角（弧度）。越大越"侧视"（盘越扁），越小越"俯视"（越接近正圆）
//   RING_R         光子环位置（Rh 为单位）
//   RING_SIGMA     光子环宽度基准（× Rh）。实际宽度以**设备像素**为下限（≥1.15px），
//                  上限 RING_MAX_SIGMA·Rh，保证小窗口不闪烁、大窗口不糊成亮带
//   RING_GAIN      光子环亮度。调大 → 更接近电影里那条刺眼的白线
//   ARC_GAIN       上下拱形背面像的整体增益。引力弯折的次级像本来比直接像暗，
//                  调小 → 直接像/光子环更突出（拱弧变成背后的弱光环）；调大 → 拱弧更抢眼
//   OMEGA_K        开普勒转速基准（Omega = diskSpeed * OMEGA_K * rho^-1.5）。调大整体更快
//   DOPPLER_K      多普勒明暗差（1.05 → 亮度 0.16~2.05 倍，一侧白热一侧暗红）。
//                  **这是"必须有明显明暗差"的核心参数**，调小会变"均匀发光的甜甜圈"
//   DOPPLER_MIN    远离侧亮度下限（防止那一侧彻底黑掉、读不出"暗红"）
//   TEMP_FALLOFF   温度剖面陡度（亮度 ∝ T^TEMP_FALLOFF）。越大 → 内亮外暗对比越强
//   TINT_MIX       多普勒色调比重（0.45 = 底色主导 55% / 多普勒色 45%）。调小更"物理温度色"，
//                  调大更"红蓝偏移"
//   TONE_K         软压缩系数（返回前 c/(1+c*TONE_K)）。调大 → 高光更收敛不易冲白；
//                  调小 → 内圈更接近硬钳的纯白
//   INTENSITY      整体亮度倍率。与 TONE_K 搭配决定"内圈白热"的起点
//   TURB_MIN/MAX   湍流亮度起伏区间。区间越宽 → 条纹越"脏"越像真实气体；过宽会显得像刻线
//   DISCARD_R      本 pass 计算半径上限（Rh 单位）。要 ≥ 拱弧外缘 R_OUT*1.18，否则会硬切。
//                  与 lens 的环绕扭曲带（主体外缘 D_RING_OUT 倍）叠加时，拱弧外圈是
//                  「盘面 + 外环扭曲背景」的叠加，不会再出现"盘画在未扭曲桌面上"的割裂感。
//   COLD/HOT       温度色（外冷 / 内热）
//   DOPPLER_COOL/HOT  多普勒色偏（远离观察者一侧 / 朝向观察者一侧）
//   RING_COLOR     光子环颜色
"use strict";
window.PetDisk = (function () {
  const CONST = {
    R_IN: 1.15,
    R_OUT: 3.0,
    TILT: 1.3,
    RING_R: 1.02,
    RING_SIGMA: 0.006,
    RING_GAIN: 0.55,
    ARC_GAIN: 1.4,
    OMEGA_K: 3.2,
    // 多普勒：一侧亮白、一侧暗红，暗侧保留底光
    DOPPLER_K: 0.85,
    DOPPLER_MIN: 0.4,
    TEMP_FALLOFF: 2.2,
    TEMP_MIX_LO: 0.05,
    TEMP_MIX_HI: 0.5,
    TINT_MIX: 0.25,
    TONE_K: 0.55,
    INTENSITY: 2.0,
    TURB_MIN: 0.78,
    TURB_MAX: 1.25,
    // 小尺寸稳定性钳制（Rh 单位为设备像素）
    RING_MAX_SIGMA: 0.035, // 光子环宽度上限（× Rh）；下限是 1.15 设备像素（见 shader 内 sigmaPx）
    TURB_RH_LO: 14.0, // Rh < LO：湍流完全压平、噪声频率降到最低档
    TURB_RH_HI: 40.0, // Rh > HI：湍流/频率按正常值
    TURB_FREQ_MIN: 2.0, // 小尺寸下的噪声径向频率（正常为 5.0；调小让条纹更粗、旋转更可见）
    DISCARD_R: 3.6,
    // 颜色：内缘暖白热 → 中段金橙 → 外缘暗红棕（电影里盘的颜色梯度）
    COLD: [0.28, 0.035, 0.008],
    HOT: [1.0, 0.72, 0.28],
    DOPPLER_COOL: [0.7, 0.1, 0.015],
    DOPPLER_HOT: [1.0, 0.98, 0.92],
    RING_COLOR: [1.0, 0.93, 0.8],
  };

  function f(v) {
    return Number(v).toFixed(4);
  }

  function v3(a) {
    return "vec3(" + a.map(f).join(", ") + ")";
  }

  const C = CONST;
  const C_ = {
    rIn: f(C.R_IN),
    rOut: f(C.R_OUT),
    tilt: f(C.TILT),
    ringR: f(C.RING_R),
    ringSigma: f(C.RING_SIGMA),
    ringGain: f(C.RING_GAIN),
    arcGain: f(C.ARC_GAIN),
    omega: f(C.OMEGA_K),
    doppler: f(C.DOPPLER_K),
    dopplerMin: f(C.DOPPLER_MIN),
    falloff: f(C.TEMP_FALLOFF),
    tempLo: f(C.TEMP_MIX_LO),
    tempHi: f(C.TEMP_MIX_HI),
    tintMix: f(C.TINT_MIX),
    toneK: f(C.TONE_K),
    intensity: f(C.INTENSITY),
    turbMin: f(C.TURB_MIN),
    turbMax: f(C.TURB_MAX),
    ringMaxSigma: f(C.RING_MAX_SIGMA),
    turbRhLo: f(C.TURB_RH_LO),
    turbRhHi: f(C.TURB_RH_HI),
    turbFreqMin: f(C.TURB_FREQ_MIN),
    discard: f(C.DISCARD_R),
    cold: v3(C.COLD),
    hot: v3(C.HOT),
    dopCool: v3(C.DOPPLER_COOL),
    dopHot: v3(C.DOPPLER_HOT),
    ringColor: v3(C.RING_COLOR),
  };

  const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2  u_resolution;
uniform vec2  u_center;
uniform float u_Rh;
uniform float u_time;
uniform float u_diskSpeed;
uniform float u_opacity;

out vec4 outColor;

// ===== 结构常量（Rh 为单位）=====
const float R_IN        = ${C_.rIn};
const float R_OUT       = ${C_.rOut};
const float TILT        = ${C_.tilt};
const float RING_R      = ${C_.ringR};
const float RING_SIGMA  = ${C_.ringSigma};
const float RING_GAIN   = ${C_.ringGain};
const float ARC_GAIN    = ${C_.arcGain};
// ===== 动力学 / 亮度常量 =====
const float OMEGA_K      = ${C_.omega};
const float DOPPLER_K    = ${C_.doppler};
const float DOPPLER_MIN  = ${C_.dopplerMin};
const float TEMP_FALLOFF = ${C_.falloff};
const float TEMP_MIX_LO  = ${C_.tempLo};
const float TEMP_MIX_HI  = ${C_.tempHi};
const float TINT_MIX     = ${C_.tintMix};
const float TONE_K       = ${C_.toneK};
const float INTENSITY    = ${C_.intensity};
const float TURB_MIN     = ${C_.turbMin};
const float TURB_MAX     = ${C_.turbMax};
const float RING_MAX_SIGMA = ${C_.ringMaxSigma};
const float TURB_RH_LO   = ${C_.turbRhLo};
const float TURB_RH_HI   = ${C_.turbRhHi};
const float TURB_FREQ_MIN = ${C_.turbFreqMin};
const float DISCARD_R    = ${C_.discard};
const vec3  COLD         = ${C_.cold};
const vec3  HOT          = ${C_.hot};
const vec3  DOPPLER_COOL = ${C_.dopCool};
const vec3  DOPPLER_HOT  = ${C_.dopHot};
const vec3  RING_COLOR   = ${C_.ringColor};

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 4 阶分形噪声：盘纹理由程序化噪声生成（规格 §4.2 禁止静态贴图）
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    amp *= 0.5;
  }
  return v;
}

// 盘面单点的辐亮度
//   rho = 盘平面半径（Rh 单位）
//   phi = 盘平面方位角
//   dop = 多普勒方向（-1 远离观察者 ~ 1 朝向观察者），由屏幕位置决定
vec3 diskRadiance(float rho, float phi, float dop, float t) {
  // 小尺寸稳定性：Rh 小时把噪声频率降一档、湍流幅度收向 1，
  // 否则 240px 窗口（Rh≈22.5）下盘面细纹 <1px，会变成噪点闪烁。
  float sizeK = smoothstep(TURB_RH_LO, TURB_RH_HI, u_Rh);
  float nfreq = mix(TURB_FREQ_MIN, 5.0, sizeK);

  // ---- 开普勒差速旋转：Omega ∝ rho^-1.5，内圈快、外圈慢 ----
  float omega = u_diskSpeed * OMEGA_K * pow(max(rho, 0.6), -1.5);
  float a = phi + t * omega;
  // 噪声沿方位角方向拉长成弧状条纹（径向高频 / 方位低频），并随 a 一起转
  float n = fbm(vec2(rho * nfreq - a * 1.3, a * 2.0 + rho * 3.0));
  float turb = mix(1.0, mix(TURB_MIN, TURB_MAX, smoothstep(0.18, 0.82, n)), sizeK);

  // ---- 温度剖面：内亮外暗自 → 盘面整体内亮外暗 ----
  float temp = pow(clamp(R_IN / max(rho, 0.0010), 0.0, 1.0), 0.65);
  float radial = pow(temp, TEMP_FALLOFF);

  // ---- 色带：内金黄 → 外暗红棕（插值中段自然过渡出橙色）----
  float tRho = clamp((rho - R_IN) / max(R_OUT - R_IN, 0.0010), 0.0, 1.0);
  vec3 base = mix(HOT, COLD, smoothstep(0.0, 1.0, tRho));
  // 内缘白热：紧贴盘内缘的一条极亮细环（电影里最亮的部分）
  float hotEdge = exp(-pow((rho - R_IN * 1.02) / max(R_IN * 0.20, 0.02), 2.0));
  base = mix(base, vec3(1.0, 0.97, 0.93), clamp(hotEdge, 0.0, 1.0) * 0.85);

  // ---- 多普勒：一侧朝观察者运动 → 更亮更白；另一侧远离 → 更暗更红 ----
  // DOPPLER_MIN 给远离侧留一点底光，否则那一侧会直接黑掉（读不出"暗红"）
  float boost = max(1.0 + DOPPLER_K * dop, DOPPLER_MIN);
  vec3 tint = mix(DOPPLER_COOL, DOPPLER_HOT, smoothstep(-0.9, 0.9, dop));
  vec3 col = mix(base, tint, TINT_MIX * 0.6);

  // ---- 软压缩（tone map）：只压亮度、保色相 ----
  // 逐通道 c/(1+c*k) 会把暖色洗成灰白；这里压的是亮度，各通道等比缩放，颜色不会失真。
  vec3 c = col * radial * turb * boost * INTENSITY;
  float lum = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
  return c * ((lum / (1.0 + lum * TONE_K)) / lum);
}

void main() {
  // 与 Pass 1 一致的「y 向下」窗口设备像素坐标系
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 q = (frag - u_center) / max(u_Rh, 0.0010);
  float r = length(q);

  // 只在盘系统有效区域计算：拱弧外缘是 R_OUT*1.18，超出即丢弃
  if (r > DISCARD_R) discard;

  float phi = atan(q.y, q.x);
  float dop = clamp(q.x / max(r, 0.0010), -1.0, 1.0);
  float t = u_time;
  float cosT = cos(TILT);

  // ---- (a) 直接像：盘正面（屏幕 y 被 cosT 压扁）----
  vec2 dq = vec2(q.x, q.y / max(cosT, 0.08));
  float rhoA = length(dq);
  float phiA = atan(dq.y, dq.x);
  float bandA = smoothstep(R_IN, R_IN * 1.06, rhoA) * (1.0 - smoothstep(R_OUT * 0.90, R_OUT, rhoA));
  // 盘背面（屏幕上半侧）在视界内被黑洞本体遮挡：近侧（下半侧）才允许横穿到黑洞前方
  float occult = (q.y < 0.0) ? smoothstep(0.90, 1.06, r) : 1.0;
  vec3 colA = diskRadiance(rhoA, phiA, dop, t) * (bandA * occult);

  // ---- (b) 上下拱起的背面像（引力弯折的盘背面）----
  // 是紧贴黑洞上下的「弯弧」，两端与水平盘带连接成一整圈，而不是竖直光柱：
  //   · 角度窗口放宽到 0.30 起（与盘带重叠），弧两端自然接到盘带上下缘；
  //   · 径向收在 1.1~2.0Rh（贴着黑球，细弧）；
  //   · 半径映射到盘的内中段（1.25~2.8Rh），内亮外暗，与正面盘同一套辐射公式。
  float rhoB = mix(R_IN * 1.3, R_OUT * 0.9, smoothstep(R_IN * 0.95, 1.80, r));
  float arcB = smoothstep(0.35, 0.95, abs(q.y) / max(r, 0.0010))   // 从盘带边缘接到上下方
             * smoothstep(R_IN * 0.95, R_IN * 1.08, r)            // 不进视界
             * (1.0 - smoothstep(1.60, 1.85, r));                 // 贴着黑球的一圈细弧
  vec3 colB = diskRadiance(rhoB, phi, dop, t) * (arcB * ARC_GAIN);

  // ---- (c) 光子环：极细高斯亮环，全周 ----
  // 宽度以设备像素为下限（小窗口下环也不闪烁），再钳在 Rh 的 RING_MAX_SIGMA 以内（否则糊成亮带）。
  float sigmaPx = max(1.1500, RING_SIGMA * u_Rh);
  sigmaPx = min(sigmaPx, RING_MAX_SIGMA * u_Rh);
  float sigma = sigmaPx / max(u_Rh, 1.0);
  float ring = exp(-pow((r - RING_R) / sigma, 2.0));
  // 光子环缓慢明暗起伏（动态版要求「光带明暗缓慢柔和起伏，无剧烈闪烁」）
  float ringPulse = 0.92 + 0.08 * sin(t * 0.65);

  vec3 col = colA + colB + RING_COLOR * (ring * RING_GAIN * ringPulse);

  // ---- (d) 盘缝隙里的微弱星尘：极低密度 + 慢闪烁，只做点缀，不喧宾夺主 ----
  // 用低频网格哈希，密度 ~1.8%，亮度 0.22；小窗口下也不会变成"噪点爆炸"。
  vec2 dustCell = floor(q * 34.0);
  float dustH = hash21(dustCell);
  float dust = step(0.982, dustH) * (0.55 + 0.45 * sin(t * 1.10 + dustH * 41.0));
  dust *= smoothstep(0.85, 1.15, r) * (1.0 - smoothstep(2.70, 3.30, r));
  col += vec3(0.75, 0.85, 1.0) * dust * 0.22;

  // 覆盖率由**几何权重**决定（不再依赖亮度）：
  // 暗部也完整覆盖背后的桌面，避免「暗红盘缘被白桌面冲成灰白」。
  float alphaMask = clamp(bandA * occult + arcB * 0.95 + ring * 0.85 + dust * 0.25, 0.0, 1.0);
  alphaMask *= smoothstep(0.0, 0.03, alphaMask);
  if (alphaMask < 0.0002) discard;
  float a = alphaMask * u_opacity;
  outColor = vec4(col * a, a);
}
`;

  /**
   * 由渲染状态算出本 pass 的全部 uniform 值。
   * @param {object} s 渲染状态（见 renderer.js / app.js 的 state）
   */
  function uniforms(s) {
    return {
      u_resolution: [s.width, s.height],
      u_center: [s.centerX, s.centerY],
      u_Rh: s.rh,
      u_time: s.time,
      u_diskSpeed: s.diskSpeed,
      u_opacity: s.opacity,
    };
  }

  return {
    CONST: CONST,
    FRAGMENT: FRAGMENT,
    uniforms: uniforms,
  };
})();
