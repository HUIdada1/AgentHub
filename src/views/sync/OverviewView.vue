<script setup lang="ts">
import { onMounted, ref, watch, computed } from "vue";
import { useSyncStore } from "../../stores/sync";
import { useAppStore } from "../../stores/app";
import { useUsageStore } from "../../stores/usage";
import { formatToken } from "../../composables/useFormat";
import TrendChart from "../../components/sync/TrendChart.vue";
import Heatmap from "../../components/sync/Heatmap.vue";
import UsageBreakdown from "../../components/sync/UsageBreakdown.vue";
import DayModal from "../../components/sync/DayModal.vue";
import EmptyState from "../../components/sync/EmptyState.vue";

const app = useSyncStore();
const framework = useAppStore();
const usage = useUsageStore();

const range = ref(7); // 默认「近七天」
const pickedDay = ref<string | null>(null);

// 数字滚动
const anim = ref<Record<string, number>>({});
function animate(target: Record<string, number>) {
  const keys = Object.keys(target);
  // 「界面动效」关闭（仅展示层）：数值直接到位，不跑 rAF 补间
  if (!framework.config.fx) {
    keys.forEach((k) => (anim.value[k] = target[k]));
    return;
  }
  const start: Record<string, number> = {};
  keys.forEach((k) => (start[k] = anim.value[k] || 0));
  const t0 = performance.now();
  const dur = 900;
  function step(now: number) {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    keys.forEach((k) => (anim.value[k] = start[k] + (target[k] - start[k]) * e));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

watch(
  () => usage.summary,
  (s) => {
    if (!s) return;
    animate({
      total: s.totalTokens,
      today: s.todayTokens,
      records: s.recordCount,
    });
    anim.value.hit = s.cacheHitRate * 100;
  },
  { immediate: true }
);

const activeSourceName = computed(() => app.sourceName(app.activeSource));
// 「全部」时任一可见源启用即可看；单源时看该源启用态（统一在 store 判断）
const activeSourceEnabled = computed(() => app.activeSourceEnabled);

const selectedDev = computed(() => usage.selectedDevice);
const isFiltered = computed(() => usage.isFiltered);
const todayHitPct = computed(() => (usage.summary?.todayCacheHitRate || 0) * 100);

onMounted(() => {
  if (activeSourceEnabled.value) usage.loadOverview();
  app.refreshProgress();
});

watch(() => app.totalMode, () => {
  if (activeSourceEnabled.value) usage.loadOverview();
});
watch([() => app.activeSource, activeSourceEnabled], ([source, enabled], [previousSource]) => {
  if (source !== previousSource || !enabled) usage.resetOverview();
  if (enabled) usage.loadOverview();
});

// 同步结束（running 由 true 变 false）后自动刷新总览数据
let wasRunning = app.sync.running;
watch(() => app.sync.running, (now) => {
  if (wasRunning && !now && activeSourceEnabled.value) usage.loadOverview();
  wasRunning = now;
});

// 在计费规则页改价/导入后切回总览时刷新（费用字段随价格版本重算，视图常驻需手动触发）
watch(() => app.activePage, (p) => {
  if (p === "overview" && activeSourceEnabled.value) usage.loadOverview();
});

async function changeRange(days: number) {
  range.value = days;
  usage.trendDay = null; // 从单日模式切回多天范围（dayModel 随 props.day 联动清空）
  await usage.loadTrend(days);
}

// 单日模式：选某天按小时看该天，清空（null）回到近七天（范围 tab 高亮同步复位）
async function changeDay(date: string | null) {
  if (!date) range.value = 7;
  await usage.setTrendDay(date);
}

function showSettings() {
  framework.openModuleConfig();
}
</script>

<template>
  <div class="sync-page">
    <template v-if="activeSourceEnabled">
      <template v-if="usage.loading && !usage.summary">
        <div class="overview-top-section">
          <div class="top-kpis-grid">
            <div class="skeleton sk-kpi" v-for="i in 6" :key="i"></div>
          </div>
          <div class="skeleton sk-chart" style="height: 100%; min-height: 230px; margin-bottom: 0;"></div>
        </div>
        <div class="skeleton sk-chart"></div>
      </template>

      <template v-else>
      <!-- 设备筛选提示横幅（当点击选中单台设备时显示） -->
      <div v-if="usage.loadError" class="filter-banner anim error-banner">
        <span class="filter-dot error"></span>
        <div class="filter-text">数据加载失败：{{ usage.loadError }}</div>
        <button class="filter-reset-btn" @click="usage.loadOverview()">重试</button>
      </div>

      <!-- 设备筛选提示横幅（当点击选中单台设备时显示） -->
      <div v-if="isFiltered" class="filter-banner anim">
        <span class="filter-dot"></span>
        <div class="filter-text">
          当前正查看设备 <b>「{{ selectedDev?.deviceName || '指定电脑' }}」</b> 的独立用量
          <span v-if="selectedDev?.isLocal" class="tag">本机</span>
          <span v-else class="tag tag-remote">他机</span>
        </div>
        <button class="filter-reset-btn" @click="usage.selectDevice(null)">
          查看全部电脑汇总
        </button>
      </div>

      <!-- 顶部左右栅格：左上方6个指标小卡片，右上方全年用量热力图 -->
      <div class="overview-top-section">
        <div class="top-kpis-grid">
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>总计消耗Token</div>
            <div class="k-value mono">{{ formatToken(anim.total || 0) }}</div>
            <div class="k-foot">{{ isFiltered ? ((selectedDev?.deviceName || '设备') + ' 累计消耗') : '全部设备累计' }}</div>
          </div>
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>今日消耗Token</div>
            <div class="k-value mono">{{ formatToken(anim.today || 0) }}</div>
            <div class="k-foot">{{ isFiltered ? '该设备今日消耗' : '今日 0 点起累计' }}</div>
          </div>
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>总计缓存命中率</div>
            <div class="k-value mono">{{ (anim.hit || 0).toFixed(1) }}<span class="unit">%</span></div>
            <div class="k-foot">命中 {{ formatToken(usage.summary?.cacheReadTokens || 0) }} / 输入 {{ formatToken(usage.summary?.inputTokens || 0) }}</div>
          </div>
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>今日缓存命中率</div>
            <div class="k-value mono">{{ todayHitPct.toFixed(1) }}<span class="unit">%</span></div>
            <div class="k-foot">今日命中 {{ formatToken(usage.summary?.todayCacheReadTokens || 0) }} / 输入 {{ formatToken(usage.summary?.todayInputTokens || 0) }}</div>
          </div>
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>总计调用次数</div>
            <div class="k-value mono">{{ (anim.records || 0).toLocaleString("en-US") }}</div>
            <div class="k-foot">{{ isFiltered ? '该机累计请求记录' : '全部设备累计请求记录' }}</div>
          </div>
          <div class="kpi"><i class="k-line-glow"></i>
            <div class="k-label"><span class="kdot"></span>今日调用次数</div>
            <div class="k-value mono">{{ (usage.summary?.todayRecordCount || 0).toLocaleString("en-US") }}</div>
            <div class="k-foot">今日 0 点起请求记录</div>
          </div>
        </div>

        <div class="top-heatmap-wrapper">
          <Heatmap :data="usage.heatmap" @pick="pickedDay = $event" />
        </div>
      </div>

      <!-- 用量趋势折线图（day 非空时为单日按小时模式） -->
      <TrendChart :data="usage.trend" :range="range" :day="usage.trendDay" @change-range="changeRange" @change-day="changeDay" />

      <!-- 各电脑用量构成 -->
      <section class="device-breakdowns">
        <div class="section-kicker">各电脑用量构成</div>
        <div v-if="usage.deviceBreakdowns.length" class="device-breakdown-grid">
          <UsageBreakdown v-for="device in usage.deviceBreakdowns" :key="device.deviceId" :summary="device" :device-name="device.deviceName" :is-local="device.isLocal" />
        </div>
        <EmptyState v-else title="暂无设备用量" desc="完成一次同步后，这里会按电脑展示 token 构成。" />
      </section>

      <DayModal :show="!!pickedDay" :date="pickedDay || ''" :data="usage.heatmap" @close="pickedDay = null" />
      </template>
    </template>

    <div v-else class="card">
      <EmptyState
        :title="activeSourceName + ' 未启用'"
        desc="请先在设置中启用该数据源，再执行同步读取本机用量。"
        @action="showSettings"
      />
    </div>
  </div>
</template>
