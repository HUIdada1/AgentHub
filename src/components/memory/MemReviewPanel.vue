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
<!-- 记忆中枢 · 待确认收件箱（原独立页签，现为「记忆浏览」的第三个视图）：
     三类人工裁决集中一处（事实失效 / 项目归类 / 去重），AI 只建议不自动改。
     本面板不自带页面头部——页头属于记忆浏览；三个队列各有一枚待处理红点。 -->
<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { coalesceAsync } from "../../utils/timing";
import MemHelp from "./MemHelp.vue";
import MemSelect from "./MemSelect.vue";

const mem = useMemoryStore();

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
  supersede: loadedOnce.value ? supersede.value.length : (mem.reviewCounts?.supersede ?? supersede.value.length),
  classify: loadedOnce.value ? classify.value.length : (mem.reviewCounts?.classify ?? classify.value.length),
  dedup: loadedOnce.value ? dedup.value.length : (mem.reviewCounts?.dedup ?? dedup.value.length),
}));
const total = computed(() => counts.value.supersede + counts.value.classify + counts.value.dedup);
/** 三档滑块：0/1/2 对应 tab 顺序，位移用 translateX(calc(N * (100% + 2px))) */
const tabIndex = computed(() => ({ supersede: 0, classify: 1, dedup: 2 })[tab.value]);

async function refresh() {
  await Promise.all([
    api.memoryReviewList("supersede").then((r) => (supersede.value = (r.items || []) as unknown as SupersedeItem[])).catch(() => {}),
    api.memoryReviewList("classify").then((r) => (classify.value = (r.items || []) as unknown as ClassifyItem[])).catch(() => {}),
    api.memoryDedupReviewList().then((r) => (dedup.value = (r.items || []) as unknown as DedupItem[])).catch(() => {}),
  ]);
  mem.reviewCounts = {
    supersede: supersede.value.length,
    classify: classify.value.length,
    dedup: dedup.value.length,
  };
  mem.pending.browse = supersede.value.length + classify.value.length + dedup.value.length;
  loadedOnce.value = true;
}

const batchBusy = ref(false);

/** 三类自动按推荐确认开关（review.autoConfirm*，默认关）：开启后建议入队即按推荐执行，不再进收件箱 */
const autoConfirmOf = (key: "supersede" | "classify" | "dedup") => {
  const cfgKey = `review.autoConfirm${key[0].toUpperCase()}${key.slice(1)}`;
  return computed({
    get: () => !!mem.cfg(cfgKey, false),
    set: (v: boolean) => {
      // 保存成功才提示成功：此前不 await 就无条件 toast，存盘失败时开关视觉与配置会不一致
      void mem
        .save({ [cfgKey]: v })
        .then(() => ElMessage.success(v ? "已开启：之后的建议将自动按推荐处理" : "已关闭：建议恢复人工确认"))
        .catch((e) => ElMessage.error((e as Error).message || "保存失败"));
    },
  });
};
const autoSupersede = autoConfirmOf("supersede");
const autoClassify = autoConfirmOf("classify");
const autoDedup = autoConfirmOf("dedup");

/* ===== 高置信建议自动处理 · 总开关（三细键的快捷方式，细键继续在高级配置生效） ===== */
const AUTO_KEYS: Record<"supersede" | "classify" | "dedup", string> = {
  supersede: "review.autoConfirmSupersede",
  classify: "review.autoConfirmClassify",
  dedup: "review.autoConfirmDedup",
};
const autoAllState = computed(() => {
  const on = (Object.keys(AUTO_KEYS) as ("supersede" | "classify" | "dedup")[]).filter((k) => !!mem.cfg(AUTO_KEYS[k], false));
  return { on: on.length === 3, partial: on.length > 0 && on.length < 3, count: on.length };
});
async function toggleAutoAll() {
  const target = !(autoAllState.value.on || autoAllState.value.partial);
  try {
    await mem.save({
      [AUTO_KEYS.supersede]: target,
      [AUTO_KEYS.classify]: target,
      [AUTO_KEYS.dedup]: target,
    });
    ElMessage.success(target
      ? "已开启：高置信建议（达到下限）自动按推荐处理，拿不准的仍进本页等人工"
      : "已关闭：建议恢复人工确认");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

/** 置信下限：低于它的建议不配绿色主按钮，避免低置信建议被盲目采纳 */
const minConf = computed(() => {
  const v = Number(mem.cfg("review.autoConfirmMinConfidence", 0.8));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
});
const lowConf = (c?: number | null) => c != null && Number(c) < minConf.value;

/** 执行后可撤销提示：裁决都是软操作（失效标记/改归属），一键还原。
    同时最多保留 3 个（连续裁决时关掉最早的），避免提示在屏幕上堆叠。 */
const undoToasts: { close: () => void }[] = [];
function toastUndo(message: string, undo: () => Promise<unknown>) {
  const ins = ElMessage({
    type: "success",
    duration: 10000,
    showClose: true,
    message: h("span", { style: "display:inline-flex;align-items:center;gap:12px" }, [
      h("span", null, message),
      h("button", {
        class: "btn-link",
        style: "font-size: 12px; flex: none",
        onClick: () => {
          void Promise.resolve(undo())
            .then(() => ElMessage.success("已撤销"))
            .catch((e) => ElMessage.error((e as Error).message || "撤销失败"));
          ins.close();
        },
      }, "撤销"),
    ]),
  });
  undoToasts.push(ins);
  while (undoToasts.length > 3) {
    const oldest = undoToasts.shift();
    if (oldest) oldest.close();
  }
}

/** 单队列一次最多渲染的条目数：队列积压很多时（如数千条），全量渲染会明显卡顿。
    渲染截断不影响处理范围——批量按钮仍作用于完整队列，计数也按完整队列显示。 */
const RENDER_CAP = 100;
const shownSupersede = computed(() => supersede.value.slice(0, RENDER_CAP));
const shownClassify = computed(() => classify.value.slice(0, RENDER_CAP));
const shownDedup = computed(() => dedup.value.slice(0, RENDER_CAP));

/** 单条处理后的局部收尾：只移除本条并就地同步计数，不全量重拉三队列（批量才全量刷） */
function removeLocal(kind: "supersede" | "classify" | "dedup", id: string) {
  const list = kind === "supersede" ? supersede : kind === "classify" ? classify : dedup;
  const i = list.value.findIndex((x) => x.id === id);
  if (i >= 0) list.value.splice(i, 1);
  loadedOnce.value = true;
  mem.reviewCounts = { supersede: supersede.value.length, classify: classify.value.length, dedup: dedup.value.length };
  mem.pending.browse = supersede.value.length + classify.value.length + dedup.value.length;
}
async function afterDataChange() {
  await mem.loadStats();
}

/** 归类改选：默认取 AI 推荐 slug，可改选任意项目（后端 projectAssign 本就收任意 slug） */
const projectOptions = computed(() => mem.projects.map((p) => ({ value: p.slug, label: p.name })));
const classifyPick = ref<Record<string, string>>({});
function pickedSlug(item: ClassifyItem): string | null {
  return classifyPick.value[item.id] ?? item.payload.slug ?? null;
}

async function resolveSupersede(item: SupersedeItem, action: "confirm" | "dismiss" | "merge") {
  busy.value = item.id;
  try {
    const r = await api.memoryReviewResolve(item.id, action);
    removeLocal("supersede", item.id);
    // stale：引用的旧记忆已不存在，后端已把该建议作废——如实展示原因，不能报"已标记失效"
    if (r?.stale) ElMessage.info(r.message || "该建议已自动作废");
    else if (action === "confirm") {
      toastUndo("已标记旧事实失效", async () => {
        const u = await api.memoryUnsupersede(item.payload.oldId);
        if (u && u.ok === false) throw new Error(u.message || "撤销失败");
        await afterDataChange();
      });
    } else ElMessage.success(action === "merge" ? "已合并两条" : "已判定为并非矛盾");
    await afterDataChange();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

async function resolveClassify(item: ClassifyItem, slug: string | null) {
  busy.value = item.id;
  try {
    const r = await api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss", slug ? { slug } : undefined);
    removeLocal("classify", item.id);
    if (r?.stale) ElMessage.info(r.message || "该建议已自动作废");
    else if (slug) {
      const name = mem.projects.find((p) => p.slug === slug)?.name || slug;
      // 归类建议只对「没归上项目」的记忆产生（当前必在通用区），撤销=归回通用
      toastUndo(`已归入 ${name}`, async () => {
        await api.memoryProjectAssign([item.payload.memoryId], "general");
        await afterDataChange();
      });
    } else ElMessage.success("已标记为独立记忆");
    await afterDataChange();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

/* ===== 批量引擎：三队列共用，执行时记录可撤销动作，完成后出常驻结果条 =====
   撤销边界：只反向有数据动作的（标失效/改归属）；dismiss、保留两边等无数据动作不在撤销范围。
   删除类建议永不自动执行（后端语义），批量同样只按推荐「采纳新/标失效/归入」，与人工单条同口径。 */
type Undoable =
  | { kind: "supersede"; id: string }
  | { kind: "dedup"; id: string }
  | { kind: "classify"; memoryId: string };
const batchResult = ref<{ ok: number; fail: number; undoable: Undoable[] } | null>(null);

const BATCH_DESC: Record<"supersede" | "classify" | "dedup", string> = {
  supersede: "事实失效：按推荐标记旧事实失效（原文与演化链完整保留）",
  classify: "项目归类：按推荐归入对应项目（无推荐的直接忽略）",
  dedup: "记忆去重：按推荐采纳新记忆（旧记忆标失效、保留追溯）",
};

async function runBatch(kinds: ("supersede" | "classify" | "dedup")[]) {
  const n = kinds.reduce((s, k) => s + counts.value[k], 0);
  if (!n || batchBusy.value) return;
  const heavy = n > 200 ? `\n（本次 ${n} 条，将逐条处理，期间请保持应用在前台）` : "";
  const lines = [`将按各队列推荐方案一键处理 ${n} 条待确认事项：`, ...kinds.filter((k) => counts.value[k]).map((k) => `• ${BATCH_DESC[k]}（${counts.value[k]} 条）`), "", "所有操作均不物理删除原文。处理后出现的结果条可一键撤销。" + heavy + "\n确定立即执行？"].filter(Boolean).join("\n");
  try {
    await ElMessageBox.confirm(lines, kinds.length > 1 ? "一键推荐处理全部" : "一键按推荐处理本队列", {
      confirmButtonText: "确认执行",
      cancelButtonText: "取消",
      type: "info",
    });
  } catch {
    return;
  }

  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  const undoable: Undoable[] = [];
  try {
    if (kinds.includes("supersede")) {
      for (const item of [...supersede.value]) {
        try {
          await api.memoryReviewResolve(item.id, "confirm");
          undoable.push({ kind: "supersede", id: item.payload.oldId });
          ok++;
        } catch { fail++; }
      }
    }
    if (kinds.includes("classify")) {
      for (const item of [...classify.value]) {
        const slug = pickedSlug(item);
        try {
          await api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss", slug ? { slug } : undefined);
          if (slug) undoable.push({ kind: "classify", memoryId: item.payload.memoryId });
          ok++;
        } catch { fail++; }
      }
    }
    if (kinds.includes("dedup")) {
      for (const item of [...dedup.value]) {
        try {
          await api.memoryDedupReviewResolve(item.id, "adoptNew");
          undoable.push({ kind: "dedup", id: item.payload.targetId });
          ok++;
        } catch { fail++; }
      }
    }
    batchResult.value = { ok, fail, undoable };
    if (fail > 0) ElMessage.warning(`处理完成：${ok} 条成功，${fail} 条失败`);
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "批量处理失败");
  } finally {
    batchBusy.value = false;
  }
}

const undoBusy = ref(false);
/** 撤销进度（条数多时按钮上给个「撤销中 x/N」，避免长任务看起来像卡住） */
const undoProgress = ref("");
/** 撤销全部批量动作：失效标记逐条还原、归类归回通用（建议本身不回流队列） */
async function undoBatch() {
  const r = batchResult.value;
  if (!r || undoBusy.value) return;
  undoBusy.value = true;
  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < r.undoable.length; i++) {
      const u = r.undoable[i];
      if (r.undoable.length > 20) undoProgress.value = `${i + 1}/${r.undoable.length}`;
      try {
        if (u.kind === "classify") await api.memoryProjectAssign([u.memoryId], "general");
        else await api.memoryUnsupersede(u.id);
        ok++;
      } catch { fail++; }
    }
    batchResult.value = null;
    if (fail > 0) ElMessage.warning(`撤销完成：${ok} 条成功，${fail} 条失败（失败项可到记忆浏览手动处理）`);
    else ElMessage.success(`已撤销 ${ok} 条`);
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "撤销失败");
  } finally {
    undoBusy.value = false;
    undoProgress.value = "";
  }
}

async function resolveDedup(item: DedupItem, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss") {
  let text: string | undefined;
  if (action === "merge") {
    // 合并草稿预拼接：新记忆全文在前，旧记忆全文跟在分隔线后，用户只需在草稿上微调
    let newText = item.payload.newSummary || "";
    let oldText = item.payload.targetSummary || "";
    try {
      const r = await api.memoryGet(item.payload.newId);
      if (r?.memory?.body) newText = r.memory.body;
    } catch { /* 兜底回 summary */ }
    try {
      const r = await api.memoryGet(item.payload.targetId);
      if (r?.memory?.body) oldText = r.memory.body;
    } catch { /* 兜底回 summary */ }
    const defaultText = oldText
      ? `${newText}\n\n—— 以下为原记忆内容，合并时酌情删改 ——\n${oldText}`
      : newText;
    try {
      const r = await ElMessageBox.prompt("编辑合并后的正文（已预拼新记忆全文与原记忆全文）", "编辑后合并", {
        inputType: "textarea",
        inputValue: defaultText,
      });
      text = r.value || "";
    } catch {
      return;
    }
  }
  busy.value = item.id;
  try {
    const r = await api.memoryDedupReviewResolve(item.id, action, text ? { text } : undefined);
    removeLocal("dedup", item.id);
    if (r?.stale) ElMessage.info(r.message || "该建议已自动作废");
    else if (action === "adoptNew") {
      toastUndo("已采纳新记忆（旧记忆已标失效）", async () => {
        const u = await api.memoryUnsupersede(item.payload.targetId);
        if (u && u.ok === false) throw new Error(u.message || "撤销失败");
        await afterDataChange();
      });
    } else ElMessage.success("已处理");
    await afterDataChange();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

let offEvent: (() => void) | undefined;
// 去重巡检/失效判定/归类完成后要自动回到这里（index 事件是 watcher 风暴源，不刷）
const REFRESH_TYPES = new Set(["memory-new", "deleted", "dedup", "supersede", "config-changed", "root-changed"]);
// 事件合流：自动化跑批时 memory-new/dedup/supersede 密集到达，refresh 是 3 个并发 IPC，
// 逐事件直调会让队列堆积；合流后同刻只在跑一次、间隔内合并
const scheduleRefresh = coalesceAsync(refresh, 1000);
onMounted(async () => {
  await refresh();
  // 归类改选下拉的数据源（BrowseView 挂载时通常已带出，这里兜底一次）
  if (!mem.projects.length) void mem.loadProjects();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "memory" && REFRESH_TYPES.has(p.type || "")) scheduleRefresh();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  scheduleRefresh.cancel();
});
/** 各页/侧栏的「N 条待确认 →」入口按队列类型带落点进来（消费后清空）。
    immediate：本面板在浏览页里是懒挂载的（v-if 到待确认视图才建），入口点进来时 hint 已经写好，
    挂载后不会再触发一次 watch，故必须就地消费一次初始值，否则落点 tab 会丢。 */
watch(
  () => mem.reviewTabHint,
  (k) => {
    if (!k) return;
    mem.reviewTabHint = "";
    if (k === "classify" || k === "dedup" || k === "supersede") tab.value = k;
  },
  { immediate: true },
);

defineExpose({ refresh, total });
</script>

<template>
  <div class="mem-col" style="gap: var(--gap-block)">
    <div class="mem-head">
      <div class="mem-col" style="gap: 4px">
        <p class="mem-sub" style="margin: 0">
          共 {{ total }} 条待你点头，AI 只建议不自动改
          <MemHelp text="三件事需要你确认：① 事实失效（新记忆推翻了旧的）② 项目归类（名称模糊匹配的结果）③ 去重（低置信的重复判定）。每一项都有明确的取舍说明，选错可撤销（旧记忆只标失效、原文都在）。" />
        </p>
      </div>
      <div class="mem-head-actions" style="display: flex; align-items: center; gap: 10px">
        <span class="mem-row" style="gap: 6px; align-items: center">
          <div class="switch" :class="{ on: autoAllState.on || autoAllState.partial }" role="switch" :aria-checked="autoAllState.on || autoAllState.partial" @click="toggleAutoAll"></div>
          <span class="mem-hint" style="white-space: nowrap">
            高置信建议自动处理
            <span v-if="autoAllState.partial" class="mem-chip warn">部分（{{ autoAllState.count }}/3）</span>
            <MemHelp :text="`一键开关三个队列的自动处理：开启后，置信度不低于 ${minConf} 的建议入队即按推荐执行（删除类永不自动），拿不准的仍进本页等人工。各队列的细粒度开关在下方卡头与「配置 · 自动化」里。`" />
          </span>
        </span>
        <el-tooltip
          v-if="total > 0"
          content="按各队列推荐方案一次性处理全部待确认事项"
          placement="top"
        >
          <button
            class="btn btn-cta"
            style="font-size: 12px; padding: 4px 12px"
            :disabled="batchBusy || !!busy"
            @click="runBatch(['supersede', 'classify', 'dedup'])"
          >
            {{ batchBusy ? "处理中…" : `一键推荐处理全部（${total}）` }}
          </button>
        </el-tooltip>
        <div class="mem-switch is-3" :style="{ '--sw-i': tabIndex }" role="tablist">
          <span class="sw-thumb"></span>
          <button class="sw-item" :class="{ active: tab === 'supersede' }" role="tab" :aria-selected="tab === 'supersede'" @click="tab = 'supersede'">
            事实失效<span v-if="counts.supersede" class="sw-n">{{ counts.supersede }}</span>
            <el-tooltip v-if="counts.supersede" content="有待处理项" placement="top">
              <span class="sw-dot"></span>
            </el-tooltip>
          </button>
          <button class="sw-item" :class="{ active: tab === 'classify' }" role="tab" :aria-selected="tab === 'classify'" @click="tab = 'classify'">
            项目归类<span v-if="counts.classify" class="sw-n">{{ counts.classify }}</span>
            <el-tooltip v-if="counts.classify" content="有待处理项" placement="top">
              <span class="sw-dot"></span>
            </el-tooltip>
          </button>
          <button class="sw-item" :class="{ active: tab === 'dedup' }" role="tab" :aria-selected="tab === 'dedup'" @click="tab = 'dedup'">
            去重<span v-if="counts.dedup" class="sw-n">{{ counts.dedup }}</span>
            <el-tooltip v-if="counts.dedup" content="有待处理项" placement="top">
              <span class="sw-dot"></span>
            </el-tooltip>
          </button>
        </div>
      </div>
    </div>

    <!-- 批量处理结果条：常驻不自动消失（多条 toast 叠加没有可用性），撤销全部/完成二选一 -->
    <div v-if="batchResult" class="mem-banner info">
      <span class="b-grow">已按推荐处理 {{ batchResult.ok }} 条{{ batchResult.fail ? `，${batchResult.fail} 条失败` : "" }}{{ batchResult.undoable.length ? ` · 其中 ${batchResult.undoable.length} 条可撤销` : "" }}</span>
      <button v-if="batchResult.undoable.length" class="btn-outline" :disabled="undoBusy" @click="undoBatch">
        {{ undoBusy ? `撤销中${undoProgress ? " " + undoProgress : "…"}` : "撤销全部" }}
      </button>
      <button class="btn btn-ghost" @click="batchResult = null">完成</button>
    </div>

    <div v-if="!total && loadedOnce" class="mem-card">
      <div class="mem-empty">没有待确认的事 —— AI 的建议都已处理完</div>
    </div>

    <!-- ① 事实失效 -->
    <template v-if="tab === 'supersede'">
      <div class="mem-card">
        <div class="mem-card-title" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
          <div>
            事实失效（{{ counts.supersede }} 条）
            <span class="mem-hint">AI 找出互相矛盾的一对并给理由，你点「确认失效」才算数</span>
            <MemHelp text="记忆会被推翻（「改用 Vue3」推翻「在用 React」）。确认后旧的那条被标记失效、默认不再被检索到，但原文仍在、可随时查看演化链——所以选错的代价只是「检索时少看到一条」。" />
          </div>
          <div style="display: flex; align-items: center; gap: 12px">
            <span class="mem-row" style="gap: 6px; align-items: center">
              <div class="switch" :class="{ on: autoSupersede }" role="switch" :aria-checked="autoSupersede" @click="autoSupersede = !autoSupersede"></div>
              <span class="mem-hint" style="white-space: nowrap">自动按推荐确认<MemHelp text="开启后，之后产生的失效判定建议不再进入本页等人工确认，而是立即按推荐标记旧事实失效（原文与演化链完整保留，可随时回看）。" /></span>
            </span>
            <el-tooltip
              v-if="counts.supersede"
              content="按推荐将所有矛盾项标记旧记忆失效（保留演化链）"
              placement="top"
            >
              <button
                class="btn btn-cta"
                style="font-size: 12px; padding: 4px 12px"
                :disabled="batchBusy || !!busy"
                @click="runBatch(['supersede'])"
              >
                {{ batchBusy ? "处理中…" : `一键推荐确认失效（${counts.supersede}）` }}
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="counts.supersede" class="mem-col" style="gap: 10px">
          <div v-for="q in shownSupersede" :key="q.id" class="mem-tile">
            <div class="mem-kv">
              <span class="k">旧事实</span>
              <el-tooltip :content="q.payload.oldId" placement="top">
                <span class="v mem-link" @click="mem.openDetail(q.payload.oldId)">{{ q.payload.oldTitle || q.payload.oldId }} ↗</span>
              </el-tooltip>
              <span class="k">新事实</span>
              <el-tooltip :content="q.payload.newId || ''" :disabled="!q.payload.newId" placement="top">
                <span class="v" :class="{ 'mem-link': !!q.payload.newId }" @click="q.payload.newId && mem.openDetail(q.payload.newId)">{{ q.payload.newTitle || q.payload.newId || "（仅提示，无对应新条）" }}{{ q.payload.newId ? ' ↗' : '' }}</span>
              </el-tooltip>
              <span class="k">判定理由</span>
              <span class="v">{{ q.payload.reason || "—" }}</span>
              <span class="k">置信度</span>
              <span class="v">
                {{ q.payload.confidence }}
                <span v-if="lowConf(q.payload.confidence)" class="mem-chip danger" style="margin-left: 6px">拿不准，建议细看</span>
              </span>
            </div>
            <div class="mem-tile-foot">
              <button :class="lowConf(q.payload.confidence) ? 'btn' : 'btn btn-cta'" :disabled="busy === q.id" @click="resolveSupersede(q, 'confirm')">确认失效</button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveSupersede(q, 'dismiss')">并非矛盾</button>
              <button v-if="q.payload.newId" class="btn btn-ghost" :disabled="busy === q.id" @click="resolveSupersede(q, 'merge')">合并两条</button>
              <MemHelp text="确认失效：旧记忆被标记失效、默认不再被检索到，但原文保留、可查演化链。并非矛盾：两条都保持有效，AI 不再追问。合并两条：把旧的内容并入新的再标失效。" />
            </div>
            <div v-if="supersede.length > RENDER_CAP" class="mem-hint">
              只显示前 {{ RENDER_CAP }} 条（共 {{ supersede.length }} 条）——可用上方「一键推荐确认失效」批量处理
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">没有待确认的失效判定</div>
      </div>
    </template>

    <!-- ② 项目归类 -->
    <template v-else-if="tab === 'classify'">
      <div class="mem-card">
        <div class="mem-card-title" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
          <div>
            项目归类（{{ counts.classify }} 条）
            <span class="mem-hint">没有 Git 地址的记忆，按目录名/标题与已有项目比相似度</span>
            <MemHelp text="归类只认 Git 远程地址（最可靠）。没有远程地址时才退化为名称模糊匹配，而模糊匹配归错了会污染目录结构且难察觉——所以这一档只给建议，等你点头。" />
          </div>
          <div style="display: flex; align-items: center; gap: 12px">
            <span class="mem-row" style="gap: 6px; align-items: center">
              <div class="switch" :class="{ on: autoClassify }" role="switch" :aria-checked="autoClassify" @click="autoClassify = !autoClassify"></div>
              <span class="mem-hint" style="white-space: nowrap">自动按推荐归入<MemHelp text="开启后，之后产生的归类建议不再进入本页等人工确认，而是立即按推荐归入对应项目（无推荐项目时直接忽略，不会乱归）。" /></span>
            </span>
            <el-tooltip
              v-if="counts.classify"
              content="按建议将所有记忆归入推测的项目"
              placement="top"
            >
              <button
                class="btn btn-cta"
                style="font-size: 12px; padding: 4px 12px"
                :disabled="batchBusy || !!busy"
                @click="runBatch(['classify'])"
              >
                {{ batchBusy ? "归入中…" : `一键推荐确认归入（${counts.classify}）` }}
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="counts.classify" class="mem-col">
          <div v-for="s in shownClassify" :key="s.id" class="mem-chain-node" style="flex-wrap: wrap; gap: 8px">
            <span v-if="s.payload.score !== undefined" class="mem-chip" :class="lowConf(s.payload.score) ? 'danger' : 'warn'">置信 {{ s.payload.score }}</span>
            <el-tooltip :content="s.payload.memoryId" placement="top">
              <span class="mem-link" @click="mem.openDetail(s.payload.memoryId)">「{{ s.payload.candidate || s.payload.title }}」 ↗</span>
            </el-tooltip>
            <span style="color: var(--text-3)">疑似属于</span>
            <!-- 改选目标项目：默认 AI 推荐 slug，可换成任意项目再确认 -->
            <MemSelect
              :model-value="pickedSlug(s)"
              :options="projectOptions.length ? projectOptions : (s.payload.slug ? [{ value: s.payload.slug, label: s.payload.name || s.payload.slug || '' }] : [])"
              width="180px"
              @change="(v: string | number) => (classifyPick[s.id] = String(v))"
            />
            <span v-if="lowConf(s.payload.score)" class="mem-chip danger">拿不准，建议细看</span>
            <span style="margin-left: auto; display: flex; gap: 6px">
              <button :class="lowConf(s.payload.score) && pickedSlug(s) !== s.payload.slug ? 'btn' : 'btn btn-cta'" :disabled="busy === s.id || batchBusy" @click="resolveClassify(s, pickedSlug(s))">确认归入</button>
              <button class="btn btn-ghost" :disabled="busy === s.id || batchBusy" @click="resolveClassify(s, null)">不是同一项目</button>
            </span>
            <div v-if="classify.length > RENDER_CAP" class="mem-hint">
              只显示前 {{ RENDER_CAP }} 条（共 {{ classify.length }} 条）——可用上方「一键推荐确认归入」批量处理
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">没有待确认的归类</div>
      </div>
    </template>

    <!-- ③ 去重 -->
    <template v-else>
      <div class="mem-card">
        <div class="mem-card-title" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
          <div>
            去重（{{ counts.dedup }} 条）
            <span class="mem-hint">低置信 UPDATE 与全部 DELETE 都要人工点头</span>
            <MemHelp text="四选一：采纳新记忆（旧的标失效、可追溯）／保留旧记忆（新的丢弃并把来源并入旧的）／两条都留（记住这一对不是重复，以后不再问）／编辑后合并（你手动拼一条）。删除永远不会自动执行。" />
          </div>
          <div style="display: flex; align-items: center; gap: 12px">
            <span class="mem-row" style="gap: 6px; align-items: center">
              <div class="switch" :class="{ on: autoDedup }" role="switch" :aria-checked="autoDedup" @click="autoDedup = !autoDedup"></div>
              <span class="mem-hint" style="white-space: nowrap">自动按推荐采纳<MemHelp text="开启后，之后产生的去重建议不再进入本页等人工确认，而是立即按推荐采纳新记忆（旧记忆标失效、完整保留追溯；删除动作永远存在，不自动执行）。" /></span>
            </span>
            <el-tooltip
              v-if="counts.dedup"
              content="按推荐将所有重复项采纳新记忆生效并保留旧记忆追溯"
              placement="top"
            >
              <button
                class="btn btn-cta"
                style="font-size: 12px; padding: 4px 12px"
                :disabled="batchBusy || !!busy"
                @click="runBatch(['dedup'])"
              >
                {{ batchBusy ? "处理中…" : `一键推荐采纳新记忆（${counts.dedup}）` }}
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="counts.dedup" class="mem-col" style="gap: 10px">
          <div v-for="q in shownDedup" :key="q.id" class="mem-tile">
            <div class="mem-row">
              <span class="mem-chip" :class="q.payload.kind === 'DELETE' ? 'danger' : 'warn'">
                {{ q.payload.kind }}（置信 {{ q.payload.confidence }}）
              </span>
              <span v-if="q.payload.kind === 'DELETE'" class="mem-chip danger">删除类建议，请细看后再选</span>
              <span v-else-if="lowConf(q.payload.confidence)" class="mem-chip danger">拿不准，建议细看</span>
              <span v-if="q.payload.reason" class="mem-hint">{{ q.payload.reason }}</span>
            </div>
            <div class="mem-split-2-1">
              <div class="mem-card" style="background: var(--mem-soft)">
                <div class="mem-hint">已有记忆（旧）</div>
                <div class="mem-link" style="font-size: 12px; margin-top: 4px" @click="mem.openDetail(q.payload.targetId)">{{ q.payload.targetTitle || q.payload.targetId }} ↗</div>
                <div class="mem-hint" style="margin-top: 4px">{{ q.payload.targetSummary || "（无摘要）" }}</div>
              </div>
              <div class="mem-card" style="background: var(--mem-soft)">
                <div class="mem-hint">新记忆</div>
                <div class="mem-link" style="font-size: 12px; margin-top: 4px" @click="mem.openDetail(q.payload.newId)">{{ q.payload.newTitle || q.payload.newId }} ↗</div>
                <div class="mem-hint" style="margin-top: 4px">{{ q.payload.newSummary || "（无摘要）" }}</div>
              </div>
            </div>
            <!-- 三选 + 更多：主按钮只给 UPDATE 且置信达标的建议（删除类与低置信不给主按钮样式，避免诱导盲采） -->
            <div class="mem-tile-foot">
              <button
                :class="q.payload.kind === 'UPDATE' && !lowConf(q.payload.confidence) ? 'btn btn-cta' : 'btn'"
                :disabled="busy === q.id"
                @click="resolveDedup(q, 'adoptNew')"
              >
                采纳新记忆{{ q.payload.kind === 'UPDATE' && !lowConf(q.payload.confidence) ? "（推荐）" : "" }}
              </button>
              <button class="btn btn-ghost" :disabled="busy === q.id" @click="resolveDedup(q, 'keepBoth')">保留两边</button>
              <el-dropdown trigger="click" @command="(c: string) => resolveDedup(q, c as 'keepOld' | 'merge' | 'dismiss')">
                <button class="btn btn-ghost" :disabled="busy === q.id">换个处理 ▾</button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="keepOld">保留旧记忆（丢弃新的）</el-dropdown-item>
                    <el-dropdown-item command="merge">编辑后合并（已预拼草稿）</el-dropdown-item>
                    <el-dropdown-item command="dismiss" divided>忽略（这条不是重复）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <MemHelp text="采纳新记忆：旧的标失效、可撤销；保留旧记忆：新的丢弃并把来源并入旧的；保留两边：记住这一对不是重复，以后不再问；编辑后合并：草稿已预拼新旧全文，改几个字即可。" />
            </div>
            <div v-if="dedup.length > RENDER_CAP" class="mem-hint">
              只显示前 {{ RENDER_CAP }} 条（共 {{ dedup.length }} 条）——可用上方「一键推荐采纳新记忆」批量处理
            </div>
          </div>
        </div>
        <div v-else class="mem-empty">没有待判定的重复</div>
      </div>
    </template>
  </div>
</template>