<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 深层画像：4大核心维度卡片 + 证据链追溯 + 本地持久缓存与WebDAV双重保护 + 原位编辑 -->
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

/* 4大分区配置：图标、标题、副标题、语义字段 */
const SECTION_META: Record<string, { title: string; subtitle: string; icon: string; field: string }> = {
  persona: {
    title: "人格特质",
    subtitle: "思维倾向、决策模式与协作个性",
    icon: "ph-brain",
    field: "结论",
  },
  preferences: {
    title: "沟通偏好",
    subtitle: "语言风格、详略偏好与确认习惯",
    icon: "ph-chats",
    field: "偏好",
  },
  tech: {
    title: "技术偏好",
    subtitle: "技术栈选型、代码规范与工程习惯",
    icon: "ph-gear-six",
    field: "偏好",
  },
  habits: {
    title: "工作习惯",
    subtitle: "任务节奏、验证偏好与协作工作流",
    icon: "ph-arrows-clockwise",
    field: "习惯",
  },
};

type Section = { name: string; path: string; text: string; exists: boolean };
const sections = ref<Section[]>([]);
const supersedeCount = ref(0);
const generating = ref(false);
const lastAt = ref(0);
const hasCache = ref(false);
const editing = ref<string>("");
const draft = ref("");

interface ParsedItem {
  text: string;
  isPinned: boolean;
  evidence: string[];
}

const parsed = computed(() => {
  const out: Record<string, ParsedItem[]> = {};
  for (const s of sections.value) {
    const items: ParsedItem[] = [];
    const lines = String(s.text || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- ")) {
        let rawText = line.slice(2).trim();
        const next = (lines[i + 1] || "").trim();
        const evidence = next.startsWith("证据") ? (next.split("：")[1] || "").split(/[,，]\s*/).filter(Boolean) : [];
        if (!rawText.startsWith("<!--")) {
          const isPinned = rawText.startsWith("[pinned]");
          if (isPinned) {
            rawText = rawText.replace(/^\[pinned\]\s*/i, "");
          }
          items.push({ text: rawText, isPinned, evidence });
        }
      }
    }
    out[s.name] = items;
  }
  return out;
});

async function refresh() {
  await mem.loadAll();
  try {
    const r = await api.memoryProfileGet() as { sections: Section[]; history: unknown[]; lastAt: number; hasCache?: boolean };
    sections.value = r.sections;
    lastAt.value = r.lastAt;
    hasCache.value = !!r.hasCache;
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
    genResult.value = { ok: true, message: r.detail || "画像已更新并持久备份", extra: r.tokens ? [`消耗 ${formatInteger(r.tokens)} token`] : undefined };
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

function insertPinnedTag() {
  draft.value = `- [pinned] ` + draft.value.replace(/^- /, "");
}

async function saveEdit() {
  try {
    await api.memoryProfileSave(editing.value, draft.value);
    ElMessage.success("已保存修改并同步到持久缓存");
    editing.value = "";
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function copySection(name: string) {
  const s = sections.value.find((x) => x.name === name);
  if (!s || !s.text) {
    ElMessage.info("暂无可复制内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(s.text);
    ElMessage.success(`已复制「${SECTION_META[name]?.title || name}」全文`);
  } catch {
    ElMessage.error("复制失败");
  }
}

/** 打开画像历史留档目录 */
function openHistory() {
  void api.memoryOpenDir("profile/.history");
}

/** 证据链点击 = 打开记忆详情抽屉 */
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
    <!-- 顶部状态栏与操作栏 -->
    <div class="mem-head">
      <div class="mem-col" style="gap: 4px">
        <p class="mem-sub" style="margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <span>跨项目归纳的人格与偏好特征，每条带真实证据链；手改内容加 <code>[pinned]</code> 永久保留</span>
          <MemHelp text="画像＝跨项目归纳出的「你是谁」：人格特质、沟通偏好、技术偏好、工作习惯。每条结论都附带依据的真实记忆 ID（证据链），点击证据即可查看原始记录。即使版本升级或切换目录，也会通过本地持久缓存和 WebDAV 保持双向自愈，绝不丢失。" />
        </p>
        <div class="mem-row" style="gap: 8px; font-size: 12px; margin-top: 4px; flex-wrap: wrap">
          <span class="mem-chip" style="background: rgba(34, 197, 94, 0.12); color: #16a34a; border: 1px solid rgba(34, 197, 94, 0.25)">
            <i class="ph ph-shield-check" style="margin-right: 4px"></i>持久缓存与 WebDAV 同步保护中
          </span>
          <span v-if="lastAt" class="mem-chip info">
            <i class="ph ph-clock" style="margin-right: 4px"></i>上次处理 {{ timeAgo(lastAt) }}
          </span>
          <span class="mem-chip">
            <i class="ph ph-database" style="margin-right: 4px"></i>记忆素材 {{ formatInteger(mem.stats?.total || 0) }} 条
          </span>
        </div>
      </div>

      <div class="mem-head-actions">
        <button v-if="supersedeCount" class="btn-outline" @click="mem.gotoReview('supersede')">
          {{ supersedeCount }} 条待确认失效 →
        </button>
        <button class="btn btn-ghost" @click="openHistory">
          <i class="ph ph-folder-open" style="margin-right: 4px"></i>历史留档
        </button>
        <button class="btn btn-cta" :disabled="generating" @click="generate">
          <i class="ph ph-sparkle" style="margin-right: 4px"></i>
          {{ generating ? "正在生成…" : "重新生成画像" }}
        </button>
      </div>
    </div>

    <!-- 4 大核心维度画像网格卡片 -->
    <div class="profile-grid">
      <div v-for="s in sections" :key="s.name" class="profile-card">
        <!-- 卡片头部 -->
        <div class="profile-card-header">
          <div class="profile-card-title-group">
            <div class="profile-card-icon">
              <i class="ph" :class="SECTION_META[s.name]?.icon || 'ph-file-text'"></i>
            </div>
            <div>
              <div class="profile-card-title">
                {{ SECTION_META[s.name]?.title || s.name }}
                <span v-if="(parsed[s.name] || []).length" class="profile-count-badge">
                  {{ (parsed[s.name] || []).length }} 项
                </span>
              </div>
              <div class="profile-card-desc">
                {{ SECTION_META[s.name]?.subtitle || "" }}
              </div>
            </div>
          </div>

          <div class="profile-card-actions">
            <button
              v-if="editing !== s.name && (parsed[s.name] || []).length"
              class="btn btn-ghost btn-sm"
              title="复制此分区 Markdown"
              @click="copySection(s.name)"
            >
              <i class="ph ph-copy"></i>
            </button>
            <button
              v-if="editing !== s.name"
              class="btn btn-ghost btn-sm"
              title="编辑该分区 Markdown"
              @click="startEdit(s.name)"
            >
              <i class="ph ph-pencil-simple"></i> 编辑
            </button>
          </div>
        </div>

        <!-- 编辑模式 -->
        <div v-if="editing === s.name" class="profile-edit-box">
          <div class="profile-edit-toolbar">
            <button class="btn btn-ghost btn-xs" @click="insertPinnedTag">
              📌 插入 [pinned] 置顶标记
            </button>
            <span class="mem-hint" style="font-size: 11px">
              以 <code>[pinned]</code> 开头的行下次生成不会被覆盖
            </span>
          </div>
          <textarea
            v-model="draft"
            class="el-textarea__inner profile-textarea"
            rows="10"
            placeholder="输入 Markdown 内容，例如：\n- 结论描述\n  证据：id1, id2"
          ></textarea>
          <div class="mem-row" style="margin-top: 10px; justify-content: flex-end; gap: 8px">
            <button class="btn btn-ghost" @click="editing = ''">取消</button>
            <button class="btn btn-cta" @click="saveEdit">保存并更新缓存</button>
          </div>
        </div>

        <!-- 查看模式 -->
        <div v-else class="profile-content-box">
          <div v-if="(parsed[s.name] || []).length" class="profile-item-list">
            <div
              v-for="(item, i) in parsed[s.name]"
              :key="i"
              class="profile-item-row"
              :class="{ 'is-pinned': item.isPinned }"
            >
              <div class="profile-item-main">
                <div class="profile-item-text">
                  <span v-if="item.isPinned" class="pinned-tag" title="此条为手动置顶，重新生成不被覆盖">
                    <i class="ph ph-push-pin-simple"></i> 置顶保留
                  </span>
                  <span>{{ item.text }}</span>
                </div>

                <!-- 证据链气泡 -->
                <div v-if="item.evidence.length" class="profile-evidence-row">
                  <span class="evidence-label">
                    <i class="ph ph-link-simple"></i> 证据链:
                  </span>
                  <button
                    v-for="e in item.evidence"
                    :key="e"
                    class="evidence-chip"
                    title="点击查看记忆详情"
                    @click="showEvidence(e)"
                  >
                    #{{ e.slice(-6) }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 空状态 -->
          <div v-else class="profile-empty-box">
            <i class="ph ph-sparkle profile-empty-icon"></i>
            <div class="profile-empty-title">暂未归纳该维度特征</div>
            <div class="profile-empty-desc">
              当前有效记忆 {{ formatInteger(mem.stats?.total || 0) }} 条（门槛建议至少 {{ formatInteger(Number(mem.cfg("deep.personaMinMemories", 30))) }} 条）
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top: 8px" @click="startEdit(s.name)">
              手动添加偏好
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 证据链查看：统一记忆详情抽屉 -->
    <MemoryDetailDrawer
      :show="drawerOpen"
      :id="drawerId"
      @close="drawerOpen = false"
      @open="(id: string) => { drawerId = id; }"
      @changed="refresh"
    />

    <!-- 重新生成画像的进度弹窗 -->
    <MemProgressDialog
      v-model:open="genOpen"
      title="重新生成画像"
      sub="归纳人格特质、沟通偏好、技术偏好与工作习惯，结果将写入全局持久缓存与云端同步"
      :running="generating"
      phase="读取记忆素材并调用模型归纳特征"
      :detail="'自动校验真实记忆 ID 作为证据链，防止模型虚构画像'"
      :started-at="genStartedAt"
      :result="genResult"
    />
  </div>
</template>

<style scoped>
.profile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-block, 16px);
}

@media (max-width: 960px) {
  .profile-grid {
    grid-template-columns: 1fr;
  }
}

.profile-card {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}

.profile-card:hover {
  border-color: var(--line-strong, var(--accent));
}

.profile-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line, rgba(125, 125, 125, 0.12));
}

.profile-card-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.profile-card-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--r-md, 8px);
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  color: var(--accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.profile-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile-count-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  color: var(--text-2, var(--text-secondary));
}

.profile-card-desc {
  font-size: 11.5px;
  color: var(--text-3, var(--text-muted));
  margin-top: 1px;
}

.profile-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-sm {
  font-size: 11.5px;
  padding: 2px 8px;
  height: 26px;
}

.btn-xs {
  font-size: 11px;
  padding: 1px 6px;
  height: 22px;
}

.profile-content-box {
  flex: 1;
  min-height: 120px;
}

.profile-item-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.profile-item-row {
  padding: 10px 12px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.06));
  border-left: 3px solid var(--accent, #3b82f6);
  transition: background 0.15s, border-color 0.15s;
}

.profile-item-row:hover {
  background: var(--bg-hover, rgba(125, 125, 125, 0.12));
}

.profile-item-row.is-pinned {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
}

.profile-item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.profile-item-text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;
}

.pinned-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
  margin-right: 6px;
}

.profile-evidence-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.evidence-label {
  font-size: 11px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.evidence-chip {
  font-family: var(--font-code, monospace);
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  border: 1px solid var(--line, rgba(125, 125, 125, 0.15));
  color: var(--accent, #3b82f6);
  cursor: pointer;
  transition: all 0.15s;
}

.evidence-chip:hover {
  border-color: var(--accent, #3b82f6);
  background: var(--accent-dim, rgba(59, 130, 246, 0.15));
}

.profile-edit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-edit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.profile-textarea {
  font-family: var(--font-code, monospace);
  font-size: 12.5px;
  line-height: 1.5;
  width: 100%;
  background: var(--input-bg, var(--bg-soft));
  color: var(--text);
  border-color: var(--line);
}

.profile-empty-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 16px;
  text-align: center;
}

.profile-empty-icon {
  font-size: 26px;
  color: var(--text-3);
  margin-bottom: 6px;
}

.profile-empty-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}

.profile-empty-desc {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
}
</style>
