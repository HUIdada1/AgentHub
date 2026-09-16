/**
 * 液滴光标 + 点击涟漪（液态玻璃设计稿 v5 · 标志性鼠标交互）
 *
 * 三层结构：
 * - x-core  实心核，即时跟随（不插值，操作精度无损）；
 * - x-drop  外环液滴，弹簧追赶 + 随速度方向压扁拉伸（squash & stretch），
 *           悬停可交互元素时融化放大成柔光斑（尺寸/配色过渡由 CSS 承担）；
 * - x-halo  一团更大更慢的光晕垫底；
 * 点击时荡开一圈涟漪（.dropwave）。
 *
 * 设计约束：
 * - 独立模块零耦合：不触碰任何组件 / store / 模板，仅操作自建 DOM 与 body 类；
 * - 安全兜底：body 上的 cursor:none 只在 DOM 建好且 rAF 启动后才加（cursor-on 类），
 *   模块内任何异常都会走 finally 移除该类，系统光标永远是退路；
 * - 环境门控：触屏（pointer: coarse）与 prefers-reduced-motion: reduce 下不安装；
 * - 页面隐藏时暂停 rAF，最小化到托盘不空烧 CPU；弹簧贴合后挂起，空闲零开销。
 */

const HOT_SELECTOR = [
  "button",
  ".btn",
  ".chip",
  ".tab",
  ".cfg-subtab",
  "[role=tab]",
  ".switch",
  "a",
  ".st-pill",
  ".card",
  ".kpi",
  ".row",
  ".hud-card",
  ".module-card",
  ".ov-row",
  ".tbl tbody tr",
].join(", ");

export function installCursorFX(): () => void {
  const fine = window.matchMedia("(pointer: fine)").matches;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduced) return () => {};

  let disposed = false;
  let raf = 0;
  let running = false;
  // mx/my：光标真实位置（core 即时跟随）；dx/dy：液滴弹簧位置；hx/hy：光晕 lerp 位置
  let mx = window.innerWidth / 2;
  let my = window.innerHeight / 2;
  let dx = mx;
  let dy = my;
  let hx = mx;
  let hy = my;
  let pvx = 0;
  let pvy = 0; // 液滴弹簧速度（欠阻尼振荡）
  let dropAngle = 0; // 液滴朝向（沿运动方向）
  let dropStretch = 0; // 液滴当前拉伸量

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");
  for (const cls of ["x-halo", "x-drop", "x-core"]) {
    const el = document.createElement("div");
    el.className = cls;
    cursor.appendChild(el);
  }
  const halo = cursor.querySelector<HTMLElement>(".x-halo")!;
  const drop = cursor.querySelector<HTMLElement>(".x-drop")!;
  const core = cursor.querySelector<HTMLElement>(".x-core")!;

  const onMove = (e: MouseEvent) => {
    mx = e.clientX;
    my = e.clientY;
    if (!running) start();
    // 即刻把核吸附到最新光标位（不等下一帧）：快速甩动鼠标时中心点也不脱节
    core.style.transform = `translate(${mx}px, ${my}px)`;
  };
  const onOver = (e: MouseEvent) => {
    const hot = (e.target as HTMLElement | null)?.closest?.(HOT_SELECTOR);
    cursor.classList.toggle("hot", !!hot);
  };
  const onDown = (e: PointerEvent) => spawnRipple(e.clientX, e.clientY);
  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };

  function spawnRipple(x: number, y: number) {
    const w = document.createElement("div");
    w.className = "dropwave";
    w.setAttribute("aria-hidden", "true");
    w.style.left = `${x}px`;
    w.style.top = `${y}px`;
    w.addEventListener("animationend", () => w.remove(), { once: true });
    document.body.appendChild(w);
    // 动画被全局 reduced-motion 兜底压零时 animationend 仍会触发；保险起见限时自清
    setTimeout(() => w.remove(), 900);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    // 外环液滴：弹簧追赶（欠阻尼），速度越大沿运动方向压扁拉伸越明显
    pvx += ((mx - dx) * 0.22 - pvx) * 0.35;
    pvy += ((my - dy) * 0.22 - pvy) * 0.35;
    dx += pvx * 0.62;
    dy += pvy * 0.62;
    const speed = Math.min(Math.hypot(pvx, pvy), 26);
    dropStretch += ((speed / 26) * 0.42 - dropStretch) * 0.2;
    if (speed > 1.2) {
      const a = Math.atan2(pvy, pvx);
      let diff = a - dropAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      dropAngle += diff * 0.25;
    }
    drop.style.transform =
      `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${dropAngle.toFixed(3)}rad)` +
      ` scale(${(1 + dropStretch).toFixed(3)}, ${(1 - dropStretch * 0.55).toFixed(3)})`;
    // 大光晕：最慢一层 lerp，垫底氛围
    hx += (mx - hx) * 0.07;
    hy += (my - hy) * 0.07;
    halo.style.transform = `translate(${hx.toFixed(1)}px, ${hy.toFixed(1)}px)`;
    // 弹簧已贴合且拉伸归零时挂起，等下一次鼠标活动再唤醒（空闲 0 开销）
    if (
      Math.abs(mx - dx) < 0.3 &&
      Math.abs(my - dy) < 0.3 &&
      Math.abs(mx - hx) < 0.3 &&
      Math.abs(my - hy) < 0.3 &&
      dropStretch < 0.005 &&
      speed < 0.05
    ) {
      dx = mx;
      dy = my;
      hx = mx;
      hy = my;
      pvx = 0;
      pvy = 0;
      dropStretch = 0;
      drop.style.transform = `translate(${mx}px, ${my}px)`;
      halo.style.transform = `translate(${mx}px, ${my}px)`;
      stop();
    }
  }

  function start() {
    if (running || disposed) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }

  function teardown() {
    if (disposed) return;
    disposed = true;
    stop();
    window.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseover", onOver, true);
    window.removeEventListener("pointerdown", onDown);
    document.removeEventListener("visibilitychange", onVisibility);
    cursor.remove();
    document.body.classList.remove("cursor-on");
  }

  try {
    document.body.appendChild(cursor);
    // 捕获阶段监听：项目内多处 stopPropagation 不影响光标跟踪
    window.addEventListener("mousemove", onMove, { passive: true, capture: true });
    document.addEventListener("mouseover", onOver, { passive: true, capture: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();
    // 一切就绪后才隐藏系统光标（失败路径不会走到这里）
    document.body.classList.add("cursor-on");
  } catch {
    teardown();
  }

  return teardown;
}
