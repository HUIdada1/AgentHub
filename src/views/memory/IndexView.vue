<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 检索与索引：索引状态 + 维护操作 + 检索调试台（分词/评分分解）+ token 预算模拟 + digest 预览 + 链接图 + 诊断 + 回收站 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, formatDateTime, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "index");

const debugQuery = ref("索引方案");
const debug = ref<Awaited<ReturnType<typeof api.memorySearchDebug>> | null>(null);
const digest = ref<Awaited<ReturnType<typeof api.memoryDigest>> | null>(null);
const graph = ref({ nodes: 0, edges: 0, broken: 0, isolated: 0 });
const diagnose = ref<{ orphanRows: string[]; unindexed: string[]; fts: { rebuilt: boolean } } | null>(null);
const trash = ref<{ name: string; trashedAt: number; originPath: string; size: number }[]>([]);
const estSearchTokens = ref(0);
const busy = ref("");
const digestLines = ref<number | null>(null);
/** 评分口径说明（模板里展示，避免与后端算法重复实现） */
const settingsExplain = "评分 = BM25×0.5 + 时间衰减×0.15 + 重要度×0.1 + 亲和×0.15 + 图层×0.05 + 置顶加成";

const sizeKb = (n: number) => `${formatInteger(Math.round(n / 1024))} KB`;

async function refresh() {
  await mem.loadAll(true);
  try {
    graph.value = await api.memoryGraphStats();
  } catch {
    /* 忽略 */
  }
  try {
    digest.value = await api.memoryDigest(digestLines.value ?? undefined);
  } catch {
    /* 忽略 */
  }
  try {
    const t = await api.memoryTrashList();
    trash.value = t.items;
  } catch {
    /* 忽略 */
  }
  await runDebug();
}

async function runDebug() {
  if (!debugQuery.value.trim()) return;
  try {
    debug.value = await api.memorySearchDebug(debugQuery.value.trim());
    const texts = debug.value.results.map((r) => `${r.title} ${r.summary}`.slice(0, 300));
    const est = await api.memoryTokenEstimate(texts.length ? texts : ["（无命中）"]);
    estSearchTokens.value = est.total;
  } catch (e) {
    ElMessage.error((e as Error).message || "检索失败");
  }
}

async function rebuild() {
  busy.value = "rebuild";
  try {
    const r = await api.memoryIndexRebuild();
    ElMessage.success(`全量重建完成：${r.files} 个文件 / ${r.tookMs}ms`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "重建失败");
  } finally {
    busy.value = "";
  }
}

async function buildIncremental() {
  busy.value = "build";
  try {
    const r = await api.memoryIndexBuild();
    ElMessage.success(`增量构建完成：${r.files} 个文件`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "构建失败");
  } finally {
    busy.value = "";
  }
}

async function runDiagnose() {
  busy.value = "diag";
  try {
    const r = await api.memoryIndexDiagnose();
    diagnose.value = r.diagnose;
    graph.value = r.graph;
    ElMessage.success(`诊断完成：孤儿 ${r.diagnose.orphanRows.length} / 未索引 ${r.diagnose.unindexed.length} / 断链 ${r.graph.broken}`);
  } catch (e) {
    ElMessage.error((e as Error).message || "诊断失败");
  } finally {
    busy.value = "";
  }
}

async function repair() {
  busy.value = "repair";
  try {
    const r = await api.memoryIndexBuild();
    ElMessage.success(`已按目录重算索引（${r.files} 个文件），孤儿行与未索引项已收敛`);
    diagnose.value = null;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "修复失败");
  } finally {
    busy.value = "";
  }
}

async function vacuum() {
  busy.value = "vacuum";
  try {
    const r = await api.memoryIndexVacuum();
    ElMessage.success(`VACUUM 完成：${sizeKb(r.before)} → ${sizeKb(r.after)}`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "VACUUM 失败");
  } finally {
    busy.value = "";
  }
}

async function restoreTrash(name: string, dest: string) {
  try {
    await api.memoryTrashRestore(name, dest);
    ElMessage.success("已恢复到原路径");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "恢复失败");
  }
}

async function purgeTrash() {
  try {
    await ElMessageBox.confirm("清理超过保留期的回收站文件？此操作不可恢复。", "清理回收站", { type: "warning" });
  } catch {
    return;
  }
  try {
    const r = await api.memoryTrashPurge();
    ElMessage.success(`已清理 ${r.removed} 个文件`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "清理失败");
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

onMounted(refresh);
watch(active, (v) => {
  if (v) void refresh();
});
watch(digestLines, () => void api.memoryDigest(digestLines.value ?? undefined).then((d) => (digest.value = d)).catch(() => {}));
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        bigram 预分词 · external content 双索引 · 6 触发器自动同步 · 混合评分在应用层
        <MemHelp text="索引是从记忆文件派生的加速层，随时可以删掉重建、不丢数据。这一页做维护与排查：构建、重建、诊断，以及看某次查询为什么这么排。" />
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small" :disabled="!!busy" @click="buildIncremental">{{ busy === "build" ? "构建中…" : "增量构建" }}</button>
        <button class="el-button el-button--small" :disabled="!!busy" @click="rebuild">{{ busy === "rebuild" ? "重建中…" : "全量重建" }}</button>
        <MemHelp text="增量构建：只补磁盘上有、索引里没有的文件。全量重建：清空索引后按所有记忆文件重扫（2 万条约 1 秒多）。两者都不改动记忆文件本身。" />
        <button class="el-button el-button--small" :disabled="!!busy" @click="runDiagnose">{{ busy === "diag" ? "诊断中…" : "诊断" }}</button>
        <button class="el-button el-button--small" :disabled="!!busy" @click="vacuum">{{ busy === "vacuum" ? "回收中…" : "VACUUM 回收空间" }}</button>
      </div>
    </div>

    <div class="mem-grid mem-grid-4">
      <div class="mem-kpi"><span class="k-label">索引条目</span><span class="k-value">{{ formatInteger(mem.index?.rows || 0) }}</span><span class="k-foot">{{ mem.index?.consistent ? "一致率 100%" : "需重建" }}</span></div>
      <div class="mem-kpi"><span class="k-label">索引体积</span><span class="k-value">{{ sizeKb(mem.index?.sizeBytes || 0) }}</span><span class="k-foot">WAL {{ sizeKb(mem.index?.walBytes || 0) }}</span></div>
      <div class="mem-kpi">
        <span class="k-label">触发器健康<MemHelp text="6 个触发器负责「记忆表一改，两个索引自动跟着改」。漏建时索引会悄悄变空、检索全 0 且不报错，所以这里单独盯。" /></span>
        <span class="k-value">{{ mem.index?.consistent ? "6/6" : "异常" }}</span><span class="k-foot">mem / mem_w 双索引</span>
      </div>
      <div class="mem-kpi"><span class="k-label">最后构建</span><span class="k-value" style="font-size: 15px">{{ mem.index?.lastBuildAt ? timeAgo(mem.index.lastBuildAt) : "—" }}</span><span class="k-foot">目录扫描 {{ mem.index?.lastScanAt ? timeAgo(mem.index.lastScanAt) : "—" }}</span></div>
    </div>

    <div class="mem-split-2-1">
      <div class="mem-card">
        <div class="mem-card-title">
          检索调试台
          <span class="mem-hint">{{ settingsExplain }}</span>
          <MemHelp text="输入任意查询，看它被切成什么词、命中了哪些条、每条分数由哪几部分构成（相关度/时间/重要度/亲和/图层/图扩散）。怀疑「该搜到的没搜到」时先来这里看分词结果。" />
        </div>
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

          <div class="s-title" style="margin-top: 10px">命中结果（{{ debug.results.length }} / {{ debug.total }}，{{ debug.tookMs }}ms）</div>
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
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          token 预算模拟器
          <span class="mem-hint">估算值，非计费值</span>
        </div>
        <div class="mem-table-wrap">
          <table class="mem-table">
            <tbody>
            <tr><td>memory_core（常驻）</td><td class="num">≤ {{ formatInteger(Number(mem.cfg("agents.coreMaxTokens", 800))) }}</td></tr>
            <tr><td>memory_digest</td><td class="num">≤ {{ formatInteger(Number(mem.cfg("agents.digestMaxLines", 200))) }} 行</td></tr>
            <tr><td>memory_search（本次样例）</td><td class="num">{{ formatInteger(estSearchTokens) }}</td></tr>
            <tr><td>memory_search 上限</td><td class="num">{{ formatInteger(Number(mem.cfg("agents.searchMaxTokens", 1200))) }}</td></tr>
            <tr><td>全量读取（{{ formatInteger(mem.stats?.total || 0) }} 条）</td><td class="num">≈ {{ formatInteger((mem.stats?.total || 0) * 200) }}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="mem-hint" style="margin-top: 8px">
          三级披露：检索只回摘要，精读用 memory_get —— 相比全量读取省去绝大部分 token。
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        digest 概览预览（≤ {{ formatInteger(Number(mem.cfg("agents.digestMaxLines", 200))) }} 行）
        <MemHelp text="Agent 开局常驻的全局索引（项目清单 + 每个项目最近几条摘要），约 400 token。有了它，Agent 不检索也知道你记过哪些东西；行数上限在配置里可调。" />
        <span class="mem-hint mem-inline-ctl">
          当前 {{ digest?.lines || 0 }} 行
          <input v-model.number="digestLines" type="number" class="el-input__inner" placeholder="行数" />
          <button class="mem-chip click" @click="copyDigest">复制 digest</button>
        </span>
      </div>
      <pre class="mem-pre">{{ digest?.text || "（暂无内容）" }}</pre>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-card">
        <div class="mem-card-title">
        链接图概览
        <MemHelp text="记忆之间通过 frontmatter 的 refs 与正文 [[双链]] 建立联系。检索命中一条时会沿这些边带出相关记忆（图扩散），用来补「用词不同但说的是同一件事」的情况；断链指指向不存在的记忆。" />
      </div>
        <div class="mem-kv">
          <span class="k">节点</span><span class="v">{{ formatInteger(graph.nodes) }}</span>
          <span class="k">边</span><span class="v">{{ formatInteger(graph.edges) }}</span>
          <span class="k">孤立节点</span><span class="v">{{ formatInteger(graph.isolated) }}</span>
          <span class="k">断链</span><span class="v">{{ graph.broken }} {{ graph.broken ? "⚠" : "" }}</span>
        </div>
        <div class="mem-hint" style="margin-top: 8px">边来自 frontmatter 的 refs 与正文 [[双链]]；命中一条会沿图扩散带出相关记忆。</div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          索引诊断
          <MemHelp text="孤儿索引行＝索引里有、磁盘上没有（多为手工删了文件）；未索引文件＝磁盘上有、索引里没有（多为外部新增）；一键修复按目录重算即可，两者都不会动你的记忆文件。" />
          <button v-if="diagnose" class="mem-chip click" @click="repair">一键修复（按目录重算）</button>
        </div>
        <div v-if="!diagnose" class="mem-empty">点右上「诊断」检查孤儿索引行 / 未索引文件 / 触发器</div>
        <div v-else class="mem-kv">
          <span class="k">孤儿索引行</span><span class="v">{{ diagnose.orphanRows.length }} {{ diagnose.orphanRows.length ? "⚠" : "✓" }}</span>
          <span class="k">未索引文件</span><span class="v">{{ diagnose.unindexed.length }} {{ diagnose.unindexed.length ? "⚠" : "✓" }}</span>
          <span class="k">FTS 自检</span><span class="v">{{ diagnose.fts.rebuilt ? "已自动重建" : "✓ 一致" }}</span>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        回收站
        <MemHelp text="删除的记忆先整份进这里，保留期内可一键恢复回原路径；只有点「清理超期文件」才会真正从磁盘删除。" />
        <span class="mem-inline-ctl">
          <span class="mem-hint">{{ trash.length }} 个文件 · 保留 {{ formatInteger(Number(mem.cfg("storage.trashKeepDays", 90))) }} 天</span>
          <button class="mem-chip click" @click="purgeTrash">清理超期文件</button>
        </span>
      </div>
      <div v-if="trash.length" class="mem-table-wrap">
        <table class="mem-table">
        <thead><tr><th>删除时间</th><th>原路径</th><th>体积</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in trash.slice(0, 50)" :key="t.name">
            <td>{{ formatDateTime(t.trashedAt) }}</td>
            <td><span class="mem-mono">{{ t.originPath }}</span></td>
            <td class="num">{{ sizeKb(t.size) }}</td>
            <td><button class="el-button el-button--small" @click="restoreTrash(t.name, t.originPath)">恢复</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="mem-empty">回收站为空</div>
    </div>
  </div>
</template>
