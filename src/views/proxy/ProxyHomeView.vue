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
<!-- 号池管家 · 总览：各渠道余额聚合 / 账号可用性 / 最近动态
     原「反代网关」总览的服务开关、接入地址、实时请求流与快速上手已随转发能力下线 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyGatewayStatus, ProxyOpLogRow, ProxyChannelId } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtTime, fmtDate, fmtBalance, balanceUnit, isQoderChannel } from "./format";
import { coalesceAsync } from "../../utils/timing";

const app = useAppStore();
const st = ref<ProxyGatewayStatus | null>(null);
const recent = ref<ProxyOpLogRow[]>([]);
const busyChannel = ref("");
const busyAll = ref(false);
const err = ref("");
const updatedAt = ref(0);
let offEvent: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    st.value = await api.proxyStatus();
    const log = await api.proxyOpLogList({ limit: 8, offset: 0 }).catch(() => null);
    if (log) recent.value = log.rows;
    updatedAt.value = Date.now();
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

const channels = computed(() => st.value?.channels || []);

/** 刷新全部渠道余额：逐账号串行，慢是正常的（后端无超时限制） */
async function refreshAll() {
  if (busyAll.value) return;
  busyAll.value = true;
  err.value = "";
  try {
    const r = await api.proxyCreditsRefresh();
    if (r && r.ok === false) err.value = r.message || "刷新失败";
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busyAll.value = false;
    await refresh();
  }
}

async function refreshOne(channel: string) {
  if (busyChannel.value) return;
  busyChannel.value = channel;
  err.value = "";
  try {
    const r = await api.proxyCreditsRefreshChannel(channel as ProxyChannelId);
    if (r && r.ok === false) err.value = "该渠道没有可刷新的账号";
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busyChannel.value = "";
    await refresh();
  }
}

function goAgents() {
  app.activeModule = "proxy";
  app.setPage("agents");
}

const active = computed(() => app.activeModule === "proxy" && app.activePage === "home");
const scheduleRefresh = coalesceAsync(refresh, 1000);

function startPoll() {
  stopPoll();
  pollTimer = setInterval(scheduleRefresh, 15000);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

watch(active, (on) => {
  if (on) {
    refresh();
    startPoll();
  } else {
    stopPoll();
    scheduleRefresh.cancel();
  }
});

onMounted(() => {
  refresh();
  startPoll();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if (!active.value) return;
    if (p.type === "status" || p.type === "credits" || p.type === "poolsync") scheduleRefresh();
  });
});
onUnmounted(() => {
  stopPoll();
  scheduleRefresh.cancel();
  if (offEvent) offEvent();
});

/** 渠道余额的 tooltip：zcode 与 Qoder 的数值需要精确值对照 */
function balanceTip(c: { id: string; totalCredits: number }) {
  if (c.id === "zcode") return `${fmtInt(c.totalCredits)} Tokens`;
  if (isQoderChannel(c.id)) return `${c.totalCredits} Credits（精确值）`;
  return "";
}
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">{{ err }}</div>
      </div>

      <div class="kpis kpis-compact">
        <div class="kpi"><span>启用渠道</span><b class="acc">{{ st?.channelCount ?? 0 }}<i class="kpi-unit">个</i></b></div>
        <div class="kpi"><span>号池账号</span><b>{{ st?.accountCount ?? 0 }}<i class="kpi-unit">个</i></b></div>
        <div class="kpi"><span>在线可用</span><b>{{ st?.onlineCount ?? 0 }}<i class="kpi-unit">个</i></b></div>
        <div class="kpi"><span>即将到期</span><b>{{ st?.expiringSoonCount ?? 0 }}<i class="kpi-unit">个</i></b></div>
      </div>

      <div class="card">
        <div class="card-title">
          渠道余额
          <span class="right">
            <template v-if="updatedAt">更新于 {{ fmtTime(updatedAt) }} · </template>
            <button class="link-btn" :disabled="busyAll" @click="refreshAll">{{ busyAll ? "刷新中…" : "刷新全部" }}</button>
          </span>
        </div>
        <div v-if="!channels.length" class="empty">还没有启用的渠道 —— 到「号池」页添加账号，或在「配置 · 号池管家」里打开渠道</div>
        <div v-else class="ch-grid">
          <div v-for="c in channels" :key="c.id" class="ch-card">
            <div class="ch-head">
              <span class="ch-name">{{ c.display }}</span>
              <span class="tag" :class="c.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
                {{ c.accountCount ? `${c.onlineCount}/${c.accountCount} 可用` : "未配置" }}
              </span>
            </div>
            <div class="ch-balance">
              <el-tooltip :content="balanceTip(c)" :disabled="!balanceTip(c)" placement="top">
                <b class="big-num">{{ fmtBalance(c.totalCredits, c.id) }}</b>
              </el-tooltip>
              <span class="unit">{{ balanceUnit(c.id) }}</span>
            </div>
            <div class="ch-meta">
              <span>最早到期 {{ c.earliestExpire ? fmtDate(c.earliestExpire) : "-" }}</span>
              <span v-if="c.expiringSoon" class="tag tag-warn">有即将到期</span>
            </div>
            <div class="ch-foot">
              <span class="muted">今日 {{ fmtInt(c.todayReq) }} 次 · {{ fmtK(c.todayTokens) }} tokens</span>
              <button class="link-btn" :disabled="!!busyChannel || !c.accountCount" @click="refreshOne(c.id)">
                {{ busyChannel === c.id ? "刷新中…" : "刷新余额" }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          最近动态
          <span class="right">
            <button class="link-btn" @click="goAgents">去号池 →</button>
          </span>
        </div>
        <div class="table-scroll">
          <table class="table table-bare">
            <thead>
              <tr><th>时间</th><th>类型</th><th>渠道</th><th>内容</th></tr>
            </thead>
            <tbody>
              <tr v-if="!recent.length">
                <td colspan="4" class="empty-cell">暂无操作记录</td>
              </tr>
              <tr v-for="r in recent" :key="r.id">
                <td class="mono">{{ fmtDate(r.ts) }} {{ fmtTime(r.ts) }}</td>
                <td>
                  <span class="pill" :class="r.level === 'error' ? 'err' : r.level === 'warn' ? 'warn' : 'ok'">{{ r.op || "-" }}</span>
                </td>
                <td>{{ r.channel || "-" }}</td>
                <td class="msg">{{ r.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 总览专属的压扁 KPI 卡：标题与数值同行（全局 .kpi 是上下两行的统计卡，这里只覆盖本页，不动其它模块） */
.kpis-compact {
  margin-bottom: 12px;
}
.kpis-compact .kpi {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
}
.kpis-compact .kpi span {
  flex: none;
}
.kpis-compact .kpi b {
  margin-top: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  font-size: 17px;
}
.kpi-unit {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 400;
  font-style: normal;
  color: var(--text-3);
  letter-spacing: 0;
}
.ch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.ch-card {
  border: 1px solid var(--line);
  border-radius: var(--r-md, 10px);
  padding: 12px 14px;
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ch-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.ch-balance {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.big-num {
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
  font-size: 24px;
  letter-spacing: -1px;
}
.unit {
  font-size: 11px;
  color: var(--text-3);
}
.ch-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
}
.ch-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.muted {
  font-size: 11px;
  color: var(--text-3);
}
.link-btn {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-strong);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.link-btn:hover {
  text-decoration: underline;
}
.link-btn:disabled {
  color: var(--text-3);
  cursor: default;
  text-decoration: none;
}
.empty {
  padding: 20px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 20px 0;
}
.msg {
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
</style>
