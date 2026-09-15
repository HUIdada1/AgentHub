<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import * as api from "../../api/sync";
import { useSyncStore } from "../../stores/sync";
import { formatDateTime } from "../../composables/useFormat";
import type { SyncLog } from "../../types/sync";

const app = useSyncStore();
const logs = ref<SyncLog[]>([]);
const kindFilter = ref("");
const levelFilter = ref("");

const kindText: Record<string, string> = {
  extract: "抽取", upload: "上传", download: "拉取", merge: "合并",
  done: "完成", error: "错误",
};

const filteredLogs = computed(() =>
  logs.value.filter(
    (l) => (!kindFilter.value || l.kind === kindFilter.value) && (!levelFilter.value || l.level === levelFilter.value)
  )
);

async function load() {
  logs.value = await api.getSyncLogs();
}
onMounted(load);

// 同步结束后自动刷新（页面用 v-show 常驻，需手动触发）
watch(() => app.sync.running, (now, prev) => {
  if (prev && !now) load();
});

async function clear() {
  await api.clearSyncLogs();
  logs.value = [];
}
</script>

<template>
  <div class="sync-page">
    <div class="page-title">同步日志</div>
    <div class="page-sub">最近同步记录 · 失败会显示错误码</div>
    <div class="card">
      <div class="filters" style="margin-bottom: 14px">
        <div class="f-group"><label>类型</label>
          <select class="f-select" v-model="kindFilter">
            <option value="">全部</option>
            <option value="extract">抽取</option>
            <option value="upload">上传</option>
            <option value="download">拉取</option>
            <option value="merge">合并</option>
            <option value="done">完成</option>
            <option value="error">错误</option>
          </select>
        </div>
        <div class="f-group"><label>状态</label>
          <select class="f-select" v-model="levelFilter">
            <option value="">全部</option>
            <option value="ok">成功</option>
            <option value="info">信息</option>
            <option value="warn">警告</option>
            <option value="error">失败</option>
          </select>
        </div>
        <div style="flex: 1"></div>
        <button class="btn-ghost" @click="load">刷新</button>
        <button class="btn-ghost" @click="clear">清空日志</button>
      </div>
      <ul class="log-list">
        <li v-for="(l, i) in filteredLogs" :key="l.id" class="log-item" :style="{ '--i': i }">
          <div class="licon" :class="l.level">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path v-if="l.level === 'ok'" d="M20 6 9 17l-5-5" />
              <template v-else-if="l.level === 'error'">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </template>
              <path v-else d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div class="lbody">
            <div class="ltitle">{{ kindText[l.kind] || l.kind }} · {{ l.message }}</div>
            <div class="ldesc">{{ l.detail }}</div>
          </div>
          <div class="ltime mono">{{ formatDateTime(l.time) }}</div>
        </li>
      </ul>
      <div v-if="!filteredLogs.length" style="padding: 24px 0; text-align: center; color: var(--text-3); font-size: 13px">
        {{ logs.length ? "没有匹配当前筛选的日志" : "暂无同步日志，执行一次同步后这里会显示记录" }}
      </div>
    </div>
  </div>
</template>
