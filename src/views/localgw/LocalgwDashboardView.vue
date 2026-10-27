<!--
  ============================================================
   作者：沐晖
   日期：2026-10-27
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 总览：运行状态 / KPI / 三步引导 / 最近请求 / 渠道状态一览
     号池无账号时显示引导（方案决策 5）；后端未接入时显示「后端未就绪」占位 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { formatToken } from "../../composables/useFormat";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 轮询句柄：只在「总览页可见 + 后端就绪」时启动 */
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** 当前是否停留在总览页：App.vue 用 v-show 保活，切页不会卸载组件，
 *  所以必须自己按可见性起停轮询，否则离开页面后定时器一直空转 */
const visible = computed(() => app.activeModule === "localgw" && app.activePage === "dashboard");

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
function startPoll() {
  stopPoll();
  // 后端没接线时不要轮询：每 5s 一次必然失败的 IPC 没有意义（等 backendReady 翻真再启）
  if (!lgw.backendReady) return;
  // 5s 轮询一次状态：足够实时又不至于打爆 IPC（事件订阅留待 server 上线后启用）
  pollTimer = setInterval(() => { lgw.refreshStatus(); }, 5000);
}

/** 引导步骤状态（决策 5 三步引导） */
const guideStep = computed(() => {
  if (!lgw.backendReady) return 0; // 后端未就绪（占位态）
  if (!lgw.poolReady) return 1;    // 号池无账号 → 引导去号池
  if (!lgw.snapshot?.running) return 2; // 号池有账号但网关未启动
  return 3; // 全部就绪
});

const guideSteps = [
  { title: "后端通道未接入", desc: "等待主进程注册 localgw IPC 通道" },
  { title: "到号池管家添加渠道账号", desc: "本地网关复用号池的账号体系，不会另建一套" },
  { title: "启动本地网关", desc: "点击下方启动按钮，网关会按配置的监听地址（默认 127.0.0.1）开始服务" },
  { title: "到「服务与密钥」创建第一个 API Key", desc: "Key 创建后只在页面上显示一次，请立即复制保存" },
];

const busy = ref(false);
async function toggleStart() {
  if (busy.value) return;
  if (!lgw.canStart) {
    ElMessage.warning("请先到号池管家添加至少一个渠道账号");
    return;
  }
  const enable = !(lgw.snapshot?.running);
  busy.value = true;
  try {
    if (!enable) {
      try {
        await ElMessageBox.confirm("停止后所有通过该网关的 API 调用都会失败，确认停止？", "停止本地网关", {
          confirmButtonText: "停止",
          cancelButtonText: "取消",
          type: "warning",
        });
      } catch { return; }
    }
    // store 已把异常收敛成 lastError，这里不会再抛出
    const ok = await lgw.toggle(enable);
    if (ok) ElMessage.success(enable ? "网关已启动" : "网关已停止");
    else ElMessage.error(lgw.lastError || (enable ? "启动失败" : "停止失败"));
  } finally {
    busy.value = false;
  }
}

/** KPI 列表（快照 + 延时分位） */
const kpis = computed(() => {
  const s = lgw.snapshot;
  if (!s) return [];
  // errRate 后端给的是 0~1 的比例（errCount / todayReq），不是百分数：这里统一乘 100 并保留一位小数。
  // 今日无请求时 errRate 恒为 0，显示 "0.0%" 会让人误以为"有请求但零错误"，所以单列一个 — 文案
  const errRateText = s.todayReq > 0 ? `${(s.errRate * 100).toFixed(1)}` : "—";
  return [
    { label: "今日请求", value: String(s.todayReq), unit: "次" },
    { label: "今日 tokens", value: formatToken(s.todayTokens) },
    { label: "错误率", value: errRateText, unit: s.todayReq > 0 ? "%" : "无请求" },
    { label: "平均延迟", value: lgw.pot?.avgMs ? `${Math.round(lgw.pot.avgMs)}` : "-", unit: "ms" },
    { label: "P95 延迟", value: lgw.pot?.p95Ms ? `${Math.round(lgw.pot.p95Ms)}` : "-", unit: "ms" },
    { label: "活跃渠道", value: String(s.activeChannels), unit: "个" },
    { label: "有效密钥", value: String(s.validKeys), unit: "个" },
  ];
});

/** 渠道状态一览（来自号池，只读） */
const channelRows = computed(() => {
  return lgw.channels.slice(0, 6).map((c) => ({
    id: c.id,
    name: c.display,
    meta: c.onlineCount ? `${c.onlineCount}/${c.accountCount} 在线` : "无在线账号",
    ok: c.onlineCount > 0,
  }));
});

/** 最近请求（前 8 条） */
const recentLogs = computed(() => lgw.logs.slice(0, 8));

function fmtTime(ts: number) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusClass(s: string) {
  return s === "success" ? "lgw-status-ok" : s === "error" ? "lgw-status-err" : "lgw-status-cancelled";
}

onMounted(async () => {
  await lgw.loadAll();
  await lgw.refreshLogs();
  if (visible.value) startPoll();
});
onUnmounted(stopPoll);
// 页面可见性 / 后端就绪度变化时同步轮询状态
watch(visible, (v) => { if (v) startPoll(); else stopPoll(); });
watch(() => lgw.backendReady, () => { if (visible.value) startPoll(); });
// 启停状态变化即刷新请求流（切到运行态时马上能看到新流水）
watch(() => lgw.snapshot?.running, () => { if (lgw.backendReady) lgw.refreshLogs(); });
</script>

<template>
  <div class="page lgw-scope">
    <!-- 顶部操作条 -->
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">本地网关</span>
      <el-tag v-if="lgw.snapshot?.running" type="success">运行中</el-tag>
      <el-tag v-else-if="lgw.backendReady" type="info">未启动</el-tag>
      <el-tag v-else type="warning">后端未就绪</el-tag>
      <el-button
        size="small"
        :type="lgw.snapshot?.running ? 'danger' : 'primary'"
        :loading="busy"
        :disabled="!lgw.canStart && !lgw.snapshot?.running"
        @click="toggleStart"
      >
        {{ lgw.snapshot?.running ? "停止" : "启动" }}
      </el-button>
      <span v-if="lgw.snapshot" class="lgw-kpi-sub">
        {{ lgw.snapshot.bind }}:{{ lgw.snapshot.port }}
      </span>
      <span v-if="lgw.snapshot?.running" class="lgw-kpi-sub">
        运行 {{ Math.floor(lgw.snapshot.uptimeSec / 60) }} 分钟
      </span>
    </div>

    <!-- 错误横幅：刷新/操作失败时把原因显式说出来（后端未接线不算错误，走下面的占位态） -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <!-- 后端未接入占位 -->
    <div v-if="!lgw.backendReady" class="lgw-backend-off">
      <i class="ph ph-link-break lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入</div>
      <div class="lgw-backend-off-desc">
        前端已就绪，等待主进程注册 localgw IPC 通道。接入方式：在 electron/main.cjs 中
        <code style="font-family:var(--font-mono);font-size:11px">const lgw = require("./backend/localgw/index.cjs"); lgw.register(ipcMain); lgw.boot();</code>
      </div>
    </div>

    <!-- 号池未配置 → 三步引导 -->
    <div v-else-if="guideStep < 3" class="lgw-guide">
      <div class="lgw-guide-title">开始使用本地网关</div>
      <div
        v-for="(s, i) in guideSteps.slice(1, 4)"
        :key="i"
        class="lgw-guide-step"
        :style="i + 1 === guideStep ? '' : 'opacity:0.5'"
      >
        <span class="lgw-step-num">{{ i + 1 }}</span>
        <div class="lgw-step-body">
          <div class="lgw-step-title">{{ s.title }}</div>
          <div class="lgw-step-desc">{{ s.desc }}</div>
        </div>
        <el-button
          v-if="i + 1 === 1 && guideStep === 1"
          size="small"
          type="primary"
          @click="app.selectModule('proxy')"
        >去号池管家</el-button>
      </div>
    </div>

    <!-- 正常运行态 -->
    <template v-else>
      <!-- KPI 条 -->
      <div class="lgw-kpis">
        <div v-for="k in kpis" :key="k.label" class="lgw-kpi">
          <span class="lgw-kpi-label">{{ k.label }}</span>
          <span class="lgw-kpi-value">{{ k.value }}<span v-if="k.unit" class="lgw-unit">{{ k.unit }}</span></span>
        </div>
      </div>

      <!-- 双栏：引导（已就绪时弱化显示）+ 最近请求 -->
      <div class="lgw-grid-2">
        <div class="lgw-section">
          <div class="lgw-section-title">接入引导</div>
          <div class="lgw-guide-step" style="opacity:0.6">
            <span class="lgw-step-num">1</span>
            <div class="lgw-step-body">
              <div class="lgw-step-title">网关运行中</div>
              <div class="lgw-step-desc">Base URL：http://127.0.0.1:{{ lgw.snapshot?.port }}/v1</div>
            </div>
          </div>
          <div class="lgw-guide-step" style="opacity:0.6">
            <span class="lgw-step-num">2</span>
            <div class="lgw-step-body">
              <div class="lgw-step-title">到「服务与密钥」创建 API Key</div>
              <div class="lgw-step-desc">每个 Key 可独立设置渠道权限、并发与限流</div>
            </div>
            <el-button size="small" @click="app.setPage('keys')">去创建</el-button>
          </div>
          <div class="lgw-guide-step" style="opacity:0.6">
            <span class="lgw-step-num">3</span>
            <div class="lgw-step-body">
              <div class="lgw-step-title">在 IDE 或 curl 中粘贴</div>
              <div class="lgw-step-desc">详见「接入与文档」页的示例片段</div>
            </div>
            <el-button size="small" @click="app.setPage('access')">查看接入</el-button>
          </div>
        </div>

        <div class="lgw-section">
          <div class="lgw-section-title">最近请求</div>
          <table v-if="recentLogs.length" class="lgw-table">
            <thead>
              <tr><th>时间</th><th>渠道</th><th>模型</th><th>状态</th><th>耗时</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in recentLogs" :key="r.id || i">
                <td>{{ fmtTime(r.ts) }}</td>
                <td>{{ r.channel || "-" }}</td>
                <td>{{ r.model || "-" }}</td>
                <td :class="statusClass(r.status)">{{ r.status === "success" ? "成功" : r.status === "error" ? "失败" : "取消" }}</td>
                <td>{{ Math.round(Number(r.ms) || 0) }}ms</td>
              </tr>
            </tbody>
          </table>
          <div v-else style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">
            今日还没有请求记录
          </div>
        </div>
      </div>

      <!-- 渠道状态一览 -->
      <div class="lgw-section">
        <div class="lgw-section-title">渠道状态一览</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <div v-for="c in channelRows" :key="c.id" class="lgw-channel-row" style="flex:1;min-width:160px">
            <div class="lgw-channel-body">
              <div class="lgw-channel-name">{{ c.name }}</div>
              <div class="lgw-channel-meta">{{ c.meta }}</div>
            </div>
            <el-tag :type="c.ok ? 'success' : 'warning'" size="small">{{ c.ok ? "在线" : "离线" }}</el-tag>
          </div>
          <div v-if="!channelRows.length" style="color:var(--text-3);font-size:12px;padding:8px">
            号池暂无可用渠道
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lgw-channel-body { flex:1;min-width:0 }
</style>
