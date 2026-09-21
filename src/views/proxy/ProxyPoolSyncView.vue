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

const CHANNELS: { id: ProxyChannelId | ""; label: string }[] = [
  { id: "", label: "全部渠道" },
  { id: "trae", label: "Trae SOLO CN" },
  { id: "workbuddy", label: "WorkBuddy（中国区）" },
  { id: "workbuddy_ai", label: "WorkBuddy AI（国际版）" },
  { id: "raccoon", label: "商汤小浣熊" },
];

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
  offEvent = api.onUpdateEvent(onEvent);
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">号池同步</div>
        <div class="page-sub">多设备共享号池：账号与凭据经 WebDAV 密码加密打包，按账号自动去重合并</div>
      </div>
      <div class="page-actions">
        <button v-if="st && !st.configured" class="btn" @click="app.openSettings('webdav')">去配置 WebDAV</button>
        <button v-else-if="running" class="btn btn-stop" @click="cancelSync">取消同步</button>
        <button v-else class="btn btn-primary" :disabled="!st?.configured" @click="runSync">
          {{ targetChannel ? `同步 ${channelName(targetChannel)}` : "开始同步" }}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 未配置 WebDAV：号池仅存本机，讲清当前边界与迁移途径 -->
      <div v-if="st && !st.configured" class="card">
        <div class="card-title">本地模式</div>
        <div class="set-desc">
          还没配置 WebDAV，号池仅保存在本机：跨设备共享与换电脑迁移暂不可用。点右上「去配置 WebDAV」填好统一服务器后，
          多台电脑即可经加密压缩包自动去重合并号池；不配置也不影响本机使用，换机前建议先配置并同步一次，或手动备份整个数据目录。
        </div>
      </div>

      <!-- 同步范围：全部 / 只同步某一个编译器 -->
      <div class="card">
        <div class="card-title">同步范围</div>
        <div class="set-desc" style="margin-bottom: 10px">
          选择「只同步某一个编译器」时，拉取合并与上传打包都只涉及该渠道的账号，其他渠道不动
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

      <!-- 同步进度：百分比 + 阶段 + 细节 -->
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          同步进度
          <span class="right">
            <span v-if="running" class="tag tag-ok">同步中</span>
            <span v-else class="tag" :class="st?.lastError ? 'tag-warn' : 'tag-dim'">{{ st?.stageLabel || "空闲" }}</span>
          </span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" :class="{ done: percent >= 100 }" :style="{ width: percent + '%' }"></div>
        </div>
        <div class="bar-meta">
          <span class="mono">{{ percent }}%</span>
          <span>{{ st?.detail || (running ? "准备中…" : "等待开始") }}</span>
        </div>
        <div v-if="runMsg" class="set-desc" style="margin-top: 8px">{{ runMsg }}</div>
        <div v-if="st?.lastError && !running" class="set-desc err-text" style="margin-top: 8px">上次失败：{{ st.lastError }}</div>
      </div>

      <!-- 最近一次同步 + 设备身份 -->
      <div class="kpis" style="margin-top: 12px">
        <div class="kpi"><span>上次同步</span><b>{{ st?.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "从未" }}</b></div>
        <div class="kpi"><span>本机设备</span><b>{{ st?.deviceName || "-" }}</b></div>
        <div class="kpi"><span>服务器</span><b>{{ st?.configured ? "已配置" : "未配置" }}</b></div>
        <div class="kpi"><span>加密</span><b>WebDAV 密码 · AES-256-GCM</b></div>
      </div>
      <div v-if="st?.lastSummary" class="card" style="margin-top: 12px">
        <div class="set-desc">上次结果：{{ st.lastSummary }}</div>
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
.bar-track {
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  overflow: hidden;
  margin-top: 10px;
}
.bar-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: linear-gradient(90deg, var(--cta-1), var(--accent));
  transition: width 0.4s var(--ease);
}
.bar-fill.done {
  background: var(--accent);
}
.bar-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.btn-stop {
  color: var(--danger);
}
.btn-stop:hover {
  border-color: var(--danger);
  background: var(--danger-dim);
}
</style>
