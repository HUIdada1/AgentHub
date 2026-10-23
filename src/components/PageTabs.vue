<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 主区顶部横条卡片：当前模块的子页面切换（条超宽时可横向滚动）。
     右侧「配置」按钮与左侧 tab 是同一套页面切换逻辑：切到当前模块的配置页（id=config），
     配置页内子板块的二级 tab 由配置页自己渲染，不占这里的位置。
     页签右上角红点 = 该页有「待你处理」的东西（待裁决冲突 / 待确认裁决 / 索引不一致），
     没有待处理项时红点自动消失，不占位置提示不需要的文字 -->
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import { useMemoryStore } from "../stores/memory";
import type { PageDef } from "../types";
import * as api from "../api/ipc";
import { toast } from "../utils/toast";

const app = useAppStore();
const mem = useMemoryStore();
const scrollEl = ref<HTMLElement | null>(null);

/** 页签点击：禁用页（如提示词库的「线上提示词库」）只提示不切页。
 *  为什么是「拦点击」而不是把禁用页从 app.pagesOf 里过滤掉：占位页要「看得见但点不动」，
 *  用户才知道这个能力存在、只是待版本更新；直接隐藏会被当成「功能根本不存在」。
 *  提示统一走 utils/toast（它就是包了一层全站玻璃样式的 ElMessage），与站内其它提示同款外观。 */
function onTabClick(p: PageDef) {
  if (p.disabled) {
    toast.info(p.disabledTip || "待版本更新");
    return;
  }
  app.setPage(p.id);
}

/** 页签待处理红点的唯一事实源（值＝待处理条数，0/未定义＝不显示）：
    技能仓库的待裁决数在 app store，记忆中枢三类待处理在 memory store 的 pending（自动拉取）。
    待确认收件箱已并入「记忆浏览」，故它的红点挂在浏览页上。 */
function pendingCount(pageId: string): number {
  if (app.activeModule === "skills") return pageId === "dedup" ? app.conflictCount : 0;
  if (app.activeModule === "memory") return mem.pending[pageId] || 0;
  return 0;
}

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
  <!-- 第二行右格：当前板块的子页面切换（独立卡片） -->
  <nav class="tabs glass">
    <div ref="scrollEl" class="tabs-scroll" @scroll.passive="updateFades" @wheel="onWheel">
      <button
        v-for="p in app.pagesOf"
        :key="p.id"
        class="tab"
        :class="{ active: !app.pluginView && !p.disabled && app.activePage === p.id, disabled: p.disabled }"
        :aria-disabled="p.disabled ? 'true' : undefined"
        :title="p.disabled ? p.disabledTip || '待版本更新' : undefined"
        @click="onTabClick(p)"
      >
        {{ p.name }}
        <el-tooltip v-if="pendingCount(p.id)" :content="`${pendingCount(p.id)} 项待处理`" placement="top">
          <span class="tab-dot"></span>
        </el-tooltip>
      </button>
      <!-- 外置插件页签：名称取自插件 manifest，插件页激活时模块页签一律不高亮 -->
      <button
        v-if="app.pluginView"
        class="tab active"
        :title="app.pluginView.title"
        @click="app.openPluginView(app.pluginView.id)"
      >
        {{ app.pluginView.title }}
      </button>
    </div>
    <!-- 右侧常驻入口：普通态进配置页，配置态「完成」回到来时页面；不随 tab 条横向滚动。
         插件页激活时隐藏——配置页属于模块，不属于插件 -->
    <button v-if="app.pluginView" class="tab tab-config" @click="app.closePluginView()">
      <i class="ph ph-arrow-left"></i>返回
    </button>
    <button v-else-if="app.activePage === 'config'" class="tab tab-config active" @click="app.closeModuleConfig()">
      <i class="ph ph-check"></i>完成
    </button>
    <button v-else class="tab tab-config" @click="app.openModuleConfig()">
      <i class="ph ph-gear-six"></i>配置
    </button>
  </nav>
</template>

<style scoped>
/* ===== 页面 tab 横条卡 ===== */
.tabs {
  grid-area: tabs;
  height: var(--topbar-h);
  border-radius: var(--r-panel);
  display: flex;
  align-items: center;
  overflow: hidden;
  padding-right: 8px;
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
  position: relative;
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
/* 禁用页签（MODULES 里声明 disabled 的占位页，如提示词库「线上提示词库」）：
   低对比置灰 + not-allowed 指针，并压掉 hover 高亮——按钮看着像能点却没有反馈最容易让人反复点。
   这两条放在 .tab:hover 与亮色主题的 hover 之后：同权重下后者生效，禁用态不会被悬停样式盖掉 */
.tab.disabled {
  color: var(--text-3);
  opacity: 0.55;
  cursor: not-allowed;
}
.tab.disabled:hover,
:root[data-theme="light"] .tab.disabled:hover {
  color: var(--text-3);
  background: transparent;
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

/* 待处理红点：贴在页签右上角，只有「真的有东西等你处理」时才出现 */
.tab-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 2px var(--glass-a);
}
.tab.active .tab-dot {
  box-shadow: 0 0 0 2px var(--accent-dim);
}

/* 反代模块的操作目标（本机 / 远程实例）：常驻在配置入口左边，不随 tab 条滚动 */
.tab-remote {
  margin: 6px 0 6px 2px;
  border-left: 1px solid var(--line);
  border-radius: 0;
  padding-left: 12px;
}
.tab-remote.remote-on {
  color: var(--accent-strong);
}

/* 右侧常驻入口：不随 tab 条横向滚动，左边留一道分隔线 */
.tab-config {
  flex-shrink: 0;
  margin: 0 10px 0 2px;
  border-left: 1px solid var(--line);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  padding-left: 12px;
}
</style>
