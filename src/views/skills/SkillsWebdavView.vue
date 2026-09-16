<!-- 技能仓库 · WebDAV 同步：中央仓库跨设备同步运行器（从设置弹窗的 WebDAV 分类移入本模块）
     一次同步 = 拉取远端台账、下载别人的更新、推送本机变更、合并台账回写；
     服务器地址与模块根目录在左下角「设置 · WebDAV 同步」配置 -->
<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import {
  webdavSync, webdavCancel, webdavStatus,
  webdavLogs, webdavDevices, listReports, readReport, openReport, onUpdateEvent,
  type WebDavStatus, type RemoteDevice, type WebDavLog, type ReportRow, type WebDavEvent,
} from "../../api/ipc";
import { fmtTime } from "../../utils/format";
import { useAppStore } from "../../stores/app";

const app = useAppStore();

// ===== 中央仓库同步运行器（多台电脑之间同步中央仓库） =====
const status = ref<WebDavStatus | null>(null);
const saveMsg = ref("");
const logs = ref<WebDavLog[]>([]);
const devices = ref<RemoteDevice[]>([]);
const reports = ref<ReportRow[]>([]);
const activeReport = ref("");
const reportContent = ref("");
const lastSummary = ref("");
const newSkills = ref(0); // 本次同步从远端拉到的新技能数，提示去同步中心分发

const running = computed(() => !!status.value?.running);
const configured = computed(() => !!status.value?.configured);

// ===== 同步进度：百分比 + 步骤状态 + 简要日志 =====
const pct = computed(() => {
  const st = status.value;
  if (!st) return 0;
  if (st.stage === "done") return 100;
  return Math.min(100, Math.max(0, Math.round(st.pct ?? 0)));
});

const progressStatus = computed<"success" | "exception" | "warning" | undefined>(() => {
  const s = status.value?.stage;
  if (s === "error") return "exception";
  if (s === "cancelled") return "warning";
  if (s === "done") return "success";
  return undefined;
});

// 六阶段步骤条；出错/取消时隐藏步骤条，只留异常色进度条与日志
const STEPS = [
  { key: "connect", title: "连接" },
  { key: "pull", title: "拉取" },
  { key: "download", title: "下载" },
  { key: "upload", title: "上传" },
  { key: "push", title: "推送" },
  { key: "done", title: "完成" },
];
const stepActive = computed(() => {
  const i = STEPS.findIndex((s) => s.key === status.value?.stage);
  return i < 0 ? 0 : i; // idle/未知阶段回 0（全部待命），不能回落到末步造成"假完成"
});
const showSteps = computed(() => {
  const s = status.value?.stage;
  return running.value || s === "done"; // idle/未配置时不显示，避免看起来像"已跑完一轮"
});

// 运行中标签显示当前阶段名；事件广播只带 stage 不带 label，前端自己映射
const runningStageLabel = computed(() => STEPS.find((s) => s.key === status.value?.stage)?.title || "同步中");

const progressHint = computed(() => {
  const st = status.value;
  if (!st) return "还没有同步过";
  if (st.stage === "error") return `上次同步失败：${st.lastError}`;
  if (st.stage === "cancelled") return "上次同步已取消";
  if (st.stage === "done") return `同步完成：${st.detail}`;
  return st.lastSyncAt ? `上次同步 ${fmtTime(st.lastSyncAt)}` : "还没有同步过";
});

// 日志按内容着级：失败红 / 冲突黄 / 计划与完成绿
function logLevel(text: string): string {
  if (/失败|错误|error/i.test(text)) return "bad";
  if (/冲突/.test(text)) return "warn";
  if (/计划|完成|已入队/.test(text)) return "ok";
  return "";
}
function fmtClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

const logBox = ref<HTMLElement | null>(null);
watch(() => logs.value.length, async () => {
  await nextTick();
  logBox.value?.scrollTo({ top: logBox.value.scrollHeight });
});

// 每次进入页面都重新拉一遍状态与日志
const active = computed(() => app.activeModule === "skills" && app.activePage === "webdav");
watch(active, (v) => { if (v) loadPage(); }, { immediate: true });

// 后台刷新拉不到就保留旧值，别把页面已有状态冲掉
async function refreshStatus() {
  try {
    status.value = await webdavStatus();
  } catch { /* 保留旧值 */ }
}
async function refreshLogs() {
  try {
    logs.value = (await webdavLogs()) || [];
  } catch { /* 保留旧值 */ }
}
async function refreshDevices() {
  try {
    const r = await webdavDevices();
    devices.value = r?.devices || [];
  } catch { /* 保留旧值 */ }
}

async function startSync() {
  try {
    const r = await webdavSync();
    if (r && !r.ok) saveMsg.value = r.message || "启动失败";
    else await refreshStatus();
  } catch (e) {
    saveMsg.value = String((e as Error).message || e);
  }
}

async function cancelSync() {
  await webdavCancel().catch(() => {});
}

async function openReportFile(file: string) {
  activeReport.value = file;
  try {
    const r = await readReport(file);
    reportContent.value = r?.content || "";
  } catch {
    reportContent.value = "";
  }
}

// 进入页面即整页加载：状态 / 日志 / 设备与报告
async function loadPage() {
  await refreshStatus();
  await refreshLogs();
  if (configured.value) await refreshDevices();
  const all = (await listReports().catch(() => [])) || [];
  reports.value = all.filter((r) => r.file.startsWith("webdav-"));
}

// 同步进度走主进程广播（event:"webdav"）；运行中日志实时长出来（IPC 拉取按 300ms 节流，
// 进度事件本身很密，每事件都全量拉日志会让页面自己变卡）；
// 结束（done/error/cancelled running=false）时刷新全部数据
let unsub: (() => void) | undefined;
let lastLogsPull = 0;
function throttledRefreshLogs() {
  const now = Date.now();
  if (now - lastLogsPull < 300) return;
  lastLogsPull = now;
  refreshLogs();
}
onMounted(() => {
  unsub = onUpdateEvent((payload) => {
    const p = payload as WebDavEvent;
    if (!p || p.event !== "webdav") return;
    if (status.value) {
      status.value.stage = (p.stage as WebDavStatus["stage"]) || status.value.stage;
      status.value.detail = p.detail || "";
      status.value.pct = p.pct ?? status.value.pct;
      status.value.running = !!p.running;
    }
    if (p.running) {
      throttledRefreshLogs();
    } else {
      // 一轮同步结束：拉结果、日志、设备与报告
      refreshStatus().then(() => {
        const st = status.value;
        if (st && st.stage === "done") {
          lastSummary.value = st.detail;
          const m = st.detail.match(/下载 (\d+)/);
          newSkills.value = m ? parseInt(m[1], 10) : 0;
        }
      });
      refreshLogs();
      refreshDevices();
      listReports().then((all) => {
        reports.value = (all || []).filter((r) => r.file.startsWith("webdav-"));
      }).catch(() => {});
    }
  });
});
onUnmounted(() => {
  if (unsub) unsub();
});
</script>

<template>
  <section class="page sk-page">
    <div class="sk-page-head">
      <div>
        <p class="sub">多台电脑各自拉取合并，双向增删全记录。</p>
      </div>
      <div class="sk-head-actions">
        <span class="sk-badge" :class="running ? 'info' : configured ? 'ok' : 'mute'" style="align-self:center">
          <i class="ph" :class="running ? 'ph-circle-notch' : configured ? 'ph-cloud-check' : 'ph-cloud-slash'"></i>
          {{ running ? runningStageLabel : configured ? "已连接就绪" : "未配置" }}
        </span>
        <button class="btn" :disabled="!running" @click="cancelSync"><i class="ph ph-x"></i>取消</button>
        <button class="btn btn-cta" :class="{ 'is-loading': running }" :disabled="running" @click="startSync">
          <i class="ph ph-arrows-clockwise"></i>{{ running ? "同步中…" : "立即同步" }}
        </button>
      </div>
    </div>

    <div class="sk-note warn" v-if="status && !configured && !running">
      <i class="ph ph-cloud-slash"></i>
      <div>
        还没配置 WebDAV 服务器。先到左下角「设置 · WebDAV 同步」填好服务器地址、账号与应用密码并保存，
        <a href="#" @click.prevent="app.openSettings('webdav')">去配置 →</a>
      </div>
    </div>
    <div class="sk-note warn" v-else-if="saveMsg"><i class="ph ph-warning"></i><div>{{ saveMsg }}</div></div>
    <div class="sk-note ok" v-if="lastSummary"><i class="ph ph-check-circle"></i><div>同步完成：{{ lastSummary }}<template v-if="newSkills">，<a href="#" @click.prevent="app.go('sync')">去同步中心分发到工具 →</a></template></div></div>

    <div class="sk-section">
      <div class="sk-panel">
        <el-steps v-if="showSteps" :active="stepActive" align-center finish-status="success" class="sync-steps">
          <el-step v-for="s in STEPS" :key="s.key" :title="s.title" />
        </el-steps>

        <el-progress
          :percentage="pct"
          :status="progressStatus"
          :stroke-width="10"
          :striped="running"
          :striped-flow="running"
          :duration="16"
        />

        <div class="sk-row-between run-mt">
          <span class="sk-muted sk-small" :class="{ 'is-running': running }">{{ running ? status?.detail || "进行中…" : progressHint }}</span>
          <span class="sk-badge mute sk-mono sk-small" v-if="status?.lastSyncAt">上次 {{ fmtTime(status.lastSyncAt) }}</span>
        </div>

        <hr class="sk-divider" />
        <div class="log-head">
          <span class="log-title"><i class="ph ph-list-dashes"></i>简要日志</span>
          <span class="sk-muted sk-small" v-if="logs.length">{{ logs.length }} 条</span>
        </div>
        <div class="log-list" ref="logBox">
          <div v-if="!logs.length" class="log-empty">还没有日志，点「立即同步」开始一轮同步。</div>
          <div v-for="(l, i) in logs" :key="i" class="log-line" :class="logLevel(l.text)">
            <span class="log-time">{{ fmtClock(l.at) }}</span>
            <span class="log-text">{{ l.text }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 设备列表 -->
    <div class="sk-section" v-if="devices.length">
      <h2>已注册设备</h2>
      <p class="desc">在同一 WebDAV 根目录下同步过的电脑。每台写自己的设备档案，互不覆盖。</p>
      <div class="sk-panel" style="padding:6px 8px; overflow-x:auto">
        <table class="sk-table">
          <thead><tr><th>设备</th><th>软件版本</th><th>最后同步</th><th style="text-align:right">设备 ID</th></tr></thead>
          <tbody>
            <tr v-for="d in devices" :key="d.id">
              <td class="strong">{{ d.name }} <span class="sk-badge ok" v-if="d.self">本机</span></td>
              <td class="sk-mono">{{ d.appVersion || "—" }}</td>
              <td>{{ fmtTime(d.lastSyncAt) }}</td>
              <td class="sk-mono sk-muted sk-small">{{ d.id.slice(0, 8) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <details class="sk-fold" v-if="reports.length">
      <summary>同步报告（{{ reports.length }} 份）</summary>
      <div class="sk-chips" style="margin:8px 0 12px">
        <span class="sk-chip" v-for="r in reports.slice(0, 8)" :key="r.file" :class="{ on: activeReport === r.file }" @click="openReportFile(r.file)">
          <i class="ph ph-file-text"></i> {{ fmtTime(r.mtimeMs) }}
        </span>
      </div>
      <div class="sk-code" v-if="reportContent">{{ reportContent }}</div>
      <div class="sk-row sk-mt-16" style="gap:10px" v-if="activeReport">
        <button class="btn" @click="openReport(activeReport)"><i class="ph ph-folder-open"></i>打开 reports 目录</button>
      </div>
    </details>
  </section>
</template>

<style scoped>
/* 步骤条与进度条之间留出呼吸空间（标题文字略溢出容器，靠这个 margin 隔开） */
.sync-steps { margin-bottom: 22px; }
.run-mt { margin-top: 12px; }

/* 运行中的 detail 文字给一点呼吸感 */
.is-running { color: var(--accent); }

/* 简要日志 */
.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.log-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.log-list {
  background: var(--code-bg);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 10px 14px;
  height: 200px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.9;
}
.log-line {
  display: flex;
  gap: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.log-time { flex: none; color: var(--text-3); }
.log-text { color: var(--code-text); }
.log-line.bad .log-text { color: var(--danger); }
.log-line.warn .log-text { color: var(--warn); }
.log-line.ok .log-text { color: var(--accent); }
.log-empty {
  color: var(--text-3);
  text-align: center;
  padding: 66px 0;
}
</style>
