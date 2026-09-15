<script setup lang="ts">
import { computed } from "vue";
import { humanDate, formatInteger, formatCost, formatToken, formatPercent } from "../../composables/useFormat";
import { useSyncStore } from "../../stores/sync";
import type { HeatmapRow } from "../../stores/usage";

const props = defineProps<{ show: boolean; date: string; data: HeatmapRow[] }>();
defineEmits<{ (e: "close"): void }>();

const app = useSyncStore();

const day = computed(() => props.data.find((x) => x.date === props.date));
const total = computed(() => (day.value ? day.value.total : 0));
const cost = computed(() => (day.value && day.value.cost != null ? day.value.cost : null));
const currency = computed(() => app.config.billing?.displayCurrency || "CNY");
// 缓存命中率：与总览卡片同口径 cacheRead/input（input 含 cache_read），当日无调用时显示 —
const hitRate = computed(() => {
  const d = day.value;
  if (!d || !d.callCount) return null;
  return d.inputTokens && d.inputTokens > 0 ? (d.cacheReadTokens || 0) / d.inputTokens : 0;
});
const callCount = computed(() => (day.value && day.value.callCount != null ? day.value.callCount : 0));
</script>

<template>
  <Teleport to="body">
    <div class="overlay sync-scope" :class="{ show }" @click="$emit('close')"></div>
    <div class="modal sync-scope" :class="{ show }">
      <div class="m-head">
        <h3>{{ date ? humanDate(date) : "" }}<span class="m-sub">当日用量</span></h3>
        <button class="d-close" @click="$emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="m-body">
        <!-- 当日消耗主数值：accent 渐弱底衬托 -->
        <div class="m-hero">
          <span class="hero-label">当日消耗</span>
          <span class="hero-val mono">{{ formatToken(total) }}<small> token</small></span>
        </div>
        <!-- 次级指标栅格：费用（开启计费才显示）/ 缓存命中率 / 调用次数 -->
        <div class="m-grid">
          <div v-if="app.config.billing?.enabled && cost !== null" class="m-cell">
            <span class="c-label">当日费用</span>
            <b class="c-val mono">{{ formatCost(cost, 2, currency) }}</b>
          </div>
          <div class="m-cell">
            <span class="c-label">缓存命中率</span>
            <b class="c-val mono">{{ hitRate !== null ? formatPercent(hitRate) : "—" }}</b>
            <span class="c-foot">命中 / 输入</span>
          </div>
          <div class="m-cell">
            <span class="c-label">调用次数</span>
            <b class="c-val mono">{{ formatInteger(callCount) }}</b>
            <span class="c-foot">次请求记录</span>
          </div>
        </div>
        <p class="m-hint">当日输入 / 输出 / 推理的分项构成，请在「用量明细」页按日期筛选查看。</p>
      </div>
    </div>
  </Teleport>
</template>