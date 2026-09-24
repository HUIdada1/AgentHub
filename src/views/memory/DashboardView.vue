<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 仪表盘：4 张 KPI + 增长趋势 + Agent 连接状态 + 实时记忆流 + 系统健康（一行结论）+ AI 花费
     重动作（同步 / 重建索引 / 生成画像）不常驻在这里——各自页面有入口，索引异常时才出现「一键修复」 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryAgentCard, MemoryRow } from "../../types";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import EmptyState from "../../components/sync/EmptyState.vue";
import MemoryDetailDrawer from "../../components/memory/MemoryDetailDrawer.vue";
import MemoryTrendChart from "../../components/memory/MemoryTrendChart.vue";
import LlmUsagePanel from "../../components/memory/LlmUsagePanel.vue";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();

const active = computed(() => app.activeModule === "memory" && app.activePage === "dashboard");

const trendRaw = ref<{ day: string; count: number }[]>([]);
const trendRange = ref(30);
const recent = ref<MemoryRow[]>([]);
const agents = ref<MemoryAgentCard[]>([]);
/** 健康三态：null=尚未诊断（不显示异常），诊断失败回到 null 而不是沿用旧结论 */
const healthy = ref<{ consistent: boolean; broken: number; orphan: number; unindexed: number } | null>(null);
const healthOpen = ref(false);
const lastSyncAt = ref(0);
const busy = ref("");
const drawerId = ref("");
const drawerOpen = ref(false);

const healthyOk = computed(
  () => !!healthy.value && healthy.value.consistent && !healthy.value.broken && !healthy.value.orphan && !healthy.value.unindexed,
);

function applyDiagnose(dg: { consistent: boolean; broken: number; orphan: number; unindexed: number }) {
  healthy.value = { consistent: !!dg.consistent, broken: dg.broken || 0, orphan: dg.orphan || 0, unindexed: dg.unindexed || 0 };
}

/** KPI 只留四张：记了多少 / 谁在用 / 今天记了没 / 有没有要点头的事。
    项目数并进「记忆总数」副行；索引一致率不是用户的决定项 —— 异常时上面出提示条 */
const kpi = computed(() => {
  const s = mem.stats;
  return [
    {
      label: "记忆总数",
      value: s ? formatInteger(s.total) : "-",
      foot: s ? `L2 ${s.l2} 条 · ${s.projects} 个项目` : "",
      page: "browse",
      help: "库里全部记忆条数（含每日流水、会话摘要、手写笔记与 AI 蒸馏出的深层记忆）。点开看列表。",
    },
    {
      label: "已连通 Agent",
      value: mem.beats.length ? `${mem.verifiedAgents}/${mem.beats.length}` : `0/${agents.value.filter((a) => a.injected).length}`,
      foot: "三级校验为真实调用",
      page: "agents",
      help: "分母是已注入 MCP 的 Agent 数，分子是「真的调用过记忆工具」的数量。只配置了但从未调用不算连通——避免假绿灯。",
    },
    {
      label: "今日新增",
      value: s ? String(s.today) : "-",
      foot: s ? `昨日 ${s.yesterday}` : "",
      page: "browse",
      help: "今天 0 点以后写入的记忆条数（对比昨日同口径）。",
    },
    {
      label: "待确认",
      value: s ? String(s.pending) : "-",
      foot: "事实失效 / 归类 / 去重",
      warn: !!s && s.pending > 0,
      page: "review",
      help: "需要你点头的事：AI 判定的「事实失效」建议、名称模糊的项目归类建议、去重队列里低置信的重复判定。AI 只建议，不自动改。",
    },
  ];
});

/** 区间窗口内的逐日序列：从（今天 − 区间 + 1）到今天连续补齐、库里没有记录的日子补 0
    （与「用量趋势」的 completeData 同口径，最右侧严格是今天、曲线均匀）；
    区间与数据在 loadTrend 里一起落地，所以这里的窗口长度与 trendRaw 覆盖的区间恒等 */
const trendPoints = computed(() => {
  const counts = new Map(trendRaw.value.map((d) => [d.day, d.count]));
  const list: { day: string; count: number }[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = trendRange.value - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    list.push({ day, count: counts.get(day) || 0 });
  }
  return list;
});

/** 取某区间的逐日新增；取到才切区间——失败就停在原区间，免得出现「标签写一年、图里只有 30 天」 */
async function loadTrend(days: number) {
  try {
    const hm = await api.memoryHeatmap(days);
    trendRaw.value = hm.days;
    trendRange.value = days;
  } catch {
    /* 保留旧值 */
  }
}

async function refresh() {
  await mem.loadAll();
  await loadTrend(trendRange.value);
  try {
    const r = await api.memoryRecent({ days: 7, limit: 6 });
    recent.value = r.rows;
  } catch {
    /* 保留旧值 */
  }
  try {
    const list = await api.memoryAgentsList();
    agents.value = list.agents;
  } catch {
    /* 保留旧值 */
  }
  try {
    const d = await api.memoryIndexDiagnose();
    applyDiagnose({
      consistent: !d.diagnose.fts.rebuilt,
      broken: d.graph.broken,
      orphan: d.diagnose.orphanRows.length,
      unindexed: d.diagnose.unindexed.length,
    });
  } catch {
    healthy.value = null;
  }
  try {
    const st = await api.memorySyncStatus();
    lastSyncAt.value = st.lastSyncAt || 0;
  } catch {
    /* 保留旧值 */
  }
}

/** 索引异常时的「一键修复」：按目录重算后必须复核诊断，收敛才报成功，否则报真实剩余差异 */
async function repairIndex() {
  busy.value = "repair";
  try {
    const r = await api.memoryIndexBuild();
    const swept = r.pruned ? `、清掉 ${r.pruned} 条失效索引行` : "";
    try {
      const d = await api.memoryIndexDiagnose();
      const orphan = d.diagnose.orphanRows.length;
      const unindexed = d.diagnose.unindexed.length;
      const broken = d.graph.broken;
      applyDiagnose({ consistent: !d.diagnose.fts.rebuilt, broken, orphan, unindexed });
      if (orphan || unindexed || broken) {
        ElMessage.warning(`已重算 ${r.files} 个文件${swept}，但仍有差异：孤儿行 ${orphan} · 未索引 ${unindexed} · 断链 ${broken}`);
      } else {
        ElMessage.success(`已修复：重算 ${r.files} 个文件${swept}，索引已收敛`);
      }
    } catch {
      ElMessage.warning(`已重算 ${r.files} 个文件${swept}，但复核诊断失败，请稍后手动刷新确认`);
    }
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "修复失败");
  } finally {
    busy.value = "";
  }
}

function openDrawer(id: string) {
  drawerId.value = id;
  drawerOpen.value = true;
}

function goto(page: string) {
  if (page === "review") mem.gotoReview();
  else app.activePage = page;
}

/** 模型与网关现为配置页的子板块：先留跳转提示（配置页消费后清空），再进配置页 */
function openModels() {
  mem.configTabHint = "__models__";
  app.openModuleConfig();
}

let offEvent: (() => void) | undefined;
// 只对会改变卡片内容的事件全量刷新：watcher 每改一个文件就发 index 事件，
// 不挡的话批量写入/导入时仪表盘每次连发 5 个 IPC（事件风暴）。
// index 完成事件（running:false，带诊断快照）单独处理：只更新健康结论，触发不了全量刷新风暴
const REFRESH_TYPES = new Set(["memory-new", "deleted", "supersede", "config-changed", "bridge", "conflict", "sync", "root-changed"]);
onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; running?: boolean; diagnose?: { consistent: boolean; broken: number; orphan: number; unindexed: number } };
    if (p.event !== "memory") return;
    if (REFRESH_TYPES.has(p.type || "")) void refresh();
    else if (p.type === "index" && p.running === false && p.diagnose) applyDiagnose(p.diagnose);
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
});

watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope" :class="{ 'is-active': active }">
    <div class="mem-head">
      <p class="mem-sub">
        仓库目录：<span class="mem-mono" :title="mem.root">{{ mem.root || "—" }}</span>
        <span :class="mem.bridge.running ? 'mem-chip accent' : 'mem-chip warn'">{{ mem.bridge.running ? `本地桥运行中 :${mem.bridge.port}` : "本地桥未运行" }}</span>
        <span class="mem-hint">上次同步 {{ lastSyncAt ? timeAgo(lastSyncAt) : "尚未同步" }}</span>
      </p>
      <div class="mem-head-actions">
        <button class="btn btn-ghost" @click="api.memoryOpenDir()">打开仓库目录</button>
      </div>
    </div>

    <!-- 索引异常才出现的提示条（正常时完全不占位置）；修复 = 按目录重算，不动记忆文件 -->
    <div v-if="healthy && !healthyOk" class="mem-banner">
      ⚠️ 索引与记忆文件不一致（孤儿行 {{ healthy.orphan }} · 未索引 {{ healthy.unindexed }} · 断链 {{ healthy.broken }}）
      <span class="b-grow"></span>
      <button class="btn btn-ghost" :disabled="busy === 'repair'" @click="repairIndex">{{ busy === "repair" ? "修复中…" : "一键修复" }}</button>
      <button class="mem-chip click" @click="app.activePage = 'index'">诊断详情</button>
    </div>

    <div v-if="mem.indexEvent?.running" class="mem-card">
      <div class="mem-row" style="justify-content: space-between; font-size: 12px">
        <span>{{ mem.indexEvent.detail || "正在处理索引…" }}</span>
        <span>{{ mem.indexEvent.done }}/{{ mem.indexEvent.total || "?" }}</span>
      </div>
      <div class="mem-progress" style="margin-top: 8px">
        <i :style="{ width: `${mem.indexEvent.total ? Math.round((100 * mem.indexEvent.done) / mem.indexEvent.total) : 8}%` }"></i>
      </div>
    </div>

    <div class="mem-grid mem-grid-kpi">
      <div v-for="k in kpi" :key="k.label" class="mem-kpi" :class="{ 'is-warn': k.warn }" @click="goto(k.page)">
        <span class="k-label">{{ k.label }}<MemHelp v-if="k.help" :text="k.help" :width="300" /></span>
        <span class="k-value">{{ k.value }}</span>
        <span class="k-foot">{{ k.foot }}</span>
      </div>
    </div>

    <div class="mem-split-2-1">
      <MemoryTrendChart :data="trendPoints" :range="trendRange" @change-range="loadTrend" />

      <div class="mem-card">
        <div class="mem-card-title">
          Agent 连接状态
          <span class="mem-hint">{{ agents.length }} 个已接入 · {{ mem.verifiedAgents }} 个真实调用过</span>
        </div>
        <!-- 定高滚动：后续接入的 Agent 变多时列表自己滚，不把卡片越撑越高 -->
        <div v-if="agents.length" class="mem-scroll mem-scroll-sm">
          <div v-for="a in agents" :key="a.id" class="mem-chain-node" style="cursor: pointer" @click="goto('agents')">
            <span class="mem-dot" :class="a.beat ? 'ok' : a.injected ? 'warn' : 'bad'"></span>
            <span class="n-title">{{ a.name }}</span>
            <span style="margin-left: auto" class="mem-chip" :class="a.beat ? 'accent' : a.injected ? 'warn' : ''">
              {{ a.beat ? `真实调用 · ${timeAgo(a.beat.lastCall)}` : a.injected ? "已配置未调用" : "未注入" }}
            </span>
          </div>
        </div>
        <div v-else class="mem-empty">尚未探测到可接入的 Agent</div>
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-card mem-card-fill">
        <div class="mem-card-title">
          实时记忆流
          <span class="mem-hint">近 7 天</span>
          <MemHelp text="最近写入的记忆（新写入的自动置顶并高亮）。点任意一条打开详情抽屉，可看全文、演化链与相关记忆。" />
        </div>
        <div v-if="recent.length" class="mem-scroll">
          <div
            v-for="r in recent"
            :key="r.id"
            class="mem-item"
            :class="{ 'is-new': r.id === mem.lastNewId }"
            style="padding: 8px 10px"
            @click="openDrawer(r.id)"
          >
            <div class="mi-top">
              <span class="mi-title">{{ r.title }}</span>
              <span class="mem-chip">{{ timeAgo(r.created) }}</span>
            </div>
            <div class="mi-meta">
              <span>{{ r.agent }}</span>
              <span>·</span>
              <span>{{ r.project || "通用（general）" }}</span>
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">还没有记忆。让 Agent 调用 <code>memory_write</code>，或在「记忆浏览」手动新建。</div>
      </div>

      <!-- 系统健康：默认只有一行结论 + 三条常用指标，异常时自动展开内部诊断明细 -->
      <div class="mem-card">
        <div class="mem-card-title">
          系统健康
          <span class="mem-hint mem-inline-ctl">
            <button class="mem-chip click" @click="healthOpen = !healthOpen">{{ healthOpen ? "收起明细" : "明细" }}</button>
          </span>
        </div>
        <div class="mem-row" style="gap: 8px">
          <span class="mem-dot" :class="healthy ? (healthyOk ? 'ok' : 'bad') : ''"></span>
          <span>{{ healthy ? (healthyOk ? "索引一致 · 无孤儿行 · 无断链" : "发现异常，点上方「一键修复」") : "诊断中…" }}</span>
        </div>
        <div class="mem-kv" style="margin-top: 10px">
          <span class="k">索引条目</span>
          <span class="v">{{ formatInteger(mem.index?.rows || 0) }} 条</span>
          <span class="k">索引体积</span>
          <span class="v">{{ formatInteger(Math.round((mem.index?.sizeBytes || 0) / 1024)) }} KB</span>
          <span class="k">最后构建</span>
          <span class="v">{{ mem.index?.lastBuildAt ? timeAgo(mem.index.lastBuildAt) : "—" }}</span>
        </div>
        <div v-if="healthy && (healthOpen || !healthyOk)" class="mem-kv" style="margin-top: 10px">
          <span class="k">孤儿索引行</span>
          <span class="v">{{ healthy.orphan }}</span>
          <span class="k">未索引文件</span>
          <span class="v">{{ healthy.unindexed }}</span>
          <span class="k">断链</span>
          <span class="v">{{ healthy.broken }}</span>
          <span class="k">WAL</span>
          <span class="v">{{ formatInteger(Math.round((mem.index?.walBytes || 0) / 1024)) }} KB</span>
        </div>
        <div style="margin-top: 10px">
          <button class="btn btn-ghost" @click="goto('index')">诊断与修复 →</button>
        </div>
      </div>
    </div>

    <!-- AI 花费：原「自动化成本」与「模型调用统计」是同一件事，合并为一张卡 -->
    <div class="mem-card">
      <div class="mem-card-title">
        AI 花费
        <span class="mem-hint">近 30 天 · 数据源为本模块 llm_call 表</span>
        <span class="mem-inline-ctl">
          <button class="mem-chip click" @click="goto('auto')">自动化任务 →</button>
          <button class="mem-chip click" @click="openModels">配置模型与供应商 →</button>
        </span>
      </div>
      <LlmUsagePanel compact />
    </div>

    <MemoryDetailDrawer
      :show="drawerOpen"
      :id="drawerId"
      @close="drawerOpen = false"
      @open="openDrawer"
      @changed="refresh"
    />

    <EmptyState
      v-if="mem.loadError"
      title="记忆仓库未启用"
      :desc="mem.loadError"
    />
  </div>
</template>
