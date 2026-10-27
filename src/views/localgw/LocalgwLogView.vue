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
<!-- 本地网关 · 请求日志：按时间倒序 + 渠道/状态筛选 + 分页 + 导出
     流水由 localgw/oplog.cjs 落库，保留期见配置 logRetentionDays（默认 30 天）；
     后端单次最多回 1000 行（oplog.list 钳制），所以前端必须分页而不是一次全拉 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";

const lgw = useLocalgwStore();
const filterChannel = ref("");
const filterStatus = ref("");
const exporting = ref(false);
/** 分页：一页 50 条，避免几百行流水一次性铺满 DOM */
const page = ref(1);
const pageSize = ref(50);

const statusOptions = [
  { label: "全部状态", value: "" },
  { label: "成功", value: "success" },
  { label: "失败", value: "error" },
  { label: "取消", value: "cancelled" },
];

/** 渠道下拉：以号池已知渠道为底（不会随筛选结果收缩），再并入日志里出现过的渠道 */
const channelOptions = computed(() => {
  const set = new Set<string>();
  for (const c of lgw.allChannels) if (c.id) set.add(c.id);
  for (const c of lgw.channels) if (c.id) set.add(c.id);
  for (const r of lgw.logs) if (r.channel) set.add(r.channel);
  const list = [...set].sort((a, b) => a.localeCompare(b));
  return [{ label: "全部渠道", value: "" }, ...list.map((c) => ({ label: c, value: c }))];
});

async function reload() {
  await lgw.refreshLogs({
    limit: pageSize.value,
    offset: (page.value - 1) * pageSize.value,
    channel: filterChannel.value || undefined,
    status: filterStatus.value || undefined,
  });
}

/** 改筛选条件：回到第 1 页再拉（否则会停在一个不存在的页码上，看到空表） */
async function reloadFromFirstPage() {
  page.value = 1;
  await reload();
}

async function onPageChange(p: number) {
  page.value = p;
  await reload();
}

async function exportLogs(fmt: "jsonl" | "csv") {
  if (exporting.value) return;
  exporting.value = true;
  try {
    // 导出要等系统保存对话框（用户可能很久才选），失败/取消都要有可见反馈
    const r = await localgwApi.logsExport(fmt);
    if (r && r.ok) ElMessage.success(r.path ? `已导出到 ${r.path}` : "已导出");
    else ElMessage.error(r?.message || "导出失败");
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    exporting.value = false;
  }
}

function fmtTime(ts: number) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusText(s: string) {
  return s === "success" ? "成功" : s === "error" ? "失败" : "取消";
}
function statusClass(s: string) {
  return s === "success" ? "lgw-status-ok" : s === "error" ? "lgw-status-err" : "lgw-status-cancelled";
}

onMounted(async () => {
  // refreshLogs 成功即置 backendReady；顺带拉渠道清单让筛选下拉稳定
  await Promise.all([reload(), lgw.refreshChannels()]);
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">请求日志</span>
      <span class="lgw-kpi-sub">共 {{ lgw.logsTotal }} 条</span>
      <el-select v-model="filterChannel" size="small" style="width:140px" @change="reloadFromFirstPage">
        <el-option v-for="o in channelOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filterStatus" size="small" style="width:120px" @change="reloadFromFirstPage">
        <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button size="small" @click="exportLogs('jsonl')" :loading="exporting">导出 JSONL</el-button>
      <el-button size="small" @click="exportLogs('csv')" :loading="exporting">导出 CSV</el-button>
    </div>

    <!-- 错误横幅：加载/导出失败时把原因显式说出来 -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <div v-if="!lgw.backendReady" class="lgw-backend-off">
      <i class="ph ph-link-break lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入</div>
      <div class="lgw-backend-off-desc">请求流水由 localgw 主进程写入，接入后本页自动可用。</div>
    </div>

    <div v-else class="lgw-section">
      <div class="lgw-table-wrap">
        <table v-if="lgw.logs.length" class="lgw-table">
          <thead>
            <tr>
              <th>时间</th><th>密钥</th><th>渠道</th><th>模型</th>
              <th>状态</th><th>耗时</th><th>输入</th><th>输出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in lgw.logs" :key="r.id || i">
              <td>{{ fmtTime(r.ts) }}</td>
              <td>{{ r.apiKeyPrefix || "-" }}</td>
              <td>{{ r.channel || "-" }}</td>
              <td>{{ r.model || "-" }}</td>
              <td :class="statusClass(r.status)">{{ statusText(r.status) }}</td>
              <td>{{ Math.round(Number(r.ms) || 0) }}ms</td>
              <td>{{ r.promptTokens ?? 0 }}</td>
              <td>{{ r.completionTokens ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!lgw.logs.length" style="padding:32px;text-align:center;color:var(--text-3);font-size:12px">
        暂无请求记录 —— 网关启动后，客户端调用会在这里逐条出现
      </div>

      <!-- 分页：只在确实超过一页时出现 -->
      <div v-if="lgw.logsTotal > pageSize" style="display:flex;justify-content:flex-end;padding-top:10px">
        <el-pagination
          small
          background
          layout="prev, pager, next, total"
          :total="lgw.logsTotal"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </div>
  </div>
</template>
