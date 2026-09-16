/**
 * HUD 十字准星光标 + 点击冲击波（液态玻璃动效概念稿 v4 · 标志性鼠标交互）
 *
 * 设计约束：
 * - 独立模块零耦合：不触碰任何组件 / store / 模板，仅操作自建 DOM 与 body 类；
 * - 可用性优先：准星 core 即时跟随光标（不插值，操作精度无损），外环 lerp 拖尾；
 * - 安全兜底：body 上的 cursor:none 只在 DOM 建好且 rAF 启动后才加（xhair-on 类），
 *   模块内任何异常都会走 finally 移除该类，系统光标永远是退路；
 * - 环境门控：触屏（pointer: coarse）与 prefers-reduced-motion: reduce 下不安装；
 * - 页面隐藏时暂停 rAF，最小化到托盘不空烧 CPU。
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
].join(", ");

export function installCursorFX(): () => void {
  const fine = window.matchMedia("(pointer: fine)").matches;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduced) return () => {};

  let disposed = false;
  let raf = 0;
  let running = false;
  let mx = window.innerWidth / 2;
  let my = window.innerHeight / 2;
  // 外环/刻度盘的 lerp 位置（拖尾），core 直接用 mx/my（即时）
  let rx = mx;
  let ry = my;

  const xhair = document.createElement("div");
  xhair.className = "xhair";
  xhair.setAttribute("aria-hidden", "true");
  for (const cls of ["x-ring", "x-ticks", "x-cross", "x-cross v", "x-core"]) {
    const el = document.createElement("div");
    el.className = cls;
    xhair.appendChild(el);
  }

  const onMove = (e: MouseEvent) => {
    mx = e.clientX;
    my = e.clientY;
    if (!running) start();
    // 即刻把 core 与十字线吸附到最新光标位（不等下一帧）：拖尾只留给外环，
    // 快速甩动鼠标时中心点也不脱节
    syncCore();
  };
  const onOver = (e: MouseEvent) => {
    const hot = (e.target as HTMLElement | null)?.closest?.(HOT_SELECTOR);
    xhair.classList.toggle("hot", !!hot);
  };
  const onDown = (e: PointerEvent) => {
    xhair.classList.add("press");
    spawnShockwave(e.clientX, e.clientY);
  };
  const onUp = () => xhair.classList.remove("press");
  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };

  function spawnShockwave(x: number, y: number) {
    const s = document.createElement("div");
    s.className = "shockwave";
    s.setAttribute("aria-hidden", "true");
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.addEventListener("animationend", () => s.remove(), { once: true });
    document.body.appendChild(s);
    // 动画被全局 reduced-motion 兜底压零时 animationend 仍会触发；保险起见限时自清
    setTimeout(() => s.remove(), 1200);
  }

  function syncCore() {
    const core = xhair.querySelector<HTMLElement>(".x-core");
    const crossH = xhair.querySelector<HTMLElement>(".x-cross:not(.v)");
    const crossV = xhair.querySelector<HTMLElement>(".x-cross.v");
    if (core) core.style.transform = `translate(${mx}px, ${my}px)`;
    if (crossH) crossH.style.transform = `translate(${mx}px, ${my}px)`;
    if (crossV) crossV.style.transform = `translate(${mx}px, ${my}px)`;
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    syncCore();
    // 外环与刻度盘 lerp 追逐（能量拖尾）
    rx += (mx - rx) * 0.28;
    ry += (my - ry) * 0.28;
    (xhair.querySelector<HTMLElement>(".x-ring") ?? xhair).style.transform = `translate(${rx.toFixed(1)}px, ${ry.toFixed(1)}px)`;
    const ticks = xhair.querySelector<HTMLElement>(".x-ticks");
    if (ticks) ticks.style.transform = `translate(${rx.toFixed(1)}px, ${ry.toFixed(1)}px)`;
    // 已基本贴合时挂起，等下一次鼠标活动再唤醒（空闲 0 开销）
    if (Math.abs(mx - rx) < 0.3 && Math.abs(my - ry) < 0.3) {
      rx = mx;
      ry = my;
      stop();
      // 停止前把外环精确吸附到位
      (xhair.querySelector<HTMLElement>(".x-ring") ?? xhair).style.transform = `translate(${mx}px, ${my}px)`;
      if (ticks) ticks.style.transform = `translate(${mx}px, ${my}px)`;
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
    window.removeEventListener("pointerup", onUp);
    document.removeEventListener("visibilitychange", onVisibility);
    xhair.remove();
    document.body.classList.remove("xhair-on");
  }

  try {
    document.body.appendChild(xhair);
    // 捕获阶段监听：项目内多处 stopPropagation 不影响光标跟踪
    window.addEventListener("mousemove", onMove, { passive: true, capture: true });
    document.addEventListener("mouseover", onOver, { passive: true, capture: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();
    // 一切就绪后才隐藏系统光标（失败路径不会走到这里）
    document.body.classList.add("xhair-on");
  } catch {
    teardown();
  }

  return teardown;
}
