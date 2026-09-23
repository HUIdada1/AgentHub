<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useSyncStore } from "../../stores/sync";
import type { HeatmapRow } from "../../stores/usage";
import { formatToken } from "../../composables/useFormat";

const props = defineProps<{ data: HeatmapRow[] }>();
const emit = defineEmits<{ (e: "pick", date: string): void }>();

const app = useSyncStore();

// 用户指定的 20 级绿色渐变（0 = 无用量：灰白半透明；1~20 按占比递进）
const HEAT_LEVELS = [
  'rgba(236, 236, 236, 0.28)', '#D9F2E3', '#CDEEDA', '#C0EAD1', '#B3E7C7',
  '#A6E3BE', '#98E0B4', '#8BDDAA', '#7DDA9F', '#6FD895',
  '#61D58A', '#53D37F', '#44D174', '#35CF69', '#2DC760',
  '#29BB58', '#25AE50', '#21A248', '#1D9541', '#19883A', '#167B33'
];

// 日期 → 总量
const totalMap = computed(() => {
  const m: Record<string, number> = {};
  props.data.forEach((d) => (m[d.date] = d.total));
  return m;
});

const maxTotal = computed(() => Math.max(0, ...props.data.map((d) => d.total)));

// 幂律刻度着色（α=0.2）：介于线性与对数之间——日常用量落浅中区、逐级渐变，高位逐渐趋缓；
// 线性会让低用量全挤最浅档，对数又让整图偏深，α 越小整体越深、越大越浅
function cellColor(v: number): string {
  if (v <= 0) return HEAT_LEVELS[0];
  const ratio = Math.pow(v / (maxTotal.value || 1), 0.2);
  const idx = Math.max(1, Math.min(20, Math.ceil(ratio * 20)));
  return HEAT_LEVELS[idx];
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 滚动 53 周窗口：包含左侧星期对齐。颜色在这里一次算好随格子下发，
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
    cells.push({ date: inWindow ? key : null, color: inWindow ? cellColor(totalMap.value[key] || 0) : "transparent" });
    d.setDate(d.getDate() + 1);
  }
  return cells;
});

const weeks = computed(() => {
  const out: (typeof grid.value)[] = [];
  for (let i = 0; i < grid.value.length; i += 7) out.push(grid.value.slice(i, i + 7));
  return out;
});

// GitHub 格式月份标签（格子 12px + 列距 4px = 每周 16px）
const months = computed(() => {
  const firstWeekOf: Record<string, number> = {};
  weeks.value.forEach((week, wi) => {
    week.forEach((cell) => {
      if (!cell.date) return;
      const key = cell.date.slice(0, 7);
      const day = parseInt(cell.date.slice(8), 10);
      if (day === 1) {
        if (!(key in firstWeekOf)) firstWeekOf[key] = wi;
      } else if (!(key in firstWeekOf)) {
        firstWeekOf[key] = wi;
      }
    });
  });
  return Object.entries(firstWeekOf)
    .sort((a, b) => a[1] - b[1])
    .map(([key, wi]) => ({ offset: wi, label: parseInt(key.slice(5), 10) + "月" }));
});

const activeDays = computed(() => props.data.filter((d) => d.total > 0).length);

// 今日日期，用于标记当前格子光晕脉冲
const todayStr = fmt(new Date());

// 悬停提示（毛玻璃小看板）智能自适应定位；内容结构化为「日期 + 当日总量」两段。
// 内容（tipCell）走响应式、只在换格子时更新；位置在 mousemove 里直接写 DOM ——
// 高频移动若走响应式会连带整个热力图重渲染（371 格），这正是原先悬停发涩的来源
const tipCell = ref<{ date: string; total: number } | null>(null);
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

// 事件委托：格子自身不挂监听（371 格 × 3 个 handler 的重建省掉），靠 data-date 认格
function cellFromEvent(e: MouseEvent): { date: string; total: number } | null {
  const el = (e.target as HTMLElement | null)?.closest?.(".heat-cell") as HTMLElement | null;
  const date = el?.dataset?.date;
  if (!date) return null;
  return { date, total: totalMap.value[date] || 0 };
}

function onCellOver(e: MouseEvent) {
  const cell = cellFromEvent(e);
  if (!cell) {
    tipCell.value = null; // 移到空隙/空日期格：与原先单格 mouseleave 行为一致
    return;
  }
  tipXY = { x: e.clientX, y: e.clientY };
  // 同格内不重设内容（避免多一次重渲染），只有换格才更新 tipCell
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
  <div class="card anim top-heatmap-card">
    <div class="card-head">
      <div class="heat-head-title">
        <h2>全年用量热力图</h2>
      </div>
      <div class="right">
        <span class="heat-badge mono">近一年 · 活跃 {{ activeDays }} 天</span>
      </div>
    </div>
    <div ref="scrollEl" class="heat-scroll" @scroll="tipCell = null">
      <div class="heat-main">
        <div class="heat-months">
          <span v-for="(m, i) in months" :key="i" :style="{ left: m.offset * 16 + 'px' }">{{ m.label }}</span>
        </div>
        <div
          class="heat-body"
          @mouseover="onCellOver"
          @mousemove="onCellMove"
          @mouseleave="tipCell = null"
          @click="onCellClick"
        >
          <div v-for="(week, wi) in weeks" :key="wi" class="heat-col">
            <span
              v-for="(cell, ci) in week"
              :key="ci"
              class="heat-cell"
              :class="{ 'is-empty': !cell.date, 'is-today': cell.date === todayStr }"
              :data-date="cell.date || undefined"
              :style="{ background: cell.color, '--d': wi * 7 + ci }"
            ></span>
          </div>
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div v-if="tipCell" ref="tipEl" class="heat-tip sync-scope">
        <span class="ht-date mono">{{ tipCell.date }}</span>
        <span class="ht-sep"></span>
        <span class="ht-val mono">{{ tipCell.total > 0 ? formatToken(tipCell.total) + " token" : "暂无用量记录" }}</span>
      </div>
    </Teleport>
    <div class="heat-legend">
      <span class="heat-legend-label">无用量</span>
      <span class="cells"><i v-for="(c, i) in HEAT_LEVELS" :key="i" :style="{ background: c }"></i></span>
      <span class="heat-legend-label">高用量</span>
    </div>
  </div>
</template>
