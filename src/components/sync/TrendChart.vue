<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from "vue";
import * as echarts from "echarts";
import { useSyncStore } from "../../stores/sync";
import { useAppStore } from "../../stores/app";
import { formatToken } from "../../composables/useFormat";
import { glassTooltip, tooltipCard, markerColor, type TooltipParam } from "../../utils/chart-tooltip";

const props = defineProps<{ data: { date: string; total: number; models?: Record<string, number>; cacheHitRate?: number }[]; range: number; day: string | null }>();
const emit = defineEmits<{ (e: "change-range", days: number): void; (e: "change-day", date: string | null): void }>();

const app = useSyncStore();
const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const ranges = [
  { key: 7, label: "近七天" },
  { key: 30, label: "月" },
  { key: 90, label: "季" },
  { key: 180, label: "半年" },
  { key: 365, label: "年" },
];

// 天选择器（el-date-picker）：选中某天后进入单日（按小时）模式，清空回落近 N 天
const dayModel = ref<string | null>(props.day || "");
// 今天 0 点之前的都可选（含今天），明天起禁用
function disableFuture(d: Date) {
  const n = new Date();
  return d.getTime() > new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
watch(dayModel, (v) => emit("change-day", v || null));
watch(
  () => props.day,
  (v) => {
    if ((v || "") !== (dayModel.value || "")) dayModel.value = v || null;
  }
);

/** 补齐连续日期序列：单日模式直接用后端已补齐的 24 小时数据（date="HH:00"）；
 *  多天模式从 (today - range + 1) 到 today，保证最右侧严格为最新时间（今天），空缺日补 0 保证曲线均匀 */
const completeData = computed(() => {
  if (props.day) {
    return props.data.map((d) => ({
      date: d.date,
      total: d.total,
      models: d.models || {},
      cacheHitRate: d.cacheHitRate || 0,
    }));
  }

  const map = new Map<string, { total: number; models: Record<string, number>; cacheHitRate: number }>();
  props.data.forEach((d) => {
    map.set(d.date, { total: d.total, models: d.models || {}, cacheHitRate: d.cacheHitRate || 0 });
  });

  const list: { date: string; total: number; models: Record<string, number>; cacheHitRate: number }[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const count = props.range || 30;

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${day}`;
    const existing = map.get(key);
    list.push({
      date: key,
      total: existing ? existing.total : 0,
      models: existing ? existing.models : {},
      cacheHitRate: existing ? existing.cacheHitRate : 0,
    });
  }
  return list;
});

const palette = ["#2563eb", "#0f766e", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#65a30d"];
const modelNames = computed(() =>
  Array.from(new Set(completeData.value.flatMap((d) => Object.keys(d.models || {}))))
    .filter((model) => completeData.value.some((d) => Number(d.models?.[model] || 0) > 0))
);

// 图表切换：汇总（总量曲线 + 白色虚线缓存命中率）/ 按模型（各模型分色曲线）
const view = ref<"total" | "models">("total");
const showLegend = computed(() => (view.value === "models" ? modelNames.value.length > 0 : true));
const isDay = computed(() => !!props.day);

function render() {
  if (!chart || !el.value) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#2563eb";
  const gridColor = css.getPropertyValue("--border").trim() || "rgba(15,23,42,0.08)";
  const textColor = css.getPropertyValue("--text-3").trim() || "#94a3b8";
  const dataset = completeData.value;
  // 缓存命中率曲线配色：深色背景白虚线，浅色背景深灰（白色在明亮背景不可见）
  const hitColor = app.isDark ? "#ffffff" : "#4b5563";
  // 单日模式 x 轴标签为小时（"HH:00" → "HH时"），多天为 "MM-DD"
  const xLabels = dataset.map((d) => (isDay.value ? d.date.slice(0, 2) + "时" : d.date.slice(5)));

  chart.clear();
  chart.setOption({
    // 「界面动效」关闭（仅展示层）：不播入场/更新动画，数据照常渲染
    animation: ui.config.fx,
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 60, right: 50, top: showLegend.value ? 58 : 26, bottom: 32 },
    tooltip: {
      ...glassTooltip(),
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const dateStr = dataset[list[0].dataIndex]?.date || "";
        const title = isDay.value ? `${props.day} ${dateStr.slice(0, 2)}时` : dateStr;
        return tooltipCard(
          title,
          list.map((p) => {
            const isHit = p.seriesName === "缓存命中率";
            return {
              color: markerColor(p.marker),
              label: p.seriesName || "总量",
              value: isHit ? Number(p.value || 0).toFixed(1) : formatToken(Number(p.value || 0)),
              unit: isHit ? "%" : "token",
            };
          })
        );
      },
    },
    xAxis: {
      type: "category",
      data: xLabels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    yAxis: [
      {
        type: "value",
        axisLabel: {
          color: textColor,
          fontSize: 10.5,
          formatter: (v: number) => formatToken(v),
        },
        splitLine: { lineStyle: { color: gridColor } },
      },
      {
        // 缓存命中率右轴：随数据自适应均匀刻度（与左轴同规则），不强制从 0% 起
        type: "value",
        scale: true,
        axisLabel: { color: textColor, fontSize: 10.5, formatter: "{value}%" },
        splitLine: { show: false },
      },
    ],
    series:
      view.value === "total"
        ? [
            {
              // 顶层 color 必须显式声明：legend 色块取 series 主色而非 lineStyle.color，
              // 不设会回退 ECharts 默认调色盘（蓝色），出现「绿线蓝块」
              name: "总量",
              type: "line",
              color: accent,
              data: dataset.map((d) => d.total),
              smooth: true,
              symbol: "none",
              lineStyle: { width: 2.2, color: accent, shadowColor: accent, shadowBlur: 8, shadowOffsetY: 3 },
              areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: accent + "4d" },
                  { offset: 1, color: accent + "00" },
                ]),
              },
            },
            {
              // 缓存命中率虚线：hitColor 按主题取白/深灰
              name: "缓存命中率",
              type: "line",
              color: hitColor,
              yAxisIndex: 1,
              data: dataset.map((d) => Math.round((d.cacheHitRate || 0) * 1000) / 10),
              smooth: true,
              symbol: "none",
              lineStyle: { width: 1.6, type: "dashed", color: hitColor },
              itemStyle: { color: hitColor },
              z: 3,
            },
          ]
        : modelNames.value.map((model, i) => ({
            name: model,
            type: "line",
            color: palette[i % palette.length],
            data: dataset.map((d) => d.models?.[model] || 0),
            smooth: true,
            symbol: "none",
            lineStyle: { width: 1.8, color: palette[i % palette.length] },
          })),
    legend: {
      show: showLegend.value,
      top: 12,
      left: 60,
      right: 28,
      type: "scroll",
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      pageIconSize: 10,
      textStyle: { color: textColor, fontSize: 11 },
    },
  });
}

let resizeObserver: ResizeObserver | null = null;

function onResize() {
  chart?.resize();
}

onMounted(() => {
  if (!el.value) return;
  nextTick(() => {
    if (!el.value) return;
    chart = echarts.init(el.value);
    render();

    resizeObserver = new ResizeObserver(() => {
      chart?.resize();
    });
    resizeObserver.observe(el.value);
  });
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});

watch(() => completeData.value, () => nextTick(render), { deep: true });
watch(() => props.range, () => nextTick(render));
watch(() => props.day, () => nextTick(render));
watch(() => app.isDark, () => nextTick(render));
watch(view, () => nextTick(render));
watch(() => ui.config.fx, () => nextTick(render));
</script>

<template>
  <div class="card anim">
    <div class="card-head">
      <h2>用量趋势</h2>
      <span class="hint">{{ isDay ? "该天逐小时 token" : "每日累计 token" }}</span>
      <div class="right">
        <div class="tabs">
          <button class="tab" :class="{ active: view === 'total' }" @click="view = 'total'">汇总</button>
          <button class="tab" :class="{ active: view === 'models' }" @click="view = 'models'">按模型</button>
        </div>
        <div class="tabs">
          <button v-for="r in ranges" :key="r.key" class="tab" :class="{ active: !day && range === r.key }" @click="emit('change-range', r.key)">
            {{ r.label }}
          </button>
          <el-date-picker
            v-model="dayModel"
            type="date"
            size="small"
            value-format="YYYY-MM-DD"
            placeholder="选择某天"
            clearable
            popper-class="glass-popper"
            class="trend-date"
            :disabled-date="disableFuture"
            title="选择某一天按小时查看；清空回到近七天"
          />
        </div>
      </div>
    </div>
    <div class="chart-wrap"><div ref="el" class="chart trend-chart"></div></div>
  </div>
</template>

<style scoped>
.trend-chart {
  height: 320px;
}
/* el-date-picker 模板根是 ElTooltip（trigger+teleport 多节点），父组件 scoped 的 data-v
   落不到 .el-date-editor 根元素上，直接写 .trend-date{width} 永远命不中（Element 默认 220px）；
   必须借 .tabs 后代 :deep 穿透，特异性 (0,3,0) 同时压过 .el-date-editor.el-input (0,2,0) */
.tabs :deep(.trend-date) {
  width: 110px;
  margin-left: 4px;
  --el-component-size-small: 24px;
}
.tabs :deep(.trend-date .el-input__wrapper) {
  padding: 0 6px;
}
.tabs :deep(.trend-date .el-input__inner) {
  font-size: 11px;
}
</style>
