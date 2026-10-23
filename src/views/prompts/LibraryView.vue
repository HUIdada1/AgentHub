<!--
  ============================================================
   作者：沐晖
   日期：2026-10-23
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
  提示词库 · 个人提示词库（方案总纲 §3.2）：顶栏（搜索 / 视图切换 / chips / 新建 / 导入 / 批量）
  → 左栏（快捷入口 / 两级分类树 / 标签云 / 来源筛选）→ 主区（卡片或列表 / 批量条 / 空态）。
  页面不接收 props：数据一律从 usePromptsStore() 取，筛选态也放在 store 里（切页回来不丢）。

  §8.2 中本页负责落地的边界（后端负责的只透传 message，前端不重复判断）：
    1  导入同名 → 弹窗里选「新建副本 / 覆盖 / 跳过」（一次选定 = 契约的 onConflict，等价于「全部应用」）
    3  删除 → 进回收站（保留期内可恢复，过期由后端清理）
    5  单条过大 → 后端拒绝保存，本页原样透出错误文案
    7  分类被删 → 条目的 category 退回「未分类」，本页「未分类」快捷入口就是它的落点
    8  库目录被手工移动/删除 → 错误态里给「打开库目录 / 重建台账」的引导
    10 台账损坏 → 错误态里给「重建台账」，重建后提示恢复条数
    16 并发编辑（两窗口）→ 行内改名/移动分类等保存动作全部带 expectedHash，冲突时问「是否覆盖」
  另外：排序、置顶优先、同步状态点的口径全部收在 store 的 getters 里，本页只渲染，避免两处口径打架。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import {
  usePromptsStore,
  type PromptChip, type PromptQuick, type PromptSort, type PromptSource,
} from "../../stores/prompts";
import { pipc, type PromptItem } from "./promptTypes";
import { copyText, newId, parseTags, parseVariables, summaryOf } from "./promptUtil";
import { timeAgo } from "../../composables/useFormat";

const app = useAppStore();
const prompts = usePromptsStore();

/** 来源徽标文案与配色：来源是「这条从哪来」，比分类更能解释用户为什么会有这条 */
const SOURCE_LABEL: Record<PromptItem["source"], string> = {
  local: "本地",
  optimized: "优化生成",
  online: "线上",
  imported: "导入",
};
const SOURCE_CLS: Record<PromptItem["source"], string> = {
  local: "",
  optimized: "accent",
  online: "info",
  imported: "info",
};

/** 排序项：与 store 的 PromptSort 一一对应（口径在 store，这里只给文案） */
const SORTS: { value: PromptSort; label: string }[] = [
  { value: "updated", label: "最近更新" },
  { value: "created", label: "创建时间" },
  { value: "used", label: "使用次数" },
  { value: "name", label: "名称" },
];

/** 顶栏筛选 chips：与左栏 quick 是「与」关系（例如「收藏」快捷入口 + 「有变量」chip） */
const CHIPS: { key: PromptChip; label: string }[] = [
  { key: "favorite", label: "收藏" },
  { key: "recent", label: "最近 7 天" },
  { key: "variables", label: "有变量" },
  { key: "conflict", label: "有冲突" },
  { key: "synced", label: "已同步" },
];

/** 要在界面上显示「变量占位符」这个字面量时的唯一出口。
 *  为什么不能直接在插值里写 `{{ "{{x}}" }}`：Vue 的插值解析器遇到第一个 `}}` 就结束（它不认字符串），
 *  会把表达式截成 `"{{x` 这样的非法 JS，真实编译器（@vue/compiler-sfc / vite build）会直接报
 *  "Unterminated string constant" —— 所以字面量只能放在脚本常量里，模板只插值常量名。 */
const VAR_SAMPLE = "{{变量}}";

const chipCounts = computed(() => prompts.chipCounts);
const syncAt = computed(() => prompts.syncBaseAt);

/** 快捷入口的计数就地算：这几个口径很直观（收藏 / 未分类 / 回收站），没必要再往 store 里塞 getter */
const quickEntries = computed<{ key: PromptQuick; label: string; icon: string; count: number }[]>(() => {
  const live = prompts.liveItems;
  return [
    { key: "all", label: "全部", icon: "ph-stack", count: live.length },
    { key: "favorite", label: "收藏", icon: "ph-star", count: live.filter((i) => i.favorite).length },
    { key: "recent", label: "最近使用", icon: "ph-clock-counter-clockwise", count: prompts.chipCounts.recent },
    {
      key: "uncategorized",
      label: "未分类",
      icon: "ph-folder-dashed",
      count: live.filter((i) => !i.category || i.category === "未分类").length,
    },
    { key: "trash", label: "回收站", icon: "ph-trash", count: prompts.trashItems.length },
  ];
});

/** 来源筛选：线上库是二期能力，只有真的存在线上条目时才显示这一档（不给用户假入口） */
const sourceEntries = computed<{ key: PromptSource; label: string; count: number }[]>(() => {
  const c = prompts.sourceCounts;
  const rows: { key: PromptSource; label: string; count: number }[] = [
    { key: "all", label: "全部来源", count: prompts.liveItems.length },
    { key: "local", label: "本地创建", count: c.local || 0 },
    { key: "optimized", label: "优化生成", count: c.optimized || 0 },
    { key: "imported", label: "导入", count: c.imported || 0 },
  ];
  if (c.online) rows.push({ key: "online", label: "线上", count: c.online });
  return rows;
});

const hasFilter = computed(() =>
  !!(
    prompts.query.trim()
    || prompts.quick !== "all"
    || prompts.category
    || prompts.tag
    || prompts.source !== "all"
    || prompts.chips.length
  ),
);

/** 空态必须分三种（「一条都没有」和「筛没了」要给完全不同的下一步动作）：
 *  库为空 → 引导去优化提示词页产出第一条；回收站为空 → 回全部；其余 → 一键清筛选。 */
const isEmptyLibrary = computed(() => !prompts.loading && prompts.items.length === 0);
const isTrashEmpty = computed(() => prompts.quick === "trash" && prompts.trashItems.length === 0);
const emptyTitle = computed(() =>
  isEmptyLibrary.value ? "提示词库还是空的" : isTrashEmpty.value ? "回收站是空的" : "当前筛选下没有条目",
);
const emptyHint = computed(() =>
  isEmptyLibrary.value
    ? "去「优化提示词」把一句话改写成可复用的提示词，保存后就会出现在这里；也可以直接「新建」手写一条。"
    : isTrashEmpty.value
      ? `删除的条目会先进回收站，保留 ${prompts.cfg.trashDays} 天，期间可以还原。`
      : "换个关键词，或把左侧的分类 / 标签 / 来源和顶栏的筛选条件放宽一些。",
);

// ===== 筛选态操作 =====
function clearFilters() {
  prompts.query = "";
  prompts.quick = "all";
  prompts.category = "";
  prompts.tag = "";
  prompts.source = "all";
  prompts.chips = [];
}
function toggleChip(c: PromptChip) {
  const i = prompts.chips.indexOf(c);
  if (i >= 0) prompts.chips.splice(i, 1);
  else prompts.chips.push(c);
}
function toggleBatch() {
  prompts.batchMode = !prompts.batchMode;
  // 退出批量时清空选中：留着选中集合会让下次进批量时「凭空多出几条选中」
  if (!prompts.batchMode) prompts.selected = [];
}

// ===== 选中与批量 =====
const selectedSet = computed(() => new Set(prompts.selected));
function toggleSelect(id: string) {
  const i = prompts.selected.indexOf(id);
  if (i >= 0) prompts.selected.splice(i, 1);
  else prompts.selected.push(id);
}
const allSelected = computed(() => {
  const list = prompts.filtered;
  return list.length > 0 && list.every((i) => selectedSet.value.has(i.id));
});
function toggleSelectAll() {
  prompts.selected = allSelected.value ? [] : prompts.filtered.map((i) => i.id);
}
/** 回收站条的「全选」：顺手进批量模式，否则选了却没地方做批量动作 */
function selectAllTrash() {
  prompts.selected = prompts.trashItems.map((i) => i.id);
  prompts.batchMode = true;
}

/** 每条正文里的变量名（渲染前算一次）：
 *  卡片上要显示变量徽标，直接在模板里 parseVariables 会让每次重渲染都对全部条目重跑正则——
 *  列表上百条时这是明显的浪费，收成一个 computed 后只在库内容变化时算一次。 */
const varsOf = computed(() => {
  const m = new Map<string, string[]>();
  for (const it of prompts.filtered) m.set(it.id, parseVariables(it.body).map((v) => v.name));
  return m;
});

/**
 * 批量改条目（打标签 / 移动分类共用）：
 * 为什么不用 store.saveItem —— 它每条都会 loadLibrary(true)，批量 N 条就是 N 次全量重拉；
 * 这里逐条带 expectedHash 保存，结束后只重拉一次，并把冲突/失败分开计数后一次性汇报。
 */
async function batchMutate(ids: string[], mutate: (it: PromptItem) => void, okText: string) {
  let ok = 0;
  let conflict = 0;
  let fail = 0;
  for (const id of ids) {
    const it = prompts.items.find((x) => x.id === id);
    if (!it) continue;
    // 深拷贝再改：保存失败时不能把界面上的数据也改脏（乐观锁冲突就是要能回退）
    const payload: PromptItem = JSON.parse(JSON.stringify(it));
    mutate(payload);
    try {
      await pipc.promptsSave({ item: payload, expectedHash: it.hash });
      ok++;
    } catch (e) {
      if ((e as Error & { code?: string }).code === "conflict") conflict++;
      else fail++;
    }
  }
  prompts.selected = [];
  prompts.batchMode = false;
  await prompts.loadLibrary(true);
  if (ok) ElMessage.success(`${okText}（成功 ${ok} 条）`);
  if (conflict) ElMessage.warning(`${conflict} 条在保存前已被其它窗口/同步改动，本次跳过；可重试`);
  if (fail) ElMessage.error(`${fail} 条保存失败（详见提示词库目录是否可写）`);
  if (!ok && !conflict && !fail) ElMessage.info("没有可修改的条目");
}

async function batchTag() {
  let input = "";
  try {
    const r = await ElMessageBox.prompt("要追加的标签（逗号 / 空格分隔，与原有标签取并集）", "批量打标签", {
      inputPlaceholder: "写作, 邮件",
    });
    input = r.value || "";
  } catch { return; }
  const tags = parseTags(input);
  if (!tags.length) { ElMessage.warning("没有解析出标签"); return; }
  await batchMutate(prompts.selected.slice(), (it) => {
    it.tags = [...new Set([...(it.tags || []), ...tags])];
  }, `已为选中条目追加标签：${tags.join("、")}`);
}

async function batchMove() {
  let cat = "";
  try {
    const r = await ElMessageBox.prompt("目标分类（支持两级，如 写作/邮件；留空视为「未分类」）", "批量移动分类", {
      inputPlaceholder: prompts.cfg.defaultCategory,
    });
    cat = (r.value || "").trim();
  } catch { return; }
  const target = cat || prompts.cfg.defaultCategory;
  await batchMutate(prompts.selected.slice(), (it) => { it.category = target; }, `已移动到分类「${target}」`);
}

async function batchDelete() {
  const ids = prompts.selected.slice();
  if (!ids.length) { ElMessage.warning("先选中要删除的条目"); return; }
  try {
    await ElMessageBox.confirm(
      `把选中的 ${ids.length} 条移入回收站？回收站保留 ${prompts.cfg.trashDays} 天，期间可还原。`,
      "批量删除",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await pipc.promptsDelete({ id });
      ok++;
    } catch { fail++; }
  }
  prompts.selected = [];
  prompts.batchMode = false;
  await prompts.loadLibrary(true);
  if (ok) ElMessage.success(`已把 ${ok} 条移入回收站`);
  if (fail) ElMessage.error(`${fail} 条删除失败`);
}

// ===== 导出 =====
async function exportItems(ids: string[], format: "md" | "json") {
  if (!ids.length) { ElMessage.warning("先选中要导出的条目"); return; }
  try {
    const r = await pipc.promptsExport({ ids, format });
    ElMessage.success(`已导出 ${r.count} 条（${format}）到：${r.path}`);
  } catch (e) {
    ElMessage.error((e as Error).message || "导出失败");
  }
}

// ===== 单条保存（乐观锁）：改名 / 移动分类都走它 =====
/** force=true 表示用户已在冲突弹窗里选了「覆盖」：此时不再传 expectedHash（契约 §4.1 的 expectedHash 可省略） */
async function saveOne(payload: PromptItem, expectedHash: string | undefined, okText: string, force = false): Promise<boolean> {
  const r = await prompts.saveItem(payload, force ? undefined : expectedHash);
  if (r.ok) { ElMessage.success(okText); return true; }
  if (r.conflict) {
    try {
      await ElMessageBox.confirm(
        "内容已被修改（可能来自另一个窗口或刚完成的同步合并），是否覆盖？",
        "保存冲突",
        { confirmButtonText: "覆盖", cancelButtonText: "取消", type: "warning" },
      );
    } catch { return false; }
    return saveOne(payload, undefined, okText, true);
  }
  ElMessage.error(r.message || "保存失败");
  return false;
}

async function rename(it: PromptItem) {
  let name = "";
  try {
    const r = await ElMessageBox.prompt("新的名称（id 与文件路径不变，名称只存 frontmatter）", "重命名", {
      inputValue: it.name,
      inputPlaceholder: it.name,
    });
    name = (r.value || "").trim();
  } catch { return; }
  if (!name || name === it.name) return;
  const payload: PromptItem = JSON.parse(JSON.stringify(it));
  payload.name = name;
  await saveOne(payload, it.hash, `已重命名为「${name}」`);
}

async function moveCategory(it: PromptItem) {
  let cat = "";
  try {
    const r = await ElMessageBox.prompt("目标分类（支持两级，如 写作/邮件）", "移动分类", {
      inputValue: it.category || "",
      inputPlaceholder: prompts.cfg.defaultCategory,
    });
    cat = (r.value || "").trim();
  } catch { return; }
  const target = cat || prompts.cfg.defaultCategory;
  if (target === it.category) return;
  const payload: PromptItem = JSON.parse(JSON.stringify(it));
  payload.category = target;
  await saveOne(payload, it.hash, `已移动到分类「${target}」`);
}

/** 行内「复制正文」：复制即视为一次使用，否则「使用次数」排序永远没数据 */
async function copyBody(it: PromptItem) {
  const ok = await copyText(it.body, "正文");
  if (ok) void prompts.bumpUse(it);
}

/** 另存新版本：以当前内容**新建一条条目**，血缘指向本条。
 *  为什么不把新条目的版本号接着涨：版本号是「条目内」的修订序号，跨条目延续会出现
 *  「v7 但历史里只有一条」的自相矛盾；跨条目的关系交给 lineage.parentHash（详情页血缘可回溯）。 */
async function saveAsNewVersion(it: PromptItem) {
  const now = Date.now();
  const base: PromptItem = JSON.parse(JSON.stringify(it));
  const copy: PromptItem = {
    ...base,
    id: newId("p"),
    name: `${it.name}（副本）`,
    version: 1,
    versions: [{ version: 1, body: it.body, at: now, note: `另存自「${it.name}」v${it.version}`, by: "user" }],
    lineage: { ...(it.lineage || {}), parentHash: it.hash },
    favorite: false,
    useCount: 0,
    lastUsedAt: 0,
    hash: "",
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
  };
  const r = await prompts.saveItem(copy);
  if (!r.ok) { ElMessage.error(r.message || "另存失败"); return; }
  ElMessage.success(`已另存为新条目「${copy.name}」`);
}

async function removeOne(it: PromptItem) {
  try {
    await ElMessageBox.confirm(
      `把「${it.name}」移入回收站？保留 ${prompts.cfg.trashDays} 天内可还原。`,
      "删除提示词",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    await prompts.removeItem(it.id);
    ElMessage.success("已移入回收站");
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function restoreOne(it: PromptItem) {
  try {
    await prompts.restoreItem(it.id);
    ElMessage.success(`已还原「${it.name}」`);
  } catch (e) {
    ElMessage.error((e as Error).message || "还原失败");
  }
}

async function purgeOne(it: PromptItem) {
  try {
    await ElMessageBox.confirm(`彻底删除「${it.name}」？该操作不可恢复。`, "彻底删除", {
      confirmButtonText: "彻底删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch { return; }
  try {
    await prompts.purgeItem(it.id);
    ElMessage.success("已彻底删除");
  } catch (e) {
    ElMessage.error((e as Error).message || "彻底删除失败");
  }
}

async function emptyTrash() {
  const n = prompts.trashItems.length;
  if (!n) { ElMessage.info("回收站已经是空的"); return; }
  try {
    await ElMessageBox.confirm(`彻底删除回收站里的 ${n} 条？该操作不可恢复。`, "清空回收站", {
      confirmButtonText: "清空",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch { return; }
  try {
    const count = await prompts.emptyTrash();
    ElMessage.success(`已清空回收站（${count} 条）`);
  } catch (e) {
    ElMessage.error((e as Error).message || "清空失败");
  }
}

/** 行内「更多」菜单：命令名集中在一处分发，避免模板里写一堆 v-if */
function cardAction(it: PromptItem, cmd: string) {
  if (cmd === "rename") void rename(it);
  else if (cmd === "move") void moveCategory(it);
  else if (cmd === "export-md") void exportItems([it.id], "md");
  else if (cmd === "export-json") void exportItems([it.id], "json");
  else if (cmd === "restore") void restoreOne(it);
  else if (cmd === "purge") void purgeOne(it);
  else if (cmd === "delete") void removeOne(it);
}

/** 同步状态点：契约 §4 没有「单条同步状态」通道，用「条目最后修改时间 ≤ 上次同步时刻」推导（口径在 store）。
 *  冲突优先于同步状态显示——冲突是「需要人做决定」的事，不能被「已同步」的绿点盖掉。 */
function syncDot(it: PromptItem): { cls: string; title: string } {
  if (prompts.conflictIds.has(it.id)) return { cls: "bad", title: "有同步冲突待裁决" };
  const base = prompts.syncBaseAt;
  if (!base) return { cls: "", title: "尚未同步过（在「WebDAV 同步」页配置并同步后才有状态）" };
  return it.updatedAt <= base
    ? { cls: "ok", title: "已同步" }
    : { cls: "warn", title: "本地有改动，待下次同步上传" };
}

function openItem(it: PromptItem) {
  if (prompts.batchMode) { toggleSelect(it.id); return; }
  prompts.openDetail(it.id);
}
function goSync() { app.setPage("sync"); }

// ===== 新建 =====
const newOpen = ref(false);
const newForm = ref({ name: "", category: "", tags: "", description: "" });
function openNew() {
  newForm.value = { name: "", category: prompts.cfg.defaultCategory, tags: "", description: "" };
  newOpen.value = true;
}
async function doCreate() {
  const name = newForm.value.name.trim();
  if (!name) { ElMessage.warning("请填写名称"); return; }
  // 名称可重复（id 唯一），但要让用户知道会多出一条同名（与优化页保存到库同一口径）
  if (prompts.liveItems.some((i) => i.name === name)) {
    try {
      await ElMessageBox.confirm(`已存在同名条目「${name}」，仍要再建一条吗？`, "同名提示", {
        confirmButtonText: "仍然新建",
        cancelButtonText: "取消",
        type: "warning",
      });
    } catch { return; }
  }
  const now = Date.now();
  const item: PromptItem = {
    id: newId("p"),
    name,
    description: newForm.value.description,
    body: "",
    variables: [],
    category: newForm.value.category.trim() || prompts.cfg.defaultCategory,
    tags: parseTags(newForm.value.tags),
    source: "local",
    version: 1,
    // 新建即落一条「新建条目」版本：这样详情页的版本历史从第一条开始就是完整的，
    // 第一次保存正文时天然成为 v2，不需要为「空历史」写特殊分支
    versions: [{ version: 1, body: "", at: now, note: "新建条目", by: "user" }],
    favorite: false,
    useCount: 0,
    lastUsedAt: 0,
    hash: "",
    createdAt: now,
    updatedAt: now,
  };
  const r = await prompts.saveItem(item);
  if (!r.ok) { ElMessage.error(r.message || "新建失败"); return; }
  newOpen.value = false;
  // 直接进详情页写正文：库页没有正文编辑器，留着空条目让用户再点一次是多余的一步
  prompts.openDetail(r.id || item.id);
}

// ===== 导入 =====
const importOpen = ref(false);
const importForm = ref<{ format: "md" | "json"; onConflict: "new" | "overwrite" | "skip"; data: string; fileName: string }>({
  format: "md",
  onConflict: "new",
  data: "",
  fileName: "",
});
const fileInput = ref<HTMLInputElement | null>(null);
function pickFile() { fileInput.value?.click(); }
async function onFilePicked(e: Event) {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  if (!f) return;
  importForm.value.fileName = f.name;
  importForm.value.data = await f.text();
  importForm.value.format = /\.json$/i.test(f.name) ? "json" : "md";
  // 清空 value：否则再次选择同一个文件不会触发 change（浏览器认为值没变）
  el.value = "";
}
async function doImport() {
  const data = importForm.value.data.trim();
  if (!data) { ElMessage.warning("请粘贴内容或选择一个 .md / .json 文件"); return; }
  try {
    const r = await pipc.promptsImport({
      data,
      format: importForm.value.format,
      onConflict: importForm.value.onConflict,
    });
    ElMessage.success(`导入完成：新增 ${r.imported} · 覆盖 ${r.overwritten} · 跳过 ${r.skipped}`);
    importOpen.value = false;
    importForm.value = { format: "md", onConflict: "new", data: "", fileName: "" };
    await prompts.loadLibrary(true);
  } catch (e) {
    // §8.2 第 2 条：格式非法要「拒绝并说明支持格式」，所以这里把后端的 message 透出，再补一句支持范围
    ElMessage.error(`${(e as Error).message || "导入失败"}（仅支持本模块导出的 md / json）`);
  }
}

// ===== 库异常引导（§8.2 第 8、10 条）=====
async function openLibDir() {
  try {
    await pipc.promptsOpenDir();
  } catch (e) {
    ElMessage.error((e as Error).message || "打开库目录失败");
  }
}
async function rebuildLedger() {
  try {
    await ElMessageBox.confirm(
      "重建台账会扫描库目录下 items/*.md 重新入账（不会删除或改写你的文件）。确定继续？",
      "重建台账",
      { confirmButtonText: "重建", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    const r = await pipc.promptsRebuild();
    ElMessage.success(`重建完成，恢复 ${r.count} 条`);
    await prompts.loadLibrary(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "重建失败");
  }
}

// ===== 生命周期 =====
onMounted(async () => {
  // init() 只订阅一次主进程事件（契约 §4.4），库在别处被改（同步合并 / 优化页存库）时会自动刷新
  prompts.init();
  await prompts.loadLibrary();
});
</script>

<template>
  <div class="page prompts-scope">
    <!-- ===== 顶栏：状态 + 搜索 + 视图/排序 + 新建/导入/批量 ===== -->
    <div class="pr-card">
      <div class="pr-head">
        <p class="pr-sub">
          <span class="pr-dot" :class="prompts.error ? 'bad' : 'ok'"></span>
          <span>共 {{ prompts.liveItems.length }} 条 · 收藏 {{ chipCounts.favorite }} · 回收站 {{ prompts.trashItems.length }}</span>
          <span
            v-if="prompts.stats?.conflicts"
            class="pr-chip warn click"
            title="有同步冲突需要人工裁决，点此去同步页"
            @click="goSync"
          >待裁决 {{ prompts.stats?.conflicts }}</span>
          <span class="pr-hint">上次同步：{{ syncAt ? timeAgo(syncAt) : "从未同步" }}</span>
        </p>

        <div class="pr-head-actions">
          <input v-model="prompts.query" class="f-input" style="width: 208px" placeholder="搜索名称 / 正文 / 标签…" />
          <el-select v-model="prompts.sort" size="small" style="width: 124px">
            <el-option v-for="s in SORTS" :key="s.value" :value="s.value" :label="s.label" />
          </el-select>
          <button
            class="btn btn-ghost btn-sm"
            :title="prompts.view === 'card' ? '切换为列表视图' : '切换为卡片视图'"
            @click="prompts.view = prompts.view === 'card' ? 'list' : 'card'"
          >
            <i :class="prompts.view === 'card' ? 'ph ph-list' : 'ph ph-squares-four'"></i>{{ prompts.view === "card" ? "列表" : "卡片" }}
          </button>
          <button class="btn btn-ghost btn-sm" :class="{ 'btn-outline': prompts.batchMode }" @click="toggleBatch">
            <i class="ph ph-checks"></i>批量
          </button>
          <button class="btn btn-ghost btn-sm" @click="importOpen = true"><i class="ph ph-upload-simple"></i>导入</button>
          <button class="btn btn-cta btn-sm" @click="openNew"><i class="ph ph-plus"></i>新建</button>
        </div>
      </div>

      <div class="pr-row" style="margin-top: 10px">
        <span
          v-for="c in CHIPS"
          :key="c.key"
          class="pr-chip click"
          :class="{ accent: prompts.chips.includes(c.key) }"
          :title="`${c.label}：${chipCounts[c.key]} 条（可多选，与左侧条件同时生效）`"
          @click="toggleChip(c.key)"
        >{{ c.label }} {{ chipCounts[c.key] }}</span>
        <span v-if="hasFilter" class="pr-chip click danger" @click="clearFilters">
          <i class="ph ph-funnel-simple-x"></i>清空筛选
        </span>
      </div>
    </div>

    <!-- ===== 库不可用（§8.2 第 8、10 条）：先把「怎么救回来」摆出来，再谈列表 ===== -->
    <div v-if="prompts.error" class="pr-card">
      <div class="pr-empty">
        <i class="ph ph-warning-circle"></i>
        <div class="es-title">提示词库读取失败</div>
        <div>{{ prompts.error }}</div>
        <div class="pr-row" style="margin-top: 8px; justify-content: center">
          <button class="btn btn-ghost btn-sm" @click="prompts.loadLibrary(true)">重试</button>
          <button class="btn btn-ghost btn-sm" @click="openLibDir">打开库目录</button>
          <button class="btn btn-ghost btn-sm" @click="rebuildLedger">重建台账</button>
        </div>
        <div class="pr-hint" style="margin-top: 6px">
          库目录被手工移动 / 删除时，请先在「配置 · 提示词库」重新指定目录；manifest.json 损坏时「重建台账」会扫描
          items/ 下的条目文件重新入账（不会丢文件）。
        </div>
      </div>
    </div>

    <!-- ===== 左栏 + 主区 ===== -->
    <div v-else class="pr-lib">
      <!-- 左栏 -->
      <div class="pr-aside">
        <div class="pr-card" style="padding: 12px 14px">
          <div class="pr-aside-group">
            <div class="pr-aside-title">快捷入口</div>
            <div
              v-for="q in quickEntries"
              :key="q.key"
              class="pr-nav-item"
              :class="{ on: prompts.quick === q.key }"
              @click="prompts.quick = q.key"
            >
              <i :class="'ph ' + q.icon"></i>{{ q.label }}<span class="n">{{ q.count }}</span>
            </div>
          </div>

          <div class="pr-aside-group" style="margin-top: 12px">
            <div class="pr-aside-title">分类</div>
            <div class="pr-nav-item" :class="{ on: !prompts.category }" @click="prompts.category = ''">
              <i class="ph ph-folders"></i>全部分类<span class="n">{{ prompts.liveItems.length }}</span>
            </div>
            <template v-for="node in prompts.categoryTree" :key="node.parent">
              <div
                class="pr-nav-item"
                :class="{ on: prompts.category === node.parent }"
                @click="prompts.category = prompts.category === node.parent ? '' : node.parent"
              >
                <i class="ph ph-folder"></i>{{ node.parent }}<span class="n">{{ node.count }}</span>
              </div>
              <div
                v-for="child in node.children"
                :key="child.path"
                class="pr-nav-item child"
                :class="{ on: prompts.category === child.path }"
                @click="prompts.category = prompts.category === child.path ? '' : child.path"
              >
                <i class="ph ph-folder-open"></i>{{ child.name }}<span class="n">{{ child.count }}</span>
              </div>
            </template>
            <div v-if="!prompts.categoryTree.length" class="pr-hint">还没有条目，所以没有分类</div>
          </div>

          <div class="pr-aside-group" style="margin-top: 12px">
            <div class="pr-aside-title">标签</div>
            <div v-if="prompts.tagCounts.length" class="pr-tagcloud">
              <span
                v-for="t in prompts.tagCounts"
                :key="t.name"
                class="pr-chip click"
                :class="{ accent: prompts.tag === t.name }"
                @click="prompts.tag = prompts.tag === t.name ? '' : t.name"
              >{{ t.name }} {{ t.count }}</span>
            </div>
            <div v-else class="pr-hint">还没有标签（保存条目时可以填，或批量打标签）</div>
          </div>

          <div class="pr-aside-group" style="margin-top: 12px">
            <div class="pr-aside-title">来源</div>
            <div
              v-for="s in sourceEntries"
              :key="s.key"
              class="pr-nav-item"
              :class="{ on: prompts.source === s.key }"
              @click="prompts.source = s.key"
            >
              <i class="ph ph-git-branch"></i>{{ s.label }}<span class="n">{{ s.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 主区 -->
      <div class="pr-col">
        <!-- 回收站专用条：回收站是「危险区」，把还原/清空集中在一处，避免误点卡片上的删除 -->
        <div v-if="prompts.quick === 'trash'" class="pr-bulkbar">
          <i class="ph ph-trash"></i>
          <span>回收站内 {{ prompts.trashItems.length }} 条 · 保留 {{ prompts.cfg.trashDays }} 天，过期由后端清理</span>
          <span class="pr-inline-ctl">
            <button class="btn btn-ghost btn-sm" :disabled="!prompts.trashItems.length" @click="selectAllTrash">
              全选
            </button>
            <button class="btn btn-outline danger btn-sm" :disabled="!prompts.trashItems.length" @click="emptyTrash">
              清空回收站
            </button>
          </span>
        </div>

        <!-- 批量操作条 -->
        <div v-if="prompts.batchMode" class="pr-bulkbar">
          <i class="ph ph-checks"></i>
          <span>已选 {{ prompts.selected.length }} / {{ prompts.filtered.length }} 条</span>
          <button class="btn btn-ghost btn-sm" @click="toggleSelectAll">{{ allSelected ? "取消全选" : "全选当前筛选" }}</button>
          <span class="pr-inline-ctl">
            <button class="btn btn-ghost btn-sm" :disabled="!prompts.selected.length" @click="exportItems(prompts.selected.slice(), 'md')">导出 md</button>
            <button class="btn btn-ghost btn-sm" :disabled="!prompts.selected.length" @click="exportItems(prompts.selected.slice(), 'json')">导出 json</button>
            <button class="btn btn-ghost btn-sm" :disabled="!prompts.selected.length" @click="batchTag">打标签</button>
            <button class="btn btn-ghost btn-sm" :disabled="!prompts.selected.length" @click="batchMove">移动分类</button>
            <button class="btn btn-outline danger btn-sm" :disabled="!prompts.selected.length" @click="batchDelete">批量删除</button>
            <button class="btn btn-ghost btn-sm" @click="toggleBatch">退出批量</button>
          </span>
        </div>

        <!-- 加载中 -->
        <div v-if="prompts.loading && !prompts.items.length" class="pr-card">
          <div class="pr-empty"><i class="ph ph-circle-notch"></i><div>正在读取提示词库…</div></div>
        </div>

        <!-- 空态：三种情形给三种下一步（见 emptyTitle / emptyHint 的注释） -->
        <div v-else-if="!prompts.filtered.length" class="pr-card">
          <div class="pr-empty">
            <i class="ph" :class="isEmptyLibrary ? 'ph-bookmark-simple' : isTrashEmpty ? 'ph-trash' : 'ph-magnifying-glass'"></i>
            <div class="es-title">{{ emptyTitle }}</div>
            <div>{{ emptyHint }}</div>
            <div class="pr-row" style="margin-top: 8px; justify-content: center">
              <button v-if="isEmptyLibrary" class="btn btn-cta btn-sm" @click="app.setPage('optimize')">
                <i class="ph ph-magic-wand"></i>去「优化提示词」生成第一条
              </button>
              <button v-if="isEmptyLibrary" class="btn btn-ghost btn-sm" @click="openNew">直接新建一条</button>
              <button v-if="isTrashEmpty" class="btn btn-ghost btn-sm" @click="prompts.quick = 'all'">回到全部条目</button>
              <button v-if="!isEmptyLibrary && !isTrashEmpty && hasFilter" class="btn btn-ghost btn-sm" @click="clearFilters">
                <i class="ph ph-funnel-simple-x"></i>一键清空筛选
              </button>
            </div>
          </div>
        </div>

        <!-- 卡片 / 列表 -->
        <div v-else class="pr-grid" :class="{ 'is-list': prompts.view === 'list' }">
          <div
            v-for="it in prompts.filtered"
            :key="it.id"
            class="pr-item"
            :class="{ 'is-picked': selectedSet.has(it.id) }"
            @click="openItem(it)"
          >
            <div class="t-head">
              <input
                v-if="prompts.batchMode"
                type="checkbox"
                :checked="selectedSet.has(it.id)"
                title="选中该条"
                @click.stop="toggleSelect(it.id)"
              />
              <span
                v-else
                class="pr-dot"
                :class="it.deletedAt ? 'bad' : syncDot(it).cls"
                :title="it.deletedAt ? '在回收站里（还原后才参与同步）' : syncDot(it).title"
              ></span>
              <span class="t-name" :title="it.name">{{ it.name }}</span>
              <span class="pr-chip" :class="SOURCE_CLS[it.source]">{{ SOURCE_LABEL[it.source] }}</span>
              <span v-if="prompts.conflictIds.has(it.id)" class="pr-chip warn">待裁决</span>
              <span v-if="it.deletedAt" class="pr-chip danger">回收站</span>
              <span class="pr-inline-ctl">
                <span v-if="it.favorite" class="pr-chip accent" title="已收藏"><i class="ph ph-star"></i></span>
                <span v-if="it.pinned" class="pr-chip" title="已置顶"><i class="ph ph-push-pin"></i></span>
              </span>
            </div>

            <div class="t-desc">{{ summaryOf(it.body) || "（正文为空，点「编辑」写正文）" }}</div>

            <div v-if="(it.tags || []).length" class="pr-row">
              <span
                v-for="t in it.tags"
                :key="t"
                class="pr-chip click"
                :class="{ accent: prompts.tag === t }"
                @click.stop="prompts.tag = prompts.tag === t ? '' : t"
              >{{ t }}</span>
            </div>

            <div v-if="(varsOf.get(it.id) || []).length" class="pr-row">
              <span class="pr-hint">变量</span>
              <span v-for="n in (varsOf.get(it.id) || []).slice(0, 6)" :key="n" class="pr-chip info">{{ n }}</span>
              <span v-if="(varsOf.get(it.id) || []).length > 6" class="pr-hint">…共 {{ (varsOf.get(it.id) || []).length }} 个</span>
            </div>

            <div class="t-meta">
              <span>{{ it.category || "未分类" }}</span>
              <span>v{{ it.version }}</span>
              <span>使用 {{ it.useCount || 0 }} 次</span>
              <span :title="'创建于 ' + new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false })">
                更新 {{ timeAgo(it.updatedAt) }}
              </span>
              <span class="pr-mono" :title="'内容哈希：' + (it.hash || '（未落盘）')">{{ (it.hash || "—").slice(0, 8) }}</span>
            </div>

            <div class="t-foot">
              <template v-if="it.deletedAt">
                <button class="btn btn-ghost btn-sm" @click.stop="restoreOne(it)">还原</button>
                <button class="btn btn-outline danger btn-sm" @click.stop="purgeOne(it)">彻底删除</button>
                <button class="btn btn-ghost btn-sm" @click.stop="openItem(it)">查看</button>
              </template>
              <template v-else>
                <button class="btn btn-ghost btn-sm" @click.stop="prompts.openDetail(it.id)">编辑</button>
                <button class="btn btn-ghost btn-sm" :disabled="!it.body" @click.stop="copyBody(it)">复制正文</button>
                <button class="btn btn-ghost btn-sm" @click.stop="saveAsNewVersion(it)">另存新版本</button>
                <button class="btn btn-ghost btn-sm" @click.stop="prompts.toggleFavorite(it)">
                  {{ it.favorite ? "取消收藏" : "收藏" }}
                </button>
                <!-- 不能在 el-dropdown 内再套 el-tooltip（EP 的 dropdown 本身用 tooltip 机制管触发器） -->
                <el-dropdown trigger="click" style="margin-left: auto" @command="(c: string) => cardAction(it, c)">
                  <span class="btn btn-ghost btn-sm" @click.stop>更多<i class="ph ph-caret-down"></i></span>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="rename">重命名</el-dropdown-item>
                      <el-dropdown-item command="move">移动分类</el-dropdown-item>
                      <el-dropdown-item command="export-md">导出 md</el-dropdown-item>
                      <el-dropdown-item command="export-json">导出 json</el-dropdown-item>
                      <el-dropdown-item command="delete" divided>删除（移入回收站）</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 新建 ===== -->
    <el-dialog v-model="newOpen" title="新建提示词" width="520px">
      <div class="pr-col">
        <label style="display: block">名称<input v-model="newForm.name" class="f-input" style="width: 100%" placeholder="例如：周报生成器" /></label>
        <label style="display: block">
          分类<input v-model="newForm.category" class="f-input" style="width: 100%" placeholder="支持两级，如 写作/邮件" />
        </label>
        <label style="display: block">标签（逗号或空格分隔）<input v-model="newForm.tags" class="f-input" style="width: 100%" placeholder="写作, 日报" /></label>
        <label style="display: block">备注<textarea v-model="newForm.description" class="pr-area" style="min-height: 64px" placeholder="这条提示词是干什么用的（会显示在搜索与卡片摘要里）"></textarea></label>
        <div class="pr-hint">保存后会直接进入详情页写正文；正文里的 <code>{{ VAR_SAMPLE }}</code> 会被自动识别为变量。</div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="newOpen = false">取消</button>
        <button class="btn btn-cta" @click="doCreate">创建并编辑</button>
      </template>
    </el-dialog>

    <!-- ===== 导入（§8.2 第 1、2 条）===== -->
    <el-dialog v-model="importOpen" title="导入提示词" width="620px">
      <div class="pr-col">
        <div class="pr-row">
          <span class="pr-hint">格式</span>
          <el-select v-model="importForm.format" size="small" style="width: 110px">
            <el-option value="md" label="Markdown" />
            <el-option value="json" label="JSON" />
          </el-select>
          <span class="pr-hint">同名条目</span>
          <el-select v-model="importForm.onConflict" size="small" style="width: 168px">
            <el-option value="new" label="新建副本（全部应用）" />
            <el-option value="overwrite" label="覆盖已有（全部应用）" />
            <el-option value="skip" label="跳过已有（全部应用）" />
          </el-select>
          <button class="btn btn-ghost btn-sm" @click="pickFile"><i class="ph ph-file-arrow-up"></i>选择文件</button>
          <span v-if="importForm.fileName" class="pr-mono">{{ importForm.fileName }}</span>
        </div>
        <textarea
          v-model="importForm.data"
          class="pr-area"
          style="min-height: 200px"
          placeholder="粘贴要导入的内容（本模块导出的 md / json）"
        ></textarea>
        <div class="pr-hint">
          支持本模块导出的两种格式：md（frontmatter + 正文，可含多条）与 json（条目数组）。格式非法会被拒绝并说明原因。
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="importOpen = false">取消</button>
        <button class="btn btn-cta" :disabled="!importForm.data.trim()" @click="doImport">开始导入</button>
      </template>
    </el-dialog>

    <!-- 隐藏的文件选择器：读文件内容走浏览器 File API，不需要新增 IPC（契约 §4 只有 prompts_import 收 data 字符串） -->
    <input ref="fileInput" type="file" accept=".md,.json,.txt" style="display: none" @change="onFilePicked" />
  </div>
</template>
