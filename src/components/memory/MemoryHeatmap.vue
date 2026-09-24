<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 全年记录热力图：GitHub 式周列日历（写法与「用量统计」的全年用量热力图一致），
     点任一格回调当天日期；悬停毛玻璃看板走 Teleport，位置直写 DOM，换格才触发重渲染。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps<{ data: { day: string; count: number }[]; picked?: string | null }>();
const emit = defineEmits<{ (e: "pick", day: string): void }>();

// 20 级绿色渐变：与「用量统计」全年热力图同一套色阶（0 = 无记录：灰白半透明）
const HEAT_LEVELS = [
  "rgba(236, 236, 236, 0.28)", "#D9F2E3", "#CDEEDA", "#C0EAD1", "#B3E7C7",
  "#A6E3BE", "#98E0B4", "#8BDDAA", "#7DDA9F", "#6FD895",
  "#61D58A", "#53D37F", "#44D174", "#35CF69", "#2DC760",
  "#29BB58", "#25AE50", "#21A248", "#1D9541", "#19883A", "#167B33",
];

const dayCount = computed(() => {
  const m: Record<string, number> = {};
  props.data.forEach((d) => (m[d.day] = d.count));
  return m;
});

const maxCount = computed(() => Math.max(0, ...props.data.map((d) => d.count)));

// 幂律刻度着色（α=0.2）：介于线性与对数之间——日常记录量落浅中区、逐级渐变，高位趋缓；
// 线性会让低记录量全挤最浅档，对数又让整图偏深，α 越小整体越深、越大越浅
function cellColor(v: number): string {
  if (v <= 0) return HEAT_LEVELS[0];
  const ratio = Math.pow(v / (maxCount.value || 1), 0.2);
  const idx = Math.max(1, Math.min(20, Math.ceil(ratio * 20)));
  return HEAT_LEVELS[idx];
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 53 周窗口：包含左侧星期对齐。颜色在这里一次算好随格子下发，
// 悬停换格触发的重渲染不再对 371 个格子逐个跑 Math.pow
const grid = computed(() => {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  const first = new Date(start);
  const dow = first.getDay() || 7;
  first.setDate(first.getDate() - (dow - 1));

  const cells: { date: string | null; color: string }[] = [];
  const d = new Date(first);
  while (d <= end) {
    const key = fmt(d);
    const inWindow = d >= start;
    cells.push({ date: inWindow ? key : null, color: inWindow ? cellColor(dayCount.value[key] || 0) : "transparent" });
    d.setDate(d.getDate() + 1);
  }
  return cells;
});

const weeks = computed(() => {
  const out: (typeof grid.value)[] = [];
  for (let i = 0; i < grid.value.length; i += 7) out.push(grid.value.slice(i, i + 7));
  return out;
});

// 月份标尺（格子 12px + 列距 4px = 每周 16px）：每个月出现在哪一列，标尺就摆到那一列。
// 从右往左筛：与右侧已保留的标尺不足 2 周（32px，够放「10月」）就丢掉 —— 只有窗口最左侧
// 那个残缺月会挨得这么近，丢它比让「9月10月」叠成一坨可读（GitHub 的全年图同样不标残月）
const months = computed(() => {
  const firstWeekOf: Record<string, number> = {};
  weeks.value.forEach((week, wi) => {
    week.forEach((cell) => {
      if (!cell.date) return;
      const key = cell.date.slice(0, 7);
      if (!(key in firstWeekOf)) firstWeekOf[key] = wi;
    });
  });
  const all = Object.entries(firstWeekOf)
    .sort((a, b) => a[1] - b[1])
    .map(([key, wi]) => ({ offset: wi, label: parseInt(key.slice(5), 10) + "月" }));
  const kept: typeof all = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (!kept.length || kept[0].offset - all[i].offset >= 2) kept.unshift(all[i]);
  }
  return kept;
});

const todayStr = fmt(new Date());

// 悬停提示：内容（tipCell）走响应式、只在换格子时更新；位置在 mousemove 里直接写 DOM ——
// 高频移动若走响应式会连带整个热力图重渲染（371 格），这正是用量统计那边悬停发涩的原根因
const tipCell = ref<{ date: string; count: number } | null>(null);
const tipEl = ref<HTMLElement | null>(null);
let tipXY = { x: 0, y: 0 };

function positionTip() {
  const el = tipEl.value;
  if (!el) return;
  const { x, y } = tipXY;
  const offset = 14;
  const width = el.offsetWidth || 190;
  const height = el.offsetHeight || 36;
  let left = x + offset;
  let top = y + offset;
  if (x + width + offset > window.innerWidth - 12) left = Math.max(8, x - width - 10);
  if (y + height + offset > window.innerHeight - 12) top = Math.max(8, y - height - 10);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// 事件委托：格子自身不挂监听（371 格 × 3 个 handler 的重建省掉），靠 data-day 认格
function cellFromEvent(e: MouseEvent): { date: string; count: number } | null {
  const el = (e.target as HTMLElement | null)?.closest?.(".mem-heat-cell") as HTMLElement | null;
  const date = el?.dataset?.day;
  if (!date) return null;
  return { date, count: dayCount.value[date] || 0 };
}

function onCellOver(e: MouseEvent) {
  const cell = cellFromEvent(e);
  if (!cell) {
    tipCell.value = null; // 移到空隙/空日期格：与单格 mouseleave 行为一致
    return;
  }
  tipXY = { x: e.clientX, y: e.clientY };
  if (tipCell.value?.date !== cell.date) tipCell.value = cell;
  else positionTip();
}

function onCellMove(e: MouseEvent) {
  if (!tipCell.value) return;
  tipXY = { x: e.clientX, y: e.clientY };
  positionTip();
}

function onCellClick(e: MouseEvent) {
  const cell = cellFromEvent(e);
  if (cell) emit("pick", cell.date);
}

// tipCell 渲染出元素后立刻定位（nextTick 在绘制前完成，不会闪在左上角）
watch(tipCell, async (v) => {
  if (!v) return;
  await nextTick();
  positionTip();
});

const scrollEl = ref<HTMLElement | null>(null);

// 默认滚到最右（最新的一天）；数据刷新后同样贴右
function scrollToEnd() {
  nextTick(() => {
    const el = scrollEl.value;
    if (el) el.scrollLeft = el.scrollWidth;
  });
}

onMounted(scrollToEnd);
watch(() => props.data, scrollToEnd);
</script>

<template>
  <div ref="scrollEl" class="mem-heat-scroll" @scroll="tipCell = null">
    <div class="mem-heat-main">
      <div class="mem-heat-months">
        <span v-for="(m, i) in months" :key="i" :style="{ left: m.offset * 16 + 'px' }">{{ m.label }}</span>
      </div>
      <div
        class="mem-heat-body"
        @mouseover="onCellOver"
        @mousemove="onCellMove"
        @mouseleave="tipCell = null"
        @click="onCellClick"
      >
        <div v-for="(week, wi) in weeks" :key="wi" class="mem-heat-col">
          <span
            v-for="(cell, ci) in week"
            :key="ci"
            class="mem-heat-cell"
            :class="{ 'is-empty': !cell.date, 'is-today': cell.date === todayStr, 'is-picked': !!cell.date && cell.date === picked }"
            :data-day="cell.date || undefined"
            :style="{ background: cell.color, '--d': wi * 7 + ci }"
          ></span>
        </div>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <div v-if="tipCell" ref="tipEl" class="mem-heat-tip">
      <span class="mh-date">{{ tipCell.date }}</span>
      <span class="mh-sep"></span>
      <span class="mh-val">{{ tipCell.count > 0 ? tipCell.count + " 条记录" : "当天没有记录" }}</span>
    </div>
  </Teleport>
  <div class="mem-heat-legend">
    <span>无记录</span>
    <span class="cells"><i v-for="(c, i) in HEAT_LEVELS" :key="i" :style="{ background: c }"></i></span>
    <span>记录多</span>
  </div>
</template>
