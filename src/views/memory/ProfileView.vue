<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 深层画像：4大核心维度分Tab展示 + 证据链追溯 + 本地持久缓存与WebDAV双重保护 + 原位/源码编辑 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import { useAiGuard } from "../../composables/useAiGuard";
import MemHelp from "../../components/memory/MemHelp.vue";
import MemProgressDialog from "../../components/memory/MemProgressDialog.vue";
import MemoryDetailDrawer from "../../components/memory/MemoryDetailDrawer.vue";

const app = useAppStore();
const mem = useMemoryStore();
/** AI 引导守卫：未配置模型 / 渠道报错时统一弹窗，一键去「设置 · 模型与网关」 */
const aiGuard = useAiGuard();
const active = computed(() => app.activeModule === "memory" && app.activePage === "profile");

type ProfileDimension = "persona" | "preferences" | "tech" | "habits";

/* 4大分区配置：图标、标题、副标题、语义字段、主题柔光 */
const SECTION_META: Record<ProfileDimension, { title: string; subtitle: string; icon: string; field: string }> = {
  persona: {
    title: "人格特质",
    subtitle: "思维倾向、决策模式与协作个性，帮助 Agent 理解你的深层思考习惯",
    icon: "ph-brain",
    field: "结论",
  },
  preferences: {
    title: "沟通偏好",
    subtitle: "语言风格、详略偏好与确认习惯，让回复口吻更符合你的日常预期",
    icon: "ph-chats",
    field: "偏好",
  },
  tech: {
    title: "技术偏好",
    subtitle: "技术栈选型、代码规范与工程习惯，严格遵循现有代码约定的事实源",
    icon: "ph-gear-six",
    field: "偏好",
  },
  habits: {
    title: "工作习惯",
    subtitle: "任务节奏、验证偏好与协作工作流，先查后改与一步到位的行动准则",
    icon: "ph-arrows-clockwise",
    field: "习惯",
  },
};

const DIMENSIONS: ProfileDimension[] = ["persona", "preferences", "tech", "habits"];
const currentTab = ref<ProfileDimension>("persona");

type Section = { name: string; path: string; text: string; exists: boolean };
const sections = ref<Section[]>([]);
const supersedeCount = ref(0);
const generating = ref(false);
const lastAt = ref(0);
const editing = ref("");

interface ParsedItem {
  text: string;
  isPinned: boolean;
  evidence: string[];
}

const parsed = computed(() => {
  const out: Record<string, ParsedItem[]> = {
    persona: [],
    preferences: [],
    tech: [],
    habits: [],
  };
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

const currentSection = computed(() => {
  return sections.value.find((s) => s.name === currentTab.value) || {
    name: currentTab.value,
    path: "",
    text: "",
    exists: false,
  };
});

const currentItems = computed(() => parsed.value[currentTab.value] || []);

async function refresh() {
  await mem.loadAll();
  try {
    const r = (await api.memoryProfileGet()) as { sections: Section[]; history: unknown[]; lastAt: number };
    sections.value = r.sections || [];
    lastAt.value = r.lastAt || 0;
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

/** 重新生成的进度弹窗 */
const genOpen = ref(false);
const genStartedAt = ref(0);
const genResult = ref<{ ok: boolean; message: string; extra?: string[] } | null>(null);

async function generate(dim?: ProfileDimension) {
  const label = dim ? `重新生成「${SECTION_META[dim]?.title || dim}」` : "重新生成全量画像";
  if (!(await aiGuard.ensureAiReady({ task: label }))) return;
  generating.value = true;
  genStartedAt.value = Date.now();
  genResult.value = null;
  genOpen.value = true;
  try {
    const r = await api.memoryProfileGenerate(dim);
    genResult.value = {
      ok: true,
      message: r.detail || "画像已更新并持久备份",
      extra: r.tokens ? [`消耗 ${formatInteger(r.tokens)} token`] : undefined,
    };
    await refresh();
  } catch (e) {
    aiGuard.handleAiError(e, { task: label });
    genResult.value = {
      ok: false,
      message: (e as Error).message || "生成失败：先在「设置 · 模型与网关」配置可用模型",
    };
  } finally {
    generating.value = false;
  }
}

/* 结构化编辑与原样保留 */
const rawLines = computed(() => {
  const out: Record<string, string[]> = {};
  for (const s of sections.value) {
    const lines = String(s.text || "").split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith("- ")) {
        const next = (lines[i + 1] || "").trim();
        if (next.startsWith("证据")) i++;
        continue;
      }
      if (t.startsWith("<!--")) continue;
      if (!t) continue;
      kept.push(line);
    }
    out[s.name] = kept;
  }
  return out;
});

const editItems = ref<{ text: string; isPinned: boolean; evidence: string[] }[]>([]);
const editRaw = ref<string[]>([]);
const sourceMode = ref(false);
const sourceText = ref("");
const saving = ref(false);

function startEdit(name: string) {
  editItems.value = (parsed.value[name] || []).map((x) => ({ ...x, evidence: [...x.evidence] }));
  editRaw.value = [...(rawLines.value[name] || [])];
  sourceText.value = sections.value.find((s) => s.name === name)?.text || "";
  sourceMode.value = false;
  editing.value = name;
}

function addItem() {
  editItems.value.push({ text: "", isPinned: false, evidence: [] });
}

function removeItem(i: number) {
  editItems.value.splice(i, 1);
}

function serialize(): string {
  const lines = ["<!-- 本文件由 AgentHub 记忆中枢生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->"];
  for (const it of editItems.value) {
    const text = String(it.text || "").trim();
    if (!text) continue;
    lines.push(`- ${it.isPinned ? "[pinned] " : ""}${text}`);
    if (it.evidence.length) lines.push(`  证据 [${it.evidence.length}]：${it.evidence.join(", ")}`);
  }
  for (const raw of editRaw.value) lines.push(raw);
  return lines.join("\n") + "\n";
}

async function saveEdit() {
  const name = editing.value;
  if (!name) return;
  const text = sourceMode.value ? sourceText.value : serialize();
  saving.value = true;
  try {
    await api.memoryProfileSave(name, text);
    ElMessage.success("已保存修改并同步到持久缓存");
    editing.value = "";
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
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
    ElMessage.success(`已复制「${SECTION_META[name as ProfileDimension]?.title || name}」全文`);
  } catch {
    ElMessage.error("复制失败");
  }
}

async function openHistory() {
  try {
    await api.memoryOpenDir("profile/.history");
  } catch (e) {
    ElMessage.error((e as Error).message || "打开历史目录失败");
  }
}

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
    <div class="mem-head profile-head-bar">
      <div class="mem-col" style="gap: 4px">
        <p class="mem-sub" style="margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <span>跨项目归纳的人格与偏好特征，每条带真实证据链；手动置顶的条目重新生成时保留</span>
          <MemHelp text="画像＝跨项目归纳出的「你是谁」，每条结论都带真实记忆证据链，让各 Agent 深刻理解你的偏好" />
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
        <button class="btn btn-cta" :disabled="generating" @click="generate()">
          <i class="ph ph-sparkle" style="margin-right: 4px"></i>
          {{ generating ? "正在生成…" : "重新生成全量画像" }}
        </button>
      </div>
    </div>

    <!-- 4 大核心维度 Tab 切换器 -->
    <div class="profile-tabs-wrapper">
      <div class="profile-tabs" role="tablist">
        <button
          v-for="dim in DIMENSIONS"
          :key="dim"
          class="profile-tab-btn"
          :class="{ active: currentTab === dim }"
          role="tab"
          :aria-selected="currentTab === dim"
          @click="currentTab = dim"
        >
          <div class="tab-icon">
            <i class="ph" :class="SECTION_META[dim].icon"></i>
          </div>
          <div class="tab-text-group">
            <div class="tab-title">
              {{ SECTION_META[dim].title }}
              <span v-if="(parsed[dim] || []).length" class="tab-count-badge">
                {{ (parsed[dim] || []).length }}
              </span>
            </div>
          </div>
        </button>
      </div>
    </div>

    <!-- 当前 Tab 维度的主面板展示 -->
    <div class="profile-main-card">
      <!-- 维度卡片头部 -->
      <div class="profile-panel-header">
        <div class="panel-header-left">
          <div class="panel-icon-box">
            <i class="ph" :class="SECTION_META[currentTab].icon"></i>
          </div>
          <div class="panel-title-group">
            <div class="panel-title-row">
              <h3 class="panel-title">{{ SECTION_META[currentTab].title }}</h3>
              <span class="panel-count-pill" v-if="currentItems.length">
                共 {{ currentItems.length }} 条归纳
              </span>
            </div>
            <p class="panel-subtitle">{{ SECTION_META[currentTab].subtitle }}</p>
          </div>
        </div>

        <div class="panel-header-actions">
          <template v-if="editing !== currentTab">
            <button
              v-if="currentItems.length"
              class="btn btn-ghost btn-sm"
              title="复制此维度 Markdown"
              @click="copySection(currentTab)"
            >
              <i class="ph ph-copy"></i>
              <span>复制 Markdown</span>
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="generating"
              title="只重新生成这一维度，更省 token"
              @click="generate(currentTab)"
            >
              <i class="ph ph-sparkle"></i>
              <span>单独生成</span>
            </button>
            <button
              class="btn btn-primary btn-sm"
              title="编辑该分区的条目"
              @click="startEdit(currentTab)"
            >
              <i class="ph ph-pencil-simple"></i>
              <span>编辑条目</span>
            </button>
          </template>
        </div>
      </div>

      <!-- 编辑模式 -->
      <div v-if="editing === currentTab" class="profile-edit-container">
        <div class="profile-edit-toolbar">
          <button class="btn btn-ghost btn-xs" @click="sourceMode = !sourceMode">
            <i class="ph" :class="sourceMode ? 'ph-rows' : 'ph-code'"></i>
            {{ sourceMode ? "回到结构化条目编辑" : "切换为源码模式（Markdown）" }}
          </button>
          <span class="mem-hint" style="font-size: 11.5px">
            {{ sourceMode ? "直接编辑 Markdown 源文本（请遵守标准条目格式）" : "勾选「置顶」的条目在重新生成时永久保留不被覆盖" }}
          </span>
        </div>

        <template v-if="sourceMode">
          <textarea
            v-model="sourceText"
            class="el-textarea__inner profile-textarea"
            rows="12"
            placeholder="输入 Markdown 源码内容..."
          ></textarea>
        </template>

        <template v-else>
          <div class="edit-items-list">
            <div v-for="(it, i) in editItems" :key="i" class="edit-item-row">
              <span class="edit-item-idx">{{ i + 1 }}</span>
              <input
                v-model="it.text"
                class="f-input edit-item-input"
                placeholder="填写一条具体的用户特征、沟通偏好或工作准则..."
              />
              <div class="edit-item-options">
                <el-tooltip content="置顶：重新生成画像时绝不被覆盖" placement="top">
                  <div
                    class="pinned-toggle"
                    :class="{ active: it.isPinned }"
                    @click="it.isPinned = !it.isPinned"
                  >
                    <i class="ph" :class="it.isPinned ? 'ph-push-pin-simple-fill' : 'ph-push-pin-simple'"></i>
                    <span>{{ it.isPinned ? "已置顶" : "置顶" }}</span>
                  </div>
                </el-tooltip>
                <span v-if="it.evidence.length" class="mem-chip" :title="it.evidence.join(', ')">
                  <i class="ph ph-link-simple" style="margin-right: 2px"></i>证据 {{ it.evidence.length }}
                </span>
                <button class="btn-link delete-btn" title="删除这一条" @click="removeItem(i)">
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>

            <div class="edit-add-bar">
              <button class="btn btn-ghost btn-sm" @click="addItem">
                <i class="ph ph-plus"></i> 添加一条结论/偏好
              </button>
            </div>

            <div v-if="editRaw.length" class="mem-hint edit-raw-tip">
              原样保留 {{ editRaw.length }} 行非条目内容（保存时原样写回）：
              <span class="mem-mono">{{ editRaw.slice(0, 2).join(" / ").slice(0, 80) }}{{ editRaw.length > 2 ? " …" : "" }}</span>
            </div>
          </div>
        </template>

        <div class="profile-edit-footer">
          <button class="btn btn-ghost" @click="editing = ''">取消</button>
          <button class="btn btn-cta" :disabled="saving" @click="saveEdit">
            <i class="ph ph-check" style="margin-right: 4px"></i>
            {{ saving ? "保存中…" : "保存并更新持久缓存" }}
          </button>
        </div>
      </div>

      <!-- 查看模式 -->
      <div v-else class="profile-items-container">
        <div v-if="currentItems.length" class="profile-cards-flow">
          <div
            v-for="(item, i) in currentItems"
            :key="i"
            class="profile-item-card"
            :class="{ 'is-pinned': item.isPinned }"
          >
            <div class="item-card-header">
              <div class="item-meta-left">
                <span v-if="item.isPinned" class="pinned-badge">
                  <i class="ph ph-push-pin-simple-fill"></i>
                  置顶保留
                </span>
                <span class="item-index-badge">#{{ i + 1 }}</span>
              </div>
            </div>

            <div class="item-content-body">
              <p class="item-text">{{ item.text }}</p>
            </div>

            <!-- 证据链追溯 -->
            <div v-if="item.evidence.length" class="item-evidence-bar">
              <span class="evidence-title">
                <i class="ph ph-link-simple"></i>
                证据来源 ({{ item.evidence.length }}):
              </span>
              <div class="evidence-chips-wrap">
                <el-tooltip
                  v-for="e in item.evidence"
                  :key="e"
                  :content="`查看关联真实记忆：${e}`"
                  placement="top"
                >
                  <button class="evidence-chip-btn" @click="showEvidence(e)">
                    <i class="ph ph-file-text"></i>
                    <span>#{{ e.slice(-8) }}</span>
                  </button>
                </el-tooltip>
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态展示 -->
        <div v-else class="profile-empty-panel">
          <div class="empty-icon-box">
            <i class="ph ph-sparkle"></i>
          </div>
          <h4 class="empty-title">暂未归纳「{{ SECTION_META[currentTab].title }}」特征</h4>
          <p class="empty-subtitle">
            当前有效记忆共 {{ formatInteger(mem.stats?.total || 0) }} 条（建议至少积累 {{ formatInteger(Number(mem.cfg("deep.personaMinMemories", 30))) }} 条后启动归纳）
          </p>
          <div class="empty-actions">
            <button class="btn btn-primary btn-sm" @click="startEdit(currentTab)">
              <i class="ph ph-plus"></i> 手动添加偏好条目
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="generating"
              @click="generate(currentTab)"
            >
              <i class="ph ph-sparkle"></i> 尝试AI自动归纳
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 证据链详情抽屉 -->
    <MemoryDetailDrawer
      :show="drawerOpen"
      :id="drawerId"
      @close="drawerOpen = false"
      @open="(id: string) => { drawerId = id; }"
      @changed="refresh"
    />

    <!-- 重新生成画像进度弹窗 -->
    <MemProgressDialog
      v-model:open="genOpen"
      title="重新生成画像"
      sub="深度归纳人格特质、沟通偏好、技术偏好与工作习惯，结果将持久化写入缓存与云端同步"
      :running="generating"
      phase="读取记忆素材并调用模型归纳特征"
      :detail="'自动严格关联真实记忆 ID 形成客观证据链，杜绝模型臆测与虚构'"
      :started-at="genStartedAt"
      :result="genResult"
    />
  </div>
</template>

<style scoped>
.profile-head-bar {
  margin-bottom: 2px;
}

/* 4 大核心维度 Tab 切换器 */
.profile-tabs-wrapper {
  margin-bottom: 12px;
}

.profile-tabs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  background: var(--mem-soft, rgba(125, 125, 125, 0.05));
  padding: 6px;
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--mem-line, var(--line));
}

@media (max-width: 860px) {
  .profile-tabs {
    grid-template-columns: repeat(2, 1fr);
  }
}

.profile-tab-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--r-md, 8px);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  color: var(--text-2);
  transition: all 0.2s var(--ease);
  position: relative;
  text-align: left;
}

.profile-tab-btn:hover {
  background: var(--bg-hover, rgba(125, 125, 125, 0.08));
  color: var(--text);
}

.profile-tab-btn.active {
  background: var(--glass-a, var(--panel));
  color: var(--text);
  border-color: var(--glass-bd, var(--line-strong));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.tab-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  color: var(--text-3);
  transition: all 0.2s;
}

.profile-tab-btn.active .tab-icon {
  background: var(--accent-dim, rgba(59, 130, 246, 0.15));
  color: var(--accent, #3b82f6);
}

.tab-text-group {
  flex: 1;
  min-width: 0;
}

.tab-title {
  font-size: 13.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.3;
}

.tab-count-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.12));
  color: var(--text-3);
}

.profile-tab-btn.active .tab-count-badge {
  background: var(--accent-dim, rgba(59, 130, 246, 0.2));
  color: var(--accent, #3b82f6);
}

/* 主面板容器 */
.profile-main-card {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 20px 24px;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 维度卡片头部 */
.profile-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--mem-line, var(--line));
  flex-wrap: wrap;
  gap: 12px;
}

.panel-header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.panel-icon-box {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  color: var(--accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.panel-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.panel-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}

.panel-count-pill {
  font-size: 11.5px;
  padding: 1px 8px;
  border-radius: 12px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.1));
  color: var(--text-2);
}

.panel-subtitle {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.4;
}

.panel-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 按钮小尺寸微调 */
.btn-sm {
  font-size: 12px;
  padding: 4px 10px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.btn-xs {
  font-size: 11px;
  padding: 2px 8px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 条目卡片流 */
.profile-cards-flow {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.profile-item-card {
  padding: 14px 18px;
  border-radius: var(--r-md, 10px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.12));
  border-left: 4px solid var(--accent, #3b82f6);
  transition: all 0.2s var(--ease);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-item-card:hover {
  background: var(--bg-hover, rgba(125, 125, 125, 0.09));
  border-color: var(--line-strong, rgba(125, 125, 125, 0.25));
  border-left-color: var(--accent, #3b82f6);
}

.profile-item-card.is-pinned {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.05);
}

.profile-item-card.is-pinned:hover {
  background: rgba(245, 158, 11, 0.09);
  border-left-color: #f59e0b;
}

.item-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.item-meta-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pinned-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
}

.item-index-badge {
  font-size: 11px;
  font-family: var(--font-code, monospace);
  color: var(--text-3);
}

.item-content-body {
  margin: 0;
}

.item-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}

.item-evidence-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px dashed var(--mem-line, rgba(125, 125, 125, 0.1));
}

.evidence-title {
  font-size: 11px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.evidence-chips-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.evidence-chip-btn {
  font-family: var(--font-code, monospace);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.18));
  color: var(--accent, #3b82f6);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

.evidence-chip-btn:hover {
  background: var(--accent-dim, rgba(59, 130, 246, 0.15));
  border-color: var(--accent, #3b82f6);
}

/* 空状态 */
.profile-empty-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon-box {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  margin-bottom: 12px;
}

.empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.empty-subtitle {
  margin: 6px 0 16px;
  font-size: 12.5px;
  color: var(--text-3);
}

.empty-actions {
  display: flex;
  gap: 10px;
}

/* 编辑区 */
.profile-edit-container {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.profile-edit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--mem-line, rgba(125, 125, 125, 0.15));
}

.profile-textarea {
  font-family: var(--font-code, monospace);
  font-size: 13px;
  line-height: 1.6;
  width: 100%;
  padding: 12px;
  border-radius: var(--r-md, 8px);
  background: var(--input-bg, var(--bg-soft));
  color: var(--text);
  border: 1px solid var(--line);
}

.edit-items-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.edit-item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.1));
}

.edit-item-idx {
  font-size: 12px;
  font-family: var(--font-code, monospace);
  color: var(--text-3);
  width: 20px;
  text-align: center;
}

.edit-item-input {
  flex: 1;
}

.edit-item-options {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pinned-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
}

.pinned-toggle:hover {
  color: var(--text);
  border-color: var(--text-3);
}

.pinned-toggle.active {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.35);
}

.delete-btn {
  font-size: 14px;
  color: var(--text-3);
  padding: 4px;
}

.delete-btn:hover {
  color: var(--danger, #ef4444);
}

.edit-add-bar {
  margin-top: 4px;
}

.edit-raw-tip {
  margin-top: 6px;
  font-size: 11.5px;
}

.profile-edit-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--mem-line, var(--line));
}
</style>
