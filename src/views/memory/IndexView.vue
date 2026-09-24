<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 检索与索引：索引状态（异常才出现修复）+ 检索调试（折叠）+ digest 预览（折叠）
     索引由增量构建与自愈扫描自动维护，这里不再常驻「增量/全量/诊断/VACUUM」四个按钮 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "index");

const debugQuery = ref("索引方案");
const debug = ref<Awaited<ReturnType<typeof api.memorySearchDebug>> | null>(null);
const digest = ref<Awaited<ReturnType<typeof api.memoryDigest>> | null>(null);
const graph = ref({ nodes: 0, edges: 0, broken: 0, isolated: 0 });
const diagnose = ref<{ orphanRows: string[]; unindexed: string[]; fts: { rebuilt: boolean } } | null>(null);
const busy = ref("");
const debugOpen = ref(false);
const digestOpen = ref(false);
const detailOpen = ref(false);
/** 评分口径说明（模板里展示，避免与后端算法重复实现） */
const settingsExplain = "评分 = BM25×0.5 + 时间衰减×0.15 + 重要度×0.1 + 亲和×0.15 + 图层×0.05 + 置顶加成";

const sizeKb = (n: number) => `${formatInteger(Math.round(n / 1024))} KB`;
const healthyOk = computed(
  () => !!diagnose.value && diagnose.value.orphanRows.length === 0 && diagnose.value.unindexed.length === 0 && graph.value.broken === 0,
);

async function refresh() {
  await mem.loadAll(true);
  try {
    graph.value = await api.memoryGraphStats();
  } catch {
    /* 忽略 */
  }
  try {
    digest.value = await api.memoryDigest();
  } catch {
    /* 忽略 */
  }
  // 自动诊断：正常时只显示一行结论，省掉一个常驻按钮
  try {
    const r = await api.memoryIndexDiagnose();
    diagnose.value = r.diagnose;
    graph.value = r.graph;
  } catch {
    /* 忽略 */
  }
}

async function runDebug() {
  if (!debugQuery.value.trim()) return;
  try {
    debug.value = await api.memorySearchDebug(debugQuery.value.trim());
  } catch (e) {
    ElMessage.error((e as Error).message || "检索失败");
  }
}

/** 一键修复：按目录重算索引（索引是从文件派生的，重算不会动记忆文件） */
async function repair() {
  busy.value = "repair";
  try {
    const r = await api.memoryIndexBuild();
    ElMessage.success(`已按目录重算索引（${r.files} 个文件），孤儿行与未索引项已收敛`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "修复失败");
  } finally {
    busy.value = "";
  }
}

async function copyDigest() {
  try {
    await navigator.clipboard.writeText(digest.value?.text || "");
    ElMessage.success("digest 已复制");
  } catch {
    ElMessage.warning("复制失败");
  }
}

function toggleDebug() {
  debugOpen.value = !debugOpen.value;
  if (debugOpen.value && !debug.value) void runDebug();
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
        索引是从记忆文件派生的加速层，删掉可随时重建、不丢数据；平时由增量构建与自愈扫描自动照看
        <MemHelp text="这一页用于「该搜到的没搜到」这类排查：看某次查询被切成什么词、命中了哪些条、分数由哪几部分构成。索引本身无需手动维护，只有异常（磁盘与索引对不上）时才需要点修复。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="!healthyOk" class="el-button el-button--small el-button--primary" :disabled="busy === 'repair'" @click="repair">
          {{ busy === "repair" ? "修复中…" : "一键修复" }}
        </button>
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-kpi">
        <span class="k-label">索引条目</span>
        <span class="k-value">{{ formatInteger(mem.index?.rows || 0) }}</span>
        <span class="k-foot">{{ healthyOk ? "与记忆文件一致" : "与记忆文件不一致" }}</span>
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
            <span class="mem-dot" :class="healthyOk ? 'ok' : 'bad'"></span>
            <span>{{ healthyOk ? "磁盘与索引一致" : "发现异常，点右上「一键修复」" }}</span>
          </span>
          <button class="mem-chip click" @click="detailOpen = !detailOpen">{{ detailOpen ? "收起明细" : "明细" }}</button>
        </span>
      </div>
      <div v-if="detailOpen || !healthyOk" class="mem-kv">
        <span class="k">孤儿索引行<MemHelp text="索引里有、磁盘上没有（多为手工删了文件）——自愈扫描会清掉。" /></span>
        <span class="v">{{ diagnose?.orphanRows.length ?? 0 }}</span>
        <span class="k">未索引文件<MemHelp text="磁盘上有、索引里没有（多为外部新增）——增量构建会补上。" /></span>
        <span class="v">{{ diagnose?.unindexed.length ?? 0 }}</span>
        <span class="k">断链</span>
        <span class="v">{{ graph.broken }}</span>
        <span class="k">链接图</span>
        <span class="v">{{ formatInteger(graph.nodes) }} 节点 / {{ formatInteger(graph.edges) }} 边 · 孤立 {{ graph.isolated }}</span>
        <span class="k">WAL</span>
        <span class="v">{{ sizeKb(mem.index?.walBytes || 0) }}</span>
      </div>
    </div>

    <!-- 检索调试台：开发者视角的排查工具，默认收起 -->
    <div class="mem-card">
      <div class="mem-card-title">
        检索调试
        <span class="mem-hint">看某次查询为什么这么排</span>
        <button class="mem-chip click" @click="toggleDebug">{{ debugOpen ? "收起" : "展开" }}</button>
      </div>
      <template v-if="debugOpen">
        <div class="mem-row" style="margin-bottom: 10px">
          <input v-model="debugQuery" class="el-input__inner" style="flex: 1" @keyup.enter="runDebug" placeholder="输入查询，查看分词、命中与评分分解" />
          <button class="el-button el-button--small" @click="runDebug">检索</button>
        </div>

        <div v-if="debug" class="mem-section">
          <div class="s-title">分词结果（bigram 预分词）</div>
          <div class="mem-row" style="gap: 6px">
            <span v-for="(t, i) in debug.tokens" :key="i" class="mem-chip">{{ t }}</span>
            <span v-if="!debug.tokens.length" class="mem-hint">（无可分词内容）</span>
          </div>

          <div class="s-title" style="margin-top: 10px">查询扩展（同义词表命中）</div>
          <div class="mem-row" style="gap: 6px">
            <span v-for="(list, key) in debug.synonyms" :key="key" class="mem-chip info">{{ key }} → {{ (list || []).slice(0, 5).join(" / ") }}</span>
            <span v-if="!Object.keys(debug.synonyms || {}).length" class="mem-hint">（同义词表为空，可在 &lt;仓库&gt;/index/synonyms.json 编辑）</span>
          </div>

          <div class="s-title" style="margin-top: 10px">
            命中结果（{{ debug.results.length }} / {{ debug.total }}，{{ debug.tookMs }}ms）
            <MemHelp :text="settingsExplain" />
          </div>
          <div class="mem-col" style="gap: 6px; max-height: 320px; overflow: auto">
            <div v-for="(r, i) in debug.results.slice(0, 10)" :key="r.id" style="border: 1px solid var(--mem-line); border-radius: var(--r-sm); padding: 8px 10px">
              <div style="display: flex; align-items: baseline; gap: 8px">
                <span class="mem-chip">{{ i + 1 }}</span>
                <span class="mi-title" style="cursor: default">{{ r.title }}</span>
                <span class="mem-chip accent" style="margin-left: auto">总分 {{ r.score }}</span>
              </div>
              <div class="mem-hint" style="margin-top: 4px">
                <template v-if="r.scoreParts">
                  BM25 {{ (r.scoreParts.bm25 ?? 0).toFixed(2) }} · 时间 {{ (r.scoreParts.recency ?? 0).toFixed(2) }} ·
                  重要度 {{ (r.scoreParts.importance ?? 0).toFixed(2) }} · 亲和 {{ (r.scoreParts.affinity ?? 0).toFixed(2) }} ·
                  图层 {{ (r.scoreParts.layer ?? 0).toFixed(2) }} · 图扩散 {{ (r.scoreParts.graph ?? 0).toFixed(2) }}
                </template>
              </div>
            </div>
            <div v-if="!debug.results.length" class="mem-empty">没有命中：换个更短的关键词，或检查同义词表</div>
          </div>
        </div>
      </template>
    </div>

    <!-- digest 概览：Agent 开局常驻的全局索引，默认收起（行数上限在配置页调） -->
    <div class="mem-card">
      <div class="mem-card-title">
        digest 概览预览
        <span class="mem-hint">Agent 开局常驻的全局索引 · 当前 {{ digest?.lines || 0 }} 行（上限 {{ formatInteger(Number(mem.cfg("agents.digestMaxLines", 200))) }} 行，配置页可调）</span>
        <span class="mem-inline-ctl">
          <button class="mem-chip click" @click="copyDigest">复制 digest</button>
          <button class="mem-chip click" @click="digestOpen = !digestOpen">{{ digestOpen ? "收起" : "展开" }}</button>
        </span>
      </div>
      <pre v-if="digestOpen" class="mem-pre">{{ digest?.text || "（暂无内容）" }}</pre>
    </div>
  </div>
</template>
