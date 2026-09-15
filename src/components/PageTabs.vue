<!-- 主区顶部横条卡片：当前模块的子页面切换（条超宽时可横向滚动）。
     右侧「配置」按钮与左侧 tab 是同一套页面切换逻辑：切到当前模块的配置页（id=config），
     配置页内子板块的二级 tab 由配置页自己渲染，不占这里的位置 -->
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const scrollEl = ref<HTMLElement | null>(null);

// 左右边缘渐隐提示还有内容可滚；条不超宽时两端贴边、无渐隐
function updateFades() {
  const el = scrollEl.value;
  if (!el) return;
  el.classList.toggle("fade-l", el.scrollLeft > 4);
  el.classList.toggle("fade-r", el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
}

// 纵向滚轮转横向滚动：tab 条超宽时免按 Shift
function onWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
}

// 切换模块后回到条头
watch(
  () => app.activeModule,
  () =>
    nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollLeft = 0;
      updateFades();
    })
);
onMounted(updateFades);
</script>

<template>
  <nav class="tabs glass">
    <div ref="scrollEl" class="tabs-scroll" @scroll.passive="updateFades" @wheel="onWheel">
      <button
        v-for="p in app.pagesOf"
        :key="p.id"
        class="tab"
        :class="{ active: app.activePage === p.id }"
        @click="app.setPage(p.id)"
      >
        {{ p.name }}
        <span v-if="p.badge" class="tab-badge">{{ p.badge }}</span>
      </button>
    </div>
    <!-- 右侧常驻入口：普通态进配置页，配置态「完成」回到来时页面；不随 tab 条横向滚动 -->
    <button v-if="app.activePage === 'config'" class="tab tab-config active" @click="app.closeModuleConfig()">
      <i class="ph ph-check"></i>完成
    </button>
    <button v-else class="tab tab-config" @click="app.openModuleConfig()">
      <i class="ph ph-gear-six"></i>配置
    </button>
  </nav>
</template>

<style scoped>
.tabs {
  grid-area: tabs;
  border-radius: var(--r-panel);
  display: flex;
  overflow: hidden;
  min-height: 46px;
}
.tabs-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  /* 滚动条隐藏，横移靠滚轮 / 触摸板；可滚方向用边缘渐隐提示 */
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.fade-l {
  mask-image: linear-gradient(to right, transparent, #000 20px);
}
.fade-r {
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
}
.fade-l.fade-r {
  mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent);
}

.tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: var(--ctl-h);
  padding: 0 14px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 550;
  line-height: 1;
  font-family: var(--font-ui);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.tab .ph {
  font-size: 14px;
}
.tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}
:root[data-theme="light"] .tab:hover {
  background: rgba(15, 23, 42, 0.045);
}
.tab.active {
  color: var(--accent-strong);
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.tab:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 2px;
}
.tab-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-3);
}
:root[data-theme="light"] .tab-badge {
  background: rgba(15, 23, 42, 0.06);
}
.tab.active .tab-badge {
  background: rgba(68, 224, 127, 0.18);
  color: var(--accent-strong);
}

/* 右侧常驻入口：不随 tab 条横向滚动，左边留一道分隔线 */
.tab-config {
  flex-shrink: 0;
  margin: 6px 10px 6px 2px;
  border-left: 1px solid var(--line);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  padding-left: 12px;
}
</style>
