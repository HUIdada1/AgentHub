<script setup lang="ts">
import { computed, watch } from "vue";
import { humanDate, formatInteger, formatCost, formatToken, formatPercent } from "../../composables/useFormat";
import { useSyncStore } from "../../stores/sync";
import type { HeatmapRow } from "../../stores/usage";

const props = defineProps<{ show: boolean; date: string; data: HeatmapRow[] }>();
const emit = defineEmits<{ (e: "close"): void }>();

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
const inputTokens = computed(() => day.value?.inputTokens ?? 0);
const cacheReadTokens = computed(() => day.value?.cacheReadTokens ?? 0);
const billingOn = computed(() => !!app.config.billing?.enabled);
const hasDay = computed(() => !!day.value && (day.value.total > 0 || callCount.value > 0));

// 次级指标卡片：费用（开启计费才显示）/ 缓存命中率 / 调用次数，缺一行时栅格自动等宽
const cells = computed(() => {
  const out: { key: string; label: string; val: string; foot: string }[] = [];
  if (billingOn.value && cost.value !== null) {
    out.push({ key: "cost", label: "当日费用", val: formatCost(cost.value, 2, currency.value), foot: "按当日价格版本" });
  }
  out.push({
    key: "hit",
    label: "缓存命中率",
    val: hitRate.value !== null ? formatPercent(hitRate.value) : "—",
    foot: hitRate.value !== null ? `${formatToken(cacheReadTokens.value)} / ${formatToken(inputTokens.value)}` : "当日无调用",
  });
  out.push({ key: "calls", label: "调用次数", val: formatInteger(callCount.value), foot: "次请求记录" });
  return out;
});

// 打开瞬间重流动画：内容块错落上浮
const animKey = computed(() => `${props.show}-${props.date}`);

// Esc 关闭（与遮罩点击同语义）
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.show) emit("close");
}
watch(
  () => props.show,
  (v) => {
    if (v) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  }
);
</script>

<template>
  <Teleport to="body">
    <div class="dm-overlay" :class="{ show }" @click="emit('close')"></div>
    <div class="dm-modal" :class="{ show }" role="dialog" aria-modal="true">
      <div class="dm-head">
        <div class="dm-titles">
          <div class="dm-date">{{ date ? humanDate(date) : "" }}</div>
          <div class="dm-sub">当日用量明细</div>
        </div>
        <button class="dm-close" title="关闭（Esc）" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div class="dm-body" :key="animKey">
        <!-- 当日消耗主数值：accent 渐弱底衬托 -->
        <div class="dm-hero" style="--i: 0">
          <div class="dm-hero-top">
            <span class="dm-hero-label">当日消耗</span>
            <span class="dm-hero-badge" :class="{ off: !hasDay }">{{ hasDay ? "有记录" : "无记录" }}</span>
          </div>
          <span class="dm-hero-val">{{ formatToken(total) }}<small> token</small></span>
        </div>

        <!-- 次级指标栅格 -->
        <div class="dm-grid">
          <div v-for="(c, i) in cells" :key="c.key" class="dm-cell" :style="{ '--i': i + 1 }">
            <span class="dm-cell-label">{{ c.label }}</span>
            <b class="dm-cell-val">{{ c.val }}</b>
            <span class="dm-cell-foot">{{ c.foot }}</span>
          </div>
        </div>

        <p class="dm-hint" style="--i: 4">
          当日输入 / 输出 / 推理的分项构成，请在「用量明细」页按日期筛选查看。
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Teleport 到 body，scoped 样式照常生效（组件内元素带 data-v 属性）；
   不依赖 sync.css 的后代选择器，避免同元素双类坑 */

.dm-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(6, 9, 14, 0.45);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
.dm-overlay.show {
  opacity: 1;
  pointer-events: auto;
}

.dm-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 91;
  width: 400px;
  max-width: calc(100vw - 48px);
  transform: translate(-50%, -50%) scale(0.94) translateY(10px);
  opacity: 0;
  /* 玻璃弹出三件套：模糊消散 + 弹簧缩放 + 轻微上浮（缓动对齐全局 --ease / --ease-spring） */
  filter: blur(8px);
  pointer-events: none;
  border-radius: var(--r-panel, 18px);
  border: 1px solid var(--glass-bd);
  background: linear-gradient(165deg, var(--glass-a), var(--glass-b));
  backdrop-filter: blur(30px) saturate(160%);
  -webkit-backdrop-filter: blur(30px) saturate(160%);
  box-shadow: var(--glass-shadow);
  transition: opacity 0.22s var(--ease, ease), transform 0.34s var(--ease-spring, cubic-bezier(0.34, 1.45, 0.5, 1)), filter 0.22s var(--ease, ease);
  overflow: hidden;
}
.dm-modal.show {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, -50%) scale(1) translateY(0);
  filter: blur(0);
}

/* ===== 头部：日期主标题 + 类别小字 + 圆形关闭钮 ===== */
.dm-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 16px 13px;
  border-bottom: 1px solid var(--line);
}
.dm-titles {
  flex: 1;
  min-width: 0;
  line-height: 1.3;
}
.dm-date {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
}
.dm-sub {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.12em;
  margin-top: 2px;
}
.dm-close {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--bg-soft);
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, transform 0.2s var(--ease, ease);
}
.dm-close:hover {
  color: var(--text);
  border-color: var(--accent-line);
  transform: rotate(90deg);
}

.dm-body {
  padding: 14px 16px 16px;
}

/* ===== 主数值卡 ===== */
.dm-hero {
  padding: 14px 16px 13px;
  border-radius: var(--r-ctl, 12px);
  background: linear-gradient(135deg, var(--accent-dim), transparent 72%);
  border: 1px solid var(--accent-line);
}
.dm-hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
}
.dm-hero-label {
  font-size: 11px;
  color: var(--text-2);
}
.dm-hero-badge {
  font-size: 9px;
  font-family: var(--font-mono, monospace);
  padding: 1.5px 7px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.dm-hero-badge.off {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-3);
}
.dm-hero-val {
  font-family: var(--font-mono, monospace);
  font-size: 28px;
  font-weight: 750;
  letter-spacing: -0.02em;
  color: var(--accent-strong);
  line-height: 1.15;
}
.dm-hero-val small {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 3px;
}

/* ===== 次级指标栅格：等宽自适应 ===== */
.dm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.dm-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--r-sm, 8px);
  background: var(--bg-soft);
  border: 1px solid var(--line);
}
.dm-cell-label {
  font-size: 10.5px;
  color: var(--text-3);
}
.dm-cell-val {
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.dm-cell-foot {
  font-size: 9.5px;
  font-family: var(--font-mono, monospace);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dm-hint {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  margin: 12px 2px 0;
}

/* 内容块错落上浮 */
@media (prefers-reduced-motion: no-preference) {
  .dm-modal.show .dm-hero,
  .dm-modal.show .dm-cell,
  .dm-modal.show .dm-hint {
    animation: dmRise 0.35s var(--ease, ease) both;
    animation-delay: calc(var(--i, 0) * 45ms);
  }
  @keyframes dmRise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
</style>
