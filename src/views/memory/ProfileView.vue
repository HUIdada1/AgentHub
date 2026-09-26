<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 深层画像：画像卡组（证据链可展开、可就地编辑）+ 生成；失效队列在「待确认」收件箱里处理 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";
import MemoryDetailDrawer from "../../components/memory/MemoryDetailDrawer.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "profile");

/* 分区图标沿用全站 ph 图标体系（与配置页分组同源），不再用 emoji */
const SECTION_META: Record<string, { title: string; icon: string; field: string }> = {
  persona: { title: "人格特质", icon: "ph-brain", field: "结论" },
  preferences: { title: "沟通偏好", icon: "ph-chats", field: "偏好" },
  tech: { title: "技术偏好", icon: "ph-gear-six", field: "偏好" },
  habits: { title: "工作习惯", icon: "ph-arrows-clockwise", field: "习惯" },
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

/** 重新生成的进度弹窗：这一步要读素材 + 调模型，耗时以分钟计，进度只能给到阶段与时长 */
const genOpen = ref(false);
const genStartedAt = ref(0);
const genResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);

async function generate() {
  generating.value = true;
  genStartedAt.value = Date.now();
  genResult.value = null;
  genOpen.value = true;
  try {
    const r = await api.memoryProfileGenerate();
    genResult.value = { ok: true, message: r.detail || "画像已更新", extra: r.tokens ? [`消耗 ${formatInteger(r.tokens)} token`] : undefined };
    await refresh();
  } catch (e) {
    genResult.value = { ok: false, message: (e as Error).message || "生成失败：先在「模型与网关」配置可用模型" };
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
    ElMessage.success("已保存");
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

/** 证据链点击 = 打开记忆详情抽屉（原来只 toast 标题，看不到正文/标签/相关记忆） */
const drawerOpen = ref(false);
const drawerId = ref("");
function showEvidence(id: string) {
  if (!id) return;
  drawerId.value = id;
  drawerOpen.value = true;
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
        <button class="btn btn-ghost" @click="openHistory">历史版本目录</button>
        <button class="btn btn-cta" :disabled="generating" @click="generate">
          {{ generating ? "生成中…" : "重新生成画像" }}
        </button>
        <MemHelp text="生成会读素材（L2 深层记忆 + 高重要度记忆）并调用模型，属于花 token 的操作；素材太少时会拒绝生成并提示先积累记忆。每次生成前会把旧版本留档到 profile/.history/（回滚＝手动复制覆盖，程序不改写留档）。进度与结果会显示在弹窗里。" />
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div v-for="s in sections" :key="s.name" class="mem-card">
        <div class="mem-card-title">
          <i class="ph" :class="SECTION_META[s.name]?.icon || 'ph-file-text'"></i>
          {{ SECTION_META[s.name]?.title || s.name }}
          <span class="mem-row" style="gap: 6px">
            <button class="mem-chip click" @click="startEdit(s.name)">✏️ 编辑</button>
            <MemHelp text="手改后写回该分区的 md 文件；想让它下次生成不被覆盖，就以 [pinned] 开头写一行。" />
          </span>
        </div>

        <template v-if="editing === s.name">
          <textarea v-model="draft" class="el-textarea__inner" rows="8"></textarea>
          <div class="mem-hint" style="margin-top: 4px">
            以 <code>[pinned]</code> 开头的手改内容，下次重新生成不会被覆盖
          </div>
          <div class="mem-row" style="margin-top: 8px">
            <button class="btn btn-cta" @click="saveEdit">保存</button>
            <button class="btn btn-ghost" @click="editing = ''">取消</button>
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
            还没有内容 —— 当前 {{ formatInteger(mem.stats?.total || 0) }} 条 / 需要
            {{ formatInteger(Number(mem.cfg("deep.personaMinMemories", 30))) }} 条记忆才能生成
          </div>
        </template>
      </div>
    </div>

    <!-- 证据链查看：复用统一的记忆详情抽屉（含正文/标签/演化链/相关记忆） -->
    <MemoryDetailDrawer
      :show="drawerOpen"
      :id="drawerId"
      @close="drawerOpen = false"
      @open="(id: string) => { drawerId = id; }"
      @changed="refresh"
    />

    <!-- 重新生成画像的进度弹窗：读素材 + 调模型，耗时较长，结果也在这里看 -->
    <MemProgressDialog
      v-model:open="genOpen"
      title="重新生成画像"
      sub="读 L2 深层记忆与高重要度记忆，调用模型归纳稳定特征"
      :running="generating"
      phase="归纳人格特质 / 沟通偏好 / 技术偏好 / 工作习惯"
      :detail="'每次都要求模型为每条结论附真实记忆 id 作为证据链，防止编造人格'"
      :started-at="genStartedAt"
      :result="genResult"
    />
  </div>
</template>
