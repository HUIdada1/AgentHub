<script setup lang="ts">
import { computed } from "vue";
import type { DeviceBreakdown } from "../../types/sync";
import { useSyncStore } from "../../stores/sync";
import { formatToken, formatPercent, formatCost } from "../../composables/useFormat";

const props = defineProps<{ summary: DeviceBreakdown; deviceName?: string; isLocal?: boolean }>();
const app = useSyncStore();

const items = computed(() => {
  const s = props.summary;
  const netInput = Math.max(0, s.inputTokens - s.cacheReadTokens);
  // 色板全部取全局主题 token：info 蓝 / accent 绿系 / warn 琥珀 / 中性灰，跟随明暗主题，
  // 五项彼此可辨（不再用 accent 与 info 调出的浑浊中间色）
  return [
    { label: "净新增输入", value: netInput, color: "var(--info)" },
    { label: "缓存命中", value: s.cacheReadTokens, color: "var(--accent-strong)" },
    { label: "输出", value: s.outputTokens, color: "var(--accent)" },
    { label: "推理", value: s.reasoningTokens, color: "var(--warn)" },
    { label: "缓存写入", value: s.cacheCreationTokens, color: "var(--text-2)" },
  ];
});

const total = computed(() => items.value.reduce((s, i) => s + i.value, 0) || 1);
const totalTokens = computed(() => props.summary.totalTokens);
const cacheHitRate = computed(() => props.summary.inputTokens > 0 ? props.summary.cacheReadTokens / props.summary.inputTokens : 0);
const currency = computed(() => app.config.billing?.displayCurrency || "CNY");
</script>

<template>
  <div class="card anim">
    <div class="card-head">
      <h2>{{ props.deviceName || "用量构成" }}<span v-if="props.isLocal" class="local-tag">本机</span></h2>
      <span class="hint">全部模型</span>
    </div>
    <div class="total-row">
      <span class="big mono">{{ formatToken(totalTokens) }}</span>
    </div>
    <ul class="break">
        <li v-for="(i, idx) in items" :key="i.label" :style="{ '--i': idx }">
        <span class="c-label"><span class="swatch" :style="{ background: i.color }"></span>{{ i.label }}</span>
        <span class="c-val mono">{{ formatToken(i.value) }}</span>
        <span class="c-pct mono">{{ formatPercent(i.value / total) }}</span>
      </li>
    </ul>
    <div class="hitrate">
      <div class="hr-label">缓存命中率</div>
      <div class="hr-val mono">{{ formatPercent(cacheHitRate) }}</div>
      <div class="hr-sub">
        命中 {{ formatToken(summary.cacheReadTokens) }} / 输入 {{ formatToken(summary.inputTokens) }} · 缓存复用计费更低
        <template v-if="app.config.billing?.enabled && summary.cost != null">
          · 费用 <b class="mono" style="color: var(--text-2)">{{ formatCost(summary.cost, 2, currency) }}</b>
        </template>
      </div>
    </div>
  </div>
</template>
