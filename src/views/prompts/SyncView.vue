<!--
  ============================================================
   作者：沐晖
   日期：2026-10-23
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 提示词库 · WebDAV 同步（方案 §3.5 / §8.3 / §8.4）
     本页的重点不是「点一下同步」，而是**冲突的可解释与可改判**：
     自动合并被设为默认策略的前提是「被放弃的那一份进了版本历史」，所以界面必须把
     「这轮自动合并了哪些、按什么策略、保留的是谁」摆出来，并允许用户当场改判。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { usePromptsStore } from "../../stores/prompts";
import { pipc, type PromptConflict, type PromptConflictDiff } from "./promptTypes";
import { formatDateTime } from "../../composables/useFormat";

const store = usePromptsStore();

/** 阶段顺序固定，进度条按它点亮（顺序来自契约 §4.3 的 stage 枚举） */
const STAGES: { key: string; label: string }[] = [
  { key: "connect", label: "连接" },
  { key: "pull", label: "拉取" },
  { key: "merge", label: "合并" },
  { key: "push", label: "上传" },
  { key: "done", label: "完成" },
];

const logs = ref<{ at: number; text: string }[]>([]);
const devices = ref<{ id: string; name: string; appVersion: string; lastSyncAt: number; self: boolean }[]>([]);
const reports = ref<{ name: string; path: string; size: number }[]>([]);
const reportText = ref("");
const reportName = ref("");
const busy = ref(false);
const diffOpenId = ref("");
const diff = ref<PromptConflictDiff | null>(null);
const manualText = ref("");
let logTimer = 0;

const st = computed(() => store.syncStatus);
const configured = computed(() => st.value?.configured !== false);
const stageIndex = computed(() => {
  const k = st.value?.stage || "idle";
  if (k === "error" || k === "cancelled") return -1;
  return STAGES.findIndex((s) => s.key === k);
});
const autoMergedList = computed(() => store.conflicts.filter((c) => c.autoMerged));
const pendingList = computed(() => store.conflicts.filter((c) => !c.resolved && !c.autoMerged));
/** 下一次自动同步预计时刻：与后端 sched 同口径（间隔小时 × 上次同步），仅供用户预期，不参与调度 */
const nextAt = computed(() => {
  const last = st.value?.lastSyncAt || 0;
  if (!last || !store.cfg.syncAuto) return 0;
  return last + Math.max(1, store.cfg.syncIntervalHours) * 3600 * 1000;
});

async function refreshAll() {
  await Promise.all([store.loadSync(), store.loadConflicts(), loadDevices(), loadReports()]);
}

async function loadDevices() {
  try {
    const r = await pipc.promptsSyncDevices();
    devices.value = r.devices || [];
  } catch { devices.value = []; }
}

async function loadReports() {
  try {
    const r = await pipc.promptsReportsList();
    reports.value = r.reports || [];
  } catch { reports.value = []; }
}

async function loadLogs() {
  try {
    const r = await pipc.promptsSyncLogs();
    logs.value = r.logs || [];
  } catch { /* 日志是附属信息 */ }
}

async function openReport(name: string) {
  try {
    const r = await pipc.promptsReportRead({ name });
    reportName.value = name;
    reportText.value = r.text || "";
  } catch (e) {
    ElMessage.error((e as Error).message || "读取报告失败");
  }
}

async function runSync() {
  if (busy.value || st.value?.running) return;
  busy.value = true;
  try {
    const r = await pipc.promptsSyncRun();
    if (r.ok) {
      ElMessage.success(r.message || "同步完成");
      await refreshAll();
      await store.loadLibrary(true);
    } else {
      // 未配置 / 其它板块占用 / 远端疑似被清空 —— 后端的 message 已经写清了原因，原样呈现
      ElMessage.warning(r.message || "同步未执行");
      await refreshAll();
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "同步失败");
  } finally {
    busy.value = false;
  }
}

async function cancelSync() {
  await pipc.promptsSyncCancel();
  ElMessage.info("已请求取消（在途请求会在当前阶段结束后停止）");
}

async function autoMergeAll() {
  try {
    const r = await pipc.promptsConflictsAuto({});
    ElMessage.success(`已自动合并 ${r.merged} 条，剩余待裁决 ${r.remaining} 条`);
    await store.loadConflicts();
    await store.loadLibrary(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "自动合并失败");
  }
}

async function toggleDiff(c: PromptConflict) {
  if (diffOpenId.value === c.id) { diffOpenId.value = ""; diff.value = null; return; }
  diffOpenId.value = c.id;
  diff.value = null;
  try {
    const r = await pipc.promptsConflictDiff({ id: c.id });
    diff.value = r.diff || null;
    manualText.value = r.diff?.left.body || "";
  } catch { /* 读不到就让界面显示占位 */ }
}

async function resolve(c: PromptConflict, decision: "local" | "remote" | "both" | "merge") {
  if (decision === "merge") {
    await pipc.promptsConflictResolve({ id: c.id, decision, mergedText: manualText.value });
  } else {
    await pipc.promptsConflictResolve({ id: c.id, decision });
  }
  ElMessage.success("已裁决");
  diffOpenId.value = "";
  diff.value = null;
  await store.loadConflicts();
  await store.loadLibrary(true);
}

/** 简易行级差异：左有右无=删、右有左无=增、都有=上下文。
 *  刻意不做 LCS：提示词改写通常是整段重写，行级对齐的收益低于复杂度。 */
const diffRows = computed(() => {
  if (!diff.value) return [];
  const L = diff.value.left.body.split(/\r?\n/);
  const R = diff.value.right.body.split(/\r?\n/);
  const setL = new Set(L), setR = new Set(R);
  const rows: { left: string; right: string; kind: "same" | "chg" }[] = [];
  const max = Math.max(L.length, R.length);
  for (let i = 0; i < max; i++) {
    const l = L[i] ?? "", r = R[i] ?? "";
    rows.push({ left: l, right: r, kind: l === r ? "same" : "chg" });
  }
  void setL; void setR;
  return rows;
});

async function setAuto(v: boolean) {
  await store.saveCfg({ syncAuto: v });
  ElMessage.success(v ? "已开启自动同步" : "已关闭自动同步");
}

function gotoWebdavSettings() {
  // 服务器凭据统一在「设置 · WebDAV 同步」，本页不重复造入口
  ElMessage.info("请在「设置 · WebDAV 同步」里填写服务器地址与账号");
}

onMounted(async () => {
  store.init();
  await refreshAll();
  await loadLogs();
  // 日志轮询：只在同步进行中才开，避免空闲时也每 300ms 打一次 IPC
  logTimer = window.setInterval(() => { if (st.value?.running) void loadLogs(); }, 1000);
});
onUnmounted(() => { if (logTimer) window.clearInterval(logTimer); });

// 同步结束后补一次设备与报告（设备档案是同步时写的）
watch(() => st.value?.running, async (now, before) => {
  if (before && !now) { await loadDevices(); await loadReports(); await loadLogs(); }
});
</script>

<template>
  <div class="page prompts-scope">
    <!-- 页头卡：标题/说明 + 操作 + 状态行（原先页头悬空、状态又单独一张卡，两层错位；
         合并成一张卡后，状态行用分隔线与页头隔开，所有元素在同一栅格里对齐） -->
    <div class="pr-card">
      <div class="pr-head">
        <div class="pr-head-main">
          <div class="pr-card-title">
            <i class="ph ph-cloud-arrow-up-down"></i>WebDAV 同步
          </div>
          <div class="pr-hint">
            提示词库使用独立的同步根目录，与技能仓库 / 用量统计 / 号池管家 / 记忆中枢互不干扰。
            冲突默认<b>自动合并</b>（被放弃的版本会存入该条目的版本历史，可随时改判或回滚）。
          </div>
        </div>
        <div class="pr-head-actions">
          <el-button v-if="!st?.running" type="primary" :loading="busy" :disabled="!configured" @click="runSync">立即同步</el-button>
          <el-button v-else type="warning" @click="cancelSync">取消</el-button>
          <el-button @click="refreshAll">刷新</el-button>
        </div>
      </div>

      <div v-if="configured" class="pr-sync-status">
        <span class="pr-row" style="gap: 6px; flex-wrap: nowrap">
          <span class="pr-dot" :class="st?.running ? 'warn' : st?.lastError ? 'bad' : 'ok'"></span>
          <b>{{ st?.running ? "同步中" : st?.lastError ? "上次失败" : "就绪" }}</b>
        </span>
        <span class="pr-hint">上次同步：{{ st?.lastSyncAt ? formatDateTime(st.lastSyncAt) : "从未" }}</span>
        <span v-if="nextAt" class="pr-hint">下次预计：{{ formatDateTime(nextAt) }}</span>
        <span class="pr-inline-ctl">
          <span class="pr-hint">自动同步（每 {{ store.cfg.syncIntervalHours }} 小时）</span>
          <el-switch :model-value="store.cfg.syncAuto" @update:model-value="setAuto(!!$event)" />
        </span>
      </div>
      <div v-if="configured && st?.lastError" class="pr-warn-inline" style="margin-top: 8px">{{ st.lastError }}</div>
      <div v-if="configured" class="pr-hint" style="margin-top: 8px">周期在「设置 · 同步时间 → 提示词库」里调整。</div>
    </div>

    <!-- 未配置 WebDAV：空态引导，而不是给一个点了没反应的按钮 -->
    <div v-if="!configured" class="pr-card pr-empty">
      <i class="ph ph-cloud-slash"></i>
      <div class="es-title">尚未配置 WebDAV 服务器</div>
      <div class="pr-hint">同步需要服务器地址、账号与密码，请在设置里填写后再回来。</div>
      <el-button size="small" @click="gotoWebdavSettings">去设置</el-button>
    </div>

    <template v-else>
      <!-- 阶段进度 -->
      <div class="pr-card">
        <div class="pr-card-title"><i class="ph ph-list-checks"></i>同步进度</div>
        <div class="pr-stages">
          <span
            v-for="(s, i) in STAGES"
            :key="s.key"
            class="pr-stage"
            :class="{ done: stageIndex > i, on: stageIndex === i, bad: st?.stage === 'error' && i === 0 }"
          >{{ s.label }}</span>
        </div>
        <div class="pr-progress"><i :style="{ width: (st?.pct || (st?.stage === 'done' ? 100 : 0)) + '%' }"></i></div>
        <div class="pr-hint">{{ st?.detail || "等待同步" }}</div>
      </div>

      <!-- 冲突区：本页核心。标题行用 pr-card-title 承载（标题 / 计数 chips / 右侧按钮同行居中对齐，
           代替原来「pr-row 里塞带 margin 的标题」造成的上下错位） -->
      <div class="pr-card">
        <div class="pr-card-title">
          <i class="ph ph-git-merge"></i>冲突处理
          <span class="pr-chip info">本轮自动合并 {{ st?.autoMerged || 0 }} 条</span>
          <span class="pr-chip" :class="{ warn: pendingList.length > 0 }">待人工裁决 {{ pendingList.length }} 条</span>
          <span class="pr-inline-ctl">
            <el-button size="small" :disabled="!pendingList.length" @click="autoMergeAll">自动合并全部</el-button>
          </span>
        </div>
        <div class="pr-hint" style="margin-bottom: 10px">
          自动合并按「{{ store.cfg.mergeStrategy === 'newer-wins' ? '新者优先' : store.cfg.mergeStrategy }}」策略裁决；
          被放弃的那一份不会消失，它已写入对应条目的版本历史。
        </div>

        <div class="pr-col">
          <div v-if="!store.conflicts.length" class="pr-hint">暂无冲突记录。</div>

          <!-- 已自动合并（可改判） -->
          <div v-for="c in autoMergedList" :key="c.id" class="pr-conflict is-auto">
            <div class="pr-row">
              <span class="pr-chip accent">已自动合并</span>
              <b>{{ c.name || c.title }}</b>
              <span class="pr-hint">{{ c.detail }}</span>
              <span class="pr-inline-ctl">
                <el-button size="small" text @click="toggleDiff(c)">{{ diffOpenId === c.id ? "收起" : "查看/改判" }}</el-button>
              </span>
            </div>
            <template v-if="diffOpenId === c.id">
              <div class="pr-diff2">
                <div class="col">
                  <div class="col-head">{{ diff?.left.label || "本地" }} · {{ diff?.left.updatedAt ? formatDateTime(diff.left.updatedAt) : "—" }}</div>
                  <div class="col-body"><pre class="pr-pre">{{ diff?.left.body || "（读取中…）" }}</pre></div>
                </div>
                <div class="col">
                  <div class="col-head">{{ diff?.right.label || "远端" }}</div>
                  <div class="col-body"><pre class="pr-pre">{{ diff?.right.body || "（远端内容需重新同步后查看）" }}</pre></div>
                </div>
              </div>
              <div class="pr-row">
                <el-button size="small" @click="resolve(c, 'local')">保留本地</el-button>
                <el-button size="small" @click="resolve(c, 'remote')">改用远端</el-button>
                <el-button size="small" @click="resolve(c, 'both')">两者都留</el-button>
              </div>
            </template>
          </div>

          <!-- 待裁决 -->
          <div v-for="c in pendingList" :key="c.id" class="pr-conflict">
            <div class="pr-row">
              <span class="pr-chip warn">待裁决</span>
              <b>{{ c.name || c.title }}</b>
              <span class="pr-hint">{{ c.detail }}</span>
              <span class="pr-inline-ctl">
                <el-button size="small" @click="toggleDiff(c)">{{ diffOpenId === c.id ? "收起" : "对比" }}</el-button>
              </span>
            </div>
            <template v-if="diffOpenId === c.id">
              <div class="pr-diff2">
                <div class="col">
                  <div class="col-head">{{ diff?.left.label || "本地" }}</div>
                  <div class="col-body">
                    <div v-for="(r, i) in diffRows" :key="i" class="pr-diff-line" :class="r.kind === 'chg' ? 'del' : 'ctx'">{{ r.left || " " }}</div>
                  </div>
                </div>
                <div class="col">
                  <div class="col-head">{{ diff?.right.label || "远端" }}</div>
                  <div class="col-body">
                    <div v-for="(r, i) in diffRows" :key="i" class="pr-diff-line" :class="r.kind === 'chg' ? 'add' : 'ctx'">{{ r.right || " " }}</div>
                  </div>
                </div>
              </div>
              <div class="pr-row">
                <el-button size="small" @click="resolve(c, 'local')">保留本地</el-button>
                <el-button size="small" @click="resolve(c, 'remote')">保留远端</el-button>
                <el-button size="small" @click="resolve(c, 'both')">两者都留</el-button>
                <el-button size="small" type="primary" @click="resolve(c, 'merge')">用下方内容合并</el-button>
              </div>
              <textarea v-model="manualText" class="pr-area" rows="6" style="min-height: 110px" placeholder="手动合并后的正文"></textarea>
            </template>
          </div>
        </div>
      </div>

      <!-- 设备 + 日志：宽屏并排（grid 自动换行成单列），日志的滚动范围收在卡内不撑开页面 -->
      <div class="pr-sync-grid">
        <div class="pr-card">
          <div class="pr-card-title"><i class="ph ph-devices"></i>已同步设备</div>
          <div v-if="!devices.length" class="pr-hint">还没有其它设备同步过。</div>
          <div v-else class="pr-table-wrap">
            <table class="pr-table">
              <thead><tr><th>设备</th><th>版本</th><th>最后同步</th></tr></thead>
              <tbody>
                <tr v-for="d in devices" :key="d.id">
                  <td>{{ d.name }} <span v-if="d.self" class="pr-chip accent">本机</span></td>
                  <td>{{ d.appVersion || "—" }}</td>
                  <td>{{ d.lastSyncAt ? formatDateTime(d.lastSyncAt) : "—" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="pr-card">
          <div class="pr-card-title">
            <i class="ph ph-terminal-window"></i>实时日志
            <span class="pr-inline-ctl"><el-button size="small" text @click="loadLogs">刷新</el-button></span>
          </div>
          <pre class="pr-pre" style="max-height: 220px">{{ logs.length ? logs.map((l) => `[${formatDateTime(l.at)}] ${l.text}`).join("\n") : "（暂无日志）" }}</pre>
        </div>
      </div>

      <!-- 报告 -->
      <div class="pr-card">
        <div class="pr-card-title"><i class="ph ph-file-text"></i>同步报告</div>
        <div v-if="!reports.length" class="pr-hint">还没有生成过报告。</div>
        <div v-else class="pr-row">
          <span v-for="r in reports.slice(0, 12)" :key="r.name" class="pr-chip click" @click="openReport(r.name)">{{ r.name.replace(/^prompts-|\.md$/g, "") }}</span>
        </div>
        <pre v-if="reportText" class="pr-pre" style="max-height: 300px; margin-top: 10px">{{ reportText }}</pre>
        <div v-if="reportName" class="pr-hint" style="margin-top: 6px">当前查看：{{ reportName }}</div>
      </div>
    </template>
  </div>
</template>
