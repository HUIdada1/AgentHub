<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from "vue";
import * as echarts from "echarts";
import { useSyncStore } from "../../stores/sync";
import { formatToken } from "../../composables/useFormat";

const props = defineProps<{ data: { date: string; total: number; models?: Record<string, number> }[]; range: number }>();
const emit = defineEmits<{ (e: "change-range", days: number): void }>();

const app = useSyncStore();
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const ranges = [
  { key: 7, label: "近七天" },
  { key: 30, label: "月" },
  { key: 90, label: "季" },
  { key: 180, label: "半年" },
  { key: 365, label: "年" },
];

/** 补齐连续日期序列：从 (today - range + 1) 到 today，保证最右侧严格为最新时间（今天） */
const completeData = computed(() => {
  const map = new Map<string, { total: number; models: Record<string, number> }>();
  props.data.forEach((d) => {
    map.set(d.date, { total: d.total, models: d.models || {} });
  });

  const list: { date: string; total: number; models: Record<string, number> }[] = [];
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
    });
  }
  return list;
});

const palette = ["#2563eb", "#0f766e", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#65a30d"];
const modelNames = computed(() =>
  Array.from(new Set(completeData.value.flatMap((d) => Object.keys(d.models || {}))))
    .filter((model) => completeData.value.some((d) => Number(d.models?.[model] || 0) > 0))
);

// 图表切换：汇总（仅总量曲线，图例干净）/ 按模型（各模型分色曲线）
const view = ref<"total" | "models">("total");
const showLegend = computed(() => view.value === "models" && modelNames.value.length > 0);

function render() {
  if (!chart || !el.value) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#2563eb";
  const gridColor = css.getPropertyValue("--border").trim() || "rgba(15,23,42,0.08)";
  const textColor = css.getPropertyValue("--text-3").trim() || "#94a3b8";
  const dataset = completeData.value;

  chart.clear();
  chart.setOption({
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 60, right: 28, top: showLegend.value ? 58 : 26, bottom: 32 },
    tooltip: {
      trigger: "axis",
      backgroundColor: css.getPropertyValue("--surface").trim(),
      borderColor: css.getPropertyValue("--border").trim(),
      textStyle: { color: css.getPropertyValue("--text").trim(), fontSize: 12 },
      formatter: (params: any) => {
        if (!params || !params.length) return "";
        const first = params[0];
        const dateStr = dataset[first.dataIndex]?.date || first.name;
        const lines = params.map(
          (p: any) => `${p.marker}${p.seriesName}: <b>${formatToken(Number(p.value || 0))}</b> token`
        );
        return `<div style="font-weight:600;margin-bottom:4px;color:${css.getPropertyValue("--text")}">${dateStr}</div>` + lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: dataset.map((d) => d.date.slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: textColor,
        fontSize: 10.5,
        formatter: (v: number) => formatToken(v),
      },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series:
      view.value === "total"
        ? [
            {
              name: "总量",
              type: "line",
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
          ]
        : modelNames.value.map((model, i) => ({
            name: model,
            type: "line",
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
watch(() => app.isDark, () => nextTick(render));
watch(view, () => nextTick(render));
</script>

<template>
  <div class="card anim">
    <div class="card-head">
      <h2>用量趋势</h2>
      <span class="hint">每日累计 token</span>
      <div class="right">
        <div class="tabs">
          <button class="tab" :class="{ active: view === 'total' }" @click="view = 'total'">汇总</button>
          <button class="tab" :class="{ active: view === 'models' }" @click="view = 'models'">按模型</button>
        </div>
        <div class="tabs">
          <button v-for="r in ranges" :key="r.key" class="tab" :class="{ active: range === r.key }" @click="emit('change-range', r.key)">
            {{ r.label }}
          </button>
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
</style>
