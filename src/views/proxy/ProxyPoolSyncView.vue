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
<!-- 反代网关 · 号池同步：多设备共享号池（账号+凭据经 WebDAV 密码加密打包）。
     渠道可选「全部 / 只同步某一个编译器」；进度按阶段锚点百分比 + 实时细节展示；
     入口：号池页右上按钮与「用量统计」页头右侧按钮 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelId } from "../../types";
import { useAppStore } from "../../stores/app";
import { channelName } from "./format";

const app = useAppStore();
const st = ref<api.ProxyPoolSyncStatus | null>(null);
const err = ref("");
const runMsg = ref("");
const targetChannel = ref<ProxyChannelId | "">("");
let offEvent: (() => void) | undefined;

// 渠道列表动态取号池视图（原写死常量不会跟随渠道启闭：关闭的渠道不进同步范围）
const CHANNELS = ref<{ id: ProxyChannelId | ""; label: string }[]>([{ id: "", label: "全部渠道" }]);
async function loadChannels() {
  try {
    const pool = await api.proxyPool();
    CHANNELS.value = [{ id: "", label: "全部渠道" }, ...pool.map((c) => ({ id: c.id, label: c.display }))];
    // 当前目标渠道被关闭时回落「全部」
    if (targetChannel.value && !pool.some((c) => c.id === targetChannel.value)) targetChannel.value = "";
  } catch {
    /* 浏览器预览走 mock，失败保留静态兜底 */
  }
}

const running = computed(() => !!st.value?.running);
const percent = computed(() => Math.max(0, Math.min(100, st.value?.percent ?? 0)));

async function refreshStatus() {
  try {
    st.value = await api.proxyPoolsyncStatus();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function runSync() {
  if (running.value) return;
  runMsg.value = "";
  err.value = "";
  try {
    const r = await api.proxyPoolsyncRun(targetChannel.value);
    runMsg.value = r?.ok ? r.summary || "同步完成" : r?.message || "同步失败";
  } catch (e) {
    runMsg.value = String((e as Error).message || e);
  }
  await refreshStatus();
}

async function cancelSync() {
  await api.proxyPoolsyncCancel().catch(() => {});
}

function onEvent(e: unknown) {
  const p = e as { event?: string; type?: string; stage?: string; detail?: string; percent?: number; running?: boolean };
  if (p.event !== "proxy" || p.type !== "poolsync") return;
  if (st.value) {
    if (p.running != null) st.value.running = p.running;
    if (p.stage) st.value.stage = p.stage;
    if (p.detail != null) st.value.detail = p.detail;
    if (p.percent != null) st.value.percent = p.percent;
  }
  if (p.running === false) refreshStatus(); // 结束拿最终摘要与 lastSyncAt
}

onMounted(() => {
  refreshStatus();
  loadChannels();
  offEvent = api.onUpdateEvent(onEvent);
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <!-- 顶部状态操作栏：去掉大标题，整合状态与核心操作按钮 -->
    <div class="poolsync-top-bar">
      <div class="top-bar-left">
        <span class="sync-status-badge" :class="st?.configured ? 'is-configured' : 'is-local'">
          <span class="status-dot"></span>
          {{ st?.configured ? "WebDAV 已连接" : "本地模式（未配置云同步）" }}
        </span>
        <span class="top-bar-tip">
          账号凭据端到端加密，多设备自动去重合并
        </span>
      </div>
      <div class="top-bar-right">
        <button v-if="st && !st.configured" class="btn btn-sm btn-primary" @click="app.openSettings('webdav')">
          去配置 WebDAV
        </button>
        <button v-else-if="running" class="btn btn-sm btn-stop" @click="cancelSync">
          取消同步
        </button>
        <button v-else class="btn btn-sm btn-primary" :disabled="!st?.configured" @click="runSync">
          <svg class="sync-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          {{ targetChannel ? `同步 ${channelName(targetChannel)}` : "立即同步" }}
        </button>
      </div>
    </div>

    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 核心指标状态卡片组：置于顶部 -->
      <div class="kpis poolsync-kpis">
        <div class="kpi">
          <span>上次同步</span>
          <b class="mono">{{ st?.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "从未" }}</b>
        </div>
        <div class="kpi">
          <span>本机设备</span>
          <b>{{ st?.deviceName || "-" }}</b>
        </div>
        <div class="kpi">
          <span>云端服务</span>
          <b :class="st?.configured ? 'text-ok' : 'text-warn'">{{ st?.configured ? "WebDAV 已就绪" : "未配置" }}</b>
        </div>
        <div class="kpi">
          <span>加密规格</span>
          <b>AES-256-GCM</b>
        </div>
      </div>

      <!-- 未配置 WebDAV 时的引导卡 -->
      <div v-if="st && !st.configured" class="card local-mode-card">
        <div class="card-title">
          <span>尚未开启跨设备同步</span>
        </div>
        <div class="set-desc">
          当前号池仅保存在本机。配置 WebDAV 服务器后，多台电脑即可经端到端加密自动去重合并号池；换机迁移或团队共享更轻松。
        </div>
      </div>

      <!-- 同步范围设置卡片 -->
      <div class="card sync-scope-card">
        <div class="card-title">
          <span>同步范围</span>
          <span class="title-sub">选择单一渠道时仅同步该渠道账号，不影响其他编译器号池</span>
        </div>
        <div class="chips">
          <button
            v-for="c in CHANNELS"
            :key="c.id"
            class="chip"
            :class="{ active: targetChannel === c.id }"
            :disabled="running"
            @click="targetChannel = c.id"
          >
            {{ c.label }}
          </button>
        </div>
      </div>

      <!-- 同步进度与执行细节卡片 -->
      <div class="card sync-progress-card">
        <div class="card-title">
          <span>同步进度</span>
          <span class="right">
            <span v-if="running" class="tag tag-ok">
              <i class="spin-dot"></i> 同步中
            </span>
            <span v-else class="tag" :class="st?.lastError ? 'tag-warn' : 'tag-dim'">
              {{ st?.stageLabel || "空闲" }}
            </span>
          </span>
        </div>

        <div class="bar-track">
          <div class="bar-fill" :class="{ done: percent >= 100, active: running }" :style="{ width: percent + '%' }"></div>
        </div>

        <div class="bar-meta">
          <span class="mono percent-num">{{ percent }}%</span>
          <span class="detail-text">{{ st?.detail || (running ? "准备中…" : "等待开始") }}</span>
        </div>

        <div v-if="runMsg" class="sync-msg-box" :class="{ err: !st?.lastError && runMsg.includes('失败') }">
          {{ runMsg }}
        </div>
        <div v-if="st?.lastError && !running" class="sync-msg-box err">
          上次失败：{{ st.lastError }}
        </div>
        <div v-if="st?.lastSummary && !running" class="sync-summary-box">
          上次结果：{{ st.lastSummary }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ===== 顶栏 ===== */
.poolsync-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 14px;
  margin-bottom: 14px;
  border-radius: var(--r-md, 10px);
  background: var(--bg-card, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--line, rgba(255, 255, 255, 0.08));
}
.top-bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sync-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2.5px 10px;
  border-radius: var(--r-pill, 999px);
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
}
.sync-status-badge.is-configured {
  background: var(--ok-dim, rgba(16, 185, 129, 0.12));
  border-color: var(--ok-line, rgba(16, 185, 129, 0.3));
  color: var(--ok, #10b981);
}
.sync-status-badge.is-local {
  background: var(--warn-dim, rgba(245, 158, 11, 0.12));
  border-color: var(--warn-line, rgba(245, 158, 11, 0.3));
  color: var(--warn, #f59e0b);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.top-bar-tip {
  font-size: 12.5px;
  color: var(--text-3, rgba(255, 255, 255, 0.5));
}
.top-bar-right {
  display: flex;
  align-items: center;
}
.sync-action-icon {
  margin-right: 4px;
}

/* ===== 核心 KPI ===== */
.poolsync-kpis {
  margin-bottom: 12px;
}
.text-ok {
  color: var(--ok, #10b981);
}
.text-warn {
  color: var(--warn, #f59e0b);
}

/* ===== 本地模式引导卡 ===== */
.local-mode-card {
  margin-bottom: 12px;
  border-color: var(--warn-line, rgba(245, 158, 11, 0.35));
  background: linear-gradient(180deg, var(--warn-dim, rgba(245, 158, 11, 0.08)) 0%, transparent 100%);
}

/* ===== 卡片子标题 ===== */
.title-sub {
  font-size: 12px;
  font-weight: normal;
  color: var(--text-3, rgba(255, 255, 255, 0.45));
  margin-left: 8px;
}

.sync-scope-card {
  margin-bottom: 12px;
}
.sync-progress-card {
  margin-bottom: 12px;
}

.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

.bar-track {
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--bg-soft, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  overflow: hidden;
  margin-top: 10px;
}
.bar-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: linear-gradient(90deg, var(--cta-1, #0284c7), var(--accent, #38bdf8));
  transition: width 0.4s var(--ease);
}
.bar-fill.done {
  background: var(--accent, #38bdf8);
}
.bar-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2, rgba(255, 255, 255, 0.7));
}
.percent-num {
  font-weight: 600;
  color: var(--text, #fff);
}
.detail-text {
  color: var(--text-3, rgba(255, 255, 255, 0.55));
}

.sync-msg-box {
  margin-top: 10px;
  padding: 8px 12px;
  font-size: 12.5px;
  border-radius: var(--r-sm, 6px);
  background: var(--bg-soft, rgba(255, 255, 255, 0.04));
  color: var(--text-2, rgba(255, 255, 255, 0.8));
}
.sync-msg-box.err {
  color: var(--err, #e05555);
  background: var(--danger-dim, rgba(224, 85, 85, 0.12));
}
.sync-summary-box {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3, rgba(255, 255, 255, 0.5));
}

.btn-stop {
  color: var(--danger, #e05555);
}
.btn-stop:hover {
  border-color: var(--danger, #e05555);
  background: var(--danger-dim, rgba(224, 85, 85, 0.12));
}
.spin-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  animation: pulse 1s infinite alternate;
}
@keyframes pulse {
  from { opacity: 0.3; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1.2); }
}
</style>
