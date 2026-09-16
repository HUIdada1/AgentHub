<!-- 沐辉制作：AgentHub Agent中控台入口 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { animate, stagger } from "motion-v";
import { usePreferredReducedMotion } from "@vueuse/core";
import { useAppStore } from "./stores/app";
import { useSyncStore } from "./stores/sync";
import Sidebar from "./components/Sidebar.vue";
import PageTabs from "./components/PageTabs.vue";
import SettingsDialog from "./components/config/SettingsDialog.vue";
import ConfigSkillsSection from "./components/config/ConfigSkillsSection.vue";
import ConfigUsageSection from "./components/config/ConfigUsageSection.vue";
import ConfigProxySection from "./components/config/ConfigProxySection.vue";
import SkillsHelpDialog from "./components/SkillsHelpDialog.vue";
// 三大模块的页面视图：各自独立目录，分别开发互不干扰
import SkillsDashboardView from "./views/skills/SkillsDashboardView.vue";
import SkillsLibraryView from "./views/skills/SkillsLibraryView.vue";
import SkillsDedupView from "./views/skills/SkillsDedupView.vue";
import SkillsSyncView from "./views/skills/SkillsSyncView.vue";
import SkillsWebdavView from "./views/skills/SkillsWebdavView.vue";
import SkillsSkillDetailView from "./views/skills/SkillsSkillDetailView.vue";
// 用量统计模块（原「用量记录同步」）：数据源顶栏 + 五个页面 + 同步进度弹窗
import SyncTopBar from "./components/sync/SyncTopBar.vue";
import SyncDialog from "./components/sync/SyncDialog.vue";
import SyncOverviewView from "./views/sync/OverviewView.vue";
import SyncDetailView from "./views/sync/DetailView.vue";
import SyncCostsView from "./views/sync/CostsView.vue";
import SyncBillingRulesView from "./views/sync/BillingRulesView.vue";
import SyncLogView from "./views/sync/LogView.vue";
import ProxyHomeView from "./views/proxy/ProxyHomeView.vue";
import ProxyKeysView from "./views/proxy/ProxyKeysView.vue";
import ProxyAgentsView from "./views/proxy/ProxyAgentsView.vue";
import ProxyModelsView from "./views/proxy/ProxyModelsView.vue";
import ProxyStatsView from "./views/proxy/ProxyStatsView.vue";
import ProxyPoolSyncView from "./views/proxy/ProxyPoolSyncView.vue";
import * as api from "./api/ipc";
import type { UpdateEvent } from "./types";

const app = useAppStore();
const usage = useSyncStore();

/** 系统级减弱动效偏好（VueUse 托管媒体查询，动效层统一听它） */
const reducedMotion = usePreferredReducedMotion();

/** [a, b) 区间随机数 */
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** 背景液态色块的随机漂移参数：位置尺寸写死在 CSS 里，路径 / 周期 / 相位每次启动现摇一份
    （绑在元素 style 上，首帧就是随机值，不会先按默认值动一下再跳） */
const blobs = Array.from({ length: 5 }, () => {
  const offset = () => `${rand(-13, 13).toFixed(2)}%`;
  return {
    "--dur": `${rand(52, 96).toFixed(1)}s`,
    "--delay": `-${rand(0, 70).toFixed(1)}s`,
    "--fx": offset(),
    "--fy": offset(),
    "--gx": offset(),
    "--gy": offset(),
    "--tx": offset(),
    "--ty": offset(),
    "--fs": rand(0.86, 1).toFixed(3),
    "--gs": rand(1.02, 1.14).toFixed(3),
    "--ts": rand(1.14, 1.3).toFixed(3),
  };
});

/** 鼠标交互 · 其一：玻璃壳内的反光。光标在窗口里的相对位置 = 全窗口唯一光源的位置，
   反光落在各壳的 ::before 上（z-index: -1，在壳面之内、内容之下），不会盖住任何东西
   其二：卡片悬停时的卡内聚光（--mx/--my 写进卡片自己的坐标） */
function bindPointer() {
  const onMove = (e: MouseEvent) => {
    document.documentElement.style.setProperty("--sx", `${((e.clientX / window.innerWidth) * 2 - 1) * 18}%`);
    document.documentElement.style.setProperty("--sy", `${((e.clientY / window.innerHeight) * 2 - 1) * 18}%`);

    const el = (e.target as HTMLElement)?.closest?.(".card, .kpi, .module-card") as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  window.addEventListener("mousemove", onMove, { passive: true });
  return () => window.removeEventListener("mousemove", onMove);
}

/** 鼠标交互 · 其三（底板主体）：整片液态背景随光标轻微偏移，两团光池在玻璃之下慢慢追过去。
   两层速度不同，拉开纵深；滚动时背景再反向错一层（软钳制 ±38px），形成背景视差。
   都在 z-index: -1 的底板里，隔着玻璃壳被折射出来 */
function bindBackdrop() {
  const ambient = document.querySelector<HTMLElement>(".ambient");
  const pools = Array.from(document.querySelectorAll<HTMLElement>(".pool"));
  if (!ambient || !pools.length) return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const speed = [0.05, 0.1]; // 一慢一快：慢的像底层液体，快的像浮在上面的一层
  let tx = window.innerWidth / 2;
  let ty = window.innerHeight / 2;
  let ax = 0;
  let ay = 0;
  // 页面滚动驱动的背景视差：tanh 软钳制，滚得再深背景也只偏移一小段
  let scrollRaw = 0;
  let scrollSmooth = 0;
  const pos = pools.map(() => ({ x: tx, y: ty }));

  const onMove = (e: MouseEvent) => {
    tx = e.clientX;
    ty = e.clientY;
  };
  window.addEventListener("mousemove", onMove, { passive: true });
  // capture：.page / .sync-page 这些内部滚动容器的 scroll 不冒泡，必须在捕获阶段拿
  const onScroll = (e: Event) => {
    const scroller = e.target as HTMLElement;
    if (scroller?.classList?.contains("page") || scroller?.classList?.contains("sync-page")) {
      scrollRaw = scroller.scrollTop;
    }
  };
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // 整片背景朝光标侧偏移（上限 ±14px），像液面被轻轻推了一下
    ax += (((tx / window.innerWidth) * 2 - 1) * 14 - ax) * 0.05;
    ay += (((ty / window.innerHeight) * 2 - 1) * 14 - ay) * 0.05;
    // 滚动视差：内容往上走，背景以约 6% 的速率反向错开，缓动追随不生硬
    scrollSmooth += (scrollRaw - scrollSmooth) * 0.08;
    const par = -38 * Math.tanh(scrollSmooth / 700);
    ambient.style.transform = `translate3d(${ax.toFixed(2)}px, ${(ay + par).toFixed(2)}px, 0)`;
    pools.forEach((el, i) => {
      const p = pos[i];
      const sp = speed[i] ?? 0.08;
      p.x += (tx - p.x) * sp;
      p.y += (ty - p.y) * sp;
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y + par * (i ? 0.5 : 0.8)).toFixed(1)}px, 0)`;
    });
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}

/** 滚动渐入 + 卡片错落：页面内容块第一次进入视口时，由 motion-v 做一次
   「上浮 + 淡入 + 轻微过冲回弹」，同批露出的兄弟按 55ms 错峰，层次就出来了。
   全程只播一次（IO 触发即断开），之后悬停/布局动画完全不受影响。
   目标选择器覆盖三套体系：框架 .page-body / skills .sk- / 用量同步 .sync-scope */
function bindReveal() {
  const io = new IntersectionObserver(
    (entries) => {
      // 同一帧露出的归为一组，组内错峰才有"错落"而不是"齐步走"
      const batch = entries.filter((en) => en.isIntersecting).map((en) => en.target as HTMLElement);
      if (!batch.length) return;
      batch.forEach((el) => io.unobserve(el));
      if (reducedMotion.value === "reduce") return; // 不播动画，元素保持默认可见
      animate(
        batch,
        { opacity: [0, 1], transform: ["translateY(16px) scale(0.985)", "translateY(0px) scale(1)"] },
        { duration: 0.55, delay: stagger(0.055), ease: [0.22, 1.2, 0.36, 1] as const }
      );
    },
    { threshold: 0.06, rootMargin: "0px 0px -4% 0px" }
  );

  const SELECTOR = [
    ".page-body > *",
    ".kpis > *",
    ".grid-2 > *",
    ".sk-page section",
    ".sk-grid > *",
    ".top-kpis-grid > .kpi",
    ".sync-scope .card",
  ].join(", ");

  const seen = new WeakSet<Element>();
  function scan(root: ParentNode) {
    root.querySelectorAll(SELECTOR).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      io.observe(el);
    });
  }

  // 页面懒挂载 / 列表数据后渲染，新节点随时可能出现，子树变动时增量扫描
  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) scan(n as Element);
      });
    });
  });
  const pages = document.querySelector(".pages");
  if (pages) {
    scan(pages);
    mo.observe(pages, { childList: true, subtree: true });
  }

  return () => {
    io.disconnect();
    mo.disconnect();
  };
}

/** 数字变化平滑过渡：指标卡文本里的数值变化时，用 motion-v 的补间从旧值滚到新值，
   前缀 / 后缀 / 千分位 / 小数位原样保留。
   只挑纯文本节点：带子元素的指标卡会被 textContent 覆写掉子节点，故不在目标内；
   用量同步总览的 .k-value 自带滚动动画，也刻意排除，避免双重补间 */
function bindCountUp() {
  const NUM = /(-?[\d,]+(?:\.\d+)?)/;
  const TARGET = ".kpi b, .agg-item b, .big-num, .ov-num";
  const last = new WeakMap<HTMLElement, string>();
  // 自己写进去的中间值：补间每帧都在改 textContent，会反过来触发 MutationObserver；
  // 不认领这些写入就会「自己触发自己」，在动画中途反向重开，读数是来回抖的
  const selfWritten = new WeakMap<HTMLElement, string>();
  const running = new WeakMap<HTMLElement, { stop: () => void }>();

  function parse(text: string) {
    const m = text.match(NUM);
    if (!m || m.index === undefined) return null;
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) return null;
    return { prefix: text.slice(0, m.index), suffix: text.slice(m.index + m[1].length), value, raw: m[1] };
  }

  function onChange(el: HTMLElement) {
    const text = el.textContent ?? "";
    if (selfWritten.get(el) === text) return; // 自己刚写的中间帧，不是外部数据变化
    if (last.get(el) === text) return;
    const to = parse(text);
    const from = parse(last.get(el) ?? "");
    last.set(el, text);
    // 锚定基线 / 非数值变化 / 减弱动效：直接过，不补间
    if (!to || !from || to.value === from.value || reducedMotion.value === "reduce") return;
    if (Math.abs(to.value) >= 1e15 || Math.abs(from.value) >= 1e15) return;
    // 口径以新文本为准：千分位有没有、小数留几位，滚动过程不跳格式
    const grouped = to.raw.includes(",");
    const decimals = (to.raw.split(".")[1] ?? "").length;
    const fmt = (v: number) =>
      to.prefix + v.toLocaleString("en-US", { useGrouping: grouped, minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + to.suffix;
    running.get(el)?.stop();
    running.set(
      el,
      animate(from.value, to.value, {
        duration: 0.7,
        easing: [0.16, 1, 0.3, 1],
        onUpdate: (v: number) => {
          const s = fmt(v);
          selfWritten.set(el, s);
          el.textContent = s;
        },
        onComplete: () => {
          // 收尾对齐到目标文本：浮点补间的最后一帧可能差一位小数
          selfWritten.set(el, text);
          el.textContent = text;
        },
      } as never)
    );
  }

  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => {
      const el = (m.target as HTMLElement).closest?.(TARGET) as HTMLElement | null;
      if (el) onChange(el);
    });
  });
  // 观察根取整个应用：侧栏「渠道额度」的数字不在 .pages 里，只盯 .pages 会漏掉它
  const root = document.querySelector(".app");
  if (!root) return () => {};
  // 基线：已存在的数字只记录不滚动，之后的真实变化才补间
  root.querySelectorAll<HTMLElement>(TARGET).forEach((el) => last.set(el, el.textContent ?? ""));
  mo.observe(root, { childList: true, subtree: true, characterData: true });

  return () => mo.disconnect();
}

/** 粒子场：极淡的慢速尘粒铺在最底层（z-index: -2，在液态色块之下被玻璃一起折射），
   随页面滚动有 2% 速率的视差，纯粹的氛围层，不抢任何主体信息 */
function bindParticles() {
  const canvas = document.querySelector<HTMLCanvasElement>(".particles");
  if (!canvas) return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  let w = 0;
  let h = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas!.width = w * dpr;
    canvas!.height = h * dpr;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // 两种色相：主绿与信息蓝，与液态色块同一套色温。
  // 细分两档：多数是背景浮尘，少数是更慢更淡的大颗粒，两层速度差拉出景深
  const COLORS = ["68, 224, 127", "92, 157, 255"];
  const dots = Array.from({ length: 58 }, (_, i) => {
    const big = i % 9 === 0; // 约 6 颗大颗粒
    return {
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: rand(-4, 4) * (big ? 0.5 : 1), // px/s
      vy: rand(-6, -1.5) * (big ? 0.45 : 1), // 整体缓慢上浮
      r: big ? rand(2.2, 3.4) : rand(0.6, 1.5),
      c: COLORS[Math.random() < 0.72 ? 0 : 1],
      a: big ? rand(0.05, 0.13) : rand(0.1, 0.3),
      ph: rand(0, Math.PI * 2), // 闪烁相位
      ps: rand(0.4, 1.1), // 闪烁速率
      par: big ? 0.045 : 0.02, // 各自的视差速率：大颗粒更近，滚得更多
    };
  });

  let scrollRaw = 0;
  let scrollSmooth = 0;
  const onScroll = (e: Event) => {
    const scroller = e.target as HTMLElement;
    if (scroller?.classList?.contains("page") || scroller?.classList?.contains("sync-page")) {
      scrollRaw = scroller.scrollTop;
    }
  };
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  let raf = 0;
  let prev = performance.now();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;
    scrollSmooth += (scrollRaw - scrollSmooth) * 0.06;
    ctx!.clearRect(0, 0, w, h);
    for (const d of dots) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // 出界回绕：上方飘出从底部回来，左右同理
      if (d.y < -8) d.y = h + 8;
      if (d.y > h + 8) d.y = -8;
      if (d.x < -8) d.x = w + 8;
      if (d.x > w + 8) d.x = -8;
      const tw = 0.65 + 0.35 * Math.sin(now / 1000 * d.ps + d.ph);
      let dy = (d.y + scrollSmooth * d.par) % (h + 16);
      if (dy < -8) dy += h + 16;
      ctx!.beginPath();
      ctx!.arc(d.x, dy - 8, d.r, 0, Math.PI * 2);
      ctx!.fillStyle = `rgba(${d.c}, ${(d.a * tw).toFixed(3)})`;
      ctx!.fill();
    }
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}

/** 按钮点击涟漪：一次向外扩散，动画跑完自清（原生 .btn 与 Element 的 .el-button 都吃） */
function bindRipple() {
  const onDown = (e: PointerEvent) => {
    const btn = (e.target as HTMLElement)?.closest?.("button.btn, button.el-button, button.sk-btn") as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    // 文字按钮不铺涟漪
    if (btn.classList.contains("btn-link") || btn.classList.contains("is-link") || btn.classList.contains("is-text")) return;
    const r = btn.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.4;
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.style.width = dot.style.height = `${d}px`;
    dot.style.left = `${e.clientX - r.left - d / 2}px`;
    dot.style.top = `${e.clientY - r.top - d / 2}px`;
    dot.addEventListener("animationend", () => dot.remove());
    btn.appendChild(dot);
  };
  document.addEventListener("pointerdown", onDown);
  return () => document.removeEventListener("pointerdown", onDown);
}

let dispose: (() => void)[] = [];
onMounted(() => {
  app.load();
  usage.load(); // 用量同步：配置/数据源清单/同步进度轮询（与原应用一致）
  // 更新通知 / 托盘点击「发现新版本」：全局唯一监听，打开设置弹窗 · 通用并自增信号
  // （滚动高亮由 ConfigGeneralSection 据 configFocusUpdate 执行；浏览器预览无桥接返回 undefined）
  const offFocusUpdate = api.onUpdateEvent((e) => {
    if ((e as UpdateEvent).event !== "focus-update") return;
    app.openSettings("general");
    app.configFocusUpdate++;
  });
  dispose = [bindPointer(), bindBackdrop(), bindRipple(), bindReveal(), bindCountUp(), bindParticles()];
  if (offFocusUpdate) dispose.push(offFocusUpdate);
});
onUnmounted(() => dispose.forEach((fn) => fn()));

/** 当前是否停在某模块某页（v-show 与进场动画条件共用） */
const on = (mod: string, page: string) => app.activeModule === mod && app.activePage === page;

/** 懒挂载：页面首次进入才挂载（数据加载走各自的 onMounted），之后 v-show 保活不切状态。
    避免启动时就把十几个页面的扫描/探测 IPC 全打一遍 */
const visited = ref<Record<string, boolean>>({ [`${app.activeModule}/${app.activePage}`]: true });
watch(
  () => `${app.activeModule}/${app.activePage}`,
  (k) => {
    visited.value[k] = true;
  }
);
const seen = (mod: string, page: string) => !!visited.value[`${mod}/${page}`];
</script>

<template>
  <!-- 最底层：粒子尘场（z-index: -2）→ 随机涌动的液态色块 + 两团跟着光标游走的光池（z-index: -1），
       都在玻璃壳之下被折射出来；3D 球体作为氛围浮在主区右上的玻璃之下；
       最上面一层是颗粒质感。都不吃鼠标事件 -->
  <canvas class="particles" aria-hidden="true"></canvas>
  <div class="ambient" aria-hidden="true">
    <i v-for="(blob, i) in blobs" :key="i" :style="blob"></i>
  </div>
  <div class="pool" aria-hidden="true"></div>
  <div class="pool" aria-hidden="true"></div>
  <div class="orb" aria-hidden="true"><i></i></div>
  <div class="grain" aria-hidden="true"></div>
  <div class="app">
    <Sidebar />
    <PageTabs />
    <main class="main glass">
      <!-- 用量统计模块的数据源顶栏（原应用 AppBar）：仅「用量统计 · 总览」页显示；样式作用域在组件根上 -->
      <SyncTopBar v-if="on('sync', 'overview')" />
      <div class="pages">
        <SkillsDashboardView v-if="seen('skills', 'dashboard')" v-show="on('skills', 'dashboard')" :class="{ 'page-anim': on('skills', 'dashboard') }" />
        <SkillsLibraryView v-if="seen('skills', 'library')" v-show="on('skills', 'library')" :class="{ 'page-anim': on('skills', 'library') }" />
        <SkillsDedupView v-if="seen('skills', 'dedup')" v-show="on('skills', 'dedup')" :class="{ 'page-anim': on('skills', 'dedup') }" />
        <SkillsSyncView v-if="seen('skills', 'sync')" v-show="on('skills', 'sync')" :class="{ 'page-anim': on('skills', 'sync') }" />
        <SkillsWebdavView v-if="seen('skills', 'webdav')" v-show="on('skills', 'webdav')" :class="{ 'page-anim': on('skills', 'webdav') }" />
        <SkillsSkillDetailView v-if="seen('skills', 'skill-detail')" v-show="on('skills', 'skill-detail')" :class="{ 'page-anim': on('skills', 'skill-detail') }" />
        <!-- 用量统计五页：.sync-page 的样式作用域要求自身同时带 .sync-scope（见 styles/sync.css） -->
        <SyncOverviewView v-if="seen('sync', 'overview')" v-show="on('sync', 'overview')" class="sync-scope" :class="{ 'page-anim': on('sync', 'overview') }" />
        <SyncDetailView v-if="seen('sync', 'detail')" v-show="on('sync', 'detail')" class="sync-scope" :class="{ 'page-anim': on('sync', 'detail') }" />
        <SyncCostsView v-if="seen('sync', 'costs')" v-show="on('sync', 'costs')" class="sync-scope" :class="{ 'page-anim': on('sync', 'costs') }" />
        <SyncBillingRulesView v-if="seen('sync', 'billing')" v-show="on('sync', 'billing')" class="sync-scope" :class="{ 'page-anim': on('sync', 'billing') }" />
        <SyncLogView v-if="seen('sync', 'log')" v-show="on('sync', 'log')" class="sync-scope" :class="{ 'page-anim': on('sync', 'log') }" />
        <ProxyHomeView v-if="seen('proxy', 'home')" v-show="on('proxy', 'home')" :class="{ 'page-anim': on('proxy', 'home') }" />
        <ProxyKeysView v-if="seen('proxy', 'keys')" v-show="on('proxy', 'keys')" :class="{ 'page-anim': on('proxy', 'keys') }" />
        <ProxyAgentsView v-if="seen('proxy', 'agents')" v-show="on('proxy', 'agents')" :class="{ 'page-anim': on('proxy', 'agents') }" />
        <ProxyModelsView v-if="seen('proxy', 'models')" v-show="on('proxy', 'models')" :class="{ 'page-anim': on('proxy', 'models') }" />
        <ProxyStatsView v-if="seen('proxy', 'stats')" v-show="on('proxy', 'stats')" :class="{ 'page-anim': on('proxy', 'stats') }" />
        <ProxyPoolSyncView v-if="seen('proxy', 'poolsync')" v-show="on('proxy', 'poolsync')" :class="{ 'page-anim': on('proxy', 'poolsync') }" />
        <!-- 三大模块的配置页：右上「配置」按钮切换到这里的页面（page + cfg-body 组合出页壳与留白）；
             配置页内部的二级子板块 tab 由各 section 自己渲染 -->
        <div v-if="seen('skills', 'config')" v-show="on('skills', 'config')" class="page cfg-body" :class="{ 'page-anim': on('skills', 'config') }">
          <ConfigSkillsSection />
        </div>
        <div v-if="seen('sync', 'config')" v-show="on('sync', 'config')" class="page cfg-body" :class="{ 'page-anim': on('sync', 'config') }">
          <ConfigUsageSection />
        </div>
        <div v-if="seen('proxy', 'config')" v-show="on('proxy', 'config')" class="page cfg-body" :class="{ 'page-anim': on('proxy', 'config') }">
          <ConfigProxySection />
        </div>
      </div>
    </main>
    <!-- 常驻挂载：显隐交给 el-dialog 自己管，进场动画才不会在 v-if 挂载时被跳过 -->
    <SyncDialog />
    <SkillsHelpDialog />
    <SettingsDialog />
  </div>
</template>
