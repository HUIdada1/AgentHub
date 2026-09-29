<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 项目归档：项目卡网格 + 归类溯源（只显示可疑项）+ 低频维护动作收进卡片菜单 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryProjectCard } from "../../types";
import { timeAgo, formatDateTime } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemSelect from "../../components/memory/MemSelect.vue";
import MemDialog from "../../components/memory/MemDialog.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "projects");

const query = ref("");
const projects = ref<MemoryProjectCard[]>([]);
const general = ref({ count: 0, latest: 0 });
const suggestCount = ref(0);
const busy = ref("");
const loading = ref(false);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return projects.value;
  return projects.value.filter((p) => `${p.name} ${p.slug} ${(p.aliases || []).join(" ")}`.toLowerCase().includes(q));
});

async function refresh() {
  loading.value = true;
  await mem.loadAll();
  try {
    const r = await api.memoryProjects();
    projects.value = r.projects;
    general.value = r.general;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取项目失败");
  } finally {
    loading.value = false;
  }
  try {
    const s = await api.memoryProjectSuggest();
    suggestCount.value = s.items.length;
  } catch {
    /* 忽略 */
  }
}

async function rename(p: MemoryProjectCard) {
  let name = "";
  try {
    const r = await ElMessageBox.prompt("项目显示名（标识 slug 与目录名不变，避免同步冲突）", "重命名项目", {
      inputValue: p.name,
      inputPlaceholder: p.name,
    });
    name = r.value || "";
  } catch {
    return;
  }
  if (!name.trim()) return;
  try {
    await api.memoryProjectRename(p.slug, name.trim(), p.aliases);
    ElMessage.success("已重命名");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "重命名失败");
  }
}

/** 合并：源项目已选定，目标项目从下拉挑（排除自身与 general），避免手输 slug 出错 */
const mergeOpen = ref(false);
const mergeSource = ref<MemoryProjectCard | null>(null);
const mergeTarget = ref("");
const mergeOptions = computed(() =>
  projects.value
    .filter((x) => x.slug !== mergeSource.value?.slug && x.slug !== "general")
    .map((x) => ({ value: x.slug, label: `${x.name}（${x.slug}）` })),
);

function openMerge(p: MemoryProjectCard) {
  const others = projects.value.filter((x) => x.slug !== p.slug && x.slug !== "general");
  if (!others.length) {
    ElMessage.info("没有可合并的其它项目");
    return;
  }
  mergeSource.value = p;
  mergeTarget.value = others[0].slug;
  mergeOpen.value = true;
}

async function confirmMerge() {
  const src = mergeSource.value;
  const target = mergeTarget.value;
  if (!src || !target) return;
  mergeOpen.value = false;
  busy.value = src.slug;
  try {
    const res = await api.memoryProjectMerge(src.slug, target);
    ElMessage.success(`已合并 ${res.moved} 条到 ${target}`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "合并失败");
  } finally {
    busy.value = "";
  }
}

async function moveToGeneral(p: MemoryProjectCard) {
  try {
    await ElMessageBox.confirm(
      `把「${p.name}」的全部记忆移入通用项目（general，普通对话区）？\n注：一次最多处理 500 条，超出请再点一次。`,
      "移入通用项目",
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    // 逐条改归属要经写队列，条数多时只处理前 500 条，避免长时间占用队列
    const list = await api.memoryList({ project: p.slug, pageSize: 500, includeSuperseded: true });
    const res = await api.memoryProjectAssign(list.rows.map((r) => r.id), null);
    const suffix = list.total > 500 ? `（仍有 ${list.total - 500} 条待处理，可再次点击）` : "";
    ElMessage.success(`已移出 ${res.moved} 条${suffix}`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "移出失败");
  }
}

async function openMemories(p: MemoryProjectCard) {
  // 跳转前落预过滤与视图落点：BrowseView 的 watch 会消费它并真正应用项目过滤
  mem.browsePrefilter = p.slug;
  mem.browseViewHint = "list";
  app.setPage("browse");
  ElMessage.info(`已跳转「记忆浏览」，项目过滤：${p.name}`);
}

/** 蒸馏 L2 的进度弹窗：把整个项目的记忆蒸成知识/决策/术语表，属花 token 的长任务 */
const distillOpen = ref(false);
const distillSlug = ref("");
const distillStartedAt = ref(0);
const distillResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);
const distillName = computed(() => projects.value.find((p) => p.slug === distillSlug.value)?.name || distillSlug.value);

/** 蒸馏前的成本确认弹窗：调模型耗 token，先确认再跑 */
const distillConfirmOpen = ref(false);
const distillConfirmTarget = ref<MemoryProjectCard | null>(null);

/** 弹窗查看远程仓库或本地路径 */
const pathsDialogOpen = ref(false);
const pathsDialogTitle = ref("");
const pathsDialogSubtitle = ref("");
const pathsDialogList = ref<string[]>([]);
const copiedIdx = ref<number | null>(null);

function openPathsDialog(p: MemoryProjectCard, type: "remotes" | "localPaths") {
  if (type === "remotes") {
    pathsDialogTitle.value = `远程仓库列表 · ${p.name}`;
    pathsDialogSubtitle.value = `标识 slug: ${p.slug} · 共 ${p.remotes.length} 个远程地址`;
    pathsDialogList.value = p.remotes || [];
  } else {
    pathsDialogTitle.value = `本地路径列表 · ${p.name}`;
    pathsDialogSubtitle.value = `标识 slug: ${p.slug} · 共 ${(p.localPaths || []).length} 个本地关联路径`;
    pathsDialogList.value = p.localPaths || [];
  }
  copiedIdx.value = null;
  pathsDialogOpen.value = true;
}

async function copyPathItem(text: string, idx: number) {
  try {
    await navigator.clipboard.writeText(text);
    copiedIdx.value = idx;
    ElMessage.success("已复制到剪贴板");
    setTimeout(() => {
      if (copiedIdx.value === idx) copiedIdx.value = null;
    }, 2000);
  } catch {
    ElMessage.error("复制失败");
  }
}

async function copyAllPaths() {
  if (!pathsDialogList.value.length) return;
  try {
    await navigator.clipboard.writeText(pathsDialogList.value.join("\n"));
    ElMessage.success("已复制全部路径");
  } catch {
    ElMessage.error("复制失败");
  }
}

function askDistill(p: MemoryProjectCard) {
  distillConfirmTarget.value = p;
  distillConfirmOpen.value = true;
}

async function confirmDistill() {
  const p = distillConfirmTarget.value;
  distillConfirmOpen.value = false;
  if (!p) return;
  busy.value = p.slug;
  distillSlug.value = p.slug;
  distillStartedAt.value = Date.now();
  distillResult.value = null;
  distillOpen.value = true;
  try {
    const r = await api.memoryDistillRun({ project: p.slug });
    distillResult.value = {
      ok: true,
      message: r.detail || "蒸馏完成",
      extra: [
        r.processed ? `处理 ${r.processed} 条` : "",
        r.updated ? `产出/更新 ${r.updated} 条 L2` : "",
        r.tokens ? `消耗 ${r.tokens} token` : "",
      ].filter(Boolean) as string[],
    };
    await refresh();
  } catch (e) {
    distillResult.value = { ok: false, message: (e as Error).message || "蒸馏失败（先在「模型与网关」配置模型）" };
  } finally {
    busy.value = "";
  }
}

/** 卡片维护动作菜单（原来五个按钮平铺，只有「查看记忆」是高频） */
function cardAction(p: MemoryProjectCard, cmd: string) {
  if (cmd === "distill") askDistill(p);
  else if (cmd === "rename") void rename(p);
  else if (cmd === "merge") openMerge(p);
  else if (cmd === "general") void moveToGeneral(p);
}

onMounted(refresh);
watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope proj-scope">
    <div class="mem-toolbar">
      <input v-model="query" class="f-input mem-grow" style="max-width: 280px" placeholder="搜索项目" />
      <span class="mem-chip">共 {{ projects.length }} 个项目</span>
      <span class="mem-chip">通用（general）{{ general.count }} 条</span>
      <MemHelp text="一个 Git 项目对应一个文件夹：归类只认 Git 远程地址（标识 slug 只由远程地址决定），同一仓库在不同电脑、不同路径下都会跨机器归并到同一个项目目录（文件夹名＝owner--repo）。没有远程地址时才退化为按目录名/名称模糊匹配，且只给建议、不自动归。" />
      <span v-if="suggestCount" style="margin-left: auto">
        <button class="btn-outline" @click="mem.gotoReview('classify')">{{ suggestCount }} 条待确认归类 →</button>
      </span>
    </div>

    <div class="card proj-card">
      <div class="table-scroll proj-table-scroll">
        <table class="table table-bare proj-table">
          <thead>
            <tr>
              <th style="width: auto; text-align: center">项目名称 / Slug</th>
              <th style="width: 72px; text-align: center">状态</th>
              <th style="width: 96px; text-align: center">远程仓库</th>
              <th style="width: 96px; text-align: center">本地路径</th>
              <th style="width: 155px; text-align: center">记忆统计</th>
              <th style="width: 130px; text-align: center">关联 Agent</th>
              <th style="width: 125px; text-align: center">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 加载中骨架屏 -->
            <tr v-if="loading" v-for="n in 6" :key="'sk-' + n">
              <td><div class="skeleton" style="height: 20px; width: 140px"></div></td>
              <td style="text-align: center"><div class="skeleton" style="height: 18px; width: 44px; margin: 0 auto"></div></td>
              <td style="text-align: center"><div class="skeleton" style="height: 18px; width: 60px; margin: 0 auto"></div></td>
              <td style="text-align: center"><div class="skeleton" style="height: 18px; width: 60px; margin: 0 auto"></div></td>
              <td><div class="skeleton" style="height: 18px; width: 110px"></div></td>
              <td><div class="skeleton" style="height: 18px; width: 80px"></div></td>
              <td style="text-align: center"><div class="skeleton" style="height: 20px; width: 70px; margin: 0 auto"></div></td>
            </tr>
            <!-- 空状态 -->
            <tr v-else-if="!filtered.length">
              <td colspan="7" style="text-align: center; color: var(--text-3); padding: 32px 0">
                {{ query ? "没有匹配的项目" : "还没有项目。让 Agent 带上项目路径写记忆，或手动记一条并选项目。" }}
              </td>
            </tr>
            <!-- 数据行 -->
            <template v-else>
              <tr v-for="(p, i) in filtered" :key="p.slug" :style="{ '--i': i }" @click="openMemories(p)">
                <!-- 项目名称 / Slug -->
                <td style="width: auto">
                  <el-tooltip :content="`${p.name} (${p.slug})${p.aliases?.length ? '\n别名: ' + p.aliases.join(', ') : ''}`" placement="top">
                    <div class="proj-cell">
                      <span class="proj-name-text">{{ p.name }}</span>
                      <span class="proj-slug-text">{{ p.slug }}</span>
                    </div>
                  </el-tooltip>
                </td>
                <!-- 状态 -->
                <td style="width: 72px; text-align: center" @click.stop>
                  <span class="pill" :class="p.latest > Date.now() - 7 * 86400000 ? 'ok' : ''">
                    {{ p.latest > Date.now() - 7 * 86400000 ? "活跃" : "静默" }}
                  </span>
                </td>
                <!-- 远程仓库 -->
                <td style="width: 96px; text-align: center" @click.stop>
                  <el-tooltip v-if="p.remotes && p.remotes.length" content="点击查看完整远程仓库地址" placement="top">
                    <button
                      class="btn btn-ghost"
                      style="font-size: 11px; padding: 2px 8px; height: 24px"
                      @click="openPathsDialog(p, 'remotes')"
                    >
                      查看 ({{ p.remotes.length }})
                    </button>
                  </el-tooltip>
                  <span v-else class="pill warn" style="font-size: 11px">
                    {{ p.origin === "fuzzy" ? "模糊匹配" : "无远程" }}
                  </span>
                </td>
                <!-- 本地路径 -->
                <td style="width: 96px; text-align: center" @click.stop>
                  <el-tooltip v-if="p.localPaths && p.localPaths.length" content="点击查看完整本地路径" placement="top">
                    <button
                      class="btn btn-ghost"
                      style="font-size: 11px; padding: 2px 8px; height: 24px"
                      @click="openPathsDialog(p, 'localPaths')"
                    >
                      查看 ({{ p.localPaths.length }})
                    </button>
                  </el-tooltip>
                  <span v-else style="color: var(--text-3)">—</span>
                </td>
                <!-- 记忆统计 -->
                <td style="width: 155px">
                  <el-tooltip :content="`总记忆: ${p.count} 条\nL2 深层: ${p.l2} 条\n最近更新: ${p.latest ? formatDateTime(p.latest) : '无'}`" placement="top">
                    <div class="proj-ellipsis-cell">
                      <span class="mono">{{ p.count }} 条</span>
                      <span style="margin: 0 4px; color: var(--text-3)">·</span>
                      <span class="pill blue" style="font-size: 10.5px; padding: 1px 5px">L2: {{ p.l2 }}</span>
                      <span style="margin-left: 4px; font-size: 11px; color: var(--text-3)">{{ timeAgo(p.latest) }}</span>
                    </div>
                  </el-tooltip>
                </td>
                <!-- 关联 Agent -->
                <td style="width: 130px">
                  <el-tooltip :content="(p.agents || []).join(' · ') || '无关联 Agent'" placement="top">
                    <div class="proj-ellipsis-cell">
                      <span>{{ (p.agents || []).join(" · ") || "—" }}</span>
                    </div>
                  </el-tooltip>
                </td>
                <!-- 操作 -->
                <td class="actions" style="width: 125px; text-align: center" @click.stop>
                  <div style="display: inline-flex; align-items: center; justify-content: center; gap: 6px">
                    <button class="btn btn-cta" style="font-size: 11px; padding: 2px 8px; height: 24px" @click="openMemories(p)">查看记忆</button>
                    <el-dropdown trigger="click" @command="(c: string) => cardAction(p, c)">
                      <el-tooltip content="更多操作" placement="top">
                        <button class="btn-link" style="padding: 2px 4px" :disabled="busy === p.slug">
                          {{ busy === p.slug ? "…" : "⋯" }}
                        </button>
                      </el-tooltip>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item command="distill">蒸馏 L2</el-dropdown-item>
                          <el-dropdown-item command="rename">重命名项目</el-dropdown-item>
                          <el-dropdown-item command="merge">合并到…</el-dropdown-item>
                          <el-dropdown-item command="general" divided>移入通用项目</el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 合并目标选择：从现有项目下拉挑（排除自身与 general），不再手输 slug -->
    <MemDialog
      v-model:open="mergeOpen"
      :title="`合并项目：${mergeSource?.name || ''}`"
      sub="把源项目的全部记忆搬到目标项目，并清理源文件夹（不可撤销，源项目的 .bak 不保留）"
      width="540px"
    >
      <div class="mem-section">
        <div class="s-title">目标项目</div>
        <MemSelect v-model="mergeTarget" :options="mergeOptions" placeholder="选择目标项目" />
        <div class="mem-hint" style="margin-top: 6px">
          合并后源项目「{{ mergeSource?.slug }}」将被清空并移除，记忆全部归到目标项目。
        </div>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="!mergeTarget" @click="confirmMerge">确认合并</button>
        <button class="btn btn-ghost" @click="mergeOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 蒸馏 L2 成本确认：要调模型耗 token，先说清楚再跑 -->
    <MemDialog
      v-model:open="distillConfirmOpen"
      :title="`蒸馏 L2：${distillConfirmTarget?.name || ''}`"
      sub="把本项目原始记忆蒸成知识 / 决策 / 术语表"
      width="560px"
    >
      <div class="mem-col">
        <p style="margin: 0; line-height: 1.7">
          这次蒸馏将读取「{{ distillConfirmTarget?.name }}」项目中最多
          {{ Number(mem.cfg("deep.distillMaxPerProject", 60)) }} 条重要素材，调用模型逐批归纳产出 L2 深层记忆。
        </p>
        <p style="margin: 0; line-height: 1.7">
          该过程会<b>消耗模型 token</b>（量随素材条数与正文长度而定，通常数千到数万），且无法中途精确预估。
          已存在的 L2 不会被删除，仅补充新结论或更新旧结论。
        </p>
      </div>
      <template #foot>
        <button class="btn btn-cta" @click="confirmDistill">确认开始</button>
        <button class="btn btn-ghost" @click="distillConfirmOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 远程仓库与本地路径完整查看弹窗 -->
    <MemDialog
      v-model:open="pathsDialogOpen"
      :title="pathsDialogTitle"
      :sub="pathsDialogSubtitle"
      width="620px"
    >
      <div v-if="pathsDialogList.length" class="mem-col" style="gap: 8px; max-height: 380px; overflow-y: auto; padding: 2px">
        <div
          v-for="(item, idx) in pathsDialogList"
          :key="idx"
          class="mem-card"
          style="padding: 10px 12px; margin: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-hover, rgba(0,0,0,0.02))"
        >
          <span class="mem-mono" style="word-break: break-all; font-size: 12px; user-select: all; line-height: 1.5">{{ item }}</span>
          <button
            class="btn btn-ghost"
            style="font-size: 11px; padding: 2px 10px; height: 26px; white-space: nowrap; flex-shrink: 0"
            @click="copyPathItem(item, idx)"
          >
            {{ copiedIdx === idx ? "✓ 已复制" : "复制" }}
          </button>
        </div>
      </div>
      <div v-else class="mem-empty" style="padding: 24px">
        暂无路径记录
      </div>
      <template #foot>
        <button
          v-if="pathsDialogList.length > 1"
          class="btn btn-outline"
          style="margin-right: auto"
          @click="copyAllPaths"
        >
          复制全部 ({{ pathsDialogList.length }})
        </button>
        <button class="btn btn-ghost" @click="pathsDialogOpen = false">关闭</button>
      </template>
    </MemDialog>

    <!-- 蒸馏 L2 的进度弹窗：长任务 + 花 token，过程与结果都显示在这里 -->
    <MemProgressDialog
      v-model:open="distillOpen"
      :title="`蒸馏 L2 · ${distillName}`"
      sub="把本项目原始记忆蒸成知识 / 决策 / 术语表"
      :running="!!busy"
      phase="读取记忆并调用模型归纳"
      :started-at="distillStartedAt"
      :result="distillResult"
    />
  </div>
</template>

<style scoped>
.proj-scope {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
}
.proj-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 520px;
  overflow: hidden;
  padding-bottom: 8px;
}
.proj-table-scroll {
  flex: 1;
  height: 100%;
  min-height: 480px;
  max-height: none;
  overflow-y: auto;
  overflow-x: hidden;
}
.proj-table {
  width: 100%;
  table-layout: fixed;
}
.proj-table th {
  text-align: center !important;
}
.proj-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.proj-name-text {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-slug-text {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-code);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-ellipsis-cell {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-ellipsis-cell span.mem-mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
