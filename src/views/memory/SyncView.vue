<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · WebDAV 同步：状态条 + 服务器信息 + 冲突裁决（内联 diff）+ 设备 + 压缩包历史 + 同步日志 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { timeAgo, formatDateTime } from "../../composables/useFormat";
import { sideBySideDiff, type DiffLine } from "../../utils/diff";
import { coalesceAsync } from "../../utils/timing";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemDialog from "../../components/memory/MemDialog.vue";

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
type DiffState = {
  index: number;
  path: string;
  note?: string;
  localText: string;
  remoteText: string;
  local?: { size: number; mtime: number; hash: string } | null;
  remote?: { size: number; mtime: number; hash: string } | null;
};

const diff = ref<DiffState | null>(null);
const devices = ref<{ deviceId: string; name?: string; lastSyncAt?: number; count?: number }[]>([]);
const busy = ref("");
const logsOpen = ref(false);
const mergeText = ref("");
const shared = ref({ endpoint: "", root: "" });

type Recommendation = {
  decision: "keepLocal" | "keepRemote";
  label: string;
  reason: string;
};

function getRecommendation(item: {
  local?: { size: number; mtime: number } | null;
  remote?: { size: number; mtime: number } | null;
  localText?: string;
  remoteText?: string;
}): Recommendation {
  const loc = item.local;
  const rem = item.remote;
  const locMtime = loc?.mtime || 0;
  const remMtime = rem?.mtime || 0;

  // 1. 若单侧不存在
  if (loc && !rem) {
    return { decision: "keepLocal", label: "保留本地", reason: "远端已无此文件，本地保留有效内容" };
  }
  if (!loc && rem) {
    return { decision: "keepRemote", label: "保留远端", reason: "本地文件缺失，远端有有效内容" };
  }

  // 2. 根据修改时间 mtime 比较
  if (locMtime && remMtime) {
    const diffMs = locMtime - remMtime;
    if (diffMs > 1000) {
      const diffMin = Math.round(diffMs / 60000);
      const diffDesc = diffMin >= 1 ? `${diffMin} 分钟` : `${Math.round(diffMs / 1000)} 秒`;
      return { decision: "keepLocal", label: "保留本地", reason: `本地修改时间较新（比远端新 ${diffDesc}）` };
    }
    if (diffMs < -1000) {
      const diffMin = Math.round(-diffMs / 60000);
      const diffDesc = diffMin >= 1 ? `${diffMin} 分钟` : `${Math.round(-diffMs / 1000)} 秒`;
      return { decision: "keepRemote", label: "保留远端", reason: `远端修改时间较新（比本地新 ${diffDesc}）` };
    }
  }

  // 3. 时间接近时，比较内容长度
  const locLen = (item.localText || "").length || (loc?.size || 0);
  const remLen = (item.remoteText || "").length || (rem?.size || 0);
  if (locLen > remLen) {
    return { decision: "keepLocal", label: "保留本地", reason: "本地内容更完整（字符量更多）" };
  }
  if (remLen > locLen) {
    return { decision: "keepRemote", label: "保留远端", reason: "远端内容更完整（字符量更多）" };
  }

  return { decision: "keepLocal", label: "保留本地", reason: "两端修改时间相近，建议优先保留本地工作区" };
}

const currentRecommendation = computed(() => (diff.value ? getRecommendation(diff.value) : null));

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
    // 同时存 path：事件刷新会让队列重排，裁决时按 path 重新定位真正的 index，杜绝点错条目
    diff.value = {
      index: c.index,
      path: d.path,
      note: d.note || c.note,
      localText: d.localText || "",
      remoteText: d.remoteText || "",
      local: d.local !== undefined ? d.local : c.local,
      remote: d.remote !== undefined ? d.remote : c.remote,
    };
    mergeText.value = d.localText || "";
  } catch (e) {
    ElMessage.error((e as Error).message || "读取差异失败");
  }
}

/** 待确认的裁决：先弹 MemDialog 说明后果，确认后才真正执行（模块弹窗统一，不再用 ElMessageBox） */
const resolveConfirm = ref<{ idx: number; decision: "keepLocal" | "keepRemote" | "keepBoth" | "merge"; text?: string } | null>(null);

const resolveConfirmText = computed(() => {
  const d = resolveConfirm.value?.decision;
  return d === "keepLocal"
    ? "保留本地版本（远端版本会留档到 reports/，不静默丢弃）"
    : d === "keepRemote"
      ? "采用远端版本（本地版本会先备份为 .bak）"
      : d === "keepBoth"
        ? "两条都留（远端版本另存为 .remote-<时间>.md）"
        : "用编辑后的文本覆盖本地";
});

function resolve(index: number, decision: "keepLocal" | "keepRemote" | "keepBoth" | "merge", text?: string) {
  // 裁决当下用 path 反查最新 index（事件刷新可能让 diff 打开时的 index 指向别的条目）
  let idx = index;
  if (diff.value) {
    const path = diff.value.path;
    const cur = conflicts.value.findIndex((c) => c.path === path);
    if (cur === -1) {
      ElMessage.warning("冲突队列已变化，本条已被处理或替换；请关闭后重新打开差异");
      diff.value = null;
      return;
    }
    idx = conflicts.value[cur].index;
  }
  resolveConfirm.value = { idx, decision, text };
}

async function doResolve() {
  const p = resolveConfirm.value;
  resolveConfirm.value = null;
  if (!p) return;
  try {
    await api.memoryConflictsResolve(p.idx, p.decision, p.text);
    ElMessage.success("已裁决");
    diff.value = null;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "裁决失败");
  }
}

/** 批量按建议裁决：点开确认弹窗那一刻把「条 + 各自建议」定格，
 *  提交只带 path（主进程按 path 反查下标），确认期间同步事件刷新队列也不会裁决错条目 */
const recommendBusy = ref(false);
const recommendAllConfirm = ref(false);
const frozenPlan = ref<{ path: string; decision: "keepLocal" | "keepRemote" }[]>([]);

function openRecommendAll() {
  frozenPlan.value = conflicts.value.map((c) => ({ path: c.path, decision: getRecommendation(c).decision }));
  if (!frozenPlan.value.length) return;
  recommendAllConfirm.value = true;
}

const frozenCounts = computed(() => {
  const plan = frozenPlan.value;
  return {
    total: plan.length,
    keepLocal: plan.filter((p) => p.decision === "keepLocal").length,
    keepRemote: plan.filter((p) => p.decision === "keepRemote").length,
  };
});

async function resolveAllRecommended() {
  recommendAllConfirm.value = false;
  const items = frozenPlan.value;
  if (!items.length) return;
  recommendBusy.value = true;
  try {
    const r = await api.memoryConflictsResolveRecommended(items);
    // 部分成功必须说清：失败的条目仍在队列里，直接再点一次即可
    if (r.failed?.length) {
      ElMessage.warning(`已按建议裁决 ${r.resolved} 条，${r.failed.length} 条未成功：${r.failed[0].path}（${r.failed[0].message}）；队列里剩下的可再点一次`);
    } else {
      ElMessage.success(`已按建议裁决 ${r.resolved} 条冲突`);
    }
    diff.value = null;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "批量裁决失败");
  } finally {
    recommendBusy.value = false;
    frozenPlan.value = [];
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
// 事件合流：同步进行中主进程每个阶段都广播 sync 事件，refresh 是 5 个串行 IPC 的重量级全量拉取，
// 逐事件直调会让 IPC 排队、界面卡顿；合流后同刻只在跑一次、间隔内合并
const scheduleRefresh = coalesceAsync(refresh, 1200);
onMounted(async () => {
  await refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    // 页面 v-show 保活：隐藏时不合流刷新（切回时 watch(active) 会补一次）
    if (!active.value) return;
    if (p.event === "memory" && (p.type === "sync" || p.type === "conflict")) scheduleRefresh();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  scheduleRefresh.cancel();
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
        <button v-if="status?.running" class="btn btn-ghost" @click="api.memorySyncCancel().then(refresh).catch((e) => ElMessage.error(String((e as Error).message || e)))">取消同步</button>
        <button class="btn btn-cta" :disabled="busy === 'sync' || status?.running" @click="syncNow">
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
        <span class="v">
          <template v-if="shared.endpoint">
            <el-tooltip :content="shared.endpoint" placement="top">
              <span class="mem-mono mem-path-text">{{ shared.endpoint }}</span>
            </el-tooltip>
          </template>
          <template v-else>
            <span class="mem-chip warn">未配置</span>
            <span class="mem-hint">（统一在「设置 · 数据存储」里填 WebDAV 凭据）</span>
            <button class="btn btn-ghost" style="margin-left: 6px" @click="app.openSettings('webdav')">去配置 →</button>
          </template>
        </span>
        <span class="k">远端目录</span><span class="v"><span class="mem-mono">{{ shared.root }}</span></span>
        <span class="k">上次同步</span><span class="v">{{ status?.lastSyncAt ? `${formatDateTime(status.lastSyncAt)}（${timeAgo(status.lastSyncAt)}）` : "尚未同步" }}</span>
        <span class="k">当前阶段</span><span class="v">{{ status?.detail || "—" }}</span>
        <span class="k">冲突<MemHelp text="冲突＝两边都改且内容不同，等你选保留哪边。删除记录（墓碑）由同步自动传播，不需要你关心。" /></span><span class="v">{{ status?.conflicts || 0 }}</span>
      </div>
      <div class="mem-hint" style="margin-top: 8px">
        与技能仓库、用量统计、号池同步共用同一套服务端凭据，根目录隔离互不冲突；本地目录：<el-tooltip :content="mem.root" placement="top"><span class="mem-mono mem-path-text">{{ mem.root }}</span></el-tooltip>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        冲突裁决
        <span class="mem-hint">{{ conflicts.length }} 条待裁决 · 一律不自动选边</span>
        <span v-if="conflicts.length" class="mem-inline-ctl">
          <button class="btn btn-cta btn-sm" :disabled="recommendBusy" @click="openRecommendAll">
            {{ recommendBusy ? "裁决中…" : `一键采纳建议（${conflicts.length} 条）` }}
          </button>
          <MemHelp text="按每条冲突上方标注的「💡 建议」逐条裁决，省去一条条点击。保留本地＝远端版本留档到 reports/；保留远端＝本地先备份为 .bak 再覆盖。建议只按修改时间与内容量推断，拿不准的条目请先「查看差异」单独裁决。" />
        </span>
      </div>
      <div v-if="conflicts.length" class="mem-col" style="gap: 10px">
        <div v-for="c in conflicts" :key="c.index + c.path" class="mem-tile">
          <div class="mem-row" style="flex-wrap: wrap; gap: 8px">
            <span class="mem-chip warn">{{ c.note }}</span>
            <span class="mem-mono">{{ c.path }}</span>
            <el-tooltip :content="getRecommendation(c).reason" placement="top">
              <span
                class="mem-chip"
                :class="getRecommendation(c).decision === 'keepLocal' ? 'accent' : 'info'"
                style="font-size: 11px"
              >
                💡 建议：{{ getRecommendation(c).label }}（{{ getRecommendation(c).reason }}）
              </span>
            </el-tooltip>
            <span class="mem-hint" style="margin-left: auto">{{ timeAgo(c.detectedAt) }}</span>
          </div>
          <div class="mem-tile-foot">
            <button class="btn btn-ghost" @click="showDiff(c)">查看差异</button>
            <button
              class="btn"
              :class="getRecommendation(c).decision === 'keepLocal' ? 'btn-cta' : 'btn-ghost'"
              @click="resolve(c.index, 'keepLocal')"
            >
              保留本地 {{ getRecommendation(c).decision === 'keepLocal' ? '★推荐' : '' }}
            </button>
            <button
              class="btn"
              :class="getRecommendation(c).decision === 'keepRemote' ? 'btn-cta' : 'btn-ghost'"
              @click="resolve(c.index, 'keepRemote')"
            >
              保留远端 {{ getRecommendation(c).decision === 'keepRemote' ? '★推荐' : '' }}
            </button>
            <button class="btn btn-ghost" @click="resolve(c.index, 'keepBoth')">两者都留</button>
            <MemHelp text="保留本地：远端版本留档到 reports/ 不丢；保留远端：本地先备份为 .bak 再覆盖；两者都留：远端版本另存为 .remote-<时间>.md。拿不准就先「查看差异」逐行合并。" />
          </div>
        </div>
      </div>
      <div v-else class="mem-empty">没有待裁决冲突</div>

      <div v-if="diff" style="margin-top: 14px; border-top: 1px solid var(--mem-line); padding-top: 14px">
        <div class="mem-card-title" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
          <div>
            差异对比：<span class="mem-mono">{{ diff.path }}</span>
          </div>
          <button class="btn btn-ghost" @click="diff = null">收起对比</button>
        </div>

        <!-- 系统推荐提示条 -->
        <div v-if="currentRecommendation" class="diff-recommend-banner">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span class="diff-rec-badge">💡 系统建议：{{ currentRecommendation.label }}</span>
            <span class="diff-rec-reason">理由：{{ currentRecommendation.reason }}</span>
          </div>
          <button
            class="btn btn-cta btn-sm"
            @click="resolve(diff.index, currentRecommendation.decision)"
          >
            直接采纳建议（{{ currentRecommendation.decision === 'keepLocal' ? '保留本地' : '保留远端' }}）
          </button>
        </div>

        <div class="mem-split-2-1">
          <div>
            <!-- 本地 vs 远端 标题对比栏（与下方 1fr 1fr 严格对齐） -->
            <div class="diff-columns-header">
              <div class="diff-header-col local" :class="{ 'is-recommended': currentRecommendation?.decision === 'keepLocal' }">
                <div class="col-main">
                  <span class="source-tag local">📁 本地版本 (Local)</span>
                  <span v-if="currentRecommendation?.decision === 'keepLocal'" class="rec-badge">★ 推荐保留</span>
                </div>
                <div class="col-sub">
                  修改时间：{{ diff.local?.mtime ? formatDateTime(diff.local.mtime) : (diff.localText ? '本地有修改' : '本地文件不存在') }}
                  <template v-if="diff.local?.size"> · {{ diff.local.size }} 字节</template>
                </div>
              </div>
              <div class="diff-header-col remote" :class="{ 'is-recommended': currentRecommendation?.decision === 'keepRemote' }">
                <div class="col-main">
                  <span class="source-tag remote">☁️ 远端版本 (Remote)</span>
                  <span v-if="currentRecommendation?.decision === 'keepRemote'" class="rec-badge">★ 推荐保留</span>
                </div>
                <div class="col-sub">
                  修改时间：{{ diff.remote?.mtime ? formatDateTime(diff.remote.mtime) : (diff.remoteText ? '远端有修改' : '远端文件不存在') }}
                  <template v-if="diff.remote?.size"> · {{ diff.remote.size }} 字节</template>
                </div>
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow: auto; border: 1px solid var(--mem-line); border-radius: 6px; padding: 6px; background: var(--bg-card, rgba(0,0,0,0.02))">
              <div
                v-for="(l, i) in diffLines"
                :key="i"
                style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-family: var(--font-code); font-size: 11px"
              >
                <el-tooltip :content="l.left ? '本地行' : ''" :disabled="!l.left" placement="top">
                  <div :style="{ background: l.left && l.left.kind === 'del' ? 'var(--danger-dim)' : 'transparent', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'pre-wrap' }">{{ l.left?.text || "" }}</div>
                </el-tooltip>
                <el-tooltip :content="l.right ? '远端行' : ''" :disabled="!l.right" placement="top">
                  <div :style="{ background: l.right && l.right.kind === 'add' ? 'var(--accent-dim)' : 'transparent', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'pre-wrap' }">{{ l.right?.text || "" }}</div>
                </el-tooltip>
              </div>
            </div>
          </div>
          <div>
            <div class="s-title" style="font-size: 11px; color: var(--text-3)">逐行合并编辑（确认后覆盖本地）</div>
            <textarea v-model="mergeText" class="el-textarea__inner" rows="11" style="margin-top: 6px"></textarea>
            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px">
              <button class="btn btn-cta" @click="diff && resolve(diff.index, 'merge', mergeText)">
                用编辑后内容覆盖本地
              </button>
              <div style="display: flex; gap: 6px">
                <button
                  class="btn btn-sm"
                  :class="currentRecommendation?.decision === 'keepLocal' ? 'btn-cta' : 'btn-ghost'"
                  style="flex: 1"
                  @click="diff && resolve(diff.index, 'keepLocal')"
                >
                  保留本地 {{ currentRecommendation?.decision === 'keepLocal' ? '★推荐' : '' }}
                </button>
                <button
                  class="btn btn-sm"
                  :class="currentRecommendation?.decision === 'keepRemote' ? 'btn-cta' : 'btn-ghost'"
                  style="flex: 1"
                  @click="diff && resolve(diff.index, 'keepRemote')"
                >
                  保留远端 {{ currentRecommendation?.decision === 'keepRemote' ? '★推荐' : '' }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="diff && resolve(diff.index, 'keepBoth')">
                  两者都留
                </button>
              </div>
            </div>
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
          <button class="btn btn-ghost" @click="logsOpen = !logsOpen">{{ logsOpen ? "收起" : "展开" }}</button>
          <MemHelp text="只同步你写下的记忆与配置：记忆 md、项目台账、画像、报告。索引库（可重建）、回收站、导入记录、本机路径配置、备份文件都不进包——既省体积，也避免把别的机器的路径配置带过来。冲突一律人工裁决（保留本地 / 保留远端 / 两者都留 / 逐行合并）。" />
        </span>
      </div>
      <pre v-if="logsOpen && logs.length" class="mem-pre">{{ logs.map((l) => `${formatDateTime(l.at).slice(11)}  [${l.stage}] ${l.detail}`).join("\n") }}</pre>
      <div v-else-if="!logs.length" class="mem-empty">还没有日志</div>
    </div>

    <!-- 冲突裁决确认：说明后果后再执行（裁决不可批量撤销） -->
    <MemDialog :open="!!resolveConfirm" title="冲突裁决" sub="确认后立即生效" width="480px" @update:open="(v: boolean) => { if (!v) resolveConfirm = null; }">
      <p style="margin: 0; line-height: 1.7">{{ resolveConfirmText }}</p>
      <template #foot>
        <button class="btn btn-cta" @click="doResolve">确认裁决</button>
        <button class="btn btn-ghost" @click="resolveConfirm = null">取消</button>
      </template>
    </MemDialog>

    <!-- 批量按建议裁决：先摊开条数与两种后果，再执行 -->
    <MemDialog :open="recommendAllConfirm" title="按建议裁决全部冲突" sub="按系统建议逐条执行，确认后立即生效" width="520px" @update:open="(v: boolean) => { if (!v) recommendAllConfirm = false; }">
      <p style="margin: 0; line-height: 1.7">
        按当前建议裁决全部 {{ frozenCounts.total }} 条冲突：保留本地 {{ frozenCounts.keepLocal }} 条（远端版本留档到
        reports/，不静默丢弃）、保留远端 {{ frozenCounts.keepRemote }} 条（本地版本先备份为 .bak 再覆盖）。
      </p>
      <p class="mem-hint" style="margin: 8px 0 0; line-height: 1.7">
        逐条独立执行、不可批量撤销；某条失败只跳过它，其余照常。建议只按修改时间与内容量推断，两条都动过且内容量接近时容易判反，重要文件请先「查看差异」单独裁决。
      </p>
      <template #foot>
        <button class="btn btn-cta" @click="resolveAllRecommended">确认裁决</button>
        <button class="btn btn-ghost" @click="recommendAllConfirm = false">取消</button>
      </template>
    </MemDialog>
  </div>
</template>

<style scoped>
.diff-recommend-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 12px;
}
.diff-rec-badge {
  font-weight: 600;
  color: var(--accent);
  font-size: 12.5px;
}
.diff-rec-reason {
  color: var(--text-2);
  font-size: 11.5px;
}
.diff-columns-header {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.diff-header-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-card, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--mem-line);
}
.diff-header-col.is-recommended {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.diff-header-col .col-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.diff-header-col .col-sub {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-code);
}
.source-tag {
  font-weight: 600;
  font-size: 12px;
}
.source-tag.local {
  color: var(--accent);
}
.source-tag.remote {
  color: var(--info, #3b82f6);
}
.rec-badge {
  font-size: 10.5px;
  background: var(--accent);
  color: #fff;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}
</style>
