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
<!-- 记忆中枢 · 检索与索引：索引状态（异常才出现修复）+ 检索调试（抽为 SearchDebugPanel，供搜索空态复用）
     索引由增量构建与自愈扫描自动维护，这里不再常驻「增量/全量/诊断/VACUUM」四个按钮 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";
import SearchDebugPanel from "../../components/memory/SearchDebugPanel.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "index");

const graph = ref({ nodes: 0, edges: 0, broken: 0, isolated: 0 });
const busy = ref("");
const detailOpen = ref(false);
const debugOpen = ref(false);

const sizeKb = (n: number) => `${formatInteger(Math.round(n / 1024))} KB`;
/* 诊断与健康结论统一收口到 store（与仪表盘同口径）：null = 尚未诊断/诊断失败 */
const diagnose = computed(() => mem.diagnose);
const healthyOk = computed(() => mem.indexHealthy);

async function refresh() {
  await mem.loadAll(true);
  try {
    graph.value = await api.memoryGraphStats();
  } catch {
    /* 忽略 */
  }
  await mem.refreshDiagnose();
}

/** 一键修复：store.fixIndex 统一实现，复核诊断收敛才报成功 */
async function repair() {
  busy.value = "repair";
  try {
    const r = await mem.fixIndex();
    if (r.ok) ElMessage.success(r.message);
    else ElMessage.warning(r.message);
    await refresh();
  } finally {
    busy.value = "";
  }
}

/** 诊断失败/未返回时的手动重试：只是再拉一次诊断，不动索引 */
async function retryDiagnose() {
  busy.value = "diag";
  try {
    await mem.refreshDiagnose();
    if (!mem.diagnose) ElMessage.warning("诊断仍未返回，可稍后重试或先看日志");
  } finally {
    busy.value = "";
  }
}

onMounted(() => {
  void refresh();
  // 索引完成事件的诊断快照由 store.onEvent 落进 mem.diagnose，本页 computed 自动跟随
});
watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        索引是从记忆文件派生的加速层，删掉可随时重建、不丢数据；平时由增量构建与自愈扫描自动照看
        <MemHelp text="这一页用于「该搜到的没搜到」这类排查：看某次查询被切成什么词、命中了哪些条、分数由哪几部分构成。索引本身无需手动维护，只有异常（磁盘与索引对不上）时才需要点修复。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="diagnose && !healthyOk" class="btn btn-cta" :disabled="busy === 'repair'" @click="repair">
          {{ busy === "repair" ? "修复中…" : "一键修复" }}
        </button>
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-kpi">
        <span class="k-label">索引条目</span>
        <span class="k-value">{{ formatInteger(mem.index?.rows || 0) }}</span>
        <span class="k-foot">{{ diagnose ? (healthyOk ? "与记忆文件一致" : "与记忆文件不一致") : "尚未诊断" }}</span>
      </div>
      <div class="mem-kpi">
        <span class="k-label">索引体积<MemHelp text="索引库与记忆文件的体积；预写日志（WAL）在大批量写入后会变大，属正常现象。" /></span>
        <span class="k-value">{{ sizeKb(mem.index?.sizeBytes || 0) }}</span>
        <span class="k-foot">最后构建 {{ mem.index?.lastBuildAt ? timeAgo(mem.index.lastBuildAt) : "—" }}</span>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        索引诊断
        <span class="mem-hint mem-inline-ctl">
          <span class="mem-row" style="gap: 6px">
            <span class="mem-dot" :class="diagnose ? (healthyOk ? 'ok' : 'bad') : ''"></span>
            <span>{{ diagnose ? (healthyOk ? "磁盘与索引一致" : "发现异常，点右上「一键修复」") : "诊断未返回" }}</span>
            <button v-if="!diagnose" class="btn btn-ghost" :disabled="busy === 'diag'" @click="retryDiagnose">
              {{ busy === "diag" ? "重试中…" : "重新诊断" }}
            </button>
          </span>
          <button class="btn btn-ghost" @click="detailOpen = !detailOpen">{{ detailOpen ? "收起明细" : "明细" }}</button>
        </span>
      </div>
      <div v-if="detailOpen || (diagnose && !healthyOk)" class="mem-kv">
        <span class="k">孤儿索引行<MemHelp text="索引里有、磁盘上没有（多为手工删了文件）——自愈扫描会清掉。" /></span>
        <span class="v">{{ diagnose?.orphan ?? 0 }}</span>
        <span class="k">未索引文件<MemHelp text="磁盘上有、索引里没有（多为外部新增）——增量构建会补上。" /></span>
        <span class="v">{{ diagnose?.unindexed ?? 0 }}</span>
        <span class="k">断链</span>
        <span class="v">{{ graph.broken }}</span>
        <span class="k">链接图</span>
        <span class="v">{{ formatInteger(graph.nodes) }} 节点 / {{ formatInteger(graph.edges) }} 边 · 孤立 {{ graph.isolated }}</span>
        <span class="k">WAL</span>
        <span class="v">{{ sizeKb(mem.index?.walBytes || 0) }}</span>
      </div>
    </div>

    <!-- 检索调试台（含 digest 概览预览）：排查「该搜到的没搜到」，默认收起；
         组件与「记忆浏览」搜索空态的入口共用同一份实现（SearchDebugPanel） -->
    <div class="mem-card">
      <div class="mem-card-title">
        检索调试
        <span class="mem-hint">看某次查询为什么这么排 · 内含 digest 概览预览</span>
        <button class="btn btn-ghost" @click="debugOpen = !debugOpen">{{ debugOpen ? "收起" : "展开" }}</button>
      </div>
      <SearchDebugPanel v-if="debugOpen" />
    </div>
  </div>
</template>
