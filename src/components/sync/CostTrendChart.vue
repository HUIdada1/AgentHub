<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from "vue";
import * as echarts from "echarts";
import { useSyncStore } from "../../stores/sync";

const props = defineProps<{ data: { date: string; cost: number }[]; range: number; currency: "CNY" | "USD" }>();
const emit = defineEmits<{ (e: "change-range", days: number): void }>();

const app = useSyncStore();
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const ranges = [
  { key: 7, label: "最近7天" },
  { key: 30, label: "最近30天" },
  { key: 90, label: "最近90天" },
];

const symbol = computed(() => (props.currency === "USD" ? "$" : "¥"));

/** 补齐连续日期序列：从 (today - range + 1) 到 today，缺数日期补 0，保证最右侧严格为今天 */
const completeData = computed(() => {
  const map = new Map<string, number>();
  props.data.forEach((d) => map.set(d.date, d.cost));

  const list: { date: string; cost: number }[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const count = props.range || 7;

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${day}`;
    list.push({ date: key, cost: map.get(key) ?? 0 });
  }
  return list;
});

/** y 轴金额缩写：数值跨度大时避免标签过长 */
function axisCost(v: number): string {
  const s = symbol.value;
  if (v >= 100) return s + Math.round(v).toLocaleString("en-US");
  if (v >= 1) return s + v.toFixed(1);
  return s + v.toFixed(2);
}

/** 悬停提示金额：固定两位小数（费用小数值常见） */
function tipCost(v: number): string {
  return symbol.value + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function render() {
  if (!chart || !el.value) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#2563eb";
  const gridColor = css.getPropertyValue("--border").trim() || "rgba(15,23,42,0.08)";
  const textColor = css.getPropertyValue("--text-3").trim() || "#94a3b8";
  const surface = css.getPropertyValue("--surface").trim() || "#ffffff";
  const dataset = completeData.value;

  chart.clear();
  chart.setOption({
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 66, right: 22, top: 16, bottom: 30 },
    tooltip: {
      trigger: "axis",
      backgroundColor: surface,
      borderColor: gridColor,
      textStyle: { color: css.getPropertyValue("--text").trim(), fontSize: 12 },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p) return "";
        const dateStr = dataset[p.dataIndex]?.date || p.name;
        return `<div style="font-weight:600;margin-bottom:4px">${dateStr}</div>${p.marker}费用：<b>${tipCost(Number(p.value || 0))}</b>`;
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
      axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => axisCost(v) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: [
      {
        name: "费用",
        type: "line",
        data: dataset.map((d) => d.cost),
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
    ],
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
</script>

<template>
  <div class="card anim">
    <div class="card-head">
      <h2>费用趋势</h2>
      <span class="hint">每日费用（{{ currency }}）· 悬停查看单日金额</span>
      <div class="right">
        <div class="tabs">
          <button v-for="r in ranges" :key="r.key" class="tab" :class="{ active: range === r.key }" @click="emit('change-range', r.key)">
            {{ r.label }}
          </button>
        </div>
      </div>
    </div>
    <div class="chart-wrap"><div ref="el" class="chart cost-chart"></div></div>
  </div>
</template>

<style scoped>
.chart-wrap {
  width: 100%;
}

.cost-chart {
  width: 100%;
  height: 280px;
}
</style>
