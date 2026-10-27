<!--
  ============================================================
   作者：沐晖
   日期：2026-10-26
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
      此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!--
  AgentHub · 提示词库（Prompt Library）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!--
  提示词库 · 线上提示词库（方案 §6）：状态条 → 搜索 + 视图切换 → 左栏（快捷/分类/按变量找）→ 卡片网格 → 详情抽屉。

  定位：精选目录，不是社区。纯客户端静态目录（内置基线 + 远程分片增量 + 用户导入），
  不做账号、云端收藏、投稿、评论、热度榜 —— AgentHub 没有服务端，任何要「用户身份」的能力都得先建后端。

  两个视图各解决一件事：
    · 模板视图：我该按什么结构写（10 套方法论，给 useWhen / guidance / pitfalls）
    · 案例视图：别人实际怎么写的（60 条成品，可复制即用）
  两视图共享搜索与分类筛选，切换不重置。

  ⚠️ 左栏必须真的驱动主区：目录模板带 categoryId，与案例的 category 是同一套 id，
  所以「分类」在模板视图里过滤模板、在案例视图里过滤案例，两边的计数也按当前视图的口径算。
  （此前模板视图渲染的是全量 templates，左栏怎么点右侧都不动 —— 这是「切换左侧右侧没反应」的主因。）

  收录（「收入我的库」）是只读目录 → 用户资产的唯一通道：
    · 写入 source:"online" + originRef:"catalog:<id>@<version>"，靠它判「已收录 / 有更新」
    · 用户改过的条目（hash 变了）永不静默覆盖
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { usePromptsStore } from "../../stores/prompts";
import { onUpdateEvent } from "../../api/ipc";
import {
  pipc,
  type CatalogCategory, type CatalogItem, type CatalogItemDetail,
  type CatalogStats, type CatalogTemplate, type PromptItem, type PromptsEvent,
} from "./promptTypes";
import { copyText, newId, parseTags, parseVariables } from "./promptUtil";

const app = useAppStore();
const prompts = usePromptsStore();
const active = computed(() => String(app.activeModule) === "prompts" && app.activePage === "online");

/** 每页条数：卡片投影不含正文，24 条约合宽屏 6~8 行 —— 一屏能扫完、滚到底不费劲，
 *  也让「翻页」这件事真的发生（目录现在 60 条 = 3 页，一次全渲染要滚 2600+ px） */
const PAGE_SIZE = 24;
/** 后端 list() 的 pageSize 上限。已收录/有更新要在前端按本地库过滤，必须一次拿全量才不会漏 */
const MAX_PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;

// ===== 目录数据 =====
const stats = ref<CatalogStats | null>(null);
const categories = ref<CatalogCategory[]>([]);
const templates = ref<CatalogTemplate[]>([]);
const items = ref<CatalogItem[]>([]);
const counts = ref<Record<string, number>>({});
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const indexLoading = ref(false);
const refreshing = ref(false);
const indexError = ref("");
const itemsError = ref("");
/** 目录全量 id→版本。只服务「有更新」的角标计数：items 是分页后的当前页，
 *  拿它数「有更新 N」会随翻页跳变，用户会以为目录在变 */
const versionById = ref(new Map<string, number>());
/** 每个模板的真实案例数（按目录里案例的 templateId 归并）。
 *  不能直接用模板声明的 itemIds.length：目录里「案例属于哪个模板」与「模板推荐哪些案例」
 *  是两套关系，实测并不总是一致（有模板声明 3 条、实际 4 条），照 itemIds 显示会让
 *  卡片上的数字和点进去看到的条数对不上。 */
const templateCaseCount = ref(new Map<string, number>());

// ===== 筛选状态（放组件内：离开页面回来重新拉一次目录不心疼，60 条而已）=====
const view = ref<"template" | "item">("template");
const query = ref("");
const category = ref("");
const templateId = ref("");
const quick = ref<"all" | "collected" | "update">("all");
const variablePick = ref("");

/** 本页的滚动容器就是根元素（带框架 .page，overflow:auto）：
 *  抽屉打开时要锁它，切换筛选后要复位它，两者都需要拿到真实 DOM */
const rootEl = ref<HTMLElement | null>(null);

// 快速连点分类、或连续输入搜索词时，先发的 IPC 可能后到。
// 只认最后一次请求的响应，否则列表会闪回上一次的筛选结果（看起来像「点了没反应」）。
let itemsSeq = 0;
let detailSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function scrollToTop() {
  const el = rootEl.value;
  if (el && el.scrollTop !== 0) el.scrollTop = 0;
}

// ===== 模板视图的可见集 =====
/** 模板带 categoryId，与案例的 category 同一套 id，所以左栏分类能直接驱动它 */
const visibleTemplates = computed(() => {
  const q = query.value.trim().toLowerCase();
  return templates.value.filter((t) => {
    if (category.value && t.categoryId !== category.value) return false;
    if (!q) return true;
    return t.title.toLowerCase().includes(q)
      || t.description.toLowerCase().includes(q)
      || t.useWhen.toLowerCase().includes(q);
  });
});

/** 模板卡上的「N 个案例」必须与点进去看到的条数一致，所以按目录里案例的 templateId 实时归并；
 *  全量目录还没拿到时回落到模板自己声明的 itemIds */
function caseCount(t: CatalogTemplate) {
  return templateCaseCount.value.get(t.id) ?? (t.itemIds || []).length;
}

// ===== 已收录 / 有更新 =====
/** 从 originRef 里解析目录 id 与收录时的版本：格式 catalog:<id>@<version> */
function parseOrigin(ref?: string): { id: string; version: number } | null {
  if (!ref) return null;
  const m = /^catalog:(.+)@(\d+)$/.exec(ref);
  return m ? { id: m[1], version: Number(m[2]) } : null;
}

const collected = computed(() => {
  const map = new Map<string, { itemId: string; version: number }>();
  for (const it of prompts.liveItems) {
    if (it.source !== "online") continue;
    const p = parseOrigin(it.originRef);
    if (p) map.set(p.id, { itemId: it.id, version: p.version });
  }
  return map;
});

function isCollected(id: string) { return collected.value.has(id); }

/** 判断依据是「目录当前版本 > 收录时版本」。当前版本优先取全量版本表，
 *  表里没有（目录超过 200 条）才回落到本次列表带回来的 version */
function hasUpdate(it: { id: string; version: number }) {
  const c = collected.value.get(it.id);
  if (!c) return false;
  return (versionById.value.get(it.id) ?? it.version) > c.version;
}

/** 「有更新」的数字必须与点进去看到的条数一致，所以走全量版本表，不用当前页 items */
const updateCount = computed(() => {
  let n = 0;
  for (const [id, v] of versionById.value) {
    const c = collected.value.get(id);
    if (c && v > c.version) n++;
  }
  return n;
});

// ===== 案例列表 / 分页 =====
/** 快捷入口的可见列表：已收录/有更新按本地库在前端过滤（目录总量小，没必要为它加后端参数） */
const visibleItems = computed(() => {
  if (quick.value === "collected") return items.value.filter((i) => isCollected(i.id));
  if (quick.value === "update") return items.value.filter((i) => hasUpdate(i));
  return items.value;
});

/** 只有「全部」走后端分页；已收录/有更新是一次拉全量再前端过滤，分页会把结果切掉一半 */
const paged = computed(() => quick.value === "all");
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const rangeLabel = computed(() => {
  if (!total.value) return "0 条";
  const from = (page.value - 1) * PAGE_SIZE + 1;
  const to = Math.min(total.value, page.value * PAGE_SIZE);
  return `${from}–${to} / 共 ${total.value} 条`;
});

/** 左栏两组「全部」的口径不同：
 *  · 分类组（本 computed）：目录在「当前搜索 + 模板」下的总量，忽略分类 —— 与后端 counts 同口径。
 *    不能用 total：那是「应用了分类筛选之后」的条数，点进某个分类后「全部」会跟着变小，
 *    看起来像目录缩水了。
 *  · 快捷组：用 total，因为「全部 / 已收录 / 有更新」三档本身就是当前筛选结果的分档。 */
const catalogTotal = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0));
const allCount = computed(() => (view.value === "template" ? templates.value.length : catalogTotal.value));

/** 分类行的数字同理：模板视图数模板，案例视图用后端 counts（它已按当前搜索/模板筛选算好） */
function categoryCount(id: string) {
  if (view.value === "template") return templates.value.filter((t) => t.categoryId === id).length;
  return counts.value[id] || 0;
}

/** 模板视图下只列「有模板」的分类：目录里 roleplay / life 只有案例、没有模板，
 *  把这两行摆出来只会让用户白点一次（点完必然落到空态）。案例视图列全部分类。 */
const sideCategories = computed(() => {
  if (view.value !== "template") return categories.value;
  return categories.value.filter((c) => categoryCount(c.id) > 0);
});

// ===== 按变量找 =====
/** 让用户从「我手上有什么材料」反查模板，而不是从「我想要什么」正查 */
const variableCloud = computed(() => {
  const n = new Map<string, number>();
  for (const it of items.value) for (const v of it.variableNames) n.set(v, (n.get(v) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, count]) => ({ name, count }));
});

/** 选中即把变量名填进搜索框（后端连正文一起搜，变量名会命中正文里的 {{name}}），再点一次取消并清空。
 *  此前写成「先改选中态、再读它」，于是选中时清空搜索框、取消时反而填入搜索词。 */
function toggleVariable(name: string) {
  if (variablePick.value === name) {
    variablePick.value = "";
    query.value = "";
    return;
  }
  variablePick.value = name;
  query.value = name;
}

// ===== 详情抽屉 =====
const drawerOpen = ref(false);
const detail = ref<CatalogItemDetail | null>(null);
const detailLoading = ref(false);

function closeDrawer() { drawerOpen.value = false; }

/** 抽屉是 fixed 浮层，但底下的 .page 仍会跟着滚轮滚（滚动穿透）。
 *  锁用类名交给样式侧：.page.pr-lock-scroll { overflow: hidden }（见 styles/prompts.css） */
watch(drawerOpen, (open) => {
  const el = rootEl.value;
  if (el) el.classList.toggle("pr-lock-scroll", open);
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && drawerOpen.value) closeDrawer();
}

async function openDetail(id: string) {
  const seq = ++detailSeq;
  drawerOpen.value = true;
  detail.value = null;
  detailLoading.value = true;
  try {
    const r = await pipc.promptsCatalogGet(id);
    if (seq !== detailSeq) return;   // 连点两张卡时只显示最后点开的那张
    if (r.ok && r.item) detail.value = r.item;
    else ElMessage.warning(r.message || "这一条打不开");
  } catch (e) {
    if (seq !== detailSeq) return;
    ElMessage.error((e as Error).message || "读取失败");
  } finally {
    if (seq === detailSeq) detailLoading.value = false;
  }
}

// ===== 收入我的库 =====
const saveOpen = ref(false);
const saveForm = ref({ name: "", category: "", tags: "" });
const saveTarget = ref<CatalogItemDetail | null>(null);

function openSave(item: CatalogItemDetail) {
  saveTarget.value = item;
  saveForm.value = {
    name: item.title,
    category: item.category ? categoryName(item.category) : prompts.cfg.defaultCategory,
    // tags 兜底成空数组：目录是外部数据，缺字段时这里抛错会让「收入我的库」整个点不动
    tags: (item.tags || []).join("，"),
  };
  saveOpen.value = true;
}

function categoryName(id: string) {
  return categories.value.find((c) => c.id === id)?.name || prompts.cfg.defaultCategory;
}

async function doSave() {
  const target = saveTarget.value;
  if (!target) return;
  const name = saveForm.value.name.trim();
  if (!name) { ElMessage.warning("请填写名称"); return; }

  const originRef = `catalog:${target.id}@${target.version}`;
  const exists = collected.value.get(target.id);
  const local = exists ? prompts.liveItems.find((i) => i.id === exists.itemId) : undefined;
  if (exists && local) {
    // 硬规则：用户改过的条目（hash 与入库时不同）永不静默覆盖。
    // 这里没有存「入库时 hash」，退一步用「有版本历史 > 1」判断是否被改过——
    // 只要用户动过，就一定多出一个版本（保存动作本身会 push 版本）。
    const edited = local.version > 1 || local.versions.length > 1;
    try {
      await ElMessageBox.confirm(
        `这条已在你的库（你的第 ${local.version} 版 / 目录 v${target.version}）。`
        + (edited ? "\n你的版本已经改过，建议「另存副本」，避免覆盖你的改动。" : ""),
        "已收录过",
        {
          confirmButtonText: edited ? "另存副本" : "更新为最新目录版",
          cancelButtonText: "取消",
          distinguishCancelAndClose: true,
          type: "warning",
        },
      );
    } catch { return; }
    if (!edited) {
      // 未改过：直接用目录版覆盖正文，保留用户自己的名称/分类/标签
      const merged: PromptItem = {
        ...local,
        body: target.body,
        variables: target.variables,
        originRef,
        originMeta: { license: target.license, url: target.sourceUrl, version: String(target.version) },
        updatedAt: Date.now(),
        versions: [...local.versions, { version: local.version + 1, body: target.body, at: Date.now(), note: `更新到目录 v${target.version}`, by: "user" as const }].slice(-prompts.cfg.versionKeep),
      };
      merged.version = local.version + 1;
      const r = await prompts.saveItem(merged);
      if (!r.ok) { ElMessage.error(r.message || "更新失败"); return; }
      saveOpen.value = false;
      ElMessage.success("已更新为目录最新版");
      return;
    }
  }

  const now = Date.now();
  const item: PromptItem = {
    id: newId("p"),
    name,
    description: `来自线上目录 · ${categoryName(target.category)}`,
    body: target.body,
    variables: parseVariables(target.body),
    category: saveForm.value.category.trim() || prompts.cfg.defaultCategory,
    tags: parseTags(saveForm.value.tags),
    source: "online",
    originRef,
    originMeta: { license: target.license, url: target.sourceUrl, version: String(target.version) },
    version: 1,
    versions: [{ version: 1, body: target.body, at: now, note: "收录自线上目录", by: "user" }],
    favorite: false,
    useCount: 0,
    lastUsedAt: 0,
    hash: "",
    createdAt: now,
    updatedAt: now,
  };
  const r = await prompts.saveItem(item);
  if (!r.ok) { ElMessage.error(r.message || "保存失败"); return; }
  saveOpen.value = false;
  ElMessage.success(`已收入个人库：${name}`);
}

/** 在此基础优化：把正文带进优化页，原文位预填，用户补上自己的场景再跑 */
function optimizeFrom(item: CatalogItemDetail) {
  prompts.draft = {
    input: item.body,
    output: "",
    styleName: "",
    model: "",
    elapsedMs: 0,
  };
  drawerOpen.value = false;
  app.setPage("optimize");
}

/** 模板卡 → 该模板的案例列表。取消选中走案例视图里的「看全部案例」，
 *  卡片上再做一次「点第二次取消」只会让人分不清「是取消还是没点中」 */
function pickTemplate(id: string) {
  templateId.value = id;
  view.value = "item";
}

function gotoPage(p: number) {
  const next = Math.min(Math.max(1, p), totalPages.value);
  if (next === page.value) return;
  page.value = next;
  void loadItems();
  scrollToTop();
}

// ===== 拉取 =====
async function loadIndex() {
  indexLoading.value = true;
  try {
    const r = await pipc.promptsCatalogIndex();
    categories.value = r.categories || [];
    templates.value = r.templates || [];
    indexError.value = "";
  } catch (e) {
    indexError.value = (e as Error).message || "目录读取失败";
  } finally {
    indexLoading.value = false;
  }
}

async function loadItems() {
  const seq = ++itemsSeq;
  loading.value = true;
  const full = quick.value !== "all";
  try {
    const r = await pipc.promptsCatalogList({
      category: category.value || undefined,
      templateId: templateId.value || undefined,
      q: query.value.trim() || undefined,
      page: full ? 1 : page.value,
      pageSize: full ? MAX_PAGE_SIZE : PAGE_SIZE,
    });
    if (seq !== itemsSeq) return;
    items.value = r.items || [];
    counts.value = r.counts || {};
    total.value = r.total || 0;
    // 筛选后总页数可能变少，后端会把 page 归一到合法值，跟着它走，避免页码与内容错位
    if (!full && r.page && r.page !== page.value) page.value = r.page;
    itemsError.value = "";
  } catch (e) {
    if (seq !== itemsSeq) return;
    itemsError.value = (e as Error).message || "目录读取失败";
  } finally {
    // 竞态里被淘汰的那次不能清 loading：否则后发的请求还在飞，界面就先解除加载态了
    if (seq === itemsSeq) loading.value = false;
  }
}

async function loadStats() {
  try {
    const r = await pipc.promptsCatalogStats();
    stats.value = r.stats;
  } catch { /* 概况拉不到不影响浏览 */ }
}

/** 拉一次全量目录（不分页），建两张表：id→版本（供「有更新」计数）、模板 id→案例数（供模板卡数字）。
 *  目录是精选目录，条数上限即后端 pageSize 上限（200），超过这个量级时这两处计数会偏低——
 *  真到那天该由后端提供专门的计数通道，而不是把全量目录拉到前端 */
async function loadCatalogMeta() {
  try {
    const r = await pipc.promptsCatalogList({ pageSize: MAX_PAGE_SIZE });
    const versions = new Map<string, number>();
    const perTemplate = new Map<string, number>();
    for (const it of r.items || []) {
      versions.set(it.id, it.version);
      if (it.templateId) perTemplate.set(it.templateId, (perTemplate.get(it.templateId) || 0) + 1);
    }
    versionById.value = versions;
    templateCaseCount.value = perTemplate;
  } catch { /* 角标与计数拿不到不影响浏览 */ }
}

async function reloadAll() {
  await Promise.all([loadIndex(), loadItems(), loadStats(), loadCatalogMeta()]);
}

async function refreshCatalog() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const r = await pipc.promptsCatalogRefresh();
    if (r.updated) {
      ElMessage.success(r.message || "目录已更新");
      page.value = 1;
      await reloadAll();
    } else if (r.ok) {
      // 分片有失败时版本号不推进（后端不写 index），但成功下到的分片已经落盘：
      // 列表必须重拉，只刷 stats 会让界面停在旧内容上，而状态条已经在提示「更新未完成」
      if (r.failed) { page.value = 1; await reloadAll(); } else await loadStats();
      ElMessage.info(r.message || "已是最新目录");
    } else {
      ElMessage.warning(r.message || "检查更新失败，继续使用本地目录");
    }
  } catch (e) {
    ElMessage.warning((e as Error).message || "检查更新失败，继续使用本地目录");
  } finally {
    refreshing.value = false;
  }
}

async function importCatalog() {
  try {
    const r = await pipc.promptsCatalogImport();
    if (!r.ok) { if (r.message && r.message !== "已取消") ElMessage.warning(r.message); return; }
    ElMessage.success(`已导入 ${r.imported} 条${r.skipped ? `（跳过 ${r.skipped} 条）` : ""}`);
    page.value = 1;
    await Promise.all([loadItems(), loadStats(), loadCatalogMeta()]);
  } catch (e) {
    ElMessage.error((e as Error).message || "导入失败");
  }
}

async function resetCatalog() {
  try {
    await ElMessageBox.confirm("将丢弃已下载的远程目录，回到安装包内置的版本。你导入的条目不受影响。", "回到内置目录？", {
      confirmButtonText: "回到内置", cancelButtonText: "取消", type: "warning",
    });
  } catch { return; }
  const r = await pipc.promptsCatalogReset();
  if (r.ok) {
    ElMessage.success("已回到内置目录");
    page.value = 1;
    await reloadAll();
  }
}

// ===== 筛选联动 =====
// 分类/模板变化：回第一页、重拉、回到顶部。不复位滚动位置的话，切换后用户还停在上一屏，
// 看到的仍是旧位置的卡片，主观感受就是「点了没切换」。
watch([category, templateId], () => {
  page.value = 1;
  void loadItems();
  scrollToTop();
});

watch(quick, () => {
  page.value = 1;
  void loadItems();
  scrollToTop();
});

watch(query, (q) => {
  // 手动改了搜索词就取消变量云的选中态，避免「高亮着 A 却在搜 B」
  if (variablePick.value && q !== variablePick.value) variablePick.value = "";
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void loadItems();
    scrollToTop();
  }, SEARCH_DEBOUNCE_MS);
});

// 两视图共用筛选，但切换视图后应从第一屏看起。
// 另外：目录里 roleplay / life 只有案例、没有模板，从案例视图带着这两个分类切到模板视图时，
// 左栏会没有高亮行、主区直接落到空态 —— 清掉分类，让用户从「全部模板」重新选。
watch(view, (v) => {
  if (v === "template" && category.value && !templates.value.some((t) => t.categoryId === category.value)) {
    category.value = "";
  }
  scrollToTop();
});

// ===== 生命周期 =====
let offEvent: (() => void) | undefined;

async function bootstrap() {
  prompts.init();
  void prompts.loadLibrary();
  await reloadAll();
}

onMounted(() => {
  void bootstrap();
  offEvent = onUpdateEvent((p) => {
    const e = p as PromptsEvent;
    if (e && e.event === "prompts" && e.type === "catalog-updated") void reloadAll();
  });
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  if (offEvent) { offEvent(); offEvent = undefined; }
  window.removeEventListener("keydown", onKeydown);
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  rootEl.value?.classList.remove("pr-lock-scroll");
});

watch(active, (v) => { if (v && !items.value.length) void reloadAll(); });

const sourceLabel = computed(() => {
  const s = stats.value;
  if (!s) return "目录读取中…";
  if (s.source === "cache") return `已更新到 v${s.version}`;
  if (s.source === "builtin") return `内置目录 v${s.version}`;
  return "目录缺失";
});
</script>

<template>
  <div ref="rootEl" class="page prompts-scope">
    <!-- 状态条 -->
    <div class="pr-card">
      <div class="pr-row">
        <span class="pr-chip accent">{{ sourceLabel }}</span>
        <span class="pr-chip">案例 {{ stats?.count ?? 0 }} 条</span>
        <span class="pr-chip">模板 {{ stats?.templates ?? 0 }} 套</span>
        <span class="pr-chip">{{ stats?.categories ?? 0 }} 分类</span>
        <span class="pr-chip" v-if="stats?.imported">导入 {{ stats.imported }} 条</span>
        <span class="pr-hint" v-if="stats?.lastCheckAt">上次检查 {{ new Date(stats.lastCheckAt).toLocaleString("zh-CN", { hour12: false }) }}</span>
        <span class="pr-hint" v-else>还没检查过更新</span>
        <span class="pr-inline-ctl">
          <button class="btn btn-ghost btn-sm" :disabled="refreshing" @click="refreshCatalog">
            <i class="ph ph-arrows-clockwise"></i>{{ refreshing ? "检查中…" : "检查更新" }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="importCatalog"><i class="ph ph-upload-simple"></i>导入</button>
          <button class="btn btn-ghost btn-sm" :disabled="stats?.source !== 'cache'" @click="resetCatalog">回到内置</button>
        </span>
      </div>
      <div v-if="stats?.lastError" class="pr-warn-inline" style="margin-top: 6px">{{ stats.lastError }}</div>
    </div>

    <!-- 搜索 + 视图切换 -->
    <div class="pr-card">
      <div class="pr-row">
        <input v-model="query" class="f-input" style="flex: 1; min-width: 220px" placeholder="搜场景、标题或变量，例如：周报 / 代码评审" />
        <span class="pr-inline-ctl">
          <span class="pr-chip click" :class="{ accent: view === 'template' }" @click="view = 'template'">模板</span>
          <span class="pr-chip click" :class="{ accent: view === 'item' }" @click="view = 'item'">案例</span>
        </span>
      </div>
      <div class="pr-hint">
        模板解决「该按什么结构写」，案例解决「别人实际怎么写的」。搜索与分类两边共用；
        「已收录 / 有更新 / 按变量找」只对案例有意义，切到案例视图才会出现。
      </div>
    </div>

    <div class="pr-online">
      <!-- 左栏 -->
      <aside class="pr-online-side">
        <div class="pr-side-group" v-if="view === 'item'">
          <div class="pr-side-title">快捷</div>
          <button class="pr-side-row" :class="{ on: quick === 'all' }" @click="quick = 'all'">
            <span>全部</span><span class="n">{{ total }}</span>
          </button>
          <button class="pr-side-row" :class="{ on: quick === 'collected' }" @click="quick = 'collected'">
            <span>已收录</span><span class="n">{{ collected.size }}</span>
          </button>
          <button class="pr-side-row" :class="{ on: quick === 'update' }" @click="quick = 'update'">
            <span>有更新</span><span class="n">{{ updateCount }}</span>
          </button>
        </div>

        <div class="pr-side-group">
          <div class="pr-side-title">分类<template v-if="view === 'template' && sideCategories.length < categories.length"> · 只列有模板的</template></div>
          <button class="pr-side-row" :class="{ on: !category }" @click="category = ''; templateId = ''">
            <span>全部</span><span class="n">{{ allCount }}</span>
          </button>
          <button
            v-for="c in sideCategories"
            :key="c.id"
            class="pr-side-row"
            :class="{ on: category === c.id }"
            @click="category = c.id; templateId = ''"
          >
            <span>{{ c.name }}</span><span class="n">{{ categoryCount(c.id) }}</span>
          </button>
        </div>

        <div class="pr-side-group" v-if="view === 'item' && variableCloud.length">
          <div class="pr-side-title">按变量找</div>
          <div class="pr-row">
            <span
              v-for="v in variableCloud"
              :key="v.name"
              class="pr-chip click"
              :class="{ accent: variablePick === v.name }"
              @click="toggleVariable(v.name)"
            >{{ v.name }}</span>
          </div>
        </div>
      </aside>

      <!-- 主区 -->
      <div class="pr-online-main">
        <!-- 模板视图 -->
        <template v-if="view === 'template'">
          <div v-if="indexError" class="pr-online-empty">
            <div>{{ indexError }}</div>
            <button class="btn btn-ghost btn-sm" @click="reloadAll">重试</button>
          </div>
          <div v-else-if="indexLoading && !templates.length" class="pr-online-empty">正在读取目录…</div>
          <div v-else-if="!templates.length" class="pr-online-empty">目录里还没有模板</div>
          <div v-else-if="!visibleTemplates.length" class="pr-online-empty">
            <div>这个筛选下没有模板</div>
            <button class="btn btn-ghost btn-sm" @click="category = ''; query = ''">看全部模板</button>
          </div>
          <template v-else>
            <div v-if="category" class="pr-row" style="margin-bottom: 8px">
              <span class="pr-chip accent">{{ categories.find((c) => c.id === category)?.name || category }}</span>
              <span class="pr-hint">{{ visibleTemplates.length }} 套模板</span>
              <button class="btn btn-ghost btn-sm" @click="category = ''">看全部分类</button>
            </div>
            <div class="pr-tpl-grid">
              <article
                v-for="t in visibleTemplates"
                :key="t.id"
                class="pr-tpl-card"
                @click="pickTemplate(t.id)"
              >
                <div class="pr-tpl-head">
                  <span class="pr-tpl-title">{{ t.title }}</span>
                  <span class="pr-chip">{{ caseCount(t) }} 个案例</span>
                </div>
                <p class="pr-tpl-desc">{{ t.description }}</p>
                <div class="pr-tpl-use"><b>什么时候用</b>{{ t.useWhen }}</div>
              </article>
            </div>
          </template>
        </template>

        <!-- 案例视图 -->
        <template v-else>
          <div v-if="itemsError" class="pr-online-empty">
            <div>{{ itemsError }}</div>
            <button class="btn btn-ghost btn-sm" @click="loadItems">重试</button>
          </div>
          <div v-else-if="loading && !visibleItems.length" class="pr-online-empty">正在读取目录…</div>
          <div v-else-if="!visibleItems.length" class="pr-online-empty">
            <div>{{ quick === 'collected' ? "还没有收录任何条目" : quick === 'update' ? "没有可更新的条目" : "没有匹配的条目" }}</div>
            <button v-if="quick !== 'all' || query" class="btn btn-ghost btn-sm" @click="quick = 'all'; query = ''">看全部</button>
          </div>
          <template v-else>
            <div v-if="templateId" class="pr-row" style="margin-bottom: 8px">
              <span class="pr-chip accent">{{ templates.find((t) => t.id === templateId)?.title || "模板" }}</span>
              <span class="pr-hint">{{ visibleItems.length }} 个案例</span>
              <button class="btn btn-ghost btn-sm" @click="templateId = ''">看全部案例</button>
            </div>

            <div class="pr-cat-grid">
              <article v-for="it in visibleItems" :key="it.id" class="pr-cat-card" @click="openDetail(it.id)">
                <div class="pr-cat-head">
                  <span class="pr-cat-title">{{ it.title }}</span>
                  <span v-if="hasUpdate(it)" class="pr-chip warn">v{{ it.version }}</span>
                  <span v-else-if="isCollected(it.id)" class="pr-chip info">已收录</span>
                </div>
                <p class="pr-cat-summary">{{ it.summary }}</p>
                <div class="pr-row">
                  <span class="pr-chip">{{ categories.find((c) => c.id === it.category)?.name || it.category }}</span>
                  <span v-if="(it.variableNames || []).length" class="pr-chip accent">{{ it.variableNames[0] }}{{ it.variableCount > 1 ? ` +${it.variableCount - 1}` : "" }}</span>
                  <span v-for="t in (it.tags || []).slice(0, 2)" :key="t" class="pr-chip">{{ t }}</span>
                </div>
              </article>
            </div>

            <!-- 分页：只有「全部」走后端分页；已收录/有更新是一次拉全量再前端过滤，不切页 -->
            <div v-if="paged && totalPages > 1" class="pager">
              <span class="pg-info">{{ rangeLabel }}</span>
              <button class="btn btn-ghost btn-sm" :disabled="page <= 1 || loading" @click="gotoPage(page - 1)">上一页</button>
              <span class="pr-chip">第 {{ page }} / {{ totalPages }} 页</span>
              <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages || loading" @click="gotoPage(page + 1)">下一页</button>
            </div>
            <div v-else-if="paged && total" class="pr-hint" style="margin-top: 8px">共 {{ total }} 条，已全部显示</div>
          </template>
        </template>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="drawerOpen" class="pr-drawer-mask" @click.self="closeDrawer">
      <aside class="pr-drawer">
        <div class="pr-drawer-head">
          <span class="pr-drawer-title">{{ detail?.title || "读取中…" }}</span>
          <button class="btn btn-ghost btn-sm" @click="closeDrawer">关闭</button>
        </div>

        <div v-if="detailLoading" class="pr-hint">正在读取…</div>

        <div v-else-if="detail" class="pr-drawer-body">
          <div class="pr-row">
            <span class="pr-chip">{{ categories.find((c) => c.id === detail!.category)?.name || detail!.category }}</span>
            <span class="pr-chip">v{{ detail.version }}</span>
            <span v-if="isCollected(detail.id)" class="pr-chip info">已收录</span>
            <span v-if="hasUpdate(detail)" class="pr-chip warn">有更新</span>
          </div>

          <template v-if="detail.templateId">
            <template v-for="t in templates.filter((x) => x.id === detail!.templateId)" :key="t.id">
              <div class="pr-drawer-sec">
                <div class="pr-drawer-label">什么时候用</div>
                <p>{{ t.useWhen }}</p>
              </div>
              <div class="pr-drawer-sec">
                <div class="pr-drawer-label">怎么做</div>
                <ol><li v-for="(g, i) in t.guidance" :key="i">{{ g }}</li></ol>
              </div>
              <div class="pr-drawer-sec">
                <div class="pr-drawer-label">容易踩的坑</div>
                <ul class="pr-pitfall"><li v-for="(p, i) in t.pitfalls" :key="i">{{ p }}</li></ul>
              </div>
            </template>
          </template>

          <div v-if="(detail.variables || []).length" class="pr-drawer-sec">
            <div class="pr-drawer-label">变量</div>
            <div class="pr-row">
              <span v-for="v in (detail.variables || [])" :key="v.name" class="pr-chip accent">{{ v.name }}</span>
            </div>
          </div>

          <div class="pr-drawer-sec">
            <div class="pr-drawer-label">完整提示词</div>
            <pre class="pr-pre pr-drawer-pre">{{ detail.body }}</pre>
          </div>

          <div class="pr-drawer-sec">
            <div class="pr-drawer-label">来源与许可</div>
            <div class="pr-hint">
              许可：{{ detail.license }}
              <template v-if="detail.sourceUrl"> · <a :href="detail.sourceUrl" target="_blank" rel="noreferrer">打开来源页</a></template>
            </div>
          </div>
        </div>

        <div class="pr-drawer-foot">
          <button class="btn btn-ghost" :disabled="!detail" @click="detail && copyText(detail.body, '提示词')">
            <i class="ph ph-copy"></i>复制
          </button>
          <button class="btn btn-ghost" :disabled="!detail" @click="detail && optimizeFrom(detail)">
            <i class="ph ph-magic-wand"></i>在此基础优化
          </button>
          <button class="btn btn-cta" :disabled="!detail" @click="detail && openSave(detail)">
            <i class="ph ph-bookmark-simple"></i>收入我的库
          </button>
        </div>
      </aside>
    </div>

    <!-- 收入我的库 -->
    <el-dialog v-model="saveOpen" title="收入我的库" width="520px">
      <div class="pr-col">
        <label class="pr-field" style="display: block">名称<input v-model="saveForm.name" class="f-input" style="width: 100%" /></label>
        <label class="pr-field" style="display: block">分类<input v-model="saveForm.category" class="f-input" style="width: 100%" placeholder="支持两级，如 写作/邮件" /></label>
        <label class="pr-field" style="display: block">标签（逗号或空格分隔）<input v-model="saveForm.tags" class="f-input" style="width: 100%" /></label>
        <div class="pr-hint">
          正文按目录原样收入，<code v-pre>{{变量}}</code> 会被自动识别成变量。
          来源记为「线上」，目录以后更新时这里会提示「有更新」，但不会自动覆盖你改过的内容。
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="saveOpen = false">取消</button>
        <button class="btn btn-cta" @click="doSave">收入</button>
      </template>
    </el-dialog>
  </div>
</template>
