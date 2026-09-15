<script setup lang="ts">
// 技能仓库 · 仪表盘：中央技能库与各工具连接状态总览
import { ref, onMounted } from "vue";
import { getOverview, adoptHubSkill, type Overview } from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { fmtTime } from "../../utils/format";

const app = useAppStore();
const data = ref<Overview | null>(null);
const loading = ref(true);
const errMsg = ref("");
const actionMsg = ref("");

function mountOkCount(toolId: string, o: Overview) {
  return o.mountHealth.filter((m) => m.tool === toolId && m.valid).length;
}

function mountBroken(o: Overview) {
  return o.mountHealth.filter((m) => !m.valid);
}

function pendingCount(o: Overview): number {
  return o.pendingConflicts.length + o.orphans.length + (o.hubExtra || []).length;
}

async function doAdopt(name: string) {
  actionMsg.value = `正在纳管 ${name}…`;
  const r = await adoptHubSkill(name).catch(() => null);
  actionMsg.value = r?.ok ? `已纳管 ${name}，登记挂载 ${r.mounts} 处` : r?.message || "纳管失败";
  await load();
}

async function load() {
  loading.value = true;
  errMsg.value = "";
  try {
    data.value = await getOverview();
    if (!data.value) errMsg.value = "未检测到后端（浏览器预览模式），请通过 Electron 应用打开";
  } catch (e) {
    errMsg.value = String((e as Error).message || e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page sk-page">
    <div class="sk-page-head">
      <div>
        <h1>仪表盘</h1>
        <p class="sub" v-if="data">中央仓库位于 <span class="sk-mono">{{ data.hubDir }}</span>。同步仅手动触发，所有写入经回收站兜底。</p>
        <p class="sub" v-else>正在读取中央仓库状态…</p>
      </div>
      <div class="sk-head-actions">
        <button class="sk-btn" @click="app.go('sync')"><i class="ph ph-arrows-left-right"></i>去同步</button>
        <button class="sk-btn sk-btn-primary" :disabled="loading" @click="load"><i class="ph ph-lightning"></i>{{ loading ? "读取中" : "刷新" }}</button>
      </div>
    </div>

    <div class="sk-note warn" v-if="errMsg"><i class="ph ph-warning"></i><div>{{ errMsg }}</div></div>
    <div class="sk-note sk-mt-8" v-if="actionMsg"><i class="ph ph-info"></i><div>{{ actionMsg }}</div></div>

    <template v-if="data">
      <div class="sk-grid sk-grid-4">
        <div class="sk-panel sk-stat">
          <div class="label">中央技能库</div>
          <div class="num accent">{{ data.manifestCount || data.skillCount }}<small>个技能</small></div>
          <div class="hint">来自 {{ data.sourceCount }} 份原始副本的去重结果</div>
        </div>
        <div class="sk-panel sk-stat">
          <div class="label">去重消除</div>
          <div class="num">{{ data.l1Merged }}<small>份重复</small></div>
          <div class="hint">L1 内容树哈希精确命中</div>
        </div>
        <div class="sk-panel sk-stat">
          <div class="label">已连接工具</div>
          <div class="num">{{ data.tools.length }}<small>个目录</small></div>
          <div class="hint">Junction 按技能粒度挂载共用</div>
        </div>
        <div class="sk-panel sk-stat">
          <div class="label">待处理</div>
          <div class="num" :class="pendingCount(data) ? 'warn' : 'accent'">{{ pendingCount(data) }}<small>项</small></div>
          <div class="hint">{{ data.pendingConflicts.length }} 个冲突 + {{ data.orphans.length }} 个孤儿 + {{ (data.hubExtra || []).length }} 个未登记</div>
        </div>
      </div>

      <div class="sk-section">
        <h2>工具连接</h2>
        <p class="desc">每个工具的全局技能目录。括号内为可收纳的技能数（工具自带目录不计入），含 Junction 指入。</p>
        <div class="sk-panel" style="padding: 6px 18px;">
          <div class="sk-tool-row" v-for="t in data.tools" :key="t.id">
            <div class="sk-tool-icon"><i class="ph" :class="app.toolIcon(t.id)"></i></div>
            <div class="t-main">
              <div class="t-name">{{ t.name }}</div>
              <div class="t-path">{{ t.dir }}</div>
            </div>
            <span class="t-count">{{ t.skillCount }}</span>
            <span class="sk-badge ok" v-if="mountOkCount(t.id, data) > 0"><i class="ph ph-check-circle"></i>已挂载 {{ mountOkCount(t.id, data) }}</span>
            <span class="sk-badge mute" v-else><i class="ph ph-minus-circle"></i>未挂载</span>
          </div>
          <div class="sk-tool-row" v-if="!data.tools.length">
            <div class="t-main">
              <div class="t-name sk-muted">未发现任何工具技能目录</div>
              <div class="t-path">可在设置中调整候选路径，或扫描发现 / 手动新增工具适配器</div>
            </div>
          </div>
        </div>
        <div class="sk-mt-16" v-if="mountBroken(data).length">
          <div class="sk-note warn">
            <i class="ph ph-warning"></i>
            <div>发现 {{ mountBroken(data).length }} 个失效挂载（{{ mountBroken(data).slice(0, 3).map((m) => m.skill + "@" + m.tool).join("、") }}{{ mountBroken(data).length > 3 ? " 等" : "" }}），可在技能库一键重建。</div>
          </div>
        </div>
      </div>

      <div class="sk-grid sk-grid-2 sk-section">
        <div>
          <h2>最近同步</h2>
          <p class="desc">每次同步都会在 <span class="sk-mono">reports\</span> 生成 MD 报告。</p>
          <div class="sk-panel sk-timeline" v-if="data.recentReports.length">
            <div class="tl-row" v-for="r in data.recentReports" :key="r.file">
              <span class="tl-time">{{ fmtTime(r.mtimeMs) }}</span>
              <div class="tl-main">
                <div class="tl-title">同步 <span class="sk-badge ok">完成</span></div>
                <div class="tl-desc">{{ r.file }}</div>
              </div>
              <button class="sk-btn sk-btn-sm" @click="app.go('sync')"><i class="ph ph-file-text"></i>报告</button>
            </div>
          </div>
          <div class="sk-panel" v-else>
            <div class="sk-empty-state" style="padding:28px 16px">
              <i class="ph ph-file-text"></i>
              <div class="es-title">还没有同步记录</div>
              <div class="es-desc">首次同步将把各工具技能去重收纳到中央仓库，并产出第一份 MD 报告。</div>
            </div>
          </div>
        </div>

        <div>
          <h2>待办事项</h2>
          <p class="desc">需要你决策的事项，处理后仪表盘计数归零。</p>
          <div class="sk-panel" style="padding: 6px 18px;" v-if="pendingCount(data)">
            <div class="sk-tool-row" v-for="c in data.pendingConflicts.slice(0, 4)" :key="c.id">
              <div class="sk-tool-icon" style="color:var(--warn)"><i class="ph ph-git-merge"></i></div>
              <div class="t-main">
                <div class="t-name">{{ c.title }}</div>
                <div class="t-path">{{ c.detail }}</div>
              </div>
              <button class="sk-btn sk-btn-sm" @click="app.go('dedup')"><i class="ph ph-arrow-right"></i>裁决</button>
            </div>
            <div class="sk-tool-row" v-for="o in data.orphans.slice(0, 3)" :key="o.dir + o.name">
              <div class="sk-tool-icon"><i class="ph ph-folder-plus"></i></div>
              <div class="t-main">
                <div class="t-name">陌生目录：{{ o.name }}</div>
                <div class="t-path">存在于 {{ app.toolName(o.tool) }}{{ o.mtimeMs ? " · 最后修改 " + fmtTime(o.mtimeMs) : "" }}，待确认收纳</div>
              </div>
              <button class="sk-btn sk-btn-sm" @click="app.go('sync')"><i class="ph ph-arrow-right"></i>查看</button>
            </div>
            <div class="sk-tool-row" v-for="h in (data.hubExtra || []).slice(0, 3)" :key="'hx' + h.name">
              <div class="sk-tool-icon" style="color:var(--warn)"><i class="ph ph-eye-slash"></i></div>
              <div class="t-main">
                <div class="t-name">中央未登记：{{ h.name }}</div>
                <div class="t-path">{{ h.isLink ? "悬空链接，无真身" : h.hasSkillMd ? "已被直接放入中央仓库（可能 AI 绕过软件操作）" : "非技能内容" }}</div>
              </div>
              <button class="sk-btn sk-btn-sm" :disabled="h.isLink" @click="doAdopt(h.name)"><i class="ph ph-clipboard-text"></i>纳管</button>
            </div>
          </div>
          <div class="sk-panel" v-else>
            <div class="sk-empty-state" style="padding:28px 16px">
              <i class="ph ph-check-circle" style="color:var(--accent)"></i>
              <div class="es-title">暂无待办</div>
              <div class="es-desc">没有待裁决冲突，也没有陌生孤儿目录。</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
