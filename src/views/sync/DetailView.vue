<script setup lang="ts">
import { onMounted, ref, reactive, watch, computed } from "vue";
import { useUsageStore } from "../../stores/usage";
import { useSyncStore } from "../../stores/sync";
import { formatToken, formatDateTime, formatCost } from "../../composables/useFormat";
import * as api from "../../api/sync";
import Drawer from "../../components/sync/Drawer.vue";
import type { UsageRecord } from "../../types/sync";

const usage = useUsageStore();
const app = useSyncStore();

// 费用列/抽屉的货币符号跟随计费显示币种
const currency = computed(() => app.config.billing?.displayCurrency || "CNY");

const filter = reactive({
  from: "", // "YYYY-MM-DD"，空为不限
  to: "",
  model: null as string | null,
  provider: null as string | null,
  device: null as string | null,
  status: null as string | null,
});

const page = ref(0);
const pageSize = 20;

const modelOptions = ref<string[]>([]);
const providerOptions = ref<string[]>([]);

const drawerShow = ref(false);
const drawerTitle = ref("");
const drawerRows = ref<{ k: string; v: string }[]>([]);
const exportMsg = ref<{ ok: boolean; text: string } | null>(null);
let exportMsgTimer = 0;

const statusText: Record<string, { label: string; cls: string }> = {
  success: { label: "成功", cls: "ok" },
  error: { label: "失败", cls: "err" },
  cancelled: { label: "已取消", cls: "warn" },
};

/** 日期字符串 → 当日毫秒区间（本地时区），空为 null */
function rangeToMs() {
  return {
    from: filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null,
    to: filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : null,
  };
}

/** 当前筛选 → 导出条件（与列表查询同一套语义） */
function exportFilter() {
  const { from, to } = rangeToMs();
  return { from, to, deviceId: filter.device, source: app.querySource, model: filter.model, provider: filter.provider, status: filter.status };
}

async function load() {
  const { from, to } = rangeToMs();
  await usage.loadRecords({
    from, to,
    deviceId: filter.device, source: app.querySource,
    model: filter.model, provider: filter.provider, status: filter.status,
    limit: pageSize, offset: page.value * pageSize,
  });
}

async function loadOptions() {
  // 模型 / 供应商下拉从真实数据动态生成，避免硬编码漏项；失败保留旧选项。
  // 走轻量维度接口（原为拿选项跑两次全表 getAggregate，切源时要多等约 300ms）
  try {
    const [models, providers] = await Promise.all([
      api.getDimensions("model", app.querySource),
      api.getDimensions("provider", app.querySource),
    ]);
    modelOptions.value = models;
    providerOptions.value = providers;
  } catch {
    /* 下拉选项加载失败不阻断列表使用 */
  }
}

onMounted(() => {
  load();
  loadOptions();
  // 设备下拉不依赖总览页是否加载过（源未启用/总览失败时也能筛选设备）
  usage.refreshDevices();
});

watch(() => app.activeSource, () => {
  filter.from = "";
  filter.to = "";
  filter.model = null;
  filter.provider = null;
  filter.device = null;
  filter.status = null;
  page.value = 0;
  load();
  loadOptions();
  usage.refreshDevices();
});

watch(() => app.totalMode, () => {
  load();
  loadOptions();
});

// 同步结束后自动刷新列表与下拉选项（页面用 v-show 常驻，需手动触发）
watch(() => app.sync.running, (now, prev) => {
  if (prev && !now) {
    load();
    loadOptions();
    usage.refreshDevices();
  }
});

// 在计费规则页改价/导入后切回明细时刷新（费用列随价格版本重算，视图常驻需手动触发）
watch(() => app.activePage, (p) => {
  if (p === "detail") load();
});

function pickModel(v: string) { filter.model = v || null; page.value = 0; load(); }
function pickProvider(v: string) { filter.provider = v || null; page.value = 0; load(); }
function pickDevice(v: string) { filter.device = v || null; page.value = 0; load(); }
function pickStatus(v: string) { filter.status = v || null; page.value = 0; load(); }
function pickFrom(v: string) { filter.from = v || ""; page.value = 0; load(); }
function pickTo(v: string) { filter.to = v || ""; page.value = 0; load(); }

async function doExport(fmt: "csv" | "json") {
  try {
    const r = await api.exportData(fmt, exportFilter());
    exportMsg.value = {
      ok: !!r?.ok,
      text: r?.ok ? `${r.message || "导出成功"}：${r.path}` : r?.message || "导出失败",
    };
  } catch (e) {
    exportMsg.value = { ok: false, text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` };
  }
  window.clearTimeout(exportMsgTimer);
  exportMsgTimer = window.setTimeout(() => { exportMsg.value = null; }, 6000);
}

function openRecord(r: UsageRecord) {
  const billingOn = !!app.config.billing?.enabled;
  drawerTitle.value = "用量明细详情";
  drawerRows.value = [
    { k: "记录 ID", v: r.id },
    { k: "时间", v: formatDateTime(r.startedAt) },
    { k: "模型", v: r.modelId },
    { k: "供应商", v: r.providerId },
    { k: "变体 variant", v: r.variant || "—" },
    { k: "会话 session_id", v: r.sessionId || "—" },
    { k: "任务类型 task_type", v: r.taskType || "—" },
    { k: "agent", v: r.agent || "—" },
    { k: "模式 mode", v: r.mode || "—" },
    { k: "输入 tokens", v: formatToken(r.inputTokens) },
    { k: "输出 tokens", v: formatToken(r.outputTokens) },
    { k: "推理 tokens", v: formatToken(r.reasoningTokens) },
    { k: "缓存命中", v: formatToken(r.cacheReadTokens) },
    { k: "缓存写入", v: formatToken(r.cacheCreationTokens) },
    { k: "额度 credits", v: r.credits != null ? r.credits.toFixed(2) : "—" },
    // 费用按记录发生时刻的价格版本计算；原生为该模型计费币种金额
    ...(billingOn ? [
      { k: "费用", v: r.priced ? formatCost(r.costDisplay, 6, currency.value) : "未配置价格" },
      { k: "费用（原生币种）", v: r.priced ? `${(r.costNative ?? 0).toFixed(6)} ${r.costCurrency || ""}` : "—" },
    ] : []),
    { k: "状态", v: r.status },
  ];
  drawerShow.value = true;
}

const totalPages = () => Math.max(1, Math.ceil(usage.recordsTotal / pageSize));
</script>

<template>
  <div class="sync-page">
    <div class="filters detail-bar">
      <div class="f-group"><label>开始日期</label>
          <el-date-picker
            :model-value="filter.from"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不限"
            popper-class="glass-popper"
            class="f-date"
            @update:model-value="pickFrom"
          />
        </div>
        <div class="f-group"><label>结束日期</label>
          <el-date-picker
            :model-value="filter.to"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不限"
            popper-class="glass-popper"
            class="f-date"
            @update:model-value="pickTo"
          />
        </div>
        <div class="f-group"><label>模型</label>
          <el-select :model-value="filter.model || ''" placeholder="全部模型" popper-class="glass-popper" class="f-el-select" @update:model-value="pickModel">
            <el-option value="" label="全部模型" />
            <el-option v-for="m in modelOptions" :key="m" :value="m" :label="m" />
          </el-select>
        </div>
        <div class="f-group"><label>供应商</label>
          <el-select :model-value="filter.provider || ''" placeholder="全部供应商" popper-class="glass-popper" class="f-el-select" @update:model-value="pickProvider">
            <el-option value="" label="全部供应商" />
            <el-option v-for="p in providerOptions" :key="p" :value="p" :label="p" />
          </el-select>
        </div>
        <div class="f-group"><label>设备</label>
          <el-select :model-value="filter.device || ''" placeholder="全部设备" popper-class="glass-popper" class="f-el-select" @update:model-value="pickDevice">
            <el-option value="" label="全部设备" />
            <el-option v-for="d in usage.devices" :key="d.deviceId" :value="d.deviceId" :label="d.deviceName" />
          </el-select>
        </div>
        <div class="f-group"><label>状态</label>
          <el-select :model-value="filter.status || ''" placeholder="全部状态" popper-class="glass-popper" class="f-el-select" @update:model-value="pickStatus">
            <el-option value="" label="全部状态" />
            <el-option value="success" label="成功" />
            <el-option value="error" label="失败" />
            <el-option value="cancelled" label="已取消" />
          </el-select>
        </div>
        <div style="flex: 1"></div>
        <span v-if="usage.recordsError" style="font-size: 12px; color: var(--err)">{{ usage.recordsError }}</span>
        <span v-else-if="exportMsg" :style="{ fontSize: '12px', color: exportMsg.ok ? 'var(--ok)' : 'var(--err)', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }" :title="exportMsg.text">{{ exportMsg.text }}</span>
        <button class="btn-outline" @click="doExport('csv')">导出 CSV</button>
        <button class="btn-outline" @click="doExport('json')">导出 JSON</button>
      </div>
      <div class="card">
      <div class="table-scroll">
        <table class="table table-bare">
          <thead><tr>
            <th>时间</th><th>模型</th><th>供应商</th><th>输入</th><th>输出</th><th>推理</th><th>缓存命中</th><th>额度</th>
            <th v-if="app.config.billing?.enabled">费用</th>
            <th>状态</th>
          </tr></thead>
          <tbody>
            <tr v-for="(r, i) in usage.records" :key="r.id" :style="{ '--i': i }" @click="openRecord(r)">
              <td class="mono">{{ formatDateTime(r.startedAt) }}</td>
              <td class="mono">{{ r.modelId }}</td>
              <td>{{ r.providerId }}</td>
              <td class="num mono">{{ formatToken(r.inputTokens) }}</td>
              <td class="num mono">{{ formatToken(r.outputTokens) }}</td>
              <td class="num mono">{{ formatToken(r.reasoningTokens) }}</td>
              <td class="num mono">{{ formatToken(r.cacheReadTokens) }}</td>
              <td class="num mono" :title="r.credits != null ? '额度点（Qoder 官方模型计量单位）' : ''">
                <span v-if="r.credits != null" class="mono">{{ r.credits.toFixed(2) }}</span>
                <span v-else style="color: var(--text-3)">—</span>
              </td>
              <td v-if="app.config.billing?.enabled" class="num mono" :title="r.priced ? `原生 ${(r.costNative ?? 0).toFixed(6)} ${r.costCurrency || ''}` : '该模型未配置价格'">
                <span v-if="r.priced" class="mono">{{ formatCost(r.costDisplay, 4, currency) }}</span>
                <span v-else style="color: var(--text-3)">—</span>
              </td>
              <td><span class="pill" :class="statusText[r.status]?.cls || 'blue'">{{ statusText[r.status]?.label || r.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span class="pg-info">共 {{ usage.recordsTotal }} 条 · 第 {{ page + 1 }} / {{ totalPages() }} 页</span>
        <button class="btn-ghost" :disabled="page === 0" @click="page--; load()">上一页</button>
        <button class="btn-ghost" :disabled="(page + 1) * pageSize >= usage.recordsTotal" @click="page++; load()">下一页</button>
      </div>
    </div>

    <Drawer :show="drawerShow" :title="drawerTitle" :rows="drawerRows" @close="drawerShow = false" />
  </div>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方表格区，筛选操作始终可及 */
.detail-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  margin-bottom: 14px;
  padding: 12px 14px;
  background: var(--glass-bg);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}

/* 明细列表去掉内部行分隔线：行距与 hover 底色承担区分 */
.table-bare tbody td {
  border-bottom: none;
  padding-top: 13px;
  padding-bottom: 13px;
}

/* 筛选区的 el 控件：宽度和高度对齐原 f-select/f-input（34px），不抢布局节奏
   注意：el-date-picker/el-select 模板根是 tooltip 包裹的多节点结构，组件 scoped 的
   data-v 透传不到 .el-date-editor/.el-select 根上，直接 .f-date{width} 命不中（默认 220px），
   必须借 .filters 后代 :deep 穿透 */
.filters :deep(.f-date),
.filters :deep(.f-el-select) {
  width: 150px;
}
.filters :deep(.f-date .el-input__wrapper),
.filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 34px;
  font-size: 13px;
}
.filters :deep(.f-date .el-input__inner) {
  font-size: 13px;
}
</style>
