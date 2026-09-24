<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 导入与去重：来源探测卡 + 干跑预览 + 去重漏斗与四层开关 + 人工确认队列 + 学习结果 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "import");

type SourceCard = {
  id: string; name: string; kind: string; path: string; enabled: boolean;
  exists: boolean; items: number; sizeBytes: number; note: string; estimate: string;
  table?: string;
  cursor: unknown;
};
type PreviewShape = {
  wouldCreate: number; wouldMerge: number; skipDuplicate: number; classifyFailed: number;
  sensitive: number; estimatedBytes: number; estimatedTokens: number;
  groups: { project: string; count: number; source: string }[];
  samples: { title: string; created: number; source: string; project: string }[];
  note: string;
};
type DedupStatus = {
  total: number; pending: number; done: number; merged: number; queued: number;
  dedupRate: number; learnedPairs: number; tokensUsed: number;
  layerCounts: { l1: number; learned: number };
};
type QueueItem = { id: string; payload: { kind: string; newId: string; targetId: string; confidence: number; reason: string; newTitle?: string; targetTitle?: string; newSummary?: string; targetSummary?: string } };

const sources = ref<SourceCard[]>([]);
const preview = ref<PreviewShape | null>(null);
const dedup = ref<DedupStatus | null>(null);
const queue = ref<QueueItem[]>([]);
const pairs = ref<{ a: string; b: string; aTitle: string; bTitle: string }[]>([]);
const progress = ref<{ phase: string; done: number; total: number; created: number; skipped: number; running: boolean } | null>(null);
const busy = ref("");
const detecting = ref<{ id: string; text: string } | null>(null);
const editSource = ref<SourceCard | null>(null);
const editForm = ref({ name: "", path: "", kind: "jsonl", enabled: true, table: "" });
const lastReport = ref("");

/** 模型与网关是配置页的子板块：留跳转提示后进配置页 */
function openModels() {
  mem.configTabHint = "__models__";
  app.openModuleConfig();
}

async function refresh() {
  await mem.loadAll();
  try {
    const r = await api.memoryImportSources();
    sources.value = r.sources as unknown as SourceCard[];
  } catch (e) {
    ElMessage.error((e as Error).message || "读取来源失败");
  }
  try {
    dedup.value = (await api.memoryDedupStatus()) as unknown as DedupStatus;
  } catch {
    /* 忽略 */
  }
  try {
    queue.value = (await api.memoryDedupReviewList()).items as unknown as QueueItem[];
  } catch {
    /* 忽略 */
  }
  try {
    pairs.value = (await api.memoryDedupPairsGet()).pairs;
  } catch {
    /* 忽略 */
  }
  try {
    progress.value = (await api.memoryImportProgress()) as unknown as typeof progress.value;
  } catch {
    /* 忽略 */
  }
  try {
    const r = await api.memoryImportReport();
    lastReport.value = r.content || "";
  } catch {
    /* 忽略 */
  }
}

async function runPreview(ids?: string[]) {
  busy.value = "preview";
  try {
    preview.value = (await api.memoryImportPreview({ sourceIds: ids })) as unknown as PreviewShape;
    ElMessage.success(`干跑完成：预计新建 ${preview.value.wouldCreate} 条，跳过重复 ${preview.value.skipDuplicate} 条（未写盘）`);
  } catch (e) {
    ElMessage.error((e as Error).message || "干跑失败");
  } finally {
    busy.value = "";
  }
}

async function runImport(ids?: string[]) {
  try {
    await ElMessageBox.confirm(
      "导入会写入记忆库（分批 + 幂等，可中断；游标保证不重复读）。确认执行？",
      "执行导入",
      { type: "warning", confirmButtonText: "开始导入" },
    );
  } catch {
    return;
  }
  busy.value = "import";
  try {
    const r = await api.memoryImportApply({ sourceIds: ids });
    if (r.ok) ElMessage.success(`导入完成：新建 ${r.created} · 跳过 ${r.skipped} · 敏感跳过 ${r.sensitive}`);
    else ElMessage.error(r.message || "导入失败");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "导入失败");
  } finally {
    busy.value = "";
  }
}

async function detect(s: SourceCard) {
  detecting.value = { id: s.id, text: "探测中…" };
  try {
    const r = await api.memoryImportSourceDetect(s.id, s.path);
    detecting.value = { id: s.id, text: JSON.stringify(r.detect, null, 2).slice(0, 4000) };
  } catch (e) {
    detecting.value = { id: s.id, text: (e as Error).message || "探测失败" };
  }
}

function openEdit(s: SourceCard) {
  editSource.value = s;
  editForm.value = { name: s.name, path: s.path, kind: s.kind, enabled: s.enabled, table: s.table || "" };
}

async function saveEdit() {
  const list = sources.value.map((s) =>
    s.id === editSource.value?.id
      ? { ...s, name: editForm.value.name, path: editForm.value.path, kind: editForm.value.kind, enabled: editForm.value.enabled, table: editForm.value.table }
      : s,
  );
  try {
    await api.memoryImportSourceSave(list.map(({ id, name, kind, path, enabled, table }) => ({ id, name, kind, path, enabled, table: table || "" })));
    ElMessage.success("来源已保存（路径写进本机配置，不随同步走）");
    editSource.value = null;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function toggleSource(s: SourceCard) {
  // table 映射必须带上：后端按整份清单重建配置，漏字段等于把用户手填的表名抹掉
  const list = sources.value.map((x) => ({
    id: x.id, name: x.name, kind: x.kind, path: x.path,
    enabled: x.id === s.id ? !x.enabled : x.enabled,
    table: x.table || "",
  }));
  try {
    await api.memoryImportSourceSave(list);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "切换失败");
  }
}

async function resetCursor(s: SourceCard) {
  try {
    await ElMessageBox.confirm(`重置「${s.name}」的增量游标？下次导入将重新扫描该来源（幂等保证不会重复写入）。`, "重置游标", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryImportCursorsReset(s.id);
    ElMessage.success("游标已重置");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "重置失败");
  }
}

async function scanDedup(useModel: boolean) {
  busy.value = "dedup";
  try {
    const r = await api.memoryDedupScan(useModel);
    ElMessage.success(`巡检 ${r.scanned} 条：自动合并 ${r.merged} · 进队列 ${r.queued} · 消耗 ${r.tokens} token`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "巡检失败（可能未配置模型）");
  } finally {
    busy.value = "";
  }
}

async function toggleLayer(layer: "l1" | "l2" | "l4", enabled: boolean) {
  try {
    await api.memoryDedupLayerToggle(layer, enabled);
    ElMessage.success(`${layer.toUpperCase()} 已${enabled ? "开启" : "关闭"}`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "切换失败");
  }
}

async function resolveItem(item: QueueItem, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss") {
  let text: string | undefined;
  if (action === "merge") {
    try {
      const r = await ElMessageBox.prompt("编辑合并后的正文（默认取新记忆内容）", "编辑后合并", {
        inputType: "textarea",
        inputValue: item.payload.newSummary || "",
      });
      text = r.value || "";
    } catch {
      return;
    }
  }
  try {
    await api.memoryDedupReviewResolve(item.id, action, text ? { text } : undefined);
    ElMessage.success("已处理");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  }
}

async function clearPair(pair?: string) {
  try {
    await api.memoryDedupPairsClear(pair);
    ElMessage.success("已清除学习记录");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "清除失败");
  }
}

const sizeText = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

let offEvent: (() => void) | undefined;
onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; phase?: string; done?: number; total?: number };
    if (p.event !== "memory") return;
    if (p.type === "import") {
      const q = p as { created?: number; skipped?: number };
      // created/skipped 用事件载荷的真实值（缺省回落到已有进度），不能硬写 0 盖掉
      progress.value = {
        phase: p.phase || "",
        done: p.done || 0,
        total: p.total || 0,
        created: q.created ?? progress.value?.created ?? 0,
        skipped: q.skipped ?? progress.value?.skipped ?? 0,
        running: p.phase !== "done" && p.phase !== "error",
      };
      if (p.phase === "done") {
        ElMessage.success("导入完成");
        void refresh();
      }
    }
    if (p.type === "dedup") void refresh();
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
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        先把历史记忆搬进来（干跑预览 → 幂等写入），再靠四层漏斗把重复收敛（永不自动删除）
        <MemHelp text="上半区导入：把各 Agent 的历史会话与笔记读成记忆。下半区去重：把重复收敛，但绝不自动删——最坏结果只是留了冗余。" />
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small" :disabled="busy === 'preview'" @click="runPreview()">干跑预览</button>
        <button class="el-button el-button--small el-button--primary" :disabled="busy === 'import'" @click="runImport()">执行导入</button>
        <button class="el-button el-button--small" @click="api.memoryImportCancel().then(() => ElMessage.info('已请求中断（已提交批次不回滚）'))">中断</button>
        <button class="el-button el-button--small" :disabled="busy === 'dedup'" @click="scanDedup(true)">{{ busy === "dedup" ? "巡检中…" : "全库去重巡检" }}</button>
      </div>
    </div>

    <div v-if="progress && progress.running" class="mem-card">
      <div class="mem-row" style="justify-content: space-between; font-size: 12px">
        <span>导入中：{{ progress.phase }} · 已处理 {{ progress.done }}<template v-if="progress.total"> / {{ progress.total }}</template></span>
        <span>新建 {{ progress.created }} · 跳过 {{ progress.skipped }}</span>
      </div>
      <div class="mem-progress" style="margin-top: 8px"><i :style="{ width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 30}%` }"></i></div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        来源探测（{{ sources.filter((s) => s.exists).length }}/{{ sources.length }} 个已找到）
        <MemHelp text="每个来源就是一份历史数据的入口（会话库/日志/笔记目录）。路径写在本机配置里，不随同步走——否则换台电脑就指向不存在的目录了。找不到的来源可「改路径」手填。" />
        <span class="mem-hint">路径写在本机配置，不随 WebDAV 同步（否则会产生指向别机路径的配置）</span>
      </div>
      <div class="mem-grid mem-grid-3">
        <div v-for="s in sources" :key="s.id" class="mem-tile">
          <div class="mem-tile-head">
            <span class="t-name">{{ s.name }}</span>
            <span class="mem-chip" :class="!s.enabled ? '' : s.exists ? 'accent' : 'danger'">
              {{ !s.enabled ? "已忽略" : s.exists ? "✓ 已找到" : "✗ 路径不存在" }}
            </span>
          </div>
          <div class="t-row"><span>路径</span><span class="mem-mono">{{ s.path || "（未指定）" }}</span></div>
          <div class="t-row"><span>格式</span><span>{{ s.kind }}{{ s.kind === "sqlite" ? " · 权威源" : s.kind === "jsonl" ? " · 准实时" : "" }}</span></div>
          <div class="t-row"><span>体量</span><span>{{ s.items }} 项 · {{ sizeText(s.sizeBytes) }}</span></div>
          <div class="t-row"><span>增量</span><span>{{ s.estimate || "—" }}</span></div>
          <div class="mem-tile-foot">
            <button class="el-button el-button--small" @click="runPreview([s.id])">预览</button>
            <button class="el-button el-button--small" :disabled="!s.exists" @click="runImport([s.id])">导入</button>
            <button class="el-button el-button--small" @click="detect(s)">深度探测</button>
            <MemHelp text="读一下来源内部结构（SQLite 有哪些表、JSONL 有哪些字段），用来确认路径填对了、字段能不能自动认出来。" />
            <button class="el-button el-button--small" @click="openEdit(s)">改路径</button>
            <button class="el-button el-button--small" @click="toggleSource(s)">{{ s.enabled ? "忽略" : "启用" }}</button>
            <button class="el-button el-button--small" @click="resetCursor(s)">重置游标</button>
            <MemHelp text="游标记着「这个来源读到哪了」。重置后下次导入会重扫整个来源——因为是幂等写入，已导入过的不会重复入库，只是多花点时间。" />
          </div>
        </div>
      </div>
      <pre v-if="detecting" class="mem-pre" style="margin-top: 10px">{{ detecting.text }}</pre>
    </div>

    <div v-if="preview" class="mem-card">
      <div class="mem-card-title">
        导入预览（干跑，未写入任何文件）
        <MemHelp text="干跑：只解析与试算（新建几条、跳过几条重复、哪些敏感内容被跳过、归到哪些项目），不写任何文件。确认无误再点「确认导入」。" />
        <button class="mem-chip click" @click="runImport()">确认导入 {{ preview.wouldCreate }} 条</button>
      </div>
      <div class="mem-grid mem-grid-6">
        <div class="mem-kpi"><span class="k-label">预计新建</span><span class="k-value">{{ formatInteger(preview.wouldCreate) }}</span></div>
        <div class="mem-kpi"><span class="k-label">合并到已有</span><span class="k-value">{{ formatInteger(preview.wouldMerge) }}</span></div>
        <div class="mem-kpi"><span class="k-label">跳过重复</span><span class="k-value">{{ formatInteger(preview.skipDuplicate) }}</span></div>
        <div class="mem-kpi"><span class="k-label">未归类</span><span class="k-value">{{ formatInteger(preview.classifyFailed) }}</span></div>
        <div class="mem-kpi" :class="{ 'is-warn': preview.sensitive > 0 }"><span class="k-label">敏感跳过</span><span class="k-value">{{ formatInteger(preview.sensitive) }}</span></div>
        <div class="mem-kpi"><span class="k-label">预计体积</span><span class="k-value" style="font-size: 16px">{{ sizeText(preview.estimatedBytes) }}</span></div>
      </div>
      <div class="mem-grid mem-grid-2" style="margin-top: 12px">
        <div>
          <div class="s-title" style="font-size: 11px; color: var(--text-3); margin-bottom: 6px">按项目分组</div>
          <div class="mem-table-wrap">
            <table class="mem-table">
              <tbody>
                <tr v-for="g in preview.groups.slice(0, 12)" :key="g.project">
                <td>{{ g.project }}</td>
                <td class="num">{{ g.count }}</td>
                <td style="color: var(--text-3)">{{ g.source }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="s-title" style="font-size: 11px; color: var(--text-3); margin-bottom: 6px">样例预览（看解析对不对）</div>
          <div v-for="(x, i) in preview.samples" :key="i" class="mem-chain-node">
            <span class="n-title" style="cursor: default">{{ x.title }}</span>
            <span style="margin-left: auto; color: var(--text-3)">{{ x.source }}{{ x.project ? " · " + x.project : "" }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        去重总览
        <span class="mem-hint">去重率 {{ dedup?.dedupRate ?? 0 }}% · 学习记录 {{ dedup?.learnedPairs || 0 }} 对</span>
        <MemHelp text="四层漏斗：L1 逐字哈希（同内容直接跳过）→ L2 文本近似（很像就自动合并，保留信息量大的那条）→ L3 找候选 → L4 让模型判断是新增/更新/重复。层数越深越花 token，所以先拦住简单的。" />
      </div>
      <div class="mem-funnel">
        <div class="mem-funnel-row">
          <span>L1 精确哈希</span>
          <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, ((dedup?.layerCounts.l1 || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.layerCounts.l1 || 0 }} 条</span>
        </div>
        <div class="mem-funnel-row">
          <span>L2 文本近似</span>
          <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, ((dedup?.merged || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.merged || 0 }} 条</span>
        </div>
        <div class="mem-funnel-row">
          <span>L3→L4 判定</span>
          <span class="mem-funnel-bar warn"><i :style="{ width: `${Math.min(100, ((dedup?.queued || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.queued || 0 }} 条</span>
        </div>
        <div class="mem-funnel-row">
          <span>待判队列</span>
          <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, ((dedup?.pending || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.pending || 0 }} 条</span>
        </div>
      </div>
      <div class="mem-row" style="margin-top: 12px; gap: 10px">
        <span class="mem-row" style="gap: 6px">
          <el-switch :model-value="mem.cfg('dedup.l1.enabled', true) !== false" @change="toggleLayer('l1', $event as boolean)" />
          <span class="mem-hint">L1 精确哈希</span>
        </span>
        <span class="mem-row" style="gap: 6px">
          <el-switch :model-value="mem.cfg('dedup.l2.enabled', true) !== false" @change="toggleLayer('l2', $event as boolean)" />
          <span class="mem-hint">L2 近似去重</span>
        </span>
        <span class="mem-row" style="gap: 6px">
          <el-switch :model-value="mem.cfg('dedup.l4.enabled', true) !== false" @change="toggleLayer('l4', $event as boolean)" />
          <span class="mem-hint">L4 语义判定（耗 token）</span>
        </span>
        <span class="mem-chip danger" title="删记忆不可逆，误删代价远大于冗余代价">自动删除：永久关闭</span>
        <MemHelp text="即使模型判定「新记忆更少、可以删旧的」，也一律不自动删——删错不可逆，留冗余只是占点空间。删除动作永远要你在队列里点头。" />
      </div>
      <div class="mem-hint" style="margin-top: 8px">
        今日消耗 {{ formatInteger(dedup?.tokensUsed || 0) }} token · L4 判定失败只跳过本批，不写半成品
        <button class="mem-chip click" style="margin-left: 8px" @click="openModels">配置模型 →</button>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        待确认队列
        <span class="mem-hint">{{ queue.length }} 条 · 低置信 UPDATE 与全部 DELETE 都要人工点头</span>
        <MemHelp text="四选一：采纳新记忆（旧的标失效、可追溯）／保留旧记忆（新的丢弃并把来源并入旧的）／两条都留（记住这一对不是重复，以后不再问）／编辑后合并（你手动拼一条）。" />
      </div>
      <div v-if="queue.length" class="mem-col" style="gap: 10px">
        <div v-for="q in queue" :key="q.id" class="mem-tile">
          <div class="mem-row">
            <span class="mem-chip" :class="q.payload.kind === 'DELETE' ? 'danger' : 'warn'">
              {{ q.payload.kind }}（置信 {{ q.payload.confidence }}）
            </span>
            <span v-if="q.payload.reason" class="mem-hint">{{ q.payload.reason }}</span>
          </div>
          <div class="mem-split-2-1">
            <div class="mem-card" style="background: var(--mem-soft)">
              <div class="s-title" style="font-size: 11px; color: var(--text-3)">已有记忆（旧）</div>
              <div style="font-size: 12px; margin-top: 4px">{{ q.payload.targetTitle || q.payload.targetId }}</div>
              <div class="mem-hint" style="margin-top: 4px">{{ q.payload.targetSummary || "（无摘要）" }}</div>
            </div>
            <div class="mem-card" style="background: var(--mem-soft)">
              <div class="s-title" style="font-size: 11px; color: var(--text-3)">新记忆</div>
              <div style="font-size: 12px; margin-top: 4px">{{ q.payload.newTitle || q.payload.newId }}</div>
              <div class="mem-hint" style="margin-top: 4px">{{ q.payload.newSummary || "（无摘要）" }}</div>
            </div>
          </div>
          <div class="mem-tile-foot">
            <button class="el-button el-button--small el-button--primary" @click="resolveItem(q, 'adoptNew')">采纳新记忆</button>
            <button class="el-button el-button--small" @click="resolveItem(q, 'keepOld')">保留旧记忆</button>
            <button class="el-button el-button--small" @click="resolveItem(q, 'keepBoth')">两条都留</button>
            <button class="el-button el-button--small" @click="resolveItem(q, 'merge')">编辑后合并</button>
            <button class="el-button el-button--small" @click="resolveItem(q, 'dismiss')">忽略</button>
          </div>
        </div>
      </div>
      <div v-else class="mem-empty">队列为空 —— 没有需要人工裁决的重复</div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-card">
        <div class="mem-card-title">
          已判为不重复的记忆对
          <MemHelp text="你选过「两条都留」的记忆对会记在这里，之后不再送去模型判定——这是去重的自我学习，用来省 token。" />
          <span class="mem-inline-ctl">
            <span class="mem-hint">{{ pairs.length }} 对 · 下次同一对不再消耗 token</span>
            <button class="mem-chip click" @click="clearPair()">全部清除</button>
          </span>
        </div>
        <div v-if="pairs.length" class="mem-col" style="gap: 6px; max-height: 220px; overflow: auto">
          <div v-for="(p, i) in pairs.slice(0, 30)" :key="i" class="mem-chain-node">
            <span class="n-title" style="cursor: default">{{ p.aTitle || p.a }}</span>
            <span style="color: var(--text-3)">≠</span>
            <span class="n-title" style="cursor: default">{{ p.bTitle || p.b }}</span>
            <button class="mem-chip click" style="margin-left: auto" @click="clearPair(`${p.a}|${p.b}`)">清除</button>
          </div>
        </div>
        <div v-else class="mem-empty">还没有"两条都留"的判断记录</div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">最近导入报告</div>
        <pre v-if="lastReport" class="mem-pre">{{ lastReport }}</pre>
        <div v-else class="mem-empty">还没有导入报告</div>
      </div>
    </div>

    <!-- 来源编辑抽屉 -->
    <Teleport to="body">
      <div class="memory-scope">
        <div class="mem-drawer-mask" :class="{ show: !!editSource }" @click="editSource = null"></div>
        <aside class="mem-drawer" :class="{ show: !!editSource }">
          <div class="mem-drawer-head">
            <h3 style="margin: 0; font-size: 15px">编辑来源：{{ editSource?.name }}</h3>
            <button class="mem-chip click" @click="editSource = null">✕</button>
          </div>
          <div class="mem-drawer-body">
            <div class="mem-section">
              <div class="s-title">名称</div>
              <input v-model="editForm.name" class="el-input__inner" />
            </div>
            <div class="mem-section">
              <div class="s-title">路径（文件或目录）</div>
              <input v-model="editForm.path" class="el-input__inner" placeholder="如 ~/.codex/sessions" />
              <div class="mem-hint">支持 ~ 与 %ENV% 变量；不确定就先「深度探测」看能不能读到</div>
            </div>
            <div class="mem-section">
              <div class="s-title">格式</div>
              <select v-model="editForm.kind" class="el-input__inner">
                <option value="sqlite">SQLite（会话库）</option>
                <option value="jsonl">JSONL（会话日志）</option>
                <option value="md">Markdown（笔记目录）</option>
              </select>
            </div>
            <div class="mem-section">
              <div class="s-title">SQLite 表名（可选）</div>
              <input v-model="editForm.table" class="el-input__inner" placeholder="留空 = 自动按列名签名识别消息表" />
            </div>
            <label class="mem-row" style="gap: 8px">
              <el-switch v-model="editForm.enabled" />
              <span class="mem-hint">启用该来源</span>
            </label>
          </div>
          <div class="mem-drawer-foot">
            <button class="el-button el-button--small el-button--primary" @click="saveEdit">保存</button>
            <button class="el-button el-button--small" @click="editSource = null">取消</button>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>
