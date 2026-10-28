<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
      此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 请求日志：按时间倒序 + 渠道/状态筛选 + 分页 + 导出
     页面形式照搬 fdb3e55^ 旧版反代网关的明细表（.stats-filters 筛选栏 / .table.table-bare /
     .table-scroll / .pager），功能与数据源保持现状不变。
     流水由 localgw/oplog.cjs 落库，保留期见配置 logRetentionDays（默认 30 天）；
     后端单次最多回 1000 行（oplog.list 钳制），所以前端必须分页而不是一次全拉。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";
import { fmtInt } from "../proxy/format";

const app = useAppStore();
const lgw = useLocalgwStore();
const filterChannel = ref("");
const filterStatus = ref("");
const exporting = ref(false);
/** 分页：一页 50 条，避免几百行流水一次性铺满 DOM */
const page = ref(1);
const PAGE_SIZE = 50;

const statusOptions = [
  { label: "全部状态", value: "" },
  { label: "成功", value: "success" },
  { label: "失败", value: "error" },
  { label: "取消", value: "cancelled" },
];

/** 保留期：与后端 oplog.gc 实际用的 logRetentionDays 同源，页面上说出来才知道「翻不到更早的」是正常的 */
const retentionDays = computed(() => Number(app.config.localgw?.logRetentionDays) || 30);

/** 渠道下拉：以号池已知渠道为底（不会随筛选结果收缩），再并入日志里出现过的渠道 */
const channelOptions = computed(() => {
  const set = new Set<string>();
  for (const c of lgw.allChannels) if (c.id) set.add(c.id);
  for (const c of lgw.channels) if (c.id) set.add(c.id);
  for (const r of lgw.logs) if (r.channel) set.add(r.channel);
  const list = [...set].sort((a, b) => a.localeCompare(b));
  return [{ label: "全部渠道", value: "" }, ...list.map((c) => ({ label: c, value: c }))];
});

const totalPages = computed(() => Math.max(1, Math.ceil(lgw.logsTotal / PAGE_SIZE)));

async function reload() {
  await lgw.refreshLogs({
    limit: PAGE_SIZE,
    offset: (page.value - 1) * PAGE_SIZE,
    channel: filterChannel.value || undefined,
    status: filterStatus.value || undefined,
  });
}

/** 改筛选条件：回到第 1 页再拉（否则会停在一个不存在的页码上，看到空表） */
async function reloadFromFirstPage() {
  page.value = 1;
  await reload();
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  reload();
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

/** 日志页的时间列带日期（跨天的流水只给 HH:mm:ss 会分不清是哪天），秒级精度保持原样 */
function fmtTime(ts: number) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusText(s: string) {
  return s === "success" ? "成功" : s === "error" ? "失败" : "取消";
}
/** 状态标签沿用全站 .tag 色板（与用量统计明细同一套语义色） */
function statusTagCls(s: string) {
  return s === "success" ? "tag-ok" : s === "error" ? "tag-err" : "tag-dim";
}

onMounted(async () => {
  // refreshLogs 成功即置 backendReady；顺带拉渠道清单让筛选下拉稳定
  await Promise.all([reload(), lgw.refreshChannels()]);
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="page-body">
      <!-- 顶部筛选栏：sticky，滚动只发生在下方内容区（与用量统计页同一套版式） -->
      <div class="stats-filters">
        <span class="lgw-toolbar-title">请求日志</span>
        <el-select v-model="filterChannel" placeholder="全部渠道" clearable class="f-el-select" popper-class="glass-popper" @change="reloadFromFirstPage">
          <el-option v-for="o in channelOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-select v-model="filterStatus" placeholder="全部状态" clearable class="f-el-select" popper-class="glass-popper" @change="reloadFromFirstPage">
          <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <span class="range-hint">共 {{ fmtInt(lgw.logsTotal) }} 条 · 保留期 {{ retentionDays }} 天</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" @click="reload"><i class="ph ph-arrows-clockwise"></i> 刷新</button>
        <button class="btn btn-sm" :disabled="exporting" @click="exportLogs('jsonl')">导出 JSONL</button>
        <button class="btn btn-sm" :disabled="exporting" @click="exportLogs('csv')">导出 CSV</button>
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

      <div v-else class="card">
        <div class="card-title">
          请求流水
          <span class="right">{{ fmtInt(lgw.logsTotal) }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
        </div>
        <div class="table-scroll">
          <table class="table table-bare tbl-c">
            <thead>
              <tr>
                <th>时间</th><th>密钥</th><th>渠道</th><th>模型</th>
                <th>状态</th><th>耗时</th><th>输入</th><th>输出</th><th>敏</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in lgw.logs" :key="r.id || i" :style="{ '--i': i }">
                <td class="mono">{{ fmtTime(r.ts) }}</td>
                <td class="mono">{{ r.apiKeyPrefix || "-" }}</td>
                <td>{{ r.channel || "-" }}</td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td>
                  <el-tooltip :content="r.errCode || ''" :disabled="!r.errCode" placement="top">
                    <span class="tag" :class="statusTagCls(r.status)">{{ statusText(r.status) }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ Math.round(Number(r.ms) || 0) }}ms</td>
                <td class="mono">{{ fmtInt(Number(r.promptTokens) || 0) }}</td>
                <td class="mono">{{ fmtInt(Number(r.completionTokens) || 0) }}</td>
                <!-- 敏：出站指纹脱敏命中的规则。悬停看完整清单（口径见 proxy/sanitize.cjs）；
                     没命中显示 "-"，不是 0 —— 0 会被误读成"命中了 0 条规则"这件事有意义 -->
                <td>
                  <el-tooltip v-if="r.sensitiveHits" :content="`已改写上游审核指纹：${r.sensitiveHits}`" placement="top">
                    <span class="tag tag-warn">敏</span>
                  </el-tooltip>
                  <span v-else>-</span>
                </td>
              </tr>
              <tr v-if="!lgw.logs.length">
                <td colspan="9" class="empty-cell">暂无请求记录 —— 网关启动后，客户端调用会在这里逐条出现</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span class="pager-info">共 {{ fmtInt(lgw.logsTotal) }} 条 · 每页 {{ PAGE_SIZE }} 条</span>
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方内容区（对齐用量统计页的筛选栏配方） */
.stats-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--glass-a);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.stats-filters .spacer {
  flex: 1;
}
.stats-filters .lgw-toolbar-title {
  margin-right: 4px;
}
.range-hint {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* el 组件模板根是多节点结构，scoped 的 data-v 透传不到根上，必须 :deep 穿透 */
.stats-filters :deep(.f-el-select) {
  width: 140px;
}
.stats-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 34px;
  font-size: 12.5px;
}

/* 表格字段值居中；th 全局 .table 已居中，这里覆盖默认左对齐的 td */
.tbl-c th,
.tbl-c td {
  text-align: center;
}
/* 本页表格行不可点（全局 .table 统一给了 pointer + 悬停底色，那是给「点行看详情」的表用的） */
.tbl-c tbody tr {
  cursor: default;
}

.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 18px 0;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.pager-info {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
</style>
