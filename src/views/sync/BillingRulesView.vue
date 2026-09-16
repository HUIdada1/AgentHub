<script setup lang="ts">
import { onMounted, ref, reactive, computed, watch } from "vue";
import { useSyncStore } from "../../stores/sync";
import { formatToken, formatInteger, formatDateTime } from "../../composables/useFormat";
import * as api from "../../api/sync";
import type { PriceRow, PriceEntry, UnpricedModel, ImportPreview, ImportPreviewItem, RemotePricingConfig } from "../../types/sync";

const app = useSyncStore();

// ===== 远程价格源（来源 remote：自动拉取，优先级 手动 > 远程 > 内置） =====
const remotePulling = ref(false);
const remoteStatus = ref<(RemotePricingConfig & { lastAt: number | null; lastHash: string | null; lastModels: number | null }) | null>(null);
const remoteMsg = ref<{ ok: boolean; text: string } | null>(null);

async function loadRemoteStatus() {
  try {
    remoteStatus.value = await api.getRemotePricingStatus();
  } catch {
    remoteStatus.value = null;
  }
}
async function saveRemoteField() {
  const r = await app.save();
  if (!r.ok) flash(r);
}
function toggleRemotePricing() {
  app.config.billing.remotePricing.enabled = !app.config.billing.remotePricing.enabled;
  saveRemoteField();
}
async function pullRemoteNow() {
  remotePulling.value = true;
  remoteMsg.value = null;
  try {
    // 立即拉取强制跳过哈希短路（确保拿到远端最新）
    const r = await api.pullRemotePricing(true);
    remoteMsg.value = { ok: !!r.ok, text: r.message };
    if (r.ok) await Promise.all([loadPrices(), loadRemoteStatus()]);
  } catch (e) {
    remoteMsg.value = { ok: false, text: e instanceof Error ? e.message : "拉取失败" };
  } finally {
    remotePulling.value = false;
  }
}
const sourceLabel: Record<string, string> = { manual: "手动", remote: "远程", builtin: "内置" };

// ===== 价格表 =====
const prices = ref<PriceRow[]>([]);
const loading = ref(true);
const actionResult = ref<{ ok: boolean; message: string } | null>(null);

function flash(r: { ok: boolean; message: string }) {
  actionResult.value = r;
  window.setTimeout(() => { actionResult.value = null; }, 3600);
}

async function loadPrices() {
  loading.value = true;
  try {
    prices.value = await api.getPrices();
  } finally {
    loading.value = false;
  }
}

const pricedCount = computed(() => prices.value.filter((p) => p.active).length);

// ===== 计费设置（改动即时落盘，与设置页开关行为一致） =====
async function autoSave() {
  const r = await app.save();
  if (!r.ok) flash(r);
}
function toggleEnabled() {
  app.config.billing.enabled = !app.config.billing.enabled;
  // 关闭时若正停留在费用页，随入口一起隐藏，避免留下无导航入口的孤儿页面
  if (!app.config.billing.enabled && app.activePage === "costs") app.setPage("billing");
  autoSave();
}
function setCurrency(cur: "CNY" | "USD") {
  app.config.billing.displayCurrency = cur;
  autoSave();
}
function onRateBlur() {
  const rate = Number(app.config.billing.usdToCny);
  if (!isFinite(rate) || rate <= 0) app.config.billing.usdToCny = 7.2;
  autoSave();
}

// ===== 改价弹层 =====
const editModal = reactive({
  show: false,
  isNew: false,
  providerId: null as string | null,
  form: { modelId: "", inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, currency: "CNY" as "CNY" | "USD", effectiveFrom: "" },
});

function todayStr() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateToStr(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openEdit(p: PriceRow) {
  editModal.isNew = false;
  editModal.providerId = p.providerId;
  editModal.form = {
    modelId: p.modelId,
    inputPerM: p.inputPerM,
    outputPerM: p.outputPerM,
    cacheReadPerM: p.cacheReadPerM,
    cacheWritePerM: p.cacheWritePerM,
    currency: p.currency,
    effectiveFrom: todayStr(),
  };
  editModal.show = true;
}
function openCreate() {
  editModal.isNew = true;
  editModal.providerId = null;
  editModal.form = { modelId: "", inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, currency: app.config.billing?.displayCurrency || "CNY", effectiveFrom: todayStr() };
  editModal.show = true;
}
function dateToMs(s: string) {
  // 日期选择器给本地时区当日零点，与记录 started_at 的本地时间口径一致
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.now();
}
/** 生效时间展示：0（内置默认种子）表示自最早记录起，避免显示 1970 时间戳 */
function effLabel(ms: number) {
  return ms > 0 ? formatDateTime(ms) + " 起" : "全部历史";
}

async function submitEdit() {
  if (!editModal.form.modelId.trim()) {
    flash({ ok: false, message: "模型 ID 不能为空" });
    return;
  }
  const r = await api.savePrice({
    providerId: editModal.providerId,
    modelId: editModal.form.modelId.trim(),
    inputPerM: Number(editModal.form.inputPerM) || 0,
    outputPerM: Number(editModal.form.outputPerM) || 0,
    cacheReadPerM: Number(editModal.form.cacheReadPerM) || 0,
    cacheWritePerM: Number(editModal.form.cacheWritePerM) || 0,
    currency: editModal.form.currency,
    effectiveFrom: dateToMs(editModal.form.effectiveFrom),
  });
  flash(r);
  if (r.ok) {
    editModal.show = false;
    await loadPrices();
    await loadUnpriced();
  }
}

// ===== 价格版本历史 =====
const historyModal = reactive({ show: false, modelId: "", providerId: null as string | null, versions: [] as PriceEntry[] });
async function openHistory(p: PriceRow) {
  historyModal.modelId = p.modelId;
  historyModal.providerId = p.providerId;
  historyModal.versions = await api.getPriceVersions(p.providerId, p.modelId);
  historyModal.show = true;
}

async function removeModel(p: PriceRow) {
  if (!window.confirm(`确定删除「${p.modelId}」的全部 ${p.versions} 个价格版本吗？\n\n删除后相关记录费用按未配置处理（计 0 并提示）。`)) return;
  const r = await api.deleteModelPrices(p.providerId, p.modelId);
  flash(r);
  if (r.ok) await loadPrices();
}

// ===== 未配置模型（从用量生成草稿） =====
const unpriced = ref<UnpricedModel[]>([]);
const draftRows = reactive<Record<string, { inputPerM: number; outputPerM: number; cacheReadPerM: number; currency: "CNY" | "USD"; effectiveFrom: string }>>({});

async function loadUnpriced() {
  unpriced.value = await api.getUnpricedModels();
  for (const u of unpriced.value) {
    const key = `${u.providerId}|${u.modelId}`;
    if (!draftRows[key]) {
      draftRows[key] = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, currency: app.config.billing?.displayCurrency || "CNY", effectiveFrom: dateToStr(u.firstSeen) };
    }
  }
}
const draftKey = (u: UnpricedModel) => `${u.providerId}|${u.modelId}`;

async function saveDraft(u: UnpricedModel) {
  const d = draftRows[draftKey(u)];
  const r = await api.savePrice({
    providerId: null,
    modelId: u.modelId,
    inputPerM: Number(d.inputPerM) || 0,
    outputPerM: Number(d.outputPerM) || 0,
    cacheReadPerM: Number(d.cacheReadPerM) || 0,
    cacheWritePerM: 0,
    currency: d.currency,
    effectiveFrom: dateToMs(d.effectiveFrom),
  });
  flash(r);
  if (r.ok) {
    delete draftRows[draftKey(u)];
    await Promise.all([loadPrices(), loadUnpriced()]);
  }
}

// ===== 价格源导入 =====
const importModal = reactive({
  show: false,
  source: "litellm" as "litellm" | "openrouter",
  loading: false,
  error: "",
  preview: null as ImportPreview | null,
  checked: new Set<string>(),
  effectiveFrom: todayStr(),
});

function itemKey(it: ImportPreviewItem) {
  return `${it.providerId || ""}|${it.modelId}`;
}
const checkedItems = computed(() => {
  const all = [...(importModal.preview?.additions || []), ...(importModal.preview?.changes || [])];
  return all.filter((it) => importModal.checked.has(itemKey(it)));
});

function openImport() {
  importModal.show = true;
  importModal.preview = null;
  importModal.error = "";
  importModal.checked = new Set();
  importModal.effectiveFrom = todayStr();
  pullPreview();
}
async function pullPreview() {
  importModal.loading = true;
  importModal.error = "";
  try {
    const r = await api.importPricesPreview(importModal.source);
    if (r.ok) {
      importModal.preview = r;
      importModal.checked = new Set([...r.additions, ...r.changes].map(itemKey));
    } else {
      importModal.error = r.message || "拉取失败";
    }
  } catch (e) {
    importModal.error = e instanceof Error ? e.message : "拉取失败";
  } finally {
    importModal.loading = false;
  }
}
function toggleCheck(key: string) {
  const next = new Set(importModal.checked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  importModal.checked = next;
}
async function applyImport() {
  if (!checkedItems.value.length) return;
  const r = await api.importPricesApply(checkedItems.value, dateToMs(importModal.effectiveFrom));
  flash(r);
  if (r.ok) {
    importModal.show = false;
    await Promise.all([loadPrices(), loadUnpriced()]);
  }
}

onMounted(async () => {
  await Promise.all([loadPrices(), loadUnpriced(), loadRemoteStatus()]);
});

// 视图常驻：同步结束（他机价格表合并 / 远程价格源顺带拉取）或切回本页时刷新
let wasRunning = app.sync.running;
watch(() => app.sync.running, (now) => {
  if (wasRunning && !now) { loadPrices(); loadUnpriced(); loadRemoteStatus(); }
  wasRunning = now;
});
watch(() => app.activePage, (p) => {
  if (p === "billing") { loadPrices(); loadUnpriced(); loadRemoteStatus(); }
});
</script>

<template>
  <div class="sync-page">
    <div v-if="actionResult" class="save-line" :class="{ ok: actionResult.ok }">{{ actionResult.message }}</div>

    <!-- 计费设置 + 远程价格源（左右分栏） -->
    <div class="card">
      <div class="billing-setup">
        <!-- 左：计费开关与基础设置 -->
        <div class="bs-col">
          <div class="rule-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/></svg>
            计费设置
          </div>
          <div class="switch-row">
            <div class="s-left">
              <div class="s-title">启用费用统计</div>
              <div class="s-desc">关闭后隐藏「费用」页与所有费用元素，记录与同步不受影响</div>
            </div>
            <div class="switch" :class="{ on: app.config.billing?.enabled }" role="switch" :aria-checked="!!app.config.billing?.enabled" @click="toggleEnabled"></div>
          </div>
          <div class="form-grid billing-form">
            <div class="form-field">
              <label>显示币种</label>
              <div class="tabs">
                <button class="tab" :class="{ active: app.config.billing?.displayCurrency === 'CNY' }" @click="setCurrency('CNY')">CNY 人民币</button>
                <button class="tab" :class="{ active: app.config.billing?.displayCurrency === 'USD' }" @click="setCurrency('USD')">USD 美元</button>
              </div>
            </div>
            <div class="form-field">
              <label>USD → CNY 汇率</label>
              <input class="f-input mono" type="number" step="0.01" min="0" v-model="app.config.billing.usdToCny" @blur="onRateBlur" />
            </div>
            <div class="form-field full">
              <label>导入代理（可选，留空直连）</label>
              <input class="f-input mono" v-model="app.config.billing.importProxy" placeholder="http://127.0.0.1:7897" @blur="autoSave" />
            </div>
          </div>
          <div class="bs-note">汇率修改后，全部历史费用按新汇率即时重算 · jsdelivr 镜像无代理时也可直连</div>
        </div>

        <!-- 右：远程价格源（来源 remote：手动 > 远程 > 内置） -->
        <div class="bs-col">
          <div class="rule-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
            远程价格源
          </div>
          <div class="switch-row">
            <div class="s-left">
              <div class="s-title">自动拉取远程价格</div>
              <div class="s-desc">按间隔随数据同步自动拉取，价格来源标记为「远程」；优先级：手动 &gt; 远程 &gt; 内置</div>
            </div>
            <div class="switch" :class="{ on: app.config.billing?.remotePricing?.enabled }" role="switch" :aria-checked="!!app.config.billing?.remotePricing?.enabled" @click="toggleRemotePricing"></div>
          </div>
          <div class="form-grid billing-form">
            <div class="form-field full">
              <label>价格表网址（LiteLLM 兼容格式）</label>
              <input class="f-input mono" v-model="app.config.billing.remotePricing.url" placeholder="https://…/model_prices_and_context_window.json" @blur="saveRemoteField" />
            </div>
            <div class="form-field">
              <label>哈希校验网址（可选，远程无变化时短路由）</label>
              <input class="f-input mono" v-model="app.config.billing.remotePricing.hashUrl" placeholder="https://…/model_prices_and_context_window.sha256" @blur="saveRemoteField" />
            </div>
            <div class="form-field">
              <label>检查间隔（小时）</label>
              <input class="f-input mono" type="number" min="1" step="1" v-model.number="app.config.billing.remotePricing.intervalHours" @blur="saveRemoteField" />
            </div>
          </div>
          <div class="switch-row">
            <div class="s-left">
              <div class="s-desc">
                <template v-if="remoteStatus?.lastAt">上次拉取 {{ formatDateTime(remoteStatus.lastAt) }} · 命中 {{ remoteStatus.lastModels }} 个本地模型<span v-if="remoteMsg"> · </span></template>
                <template v-else>尚未拉取过<span v-if="remoteMsg"> · </span></template>
                <span v-if="remoteMsg" :style="{ color: remoteMsg.ok ? 'var(--ok)' : 'var(--err)' }">{{ remoteMsg.text }}</span>
              </div>
            </div>
            <button class="btn-outline" :disabled="remotePulling" @click="pullRemoteNow">{{ remotePulling ? "拉取中…" : "立即拉取" }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 模型价格表 -->
    <div class="card">
      <div class="card-head">
        <h2>模型价格</h2>
        <span class="hint">{{ pricedCount }} 个模型已配置 · {{ unpriced.length }} 个未配置 · 单价单位：元（$）/ 百万 token</span>
        <div class="right">
          <button class="btn-outline" @click="openImport">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>
            从价格源导入
          </button>
          <button class="btn-outline" @click="openCreate">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            新增模型
          </button>
        </div>
      </div>
      <div v-if="loading" class="skeleton sk-chart" style="height: 200px; margin-bottom: 0"></div>
      <div v-else class="table-scroll">
        <table class="table">
          <thead><tr>
            <th>模型</th><th>供应商</th>
            <th class="num">输入 /M</th><th class="num">输出 /M</th><th class="num">缓存读 /M</th><th class="num">缓存写 /M</th>
            <th>币种</th><th>来源</th><th>现行版本</th><th class="op-cell">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="p in prices" :key="p.id" :class="{ 'tr-unpriced': !p.active }">
              <td class="mono">{{ p.modelId }}</td>
              <td>{{ p.providerId || "不限" }}</td>
              <td class="num mono">{{ p.inputPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.outputPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.cacheReadPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.cacheWritePerM.toFixed(2) }}</td>
              <td><span class="pill" :class="p.currency === 'USD' ? 'ok' : 'blue'">{{ p.currency }}</span></td>
              <td><span class="pill" :class="p.source === 'manual' ? 'blue' : p.source === 'remote' ? 'ok' : 'src-builtin'">{{ sourceLabel[p.source] || p.source }}</span></td>
              <td class="ver">
                <template v-if="p.active"><b>{{ effLabel(p.effectiveFrom) }}</b> · {{ p.versions > 1 ? `${p.versions} 个历史版本` : "无历史" }}</template>
                <template v-else><span class="pill warn">待生效 · {{ effLabel(p.effectiveFrom) }}</span></template>
              </td>
              <td class="op-cell">
                <button class="btn-link" @click="openEdit(p)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                  改价
                </button>
                <button class="btn-link" @click="openHistory(p)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                  历史
                </button>
                <button class="btn-link danger" @click="removeModel(p)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!prices.length">
              <td colspan="10" style="text-align: center; color: var(--text-3); padding: 24px 0">
                还没有任何价格，点击「从价格源导入」或「新增模型」开始配置
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 未配置模型（从用量生成草稿） -->
    <div class="card" v-if="unpriced.length">
      <div class="card-head">
        <h2>未配置价格的模型</h2>
        <span class="hint">来自本机真实用量 · 填写后保存即计价（生效日期默认该模型最早记录日，历史一并计入）</span>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead><tr>
            <th>模型</th><th>供应商</th><th class="num">记录</th><th class="num">Token</th>
            <th>输入 /M</th><th>输出 /M</th><th>缓存读 /M</th><th>币种</th><th>生效日期</th><th class="op-cell">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="u in unpriced" :key="draftKey(u)" class="tr-unpriced">
              <td class="mono">{{ u.modelId }}</td>
              <td>{{ u.providerId }}</td>
              <td class="num mono">{{ formatInteger(u.records) }}</td>
              <td class="num mono">{{ formatToken(u.tokens) }}</td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].inputPerM" /></td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].outputPerM" /></td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].cacheReadPerM" /></td>
              <td>
                <select class="f-select mini-input" v-model="draftRows[draftKey(u)].currency">
                  <option value="CNY">CNY</option><option value="USD">USD</option>
                </select>
              </td>
              <td><input class="f-input mini-input" type="date" v-model="draftRows[draftKey(u)].effectiveFrom" /></td>
              <td class="op-cell"><button class="btn-outline sm" @click="saveDraft(u)">保存</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 计费口径 -->
    <div class="card footnote-card">
      <div class="formula-line">
        单条记录费用 = <code>净输入 × 输入价</code> + <code>缓存命中 × 缓存读价</code> + <code>缓存写入 × 缓存写价</code> + <code>(输出 + 推理) × 输出价</code>
        <span class="muted">（净输入 = 输入 − 缓存命中；单价按记录发生时刻生效的版本）</span>
      </div>
      <div class="caliper-grid">
        <div class="cal-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div><b>价格匹配</b>：供应商精确匹配优先，其次仅按模型通配；同一模型跨软件源共用一份价格。</div>
        </div>
        <div class="cal-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div><b>失败/取消记录</b>照常计费（有 token 即为实际消耗），0 token 记录天然为 0。</div>
        </div>
        <div class="cal-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div><b>Antigravity 系</b>（配额百分比点，非 token）不参与计费。</div>
        </div>
        <div class="cal-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div><b>多设备同步</b>：价格表整份经 WebDAV 共享，每次同步自动对齐（后修改的一方生效）。</div>
        </div>
      </div>
    </div>

    <!-- 改价 / 新增 弹层。Teleport 到 body 后就没有 .sync-scope 祖先了，
         而 .overlay / .modal 的定位与显隐全部写在 sync.css 的 .sync-scope 作用域下，
         漏掉这个类不只是"不好看"：.modal 会退回 static，变成一个常驻 body 文档流里的普通块，
         给整个文档凭空加几百像素高度，外壳从此可被滚动/推走。三个 Teleport 都要带上它 -->
    <Teleport to="body">
      <div class="overlay sync-scope" :class="{ show: editModal.show }" @click="editModal.show = false"></div>
      <div class="modal price-modal sync-scope" :class="{ show: editModal.show }">
        <div class="m-head">
          <h3>{{ editModal.isNew ? "新增模型价格" : "修改价格" }}
            <span class="m-sub mono">{{ editModal.form.modelId }}</span>
          </h3>
          <button class="d-close" @click="editModal.show = false">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="m-body">
          <div class="form-grid" style="grid-template-columns: 1fr 1fr">
            <div class="form-field" v-if="editModal.isNew" style="grid-column: 1 / -1">
              <label>模型 ID（与用量记录中的模型名一致）</label>
              <input class="f-input mono" v-model="editModal.form.modelId" placeholder="如 glm-5.3" />
            </div>
            <div class="form-field">
              <label>输入 /M</label><input class="f-input mono" type="number" step="0.01" min="0" v-model="editModal.form.inputPerM" />
            </div>
            <div class="form-field">
              <label>输出 /M</label><input class="f-input mono" type="number" step="0.01" min="0" v-model="editModal.form.outputPerM" />
            </div>
            <div class="form-field">
              <label>缓存读 /M</label><input class="f-input mono" type="number" step="0.01" min="0" v-model="editModal.form.cacheReadPerM" />
            </div>
            <div class="form-field">
              <label>缓存写 /M</label><input class="f-input mono" type="number" step="0.01" min="0" v-model="editModal.form.cacheWritePerM" />
            </div>
            <div class="form-field">
              <label>币种</label>
              <select class="f-select" v-model="editModal.form.currency"><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option></select>
            </div>
            <div class="form-field">
              <label>生效日期（默认今天，可改到过去补录历史价）</label>
              <input class="f-input" type="date" v-model="editModal.form.effectiveFrom" />
            </div>
          </div>
          <p class="m-hint">保存后关闭现行价格段并生成新版本，旧版本永久保留；全部历史费用按新版本自动重算。</p>
          <div class="modal-actions">
            <button class="btn-outline" @click="editModal.show = false">取消</button>
            <button class="btn btn-cta" @click="submitEdit">保存新版本</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 价格历史抽屉 -->
    <Teleport to="body">
      <div class="overlay sync-scope" :class="{ show: historyModal.show }" @click="historyModal.show = false"></div>
      <div class="drawer-panel" :class="{ show: historyModal.show }">
        <div class="m-head">
          <h3>价格历史 <span class="m-sub mono">{{ historyModal.modelId }}</span></h3>
          <button class="d-close" @click="historyModal.show = false">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <ul class="version-timeline">
          <li v-for="(v, i) in historyModal.versions" :key="v.id" :class="{ now: i === 0 }">
            <div class="vt-time">
              <b>{{ effLabel(v.effectiveFrom) }}</b>
              {{ v.effectiveTo ? "至 " + formatDateTime(v.effectiveTo) : "· 至今" }}
              <span class="pill" :class="i === 0 ? 'blue' : ''" v-if="i === 0">现行</span>
              <span class="pill" :class="v.source === 'manual' ? 'blue' : v.source === 'remote' ? 'ok' : 'src-builtin'" style="margin-left: 4px">{{ sourceLabel[v.source] || v.source }}</span>
              <span v-if="v.currency === 'USD'" class="pill ok" style="margin-left: 4px">USD</span>
            </div>
            <div class="vt-price mono">输入 {{ v.inputPerM.toFixed(2) }} · 输出 {{ v.outputPerM.toFixed(2) }} · 缓存读 {{ v.cacheReadPerM.toFixed(2) }}</div>
            <div class="vt-by">由 {{ v.updatedBy || "未知设备" }} 于 {{ formatDateTime(v.updatedAt) }} 设置</div>
          </li>
          <li v-if="!historyModal.versions.length" style="border: none; color: var(--text-3)">暂无版本记录</li>
        </ul>
      </div>
    </Teleport>

    <!-- 导入面板 -->
    <Teleport to="body">
      <div class="overlay sync-scope" :class="{ show: importModal.show }" @click="importModal.show = false"></div>
      <div class="modal price-modal sync-scope" :class="{ show: importModal.show }">
        <div class="m-head">
          <h3>从价格源导入 <span class="m-sub">{{ importModal.preview?.sourceName || "" }}</span></h3>
          <button class="d-close" @click="importModal.show = false">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="m-body">
          <div class="import-toolbar">
            <div class="tabs">
              <button class="tab" :class="{ active: importModal.source === 'litellm' }" @click="importModal.source = 'litellm'">LiteLLM</button>
              <button class="tab" :class="{ active: importModal.source === 'openrouter' }" @click="importModal.source = 'openrouter'">OpenRouter</button>
            </div>
            <button class="btn-outline" :disabled="importModal.loading" @click="pullPreview">{{ importModal.loading ? "拉取中…" : "重新拉取" }}</button>
          </div>
          <div v-if="importModal.loading" class="skeleton sk-chart" style="height: 140px; margin-bottom: 0"></div>
          <template v-else-if="importModal.error">
            <p class="m-hint" style="color: var(--err)">拉取失败：{{ importModal.error }}。可在上方设置导入代理后重试。</p>
          </template>
          <template v-else-if="importModal.preview">
            <div class="imp-list">
              <label v-for="it in importModal.preview.additions" :key="'a' + itemKey(it)" class="imp-row">
                <input type="checkbox" :checked="importModal.checked.has(itemKey(it))" @change="toggleCheck(itemKey(it))" />
                <span class="ic add">+</span>
                <span class="m mono">{{ it.modelId }}</span>
                <span class="d">新增 {{ it.currency }} {{ it.inputPerM.toFixed(2) }} / {{ it.outputPerM.toFixed(2) }} · 缓存读 {{ it.cacheReadPerM.toFixed(2) }}</span>
              </label>
              <label v-for="it in importModal.preview.changes" :key="'c' + itemKey(it)" class="imp-row">
                <input type="checkbox" :checked="importModal.checked.has(itemKey(it))" @change="toggleCheck(itemKey(it))" />
                <span class="ic chg">↻</span>
                <span class="m mono">{{ it.modelId }}</span>
                <span class="d">
                  变更 {{ it.prev!.currency }} {{ it.prev!.inputPerM.toFixed(2) }}/{{ it.prev!.outputPerM.toFixed(2) }}
                  → {{ it.currency }} {{ it.inputPerM.toFixed(2) }}/{{ it.outputPerM.toFixed(2) }}
                  <b v-if="it.prev!.currency !== it.currency" style="color: var(--warn)">（币种变化）</b>
                </span>
              </label>
              <div v-for="mi in importModal.preview.missing" :key="'m' + mi.modelId" class="imp-row">
                <span class="ic miss">✕</span>
                <span class="m mono">{{ mi.modelId }}</span>
                <span class="d">未收录，请手动填写</span>
              </div>
            </div>
            <p v-if="!importModal.preview.additions.length && !importModal.preview.changes.length && !importModal.preview.missing.length" class="m-hint">
              本机用量中的模型在 {{ importModal.preview.sourceName }} 均无记录。
            </p>
            <div class="form-field" style="max-width: 240px">
              <label>导入价格生效日期</label>
              <input class="f-input" type="date" v-model="importModal.effectiveFrom" />
            </div>
            <p class="m-hint">勾选确认后写入；币种变化（如 CNY → USD）请在确认前留意是否符合该模型的实际计费币种。</p>
          </template>
          <div class="modal-actions">
            <button class="btn-outline" @click="importModal.show = false">关闭</button>
            <button class="btn btn-cta" :disabled="!checkedItems.length" @click="applyImport">确认导入 {{ checkedItems.length }} 项</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.rule-group-title { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 700; margin-bottom: 12px; color: var(--text); }
.rule-group-title svg { width: 16px; height: 16px; color: var(--accent); }

/* 计费设置 + 远程价格源：左右分栏 */
.billing-setup { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 0 32px; }
.bs-col + .bs-col { border-left: 1px solid var(--border); padding-left: 32px; }
.billing-form { padding: 4px 0 2px; }
.bs-note { border-top: 1px solid var(--border); padding-top: 12px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.bs-col .switch-row:last-child { padding-bottom: 0; }
@media (max-width: 1080px) {
  .billing-setup { grid-template-columns: 1fr; gap: 20px 0; }
  .bs-col + .bs-col { border-left: none; padding-left: 0; }
}

/* 表格操作列与行内按钮 */
.op-cell { text-align: right; white-space: nowrap; }
.op-cell .btn-link + .btn-link { margin-left: 2px; }
/* 保存结果提示：标题行已去除，改为卡片上方的独立反馈行 */
.save-line { font-size: 12px; color: var(--err); margin-bottom: 14px; }
.save-line.ok { color: var(--ok); }
.footnote-card { padding: 16px 20px; }

.tr-unpriced td { background: rgba(217, 119, 6, 0.045); }
.tr-unpriced:hover td { background: rgba(217, 119, 6, 0.08); }
.ver { font-size: 11.5px; color: var(--text-3); }
.ver b { color: var(--text-2); font-weight: 600; }
.mini-input { height: 30px; font-size: 12px; padding: 0 8px; width: 90px; }
select.mini-input { width: 76px; }
.pill.src-builtin { color: var(--text-3); background: var(--surface-3); }
.formula-line { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: var(--text-2); margin-bottom: 12px; }
.formula-line code { font-family: "Cascadia Code", Consolas, monospace; font-size: 11.5px; color: var(--accent-strong); background: var(--accent-soft); padding: 1px 6px; border-radius: 5px; margin: 0 1px; }
.formula-line .muted { color: var(--text-3); }
.caliper-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; }
.cal-item { display: flex; gap: 9px; font-size: 12px; color: var(--text-2); line-height: 1.65; padding: 5px 0; }
.cal-item svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 3px; color: var(--accent); }
.cal-item b { color: var(--text); }
.m-sub { font-size: 12px; color: var(--text-3); font-weight: 500; margin-left: 8px; }
.price-modal { width: min(560px, 92vw); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.import-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.imp-list { max-height: 260px; overflow-y: auto; }
.imp-row { display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: 1px dashed var(--border); font-size: 12.5px; cursor: pointer; }
.imp-row:last-child { border-bottom: none; }
.imp-row .ic { width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0; }
.imp-row .ic.add { color: var(--ok); background: rgba(5, 150, 105, 0.12); }
.imp-row .ic.chg { color: var(--accent-strong); background: var(--accent-soft); }
.imp-row .ic.miss { color: var(--err); background: rgba(220, 38, 38, 0.1); }
.imp-row .m { font-weight: 600; color: var(--text); }
.imp-row .d { color: var(--text-3); font-size: 11.5px; margin-left: auto; }
.drawer-panel { position: fixed; top: 0; right: -420px; width: 400px; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); z-index: 60; transition: right .3s cubic-bezier(.16,1,.3,1); padding: 18px 20px; overflow-y: auto; }
.drawer-panel.show { right: 0; }
.drawer-panel .m-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.version-timeline { list-style: none; }
.version-timeline li { position: relative; padding: 0 0 18px 18px; border-left: 2px solid var(--border-strong); margin-left: 6px; }
.version-timeline li.now { border-left-color: var(--accent); }
.version-timeline li::before { content: ""; position: absolute; left: -6px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--surface); border: 2px solid var(--text-3); }
.version-timeline li.now::before { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 8px var(--accent-soft-2); }
.vt-time { font-size: 12px; color: var(--text-3); }
.vt-time b { color: var(--text); }
.vt-price { font-size: 12.5px; font-weight: 600; color: var(--text); margin-top: 3px; }
.vt-by { font-size: 11px; color: var(--text-3); margin-top: 2px; }
</style>
