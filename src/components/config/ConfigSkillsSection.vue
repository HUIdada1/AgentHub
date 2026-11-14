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
<!-- 技能仓库 · 配置页：工具适配器 / 同步与每日全自动巡检 / 回收站与危险区
     支持商汤小浣熊、AutoClaw、Qoder CN、Qoder 国际版等全渠道一键开启与统一品牌图标，布局合理整洁便于观看 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { fmtTime, fmtSize } from "../../utils/format";
import SkillChannelIcon from "../skills/SkillChannelIcon.vue";
import type { AppConfig, ToolRow, TrashRow, ProbeRow, DailyCheckResult } from "../../types";

const app = useAppStore();

// 页面二级板块：工具适配器 / 同步与全自动调度 / 回收站与数据
const tab = ref<"tools" | "sync" | "data">("tools");

const skCfg = ref<AppConfig | null>(null);
const skTools = ref<ToolRow[]>([]);
const skTrash = ref<TrashRow[]>([]);
const skHubDir = ref("%USERPROFILE%\\.agent_skills");
const skMsg = ref("");
const skSaving = ref(false);

// 每日自动检测状态
const dailyCheckInfo = ref<DailyCheckResult | null>(null);
const dailyChecking = ref(false);

// ---- 预置推荐渠道列表（支持一键快速开启） ----
const PRESET_CHANNELS = [
  { id: "raccoon", name: "商汤小浣熊", paths: [".box-agent/skills", ".raccoon/skills", "%APPDATA%/office-raccoon/skills"], desc: "SenseChat 小浣熊助手 (~/.box-agent/skills)" },
  { id: "autoclaw", name: "AutoClaw", paths: [".autoclaw/skills", "%APPDATA%/AutoClaw/skills", "%LOCALAPPDATA%/Programs/AutoClaw/skills"], desc: "AutoClaw 自动化助手 (~/.autoclaw/skills)" },
  { id: "autoclaw_intl", name: "AutoClaw 国际版", paths: [".autoclaw-intl/skills", "%APPDATA%/AutoClaw-intl/skills"], desc: "AutoClaw 全球区部署" },
  { id: "qoder", name: "Qoder CN", paths: [".qoder/skills", "%APPDATA%/Qoder/skills"], desc: "Qoder 国内版编程助手 (~/.qoder/skills)" },
  { id: "qoder_intl", name: "Qoder 国际版", paths: [".qoder-intl/skills", ".qoder_intl/skills", "%APPDATA%/Qoder-intl/skills"], desc: "Qoder 国际版 (~/.qoder-intl/skills)" },
  { id: "trae", name: "Trae SOLO CN", paths: [".trae/skills", "%APPDATA%/Trae/skills"], desc: "字节跳动 AI 原生 IDE (~/.trae/skills)" },
  { id: "cursor", name: "Cursor", paths: [".cursor/skills", "%APPDATA%/Cursor/User/skills"], desc: "Cursor AI 编辑器技能目录" },
  { id: "roo", name: "Roo Code", paths: [".roo/skills", ".roo-code/skills"], desc: "Roo Code 社区扩展技能目录" },
];

// ---- 工具过滤与折叠控制 ----
const toolQuery = ref("");
const toolFilter = ref<"all" | "hit" | "enabled" | "unhit">("all");
const expandedPaths = ref<Record<string, boolean>>({});

function toggleExpandPath(toolId: string) {
  expandedPaths.value[toolId] = !expandedPaths.value[toolId];
}

// 过滤后的工具列表
const filteredTools = computed(() => {
  const q = toolQuery.value.trim().toLowerCase();
  return skTools.value.filter((t) => {
    // 文本搜索
    const matchText = !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    if (!matchText) return false;
    // 分类筛选
    if (toolFilter.value === "hit") return !!t.dir;
    if (toolFilter.value === "enabled") return skCfg.value?.tools[t.id]?.enabled !== false;
    if (toolFilter.value === "unhit") return !t.dir;
    return true;
  });
});

// 统计
const toolStats = computed(() => {
  const total = skTools.value.length;
  const hit = skTools.value.filter((t) => !!t.dir).length;
  const enabled = skTools.value.filter((t) => skCfg.value?.tools[t.id]?.enabled !== false).length;
  return { total, hit, enabled };
});

// 检查某个预置渠道是否已存在
function hasPreset(id: string) {
  return skTools.value.some((t) => t.id === id);
}

// 一键启用/添加预置渠道
function enablePreset(preset: typeof PRESET_CHANNELS[0]) {
  if (!skCfg.value) return;
  const id = preset.id;
  if (!skCfg.value.tools) skCfg.value.tools = {};

  if (skCfg.value.tools[id]) {
    skCfg.value.tools[id].enabled = true;
  } else {
    skCfg.value.tools[id] = {
      name: preset.name,
      enabled: true,
      paths: [...preset.paths],
    };
  }

  // 确保列表里有该项
  const existing = skTools.value.find((t) => t.id === id);
  if (!existing) {
    skTools.value.push({
      id,
      name: preset.name,
      icon: "ph-robot",
      builtin: true,
      deletable: false,
      enabled: true,
      dir: "",
      candidatePaths: [...preset.paths],
    });
  } else {
    existing.enabled = true;
  }

  expandedPaths.value[id] = true;
  skMsg.value = `已添加并启用渠道「${preset.name}」，点击保存后生效`;
}

// ---- 扫描发现 / 手动新增 ----
const probeOpen = ref(false);
const probeLoading = ref(false);
const probed = ref<ProbeRow[]>([]);

const manualOpen = ref(false);
const manual = ref({ name: "", id: "", path: "" });
const idTouched = ref(false);

function onNameInput() {
  if (!idTouched.value) manual.value.id = slugId(manual.value.name);
}

const active = computed(() => app.activeModule === "skills" && app.activePage === "config");
watch(active, (v) => { if (v) loadSkillsSettings(); }, { immediate: true });

async function loadSkillsSettings() {
  try {
    skCfg.value = await api.loadConfig();
    skTools.value = (await api.listTools()) || [];
    for (const t of skTools.value) {
      const tc = skCfg.value?.tools?.[t.id];
      if (tc && !tc.name) tc.name = t.name;
    }
    skTrash.value = (await api.trashList()) || [];
    const dir = await api.getDataDir();
    if (dir) skHubDir.value = dir;
    dailyCheckInfo.value = (await api.getDailyCheckStatus().catch(() => null)) || null;
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  }
}

async function saveSkillsSettings() {
  if (!skCfg.value) return;
  skSaving.value = true;
  try {
    const r = await api.saveConfig(skCfg.value);
    skMsg.value = r?.ok ? "设置已保存，同步中心重新扫描后生效" : r?.message || "保存失败";
    if (r?.ok) {
      Object.assign(app.config, JSON.parse(JSON.stringify(skCfg.value)));
      skTools.value = (await api.listTools()) || [];
      await app.refreshTools();
    }
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  } finally {
    skSaving.value = false;
  }
}

function slugId(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(s) ? s : "agent";
}

async function doProbe() {
  probeLoading.value = true;
  probed.value = [];
  try {
    probed.value = (await api.probeAgents()) || [];
    probeOpen.value = true;
    manualOpen.value = false;
    skMsg.value = probed.value.length ? `扫描到 ${probed.value.length} 个未注册的 agent 技能目录` : "没有发现未注册的 agent 技能目录";
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  } finally {
    probeLoading.value = false;
  }
}

function adopt(row: ProbeRow) {
  if (!skCfg.value) return;
  let id = row.suggestId;
  let n = 2;
  while (skCfg.value.tools[id]) id = `${row.suggestId}-${n++}`;
  const paths = row.hitDirs.length ? [row.hitDirs[0]] : [""];
  skCfg.value.tools[id] = { name: row.name, icon: row.icon, enabled: true, paths };
  skTools.value.push({ id, name: row.name, icon: row.icon, builtin: false, deletable: true, enabled: true, dir: paths[0], candidatePaths: paths });
  skMsg.value = `已添加「${row.name}」，保存后生效`;
}

function openManual() {
  manualOpen.value = !manualOpen.value;
  probeOpen.value = false;
  manual.value = { name: "", id: "", path: "" };
  idTouched.value = false;
}

async function browseManualPath() {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) manual.value.path = r.path;
}

function submitManual() {
  if (!skCfg.value) return;
  const name = manual.value.name.trim();
  const id = (manual.value.id.trim() || slugId(name)).toLowerCase();
  if (!name) { skMsg.value = "先给工具起个名字"; return; }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { skMsg.value = "id 只能用小写字母数字开头，可含 -_，最长 32 位"; return; }
  if (skCfg.value.tools[id]) { skMsg.value = `id「${id}」已被占用，换一个`; return; }
  const paths = manual.value.path.trim() ? [manual.value.path.trim()] : [""];
  skCfg.value.tools[id] = { name, enabled: true, paths };
  skTools.value.push({ id, name, icon: "ph-robot", builtin: false, deletable: true, enabled: true, dir: paths[0], candidatePaths: paths });
  manualOpen.value = false;
  skMsg.value = `已添加「${name}」，保存后生效`;
}

async function startRemove(t: ToolRow) {
  const plan = await api.removeTool(t.id).catch(() => null);
  if (!plan || plan.ok === false) { skMsg.value = plan?.message || "删除失败，请重试"; return; }
  if (plan.openConflicts) {
    await ElMessageBox.alert(`该工具还有 ${plan.openConflicts} 条未裁决冲突，请先去「去重与冲突」页处理，再回来删除。`, "暂不能删除", { confirmButtonText: "知道了", type: "warning" });
    return;
  }
  const mounts = plan.mounts || [];
  const src = plan.sourceCount || 0;
  let text = `删除工具适配器「${t.name}」？`;
  if (mounts.length) text += `\n将摘除 ${mounts.length} 处挂载（只删链接，技能与目录都不动）。`;
  if (src) text += `\n${src} 条来源记录会保留为历史档案，显示为原 id。`;
  try {
    await ElMessageBox.confirm(text, "删除工具适配器", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
  } catch {
    return;
  }
  const r = await api.removeTool(t.id, true).catch(() => null);
  skMsg.value = r?.ok ? r.message || "已删除" : r?.message || "删除失败，请重试";
  await loadSkillsSettings();
  await app.refreshTools();
}

async function browseToolPath(toolId: string, idx: number) {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) {
    if (toolId === "custom") skCfg.value!.customDirs[idx] = r.path;
    else skCfg.value!.tools[toolId].paths[idx] = r.path;
  }
}

async function browseCustomAdd() {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) skCfg.value!.customDirs.push(r.path);
}

// 执行每日全自动检测
async function triggerDailyCheck() {
  dailyChecking.value = true;
  skMsg.value = "正在执行全渠道健康巡检与自动对账…";
  try {
    const res = await api.runDailyCheck({ autoMount: skCfg.value?.schedule?.dailyCheckAutoMount !== false });
    dailyCheckInfo.value = res;
    skMsg.value = res.summary || "巡检完成";
    await loadSkillsSettings();
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  } finally {
    dailyChecking.value = false;
  }
}

async function restoreTrash(name: string) {
  const r = await api.trashRestore(name).catch(() => null);
  skMsg.value = r?.ok ? `已还原到 ${r.dest}` : r?.message || "还原失败";
  await loadSkillsSettings();
}

async function purgeAll() {
  try {
    await ElMessageBox.confirm("立即永久删除 .trash 内的全部历史版本，此操作不可恢复。", "清空回收站", {
      confirmButtonText: "清空",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  const r = await api.trashPurge().catch(() => null);
  skMsg.value = r ? `已清理 ${r.purged} 项` : "清理失败，请重试";
  await loadSkillsSettings();
}

function gotoTiming() {
  app.settingsTab = "timing";
  app.settingsOpen = true;
}

const scheduleSummary = computed(() => {
  const c = skCfg.value;
  if (!c) return "";
  return [
    c.schedule.dailyCheck !== false ? `每日自动巡检 ${c.schedule.dailyCheckTime || "09:00"}` : "每日自动巡检关",
    c.schedule.hourly ? "每小时同步开" : "每小时同步关",
    c.schedule.daily ? `每天 ${c.schedule.dailyTime}` : "每天同步关",
    c.watch.enabled ? `自动感知 ${c.watch.intervalSeconds || 15} 秒` : "自动感知关",
  ].join(" · ");
});

async function openDataDir() {
  try {
    await api.openDataDir();
  } catch {
    /* 预览降级 */
  }
}
</script>

<template>
  <div class="cfg-sec">
    <!-- 顶部状态栏 -->
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 技能仓库</div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn" @click="openDataDir"><i class="ph ph-folder-open"></i>中央数据目录</button>
        <button class="btn btn-cta" :disabled="skSaving" @click="saveSkillsSettings">
          <i class="ph ph-floppy-disk"></i>{{ skSaving ? "保存中…" : "保存配置" }}
        </button>
      </div>
    </div>

    <!-- 二级导航 Tab -->
    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'tools' }" @click="tab = 'tools'">
        <i class="ph ph-plugs"></i>渠道工具适配器 ({{ toolStats.total }})
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'sync' }" @click="tab = 'sync'">
        <i class="ph ph-shield-check"></i>全自动检测与调度
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'data' }" @click="tab = 'data'">
        <i class="ph ph-trash"></i>回收站与存储 ({{ skTrash.length }})
      </button>
    </div>

    <div class="sk-note" v-if="skMsg"><i class="ph ph-info"></i><div>{{ skMsg }}</div></div>

    <template v-if="skCfg">
      <!-- ================= 板块一：工具适配器 ================= -->
      <template v-if="tab === 'tools'">
        <!-- 预置常用 Agent 快速启用面板 -->
        <div class="sk-panel preset-banner">
          <div class="preset-head">
            <div class="preset-title">
              <i class="ph ph-sparkle" style="color:var(--accent)"></i>
              <span>常用 Agent 渠道推荐</span>
            </div>
          </div>
          <div class="preset-chips">
            <div
              v-for="p in PRESET_CHANNELS"
              :key="p.id"
              class="preset-chip"
              :class="{ 'is-added': hasPreset(p.id) && skCfg.tools[p.id]?.enabled !== false }"
              @click="enablePreset(p)"
            >
              <SkillChannelIcon :toolId="p.id" :name="p.name" size="sm" :border="false" />
              <span class="p-name">{{ p.name }}</span>
              <span class="p-action" v-if="!hasPreset(p.id) || skCfg.tools[p.id]?.enabled === false">
                <i class="ph ph-plus"></i>启用
              </span>
              <span class="p-action ok" v-else>
                <i class="ph ph-check"></i>已就绪
              </span>
            </div>
          </div>
        </div>

        <!-- 过滤与操作栏 -->
        <div class="sk-panel filter-panel">
          <div class="sk-row" style="gap: 12px; flex-wrap: wrap; justify-content: space-between;">
            <div class="filter-tabs">
              <button
                class="filter-tab"
                :class="{ active: toolFilter === 'all' }"
                @click="toolFilter = 'all'"
              >全部 ({{ toolStats.total }})</button>
              <button
                class="filter-tab"
                :class="{ active: toolFilter === 'hit' }"
                @click="toolFilter = 'hit'"
              >有效已连接 ({{ toolStats.hit }})</button>
              <button
                class="filter-tab"
                :class="{ active: toolFilter === 'enabled' }"
                @click="toolFilter = 'enabled'"
              >已启用 ({{ toolStats.enabled }})</button>
              <button
                class="filter-tab"
                :class="{ active: toolFilter === 'unhit' }"
                @click="toolFilter = 'unhit'"
              >待配置路径 ({{ toolStats.total - toolStats.hit }})</button>
            </div>
            <div class="sk-row" style="gap: 8px;">
              <input
                v-model="toolQuery"
                placeholder="快速搜索渠道名称或 ID…"
                class="f-input tool-search-in"
              />
              <button class="btn btn-ghost" :disabled="probeLoading" @click="doProbe">
                <i class="ph ph-scan"></i>扫描电脑发现
              </button>
              <button class="btn btn-ghost" @click="openManual">
                <i class="ph ph-plus"></i>手动新增
              </button>
            </div>
          </div>
        </div>

        <!-- 扫描发现面板 -->
        <div class="probe-panel" v-if="probeOpen">
          <div class="sk-row" style="justify-content:space-between; margin-bottom:8px">
            <span class="probe-title"><i class="ph ph-scan"></i>本地扫描探测结果</span>
            <button class="btn btn-ghost btn-sm" @click="probeOpen = false"><i class="ph ph-x"></i>关闭</button>
          </div>
          <div class="sk-muted sk-small" v-if="!probed.length">没有发现未注册的 agent 技能目录。</div>
          <div class="sk-tool-row" v-for="r in probed" :key="r.suggestId">
            <SkillChannelIcon :toolId="r.suggestId" :name="r.name" size="md" />
            <div class="t-main">
              <div class="t-name">{{ r.name }}</div>
              <div class="t-path">{{ r.hitDirs.join(" · ") }}{{ r.skillCount ? `（${r.skillCount} 个技能）` : "（空）" }}</div>
            </div>
            <button class="btn btn-link" @click="adopt(r)"><i class="ph ph-plus"></i>添加进列表</button>
          </div>
        </div>

        <!-- 手动新增面板 -->
        <div class="probe-panel" v-if="manualOpen">
          <div class="sk-row" style="justify-content:space-between; margin-bottom:12px">
            <span class="probe-title"><i class="ph ph-plus-circle"></i>手动新增 Agent 渠道适配器</span>
            <button class="btn btn-ghost btn-sm" @click="manualOpen = false"><i class="ph ph-x"></i>关闭</button>
          </div>
          <div class="sk-grid sk-grid-2" style="gap:12px; margin-bottom:10px">
            <div class="sk-field">
              <label>显示名</label>
              <input v-model="manual.name" placeholder="例如 Cursor / Roo Code" class="f-input" @input="onNameInput" />
            </div>
            <div class="sk-field">
              <label>渠道引用 ID（小写字母/连字符）</label>
              <input v-model="manual.id" placeholder="例如 cursor" class="f-input mono-in" @input="idTouched = true" />
            </div>
          </div>
          <div class="sk-field" style="margin-bottom:12px">
            <label>技能目录绝对路径或 ~ 路径</label>
            <div class="path-row">
              <input v-model="manual.path" placeholder="~/.cursor/skills" class="f-input mono-in" />
              <button class="btn btn-ghost" @click="browseManualPath"><i class="ph ph-folder-open"></i>浏览</button>
            </div>
          </div>
          <div class="sk-row" style="gap:10px">
            <button class="btn btn-cta btn-sm" @click="submitManual"><i class="ph ph-check"></i>添加</button>
            <button class="btn btn-ghost btn-sm" @click="manualOpen = false">取消</button>
          </div>
        </div>

        <!-- 工具卡片网格列表（布局合理、便于观看） -->
        <div class="channel-card-grid">
          <div
            class="channel-card"
            :class="{ 'is-disabled': skCfg.tools[t.id]?.enabled === false, 'is-hit': !!t.dir }"
            v-for="t in filteredTools"
            :key="t.id"
          >
            <!-- 卡片头部：图标 + 名称 + ID + 启用开关 -->
            <div class="c-head">
              <div class="c-brand">
                <SkillChannelIcon :toolId="t.id" :name="skCfg.tools[t.id]?.name || t.name" size="md" />
                <div class="c-meta">
                  <div class="c-name-row">
                    <input
                      v-model="skCfg.tools[t.id]!.name"
                      class="c-name-input"
                      placeholder="渠道名"
                    />
                    <span class="tool-id sk-mono">{{ t.id }}</span>
                    <span class="sk-badge mute" v-if="t.builtin">内置</span>
                    <span class="sk-badge ok" v-else>自定义</span>
                  </div>
                  <div class="c-dir-hint" v-if="t.dir" :title="t.dir">
                    <i class="ph ph-check-circle" style="color:var(--accent)"></i>
                    <span class="sk-mono">{{ t.dir }}</span>
                  </div>
                  <div class="c-dir-hint warn" v-else-if="skCfg.tools[t.id]?.enabled !== false">
                    <i class="ph ph-warning"></i>
                    <span>候选目录未命中，请核对下方路径</span>
                  </div>
                </div>
              </div>

              <!-- 右侧控制 -->
              <div class="c-ctrls">
                <label class="switch-wrap">
                  <div
                    class="switch"
                    :class="{ on: skCfg.tools[t.id]?.enabled !== false }"
                    @click="skCfg.tools[t.id]!.enabled = !skCfg.tools[t.id]!.enabled"
                  ></div>
                </label>
                <button
                  class="btn btn-ghost btn-sm"
                  :class="{ active: expandedPaths[t.id] }"
                  @click="toggleExpandPath(t.id)"
                >
                  <i class="ph ph-sliders"></i>
                  <span>{{ (skCfg.tools[t.id]?.paths || []).length }} 路径</span>
                </button>
                <button
                  class="btn btn-link danger btn-sm"
                  v-if="t.deletable"
                  @click="startRemove(t)"
                  title="删除该自定义适配器"
                >
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>

            <!-- 折叠的候选路径区域 -->
            <div class="c-paths-panel" v-if="expandedPaths[t.id]">
              <div class="c-paths-label">候选路径列表（按顺序探测，优先采用首个命中项）：</div>
              <div
                class="path-row"
                v-for="(p, i) in skCfg.tools[t.id]!.paths"
                :key="i"
              >
                <input
                  v-model="skCfg.tools[t.id]!.paths[i]"
                  placeholder="候选路径（~ 开头或绝对路径）"
                  class="f-input mono-in"
                />
                <button class="btn btn-ghost" @click="browseToolPath(t.id, i)" title="选择文件夹">
                  <i class="ph ph-folder-open"></i>
                </button>
                <button
                  class="btn btn-ghost"
                  v-if="skCfg.tools[t.id]!.paths.length > 1"
                  @click="skCfg.tools[t.id]!.paths.splice(i, 1)"
                  title="移除路径"
                >
                  <i class="ph ph-x"></i>
                </button>
              </div>
              <div class="sk-row" style="justify-content:flex-start; margin-top:6px">
                <button class="btn btn-ghost btn-sm" @click="skCfg.tools[t.id]!.paths.push('')">
                  <i class="ph ph-plus"></i>添加备选路径
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 自定义裸目录 -->
        <div class="sk-panel" style="margin-top: 16px;">
          <div class="tool-head">
            <span class="tool-name"><i class="ph ph-folder" style="color:var(--accent)"></i> 自定义裸技能目录</span>
          </div>
          <p class="sk-help" style="margin-bottom:10px">没有 agent 身份的独立裸目录；若属于某个常用 agent，建议在上方直接添加渠道挂名</p>
          <div class="path-row" v-for="(p, i) in skCfg.customDirs" :key="i">
            <input v-model="skCfg.customDirs[i]" class="f-input mono-in" />
            <button class="btn btn-ghost" @click="browseToolPath('custom', i)"><i class="ph ph-folder-open"></i></button>
            <button class="btn btn-ghost" @click="skCfg.customDirs.splice(i, 1)"><i class="ph ph-x"></i></button>
          </div>
          <div class="add-line">
            <button class="btn btn-ghost" @click="browseCustomAdd"><i class="ph ph-plus"></i>添加自定义目录</button>
          </div>
        </div>
      </template>

      <!-- ================= 板块二：全自动检测与调度 ================= -->
      <template v-else-if="tab === 'sync'">
        <!-- 全自动每日健康检测卡片 -->
        <div class="sk-section">
          <h2>全自动每日健康检测与自动对账</h2>
          <div class="sk-panel">
            <div class="opt-row">
              <div>
                <div class="opt-title">每日全自动健康检测开关</div>
                <div class="sk-help">开启后系统每天在设定时刻自动扫描全部渠道连通性、新技能与挂载完整性</div>
              </div>
              <div
                class="switch"
                :class="{ on: skCfg.schedule.dailyCheck !== false }"
                @click="skCfg.schedule.dailyCheck = skCfg.schedule.dailyCheck === false ? true : false"
              ></div>
            </div>

            <div class="opt-row">
              <div>
                <div class="opt-title">每日巡检执行时刻</div>
                <div class="sk-help">格式为 24 小时制 HH:mm，如错过设定时刻（睡眠关机），开机首次 tick 自动补测</div>
              </div>
              <div class="opt-inline">
                <input
                  v-model="skCfg.schedule.dailyCheckTime"
                  placeholder="09:00"
                  class="f-input mono-in"
                  style="width: 100px; text-align: center;"
                />
              </div>
            </div>

            <div class="opt-row">
              <div>
                <div class="opt-title">巡检自动修复与纳管</div>
                <div class="sk-help">检测到失效的 Junction 挂载时自动重建，无冲突孤儿目录自动尝试安全收纳</div>
              </div>
              <div
                class="switch"
                :class="{ on: skCfg.schedule.dailyCheckAutoMount !== false }"
                @click="skCfg.schedule.dailyCheckAutoMount = skCfg.schedule.dailyCheckAutoMount === false ? true : false"
              ></div>
            </div>

            <!-- 检测状态小结与手动立即检测 -->
            <div class="daily-check-status-box" v-if="dailyCheckInfo">
              <div class="sk-row" style="justify-content:space-between; margin-bottom:6px">
                <div class="sk-row" style="gap:8px">
                  <span class="sk-badge" :class="dailyCheckInfo.ok ? 'ok' : 'warn'">
                    <i class="ph" :class="dailyCheckInfo.ok ? 'ph-check-circle' : 'ph-warning'"></i>
                    {{ dailyCheckInfo.ok ? '全渠道健康良好' : '发现待处理项' }}
                  </span>
                  <span class="sk-small sk-muted" v-if="dailyCheckInfo.checkedAt">
                    上次巡检：{{ fmtTime(dailyCheckInfo.checkedAt) }}
                  </span>
                </div>
                <button class="btn btn-ghost btn-sm" :disabled="dailyChecking" @click="triggerDailyCheck">
                  <i class="ph ph-lightning"></i>{{ dailyChecking ? '巡检中…' : '立即执行一次全自动检测' }}
                </button>
              </div>
              <div class="sk-small" style="color:var(--text-2); line-height:1.6">
                {{ dailyCheckInfo.summary }}
              </div>
            </div>
          </div>
        </div>

        <!-- 挂载策略与去重 -->
        <div class="sk-grid sk-grid-2 sk-section top-grid">
          <div>
            <h2>挂载模式与生命周期</h2>
            <p class="desc">调整仅影响之后的同步与挂载动作</p>
            <div class="sk-panel">
              <div class="sk-field">
                <label>挂载模式</label>
                <el-radio-group v-model="skCfg.mountMode" class="mount-radio">
                  <el-radio value="junction" border>
                    <span class="r-wrap">
                      <span class="r-title">Junction（推荐）</span>
                      <span class="r-desc">按技能粒度建立目录联接，零拷贝、即时生效。</span>
                    </span>
                  </el-radio>
                  <el-radio value="copy" border>
                    <span class="r-wrap">
                      <span class="r-title">直接复制</span>
                      <span class="r-desc">独立文件拷贝，兼容性好但可能产生漂移。</span>
                    </span>
                  </el-radio>
                </el-radio-group>
              </div>
              <div class="opt-row">
                <div>
                  <div class="opt-title">L3 语义去重提示</div>
                  <div class="sk-help">本地向量计算，仅提示建议，绝不强行合并</div>
                </div>
                <div class="switch" :class="{ on: skCfg.l3.enabled }" @click="skCfg.l3.enabled = !skCfg.l3.enabled"></div>
              </div>
              <div class="sk-field days-field">
                <label>回收站保留天数</label>
                <input type="number" class="f-input" v-model.number="skCfg.trashDays" min="1" max="90" style="width:120px" />
                <div class="sk-help">超期后由清理动作自动清除</div>
              </div>
            </div>
          </div>

          <div>
            <h2>中央数据仓库位置</h2>
            <p class="desc">技能真身（skills/）、清单（manifest.json）存放位置</p>
            <div class="sk-panel">
              <div class="sk-field" style="margin-bottom:0">
                <label>中央仓库物理路径</label>
                <div class="path-row">
                  <input :value="skHubDir" disabled class="f-input mono-in" />
                  <button class="btn btn-ghost" @click="openDataDir" title="在系统资源管理器中打开"><i class="ph ph-folder-open"></i></button>
                </div>
              </div>
              <div class="opt-row" style="margin-top:14px; padding-bottom:2px">
                <div>
                  <div class="opt-title">全局同步与跨设备 WebDAV</div>
                  <div class="sk-help">{{ scheduleSummary }}</div>
                </div>
                <button class="btn btn-ghost btn-sm" @click="gotoTiming"><i class="ph ph-clock-countdown"></i>去 设置 · 同步时间</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= 板块三：回收站与危险区 ================= -->
      <template v-else>
        <div class="sk-section">
          <h2>回收站（{{ skTrash.length }} 项）</h2>
          <p class="desc">被替换或删除的技能目录先进回收站，保留 {{ skCfg.trashDays }} 天可还原。</p>
          <div class="sk-panel" style="padding: 6px 18px;" v-if="skTrash.length">
            <div class="sk-tool-row" v-for="t in skTrash" :key="t.name">
              <div class="sk-tool-icon"><i class="ph ph-trash"></i></div>
              <div class="t-main">
                <div class="t-name">{{ t.name }}</div>
                <div class="t-path">{{ fmtTime(t.trashedAt) }} · {{ fmtSize(t.sizeBytes) }}</div>
              </div>
              <button class="btn btn-ghost" @click="restoreTrash(t.name)"><i class="ph ph-arrow-u-up-left"></i>还原</button>
            </div>
          </div>
          <div class="sk-panel" v-else>
            <div class="sk-empty-state" style="padding:24px"><i class="ph ph-trash"></i><div class="es-title">回收站是空的</div></div>
          </div>
        </div>

        <div class="sk-section" style="margin-bottom: 8px">
          <h2>危险区</h2>
          <div class="sk-panel">
            <div class="opt-row" style="padding:2px 0">
              <div>
                <div class="opt-title" style="color:var(--danger)">清空回收站</div>
                <div class="sk-help">立即永久删除 <span class="sk-mono">.trash\</span> 内的历史技能版本，不可恢复。</div>
              </div>
              <button class="btn btn-outline danger" @click="purgeAll"><i class="ph ph-trash"></i>清空</button>
            </div>
          </div>
        </div>
      </template>
    </template>
    <div class="sk-panel" v-else style="color:var(--text-3); text-align:center">读取配置中…</div>
  </div>
</template>

<style scoped>
.mono-in { font-family: var(--font-code); font-size: 12px; }
:deep(.el-radio.is-bordered) { border-radius: var(--r-sm); }
.top-grid { align-items: start; }

.opt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}
.opt-row + .opt-row { border-top: 1px solid var(--border-soft); }
.opt-title { font-size: 13px; font-weight: 500; }
.opt-row .sk-help { margin-top: 2px; }
.opt-inline { display: flex; align-items: center; gap: 10px; }

/* 预设推荐栏 */
.preset-banner {
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
}
.preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.preset-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--panel-1);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}
.preset-chip:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.preset-chip.is-added {
  background: rgba(56, 189, 248, 0.08);
  border-color: rgba(56, 189, 248, 0.3);
}
.preset-chip .p-name { font-weight: 500; }
.preset-chip .p-action { font-size: 11px; color: var(--text-3); }
.preset-chip .p-action.ok { color: var(--accent); font-weight: 600; }

/* 过滤与搜索条 */
.filter-panel {
  padding: 10px 14px;
  margin-bottom: 14px;
}
.filter-tabs {
  display: flex;
  gap: 4px;
  background: var(--panel-2);
  padding: 3px;
  border-radius: 8px;
}
.filter-tab {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
}
.filter-tab.active {
  background: var(--panel-1);
  color: var(--text-1);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.tool-search-in {
  width: 200px;
  font-size: 12px;
}

/* 渠道卡片网格（2 栏响应式） */
.channel-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 12px;
}
.channel-card {
  background: var(--panel-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  padding: 14px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.channel-card:hover {
  border-color: rgba(255,255,255,0.15);
}
.channel-card.is-hit {
  border-left: 3px solid var(--accent);
}
.channel-card.is-disabled {
  opacity: 0.65;
}

.c-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.c-brand {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.c-meta {
  flex: 1;
  min-width: 0;
}
.c-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.c-name-input {
  font-size: 13.5px;
  font-weight: 600;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-1);
  border-radius: 4px;
  padding: 1px 4px;
  max-width: 140px;
}
.c-name-input:focus {
  border-color: var(--accent);
  background: var(--panel-2);
}
.tool-id {
  font-size: 11px;
  color: var(--text-3);
}
.c-dir-hint {
  font-size: 11.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-dir-hint.warn { color: var(--warn); }

.c-ctrls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.switch-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

/* 展开路径面板 */
.c-paths-panel {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-soft);
}
.c-paths-label {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.path-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.path-row .f-input { flex: 1; }

/* 扫描发现/手动新增 */
.probe-panel {
  margin-bottom: 14px;
  padding: 14px 16px;
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
}
.probe-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 每日检测小结框 */
.daily-check-status-box {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--panel-2);
  border-radius: 8px;
  border: 1px solid var(--border-soft);
}

/* 挂载模式 */
.mount-radio {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  width: 100%;
}
.mount-radio :deep(.el-radio) {
  height: auto;
  align-items: flex-start;
  padding: 12px 14px;
  margin: 0;
  width: 100%;
  border-radius: var(--r-sm);
}
.mount-radio :deep(.el-radio__input) { margin-top: 3px; }
.mount-radio :deep(.el-radio__label) { white-space: normal; line-height: 1.55; padding-left: 8px; }
.r-wrap { display: block; }
.r-title { display: block; font-size: 13px; font-weight: 500; }
.r-desc { display: block; font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.days-field { margin-bottom: 0; padding-top: 13px; }
.days-field + .opt-row { border-top: 1px solid var(--border-soft); }
</style>
