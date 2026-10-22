<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
import { onMounted, ref, reactive, computed, watch } from "vue";
import { useSyncStore } from "../../stores/sync";
import { formatToken, formatInteger, formatDateTime } from "../../composables/useFormat";
import { toast as ElMessage } from "../../utils/toast";
import * as api from "../../api/sync";
import type { PriceRow, PriceEntry, UnpricedModel, ImportPreview, ImportPreviewItem, RemotePricingConfig, ModelAlias, NewApiPricingStatus, NewApiPreview, NewApiPreviewItem } from "../../types/sync";

const app = useSyncStore();

// ===== 在线定价源（来源 newapi：手动 > 在线定价 > 远程 > 内置）=====
// 链接内置在代码里（与后端 NEWAPI_PRESET_SOURCES 一致），界面只读展示——不需要用户填任何地址
const PRESET_LINKS = [
  {
    id: "official",
    name: "官方倍率预设",
    host: "basellm.github.io",
    url: "https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json",
  },
  {
    id: "modelsdev",
    name: "models.dev 预设",
    host: "models.dev",
    url: "https://models.dev/api.json",
  },
];

const naPulling = ref(false);
const naStatus = ref<NewApiPricingStatus | null>(null);
const naMsg = ref<{ ok: boolean; text: string } | null>(null);

/** 两个内置链接的展示行：上次拉取有记录就带上命中数/失败原因，没有就显示待拉取 */
const presetRows = computed(() => {
  const sources = naStatus.value?.sources || [];
  return PRESET_LINKS.map((link) => {
    const hit = sources.find((s) => s.id === link.id);
    return {
      ...link,
      state: !hit ? "idle" : hit.ok ? "ok" : "err",
      count: !hit ? "待拉取" : hit.ok ? `${formatInteger(hit.models)} 个模型` : "拉取失败",
      // 只提示预设名与域名，不外露底层链接
      tip: hit && !hit.ok ? hit.error : `${link.name} · ${link.host}`,
    };
  });
});

async function loadNaStatus() {
  try {
    naStatus.value = await api.getNewApiPricingStatus();
  } catch {
    naStatus.value = null;
  }
}
async function saveNaField() {
  const r = await app.save();
  if (!r.ok) flash(r);
}
function toggleNewApi() {
  app.config.billing.newApi.enabled = !app.config.billing.newApi.enabled;
  saveNaField();
}
async function pullNaNow() {
  naPulling.value = true;
  naMsg.value = null;
  try {
    // 立即拉取强制跳过哈希短路（确保拿到两个链接的最新价）
    const r = await api.pullNewApiPricing(true);
    naMsg.value = { ok: !!r.ok, text: r.message };
    if (r.ok) await Promise.all([loadPrices(), loadNaStatus(), loadUnpriced()]);
  } catch (e) {
    naMsg.value = { ok: false, text: e instanceof Error ? e.message : "拉取失败" };
  } finally {
    naPulling.value = false;
  }
}

// 差异预览（只读）：勾选后按在线定价来源写入，没勾的保持原样
const naPreview = reactive({
  show: false,
  loading: false,
  error: "",
  data: null as NewApiPreview | null,
  checked: new Set<string>(),
});
const naCheckedItems = computed(() => {
  const d = naPreview.data;
  if (!d) return [] as NewApiPreviewItem[];
  return [...(d.additions || []), ...(d.changes || [])].filter((it) => naPreview.checked.has(it.modelId));
});
/** 预览里被规则过滤掉的模型总数（按次计费 / 表达式无法解析） */
const naSkippedCount = computed(() => {
  const s = naPreview.data?.skipped;
  if (!s) return 0;
  return (s.request?.length || 0) + (s.invalid?.length || 0);
});
function openNaPreview() {
  naPreview.show = true;
  naPreview.data = null;
  naPreview.error = "";
  naPreview.checked = new Set();
  pullNaPreview();
}
async function pullNaPreview() {
  naPreview.loading = true;
  naPreview.error = "";
  try {
    const r = await api.previewNewApiPricing();
    if (r.ok) {
      naPreview.data = r;
      // 默认只勾「会真正生效」的：被手动价压制的条目勾了也没用，容易让人以为功能失效
      naPreview.checked = new Set(
        [...(r.additions || []), ...(r.changes || [])].filter((it) => it.willApply !== false).map((it) => it.modelId)
      );
    } else {
      naPreview.error = r.message || "拉取失败";
    }
  } catch (e) {
    naPreview.error = e instanceof Error ? e.message : "拉取失败";
  } finally {
    naPreview.loading = false;
  }
}
function toggleNaCheck(id: string) {
  const next = new Set(naPreview.checked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  naPreview.checked = next;
}
async function applyNaPreview() {
  if (!naCheckedItems.value.length) return;
  // checkedItems 来自 reactive 的 preview，元素是响应式 Proxy；Electron IPC 结构化克隆
  // 不支持 Proxy（DataCloneError 且异常静默），必须映射为纯字段普通对象再传（同 applyImport 口径）
  const items = naCheckedItems.value.map((it) => ({
    providerId: null,
    modelId: it.modelId,
    inputPerM: it.inputPerM,
    outputPerM: it.outputPerM,
    cacheReadPerM: it.cacheReadPerM,
    cacheWritePerM: it.cacheWritePerM,
    currency: it.currency,
  }));
  try {
    const r = await api.applyNewApiPricing(items);
    flash(r);
    if (r.ok) {
      naPreview.show = false;
      await Promise.all([loadPrices(), loadUnpriced(), loadNaStatus()]);
    }
  } catch (e) {
    flash({ ok: false, message: e instanceof Error ? e.message : "应用失败，请重试" });
  }
}

// ===== 远程价格源（来源 remote：手动 > 在线定价 > 远程 > 内置） =====
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
const sourceLabel: Record<string, string> = { manual: "手动", newapi: "在线定价", remote: "远程", builtin: "内置" };

/** 来源标签样式：手动=蓝、在线定价=强调、远程=绿、内置=灰 */
function srcPillClass(s: string) {
  return s === "manual" ? "blue" : s === "newapi" ? "src-newapi" : s === "remote" ? "ok" : "src-builtin";
}

/** 价格表里看不见的其它来源（被更高优先级盖住）：如在线定价生效时，远程价仍在表里但不单独出行 */
function hiddenSources(p: PriceRow) {
  return (p.sources || []).filter((s) => s !== p.source);
}

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
  } catch {
    /* 拉取失败保留旧价格表，避免恢复备份/库占用时表格突然清空 */
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

// ===== 模型归并（别名计费）：变体模型名 → 按已配置模型的价格计费 =====
const aliases = ref<ModelAlias[]>([]);

async function loadAliases() {
  aliases.value = await api.listAliases();
}

/** 模型名 → 小写关键字 token（按非字母数字切分）：sn-glm-5-3-flash → [sn, glm, 5, 3, flash] */
function tokenizeModel(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 归并候选（模型级去重）：命中关键字 > 0 的已配置模型按重合度排序在前 */
interface MergeCandidate {
  modelId: string;
  hit: number; // 目标模型关键字被命中的个数
  total: number; // 目标模型关键字总数
  tokens: string[]; // 命中的关键字
  source?: string; // 目标现行价格的来源（手动/远程/内置），下拉里展示供选择参考
  exactOnly?: boolean; // 目标仅有供应商精确价（无通配价）——其它供应商记录归并后按估算价计
}
function mergeCandidates(aliasModelId: string): MergeCandidate[] {
  const src = new Set(tokenizeModel(aliasModelId));
  // 目标价格侧信息：来源（manual 优先展示）+ 是否「仅有」供应商精确价
  const meta = new Map<string, { source?: string; exact: boolean; generic: boolean }>();
  for (const p of prices.value) {
    if (!p.active) continue;
    const m = meta.get(p.modelId) || { exact: false, generic: false };
    if (p.source === "manual" || !m.source) m.source = p.source;
    if (p.providerId) m.exact = true;
    else m.generic = true;
    meta.set(p.modelId, m);
  }
  const hits: MergeCandidate[] = [];
  const missed: string[] = [];
  const seen = new Set<string>();
  for (const p of prices.value) {
    // 排除待归并模型自身：同名价格行不构成归并目标（后端同样拒绝自归并，issue #98），
    // 它的正确出路是把生效日期补到最早记录日（见 activePriceByModel / extendRowPriceBack）
    if (!p.active || p.modelId === aliasModelId || seen.has(p.modelId)) continue;
    seen.add(p.modelId);
    const tokens = [...new Set(tokenizeModel(p.modelId))];
    const hitTokens = tokens.filter((t) => src.has(t));
    const info = meta.get(p.modelId);
    if (hitTokens.length) hits.push({ modelId: p.modelId, hit: hitTokens.length, total: tokens.length, tokens: hitTokens, source: info?.source, exactOnly: !!(info?.exact && !info?.generic) });
    else missed.push(p.modelId);
  }
  // 命中占比高者优先；占比相同取关键字更多的（更精确，如 glm-5.3-flash 优于 glm-5.3）
  hits.sort((a, b) => b.hit / b.total - a.hit / a.total || b.total - a.total || a.modelId.localeCompare(b.modelId));
  return [...hits, ...missed.sort().map((m) => ({ modelId: m, hit: 0, total: 0, tokens: [] as string[], source: meta.get(m)?.source, exactOnly: !!(meta.get(m)?.exact && !meta.get(m)?.generic) }))];
}

/** 价格表里的同名现行行（按 modelId 取首个：通配组在前、来源优先级已由 listCurrentPrices 排好）。
 *  未配置模型命中它 = 有价格但没覆盖这些记录（生效日期晚于记录，或只有其它供应商的精确价）——
 *  出口是「补生效日期」，不是归并（issue #98） */
const activePriceByModel = computed(() => {
  const m = new Map<string, PriceRow>();
  for (const p of prices.value) if (p.active && !m.has(p.modelId)) m.set(p.modelId, p);
  return m;
});

/** 未配置行内提示文案：已有同名现行价格（未覆盖历史记录） */
function priceHint(u: UnpricedModel): string {
  const p = activePriceByModel.value.get(u.modelId);
  if (!p) return "";
  return `已有价格（${sourceLabel[p.source] || p.source} · ${dateToStr(p.effectiveFrom)} 起）、未覆盖历史记录`;
}

const mergeModal = reactive({
  show: false,
  aliasModelId: "",
  records: 0,
  tokens: 0,
  firstSeen: 0,
  candidates: [] as MergeCandidate[],
  selfPrice: null as PriceRow | null, // 本模型的现行价格行（存在 = 应走「补生效日期」，而不是归并）
  target: "",
  submitting: false,
  extending: false,
  error: "",
});

function openMerge(u: UnpricedModel) {
  mergeModal.aliasModelId = u.modelId;
  mergeModal.records = u.records;
  mergeModal.tokens = u.tokens;
  mergeModal.firstSeen = u.firstSeen;
  mergeModal.candidates = mergeCandidates(u.modelId);
  mergeModal.selfPrice = activePriceByModel.value.get(u.modelId) || null;
  // 自有现行价格时不再默认选中「最像的」其它模型：自动归并过去会改错计费口径；
  // 正确动作是给自有价格补生效日期，归并目标需用户显式改选
  mergeModal.target = mergeModal.selfPrice ? "" : mergeModal.candidates[0]?.modelId || "";
  mergeModal.error = "";
  mergeModal.show = true;
}

/** 是否为该别名的最优推荐（命中 > 0 即有资格标注「推荐」） */
const bestMerge = computed(() => {
  const c = mergeModal.candidates[0];
  return c && c.hit > 0 ? c : null;
});

/** 「补生效日期」按钮文案：现行价确实晚于最早记录才说「提前」，否则说「补录」（供应商维度未覆盖的场景） */
const extendLabel = computed(() => {
  const day = dateToStr(mergeModal.firstSeen);
  const sp = mergeModal.selfPrice;
  return sp && sp.effectiveFrom <= mergeModal.firstSeen ? `按现行价格补录历史记录（${day} 起生效）` : `生效日期提前到 ${day} 并重算`;
});

/** 让 modelId 的历史记录按现行价格计费：价格段起点补到最早记录日（与草稿行「生效日期默认最早记录日」同一口径）。
 *  写通配行（providerId=null）以同时兜住「只有其它供应商精确价」的场景；沿用原行来源（remote 保持随远程源更新）。
 *  savePrice 会把同来源同维度的后续段并入这一段——数值不变，只挪生效起点，历史费用随即重算 */
function priceHistoryBack(modelId: string, firstSeen: number, sp: PriceRow) {
  return api.savePrice({
    providerId: null,
    modelId,
    inputPerM: sp.inputPerM,
    outputPerM: sp.outputPerM,
    cacheReadPerM: sp.cacheReadPerM,
    cacheWritePerM: sp.cacheWritePerM,
    currency: sp.currency,
    effectiveFrom: dateToMs(dateToStr(firstSeen)),
    source: sp.source,
  });
}

/** 归并弹窗顶部「补生效日期」：本模型已有现行价格时的一键出口（无需归并） */
async function extendPriceBack() {
  const sp = mergeModal.selfPrice;
  if (!sp || mergeModal.extending) return;
  mergeModal.extending = true;
  mergeModal.error = "";
  try {
    const r = await priceHistoryBack(mergeModal.aliasModelId, mergeModal.firstSeen, sp);
    if (r.ok) {
      ElMessage.success(`已按现行价格重算 ${mergeModal.aliasModelId} 的历史记录`);
      mergeModal.show = false;
      await Promise.all([loadPrices(), loadUnpriced()]);
    } else {
      mergeModal.error = r.message || "保存失败，请重试";
    }
  } catch (e) {
    mergeModal.error = e instanceof Error ? e.message : "保存失败，请重试";
  } finally {
    mergeModal.extending = false;
  }
}

/** 未配置行内的「补生效日期」：同上，不经过弹窗 */
async function extendRowPriceBack(u: UnpricedModel) {
  const sp = activePriceByModel.value.get(u.modelId);
  if (!sp) return;
  const r = await priceHistoryBack(u.modelId, u.firstSeen, sp);
  flash(r.ok ? { ok: true, message: `已按现行价格重算 ${u.modelId} 的历史记录` } : r);
  if (r.ok) await Promise.all([loadPrices(), loadUnpriced()]);
}

async function submitMerge() {
  if (!mergeModal.target || mergeModal.submitting) return;
  mergeModal.submitting = true;
  mergeModal.error = "";
  try {
    const r = await api.addAlias(mergeModal.aliasModelId, mergeModal.target);
    if (r.ok) {
      // 提示走全局 toast：弹窗随即关闭，顶部 flash 会被遮罩挡住、3.6 秒自动消失，用户会以为「没反应」
      ElMessage.success(r.message || "已归并");
      mergeModal.show = false;
      await Promise.all([loadPrices(), loadAliases(), loadUnpriced()]);
    } else {
      mergeModal.error = r.message || "归并失败，请重试";
      ElMessage.error(mergeModal.error);
    }
  } catch (e) {
    mergeModal.error = e instanceof Error ? e.message : "归并失败，请重试";
    ElMessage.error(mergeModal.error);
  } finally {
    mergeModal.submitting = false;
  }
}

/** 目标模型 → 归并到它的别名列表（价格表模型列下展示） */
const aliasesByTarget = computed(() => {
  const m = new Map<string, ModelAlias[]>();
  for (const a of aliases.value) {
    const arr = m.get(a.targetModelId) || [];
    arr.push(a);
    m.set(a.targetModelId, arr);
  }
  return m;
});

async function removeAliasRow(a: ModelAlias) {
  if (!window.confirm(`取消「${a.alias} → ${a.targetModelId}」的归并？\n\n取消后该模型回到未配置状态，相关记录费用按未配置处理（计 0）。`)) return;
  const r = await api.removeAlias(a.alias);
  flash(r);
  if (r.ok) await Promise.all([loadPrices(), loadAliases(), loadUnpriced()]);
}

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
  // checkedItems 来自 reactive 的 preview，元素是响应式 Proxy；Electron IPC 结构化克隆
  // 不支持 Proxy（DataCloneError 且异常静默），必须映射为纯字段普通对象再传（同 saveConfig 的脱壳口径）
  const items = checkedItems.value.map((it) => ({
    providerId: it.providerId ?? null,
    modelId: it.modelId,
    inputPerM: it.inputPerM,
    outputPerM: it.outputPerM,
    cacheReadPerM: it.cacheReadPerM,
    cacheWritePerM: it.cacheWritePerM,
    currency: it.currency,
  }));
  try {
    const r = await api.importPricesApply(items, dateToMs(importModal.effectiveFrom));
    flash(r);
    if (r.ok) {
      importModal.show = false;
      await Promise.all([loadPrices(), loadUnpriced()]);
    }
  } catch (e) {
    flash({ ok: false, message: e instanceof Error ? e.message : "导入失败，请重试" });
  }
}

onMounted(async () => {
  await Promise.all([loadPrices(), loadUnpriced(), loadRemoteStatus(), loadNaStatus(), loadAliases()]);
});

// 视图常驻：同步结束（他机价格表合并 / 价格源顺带拉取）或切回本页时刷新
let wasRunning = app.sync.running;
watch(() => app.sync.running, (now) => {
  if (wasRunning && !now) { loadPrices(); loadUnpriced(); loadRemoteStatus(); loadNaStatus(); loadAliases(); }
  wasRunning = now;
});
watch(() => app.activePage, (p) => {
  if (p === "billing") { loadPrices(); loadUnpriced(); loadRemoteStatus(); loadNaStatus(); loadAliases(); }
});
</script>

<template>
  <div class="sync-page">
    <div v-if="actionResult" class="save-line" :class="{ ok: actionResult.ok }">{{ actionResult.message }}</div>

    <!-- ① 计费设置：与价格源解耦，单独成卡（三个字段并排，不再挤在右栏） -->
    <div class="card">
      <div class="card-head">
        <h2>计费设置</h2>
        <span class="hint">汇率修改后，全部历史费用按新汇率即时重算</span>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">启用费用统计</div>
          <div class="s-desc">关闭后隐藏「费用」页与所有费用元素，记录与同步不受影响</div>
        </div>
        <div class="switch" :class="{ on: app.config.billing?.enabled }" role="switch" :aria-checked="!!app.config.billing?.enabled" @click="toggleEnabled"></div>
      </div>
      <div class="form-grid billing-form billing-form-3">
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
        <div class="form-field">
          <label>导入代理（可选，留空直连）</label>
          <input class="f-input mono" v-model="app.config.billing.importProxy" placeholder="http://127.0.0.1:7897" @blur="autoSave" />
        </div>
      </div>
      <div class="bs-note">两个价格源共用这个代理（拉取走独立网络会话，不影响主窗口）</div>
    </div>

    <!-- ② 价格来源：主源（在线定价）与备源（远程价格表）并列，顶部是生效优先级链 -->
    <div class="card">
      <div class="card-head">
        <h2>价格来源</h2>
        <span class="hint">两源并存，同一模型按下方优先级取价</span>
      </div>

      <div class="src-chain">
        <span class="chain-pill">手动价</span>
        <span class="chain-arrow">›</span>
        <span class="chain-pill accent">在线定价</span>
        <span class="chain-arrow">›</span>
        <span class="chain-pill">远程价格表</span>
        <span class="chain-arrow">›</span>
        <span class="chain-pill">内置</span>
        <span class="chain-note">没填手动价的模型自动落到在线定价；在线定价没收录的模型由远程价兜底</span>
      </div>

      <div class="src-grid">
        <!-- 在线定价源（主）：内置两个公共定价预设，免配置 -->
        <section class="src-panel primary">
          <div class="sp-head">
            <div class="sp-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2.4"/></svg>
              在线定价源
              <span class="sp-badge main">主</span>
            </div>
            <div class="switch" :class="{ on: app.config.billing?.newApi?.enabled }" role="switch" :aria-checked="!!app.config.billing?.newApi?.enabled" @click="toggleNewApi"></div>
          </div>
          <p class="sp-desc">
            免配置：内置两个公共定价表，官方预设优先、models.dev 补齐它没收录的模型
          </p>

          <ul class="preset-list">
            <li v-for="s in presetRows" :key="s.id" class="preset-row" :class="s.state" :title="s.tip">
              <span class="p-dot"></span>
              <div class="p-main">
                <div class="p-host mono">{{ s.host }}</div>
                <div class="p-name">{{ s.name }}</div>
              </div>
              <span class="p-count">{{ s.count }}</span>
            </li>
          </ul>

          <div class="form-field" style="max-width: 150px; margin-top: 12px">
            <label>检查间隔（小时）</label>
            <input class="f-input mono" type="number" min="1" step="1" v-model.number="app.config.billing.newApi.intervalHours" @blur="saveNaField" />
          </div>

          <div class="sp-status" :class="{ err: !naMsg && naStatus?.lastError }">
            <span v-if="naMsg" :style="{ color: naMsg.ok ? 'var(--ok)' : 'var(--err)' }">{{ naMsg.text }}</span>
            <template v-else-if="naStatus?.lastError">最近失败：{{ naStatus.lastError }}</template>
            <template v-else-if="naStatus?.lastAt">
              上次拉取 {{ formatDateTime(naStatus.lastAt) }} · 命中 {{ naStatus.lastModels }}/{{ naStatus.lastTotal }} 个模型
            </template>
            <template v-else>尚未拉取过</template>
          </div>
          <div class="sp-actions">
            <button class="btn-outline" @click="openNaPreview">预览差异</button>
            <button class="btn-outline" :disabled="naPulling" @click="pullNaNow">{{ naPulling ? "拉取中…" : "立即拉取" }}</button>
          </div>
        </section>

        <!-- 远程价格表（备）：公共价格表，兜底在线定价没收录的模型 -->
        <section class="src-panel">
          <div class="sp-head">
            <div class="sp-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
              远程价格表
              <span class="sp-badge">备</span>
            </div>
            <div class="switch" :class="{ on: app.config.billing?.remotePricing?.enabled }" role="switch" :aria-checked="!!app.config.billing?.remotePricing?.enabled" @click="toggleRemotePricing"></div>
          </div>
          <p class="sp-desc">
            LiteLLM 兼容格式的公共价格表，覆盖主流模型；在线定价没收录的模型由它兜底
          </p>
          <div class="form-grid billing-form">
            <div class="form-field full">
              <label>价格表网址</label>
              <input class="f-input mono" v-model="app.config.billing.remotePricing.url" placeholder="https://…/model_prices_and_context_window.json" @blur="saveRemoteField" />
            </div>
            <div class="form-field">
              <label>哈希校验（可选）</label>
              <input class="f-input mono" v-model="app.config.billing.remotePricing.hashUrl" placeholder="https://…/…sha256" @blur="saveRemoteField" />
            </div>
            <div class="form-field">
              <label>检查间隔（小时）</label>
              <input class="f-input mono" type="number" min="1" step="1" v-model.number="app.config.billing.remotePricing.intervalHours" @blur="saveRemoteField" />
            </div>
          </div>
          <div class="sp-status">
            <span v-if="remoteMsg" :style="{ color: remoteMsg.ok ? 'var(--ok)' : 'var(--err)' }">{{ remoteMsg.text }}</span>
            <template v-else-if="remoteStatus?.lastAt">上次拉取 {{ formatDateTime(remoteStatus.lastAt) }} · 命中 {{ remoteStatus.lastModels }} 个本地模型</template>
            <template v-else>尚未拉取过</template>
          </div>
          <div class="sp-actions">
            <button class="btn-outline" :disabled="remotePulling" @click="pullRemoteNow">{{ remotePulling ? "拉取中…" : "立即拉取" }}</button>
          </div>
        </section>
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
              <td class="mono">
                {{ p.modelId }}
                <div v-for="a in aliasesByTarget.get(p.modelId)" :key="a.alias" class="alias-line">
                  <span>↳ {{ a.alias }}</span>
                  <el-tooltip content="取消归并" placement="top">
                    <button class="alias-del" @click="removeAliasRow(a)">×</button>
                  </el-tooltip>
                </div>
              </td>
              <td>{{ p.providerId || "不限" }}</td>
              <td class="num mono">{{ p.inputPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.outputPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.cacheReadPerM.toFixed(2) }}</td>
              <td class="num mono">{{ p.cacheWritePerM.toFixed(2) }}</td>
              <td><span class="pill" :class="p.currency === 'USD' ? 'ok' : 'blue'">{{ p.currency }}</span></td>
              <td><span class="pill" :class="srcPillClass(p.source)">{{ sourceLabel[p.source] || p.source }}</span></td>
              <td class="ver">
                <template v-if="p.active">
                  <b>{{ effLabel(p.effectiveFrom) }}</b> · {{ p.versions > 1 ? `${p.versions} 个历史版本` : "无历史" }}
                  <div v-if="hiddenSources(p).length" class="ver-sub">
                    另有 {{ hiddenSources(p).map((s) => sourceLabel[s] || s).join(" / ") }} 价（优先级更低，未生效）
                  </div>
                </template>
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
        <span class="hint">来自本机真实用量 · 填写后保存即计价（生效日期默认该模型最早记录日，历史一并计入）· 已有同名价格的行可「补生效日期」 · 渠道变体名可「归并」到已配置模型</span>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead><tr>
            <th>模型</th><th>供应商</th><th class="num">记录</th><th class="num">Token</th>
            <th>输入 /M</th><th>输出 /M</th><th>缓存读 /M</th><th>币种</th><th>生效日期</th><th class="op-cell">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="u in unpriced" :key="draftKey(u)" class="tr-unpriced">
              <td class="mono">
                {{ u.modelId }}
                <div v-if="activePriceByModel.has(u.modelId)" class="u-note">{{ priceHint(u) }}</div>
              </td>
              <td>{{ u.providerId }}</td>
              <td class="num mono">{{ formatInteger(u.records) }}</td>
              <td class="num mono">{{ formatToken(u.tokens) }}</td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].inputPerM" /></td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].outputPerM" /></td>
              <td><input class="f-input mini-input mono" type="number" step="0.01" min="0" v-model="draftRows[draftKey(u)].cacheReadPerM" /></td>
              <td>
                <el-select v-model="draftRows[draftKey(u)].currency" class="f-el-select" popper-class="glass-popper" style="width: 76px">
                  <el-option value="CNY" label="CNY" /><el-option value="USD" label="USD" />
                </el-select>
              </td>
              <td><input class="f-input mini-input" type="date" v-model="draftRows[draftKey(u)].effectiveFrom" /></td>
              <td class="op-cell">
                <button v-if="activePriceByModel.has(u.modelId)" class="btn-outline sm" @click="extendRowPriceBack(u)">补生效日期</button>
                <button class="btn-outline sm" @click="openMerge(u)">归并</button>
                <button class="btn-outline sm" @click="saveDraft(u)">保存</button>
              </td>
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
          <div><b>来源优先级</b>：手动 &gt; 在线定价 &gt; 远程价格表 &gt; 内置。同一模型多源并存时按此取价，低优先级来源的价格段保留但不生效（历史抽屉里能看到）。</div>
        </div>
        <div class="cal-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div><b>供应商匹配</b>：同来源内供应商精确匹配优先，其次按模型通配；同一模型跨软件源共用一份价格。</div>
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
         给整个文档凭空加几百像素高度，外壳从此可被滚动/推走。改价与历史两个 Teleport 都要带上它 -->
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
              <el-select v-model="editModal.form.currency" class="f-el-select" popper-class="glass-popper" style="width: 100%">
                <el-option value="CNY" label="CNY 人民币" /><el-option value="USD" label="USD 美元" />
              </el-select>
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
              <span class="pill" :class="srcPillClass(v.source)" style="margin-left: 4px">{{ sourceLabel[v.source] || v.source }}</span>
              <span v-if="v.currency === 'USD'" class="pill ok" style="margin-left: 4px">USD</span>
            </div>
            <div class="vt-price mono">输入 {{ v.inputPerM.toFixed(2) }} · 输出 {{ v.outputPerM.toFixed(2) }} · 缓存读 {{ v.cacheReadPerM.toFixed(2) }}</div>
            <div class="vt-by">由 {{ v.updatedBy || "未知设备" }} 于 {{ formatDateTime(v.updatedAt) }} 设置</div>
          </li>
          <li v-if="!historyModal.versions.length" style="border: none; color: var(--text-3)">暂无版本记录</li>
        </ul>
      </div>
    </Teleport>

    <!-- 定价差异预览：只读拉取内置定价表，与本地现行价逐项比对，勾选后才写入 -->
    <el-dialog v-model="naPreview.show" class="settings-dialog sync-scope" width="640px" align-center append-to-body>
      <template #header>
        <div>
          <div class="sd-title">定价差异</div>
          <div class="sd-sub">
            <template v-if="naPreview.data">
              两个内置预设共 {{ naPreview.data.total }} 个模型
              <template v-if="naPreview.data.tieredCount">· {{ naPreview.data.tieredCount }} 个阶梯/分时计费按首档取价</template>
            </template>
            <template v-else>{{ naPreview.loading ? "正在拉取内置预设…" : "只读预览，确认后才写入" }}</template>
          </div>
        </div>
      </template>
      <div v-if="naPreview.loading" class="skeleton sk-chart" style="height: 140px; margin-bottom: 0"></div>
      <template v-else-if="naPreview.error">
        <p class="m-hint" style="color: var(--err)">{{ naPreview.error }}</p>
      </template>
      <template v-else-if="naPreview.data">
        <div class="na-src">
          <span v-for="s in naPreview.data.sources" :key="s.id" class="na-src-item" :class="{ err: !s.ok }" :title="s.url">
            <b class="mono">{{ s.host }}</b>
            <span v-if="s.ok">{{ s.models }} 个</span>
            <span v-else>失败：{{ s.error }}</span>
          </span>
        </div>
        <div class="na-sum">
          <span class="na-chip add">新增 {{ naPreview.data.additions.length }}</span>
          <span class="na-chip chg">调价 {{ naPreview.data.changes.length }}</span>
          <span class="na-chip same">同价 {{ naPreview.data.unchanged.length }}</span>
          <span class="na-chip miss">未收录 {{ naPreview.data.unmatched.length }}</span>
          <span v-if="naSkippedCount" class="na-chip skip">已跳过 {{ naSkippedCount }}</span>
        </div>
        <div class="imp-list">
          <label v-for="it in naPreview.data.additions" :key="'a' + it.modelId" class="imp-row">
            <input type="checkbox" :checked="naPreview.checked.has(it.modelId)" @change="toggleNaCheck(it.modelId)" />
            <span class="ic add">+</span>
            <span class="m mono">{{ it.modelId }}</span>
            <span class="d">{{ it.currency }} {{ it.inputPerM.toFixed(2) }} / {{ it.outputPerM.toFixed(2) }} · 缓存读 {{ it.cacheReadPerM.toFixed(2) }}</span>
          </label>
          <label v-for="it in naPreview.data.changes" :key="'c' + it.modelId" class="imp-row">
            <input type="checkbox" :checked="naPreview.checked.has(it.modelId)" @change="toggleNaCheck(it.modelId)" />
            <span class="ic chg">↻</span>
            <span class="m mono">{{ it.modelId }}</span>
            <span class="d">
              {{ it.prev!.currency }} {{ it.prev!.inputPerM.toFixed(2) }}/{{ it.prev!.outputPerM.toFixed(2) }}
              → {{ it.currency }} {{ it.inputPerM.toFixed(2) }}/{{ it.outputPerM.toFixed(2) }}
              <b v-if="it.overriddenSource === 'manual'" class="na-over">手动价优先，写入后不生效</b>
              <b v-else-if="it.overriddenSource" class="na-over">覆盖{{ sourceLabel[it.overriddenSource] || it.overriddenSource }}价</b>
            </span>
          </label>
          <div v-for="f in naPreview.data.fuzzy" :key="'f' + f.modelId" class="imp-row">
            <span class="ic fuzz">≈</span>
            <span class="m mono">{{ f.modelId }}</span>
            <span class="d">按名称归一化匹配到 {{ f.matchedFrom }}，请核对是否为同一模型</span>
          </div>
          <div v-for="u in naPreview.data.unmatched" :key="'u' + u.modelId" class="imp-row">
            <span class="ic miss">✕</span>
            <span class="m mono">{{ u.modelId }}</span>
            <span class="d">预设未收录，仍由远程价格表 / 内置价兜底</span>
          </div>
          <div v-for="(m, i) in naPreview.data.skipped.request" :key="'sr' + i" class="imp-row">
            <span class="ic miss">!</span>
            <span class="m mono">{{ m }}</span>
            <span class="d">按次计费（fixed），token 计价无法表达，已跳过</span>
          </div>
          <div v-for="(m, i) in naPreview.data.skipped.invalid" :key="'si' + i" class="imp-row">
            <span class="ic miss">!</span>
            <span class="m mono">{{ m }}</span>
            <span class="d">表达式无法解析出 token 单价，已跳过</span>
          </div>
        </div>
        <p v-if="!naPreview.data.additions.length && !naPreview.data.changes.length && !naPreview.data.unmatched.length" class="m-hint">
          本地用量模型与内置预设价格已完全对齐，无需改动。
        </p>
        <p class="m-hint">
          写入的价格来源标记为 <b>在线定价</b>：优先级高于远程价格表、低于手动价；新价格从此刻起生效，历史记录仍按原价格段计费。未勾选的条目不写入。
        </p>
      </template>
      <div class="modal-actions">
        <button class="btn-outline" @click="naPreview.show = false">关闭</button>
        <button class="btn-outline" :disabled="naPreview.loading" @click="pullNaPreview">重新拉取</button>
        <button class="btn btn-cta" :disabled="!naCheckedItems.length" @click="applyNaPreview">应用 {{ naCheckedItems.length }} 项</button>
      </div>
    </el-dialog>

    <!-- 导入面板：与全局设置弹窗同一套 el-dialog 玻璃样式（settings-dialog）。
         class 里的 sync-scope 必须保留：弹窗内容用的 .m-hint / .form-field / .f-input / .tabs / .btn-cta
         全部写在 sync.css 的 .sync-scope 作用域下，Teleport 到 body 后漏掉它这些样式会整体失效 -->
    <el-dialog v-model="importModal.show" class="settings-dialog sync-scope" width="560px" align-center append-to-body>
      <template #header>
        <div>
          <div class="sd-title">从价格源导入</div>
          <div class="sd-sub">{{ importModal.preview?.sourceName || (importModal.loading ? "正在拉取价格源…" : "从公开价格源导入本机用量模型的最新价格") }}</div>
        </div>
      </template>
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
    </el-dialog>

    <!-- 归并弹窗：与设置弹窗同款 el-dialog；候选按关键字重合度排序，最优者默认选中 -->
    <el-dialog v-model="mergeModal.show" class="settings-dialog sync-scope" width="480px" align-center append-to-body>
      <template #header>
        <div>
          <div class="sd-title">归并到已配置模型</div>
          <div class="sd-sub mono">{{ mergeModal.aliasModelId }} · {{ formatInteger(mergeModal.records) }} 条记录 · {{ formatToken(mergeModal.tokens) }} tokens</div>
        </div>
      </template>
      <!-- 本模型在价格表里已有现行价格：正确出口是补生效日期（归并只用于渠道变体名），置顶为主动作 -->
      <div v-if="mergeModal.selfPrice" class="self-price-box">
        <p class="sp-line">
          本模型在价格表里已有现行价格：<b>{{ sourceLabel[mergeModal.selfPrice.source] || mergeModal.selfPrice.source }}</b>
          · 输入 <b>{{ mergeModal.selfPrice.inputPerM }}</b>/M · 输出 <b>{{ mergeModal.selfPrice.outputPerM }}</b>/M（{{ mergeModal.selfPrice.currency }}）
          · {{ formatDateTime(mergeModal.selfPrice.effectiveFrom) }} 起生效
        </p>
        <p class="m-hint">点下面按钮即可让这批历史记录按此价格计费；归并只用于渠道变体模型名，这种情况不需要归并。</p>
        <button class="btn btn-cta" :disabled="mergeModal.extending" @click="extendPriceBack">
          {{ mergeModal.extending ? "重算中…" : extendLabel }}
        </button>
      </div>
      <div class="form-field" v-if="mergeModal.candidates.length">
        <label>{{ mergeModal.selfPrice ? "或：归并到其它已配置模型（渠道变体名场景）" : "归并目标（该模型的全部记录按目标价格计费，生效日期不适用）" }}</label>
        <el-select v-model="mergeModal.target" class="f-el-select" popper-class="glass-popper" style="width: 100%" filterable>
          <el-option
            v-for="c in mergeModal.candidates"
            :key="c.modelId"
            :value="c.modelId"
            :label="c.modelId + (c.hit > 0 ? ` · 命中 ${c.tokens.join(' / ')}` : '') + (c.source ? ` · ${sourceLabel[c.source] || c.source}` : '') + (c.exactOnly ? ' · 仅供应商精确价' : '')"
          />
        </el-select>
      </div>
      <template v-if="!mergeModal.selfPrice">
        <p v-if="bestMerge" class="m-hint">
          关键字匹配：<code>{{ mergeModal.aliasModelId }}</code> 与 <b>{{ bestMerge.modelId }}</b> 命中
          {{ bestMerge.hit }}/{{ bestMerge.total }}{{ bestMerge.hit === bestMerge.total ? "（全命中）" : "" }}，已默认选中；也可改选其它模型。
        </p>
        <p v-else class="m-hint">未能按关键字自动匹配（与已配置模型无重合关键字），请从列表手动选择归并目标。</p>
      </template>
      <p class="m-hint">归并后该模型历史费用按目标模型价格自动重算；别名显示在价格表模型名下方，可随时取消。归并关系随价格表经 WebDAV 多设备同步。</p>
      <p v-if="mergeModal.error" class="m-error">{{ mergeModal.error }}</p>
      <div class="modal-actions">
        <button class="btn-outline" @click="mergeModal.show = false">取消</button>
        <button class="btn btn-cta" :disabled="!mergeModal.target || mergeModal.submitting" @click="submitMerge">{{ mergeModal.submitting ? "归并中…" : "确认归并" }}</button>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.billing-form { padding: 4px 0 2px; }
/* 计费设置：三字段并排（币种 / 汇率 / 代理）。
   特异性要压过 sync.css 里的 .sync-scope .form-grid（0,2,0）与它的窄屏覆盖，否则三列不生效 */
.sync-scope .form-grid.billing-form-3 { grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.8fr) minmax(0, 1.4fr); }
@media (max-width: 1080px) {
  .sync-scope .form-grid.billing-form-3 { grid-template-columns: 1fr 1fr; }
  .sync-scope .form-grid.billing-form-3 > .form-field:last-child { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  .sync-scope .form-grid.billing-form-3 { grid-template-columns: 1fr; }
}
.bs-note { border-top: 1px solid var(--border); padding-top: 12px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }

/* 价格来源：顶部优先级链 */
.src-chain { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px 14px; margin-bottom: 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
.chain-pill { font-size: 11.5px; padding: 2px 10px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); color: var(--text-2); white-space: nowrap; }
.chain-pill.accent { background: var(--accent-soft); border-color: var(--accent-soft-2); color: var(--accent-strong); font-weight: 600; }
.chain-arrow { color: var(--text-3); font-size: 12px; }
.chain-note { font-size: 11.5px; color: var(--text-3); margin-left: auto; }

/* 价格来源：主备两列（在线定价主 / 远程价格表备） */
.src-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
@media (max-width: 1080px) { .src-grid { grid-template-columns: 1fr; } }
.src-panel { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--surface); }
.src-panel.primary { border-color: var(--accent-soft-2); background: var(--accent-soft); }
.sp-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.sp-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text); }
.sp-title svg { width: 15px; height: 15px; color: var(--accent); flex-shrink: 0; }
.sp-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--surface-3); color: var(--text-3); font-weight: 500; }
.sp-badge.main { background: var(--accent); color: #fff; }
.sp-desc { font-size: 11.5px; color: var(--text-3); line-height: 1.65; margin-bottom: 10px; }
.sp-desc code { font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--accent-strong); background: var(--surface); padding: 1px 5px; border-radius: 4px; }
.sp-status { font-size: 11.5px; color: var(--text-3); line-height: 1.6; padding: 8px 0 0; margin-top: auto; border-top: 1px dashed var(--border); }
.sp-status.err { color: var(--err); }
.sp-actions { display: flex; gap: 8px; margin-top: 10px; }

/* 内置预设链接列表：状态点 + 域名/预设名 + 模型数，一眼看清两个链接各自拉到了什么 */
.preset-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.preset-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); transition: border-color .16s ease, background .16s ease; }
.preset-row:hover { border-color: var(--border-strong); background: var(--surface-2); }
.p-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-3); transition: box-shadow .16s ease; }
.preset-row.ok .p-dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.12); }
.preset-row.err .p-dot { background: var(--err); box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.12); }
.p-main { flex: 1; min-width: 0; }
.p-host { font-size: 12px; font-weight: 600; color: var(--text); line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-name { font-size: 11px; color: var(--text-3); line-height: 1.45; }
.p-count { font-size: 11px; color: var(--text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.preset-row.err .p-count { color: var(--err); }

/* 价格表：被更高优先级盖住的来源提示 */
.ver-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.pill.src-newapi { color: var(--accent-strong); background: var(--accent-soft); border: 1px solid var(--accent-soft-2); }

/* 定价差异预览 */
.na-src { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.na-src-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); }
.na-src-item b { font-weight: 600; color: var(--text); }
.na-src-item.err { color: var(--err); border-color: rgba(220, 38, 38, 0.28); background: rgba(220, 38, 38, 0.05); }
.na-src-item.err b { color: var(--err); }
.na-sum { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.na-chip { font-size: 11.5px; padding: 2px 10px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.na-chip.add { color: var(--ok); background: rgba(5, 150, 105, 0.1); }
.na-chip.chg { color: var(--accent-strong); background: var(--accent-soft); }
.na-chip.miss { color: var(--text-3); }
.na-chip.skip { color: var(--warn); background: rgba(217, 119, 6, 0.1); }
.na-over { color: var(--warn); font-weight: 500; margin-left: 4px; }
.imp-row .ic.fuzz { color: var(--accent-strong); background: var(--accent-soft); }

th.op-cell { text-align: center; white-space: nowrap; }
td.op-cell { text-align: right; white-space: nowrap; }
.op-cell .btn-link + .btn-link { margin-left: 2px; }
/* 保存结果提示：标题行已去除，改为卡片上方的独立反馈行 */
.save-line { font-size: 12px; color: var(--err); margin-bottom: 14px; }
.save-line.ok { color: var(--ok); }
/* 归并弹窗内错误行：失败时留在弹窗里（全局 toast 3 秒消失，红字停留供重试时对照） */
.m-error { font-size: 12px; color: var(--err); margin: 10px 0 0; line-height: 1.6; }
/* 未配置行内提示：已有同名现行价格、未覆盖历史记录——出口是补生效日期而非归并 */
.u-note { font-size: 11px; color: var(--text-3); font-weight: 400; margin-top: 2px; line-height: 1.5; }
/* 归并弹窗的「补生效日期」提示块（本模型已有现行价格时置顶） */
.self-price-box { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); padding: 10px 12px; margin-bottom: 12px; }
.self-price-box .sp-line { font-size: 12.5px; color: var(--text-2); line-height: 1.6; margin-bottom: 4px; }
.self-price-box .sp-line b { color: var(--text); }
.self-price-box .m-hint { margin-bottom: 10px; }
.self-price-box .btn { margin-bottom: 2px; }
.footnote-card { padding: 16px 20px; }

.tr-unpriced td { background: rgba(217, 119, 6, 0.045); }
.tr-unpriced:hover td { background: rgba(217, 119, 6, 0.08); }
.ver { font-size: 11.5px; color: var(--text-3); }
.ver b { color: var(--text-2); font-weight: 600; }
.mini-input { height: 30px; font-size: 12px; padding: 0 8px; width: 90px; }
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
/* 导入弹窗与全局设置弹窗同款 el-dialog：标题/副标题/宽度上限同值（源自 SettingsDialog） */
.sd-title { font-size: 15px; font-weight: 700; }
.sd-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.settings-dialog { max-width: calc(100vw - 48px); }
.settings-dialog :deep(.el-dialog__body) { padding: 14px 16px 16px; }
/* 价格表模型名下方的归并别名行 */
.alias-line { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); margin-top: 2px; }
.alias-line .alias-del { border: none; background: none; color: var(--text-3); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; border-radius: 4px; }
.alias-line .alias-del:hover { color: var(--err); }
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
