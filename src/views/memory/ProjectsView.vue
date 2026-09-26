<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 项目归档：项目卡网格 + 归类溯源（只显示可疑项）+ 低频维护动作收进卡片菜单 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryProjectCard } from "../../types";
import { timeAgo } from "../../composables/useFormat";
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

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return projects.value;
  return projects.value.filter((p) => `${p.name} ${p.slug} ${(p.aliases || []).join(" ")}`.toLowerCase().includes(q));
});

async function refresh() {
  await mem.loadAll();
  try {
    const r = await api.memoryProjects();
    projects.value = r.projects;
    general.value = r.general;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取项目失败");
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
  // 跳转前落预过滤：BrowseView 的 watch 会消费它并真正应用项目过滤
  mem.browsePrefilter = p.slug;
  app.activePage = "browse";
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
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        一个 Git 项目一个文件夹（标识 slug 只由远程地址决定，跨机器归并到同一目录）
        <MemHelp text="归类只认 Git 远程地址：同一仓库在不同电脑、不同路径下都会落到同一个项目文件夹（文件夹名＝owner--repo）。没有远程地址时才退化为按目录名/名称模糊匹配，且只给建议、不自动归。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="suggestCount" class="mem-chip click warn" @click="mem.gotoReview('classify')">{{ suggestCount }} 条待确认归类 →</button>
      </div>
    </div>

    <div class="mem-toolbar">
      <input v-model="query" class="f-input mem-grow" style="max-width: 280px" placeholder="搜索项目" />
      <span class="mem-chip">共 {{ projects.length }} 个项目</span>
      <span class="mem-chip">通用（general）{{ general.count }} 条</span>
    </div>

    <div class="mem-grid mem-grid-3">
      <div v-for="p in filtered" :key="p.slug" class="mem-tile">
        <div class="mem-tile-head">
          <span class="t-name">{{ p.name }}</span>
          <span class="mem-chip" :class="p.latest > Date.now() - 7 * 86400000 ? 'accent' : ''">
            {{ p.latest > Date.now() - 7 * 86400000 ? "活跃" : "静默" }}
          </span>
        </div>
        <div class="mem-kv" style="grid-template-columns: 64px minmax(0,1fr); font-size: 11.5px">
          <span class="k">远程</span>
          <span class="v">
            <span v-if="p.remotes.length" class="mem-mono">{{ p.remotes.join(" · ") }}</span>
            <span v-else class="mem-chip warn">无远程地址（名称归类）</span>
          </span>
          <!-- 归类依据只在最弱档（按名称猜）时提示：其余档位是算法细节 -->
          <template v-if="p.origin === 'fuzzy'">
            <span class="k">归入依据</span>
            <span class="v"><span class="mem-chip warn">名称模糊匹配（最弱，可质疑）</span></span>
          </template>
          <span class="k">本地路径</span>
          <span class="v">
            <span class="mem-mono">{{ (p.localPaths || []).join(" · ") || "—" }}</span>
            <span v-if="(p.localPaths || []).length > 1" class="mem-chip accent" style="margin-left: 6px">{{ p.localPaths.length }} 机</span>
          </span>
          <span class="k">统计</span>
          <span class="v">记忆 {{ p.count }} 条 · L2 {{ p.l2 }} 条 · 最近 {{ timeAgo(p.latest) }}</span>
          <span class="k">Agent</span>
          <span class="v">{{ (p.agents || []).join(" · ") || "—" }}</span>
        </div>
        <div class="mem-tile-foot">
          <button class="btn btn-cta" @click="openMemories(p)">查看记忆</button>
          <el-dropdown trigger="click" @command="(c: string) => cardAction(p, c)">
            <button class="mem-chip click" :disabled="busy === p.slug">{{ busy === p.slug ? "处理中…" : "⋯" }}</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="distill">蒸馏 L2</el-dropdown-item>
                <el-dropdown-item command="rename">重命名项目</el-dropdown-item>
                <el-dropdown-item command="merge">合并到…</el-dropdown-item>
                <el-dropdown-item command="general" divided>移入通用项目</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <MemHelp text="蒸馏 L2：把本项目原始记忆蒸成知识/决策/术语表（耗 token，会先弹确认）。合并到…：把本项目记忆全部搬到目标项目并清理本文件夹。移入通用项目：适合「根本不是项目」的误归类，单次最多处理 500 条，超出请再点一次。" />
        </div>
      </div>
      <div v-if="!filtered.length" class="mem-card mem-empty">还没有项目。让 Agent 带上项目路径写记忆，或手动记一条并选项目。</div>
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
