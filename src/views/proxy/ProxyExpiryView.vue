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
<!-- 积分日历（原「积分到期」，方案 Q3c）：把所有渠道所有账号的积分包拉平，按到期升序统一呈现，
     一屏看清「哪些包快过期了」。分级配色与号池页展开明细一致（主进程按 expiringSoonDays 派生）。
     默认档「有余额」滤掉剩余为 0 的包——已用完的包再谈到期没有信息量（2026-09-29）。
     两条后加的口径（2026-10-12）：
       · 上游不拆包的渠道（catpaw / cline / autoclaw / raccoon / modelscope）
         按账号出一条聚合行，日历因此覆盖全部有额度概念的渠道；
         （2026-10-13：lobster 与 qoder 家已改出真逐包——上游同一条响应里就带着逐包与到期，
          见 adapters.cjs 的 lobsterCreditPackages 与 qoderAdapter.cjs 的 creditPackagesOf）
       · 过期满 STALE_EXPIRED_DAYS 天的行退出默认视图（几天前的过期包只剩刷屏价值），
         收进「历史过期积分」按钮，一行都不丢。
     三档呈现（2026-10-13，用户要「更可视化的形式且能与表格互切」）：
       · 表格（默认）= 逐包明细的权威面
       · 时间轴 = 泳道点阵，答「哪几天集中掉」；纯 DOM，不引 echarts 新注册
       · 见底曲线 = 每渠道一根台阶线（小倍图，各自单位），答「哪天腰斩、什么时候归零」；内联 SVG
       两档图形吃的都是本页已过滤的 rows ⇒ 筛选/历史档对三档同时生效。
       选型过程与被淘汰的四种形态（逐包甘特 / 热力网格 / 堆叠柱 / 环形）见当轮对照页。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyCreditPackage } from "../../types";
import { useAppStore } from "../../stores/app";
import { coalesceAsync } from "../../utils/timing";
import { fmtDate, fmtBalance, fmtBalancePair, pkgFallbackName } from "./format";
import { CHANNEL_ICONS, channelInitial } from "./channelIcons";
import {
  LANE_TICKS,
  LANE_FAR_X,
  LANE_X_MAX,
  buildDecaySeries,
  buildExpiryLanes,
  decayAreaPath,
  decayPath,
  lanePct,
  type DecaySeries,
  type ExpiryLane,
  type LaneDot,
} from "./expiryLanes";
import {
  STATUS_OPTIONS,
  SORT_OPTIONS,
  STALE_EXPIRED_DAYS,
  aggregateRow,
  applyExpiryFilter,
  countByState,
  expiredDays,
  statusOf,
  type ExpiryRow,
  type ExpirySortKey,
  type ExpiryStatusFilter,
} from "./expiryRows";

const app = useAppStore();
const active = computed(() => app.activeModule === "proxy" && app.activePage === "expiry");

const pool = ref<ProxyChannelView[]>([]);
const loading = ref(false);
const err = ref("");
let offEvent: (() => void) | undefined;
let scheduleRefresh: (ReturnType<typeof coalesceAsync>) | undefined;

const statusFilter = ref<ExpiryStatusFilter>("usable");
const channelFilter = ref("all");
const sortKey = ref<ExpirySortKey>("expiryAsc");
/** 历史过期档：只看全部已过期（含默认视图自动隐藏的陈旧过期） */
const historyOpen = ref(false);

async function refresh() {
  loading.value = true;
  err.value = "";
  nowMs.value = Date.now();
  try {
    pool.value = await api.proxyPool();
  } catch (e) {
    err.value = String((e as Error)?.message || e);
  } finally {
    loading.value = false;
  }
}

// 拉平：各渠道账号逐包摊平成行。有逐包明细的用逐包，没有的按账号出一条聚合行，
// 两者互斥所以不会重复计数；排序交给 applyExpiryFilter
const allRows = computed<ExpiryRow[]>(() => {
  const out: ExpiryRow[] = [];
  for (const ch of pool.value) {
    for (const acc of ch.accounts) {
      const packs = acc.packages || [];
      if (packs.length) {
        for (const [i, pkg] of packs.entries()) {
          // key 带下标：同一账号两个包的 code 可能同为空/相同，仅 code 作 key 会撞
          out.push({ key: `${acc.id}:${i}:${pkg.code || ""}`, channelId: ch.id, channelDisplay: ch.display, accountName: acc.name || "（未命名）", pkg });
        }
        continue;
      }
      const agg = aggregateRow(ch.id, ch.display, acc);
      if (agg) out.push(agg);
    }
  }
  return out;
});

const channelOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const r of allRows.value) if (!seen.has(r.channelId)) seen.set(r.channelId, r.channelDisplay);
  return [...seen].map(([value, label]) => ({ value, label }));
});

// 选中的渠道从号池消失后（渠道被删/改）回落「全部」，免得下拉里显示裸 id
watch(channelOptions, (opts) => {
  if (channelFilter.value !== "all" && !opts.some((o) => o.value === channelFilter.value)) channelFilter.value = "all";
});

/** 顶部渠道切换收起/展开：默认收起成一行方块（参考号池页风格） */
const switcherCollapsed = ref(true);

/** 各渠道在当前日历中的包数量统计 */
const channelPkgCounts = computed(() => {
  const map: Record<string, number> = {};
  for (const r of allRows.value) {
    map[r.channelId] = (map[r.channelId] || 0) + 1;
  }
  return map;
});

function getChannelPkgCount(channelId: string): number {
  return channelPkgCounts.value[channelId] || 0;
}

function stripTip(ch: { id: string; display?: string }): string {
  const count = getChannelPkgCount(ch.id);
  return `${ch.display || ch.id} · ${count} 个包`;
}

/** 一次渲染只取一次时刻。三档图形各自 Date.now() 会让「点位、曲线、表格剩余天数」跨过一次阈值
 *  而互相矛盾（同一批行被三把尺量），刷新时统一推进。 */
const nowMs = ref(Date.now());
const rows = computed(() =>
  applyExpiryFilter(allRows.value, { status: statusFilter.value, channelId: channelFilter.value, sort: sortKey.value, history: historyOpen.value }, nowMs.value),
);

// 聚合标签走全量：它们是总览数字，不随筛选变化
const summary = computed(() => countByState(allRows.value));

/** 呈现档：表格（默认）↔ 泳道时间轴 ↔ 见底曲线。表格是逐包明细的权威面，
 *  时间轴补「哪几天集中掉」，见底曲线补「哪天腰斩、什么时候归零」——三者各答一个问题 */
const viewMode = ref<"table" | "lane" | "decay">("table");
// 喂给两档图形的都是表格正在显示的那一批行 ⇒ 渠道/状态筛选与历史档对三档同时生效，不会各说一套
const lanes = computed(() => buildExpiryLanes(rows.value, nowMs.value));
const decay = computed(() => buildDecaySeries(rows.value, nowMs.value));

function laneFace(l: ExpiryLane): string {
  // total = -1 是「上游不给总额」，编不出面值就不标；有面值才标，否则同名不同面值的两行分不开
  return l.total > 0 ? fmtBalance(l.total, l.channelId) : "";
}
function laneSum(l: ExpiryLane): string {
  return l.sum === null ? "含不限" : fmtBalance(l.sum, l.channelId);
}
/** 一个点并了同一天到期的多个包：不合并的话它们像素级重叠，下层的包连 tooltip 都悬不到 */
function dotTip(d: LaneDot): string {
  const head = d.count > 1 ? `${d.count} 个包同日到期 · ` : "";
  const body = d.unlimited ? "剩余不限" : `剩余 ${fmtBalance(d.sum || 0, d.rows[0].channelId)}`;
  const who = d.rows.slice(0, 4).map((r) => r.accountName).join("、") + (d.count > 4 ? ` 等 ${d.count} 个号` : "");
  const when = d.rows[0].pkg.expiresAt ? fmtDate(d.rows[0].pkg.expiresAt) : "长期有效";
  return `${head}${body} · ${when}（${daysText(d.rows[0].pkg)}）\n${who}`;
}
function dayPhrase(x: number | null, word: string): string {
  if (x === null) return "";
  if (x === LANE_FAR_X) return `${word}在 ${LANE_X_MAX} 天以后`;
  if (x < 0) return `已${word}`;
  if (x === 0) return `今天${word}`;
  return `${x} 天后${word}`;
}
/** 曲线下方那行字：把「今天还剩多少 / 哪天腰斩 / 哪天归零」直接算出来，比让人 hover 一个被拉伸的圆点有用。
 *  有长期有效的量时它永远归不了零，「见底」这一项就不该出现，改成如实标出地板。 */
function decayFoot(s: DecaySeries): string {
  if (s.unlimited) return "";
  const parts = [
    `今天剩 ${fmtBalance(s.atToday ?? 0, s.channelId)}`,
    dayPhrase(s.halfAt, "腰斩"),
    dayPhrase(s.zeroAt, "见底"),
    s.floor > 0 ? `其中 ${fmtBalance(s.floor, s.channelId)} 长期有效` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** 全部已过期条数（不随渠道筛选变）：按钮上的总数，也是历史档的分母 */
const historyCount = computed(() => applyExpiryFilter(allRows.value, { status: "all", channelId: "all", sort: "expiryAsc", history: true }, Date.now()).length);

/** 被「过期满 2 天」规则收起的条数：与「全部」档相减即得，所以判据只能是这一条规则在生效 */
const staleHidden = computed(() => allRows.value.length - applyExpiryFilter(allRows.value, { status: "all", channelId: "all", sort: "expiryAsc" }, Date.now()).length);

/** 空态文案：三档共用一份，别在各档各写一套口径 */
const emptyText = computed(() =>
  historyOpen.value
    ? "没有已过期记录"
    : summary.value.total
      ? "当前筛选条件下没有匹配的套餐/积分包"
      : "暂无套餐数据 —— 到「号池」页刷新生态渠道账号后，这里会列出各积分包 / Token 套餐的到期时间",
);

function daysText(pkg: ProxyCreditPackage): string {
  if (!pkg.expiresAt) return "长期";
  const gone = expiredDays(pkg, Date.now());
  if (gone >= 0) return gone === 0 ? "刚过期" : `过期 ${gone} 天`;
  return `剩 ${Math.max(1, Math.ceil((pkg.expiresAt - Date.now()) / 86400000))} 天`;
}
function statusCls(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "tag-err";
    case "soon":
      return "tag-warn";
    case "used":
      return "tag-dim";
    default:
      return "tag-ok";
  }
}
function statusText(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "已过期";
    case "soon":
      return "即将到期";
    case "used":
      return "已用完";
    default:
      return "生效中";
  }
}
function rowCls(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "row-expired";
    case "soon":
      return "row-soon";
    case "used":
      return "row-used";
    default:
      return "";
  }
}

onMounted(() => {
  refresh();
  // 主进程批量签到/额度刷新时逐账号广播 credits/status 事件，裸调 refresh 会打出 N 次
  // proxyPool IPC + N 次全表重渲染（号池页/总览页已同款合流，这里是第三处）
  scheduleRefresh = coalesceAsync(refresh, 1200);
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if ((p.type === "credits" || p.type === "status") && active.value) scheduleRefresh?.();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  scheduleRefresh?.cancel();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 渠道切换：顶部方块条（参考号池tab页），含「全部」及各生态渠道，可收起/展开 -->
      <div class="ch-switch">
        <div v-if="switcherCollapsed" class="ch-strip">
          <div class="ch-strip-list" aria-label="渠道切换">
            <el-tooltip :content="`全部渠道 · 共 ${summary.total} 个包`" placement="top" :show-after="140">
              <button
                class="ch-sq ch-sq-all"
                :class="{ active: channelFilter === 'all' }"
                :aria-pressed="channelFilter === 'all'"
                aria-label="全部渠道"
                @click="channelFilter = 'all'"
              >
                <span>全</span>
              </button>
            </el-tooltip>
            <el-tooltip
              v-for="ch in pool"
              :key="ch.id"
              :content="stripTip(ch)"
              placement="top"
              :show-after="140"
            >
              <button
                class="ch-sq"
                :class="{ active: channelFilter === ch.id }"
                :aria-pressed="channelFilter === ch.id"
                :aria-label="stripTip(ch)"
                @click="channelFilter = ch.id"
              >
                <img v-if="CHANNEL_ICONS[ch.id]" :src="CHANNEL_ICONS[ch.id]" alt="" />
                <b v-else>{{ channelInitial(ch.id, ch.display) }}</b>
              </button>
            </el-tooltip>
          </div>
          <el-tooltip content="展开全部渠道" placement="top" :show-after="140">
            <button class="ch-sq ch-sq-arrow" :disabled="!pool.length" aria-label="展开全部渠道" @click="switcherCollapsed = false">
              <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 9 L12 16 L19 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </el-tooltip>
        </div>
        <template v-else>
          <div class="channel-switch">
            <button
              class="channel-btn"
              :class="{ active: channelFilter === 'all' }"
              @click="channelFilter = 'all'"
            >
              <span class="ch-text">
                <span class="ch-name">全部渠道</span>
                <span class="ch-sub">共 {{ summary.total }} 个包</span>
              </span>
            </button>
            <button
              v-for="ch in pool"
              :key="ch.id"
              class="channel-btn"
              :class="{ active: channelFilter === ch.id }"
              @click="channelFilter = ch.id"
            >
              <span class="ch-text">
                <span class="ch-name">{{ ch.display }}</span>
                <span class="ch-sub">{{ getChannelPkgCount(ch.id) }} 个包</span>
              </span>
            </button>
          </div>
          <div class="ch-strip-foot">
            <el-tooltip content="收起渠道切换" placement="top" :show-after="140">
              <button class="ch-sq ch-sq-arrow" aria-label="收起渠道切换" @click="switcherCollapsed = true">
                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 16 L12 9 L19 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </el-tooltip>
          </div>
        </template>
      </div>

      <div v-if="err" class="expiry-err">{{ err }}</div>

      <!-- 顶部操作与筛选综合栏：小问号提示 + 汇总胶囊 + 筛选下拉 + 视图切换 + 刷新 -->
      <div class="expiry-toolbar">
        <div class="expiry-tools-left">
          <!-- 小问号说明：鼠标移上去显示原副标题文案 -->
          <el-tooltip
            content="所有渠道的积分包 / Token 套餐按到期时间升序（长期有效排最后）；预警阈值在「设置」里调整"
            placement="top"
          >
            <span class="info-help-btn" role="img" aria-label="帮助说明">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </span>
          </el-tooltip>

          <!-- 汇总胶囊 -->
          <div class="expiry-summary-tags">
            <span class="agg-tag tag-err" v-if="summary.expired">已过期 {{ summary.expired }}</span>
            <span class="agg-tag tag-warn" v-if="summary.soon">即将到期 {{ summary.soon }}</span>
            <span class="agg-tag tag-dim" v-if="summary.used">已用完 {{ summary.used }}</span>
            <span class="agg-tag tag-ok" v-if="summary.ok">生效中 {{ summary.ok }}</span>
          </div>

          <!-- 状态筛选 -->
          <span v-if="historyOpen" class="hist-chip">全部已过期积分包</span>
          <el-select v-else v-model="statusFilter" class="f-el-select" popper-class="glass-popper" style="width: 108px">
            <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>

          <!-- 排序 -->
          <el-select v-model="sortKey" class="f-el-select" popper-class="glass-popper" style="width: 135px">
            <el-option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>

          <button v-if="historyCount" class="btn btn-sm" :class="{ 'btn-primary': historyOpen }" @click="historyOpen = !historyOpen">
            {{ historyOpen ? "返回日历" : "历史过期积分" }}
          </button>

          <span class="expiry-count">显示 {{ rows.length }} / {{ historyOpen ? historyCount : summary.total }} 条</span>
          <span v-if="staleHidden && !historyOpen" class="expiry-count">已过期满 {{ STALE_EXPIRED_DAYS }} 天的 {{ staleHidden }} 条已收起</span>
        </div>

        <div class="expiry-tools-right">
          <!-- 呈现模式切换 -->
          <div class="expiry-view-switch">
            <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'table' }" :aria-pressed="viewMode === 'table'" @click="viewMode = 'table'">表格</button>
            <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'lane' }" :aria-pressed="viewMode === 'lane'" @click="viewMode = 'lane'">时间轴</button>
            <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'decay' }" :aria-pressed="viewMode === 'decay'" @click="viewMode = 'decay'">见底曲线</button>
          </div>

          <button class="btn btn-sm" :disabled="loading" @click="refresh">
            <svg v-if="loading" class="spin-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4m0 12v4m-10-10h4m12 0h4m-2.93-7.07l-2.83 2.83m-8.48 8.48l-2.83 2.83m0-14.14l2.83 2.83m8.48 8.48l2.83 2.83"/></svg>
            {{ loading ? "刷新中…" : "刷新" }}
          </button>
        </div>
      </div>

      <div v-if="viewMode === 'lane'" class="lane-wrap">
        <div class="lane-legend">
          <span class="lane-lg"><i class="lane-dot lane-dot-expired is-key"></i>已过期</span>
          <span class="lane-lg"><i class="lane-dot lane-dot-soon is-key"></i>即将到期</span>
          <span class="lane-lg"><i class="lane-dot lane-dot-used is-key"></i>已用完</span>
          <span class="lane-lg"><i class="lane-dot lane-dot-ok is-key"></i>生效中</span>
          <span class="lane-hint">一个点 = 当天到期的一批包（外圈 = 多个）· 方点 = 含「不限」· 行 = 渠道 × 包名 · 点大小 = 剩余量 · 单位：天</span>
        </div>
        <div class="lane-row lane-row-axis">
          <div class="lane-label"></div>
          <div class="lane-track">
            <i class="lane-far" :style="{ left: lanePct(LANE_X_MAX) + '%' }"></i>
            <i class="lane-today" :style="{ left: lanePct(0) + '%' }"></i>
            <span v-for="t in LANE_TICKS" :key="t.x" class="lane-tick" :class="{ 'is-today': t.today }" :style="{ left: lanePct(t.x) + '%' }">{{ t.label }}</span>
          </div>
        </div>
        <div v-for="l in lanes" :key="l.key" class="lane-row">
          <!-- 提示只挂在标签上：挂整行会让「悬停某个点」同时弹出行提示与点提示两个浮层 -->
          <el-tooltip :content="l.channelDisplay + ' · ' + l.pkgName" placement="top">
            <div class="lane-label">
              <span class="lane-top"
                ><span class="lane-ch">{{ l.channelDisplay }}</span>{{ l.pkgName }}<template v-if="laneFace(l)"> · {{ laneFace(l) }}</template></span
              >
              <span class="lane-meta"
                >×{{ l.pkgCount }} · {{ laneSum(l) }}<template v-if="l.maxCount > 1"> · 一天最多 {{ l.maxCount }}</template></span
              >
            </div>
          </el-tooltip>
          <div class="lane-track">
            <i class="lane-far" :style="{ left: lanePct(LANE_X_MAX) + '%' }"></i>
            <i class="lane-today" :style="{ left: lanePct(0) + '%' }"></i>
            <el-tooltip v-for="d in l.dots" :key="d.x" :content="dotTip(d)" placement="top">
              <i
                class="lane-dot"
                :class="'lane-dot-' + d.state + (d.unlimited ? ' is-unlimited' : '') + (d.count > 1 ? ' is-cluster' : '')"
                :style="{ left: lanePct(d.x) + '%', width: d.size + 'px', height: d.size + 'px' }"
              ></i>
            </el-tooltip>
          </div>
        </div>
        <div v-if="!lanes.length" class="lane-empty">{{ emptyText }}</div>
      </div>

      <div v-else-if="viewMode === 'decay'" class="decay-wrap">
        <div class="lane-legend">
          <span class="lane-hint">x = 距今天数（与时间轴同窗口，右端灰带是 {{ LANE_X_MAX }} 天以后）· y = 那天之后这个渠道还剩多少 · <b>各渠道单位不同，每格一根自己的尺，别横着比高低</b></span>
        </div>
        <div class="decay-grid">
          <div v-for="s in decay" :key="s.channelId" class="decay-cell">
            <div class="decay-head">
              <span class="decay-name">{{ s.display }}</span>
              <span class="decay-total">{{ s.unlimited ? "含不限" : fmtBalance(s.total || 0, s.channelId) }}</span>
              <span class="decay-count">{{ s.count }} 个包</span>
            </div>
            <!-- 没有 y 轴刻度：数值已经在下面那行字里给全了，摆刻度只会和邻居的尺混淆 -->
            <!-- viewBox 是 0~100 的用户单位，所以这里要的是百分比刻度（lanePct）而不是归一值：
                 塞 nx 会把「今天」线画到 0.26% 的位置上，整条参考线贴死在左边缘 -->
            <svg v-if="!s.unlimited" class="decay-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <rect class="decay-far" :x="lanePct(LANE_X_MAX)" y="0" :width="100 - lanePct(LANE_X_MAX)" height="100" />
              <path class="decay-area" :d="decayAreaPath(s)" />
              <path class="decay-line" :d="decayPath(s)" vector-effect="non-scaling-stroke" />
              <line class="decay-today" :x1="lanePct(0)" :x2="lanePct(0)" y1="0" y2="100" vector-effect="non-scaling-stroke" />
            </svg>
            <div v-else class="decay-flat">含「不限」额度，剩余量加不出总数，所以不画曲线</div>
            <div class="decay-foot">{{ decayFoot(s) }}</div>
          </div>
        </div>
        <div v-if="!decay.length" class="lane-empty">{{ emptyText }}</div>
      </div>

      <div v-else class="tbl-wrap">
        <table class="tbl expiry-tbl">
          <tbody>
            <tr>
              <th>渠道 · 账号</th><th>包名</th><th class="num">剩余 / 总额</th><th>到期</th><th class="num">剩余天数</th><th>状态</th>
            </tr>
            <tr v-for="r in rows" :key="r.key" :class="rowCls(r.pkg)">
              <td>
                <div class="src-ch">{{ r.channelDisplay }}</div>
                <div class="src-acc">{{ r.accountName }}</div>
              </td>
              <el-tooltip :content="r.pkg.name" :disabled="!r.pkg.name" placement="top">
                <td>{{ r.pkg.name || pkgFallbackName(r.channelId) }}</td>
              </el-tooltip>
              <!-- 逐行带单位：Token 渠道（zcode 家）过 fmtToken 换算，积分渠道原值；
                   「/ —」是上游不给总额（账号级聚合行等），与「不限」哨兵不是一回事 -->
              <td class="mono num">{{ fmtBalancePair(r.pkg.remaining, r.pkg.total, r.channelId) }}</td>
              <td class="mono">{{ r.pkg.expiresAt ? fmtDate(r.pkg.expiresAt) : "长期" }}</td>
              <td class="mono num">{{ daysText(r.pkg) }}</td>
              <td><span class="tag" :class="statusCls(r.pkg)">{{ statusText(r.pkg) }}</span></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6" style="text-align: center; color: var(--text-3); padding: 18px">{{ emptyText }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ===== 渠道切换容器：参考号池页风格 ===== */
.ch-switch {
  --ch-card-h: 56px;
  --ch-strip-h: 38px;
  --ch-sq: 28px;
  min-width: 0;
  margin-bottom: 12px;
}
.ch-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--ch-strip-h);
  min-width: 0;
}
.ch-strip-list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ch-strip-list::-webkit-scrollbar {
  display: none;
}
.ch-sq {
  flex-shrink: 0;
  width: var(--ch-sq);
  height: var(--ch-sq);
  padding: 0;
  border-radius: var(--r-sm, 6px);
  border: 1px solid var(--line-strong, rgba(255, 255, 255, 0.12));
  background: var(--bg-card, rgba(255, 255, 255, 0.04));
  color: var(--text-2, rgba(255, 255, 255, 0.7));
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: transform 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}
.ch-sq:hover {
  border-color: var(--line-stronger, rgba(255, 255, 255, 0.25));
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--text, #fff);
  transform: translateY(-1px);
}
.ch-sq.active {
  border-color: var(--accent-line, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.15));
  color: var(--accent-strong, #38bdf8);
  box-shadow: 0 0 10px -2px var(--accent-dim, rgba(56, 189, 248, 0.3));
}
.ch-sq img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  display: block;
}
.ch-sq b {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.ch-sq-all span {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.ch-sq-arrow {
  color: var(--text-3, rgba(255, 255, 255, 0.45));
}
.ch-sq-arrow:hover {
  color: var(--text, #fff);
}

.channel-switch {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 6px;
}
.channel-btn {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  min-height: var(--ch-card-h);
  border-radius: var(--r-sm, 6px);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  background: var(--bg-card, rgba(255, 255, 255, 0.03));
  color: var(--text-2, rgba(255, 255, 255, 0.7));
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
}
.channel-btn:hover {
  border-color: var(--line-strong, rgba(255, 255, 255, 0.25));
  background: var(--bg-hover, rgba(255, 255, 255, 0.07));
  color: var(--text, #fff);
  transform: translateY(-1px);
}
.channel-btn.active {
  border-color: var(--accent-line, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.15));
  color: var(--text, #fff);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 18px -8px var(--accent-line, #38bdf8);
}
.ch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ch-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-sub {
  font-size: 11px;
  color: var(--text-3, rgba(255, 255, 255, 0.45));
}
.channel-btn.active .ch-sub {
  color: var(--accent-strong, #38bdf8);
}
.ch-strip-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

/* ===== 顶部综合操作栏 ===== */
.expiry-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.expiry-tools-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.expiry-tools-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.info-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-3, rgba(255, 255, 255, 0.5));
  background: var(--bg-soft, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  cursor: help;
  transition: all 0.18s ease;
  flex-shrink: 0;
}
.info-help-btn:hover {
  color: var(--accent, #38bdf8);
  border-color: var(--accent-line, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
}
.expiry-summary-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.expiry-view-switch {
  display: inline-flex;
  gap: 4px;
}
.spin-icon {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.expiry-count {
  font-size: 12px;
  color: var(--text-3);
}
/* 历史档顶替 status 下拉的标签：与 .f-el-select .el-select__wrapper 同一套盒子，
   切档时筛选行不跳位 */
.hist-chip {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-3);
  background: var(--bg-soft);
  border-radius: var(--r-sm);
  box-shadow: 0 0 0 1px var(--line-strong) inset;
}
.agg-tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}
.expiry-err {
  color: var(--danger, #e5484d);
  font-size: 13px;
  margin-bottom: 8px;
}
.expiry-tbl {
  width: 100%;
  border-collapse: collapse;
}
.expiry-tbl th {
  text-align: left;
  font-weight: 500;
  color: var(--text-3);
  padding: 6px 10px;
  font-size: 12px;
}
.expiry-tbl td {
  padding: 6px 10px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.15));
  font-size: 13px;
}
.expiry-tbl td.num {
  text-align: right;
}
/* 数值列表头与 td.num 同侧（全站对齐规范）。必须写在本组件里：scoped 的
   .expiry-tbl th[data-v] 特异性高于全局 th.num，不补这条表头会被压回左对齐 */
.expiry-tbl th.num {
  text-align: right;
}
.src-ch {
  font-size: 12px;
  color: var(--text-3);
}
.src-acc {
  font-weight: 500;
}
.row-expired {
  background: var(--danger-bg, rgba(229, 72, 77, 0.08));
}
.row-soon {
  background: var(--warn-bg, rgba(245, 176, 65, 0.08));
}
.row-used {
  background: rgba(127, 127, 127, 0.06);
}

/* ===== 时间轴档（纯 DOM：不引 echarts 新注册，与 sync/Heatmap.vue 同路子） ===== */
.expiry-view-switch {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.lane-wrap {
  padding-bottom: 8px;
}
.lane-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.lane-lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lane-hint {
  font-size: 11px;
}
.lane-row {
  display: flex;
  align-items: center;
  min-height: 32px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.15));
}
.lane-row-axis {
  border-top: 0;
  min-height: 20px;
}
.lane-label {
  flex: 0 0 300px;
  min-width: 0;
  padding-right: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  line-height: 1.35;
}
.lane-ch {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane-top {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane-top .lane-ch {
  margin-right: 5px;
}
.lane-meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane-track {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  align-self: stretch;
}
.lane-far {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: var(--border-soft);
  border-left: 1px dashed var(--line-strong, rgba(127, 127, 127, 0.3));
}
.lane-today {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line-strong, rgba(127, 127, 127, 0.35));
}
.lane-tick {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
}
.lane-tick.is-today {
  color: var(--text-2, var(--text-3));
  font-weight: 600;
}
.lane-dot {
  border-radius: 50%;
  opacity: 0.85;
}
.lane-track .lane-dot {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
}
.lane-dot.is-key {
  width: 9px;
  height: 9px;
}
/* 并了多个包的点：外圈实线。用 outline 是因为它不改盒子尺寸——
   点大小那把尺一旦被边框污染，「大小 = 剩余量」就不成立了。
   数字不放点上：10px/天的轴位装不下 14px 宽的角标，密集行会连成 ×2×2×2 一串（实测 54 个角标撞 31 对）。 */
.lane-dot.is-cluster {
  outline: 1.5px solid var(--text-3);
  outline-offset: 2px;
}
.lane-dot-expired {
  background: var(--danger);
}
.lane-dot-soon {
  background: var(--warn);
}
.lane-dot-used {
  background: var(--text-3);
}
.lane-dot-ok {
  background: var(--accent-strong);
}
/* 「不限」不是一个可比较的数值：虚线描边把它和真实余额的点区分开 */
.lane-dot.is-unlimited {
  opacity: 1;
  /* 方点而不是虚线环：并包的标记已经占了 outline，一个点完全可以既含「不限」又并了包，
     两个标记不能抢同一个属性，否则后写的规则会静默吃掉前一个 */
  border-radius: 3px;
}
.lane-empty {
  text-align: center;
  color: var(--text-3);
  padding: 18px;
  font-size: 13px;
}

/* ===== 见底曲线档（内联 SVG，同样不碰 echarts） ===== */
.decay-wrap {
  padding-bottom: 8px;
}
.decay-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
}
.decay-cell {
  border: 1px solid var(--border, rgba(127, 127, 127, 0.15));
  border-radius: var(--r-md, 10px);
  padding: 8px 10px 6px;
  min-width: 0;
}
.decay-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
}
.decay-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.decay-total {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--accent-strong);
  white-space: nowrap;
}
.decay-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}
.decay-svg {
  display: block;
  width: 100%;
  height: 92px;
}
.decay-far {
  fill: var(--border-soft);
}
.decay-today {
  stroke: var(--line-strong, rgba(127, 127, 127, 0.35));
  stroke-width: 1;
}
.decay-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.decay-area {
  fill: var(--accent);
  opacity: 0.12;
  stroke: none;
}
.decay-foot {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.decay-flat {
  height: 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-3);
  border: 1px dashed var(--line-strong, rgba(127, 127, 127, 0.3));
  border-radius: var(--r-sm, 8px);
  padding: 0 8px;
}
</style>
