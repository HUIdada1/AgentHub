<!--
  ============================================================
   作者：沐晖
   日期：2026-10-29
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
      此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 用量 KPI 六宫格（区间口径：总请求 / 总 Token / 成功率 / 平均耗时 / 输入 Token / 输出 Token）

     为什么抽成一个组件而不是两页各写一遍：总览的「近 7 天」与「用量统计」页展示的是
     **同一组指标、同一个后端聚合**（localgw/stats.cjs 的 kpis）。一旦各写一份，成功率是
     0~100 还是 0~1、平均耗时算不算失败请求、占比的分子分母取谁——这些口径迟早会漂，
     而「两个页面的数字对不上」是最伤信任的一类 bug（项目里已有过 stats.db 双份数的教训）。

     版式直接走全局 .kpis .kpis-6 .kpi（与全站统计卡同一配方，不新建一套皮肤）：
     label 一行 + 数值一行 + 一行灰色副信息（small）。副信息是「这个数字怎么来的」，
     用 hover 才能看到等于没写，所以常驻显示；完整说明再挂 title。 -->
<script setup lang="ts">
import { computed } from "vue";
import type { LocalgwStatsOverview } from "../../api/ipc";
import { fmtInt, fmtK, fmtMs } from "../../views/proxy/format";

const props = withDefaults(
  defineProps<{
    /** 区间聚合的 kpis（后端 localgw_stats_overview 原样字段；null = 还没拉到） */
    kpis: LocalgwStatsOverview["kpis"] | null;
    /** 首屏加载中：只用于占位文案，不影响已有数字的显示（抖动不该把数字擦成 0） */
    loading?: boolean;
  }>(),
  { loading: false },
);

type Card = {
  label: string;
  value: string;
  /** acc / err 走全局 .kpi b 的语义色（成功率高=主色，低=危险色） */
  cls: string;
  /** 常驻副信息：口径的来源 */
  sub: string;
  /** 悬停补全：完整说明（含分位、分子分母） */
  title: string;
};

const cards = computed<Card[]>(() => {
  const k = props.kpis;
  const req = Number(k?.req) || 0;
  const tokens = Number(k?.tokens) || 0;
  const pt = Number(k?.promptTokens) || 0;
  const ct = Number(k?.completionTokens) || 0;
  // 成功率是 **0~100 的百分数**（与 localgw_status.errRate 的 0~1 不同，不要再 ×100）；
  // 零请求时后端恒回 0，直接显示 "100.0%" 会被读成「全部成功」，所以单独置 null 显示 —
  const rate = req > 0 ? Number(k?.successRate) || 0 : null;
  // 失败数按成功率反推（kpis 只回 successRate，没有 ok/err 计数）：与后端
  // 「err = req - 成功数、successRate 与 err 严格互补」的口径一致，只用于副信息，不参与计算
  const errCount = rate == null ? 0 : Math.max(0, Math.round((req * (100 - rate)) / 100));
  const okCount = Math.max(0, req - errCount);
  const avgMs = Number(k?.avgMs) || 0;
  const p50 = Number(k?.p50Ms) || 0;
  const p95 = Number(k?.p95Ms) || 0;
  // 输入/输出占总量比：分母固定是 tokens（= pt + ct），不各自为分母，否则两个百分比加不出 100%
  const pct = (v: number) => (tokens ? Math.round((v / tokens) * 1000) / 10 : 0);
  const idle = props.loading ? "加载中…" : "该区间暂无请求";
  const empty = "—";

  return [
    {
      label: "总请求",
      value: req ? fmtInt(req) : empty,
      cls: req ? "acc" : "",
      sub: req ? `成功 ${fmtInt(okCount)} · 失败 ${fmtInt(errCount)}` : idle,
      title: req ? `成功 ${fmtInt(okCount)} · 失败 ${fmtInt(errCount)}` : "该区间还没有请求落账",
    },
    {
      label: "总 Token",
      value: tokens ? fmtK(tokens) : empty,
      cls: "",
      sub: tokens ? `输入 ${fmtK(pt)} + 输出 ${fmtK(ct)}` : idle,
      title: `输入 ${fmtInt(pt)} + 输出 ${fmtInt(ct)} = ${fmtInt(tokens)}`,
    },
    {
      label: "成功率",
      value: rate == null ? empty : `${rate.toFixed(1)}%`,
      // 阈值与「用量统计」页一致：<99% 标红（有失败请求就该看一眼），其余走主色
      cls: rate == null ? "" : rate < 99 ? "err" : "acc",
      sub: req ? `成功 ${fmtInt(okCount)} / 共 ${fmtInt(req)}` : idle,
      title: req ? `成功 ${fmtInt(okCount)} / 共 ${fmtInt(req)} 次请求` : "零请求时成功率无意义，故显示 —",
    },
    {
      label: "平均耗时",
      // fmtMs(0) 回 "-"：零请求时不该出现 "0ms" 这种看着像很快的假数字
      value: avgMs ? fmtMs(avgMs) : empty,
      cls: "",
      sub: avgMs ? `P50 ${fmtMs(p50)} · P95 ${fmtMs(p95)}` : idle,
      title: `P50 ${fmtMs(p50)} · P95 ${fmtMs(p95)}（只统计成功请求，失败请求的耗时没有参考意义）`,
    },
    {
      label: "输入 Token",
      value: pt ? fmtK(pt) : empty,
      cls: "",
      sub: tokens ? `占总量 ${pct(pt)}%` : idle,
      title: `占总量 ${pct(pt)}% · ${fmtInt(pt)} Token`,
    },
    {
      label: "输出 Token",
      value: ct ? fmtK(ct) : empty,
      cls: "",
      sub: tokens ? `占总量 ${pct(ct)}%` : idle,
      title: `占总量 ${pct(ct)}% · ${fmtInt(ct)} Token`,
    },
  ];
});
</script>

<template>
  <div class="kpis kpis-6 lgw-kpi-grid">
    <div v-for="c in cards" :key="c.label" class="kpi" :title="c.title">
      <span>{{ c.label }}</span>
      <b :class="c.cls">{{ c.value }}</b>
      <small>{{ c.sub }}</small>
    </div>
  </div>
</template>

<style scoped>
/* 只补三件全局 .kpi 没管的事：卡片纵向排布、副信息与数值的间距、窄卡时副信息单行省略。
   颜色/字号/圆角全部沿用全局 token，不在这里另起一套数值 */
.lgw-kpi-grid .kpi {
  display: flex;
  flex-direction: column;
}
.lgw-kpi-grid .kpi small {
  display: block;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
