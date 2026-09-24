<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · WebDAV 同步：状态条 + 服务器信息 + 冲突裁决（内联 diff）+ 设备 + 压缩包历史 + 同步日志 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { timeAgo, formatDateTime } from "../../composables/useFormat";
import { sideBySideDiff, type DiffLine } from "../../utils/diff";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "sync");

type Conflict = {
  index: number; kind: string; path: string; detectedAt: number; note: string;
  local: { size: number; mtime: number; hash: string } | null;
  remote: { size: number; mtime: number; hash: string } | null;
  localText?: string; remoteText?: string;
};

const status = ref<{ running: boolean; stage: string; stageLabel: string; percent: number; detail: string; lastSyncAt: number; conflicts: number; tombstones: number; configured: boolean } | null>(null);
const logs = ref<{ at: number; stage: string; detail: string }[]>([]);
const conflicts = ref<Conflict[]>([]);
const diff = ref<{ index: number; path: string; localText: string; remoteText: string } | null>(null);
const devices = ref<{ deviceId: string; name?: string; lastSyncAt?: number; count?: number }[]>([]);
const busy = ref("");
const logsOpen = ref(false);
const mergeText = ref("");
const shared = ref({ endpoint: "", root: "" });

async function refresh() {
  await mem.loadAll();
  try {
    status.value = (await api.memorySyncStatus()) as unknown as typeof status.value;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取同步状态失败");
  }
  try {
    logs.value = (await api.memorySyncLogs(50)).logs;
  } catch {
    /* 忽略 */
  }
  try {
    conflicts.value = (await api.memoryConflictsList()).conflicts as Conflict[];
  } catch {
    /* 忽略 */
  }
  try {
    devices.value = (await api.memorySyncDevices()).devices;
  } catch {
    /* 忽略 */
  }
  try {
    const s = await api.webdavSharedGet();
    shared.value = { endpoint: s.endpoint || "", root: s.roots?.memory || "/agenthub-memory" };
  } catch {
    /* 忽略 */
  }
}

async function syncNow() {
  busy.value = "sync";
  try {
    const r = await api.memorySyncRun();
    if (r.ok) ElMessage.success(`同步完成：下载 ${r.downloaded} · 冲突 ${r.conflicts}`);
    else if (r.cancelled) ElMessage.info("已取消");
    else ElMessage.error(r.message || "同步失败");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "同步失败");
  } finally {
    busy.value = "";
  }
}

async function showDiff(c: Conflict) {
  try {
    const d = await api.memoryConflictsDiff(c.index);
    // index 随 diff 存住：打开期间冲突队列被事件刷新重排时，findIndex 会返回 -1 发错裁决
    diff.value = { index: c.index, path: d.path, localText: d.localText || "", remoteText: d.remoteText || "" };
    mergeText.value = d.localText || "";
  } catch (e) {
    ElMessage.error((e as Error).message || "读取差异失败");
  }
}

async function resolve(index: number, decision: "keepLocal" | "keepRemote" | "keepBoth" | "merge", text?: string) {
  try {
    await ElMessageBox.confirm(
      decision === "keepLocal" ? "保留本地版本（远端版本会留档到 reports/，不静默丢弃）"
        : decision === "keepRemote" ? "采用远端版本（本地版本会先备份为 .bak）"
          : decision === "keepBoth" ? "两条都留（远端版本另存为 .remote-<时间>.md）"
            : "用编辑后的文本覆盖本地",
      "冲突裁决",
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await api.memoryConflictsResolve(index, decision, text);
    ElMessage.success("已裁决");
    diff.value = null;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "裁决失败");
  }
}

/** 左右并排差异行（utils/diff.ts 返回对齐后的两列，最多展示前 400 行） */
const diffLines = computed<{ left: DiffLine | null; right: DiffLine | null }[]>(() => {
  if (!diff.value) return [];
  try {
    const { left, right } = sideBySideDiff(diff.value.localText, diff.value.remoteText);
    return left.slice(0, 400).map((l, i) => ({ left: l, right: right[i] || null }));
  } catch {
    return [];
  }
});

let offEvent: (() => void) | undefined;
onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "memory" && (p.type === "sync" || p.type === "conflict")) void refresh();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        记忆文件整体打包同步（tar.gz 单包原子传输），两边都改且不一样时进冲突队列等你裁决
        <MemHelp text="把你的记忆文件夹整体打包上传/下载（单文件原子传输，不怕传一半）。同步时按「本地 / 远端 / 上次同步基线」三方比对，只搬真正变化的部分；两边都改了且不一样就进冲突队列等你裁决。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="status?.running" class="el-button el-button--small" @click="api.memorySyncCancel().then(refresh)">取消同步</button>
        <button class="el-button el-button--small el-button--primary" :disabled="busy === 'sync' || status?.running" @click="syncNow">
          {{ status?.running ? "同步中…" : "立即同步" }}
        </button>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        同步状态
        <span class="mem-chip" :class="status?.running ? 'accent' : ''">{{ status?.stageLabel || "空闲" }}</span>
      </div>
      <div v-if="status?.running" class="mem-progress" style="margin-bottom: 8px"><i :style="{ width: `${status.percent}%` }"></i></div>
      <div class="mem-kv">
        <span class="k">服务器</span>
        <span class="v"><span class="mem-mono">{{ shared.endpoint || "未配置（设置 · 数据存储里填统一 WebDAV）" }}</span></span>
        <span class="k">远端目录</span><span class="v"><span class="mem-mono">{{ shared.root }}</span></span>
        <span class="k">上次同步</span><span class="v">{{ status?.lastSyncAt ? `${formatDateTime(status.lastSyncAt)}（${timeAgo(status.lastSyncAt)}）` : "尚未同步" }}</span>
        <span class="k">当前阶段</span><span class="v">{{ status?.detail || "—" }}</span>
        <span class="k">冲突<MemHelp text="冲突＝两边都改且内容不同，等你选保留哪边。删除记录（墓碑）由同步自动传播，不需要你关心。" /></span><span class="v">{{ status?.conflicts || 0 }}</span>
      </div>
      <div class="mem-hint" style="margin-top: 8px">
        与技能仓库、用量统计、号池同步共用同一套服务端凭据，根目录隔离互不冲突；本地目录：<span class="mem-mono">{{ mem.root }}</span>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        冲突裁决
        <span class="mem-hint">{{ conflicts.length }} 条待裁决 · 一律不自动选边</span>
      </div>
      <div v-if="conflicts.length" class="mem-col" style="gap: 10px">
        <div v-for="c in conflicts" :key="c.index + c.path" class="mem-tile">
          <div class="mem-row">
            <span class="mem-chip warn">{{ c.note }}</span>
            <span class="mem-mono">{{ c.path }}</span>
            <span class="mem-hint" style="margin-left: auto">{{ timeAgo(c.detectedAt) }}</span>
          </div>
          <div class="mem-tile-foot">
            <button class="el-button el-button--small" @click="showDiff(c)">查看差异</button>
            <button class="el-button el-button--small" @click="resolve(c.index, 'keepLocal')">保留本地</button>
            <button class="el-button el-button--small" @click="resolve(c.index, 'keepRemote')">保留远端</button>
            <button class="el-button el-button--small" @click="resolve(c.index, 'keepBoth')">两者都留</button>
            <MemHelp text="保留本地：远端版本留档到 reports/ 不丢；保留远端：本地先备份为 .bak 再覆盖；两者都留：远端版本另存为 .remote-<时间>.md。拿不准就先「查看差异」逐行合并。" />
          </div>
        </div>
      </div>
      <div v-else class="mem-empty">没有待裁决冲突</div>

      <div v-if="diff" style="margin-top: 12px">
        <div class="mem-card-title">
          差异对比：<span class="mem-mono">{{ diff.path }}</span>
          <button class="mem-chip click" @click="diff = null">收起</button>
        </div>
        <div class="mem-split-2-1">
          <div>
            <div style="display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto">
              <div
                v-for="(l, i) in diffLines"
                :key="i"
                style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-family: var(--font-code); font-size: 11px"
              >
                <div :style="{ background: l.left && l.left.kind === 'del' ? 'var(--danger-dim)' : 'transparent', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'pre-wrap' }">{{ l.left?.text || "" }}</div>
                <div :style="{ background: l.right && l.right.kind === 'add' ? 'var(--accent-dim)' : 'transparent', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'pre-wrap' }">{{ l.right?.text || "" }}</div>
              </div>
            </div>
          </div>
          <div>
            <div class="s-title" style="font-size: 11px; color: var(--text-3)">逐行合并编辑（确认后覆盖本地）</div>
            <textarea v-model="mergeText" class="el-textarea__inner" rows="12" style="margin-top: 6px"></textarea>
            <button class="el-button el-button--small el-button--primary" style="margin-top: 8px" @click="diff && resolve(diff.index, 'merge', mergeText)">
              用编辑后内容覆盖本地
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        设备列表
        <MemHelp text="每台同步过的机器一行（同步时上报主机名与最后同步时间），用来判断「最近是谁在改」。" />
        <span class="mem-hint">同步时上报，用于判断"哪台机器最后改的"</span>
      </div>
      <div v-if="devices.length" class="mem-table-wrap">
        <table class="mem-table">
          <thead><tr><th>设备</th><th>最后同步</th></tr></thead>
          <tbody>
            <tr v-for="d in devices" :key="d.deviceId">
              <td class="mem-mono">{{ d.name || d.deviceId }}</td>
              <td>{{ d.lastSyncAt ? timeAgo(d.lastSyncAt) : "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="mem-empty">本机是首台设备；另一台机器同步后会出现在这里</div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        同步日志
        <span class="mem-hint">{{ logs.length }} 条；出问题时先看这里（含失败原因）</span>
        <span class="mem-inline-ctl">
          <button class="mem-chip click" @click="logsOpen = !logsOpen">{{ logsOpen ? "收起" : "展开" }}</button>
          <MemHelp text="只同步你写下的记忆与配置：记忆 md、项目台账、画像、报告。索引库（可重建）、回收站、导入记录、本机路径配置、备份文件都不进包——既省体积，也避免把别的机器的路径配置带过来。冲突一律人工裁决（保留本地 / 保留远端 / 两者都留 / 逐行合并）。" />
        </span>
      </div>
      <pre v-if="logsOpen && logs.length" class="mem-pre">{{ logs.map((l) => `${formatDateTime(l.at).slice(11)}  [${l.stage}] ${l.detail}`).join("\n") }}</pre>
      <div v-else-if="!logs.length" class="mem-empty">还没有日志</div>
    </div>
  </div>
</template>
