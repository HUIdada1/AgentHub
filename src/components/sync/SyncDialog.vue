<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useSyncStore } from "../../stores/sync";
import * as api from "../../api/sync";
import type { SyncLog } from "../../types/sync";

const app = useSyncStore();
const logs = ref<SyncLog[]>([]);
let timer: number | null = null;

const stages = [
  { key: "extract", label: "获取本地数据" },
  { key: "package", label: "生成本机备份" },
  { key: "upload", label: "压缩并上传", remote: true },
  { key: "download", label: "下载其它电脑", remote: true },
  { key: "merge", label: "解压并合并" },
  { key: "done", label: "同步完成" },
];
// 本地模式（未配置 WebDAV 或强制备份）：不展示远程上传/下载阶段，改为展示「生成本机备份」；
// WebDAV 模式则不出现备份阶段
const visibleStages = computed(() =>
  stages.filter((s) => {
    if (app.sync.localOnly && s.remote) return false;
    if (s.key === "package") return !!app.sync.localOnly;
    return true;
  })
);
const currentIndex = computed(() => visibleStages.value.findIndex((s) => s.key === app.sync.stage));
const canClose = computed(() => !app.sync.running && !app.syncing);

async function refresh() {
  try { logs.value = await api.getSyncLogs(); } catch { /* 日志读取失败不影响同步进度 */ }
}
function stopPolling() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
}
function startPolling() {
  stopPolling();
  refresh();
  timer = window.setInterval(refresh, 700);
}
watch(() => app.syncDialogOpen, (open) => { if (open) startPolling(); else stopPolling(); }, { immediate: true });
onBeforeUnmount(stopPolling);
</script>

<template>
  <Transition name="sync-pop">
    <div v-if="app.syncDialogOpen" class="modal-backdrop sync-scope">
    <section class="sync-dialog" role="dialog" aria-modal="true" aria-label="用量同步">
      <div class="sync-dialog-head">
        <div>
          <div class="eyebrow">沐辉制作 · AGENTHUB 用量统计</div>
          <h2>用量同步</h2>
        </div>
        <button class="icon-btn" :disabled="!canClose" title="关闭" @click="app.closeSyncDialog()">×</button>
      </div>
      <div class="sync-dialog-status" :class="{ error: app.sync.stage === 'error', done: app.sync.stage === 'done' }">
        <div class="status-line"><strong>{{ app.sync.stageLabel || "准备同步" }}</strong><span>{{ Math.round(app.sync.percent) }}%</span></div>
        <div class="track"><div class="fill" :style="{ width: `${app.sync.percent}%` }"></div></div>
        <p>{{ app.sync.message || "正在准备同步任务" }}</p>
      </div>
      <div class="sync-stages">
        <div v-for="(stage, index) in visibleStages" :key="stage.key" class="sync-stage" :class="{ active: index === currentIndex, done: index < currentIndex }">
          <span>{{ index < currentIndex ? "✓" : index + 1 }}</span>{{ stage.label }}
        </div>
      </div>
      <div v-if="app.sync.localOnly && app.sync.stage === 'done'" class="sync-local-tip">{{ app.webdavReady ? "本次仅处理本机（本地）数据，已重新生成备份压缩包" : "未配置 WebDAV，已生成本机备份压缩包 dosage-sync-backup.zip，未发起远程同步" }}</div>
      <div class="sync-log-head"><h3>同步日志</h3><span>{{ logs.length }} 条</span></div>
      <div class="sync-dialog-logs">
        <div v-for="log in logs.slice(0, 40)" :key="log.id" class="sync-dialog-log" :class="log.level">
          <span class="log-time">{{ new Date(log.time).toLocaleTimeString("zh-CN", { hour12: false }) }}</span>
          <span class="log-kind">{{ log.kind }}</span>
          <span class="log-message">{{ log.message }}<small v-if="log.detail"> · {{ log.detail }}</small></span>
        </div>
        <div v-if="!logs.length" class="sync-empty">等待同步日志…</div>
      </div>
      <div class="sync-dialog-foot">
        <span v-if="app.sync.stage === 'error'" class="sync-error-tip">请检查 WebDAV 地址、根目录和账号写入权限</span>
        <button v-if="app.sync.running" class="btn-outline" @click="app.cancelSync()">取消同步</button>
        <button v-else class="btn-sync" :disabled="!canClose" @click="app.closeSyncDialog()">关闭</button>
      </div>
    </section>
    </div>
  </Transition>
</template>
