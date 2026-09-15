<!-- 反代网关 · 用量统计：指标卡 + 近 7 日趋势 + TOP 排行（渠道/模型/Key/账号）+ 明细分页（方案 §7 stats.html）
     口径：不设日聚合冗余表，全部由 usage_requests 流水直查 GROUP BY；流水保留 90 天 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyStatsOverview, ProxyStatsDetail } from "../../types";
import { fmtInt, fmtK, fmtMs, fmtTime, fmtDate, channelName, statusCls } from "./format";

const DAYS = 7;
const ov = ref<ProxyStatsOverview | null>(null);
const detail = ref<ProxyStatsDetail | null>(null);
const page = ref(1);
const pageSize = 10;
const dim = ref<"channel" | "model" | "key" | "account">("channel");
const err = ref("");

const DIMS = [
  { value: "channel" as const, label: "渠道" },
  { value: "model" as const, label: "模型" },
  { value: "key" as const, label: "Key" },
  { value: "account" as const, label: "账号" },
];

const topRows = computed(() => {
  const rows = ov.value?.tops[dim.value] || [];
  const total = rows.reduce((s, r) => s + r.req, 0) || 1;
  return rows.map((r) => ({ ...r, label: dim.value === "channel" ? channelName(r.name) : r.name, pct: Math.round((r.req / total) * 100) }));
});

const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / pageSize)));

// 近 7 日趋势：零依赖 SVG 折线（对齐设计稿 charts.js 的 line）
const trendPath = computed(() => {
  const t = ov.value?.trend || [];
  if (!t.length) return { line: "", area: "", max: 0 };
  const w = 560;
  const h = 96;
  const max = Math.max(...t.map((x) => x.req), 1);
  const pts = t.map((x, i) => [((i + 0.5) / t.length) * w, h - 8 - (x.req / max) * (h - 20)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return { line, area, max };
});

async function refresh() {
  try {
    ov.value = await api.proxyStatsOverview(DAYS);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function loadDetail() {
  try {
    detail.value = await api.proxyStatsDetail({ page: page.value, pageSize });
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

onMounted(() => {
  refresh();
  loadDetail();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">用量统计</div>
        <div class="page-sub">请求与 Token 消耗明细（流水保留 90 天，统计直查流水）</div>
      </div>
      <div class="page-actions"><span class="pill">范围 近 {{ DAYS }} 日</span></div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="kpis">
        <div class="kpi"><span>今日请求</span><b class="acc">{{ fmtInt(ov?.today.req || 0) }}</b></div>
        <div class="kpi"><span>今日 Token</span><b>{{ fmtK(ov?.today.tokens || 0) }}</b></div>
        <div class="kpi"><span>成功率</span><b>{{ (ov?.today.successRate ?? 100).toFixed(1) }}%</b></div>
        <div class="kpi"><span>TTFT 均值</span><b>{{ fmtMs(ov?.today.ttftAvg || 0) }}</b></div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">近 {{ DAYS }} 日请求趋势 <span class="right">峰值 {{ fmtInt(trendPath.max) }} / 日</span></div>
        <svg viewBox="0 0 560 96" class="trend" preserveAspectRatio="none">
          <path v-if="trendPath.area" :d="trendPath.area" class="trend-area" />
          <path v-if="trendPath.line" :d="trendPath.line" class="trend-line" />
        </svg>
        <div class="trend-days">
          <span v-for="t in ov?.trend || []" :key="t.day">{{ t.day.slice(5) }}</span>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          用量占比 TOP
          <div class="chips" style="margin-left: 8px">
            <button v-for="d in DIMS" :key="d.value" class="chip" :class="{ active: dim === d.value }" @click="dim = d.value">{{ d.label }}</button>
          </div>
        </div>
        <div class="rows">
          <div v-for="r in topRows" :key="r.name" class="row">
            <div class="grow"><div class="name">{{ r.label }}</div></div>
            <div class="ratio" style="flex: 1">
              <div class="ratio-track"><div class="ratio-fill" :style="{ width: r.pct + '%' }"></div></div>
              <span class="num">{{ r.pct }}% · {{ fmtInt(r.req) }} 次 · {{ fmtK(r.tokens) }}</span>
            </div>
          </div>
          <div v-if="!topRows.length" class="set-desc" style="padding: 8px 0">近 {{ DAYS }} 日暂无请求数据</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          请求明细
          <span class="right">{{ fmtInt(detail?.total || 0) }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr><th>时间</th><th>模型</th><th>渠道</th><th>KEY</th><th>账号</th><th>状态</th><th>请求 Tok</th><th>响应 Tok</th><th>TTFT</th><th>耗时</th></tr>
              <tr v-for="r in detail?.rows || []" :key="r.id">
                <td class="mono" :title="fmtDate(r.ts)">{{ fmtTime(r.ts) }}</td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td>{{ channelName(r.channel) }}</td>
                <td class="mono">{{ r.keyName || "-" }}</td>
                <td>{{ r.accountName || "-" }}</td>
                <td>
                  <span class="tag" :class="statusCls(r.status)" :title="r.error">{{ r.status || "-" }}</span>
                </td>
                <td class="mono">{{ fmtInt(r.promptTokens) }}</td>
                <td class="mono">{{ fmtInt(r.completionTokens) }}</td>
                <td class="mono">{{ fmtMs(r.ttftMs) }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
              </tr>
              <tr v-if="!(detail?.rows || []).length">
                <td colspan="10" style="text-align: center; color: var(--text-3); padding: 18px">暂无请求明细</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.trend {
  width: 100%;
  height: 96px;
  display: block;
}
.trend-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.trend-area {
  fill: var(--accent-dim, rgba(68, 224, 127, 0.12));
  stroke: none;
}
.trend-days {
  display: flex;
  justify-content: space-around;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.pager {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
