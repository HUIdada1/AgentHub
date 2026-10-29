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
<!-- 记忆中枢 · 自动化任务：总控（含预算）+ 9 张任务卡（状态为主）+ 时间线
     成本明细在仪表盘「AI 花费」；模型配置在「设置 · 模型与网关」；隐私开关在配置页「隐私」分组 -->
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
  id: string; name: string; needsModel: boolean; estimate: string;
  enabled: boolean; intervalMin: number | null; daily: string | null; weekly: number | null; weeklyTime: string | null;
  batchSize: number | null; thresholdCount: number | null;
  lastAt: number; nextAt: number; successRate: number | null; runs: number; tokens: number;
  /** 出厂节奏（TASK_DEFS 原始定义，不受用户配置覆盖）：「恢复默认时间」按钮的数据源 */
  default: TaskRhythm;
};
type StatusShape = {
  enabled: boolean; paused: boolean; pausedUntil: number;
  running: { id: string; name?: string; startedAt: number; phase: string; percent?: number } | null;
  queue: string[]; todayTokens: number; todayCalls: number; dailyTokenLimit: number; overBudget: boolean;
  pending: { unprocessed: number; classified: number; review: number; dedup: number };
  tasks: TaskRow[];
};

const status = ref<StatusShape | null>(null);
/** 时间线条目：errorCode 由后端 scheduler 写入（record.errorCode = e.code），
 *  是「未配置模型」这类原因唯一可靠的判定依据（不再靠文案匹配） */
const timeline = ref<{ task: string; name?: string; at: number; ok: boolean; ms: number; tokens: number; detail: string; errorCode?: string; processed?: number; updated?: number; report?: string }[]>([]);
const timelineAll = ref(false);
const limitInput = ref(0);
const limitEl = ref<HTMLInputElement | null>(null);

/** 任务 id → 中文名：以后端 status.tasks 的 name 为准（它就是任务卡上显示的名字），
    后端没给（历史记录里的旧任务）再退回 labels.ts 的短名，最后兜底原 id */
function taskNameOf(id: string): string {
  return status.value?.tasks.find((t) => t.id === id)?.name || taskLabelZh(id);
}

/** 轻量刷新：只回读自动化状态与时间线（任务在执行期间事件触发，一秒最多一次）。
 *  silent=true 用于事件驱动的后台轮询：主进程暂时繁忙时不该每 800ms 弹一次相同错误（会刷屏），
 *  用户手动进入页面时（silent=false）仍如实报错。 */
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

/** 执行进度实时跟进：后端 task / task-progress 事件触发节流回读，
    正在执行卡片的百分比与阶段始终以后端 running 快照为准（单一数据源，不做本地推测） */
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

/** 收口重试的定时器：组件卸载时必须清掉，避免回调打到已卸载实例 */
let finishTimer: number | undefined;

/** 立即执行改排队跟踪：点「立即执行」入队（忙时排队，可连点多个任务，不必等一个跑完），
    弹窗跟随后端 running 快照（排队中/执行中）；结束后从时间线取本次结果展示。
    弹窗正跟踪别的任务时再点，只入队并 toast 提示，不抢走弹窗 */
const runOpen = ref(false);
const trackId = ref("");
const trackName = ref("");
const trackStartedAt = ref(0);
const runPhase = ref("");
const runResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);
/** 弹窗「正在跑」：入队或执行中都算跑（排队中走阶段文案，执行中跟随后端快照） */
const runTracking = computed(() => !!trackId.value && !runResult.value);
let trackResolving = false;

async function runTask(id: string) {
  // 前置守卫：只对「会调模型」的任务做（索引自检/清理/归类这些零成本任务不该被模型配置拦住）
  const needsModel = status.value?.tasks.find((t) => t.id === id)?.needsModel !== false;
  if (needsModel && !(await aiGuard.ensureAiReady({ task: taskNameOf(id) }))) return;
  try {
    const r = await api.memoryAutoTaskRun(id);
    if (!r.ok) {
      // 超预算或未知任务：直接报失败（弹窗正跟踪别的任务时只 toast，不抢走弹窗）
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

/** 跟踪收口：任务不在跑也不在队后，从时间线找本次执行记录（e.at >= 开始时间戳），
    找到即回填结果；时间线在事件节流下可能滞后，补一拍再收口，仍没有按「已跳过」处理 */
function finishTrack(entry?: { ok: boolean; detail: string; tokens: number; errorCode?: string }) {
  if (!trackId.value) return;
  trackId.value = "";
  if (entry && entry.ok) {
    runResult.value = { ok: true, message: entry.detail || "执行完成", extra: [entry.tokens ? `消耗 ${formatInteger(entry.tokens)} token` : ""].filter(Boolean) };
  } else if (entry) {
    runResult.value = { ok: false, message: entry.detail || "任务失败" };
    // 手动执行是用户在场场景：未配置模型时弹一次引导窗（后台自动跑不弹，只落时间线标记）
    if (entry.errorCode === "no_model") aiGuard.handleAiError({ code: "no_model", message: entry.detail } as unknown as Error, { task: trackName.value });
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
    trackStartedAt.value = rt.startedAt; // 弹窗已用时长以后端开始时间为准
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

/** 正在执行卡片：任务名/阶段/百分比全部用后端快照（进度是任务自报的真实推进，不是按时长估的） */
const running = computed(() => status.value?.running || null);
const runPercent = computed(() => {
  const p = running.value?.percent;
  return typeof p === "number" ? Math.max(2, Math.min(100, Math.round(p))) : 0;
});

/** 排队中的任务（按入队顺序依次执行）：名称跟随任务表，队列里的旧 id 也给得出名字 */
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

/** 节奏编辑弹窗：三种节奏（每隔 N 分钟 / 每天固定时间 / 每周固定日+时间）任选其一。
    保存时把不用的模式置 null——后端 taskConfig 会合并默认值，只有置空才能切换模式 */
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

/** 恢复默认时间：把节奏表单回填成出厂值（status.tasks[].default）并立即保存。
    走 saveEdit 同一条保存路径，校验/关闭弹窗/回读全部复用 */
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
  void saveEdit(`已恢复「${t.name}」默认节奏（${fmtInterval({ ...t, intervalMin: d.intervalMin, daily: d.daily, weekly: d.weekly, weeklyTime: d.weeklyTime })}）`);
}

function toggleTask(t: TaskRow) {
  // 开启前把预计消耗说清楚（成本闸门 6），确认走 MemDialog（模块弹窗统一）
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
    // 先回读真实状态再弹提示：提示这一步出任何岔子都不该让开关停在旧视觉上（v1.25.2 前的 RangeError 就这么冻住了开关）
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

/** 在系统文件管理器里打开报告所在目录（memory_open_dir 接受相对仓库根的路径） */
async function openReportDir() {
  if (!reportPath.value) return;
  try {
    // memoryAutoReport 返回的是绝对路径；memoryOpenDir 走绝对路径直开
    await api.memoryOpenDir(reportPath.value);
  } catch (e) {
    ElMessage.error((e as Error).message || "打开失败");
  }
}

/** 报告导出结果改为弹窗显示（toast 3 秒就消失，用户找不到路径要再点一次） */
const reportOpen = ref(false);
const reportPath = ref("");

async function saveLimit(value: number) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    ElMessage.warning("请填一个不小于 0 的数字（0 = 不限）");
    return;
  }
  try {
    await mem.save({ "auto.dailyTokenLimit": Number(value) });
    // 状态里的日上限要一起回读，否则「今日消耗 x / y」里的 y 还显示旧预算
    await refresh();
    ElMessage.success("日预算已更新");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败（值超出允许范围）");
  }
}

/** 模板内联开关的统一保存：失败要提示且强制 refresh 把复选框视觉态拉回真实配置 */
async function saveKV(entries: Record<string, unknown>) {
  try {
    await mem.save(entries);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
    await refresh();
  }
}

/** 超预算时不用「一键取消限制」这种危险快捷方式，而是把光标送到预算输入框让你自己定 */
function focusLimit() {
  limitEl.value?.focus();
  limitEl.value?.select();
}

/* ===== 三「停」合一：运行中 / 暂停到明天 / 全部关闭 =====
   原来总开关与「暂停全部」是两个控件、概念上却是同一件事（停还是不停）。
   暂停到明天走后端 pausedUntil（到期自动恢复），不再需要用户记得回来手动恢复。 */
const autoMode = computed(() => (!status.value?.enabled ? "off" : status.value?.paused ? "paused" : "on"));
const AUTO_MODE_OPTIONS = [
  { value: "on", label: "运行中（按各任务节奏自动执行）" },
  { value: "paused", label: "暂停到明天 0 点（手动「立即执行」不受影响）" },
  { value: "off", label: "全部关闭（手动「立即执行」仍可用）" },
];
const modeBusy = ref(false);
async function setAutoMode(v: string | number) {
  const mode = String(v);
  if (mode === autoMode.value || modeBusy.value) return;
  modeBusy.value = true;
  try {
    if (mode === "off") {
      // 先清暂停态：否则下次开启会立刻处于「暂停到某时刻」的残留状态
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

/* ===== 预设套餐：只调整任务开关与日预算，不改动各任务的执行节奏 ===== */
type PresetId = "frugal" | "standard" | "busy";
const PRESETS: { id: PresetId; label: string; desc: string; tokens: number; on: string[] }[] = [
  { id: "frugal", label: "省钱", desc: "只跑零成本任务（归类、索引自检、清理），完全不调模型", tokens: 0, on: ["classify", "index-scan", "cleanup"] },
  { id: "standard", label: "标准", desc: "零成本 + 打标签 + 摘要 + 失效识别；日预算 20 万 token", tokens: 200000, on: ["classify", "index-scan", "cleanup", "tag", "summarize", "extract", "supersede"] },
  { id: "busy", label: "勤快", desc: "全部任务开启（含蒸馏、画像、全库查重）；日预算 50 万 token", tokens: 500000, on: ["classify", "index-scan", "cleanup", "tag", "summarize", "extract", "supersede", "distill", "profile", "consolidate"] },
];
/** 预设管辖的任务 id：名单外的任务（含后端将来新增的）一律不处理，避免被预设意外关闭 */
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
    else ElMessage.success(`已应用「${p.label}」套餐（任务节奏未改动）`);  } catch (e) {
    await refresh();
    ElMessage.error((e as Error).message || "应用套餐失败");
  } finally {
    presetBusy.value = false;
  }
}

/** 任务清单折叠：9 张卡默认收起（预设覆盖大多数场景，逐卡微调是高级需求） */
const tasksOpen = ref(false);
const taskSummary = computed(() => {
  const list = status.value?.tasks || [];
  return { total: list.length, on: list.filter((t) => t.enabled).length };
});

watch(
  () => status.value?.dailyTokenLimit,
  (v) => {
    if (typeof v === "number") limitInput.value = v;
  },
);

/** 每个任务实际做什么（卡片上大白话一行，避免「抽取结构化信息」这类术语看天书） */
const TASK_DESC: Record<string, string> = {
  extract: "给新记忆补一句摘要与重要度",
  summarize: "为会话/日记生成规整摘要",
  tag: "按内容补 2~5 个标签，优先复用已有标签",
  classify: "给没归项目的记忆找最像的项目（零成本）",
  supersede: "识别「新事实推翻旧事实」，只出建议",
  distill: "把每个项目的原始记忆蒸成知识/决策/术语表",
  consolidate: "全库查重：能合并的合并，拿不准的进队列",
  profile: "跨项目归纳你的人格/偏好/技术栈/工作习惯",
  "index-scan": "扫一遍有没有文件漏进索引、索引有没有坏",
  cleanup: "回收站到期文件彻底删除；开启清理开关后按类删除异常记忆（先入回收站）",
};

function fmtInterval(t: TaskRow) {
  if (t.weekly !== null && t.weekly !== undefined) return `每周${["日", "一", "二", "三", "四", "五", "六"][t.weekly] || "?"} ${t.weeklyTime || ""}`;
  if (t.daily) return `每天 ${t.daily}`;
  return `每 ${t.intervalMin || "?"} 分钟`;
}

onMounted(async () => {
  await refresh();
  // 自动化任务由 60s tick 触发：没有事件订阅时页面要等切页才刷新，任务跑完了界面还停在旧状态
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; phase?: string };
    if (p.event !== "memory") return;
    if (!active.value) return; // 页面 v-show 保活：隐藏时不轮询（切回时 watch(active) 会补一次）
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
    <div v-if="status?.pending?.review" class="mem-head" style="justify-content: flex-end; min-height: unset; margin-bottom: 8px">
      <div class="mem-head-actions">
        <!-- 只算待确认收件箱的 review 队列（supersede/classify/dedup 三类建议）。
             dedup pending 是 mem.dedup_status 的「待去重判」自动流转队列，与人工确认无关，
             计进来会出现「明明都确认完了还显示两万条」的假告警 -->
        <button class="btn-outline" @click="mem.gotoReview()">
          {{ status?.pending?.review }} 条待确认建议 →
        </button>
      </div>
    </div>

    <div v-if="running" class="mem-card">
      <div class="mem-row" style="justify-content: space-between; font-size: 12px; align-items: center; gap: 10px">
        <span>⟳ 正在执行：{{ running.name || taskNameOf(running.id) }}<template v-if="running.phase"> · {{ running.phase }}</template> · 开始于 {{ timeAgo(running.startedAt) }}</span>
        <button class="btn btn-ghost" @click="cancelRun">取消</button>
      </div>
      <div class="mem-row" style="margin-top: 8px; align-items: center; gap: 8px">
        <div class="mem-progress" style="flex: 1"><i :style="{ width: `${runPercent}%` }"></i></div>
        <span class="mem-chip accent">{{ runPercent }}%</span>
      </div>
      <!-- 排队显示跟在「正在执行」卡内：空闲但有排队（如手动入队后点了暂停）也单独给一张卡 -->
      <div v-if="queueRows.length" class="mem-row" style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--mem-line); flex-wrap: wrap; gap: 6px; align-items: center">
        <span class="mem-hint" style="flex: 0 0 auto">排队中（依次执行）：</span>
        <span v-for="(q, i) in queueRows" :key="q.id" class="mem-chip">{{ i + 1 }}. {{ q.name }}</span>
      </div>
    </div>
    <div v-else-if="queueRows.length" class="mem-card">
      <div class="mem-row" style="font-size: 12px; flex-wrap: wrap; gap: 6px; align-items: center">
        <span>⏳ 排队中（依次执行）：</span>
        <span v-for="(q, i) in queueRows" :key="q.id" class="mem-chip">{{ i + 1 }}. {{ q.name }}</span>
      </div>
    </div>

    <div v-if="status?.overBudget" class="mem-banner">
      ⚠️ 今日 token 已达上限 {{ formatInteger(status.dailyTokenLimit) }}，模型类任务已自动跳过（零成本任务照常）
      <span class="b-grow"></span>
      <button class="btn btn-ghost" @click="focusLimit">调整预算</button>
    </div>

    <!-- 总控 + 预算合成一张：开关、花销、待确认、日上限、超预算行为都是「一个地方管全局」。
         左列＝运行状态（今日消耗 / 待确认），右列＝闸门设置（日上限 / 超预算行为），
         两列各自成组，读起来是「现在怎么样」与「超了怎么办」两件事 -->
    <div class="mem-card">
      <div class="mem-card-title">
        总控
        <MemHelp text="三种「停」：按节奏自动跑 / 暂停到明天 0 点 / 全部关闭" />
        <span class="mem-hint">{{ autoMode === "paused" && status?.pausedUntil ? `暂停至 ${formatDateTime(status.pausedUntil)}` : autoMode === "paused" ? "已暂停" : autoMode === "off" ? "已关闭" : "运行中" }}</span>
      </div>
      <!-- 三「停」合一：开关与暂停本是同一件事（停不停），合成一个下拉 -->
      <div class="mem-row" style="gap: 14px; padding: 4px 0; border-bottom: 1px solid var(--mem-line); margin-bottom: 8px; align-items: center">
        <span style="font-size: 13px; flex: 0 0 auto">自动化状态</span>
        <MemSelect
          :model-value="autoMode"
          width="320px"
          :disabled="modeBusy"
          :options="AUTO_MODE_OPTIONS"
          @change="setAutoMode"
        />
      </div>
      <div class="mem-two-col" style="gap: 4px 14px">
        <!-- 左列：运行状态 -->
        <div class="mem-kv">
          <span class="k">今日消耗<MemHelp text="自动化任务调用模型花掉的 token（含输入+输出）。上限到顶后模型类任务自动跳过，第二天 0 点重置。" /></span>
          <span class="v">
            <template v-if="(status?.dailyTokenLimit || 0) > 0">
              {{ formatInteger(status?.todayTokens || 0) }} / {{ formatInteger(status?.dailyTokenLimit || 0) }} token
              （{{ status?.todayCalls || 0 }} 次调用）
              <span class="mem-chip" :class="(status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1) > 0.8 ? 'warn' : ''">
                {{ Math.round(((status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1)) * 100) }}%
              </span>
            </template>
            <template v-else>
              {{ formatInteger(status?.todayTokens || 0) }} token（{{ status?.todayCalls || 0 }} 次调用）
              <span class="mem-chip">不限额</span>
            </template>
          </span>
          <span class="k">待确认<MemHelp text="要你点头的失效/归类/去重建议。其余队列（待抽取/待归类/待去重判）是自动流转的，不需要你介入。" /></span>
          <span class="v">
            <button class="btn-outline" @click="mem.gotoReview()">
              {{ status?.pending.review || 0 }} 条待裁决 →
            </button>
          </span>
        </div>
        <!-- 右列：闸门设置 -->
        <div class="mem-kv">
          <span class="k">日 token 上限<MemHelp text="每天允许自动化花掉的 token 上限（0 = 不限）。到顶后只跳过会调模型的任务，第二天 0 点自动重置。" /></span>
          <span class="v">
            <input ref="limitEl" v-model.number="limitInput" type="number" min="0" class="f-input" style="width: 140px" @change="saveLimit(limitInput)" @keyup.enter="saveLimit(limitInput)" />
            <span class="mem-hint">改完自动保存 · 0 = 不限额</span>
          </span>
          <span class="k">超预算行为<MemHelp text="选「暂停」只停会花钱的任务、保留索引自检这类零成本任务；选「不限制」则超了也继续跑。" /></span>
          <span class="v">
            <MemSelect
              :model-value="mem.cfg('auto.overBudgetAction', 'pause')"
              width="260px"
              :options="[
                { value: 'pause', label: '暂停模型类任务（保留零成本任务）' },
                { value: 'ignore', label: '不限制，继续跑' },
              ]"
              @change="(v: string | number) => saveKV({ 'auto.overBudgetAction': v })"
            />
          </span>
        </div>
      </div>
    </div>

    <!-- 预设套餐：一键定好「跑哪些任务、花多少」，逐卡微调收进下方折叠 -->
    <div class="mem-card">
      <div class="mem-card-title">
        预设套餐
        <span class="mem-hint">一键设定任务开关与日预算；各任务的节奏不受影响</span>
        <MemHelp text="按使用强度选一档：省钱 / 标准 / 勤快，应用后仍可逐个调整" />
      </div>
      <div class="mem-row" style="gap: 10px; flex-wrap: wrap">
        <button
          v-for="p in PRESETS"
          :key="p.id"
          class="btn"
          :class="presetBusy ? '' : 'btn-outline'"
          :disabled="presetBusy"
          :title="p.desc"
          @click="applyPreset(p.id)"
        >
          {{ p.label }}
        </button>
        <span class="mem-hint" style="align-self: center">点选后确认即生效（会按套餐调整各任务开关；你手动改过的开关也会被调整）</span>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        任务清单（{{ taskSummary.total }} 项 · {{ taskSummary.on }} 项开启）
        <span class="mem-hint">逐卡可改开关与执行节奏；多数场景用上方套餐即可</span>
        <button class="btn-outline" @click="tasksOpen = !tasksOpen">{{ tasksOpen ? "收起" : "展开管理" }}</button>
      </div>
      <div v-if="tasksOpen" class="mem-grid mem-grid-3">
        <div v-for="t in status?.tasks || []" :key="t.id" class="mem-tile">
          <div class="mem-tile-head">
            <span class="t-name">{{ t.name }}</span>
            <span class="mem-row" style="gap: 6px">
              <button class="btn btn-ghost" style="padding: 0 8px; font-size: 12px" @click="openEdit(t)">编辑</button>
              <div class="switch" :class="{ on: t.enabled }" role="switch" :aria-checked="!!t.enabled" @click="toggleTask(t)"></div>
              <span class="mem-hint">{{ t.enabled ? "开" : "关" }}</span>
            </span>
          </div>
          <div class="t-row"><span>说明</span><span>{{ TASK_DESC[t.id] || "—" }}</span></div>
          <div class="t-row"><span>节奏</span><span>{{ fmtInterval(t) }}</span></div>
          <!-- 上次 / 下次合并一行两列：标签|值|标签|值 四列网格，值右对齐 -->
          <div class="t-dual">
            <span>上次</span><span>{{ t.lastAt ? timeAgo(t.lastAt) : "从未执行" }}</span>
            <span>下次</span><span>{{ t.enabled && t.nextAt ? timeUntil(t.nextAt) : "—" }}</span>
          </div>
          <div class="t-row">
            <span>统计<MemHelp :text="t.needsModel ? `调模型 · ${t.estimate}；失败会标红并可立即重跑。` : '不调模型、零成本。'" /></span>
            <span>
              {{ t.successRate === null ? "—" : t.successRate + "%" }}（{{ t.runs }} 次 · {{ formatInteger(t.tokens) }} token）
            </span>
          </div>
          <div class="mem-tile-foot">
            <button class="btn btn-ghost" @click="runTask(t.id)">立即执行</button>
            <span v-if="status?.queue?.includes(t.id)" class="mem-chip">已排队</span>
          </div>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        任务时间线（最近 50 次）
        <MemHelp text="每次执行的耗时、token 与结果；失败会标红并带原因，可立即重跑" />
        <span class="mem-inline-ctl">
          <button v-if="timeline.length > 10" class="btn btn-ghost" @click="timelineAll = !timelineAll">{{ timelineAll ? "只看最近 10 次" : `查看全部 ${timeline.length} 次` }}</button>
          <button class="btn-outline" @click="exportReport">导出报告</button>
        </span>
      </div>
      <!-- 定高滚动 + 表头粘顶：时间线会一直累积，列表自己滚，不把页面拉长 -->
      <div v-if="timeline.length" class="mem-table-wrap mem-table-scroll">
        <table class="mem-table">
          <thead><tr><th>时间</th><th>任务</th><th>结果</th><th>耗时</th><th>token</th><th>详情</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in timelineAll ? timeline : timeline.slice(0, 10)" :key="i">
              <td>{{ formatDateTime(e.at) }}</td>
              <td>{{ e.name || taskNameOf(e.task) }}</td>
              <td>{{ e.ok ? "✓" : "✗" }}</td>
              <td class="num">{{ (e.ms / 1000).toFixed(1) }}s</td>
              <td class="num">{{ formatInteger(e.tokens) }}</td>
              <td>
                {{ e.detail }}
                <!-- 未配置模型：时间线上直接给出去处，不必等用户自己找「设置」 -->
                <button v-if="e.errorCode === 'no_model'" class="btn-link" style="margin-left: 6px" @click="app.openSettings('models')">去配置模型 →</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="mem-empty">还没有执行记录（首轮 tick 会在启动约 90 秒后进行）</div>
    </div>

    <!-- 立即执行的进度弹窗：入队后跟随后端快照（排队中/执行中），跑完显示结果，长任务不会一闪而过 -->
    <MemProgressDialog
      v-model:open="runOpen"
      :title="`立即执行 · ${trackName}`"
      sub="手动跑一次任务（仍受单日 token 上限约束）；忙时可排队，不必等一个跑完"
      :running="runTracking"
      :phase="runPhase"
      :started-at="trackStartedAt"
      :result="runResult"
    />

    <!-- 开启任务的成本确认：耗 token 的操作先说清楚再开 -->
    <MemDialog :open="!!taskConfirm" title="开启自动化任务" sub="确认前先看预计消耗" width="520px" @update:open="(v: boolean) => { if (!v) taskConfirm = null; }">
      <p v-if="taskConfirm" style="margin: 0; line-height: 1.8">
        「{{ taskConfirm.name }}」预计消耗：{{ taskConfirm.estimate }}<br />
        当前日预算：{{ formatInteger(status?.dailyTokenLimit || 0) }} token，今日已用 {{ formatInteger(status?.todayTokens || 0) }}。
      </p>
      <template #foot>
        <button class="btn btn-cta" @click="confirmEnableTask">开启</button>
        <button class="btn btn-ghost" @click="taskConfirm = null">取消</button>
      </template>
    </MemDialog>

    <!-- 节奏编辑：三种模式二选一，保存时把不用的模式置空（后端按非空项生效） -->
    <MemDialog :open="editOpen" :title="`编辑节奏 · ${editTask?.name || ''}`" sub="改的是调度节奏，不影响任务本身" width="520px" @update:open="(v: boolean) => { if (!v) editOpen = false; }">
      <div v-if="editTask" style="display: grid; gap: 12px">
        <div class="mem-row" style="gap: 10px; align-items: center">
          <span class="mem-hint" style="flex: 0 0 auto; width: 64px">节奏类型</span>
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
        <div v-if="editKind === 'interval'" class="mem-row" style="gap: 10px; align-items: center">
          <span class="mem-hint" style="flex: 0 0 auto; width: 64px">每隔</span>
          <input v-model.number="editInterval" type="number" min="5" class="f-input" style="width: 100px" />
          <span class="mem-hint">分钟执行一次（最小 5）</span>
        </div>
        <div v-else-if="editKind === 'daily'" class="mem-row" style="gap: 10px; align-items: center">
          <span class="mem-hint" style="flex: 0 0 auto; width: 64px">每天</span>
          <input v-model="editDaily" type="time" class="f-input" style="width: 140px" />
          <span class="mem-hint">执行</span>
        </div>
        <div v-else class="mem-row" style="gap: 10px; align-items: center">
          <span class="mem-hint" style="flex: 0 0 auto; width: 64px">每周</span>
          <MemSelect :model-value="editWeekly" width="110px" :options="WEEKDAY_OPTIONS" @change="(v: string | number) => (editWeekly = Number(v))" />
          <input v-model="editWeeklyTime" type="time" class="f-input" style="width: 140px" />
        </div>
        <div class="mem-hint">改完即生效：「下次」时间会按新节奏重新推算；当天已跑过的按天/按周任务从下一周期开始。</div>
      </div>
      <template #foot>
        <button class="btn btn-ghost" style="margin-right: auto" @click="restoreDefaultRhythm">恢复默认时间</button>
        <button class="btn btn-cta" @click="saveEdit()">保存</button>
        <button class="btn btn-ghost" @click="editOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 预设套餐确认：会按套餐调整各任务开关（节奏不动），先讲清楚再应用 -->
    <MemDialog :open="!!presetTarget" :title="`应用「${presetTarget?.label || ''}」套餐`" sub="只调整任务开关与日预算，不改变各任务的执行节奏" width="520px" @update:open="(v: boolean) => { if (!v) presetConfirm = null; }">
      <div v-if="presetTarget" style="line-height: 1.8">
        <p style="margin: 0 0 8px">{{ presetTarget.desc }}</p>
        <p style="margin: 0 0 8px">将开启：{{ presetTarget.on.map((id) => taskNameOf(id)).join("、") || "（无）" }}；其余任务关闭。</p>
        <p style="margin: 0; color: var(--text-3)">你手动改过的任务开关也会被调整为套餐口径；执行节奏保持不变。</p>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="presetBusy" @click="doApplyPreset">{{ presetBusy ? "应用中…" : "确认应用" }}</button>
        <button class="btn btn-ghost" @click="presetConfirm = null">取消</button>
      </template>
    </MemDialog>

    <!-- 报告导出结果（路径很长、需要复制/打开；toast 3 秒就消失找不到） -->
    <MemDialog v-model:open="reportOpen" title="报告已生成" sub="完整 Markdown 报告路径如下" width="600px">
      <div class="mem-section">
        <div class="s-title">报告路径</div>
        <div class="mem-mono" style="word-break: break-all; padding: 8px 10px; background: var(--mem-soft); border-radius: var(--r-sm)">
          {{ reportPath }}
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="openReportDir">打开所在目录</button>
        <button class="btn btn-ghost" @click="reportOpen = false">关闭</button>
      </template>
    </MemDialog>
  </div>
</template>
