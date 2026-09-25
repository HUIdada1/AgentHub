<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 进度弹窗：花时间/花 token 的动作（重新生成画像、蒸馏 L2、立即执行任务、导入）
     统一在操作后弹出它展示进度。两种形态：
       ① 有总量（导入、索引）→ 按 done/total 走真实百分比；
       ② 只有阶段（调模型的单次任务）→ 走动效条 + 当前阶段 + 已用时长，不假装有百分比。
     跑完不自动关：弹窗内给出结果（✓/✗ + 详情 + token + 耗时），由你自己看完再关。 -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import MemDialog from "./MemDialog.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    sub?: string;
    /** 正在跑（false 表示已结束，展示 result） */
    running: boolean;
    /** 当前阶段（如「解析来源」「③ 格式能力」） */
    phase?: string;
    /** 阶段详情（后端事件里的 detail） */
    detail?: string;
    /** 进度分子/分母：total > 0 时走真实百分比，否则走不确定动效条 */
    done?: number;
    total?: number;
    /** 附加计数行（新建 / 跳过 / token 等） */
    extra?: { label: string; value: string | number }[];
    /** 开始时间戳（弹窗内自算已用时长） */
    startedAt?: number;
    /** 结束后展示的结果 */
    result?: { ok: boolean; message: string; extra?: string[] } | null;
    /** 中断按钮文案：给了才显示（不给＝不可中断） */
    cancelText?: string;
  }>(),
  { sub: "", phase: "", detail: "", done: 0, total: 0, startedAt: 0, result: null, cancelText: "" },
);

const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  (e: "cancel"): void;
}>();

/** 已用时长：跑动时每秒自增，跑完定格在最终值（不随结果里的毫秒再算一遍） */
const elapsed = ref(0);
let timer: number | undefined;
function stopTimer() {
  if (timer) window.clearInterval(timer);
  timer = undefined;
}
function startTimer() {
  stopTimer();
  const base = props.startedAt || Date.now();
  elapsed.value = Date.now() - base;
  timer = window.setInterval(() => {
    elapsed.value = Date.now() - base;
  }, 1000);
}
watch(
  () => [props.open, props.running, props.startedAt] as const,
  ([open, running]) => {
    if (open && running) startTimer();
    else stopTimer();
  },
  { immediate: true },
);
onUnmounted(stopTimer);

const elapsedText = computed(() => {
  const s = Math.max(0, Math.round(elapsed.value / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
});
/** 有总量走真实百分比，没有就走不确定态（CSS 动效条），不编造数字 */
const determinate = computed(() => props.total > 0);
const percent = computed(() => (determinate.value ? Math.min(100, Math.round((100 * props.done) / props.total)) : 0));
</script>

<template>
  <MemDialog
    :open="open"
    :title="title"
    :sub="sub"
    width="520px"
    :close-on-click-modal="false"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <div class="mpd">
      <!-- 结论行：跑动时是转圈 + 阶段，结束后换成结果 -->
      <div class="mpd-line">
        <span v-if="running" class="mpd-spin" aria-hidden="true"></span>
        <span v-else class="mpd-ico" :class="result?.ok ? 'ok' : 'bad'">{{ result?.ok ? "✓" : "✗" }}</span>
        <span class="mpd-phase">{{ running ? phase || "执行中…" : result?.message || "已结束" }}</span>
        <span class="mpd-time">{{ elapsedText }}</span>
      </div>

      <div class="mem-progress" :class="{ 'is-busy': running && !determinate }">
        <i :style="determinate ? { width: `${percent}%` } : undefined"></i>
      </div>

      <!-- 有总量才有数字行；无总量的跑动态在下面给一句说明，跑完两样都不占位（不留空档） -->
      <div v-if="determinate || running" class="mpd-nums">
        <template v-if="determinate">
          <span class="mem-mono">{{ done }} / {{ total }}</span>
          <span class="mem-chip accent">{{ percent }}%</span>
        </template>
        <span v-else class="mem-hint">这一步由模型处理，没有可拆分的进度：跑完会显示结果</span>
      </div>

      <div v-if="detail" class="mpd-detail">{{ detail }}</div>

      <div v-if="(extra || []).length" class="mem-kv">
        <template v-for="e in extra" :key="e.label">
          <span class="k">{{ e.label }}</span>
          <span class="v">{{ e.value }}</span>
        </template>
      </div>

      <div v-if="!running && result?.extra?.length" class="mem-col" style="gap: 4px">
        <div v-for="(x, i) in result.extra" :key="i" class="mem-hint">{{ x }}</div>
      </div>
    </div>

    <template #foot>
      <button v-if="running && cancelText" class="btn btn-ghost" @click="emit('cancel')">{{ cancelText }}</button>
      <button class="btn btn-ghost" @click="emit('update:open', false)">{{ running ? "后台继续（关闭）" : "关闭" }}</button>
    </template>
  </MemDialog>
</template>