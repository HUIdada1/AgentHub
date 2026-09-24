<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 深层画像：画像卡组（证据链可展开、可就地编辑）+ 生成；失效队列在「待确认」收件箱里处理 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "profile");

const SECTION_META: Record<string, { title: string; icon: string; field: string }> = {
  persona: { title: "人格特质", icon: "🧠", field: "结论" },
  preferences: { title: "沟通偏好", icon: "💬", field: "偏好" },
  tech: { title: "技术偏好", icon: "⚙️", field: "偏好" },
  habits: { title: "工作习惯", icon: "🔄", field: "习惯" },
};

type Section = { name: string; path: string; text: string; exists: boolean };
const sections = ref<Section[]>([]);
const supersedeCount = ref(0);
const generating = ref(false);
const lastAt = ref(0);
const editing = ref<string>("");
const draft = ref("");

const parsed = computed(() => {
  const out: Record<string, { text: string; evidence: string[] }[]> = {};
  for (const s of sections.value) {
    const items: { text: string; evidence: string[] }[] = [];
    const lines = String(s.text || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- ")) {
        const text = line.slice(2).trim();
        const next = (lines[i + 1] || "").trim();
        const evidence = next.startsWith("证据") ? (next.split("：")[1] || "").split(/[,，]\s*/).filter(Boolean) : [];
        if (!text.startsWith("<!--")) items.push({ text, evidence });
      }
    }
    out[s.name] = items;
  }
  return out;
});

async function refresh() {
  await mem.loadAll();
  try {
    const r = await api.memoryProfileGet();
    sections.value = r.sections;
    lastAt.value = r.lastAt;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取画像失败");
  }
  try {
    const q = await api.memoryReviewList("supersede");
    supersedeCount.value = q.items.length;
  } catch {
    /* 忽略 */
  }
}

async function generate() {
  generating.value = true;
  try {
    const r = await api.memoryProfileGenerate();
    ElMessage.success(r.detail || "画像已更新");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "生成失败：先在「模型与网关」配置可用模型");
  } finally {
    generating.value = false;
  }
}

function startEdit(name: string) {
  editing.value = name;
  draft.value = sections.value.find((s) => s.name === name)?.text || "";
}

async function saveEdit() {
  try {
    await api.memoryProfileSave(editing.value, draft.value);
    ElMessage.success("已保存（手改内容请以 [pinned] 开头，下次生成不会覆盖）");
    editing.value = "";
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

/** 打开画像历史留档目录（回滚 = 手动复制覆盖，程序不自动改写历史，避免留档被二次污染） */
function openHistory() {
  void api.memoryOpenDir("profile/.history");
}

async function showEvidence(id: string) {
  try {
    const r = await api.memoryGet(id);
    ElMessage.success(`证据原文：${r.memory.title}`);
  } catch {
    ElMessage.warning("该证据记忆已不存在（可能被删除或失效）");
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
        AI 蒸馏出的稳定特征，每条结论带证据链；手改内容标 [pinned] 不被覆盖
        <template v-if="lastAt">· 上次处理 {{ timeAgo(lastAt) }}</template>
        <MemHelp text="画像＝跨项目归纳出的「你是谁」：人格特质、沟通偏好、技术偏好、工作习惯。每条结论都必须附它依据的记忆 id（证据链），点证据可回原文，防止模型编造人格。" />
      </p>
      <div class="mem-head-actions">
        <button v-if="supersedeCount" class="mem-chip click warn" @click="mem.gotoReview('supersede')">{{ supersedeCount }} 条待确认失效 →</button>
        <button class="el-button el-button--small" @click="openHistory">历史版本目录</button>
        <button class="el-button el-button--small el-button--primary" :disabled="generating" @click="generate">
          {{ generating ? "生成中…" : "重新生成画像" }}
        </button>
        <MemHelp text="生成会读素材（L2 深层记忆 + 高重要度记忆）并调用模型，属于花 token 的操作；素材太少时会拒绝生成并提示先积累记忆。每次生成前会把旧版本留档到 profile/.history/（回滚＝手动复制覆盖，程序不改写留档）。" />
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div v-for="s in sections" :key="s.name" class="mem-card">
        <div class="mem-card-title">
          {{ SECTION_META[s.name]?.icon }} {{ SECTION_META[s.name]?.title || s.name }}
          <span class="mem-row" style="gap: 6px">
            <button class="mem-chip click" @click="startEdit(s.name)">✏️ 编辑</button>
            <MemHelp text="手改后写回该分区的 md 文件；想让它下次生成不被覆盖，就以 [pinned] 开头写一行。" />
          </span>
        </div>

        <template v-if="editing === s.name">
          <textarea v-model="draft" class="el-textarea__inner" rows="8"></textarea>
          <div class="mem-row" style="margin-top: 8px">
            <button class="el-button el-button--small el-button--primary" @click="saveEdit">保存</button>
            <button class="el-button el-button--small" @click="editing = ''">取消</button>
          </div>
        </template>

        <template v-else>
          <div v-if="(parsed[s.name] || []).length" class="mem-col">
            <div v-for="(item, i) in parsed[s.name]" :key="i" class="mem-chain-node" style="align-items: flex-start; flex-direction: column; gap: 4px">
              <span>{{ item.text }}</span>
              <span v-if="item.evidence.length" style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center">
                <span class="mem-hint">证据 [{{ item.evidence.length }}]</span>
                <button v-for="e in item.evidence.slice(0, 5)" :key="e" class="mem-chip click" @click="showEvidence(e)">{{ e }}</button>
              </span>
            </div>
          </div>
          <div v-else class="mem-empty">
            还没有内容 —— 点右上「重新生成画像」（需要先配置模型；素材至少
            {{ formatInteger(Number(mem.cfg("deep.personaMinMemories", 30))) }} 条记忆）
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
