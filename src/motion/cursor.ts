/**
 * 液滴光标 + 点击涟漪（液态玻璃设计稿 v5 · 标志性鼠标交互）
 *
 * 三层结构（位置全部即时跟随，零延迟零拖尾）：
 * - x-core  实心核，即时跟随，操作精度无损；
 * - x-drop  外环液滴，位置即时贴住光标，仅保留随速度方向的
 *           压扁拉伸（squash & stretch）液体质感，悬停可交互元素时
 *           融化放大成柔光斑；
 * - x-halo  一团更大的光晕垫底，即时跟随；
 * 点击时荡开一圈涟漪（.dropwave）。
 *
 * 设计约束：
 * - 独立模块零耦合：不触碰任何组件 / store / 模板，仅操作自建 DOM 与 body 类；
 * - 安全兜底：body 上的 cursor:none 只在 DOM 建好且 rAF 启动后才加（cursor-on 类），
 *   模块内任何异常都会走 finally 移除该类，系统光标永远是退路；
 * - 环境门控：触屏（pointer: coarse）与 prefers-reduced-motion: reduce 下不安装；
 * - 页面隐藏时暂停 rAF，最小化到托盘不空烧 CPU；形变收敛后挂起，空闲零开销。
 * - 事件只记坐标，样式写入收敛到每帧一次：高报点率鼠标一帧能触发十几次 mousemove，
 *   每次都写三层 transform 是纯浪费；挂起态收到事件才就地吸附一次（零延迟保底）。
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
  // mx/my：光标当前位置；px/py：上一帧位置（帧间差分估速用）
  let mx = window.innerWidth / 2;
  let my = window.innerHeight / 2;
  let px = mx;
  let py = my;
  let svx = 0;
  let svy = 0; // 平滑后的瞬时速度（像素/帧），只驱动形变，不参与定位
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
    if (running) return; // 运行态交给 tick 每帧统一写：高报点率鼠标一帧能来十几次事件，
    // 每次都写样式是纯浪费；挂起态才就地吸附，保住"零延迟零拖尾"
    syncPosition();
    start();
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

  /** withDrop=false 供 tick 用：drop 的 transform 含当帧形变，由形变段统一写，
      避免同一帧内先写一版再覆盖一版 */
  function syncPosition(withDrop = true) {
    core.style.transform = `translate(${mx}px, ${my}px)`;
    if (withDrop)
      drop.style.transform =
        `translate(${mx.toFixed(1)}px, ${my.toFixed(1)}px) rotate(${dropAngle.toFixed(3)}rad)` +
        ` scale(${(1 + dropStretch).toFixed(3)}, ${(1 - dropStretch * 0.55).toFixed(3)})`;
    halo.style.transform = `translate(${mx}px, ${my}px)`;
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    syncPosition(false);
    // 帧间差分估速 + 低通滤波：速度只用于液滴的 squash & stretch 形变，不影响定位
    const ivx = mx - px;
    const ivy = my - py;
    px = mx;
    py = my;
    svx += (ivx - svx) * 0.35;
    svy += (ivy - svy) * 0.35;
    const speed = Math.min(Math.hypot(svx, svy), 26);
    dropStretch += ((speed / 26) * 0.42 - dropStretch) * 0.2;
    if (speed > 1.2) {
      const a = Math.atan2(svy, svx);
      let diff = a - dropAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      dropAngle += diff * 0.25;
    }
    drop.style.transform =
      `translate(${mx.toFixed(1)}px, ${my.toFixed(1)}px) rotate(${dropAngle.toFixed(3)}rad)` +
      ` scale(${(1 + dropStretch).toFixed(3)}, ${(1 - dropStretch * 0.55).toFixed(3)})`;
    // 形变收敛且速度归零时挂起，等下一次鼠标活动再唤醒（空闲 0 开销）
    if (dropStretch < 0.005 && speed < 0.05) {
      dropStretch = 0;
      svx = 0;
      svy = 0;
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
    syncPosition();
    start();
    // 一切就绪后才隐藏系统光标（失败路径不会走到这里）
    document.body.classList.add("cursor-on");
  } catch {
    teardown();
  }

  return teardown;
}
