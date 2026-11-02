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
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { heatmapDayRange, type HeatmapMode, type HeatmapRow } from "../../stores/usage";
import { formatToken } from "../../composables/useFormat";

const props = defineProps<{ data: HeatmapRow[]; mode: HeatmapMode; year: number }>();
const emit = defineEmits<{
  (e: "pick", date: string): void;
  (e: "change-mode", mode: HeatmapMode): void;
  (e: "change-year", year: number): void;
}>();

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

// 跨天守护：本组件常驻（页面 v-show 保活），computed 里的 new Date() 不构成响应式依赖。
// 用「数据刷新」作为跨天信号推进 tick —— store 的 startDayWatcher 跨天会 refreshQuietly 重拉总览，
// heatmap 数组随之换新，tick 一变窗口/「今天」标记就整体前移（与改版前 grid 随 data 重读日期的行为一致）。
const dayTick = ref(0);

// 当前视图的起止日（窗口算法与 store 单源：heatmapDayRange）：
//  · 近一年 = 今天往前 364 天 → 今天；年 = 自然年 1/1 → 12/31（选到今年时截到今天）
const windowRange = computed(() => {
  void dayTick.value; // 响应式依赖：数据刷新即重读「今天」
  return heatmapDayRange(props.mode, props.year);
});

// 周列网格（含左侧星期对齐）。颜色在这里一次算好随格子下发，
// 悬停换格触发的重渲染不再对几百个格子逐个跑 Math.pow
const grid = computed(() => {
  const { start, end } = windowRange.value;
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

// 活跃天数：只统计当前视图窗口内、且不晚于今天的日期（切视图数据在途时也不会串口径）
const activeDays = computed(() => {
  const s = fmt(windowRange.value.start);
  const e = fmt(windowRange.value.end);
  return props.data.filter((d) => d.total > 0 && d.date >= s && d.date <= e).length;
});

// 今日日期，用于标记当前格子光晕脉冲（同样吃 dayTick：跨天后光晕跟到新的一天）
const todayStr = computed(() => {
  void dayTick.value;
  return fmt(new Date());
});

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

// 滚动定位：近一年/今年看最右（最新），往年年份看最左（1 月，按年度从头读）
function scrollToViewEdge() {
  nextTick(() => {
    const el = scrollEl.value;
    if (!el) return;
    const pastYear = props.mode === "year" && props.year < new Date().getFullYear();
    el.scrollLeft = pastYear ? 0 : el.scrollWidth;
  });
}

// 「年」视图的年度选择器：只允许选到今年（未来年份禁用，后端也没有数据）
function disableFutureYear(d: Date): boolean {
  return d.getFullYear() > new Date().getFullYear();
}

function onYearPick(v: unknown): void {
  const y = Math.trunc(Number(v));
  if (Number.isFinite(y) && y > 0) emit("change-year", y);
}

onMounted(scrollToViewEdge);
// 数据整窗替换（含跨天刷新）→ 推进 dayTick 让窗口前移、收起旧悬停看板（数值已变），并滚到相应边缘
watch(() => props.data, () => {
  dayTick.value = Date.now();
  tipCell.value = null;
  scrollToViewEdge();
});
watch([() => props.mode, () => props.year], () => {
  tipCell.value = null;
  scrollToViewEdge();
});
</script>

<template>
  <div class="card anim top-heatmap-card">
    <div class="card-head">
      <div class="heat-head-title">
        <h2>全年用量热力图</h2>
        <!-- 活跃天数从右侧徽章移到标题右侧（需求口径） -->
        <span class="heat-badge mono">活跃 {{ activeDays }} 天</span>
      </div>
      <div class="right heat-head-right">
        <!-- 参考「用量趋势」右侧：分段 tab 切换近一年 / 年 -->
        <div class="tabs">
          <button class="tab" :class="{ active: mode === 'recent' }" @click="emit('change-mode', 'recent')">近一年</button>
          <button class="tab" :class="{ active: mode === 'year' }" @click="emit('change-mode', 'year')">年</button>
        </div>
        <!-- 「年」视图的年度选择器：与趋势图右上日期选同款玻璃弹层，默认今年 -->
        <el-date-picker
          v-if="mode === 'year'"
          :model-value="String(year)"
          type="year"
          size="small"
          value-format="YYYY"
          :clearable="false"
          placeholder="选择年份"
          :disabled-date="disableFutureYear"
          popper-class="glass-popper"
          class="heat-year"
          @update:model-value="onYearPick"
        />
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
