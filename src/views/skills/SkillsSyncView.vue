<script setup lang="ts">
// 技能仓库 · 同步中心：扫描预览 -> 确认执行 -> 看报告。界面只讲三件事：收什么、挂什么、有什么要裁决
import { ref, computed, onMounted } from "vue";
import { syncPlan, syncExecute, listReports, readReport, openReport, type SyncPlan, type SyncResult, type ReportRow } from "../../api/ipc";
import { fmtTime } from "../../utils/format";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const plan = ref<SyncPlan | null>(null);
const result = ref<SyncResult | null>(null);
const executing = ref(false);
const errMsg = ref("");
const reportContent = ref("");
const reports = ref<ReportRow[]>([]);
const activeReport = ref("");

const counts = computed(() => {
  const c: Record<string, number> = { import: 0, replace: 0, publish: 0, conflict: 0, skip: 0, error: 0 };
  if (!plan.value) return c;
  for (const a of plan.value.actions) {
    if (a.type === "import") c.import++;
    else if (a.type === "mount") (a.replaceReal ? c.replace++ : c.publish++);
    else if (a.type === "skip") c.skip++;
    else if (a.type === "error") c.error++;
  }
  c.conflict = plan.value.conflicts.length;
  return c;
});

// 预览表只列有动作的行，一切正常的技能不进表格
type Row = { skill: string; kind: "import" | "mount" | "publish" | "conflict" | "error"; source: string; detail: string; conflictId?: string };

const rows = computed<Row[]>(() => {
  if (!plan.value) return [];
  const out: Row[] = [];
  for (const a of plan.value.actions) {
    if (a.type === "import") {
      out.push({ skill: a.skill, kind: "import", source: (a.sources || []).map((s) => app.toolName(s.tool)).join(" + "), detail: a.note });
    } else if (a.type === "mount") {
      out.push({ skill: `${a.mountName || a.skill} @ ${app.toolName(a.toolId || "")}`, kind: a.replaceReal ? "mount" : "publish", source: "hub", detail: a.note });
    } else if (a.type === "error") {
      out.push({ skill: a.skill, kind: "error", source: "hub", detail: a.note });
    }
  }
  for (const c of plan.value.conflicts) {
    out.push({ skill: c.skill || c.title, kind: "conflict", source: c.toolId || "", detail: c.detail, conflictId: c.id });
  }
  return out;
});

const KIND_BADGE: Record<Row["kind"], { cls: string; icon: string; text: string }> = {
  import: { cls: "ok", icon: "ph-download-simple", text: "收进中央" },
  mount: { cls: "ok", icon: "ph-link", text: "改为共用" },
  publish: { cls: "info", icon: "ph-upload-simple", text: "分发到工具" },
  conflict: { cls: "warn", icon: "ph-git-merge", text: "需要你裁决" },
  error: { cls: "bad", icon: "ph-warning-octagon", text: "异常" },
};

async function scan() {
  errMsg.value = "";
  result.value = null;
  reportContent.value = "";
  try {
    plan.value = await syncPlan();
    if (!plan.value) errMsg.value = "未检测到后端，请通过 Electron 应用打开";
  } catch (e) {
    errMsg.value = String((e as Error).message || e);
  }
}

async function execute() {
  if (!plan.value) return;
  if (!confirm(`确认执行同步吗？\n收进中央 ${counts.value.import} 个 · 挂载变更 ${counts.value.replace + counts.value.publish} 处 · ${counts.value.conflict} 条冲突进入人工裁决。\n所有覆盖/删除先进入回收站，可还原。`)) return;
  executing.value = true;
  try {
    result.value = await syncExecute(plan.value);
    plan.value = null;
    reports.value = (await listReports()) || [];
    if (result.value?.reportFile) {
      const name = result.value.reportFile.replace(/\\/g, "/").split("/").pop() || "";
      activeReport.value = name;
      const r = await readReport(name);
      reportContent.value = r?.content || "";
    }
  } catch (e) {
    errMsg.value = String((e as Error).message || e);
  } finally {
    executing.value = false;
  }
}

async function openReportFile(file: string) {
  activeReport.value = file;
  try {
    const r = await readReport(file);
    reportContent.value = r?.content || "";
  } catch {
    reportContent.value = "";
  }
}

onMounted(async () => {
  await scan();
  reports.value = (await listReports()) || [];
});
</script>

<template>
  <section class="page sk-page">
    <div class="sk-page-head">
      <div>
        <h1>同步中心</h1>
        <p class="sub">一键把各工具里的技能收进中央仓库统一管理。先扫描预览，你确认了才动文件，每次同步都有报告可查。</p>
      </div>
      <div class="sk-head-actions">
        <span class="sk-badge info" style="align-self:center" v-if="plan"><i class="ph ph-eye"></i>预览，还没动任何文件</span>
        <span class="sk-badge ok" style="align-self:center" v-else-if="result"><i class="ph ph-check-circle"></i>已执行</span>
        <button class="sk-btn" @click="scan"><i class="ph ph-arrows-counter-clockwise"></i>重新扫描</button>
        <button class="sk-btn sk-btn-primary" :disabled="!plan || executing" @click="execute"><i class="ph ph-play"></i>{{ executing ? "执行中…" : "确认执行" }}</button>
      </div>
    </div>

    <div class="sk-note warn sk-mt-8" v-if="errMsg"><i class="ph ph-warning"></i><div>{{ errMsg }}</div></div>

    <div class="sk-grid sk-grid-3" v-if="plan">
      <div class="sk-panel sk-stat">
        <div class="label">收进中央</div>
        <div class="num accent">{{ counts.import }}</div>
        <div class="hint">工具目录里有、中央仓库还没有的技能</div>
      </div>
      <div class="sk-panel sk-stat">
        <div class="label">挂载变更</div>
        <div class="num accent">{{ counts.replace + counts.publish }}</div>
        <div class="hint">改为共用 {{ counts.replace }} 处 · 分发到工具 {{ counts.publish }} 处</div>
      </div>
      <div class="sk-panel sk-stat">
        <div class="label">需要你裁决</div>
        <div class="num" :class="counts.conflict ? 'warn' : ''">{{ counts.conflict }}</div>
        <div class="hint">同名技能但内容不一样，选保留哪个</div>
      </div>
    </div>
    <p class="sk-muted sk-small sk-mt-8" v-if="plan && counts.skip">另有 {{ counts.skip }} 个技能两边已经一致，无需处理。</p>

    <div class="sk-section" v-if="plan">
      <h2>这次同步会做什么</h2>
      <p class="desc">（{{ plan.mode === "copy" ? "复制模式" : "Junction 共用模式" }}）确认执行前不会改任何文件。</p>
      <div class="sk-panel" style="padding: 6px 8px; overflow-x:auto" v-if="rows.length">
        <table class="sk-table">
          <thead>
            <tr><th>技能</th><th>将做什么</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="i">
              <td>
                <div class="sk-strong">{{ r.skill }}</div>
                <div class="sk-muted sk-small">{{ r.detail }}</div>
              </td>
              <td><span class="sk-badge" :class="KIND_BADGE[r.kind].cls"><i class="ph" :class="KIND_BADGE[r.kind].icon"></i>{{ KIND_BADGE[r.kind].text }}</span></td>
              <td><button class="sk-btn sk-btn-sm" v-if="r.kind === 'conflict'" @click="app.go('dedup')">去裁决</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sk-panel" v-else>
        <div class="sk-empty-state">
          <i class="ph ph-check-circle" style="color:var(--accent)"></i>
          <div class="es-title">一切就绪，没有需要执行的动作</div>
          <div class="es-desc">各工具与中央仓库内容一致，无需变更。</div>
        </div>
      </div>
      <!-- 孤儿目录：只标记不删除，这里把「是什么、从哪来、怎么处理」一次讲清 -->
      <div class="sk-panel sk-mt-16" v-if="plan.orphans.length" style="padding: 0; overflow: hidden">
        <div class="sk-orphan-head">
          <i class="ph ph-folder-plus"></i>
          <div>
            <div class="sk-strong">待确认的孤儿目录（{{ plan.orphans.length }}）</div>
            <div class="sk-muted sk-small">
              工具技能目录里真实存在、但中央仓库还没接管的技能，<b>通常是你自己安装的</b>。执行一次同步就会收进中央库并原位转为挂载，此列表清零；程序只标记、不会删除它们。
              <a class="sk-link" @click="app.showHelp('help-orphans')">孤儿目录是什么？</a>
              <a class="sk-link" style="margin-left:10px" @click="app.showHelp('help-origin')">来源标识说明</a>
            </div>
          </div>
        </div>
        <table class="sk-table">
          <thead>
            <tr><th>目录名</th><th>所在工具</th><th>最后修改</th><th>来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="o in plan.orphans" :key="o.tool + o.name">
              <td class="strong sk-mono">{{ o.name }}</td>
              <td>{{ app.toolName(o.tool) }}</td>
              <td class="sk-muted">{{ o.mtimeMs ? fmtTime(o.mtimeMs) : "—" }}</td>
              <td><span class="sk-badge info"><i class="ph ph-hand-tap"></i>你安装的</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="sk-note ok sk-mt-16" v-if="result">
      <i class="ph ph-check-circle"></i>
      <div>同步完成：收进中央 {{ result.summary.imported }} 个 · 挂载变更 {{ result.summary.mounted }} 处 · 合并重复 {{ result.summary.merged }} 份 · 待裁决冲突 {{ result.summary.conflicts }} 条。</div>
    </div>

    <details class="sk-fold" v-if="reports.length" :open="!!result">
      <summary>同步报告（{{ reports.length }} 份）</summary>
      <div class="sk-chips" style="margin:8px 0 12px">
        <span class="sk-chip" v-for="r in reports.slice(0, 8)" :key="r.file" :class="{ on: activeReport === r.file }" @click="openReportFile(r.file)">
          <i class="ph ph-file-text"></i> {{ fmtTime(r.mtimeMs) }}
        </span>
      </div>
      <div class="sk-code" v-if="reportContent">{{ reportContent }}</div>
      <div class="sk-row sk-mt-16" style="gap:10px" v-if="activeReport">
        <button class="sk-btn sk-btn-sm" @click="openReport(activeReport)"><i class="ph ph-folder-open"></i>打开 reports 目录</button>
      </div>
    </details>
  </section>
</template>
