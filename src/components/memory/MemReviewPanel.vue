<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 待确认收件箱（原独立页签，现为「记忆浏览」的第三个视图）：
     三类人工裁决集中一处（事实失效 / 项目归类 / 去重），AI 只建议不自动改。
     本面板不自带页面头部——页头属于记忆浏览；三个队列各有一枚待处理红点。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { coalesceAsync } from "../../utils/timing";
import MemHelp from "./MemHelp.vue";

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

async function resolveSupersede(item: SupersedeItem, action: "confirm" | "dismiss" | "merge") {
  busy.value = item.id;
  try {
    await api.memoryReviewResolve(item.id, action);
    ElMessage.success(action === "confirm" ? "已标记旧事实失效" : action === "merge" ? "已合并两条" : "已判定为并非矛盾");
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
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
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  } finally {
    busy.value = "";
  }
}

/** 一键按推荐确认事实失效 */
async function batchConfirmSupersede() {
  if (!supersede.value.length || batchBusy.value) return;
  const count = supersede.value.length;
  try {
    await ElMessageBox.confirm(
      `确定将当前待确认的 ${count} 条事实矛盾全部按推荐确认失效？\n（旧事实将被标记失效，不再被默认检索，但原文与演化链完整保留）`,
      "一键推荐确认失效",
      {
        confirmButtonText: "确认失效",
        cancelButtonText: "取消",
        type: "warning",
      }
    );
  } catch {
    return;
  }

  batchBusy.value = true;
  let successCount = 0;
  let failCount = 0;
  try {
    for (const item of [...supersede.value]) {
      try {
        await api.memoryReviewResolve(item.id, "confirm");
        successCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount > 0) {
      ElMessage.warning(`处理完成：${successCount} 条成功，${failCount} 条失败`);
    } else {
      ElMessage.success(`已一键按推荐确认失效 ${successCount} 条记忆`);
    }
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "批量确认失效失败");
  } finally {
    batchBusy.value = false;
  }
}

/** 一键按推荐确认项目归类 */
async function batchConfirmClassify() {
  if (!classify.value.length || batchBusy.value) return;
  const count = classify.value.length;
  try {
    await ElMessageBox.confirm(
      `确定将当前待确认的 ${count} 条记忆全部按建议归入对应项目？`,
      "一键推荐归入项目",
      {
        confirmButtonText: "确认归入",
        cancelButtonText: "取消",
        type: "info",
      }
    );
  } catch {
    return;
  }

  batchBusy.value = true;
  let successCount = 0;
  let failCount = 0;
  try {
    for (const item of [...classify.value]) {
      const slug = item.payload.slug || null;
      try {
        await api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss", slug ? { slug } : undefined);
        successCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount > 0) {
      ElMessage.warning(`批量处理完成：${successCount} 条成功，${failCount} 条失败`);
    } else {
      ElMessage.success(`已一键推荐归入 ${successCount} 条记忆`);
    }
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "批量归入失败");
  } finally {
    batchBusy.value = false;
  }
}

/** 一键按推荐处理去重（采纳新记忆） */
async function batchConfirmDedup() {
  if (!dedup.value.length || batchBusy.value) return;
  const count = dedup.value.length;
  try {
    await ElMessageBox.confirm(
      `确定将当前待确认的 ${count} 条去重建议全部按推荐采纳新记忆？\n（将采纳新记忆生效，旧记忆标记失效并保留追溯）`,
      "一键推荐采纳新记忆",
      {
        confirmButtonText: "确认采纳",
        cancelButtonText: "取消",
        type: "info",
      }
    );
  } catch {
    return;
  }

  batchBusy.value = true;
  let successCount = 0;
  let failCount = 0;
  try {
    for (const item of [...dedup.value]) {
      try {
        await api.memoryDedupReviewResolve(item.id, "adoptNew");
        successCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount > 0) {
      ElMessage.warning(`处理完成：${successCount} 条成功，${failCount} 条失败`);
    } else {
      ElMessage.success(`已一键按推荐采纳 ${successCount} 条新记忆`);
    }
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "批量处理去重失败");
  } finally {
    batchBusy.value = false;
  }
}

/** 一键按推荐处理全部待确认事项 */
async function batchConfirmAll() {
  if (!total.value || batchBusy.value) return;
  const lines = [
    `将按各队列推荐方案一键处理全部 ${total.value} 条待确认事项：`,
    counts.value.supersede ? `• 事实失效（${counts.value.supersede} 条）：按推荐标记旧事实失效` : "",
    counts.value.classify ? `• 项目归类（${counts.value.classify} 条）：按推荐归入对应项目` : "",
    counts.value.dedup ? `• 记忆去重（${counts.value.dedup} 条）：按推荐采纳新记忆` : "",
    "",
    "所有操作均不物理删除原文（保留完整演化链与追溯）。确定立即执行？",
  ].filter(Boolean).join("\n");

  try {
    await ElMessageBox.confirm(lines, "一键推荐处理全部", {
      confirmButtonText: "全部一键处理",
      cancelButtonText: "取消",
      type: "info",
    });
  } catch {
    return;
  }

  batchBusy.value = true;
  let successCount = 0;
  let failCount = 0;
  try {
    // 1. 处理事实失效
    for (const item of [...supersede.value]) {
      try {
        await api.memoryReviewResolve(item.id, "confirm");
        successCount++;
      } catch {
        failCount++;
      }
    }
    // 2. 处理项目归类
    for (const item of [...classify.value]) {
      const slug = item.payload.slug || null;
      try {
        await api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss", slug ? { slug } : undefined);
        successCount++;
      } catch {
        failCount++;
      }
    }
    // 3. 处理记忆去重
    for (const item of [...dedup.value]) {
      try {
        await api.memoryDedupReviewResolve(item.id, "adoptNew");
        successCount++;
      } catch {
        failCount++;
      }
    }

    if (failCount > 0) {
      ElMessage.warning(`一键处理完成：${successCount} 条成功，${failCount} 条失败`);
    } else {
      ElMessage.success(`已按推荐一键处理全部 ${successCount} 条待确认事项`);
    }
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "一键批量处理失败");
  } finally {
    batchBusy.value = false;
  }
}

async function resolveDedup(item: DedupItem, action: "adoptNew" | "keepOld" | "keepBoth" | "merge" | "dismiss") {
  let text: string | undefined;
  if (action === "merge") {
    // 「合并两条」默认取新记忆完整正文（不是摘要）：先拉详情，拉不到再退回 summary
    let defaultText = item.payload.newSummary || "";
    try {
      const r = await api.memoryGet(item.payload.newId);
      if (r?.memory?.body) defaultText = r.memory.body;
    } catch {
      /* 兜底回 summary */
    }
    try {
      const r = await ElMessageBox.prompt("编辑合并后的正文（默认取新记忆完整内容）", "编辑后合并", {
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
    await api.memoryDedupReviewResolve(item.id, action, text ? { text } : undefined);
    ElMessage.success("已处理");
    await refresh();
    await mem.loadStats();
    await mem.refreshPending(true);
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
          <MemHelp text="三件事需要你确认：① 事实失效（新记忆推翻了旧的）② 项目归类（名称模糊匹配的结果）③ 去重（低置信的重复判定）。每一项都有明确的取舍说明，选错可恢复（旧记忆只标失效、原文都在）。" />
        </p>
      </div>
      <div class="mem-head-actions" style="display: flex; align-items: center; gap: 10px">
        <el-tooltip
          v-if="total > 0"
          content="按各队列推荐方案一次性处理全部待确认事项"
          placement="top"
        >
          <button
            class="btn btn-cta"
            style="font-size: 12px; padding: 4px 12px"
            :disabled="batchBusy || !!busy"
            @click="batchConfirmAll"
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
                @click="batchConfirmSupersede"
              >
                {{ batchBusy ? "处理中…" : `一键推荐确认失效（${counts.supersede}）` }}
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="counts.supersede" class="mem-col" style="gap: 10px">
          <div v-for="q in supersede" :key="q.id" class="mem-tile">
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
                @click="batchConfirmClassify"
              >
                {{ batchBusy ? "归入中…" : `一键推荐确认归入（${counts.classify}）` }}
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="counts.classify" class="mem-col">
          <div v-for="s in classify" :key="s.id" class="mem-chain-node" style="flex-wrap: wrap; gap: 8px">
            <span v-if="s.payload.score !== undefined" class="mem-chip warn">置信 {{ s.payload.score }}</span>
            <el-tooltip :content="s.payload.memoryId" placement="top">
              <span class="mem-link" @click="mem.openDetail(s.payload.memoryId)">「{{ s.payload.candidate || s.payload.title }}」 ↗</span>
            </el-tooltip>
            <span style="color: var(--text-3)">疑似属于</span>
            <span class="mem-chip accent">{{ s.payload.name || s.payload.slug }}</span>
            <span style="margin-left: auto; display: flex; gap: 6px">
              <button class="btn btn-cta" :disabled="busy === s.id || batchBusy" @click="resolveClassify(s, s.payload.slug || null)">确认归入</button>
              <button class="btn btn-ghost" :disabled="busy === s.id || batchBusy" @click="resolveClassify(s, null)">不是同一项目</button>
            </span>
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
                @click="batchConfirmDedup"
              >
                {{ batchBusy ? "处理中…" : `一键推荐采纳新记忆（${counts.dedup}）` }}
              </button>
            </el-tooltip>
          </div>
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
                <div class="mem-link" style="font-size: 12px; margin-top: 4px" @click="mem.openDetail(q.payload.targetId)">{{ q.payload.targetTitle || q.payload.targetId }} ↗</div>
                <div class="mem-hint" style="margin-top: 4px">{{ q.payload.targetSummary || "（无摘要）" }}</div>
              </div>
              <div class="mem-card" style="background: var(--mem-soft)">
                <div class="mem-hint">新记忆</div>
                <div class="mem-link" style="font-size: 12px; margin-top: 4px" @click="mem.openDetail(q.payload.newId)">{{ q.payload.newTitle || q.payload.newId }} ↗</div>
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