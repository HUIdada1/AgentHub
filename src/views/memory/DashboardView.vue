<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 仪表盘：KPI 卡组 + 增长趋势 + Agent 连接状态 + 实时记忆流 + 系统健康 + 快捷操作 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryAgentCard, MemoryRow } from "../../types";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import EmptyState from "../../components/sync/EmptyState.vue";
import MemoryDetailDrawer from "../../components/memory/MemoryDetailDrawer.vue";
import LlmUsagePanel from "../../components/memory/LlmUsagePanel.vue";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();

const active = computed(() => app.activeModule === "memory" && app.activePage === "dashboard");

const trend = ref<{ day: string; count: number }[]>([]);
const recent = ref<MemoryRow[]>([]);
const agents = ref<MemoryAgentCard[]>([]);
const healthy = ref<{ consistent: boolean; broken: number; orphan: number }>({ consistent: true, broken: 0, orphan: 0 });
const disk = ref({ mdBytes: 0, files: 0, indexBytes: 0 });
const busy = ref("");
const drawerId = ref("");
const drawerOpen = ref(false);

const kpi = computed(() => {
  const s = mem.stats;
  const idx = mem.index;
  return [
    { label: "记忆总数", value: s ? formatInteger(s.total) : "-", foot: s ? `L2 ${s.l2} 条` : "", page: "browse",
      help: "库里全部记忆条数（含每日流水、会话摘要、手写笔记与 AI 蒸馏出的深层记忆）。点开看列表。" },
    { label: "项目数", value: s ? String(s.projects) : "-", foot: "按 Git 地址归类", page: "projects",
      help: "按 Git 远程地址归类出的项目文件夹数。同一仓库在不同电脑、不同路径下都会归到同一个项目。" },
    {
      label: "已连通 Agent",
      value: mem.beats.length ? `${mem.verifiedAgents}/${mem.beats.length}` : `0/${agents.value.filter((a) => a.injected).length}`,
      foot: "三级校验为真实调用",
      page: "agents",
      help: "分母是已注入 MCP 的 Agent 数，分子是「真的调用过记忆工具」的数量。只配置了但从未调用不算连通——避免假绿灯。",
    },
    { label: "今日新增", value: s ? String(s.today) : "-", foot: s ? `昨日 ${s.yesterday}` : "", page: "browse",
      help: "今天 0 点以后写入的记忆条数（对比昨日同口径）。" },
    {
      label: "索引一致率",
      value: idx ? (idx.consistent ? "100%" : "不一致") : "-",
      foot: idx ? `${formatInteger(idx.rows)} 条` : "",
      warn: !!idx && !idx.consistent,
      page: "index",
      help: "索引条目数是否等于内容表行数。不一致说明触发器漏建或索引损坏——点开「检索与索引」一键重建即可（记忆文件本身不受影响）。",
    },
    {
      label: "待处理",
      value: s ? String(s.pending) : "-",
      foot: "待确认失效 / 归类 / 去重",
      warn: !!s && s.pending > 0,
      page: "profile",
      help: "需要你点头的事：AI 判定的「事实失效」建议、名称模糊的项目归类建议、去重队列里低置信的重复判定。AI 只建议，不自动改。",
    },
  ];
});

const trendPoints = computed(() => trend.value.slice(-30));

async function refresh() {
  await mem.loadAll();
  try {
    const hm = await api.memoryHeatmap(30);
    trend.value = hm.days;
  } catch {
    /* 保留旧值 */
  }
  try {
    const r = await api.memoryRecent({ days: 7, limit: 12 });
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
    healthy.value = { consistent: !d.diagnose.fts.rebuilt, broken: d.graph.broken, orphan: d.diagnose.orphanRows.length };
  } catch {
    /* 保留旧值 */
  }
  const st = await api.memoryStatus().catch(() => null);
  if (st) disk.value = { mdBytes: mem.stats?.indexBytes ?? 0, files: st.index?.rows ?? 0, indexBytes: st.index?.sizeBytes ?? 0 };
}

async function quickSync() {
  busy.value = "sync";
  try {
    const r = await api.memorySyncRun();
    ElMessage.success(`同步完成：上传 ${r.uploaded ?? 0} 个包 / 冲突 ${r.conflicts ?? 0} 条`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "同步失败");
  } finally {
    busy.value = "";
  }
}

async function quickRebuild() {
  busy.value = "rebuild";
  try {
    const r = await api.memoryIndexRebuild();
    ElMessage.success(`索引已重建：${r.files} 个文件 / ${r.tookMs}ms`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "重建失败");
  } finally {
    busy.value = "";
  }
}

async function quickProfile() {
  busy.value = "profile";
  try {
    const r = await api.memoryProfileGenerate();
    ElMessage.success(r.detail || "画像生成完成");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "生成失败（可先在「模型与网关」配置模型）");
  } finally {
    busy.value = "";
  }
}

function openDrawer(id: string) {
  drawerId.value = id;
  drawerOpen.value = true;
}

function goto(page: string) {
  app.activePage = page;
}

/** 模型与网关现为配置页的子板块：先留跳转提示（配置页消费后清空），再进配置页 */
function openModels() {
  mem.configTabHint = "__models__";
  app.openModuleConfig();
}

let offEvent: (() => void) | undefined;
// 只对会改变卡片内容的事件全量刷新：watcher 每改一个文件就发 index 事件，
// 不挡的话批量写入/导入时仪表盘每次连发 5 个 IPC（事件风暴）
const REFRESH_TYPES = new Set(["memory-new", "deleted", "supersede", "config-changed", "bridge", "conflict", "sync", "root-changed"]);
onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "memory" && REFRESH_TYPES.has(p.type || "")) void refresh();
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
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small" :disabled="!!busy" @click="quickSync">{{ busy === "sync" ? "同步中…" : "立即同步" }}</button>
        <button class="el-button el-button--small" :disabled="!!busy" @click="quickRebuild">{{ busy === "rebuild" ? "重建中…" : "重建索引" }}</button>
        <button class="el-button el-button--small" :disabled="!!busy" @click="quickProfile">{{ busy === "profile" ? "生成中…" : "生成画像" }}</button>
        <button class="el-button el-button--small" @click="api.memoryOpenDir()">打开仓库目录</button>
      </div>
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
      <div class="mem-card mem-card-fill">
        <div class="mem-card-title">
          记忆增长趋势（近 30 天）
          <span class="mem-hint">共 {{ formatInteger(trendPoints.reduce((s, d) => s + d.count, 0)) }} 条</span>
        </div>
        <svg v-if="trendPoints.length" viewBox="0 0 600 90" preserveAspectRatio="none" style="width: 100%">
          <polyline
            :points="trendPoints.map((d, i) => `${(i / Math.max(1, trendPoints.length - 1)) * 600},${90 - (d.count / Math.max(1, ...trendPoints.map((x) => x.count))) * 78}`).join(' ')"
            fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"
          />
        </svg>
        <div v-else class="mem-empty">暂无数据</div>
      </div>

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

    <div class="mem-grid mem-grid-3">
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
              <span>{{ r.project || "general" }}</span>
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">还没有记忆。让 Agent 调用 <code>memory_write</code>，或在本页手动新建。</div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          系统健康
          <MemHelp text="索引健康看条目数与触发器是否齐；WAL 是 SQLite 的预写日志（大批量写入后会变大，正常）；孤儿索引行与断链来自诊断结果。" />
        </div>
        <div class="mem-kv">
          <span class="k">索引健康</span>
          <span class="v">
            <span class="mem-dot" :class="healthy.consistent ? 'ok' : 'bad'"></span>
            {{ healthy.consistent ? "正常" : "需重建" }}
          </span>
          <span class="k">触发器</span>
          <span class="v">6/6 {{ mem.index?.consistent ? "✓" : "⚠" }}</span>
          <span class="k">孤儿索引行</span>
          <span class="v">{{ healthy.orphan }}</span>
          <span class="k">断链</span>
          <span class="v">{{ healthy.broken }} {{ healthy.broken ? "⚠" : "" }}</span>
          <span class="k">索引体积</span>
          <span class="v">{{ formatInteger(Math.round((mem.index?.sizeBytes || 0) / 1024)) }} KB</span>
          <span class="k">WAL</span>
          <span class="v">{{ formatInteger(Math.round((mem.index?.walBytes || 0) / 1024)) }} KB</span>
          <span class="k">仓库文件</span>
          <span class="v">{{ disk.files }} 个</span>
        </div>
        <div style="margin-top: 10px">
          <button class="el-button el-button--small" @click="goto('index')">诊断并修复 →</button>
        </div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          自动化成本
          <span class="mem-hint">今日</span>
          <MemHelp text="自动化任务调用模型花掉的 token（含抽取/打标/去重/蒸馏/画像）。到「自动化任务」页可调每个任务的开关节奏与单日上限。" />
        </div>
        <div class="mem-kv">
          <span class="k">今日消耗</span>
          <span class="v">{{ formatInteger(mem.stats?.llmToday || 0) }} token</span>
          <span class="k">今日调用</span>
          <span class="v">{{ mem.stats?.llmCalls || 0 }} 次</span>
          <span class="k">预算</span>
          <span class="v">{{ formatInteger(Number(mem.cfg("auto.dailyTokenLimit", 200000))) }} / 天</span>
        </div>
        <div class="mem-actions" style="margin-top: 10px">
          <button class="el-button el-button--small" @click="goto('auto')">自动化任务 →</button>
          <button class="el-button el-button--small" @click="openModels">模型与网关 →</button>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        模型调用统计
        <span class="mem-hint">近 30 天 · 数据源为本模块 llm_call 表</span>
        <button class="mem-chip click" @click="openModels">配置模型与供应商 →</button>
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
