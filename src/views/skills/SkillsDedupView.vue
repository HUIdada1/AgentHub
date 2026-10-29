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
// 技能仓库 · 去重与冲突
import { computed, ref, nextTick, onMounted } from "vue";
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
const detailRef = ref<HTMLElement | null>(null);

const diffLines = ref<{ left: DiffLine[]; right: DiffLine[] } | null>(null);
const diffStatsRow = ref({ del: 0, add: 0 });

// diff-link 的链接现状：指向哪份、还在不在、中央有没有对应真身
const link = computed(() => diff.value?.link ?? null);
const linkTargetText = computed(() => {
  const l = link.value;
  if (!l) return "—";
  if (!l.target) return "（读不到链接目标）";
  return l.resolves ? l.target : `${l.target}（目标已不存在）`;
});
/** 两个动词各自的前提：缺哪个就置灰并在面板上写明原因，别让人点了没反应 */
const canRelink = computed(() => link.value?.centralExists === true);
const canAdopt = computed(() => {
  const l = link.value;
  return !!l && l.resolves && l.hasSkillMd && !l.targetInsideHub;
});
const linkBlockReason = computed(() => {
  const l = link.value;
  if (!l) return "读不到这条链接的现状（可能主进程读取失败），点「刷新」重试。";
  if (!canRelink.value && !canAdopt.value) return "中央没有这份真身，链接指向的位置也读不到技能内容：先在工具目录里修好这个链接，或直接忽略这条冲突。";
  const reasons: string[] = [];
  if (!canRelink.value) reasons.push(`中央还没有这份真身（${l.centralPath}），「重建链接指向中央」无从挂起`);
  if (!l.resolves) reasons.push("链接悬空（指向的目标不存在），没有内容可收纳");
  else if (!l.hasSkillMd) reasons.push("链接指向的位置没有 SKILL.md，不认为是技能目录");
  else if (l.targetInsideHub) reasons.push("链接指向中央仓库内部，收下它会覆盖另一份真身");
  return reasons.join("；");
});

async function load() {
  try {
    [plan.value, conflicts.value, cfg.value] = await Promise.all([syncPlan(), listConflicts(), loadConfig()]);
    if (conflicts.value?.length) await pick(conflicts.value[0]);
    else { active.value = null; diff.value = null; diffLines.value = null; }
  } catch (e) {
    actionMsg.value = String((e as Error).message || e);
  }
}

/** 手动刷新：只有这里清掉上一条结果提示——裁决后的反馈不能被紧随其后的重拉抹掉 */
async function refresh() {
  actionMsg.value = "";
  await load();
}

/** 行图标：跨设备冲突是云、链接指向异常是断链，其余是合并分支 */
function rowIcon(c: ConflictItem): string {
  if (c.kind === "remote") return "ph-cloud";
  if (c.kind === "diff-link") return "ph-link-break";
  return "ph-git-merge";
}

async function pick(c: ConflictItem, reveal = false) {
  active.value = c;
  diff.value = null;
  diffLines.value = null;
  diffStatsRow.value = { del: 0, add: 0 };
  // 三类都走双栏 SKILL.md 对比：content 是工具版 vs 中央版，remote 的右侧是同步时暂存的远端版，
  // diff-link 的左侧是链接现在指向的那份（悬空时读不到）
  if (c.kind === "content" || c.kind === "remote" || c.kind === "diff-link") {
    const d = await getConflictDiff(c.id).catch(() => null);
    diff.value = d;
    if (d) {
      diffLines.value = sideBySideDiff(d.left.md, d.right.md);
      diffStatsRow.value = diffStats(d.left.md, d.right.md);
    }
  }
  // 点「查看 / 裁决」要的是这一条的裁决面：面板在列表下方，长列表时落在屏幕外，
  // 不滚一下跟没反应一样。首次自动选中不滚，别抢用户当前的位置
  if (reveal) {
    await nextTick();
    detailRef.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** 裁决确认文案：diff-link 的两个动词都不删内容，套用「落选版本进回收站」会把人吓退 */
function confirmText(c: ConflictItem, choice: string): string {
  if (c.kind !== "diff-link") return `确认裁决：${c.title}\n落选版本将移入回收站（保留 ${cfg.value?.trashDays ?? 7} 天）。`;
  if (choice === "relink") return `确认重建链接？\n${c.title}\n只替换工具目录里的那个链接，它当前指向的内容不会被删除。`;
  return `确认收下链接指向的那份内容？\n${c.title}\n它会成为中央真身，中央现有版本先进回收站；链接指向的那份内容原地保留，随后重挂为指向中央的链接。`;
}

async function resolve(choice: string) {
  if (!active.value) return;
  const c = active.value;
  if (!confirm(confirmText(c, choice))) return;
  // 后端拒绝的理由（中央还没有真身、链接悬空、指向中央内部……）必须原样说出来，
  // 吞成「裁决失败」等于又回到"点了没反应"
  const r = await resolveConflict(c.id, choice).catch((e: unknown) => ({ ok: false, message: String((e as Error).message || e) }));
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
        <button class="btn btn-cta" @click="refresh"><i class="ph ph-arrows-counter-clockwise"></i>刷新</button>
      </div>
    </div>

    <div class="sk-note sk-mt-8" v-if="actionMsg"><i class="ph ph-info"></i><div>{{ actionMsg }}</div></div>

    <div class="sk-section">
      <h2>需要你决定的冲突（{{ conflicts.length }}）</h2>
      <p class="desc">同名异容的技能选保留哪边；落选的先进回收站，可还原</p>
      <div class="sk-panel" style="padding: 6px 18px; max-height: 380px; overflow-y: auto" v-if="conflicts.length">
        <div class="sk-tool-row" :class="{ 'is-active': active?.id === c.id }" v-for="c in conflicts" :key="c.id">
          <div class="sk-tool-icon" :style="{ color: c.kind === 'norm' ? 'var(--info)' : 'var(--warn)' }"><i class="ph" :class="rowIcon(c)"></i></div>
          <div class="t-main">
            <div class="t-name">{{ c.title }}</div>
            <div class="t-path">{{ c.detail }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" :class="{ 'btn-cta': active?.id !== c.id }" @click="pick(c, true)">查看 / 裁决</button>
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

    <div ref="detailRef">
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

      <!-- 链接指向异常：工具目录那个位置有链接，但不指向中央真身。先亮现场（指向哪份、中央有没有），
           再给两个动词——只重建链接，或先把链接指向的那份收进中央 -->
      <div class="sk-section" v-if="active && active.kind === 'diff-link'">
        <h2>链接指向异常：{{ active.skill || active.title }}</h2>
        <p class="desc">{{ active.detail }}。</p>
        <div class="sk-panel" style="padding: 12px 16px">
          <div class="sk-row" style="gap: 10px">
            <span class="sk-muted sk-small" style="flex: none; width: 60px">现有链接</span>
            <span class="sk-mono sk-small" style="overflow-wrap: anywhere">{{ link?.linkPath || "—" }}</span>
          </div>
          <div class="sk-row sk-mt-8" style="gap: 10px">
            <span class="sk-muted sk-small" style="flex: none; width: 60px">指向</span>
            <span class="sk-mono sk-small" style="overflow-wrap: anywhere">{{ linkTargetText }}</span>
          </div>
          <div class="sk-row sk-mt-8" style="gap: 10px">
            <span class="sk-muted sk-small" style="flex: none; width: 60px">中央真身</span>
            <span class="sk-mono sk-small" style="overflow-wrap: anywhere">{{ link?.centralPath || "—" }}</span>
            <span class="sk-badge" :class="link?.centralExists ? 'ok' : 'warn'">{{ link?.centralExists ? "已存在" : "还没有" }}</span>
          </div>
        </div>

        <div class="sk-note sk-mt-8" v-if="!link"><i class="ph ph-warning"></i><div>读不到这条链接的现状（可能主进程读取失败），点「刷新」重试。</div></div>
        <div class="sk-diff-wrap" v-else-if="diffLines && diff?.left.md && diff?.right.md">
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
        <div class="sk-note sk-mt-8" v-else-if="!link?.resolves"><i class="ph ph-link-break"></i><div>链接悬空：它指向的位置已经不存在，没有内容可对比。</div></div>
        <div class="sk-note sk-mt-8" v-else-if="!link?.centralExists"><i class="ph ph-info"></i><div>中央还没有这份技能，没有可对比的中央版。</div></div>
        <div class="sk-note sk-mt-8" v-else><i class="ph ph-info"></i><div>两侧读不到 SKILL.md，无法逐行对比，可按上面的路径自行核对。</div></div>

        <div class="sk-row sk-mt-16" style="gap:10px; flex-wrap: wrap">
          <button class="btn btn-cta" :disabled="!canRelink" @click="resolve('relink')"><i class="ph ph-link"></i>重建链接指向中央</button>
          <button class="btn btn-ghost" :disabled="!canAdopt" @click="resolve('adopt')"><i class="ph ph-download-simple"></i>把链接那份收进中央</button>
          <button class="btn btn-ghost" @click="dismiss"><i class="ph ph-x"></i>忽略</button>
          <span class="sk-muted sk-small" style="margin-left:auto">重建只换链接本身，不动它指向的内容；内容先进 <span class="sk-mono">.trash\</span>，保留 {{ cfg?.trashDays ?? 7 }} 天</span>
        </div>
        <p class="desc sk-mt-8" v-if="linkBlockReason">{{ linkBlockReason }}</p>
      </div>
    </div>

    <details class="sk-fold" v-if="plan?.dedup?.duplicates?.length">
      <summary>已自动合并的重复组（{{ plan.dedup.duplicates.length }}）</summary>
      <p class="desc">扫描中自动合并的组，来源工具均有记录，可从回收站还原</p>
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
      <p class="desc">名字描述相似但内容不同，不自动合并；可在设置页开关此提示</p>
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
