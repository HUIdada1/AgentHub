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
<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 自动化任务：科学仪表盘 + 便捷分类操作 + 预设套餐 + 任务调度工作台 + 实时执行跟踪 + 审计时间线 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo, timeUntil, formatDateTime } from "../../composables/useFormat";
import { useAiGuard } from "../../composables/useAiGuard";
import { taskLabelZh } from "../../components/memory/labels";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemSelect from "../../components/memory/MemSelect.vue";
import MemDialog from "../../components/memory/MemDialog.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";

const app = useAppStore();
const mem = useMemoryStore();
/** AI 引导守卫：模型类任务在未配置 / 渠道报错时弹窗引导去「设置 · 模型与网关」 */
const aiGuard = useAiGuard();
const active = computed(() => app.activeModule === "memory" && app.activePage === "auto");

type TaskRhythm = { intervalMin: number | null; daily: string | null; weekly: number | null; weeklyTime: string | null };
type TaskRow = {
  id: string;
  name: string;
  needsModel: boolean;
  estimate: string;
  enabled: boolean;
  intervalMin: number | null;
  daily: string | null;
  weekly: number | null;
  weeklyTime: string | null;
  batchSize: number | null;
  thresholdCount: number | null;
  lastAt: number;
  nextAt: number;
  successRate: number | null;
  runs: number;
  tokens: number;
  default: TaskRhythm;
};
type StatusShape = {
  enabled: boolean;
  paused: boolean;
  pausedUntil: number;
  running: { id: string; name?: string; startedAt: number; phase: string; percent?: number } | null;
  queue: string[];
  todayTokens: number;
  todayCalls: number;
  dailyTokenLimit: number;
  overBudget: boolean;
  pending: { unprocessed: number; classified: number; review: number; dedup: number };
  tasks: TaskRow[];
};

const status = ref<StatusShape | null>(null);
const timeline = ref<
  {
    task: string;
    name?: string;
    at: number;
    ok: boolean;
    ms: number;
    tokens: number;
    detail: string;
    errorCode?: string;
    processed?: number;
    updated?: number;
    report?: string;
  }[]
>([]);
const timelineAll = ref(false);
const limitInput = ref(0);
const limitEl = ref<HTMLInputElement | null>(null);

/* 任务分类筛选 */
type TaskFilter = "all" | "enabled" | "model" | "zero";
const taskFilter = ref<TaskFilter>("all");

function taskNameOf(id: string): string {
  return status.value?.tasks.find((t) => t.id === id)?.name || taskLabelZh(id);
}

async function refreshStatus(silent = false) {
  try {
    status.value = (await api.memoryAutoStatus()) as unknown as StatusShape;
  } catch (e) {
    if (!silent) ElMessage.error((e as Error).message || "读取自动化状态失败");
  }
  try {
    const t = await api.memoryAutoTimeline(50);
    timeline.value = t.entries as unknown as typeof timeline.value;
  } catch {
    /* 忽略 */
  }
}

async function refresh() {
  await mem.loadAll();
  await refreshStatus();
}

let statusTimer: number | undefined;
function scheduleStatusRefresh() {
  if (statusTimer) return;
  statusTimer = window.setTimeout(() => {
    statusTimer = undefined;
    void refreshStatus(true);
  }, 800);
}

let offEvent: (() => void) | undefined;
function onAutoEvent(p: { type?: string; phase?: string }) {
  if (p.type === "task" || p.type === "task-progress") scheduleStatusRefresh();
}

let finishTimer: number | undefined;

/* 立即执行与排队跟踪 */
const runOpen = ref(false);
const trackId = ref("");
const trackName = ref("");
const trackStartedAt = ref(0);
const runPhase = ref("");
const runResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);
const runTracking = computed(() => !!trackId.value && !runResult.value);
let trackResolving = false;

async function runTask(id: string) {
  const needsModel = status.value?.tasks.find((t) => t.id === id)?.needsModel !== false;
  if (needsModel && !(await aiGuard.ensureAiReady({ task: taskNameOf(id) }))) return;
  try {
    const r = await api.memoryAutoTaskRun(id);
    if (!r.ok) {
      if (trackId.value && runOpen.value) {
        ElMessage.error(r.message || "任务失败");
        return;
      }
      trackId.value = "";
      runPhase.value = "";
      runResult.value = { ok: false, message: r.message || "任务失败" };
      runOpen.value = true;
      return;
    }
    if (trackId.value && runOpen.value) {
      ElMessage.success(r.detail || "已加入队列");
      return;
    }
    trackId.value = id;
    trackName.value = taskNameOf(id);
    trackStartedAt.value = Date.now();
    runPhase.value = r.queued ? "排队中（等当前任务执行完）…" : "准备中";
    runResult.value = null;
    runOpen.value = true;
  } catch (e) {
    runResult.value = { ok: false, message: (e as Error).message || "执行失败" };
    runOpen.value = true;
  }
}

function finishTrack(entry?: { ok: boolean; detail: string; tokens: number; errorCode?: string }) {
  if (!trackId.value) return;
  trackId.value = "";
  if (entry && entry.ok) {
    runResult.value = {
      ok: true,
      message: entry.detail || "执行完成",
      extra: [entry.tokens ? `消耗 ${formatInteger(entry.tokens)} token` : ""].filter(Boolean),
    };
  } else if (entry) {
    runResult.value = { ok: false, message: entry.detail || "任务失败" };
    if (entry.errorCode === "no_model") {
      aiGuard.handleAiError({ code: "no_model", message: entry.detail } as unknown as Error, { task: trackName.value });
    }
  } else {
    runResult.value = { ok: false, message: "任务已结束（可能被跳过或取消）" };
  }
  void refresh();
}

watch(status, (s) => {
  if (!trackId.value) return;
  const rt = s?.running && s.running.id === trackId.value ? s.running : null;
  if (rt) {
    runPhase.value = rt.phase || "执行中…";
    trackStartedAt.value = rt.startedAt;
    return;
  }
  if (s?.queue?.includes(trackId.value)) {
    runPhase.value = "排队中（等当前任务执行完）…";
    return;
  }
  const entry = timeline.value.find((e) => e.task === trackId.value && e.at >= trackStartedAt.value);
  if (entry) {
    finishTrack(entry);
    return;
  }
  if (trackResolving) return;
  trackResolving = true;
  if (finishTimer) window.clearTimeout(finishTimer);
  finishTimer = window.setTimeout(() => {
    finishTimer = undefined;
    trackResolving = false;
    if (!trackId.value) return;
    finishTrack(timeline.value.find((e) => e.task === trackId.value && e.at >= trackStartedAt.value));
  }, 1600);
});

const taskConfirm = ref<TaskRow | null>(null);

const running = computed(() => status.value?.running || null);
const runPercent = computed(() => {
  const p = running.value?.percent;
  return typeof p === "number" ? Math.max(2, Math.min(100, Math.round(p))) : 0;
});

const queueRows = computed(() => (status.value?.queue || []).map((id) => ({ id, name: taskNameOf(id) })));

async function cancelRun() {
  try {
    await api.memoryAutoCancel();
    ElMessage.success("已取消排队中的任务");
    await refreshStatus();
  } catch (e) {
    ElMessage.error((e as Error).message || "取消失败");
  }
}

/* 节奏编辑弹窗 */
const editOpen = ref(false);
const editTask = ref<TaskRow | null>(null);
const editKind = ref<"interval" | "daily" | "weekly">("interval");
const editInterval = ref(30);
const editDaily = ref("11:00");
const editWeekly = ref(1);
const editWeeklyTime = ref("11:00");
const HHMM = /^\d{1,2}:\d{2}$/;
const WEEKDAY_OPTIONS = ["日", "一", "二", "三", "四", "五", "六"].map((d, i) => ({ value: i, label: `周${d}` }));

function openEdit(t: TaskRow) {
  editTask.value = t;
  if (t.weekly != null) {
    editKind.value = "weekly";
    editWeekly.value = t.weekly;
    editWeeklyTime.value = t.weeklyTime || "11:00";
  } else if (t.daily) {
    editKind.value = "daily";
    editDaily.value = t.daily;
  } else {
    editKind.value = "interval";
    editInterval.value = t.intervalMin || 30;
  }
  editOpen.value = true;
}

async function saveEdit(successMsg = "") {
  const t = editTask.value;
  if (!t) return;
  const patch: Record<string, unknown> = { intervalMin: null, daily: null, weekly: null, weeklyTime: null };
  if (editKind.value === "interval") {
    const n = Math.round(Number(editInterval.value));
    if (!Number.isFinite(n) || n < 5) {
      ElMessage.warning("间隔最小 5 分钟");
      return;
    }
    patch.intervalMin = n;
  } else if (editKind.value === "daily") {
    if (!HHMM.test(editDaily.value.trim())) {
      ElMessage.warning("时间格式为 HH:mm，如 11:00");
      return;
    }
    patch.daily = editDaily.value.trim();
  } else {
    if (!HHMM.test(editWeeklyTime.value.trim())) {
      ElMessage.warning("时间格式为 HH:mm，如 11:00");
      return;
    }
    patch.weekly = editWeekly.value;
    patch.weeklyTime = editWeeklyTime.value.trim();
  }
  try {
    await api.memoryAutoTaskSave(t.id, patch);
    editOpen.value = false;
    await refresh();
    ElMessage.success(successMsg || `${t.name} 节奏已更新`);
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

function restoreDefaultRhythm() {
  const t = editTask.value;
  const d = t?.default;
  if (!t || !d) return;
  if (d.weekly != null) {
    editKind.value = "weekly";
    editWeekly.value = d.weekly;
    editWeeklyTime.value = d.weeklyTime || "11:00";
  } else if (d.daily) {
    editKind.value = "daily";
    editDaily.value = d.daily;
  } else {
    editKind.value = "interval";
    editInterval.value = d.intervalMin || 30;
  }
  void saveEdit(
    `已恢复「${t.name}」默认节奏（${fmtInterval({ ...t, intervalMin: d.intervalMin, daily: d.daily, weekly: d.weekly, weeklyTime: d.weeklyTime })}）`,
  );
}

function toggleTask(t: TaskRow) {
  if (!t.enabled) {
    taskConfirm.value = t;
    return;
  }
  void saveTaskEnabled(t);
}

function confirmEnableTask() {
  const t = taskConfirm.value;
  taskConfirm.value = null;
  if (t) void saveTaskEnabled(t);
}

async function saveTaskEnabled(t: TaskRow) {
  try {
    await api.memoryAutoTaskSave(t.id, { enabled: !t.enabled });
    await refresh();
    ElMessage.success(`${t.name} 已${t.enabled ? "关闭" : "开启"}`);
  } catch (e) {
    await refresh();
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function exportReport() {
  try {
    const r = await api.memoryAutoReport();
    reportPath.value = r.file || "";
    reportOpen.value = true;
  } catch (e) {
    ElMessage.error((e as Error).message || "导出失败");
  }
}

async function openReportDir() {
  if (!reportPath.value) return;
  try {
    await api.memoryOpenDir(reportPath.value);
  } catch (e) {
    ElMessage.error((e as Error).message || "打开失败");
  }
}

const reportOpen = ref(false);
const reportPath = ref("");

async function saveLimit(value: number) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    ElMessage.warning("请填一个不小于 0 的数字（0 = 不限）");
    return;
  }
  try {
    await mem.save({ "auto.dailyTokenLimit": Number(value) });
    await refresh();
    ElMessage.success("日预算已更新");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败（值超出允许范围）");
  }
}

async function saveKV(entries: Record<string, unknown>) {
  try {
    await mem.save(entries);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
    await refresh();
  }
}

function focusLimit() {
  limitEl.value?.focus();
  limitEl.value?.select();
}

const autoMode = computed(() => (!status.value?.enabled ? "off" : status.value?.paused ? "paused" : "on"));
const AUTO_MODE_OPTIONS = [
  { value: "on", label: "运行中（按计划自动调度）" },
  { value: "paused", label: "暂停至明天 0 点（可手动执行）" },
  { value: "off", label: "全部停用（可手动执行）" },
];
const modeBusy = ref(false);

async function setAutoMode(v: string | number) {
  const mode = String(v);
  if (mode === autoMode.value || modeBusy.value) return;
  modeBusy.value = true;
  try {
    if (mode === "off") {
      await api.memoryAutoPause({ resume: true });
      await mem.save({ "auto.enabled": false });
    } else if (mode === "paused") {
      await mem.save({ "auto.enabled": true });
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 0, 0);
      await api.memoryAutoPause({ until: tomorrow.getTime() });
    } else {
      await mem.save({ "auto.enabled": true });
      await api.memoryAutoPause({ resume: true });
    }
    await refresh();
    ElMessage.success(mode === "on" ? "自动化已恢复运行" : mode === "paused" ? "已暂停，明天 0 点自动恢复" : "自动化已全部关闭");
  } catch (e) {
    await refresh();
    ElMessage.error((e as Error).message || "切换失败");
  } finally {
    modeBusy.value = false;
  }
}

/* 预设套餐 */
type PresetId = "frugal" | "standard" | "busy";
const PRESETS: { id: PresetId; label: string; desc: string; tokens: number; icon: string; on: string[] }[] = [
  {
    id: "frugal",
    label: "省钱模式",
    desc: "只跑零成本任务（归类、索引自检、清理），完全不调模型",
    tokens: 0,
    icon: "ph-piggy-bank",
    on: ["classify", "index-scan", "cleanup"],
  },
  {
    id: "standard",
    label: "标准推荐",
    desc: "零成本 + 智能打标签 + 摘要生成 + 事实推翻；日预算 20 万 token",
    tokens: 200000,
    icon: "ph-scales",
    on: ["classify", "index-scan", "cleanup", "tag", "summarize", "extract", "supersede"],
  },
  {
    id: "busy",
    label: "深度勤快",
    desc: "全部任务全开（含深度蒸馏、全库查重、深层画像）；日预算 50 万 token",
    tokens: 500000,
    icon: "ph-lightning",
    on: ["classify", "index-scan", "cleanup", "tag", "summarize", "extract", "supersede", "distill", "profile", "consolidate"],
  },
];

const PRESET_KNOWN = new Set(["extract", "summarize", "tag", "classify", "supersede", "distill", "consolidate", "profile", "index-scan", "cleanup"]);
const presetConfirm = ref<PresetId | null>(null);
const presetBusy = ref(false);
const presetTarget = computed(() => PRESETS.find((x) => x.id === presetConfirm.value) || null);

function applyPreset(id: PresetId) {
  presetConfirm.value = id;
}

async function doApplyPreset() {
  const p = presetTarget.value;
  presetConfirm.value = null;
  if (!p || presetBusy.value) return;
  presetBusy.value = true;
  let fail = 0;
  try {
    for (const t of status.value?.tasks || []) {
      if (!PRESET_KNOWN.has(t.id)) continue;
      const want = p.on.includes(t.id);
      if (want === t.enabled) continue;
      try {
        await api.memoryAutoTaskSave(t.id, { enabled: want });
      } catch {
        fail++;
      }
    }
    await mem.save({ "auto.dailyTokenLimit": p.tokens });
    await refresh();
    if (fail) ElMessage.warning(`已应用「${p.label}」套餐：${fail} 个任务未保存成功，可手动重试`);
    else ElMessage.success(`已应用「${p.label}」套餐（任务节奏未改动）`);
  } catch (e) {
    await refresh();
    ElMessage.error((e as Error).message || "应用套餐失败");
  } finally {
    presetBusy.value = false;
  }
}

watch(
  () => status.value?.dailyTokenLimit,
  (v) => {
    if (typeof v === "number") limitInput.value = v;
  },
);

const TASK_DESC: Record<string, string> = {
  extract: "给新记忆补一句语义摘要与重要度评级",
  summarize: "为长时间会话或日常工作流提炼高密度摘要",
  tag: "按内容推断 2~5 个标签，优先与已有概念复用",
  classify: "未归属项目的碎片自动匹配相似归档（零成本）",
  supersede: "识别「新事实推翻旧事实」，输出失效建议",
  distill: "将项目原始碎片深度蒸馏为架构决策与踩坑字典",
  consolidate: "全库记忆查重：自动合并雷同，存疑推入队列",
  profile: "跨项目深度归纳人格、沟通、技术栈与工作习惯",
  "index-scan": "全库文件与索引一致性自检及修复（零成本）",
  cleanup: "清理回收站与异常无用记录（零成本）",
};

function fmtInterval(t: TaskRow) {
  if (t.weekly !== null && t.weekly !== undefined) return `每周${["日", "一", "二", "三", "四", "五", "六"][t.weekly] || "?"} ${t.weeklyTime || ""}`;
  if (t.daily) return `每天 ${t.daily}`;
  return `每隔 ${t.intervalMin || "?"} 分钟`;
}

/* 过滤后的任务列表 */
const filteredTasks = computed(() => {
  const list = status.value?.tasks || [];
  if (taskFilter.value === "enabled") return list.filter((t) => t.enabled);
  if (taskFilter.value === "model") return list.filter((t) => t.needsModel);
  if (taskFilter.value === "zero") return list.filter((t) => !t.needsModel);
  return list;
});

const taskCounts = computed(() => {
  const list = status.value?.tasks || [];
  return {
    all: list.length,
    enabled: list.filter((t) => t.enabled).length,
    model: list.filter((t) => t.needsModel).length,
    zero: list.filter((t) => !t.needsModel).length,
  };
});

onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; phase?: string };
    if (p.event !== "memory") return;
    if (!active.value) return;
    onAutoEvent(p);
  });
});

onUnmounted(() => {
  if (offEvent) offEvent();
  if (statusTimer) window.clearTimeout(statusTimer);
  if (finishTimer) window.clearTimeout(finishTimer);
});

watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope">
    <!-- 实时执行状态条（运行中/排队中置顶） -->
    <div v-if="running" class="auto-running-banner">
      <div class="running-main-row">
        <div class="running-info">
          <span class="running-spinner">
            <i class="ph ph-circle-notch ph-spin"></i>
          </span>
          <span class="running-title">正在执行：<b>{{ running.name || taskNameOf(running.id) }}</b></span>
          <span v-if="running.phase" class="running-phase">· {{ running.phase }}</span>
          <span class="running-time">· 开始于 {{ timeAgo(running.startedAt) }}</span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="cancelRun">取消任务</button>
      </div>
      <div class="running-progress-wrap">
        <div class="running-progress-bar">
          <div class="running-progress-fill" :style="{ width: `${runPercent}%` }"></div>
        </div>
        <span class="running-pct">{{ runPercent }}%</span>
      </div>
      <div v-if="queueRows.length" class="running-queue-row">
        <span class="queue-tag">排队中 ({{ queueRows.length }}):</span>
        <span v-for="(q, i) in queueRows" :key="q.id" class="queue-item">
          {{ i + 1 }}. {{ q.name }}
        </span>
      </div>
    </div>

    <!-- 单纯排队状态 -->
    <div v-else-if="queueRows.length" class="auto-queue-banner">
      <div class="queue-banner-inner">
        <i class="ph ph-hourglass-simple"></i>
        <span>排队等待执行 ({{ queueRows.length }} 个任务)：</span>
        <span v-for="(q, i) in queueRows" :key="q.id" class="queue-item">
          {{ i + 1 }}. {{ q.name }}
        </span>
      </div>
      <button class="btn btn-ghost btn-xs" @click="cancelRun">清空队列</button>
    </div>

    <!-- 超预算提示横幅 -->
    <div v-if="status?.overBudget" class="auto-budget-alert">
      <div class="alert-content">
        <i class="ph ph-warning-circle"></i>
        <span>今日 Token 消耗已达设定上限 <b>{{ formatInteger(status.dailyTokenLimit) }}</b>，模型类任务已自动跳过保护余额（零成本自检/归类任务正常进行）。</span>
      </div>
      <button class="btn btn-outline btn-xs" @click="focusLimit">立即调整上限</button>
    </div>

    <!-- 科学便捷仪表盘：核心指标与控制 -->
    <div class="auto-metrics-grid">
      <!-- 1. 全局运行调度控制 -->
      <div class="auto-metric-card">
        <div class="metric-card-header">
          <div class="metric-icon-box">
            <i class="ph" :class="autoMode === 'on' ? 'ph-play-circle' : autoMode === 'paused' ? 'ph-pause-circle' : 'ph-stop-circle'"></i>
          </div>
          <div class="metric-title-group">
            <div class="metric-label">调度总控</div>
            <div class="metric-sub">
              {{ autoMode === "paused" && status?.pausedUntil ? `暂停至 ${formatDateTime(status.pausedUntil)}` : autoMode === "paused" ? "自动调度暂停中" : autoMode === "off" ? "全部停用" : "自动调度活跃中" }}
            </div>
          </div>
        </div>
        <div class="metric-control-row">
          <MemSelect
            :model-value="autoMode"
            width="100%"
            :disabled="modeBusy"
            :options="AUTO_MODE_OPTIONS"
            @change="setAutoMode"
          />
        </div>
        <div class="metric-footer-tip">
          <i class="ph ph-info"></i>
          <span>无论总控是否开启，任务卡片上的「立即执行」均可随时手动触发</span>
        </div>
      </div>

      <!-- 2. 今日消耗与预算闸门 -->
      <div class="auto-metric-card">
        <div class="metric-card-header">
          <div class="metric-icon-box token-box">
            <i class="ph ph-cpu"></i>
          </div>
          <div class="metric-title-group">
            <div class="metric-label">今日 Token 消耗</div>
            <div class="metric-sub">今日调用 {{ status?.todayCalls || 0 }} 次</div>
          </div>
          <span
            v-if="(status?.dailyTokenLimit || 0) > 0"
            class="budget-badge"
            :class="(status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1) >= 1 ? 'danger' : (status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1) > 0.8 ? 'warning' : 'normal'"
          >
            {{ Math.round(((status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1)) * 100) }}%
          </span>
          <span v-else class="budget-badge unlimited">不限额</span>
        </div>

        <div class="token-progress-area">
          <div class="token-numbers">
            <b>{{ formatInteger(status?.todayTokens || 0) }}</b>
            <span class="token-limit-text">
              / {{ (status?.dailyTokenLimit || 0) > 0 ? formatInteger(status?.dailyTokenLimit || 0) : "无上限" }}
            </span>
          </div>
          <div v-if="(status?.dailyTokenLimit || 0) > 0" class="token-bar-track">
            <div
              class="token-bar-fill"
              :style="{ width: `${Math.min(100, Math.round(((status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1)) * 100))}%` }"
              :class="(status?.todayTokens || 0) >= (status?.dailyTokenLimit || 0) ? 'is-overflow' : ''"
            ></div>
          </div>
        </div>

        <div class="budget-input-row">
          <span class="budget-label">日限额:</span>
          <input
            ref="limitEl"
            v-model.number="limitInput"
            type="number"
            min="0"
            step="10000"
            class="f-input budget-input"
            placeholder="0 为不限额"
            @change="saveLimit(limitInput)"
            @keyup.enter="saveLimit(limitInput)"
          />
          <span class="budget-unit">Token (0=不限)</span>
        </div>
      </div>

      <!-- 3. 待确认与健康度 -->
      <div class="auto-metric-card">
        <div class="metric-card-header">
          <div class="metric-icon-box review-box">
            <i class="ph ph-check-square-offset"></i>
          </div>
          <div class="metric-title-group">
            <div class="metric-label">待确认裁决建议</div>
            <div class="metric-sub">需人工判定的失效/归类/查重建议</div>
          </div>
        </div>

        <div class="review-status-area">
          <div class="review-count-display">
            <span class="review-big-num">{{ status?.pending?.review || 0 }}</span>
            <span class="review-unit">项待办</span>
          </div>
          <button
            class="btn btn-sm"
            :class="(status?.pending?.review || 0) > 0 ? 'btn-primary' : 'btn-ghost'"
            @click="mem.gotoReview()"
          >
            <span>进入裁决收件箱</span>
            <i class="ph ph-arrow-right"></i>
          </button>
        </div>

        <div class="metric-extra-row">
          <span class="extra-label">超预算行为:</span>
          <MemSelect
            :model-value="mem.cfg('auto.overBudgetAction', 'pause')"
            width="160px"
            :options="[
              { value: 'pause', label: '暂停模型任务' },
              { value: 'ignore', label: '不限额继续' },
            ]"
            @change="(v: string | number) => saveKV({ 'auto.overBudgetAction': v })"
          />
        </div>
      </div>
    </div>

    <!-- 预设套餐：一键快速切换策略 -->
    <div class="auto-presets-container">
      <div class="presets-header">
        <div class="presets-title">
          <i class="ph ph-magic-wand"></i>
          <span>一键预设套餐</span>
        </div>
        <span class="presets-hint">快速批量设定各任务开关与日预算，各任务自定义调度节奏保持不变</span>
      </div>

      <div class="presets-grid">
        <div
          v-for="p in PRESETS"
          :key="p.id"
          class="preset-card"
          @click="applyPreset(p.id)"
        >
          <div class="preset-card-top">
            <div class="preset-icon">
              <i class="ph" :class="p.icon"></i>
            </div>
            <div class="preset-name">{{ p.label }}</div>
            <span class="preset-tokens-badge">
              {{ p.tokens === 0 ? "0 Token · 纯本地" : `日预算 ${(p.tokens / 10000).toFixed(0)}万` }}
            </span>
          </div>
          <p class="preset-desc">{{ p.desc }}</p>
          <div class="preset-footer">
            <span class="preset-tasks-count">激活 {{ p.on.length }} 项自动化</span>
            <button class="btn btn-ghost btn-xs apply-btn" :disabled="presetBusy">
              应用套餐
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务调度工作台 -->
    <div class="auto-tasks-section">
      <!-- 任务区顶部过滤工具栏 -->
      <div class="tasks-toolbar">
        <div class="toolbar-left">
          <h3 class="section-title">
            <i class="ph ph-clock-countdown"></i>
            <span>任务调度工作台</span>
          </h3>
          <!-- 分类筛选器 -->
          <div class="task-filter-pills">
            <button
              class="filter-pill"
              :class="{ active: taskFilter === 'all' }"
              @click="taskFilter = 'all'"
            >
              全部 ({{ taskCounts.all }})
            </button>
            <button
              class="filter-pill"
              :class="{ active: taskFilter === 'enabled' }"
              @click="taskFilter = 'enabled'"
            >
              已开启 ({{ taskCounts.enabled }})
            </button>
            <button
              class="filter-pill"
              :class="{ active: taskFilter === 'model' }"
              @click="taskFilter = 'model'"
            >
              调用模型 ({{ taskCounts.model }})
            </button>
            <button
              class="filter-pill"
              :class="{ active: taskFilter === 'zero' }"
              @click="taskFilter = 'zero'"
            >
              零成本 ({{ taskCounts.zero }})
            </button>
          </div>
        </div>

        <div class="toolbar-right">
          <span class="mem-hint">
            共 {{ status?.tasks?.length || 0 }} 个注册任务 · 点击卡片开关即刻生效
          </span>
        </div>
      </div>

      <!-- 任务卡片网格 -->
      <div class="tasks-grid">
        <div
          v-for="t in filteredTasks"
          :key="t.id"
          class="task-card"
          :class="{ 'is-active': t.enabled }"
        >
          <!-- 卡片头部 -->
          <div class="task-card-header">
            <div class="task-meta-left">
              <span class="task-title">{{ t.name }}</span>
              <span class="task-type-badge" :class="t.needsModel ? 'needs-model' : 'zero-cost'">
                {{ t.needsModel ? "调用模型" : "零成本" }}
              </span>
            </div>
            <div class="task-switch-box">
              <div
                class="switch"
                :class="{ on: t.enabled }"
                role="switch"
                :aria-checked="!!t.enabled"
                @click="toggleTask(t)"
              ></div>
            </div>
          </div>

          <!-- 职责大白话描述 -->
          <div class="task-desc-box">
            {{ TASK_DESC[t.id] || "—" }}
          </div>

          <!-- 节奏与调度信息 -->
          <div class="task-schedule-box">
            <div class="schedule-item">
              <span class="item-k"><i class="ph ph-repeat"></i> 调度节奏:</span>
              <span class="item-v rhythm-val">{{ fmtInterval(t) }}</span>
              <button class="btn-link edit-rhythm-btn" @click="openEdit(t)">
                <i class="ph ph-pencil-simple"></i> 改节奏
              </button>
            </div>
            <div class="schedule-dual-row">
              <div class="time-col">
                <span class="item-k">上次运行:</span>
                <span class="item-v">{{ t.lastAt ? timeAgo(t.lastAt) : "从未执行" }}</span>
              </div>
              <div class="time-col">
                <span class="item-k">下次计划:</span>
                <span class="item-v" :class="t.enabled && t.nextAt ? 'next-at-active' : ''">
                  {{ t.enabled && t.nextAt ? timeUntil(t.nextAt) : "—" }}
                </span>
              </div>
            </div>
          </div>

          <!-- 统计与执行操作 -->
          <div class="task-card-footer">
            <div class="task-stats">
              <span class="stat-runs">
                {{ t.runs }} 次运行
              </span>
              <span v-if="t.successRate !== null" class="stat-rate" :class="t.successRate >= 95 ? 'rate-good' : 'rate-warn'">
                成功率 {{ t.successRate }}%
              </span>
              <span v-if="t.tokens > 0" class="stat-tokens">
                {{ formatInteger(t.tokens) }} tokens
              </span>
            </div>

            <div class="task-actions">
              <button
                class="btn btn-sm run-btn"
                :disabled="status?.queue?.includes(t.id)"
                @click="runTask(t.id)"
              >
                <i class="ph ph-play"></i>
                <span>立即执行</span>
              </button>
              <span v-if="status?.queue?.includes(t.id)" class="queued-badge">
                <i class="ph ph-hourglass"></i> 排队中
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务执行审计时间线 -->
    <div class="auto-timeline-section">
      <div class="timeline-header">
        <div class="timeline-title-group">
          <h3 class="section-title">
            <i class="ph ph-list-dashes"></i>
            <span>任务执行审计记录</span>
          </h3>
          <span class="timeline-subtitle">最近记录的调度耗时、Token 消耗与执行结果详情</span>
        </div>

        <div class="timeline-actions">
          <button
            v-if="timeline.length > 10"
            class="btn btn-ghost btn-sm"
            @click="timelineAll = !timelineAll"
          >
            {{ timelineAll ? "只看最近 10 条" : `查看全部 ${timeline.length} 条` }}
          </button>
          <button class="btn btn-outline btn-sm" @click="exportReport">
            <i class="ph ph-file-text"></i>
            <span>导出报告</span>
          </button>
        </div>
      </div>

      <div v-if="timeline.length" class="timeline-table-card">
        <table class="mem-table">
          <thead>
            <tr>
              <th style="width: 160px">执行时间</th>
              <th style="width: 140px">任务名称</th>
              <th style="width: 90px">状态</th>
              <th style="width: 90px">耗时</th>
              <th style="width: 110px">消耗 Token</th>
              <th>执行详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in timelineAll ? timeline : timeline.slice(0, 10)" :key="i">
              <td class="time-cell">{{ formatDateTime(e.at) }}</td>
              <td class="task-cell"><b>{{ e.name || taskNameOf(e.task) }}</b></td>
              <td>
                <span class="status-pill" :class="e.ok ? 'success' : 'failure'">
                  <i class="ph" :class="e.ok ? 'ph-check-circle' : 'ph-x-circle'"></i>
                  {{ e.ok ? "成功" : "失败" }}
                </span>
              </td>
              <td class="num">{{ (e.ms / 1000).toFixed(1) }}s</td>
              <td class="num">{{ formatInteger(e.tokens) }}</td>
              <td class="detail-cell">
                <span>{{ e.detail }}</span>
                <button
                  v-if="e.errorCode === 'no_model'"
                  class="btn-link no-model-guide"
                  @click="app.openSettings('models')"
                >
                  去配置模型 →
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="timeline-empty-card">
        <i class="ph ph-clock"></i>
        <span>尚未产生自动化执行日志（后台调度服务在系统启动约 90 秒后开始第一轮周期评估）</span>
      </div>
    </div>

    <!-- 弹窗集 -->
    <MemProgressDialog
      v-model:open="runOpen"
      :title="`执行任务 · ${trackName}`"
      sub="手动触发执行任务，进度由后端执行引擎实时跟进并回报"
      :running="runTracking"
      :phase="runPhase"
      :started-at="trackStartedAt"
      :result="runResult"
    />

    <MemDialog
      :open="!!taskConfirm"
      title="开启自动化任务"
      sub="请确认任务开启条件与预计消耗"
      width="500px"
      @update:open="(v: boolean) => { if (!v) taskConfirm = null; }"
    >
      <div v-if="taskConfirm" class="confirm-modal-body">
        <p>您即将启用任务「<b>{{ taskConfirm.name }}</b>」的定期自动化调度。</p>
        <div class="confirm-info-box">
          <div><b>预计单次消耗：</b>{{ taskConfirm.estimate }}</div>
          <div><b>当前日预算：</b>{{ formatInteger(status?.dailyTokenLimit || 0) }} Token（今日已用 {{ formatInteger(status?.todayTokens || 0) }}）</div>
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="confirmEnableTask">确认开启</button>
        <button class="btn btn-ghost" @click="taskConfirm = null">取消</button>
      </template>
    </MemDialog>

    <MemDialog
      :open="editOpen"
      :title="`编辑调度节奏 · ${editTask?.name || ''}`"
      sub="灵活配置任务的触发周期，不影响任务本身的逻辑行为"
      width="520px"
      @update:open="(v: boolean) => { if (!v) editOpen = false; }"
    >
      <div v-if="editTask" class="edit-rhythm-form">
        <div class="form-row">
          <span class="form-label">节奏类型</span>
          <MemSelect
            :model-value="editKind"
            width="220px"
            :options="[
              { value: 'interval', label: '每隔固定分钟' },
              { value: 'daily', label: '每天固定时间' },
              { value: 'weekly', label: '每周固定日 + 时间' },
            ]"
            @change="(v: string | number) => (editKind = v as 'interval' | 'daily' | 'weekly')"
          />
        </div>

        <div v-if="editKind === 'interval'" class="form-row">
          <span class="form-label">每隔</span>
          <input v-model.number="editInterval" type="number" min="5" class="f-input" style="width: 100px" />
          <span class="form-unit">分钟执行一次（最小 5 分钟）</span>
        </div>

        <div v-else-if="editKind === 'daily'" class="form-row">
          <span class="form-label">每天</span>
          <input v-model="editDaily" type="time" class="f-input" style="width: 140px" />
          <span class="form-unit">执行一次</span>
        </div>

        <div v-else class="form-row">
          <span class="form-label">每周</span>
          <MemSelect
            :model-value="editWeekly"
            width="110px"
            :options="WEEKDAY_OPTIONS"
            @change="(v: string | number) => (editWeekly = Number(v))"
          />
          <input v-model="editWeeklyTime" type="time" class="f-input" style="width: 140px" />
        </div>

        <div class="form-tip">
          <i class="ph ph-info"></i>
          <span>保存后下次运行时间将按新规则重新计算生效。</span>
        </div>
      </div>
      <template #foot>
        <button class="btn btn-ghost" style="margin-right: auto" @click="restoreDefaultRhythm">
          恢复默认出厂节奏
        </button>
        <button class="btn btn-cta" @click="saveEdit()">保存生效</button>
        <button class="btn btn-ghost" @click="editOpen = false">取消</button>
      </template>
    </MemDialog>

    <MemDialog
      :open="!!presetTarget"
      :title="`应用「${presetTarget?.label || ''}」套餐`"
      sub="批量调整任务开启状态与 Token 上限，任务自定义节奏保持原样"
      width="520px"
      @update:open="(v: boolean) => { if (!v) presetConfirm = null; }"
    >
      <div v-if="presetTarget" class="preset-confirm-content">
        <p class="preset-confirm-desc">{{ presetTarget.desc }}</p>
        <div class="preset-confirm-box">
          <div class="box-title">生效任务列表：</div>
          <div class="box-tasks">
            {{ presetTarget.on.map((id) => taskNameOf(id)).join("、") || "（无）" }}
          </div>
          <div class="box-note">其余未包含的任务将被设为关闭状态。</div>
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="presetBusy" @click="doApplyPreset">
          {{ presetBusy ? "应用中…" : "确认并立即应用" }}
        </button>
        <button class="btn btn-ghost" @click="presetConfirm = null">取消</button>
      </template>
    </MemDialog>

    <MemDialog v-model:open="reportOpen" title="审计报告已导出" sub="完整 Markdown 报告路径如下" width="600px">
      <div class="mem-section">
        <div class="s-title">文件绝对路径</div>
        <div class="mem-mono report-path-box">
          {{ reportPath }}
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="openReportDir">在文件管理器中打开</button>
        <button class="btn btn-ghost" @click="reportOpen = false">关闭</button>
      </template>
    </MemDialog>
  </div>
</template>

<style scoped>
/* 实时运行条 */
.auto-running-banner {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--accent, #3b82f6);
  border-radius: var(--r-lg, 12px);
  padding: 14px 18px;
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.12);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.running-main-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.running-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: var(--text);
  flex-wrap: wrap;
}

.running-spinner {
  color: var(--accent, #3b82f6);
  font-size: 18px;
  display: inline-flex;
}

.running-phase {
  color: var(--accent, #3b82f6);
  font-weight: 500;
}

.running-time {
  font-size: 12px;
  color: var(--text-3);
}

.running-progress-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}

.running-progress-bar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  overflow: hidden;
}

.running-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, #3b82f6), #60a5fa);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.running-pct {
  font-family: var(--font-code, monospace);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent, #3b82f6);
}

.running-queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  font-size: 12px;
}

.queue-tag {
  color: var(--text-3);
}

.queue-item {
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  color: var(--text-2);
}

/* 排队横条 */
.auto-queue-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  border: 1px solid var(--line);
  font-size: 12.5px;
}

.queue-banner-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--text-2);
}

/* 超预算警告 */
.auto-budget-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-radius: var(--r-md, 8px);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: var(--danger, #ef4444);
  font-size: 12.5px;
  gap: 12px;
  flex-wrap: wrap;
}

.alert-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 核心指标三列网格 */
.auto-metrics-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 960px) {
  .auto-metrics-grid {
    grid-template-columns: 1fr;
  }
}

.auto-metric-card {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 18px 20px;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 14px;
}

.metric-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
}

.metric-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  color: var(--accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.metric-icon-box.token-box {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.metric-icon-box.review-box {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.metric-title-group {
  flex: 1;
  min-width: 0;
}

.metric-label {
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}

.metric-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.budget-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
  font-family: var(--font-code, monospace);
}

.budget-badge.normal {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.budget-badge.warning {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.budget-badge.danger {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.budget-badge.unlimited {
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  color: var(--text-3);
}

.metric-control-row {
  margin: 4px 0;
}

.metric-footer-tip {
  font-size: 11.5px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 5px;
  line-height: 1.4;
}

/* Token 指标卡细节 */
.token-progress-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.token-numbers {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.token-numbers b {
  font-size: 20px;
  font-family: var(--font-code, monospace);
  color: var(--text);
}

.token-limit-text {
  font-size: 12px;
  color: var(--text-3);
}

.token-bar-track {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  overflow: hidden;
}

.token-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: #10b981;
  transition: width 0.3s;
}

.token-bar-fill.is-overflow {
  background: #ef4444;
}

.budget-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.budget-label {
  color: var(--text-3);
  flex-shrink: 0;
}

.budget-input {
  width: 100px;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
}

.budget-unit {
  font-size: 11px;
  color: var(--text-3);
}

/* 待确认指标卡细节 */
.review-status-area {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.review-count-display {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.review-big-num {
  font-size: 24px;
  font-weight: 700;
  font-family: var(--font-code, monospace);
  color: #f59e0b;
}

.review-unit {
  font-size: 12px;
  color: var(--text-3);
}

.metric-extra-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.extra-label {
  color: var(--text-3);
}

/* 预设套餐区 */
.auto-presets-container {
  background: var(--glass-a, var(--panel));
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.presets-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.presets-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}

.presets-title i {
  color: var(--accent, #3b82f6);
  font-size: 16px;
}

.presets-hint {
  font-size: 12px;
  color: var(--text-3);
}

.presets-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

@media (max-width: 860px) {
  .presets-grid {
    grid-template-columns: 1fr;
  }
}

.preset-card {
  padding: 12px 14px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--line);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preset-card:hover {
  background: var(--bg-hover, rgba(125, 125, 125, 0.09));
  border-color: var(--accent, #3b82f6);
  transform: translateY(-1px);
}

.preset-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preset-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  color: var(--accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.preset-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
}

.preset-tokens-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.12));
  color: var(--text-2);
}

.preset-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
  flex: 1;
}

.preset-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.preset-tasks-count {
  font-size: 11px;
  color: var(--text-3);
}

.apply-btn {
  font-size: 11px;
  height: 22px;
  padding: 0 8px;
}

/* 任务调度工作台 */
.auto-tasks-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tasks-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-filter-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  padding: 3px;
  border-radius: 8px;
}

.filter-pill {
  border: none;
  background: transparent;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
}

.filter-pill:hover {
  color: var(--text);
}

.filter-pill.active {
  background: var(--glass-a, var(--panel));
  color: var(--accent, #3b82f6);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.tasks-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 1100px) {
  .tasks-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 720px) {
  .tasks-grid {
    grid-template-columns: 1fr;
  }
}

.task-card {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 16px 18px;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: all 0.2s var(--ease);
}

.task-card:hover {
  border-color: var(--line-strong, var(--accent));
}

.task-card.is-active {
  border-left: 3px solid var(--accent, #3b82f6);
}

.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.task-meta-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.task-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}

.task-type-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.task-type-badge.needs-model {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.task-type-badge.zero-cost {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.task-desc-box {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.45;
  min-height: 34px;
}

.task-schedule-box {
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11.5px;
}

.schedule-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-k {
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.item-v {
  color: var(--text);
}

.rhythm-val {
  font-weight: 500;
  flex: 1;
}

.edit-rhythm-btn {
  font-size: 11px;
  margin-left: auto;
}

.schedule-dual-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px dashed var(--line);
  padding-top: 5px;
}

.time-col {
  display: flex;
  align-items: center;
  gap: 6px;
}

.next-at-active {
  color: var(--accent, #3b82f6);
  font-weight: 500;
}

.task-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--mem-line, var(--line));
  gap: 8px;
}

.task-stats {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--text-3);
}

.stat-rate.rate-good {
  color: #10b981;
}
.stat-rate.rate-warn {
  color: #f59e0b;
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.run-btn {
  font-size: 12px;
  height: 28px;
  padding: 0 10px;
}

.queued-badge {
  font-size: 11px;
  color: var(--accent, #3b82f6);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 审计时间线 */
.auto-timeline-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.timeline-title-group {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.timeline-subtitle {
  font-size: 12px;
  color: var(--text-3);
}

.timeline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-table-card {
  background: var(--glass-a, var(--panel));
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  overflow: hidden;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
}

.status-pill.success {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.status-pill.failure {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.time-cell {
  font-size: 12px;
  color: var(--text-3);
}

.task-cell {
  font-size: 12.5px;
  color: var(--text);
}

.detail-cell {
  font-size: 12px;
  color: var(--text-2);
}

.no-model-guide {
  font-size: 11.5px;
  margin-left: 6px;
  color: #f59e0b;
}

.timeline-empty-card {
  padding: 32px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border-radius: var(--r-md, 8px);
  border: 1px dashed var(--line);
}

/* 弹窗内容 */
.confirm-modal-body {
  line-height: 1.6;
}

.confirm-info-box {
  margin-top: 10px;
  padding: 10px 14px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  border-radius: 6px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.edit-rhythm-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-label {
  font-size: 13px;
  color: var(--text-2);
  width: 64px;
  flex-shrink: 0;
}

.form-unit {
  font-size: 12px;
  color: var(--text-3);
}

.form-tip {
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.preset-confirm-content {
  line-height: 1.6;
}

.preset-confirm-desc {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 12px;
}

.preset-confirm-box {
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.box-title {
  font-weight: 600;
  color: var(--text);
}

.box-tasks {
  color: var(--accent, #3b82f6);
}

.box-note {
  font-size: 11.5px;
  color: var(--text-3);
}

.report-path-box {
  word-break: break-all;
  padding: 10px 12px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  border-radius: var(--r-sm, 6px);
  font-size: 12px;
}
</style>
