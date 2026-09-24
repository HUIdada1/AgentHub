<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 自动化任务：总控 + 9 张任务卡 + 时间线 + 成本分析 + 隐私控制 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo, timeUntil, formatDateTime } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

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
type CostShape = { today: number; todayCalls: number; month: number; limit: number; byTask: { task: string; tokens: number }[]; estimates: Record<string, string> };

const status = ref<StatusShape | null>(null);
const timeline = ref<{ task: string; at: number; ok: boolean; ms: number; tokens: number; detail: string; processed?: number; updated?: number; report?: string }[]>([]);
const cost = ref<CostShape | null>(null);
const busy = ref("");

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
  try {
    cost.value = (await api.memoryAutoCost()) as unknown as CostShape;
  } catch {
    /* 忽略 */
  }
}

/** 模型与网关是配置页的子板块：留跳转提示后进配置页，落点即该子板块 */
function openModels() {
  mem.configTabHint = "__models__";
  app.openModuleConfig();
}

async function runTask(id: string) {
  busy.value = id;
  try {
    const r = await api.memoryAutoTaskRun(id);
    if (r.ok) ElMessage.success(r.detail || "执行完成");
    else ElMessage.warning(r.message || "任务失败");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "执行失败");
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
    ElMessage.success(`${t.name} 已${t.enabled ? "关闭" : "开启"}`);
    await refresh();
  } catch (e) {
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
    ElMessage.success(resume ? "已恢复" : "已暂停");
    await refresh();
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

const limitInput = ref(0);
watch(
  () => status.value?.dailyTokenLimit,
  (v) => {
    if (typeof v === "number") limitInput.value = v;
  },
);

/** 每个任务实际做什么（卡片上大白话一行，避免「抽取结构化信息」这类术语看天书） */
const TASK_DESC: Record<string, string> = {
  extract: "给新记忆补一句摘要与重要度（列表与检索都靠它省 token）",
  summarize: "为会话/日记生成规整摘要（与抽取同批处理，默认关）",
  tag: "按内容补 2~5 个标签，优先复用已有标签",
  classify: "给没归项目的记忆找最像的项目（纯本地比对，零成本）",
  supersede: "识别「新事实推翻旧事实」，只出建议、你来点头",
  distill: "把每个项目的原始记忆蒸成知识/决策/术语表",
  consolidate: "全库查重：能自动合并的合并，拿不准的进人工队列",
  profile: "跨项目归纳你的人格/偏好/技术栈/工作习惯（带证据链）",
  "index-scan": "定时扫一遍有没有文件漏进索引、索引有没有坏",
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
        <MemHelp text="每个任务各管一件事。一次只跑一个任务（避免同时抢模型额度），增量优先（只处理上次之后的新内容），费用与成败在下方可见。" />
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small" @click="pauseAll(status?.paused)">{{ status?.paused ? "恢复自动化" : "暂停全部" }}</button>
        <button class="el-button el-button--small" @click="api.memoryAutoCancel().then(() => ElMessage.success('已请求取消'))">取消排队任务</button>
        <button class="el-button el-button--small" @click="exportReport">导出自动化报告</button>
        <button class="el-button el-button--small" @click="refresh">刷新</button>
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
      <button class="el-button el-button--small" @click="saveLimit(0)">取消限制</button>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        总控
        <span class="mem-hint">{{ status?.paused ? "已暂停" : status?.enabled ? "运行中" : "已关闭" }}</span>
        <MemHelp text="总开关停掉全部自动化；「暂停全部」只是临时停（手动执行不受影响）。日 token 上限到顶后只停会调模型的任务，索引自检这类零成本任务照跑。" />
      </div>
      <div class="mem-kv">
        <span class="k">总开关</span>
        <span class="v">
          <el-switch
            :model-value="!!status?.enabled"
            @change="saveKV({ 'auto.enabled': $event as boolean })"
          />
          <span class="mem-hint">{{ status?.enabled ? "已启用" : "已关闭" }}</span>
        </span>
        <span class="k">今日消耗<MemHelp text="自动化任务调用模型花掉的 token（含输入+输出）。上限到顶后模型类任务自动跳过，第二天 0 点重置。" /></span>
        <span class="v">
          {{ formatInteger(status?.todayTokens || 0) }} / {{ formatInteger(status?.dailyTokenLimit || 0) }} token
          （{{ status?.todayCalls || 0 }} 次调用）
          <span class="mem-chip" :class="(status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1) > 0.8 ? 'warn' : ''">
            {{ Math.round(((status?.todayTokens || 0) / Math.max(1, status?.dailyTokenLimit || 1)) * 100) }}%
          </span>
        </span>
        <span class="k">待处理<MemHelp text="待抽取＝还没补过摘要/重要度的记忆；待归类＝没归到项目的；待确认＝要你点头的失效/归类/去重建议；待去重判＝排队等 AI 判定是否重复的。" /></span>
        <span class="v">
          待抽取 {{ status?.pending.unprocessed || 0 }} · 待归类 {{ status?.pending.classified || 0 }} ·
          待确认 {{ status?.pending.review || 0 }} · 待去重判 {{ status?.pending.dedup || 0 }}
        </span>
        <span class="k">日 token 上限</span>
        <span class="v">
          <input v-model.number="limitInput" type="number" min="0" class="el-input__inner" style="width: 140px" />
          <button class="mem-chip click" @click="saveLimit(limitInput)">保存</button>
          <span class="mem-hint">0 = 不限额</span>
        </span>
      </div>
    </div>

    <div class="mem-grid mem-grid-3">
      <div v-for="t in status?.tasks || []" :key="t.id" class="mem-tile">
        <div class="mem-tile-head">
          <span class="t-name">{{ t.name }}</span>
          <span class="mem-row" style="gap: 6px">
            <el-switch :model-value="t.enabled" @change="toggleTask(t)" />
            <span class="mem-hint">{{ t.enabled ? "开" : "关" }}</span>
          </span>
        </div>
        <div class="t-row"><span>节奏</span><span>{{ fmtInterval(t) }}</span></div>
        <div class="t-row"><span>做什么</span><span>{{ TASK_DESC[t.id] || "—" }}</span></div>
        <div class="t-row"><span>消耗</span><span>{{ t.needsModel ? `调模型 · ${t.estimate}` : "不调模型 · 零成本" }}</span></div>
        <div class="t-row"><span>结果</span><span>{{ t.needsModel ? "改动记忆文件（摘要/标签/重要度/失效标记）" : "只读或只修索引" }}</span></div>
        <div class="t-row"><span>上次</span><span>{{ t.lastAt ? timeAgo(t.lastAt) : "从未执行" }}</span></div>
        <div class="t-row"><span>下次</span><span>{{ t.enabled && t.nextAt ? timeUntil(t.nextAt) : "—" }}</span></div>
        <div class="t-row"><span>成功率</span><span>{{ t.successRate === null ? "—" : t.successRate + "%" }}（{{ t.runs }} 次）</span></div>
        <div class="t-row"><span>累计</span><span>{{ formatInteger(t.tokens) }} token</span></div>
        <div class="mem-tile-foot">
          <button class="el-button el-button--small" :disabled="busy === t.id" @click="runTask(t.id)">{{ busy === t.id ? "执行中…" : "立即执行" }}</button>
          <MemHelp text="手动跑一次当前任务（不受开关与节奏限制，但仍受单日 token 上限约束）。跑的是增量：只处理还没处理过的内容。" />
          <button class="el-button el-button--small" @click="openModels">模型配置</button>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        任务时间线（最近 50 次）
        <MemHelp text="每次执行的开始/结束、耗时、消耗 token 与结果详情。失败的会标红，详情里带原因（例如「没有可用模型」），修好配置后可点任务卡的「立即执行」重跑。" />
      </div>
      <!-- 定高滚动 + 表头粘顶：时间线会一直累积，列表自己滚，不把页面拉长 -->
      <div v-if="timeline.length" class="mem-table-wrap mem-table-scroll">
        <table class="mem-table">
        <thead><tr><th>时间</th><th>任务</th><th>结果</th><th>耗时</th><th>token</th><th>详情</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in timeline" :key="i">
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

    <div class="mem-grid mem-grid-2">
      <div class="mem-card">
        <div class="mem-card-title">
          成本分析
          <span class="mem-hint">近 30 天</span>
        </div>
        <div class="mem-kv">
          <span class="k">今日</span><span class="v">{{ formatInteger(cost?.today || 0) }} token（{{ cost?.todayCalls || 0 }} 次）</span>
          <span class="k">近 30 天</span><span class="v">{{ formatInteger(cost?.month || 0) }} token</span>
          <span class="k">预算</span><span class="v">{{ formatInteger(cost?.limit || 0) }} / 天</span>
        </div>
        <div class="mem-col" style="margin-top: 10px; gap: 6px">
          <div v-for="b in (cost?.byTask || []).slice(0, 8)" :key="b.task" class="mem-funnel-row">
            <span class="mem-mono">{{ b.task }}</span>
            <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, (b.tokens / Math.max(1, cost?.month || 1)) * 100)}%` }"></i></span>
            <span style="text-align: right">{{ formatInteger(b.tokens) }}</span>
          </div>
          <div v-if="!(cost?.byTask || []).length" class="mem-empty">还没有调用记录</div>
        </div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          模型与路由
          <span class="mem-hint">完整操作台在「模型与网关」页</span>
        </div>
        <div class="mem-kv">
          <span class="k">来源优先级</span>
          <span class="v">{{ (mem.cfg("models.sourceOrder", []) as string[]).join(" → ") || "—" }}</span>
          <span class="k">任务强度</span>
          <span class="v">
            <template v-for="(v, k) in (mem.cfg('models.taskEffort', {}) as Record<string, string>)" :key="k">
              <span class="mem-chip">{{ k }}: {{ v }}</span>
            </template>
          </span>
        </div>
        <div class="mem-row" style="margin-top: 10px">
          <button class="el-button el-button--small" @click="openModels">打开「模型与网关」（配置页）</button>
          <button class="el-button el-button--small" @click="app.activePage = 'index'">检索与索引</button>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">隐私控制</div>
      <div class="mem-kv">
        <span class="k">隐私模式<MemHelp text="打开后拒绝一切采集写入（Agent 的内存写入会被拒并收到提示），已有的记忆不受影响。" /></span>
        <span class="v">
          <el-switch
            :model-value="!!mem.cfg('privacy.pause', false)"
            @change="saveKV({ 'privacy.pause': $event as boolean })"
          />
          <span class="mem-hint">{{ mem.cfg("privacy.pause", false) ? "已开启（拒绝一切采集写入）" : "关闭" }}</span>
        </span>
        <span class="k">写入脱敏<MemHelp text="写入前扫一遍密钥、密码、手机号、身份证这类内容，命中就替换成占位符（保留「此处有过敏感信息」的痕迹）。同步到 WebDAV 前也会受益。" /></span>
        <span class="v">
          <el-switch
            :model-value="mem.cfg('privacy.redact', true) !== false"
            @change="saveKV({ 'privacy.redact': $event as boolean })"
          />
          <span class="mem-hint">命中密钥 / 密码 / 手机号等替换为占位符（保留位置说明）</span>
        </span>
        <span class="k">超预算行为<MemHelp text="选「暂停」只停会花钱的任务、保留索引自检这类零成本任务；选「不限制」则超了也继续跑。" /></span>
        <span class="v">
          <select
            class="el-input__inner"
            style="max-width: 240px"
            :value="mem.cfg('auto.overBudgetAction', 'pause')"
            @change="saveKV({ 'auto.overBudgetAction': ($event.target as HTMLSelectElement).value })"
          >
            <option value="pause">暂停模型类任务（保留零成本任务）</option>
            <option value="ignore">不限制，继续跑</option>
          </select>
        </span>
      </div>
    </div>
  </div>
</template>
