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
import { computed } from "vue";
import type { DeviceBreakdown } from "../../types/sync";
import { useSyncStore } from "../../stores/sync";
import { formatToken, formatPercent, formatCost } from "../../composables/useFormat";

const props = defineProps<{ summary: DeviceBreakdown; deviceName?: string; isLocal?: boolean }>();
const app = useSyncStore();

// Qoder 系额度点 → token 固定折算率（与 electron/backend/db.cjs 的 CREDITS_TO_TOKENS 同值；
// 实测 Qoder CN/dfmodel：输入 ≈ 22,500 token/credit、输出 ≈ 5,600，取 22,000 作为大概固定值）
const CREDITS_TO_TOKENS = 22000;
const creditTokens = computed(() => Math.round((props.summary.credits || 0) * CREDITS_TO_TOKENS));

const items = computed(() => {
  const s = props.summary;
  // input 已按 Anthropic 语义归一为「含缓存读写」，净新增输入要同时扣掉缓存命中与缓存写入，
  // 否则缓存写入会被重复计算（分项之和 > 总量）
  const netInput = Math.max(0, s.inputTokens - s.cacheReadTokens - s.cacheCreationTokens);
  // 色板全部取全局主题 token：info 蓝 / accent 绿系 / warn 琥珀 / 中性灰，跟随明暗主题，
  // 五项彼此可辨（不再用 accent 与 info 调出的浑浊中间色）
  return [
    { label: "净新增输入", value: netInput, color: "var(--info)" },
    { label: "缓存命中", value: s.cacheReadTokens, color: "var(--accent-strong)" },
    { label: "输出", value: s.outputTokens, color: "var(--accent)" },
    { label: "推理", value: s.reasoningTokens, color: "var(--warn)" },
    { label: "缓存写入", value: s.cacheCreationTokens, color: "var(--text-2)" },
    // Qoder 官方模型只有额度点：按固定率折算后并入 token 构成，保证分项之和 ≈ 总量
    ...(creditTokens.value > 0 ? [{ label: "官方额度折算", value: creditTokens.value, color: "var(--text-3)" }] : []),
  ];
});

const total = computed(() => items.value.reduce((s, i) => s + i.value, 0) || 1);
const totalTokens = computed(() => props.summary.totalTokens);
// 命中率只在有输入 token 时有意义：Qoder 官方模型本地 token 全 0，返回 null 显示「-」
const cacheHitRate = computed<number | null>(() => props.summary.inputTokens > 0 ? props.summary.cacheReadTokens / props.summary.inputTokens : null);
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
      <div class="hr-val mono">{{ cacheHitRate == null ? "-" : formatPercent(cacheHitRate) }}</div>
      <div class="hr-sub">
        <template v-if="cacheHitRate == null">无 token 明细，不计算命中率</template>
        <template v-else>命中 {{ formatToken(summary.cacheReadTokens) }} / 输入 {{ formatToken(summary.inputTokens) }} · 缓存复用计费更低</template>
        <template v-if="app.config.billing?.enabled && summary.cost != null">
          · 费用 <b class="mono" style="color: var(--text-2)">{{ formatCost(summary.cost, 2, currency) }}</b>
        </template>
      </div>
    </div>
  </div>
</template>
