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
<!-- 本地网关 · API Keys：生成 / 列表 / 改名 / 吊销（含批量）
     页面形式照搬 fdb3e55^ 的旧版反代网关 API Keys 页（ProxyKeysView.vue），
     但表格已改用与用量统计板块同款的 `.table.table-bare` + `.table-scroll` + thead 结构；
     多选列 + 行内按钮 + 5 个自研弹窗
     （.p-mask / .p-dlg / .p-title / .p-actions，Teleport），全程不用 el-dialog / el-table / ElMessageBox。

     ⚠️ 与旧版最关键的口径差异（方案决策 3）：
     完整 Key 只在 localgw_keys_create 的响应里出现一次（后端回 rawKey），列表只有 keyPrefix。
     旧版「列表可随时查看 / 复制完整 Key」的按钮与「查看完整 Key」弹窗一律不做——
     那是靠 DPAPI 解密存库实现的，新版没有这条链路，硬做一个只能靠编造数据。 -->
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

/** 列表：有效在前、已吊销在后（吊销是不可逆终态，堆在后面不干扰日常查看） */
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
  // 刻意不清 localErr：批量吊销中断的说明就写在 localErr 里，
  // 而 doBatchRevoke 的 finally 会调 refresh，清了等于刚报错就被自己擦掉
  await lgw.refreshKeys();
  // 列表变化后剔除已不存在的选中项，避免选中计数与实际行数不符
  const alive = new Set(rows.value.map((k) => k.id));
  selectedIds.value = new Set([...selectedIds.value].filter((id) => alive.has(id)));
}

// ===== 剪贴板：返回是否成功 —— 「复制并关闭」必须据此决定关不关，
//       否则复制失败时弹窗一关，这个只显示一次的 Key 就永久丢了 =====
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
      // 完整 Key 只在这一刻存在：立刻进「已生成」弹窗，关掉就再也拿不到了
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

// ===== Key 已生成弹窗（只显示一次） =====
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

// ===== 列表行内复制前缀（完整 Key 已不可得，这里只复制前缀并说明） =====
const copiedId = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyPrefix(k: LocalgwKeyRow) {
  const ok = await copyText(k.keyPrefix || "");
  if (!ok) return;
  copiedId.value = k.id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copiedId.value = ""), 1500);
}

// ===== 改名弹窗 =====
const renameOpen = ref(false);
const renameRow = ref<LocalgwKeyRow | null>(null);
const renameName = ref("");
const renaming = ref(false);
function openRename(k: LocalgwKeyRow) {
  formErr.value = "";
  renameRow.value = k;
  renameName.value = k.name || "";
  renameOpen.value = true;
}
async function doRename() {
  if (!renameRow.value || renaming.value) return;
  const name = renameName.value.trim();
  if (!name) {
    formErr.value = "名称不能为空";
    return;
  }
  renaming.value = true;
  try {
    const ok = await lgw.renameKey(renameRow.value.id, name);
    if (ok) renameOpen.value = false;
    else formErr.value = lgw.lastError || "重命名失败";
  } finally {
    renaming.value = false;
  }
}

// ===== 吊销确认（单条）=====
const revokeOpen = ref(false);
const revokeRow = ref<LocalgwKeyRow | null>(null);
function openRevoke(k: LocalgwKeyRow) {
  formErr.value = "";
  revokeRow.value = k;
  revokeOpen.value = true;
}
async function doRevoke() {
  if (!revokeRow.value) return;
  const ok = await lgw.revokeKey(revokeRow.value.id);
  if (ok) revokeOpen.value = false;
  else formErr.value = lgw.lastError || "吊销失败";
  await refresh();
}

// ===== 列表多选 / 全选 + 批量吊销 =====
const selectedIds = ref<Set<string>>(new Set());
const batchOpen = ref(false);
const batchBusy = ref(false);
const selectedCount = computed(() => rows.value.filter((k) => selectedIds.value.has(k.id)).length);
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((k) => selectedIds.value.has(k.id)));
/** 批量只处理「有效」的 Key：已吊销的是终态，重复吊销没有意义（后端也会当成非法 id） */
const selectedActive = computed(() => rows.value.filter((k) => selectedIds.value.has(k.id) && k.status === "active"));

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}
function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(rows.value.map((k) => k.id));
}

/** 批量吊销：后端只有单条 localgw_keys_revoke，这里逐条串行走——
 *  串行是有意的：任一条失败就停在中途并说明已处理几条，用户能对上账 */
async function doBatchRevoke() {
  if (batchBusy.value) return;
  const ids = selectedActive.value.map((k) => k.id);
  if (!ids.length) {
    batchOpen.value = false;
    localErr.value = "选中的 Key 里没有可吊销的（已吊销的无需重复操作）";
    return;
  }
  batchBusy.value = true;
  let done = 0;
  try {
    for (const id of ids) {
      const ok = await lgw.revokeKey(id);
      if (!ok) {
        localErr.value = `批量吊销中断：${lgw.lastError || "吊销失败"}（已成功 ${done} / ${ids.length} 个）`;
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

      <!-- 工具栏（页头已去标题化，「生成 Key」贴在正文顶部右侧；多选后左侧出现批量吊销） -->
      <div class="toolbar">
        <button v-if="selectedCount" class="btn danger" :disabled="batchBusy" @click="batchOpen = true">
          批量吊销（{{ selectedCount }}）
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
                <!-- 列集照旧版 9 列裁到 6 列：旧版的「今日请求 / 今日 Token / 每日配额」在
                     LocalgwKeyRow 里没有对应字段（只有累计口径），按「删列不填假数据」处理；
                     累计请求 / 累计 Token / 到期日 都降级到名称格下的副行，不再单开列 -->
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
                <td class="mono">{{ k.keyPrefix || "—" }}…</td>
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
                    {{ k.status === "active" ? "启用" : "已吊销" }}
                  </span>
                </td>
                <td>
                  <button class="btn-link btn-sm" @click="copyPrefix(k)">
                    {{ copiedId === k.id ? "已复制" : "复制前缀" }}
                  </button>
                  <button class="btn-link btn-sm" @click="openRename(k)">改名</button>
                  <button v-if="k.status === 'active'" class="btn-link btn-sm danger" @click="openRevoke(k)">吊销</button>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" class="empty-cell">
                  还没有 Key —— 点上方「生成 Key」；完整 Key 只在生成时显示一次，请立刻复制保存
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">安全提示</div>
        <div class="code">
          鉴权比对只用 SHA-256 哈希 · 完整 Key 只在创建响应里出现一次（列表只存前缀，之后无法再查看 / 复制）·
          吊销即时生效（鉴权实时查库）
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

      <!-- Key 已生成：只显示这一次；关掉后列表只有前缀，无法再查看 -->
      <div v-if="justCreated" class="p-mask" @click.self="justCreated = null">
        <div class="p-dlg glass">
          <div class="p-title">Key 已生成</div>
          <div class="set-desc" style="margin-bottom: 10px">
            这是「{{ justCreated.name }}」的完整 Key，<b>只显示这一次</b>：列表里只存前缀，关闭后无法再次查看。
            请立刻复制并保存到安全的地方。
          </div>
          <div class="code secret-box">{{ justCreated.rawKey }}</div>
          <div v-if="copyFailed" class="set-desc err-text" style="margin-top: 6px">
            复制失败（当前环境不允许访问剪贴板）—— 请手动选中上面的文本复制。
          </div>
          <div class="p-actions">
            <button class="btn" @click="copySecret">{{ secretCopied ? "已复制" : "复制" }}</button>
            <button class="btn btn-primary" @click="justCreated = null">我已保存</button>
          </div>
        </div>
      </div>

      <!-- 改名弹窗 -->
      <div v-if="renameOpen" class="p-mask" @click.self="renameOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">重命名 Key</div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">名称</div>
              <div class="set-desc">{{ renameRow?.keyPrefix }}…</div>
            </div>
            <input v-model="renameName" class="input" style="width: 180px" @keyup.enter="doRename" />
          </div>
          <div v-if="formErr" class="set-desc err-text" style="margin-top: 6px">{{ formErr }}</div>
          <div class="p-actions">
            <button class="btn" @click="renameOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="renaming" @click="doRename">{{ renaming ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>

      <!-- 吊销确认（旧版就是自研弹窗，不用 ElMessageBox） -->
      <div v-if="revokeOpen" class="p-mask" @click.self="revokeOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">吊销 Key</div>
          <div class="set-desc">
            确定吊销「{{ revokeRow?.name || "未命名" }}」（{{ revokeRow?.keyPrefix }}…）？
            吊销立即生效且不可恢复，使用该 Key 的客户端会返回 401。
          </div>
          <div v-if="formErr" class="set-desc err-text" style="margin-top: 6px">{{ formErr }}</div>
          <div class="p-actions">
            <button class="btn" @click="revokeOpen = false">取消</button>
            <button class="btn danger-solid" @click="doRevoke">吊销</button>
          </div>
        </div>
      </div>

      <!-- 批量吊销确认（列表多选后出现） -->
      <div v-if="batchOpen" class="p-mask" @click.self="batchOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">批量吊销 Key</div>
          <div class="set-desc">
            确定吊销选中的 {{ selectedCount }} 个 Key（其中可吊销的有效 Key {{ selectedActive.length }} 个）？
            吊销立即生效且不可恢复，使用这些 Key 的客户端会返回 401。
          </div>
          <div class="p-actions">
            <button class="btn" @click="batchOpen = false">取消</button>
            <button class="btn danger-solid" :disabled="batchBusy" @click="doBatchRevoke">
              {{ batchBusy ? "吊销中…" : "吊销" }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：「生成 Key」工具栏靠右贴在正文顶部（照搬 ProxyKeysView 的 <style scoped>） */
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
</style>
