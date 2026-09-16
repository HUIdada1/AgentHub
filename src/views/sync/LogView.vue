<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import * as api from "../../api/sync";
import { useSyncStore } from "../../stores/sync";
import { formatDateTime } from "../../composables/useFormat";
import type { SyncLog } from "../../types/sync";

const app = useSyncStore();
const logs = ref<SyncLog[]>([]);
const total = ref(0);
const page = ref(0);
const pageSize = 20;
const kindFilter = ref("");
const levelFilter = ref("");

const kindText: Record<string, string> = {
  extract: "抽取", upload: "上传", download: "拉取", merge: "合并",
  done: "完成", error: "错误",
};

const totalPages = () => Math.max(1, Math.ceil(total.value / pageSize));

async function load() {
  const r = await api.getSyncLogs({
    limit: pageSize,
    offset: page.value * pageSize,
    kind: kindFilter.value || null,
    level: levelFilter.value || null,
  });
  logs.value = r.rows;
  total.value = r.total;
  // 清空或裁剪后总数变少、当前页越界时，回退到最后一页
  const maxPage = Math.max(0, Math.ceil(r.total / pageSize) - 1);
  if (page.value > maxPage) {
    page.value = maxPage;
    await load();
  }
}
onMounted(load);

// 类型/状态筛选已下推后端，筛选变化回到第一页重新查询
watch([kindFilter, levelFilter], () => {
  page.value = 0;
  load();
});

// 同步结束后自动刷新（页面用 v-show 常驻，需手动触发）
watch(() => app.sync.running, (now, prev) => {
  if (prev && !now) load();
});

async function clear() {
  await api.clearSyncLogs();
  logs.value = [];
  total.value = 0;
  page.value = 0;
}
</script>

<template>
  <div class="sync-page">
    <div class="card">
      <div class="filters" style="margin-bottom: 14px">
        <div class="f-group"><label>类型</label>
          <el-select v-model="kindFilter" placeholder="全部" popper-class="glass-popper" class="f-el-select">
            <el-option value="" label="全部" />
            <el-option value="extract" label="抽取" />
            <el-option value="upload" label="上传" />
            <el-option value="download" label="拉取" />
            <el-option value="merge" label="合并" />
            <el-option value="done" label="完成" />
            <el-option value="error" label="错误" />
          </el-select>
        </div>
        <div class="f-group"><label>状态</label>
          <el-select v-model="levelFilter" placeholder="全部" popper-class="glass-popper" class="f-el-select">
            <el-option value="" label="全部" />
            <el-option value="ok" label="成功" />
            <el-option value="info" label="信息" />
            <el-option value="warn" label="警告" />
            <el-option value="error" label="失败" />
          </el-select>
        </div>
        <div style="flex: 1"></div>
        <button class="btn-ghost" @click="load">刷新</button>
        <button class="btn-ghost" @click="clear">清空日志</button>
      </div>
      <ul class="log-list">
        <li v-for="(l, i) in logs" :key="l.id" class="log-item" :style="{ '--i': i }">
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
      <div v-if="!logs.length" style="padding: 24px 0; text-align: center; color: var(--text-3); font-size: 13px">
        {{ total ? "没有匹配当前筛选的日志" : "暂无同步日志，执行一次同步后这里会显示记录" }}
      </div>
      <div class="pager">
        <span class="pg-info">共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages() }} 页</span>
        <button class="btn-ghost" :disabled="page === 0" @click="page--; load()">上一页</button>
        <button class="btn-ghost" :disabled="(page + 1) * pageSize >= total" @click="page++; load()">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* el-select 高度对齐 f-select（34px），不抢布局节奏 */
.f-el-select {
  width: 140px;
}
.f-el-select :deep(.el-select__wrapper) {
  min-height: 34px;
  font-size: 13px;
}
</style>
