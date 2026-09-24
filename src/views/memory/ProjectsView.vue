<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 项目归档：项目卡网格 / 树视图 + 归类溯源 + 待确认归类 + 合并拆分重命名 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryProjectCard } from "../../types";
import { timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "projects");

const view = ref<"card" | "tree">("card");
const query = ref("");
const projects = ref<MemoryProjectCard[]>([]);
const general = ref({ count: 0, latest: 0 });
const suggestions = ref<{ id: string; slug: string; name: string; score: number; candidate: string; memoryId: string; title: string; path: string }[]>([]);
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
    suggestions.value = s.items;
  } catch {
    /* 忽略 */
  }
}

async function confirmSuggestion(item: { id: string; slug: string }, slug: string | null) {
  try {
    if (slug) await api.memoryProjectConfirm(item.id, slug);
    else await api.memoryProjectConfirm(item.id, null);
    ElMessage.success(slug ? `已归入 ${slug}` : "已标记为独立记忆");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  }
}

async function rename(p: MemoryProjectCard) {
  let name = "";
  try {
    const r = await ElMessageBox.prompt("项目显示名（slug 与目录名不变，避免同步冲突）", "重命名项目", {
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

async function mergeInto(p: MemoryProjectCard) {
  const others = projects.value.filter((x) => x.slug !== p.slug);
  if (!others.length) {
    ElMessage.info("没有可合并的其它项目");
    return;
  }
  try {
    const r = await ElMessageBox.prompt(
      `把「${p.name}」的全部记忆并入目标项目（输入目标 slug，可选：${others.slice(0, 5).map((o) => o.slug).join(" / ")}）`,
      "合并项目",
      { inputPlaceholder: others[0].slug },
    );
    const target = (r.value || "").trim();
    if (!target) return;
    if (!others.some((o) => o.slug === target)) {
      ElMessage.warning("目标项目不存在");
      return;
    }
    const res = await api.memoryProjectMerge(p.slug, target);
    ElMessage.success(`已合并 ${res.moved} 条到 ${target}`);
    await refresh();
  } catch (e) {
    if (e instanceof Error) ElMessage.error(e.message || "合并失败");
  }
}

async function moveToGeneral(p: MemoryProjectCard) {
  try {
    await ElMessageBox.confirm(`把「${p.name}」的全部记忆移入 general（普通对话区）？`, "移入 general", { type: "warning" });
  } catch {
    return;
  }
  try {
    // 逐条改归属要经写队列，条数多时只处理前 500 条，避免长时间占用队列
    const list = await api.memoryList({ project: p.slug, pageSize: 500, includeSuperseded: true });
    const res = await api.memoryProjectAssign(list.rows.map((r) => r.id), null);
    ElMessage.success(`已移出 ${res.moved} 条`);
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

async function runDistill(p: MemoryProjectCard) {
  busy.value = p.slug;
  try {
    const r = await api.memoryDistillRun({ project: p.slug });
    ElMessage.success(r.detail || "蒸馏完成");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "蒸馏失败（先在「模型与网关」配置模型）");
  } finally {
    busy.value = "";
  }
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
        一个 Git 项目一个文件夹（slug 只由远程地址决定，跨机器归并到同一目录）
        <MemHelp text="归类只认 Git 远程地址：同一仓库在不同电脑、不同路径下都会落到同一个项目文件夹（文件夹名＝owner--repo）。没有远程地址时才退化为按目录名/名称模糊匹配，且只给建议、不自动归。" />
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small" @click="view = view === 'card' ? 'tree' : 'card'">
          {{ view === "card" ? "树视图" : "卡片视图" }}
        </button>
        <button class="el-button el-button--small" @click="refresh">刷新</button>
      </div>
    </div>

    <div class="mem-toolbar">
      <input v-model="query" class="el-input__inner mem-grow" style="max-width: 280px" placeholder="搜索项目" />
      <span class="mem-chip">共 {{ projects.length }} 个项目</span>
      <span class="mem-chip" :class="suggestions.length ? 'warn' : ''">{{ suggestions.length }} 条待确认归类</span>
      <span class="mem-chip">general {{ general.count }} 条</span>
    </div>

    <div v-if="suggestions.length" class="mem-card">
      <div class="mem-card-title">
        待确认归类
        <span class="mem-hint">名称模糊匹配，不自动合并 —— 归错了会污染目录结构且难察觉</span>
        <MemHelp text="没有 Git 地址的记忆，会拿它的目录名/标题跟已有项目比相似度。够像就出现在这里等你点头：「确认归入」会把记忆搬进该项目文件夹，「不是同一项目」则保持独立。" />
      </div>
      <div class="mem-col">
        <div v-for="s in suggestions" :key="s.id" class="mem-chain-node" style="flex-wrap: wrap; gap: 8px">
          <span class="mem-chip warn">置信 {{ s.score }}</span>
          <span>「{{ s.candidate || s.title }}」</span>
          <span style="color: var(--text-3)">疑似属于</span>
          <span class="mem-chip accent">{{ s.name }}</span>
          <span style="margin-left: auto; display: flex; gap: 6px">
            <button class="el-button el-button--small el-button--primary" @click="confirmSuggestion(s, s.slug)">确认归入</button>
            <button class="el-button el-button--small" @click="confirmSuggestion(s, null)">不是同一项目</button>
          </span>
        </div>
      </div>
    </div>

    <div v-if="view === 'card'" class="mem-grid mem-grid-3">
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
          <span class="k">归入依据<MemHelp text="这条项目的记忆按什么规则归进来的：git remote（最可靠）／仓库目录名／Agent 显式指定／名称模糊匹配（最弱，可质疑）。" /></span>
          <span class="v">{{ p.origin === "git" ? "git remote" : p.origin === "gitroot" ? "仓库目录名" : p.origin === "explicit" ? "Agent 显式指定" : "名称模糊匹配" }}</span>
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
          <button class="el-button el-button--small" @click="openMemories(p)">查看记忆</button>
          <button class="el-button el-button--small" :disabled="busy === p.slug" @click="runDistill(p)">{{ busy === p.slug ? "蒸馏中…" : "蒸馏 L2" }}</button>
          <button class="el-button el-button--small" @click="rename(p)">重命名</button>
          <button class="el-button el-button--small" @click="mergeInto(p)">合并到…</button>
          <MemHelp text="项目重复了（例如改名前后各建了一个）就用合并：把本项目的记忆全部搬到目标项目，并清理本项目文件夹。搬迁不改记忆内容。" />
          <button class="el-button el-button--small" @click="moveToGeneral(p)">移入 general</button>
          <MemHelp text="把整个项目移出项目区、落到 general（普通对话区）：适合「根本不是项目」的误归类。单次最多搬 500 条，超过可重复点。" />
        </div>
      </div>
      <div v-if="!filtered.length" class="mem-card mem-empty">还没有项目。让 Agent 带上项目路径写记忆，或手动记一条并选项目。</div>
    </div>

    <div v-else class="mem-card">
      <div class="mem-card-title">树视图（项目 → Agent → 日期文件）</div>
      <div class="mem-col" style="gap: 6px">
        <div v-for="p in filtered" :key="p.slug" class="mem-chain-node" style="cursor: default">
          <span class="mem-chip accent">{{ p.count }}</span>
          <span style="font-weight: 600">{{ p.name }}</span>
          <span class="mem-mono" style="color: var(--text-3)">{{ p.slug }}</span>
          <span style="margin-left: auto; color: var(--text-3)">
            {{ (p.agents || []).map((a) => `${a}`).join(" · ") }}
          </span>
        </div>
        <div class="mem-chain-node" style="cursor: default">
          <span class="mem-chip">{{ general.count }}</span>
          <span style="font-weight: 600">general（无项目归属）</span>
          <span style="margin-left: auto; color: var(--text-3)">最近 {{ general.latest ? timeAgo(general.latest) : "—" }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
