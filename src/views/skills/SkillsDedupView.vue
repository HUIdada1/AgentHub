<script setup lang="ts">
// 技能仓库 · 去重与冲突
import { ref, onMounted } from "vue";
import {
  syncPlan, listConflicts, getConflictDiff, resolveConflict, dismissConflict, loadConfig,
  type SyncPlan, type ConflictItem, type ConflictDiff, type AppConfig,
} from "../../api/ipc";
import { sideBySideDiff, diffStats, type DiffLine } from "../../utils/diff";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const plan = ref<SyncPlan | null>(null);
const conflicts = ref<ConflictItem[]>([]);
const active = ref<ConflictItem | null>(null);
const diff = ref<ConflictDiff | null>(null);
const cfg = ref<AppConfig | null>(null);
const actionMsg = ref("");

const diffLines = ref<{ left: DiffLine[]; right: DiffLine[] } | null>(null);
const diffStatsRow = ref({ del: 0, add: 0 });

async function load() {
  actionMsg.value = "";
  try {
    [plan.value, conflicts.value, cfg.value] = await Promise.all([syncPlan(), listConflicts(), loadConfig()]);
    if (conflicts.value?.length) await pick(conflicts.value[0]);
    else { active.value = null; diff.value = null; diffLines.value = null; }
  } catch (e) {
    actionMsg.value = String((e as Error).message || e);
  }
}

async function pick(c: ConflictItem) {
  active.value = c;
  diff.value = null;
  diffLines.value = null;
  // content 与 remote 冲突都走双栏 SKILL.md 对比（remote 的右侧是同步时暂存的远端版）
  if (c.kind === "content" || c.kind === "remote") {
    const d = await getConflictDiff(c.id).catch(() => null);
    diff.value = d;
    if (d) {
      diffLines.value = sideBySideDiff(d.left.md, d.right.md);
      diffStatsRow.value = diffStats(d.left.md, d.right.md);
    }
  }
}

async function resolve(choice: string) {
  if (!active.value) return;
  const c = active.value;
  if (!confirm(`确认裁决：${c.title}\n落选版本将移入回收站（保留 ${cfg.value?.trashDays ?? 7} 天）。`)) return;
  const r = await resolveConflict(c.id, choice).catch(() => null);
  actionMsg.value = r?.message || (r?.ok ? "已裁决" : "裁决失败");
  await load();
}

async function dismiss() {
  if (!active.value) return;
  await dismissConflict(active.value.id).catch(() => {});
  actionMsg.value = "已忽略该冲突（下次同步若仍存在会重新出现）";
  await load();
}

onMounted(load);
</script>

<template>
  <section class="page sk-page">
    <div class="sk-page-head">
      <p class="sk-scan-summary" v-if="plan"><i class="ph ph-funnel"></i>本轮扫描自动合并了 {{ plan?.dedup?.duplicates?.length ?? 0 }} 组重复副本；剩下 {{ conflicts.length }} 条疑似冲突需要你逐条确认。</p>
      <div class="sk-head-actions">
        <button class="btn btn-ghost" @click="app.openModuleConfig()"><i class="ph ph-gear-six"></i>去重策略</button>
        <button class="btn btn-cta" @click="load"><i class="ph ph-arrows-counter-clockwise"></i>刷新</button>
      </div>
    </div>

    <div class="sk-note sk-mt-8" v-if="actionMsg"><i class="ph ph-info"></i><div>{{ actionMsg }}</div></div>

    <div class="sk-section">
      <h2>需要你决定的冲突（{{ conflicts.length }}）</h2>
      <p class="desc">同名但内容不一样，选保留哪边。落选的会先进回收站，可还原。</p>
      <div class="sk-panel" style="padding: 6px 18px; max-height: 380px; overflow-y: auto" v-if="conflicts.length">
        <div class="sk-tool-row" v-for="c in conflicts" :key="c.id" :style="active?.id === c.id ? 'background:var(--panel-2)' : ''">
          <div class="sk-tool-icon" :style="{ color: c.kind === 'norm' ? 'var(--info)' : 'var(--warn)' }"><i class="ph" :class="c.kind === 'remote' ? 'ph-cloud' : 'ph-git-merge'"></i></div>
          <div class="t-main">
            <div class="t-name">{{ c.title }}</div>
            <div class="t-path">{{ c.detail }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" :class="{ 'btn-cta': active?.id !== c.id }" @click="pick(c)">查看 / 裁决</button>
        </div>
      </div>
      <div class="sk-panel" v-else>
        <div class="sk-empty-state">
          <i class="ph ph-check-circle" style="color:var(--accent)"></i>
          <div class="es-title">没有待裁决的冲突</div>
          <div class="es-desc">同步引擎发现的同名异容冲突会出现在这里。</div>
        </div>
      </div>
    </div>

    <div class="sk-section" v-if="active && active.kind === 'content'">
      <h2>裁决：{{ active.title }}</h2>
      <p class="desc">{{ active.detail }}</p>
      <div class="sk-diff-wrap" v-if="diffLines">
        <div class="sk-diff-col">
          <div class="d-head"><span>{{ diff?.left.label }} · {{ app.toolName(active.toolId || "") }}</span><span class="sk-mono" style="color:var(--text-3)">{{ diffStatsRow.del }} 处差异</span></div>
          <div class="d-body">
            <span v-for="(l, i) in diffLines.left" :key="i" :class="l.kind" style="display:block">{{ l.text || " " }}</span>
          </div>
        </div>
        <div class="sk-diff-col">
          <div class="d-head"><span>{{ diff?.right.label }} · 中央版</span><span class="sk-mono" style="color:var(--text-3)">{{ diffStatsRow.add }} 处差异</span></div>
          <div class="d-body">
            <span v-for="(l, i) in diffLines.right" :key="i" :class="l.kind" style="display:block">{{ l.text || " " }}</span>
          </div>
        </div>
      </div>
      <div class="sk-note sk-mt-8" v-else><i class="ph ph-info"></i><div>无法读取 SKILL.md 内容（目录可能已变更），重新扫描后再试。</div></div>

      <div class="sk-row sk-mt-16" style="gap:10px">
        <button class="btn btn-cta" @click="resolve('keepHub')"><i class="ph ph-shield-check"></i>保留中央版</button>
        <button class="btn btn-ghost" @click="resolve('keepTool')"><i class="ph ph-arrow-u-up-left"></i>保留{{ app.toolName(active.toolId || "") }}版</button>
        <button class="btn btn-ghost" @click="resolve('keepBoth')"><i class="ph ph-copy"></i>双保留改名</button>
        <button class="btn btn-ghost" @click="dismiss"><i class="ph ph-x"></i>忽略</button>
        <span class="sk-muted sk-small" style="margin-left:auto">落选版本将移入 <span class="sk-mono">.trash\</span>，保留 {{ cfg?.trashDays ?? 7 }} 天可还原</span>
      </div>
    </div>

    <div class="sk-section" v-if="active && active.kind === 'norm'">
      <h2>疑似同一个技能</h2>
      <p class="desc">{{ active.detail }}</p>
      <div class="sk-row" style="gap:10px">
        <button class="btn btn-cta" @click="resolve('same')"><i class="ph ph-git-merge"></i>确认同一，合并为一个</button>
        <button class="btn btn-ghost" @click="resolve('different')"><i class="ph ph-x"></i>是不同技能，忽略</button>
      </div>
    </div>

    <!-- 跨设备冲突：两台电脑都改了同一技能，裁决后下次 WebDAV 同步按结果执行 -->
    <div class="sk-section" v-if="active && active.kind === 'remote'">
      <h2>跨设备冲突：{{ active.skill }}</h2>
      <p class="desc">{{ active.detail }}。本机版哈希 <span class="sk-mono">{{ (active.localHash || "").slice(0, 12) }}</span>，远端版哈希 <span class="sk-mono">{{ (active.remoteHash || "").slice(0, 12) }}</span>。</p>
      <div class="sk-diff-wrap" v-if="diffLines">
        <div class="sk-diff-col">
          <div class="d-head"><span>{{ diff?.left.label }}</span><span class="sk-mono" style="color:var(--text-3)">{{ diffStatsRow.del }} 处差异</span></div>
          <div class="d-body">
            <span v-for="(l, i) in diffLines.left" :key="i" :class="l.kind" style="display:block">{{ l.text || " " }}</span>
          </div>
        </div>
        <div class="sk-diff-col">
          <div class="d-head"><span>{{ diff?.right.label }}</span><span class="sk-mono" style="color:var(--text-3)">{{ diffStatsRow.add }} 处差异</span></div>
          <div class="d-body">
            <span v-for="(l, i) in diffLines.right" :key="i" :class="l.kind" style="display:block">{{ l.text || " " }}</span>
          </div>
        </div>
      </div>
      <div class="sk-note sk-mt-8" v-else><i class="ph ph-info"></i><div>远端版暂存缺失（可能同步被中断），回到「WebDAV 同步」页重新同步一次再裁决。</div></div>

      <div class="sk-row sk-mt-16" style="gap:10px">
        <button class="btn btn-cta" @click="resolve('keepLocal')"><i class="ph ph-desktop"></i>保留本机版</button>
        <button class="btn btn-ghost" @click="resolve('keepRemote')"><i class="ph ph-cloud-arrow-down"></i>采用远端版</button>
        <button class="btn btn-ghost" @click="resolve('keepBoth')"><i class="ph ph-copy"></i>双保留（远端版改名收下）</button>
        <button class="btn btn-ghost" @click="dismiss"><i class="ph ph-x"></i>忽略</button>
        <span class="sk-muted sk-small" style="margin-left:auto">落选版本将移入 <span class="sk-mono">.trash\</span>，保留 {{ cfg?.trashDays ?? 7 }} 天</span>
      </div>
    </div>

    <details class="sk-fold" v-if="plan?.dedup?.duplicates?.length">
      <summary>已自动合并的重复组（{{ plan.dedup.duplicates.length }}）</summary>
      <p class="desc">扫描中自动合并的组，来源工具均保留记录，可随时从回收站还原。</p>
      <div class="sk-panel" style="padding: 6px 8px; overflow-x:auto">
        <table class="sk-table">
          <thead>
            <tr><th>保留</th><th>合并掉</th><th>判定</th><th>依据</th></tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in plan.dedup.duplicates" :key="i">
              <td class="strong sk-mono">{{ d.kept.name }}</td>
              <td class="sk-mono">{{ app.toolName(d.removed.tool) }}:{{ d.removed.name }}</td>
              <td><span class="sk-badge ok">{{ d.rule }}</span></td>
              <td class="sk-muted sk-small">{{ d.basis }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details class="sk-fold" v-if="plan?.dedup?.hints?.length">
      <summary>疑似同一技能提示（{{ plan.dedup.hints.length }}）</summary>
      <p class="desc">名字和描述很相似，但内容不同，不自动合并。可在设置页开关此提示。</p>
      <div class="sk-panel" style="padding: 6px 18px;">
        <div class="sk-tool-row" v-for="(h, i) in plan.dedup.hints" :key="i">
          <div class="sk-tool-icon" style="color:var(--info)"><i class="ph ph-sparkle"></i></div>
          <div class="t-main">
            <div class="t-name"><span class="sk-mono">{{ h.a }}</span> 与 <span class="sk-mono">{{ h.b }}</span></div>
            <div class="t-path">相似度 {{ h.sim }}，请人工确认是否同一技能</div>
          </div>
        </div>
      </div>
    </details>
  </section>
</template>
