<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 导入与去重：点「导入」自动先干跑再确认（无需两步走）+ 去重强度三档 + 人工裁决在「待确认」收件箱 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemSelect from "../../components/memory/MemSelect.vue";
import MemDialog from "../../components/memory/MemDialog.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";

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

const sources = ref<SourceCard[]>([]);
const preview = ref<PreviewShape | null>(null);
const dedup = ref<DedupStatus | null>(null);
const queueCount = ref(0);
const pairs = ref<{ a: string; b: string; aTitle: string; bTitle: string }[]>([]);
const progress = ref<{ phase: string; done: number; total: number; created: number; skipped: number; running: boolean } | null>(null);
const busy = ref("");
const detecting = ref<{ id: string; text: string } | null>(null);
const editSource = ref<SourceCard | null>(null);
/** 弹窗开关与选中的来源分开：关闭动画跑完后才清 editSource，标题才不会提前变空 */
const editOpen = ref(false);
const detectOpen = ref(false);
const editForm = ref({ name: "", path: "", kind: "jsonl", enabled: true, table: "" });
const lastReport = ref("");
const previewOpen = ref(false);
const pairsOpen = ref(false);
const reportOpen = ref(false);
/** 去重四层漏斗：默认收起，避免占一屏 */
const funnelOpen = ref(false);

/** 模型与网关是配置页的子板块：留跳转提示后进配置页 */
function openModels() {
  mem.configTabHint = "__models__";
  app.openModuleConfig();
}

/** 干跑后预览卡底部的内联确认条状态（比 MessageBox 更直观，不弹遮挡） */
const dryrunConfirm = ref<{ ids?: string[]; wouldCreate: number } | null>(null);

/** 去重强度三档（映射到 L1/L2/L4 三个开关，用户不必知道分层细节） */
type Strength = "off" | "standard" | "deep";
const dedupStrength = computed<Strength>(() => {
  const l1 = mem.cfg("dedup.l1.enabled", true) !== false;
  const l2 = mem.cfg("dedup.l2.enabled", true) !== false;
  const l4 = mem.cfg("dedup.l4.enabled", true) !== false;
  if (!l1 && !l2 && !l4) return "off";
  return l4 ? "deep" : "standard";
});
const STRENGTH_TEXT: Record<Strength, string> = {
  off: "关闭（不做任何去重）",
  standard: "标准（本地近似判重，零成本）",
  deep: "深度（含语义判定，耗 token）",
};

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
    queueCount.value = (await api.memoryDedupReviewList()).items.length;
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

/** 导入进度弹窗：导入是长任务（分批 + 幂等 + 可中断），进度走真实 done/total，
    结束后把新建/合并/跳过/敏感跳过一起显示在弹窗里，不靠 toast 一闪而过 */
const importOpen = ref(false);
const importStartedAt = ref(0);
const importScope = ref("");
const importResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);
/** 干跑阶段也进弹窗：大来源的扫描要几秒到几十秒，没有反馈会以为点了没反应 */
const importPhase = ref("");

/**
 * 导入：点一次触发干跑；干跑结果写到下方「导入预览」卡，并出内联确认条。
 * 用户在卡里点「确认导入 N 条」才真正写入；点「取消」则丢弃本次确认（预览卡仍保留供查看）。
 */
async function runImport(ids?: string[]) {
  const scope = ids?.length === 1 ? `「${sources.value.find((s) => s.id === ids[0])?.name || "该来源"}」` : "全部已启用来源";
  importScope.value = scope;
  importStartedAt.value = Date.now();
  importPhase.value = "干跑预览（不写入，只算清楚会变成什么样）";
  importResult.value = null;
  importOpen.value = true;
  busy.value = "preview";
  dryrunConfirm.value = null;
  try {
    const pv = (await api.memoryImportPreview({ sourceIds: ids })) as unknown as PreviewShape;
    preview.value = pv;
    // 干跑完成 → 关掉进度弹窗，把决策权交给预览卡底部的内联确认条
    importOpen.value = false;
    dryrunConfirm.value = { ids, wouldCreate: pv.wouldCreate + pv.wouldMerge };
  } catch (e) {
    importResult.value = { ok: false, message: `干跑失败：${(e as Error).message || e}` };
  } finally {
    busy.value = "";
  }
}

/** 预览卡内联确认：开始真正写入 */
async function confirmApply() {
  const ids = dryrunConfirm.value?.ids;
  dryrunConfirm.value = null;
  importStartedAt.value = Date.now();
  importPhase.value = "写入记忆库（分批提交，幂等可重跑）";
  importResult.value = null;
  importOpen.value = true;
  busy.value = "import";
  try {
    const r = await api.memoryImportApply({ sourceIds: ids });
    importResult.value = r.ok
      ? {
          ok: true,
          message: "导入完成",
          extra: [
            `新建 ${r.created} 条 · 跳过 ${r.skipped} 条 · 敏感跳过 ${r.sensitive} 条`,
            r.merged ? `合并到已有 ${r.merged} 条` : "",
            r.report ? `导入报告：${r.report}` : "",
          ].filter(Boolean) as string[],
        }
      : { ok: false, message: r.message || "导入失败" };
    await refresh();
  } catch (e) {
    importResult.value = { ok: false, message: (e as Error).message || "导入失败" };
  } finally {
    busy.value = "";
  }
}

/** 全库去重巡检：同样走进度弹窗（耗 token，可能跑很久） */
const scanOpen = ref(false);
const scanStartedAt = ref(0);
const scanResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);

async function detect(s: SourceCard) {
  detecting.value = { id: s.id, text: "探测中…" };
  detectOpen.value = true;
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
  editOpen.value = true;
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
    editOpen.value = false;
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

/** 来源卡动作菜单：卡上只留「导入该来源」，其余低频/排障动作收进 ⋯ */
function sourceAction(s: SourceCard, cmd: string) {
  if (cmd === "edit") openEdit(s);
  else if (cmd === "toggle") void toggleSource(s);
  else if (cmd === "cursor") void resetCursor(s);
  else if (cmd === "detect") void detect(s);
}

async function scanDedup() {
  busy.value = "dedup";
  scanStartedAt.value = Date.now();
  scanResult.value = null;
  scanOpen.value = true;
  try {
    const r = await api.memoryDedupScan(true);
    scanResult.value = {
      ok: true,
      message: `巡检完成：共扫 ${r.scanned} 条`,
      extra: [`自动合并 ${r.merged} 条`, `进人工队列 ${r.queued} 条`, `消耗 ${r.tokens} token`],
    };
    await refresh();
  } catch (e) {
    scanResult.value = { ok: false, message: (e as Error).message || "巡检失败（可能未配置模型）" };
  } finally {
    busy.value = "";
  }
}

async function setStrength(s: Strength) {
  try {
    await api.memoryDedupLayerToggle("l1", s !== "off");
    await api.memoryDedupLayerToggle("l2", s !== "off");
    await api.memoryDedupLayerToggle("l4", s === "deep");
    ElMessage.success(`去重强度已设为「${STRENGTH_TEXT[s]}」`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "切换失败");
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

/** 后端事件里的阶段名 → 弹窗上给用户看的中文（不暴露内部英文阶段码） */
const PHASE_TEXT: Record<string, string> = {
  scan: "扫描来源（找出新增内容）",
  preview: "解析来源内容",
  commit: "写入记忆库（分批提交）",
  verify: "校验写入结果",
  done: "导入完成",
  error: "出错了",
};

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
      // 事件驱动的进度回灌弹窗：导入是后端在跑，前端只负责如实显示它报的数
      if (importOpen.value) {
        if (p.phase && p.phase !== "done" && p.phase !== "error") {
          importPhase.value = PHASE_TEXT[p.phase] || p.phase;
        }
      }
      if (p.phase === "done") void refresh();
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
        把各 Agent 的历史会话导入为记忆；先干跑出摘要，确认后才写入
        <MemHelp text="导入是幂等的：同一个来源重复导入不会写入重复内容（按内容指纹判重）。去重分四层——精确哈希、文本近似、候选召回、AI 判定；层数越深越花 token，所以按强度一键切换。" />
      </p>
      <div class="mem-head-actions">
        <button class="btn btn-ghost" :disabled="busy === 'dedup'" @click="scanDedup">{{ busy === "dedup" ? "巡检中…" : "全库去重巡检" }}</button>
        <button class="btn btn-cta" :disabled="busy === 'import' || busy === 'preview'" @click="runImport()">
          {{ busy === "import" ? "导入中…" : busy === "preview" ? "干跑中…" : "导入全部来源" }}
        </button>
      </div>
    </div>

    <!-- 导入/巡检的进行态都在各自弹窗里（原来这里有一张内联进度卡，与弹窗重复） -->
    <div v-if="progress?.running" class="mem-card">
      <div class="mem-row" style="justify-content: space-between; font-size: 12px">
        <span>后台导入中：{{ progress.phase }} · 已处理 {{ progress.done }}<template v-if="progress.total"> / {{ progress.total }}</template></span>
        <span class="mem-inline-ctl">
          <span>新建 {{ progress.created }} · 跳过 {{ progress.skipped }}</span>
          <button class="mem-chip click" @click="importOpen = true">查看进度</button>
        </span>
      </div>
      <div class="mem-progress" style="margin-top: 8px"><i :style="{ width: `${progress.total ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 30}%` }"></i></div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        来源探测（{{ sources.filter((s) => s.exists).length }}/{{ sources.length }} 个已找到）
        <MemHelp text="每个来源就是一份历史数据的入口（会话库/日志/笔记目录）。路径写在本机配置里，不随同步走——否则换台电脑就指向不存在的目录了。找不到的来源可「改路径」手填。" />
        <span class="mem-hint">路径写在本机配置，不随 WebDAV 同步</span>
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
          <div class="t-row"><span>格式</span><span>{{ s.kind === "sqlite" ? "SQLite 会话库" : s.kind === "jsonl" ? "JSONL 会话日志" : s.kind === "md" ? "Markdown 笔记目录" : s.kind }}{{ s.kind === "sqlite" ? " · 权威源" : s.kind === "jsonl" ? " · 准实时" : "" }}</span></div>
          <div class="t-row"><span>体量</span><span>{{ s.items }} 项 · {{ sizeText(s.sizeBytes) }}</span></div>
          <div class="t-row"><span>增量</span><span>{{ s.estimate || "—" }}</span></div>
          <div class="mem-tile-foot">
            <button class="btn btn-cta" :disabled="!s.exists || !!busy" @click="runImport([s.id])">导入该来源</button>
            <el-dropdown trigger="click" @command="(c: string) => sourceAction(s, c)">
              <button class="mem-chip click">⋯</button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">改路径 / 格式</el-dropdown-item>
                  <el-dropdown-item command="toggle">{{ s.enabled ? "忽略该来源" : "启用该来源" }}</el-dropdown-item>
                  <el-dropdown-item command="cursor">重置增量游标</el-dropdown-item>
                  <el-dropdown-item command="detect" divided>深度探测（看内部结构）</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <MemHelp text="深度探测：读一下来源内部结构（SQLite 有哪些表、JSONL 有哪些字段），用来确认路径填对了。重置游标：下次导入重扫整个来源（幂等写入不会重复入库）。" />
          </div>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        导入预览（最近一次干跑，未写入任何文件）
        <span class="mem-hint mem-inline-ctl">
          <button class="mem-chip click" @click="previewOpen = !previewOpen">{{ previewOpen ? "收起" : "展开详情" }}</button>
        </span>
      </div>
      <div v-if="preview" class="mem-grid mem-grid-6">
        <div class="mem-kpi"><span class="k-label">预计新建</span><span class="k-value">{{ formatInteger(preview.wouldCreate) }}</span></div>
        <div class="mem-kpi"><span class="k-label">合并到已有</span><span class="k-value">{{ formatInteger(preview.wouldMerge) }}</span></div>
        <div class="mem-kpi"><span class="k-label">跳过重复</span><span class="k-value">{{ formatInteger(preview.skipDuplicate) }}</span></div>
        <div class="mem-kpi"><span class="k-label">未归类</span><span class="k-value">{{ formatInteger(preview.classifyFailed) }}</span></div>
        <div class="mem-kpi" :class="{ 'is-warn': preview.sensitive > 0 }">
          <span class="k-label">
            敏感跳过
            <MemHelp text="疑似密钥 / 证件号 / 手机号这类敏感内容（按内置规则识别）：跳过、不落库。规则可在 配置 · 隐私 调整。" />
          </span>
          <span class="k-value">{{ formatInteger(preview.sensitive) }}</span>
        </div>
        <div class="mem-kpi"><span class="k-label">预计体积</span><span class="k-value" style="font-size: 16px">{{ sizeText(preview.estimatedBytes) }}</span></div>
      </div>
      <div v-else class="mem-empty">还没有干跑过 —— 点上方「导入全部来源」会先干跑、再在卡片底部出确认条</div>

      <!-- 干跑后的内联确认条：替代 MessageBox，决策与摘要在同一张卡里 -->
      <div v-if="preview && dryrunConfirm" class="mem-banner" style="margin-top: 12px">
        ✓ 干跑完成：共 {{ formatInteger(dryrunConfirm.wouldCreate) }} 条会写入记忆库（分批提交，幂等可中断）。
        <span class="b-grow"></span>
        <button class="btn btn-cta" :disabled="!!busy" @click="confirmApply">确认导入 {{ formatInteger(dryrunConfirm.wouldCreate) }} 条</button>
        <button class="btn btn-ghost" @click="dryrunConfirm = null">取消</button>
      </div>
      <div v-if="preview && previewOpen" class="mem-grid mem-grid-2" style="margin-top: 12px">
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
        去重
        <span class="mem-hint">去重率 {{ dedup?.dedupRate ?? 0 }}% · 学习记录 {{ dedup?.learnedPairs || 0 }} 对 · 今日 {{ formatInteger(dedup?.tokensUsed || 0) }} token</span>
        <span class="mem-inline-ctl">
          <button class="mem-chip click" :class="queueCount ? 'warn' : ''" @click="mem.gotoReview('dedup')">{{ queueCount }} 条待裁决 →</button>
          <MemHelp text="四层漏斗：第 1 层精确哈希（同内容直接跳过）→ 第 2 层文本近似（很像就自动合并）→ 第 3 层候选召回（在索引里挑出可能重复的候选）→ 第 4 层 AI 判定（让模型判断是新增/更新/重复）。强度越高越准、也越花 token；判定拿不准的进「待确认」由你裁决。删除动作永不自动执行。" />
        </span>
      </div>
      <div class="mem-row" style="gap: 10px; flex-wrap: wrap">
        <span class="mem-row" style="gap: 6px">
          <span class="mem-hint">强度</span>
          <span
            v-for="s in (['off', 'standard', 'deep'] as Strength[])"
            :key="s"
            class="mem-chip click"
            :class="dedupStrength === s ? 'accent' : ''"
            role="radio"
            :aria-checked="dedupStrength === s"
            @click="setStrength(s)"
          >
            {{ s === "off" ? "关闭" : s === "standard" ? "标准" : "深度（耗 token）" }}
          </span>
        </span>
        <span class="mem-chip danger" title="删记忆不可逆，误删代价远大于冗余代价">自动删除：永久关闭</span>
        <button class="mem-chip click" style="margin-left: auto" @click="funnelOpen = !funnelOpen">
          {{ funnelOpen ? "收起漏斗" : "查看漏斗" }}
        </button>
      </div>
      <div v-if="funnelOpen" class="mem-funnel" style="margin-top: 12px">
        <div class="mem-funnel-row">
          <span>第 1 层 精确哈希<MemHelp text="内容逐字相同 → 自动跳过（零成本）。" /></span>
          <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, ((dedup?.layerCounts.l1 || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.layerCounts.l1 || 0 }} 条</span>
        </div>
        <div class="mem-funnel-row">
          <span>第 2 层 文本近似<MemHelp text="内容高度相似 → 自动合并（零成本、不上模型）。" /></span>
          <span class="mem-funnel-bar"><i :style="{ width: `${Math.min(100, ((dedup?.merged || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.merged || 0 }} 条</span>
        </div>
        <div class="mem-funnel-row">
          <span>第 3 层 候选召回<MemHelp text="在索引里挑出可能重复的候选，给下一层判。" /></span>
          <span class="mem-funnel-bar"><i style="width: 60%"></i></span>
          <span style="text-align: right">—</span>
        </div>
        <div class="mem-funnel-row">
          <span>第 4 层 AI 判定<MemHelp text="调用模型判断是新增 / 更新 / 重复；耗 token，拿不准的进「待确认」等你点头。" /></span>
          <span class="mem-funnel-bar warn"><i :style="{ width: `${Math.min(100, ((dedup?.queued || 0) / Math.max(1, dedup?.total || 1)) * 100)}%` }"></i></span>
          <span style="text-align: right">{{ dedup?.queued || 0 }} 条</span>
        </div>
      </div>
      <div class="mem-hint" style="margin-top: 8px">
        L4 判定失败只跳过本批，不写半成品
        <button class="mem-chip click" style="margin-left: 8px" @click="openModels">配置模型 →</button>
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div class="mem-card">
        <div class="mem-card-title">
          已判为不重复的记忆对
          <MemHelp text="你选过「两条都留」的记忆对会记在这里，之后不再送去模型判定——这是去重的自我学习，用来省 token。" />
          <span class="mem-hint mem-inline-ctl">
            {{ pairs.length }} 对
            <button class="mem-chip click" @click="pairsOpen = !pairsOpen">{{ pairsOpen ? "收起" : "展开" }}</button>
            <button v-if="pairs.length" class="mem-chip click" @click="clearPair()">全部清除</button>
          </span>
        </div>
        <div v-if="pairsOpen && pairs.length" class="mem-col" style="gap: 6px; max-height: 220px; overflow: auto">
          <div v-for="(p, i) in pairs.slice(0, 30)" :key="i" class="mem-chain-node">
            <span class="n-title" style="cursor: default">{{ p.aTitle || p.a }}</span>
            <span style="color: var(--text-3)">≠</span>
            <span class="n-title" style="cursor: default">{{ p.bTitle || p.b }}</span>
            <button class="mem-chip click" style="margin-left: auto" @click="clearPair(`${p.a}|${p.b}`)">清除</button>
          </div>
        </div>
        <div v-else-if="!pairs.length" class="mem-empty">还没有"两条都留"的判断记录</div>
      </div>

      <div class="mem-card">
        <div class="mem-card-title">
          最近导入报告
          <span class="mem-inline-ctl">
            <button class="mem-chip click" @click="reportOpen = !reportOpen">{{ reportOpen ? "收起" : "展开" }}</button>
          </span>
        </div>
        <pre v-if="reportOpen && lastReport" class="mem-pre">{{ lastReport }}</pre>
        <div v-else-if="!lastReport" class="mem-empty">还没有导入报告</div>
      </div>
    </div>

    <!-- 来源编辑弹窗（与全模块弹窗统一：MemDialog；原来是自绘侧滑抽屉，样式与设置弹窗不一致） -->
    <MemDialog v-model:open="editOpen" :title="`编辑来源：${editSource?.name || ''}`" sub="路径写进本机配置，不随同步走" width="560px">
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">名称</div>
          <input v-model="editForm.name" class="f-input" />
        </div>
        <div class="mem-section">
          <div class="s-title">路径（文件或目录）</div>
          <input v-model="editForm.path" class="f-input" placeholder="如 ~/.codex/sessions" />
          <div class="mem-hint">支持 ~ 与 %ENV% 变量；不确定就先「深度探测」看能不能读到</div>
        </div>
        <div class="mem-section">
          <div class="s-title">格式</div>
          <MemSelect
            v-model="editForm.kind"
            :options="[
              { value: 'sqlite', label: 'SQLite（会话库）' },
              { value: 'jsonl', label: 'JSONL（会话日志）' },
              { value: 'md', label: 'Markdown（笔记目录）' },
            ]"
          />
        </div>
        <div class="mem-section">
          <div class="s-title">SQLite 表名（可选）</div>
          <input v-model="editForm.table" class="f-input" placeholder="留空 = 自动按列名签名识别消息表" />
        </div>
        <label class="mem-row" style="gap: 8px">
          <div class="switch" :class="{ on: editForm.enabled }" role="switch" :aria-checked="!!editForm.enabled" @click="editForm.enabled = !editForm.enabled"></div>
          <span class="mem-hint">启用该来源</span>
        </label>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="saveEdit">保存</button>
        <button class="btn btn-ghost" @click="editOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 深度探测结果弹窗（原来是一段内联 pre，把来源卡片越撑越长） -->
    <MemDialog v-model:open="detectOpen" title="深度探测结果" sub="看看这个来源内部有哪些表/字段，用来确认路径填对了" width="760px">
      <pre class="mem-pre">{{ detecting?.text || "（无内容）" }}</pre>
      <template #foot>
        <button class="btn btn-ghost" @click="detectOpen = false">关闭</button>
      </template>
    </MemDialog>

    <!-- 导入进度：干跑 → 确认 → 写入，全过程与结果都在这一个弹窗里 -->
    <MemProgressDialog
      v-model:open="importOpen"
      :title="`导入记忆 · ${importScope}`"
      sub="分批写入、幂等可重跑；中途可中断（已提交批次不回滚）"
      :running="!!busy"
      :phase="importPhase"
      :detail="progress?.running ? `新建 ${progress.created} · 跳过 ${progress.skipped}` : ''"
      :done="progress?.done || 0"
      :total="progress?.total || 0"
      :started-at="importStartedAt"
      :result="importResult"
      cancel-text="中断导入"
      @cancel="() => api.memoryImportCancel().then(() => ElMessage.info('已请求中断（已提交批次不回滚）'))"
    />

    <!-- 全库去重巡检进度 -->
    <MemProgressDialog
      v-model:open="scanOpen"
      title="全库去重巡检"
      sub="本地哈希 → 文本近似 → 语义判定，逐条比对已有记忆"
      :running="busy === 'dedup'"
      phase="比对全库内容并调用模型判定"
      :started-at="scanStartedAt"
      :result="scanResult"
    />
  </div>
</template>
