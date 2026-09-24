<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 模型调用统计：今日消耗/调用次数 + 近 30 天按供应商·模型·任务的明细。
     数据源是本模块自己的 llm_call 表（走本机网关的调用另由反代网关模块天然统计，不重复计）。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import { formatInteger } from "../../composables/useFormat";
import MemHelp from "./MemHelp.vue";

const props = defineProps<{
  /** 紧凑模式（仪表盘卡片内）：明细只列前 6 行 */
  compact?: boolean;
}>();

type UsageRow = { provider: string; model: string; task: string; calls: number; tokensIn: number; tokensOut: number; successRate: number };

const rows = ref<UsageRow[]>([]);
const today = ref({ tokens: 0, calls: 0 });
const loading = ref(false);
const limit = computed(() => (props.compact ? 6 : 50));
const monthTotal = computed(() => rows.value.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0));
const successRate = computed(() => {
  const calls = rows.value.reduce((s, r) => s + r.calls, 0);
  if (!calls) return null;
  return Math.round((rows.value.reduce((s, r) => s + r.successRate * r.calls, 0) / calls) * 1000) / 10;
});

async function load() {
  loading.value = true;
  try {
    const r = await api.memoryLlmUsage(30);
    rows.value = r.usage as unknown as UsageRow[];
    today.value = r.today;
  } catch {
    /* 模型未配置时不报错，留空态 */
  } finally {
    loading.value = false;
  }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <div class="mem-col">
    <div class="mem-kv">
      <span class="k">今日消耗</span>
      <span class="v">{{ formatInteger(today.tokens) }} token（{{ today.calls }} 次调用）</span>
      <span class="k">近 30 天</span>
      <span class="v">{{ formatInteger(monthTotal) }} token<template v-if="successRate !== null"> · 成功率 {{ successRate }}%</template></span>
    </div>
    <div class="mem-table-wrap">
      <table v-if="rows.length" class="mem-table">
        <thead><tr><th>供应商</th><th>模型</th><th>任务</th><th>次数</th><th>输入</th><th>输出</th><th>成功率</th></tr></thead>
        <tbody>
          <tr v-for="(u, i) in rows.slice(0, limit)" :key="i">
            <td class="mem-mono">{{ u.provider }}</td>
            <td class="mem-mono">{{ u.model }}</td>
            <td>{{ u.task }}</td>
            <td class="num">{{ u.calls }}</td>
            <td class="num">{{ formatInteger(u.tokensIn) }}</td>
            <td class="num">{{ formatInteger(u.tokensOut) }}</td>
            <td class="num">{{ Math.round((u.successRate || 0) * 100) }}%</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="mem-empty">{{ loading ? "正在读取…" : "还没有调用记录（配置模型并跑一次 AI 任务后这里会有数据）" }}</div>
    </div>
    <div class="mem-hint">
      记账在本模块 llm_call 表：每次 AI 任务（抽取/打标/去重/蒸馏/画像）的模型、耗时、token 与成败都记一行。
      走本机网关的调用另外由反代网关模块统计，两处口径不重叠。
      <MemHelp text="这里只统计记忆模块自己发起的调用。若想知道「总共花了多少」，把本表 + 反代网关用量页 + 各 Agent 自身用量一起看。" />
    </div>
  </div>
</template>
