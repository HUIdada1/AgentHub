<!--
  ============================================================
   作者：沐晖
   日期：2026-11-15
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatToken, formatPercent } from "../../composables/useFormat";
import { useSyncStore } from "../../stores/sync";
import { useUsageStore } from "../../stores/usage";
import { getAggregate } from "../../api/sync";
import type { AggregateRow } from "../../types/sync";
import QMark from "../QMark.vue";

const props = defineProps<{ show: boolean; /** 打开时的筛选预设：总计三卡→"all"，今日三卡→"today" */ preset: "all" | "today" }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useSyncStore();
const usage = useUsageStore();

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "today", label: "今日" },
  { key: "range", label: "时间段" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const filter = ref<FilterKey>("all");
const rangeStart = ref("");
const rangeEnd = ref("");
const rows = ref<AggregateRow[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

function todayStartMs(): number {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
/** "YYYY-MM-DD" → 本地时区当日零点 ms（解析失败返回 null） */
function parseDayMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}
function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayStr = computed(() => fmtDay(new Date()));

// 查询时间窗：全部 = 不限；今日 = 本地零点起；时间段 = 起止都选了才查，
// to 取终点次日零点 -1ms（started_at <= to 含等号，恰好覆盖终点全天）
const timeWindow = computed<{ from: number | null; to: number | null } | null>(() => {
  if (filter.value === "all") return { from: null, to: null };
  if (filter.value === "today") return { from: todayStartMs(), to: null };
  const from = parseDayMs(rangeStart.value);
  const end = parseDayMs(rangeEnd.value);
  if (from == null || end == null || end < from) return null;
  return { from, to: end + 86399999 };
});

// 快速切筛选时的竞态防护：仅最后一次请求可落地（CostsView 同款手法）
let reqId = 0;
async function load() {
  const id = ++reqId;
  const win = timeWindow.value;
  if (!win) {
    rows.value = [];
    loadError.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    // 上下文与总览页一致：口径开关 / 渠道筛选 / 设备筛选
    const r = await getAggregate(app.totalMode, "model", win.from, win.to, app.querySource, usage.selectedDeviceId || null);
    if (id !== reqId) return;
    rows.value = Array.isArray(r) ? r : [];
  } catch (e: any) {
    if (id !== reqId) return;
    loadError.value = String(e?.message || e || "加载失败");
    rows.value = [];
  } finally {
    if (id === reqId) loading.value = false;
  }
}

// 打开瞬间按预设初始化（弹窗只有一个实例，show 复位不残留上次的筛选）；关闭时移除 Esc 监听。
// 筛选切换不走 watch 而走显式事件（setFilter/onRangeChange）：避免初始化赋值连带触发双重请求
watch(
  () => props.show,
  (v) => {
    if (v) {
      filter.value = props.preset === "today" ? "today" : "all";
      const now = new Date();
      rangeEnd.value = fmtDay(now);
      rangeStart.value = fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
      load();
      window.addEventListener("keydown", onKeydown);
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  }
);

function setFilter(key: FilterKey) {
  if (filter.value === key) return;
  filter.value = key;
  if (props.show) load();
}
function onRangeChange() {
  if (props.show && filter.value === "range") load();
}

// Esc 关闭（与遮罩点击同语义）
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.show) emit("close");
}

const totalSum = computed(() => rows.value.reduce((a, r) => a + (r.totalTokens || 0), 0));

function hitText(r: AggregateRow): string {
  return r.cacheHitRate != null ? formatPercent(r.cacheHitRate) : "-";
}
</script>

<template>
  <Teleport to="body">
    <div class="mrm-overlay" :class="{ show }" @click="emit('close')"></div>
    <div class="mrm-modal" :class="{ show }" role="dialog" aria-modal="true">
      <div class="mrm-head">
        <div class="mrm-titles">
          <div class="mrm-title">模型用量排行榜 <QMark text="按当前筛选窗口内各模型的消耗聚合排行，口径与上方卡片一致（含 Qoder 官方模型额度点折算）；命中率为「-」表示该模型无缓存口径数据。" /></div>
        </div>
        <el-tooltip content="关闭（Esc）" placement="top">
          <button class="mrm-close" @click="emit('close')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </el-tooltip>
      </div>

      <div class="mrm-filters">
        <div class="mrm-tabs">
          <button v-for="f in FILTERS" :key="f.key" class="mrm-tab" :class="{ active: filter === f.key }" @click="setFilter(f.key)">{{ f.label }}</button>
        </div>
        <template v-if="filter === 'range'">
          <input type="date" class="mrm-date" v-model="rangeStart" :max="todayStr" @change="onRangeChange" />
          <span class="mrm-range-sep">→</span>
          <input type="date" class="mrm-date" v-model="rangeEnd" :max="todayStr" :min="rangeStart" @change="onRangeChange" />
        </template>
        <div v-if="timeWindow" class="mrm-total">共 {{ rows.length }} 个模型 · 合计 {{ formatToken(totalSum) }}</div>
      </div>

      <div class="mrm-body">
        <div v-if="!loading && rows.length" class="mrm-cols">
          <span></span>
          <span>模型</span>
          <span class="mrc-num">消耗 Token</span>
          <span class="mrc-num">缓存命中率</span>
          <span class="mrc-num">调用次数</span>
        </div>
        <div class="mrm-list">
          <template v-if="loading">
            <div class="mrm-sk" v-for="i in 7" :key="i"></div>
          </template>
          <template v-else-if="loadError">
            <div class="mrm-empty">
              <div class="mrm-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 8h8M8 12h5" /></svg></div>
              <div class="mrm-empty-title">加载失败</div>
              <div class="mrm-empty-desc">{{ loadError }}</div>
            </div>
          </template>
          <template v-else-if="!timeWindow">
            <div class="mrm-empty">
              <div class="mrm-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 8h8M8 12h5" /></svg></div>
              <div class="mrm-empty-title">请选择起止日期</div>
              <div class="mrm-empty-desc">选定时间段后查看该范围内的模型用量排行。</div>
            </div>
          </template>
          <template v-else-if="!rows.length">
            <div class="mrm-empty">
              <div class="mrm-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 8h8M8 12h5" /></svg></div>
              <div class="mrm-empty-title">该范围暂无模型用量</div>
              <div class="mrm-empty-desc">切换筛选范围，或完成一次同步后再来看。</div>
            </div>
          </template>
          <template v-else>
            <div v-for="(r, i) in rows" :key="r.key || '_unknown'" class="mrm-row">
              <span class="mrm-rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
              <div class="mrm-model">
                <div class="mrm-name" :title="r.key || '未知模型'">{{ r.key || "未知模型" }}</div>
                <div class="mrm-split">输入 {{ formatToken(r.inputTokens) }} · 输出 {{ formatToken(r.outputTokens) }} · 缓存读 {{ formatToken(r.cacheReadTokens) }}</div>
              </div>
              <div class="mrm-val mono">{{ formatToken(r.totalTokens) }}</div>
              <div class="mrm-val mono" :class="{ dim: r.cacheHitRate == null }">{{ hitText(r) }}</div>
              <div class="mrm-val mono">{{ (r.count || 0).toLocaleString("en-US") }}</div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Teleport 到 body，scoped 样式照常生效（组件内元素带 data-v 属性）；
   不依赖 sync.css 的后代选择器，避免同元素双类坑（DayModal 同策略） */

.mrm-overlay {
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
.mrm-overlay.show {
  opacity: 1;
  pointer-events: auto;
}

.mrm-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 91;
  /* 固定尺寸：内部列表自行滚动，不随内容伸缩 */
  width: 680px;
  height: 520px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  transform: translate(-50%, -50%) scale(0.94) translateY(10px);
  opacity: 0;
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
.mrm-modal.show {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, -50%) scale(1) translateY(0);
  filter: blur(0);
}

/* ===== 头部：标题 + 小问号 + 圆形关闭钮（同 DayModal 结构） ===== */
.mrm-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 16px 13px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.mrm-titles {
  flex: 1;
  min-width: 0;
  line-height: 1.3;
}
.mrm-title {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.mrm-close {
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
.mrm-close:hover {
  color: var(--text);
  border-color: var(--accent-line);
  transform: rotate(90deg);
}

/* ===== 筛选行：范围 tab + 时间段日期 + 合计小字（视觉参数对齐 sync.css 的 .tabs/.tab） ===== */
.mrm-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px 10px;
  flex-shrink: 0;
}
.mrm-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: var(--r-ctl);
  padding: 3px;
  flex-shrink: 0;
}
.mrm-tab {
  height: var(--ctl-h-sm);
  padding: 0 11px;
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: var(--text-3);
  border-radius: var(--r-sm);
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, background 0.15s;
  border: none;
  background: transparent;
}
.mrm-tab:hover {
  color: var(--text);
}
.mrm-tab.active {
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
}
.mrm-date {
  height: var(--ctl-h-sm);
  padding: 0 8px;
  font-size: 11.5px;
  color: var(--text);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  outline: none;
  transition: border-color 0.15s;
}
.mrm-date:focus {
  border-color: var(--accent-line);
}
.mrm-range-sep {
  font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}
.mrm-total {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== 列表区：固定尺寸内的滚动主体 ===== */
.mrm-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px 10px;
}
.mrm-cols {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 104px 84px 72px;
  gap: 8px;
  padding: 6px 10px 7px;
  border-bottom: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
  flex-shrink: 0;
}
.mrc-num {
  text-align: right;
}
.mrm-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 2px 2px;
}
.mrm-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 104px 84px 72px;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: var(--r-md, 10px);
  transition: background 0.15s;
}
.mrm-row:hover {
  background: var(--bg-soft);
}
.mrm-rank {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  border-radius: 50%;
}
.mrm-rank.top {
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.mrm-model {
  min-width: 0;
}
.mrm-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mrm-split {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mrm-val {
  text-align: right;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}
.mrm-val.dim {
  color: var(--text-3);
}

/* 加载骨架：弹窗内自带（sync.css 的 .skeleton 锁在 .sync-scope 作用域内拿不到） */
.mrm-sk {
  height: 44px;
  margin: 4px 10px;
  border-radius: var(--r-md, 10px);
  background: var(--bg-soft);
  position: relative;
  overflow: hidden;
}
.mrm-sk::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent, var(--sheen-sweep, rgba(255, 255, 255, 0.08)), transparent);
  transform: translateX(-100%);
  animation: mrm-shimmer 1.4s ease infinite;
}
@keyframes mrm-shimmer {
  to {
    transform: translateX(100%);
  }
}

/* 空态：视觉对齐 sync.css 的 .empty-state（同样因作用域不可复用，自带一份） */
.mrm-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
  padding: 20px;
}
.mrm-empty-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--text-3);
  opacity: 0.7;
  margin-bottom: 6px;
}
.mrm-empty-icon svg {
  width: 34px;
  height: 34px;
}
.mrm-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.mrm-empty-desc {
  font-size: 11.5px;
  color: var(--text-3);
  max-width: 300px;
}
</style>
