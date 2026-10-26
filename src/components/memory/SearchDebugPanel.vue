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
<!-- 记忆中枢 · 检索调试面板：「该搜到的没搜到」时的排查工具——看查询被切成什么词、
     命中了哪些条、分数由哪几部分构成；内含 digest 概览预览。
     两处复用：检索与索引页常驻一张卡；记忆浏览搜索空态里按需弹出（带上当前搜索词）。 -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger } from "../../composables/useFormat";
import MemHelp from "./MemHelp.vue";

const props = withDefaults(defineProps<{ query?: string }>(), { query: "" });
const mem = useMemoryStore();

const debugQuery = ref(props.query || "索引方案");
const debug = ref<Awaited<ReturnType<typeof api.memorySearchDebug>> | null>(null);
const digest = ref<Awaited<ReturnType<typeof api.memoryDigest>> | null>(null);
const debugOpen = ref(true);
const digestOpen = ref(false);

/** 评分公式（动态从配置读六权重，避免硬编码与后端脱节） */
const settingsExplain = ref("");
function buildExplain() {
  const f = (k: string, fb: number) => Number(mem.cfg(k, fb));
  settingsExplain.value = `评分 = BM25×${f("search.weightBm25", 0.5)} + 时间衰减×${f("search.weightRecency", 0.15)} + 重要度×${f("search.weightImportance", 0.1)} + 亲和×${f("search.weightAffinity", 0.15)} + 图层×${f("search.weightLayer", 0.05)} + 图扩散×${f("search.weightGraph", 0.05)}（置顶加成另算）`;
}

async function runDebug() {
  if (!debugQuery.value.trim()) return;
  try {
    debug.value = await api.memorySearchDebug(debugQuery.value.trim());
  } catch (e) {
    ElMessage.error((e as Error).message || "检索失败");
  }
}

async function loadDigest() {
  try {
    digest.value = await api.memoryDigest();
  } catch {
    /* 忽略 */
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

onMounted(async () => {
  buildExplain();
  await loadDigest();
  // 带搜索词进来（搜索空态入口）：直接跑一次，省掉再点一下
  if (props.query) void runDebug();
});

defineExpose({ runDebug });
</script>

<template>
  <div class="mem-col" style="gap: 10px">
    <div class="mem-row" style="gap: 8px">
      <input v-model="debugQuery" class="f-input" style="flex: 1" @keyup.enter="runDebug" placeholder="输入查询，查看分词、命中与评分分解" />
      <button class="btn btn-ghost" @click="runDebug">检索</button>
    </div>

    <div v-if="debug" class="mem-section">
      <div class="s-title">切词结果（中文双字切分）</div>
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

    <div class="mem-section">
      <div class="s-title">
        digest 概览预览
        <span class="mem-hint">当前 {{ digest?.lines || 0 }} 行（上限 {{ formatInteger(Number(mem.cfg("agents.digestMaxLines", 200))) }} 行，配置页可调）</span>
        <span class="mem-inline-ctl">
          <button class="btn btn-ghost" @click="copyDigest">复制 digest</button>
          <button class="btn btn-ghost" @click="digestOpen = !digestOpen">{{ digestOpen ? "收起" : "展开" }}</button>
        </span>
      </div>
      <pre v-if="digestOpen" class="mem-pre" style="margin-top: 6px">{{ digest?.text || "（暂无内容）" }}</pre>
    </div>
  </div>
</template>
