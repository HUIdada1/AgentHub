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
      <div class="expiry-head">
        <div class="expiry-title">
          <h2>积分日历</h2>
          <span class="hint">所有渠道的积分包 / Token 套餐按到期时间升序（长期有效排最后）；预警阈值在「设置」里调整</span>
        </div>
        <div class="expiry-actions">
          <span class="agg-tag tag-err" v-if="summary.expired">已过期 {{ summary.expired }}</span>
          <span class="agg-tag tag-warn" v-if="summary.soon">即将到期 {{ summary.soon }}</span>
          <span class="agg-tag tag-dim" v-if="summary.used">已用完 {{ summary.used }}</span>
          <span class="agg-tag tag-ok" v-if="summary.ok">生效中 {{ summary.ok }}</span>
          <button v-if="historyCount" class="btn btn-sm" :class="{ 'btn-primary': historyOpen }" @click="historyOpen = !historyOpen">
            {{ historyOpen ? "返回日历" : "历史过期积分" }}
          </button>
          <button class="btn btn-sm" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
        </div>
      </div>

      <div v-if="err" class="expiry-err">{{ err }}</div>

      <div class="expiry-filters">
        <!-- 历史档只看已过期，status 维度对它没有意义；与其摆一个点不动的下拉，不如换成说明性标签 -->
        <span v-if="historyOpen" class="hist-chip">全部已过期积分包</span>
        <el-select v-else v-model="statusFilter" class="f-el-select" popper-class="glass-popper" style="width: 118px">
          <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="channelFilter" class="f-el-select" popper-class="glass-popper" style="width: 170px">
          <el-option value="all" label="全部渠道" />
          <el-option v-for="o in channelOptions" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="sortKey" class="f-el-select" popper-class="glass-popper" style="width: 140px">
          <el-option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <span class="expiry-count">显示 {{ rows.length }} / {{ historyOpen ? historyCount : summary.total }} 条</span>
        <span v-if="staleHidden && !historyOpen" class="expiry-count">已过期满 {{ STALE_EXPIRED_DAYS }} 天的 {{ staleHidden }} 条已收起</span>
        <div class="expiry-view-switch">
          <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'table' }" :aria-pressed="viewMode === 'table'" @click="viewMode = 'table'">表格</button>
          <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'lane' }" :aria-pressed="viewMode === 'lane'" @click="viewMode = 'lane'">时间轴</button>
          <button class="btn btn-sm" :class="{ 'btn-primary': viewMode === 'decay' }" :aria-pressed="viewMode === 'decay'" @click="viewMode = 'decay'">见底曲线</button>
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
.expiry-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
}
.expiry-title {
  flex: 1 1 auto;
  min-width: 0;
}
.expiry-title h2 {
  margin: 0 0 2px;
  font-size: 16px;
}
.expiry-title .hint {
  font-size: 12px;
  color: var(--text-3);
}
.expiry-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.expiry-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
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
