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
  提示词库 · 提示词详情 / 编辑器（方案总纲 §3.3，隐藏页 `prompt-detail`）：
  顶部（名称 / 分类 / 标签 / 收藏 / 保存 / 另存为新条目）
  → 左列（正文编辑 + 变量面板 + 成品预览 + 版本历史与 diff 与回滚）
  → 右列（元信息与血缘 + 同步信息 + 删除）。

  页面不接收 props：目标条目 id 走 store 的 detailId（与记忆中枢 detailDrawerId 同款做法），
  因为详情页是「从库页点进来」的隐藏页，用 props 会逼着 App.vue 多传一层。

  §8.2 中本页负责落地的边界：
    5  单条过大（> config.prompts.itemMaxKB）→ 保存前用 UTF-8 字节数判一次，直接拒绝并说明
    6  变量未闭合 `{{` → 顶部内联高亮提示，但允许忽略后照常保存
    16 并发编辑（两窗口）→ 保存一律带 expectedHash 乐观锁；code==="conflict" 时问「内容已被修改，是否覆盖」
  另外 §3.5「同步自动合并放弃的那份不丢」：这类版本 by==="sync-merge"，本页版本列表单独标注，
  且回滚只新增版本、绝不裁剪历史（裁剪留给后端，只有它知道哪些版本来自自动合并）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { usePromptsStore } from "../../stores/prompts";
import type { PromptItem, PromptVersion } from "./promptTypes";
import {
  applyVariables, charCount, copyText, estimateTokens, hasUnclosedVariable, newId,
  parseTags, parseVariables, stripZeroWidth, unifiedDiff,
} from "./promptUtil";
import { formatDateTime, timeAgo } from "../../composables/useFormat";
import { sideBySideDiff, type DiffLine } from "../../utils/diff";

const app = useAppStore();
const prompts = usePromptsStore();

/** 来源文案与库页保持一致（两处各一份是有意的：这是纯展示映射，抽公共文件反而要改别人的写入范围） */
const SOURCE_LABEL: Record<PromptItem["source"], string> = {
  local: "本地创建",
  optimized: "优化生成",
  online: "线上",
  imported: "导入",
};

/** 并排 diff 最多渲染多少行：提示词上千行很常见，全量渲染会让滚动与选中明显变卡 */
const DIFF_MAX_ROWS = 300;

/** 要在界面上显示「变量占位符」字面量时的唯一出口。
 *  为什么不能直接在插值里写 `{{ "{{x}}" }}`：Vue 的插值解析器遇到第一个 `}}` 就结束（它不认字符串），
 *  会把表达式截成 `"{{x` 这样的非法 JS，真实编译器（@vue/compiler-sfc / vite build）会直接报
 *  "Unterminated string constant" —— 所以字面量只能放在脚本常量里，模板只插值常量名。 */
const VAR_SAMPLE = "{{变量名}}";
const VAR_SAMPLE_EN = "{{name}}";
const VAR_SAMPLE_CN = "{{主题}}";
const OPEN_BRACES = "{{";

// ===== 草稿 =====
// 为什么用「深拷贝草稿」而不是直接编辑 store 里的条目：
//   乐观锁的前提是「磁盘上的版本」与「编辑器里的版本」是两份东西；直接改 store 会让
//   冲突提示失去意义（磁盘内容已经被本地改动覆盖了，用户看不到到底差在哪）。
const draft = ref<PromptItem | null>(null);
/** 载入/上次保存成功时的内容哈希：保存时作为 expectedHash 传下去（契约 §4.1 乐观锁） */
const loadedHash = ref("");
/** 载入/上次保存成功时的可编辑字段快照（JSON 字符串）：用来判断「有没有未保存的修改」 */
const baseline = ref("");
const tagInput = ref("");
/** 版本备注：保存时写进新版本的 note，用户不用回头补 */
const saveNote = ref("");
const lineageOpen = ref(false);

/** 参与「脏检查」的字段：favorite 不在其中——收藏走 store 的即时切换（点了立刻生效并落盘），
 *  把它算进草稿会让「点一下收藏」变成「有未保存修改」，这是假信号。 */
function snapshotOf(d: PromptItem): string {
  return JSON.stringify({
    name: d.name, description: d.description, body: d.body,
    variables: d.variables, category: d.category, tags: d.tags,
  });
}

const storeItem = computed(() => prompts.detailItem);
const readOnly = computed(() => !!draft.value?.deletedAt);
const dirty = computed(() => !!draft.value && snapshotOf(draft.value) !== baseline.value);

function loadDraft() {
  const it = prompts.detailItem;
  if (!it) {
    draft.value = null;
    loadedHash.value = "";
    baseline.value = "";
    return;
  }
  const copy: PromptItem = JSON.parse(JSON.stringify(it));
  draft.value = copy;
  tagInput.value = (copy.tags || []).join(", ");
  loadedHash.value = copy.hash || "";
  baseline.value = snapshotOf(copy);
  saveNote.value = "";
  diffVersion.value = null;
  lineageOpen.value = false;
}

/** 标签输入 → 草稿：标签是「逗号/空格/顿号混用」的自由输入，解析口径复用 promptUtil.parseTags */
watch(tagInput, (v) => { if (draft.value) draft.value.tags = parseTags(v); });

/** 正文 → 变量表：以正文为准重建（占位符被删掉后，变量面板里那条已经是死配置，留着只会误导）。
 *  同名变量的说明/默认值/必填会被保留，所以改正文不会丢掉已经填好的变量说明。 */
watch(() => draft.value?.body, (body) => {
  const d = draft.value;
  if (!d) return;
  const known = new Map((d.variables || []).map((v) => [v.name, v]));
  d.variables = parseVariables(body || "").map((p) => known.get(p.name) ?? p);
});

// ===== 统计与预览 =====
const bodyChars = computed(() => charCount(draft.value?.body || ""));
const bodyTokens = computed(() => estimateTokens(draft.value?.body || ""));
/** §8.2 第 5 条：单条过大直接拒绝保存。用 Blob 算 UTF-8 字节数，与后端按文件大小的口径一致 */
const bodyBytes = computed(() => new Blob([draft.value?.body || ""]).size);
const overSize = computed(() => bodyBytes.value > prompts.cfg.itemMaxKB * 1024);
const unclosedVar = computed(() => hasUnclosedVariable(draft.value?.body || ""));
const preview = computed(() => applyVariables(draft.value?.body || "", draft.value?.variables || []));
const previewChars = computed(() => charCount(preview.value));

/** 变量在正文里出现几次：让用户知道改一个默认值会影响几处 */
function occurrences(name: string): number {
  const body = draft.value?.body || "";
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (body.match(new RegExp(`\\{\\{\\s*${safe}\\s*\\}\\}`, "g")) || []).length;
}

// ===== 版本历史 =====
/** 倒序：最近改的排最上面，用户最常看的是「上一版」 */
const versionsDesc = computed(() => [...(draft.value?.versions || [])].sort((a, b) => b.version - a.version || b.at - a.at));

const diffVersion = ref<number | null>(null);
const diffMode = ref<"side" | "unified">("side");
const diffRows = ref<{ left: DiffLine | null; right: DiffLine | null }[]>([]);
const diffUnified = ref<{ text: string; add: number; del: number }>({ text: "", add: 0, del: 0 });
let diffTimer: number | null = null;

const diffBase = computed<PromptVersion | null>(() => {
  if (diffVersion.value === null) return null;
  return (draft.value?.versions || []).find((v) => v.version === diffVersion.value) || null;
});

function computeDiff() {
  const base = diffBase.value;
  const d = draft.value;
  if (!base || !d) {
    diffRows.value = [];
    diffUnified.value = { text: "", add: 0, del: 0 };
    return;
  }
  // 复用 utils/diff 的 LCS：左侧=历史版本，右侧=当前编辑器（未保存的改动也能对比，这正是用户想要的）
  const { left, right } = sideBySideDiff(base.body || "", d.body || "");
  diffRows.value = left.slice(0, DIFF_MAX_ROWS).map((l, i) => ({ left: l, right: right[i] || null }));
  diffUnified.value = unifiedDiff(base.body || "", d.body || "");
}
/** 逐键重算 LCS 在长正文上会明显掉帧，所以正文改动合并到 300ms 之后算一次 */
function scheduleDiff() {
  if (diffTimer !== null) window.clearTimeout(diffTimer);
  diffTimer = window.setTimeout(() => { diffTimer = null; computeDiff(); }, 300);
}
function toggleDiff(v?: PromptVersion) {
  if (v) diffVersion.value = diffVersion.value === v.version ? null : v.version;
  else diffVersion.value = diffVersion.value === null ? (versionsDesc.value[0]?.version ?? null) : null;
  computeDiff(); // 立即算一次，避免用户先看到 300ms 的空白
}
watch(diffVersion, () => computeDiff());
watch(() => draft.value?.body, scheduleDiff);
onUnmounted(() => { if (diffTimer !== null) window.clearTimeout(diffTimer); });

// ===== 保存（乐观锁）=====
/** 组保存载荷：只有正文变了才涨版本号 —— 改名称/标签/分类不该占用版本额度（默认只留 20 条）。 */
function buildPayload(d: PromptItem): PromptItem {
  const now = Date.now();
  const versions: PromptVersion[] = (d.versions || []).map((v) => ({ ...v }));
  const last = versions.length ? versions[versions.length - 1] : null;
  const note = saveNote.value.trim();
  let version = d.version || 1;
  if (!last) {
    // 导入或旧数据可能没有版本历史：直接以当前版本号补一条，避免出现「第一条历史却是 v2」
    versions.push({ version, body: d.body, at: now, note: note || "首次保存", by: "user" });
  } else if (last.body !== d.body) {
    version = Math.max(d.version || 0, last.version) + 1;
    versions.push({ version, body: d.body, at: now, note: note || undefined, by: "user" });
  } else {
    version = Math.max(d.version || 0, last.version);
  }
  // 不在前端裁剪版本数组：§8.2 第 4 条要求「同步自动合并产生的版本优先保留」，
  // 只有后端知道哪些版本是 sync-merge 来的，裁剪必须由后端做（前端裁了会先删掉那些版本）。
  return {
    ...d,
    name: (d.name || "").trim(),
    description: d.description || "",
    body: d.body || "",
    variables: d.variables || [],
    category: (d.category || "").trim() || prompts.cfg.defaultCategory,
    tags: d.tags || [],
    version,
    versions,
    // 收藏以 store（磁盘侧）为准：详情页的收藏是即时切换的，草稿里那份可能已经过期
    favorite: prompts.detailItem?.favorite ?? d.favorite,
    hash: loadedHash.value || d.hash || "",
    updatedAt: now,
  };
}

async function save(force = false) {
  const d = draft.value;
  if (!d) return;
  if (d.deletedAt) { ElMessage.warning("该条目在回收站里，先「还原到库」再编辑"); return; }
  if (!(d.name || "").trim()) { ElMessage.warning("请填写名称"); return; }

  // §8.1 第 6 条：零宽字符肉眼不可见，却会让模型把「一个词」当成两个 token；
  // 写回草稿是为了让「编辑器里看到的」与「磁盘上存的」始终一致（否则下次打开会莫名其妙变样）。
  const cleanedBody = stripZeroWidth(d.body || "");
  const cleanedName = stripZeroWidth(d.name || "");
  if (cleanedBody !== d.body || cleanedName !== d.name) {
    d.body = cleanedBody;
    d.name = cleanedName;
    ElMessage.info("已清除正文/名称里的零宽字符（肉眼不可见，但会影响模型分词）");
  }
  if (overSize.value) {
    ElMessage.error(`正文 ${Math.round(bodyBytes.value / 1024)} KB，超过单条上限 ${prompts.cfg.itemMaxKB} KB，已拒绝保存（请拆分或精简）`);
    return;
  }
  // §8.2 第 6 条：未闭合的 `{{` 只提示、不阻断（用户可能正写到一半，强制拦截反而碍事）
  if (hasUnclosedVariable(d.body)) {
    ElMessage.warning("正文里有未闭合的 {{ 变量占位符，本次仍会保存；成品预览会按原文保留");
  }

  const payload = buildPayload(d);
  const r = await prompts.saveItem(payload, force ? undefined : (loadedHash.value || undefined));
  if (r.ok) {
    // 保存成功后把「刚写进去的那一版」同步回草稿：否则下一次保存会以旧的 versions 计算版本号，产生重号
    d.version = payload.version;
    d.versions = payload.versions;
    d.updatedAt = payload.updatedAt;
    d.body = payload.body;
    d.name = payload.name;
    d.category = payload.category;
    loadedHash.value = r.hash || "";
    baseline.value = snapshotOf(d);
    saveNote.value = "";
    ElMessage.success(`已保存（v${payload.version}）`);
    return;
  }
  if (r.conflict) {
    // §8.2 第 16 条：磁盘 hash 与 expectedHash 不匹配 = 内容已被其它窗口或同步改过
    let overwrite = false;
    try {
      await ElMessageBox.confirm(
        "内容已被修改（可能来自另一个窗口，或刚完成的同步合并），是否覆盖？\n"
        + "选「覆盖」会用当前编辑器里的内容写盘；选「取消」会保留磁盘上的版本，建议先复制正文再决定。",
        "内容已被修改，是否覆盖？",
        { confirmButtonText: "覆盖", cancelButtonText: "取消", type: "warning" },
      );
      overwrite = true;
    } catch { overwrite = false; }
    if (overwrite) await save(true);
    return;
  }
  ElMessage.error(r.message || "保存失败");
}

/** 回滚 = 新增一个版本（方案 §3.3）：把历史正文写回编辑器后立即保存，原历史一条不少 */
async function rollback(v: PromptVersion) {
  const d = draft.value;
  if (!d) return;
  try {
    await ElMessageBox.confirm(
      `回滚到 v${v.version}（${formatDateTime(v.at, true)}）？\n`
      + "回滚不会删除任何历史：它把这一版正文写回编辑器，保存后成为新的一版。",
      "回滚版本",
      { confirmButtonText: "回滚并保存", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  d.body = v.body;
  saveNote.value = `回滚到 v${v.version}`;
  await save();
}

// ===== 成品预览 =====
async function copyPreview() {
  const s = storeItem.value;
  const ok = await copyText(preview.value, "成品提示词");
  // 注意：这里必须传 store 里的条目对象，不能传草稿——bumpUse 会把整条条目存盘，
  // 传草稿等于把「编辑器里还没保存的改动」顺手写进磁盘，绕过用户的保存动作。
  if (ok && s) void prompts.bumpUse(s);
}

// ===== 另存为新条目 =====
/** 以当前编辑器内容派生一条新条目（含未保存的改动）：这是「想保留现在这版又不想动原条目」的出口 */
async function saveAsNew() {
  const d = draft.value;
  if (!d) return;
  if (overSize.value) { ElMessage.error("正文超过单条上限，已拒绝另存"); return; }
  const now = Date.now();
  const base: PromptItem = JSON.parse(JSON.stringify(d));
  const payload: PromptItem = {
    ...base,
    id: newId("p"),
    name: `${(d.name || "").trim() || "未命名"}（副本）`,
    // 版本号是「条目内」的修订序号，跨条目延续会出现「v7 但历史里只有一条」的自相矛盾；
    // 跨条目的关系交给 lineage.parentHash（右栏「血缘 · 父条目」可回溯）
    version: 1,
    versions: [{ version: 1, body: d.body, at: now, note: `另存自「${d.name}」v${d.version}`, by: "user" }],
    lineage: { ...(d.lineage || {}), parentHash: loadedHash.value || d.hash },
    favorite: false,
    useCount: 0,
    lastUsedAt: 0,
    hash: "",
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
  };
  const r = await prompts.saveItem(payload);
  if (!r.ok) { ElMessage.error(r.message || "另存失败"); return; }
  ElMessage.success(`已另存为新条目「${payload.name}」`);
  prompts.openDetail(r.id || payload.id);
}

// ===== 收藏 / 删除 / 还原 / 彻底删除 =====
function toggleFav() {
  const s = storeItem.value;
  if (s) void prompts.toggleFavorite(s);
}

async function removeItem() {
  const s = storeItem.value;
  if (!s) return;
  try {
    await ElMessageBox.confirm(
      `把「${s.name}」移入回收站？保留 ${prompts.cfg.trashDays} 天内可还原。`
      + (dirty.value ? "\n（编辑器里还有未保存的修改，会一并丢弃）" : ""),
      "删除提示词",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    await prompts.removeItem(s.id);
    prompts.closeDetail();
    app.setPage("library");
    ElMessage.success("已移入回收站");
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function restoreItem() {
  const s = storeItem.value;
  if (!s) return;
  try {
    await prompts.restoreItem(s.id);
    // 草稿是深拷贝：还原后必须同步清掉 deletedAt，否则只读态与「在回收站」提示会一直挂着
    if (draft.value) draft.value.deletedAt = undefined;
    ElMessage.success(`已还原「${s.name}」`);
  } catch (e) {
    ElMessage.error((e as Error).message || "还原失败");
  }
}

async function purgeItem() {
  const s = storeItem.value;
  if (!s) return;
  try {
    await ElMessageBox.confirm(`彻底删除「${s.name}」？该操作不可恢复。`, "彻底删除", {
      confirmButtonText: "彻底删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch { return; }
  try {
    await prompts.purgeItem(s.id);
    prompts.closeDetail();
    app.setPage("library");
    ElMessage.success("已彻底删除");
  } catch (e) {
    ElMessage.error((e as Error).message || "彻底删除失败");
  }
}

// ===== 返回 =====
async function back() {
  // 未保存的修改是用户的劳动成果：离开前必须问一次（不做静默丢弃）
  if (dirty.value) {
    try {
      await ElMessageBox.confirm("编辑器里有未保存的修改，返回库页会丢弃这些修改。确定返回？", "未保存的修改", {
        confirmButtonText: "丢弃并返回",
        cancelButtonText: "继续编辑",
        type: "warning",
      });
    } catch { return; }
  }
  app.setPage("library");
}

// ===== 元信息 / 血缘 / 同步 =====
const hasLineage = computed(() => {
  const l = draft.value?.lineage;
  return !!(l && (l.parentHash || l.styleId || l.model || l.inputText));
});
/** 父条目：血缘存的是父条目的内容 hash（契约 §3），拿它在库里反查；查不到说明父条目已被删除 */
const parentItem = computed(() => {
  const h = draft.value?.lineage?.parentHash;
  if (!h) return null;
  return prompts.items.find((i) => i.hash === h && i.id !== draft.value?.id) || null;
});
const styleName = computed(() => {
  const id = draft.value?.lineage?.styleId;
  if (!id) return "";
  return prompts.styleById(id)?.name || id;
});
const conflict = computed(() => prompts.conflicts.find((c) => c.id === draft.value?.id && !c.resolved) || null);
const syncState = computed<{ cls: string; text: string }>(() => {
  const d = draft.value;
  if (!d) return { cls: "", text: "" };
  // 冲突优先于一切：它是「需要人做决定」的事，不能被「已同步」的绿点盖掉
  if (conflict.value) return { cls: "bad", text: "有冲突待裁决：本地与远端的改动都要你决定保留哪一份" };
  if (dirty.value) return { cls: "warn", text: "编辑器里有未保存的修改，保存后才会参与同步" };
  const base = prompts.syncBaseAt;
  if (!base) return { cls: "", text: "尚未同步过（在「WebDAV 同步」页配置后即可同步）" };
  return d.updatedAt <= base
    ? { cls: "ok", text: "已同步" }
    : { cls: "warn", text: "本地有改动，待下次同步上传" };
});

// ===== 生命周期 =====
// 草稿的初始化订阅必须放在所有 ref 声明之后：loadDraft 会重置 diffVersion，
// 而 immediate 的 watch 是同步执行的——放前面会撞上 const 的暂时性死区（TDZ）。
// 只在「换了一条条目」时重建草稿：库列表被刷新（同步 / 别处存库）时不能把用户正在编辑的内容冲掉。
watch(() => prompts.detailItem?.id, loadDraft, { immediate: true });

// 兜底：万一详情页在库还没加载完时就被挂载（detailId 已设但 items 还是空的），
// 此时上面那个 watch 不会因为「同 id 后到」再触发，所以库加载完成时补一次初始化。
watch(() => prompts.loaded, (v) => { if (v && !draft.value) loadDraft(); });

onMounted(async () => {
  // init() 只订阅一次主进程事件：同步合并会把「被放弃的那份」写进版本历史，
  // 详情页开着时也能通过事件刷新看到新版本（见 store 的 library-changed 分支）
  prompts.init();
  // 库已加载时 loadLibrary 不会重拉；风格（血缘里的风格名）与冲突（待裁决入口）是本页要用的
  await prompts.loadAll();
});
</script>

<template>
  <div class="page prompts-scope">
    <!-- 条目不存在：detailId 失效（条目被彻底删除 / 引用过期）时给明确解释，而不是空白页 -->
    <div v-if="!draft" class="pr-card">
      <div class="pr-empty">
        <i class="ph ph-file-dashed"></i>
        <div class="es-title">找不到这条提示词</div>
        <div>它可能已被彻底删除，或详情页的引用已失效。</div>
        <button class="btn btn-ghost btn-sm" style="margin-top: 8px" @click="app.setPage('library')">返回提示词库</button>
      </div>
    </div>

    <template v-else>
      <!-- ===== 顶部：名称 / 分类 / 标签 / 收藏 / 保存 / 另存为新条目 ===== -->
      <div class="pr-card">
        <div class="pr-head">
          <p class="pr-sub">
            <button class="btn btn-ghost btn-sm" @click="back"><i class="ph ph-arrow-left"></i>返回库</button>
            <span class="pr-chip">{{ SOURCE_LABEL[draft.source] }}</span>
            <span class="pr-chip">v{{ draft.version }}</span>
            <span v-if="dirty" class="pr-chip warn">有未保存修改</span>
            <span v-if="readOnly" class="pr-chip danger">在回收站（只读）</span>
            <span v-if="conflict" class="pr-chip warn click" @click="app.setPage('sync')">待裁决</span>
          </p>
          <div class="pr-head-actions">
            <button class="btn btn-ghost btn-sm" @click="toggleFav">
              <i class="ph ph-star"></i>{{ storeItem?.favorite ? "取消收藏" : "收藏" }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="saveAsNew"><i class="ph ph-copy-simple"></i>另存为新条目</button>
            <button class="btn btn-cta btn-sm" :disabled="readOnly" @click="save()"><i class="ph ph-floppy-disk"></i>保存</button>
          </div>
        </div>

        <div class="pr-opt-adv" style="margin-top: 10px; padding-top: 10px">
          <label>名称
            <input v-model="draft.name" class="f-input" :disabled="readOnly" placeholder="例如：周报生成器" />
          </label>
          <label>分类
            <input v-model="draft.category" class="f-input" :disabled="readOnly" placeholder="支持两级，如 写作/邮件" />
          </label>
          <label>标签（逗号或空格分隔）
            <input v-model="tagInput" class="f-input" :disabled="readOnly" placeholder="写作, 日报" />
          </label>
          <label>版本备注（保存时写进新版本，可选）
            <input v-model="saveNote" class="f-input" :disabled="readOnly" placeholder="例如：把语气改得更正式" />
          </label>
        </div>
        <div class="pr-hint" style="margin-top: 8px">
          名称 / 分类 / 标签只改元信息，不会产生新版本；只有正文变化才会新增版本。
        </div>
      </div>

      <div class="pr-detail">
        <!-- ===== 左列：正文 + 变量 + 成品预览 + 版本历史 ===== -->
        <div class="pr-col">
          <!-- 正文 -->
          <div class="pr-card">
            <div class="pr-card-title">
              <i class="ph ph-text-align-left"></i>正文
              <span class="pr-chip">{{ bodyChars.toLocaleString("en-US") }} 字 · 约 {{ bodyTokens.toLocaleString("en-US") }} tokens</span>
              <span class="pr-chip" :class="overSize ? 'warn' : ''">{{ (bodyBytes / 1024).toFixed(1) }} KB / {{ prompts.cfg.itemMaxKB }} KB</span>
              <span class="pr-inline-ctl"><span class="pr-hint">Ctrl / ⌘ + S 保存</span></span>
            </div>
            <textarea
              v-model="draft.body"
              class="pr-area"
              style="min-height: clamp(220px, 38vh, 520px)"
              :readonly="readOnly"
              placeholder="把提示词写在这里。需要用户每次替换的部分写成 {{变量名}}，例如：请把下面的内容改写成面向{{读者}}的语气。"
              @keydown.ctrl.s.prevent="save()"
              @keydown.meta.s.prevent="save()"
            ></textarea>
            <div class="pr-area-foot">
              <span>变量写法：<code>{{ VAR_SAMPLE }}</code>（中英文、数字、下划线、点、横线）</span>
              <span v-if="unclosedVar" class="pr-warn-inline">⚠ 有未闭合的 <code>{{ OPEN_BRACES }}</code>，仍可保存；成品预览会按原文保留</span>
              <span v-if="overSize" class="pr-warn-inline">⚠ 已超过单条上限，保存会被拒绝</span>
            </div>
          </div>

          <!-- 变量面板 -->
          <div class="pr-card">
            <div class="pr-card-title">
              <i class="ph ph-brackets-curly"></i>变量
              <span class="pr-chip">{{ (draft.variables || []).length }} 个</span>
              <span class="pr-inline-ctl"><span class="pr-hint">变量从正文里的 {{ VAR_SAMPLE_EN }} 自动识别</span></span>
            </div>
            <div v-if="!(draft.variables || []).length" class="pr-hint">
              正文里还没有变量占位符。写上 <code>{{ VAR_SAMPLE_CN }}</code> 这样的片段，就能在这里补「说明」与「默认值」。
            </div>
            <div v-else class="pr-col" style="gap: 6px">
              <div v-for="v in draft.variables" :key="v.name" class="pr-var-row">
                <span class="name" :title="`正文里出现 ${occurrences(v.name)} 处`">{{ v.name }}</span>
                <input v-model="v.label" class="f-input" style="width: 158px" :disabled="readOnly" placeholder="说明（给模型看的）" />
                <input v-model="v.def" class="f-input" style="width: 158px" :disabled="readOnly" placeholder="默认值（预览用它替换）" />
                <label class="pr-hint" style="display: inline-flex; align-items: center; gap: 4px">
                  <input v-model="v.required" type="checkbox" :disabled="readOnly" />必填
                </label>
                <span class="pr-hint">{{ occurrences(v.name) }} 处</span>
              </div>
            </div>
          </div>

          <!-- 成品预览 -->
          <div class="pr-card">
            <div class="pr-card-title">
              <i class="ph ph-eye"></i>成品预览
              <span class="pr-chip">{{ previewChars.toLocaleString("en-US") }} 字</span>
              <span class="pr-inline-ctl">
                <button class="btn btn-ghost btn-sm" :disabled="!draft.body" @click="copyPreview">
                  <i class="ph ph-copy"></i>复制成品（计一次使用）
                </button>
              </span>
            </div>
            <div class="pr-hint" style="margin-bottom: 6px">
              变量已按「默认值」替换；没填默认值的显示为 <code>【变量名】</code>，提醒你实际使用时还要补。
            </div>
            <div class="pr-preview">{{ preview || "（正文为空）" }}</div>
          </div>

          <!-- 版本历史 -->
          <div class="pr-card">
            <div class="pr-card-title">
              <i class="ph ph-clock-counter-clockwise"></i>版本历史
              <span class="pr-chip">{{ versionsDesc.length }} 个版本</span>
              <span class="pr-chip">保留上限 {{ prompts.cfg.versionKeep }}</span>
              <span class="pr-inline-ctl"><span class="pr-hint">回滚 = 新增一个版本，不销毁历史</span></span>
            </div>
            <div v-if="!versionsDesc.length" class="pr-hint">还没有版本记录（保存一次就会生成第一条）。</div>
            <div v-else class="pr-col" style="gap: 6px">
              <div v-for="v in versionsDesc" :key="v.version" class="pr-ver-row" :class="{ on: diffVersion === v.version }">
                <span class="pr-chip" :class="v.version === draft.version ? 'accent' : ''">v{{ v.version }}</span>
                <span class="pr-hint">{{ formatDateTime(v.at, true) }}（{{ timeAgo(v.at) }}）</span>
                <span v-if="v.version === draft.version" class="pr-chip accent">当前</span>
                <span v-if="v.by === 'sync-merge'" class="pr-chip info" title="同步自动合并时被放弃的那一份会存进版本历史，可回滚">同步自动合并</span>
                <span v-if="v.note" class="pr-hint">备注：{{ v.note }}</span>
                <span class="pr-inline-ctl">
                  <button class="btn btn-ghost btn-sm" @click="toggleDiff(v)">
                    {{ diffVersion === v.version ? "收起对比" : "与当前对比" }}
                  </button>
                  <button class="btn btn-ghost btn-sm" :disabled="readOnly || v.body === draft.body" @click="rollback(v)">回滚</button>
                  <button class="btn btn-ghost btn-sm" :disabled="!v.body" @click="copyText(v.body, `v${v.version} 正文`)">复制</button>
                </span>
              </div>
            </div>

            <!-- diff：左侧历史版本，右侧当前编辑器（含未保存改动） -->
            <div v-if="diffVersion !== null" style="margin-top: 10px; border-top: 1px solid var(--pr-line); padding-top: 10px">
              <div class="pr-row" style="margin-bottom: 8px">
                <span class="pr-chip click" :class="{ accent: diffMode === 'side' }" @click="diffMode = 'side'">并排对比</span>
                <span class="pr-chip click" :class="{ accent: diffMode === 'unified' }" @click="diffMode = 'unified'">统一 diff</span>
                <span class="pr-hint">
                  左 v{{ diffVersion }} → 右 当前编辑器 · 新增 {{ diffUnified.add }} 行 / 删除 {{ diffUnified.del }} 行
                </span>
                <span v-if="diffRows.length >= DIFF_MAX_ROWS" class="pr-hint">（仅显示前 {{ DIFF_MAX_ROWS }} 行）</span>
              </div>
              <div v-if="diffMode === 'side'" class="pr-diff2">
                <div class="col">
                  <div class="col-head">v{{ diffVersion }}</div>
                  <div class="col-body">
                    <div
                      v-for="(l, i) in diffRows"
                      :key="'l' + i"
                      class="pr-diff-line"
                      :class="l.left?.kind === 'del' ? 'del' : l.left?.kind === 'ctx' ? 'ctx' : ''"
                    >{{ l.left?.text || "" }}</div>
                  </div>
                </div>
                <div class="col">
                  <div class="col-head">当前编辑器</div>
                  <div class="col-body">
                    <div
                      v-for="(l, i) in diffRows"
                      :key="'r' + i"
                      class="pr-diff-line"
                      :class="l.right?.kind === 'add' ? 'add' : l.right?.kind === 'ctx' ? 'ctx' : ''"
                    >{{ l.right?.text || "" }}</div>
                  </div>
                </div>
              </div>
              <pre v-else class="pr-pre">{{ diffUnified.text || "（两侧内容一致）" }}</pre>
            </div>
          </div>
        </div>

        <!-- ===== 右列：元信息与血缘 + 同步信息 + 删除 ===== -->
        <div class="pr-col">
          <!-- 元信息 -->
          <div class="pr-card">
            <div class="pr-card-title"><i class="ph ph-info"></i>元信息</div>
            <div class="pr-table-wrap">
              <table class="pr-table">
                <tbody>
                  <tr><th>创建时间</th><td>{{ formatDateTime(draft.createdAt, true) }}</td></tr>
                  <tr><th>更新时间</th><td>{{ formatDateTime(draft.updatedAt, true) }}（{{ timeAgo(draft.updatedAt) }}）</td></tr>
                  <tr>
                    <th>使用次数</th>
                    <td>
                      {{ draft.useCount || 0 }} 次
                      <template v-if="draft.lastUsedAt"> · 最后 {{ timeAgo(draft.lastUsedAt) }}</template>
                    </td>
                  </tr>
                  <tr><th>内容哈希</th><td class="pr-mono">{{ loadedHash || "（尚未落盘）" }}</td></tr>
                  <tr>
                    <th>来源</th>
                    <td>{{ SOURCE_LABEL[draft.source] }}<template v-if="draft.originRef"> · {{ draft.originRef }}</template></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="draft.originMeta" class="pr-hint" style="margin-top: 6px">
              原作者 {{ draft.originMeta.author || "—" }} · 许可 {{ draft.originMeta.license || "—" }}
              <template v-if="draft.originMeta.url">
                · <a :href="draft.originMeta.url" target="_blank" rel="noreferrer">{{ draft.originMeta.url }}</a>
              </template>
              <template v-if="draft.originMeta.version"> · 版本 {{ draft.originMeta.version }}</template>
            </div>
          </div>

          <!-- 血缘 -->
          <div class="pr-card">
            <div class="pr-card-title"><i class="ph ph-git-branch"></i>血缘</div>
            <div v-if="!hasLineage" class="pr-hint">这条是手写或本地新建的，没有上游血缘。</div>
            <template v-else>
              <div class="pr-table-wrap">
                <table class="pr-table">
                  <tbody>
                    <tr>
                      <th>父条目</th>
                      <td>
                        <button v-if="parentItem" class="btn-link" @click="prompts.openDetail(parentItem.id)">{{ parentItem.name }}</button>
                        <span v-else class="pr-mono">{{ draft.lineage?.parentHash || "—" }}（原条目已不存在）</span>
                      </td>
                    </tr>
                    <tr><th>优化风格</th><td>{{ styleName || "—" }}</td></tr>
                    <tr><th>模型</th><td>{{ draft.lineage?.model || "跟随默认" }}</td></tr>
                  </tbody>
                </table>
              </div>
              <div v-if="draft.lineage?.inputText" style="margin-top: 8px">
                <div class="pr-row">
                  <span class="pr-hint">优化时的原文（可能已截断）</span>
                  <span class="pr-inline-ctl">
                    <button class="btn btn-ghost btn-sm" @click="lineageOpen = !lineageOpen">{{ lineageOpen ? "收起" : "展开" }}</button>
                    <button class="btn btn-ghost btn-sm" @click="copyText(draft.lineage?.inputText || '', '原文')">复制</button>
                  </span>
                </div>
                <pre v-if="lineageOpen" class="pr-pre" style="margin-top: 6px">{{ draft.lineage.inputText }}</pre>
              </div>
            </template>
          </div>

          <!-- 同步信息 -->
          <div class="pr-card">
            <div class="pr-card-title"><i class="ph ph-cloud-arrow-up"></i>同步</div>
            <div class="pr-row">
              <span class="pr-dot" :class="syncState.cls"></span>
              <span>{{ syncState.text }}</span>
            </div>
            <div class="pr-hint" style="margin-top: 6px">
              上次同步：{{ prompts.syncBaseAt ? formatDateTime(prompts.syncBaseAt, true) : "从未同步" }}
              （口径：条目最后修改时间 ≤ 上次同步时刻即视为已同步）
            </div>
            <div v-if="conflict" class="pr-row" style="margin-top: 8px">
              <span class="pr-chip warn">待裁决</span>
              <span class="pr-hint">{{ conflict.title || conflict.detail || "本地与远端都有改动" }}</span>
              <span class="pr-inline-ctl">
                <button class="btn btn-ghost btn-sm" @click="app.setPage('sync')">去裁决</button>
              </span>
            </div>
          </div>

          <!-- 删除 / 还原 -->
          <div class="pr-card">
            <div class="pr-card-title"><i class="ph ph-warning"></i>操作</div>
            <template v-if="readOnly">
              <div class="pr-hint">这条在回收站里，只能查看与还原（保留 {{ prompts.cfg.trashDays }} 天）。</div>
              <div class="pr-row" style="margin-top: 8px">
                <button class="btn btn-cta btn-sm" @click="restoreItem"><i class="ph ph-arrow-counter-clockwise"></i>还原到库</button>
                <button class="btn btn-outline danger btn-sm" @click="purgeItem">彻底删除</button>
              </div>
            </template>
            <template v-else>
              <div class="pr-hint">删除会先移入回收站（保留 {{ prompts.cfg.trashDays }} 天），期间可以还原。</div>
              <div class="pr-row" style="margin-top: 8px">
                <button class="btn btn-outline danger btn-sm" @click="removeItem"><i class="ph ph-trash"></i>删除（进回收站）</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
