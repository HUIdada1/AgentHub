<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 增长趋势：与「用量统计」的用量趋势同一套观感（ECharts 渐变面积折线 + 毛玻璃悬停看板 +
     区间分段筛选），区间档位与文案也照搬用量趋势。逐日序列由父级按区间取数并把空缺日补 0 后传入——
     图上的零点与左上角合计始终是同一份数据，不会各算各的。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useAppStore } from "../../stores/app";
import { formatInteger } from "../../composables/useFormat";
import { glassTooltip, tooltipCard, markerColor, type TooltipParam } from "../../utils/chart-tooltip";

const props = defineProps<{
  /** 区间内已补齐的逐日序列（day 为 YYYY-MM-DD，无记录的日子 count=0）；长度即区间天数 */
  data: { day: string; count: number }[];
  /** 当前区间天数，取 ranges 的 key */
  range: number;
}>();
const emit = defineEmits<{ (e: "change-range", days: number): void }>();

const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

// 与「用量统计」用量趋势同一套档位：label 给按钮，word 给左上角合计的小字
const ranges = [
  { key: 7, label: "近七天", word: "近七天" },
  { key: 30, label: "月", word: "近 30 天" },
  { key: 90, label: "季", word: "近 90 天" },
  { key: 180, label: "半年", word: "近半年" },
  { key: 365, label: "年", word: "近一年" },
];
const rangeWord = computed(() => ranges.find((r) => r.key === props.range)?.word || `近 ${props.range} 天`);
const total = computed(() => props.data.reduce((s, d) => s + (d.count || 0), 0));

function render() {
  if (!chart || !el.value) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#1e9e5f";
  const gridColor = css.getPropertyValue("--border").trim() || "rgba(15,23,42,0.08)";
  const textColor = css.getPropertyValue("--text-3").trim() || "#94a3b8";
  const dataset = props.data;

  chart.clear();
  chart.setOption({
    // 「界面动效」关闭（仅展示层）：不播入场/更新动画，数据照常渲染
    animation: ui.config.fx,
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 52, right: 18, top: 16, bottom: 28 },
    tooltip: {
      ...glassTooltip(),
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        return tooltipCard(dataset[list[0].dataIndex]?.day || "", [
          {
            color: markerColor(list[0].marker),
            label: "新增记忆",
            value: formatInteger(Number(list[0].value || 0)),
            unit: "条",
          },
        ]);
      },
    },
    xAxis: {
      type: "category",
      data: dataset.map((d) => d.day.slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    yAxis: {
      type: "value",
      // 一天就几条：不给 minInterval 会分出 0.5 条这种刻度
      minInterval: 1,
      axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => formatInteger(v) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: [
      {
        name: "新增记忆",
        type: "line",
        color: accent,
        data: dataset.map((d) => d.count),
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

    // 记忆页是 v-show 保活的隐藏页：容器在切回本页时由 0 变宽，靠 ResizeObserver 补一次 resize
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

watch(() => props.data, () => nextTick(render), { deep: true });
watch(() => props.range, () => nextTick(render));
watch(() => ui.isDark, () => nextTick(render));
watch(() => ui.config.fx, () => nextTick(render));
</script>

<template>
  <div class="mem-card mem-card-fill">
    <div class="mem-card-title">
      <span>记忆增长趋势 <span class="mem-hint">{{ rangeWord }}共 {{ formatInteger(total) }} 条</span></span>
      <div class="mem-tabs">
        <button v-for="r in ranges" :key="r.key" class="mem-tab" :class="{ active: range === r.key }" @click="emit('change-range', r.key)">
          {{ r.label }}
        </button>
      </div>
    </div>
    <div class="mem-chart-wrap">
      <div ref="el" class="mem-chart" :data-range="range" :data-points="data.length"></div>
    </div>
  </div>
</template>
