<!--
  ============================================================
   作者：沐晖
   日期：2026-10-24
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!--
  AgentHub · 提示词库（Prompt Library）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 提示词库 · 优化历史（独立页签）：页头（状态 + 清空）→ 筛选 chips → 历史条目网格（宽屏两列，窄屏单列）。
     原先是优化页右侧的折叠抽屉，改版后独立成页：整页宽度放得下完整原文与操作，不再挤压优化主视图。
     §8.1 历史侧异常在本页落地：33 只保留最近 N 次 · 34 截断记录禁回填只可复制 · 36 失败留痕可筛选
     37 风格名快照 · 38 savedToLibrary 失效提示 · 39 清空二次确认（35/40 文件裁剪与损坏重建由后端负责）。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { usePromptsStore } from "../../stores/prompts";
import { pipc, type PromptHistoryItem } from "./promptTypes";
import { copyText, firstLine, formatElapsed } from "./promptUtil";
import { timeAgo } from "../../composables/useFormat";

const app = useAppStore();
const prompts = usePromptsStore();

const rootEl = ref<HTMLElement | null>(null);
/** 本页的滚动容器就是根元素（带框架 .page，overflow:auto）。
 *  切换筛选后必须滚回顶部：从「全部 50 条」切到「失败 2 条」时若停在原位，屏幕里只剩一片空白。 */
function scrollToTop() {
  const el = rootEl.value;
  if (el && el.scrollTop !== 0) el.scrollTop = 0;
}

const historyFilter = ref<"all" | "ok" | "fail" | "saved">("all");

/** 列表三态（loading / error / rows 互斥）：store.loadHistory() 把异常吞掉了，
 *  页面无从区分「一条都没有」和「读取失败」——失败时会一直显示空态，用户以为历史丢了。
 *  初值必须是 true：reloadHistory 在 onMounted 里才跑，而首帧渲染在它之前，
 *  初值给 false 会让第一帧先落到下面的空态分支，闪一下「还没有优化记录」。 */
const loading = ref(true);
const loadError = ref("");
let loadSeq = 0;
async function reloadHistory() {
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const r = await pipc.promptsHistoryList();
    if (seq !== loadSeq) return; // 旧响应晚到：丢弃，不覆盖新结果
    prompts.history = r.items || [];
  } catch (e) {
    if (seq !== loadSeq) return;
    loadError.value = (e as Error).message || "读取优化历史失败";
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

/** 每行预先算好状态徽标与「能否回填」：模板里同一条要读三处，算一次比每次重渲染都算三遍便宜 */
const historyRows = computed(() => {
  const list = prompts.history;
  const picked =
    historyFilter.value === "ok" ? list.filter((h) => !h.error)
      : historyFilter.value === "fail" ? list.filter((h) => !!h.error)
        : historyFilter.value === "saved" ? list.filter((h) => !!h.savedToLibrary)
          : list;
  return picked.map((h) => ({ item: h, state: historyState(h), restorable: canRestore(h) }));
});

watch(historyFilter, scrollToTop);

/** 状态徽标：失败 > 已存库 > 成功（同一时刻三者互斥，口径与筛选 chips 一致） */
function historyState(h: PromptHistoryItem): { label: string; cls: string } {
  if (h.error) return { label: "失败", cls: "danger" };
  if (h.savedToLibrary) return { label: "已存库", cls: "accent" };
  return { label: "成功", cls: "" };
}
/** 截断过的记录禁止回填：把残缺文本写回编辑器等于悄悄弄坏用户的原文（§8.1 第 34 条） */
function canRestore(h: PromptHistoryItem): boolean {
  return !h.inputTruncated && !h.outputTruncated;
}
/** 回填：把原文与结果暂存进 store，切到优化页由它取走（优化页不接收 props，落点靠 store 传递） */
function restoreHistory(h: PromptHistoryItem) {
  if (!canRestore(h)) {
    ElMessage.warning("该条过长已被截断，不可完整回填；可复制内容后自行粘贴");
    return;
  }
  prompts.draft = {
    input: h.inputText,
    output: h.outputText,
    styleName: h.styleName,
    model: h.model,
    elapsedMs: h.elapsedMs,
    tokens: h.tokens,
  };
  app.setPage("optimize");
  ElMessage.success("已回填到「优化提示词」编辑器");
}
async function deleteHistory(h: PromptHistoryItem) {
  // 历史删掉不可恢复（后端不保留回收站），所以与库页的单条删除保持同一口径：先确认再删
  try {
    await ElMessageBox.confirm("删除这条优化历史？该操作不可撤销。", "删除历史", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch { return; }
  try {
    await pipc.promptsHistoryDelete({ id: h.id });
    await reloadHistory();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}
async function clearHistory() {
  try {
    await ElMessageBox.confirm(`清空全部 ${prompts.history.length} 条优化历史？该操作不可撤销。`, "清空优化历史", { type: "warning" });
  } catch { return; }
  try {
    await pipc.promptsHistoryClear();
    await reloadHistory();
    ElMessage.success("优化历史已清空");
  } catch (e) {
    ElMessage.error((e as Error).message || "清空失败");
  }
}
/** 历史里「已存库」的失效引用：条目可能已被删除，点击要给出明确解释（§8.1 第 38 条） */
function openSaved(h: PromptHistoryItem) {
  if (!h.savedToLibrary) return;
  const hit = prompts.items.find((i) => i.id === h.savedToLibrary);
  if (!hit) { ElMessage.warning("该历史指向的条目已不存在（可能已被删除）"); return; }
  prompts.openDetail(hit.id);
}

onMounted(async () => {
  // init() 只订阅一次主进程事件（契约 §4.4），别处产生新历史（优化页跑完一轮）会自动合流刷新
  prompts.init();
  await Promise.all([reloadHistory(), prompts.loadLibrary()]);
});
</script>

<template>
  <div ref="rootEl" class="page prompts-scope">
    <!-- 页头：状态与清空 -->
    <div class="pr-card">
      <div class="pr-head">
        <div class="pr-head-main">
          <div class="pr-card-title">
            <i class="ph ph-clock-counter-clockwise"></i>优化历史
            <span class="pr-chip">{{ prompts.history.length }} / {{ prompts.cfg.historyLimit }}</span>
          </div>
          <div class="pr-hint">
            每次优化都会在这里留痕（含失败记录，便于区分是模型问题还是网络问题）；仅保留最近
            {{ prompts.cfg.historyLimit }} 次，本机记录，不参与同步。
          </div>
        </div>
        <div class="pr-head-actions">
          <button class="btn btn-outline danger btn-sm" :disabled="!prompts.history.length" @click="clearHistory">
            <i class="ph ph-broom"></i>清空
          </button>
        </div>
      </div>

      <div class="pr-row" style="margin-top: 10px">
        <span class="pr-chip click" :class="{ accent: historyFilter === 'all' }" @click="historyFilter = 'all'">全部 {{ prompts.historyCounts.all }}</span>
        <span class="pr-chip click" :class="{ accent: historyFilter === 'ok' }" @click="historyFilter = 'ok'">成功 {{ prompts.historyCounts.ok }}</span>
        <span class="pr-chip click" :class="{ accent: historyFilter === 'fail' }" @click="historyFilter = 'fail'">失败 {{ prompts.historyCounts.fail }}</span>
        <span class="pr-chip click" :class="{ accent: historyFilter === 'saved' }" @click="historyFilter = 'saved'">已存库 {{ prompts.historyCounts.saved }}</span>
      </div>
    </div>

    <!-- 加载中：与空态互斥，否则首帧会先闪一下「还没有优化记录」 -->
    <div v-if="loading && !prompts.history.length" class="pr-card">
      <div class="pr-empty"><i class="ph ph-circle-notch"></i><div>正在读取优化历史…</div></div>
    </div>

    <!-- 读取失败且没有任何可展示的数据：给出重试入口（store.loadHistory 吞异常，这里自己兜底） -->
    <div v-else-if="loadError && !prompts.history.length" class="pr-card">
      <div class="pr-empty">
        <i class="ph ph-warning-circle"></i>
        <div class="es-title">优化历史读取失败</div>
        <div>{{ loadError }}</div>
        <div class="pr-row" style="margin-top: 8px; justify-content: center">
          <button class="btn btn-ghost btn-sm" @click="reloadHistory">重试</button>
        </div>
      </div>
    </div>

    <!-- 条目网格 + 托底：末尾明确「已显示全部」，否则用户会以为下面还有内容 -->
    <template v-else-if="historyRows.length">
      <div v-if="loadError" class="pr-card">
        <div class="pr-row">
          <i class="ph ph-warning-circle"></i>
          <span class="pr-warn-inline">列表可能不是最新的：{{ loadError }}</span>
          <span class="pr-inline-ctl">
            <button class="btn btn-ghost btn-sm" @click="reloadHistory">重试</button>
          </span>
        </div>
      </div>
      <div class="pr-hist-grid">
        <div v-for="row in historyRows" :key="row.item.id" class="pr-hist-item" @click="restoreHistory(row.item)">
          <div class="l1">
            <span class="pr-chip" :class="row.state.cls">{{ row.state.label }}</span>
            <span>{{ timeAgo(row.item.at) }}</span>
            <span class="pr-mono" style="margin-left: auto">{{ formatElapsed(row.item.elapsedMs) }}</span>
          </div>
          <div class="l2" :title="row.item.inputText">{{ firstLine(row.item.inputText) || "（无原文）" }}</div>
          <div class="l1">
            <span class="pr-hint">{{ row.item.styleName }} · {{ row.item.model || "跟随默认" }}</span>
          </div>
          <div class="l3">
            <button class="btn btn-ghost btn-sm" :disabled="!row.restorable" @click.stop="restoreHistory(row.item)">回填</button>
            <button class="btn btn-ghost btn-sm" :disabled="!row.item.outputText" @click.stop="copyText(row.item.outputText, '结果')">复制</button>
            <button v-if="row.item.savedToLibrary" class="btn btn-ghost btn-sm" @click.stop="openSaved(row.item)">打开条目</button>
            <button class="btn btn-ghost btn-sm" style="margin-left: auto" @click.stop="deleteHistory(row.item)">删除</button>
          </div>
          <div v-if="!row.restorable" class="pr-warn-inline">该条过长已截断，不可完整回填（可复制）</div>
          <div v-else-if="row.item.error" class="pr-warn-inline">失败：{{ row.item.error }}</div>
        </div>
      </div>
      <div class="pr-hint" style="margin-top: 10px; text-align: center">
        {{ historyFilter === "all" ? `已显示全部 ${prompts.history.length} 条` : `当前筛选 ${historyRows.length} 条 · 共 ${prompts.history.length} 条` }}
      </div>
    </template>

    <!-- 空态：区分「一条都没有」和「筛没了」 -->
    <div v-else class="pr-card">
      <div class="pr-empty">
        <i class="ph ph-clock-counter-clockwise"></i>
        <div class="es-title">{{ prompts.history.length ? "该筛选下没有记录" : "还没有优化记录" }}</div>
        <div>{{ prompts.history.length ? "换个筛选条件试试。" : "去「优化提示词」跑一次优化，记录就会出现在这里；失败也会记录。" }}</div>
        <div class="pr-row" style="margin-top: 8px; justify-content: center">
          <button v-if="!prompts.history.length" class="btn btn-cta btn-sm" @click="app.setPage('optimize')">
            <i class="ph ph-magic-wand"></i>去优化提示词
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
