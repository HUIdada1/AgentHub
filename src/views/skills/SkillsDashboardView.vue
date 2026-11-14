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
<script setup lang="ts">
// 技能仓库 · 仪表盘：简约合理、高颜值、支持渠道工具品牌图标、每日全自动巡检与技能便捷速览
import { ref, computed, onMounted } from "vue";
import {
  getOverview,
  listSkills,
  getSkill,
  toggleMount,
  repairMounts,
  adoptHubSkill,
  openHubDir,
  runDailyCheck,
  getDailyCheckStatus,
  type Overview,
  type SkillRow,
  type SkillDetail,
  type DailyCheckResult,
} from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { fmtTime } from "../../utils/format";
import SkillChannelIcon from "../../components/skills/SkillChannelIcon.vue";
import QMark from "../../components/QMark.vue";

const app = useAppStore();

const data = ref<Overview | null>(null);
const loading = ref(true);
const errMsg = ref("");
const actionMsg = ref("");

// 每日全自动健康巡检状态与执行
const dailyCheckInfo = ref<DailyCheckResult | null>(null);
const dailyChecking = ref(false);

// 技能快捷速览列表与搜索
const quickSkills = ref<SkillRow[]>([]);
const skillSearch = ref("");
const selectedToolFilter = ref("");

// 快捷预览抽屉状态
const previewDrawerOpen = ref(false);
const previewLoading = ref(false);
const previewSkillName = ref("");
const previewDetail = ref<SkillDetail | null>(null);
const mountToggling = ref<Record<string, boolean>>({});

function mountOkCount(toolId: string, o: Overview) {
  return o.mountHealth.filter((m) => m.tool === toolId && m.valid).length;
}

function mountBroken(o: Overview) {
  return o.mountHealth.filter((m) => !m.valid);
}

function pendingCount(o: Overview): number {
  return o.pendingConflicts.length + o.orphans.length + (o.hubExtra || []).length;
}

// 快速纳管
async function doAdopt(name: string) {
  actionMsg.value = `正在纳管 ${name}…`;
  const r = await adoptHubSkill(name).catch(() => null);
  actionMsg.value = r?.ok ? `已纳管 ${name}，登记挂载 ${r.mounts} 处` : r?.message || "纳管失败";
  await load();
}

// 一键修复失效挂载
async function doRepairBroken() {
  actionMsg.value = "正在自动重建所有失效挂载…";
  try {
    const r = await repairMounts();
    actionMsg.value = r ? `已重建 ${r.repaired} 处失效挂载` : "修复完成";
    await load();
  } catch (e) {
    actionMsg.value = String((e as Error).message || e);
  }
}

// 触发一次全盘每日巡检
async function doDailyCheck() {
  dailyChecking.value = true;
  actionMsg.value = "正在执行全渠道连通性与健康巡检…";
  try {
    const res = await runDailyCheck({ autoMount: app.config.schedule?.dailyCheckAutoMount !== false });
    dailyCheckInfo.value = res;
    actionMsg.value = res.summary || "全自动检测完成";
    await load();
  } catch (e) {
    actionMsg.value = String((e as Error).message || e);
  } finally {
    dailyChecking.value = false;
  }
}

// 打开技能快捷预览抽屉
async function openQuickPreview(skillName: string) {
  previewSkillName.value = skillName;
  previewDrawerOpen.value = true;
  previewLoading.value = true;
  previewDetail.value = null;
  try {
    previewDetail.value = await getSkill(skillName);
  } catch {
    previewDetail.value = null;
  } finally {
    previewLoading.value = false;
  }
}

// 抽屉内一键切换某工具渠道挂载
async function toggleChannelMount(toolId: string, currentEnabled: boolean) {
  if (!previewSkillName.value || !previewDetail.value?.manifest) return;
  mountToggling.value[toolId] = true;
  try {
    const nextState = !currentEnabled;
    const r = await toggleMount(previewSkillName.value, toolId, nextState);
    if (r?.ok) {
      // 重新拉取该技能详情以同步状态
      previewDetail.value = await getSkill(previewSkillName.value);
      // 重新拉取仪表盘总览
      data.value = await getOverview();
    } else {
      actionMsg.value = r?.message || "切换挂载失败";
    }
  } catch (e) {
    actionMsg.value = String((e as Error).message || e);
  } finally {
    mountToggling.value[toolId] = false;
  }
}

// 过滤后的快捷技能列表
const filteredQuickSkills = computed(() => {
  const q = skillSearch.value.trim().toLowerCase();
  const tf = selectedToolFilter.value;
  return quickSkills.value.filter((s) => {
    if (s.origin === "system" && !q) return false;
    const matchText = !q || s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q);
    if (!matchText) return false;
    if (tf && !s.sources?.some((src) => src.tool === tf) && !s.mounts?.some((m) => m.tool === tf)) {
      return false;
    }
    return true;
  });
});

// 格式化 SKILL.md 摘要
const previewMarkdown = computed(() => {
  const md = previewDetail.value?.skillMd || "";
  return md.trim();
});

// 检查某个工具渠道在该技能上的挂载状态
function isToolMounted(toolId: string): boolean {
  if (!previewDetail.value?.manifest?.mounts) return false;
  return previewDetail.value.manifest.mounts.some((m) => m.tool === toolId && m.enabled);
}

async function load() {
  loading.value = true;
  errMsg.value = "";
  try {
    const [ov, sks, dc] = await Promise.all([
      getOverview(),
      listSkills().catch(() => []),
      getDailyCheckStatus().catch(() => null),
    ]);
    data.value = ov;
    quickSkills.value = sks || [];
    dailyCheckInfo.value = dc;
    if (!data.value) errMsg.value = "未检测到后端，请通过 Electron 应用启动。";
  } catch (e) {
    errMsg.value = String((e as Error).message || e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page sk-page sk-dashboard-wrap">
    <!-- 顶部状态栏：仓库路径 + 全自动每日检测药丸 + 快捷动作 -->
    <div class="dash-hero">
      <div class="dash-hero-left">
        <div class="dash-title-row">
          <span class="dash-main-title">技能仓库 · 仪表盘</span>
          <span class="hub-pill" v-if="data" @click="openHubDir" title="在系统资源管理器中打开中央仓库">
            <i class="ph ph-hard-drives"></i>
            <span class="sk-mono">{{ data.hubDir }}</span>
          </span>
        </div>

        <!-- 全自动每日健康检测药丸徽章 -->
        <div class="daily-check-capsule">
          <div class="capsule-indicator" :class="dailyCheckInfo?.ok ? 'is-ok' : 'is-warn'">
            <i class="ph" :class="dailyCheckInfo?.ok ? 'ph-check-circle' : 'ph-warning-circle'"></i>
          </div>
          <div class="capsule-text">
            <div class="c-title">
              <span>全自动每日检测</span>
              <span class="c-time" v-if="dailyCheckInfo?.checkedAt">
                · {{ fmtTime(dailyCheckInfo.checkedAt) }} 已自动完成
              </span>
              <span class="c-time" v-else>· 尚未运行检测</span>
            </div>
            <div class="c-desc" v-if="dailyCheckInfo?.summary">
              {{ dailyCheckInfo?.summary }}
            </div>
          </div>
          <button
            class="btn btn-ghost btn-sm btn-capsule-act"
            :disabled="dailyChecking"
            @click="doDailyCheck"
          >
            <i class="ph ph-lightning"></i>{{ dailyChecking ? '巡检中…' : '立即全盘检测' }}
          </button>
          <QMark text="每天定时自动检测各渠道连通性、新技能与挂载状态；上次巡检结果显示在左侧胶囊里。" />
        </div>
      </div>

      <div class="dash-hero-right">
        <button class="btn btn-ghost" @click="app.go('sync')">
          <i class="ph ph-arrows-left-right"></i>去同步中心
        </button>
        <button class="btn btn-ghost" @click="app.openModuleConfig()">
          <i class="ph ph-gear"></i>配置渠道
        </button>
        <button class="btn btn-cta" :disabled="loading" @click="load">
          <i class="ph ph-arrows-clockwise" :class="{ 'is-spinning': loading }"></i>
          {{ loading ? "读取中…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- 消息提示栏 -->
    <div class="sk-note warn" v-if="errMsg"><i class="ph ph-warning"></i><div>{{ errMsg }}</div></div>
    <div class="sk-note sk-mt-8" v-if="actionMsg"><i class="ph ph-info"></i><div>{{ actionMsg }}</div></div>

    <template v-if="data">
      <!-- 4 宫格核心指标看板（简约、合理、直观） -->
      <div class="sk-grid sk-grid-4 stats-grid">
        <div class="sk-panel stat-card" @click="app.go('library')">
          <div class="stat-top">
            <span class="stat-label">中央技能库</span>
            <i class="ph ph-books stat-icon"></i>
          </div>
          <div class="stat-num accent">
            {{ data.manifestCount || data.skillCount }}
            <span class="stat-unit">个技能</span>
          </div>
          <div class="stat-foot">
            <span>来自 {{ data.sourceCount }} 份原始副本</span>
            <span class="stat-link">去浏览 <i class="ph ph-arrow-right"></i></span>
          </div>
        </div>

        <div class="sk-panel stat-card" @click="app.openModuleConfig()">
          <div class="stat-top">
            <span class="stat-label">已连接渠道</span>
            <i class="ph ph-plugs-connected stat-icon"></i>
          </div>
          <div class="stat-num">
            {{ data.tools.filter(t => !!t.dir).length }}<span class="stat-slash">/</span>{{ data.tools.length }}
            <span class="stat-unit">个渠道</span>
          </div>
          <div class="stat-foot">
            <span class="stat-link">管理 <i class="ph ph-arrow-right"></i></span>
          </div>
        </div>

        <div class="sk-panel stat-card" :class="{ 'has-broken': mountBroken(data).length > 0 }">
          <div class="stat-top">
            <span class="stat-label">挂载与去重 <QMark text="「份消除」= L1 自动合并的冗余副本数：各工具目录里内容树哈希一致的重复技能，扫描时收纳为一份真身（其余目录转 Junction 指向它）。" /></span>
            <i class="ph ph-tree-structure stat-icon"></i>
          </div>
          <div class="stat-num">
            {{ data.l1Merged }}
            <span class="stat-unit">份消除</span>
          </div>
          <div class="stat-foot" v-if="mountBroken(data).length">
            <span class="broken-hint">
              <i class="ph ph-warning"></i>{{ mountBroken(data).length }} 个失效挂载
            </span>
            <button class="btn btn-ghost btn-xs" @click.stop="doRepairBroken">一键修复</button>
          </div>
          <div class="stat-foot" v-else>
            <span class="stat-ok-tag"><i class="ph ph-check"></i>健康</span>
          </div>
        </div>

        <div class="sk-panel stat-card" @click="app.go('dedup')">
          <div class="stat-top">
            <span class="stat-label">待处理优化</span>
            <i class="ph ph-bell stat-icon"></i>
          </div>
          <div class="stat-num" :class="pendingCount(data) ? 'warn' : 'accent'">
            {{ pendingCount(data) }}
            <span class="stat-unit">项</span>
          </div>
          <div class="stat-foot">
            <span>{{ data.pendingConflicts.length }} 冲突 + {{ data.orphans.length }} 孤儿</span>
            <span class="stat-link" v-if="pendingCount(data)">去裁决 <i class="ph ph-arrow-right"></i></span>
            <span class="stat-ok-tag" v-else><i class="ph ph-check"></i>已就绪</span>
          </div>
        </div>
      </div>

      <!-- 渠道工具连接矩阵（采用号池管家官方同款图标，横向卡片矩阵） -->
      <div class="sk-section channel-matrix-sec">
        <div class="sec-head-row">
          <div>
            <h2 class="sec-title">渠道工具连接矩阵</h2>
          </div>
          <div class="sec-actions">
            <button class="btn btn-ghost btn-sm" @click="selectedToolFilter = ''" v-if="selectedToolFilter">
              清除筛选 (显示全部)
            </button>
            <button class="btn btn-ghost btn-sm" @click="app.openModuleConfig()">
              <i class="ph ph-plus"></i>增减渠道
            </button>
          </div>
        </div>

        <div class="channel-matrix-grid">
          <div
            v-for="t in data.tools"
            :key="t.id"
            class="channel-box"
            :class="{ 'is-active': selectedToolFilter === t.id, 'is-unhit': !t.dir }"
            @click="selectedToolFilter = selectedToolFilter === t.id ? '' : t.id"
            :title="t.dir ? `点击按 ${t.name} 筛选下方技能列表` : ''"
          >
            <div class="cb-left">
              <SkillChannelIcon :toolId="t.id" :name="t.name" size="lg" />
              <div class="cb-info">
                <div class="cb-name">{{ t.name }}</div>
              </div>
            </div>
            <div class="cb-right">
              <div class="cb-stat">
                <span class="cb-count">{{ t.skillCount }}</span>
                <span class="cb-unit">技能</span>
              </div>
              <div class="cb-mount-tag" v-if="mountOkCount(t.id, data) > 0">
                <i class="ph ph-check"></i>已挂载 {{ mountOkCount(t.id, data) }}
              </div>
              <div class="cb-mount-tag mute" v-else-if="t.dir">
                <span>未挂载</span>
              </div>
              <div class="cb-mount-tag warn" v-else>
                <span>未连接</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 核心重点：技能快捷速览与预览区域（适合预览快捷使用） -->
      <div class="sk-section quick-preview-sec">
        <div class="sec-head-row">
          <div>
            <h2 class="sec-title">
              <i class="ph ph-eye" style="color:var(--accent)"></i>
              技能快捷速览与控制
              <span class="quick-count-badge">{{ filteredQuickSkills.length }}</span>
            </h2>
          </div>
          <div class="sk-row" style="gap:8px">
            <input
              v-model="skillSearch"
              placeholder="搜索技能名称或描述…"
              class="f-input quick-search-in"
            />
            <button class="btn btn-ghost btn-sm" @click="app.go('library')">
              <i class="ph ph-arrow-square-out"></i>全量技能库
            </button>
          </div>
        </div>

        <!-- 技能卡片瀑布流网格（点击直接打开抽屉速览） -->
        <div class="quick-skills-grid" v-if="filteredQuickSkills.length">
          <div
            v-for="s in filteredQuickSkills.slice(0, 18)"
            :key="s.name"
            class="sk-card-quick"
            @click="openQuickPreview(s.name)"
          >
            <div class="sq-head">
              <span class="sq-name" :title="s.name">{{ s.name }}</span>
              <span class="sq-badge" :class="s.inManifest ? 'ok' : 'pending'">
                {{ s.inManifest ? '已收纳' : '待收纳' }}
              </span>
            </div>
            <div class="sq-desc" :title="s.description || '暂无描述'">
              {{ s.description || '暂无描述' }}
            </div>
            <div class="sq-foot">
              <div class="sq-sources">
                <span class="sq-src-item" v-for="src in (s.sources || []).slice(0, 3)" :key="src.tool">
                  <SkillChannelIcon :toolId="src.tool" size="sm" :border="false" />
                  <span class="sk-mono">{{ src.tool }}</span>
                </span>
              </div>
              <div class="sq-act">
                <span class="mount-stat">{{ (s.mounts || []).filter(m => m.enabled).length }} 挂载</span>
                <i class="ph ph-caret-right"></i>
              </div>
            </div>
          </div>
        </div>
        <div class="sk-panel" v-else style="padding:28px 16px">
          <div class="sk-empty-state">
            <i class="ph ph-magnifying-glass"></i>
            <div class="es-title">没有找到符合条件的技能</div>
          </div>
        </div>
      </div>

      <!-- 底部两栏：最近同步历史与待办事项 -->
      <div class="sk-grid sk-grid-2 sk-section">
        <div>
          <div class="sec-head-row" style="margin-bottom:8px">
            <div>
              <h2 class="sec-title">最近同步记录</h2>
            </div>
            <button class="btn btn-ghost btn-sm" @click="app.go('sync')">去同步</button>
          </div>
          <div class="sk-panel sk-timeline" v-if="data.recentReports.length">
            <div class="tl-row" v-for="r in data.recentReports" :key="r.file">
              <span class="tl-time">{{ fmtTime(r.mtimeMs) }}</span>
              <div class="tl-main">
                <div class="tl-title">同步完成 <span class="sk-badge ok">Success</span></div>
                <div class="tl-desc sk-mono">{{ r.file }}</div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="app.go('sync')"><i class="ph ph-file-text"></i>报告</button>
            </div>
          </div>
          <div class="sk-panel" v-else>
            <div class="sk-empty-state" style="padding:28px 16px">
              <i class="ph ph-file-text"></i>
              <div class="es-title">还没有同步记录</div>
            </div>
          </div>
        </div>

        <div>
          <div class="sec-head-row" style="margin-bottom:8px">
            <div>
              <h2 class="sec-title">待办决策与孤儿</h2>
            </div>
            <button class="btn btn-ghost btn-sm" @click="app.go('dedup')" v-if="pendingCount(data)">去裁决</button>
          </div>
          <div class="sk-panel" style="padding: 6px 18px;" v-if="pendingCount(data)">
            <div class="sk-tool-row" v-for="c in data.pendingConflicts.slice(0, 3)" :key="c.id">
              <div class="sk-tool-icon" style="color:var(--warn)"><i class="ph ph-git-merge"></i></div>
              <div class="t-main">
                <div class="t-name">{{ c.title }}</div>
                <div class="t-path">{{ c.detail }}</div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="app.go('dedup')"><i class="ph ph-arrow-right"></i>裁决</button>
            </div>
            <div class="sk-tool-row" v-for="o in data.orphans.slice(0, 3)" :key="o.dir + o.name">
              <div class="sk-tool-icon"><i class="ph ph-folder-plus"></i></div>
              <div class="t-main">
                <div class="t-name">陌生目录：{{ o.name }}</div>
                <div class="t-path">存在于 {{ app.toolName(o.tool) }}，待收纳</div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="app.go('sync')"><i class="ph ph-arrow-right"></i>查看</button>
            </div>
            <div class="sk-tool-row" v-for="h in (data.hubExtra || []).slice(0, 3)" :key="'hx' + h.name">
              <div class="sk-tool-icon" style="color:var(--warn)"><i class="ph ph-eye-slash"></i></div>
              <div class="t-main">
                <div class="t-name">中央未登记：{{ h.name }}</div>
                <div class="t-path">{{ h.isLink ? '悬空链接' : '已被直接放入中央仓库' }}</div>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="h.isLink" @click="doAdopt(h.name)"><i class="ph ph-clipboard-text"></i>纳管</button>
            </div>
          </div>
          <div class="sk-panel" v-else>
            <div class="sk-empty-state" style="padding:28px 16px">
              <i class="ph ph-check-circle" style="color:var(--accent)"></i>
              <div class="es-title">暂无待办事项</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 技能快捷预览抽屉（适合预览快捷使用） ================= -->
    <div class="sk-preview-drawer-mask" v-if="previewDrawerOpen" @click="previewDrawerOpen = false">
      <div class="sk-preview-drawer" @click.stop>
        <div class="drawer-header">
          <div class="dh-title-row">
            <span class="dh-title">{{ previewSkillName }}</span>
            <button class="btn btn-ghost btn-sm" @click="previewDrawerOpen = false"><i class="ph ph-x"></i></button>
          </div>
          <div class="dh-sub" v-if="previewDetail?.manifest?.description">
            {{ previewDetail.manifest.description }}
          </div>
          <div class="dh-actions">
            <button class="btn btn-ghost btn-sm" @click="app.openSkillDetail(previewSkillName)">
              <i class="ph ph-arrow-square-out"></i>完整详情页
            </button>
          </div>
        </div>

        <div class="drawer-body">
          <div v-if="previewLoading" class="drawer-loading">
            <i class="ph ph-circle-notch is-spinning"></i> 读取技能信息中…
          </div>
          <template v-else-if="previewDetail">
            <!-- 渠道一键挂载切换卡 -->
            <div class="drawer-section">
              <div class="ds-title">
                <i class="ph ph-plugs"></i>各渠道工具即时挂载控制
              </div>
              <div class="drawer-mount-grid">
                <div
                  class="drawer-mount-item"
                  v-for="t in (data?.tools || [])"
                  :key="t.id"
                >
                  <div class="dm-left">
                    <SkillChannelIcon :toolId="t.id" :name="t.name" size="sm" />
                    <span class="dm-name">{{ t.name }}</span>
                  </div>
                  <label class="switch-wrap">
                    <span class="sk-small sk-muted">{{ isToolMounted(t.id) ? '已挂载' : '未挂载' }}</span>
                    <div
                      class="switch"
                      :class="{ on: isToolMounted(t.id), 'is-busy': mountToggling[t.id] }"
                      @click="toggleChannelMount(t.id, isToolMounted(t.id))"
                    ></div>
                  </label>
                </div>
              </div>
            </div>

            <!-- Markdown 快速预览 -->
            <div class="drawer-section">
              <div class="ds-title">
                <i class="ph ph-file-text"></i>SKILL.md 文档速览
              </div>
              <div class="markdown-preview-box">
                <pre class="sk-mono sk-code-pre">{{ previewMarkdown || '（该技能无 SKILL.md 文档说明）' }}</pre>
              </div>
            </div>
          </template>
          <div v-else class="sk-empty-state">
            <i class="ph ph-warning"></i>
            <div class="es-title">未能读取到该技能详情</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sk-dashboard-wrap {
  position: relative;
}

/* 顶部 Hero 区域 */
.dash-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.dash-hero-left {
  flex: 1;
  min-width: 320px;
}
.dash-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.dash-main-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.hub-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  padding: 3px 10px;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.hub-pill:hover {
  border-color: var(--accent);
  color: var(--text-1);
}

/* 每日自动检测胶囊卡 */
.daily-check-capsule {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--panel-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.capsule-indicator {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.capsule-indicator.is-ok {
  background: rgba(56, 189, 248, 0.12);
  color: var(--accent);
}
.capsule-indicator.is-warn {
  background: rgba(245, 158, 11, 0.12);
  color: var(--warn);
}
.capsule-text {
  flex: 1;
  min-width: 0;
}
.capsule-text .c-title {
  font-size: 12.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.capsule-text .c-time {
  font-size: 11px;
  color: var(--text-3);
  font-weight: normal;
}
.capsule-text .c-desc {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn-capsule-act {
  flex-shrink: 0;
}

.dash-hero-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 4 宫格卡片 */
.stats-grid {
  margin-bottom: 20px;
}
.stat-card {
  padding: 14px 16px;
  cursor: pointer;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.stat-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.18);
  box-shadow: 0 4px 14px rgba(0,0,0,0.12);
}
.stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.stat-label {
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 500;
}
.stat-icon {
  font-size: 16px;
  color: var(--text-3);
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  margin-bottom: 8px;
}
.stat-num.accent { color: var(--accent); }
.stat-num.warn { color: var(--warn); }
.stat-slash { font-size: 18px; color: var(--text-3); margin: 0 2px; }
.stat-unit {
  font-size: 12px;
  font-weight: normal;
  color: var(--text-3);
  margin-left: 4px;
}
.stat-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-3);
}
.stat-link {
  color: var(--accent);
  display: flex;
  align-items: center;
  gap: 2px;
}
.stat-ok-tag {
  color: var(--accent);
  font-weight: 600;
}
.broken-hint {
  color: var(--warn);
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 渠道矩阵板块 */
.channel-matrix-sec {
  margin-bottom: 20px;
}
.sec-head-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 12px;
}
.sec-title {
  font-size: 14.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sec-actions {
  display: flex;
  gap: 8px;
}

.channel-matrix-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}
.channel-box {
  background: var(--panel-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  transition: all 0.2s ease;
}
.channel-box:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.channel-box.is-active {
  border-color: var(--accent);
  background: rgba(56, 189, 248, 0.08);
}
.channel-box.is-unhit {
  opacity: 0.6;
}
.cb-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.cb-info {
  min-width: 0;
}
.cb-name {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cb-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.cb-stat {
  font-size: 11px;
  color: var(--text-2);
}
.cb-count {
  font-weight: 700;
  font-size: 13px;
  color: var(--text-1);
  margin-right: 2px;
}
.cb-unit { font-size: 10.5px; color: var(--text-3); }
.cb-mount-tag {
  font-size: 10px;
  color: var(--accent);
  background: rgba(56, 189, 248, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
}
.cb-mount-tag.mute { color: var(--text-3); background: var(--panel-2); }
.cb-mount-tag.warn { color: var(--warn); background: rgba(245, 158, 11, 0.1); }

/* 快捷速览区域 */
.quick-preview-sec {
  margin-bottom: 20px;
}
.quick-count-badge {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(56, 189, 248, 0.12);
  padding: 2px 7px;
  border-radius: 12px;
  margin-left: 6px;
}
.quick-search-in {
  width: 200px;
  font-size: 12px;
}

.quick-skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.sk-card-quick {
  background: var(--panel-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.sk-card-quick:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.sq-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.sq-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 190px;
}
.sq-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
}
.sq-badge.ok { color: var(--accent); background: rgba(56, 189, 248, 0.1); }
.sq-badge.pending { color: var(--warn); background: rgba(245, 158, 11, 0.1); }

.sq-desc {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.45;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 33px;
}
.sq-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-soft);
  padding-top: 8px;
}
.sq-sources {
  display: flex;
  gap: 6px;
  align-items: center;
}
.sq-src-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  color: var(--text-3);
}
.sq-act {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent);
}
.sq-act .mount-stat { font-weight: 500; }

/* 预览抽屉 */
.sk-preview-drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}
.sk-preview-drawer {
  width: 520px;
  max-width: 90vw;
  height: 100%;
  background: var(--bg-1, #0f172a);
  border-left: 1px solid var(--border-soft);
  box-shadow: -4px 0 24px rgba(0,0,0,0.3);
  display: flex;
  flex-direction: column;
  animation: slideInRight 0.25s ease;
}
@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
.drawer-header {
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel-1);
}
.dh-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.dh-title {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.dh-sub {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
  margin-bottom: 10px;
}
.dh-actions {
  display: flex;
  gap: 8px;
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}
.drawer-loading {
  text-align: center;
  padding: 40px;
  color: var(--text-3);
  font-size: 13px;
}
.drawer-section {
  margin-bottom: 20px;
}
.ds-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--text-1);
}
.drawer-mount-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.drawer-mount-item {
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dm-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dm-name {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 90px;
}
.markdown-preview-box {
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 12px 14px;
  max-height: 380px;
  overflow-y: auto;
}
.sk-code-pre {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2);
}

.is-spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
