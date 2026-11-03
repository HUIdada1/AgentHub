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
<!-- 本地网关 · API Keys：生成 / 列表（完整 Key 可随时查看复制）/ 编辑 / 启停 / 删除（含批量删除）
     表格延续与用量统计板块同款的 `.table.table-bare` + `.table-scroll` + thead 结构；
     多选列 + 行内按钮 + 5 个自研弹窗
     （.p-mask / .p-dlg / .p-title / .p-actions，Teleport），全程不用 el-dialog / el-table / ElMessageBox。

     ⚠️ 口径修正（2026-11-03）：旧版「完整 Key 只在创建响应里出现一次、列表只存前缀」的约束已废弃。
     完整 Key 现在经系统凭据（DPAPI / AES-GCM）加密存库，列表解密回传，可随时查看 / 复制 / 编辑，
     不必再担心「没存好就只能删掉重建」；同时把不可逆的「吊销」换成可逆的「停用」+ 真「删除」。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import type { LocalgwKeyRow } from "../../api/ipc";
import { fmtDate, fmtInt, fmtK } from "../proxy/format";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 页面级错误（表单校验 / 批量中断）+ store 的 lastError 合成一条文案 */
const localErr = ref("");
const err = computed(() => localErr.value || lgw.lastError);
function dismissErr() {
  localErr.value = "";
  lgw.clearError();
}

/** 列表：启用在前、停用在后（停用的 Key 留作备用，堆在后面不干扰日常查看） */
const rows = computed(() =>
  [...(lgw.keys || [])].sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)),
);

/** 渠道权限文案：scopes 缺失时按「全部渠道」显示，不能直接 .includes 崩掉 */
function scopeText(k: { scopes?: string[] }) {
  const scopes = Array.isArray(k.scopes) ? k.scopes : [];
  if (!scopes.length || scopes.includes("*")) return "全部渠道";
  return `${scopes.length} 个渠道`;
}

async function refresh() {
  // 刻意不清 localErr：批量删除中断的说明就写在 localErr 里，
  // 而 doBatchDelete 的 finally 会调 refresh，清了等于刚报错就被自己擦掉
  await lgw.refreshKeys();
  // 列表变化后剔除已不存在的选中项，避免选中计数与实际行数不符
  const alive = new Set(rows.value.map((k) => k.id));
  selectedIds.value = new Set([...selectedIds.value].filter((id) => alive.has(id)));
}

// ===== 剪贴板 =====
const copyFailed = ref(false);
async function copyText(text: string): Promise<boolean> {
  copyFailed.value = false;
  if (!text) return false;
  try {
    // navigator.clipboard 在非 https / 无权限环境下不存在或直接 reject，必须兜底
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    copyFailed.value = true;
    return false;
  }
}

// ===== 生成 Key 弹窗 =====
const createOpen = ref(false);
const creating = ref(false);
const formErr = ref("");
const form = ref({
  name: "",
  scopeAll: true,
  scopes: [] as string[],
  noExpire: true,
  expiresAt: "",
  concurrency: 8,
  ratePerMin: 120,
});

function openCreate() {
  formErr.value = "";
  form.value = {
    name: `Key-${(lgw.keys.filter((k) => k.status === "active").length + 1).toString().padStart(2, "0")}`,
    scopeAll: true,
    scopes: [],
    noExpire: true,
    expiresAt: "",
    concurrency: 8,
    ratePerMin: 120,
  };
  createOpen.value = true;
}

/** 到期时间：按「所选日期当天 23:59:59（本地时区）」结算，
 *  避免 new Date("YYYY-MM-DD") 被当成 UTC 零点导致中国用户少用 8 小时。
 *  入参放宽到 unknown：日期输入框被清空后 v-model 会变空串，直接 .trim() 会崩 */
function parseExpiry(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 时间戳 → 日期框回填值（本地时区 YYYY-MM-DD）；空值回空串 */
function toDateInput(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(Number(ts))) return "";
  const d = new Date(Number(ts));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 校验 + 生成：错误一律写进弹窗内的 formErr（自研弹窗里没有 toast 位），弹窗不关 */
async function submitCreate() {
  if (creating.value) return;
  formErr.value = "";
  if (!form.value.name.trim()) {
    formErr.value = "请填写密钥名称";
    return;
  }
  if (!form.value.scopeAll && !form.value.scopes.length) {
    formErr.value = "请至少勾选一个渠道，或选择「全部渠道」";
    return;
  }
  let expiresAt: number | null = null;
  if (!form.value.noExpire) {
    // 「自定义」但没选日期 / 选了过去的日期都必须拦下：
    // 否则前者会静默变成永不过期，后者会创建一个立刻失效的 Key（都要用户自己发现）
    expiresAt = parseExpiry(form.value.expiresAt);
    if (!expiresAt) {
      formErr.value = "请选择到期日期";
      return;
    }
    if (expiresAt <= Date.now()) {
      formErr.value = "到期日期必须晚于今天";
      return;
    }
  }
  const concurrency = Number(form.value.concurrency);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    formErr.value = "并发上限必须 ≥ 1";
    return;
  }
  const ratePerMin = Number(form.value.ratePerMin);
  if (!Number.isFinite(ratePerMin) || ratePerMin < 1) {
    formErr.value = "限流必须 ≥ 1 req/min";
    return;
  }
  creating.value = true;
  try {
    const scopes = form.value.scopeAll ? ["*"] : form.value.scopes.slice();
    const name = form.value.name.trim();
    const r = await lgw.createKey({ name, scopes, expiresAt, concurrency, ratePerMin });
    if (r) {
      createOpen.value = false;
      // 完整 Key 已加密入库，这个弹窗只是「刚生成」的即时反馈，关掉也能在列表里再拿到
      justCreated.value = { rawKey: r.rawKey, name };
      secretCopied.value = false;
      copyFailed.value = false;
    } else {
      formErr.value = lgw.lastError || "创建失败";
    }
    await refresh();
  } finally {
    creating.value = false;
  }
}

// ===== Key 已生成弹窗 =====
const justCreated = ref<{ rawKey: string; name: string } | null>(null);
const secretCopied = ref(false);
let secretTimer: ReturnType<typeof setTimeout> | undefined;
async function copySecret() {
  const ok = await copyText(justCreated.value?.rawKey || "");
  if (!ok) return;
  secretCopied.value = true;
  clearTimeout(secretTimer);
  secretTimer = setTimeout(() => (secretCopied.value = false), 1500);
}

// ===== 列表行内复制完整 Key =====
const copiedId = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyKeyRow(k: LocalgwKeyRow) {
  const text = k.secret || "";
  if (!text) {
    localErr.value =
      "这把 Key 的完整值不可恢复（创建于旧版本、或换机 / 换用户后解不开加密信封）——请删除后重新生成一把。";
    return;
  }
  const ok = await copyText(text);
  if (!ok) {
    localErr.value = "复制失败（当前环境不允许访问剪贴板）—— 请直接在列表里选中该 Key 手动复制。";
    return;
  }
  copiedId.value = k.id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copiedId.value = ""), 1500);
}

// ===== 编辑弹窗（名称 / 渠道权限 / 有效期 / 并发 / 限流） =====
const editOpen = ref(false);
const editRow = ref<LocalgwKeyRow | null>(null);
const editing = ref(false);
const editForm = ref({
  name: "",
  scopeAll: true,
  scopes: [] as string[],
  noExpire: true,
  expiresAt: "",
  concurrency: 8,
  ratePerMin: 120,
});
function openEdit(k: LocalgwKeyRow) {
  formErr.value = "";
  editRow.value = k;
  const scopes = Array.isArray(k.scopes) ? k.scopes : [];
  const all = !scopes.length || scopes.includes("*");
  editForm.value = {
    name: k.name || "",
    scopeAll: all,
    scopes: all ? [] : scopes.slice(),
    noExpire: !k.expiresAt,
    expiresAt: toDateInput(k.expiresAt),
    concurrency: Number(k.concurrency) || 8,
    ratePerMin: Number(k.ratePerMin) || 120,
  };
  editOpen.value = true;
}
async function doEdit() {
  if (!editRow.value || editing.value) return;
  formErr.value = "";
  if (!editForm.value.name.trim()) {
    formErr.value = "名称不能为空";
    return;
  }
  if (!editForm.value.scopeAll && !editForm.value.scopes.length) {
    formErr.value = "请至少勾选一个渠道，或选择「全部渠道」";
    return;
  }
  // 有效期语义：永不过期 → 显式传 null（后端据此清空 expires_at）；自定义 → 必须有未来日期
  let expiresAt: number | null = null;
  if (!editForm.value.noExpire) {
    expiresAt = parseExpiry(editForm.value.expiresAt);
    if (!expiresAt) {
      formErr.value = "请选择到期日期";
      return;
    }
    if (expiresAt <= Date.now()) {
      formErr.value = "到期日期必须晚于今天";
      return;
    }
  }
  const concurrency = Number(editForm.value.concurrency);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    formErr.value = "并发上限必须 ≥ 1";
    return;
  }
  const ratePerMin = Number(editForm.value.ratePerMin);
  if (!Number.isFinite(ratePerMin) || ratePerMin < 1) {
    formErr.value = "限流必须 ≥ 1 req/min";
    return;
  }
  editing.value = true;
  try {
    const ok = await lgw.updateKey(editRow.value.id, {
      name: editForm.value.name.trim(),
      scopes: editForm.value.scopeAll ? ["*"] : editForm.value.scopes.slice(),
      expiresAt,
      concurrency,
      ratePerMin,
    });
    if (ok) editOpen.value = false;
    else formErr.value = lgw.lastError || "保存失败";
  } finally {
    editing.value = false;
  }
}

// ===== 启 / 停（行内直接生效，可逆操作不做二次确认） =====
const statusBusyId = ref("");
async function toggleStatus(k: LocalgwKeyRow) {
  if (statusBusyId.value) return;
  statusBusyId.value = k.id;
  try {
    await lgw.setKeyStatus(k.id, k.status === "active" ? "disabled" : "active");
  } finally {
    statusBusyId.value = "";
  }
}

// ===== 删除确认（单条） =====
const delOpen = ref(false);
const delRow = ref<LocalgwKeyRow | null>(null);
const deleting = ref(false);
function openDelete(k: LocalgwKeyRow) {
  formErr.value = "";
  delRow.value = k;
  delOpen.value = true;
}
async function doDelete() {
  if (!delRow.value || deleting.value) return;
  deleting.value = true;
  try {
    const ok = await lgw.deleteKey(delRow.value.id);
    if (ok) delOpen.value = false;
    else formErr.value = lgw.lastError || "删除失败";
  } finally {
    deleting.value = false;
    await refresh();
  }
}

// ===== 列表多选 / 全选 + 批量删除 =====
const selectedIds = ref<Set<string>>(new Set());
const batchOpen = ref(false);
const batchBusy = ref(false);
const selectedCount = computed(() => rows.value.filter((k) => selectedIds.value.has(k.id)).length);
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((k) => selectedIds.value.has(k.id)));
const selectedRows = computed(() => rows.value.filter((k) => selectedIds.value.has(k.id)));

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}
function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(rows.value.map((k) => k.id));
}

/** 批量删除：后端只有单条 localgw_keys_delete，这里逐条串行走——
 *  串行是有意的：任一条失败就停在中途并说明已处理几条，用户能对上账 */
async function doBatchDelete() {
  if (batchBusy.value) return;
  const ids = selectedRows.value.map((k) => k.id);
  if (!ids.length) {
    batchOpen.value = false;
    localErr.value = "没有选中的 Key";
    return;
  }
  batchBusy.value = true;
  let done = 0;
  try {
    for (const id of ids) {
      const ok = await lgw.deleteKey(id);
      if (!ok) {
        localErr.value = `批量删除中断：${lgw.lastError || "删除失败"}（已删除 ${done} / ${ids.length} 个）`;
        break;
      }
      done++;
    }
    batchOpen.value = false;
    selectedIds.value = new Set();
  } finally {
    batchBusy.value = false;
    await refresh();
  }
}

/** 本页是否处于前台：页面经 v-show 保活，切回本页时补一次刷新，列表不停留在旧数据 */
const active = computed(() => app.activeModule === "localgw" && app.activePage === "keys");
watch(active, (on) => {
  if (on) void refresh();
});

onMounted(async () => {
  // refreshKeys 成功即证明 localgw 通道已接线（backendReady 由 store 置位）——
  // 不再依赖「先打开总览页」才把占位态消掉（App.vue 会恢复上次停留的页面）
  await Promise.all([refresh(), lgw.refreshChannels()]);
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">
          {{ err }}
          <button class="btn-link btn-sm" style="margin-left: 8px" @click="dismissErr">知道了</button>
        </div>
      </div>
      <div v-if="!lgw.backendReady" class="card">
        <div class="set-desc">后端通道未接入：密钥表需要主进程 localgw IPC，接入后本页自动可用。</div>
      </div>

      <!-- 工具栏（页头已去标题化，「生成 Key」贴在正文顶部右侧；多选后左侧出现批量删除） -->
      <div class="toolbar">
        <button v-if="selectedCount" class="btn danger" :disabled="batchBusy" @click="batchOpen = true">
          批量删除（{{ selectedCount }}）
        </button>
        <button class="btn btn-primary" @click="openCreate">生成 Key</button>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="table-scroll">
          <table class="table table-bare tbl-static keys-tbl">
            <thead>
              <tr>
                <th class="sel-col">
                  <input type="checkbox" :checked="allSelected" :disabled="!rows.length" @change="toggleSelectAll" />
                </th>
                <!-- 列集 6 列：完整 Key 直接在表里可看可选中复制；累计请求 / Token / 到期日降级到名称格下的副行 -->
                <th>KEY</th>
                <th>名称</th>
                <th>渠道权限</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in rows" :key="k.id">
                <td class="sel-col">
                  <input type="checkbox" :checked="selectedIds.has(k.id)" @change="toggleSelect(k.id)" />
                </td>
                <td class="mono key-cell">
                  <template v-if="k.secret">
                    <span class="key-full" :title="k.secret">{{ k.secret }}</span>
                  </template>
                  <template v-else>
                    <span class="key-dead" :title="`该行创建于旧版本，完整 Key 不可恢复；前缀 ${k.keyPrefix}`">
                      {{ k.keyPrefix || "—" }}… <span class="key-dead-hint">不可恢复</span>
                    </span>
                  </template>
                </td>
                <td>
                  {{ k.name || "未命名" }}
                  <div class="name-sub">
                    累计 {{ fmtInt(k.totalRequests) }} 次 · {{ fmtK(k.totalTokens) }} tokens ·
                    {{ k.expiresAt ? `到期 ${fmtDate(k.expiresAt)}` : "永不过期" }}
                  </div>
                </td>
                <td>{{ scopeText(k) }}</td>
                <td>
                  <span class="tag" :class="k.status === 'active' ? 'tag-ok' : 'tag-dim'">
                    {{ k.status === "active" ? "启用" : "已停用" }}
                  </span>
                </td>
                <td class="op-cell">
                  <button
                    class="btn-link btn-sm"
                    :disabled="!k.secret"
                    :title="k.secret ? '复制完整 Key' : '完整 Key 不可恢复，请删除后重新生成'"
                    @click="copyKeyRow(k)"
                  >
                    {{ copiedId === k.id ? "已复制" : "复制" }}
                  </button>
                  <button class="btn-link btn-sm" @click="openEdit(k)">编辑</button>
                  <button
                    class="btn-link btn-sm"
                    :class="{ danger: k.status === 'active' }"
                    :disabled="statusBusyId === k.id"
                    @click="toggleStatus(k)"
                  >
                    {{ k.status === "active" ? "停用" : "启用" }}
                  </button>
                  <button class="btn-link btn-sm danger" @click="openDelete(k)">删除</button>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" class="empty-cell">
                  还没有 Key —— 点上方「生成 Key」；生成后可在列表随时查看 / 复制完整 Key
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">安全提示</div>
        <div class="code">
          鉴权比对只用 SHA-256 哈希 · 完整 Key 经系统凭据加密存储（可随时查看 / 复制）·
          停用与删除即时生效（鉴权实时查库）
        </div>
      </div>
    </div>

    <Teleport to="body">
      <!-- 生成 Key 弹窗 -->
      <div v-if="createOpen" class="p-mask" @click.self="createOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">生成 API Key</div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="form.name" class="input" style="width: 180px" placeholder="例如：本地主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">渠道权限</div>
              <div class="set-desc">「全部渠道」写成 scopes ["*"]；限定渠道则只允许打到勾选的号池渠道</div>
            </div>
            <div class="radio-row">
              <label class="radio-item"><input v-model="form.scopeAll" type="radio" :value="true" />全部渠道</label>
              <label class="radio-item"><input v-model="form.scopeAll" type="radio" :value="false" />仅以下渠道</label>
            </div>
          </div>
          <div v-if="!form.scopeAll" class="set-row" style="align-items: flex-start">
            <div class="set-info">
              <div class="set-name">授权渠道</div>
              <div class="set-desc">至少勾一个；列表来自号池管家（只读）</div>
            </div>
            <div class="chk-grid">
              <label v-for="c in lgw.channels" :key="c.id" class="chk-item">
                <input v-model="form.scopes" type="checkbox" :value="c.id" />{{ c.display }}
              </label>
              <span v-if="!lgw.channels.length" class="set-desc">号池暂无渠道，先到「号池管家」添加账号</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">有效期</div>
              <div class="set-desc">自定义到期日按当天 23:59:59（本地时区）结算</div>
            </div>
            <div class="radio-row">
              <label class="radio-item"><input v-model="form.noExpire" type="radio" :value="true" />永不过期</label>
              <label class="radio-item"><input v-model="form.noExpire" type="radio" :value="false" />自定义</label>
              <input
                v-if="!form.noExpire"
                v-model="form.expiresAt"
                class="input mono"
                style="width: 150px"
                type="date"
              />
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">并发上限</div>
              <div class="set-desc">建议 ≤ 16（与网关全局并发上限对齐）</div>
            </div>
            <input v-model.number="form.concurrency" class="input mono" style="width: 100px" type="number" min="1" max="64" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">限流（次/分钟）</div>
              <div class="set-desc">超限返回 429</div>
            </div>
            <input v-model.number="form.ratePerMin" class="input mono" style="width: 100px" type="number" min="1" max="10000" />
          </div>
          <div v-if="formErr" class="set-desc err-text" style="margin-top: 6px">{{ formErr }}</div>
          <div class="p-actions">
            <button class="btn" @click="createOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="creating" @click="submitCreate">
              {{ creating ? "生成中…" : "生成" }}
            </button>
          </div>
        </div>
      </div>

      <!-- Key 已生成：即时反馈 + 一键复制；关掉也能在列表里再拿到完整 Key -->
      <div v-if="justCreated" class="p-mask" @click.self="justCreated = null">
        <div class="p-dlg glass">
          <div class="p-title">Key 已生成</div>
          <div class="set-desc" style="margin-bottom: 10px">
            「{{ justCreated.name }}」已加密存入本地凭据库，<b>之后可在列表随时查看 / 复制</b>。
            现在也可以直接复制走。
          </div>
          <div class="code secret-box">{{ justCreated.rawKey }}</div>
          <div v-if="copyFailed" class="set-desc err-text" style="margin-top: 6px">
            复制失败（当前环境不允许访问剪贴板）—— 请手动选中上面的文本复制。
          </div>
          <div class="p-actions">
            <button class="btn" @click="copySecret">{{ secretCopied ? "已复制" : "复制" }}</button>
            <button class="btn btn-primary" @click="justCreated = null">关闭</button>
          </div>
        </div>
      </div>

      <!-- 编辑弹窗：名称 / 渠道权限 / 有效期 / 并发 / 限流 -->
      <div v-if="editOpen" class="p-mask" @click.self="editOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">编辑 Key</div>
          <div v-if="editRow?.secret" class="set-desc" style="margin-bottom: 8px">
            <span class="mono key-inline">{{ editRow.secret }}</span>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="editForm.name" class="input" style="width: 180px" placeholder="例如：本地主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">渠道权限</div>
              <div class="set-desc">改这里只影响后续请求的渠道过滤，不动 Key 本身</div>
            </div>
            <div class="radio-row">
              <label class="radio-item"><input v-model="editForm.scopeAll" type="radio" :value="true" />全部渠道</label>
              <label class="radio-item"><input v-model="editForm.scopeAll" type="radio" :value="false" />仅以下渠道</label>
            </div>
          </div>
          <div v-if="!editForm.scopeAll" class="set-row" style="align-items: flex-start">
            <div class="set-info">
              <div class="set-name">授权渠道</div>
              <div class="set-desc">至少勾一个；列表来自号池管家（只读）</div>
            </div>
            <div class="chk-grid">
              <label v-for="c in lgw.channels" :key="c.id" class="chk-item">
                <input v-model="editForm.scopes" type="checkbox" :value="c.id" />{{ c.display }}
              </label>
              <span v-if="!lgw.channels.length" class="set-desc">号池暂无渠道，先到「号池管家」添加账号</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">有效期</div>
              <div class="set-desc">改成「永不过期」会清空原到期时间</div>
            </div>
            <div class="radio-row">
              <label class="radio-item"><input v-model="editForm.noExpire" type="radio" :value="true" />永不过期</label>
              <label class="radio-item"><input v-model="editForm.noExpire" type="radio" :value="false" />自定义</label>
              <input
                v-if="!editForm.noExpire"
                v-model="editForm.expiresAt"
                class="input mono"
                style="width: 150px"
                type="date"
              />
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">并发上限</div>
              <div class="set-desc">建议 ≤ 16（与网关全局并发上限对齐）</div>
            </div>
            <input
              v-model.number="editForm.concurrency"
              class="input mono"
              style="width: 100px"
              type="number"
              min="1"
              max="64"
            />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">限流（次/分钟）</div>
              <div class="set-desc">超限返回 429</div>
            </div>
            <input
              v-model.number="editForm.ratePerMin"
              class="input mono"
              style="width: 100px"
              type="number"
              min="1"
              max="10000"
            />
          </div>
          <div v-if="formErr" class="set-desc err-text" style="margin-top: 6px">{{ formErr }}</div>
          <div class="p-actions">
            <button class="btn" @click="editOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="editing" @click="doEdit">{{ editing ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>

      <!-- 删除确认（旧版就是自研弹窗，不用 ElMessageBox） -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除 Key</div>
          <div class="set-desc">
            确定删除「{{ delRow?.name || "未命名" }}」（{{ delRow?.keyPrefix }}…）？
            删除立即生效且不可恢复，使用该 Key 的客户端会返回 401；只想临时停用请用行内「停用」。
          </div>
          <div v-if="formErr" class="set-desc err-text" style="margin-top: 6px">{{ formErr }}</div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn danger-solid" :disabled="deleting" @click="doDelete">
              {{ deleting ? "删除中…" : "删除" }}
            </button>
          </div>
        </div>
      </div>

      <!-- 批量删除确认（列表多选后出现） -->
      <div v-if="batchOpen" class="p-mask" @click.self="batchOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">批量删除 Key</div>
          <div class="set-desc">
            确定删除选中的 {{ selectedCount }} 个 Key？
            删除立即生效且不可恢复，使用这些 Key 的客户端会返回 401。
          </div>
          <div class="p-actions">
            <button class="btn" @click="batchOpen = false">取消</button>
            <button class="btn danger-solid" :disabled="batchBusy" @click="doBatchDelete">
              {{ batchBusy ? "删除中…" : "删除" }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：「生成 Key」工具栏靠右贴在正文顶部 */
.toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.danger {
  color: var(--err, #e05555);
}
/* 选择列：全选与行选 checkbox 居中（与号池列表同一版式） */
.sel-col {
  width: 34px;
  text-align: center;
}
.sel-col input[type="checkbox"] {
  vertical-align: middle;
  cursor: pointer;
  accent-color: var(--accent);
}
/* 列表内容水平居中：与居中的表头对齐，整表视觉居中 */
.keys-tbl td {
  text-align: center;
}
/* KEY 列：完整 Key 单行等宽显示，可整段选中复制；失活的旧行给弱化色 + 说明 */
.key-cell {
  text-align: left;
}
.key-full {
  display: inline-block;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  user-select: all;
  cursor: text;
}
.key-dead {
  color: var(--text-3);
}
.key-dead-hint {
  font-size: 10.5px;
}
/* 行内四个按钮：不换行、间距紧凑，避免把表格撑到换行 */
.op-cell {
  white-space: nowrap;
}
.op-cell .btn-link + .btn-link {
  margin-left: 6px;
}
/* 本表行内只有按钮与复选框，不点行看详情：全局 .table 默认给了 pointer + 主色悬停底色，这里关掉 */
.tbl-static tbody tr {
  cursor: default;
}
.tbl-static tbody tr:hover {
  background: transparent;
}
.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 18px 0;
}
/* 名称格下的累计副行：列集裁到 6 列后，累计口径降级到这里，不与旧版「今日」列混淆 */
.name-sub {
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* 弹窗里的单选 / 多选：自研弹窗不引 Element Plus 的 radio / checkbox，用原生控件 + 主题色 */
.radio-row {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.radio-item,
.chk-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.radio-item input[type="radio"],
.chk-item input[type="checkbox"] {
  accent-color: var(--accent);
  margin: 0;
  cursor: pointer;
}
.chk-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  max-width: 300px;
  max-height: 140px;
  overflow: auto;
}
/* 弹窗（.p-mask / .p-dlg / .p-title / .p-actions / .danger-solid）走 global.css 的全站统一版式 */
.secret-box {
  word-break: break-all;
  user-select: all;
  padding: 10px;
}
/* 编辑弹窗顶部的完整 Key：长串允许换行，避免把弹窗撑破 */
.key-inline {
  word-break: break-all;
  color: var(--text-2);
}
</style>
