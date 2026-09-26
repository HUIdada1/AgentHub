<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 自动化任务：总控（含预算）+ 9 张任务卡（状态为主）+ 时间线
     成本明细在仪表盘「AI 花费」；模型配置在配置页；隐私开关在配置页「隐私」分组 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo, timeUntil, formatDateTime } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemSelect from "../../components/memory/MemSelect.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "auto");

type TaskRow = {
  id: string; name: string; needsModel: boolean; estimate: string;
  enabled: boolean; intervalMin: number | null; daily: string | null; weekly: number | null; weeklyTime: string | null;
  batchSize: number | null; thresholdCount: number | null;
  lastAt: number; nextAt: number; successRate: number | null; runs: number; tokens: number;
};
type StatusShape = {
  enabled: boolean; paused: boolean; pausedUntil: number;
  running: { id: string; startedAt: number; phase: string } | null;
  queue: string[]; todayTokens: number; todayCalls: number; dailyTokenLimit: number; overBudget: boolean;
  pending: { unprocessed: number; classified: number; review: number; dedup: number };
  tasks: TaskRow[];
};

const status = ref<StatusShape | null>(null);
const timeline = ref<{ task: string; at: number; ok: boolean; ms: number; tokens: number; detail: string; processed?: number; updated?: number; report?: string }[]>([]);
const timelineAll = ref(false);
const busy = ref("");
const limitInput = ref(0);
const limitEl = ref<HTMLInputElement | null>(null);

async function refresh() {
  await mem.loadAll();
  try {
    status.value = (await api.memoryAutoStatus()) as unknown as StatusShape;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取自动化状态失败");
  }
  try {
    const t = await api.memoryAutoTimeline(50);
    timeline.value = t.entries as unknown as typeof timeline.value;
  } catch {
    /* 忽略 */
  }
}

/** 立即执行的进度弹窗：任务由模型处理，说不出"还剩几条"，所以走阶段 + 动效条 + 已用时长，
    跑完把结果显示在同一个弹窗里（不再是转瞬即逝的 toast —— 长任务容易错过） */
const runOpen = ref(false);
const runTaskId = ref("");
const runStartedAt = ref(0);
const runPhase = ref("");
const runResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);
const runTaskName = computed(() => status.value?.tasks.find((t) => t.id === runTaskId.value)?.name || runTaskId.value);

async function runTask(id: string) {
  busy.value = id;
  runTaskId.value = id;
  runStartedAt.value = Date.now();
  runPhase.value = `执行「${TASK_DESC[id] || id}」`;
  runResult.value = null;
  runOpen.value = true;
  try {
    const r = await api.memoryAutoTaskRun(id);
    runResult.value = r.ok
      ? { ok: true, message: r.detail || "执行完成", extra: [r.tokens ? `消耗 ${formatInteger(r.tokens)} token` : ""].filter(Boolean) }
      : { ok: false, message: r.message || "任务失败" };
    await refresh();
  } catch (e) {
    runResult.value = { ok: false, message: (e as Error).message || "执行失败" };
  } finally {
    busy.value = "";
  }
}

async function toggleTask(t: TaskRow) {
  if (!t.enabled) {
    // 开启前把预计消耗说清楚（成本闸门 6）
    try {
      await ElMessageBox.confirm(
        `「${t.name}」预计消耗：${t.estimate}\n当前日预算：${formatInteger(status.value?.dailyTokenLimit || 0)} token，今日已用 ${formatInteger(status.value?.todayTokens || 0)}。\n确认开启？`,
        "开启自动化任务",
        { type: "warning", confirmButtonText: "开启" },
      );
    } catch {
      return;
    }
  }
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

async function pauseAll(resume = false) {
  try {
    if (!resume) await ElMessageBox.confirm("暂停后所有自动化任务停止（手动操作不受影响）", "暂停自动化", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryAutoPause({ resume });
    await refresh();
    ElMessage.success(resume ? "已恢复" : "已暂停");
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function exportReport() {
  try {
    const r = await api.memoryAutoReport();
    ElMessage.success(`报告已生成：${r.file}`);
  } catch (e) {
    ElMessage.error((e as Error).message || "导出失败");
  }
}

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
};

function fmtInterval(t: TaskRow) {
  if (t.weekly !== null && t.weekly !== undefined) return `每周${["日", "一", "二", "三", "四", "五", "六"][t.weekly] || "?"} ${t.weeklyTime || ""}`;
  if (t.daily) return `每天 ${t.daily}`;
  return `每 ${t.intervalMin || "?"} 分钟`;
}

onMounted(refresh);
watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        9 个任务独立开关与节奏；串行执行、增量优先、成本可见、可暂停可取消
        <MemHelp text="每个任务各管一件事。一次只跑一个任务（避免同时抢模型额度），增量优先（只处理上次之后的新内容），费用与成败在下方可见。成本明细见仪表盘「AI 花费」。" />
      </p>
      <div class="mem-head-actions">
        <button class="btn btn-ghost" @click="pauseAll(status?.paused)">{{ status?.paused ? "恢复自动化" : "暂停全部" }}</button>
      </div>
    </div>

    <div v-if="status?.running" class="mem-card">
      <div class="mem-row" style="justify-content: space-between; font-size: 12px">
        <span>⟳ 正在执行：{{ status.running.id }} · {{ status.running.phase }} · 开始于 {{ timeAgo(status.running.startedAt) }}</span>
        <button class="mem-chip click" @click="api.memoryAutoCancel()">取消</button>
      </div>
      <div class="mem-progress" style="margin-top: 8px"><i style="width: 40%"></i></div>
    </div>

    <div v-if="status?.overBudget" class="mem-banner">
      ⚠️ 今日 token 已达上限 {{ formatInteger(status.dailyTokenLimit) }}，模型类任务已自动跳过（零成本任务照常）
      <span class="b-grow"></span>
      <button class="btn btn-ghost" @click="focusLimit">调整预算</button>
    </div>

    <!-- 总控 + 预算合成一张：开关、花销、待确认、日上限、超预算行为都是「一个地方管全局」。
         左列＝运行状态（开关 / 今日消耗），右列＝闸门设置（待确认 / 日上限 / 超预算行为），
         两列各自成组，读起来是「现在怎么样」与「超了怎么办」两件事 -->
    <div class="mem-card">
      <div class="mem-card-title">
        总控
        <MemHelp text="总开关停掉全部自动化；「暂停全部」只是临时停（手动执行不受影响）。日 token 上限到顶后只停会调模型的任务，索引自检这类零成本任务照跑。" />
        <span class="mem-hint">{{ status?.paused ? "已暂停" : status?.enabled ? "运行中" : "已关闭" }}</span>
      </div>
      <div class="mem-two-col">
        <!-- 左列：运行状态 -->
        <div class="mem-kv">
          <span class="k">总开关<MemHelp text="关掉后所有自动化任务停止调度（手动点「立即执行」仍可用）；这是唯一的总闸。" /></span>
          <span class="v">
            <div class="switch" :class="{ on: !!status?.enabled }" role="switch" :aria-checked="!!status?.enabled" @click="saveKV({ 'auto.enabled': !status?.enabled })"></div>
          </span>
          <span class="k">今日消耗<MemHelp text="自动化任务调用模型花掉的 token（含输入+输出）。上限到顶后模型类任务自动跳过，第二天 0 点重置。" /></span>
          <span class="v">
            {{ formatInteger(status?.todayTokens || 0) }} / {{ formatInteger(status?.dailyTokenLimit || 0) }} token
            （{{ status?.todayCalls || 0 }} 次调用）
            <span class="mem-chip" :class="(status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1) > 0.8 ? 'warn' : ''">
              {{ Math.round(((status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1)) * 100) }}%
            </span>
          </span>
        </div>
        <!-- 右列：闸门设置 -->
        <div class="mem-kv">
          <span class="k">待确认<MemHelp text="要你点头的失效/归类/去重建议。其余队列（待抽取/待归类/待去重判）是自动流转的，不需要你介入。" /></span>
          <span class="v">
            <button class="mem-chip click" :class="status?.pending.review ? 'warn' : ''" @click="mem.gotoReview()">
              {{ status?.pending.review || 0 }} 条待裁决 →
            </button>
          </span>
          <span class="k">日 token 上限<MemHelp text="每天允许自动化花掉的 token 上限（0 = 不限）。到顶后只跳过会调模型的任务，第二天 0 点自动重置。" /></span>
          <span class="v">
            <input ref="limitEl" v-model.number="limitInput" type="number" min="0" class="f-input" style="width: 140px" />
            <button class="mem-chip click" @click="saveLimit(limitInput)">保存</button>
            <span class="mem-hint">0 = 不限额</span>
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

    <div class="mem-grid mem-grid-3">
      <div v-for="t in status?.tasks || []" :key="t.id" class="mem-tile">
        <div class="mem-tile-head">
          <span class="t-name">{{ t.name }}</span>
          <span class="mem-row" style="gap: 6px">
            <div class="switch" :class="{ on: t.enabled }" role="switch" :aria-checked="!!t.enabled" @click="toggleTask(t)"></div>
            <span class="mem-hint">{{ t.enabled ? "开" : "关" }}</span>
          </span>
        </div>
        <div class="t-row"><span>做什么</span><span>{{ TASK_DESC[t.id] || "—" }}</span></div>
        <div class="t-row"><span>节奏</span><span>{{ fmtInterval(t) }}</span></div>
        <div class="t-row"><span>上次</span><span>{{ t.lastAt ? timeAgo(t.lastAt) : "从未执行" }}</span></div>
        <div class="t-row"><span>下次</span><span>{{ t.enabled && t.nextAt ? timeUntil(t.nextAt) : "—" }}</span></div>
        <div class="t-row">
          <span>健康<MemHelp :text="t.needsModel ? `调模型 · ${t.estimate}；失败会标红并可立即重跑。` : '不调模型、零成本。'" /></span>
          <span>
            {{ t.successRate === null ? "—" : t.successRate + "%" }}（{{ t.runs }} 次 · {{ formatInteger(t.tokens) }} token）
          </span>
        </div>
        <div class="mem-tile-foot">
          <button class="btn btn-ghost" :disabled="busy === t.id" @click="runTask(t.id)">{{ busy === t.id ? "执行中…" : "立即执行" }}</button>
          <MemHelp text="手动跑一次当前任务（不受开关与节奏限制，但仍受单日 token 上限约束）。跑的是增量：只处理还没处理过的内容。执行过程与结果会在弹窗里显示。" />
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        任务时间线（最近 50 次）
        <MemHelp text="每次执行的开始/结束、耗时、消耗 token 与结果详情。失败的会标红，详情里带原因（例如「没有可用模型」），修好配置后可点任务卡的「立即执行」重跑。" />
        <span class="mem-inline-ctl">
          <button v-if="timeline.length > 10" class="mem-chip click" @click="timelineAll = !timelineAll">{{ timelineAll ? "只看最近 10 次" : `查看全部 ${timeline.length} 次` }}</button>
          <button class="mem-chip click" @click="exportReport">导出报告</button>
        </span>
      </div>
      <!-- 定高滚动 + 表头粘顶：时间线会一直累积，列表自己滚，不把页面拉长 -->
      <div v-if="timeline.length" class="mem-table-wrap mem-table-scroll">
        <table class="mem-table">
          <thead><tr><th>时间</th><th>任务</th><th>结果</th><th>耗时</th><th>token</th><th>详情</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in timelineAll ? timeline : timeline.slice(0, 10)" :key="i">
              <td>{{ formatDateTime(e.at) }}</td>
              <td class="mem-mono">{{ e.task }}</td>
              <td>{{ e.ok ? "✓" : "✗" }}</td>
              <td class="num">{{ (e.ms / 1000).toFixed(1) }}s</td>
              <td class="num">{{ formatInteger(e.tokens) }}</td>
              <td>{{ e.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="mem-empty">还没有执行记录（首轮 tick 会在启动约 90 秒后进行）</div>
    </div>

    <!-- 立即执行的进度弹窗：过程与结果都在这里，长任务不会一闪而过 -->
    <MemProgressDialog
      v-model:open="runOpen"
      :title="`立即执行 · ${runTaskName}`"
      sub="手动跑一次任务（仍受单日 token 上限约束）"
      :running="!!busy"
      :phase="runPhase"
      :started-at="runStartedAt"
      :result="runResult"
    />
  </div>
</template>
