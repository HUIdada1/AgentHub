<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 记忆浏览：四个视图（列表 / 热力图 / 待确认 / 回收站）+ 常显筛选条 + 详情抽屉。
     布局自上而下：视图切换条（含各视图待处理红点）→ 列表视图的等级 tab → 筛选行（常显，无展开按钮）
     → 结果。筛选行只在列表视图出现；等级 tab 与筛选是两级正交的维度：tab 切 L1/L2/全部，
     筛选再在结果内做项目/Agent/类型/标签/状态的收敛。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryRow } from "../../types";
import { formatInteger, timeAgo, formatDateTime } from "../../composables/useFormat";
import MemoryDetailDrawer from "../../components/memory/MemoryDetailDrawer.vue";
import MemoryHeatmap from "../../components/memory/MemoryHeatmap.vue";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemSelect from "../../components/memory/MemSelect.vue";
import MemDialog from "../../components/memory/MemDialog.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";
import MemReviewPanel from "../../components/memory/MemReviewPanel.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "browse");

type View = "list" | "heatmap" | "review" | "trash";
const view = ref<View>("list");
/* 视图切换方向：分段滑块往右滑，新面板就从右侧进（左同理）——与滑块同向，不打架 */
const dir = ref<"left" | "right">("right");
const viewOrder: Record<View, number> = { list: 0, heatmap: 1, review: 2, trash: 3 };
function setView(next: View) {
  if (next === view.value) return;
  dir.value = viewOrder[next] > viewOrder[view.value] ? "right" : "left";
  view.value = next;
  if (next === "trash") void loadTrash();
}
const viewCls = computed(() => (dir.value === "right" ? "from-right" : "from-left"));
const viewIndex = computed(() => viewOrder[view.value]);
/** 待确认视图的队列条数：直接用 store 的待处理计数（与顶部页签红点同源），
    不依赖收件箱面板是否已挂载——面板是懒挂载的，用它的内部计数会让红点晚一步才亮 */
const reviewTotal = computed(() => mem.pending.browse || 0);
/** 待确认面板一旦进过就保活（v-show）：队列状态与事件订阅不用每次重来 */
const reviewVisited = ref(false);
watch(view, (v) => {
  if (v === "review") reviewVisited.value = true;
});

/** 列表的等级 tab：L1 是日常流水的大头，L2 是蒸馏出的深层记忆，默认看全部 */
type Level = "all" | "l1" | "l2";
const level = ref<Level>("all");
const levelIndex = computed(() => ({ all: 0, l1: 1, l2: 2 })[level.value]);
/* 等级 tab 是筛选器的一部分：切换即重查（与筛选行同一套触发逻辑） */
watch(level, () => {
  page.value = 0;
  void load();
});

const query = ref("");
/* 筛选行常显、无展开收起按钮：日常 90% 的操作都在这一行里，藏起来只会多一次点击 */
const filters = ref({ project: "", agent: "", type: "", tag: "", includeSuperseded: false, starred: false, pinned: false });
const rows = ref<MemoryRow[]>([]);
const total = ref(0);
const page = ref(0);
const tookMs = ref(0);
const loading = ref(false);
const projects = ref<{ slug: string; name: string }[]>([]);
const tags = ref<{ name: string; count: number }[]>([]);
const heat = ref<{ day: string; count: number }[]>([]);
const dayPick = ref<string | null>(null);
const dayRows = ref<MemoryRow[]>([]);
const trash = ref<{ name: string; trashedAt: number; originPath: string; size: number }[]>([]);
const drawerOpen = ref(false);
const drawerId = ref("");
/** 新增记忆改为弹窗（原来就地展开一张卡，把列表往下挤） */
const createOpen = ref(false);
const draft = ref({ title: "", body: "", tags: "", importance: 3, project: "" });

const pageSize = computed(() => Number(mem.cfg("ui.pageSize", 50)));
/** 列表接口给的是逗号分隔字符串（检索接口给数组），展示层统一成数组，避免直接 .join 崩渲染 */
function tagList(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  return String(v == null ? "" : v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

/* 今天按本机时区算（原先用 toISOString 取的是 UTC 日，东八区上午会算成昨天） */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayKey = ymd(new Date());
const heatTotal = computed(() => heat.value.reduce((s, d) => s + d.count, 0));
const heatActiveDays = computed(() => heat.value.filter((d) => d.count > 0).length);
const todayCount = computed(() => heat.value.find((d) => d.day === todayKey)?.count || 0);

/* 下拉选项：与「用量统计」同款 el-select，值仍是后端认的字符串 */
const projectOptions = computed(() => [{ value: "", label: "全部项目" }, ...projects.value.map((p) => ({ value: p.slug, label: p.name }))]);
const agentOptions = [
  { value: "", label: "全部 Agent" },
  { value: "zcode", label: "zcode" },
  { value: "codex", label: "codex" },
  { value: "workbuddy", label: "workbuddy" },
  { value: "claude", label: "claude" },
  { value: "manual", label: "手动" },
];
const typeOptions = [
  { value: "", label: "全部类型" },
  { value: "daily", label: "daily" },
  { value: "session", label: "session" },
  { value: "note", label: "note" },
  { value: "decision", label: "decision" },
  { value: "knowledge", label: "knowledge" },
  { value: "insight", label: "insight" },
];
const tagOptions = computed(() => [{ value: "", label: "全部标签" }, ...tags.value.map((t) => ({ value: t.name, label: `${t.name}（${t.count}）` }))]);
/** 新建弹窗里的项目选择（语义与筛选不同：这里空值 = 交给自动归类） */
const createProjectOptions = computed(() => [
  { value: "", label: "（自动归类 / 通用 general）" },
  ...projects.value.map((p) => ({ value: p.slug, label: p.name })),
]);

/** 当前生效的筛选条数：只数非默认项，排在筛选行末尾当"重置"的启用依据 */
const activeFilterCount = computed(() => {
  const f = filters.value;
  return [f.project, f.agent, f.type, f.tag].filter(Boolean).length
    + [f.includeSuperseded, f.starred, f.pinned].filter(Boolean).length
    + (level.value === "all" ? 0 : 1);
});
function resetFilters() {
  filters.value.project = "";
  filters.value.agent = "";
  filters.value.type = "";
  filters.value.tag = "";
  filters.value.includeSuperseded = false;
  filters.value.starred = false;
  filters.value.pinned = false;
  level.value = "all";
}

/* 请求序号：筛选/事件/回车可并发触发多次 load，晚到的旧响应不许覆盖新数据 */
let loadSeq = 0;
async function load() {
  const my = ++loadSeq;
  loading.value = true;
  try {
    // 等级 tab 落到查询参数（"all" 不传，与后端「不筛层级」同义）
    const layer = level.value === "all" ? undefined : level.value;
    // 排序语义固定：有查询词走 FTS rank + 混合评分（相关度），纯浏览按时间倒序 —— 不再暴露会误导的排序下拉
    if (query.value.trim()) {
      const r = await api.memorySearch(query.value.trim(), {
        project: filters.value.project || undefined,
        agent: filters.value.agent || undefined,
        layer,
        includeSuperseded: filters.value.includeSuperseded,
        limit: pageSize.value,
        offset: page.value * pageSize.value,
      });
      if (my !== loadSeq) return;
      rows.value = r.results;
      total.value = r.total;
      tookMs.value = r.tookMs;
    } else {
      const r = await api.memoryList({
        project: filters.value.project || undefined,
        agent: filters.value.agent || undefined,
        layer,
        type: filters.value.type || undefined,
        tag: filters.value.tag || undefined,
        includeSuperseded: filters.value.includeSuperseded,
        starred: filters.value.starred,
        pinned: filters.value.pinned,
        page: page.value,
        pageSize: pageSize.value,
      });
      if (my !== loadSeq) return;
      rows.value = r.rows;
      total.value = r.total;
      tookMs.value = 0;
    }
  } catch (e) {
    if (my !== loadSeq) return;
    ElMessage.error((e as Error).message || "加载失败");
  } finally {
    if (my === loadSeq) loading.value = false;
  }
}

async function loadMeta() {
  try {
    const p = await api.memoryProjects();
    projects.value = p.projects.map((x) => ({ slug: x.slug, name: x.name }));
  } catch {
    /* 忽略 */
  }
  try {
    const t = await api.memoryTags();
    tags.value = t.tags;
  } catch {
    /* 忽略 */
  }
  try {
    const h = await api.memoryHeatmap(365);
    heat.value = h.days;
  } catch {
    /* 忽略 */
  }
}

/** 回收站（原在「检索与索引」页：删除动作发生在这里，回收站就该在这） */
async function loadTrash() {
  try {
    const t = await api.memoryTrashList();
    trash.value = t.items;
  } catch {
    /* 忽略 */
  }
}

async function restoreTrash(item: { name: string; originPath: string }) {
  try {
    await api.memoryTrashRestore(item.name, item.originPath);
    ElMessage.success("已恢复到原路径");
    await loadTrash();
    await mem.loadStats();
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
    await loadTrash();
  } catch (e) {
    ElMessage.error((e as Error).message || "清理失败");
  }
}

async function pickDay(day: string) {
  // 点已经选中的那天＝收起当日清单（与「再点一次取消」的心智一致）
  if (dayPick.value === day) {
    dayPick.value = null;
    return;
  }
  dayPick.value = day;
  try {
    const start = new Date(`${day}T00:00:00`).getTime();
    const r = await api.memoryList({ after: start, before: start + 86400000, pageSize: 200, includeSuperseded: true });
    dayRows.value = r.rows;
  } catch {
    dayRows.value = [];
  }
}

function openDrawer(id: string) {
  drawerId.value = id;
  drawerOpen.value = true;
}

async function togglePin(row: MemoryRow) {
  try {
    await api.memoryPin(row.id, !row.pinned);
    row.pinned = !row.pinned;
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function toggleStar(row: MemoryRow) {
  try {
    await api.memoryStar(row.id, !row.starred);
    row.starred = !row.starred;
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function removeRow(row: MemoryRow) {
  try {
    await ElMessageBox.confirm(`删除「${row.title}」？将移入回收站，可恢复。`, "删除记忆", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryDelete(row.id);
    ElMessage.success("已移入回收站");
    await load();
    await loadMeta();
    await mem.loadStats();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function copyPath(row: MemoryRow) {
  const rel = row.anchor ? `${row.path}#${row.anchor}` : row.path;
  try {
    await navigator.clipboard.writeText(rel);
    ElMessage.success("路径已复制");
  } catch {
    ElMessage.warning("复制失败：" + rel);
  }
}

/** 行内操作菜单（原来四个常驻 chip 与详情抽屉完全重复，收成一个 ⋯） */
function rowAction(row: MemoryRow, cmd: string) {
  if (cmd === "star") void toggleStar(row);
  else if (cmd === "pin") void togglePin(row);
  else if (cmd === "path") void copyPath(row);
  else if (cmd === "delete") void removeRow(row);
}

/** 打开新增弹窗：每次给一张干净的空白表单 */
function openCreate() {
  draft.value = { title: "", body: "", tags: "", importance: 3, project: "" };
  createOpen.value = true;
}

/* 写入进度弹窗：手写一条本身很快，但写盘 + 重建该文件索引可能被写队列排队，故照样给进度 */
const writeOpen = ref(false);
const writeRunning = ref(false);
const writeStartedAt = ref(0);
const writeResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);

async function submitCreate() {
  if (!draft.value.body.trim() && !draft.value.title.trim()) {
    ElMessage.warning("请填写标题或正文");
    return;
  }
  createOpen.value = false;
  writeRunning.value = true;
  writeStartedAt.value = Date.now();
  writeResult.value = null;
  writeOpen.value = true;
  try {
    const r = await api.memoryWrite({
      title: draft.value.title.trim(),
      body: draft.value.body,
      type: "note",
      layer: "l1",
      project: draft.value.project || undefined,
      agent: "manual",
      tags: draft.value.tags.split(/[,，\s]+/).filter(Boolean),
      // 输入框清空时给默认 3，而不是让空串被后端钳成 1
      importance: (() => {
        const n = Number(draft.value.importance);
        return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3;
      })(),
    });
    const path = r.id ? `写入位置：${r.path || r.id}` : "";
    writeResult.value = {
      ok: true,
      message: r.noop ? "内容与已有记忆相同，未重复写入" : "已写入记忆库",
      extra: path ? [path] : undefined,
    };
    await load();
    await loadMeta();
    await mem.loadStats();
  } catch (e) {
    writeResult.value = { ok: false, message: (e as Error).message || "写入失败" };
  } finally {
    writeRunning.value = false;
  }
}

/* 输入即搜（防抖 300ms）：搜索按钮是回车之外的多余入口，去掉后仍可回车立即搜 */
let searchTimer: number | undefined;
watch(query, () => {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    page.value = 0;
    void load();
  }, 300);
});

let offEvent: (() => void) | undefined;
onMounted(async () => {
  await Promise.all([mem.loadAll(), loadMeta()]);
  await load();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "memory") return;
    if (!mem.realtimeEnabled) return; // ui.realtimeRefresh 关掉后只靠手动刷新
    if (p.type === "memory-new" || p.type === "deleted") {
      void load();
      void loadMeta();
      void mem.loadStats();
    }
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  if (searchTimer) window.clearTimeout(searchTimer);
});
watch(active, (v) => {
  if (v) {
    void loadMeta();
    void load();
    if (view.value === "trash") void loadTrash();
  }
});
// 项目页「查看记忆」跳转的预过滤：消费后即清空（保活页常驻，watch 比 onMounted 可靠）
watch(
  () => mem.browsePrefilter,
  (slug) => {
    if (!slug) return;
    mem.browsePrefilter = "";
    view.value = "list";
    filters.value.project = slug;
    page.value = 0;
    void load();
  },
);
/** 别处（仪表盘 KPI、侧栏、各页「N 条待确认 →」）的视图落点提示：消费后清空 */
watch(
  () => mem.browseViewHint,
  (v) => {
    if (!v) return;
    mem.browseViewHint = "";
    if (v !== "list" && v !== "heatmap" && v !== "review" && v !== "trash") return;
    dir.value = viewOrder[v] > viewOrder[view.value] ? "right" : "left";
    view.value = v;
    if (v === "trash") void loadTrash();
    // 待处理数在面板挂载前就要显示在视图切换条上，先让 store 刷一次
    if (v === "review") void mem.refreshPending(true);
  },
);
watch(filters, () => {
  page.value = 0;
  void load();
}, { deep: true });
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        实时记录 · 支持中文与代码符号检索
        <MemHelp text="搜索走本地全文索引：中文按二字切分（「记忆」也能命中），英文与代码符号按整词。搜不到时先换更短的关键词；还搜不到就是真没记过。" />
      </p>
      <div class="mem-head-actions">
        <button class="btn btn-cta" @click="openCreate">＋ 新增一条记忆</button>
        <!-- 视图切换：左右滑动的分段控件（滑块跟着选项走）；有待处理的视图带红点 -->
        <div class="mem-switch is-4" :style="{ '--sw-i': viewIndex }" role="tablist">
          <span class="sw-thumb"></span>
          <button class="sw-item" :class="{ active: view === 'list' }" role="tab" :aria-selected="view === 'list'" @click="setView('list')">列表</button>
          <button class="sw-item" :class="{ active: view === 'heatmap' }" role="tab" :aria-selected="view === 'heatmap'" @click="setView('heatmap')">热力图</button>
          <button class="sw-item" :class="{ active: view === 'review' }" role="tab" :aria-selected="view === 'review'" @click="setView('review')">
            待确认<span v-if="reviewTotal" class="sw-n">{{ reviewTotal }}</span>
            <span v-if="reviewTotal" class="sw-dot" title="有待处理项"></span>
          </button>
          <button class="sw-item" :class="{ active: view === 'trash' }" role="tab" :aria-selected="view === 'trash'" @click="setView('trash')">回收站</button>
        </div>
      </div>
    </div>

    <!-- 列表视图：等级 tab（L1/L2 是最常用的"一类"，故单列一行做切换）+ 常显筛选行 -->
    <template v-if="view === 'list'">
      <div class="mem-toolbar">
        <!-- 一级：等级 tab。切它走 layer 查询参数，与下面的筛选正交叠加 -->
        <div class="mem-switch is-3" :style="{ '--sw-i': levelIndex }" role="tablist" aria-label="按层级筛选">
          <span class="sw-thumb"></span>
          <button class="sw-item" :class="{ active: level === 'all' }" role="tab" :aria-selected="level === 'all'" @click="level = 'all'">全部层级</button>
          <button class="sw-item" :class="{ active: level === 'l1' }" role="tab" :aria-selected="level === 'l1'" @click="level = 'l1'">
            L1 普通<MemHelp text="Agent 日常写入的流水与笔记（会话摘要、每日记录、手写笔记）。量大、粒度细，是记忆的主体。" />
          </button>
          <button class="sw-item" :class="{ active: level === 'l2' }" role="tab" :aria-selected="level === 'l2'" @click="level = 'l2'">
            L2 深层<MemHelp text="由自动化蒸馏出的知识、决策与术语表——把多条原始记忆压缩成的长期结论。条数少但信息密度高。" />
          </button>
        </div>
        <span class="mem-count">共 {{ formatInteger(total) }} 条{{ tookMs ? ` · ${tookMs}ms` : "" }}</span>
      </div>

      <!-- 二级：筛选行常显（不再有展开/收起按钮），一行自适应换行 -->
      <div class="mem-toolbar mem-filter-bar">
        <input
          v-model="query"
          class="f-input mem-grow"
          placeholder="搜索记忆（走索引，支持「索引方案」「memory_search」这类中英混合）"
          @keyup.enter="() => { page = 0; load(); }"
        />
        <MemSelect v-model="filters.project" :options="projectOptions" width="180px" />
        <MemSelect v-model="filters.agent" :options="agentOptions" placeholder="全部 Agent" width="150px" />
        <MemSelect v-model="filters.type" :options="typeOptions" placeholder="全部类型" width="140px" />
        <MemSelect v-model="filters.tag" :options="tagOptions" placeholder="全部标签" width="170px" />
        <span class="mem-row" style="gap: 6px" title="默认只看仍然有效的记忆">
          <div class="switch" :class="{ on: filters.includeSuperseded }" role="switch" :aria-checked="!!filters.includeSuperseded" @click="filters.includeSuperseded = !filters.includeSuperseded"></div>
          <span class="mem-hint">显示已失效</span>
          <MemHelp text="记忆会被推翻（例如「改用 Vue3」推翻了「我在用 React」）。旧的那条会被标记失效并从默认结果里隐去，避免拿旧偏好当现在的偏好；打开这里可以连失效的一起看。" />
        </span>
        <span class="mem-row" style="gap: 6px">
          <div class="switch" :class="{ on: filters.starred }" role="switch" :aria-checked="!!filters.starred" @click="filters.starred = !filters.starred"></div>
          <span class="mem-hint">仅收藏</span>
        </span>
        <span class="mem-row" style="gap: 6px">
          <div class="switch" :class="{ on: filters.pinned }" role="switch" :aria-checked="!!filters.pinned" @click="filters.pinned = !filters.pinned"></div>
          <span class="mem-hint">仅置顶</span>
        </span>
        <button class="mem-chip click" :disabled="!activeFilterCount" @click="resetFilters">
          重置筛选{{ activeFilterCount ? ` · ${activeFilterCount}` : "" }}
        </button>
      </div>
    </template>

    <!-- 列表视图：表格化 + 定高滚动 + 表头粘顶 + 整行进详情抽屉（与「用量统计」明细页同款） -->
    <div v-if="view === 'list'" class="mem-view" :class="viewCls">
      <div class="mem-card">
        <div v-if="loading" class="mem-empty">正在加载…</div>
        <div v-else-if="!rows.length" class="mem-empty">
          {{ query ? "没有命中的记忆 —— 试试更短的关键词，或在「检索与索引」页看分词结果" : "当前条件下没有记忆" }}
        </div>
        <template v-else>
          <div class="mem-table-wrap mem-table-scroll">
            <table class="mem-table mem-table-list">
              <thead>
                <tr>
                  <th>时间</th><th>标题</th><th>层级</th><th>项目</th><th>Agent</th><th>标记</th><th>标签</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in rows"
                  :key="r.id + (r.anchor || '')"
                  :class="{ 'is-new': r.id === mem.lastNewId, 'is-superseded': r.superseded }"
                  @click="openDrawer(r.id)"
                >
                  <td><span class="mem-mono" :title="timeAgo(r.created)">{{ formatDateTime(r.created) }}</span></td>
                  <td>
                    <span class="t-title" :title="r.title"><template v-if="r.pinned">📌 </template>{{ r.title }}</span>
                  </td>
                  <td><span class="mem-chip" :class="r.layer === 'l2' ? 'info' : ''">{{ r.layer === "l2" ? "L2" : "L1" }}</span></td>
                  <td class="t-link" @click.stop="filters.project = r.project || ''">{{ r.project || "通用（general）" }}</td>
                  <td class="t-link" @click.stop="filters.agent = r.agent">{{ r.agent }}</td>
                  <!-- 标记列：只显示例外状态（有效是默认值，不用占地方） -->
                  <td>
                    <span v-if="r.superseded" class="mem-chip warn" title="已被更新的记忆取代">已失效</span>
                    <span v-if="r.importance >= 4" class="mem-chip" title="重要度">{{ r.importance }}</span>
                    <span v-if="r.starred" class="mem-chip accent">已收藏</span>
                    <span v-if="r.score" class="mem-chip accent" title="检索相关度">{{ r.score }}</span>
                    <span v-if="!r.superseded && r.importance < 4 && !r.starred && !r.score" class="mem-hint">—</span>
                  </td>
                  <td>
                    <span class="t-tags" :title="tagList(r.tags).join(' · ')">{{ tagList(r.tags).slice(0, 3).join(" · ") || "—" }}</span>
                  </td>
                  <!-- 行内只留一个 ⋯（原来四个 chip 与详情抽屉完全重复）；重动作走整行的详情抽屉 -->
                  <td class="actions" @click.stop>
                    <el-dropdown trigger="click" @command="(c: string) => rowAction(r, c)">
                      <button class="mem-chip click" title="更多操作">⋯</button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item command="star">{{ r.starred ? "取消收藏" : "收藏" }}</el-dropdown-item>
                          <el-dropdown-item command="pin">{{ r.pinned ? "取消置顶" : "置顶" }}</el-dropdown-item>
                          <el-dropdown-item command="path">复制路径</el-dropdown-item>
                          <el-dropdown-item command="delete" divided>删除（移入回收站）</el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="total > pageSize" class="mem-pager">
            <span class="pg-info">共 {{ formatInteger(total) }} 条 · 第 {{ page + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }} 页</span>
            <button class="btn btn-ghost" :disabled="page === 0" @click="() => { page -= 1; load(); }">上一页</button>
            <button class="btn btn-ghost" :disabled="(page + 1) * pageSize >= total" @click="() => { page += 1; load(); }">下一页</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 热力图视图：GitHub 式全年日历（与「用量统计」同款）+ 点某天在下方展开当日清单 -->
    <div v-else-if="view === 'heatmap'" class="mem-view" :class="viewCls">
      <div class="mem-card">
        <div class="mem-card-title">
          每日记录热力图（一年视图）
          <span class="mem-hint">今日 {{ todayCount }} 条 · 活跃 {{ heatActiveDays }} 天 · 近一年 {{ formatInteger(heatTotal) }} 条</span>
          <MemHelp text="每格一天，颜色越深当天记录越多。点任一天在下方展开当日清单（再点一次收起）——回答「某天记了多少条」最直接的方式。" />
        </div>
        <MemoryHeatmap :data="heat" :picked="dayPick" @pick="pickDay" />

        <div v-if="dayPick" class="mem-day-split">
          <div class="mem-card-title">
            {{ dayPick }} · 共 {{ dayRows.length }} 条
            <button class="mem-chip click" @click="dayPick = null">收起</button>
          </div>
          <div v-if="dayRows.length" class="mem-table-wrap mem-table-scroll is-short">
            <table class="mem-table mem-table-list">
              <thead><tr><th>时间</th><th>标题</th><th>层级</th><th>重要</th><th>Agent</th></tr></thead>
              <tbody>
                <tr v-for="r in dayRows" :key="r.id + (r.anchor || '')" :class="{ 'is-superseded': r.superseded }" @click="openDrawer(r.id)">
                  <td><span class="mem-mono">{{ formatDateTime(r.created).slice(11, 16) }}</span></td>
                  <td><span class="t-title" :title="r.title">{{ r.title }}</span></td>
                  <td><span class="mem-chip">{{ r.layer === "l2" ? "L2" : "L1" }}</span></td>
                  <td class="num">{{ r.importance }}</td>
                  <td>{{ r.agent }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="mem-empty">这一天没有记录</div>
        </div>
      </div>
    </div>

    <!-- 待确认视图（原独立页签）：三类人工裁决——事实失效 / 项目归类 / 去重。
         首次进入才挂载，之后 v-show 保活（队列状态与事件订阅不重来） -->
    <div v-else-if="view === 'review'" class="mem-view" :class="viewCls">
      <MemReviewPanel v-if="reviewVisited" />
    </div>

    <!-- 回收站视图（原在「检索与索引」页）：删除的记忆整份在这里，保留期内可恢复 -->
    <div v-else class="mem-view" :class="viewCls">
      <div class="mem-card">
        <div class="mem-card-title">
          回收站
          <span class="mem-hint">{{ trash.length }} 个文件 · 保留 {{ formatInteger(Number(mem.cfg("storage.trashKeepDays", 90))) }} 天</span>
          <span class="mem-inline-ctl">
            <button class="mem-chip click" @click="purgeTrash">清理超期文件</button>
            <MemHelp text="删除的记忆先整份进这里，保留期内可一键恢复回原路径；只有点「清理超期文件」才会真正从磁盘删除。" />
          </span>
        </div>
        <div v-if="trash.length" class="mem-table-wrap mem-table-scroll">
          <table class="mem-table">
            <thead><tr><th>删除时间</th><th>原路径</th><th>体积</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="t in trash.slice(0, 200)" :key="t.name">
                <td>{{ formatDateTime(t.trashedAt) }}</td>
                <td><span class="mem-mono">{{ t.originPath }}</span></td>
                <td class="num">{{ formatInteger(Math.round(t.size / 1024)) }} KB</td>
                <td><button class="btn btn-ghost" @click="restoreTrash(t)">恢复</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="mem-empty">回收站为空</div>
      </div>
    </div>

    <MemoryDetailDrawer
      :show="drawerOpen"
      :id="drawerId"
      @close="drawerOpen = false"
      @open="openDrawer"
      @changed="() => { load(); loadMeta(); }"
    />

    <!-- 新增一条记忆（弹窗形态，与全模块弹窗统一：MemDialog） -->
    <MemDialog v-model:open="createOpen" title="新增一条记忆" sub="手写写入，不参与自动归类以外的处理；写盘后会立即重建该条索引">
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">标题</div>
          <input v-model="draft.title" class="f-input" placeholder="留空则取正文首行" />
        </div>
        <div class="mem-section">
          <div class="s-title">正文</div>
          <textarea v-model="draft.body" class="el-textarea__inner" rows="7" placeholder="正文内容（支持 Markdown）"></textarea>
        </div>
        <div class="mem-section">
          <div class="s-title">项目归属</div>
          <MemSelect v-model="draft.project" :options="createProjectOptions" placeholder="（自动归类 / 通用 general）" />
        </div>
        <div class="mem-row" style="gap: 10px">
          <span class="mem-section" style="flex: 1 1 220px">
            <span class="s-title">标签（逗号分隔）</span>
            <input v-model="draft.tags" class="f-input" placeholder="如：索引, 性能" />
          </span>
          <span class="mem-section" style="flex: 0 0 auto">
            <span class="s-title">重要度 1~5</span>
            <input v-model.number="draft.importance" type="number" min="1" max="5" class="f-input" style="width: 96px" />
          </span>
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="submitCreate">写入</button>
        <button class="btn btn-ghost" @click="createOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 写入进度（写盘 + 重建索引可能被写队列排队，给进度与结果） -->
    <MemProgressDialog
      v-model:open="writeOpen"
      title="写入记忆"
      sub="落盘并立即重建该条索引"
      :running="writeRunning"
      :phase="'写入记忆库'"
      :started-at="writeStartedAt"
      :result="writeResult"
    />
  </div>
</template>