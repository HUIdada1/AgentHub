<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 项目归档：项目卡网格 + 归类溯源（只显示可疑项）+ 低频维护动作收进卡片菜单 -->
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

/** 卡片维护动作菜单（原来五个按钮平铺，只有「查看记忆」是高频） */
function cardAction(p: MemoryProjectCard, cmd: string) {
  if (cmd === "distill") void runDistill(p);
  else if (cmd === "rename") void rename(p);
  else if (cmd === "merge") void mergeInto(p);
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
        一个 Git 项目一个文件夹（slug 只由远程地址决定，跨机器归并到同一目录）
        <MemHelp text="归类只认 Git 远程地址：同一仓库在不同电脑、不同路径下都会落到同一个项目文件夹（文件夹名＝owner--repo）。没有远程地址时才退化为按目录名/名称模糊匹配，且只给建议、不自动归。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="suggestCount" class="mem-chip click warn" @click="mem.gotoReview('classify')">{{ suggestCount }} 条待确认归类 →</button>
      </div>
    </div>

    <div class="mem-toolbar">
      <input v-model="query" class="el-input__inner mem-grow" style="max-width: 280px" placeholder="搜索项目" />
      <span class="mem-chip">共 {{ projects.length }} 个项目</span>
      <span class="mem-chip">general {{ general.count }} 条</span>
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
          <button class="el-button el-button--small el-button--primary" @click="openMemories(p)">查看记忆</button>
          <el-dropdown trigger="click" @command="(c: string) => cardAction(p, c)">
            <button class="mem-chip click" :disabled="busy === p.slug">{{ busy === p.slug ? "蒸馏中…" : "⋯" }}</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="distill">蒸馏 L2</el-dropdown-item>
                <el-dropdown-item command="rename">重命名项目</el-dropdown-item>
                <el-dropdown-item command="merge">合并到…</el-dropdown-item>
                <el-dropdown-item command="general" divided>移入 general</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <MemHelp text="蒸馏 L2：把本项目原始记忆蒸成知识/决策/术语表（花 token）。合并到…：把本项目记忆全部搬到目标项目并清理本文件夹。移入 general：适合「根本不是项目」的误归类，单次最多搬 500 条。" />
        </div>
      </div>
      <div v-if="!filtered.length" class="mem-card mem-empty">还没有项目。让 Agent 带上项目路径写记忆，或手动记一条并选项目。</div>
    </div>
  </div>
</template>
