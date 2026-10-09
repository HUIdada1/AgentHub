<script setup lang="ts">
// 反代网关 · 操作日志（「日志」页签）：反代网关各项操作一条一条落库（op_logs 表，stats.db），
// 这里分页展示 + 时间段/等级/操作筛选 + 导出 Excel。写入点见 backend/proxy/oplog.cjs 模块头。
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { ProxyOpLogRow } from "../../types";

const app = useAppStore();

const filter = reactive({
  from: "", // "YYYY-MM-DD"，空为不限
  to: "",
  level: "", // info / warn / error，空为全部
  op: "", // 操作分类，空为全部
});

const rows = ref<ProxyOpLogRow[]>([]);
const total = ref(0);
const error = ref("");
const page = ref(0);
const pageSize = 20;
const opOptions = ref<string[]>([]);
const exportMsg = ref<{ ok: boolean; text: string } | null>(null);
let exportMsgTimer = 0;

const LEVELS: Record<string, { label: string; cls: string }> = {
  info: { label: "信息", cls: "ok" },
  warn: { label: "警告", cls: "warn" },
  error: { label: "错误", cls: "err" },
};

/** 日期串 → 当日毫秒区间（本地时区），空为 null（与用量明细页同一套语义） */
function rangeToMs() {
  return {
    from: filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null,
    to: filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : null,
  };
}

function formatTs(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load() {
  const { from, to } = rangeToMs();
  try {
    const r = await api.proxyOpLogList({ from, to, level: filter.level || undefined, op: filter.op || undefined, limit: pageSize, offset: page.value * pageSize });
    rows.value = r?.rows || [];
    total.value = r?.total || 0;
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
}

async function loadOps() {
  // 操作类型下拉从真实数据动态生成，避免硬编码漏项；失败保留旧选项
  try {
    opOptions.value = await api.proxyOpLogOps();
  } catch {
    /* 下拉选项加载失败不阻断列表使用 */
  }
}

onMounted(() => {
  load();
  loadOps();
});

// v-show 常驻页：切回该页时刷新（新操作随时产生，重进页面就要看到最新）
watch(
  () => app.activePage,
  (p) => {
    if (p === "proxylog") {
      load();
      loadOps();
    }
  }
);

function pickLevel(v: string) { filter.level = v || ""; page.value = 0; load(); }
function pickOp(v: string) { filter.op = v || ""; page.value = 0; load(); }
function pickFrom(v: string) { filter.from = v || ""; page.value = 0; load(); }
function pickTo(v: string) { filter.to = v || ""; page.value = 0; load(); }

async function doExport() {
  try {
    const { from, to } = rangeToMs();
    const r = await api.proxyOpLogExport({ from, to, level: filter.level || undefined, op: filter.op || undefined });
    exportMsg.value = { ok: !!r?.ok, text: r?.message || (r?.ok ? "导出成功" : "导出失败") };
  } catch (e) {
    exportMsg.value = { ok: false, text: `导出失败：${e instanceof Error ? e.message : "未知错误"}` };
  }
  window.clearTimeout(exportMsgTimer);
  exportMsgTimer = window.setTimeout(() => { exportMsg.value = null; }, 6000);
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">日志</div>
        <div class="page-sub">反代网关各项操作记录（代理请求 / 签到 / 账号 / 配置等），本地存储 30 天；等级：信息=成功 · 警告=需人工/4xx · 错误=失败</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" @click="load(); loadOps()">刷新</button>
      </div>
    </div>
    <div class="page-body">
      <div class="log-filters">
        <div class="log-fgroup"><label>开始日期</label>
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
        <div class="log-fgroup"><label>结束日期</label>
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
        <div class="log-fgroup"><label>等级</label>
          <el-select :model-value="filter.level" placeholder="全部等级" popper-class="glass-popper" class="f-el-select" @update:model-value="pickLevel">
            <el-option value="" label="全部等级" />
            <el-option value="info" label="信息" />
            <el-option value="warn" label="警告" />
            <el-option value="error" label="错误" />
          </el-select>
        </div>
        <div class="log-fgroup"><label>操作</label>
          <el-select :model-value="filter.op" placeholder="全部操作" popper-class="glass-popper" class="f-el-select" @update:model-value="pickOp">
            <el-option value="" label="全部操作" />
            <el-option v-for="o in opOptions" :key="o" :value="o" :label="o" />
          </el-select>
        </div>
        <div style="flex: 1"></div>
        <span v-if="error" style="font-size: 12px; color: var(--err)">{{ error }}</span>
        <el-tooltip v-else-if="exportMsg" :content="exportMsg.text" placement="top">
          <span :style="{ fontSize: '12px', color: exportMsg.ok ? 'var(--ok)' : 'var(--err)', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }">{{ exportMsg.text }}</span>
        </el-tooltip>
        <button class="btn-outline" @click="doExport">导出 Excel</button>
      </div>

      <div class="card">
        <div class="table-scroll">
          <table class="table">
            <thead><tr>
              <th>时间</th><th>等级</th><th>操作</th><th>渠道</th><th>对象</th><th>内容</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.id">
                <td class="mono nowrap">{{ formatTs(r.ts) }}</td>
                <td><span class="log-pill" :class="LEVELS[r.level]?.cls || 'ok'">{{ LEVELS[r.level]?.label || r.level }}</span></td>
                <td class="nowrap">{{ r.op }}</td>
                <td class="nowrap">{{ r.channel || "—" }}</td>
                <td class="nowrap" :title="r.target">{{ r.target || "—" }}</td>
                <td class="log-msg">
                  <el-tooltip :content="r.detail || r.message" :disabled="!(r.detail && r.detail !== r.message)" placement="top">
                    <span>{{ r.message }}<template v-if="r.detail && r.detail !== r.message"> <span class="log-detail">· {{ r.detail }}</span></template></span>
                  </el-tooltip>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" class="empty">当前筛选条件下没有日志{{ error ? "" : "（改一下筛选或点「刷新」）" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span class="pg-info">共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages }} 页</span>
          <button class="btn-ghost" :disabled="page === 0" @click="page--; load()">上一页</button>
          <button class="btn-ghost" :disabled="(page + 1) * pageSize >= total" @click="page++; load()">下一页</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方表格区（对齐用量明细页的筛选栏配方）；
   .filters/.f-group 被用量模块的 sync-scope 作用域占用，这里自备同款配方 */
.log-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin-bottom: 14px;
  padding: 12px 14px;
  background: var(--glass-bg);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.log-fgroup {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.log-fgroup label {
  font-size: 11px;
  color: var(--text-3);
}

/* 筛选区的 el 控件：宽度对齐 f-el-select（el 组件模板根是多节点结构，scoped data-v
   透传不到 .el-select/.el-date-editor 根上，必须借后代 :deep 穿透） */
.log-filters :deep(.f-date),
.log-filters :deep(.f-el-select) {
  width: 150px;
}
.log-filters :deep(.f-date .el-input__wrapper),
.log-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 34px;
  font-size: 13px;
}

/* 等级胶囊（.pill 被用量模块的 sync-scope 作用域占用，这里自备同款配方） */
.log-pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  white-space: nowrap;
}
.log-pill.ok {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}
.log-pill.warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.log-pill.err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

/* 内容列吃剩余宽度，长文本省略号（悬停 tooltip 看全） */
.log-msg {
  max-width: 0;
  min-width: 220px;
}
.log-msg span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-detail {
  color: var(--text-3);
}
.nowrap {
  white-space: nowrap;
}
.mono {
  font-family: var(--font-mono, monospace);
}
.empty {
  text-align: center;
  color: var(--text-3);
  padding: 24px 0;
}
</style>
