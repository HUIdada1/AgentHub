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
<!-- 记忆中枢 · 深层画像：4大核心维度卡片 + 证据链追溯 + 本地持久缓存与WebDAV双重保护 + 原位编辑 -->
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
const editing = ref("");

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
    const r = await api.memoryProfileGet() as { sections: Section[]; history: unknown[]; lastAt: number };
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

async function generate(dim?: "persona" | "preferences" | "tech" | "habits") {
  const label = dim ? `重新生成「${SECTION_META[dim]?.title || dim}」` : "重新生成画像";
  // 前置守卫：三个来源全不可用时直接拦下（不白跑一轮长任务再报错）
  if (!(await aiGuard.ensureAiReady({ task: label }))) return;
  generating.value = true;
  genStartedAt.value = Date.now();
  genResult.value = null;
  genOpen.value = true;
  try {
    const r = await api.memoryProfileGenerate(dim);
    genResult.value = { ok: true, message: r.detail || "画像已更新并持久备份", extra: r.tokens ? [`消耗 ${formatInteger(r.tokens)} token`] : undefined };
    await refresh();
  } catch (e) {
    // 未配置 / 渠道报错：交给守卫弹「去设置配置」，结果弹窗里仍保留原始原因
    aiGuard.handleAiError(e, { task: label });
    genResult.value = { ok: false, message: (e as Error).message || "生成失败：先在「设置 · 模型与网关」配置可用模型" };
  } finally {
    generating.value = false;
  }
}

/* ===== 结构化编辑：每条结论一行（文本 / 置顶 / 删除），不再让用户手写 Markdown 源码 =====
   序列化回原格式（`- 文本` + `  证据 [N]：ids`），后端解析与 .history 留档完全兼容；
   解析不了的原始行（用户手改的非标格式）进「原样保留」列表，保存时原样写回，不丢弃原始内容。 */
const rawLines = computed(() => {
  const out: Record<string, string[]> = {};
  for (const s of sections.value) {
    const lines = String(s.text || "").split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith("- ")) {
        // 标准条目：连带其证据行一起消费（不重复计入原样保留）
        const next = (lines[i + 1] || "").trim();
        if (next.startsWith("证据")) i++;
        continue;
      }
      if (t.startsWith("<!--")) continue; // 生成器注释行：序列化时统一重建，不算用户内容
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

/** 结构化条目 → Markdown（与后端 _renderProfileSection 同格式） */
function serialize(): string {
  const lines = ["<!-- 本文件由 AgentHub 记忆中枢生成；置顶条目下次生成不会覆盖 -->"];
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
    ElMessage.success(`已复制「${SECTION_META[name]?.title || name}」全文`);
  } catch {
    ElMessage.error("复制失败");
  }
}

/** 打开画像历史留档目录：路径不存在等失败要提示，不能点了没反应 */
async function openHistory() {
  try {
    await api.memoryOpenDir("profile/.history");
  } catch (e) {
    ElMessage.error((e as Error).message || "打开历史目录失败");
  }
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
          <span>跨项目归纳的人格与偏好特征，每条带真实证据链；手动置顶的条目重新生成时保留</span>
          <MemHelp text="画像＝跨项目归纳出的「你是谁」，每条结论都带真实记忆证据链" />
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
            <el-tooltip
              v-if="editing !== s.name && (parsed[s.name] || []).length"
              content="复制此分区 Markdown"
              placement="top"
            >
              <button
                class="btn btn-ghost btn-sm"
                @click="copySection(s.name)"
              >
                <i class="ph ph-copy"></i>
              </button>
            </el-tooltip>
            <el-tooltip
              v-if="editing !== s.name"
              content="只重新生成这一维度（其余维度不动，更省 token）"
              placement="top"
            >
              <button
                class="btn btn-ghost btn-sm"
                :disabled="generating"
                @click="generate(s.name as 'persona' | 'preferences' | 'tech' | 'habits')"
              >
                <i class="ph ph-sparkle"></i> 单独生成
              </button>
            </el-tooltip>
            <el-tooltip
              v-if="editing !== s.name"
              content="编辑该分区的条目"
              placement="top"
            >
              <button
                class="btn btn-ghost btn-sm"
                @click="startEdit(s.name)"
              >
                <i class="ph ph-pencil-simple"></i> 编辑
              </button>
            </el-tooltip>
          </div>
        </div>

        <!-- 编辑模式：每条结论一行（文本 / 置顶 / 删除）；源码模式作为兜底 -->
        <div v-if="editing === s.name" class="profile-edit-box">
          <div class="profile-edit-toolbar">
            <button class="btn btn-ghost btn-xs" @click="sourceMode = !sourceMode">
              {{ sourceMode ? "回到条目编辑" : "源码模式（高级）" }}
            </button>
            <span class="mem-hint" style="font-size: 11px">
              {{ sourceMode ? "直接编辑 Markdown 源文（格式错误会导致该行不再被识别为条目）" : "勾「置顶」的条目重新生成时不会被覆盖" }}
            </span>
          </div>
          <template v-if="sourceMode">
            <textarea
              v-model="sourceText"
              class="el-textarea__inner profile-textarea"
              rows="10"
            ></textarea>
          </template>
          <template v-else>
            <div class="mem-col" style="gap: 6px">
              <div v-for="(it, i) in editItems" :key="i" class="mem-row" style="gap: 8px; align-items: center">
                <input v-model="it.text" class="f-input" style="flex: 1" placeholder="一条结论 / 偏好 / 习惯" />
                <el-tooltip content="置顶：重新生成时不被覆盖" placement="top">
                  <span class="mem-row" style="gap: 4px; align-items: center; flex: 0 0 auto">
                    <div class="switch" :class="{ on: it.isPinned }" role="switch" :aria-checked="it.isPinned" @click="it.isPinned = !it.isPinned"></div>
                    <span class="mem-hint">置顶</span>
                  </span>
                </el-tooltip>
                <span v-if="it.evidence.length" class="mem-chip" :title="it.evidence.join(', ')">证据 {{ it.evidence.length }}</span>
                <button class="btn-link" style="flex: 0 0 auto" title="删除这一条" @click="removeItem(i)">删除</button>
              </div>
              <div>
                <button class="btn btn-ghost btn-sm" @click="addItem">＋ 添加一条</button>
              </div>
              <div v-if="editRaw.length" class="mem-hint">
                原样保留 {{ editRaw.length }} 行非条目内容（保存时原样写回，不会被丢弃）：
                <span class="mem-mono">{{ editRaw.slice(0, 2).join(" / ").slice(0, 80) }}{{ editRaw.length > 2 ? " …" : "" }}</span>
              </div>
            </div>
          </template>
          <div class="mem-row" style="margin-top: 10px; justify-content: flex-end; gap: 8px">
            <button class="btn btn-ghost" @click="editing = ''">取消</button>
            <button class="btn btn-cta" :disabled="saving" @click="saveEdit">{{ saving ? "保存中…" : "保存并更新缓存" }}</button>
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
                  <el-tooltip v-if="item.isPinned" content="此条为手动置顶，重新生成不被覆盖" placement="top">
                    <span class="pinned-tag">
                      <i class="ph ph-push-pin-simple"></i> 置顶保留
                    </span>
                  </el-tooltip>
                  <span>{{ item.text }}</span>
                </div>

                <!-- 证据链气泡 -->
                <div v-if="item.evidence.length" class="profile-evidence-row">
                  <span class="evidence-label">
                    <i class="ph ph-link-simple"></i> 证据链:
                  </span>
                  <el-tooltip
                    v-for="e in item.evidence"
                    :key="e"
                    content="点击查看记忆详情"
                    placement="top"
                  >
                    <button
                      class="evidence-chip"
                      @click="showEvidence(e)"
                    >
                      #{{ e.slice(-6) }}
                    </button>
                  </el-tooltip>
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
