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
  两视图共享筛选状态，切换不重置。

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

// ===== 目录数据 =====
const stats = ref<CatalogStats | null>(null);
const categories = ref<CatalogCategory[]>([]);
const templates = ref<CatalogTemplate[]>([]);
const items = ref<CatalogItem[]>([]);
const counts = ref<Record<string, number>>({});
const total = ref(0);
const loading = ref(false);
const refreshing = ref(false);
const loadError = ref("");

// ===== 筛选状态（放组件内：离开页面回来重新拉一次目录不心疼，60 条而已）=====
const view = ref<"template" | "item">("template");
const query = ref("");
const category = ref("");
const templateId = ref("");
const quick = ref<"all" | "collected" | "update">("all");
const variablePick = ref("");

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void loadItems(); }, 250);
});
watch([category, templateId], () => { void loadItems(); });

/** 模板卡上的「N 个案例」：目录里的 itemIds 可能指向不存在的条目，这里只数真实存在的 */
const templateItems = computed(() => {
  const map = new Map<string, CatalogItem[]>();
  for (const it of items.value) {
    if (!it.templateId) continue;
    const arr = map.get(it.templateId) || [];
    arr.push(it);
    map.set(it.templateId, arr);
  }
  return map;
});

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
function hasUpdate(it: { id: string; version: number }) {
  const c = collected.value.get(it.id);
  return !!c && it.version > c.version;
}

/** 快捷入口的可见列表：已收录/有更新都在前端过滤（目录总量小，没必要为它加后端参数） */
const visibleItems = computed(() => {
  if (quick.value === "collected") return items.value.filter((i) => isCollected(i.id));
  if (quick.value === "update") return items.value.filter((i) => hasUpdate(i));
  return items.value;
});

/** 按变量找：让用户从「我手上有什么材料」反查模板，而不是从「我想要什么」正查 */
const variableCloud = computed(() => {
  const n = new Map<string, number>();
  for (const it of items.value) for (const v of it.variableNames) n.set(v, (n.get(v) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, count]) => ({ name, count }));
});

// ===== 详情抽屉 =====
const drawerOpen = ref(false);
const detail = ref<CatalogItemDetail | null>(null);
const detailLoading = ref(false);

async function openDetail(id: string) {
  detailLoading.value = true;
  drawerOpen.value = true;
  detail.value = null;
  try {
    const r = await pipc.promptsCatalogGet(id);
    if (r.ok && r.item) detail.value = r.item;
    else ElMessage.warning(r.message || "这一条打不开");
  } catch (e) {
    ElMessage.error((e as Error).message || "读取失败");
  } finally {
    detailLoading.value = false;
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
    tags: item.tags.join("，"),
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
  const exists = [...collected.value.entries()].find(([cid]) => cid === target.id);
  if (exists) {
    const local = prompts.liveItems.find((i) => i.id === exists[1].itemId);
    // 硬规则：用户改过的条目（hash 与入库时不同）永不静默覆盖。
    // 这里没有存「入库时 hash」，退一步用「有版本历史 > 1」判断是否被改过——
    // 只要用户动过，就一定多出一个版本（保存动作本身会 push 版本）。
    const edited = !!local && (local.version > 1 || local.versions.length > 1);
    try {
      await ElMessageBox.confirm(
        `这条已在你的库（你的第 ${local?.version ?? "?"} 版 / 目录 v${target.version}）。`
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
        ...local!,
        body: target.body,
        variables: target.variables,
        originRef,
        originMeta: { license: target.license, url: target.sourceUrl, version: String(target.version) },
        updatedAt: Date.now(),
        versions: [...local!.versions, { version: local!.version + 1, body: target.body, at: Date.now(), note: `更新到目录 v${target.version}`, by: "user" as const }].slice(-prompts.cfg.versionKeep),
      };
      merged.version = local!.version + 1;
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

// ===== 拉取 =====
async function loadIndex() {
  try {
    const r = await pipc.promptsCatalogIndex();
    categories.value = r.categories || [];
    templates.value = r.templates || [];
  } catch (e) {
    loadError.value = (e as Error).message || "目录读取失败";
  }
}

async function loadItems() {
  loading.value = true;
  try {
    const r = await pipc.promptsCatalogList({
      category: category.value || undefined,
      templateId: templateId.value || undefined,
      q: query.value.trim() || undefined,
      pageSize: 200,
    });
    items.value = r.items || [];
    counts.value = r.counts || {};
    total.value = r.total || 0;
    loadError.value = "";
  } catch (e) {
    loadError.value = (e as Error).message || "目录读取失败";
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  try {
    const r = await pipc.promptsCatalogStats();
    stats.value = r.stats;
  } catch { /* 概况拉不到不影响浏览 */ }
}

async function refreshCatalog() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const r = await pipc.promptsCatalogRefresh();
    if (r.updated) {
      ElMessage.success(r.message || "目录已更新");
      await Promise.all([loadIndex(), loadItems(), loadStats()]);
    } else if (r.ok) {
      ElMessage.info(r.message || "已是最新目录");
      await loadStats();
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
    await Promise.all([loadItems(), loadStats()]);
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
    await Promise.all([loadIndex(), loadItems(), loadStats()]);
  }
}

// ===== 生命周期 =====
let offEvent: (() => void) | undefined;
async function bootstrap() {
  prompts.init();
  void prompts.loadLibrary();
  await Promise.all([loadIndex(), loadItems(), loadStats()]);
}
onMounted(() => {
  void bootstrap();
  offEvent = onUpdateEvent((p) => {
    const e = p as PromptsEvent;
    if (e && e.event === "prompts" && e.type === "catalog-updated") void Promise.all([loadItems(), loadStats()]);
  });
});
onUnmounted(() => { if (offEvent) { offEvent(); offEvent = undefined; } });
watch(active, (v) => { if (v && !items.value.length) void Promise.all([loadIndex(), loadItems(), loadStats()]); });

const sourceLabel = computed(() => {
  const s = stats.value;
  if (!s) return "目录读取中…";
  if (s.source === "cache") return `已更新到 v${s.version}`;
  if (s.source === "builtin") return `内置目录 v${s.version}`;
  return "目录缺失";
});
</script>

<template>
  <div class="page prompts-scope">
    <!-- 状态条 -->
    <div class="pr-card">
      <div class="pr-row">
        <span class="pr-chip accent">{{ sourceLabel }}</span>
        <span class="pr-chip">{{ stats?.count ?? 0 }} 条</span>
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
        模板解决「该按什么结构写」，案例解决「别人实际怎么写的」。两边的筛选是共用的。
      </div>
    </div>

    <div class="pr-online">
      <!-- 左栏 -->
      <aside class="pr-online-side">
        <div class="pr-side-group">
          <div class="pr-side-title">快捷</div>
          <button class="pr-side-row" :class="{ on: quick === 'all' }" @click="quick = 'all'">
            <span>全部</span><span class="n">{{ total }}</span>
          </button>
          <button class="pr-side-row" :class="{ on: quick === 'collected' }" @click="quick = 'collected'">
            <span>已收录</span><span class="n">{{ collected.size }}</span>
          </button>
          <button class="pr-side-row" :class="{ on: quick === 'update' }" @click="quick = 'update'">
            <span>有更新</span><span class="n">{{ items.filter((i) => hasUpdate(i)).length }}</span>
          </button>
        </div>

        <div class="pr-side-group">
          <div class="pr-side-title">分类</div>
          <button class="pr-side-row" :class="{ on: !category }" @click="category = ''; templateId = ''">
            <span>全部</span><span class="n">{{ total }}</span>
          </button>
          <button
            v-for="c in categories"
            :key="c.id"
            class="pr-side-row"
            :class="{ on: category === c.id }"
            @click="category = c.id; templateId = ''"
          >
            <span>{{ c.name }}</span><span class="n">{{ counts[c.id] || 0 }}</span>
          </button>
        </div>

        <div class="pr-side-group" v-if="variableCloud.length">
          <div class="pr-side-title">按变量找</div>
          <div class="pr-row">
            <span
              v-for="v in variableCloud"
              :key="v.name"
              class="pr-chip click"
              :class="{ accent: variablePick === v.name }"
              @click="variablePick = variablePick === v.name ? '' : v.name; query = variablePick === v.name ? '' : v.name"
            >{{ v.name }}</span>
          </div>
        </div>
      </aside>

      <!-- 主区 -->
      <div class="pr-online-main">
        <div v-if="loadError" class="pr-online-empty">
          <div>{{ loadError }}</div>
          <button class="btn btn-ghost btn-sm" @click="bootstrap">重试</button>
        </div>

        <div v-else-if="loading" class="pr-online-empty">正在读取目录…</div>

        <!-- 模板视图 -->
        <template v-else-if="view === 'template'">
          <div v-if="!templates.length" class="pr-online-empty">目录里还没有模板</div>
          <div v-else class="pr-tpl-grid">
            <article
              v-for="t in templates"
              :key="t.id"
              class="pr-tpl-card"
              :class="{ on: templateId === t.id }"
              @click="templateId = templateId === t.id ? '' : t.id; view = 'item'"
            >
              <div class="pr-tpl-head">
                <span class="pr-tpl-title">{{ t.title }}</span>
                <span class="pr-chip">{{ templateItems.get(t.id)?.length || 0 }} 个案例</span>
              </div>
              <p class="pr-tpl-desc">{{ t.description }}</p>
              <div class="pr-tpl-use"><b>什么时候用</b>{{ t.useWhen }}</div>
            </article>
          </div>
        </template>

        <!-- 案例视图 -->
        <template v-else>
          <div v-if="templateId" class="pr-row" style="margin-bottom: 8px">
            <span class="pr-chip accent">{{ templates.find((t) => t.id === templateId)?.title || "模板" }}</span>
            <span class="pr-hint">{{ visibleItems.length }} 个案例</span>
            <button class="btn btn-ghost btn-sm" @click="templateId = ''">看全部案例</button>
          </div>

          <div v-if="!visibleItems.length" class="pr-online-empty">
            <div>{{ quick === 'collected' ? "还没有收录任何条目" : quick === 'update' ? "没有可更新的条目" : "没有匹配的条目" }}</div>
            <button v-if="quick !== 'all'" class="btn btn-ghost btn-sm" @click="quick = 'all'">看全部</button>
          </div>

          <div v-else class="pr-cat-grid">
            <article v-for="it in visibleItems" :key="it.id" class="pr-cat-card" @click="openDetail(it.id)">
              <div class="pr-cat-head">
                <span class="pr-cat-title">{{ it.title }}</span>
                <span v-if="hasUpdate(it)" class="pr-chip warn">v{{ it.version }}</span>
                <span v-else-if="isCollected(it.id)" class="pr-chip info">已收录</span>
              </div>
              <p class="pr-cat-summary">{{ it.summary }}</p>
              <div class="pr-row">
                <span class="pr-chip">{{ categories.find((c) => c.id === it.category)?.name || it.category }}</span>
                <span v-if="it.variableCount" class="pr-chip accent">{{ it.variableNames[0] }}{{ it.variableCount > 1 ? ` +${it.variableCount - 1}` : "" }}</span>
                <span v-for="t in it.tags.slice(0, 2)" :key="t" class="pr-chip">{{ t }}</span>
              </div>
            </article>
          </div>
        </template>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="drawerOpen" class="pr-drawer-mask" @click.self="drawerOpen = false">
      <aside class="pr-drawer">
        <div class="pr-drawer-head">
          <span class="pr-drawer-title">{{ detail?.title || "读取中…" }}</span>
          <button class="btn btn-ghost btn-sm" @click="drawerOpen = false">关闭</button>
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

          <div v-if="detail.variables.length" class="pr-drawer-sec">
            <div class="pr-drawer-label">变量</div>
            <div class="pr-row">
              <span v-for="v in detail.variables" :key="v.name" class="pr-chip accent">{{ v.name }}</span>
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
