<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 待确认收件箱：三类人工裁决集中一处（事实失效 / 项目归类 / 去重），
     AI 只建议不自动改，这里是你唯一必须做决定的地方 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "review");

type SupersedeItem = {
  id: string;
  payload: { oldId: string; newId?: string; confidence: number; reason: string; oldTitle?: string; newTitle?: string; project?: string };
};
type ClassifyItem = {
  id: string;
  payload: { memoryId: string; slug?: string; name?: string; score?: number; candidate?: string; title?: string; path?: string };
};
type DedupItem = {
  id: string;
  payload: { kind: string; newId: string; targetId: string; confidence: number; reason: string; newTitle?: string; targetTitle?: string; newSummary?: string; targetSummary?: string };
};

const tab = ref<"supersede" | "classify" | "dedup">("supersede");
const supersede = ref<SupersedeItem[]>([]);
const classify = ref<ClassifyItem[]>([]);
const dedup = ref<DedupItem[]>([]);
const busy = ref("");
const loadedOnce = ref(false);

const counts = computed(() => ({
  supersede: supersede.value.length,
  classify: classify.value.length,
  dedup: dedup.value.length,
}));
const total = computed(() => counts.value.supersede + counts.value.classify + counts.value.dedup);
/** 三档滑块：0/1/2 对应 tab 顺序，位移用 translateX(calc(N * (100% + 2px))) */
const tabIndex = computed(() => ({ supersede: 0, classify: 1, dedup: 2 })[tab.value]);

async function refresh() {
  await Promise.all([
    api.memoryReviewList("supersede").then((r) => (supersede.value = r.items as unknown as SupersedeItem[])).catch(() => {}),
    api.memoryReviewList("classify").then((r) => (classify.value = r.items as unknown as ClassifyItem[])).catch(() => {}),
    api.memoryDedupReviewList().then((r) => (dedup.value = r.items as unknown as DedupItem[])).catch(() => {}),
  ]);
  loadedOnce.value = true;
}

async function resolveSupersede(item: SupersedeItem, action: "confirm" | "dismiss" | "merge") {
  busy.value = item.id;
  try {
    await api.memoryReviewResolve(item.id, action);
    ElMessage.success(action === "confirm" ? "已标记旧事实失效" : action === "merge" ? "已合并两条" : "已判定为并非矛盾");
    await refresh();
    await mem.loadStats();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

async function resolveClassify(item: ClassifyItem, slug: string | null) {
  busy.value = item.id;
  try {
    await api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss", slug ? { slug } : undefined);
    ElMessage.success(slug ? `已归入 ${slug}` : "已标记为独立记忆");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

async function resolveDedup(item: DedupItem, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss") {
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
  busy.value = item.id;
  try {
    await api.memoryDedupReviewResolve(item.id, action, text ? { text } : undefined);
    ElMessage.success("已处理");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

let offEvent: (() => void) | undefined;
// 去重巡检/失效判定/归类完成后要自动回到这里（index 事件是 watcher 风暴源，不刷）
const REFRESH_TYPES = new Set(["memory-new", "deleted", "dedup", "supersede", "config-changed", "root-changed"]);
onMounted(async () => {
  await mem.loadAll();
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
/** 仪表盘/侧栏点「待处理」进来时按 kinds 落对应 tab */
watch(
  () => mem.reviewTabHint,
  (k) => {
    if (!k) return;
    mem.reviewTabHint = "";
    if (k === "classify" || k === "dedup" || k === "supersede") tab.value = k;
  },
);
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        共 {{ total }} 条待你点头，AI 只建议不自动改
        <MemHelp text="三件事需要你确认：① 事实失效（新记忆推翻了旧的）② 项目归类（名称模糊匹配的结果）③ 去重（低置信的重复判定）。每一项都有明确的取舍说明，选错可恢复（旧记忆只标失效、原文都在）。" />
      </p>
      <div class="mem-head-actions">
        <div class="mem-switch is-3" :style="{ '--sw-i': tabIndex }" role="tablist">
          <span class="sw-thumb"></span>
          <button class="sw-item" :class="{ active: tab === 'supersede' }" role="tab" :aria-selected="tab === 'supersede'" @click="tab = 'supersede'">
            事实失效<span v-if="counts.supersede" class="sw-n">{{ counts.supersede }}</span>
          </button>
          <button class="sw-item" :class="{ active: tab === 'classify' }" role="tab" :aria-selected="tab === 'classify'" @click="tab = 'classify'">
            项目归类<span v-if="counts.classify" class="sw-n">{{ counts.classify }}</span>
          </button>
          <button class="sw-item" :class="{ active: tab === 'dedup' }" role="tab" :aria-selected="tab === 'dedup'" @click="tab = 'dedup'">
            去重<span v-if="counts.dedup" class="sw-n">{{ counts.dedup }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="!total && loadedOnce" class="mem-card">
      <div class="mem-empty">没有待确认的事 —— AI 的建议都已处理完</div>
    </div>

    <!-- ① 事实失效 -->
    <template v-if="tab === 'supersede'">
      <div class="mem-card">
        <div class="mem-card-title">
          事实失效（{{ counts.supersede }} 条）
          <span class="mem-hint">AI 找出互相矛盾的一对并给理由，你点「确认失效」才算数</span>
          <MemHelp text="记忆会被推翻（「改用 Vue3」推翻「在用 React」）。确认后旧的那条被标记失效、默认不再被检索到，但原文仍在、可随时查看演化链——所以选错的代价只是「检索时少看到一条」。" />
        </div>
        <div v-if="counts.supersede" class="mem-col" style="gap: 10px">
          <div v-for="q in supersede" :key="q.id" class="mem-tile">
            <div class="mem-kv">
              <span class="k">旧事实</span>
              <span class="v">{{ q.payload.oldTitle || q.payload.oldId }}（{{ q.payload.oldId }}）</span>
              <span class="k">新事实</span>
              <span class="v">{{ q.payload.newTitle || q.payload.newId || "（仅提示，无对应新条）" }}</span>
              <span class="k">判定理由</span>
              <span class="v">{{ q.payload.reason || "—" }}</span>
              <span class="k">置信度</span>
              <span class="v">{{ q.payload.confidence }}</span>
            </div>
            <div class="mem-tile-foot">
              <button class="btn btn-cta" :disabled="busy === q.id" @click="resolveSupersede(q, 'confirm')">确认失效</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveSupersede(q, 'dismiss')">并非矛盾</button>
              <button v-if="q.payload.newId" class="btn btn-ghost" :disabled="busy === q.id" @click="resolveSupersede(q, 'merge')">合并两条</button>
              <MemHelp text="确认失效：旧记忆被标记失效、默认不再被检索到，但原文保留、可查演化链。并非矛盾：两条都保持有效，AI 不再追问。合并两条：把旧的内容并入新的再标失效。" />
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">没有待确认的失效判定</div>
      </div>
    </template>

    <!-- ② 项目归类 -->
    <template v-else-if="tab === 'classify'">
      <div class="mem-card">
        <div class="mem-card-title">
          项目归类（{{ counts.classify }} 条）
          <span class="mem-hint">没有 Git 地址的记忆，按目录名/标题与已有项目比相似度</span>
          <MemHelp text="归类只认 Git 远程地址（最可靠）。没有远程地址时才退化为名称模糊匹配，而模糊匹配归错了会污染目录结构且难察觉——所以这一档只给建议，等你点头。" />
        </div>
        <div v-if="counts.classify" class="mem-col">
          <div v-for="s in classify" :key="s.id" class="mem-chain-node" style="flex-wrap: wrap; gap: 8px">
            <span v-if="s.payload.score !== undefined" class="mem-chip warn">置信 {{ s.payload.score }}</span>
            <span>「{{ s.payload.candidate || s.payload.title }}」</span>
            <span style="color: var(--text-3)">疑似属于</span>
            <span class="mem-chip accent">{{ s.payload.name || s.payload.slug }}</span>
            <span style="margin-left: auto; display: flex; gap: 6px">
              <button class="btn btn-cta" :disabled="busy === s.id" @click="resolveClassify(s, s.payload.slug || null)">确认归入</button>
              <button class="btn btn-ghost" :disabled="busy === s.id" @click="resolveClassify(s, null)">不是同一项目</button>
            </span>
          </div>
        </div>
        <div v-else class="mem-empty">没有待确认的归类</div>
      </div>
    </template>

    <!-- ③ 去重 -->
    <template v-else>
      <div class="mem-card">
        <div class="mem-card-title">
          去重（{{ counts.dedup }} 条）
          <span class="mem-hint">低置信 UPDATE 与全部 DELETE 都要人工点头</span>
          <MemHelp text="四选一：采纳新记忆（旧的标失效、可追溯）／保留旧记忆（新的丢弃并把来源并入旧的）／两条都留（记住这一对不是重复，以后不再问）／编辑后合并（你手动拼一条）。删除永远不会自动执行。" />
        </div>
        <div v-if="counts.dedup" class="mem-col" style="gap: 10px">
          <div v-for="q in dedup" :key="q.id" class="mem-tile">
            <div class="mem-row">
              <span class="mem-chip" :class="q.payload.kind === 'DELETE' ? 'danger' : 'warn'">
                {{ q.payload.kind }}（置信 {{ q.payload.confidence }}）
              </span>
              <span v-if="q.payload.reason" class="mem-hint">{{ q.payload.reason }}</span>
            </div>
            <div class="mem-split-2-1">
              <div class="mem-card" style="background: var(--mem-soft)">
                <div class="mem-hint">已有记忆（旧）</div>
                <div style="font-size: 12px; margin-top: 4px">{{ q.payload.targetTitle || q.payload.targetId }}</div>
                <div class="mem-hint" style="margin-top: 4px">{{ q.payload.targetSummary || "（无摘要）" }}</div>
              </div>
              <div class="mem-card" style="background: var(--mem-soft)">
                <div class="mem-hint">新记忆</div>
                <div style="font-size: 12px; margin-top: 4px">{{ q.payload.newTitle || q.payload.newId }}</div>
                <div class="mem-hint" style="margin-top: 4px">{{ q.payload.newSummary || "（无摘要）" }}</div>
              </div>
            </div>
            <div class="mem-tile-foot">
              <button class="btn btn-cta" :disabled="busy === q.id" @click="resolveDedup(q, 'adoptNew')">采纳新记忆</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveDedup(q, 'keepOld')">保留旧记忆</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveDedup(q, 'keepBoth')">两条都留</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveDedup(q, 'merge')">编辑后合并</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveDedup(q, 'dismiss')">忽略</button>
              <MemHelp text="采纳新记忆：旧的标失效、可追溯；保留旧记忆：新的丢弃并把来源并入旧的；两条都留：记住这一对不是重复，以后不再问；编辑后合并：你手动拼一条。" />
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">没有待判定的重复</div>
      </div>
    </template>
  </div>
</template>
