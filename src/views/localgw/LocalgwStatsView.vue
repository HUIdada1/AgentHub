<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
      此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 用量统计：页面形式照搬 fdb3e55^ 的旧版反代网关 ProxyStatsView
     （sticky 筛选栏 → kpis-6 → 趋势 → 双环 → TOP 排行 → 明细分页 → 清理弹窗），
     底层数据换成现在的实现：localgw_stats_overview / _detail / _cleanup
     （后端 electron/backend/localgw/stats.cjs，只读 localgw_logs 一张表现算聚合，不落第二份统计）。

     两个口径差异必须写在最前面，否则一定会有人「顺手对齐」而算错一倍：
       · kpis.successRate 是 **0~100 的百分数**（与 localgw_status.errRate 的 0~1 不同），展示前不要再 ×100；
       · 每个维度桶（trend / byChannel / byModel / byStatus）只有 { key, req, tokens, err } 四个字段，
         没有请求/响应 Token 拆分、也没有分位延迟——旧版 TOP 表的「请求 Tok / 响应 Tok / 平均 TTFT」
         在现契约里不存在，这里**不摆空列**，只展示真有数据的列（区间级的拆分放在卡片标题右侧）。

     图表（趋势折线 / 双环）全部手写：旧版的 StatsTrendChart / StatsDonutChart 已随 fdb3e55 删除，
     而项目没有任何图表库，为两张小图引一个新依赖不划算 —— 趋势用内联 SVG，环图用 CSS conic-gradient。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import {
  localgwStatsCleanup,
  localgwStatsDetail,
  localgwStatsOverview,
  onUpdateEvent,
  type LocalgwLogRow,
  type LocalgwStatsBucket,
  type LocalgwStatsOverview,
  type LocalgwStatsRange,
} from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { coalesceAsync } from "../../utils/timing";
import { toast as ElMessage } from "../../utils/toast";
// 六张 KPI 卡与总览页共用同一个组件：口径与版式只有一份，两页数字不会漂
import UsageKpiGrid from "../../components/localgw/UsageKpiGrid.vue";
// 格式化与号池管家同源（渠道中文名 / 千分位 / 大数缩写 / 毫秒 / 时间）：本地网关再抄一份必然走形
import { channelName, fmtDate, fmtInt, fmtK, fmtMs, fmtTime } from "../proxy/format";

const app = useAppStore();
const lgw = useLocalgwStore();

// ===== 时间区间 =====
/** 档位与后端 LocalgwStatsRange 一一对应（后端只认 today / 7d / 30d / custom，没有 90d 档） */
const PRESETS: { key: LocalgwStatsRange; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "custom", label: "自定义" },
];

const DAY_MS = 86400000;
const preset = ref<LocalgwStatsRange>("7d");
const customRange = ref<[string, string] | null>(null);
// 响应式时间锚：Date.now() 不是响应式依赖，直接在 range 里取会让区间冻结在页面挂载那一刻——
// 「今天」档的 to 停在挂载时刻，之后的新请求 ts > to 永远查不到（点刷新也没用）。
// 每次刷新前先推进 nowTick，让区间跟着当下时刻走。
const nowTick = ref(Date.now());

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dateInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地区间（毫秒闭区间）：只用于「自定义」档的 from/to 与首屏未回显时的日期文案。
 *  预置档（今天/7 天/30 天）不把 from/to 发给后端——后端 resolveRange 是同一套日历口径，
 *  前端再算一遍只会多一处可能漂移的地方（夏令时按天推步进那种坑，后端已经处理过了）。 */
const range = computed<{ from: number; to: number }>(() => {
  const now = nowTick.value;
  if (preset.value === "custom") {
    const c = customRange.value;
    if (c && c[0] && c[1]) {
      const f = new Date(`${c[0]}T00:00:00`).getTime();
      const t = new Date(`${c[1]}T23:59:59.999`).getTime();
      return { from: Math.min(f, t), to: Math.max(f, t) };
    }
    return { from: dayStart(now) - 6 * DAY_MS, to: now };
  }
  const days = preset.value === "today" ? 1 : preset.value === "7d" ? 7 : 30;
  const from = dayStart(now) - (days - 1) * DAY_MS;
  // 「今天」档到此刻为止；其余档到今天 23:59:59.999（含当天全部流水）
  const to = days === 1 ? now : dayStart(now) + DAY_MS - 1;
  return { from, to };
});

function pickPreset(p: LocalgwStatsRange) {
  // 首次切到自定义时给个「近 7 天」的初值：选择器空着既看不清当前区间，也会走到
  // 「custom 缺 from/to → 后端回落 today」那条分支（显示与档位对不上）
  if (p === "custom" && !customRange.value) {
    const now = Date.now();
    customRange.value = [dateInput(dayStart(now) - 6 * DAY_MS), dateInput(now)];
  }
  preset.value = p;
}
function pickCustomRange(v: [string, string] | null) {
  if (v && v[0] && v[1]) {
    customRange.value = v;
    preset.value = "custom";
  }
}

/** 请求入参：预置档只发 range（后端按档位算起止），自定义档才带 from/to */
function rangeArgs(): { range: LocalgwStatsRange; from?: number; to?: number } {
  if (preset.value !== "custom") return { range: preset.value };
  const r = range.value;
  return { range: "custom", from: r.from, to: r.to };
}

// ===== 数据 =====
const ov = ref<LocalgwStatsOverview | null>(null);
const detail = ref<{ rows: LocalgwLogRow[]; total: number } | null>(null);
const err = ref("");
const page = ref(1);
/** 一页 15 条（与旧版一致）：明细只是「抽样看几条」，真要看全量该去请求日志页 */
const PAGE_SIZE = 15;
const filters = reactive({ model: "", channel: "", status: "", keyPrefix: "" });

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e || "");
  return m || "用量统计加载失败";
}

/** 区间文案：优先用后端回显的 from/to（它就是这次数据的真实区间），首屏未回显时才本地推算 */
const rangeLabel = computed(() => {
  const f = ov.value?.from ?? range.value.from;
  const t = ov.value?.to ?? range.value.to;
  const fs = dateInput(f);
  const ts = dateInput(t);
  return fs === ts ? fs : `${fs} ~ ${ts}`;
});

// ===== KPI =====
// 这里只负责「取到 kpis」，六张卡的数值 / 副信息 / 悬停说明全部交给 UsageKpiGrid：
// 失败数反推、输入输出占比这些口径再在本页写一份，就一定会和总览页漂
const k = computed(() => ov.value?.kpis ?? null);

// ===== 趋势图（手写内联 SVG）=====
type TrendMetric = "req" | "tokens" | "err";
const METRICS: { key: TrendMetric; label: string }[] = [
  { key: "req", label: "请求" },
  { key: "tokens", label: "Token" },
  { key: "err", label: "失败" },
];
const metric = ref<TrendMetric>("req");

const trend = computed<LocalgwStatsBucket[]>(() => ov.value?.trend ?? []);

/** 粒度推断：契约里没有 granularity 字段（旧版有），从相邻桶的间隔反推——
 *  后端只在 today 档或跨度 ≤2 天时按小时铺桶，间隔 ≤2h 即小时，否则按天。
 *  不按 range 硬编：custom 选两天时后端也会走小时桶，硬编会让横轴标签全错。 */
const granularity = computed<"hour" | "day">(() => {
  const t = trend.value;
  if (t.length < 2) return ov.value?.range === "today" ? "hour" : "day";
  const step = Number(t[1].key) - Number(t[0].key);
  return step > 0 && step <= 2 * 3600000 ? "hour" : "day";
});

function bucketLabel(key: string | number): string {
  const d = new Date(Number(key) || 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return granularity.value === "hour" ? `${p(d.getHours())}:00` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 轴上限取整到 1/2/5×10^n：不取整会出现 "上限 137" 这种没法读的刻度 */
function niceCeil(v: number): number {
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** 刻度文案：千位以上走 K 缩写，小数值保留一位（上限 5 时的中线是 2.5，
 *  直接过 fmtK 会被四舍五入成 "3"，与网格线所在的高度对不上） */
function axisLabel(v: number): string {
  if (v === 0) return "0";
  if (v >= 1000) return fmtK(v);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

const CHART_W = 720;
const CHART_H = 200;
const PAD_T = 14;
const PAD_B = 26;
const PAD_L = 46;
const PAD_R = 14;

/** 折线几何：viewBox 固定 720×200，容器宽度自适应（宽高比固定，文字与圆点不会被拉伸变形） */
const chart = computed(() => {
  const t = trend.value;
  const vals = t.map((b) => Number(b[metric.value]) || 0);
  const n = vals.length;
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const max = niceCeil(Math.max(...vals, 1));
  const xAt = (i: number) => (n <= 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW);
  const yAt = (v: number) => PAD_T + (1 - v / max) * innerH;
  const pts = vals.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
  const baseY = (CHART_H - PAD_B).toFixed(1);
  const line = pts.join(" ");
  // 只有一个桶时构不成折线（也构不成面积）：v-if 会退化成画一个点，
  // 这里必须回空串——否则拼出 "L  L" 这种非法路径段，浏览器控制台会报解析错误
  const area = n > 1 ? `M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${xAt(n - 1).toFixed(1)},${baseY} L ${xAt(0).toFixed(1)},${baseY} Z` : "";
  // 悬停热区：每个桶一块等宽透明矩形，内嵌 <title> 用浏览器原生 tooltip（不引组件、不写定位逻辑）
  const bandW = n ? innerW / n : innerW;
  const bands = t.map((b, i) => ({
    x: (PAD_L + i * bandW).toFixed(1),
    w: bandW.toFixed(1),
    title: `${bucketLabel(b.key)} · 请求 ${fmtInt(Number(b.req) || 0)} · Token ${fmtInt(Number(b.tokens) || 0)} · 失败 ${fmtInt(Number(b.err) || 0)}`,
  }));
  const ticks = [0, 0.5, 1].map((f) => ({ y: (PAD_T + (1 - f) * innerH).toFixed(1), label: axisLabel(max * f) }));
  return {
    n,
    line,
    area,
    bands,
    ticks,
    xAt,
    single: { x: xAt(0).toFixed(1), y: yAt(vals[0] ?? 0).toFixed(1) },
  };
});

/** 横轴只标首/中/末三处：桶多时（30 天=30 个）全标必然糊成一团 */
const xLabels = computed(() => {
  const t = trend.value;
  if (!t.length) return [];
  const idx = t.length <= 3 ? t.map((_, i) => i) : [0, Math.floor((t.length - 1) / 2), t.length - 1];
  return idx.map((i) => ({ x: chart.value.xAt(i).toFixed(1), label: bucketLabel(t[i].key) }));
});

// ===== 双环图（CSS conic-gradient）=====
type DonutSeg = { label: string; value: number; color: string; req: number; tokens: number; err: number; pct: number };

/** 渠道环图配色：主题变量轮转，多出来的尾巴合并成「其他」——
 *  渠道可能十几家，每段都配色既分不清也看不清，超过 5 段人眼就没法对应图例了 */
const CHANNEL_PALETTE = ["var(--accent)", "var(--info)", "var(--warn)", "var(--accent-strong)", "var(--danger)"];

function withPct(segs: Omit<DonutSeg, "pct">[]): DonutSeg[] {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  return segs.map((s) => ({ ...s, pct: Math.round((s.value / total) * 1000) / 10 }));
}

const channelSegs = computed<DonutSeg[]>(() => {
  const list = (ov.value?.byChannel || [])
    .map((b) => ({ key: String(b.key ?? ""), req: Number(b.req) || 0, tokens: Number(b.tokens) || 0, err: Number(b.err) || 0 }))
    .filter((b) => b.req > 0)
    .sort((a, b) => b.req - a.req);
  const head = list.slice(0, CHANNEL_PALETTE.length);
  const tail = list.slice(CHANNEL_PALETTE.length);
  const segs: Omit<DonutSeg, "pct">[] = head.map((b, i) => ({
    label: channelName(b.key),
    value: b.req,
    color: CHANNEL_PALETTE[i],
    req: b.req,
    tokens: b.tokens,
    err: b.err,
  }));
  if (tail.length) {
    segs.push({
      label: `其他 ${tail.length} 家`,
      value: tail.reduce((s, b) => s + b.req, 0),
      color: "var(--text-3)",
      req: tail.reduce((s, b) => s + b.req, 0),
      tokens: tail.reduce((s, b) => s + b.tokens, 0),
      err: tail.reduce((s, b) => s + b.err, 0),
    });
  }
  return withPct(segs);
});

/** 状态环图：顺序与配色写死（成功=主色 / 失败=危险 / 取消=警告），
 *  不按请求数排序——状态色一变，「绿=成功」的直觉就没了 */
const STATUS_META: { key: string; label: string; color: string }[] = [
  { key: "success", label: "成功", color: "var(--accent)" },
  { key: "error", label: "失败", color: "var(--danger)" },
  { key: "cancelled", label: "取消", color: "var(--warn)" },
];
const statusSegs = computed<DonutSeg[]>(() => {
  const list = ov.value?.byStatus || [];
  const segs = STATUS_META.map((m) => {
    const b = list.find((x) => String(x.key) === m.key);
    const req = Number(b?.req) || 0;
    return { label: m.label, value: req, color: m.color, req, tokens: Number(b?.tokens) || 0, err: Number(b?.err) || 0 };
  }).filter((s) => s.value > 0);
  return withPct(segs);
});

/** conic-gradient 字符串：无数据时给一圈底色（灰环），不留白洞 */
function conic(segs: DonutSeg[]): string {
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) return "conic-gradient(var(--line) 0deg 360deg)";
  let acc = 0;
  const parts = segs.map((s) => {
    const from = (acc / total) * 360;
    acc += s.value;
    const to = (acc / total) * 360;
    return `${s.color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`;
  });
  return `conic-gradient(${parts.join(", ")})`;
}

// ===== TOP 排行（byModel 前 8）=====
const topBy = ref<"req" | "tokens">("req");
/** 成功率：桶里只有 req/err，按 (req-err)/req 现算（与后端 err 互补口径一致） */
const bucketRate = (b: LocalgwStatsBucket) => {
  const req = Number(b.req) || 0;
  if (!req) return 0;
  return Math.round(((req - (Number(b.err) || 0)) / req) * 1000) / 10;
};
const rateCls = (r: number) => (r < 95 ? "rate-bad" : r < 99 ? "rate-warn" : "");

const topRows = computed(() => {
  const list = (ov.value?.byModel || []).filter((b) => (Number(b.req) || 0) > 0 || (Number(b.tokens) || 0) > 0);
  const key = topBy.value;
  list.sort((a, b) => (key === "tokens" ? (Number(b.tokens) || 0) - (Number(a.tokens) || 0) : (Number(b.req) || 0) - (Number(a.req) || 0)));
  const rows = list.slice(0, 8);
  const total = rows.reduce((s, b) => s + (key === "tokens" ? Number(b.tokens) || 0 : Number(b.req) || 0), 0) || 1;
  return rows.map((b) => {
    const req = Number(b.req) || 0;
    const tokens = Number(b.tokens) || 0;
    const err = Number(b.err) || 0;
    return {
      key: String(b.key || "（未命名）"),
      req,
      tokens,
      err,
      successRate: bucketRate(b),
      pct: Math.round(((key === "tokens" ? tokens : req) / total) * 1000) / 10,
    };
  });
});

// ===== 明细 =====
const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / PAGE_SIZE)));

/** 本页小计：契约的明细接口只回 { rows, total }（旧版有 agg），
 *  所以这里如实标成「本页」——把它写成区间合计就是在撒谎 */
const pageAgg = computed(() => {
  const rows = detail.value?.rows || [];
  const pt = rows.reduce((s, r) => s + (Number(r.promptTokens) || 0), 0);
  const ct = rows.reduce((s, r) => s + (Number(r.completionTokens) || 0), 0);
  return { n: rows.length, pt, ct, tokens: pt + ct };
});

const STATUS_TEXT: Record<string, string> = { success: "成功", error: "失败", cancelled: "取消" };
const statusText = (s: string) => STATUS_TEXT[s] || s || "-";
const statusTagCls = (s: string) => (s === "success" ? "tag-ok" : s === "error" ? "tag-err" : "tag-dim");

/** 渠道下拉：以本次区间的 byChannel 为底（有请求的渠道优先），再并入号池已知渠道
 *  （否则筛选器会随区间变化而收缩，用户没法切到「这段时间没请求」的渠道） */
const channelOptions = computed(() => {
  const ids = new Set<string>();
  for (const b of ov.value?.byChannel || []) if (b.key) ids.add(String(b.key));
  for (const c of lgw.channels) if (c.id) ids.add(c.id);
  for (const c of lgw.allChannels) if (c.id) ids.add(c.id);
  return [...ids].map((id) => ({ id, label: channelName(id) }));
});

// ===== 取数 =====
async function refresh() {
  try {
    ov.value = await localgwStatsOverview(rangeArgs());
    err.value = "";
  } catch (e) {
    err.value = errText(e);
  }
}

async function loadDetail() {
  try {
    detail.value = await localgwStatsDetail({
      ...rangeArgs(),
      // model / channel / status 后端一律**精确匹配**（不是 LIKE）：把「选 gpt-4o」写成模糊
      // 会把 gpt-4o-mini 也带进来，而表头写的是具体模型名；keyPrefix 例外，它的语义就是前缀
      model: filters.model.trim() || undefined,
      channel: filters.channel || undefined,
      status: filters.status || undefined,
      keyPrefix: filters.keyPrefix.trim() || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    err.value = "";
  } catch (e) {
    err.value = errText(e);
  }
}

async function reload() {
  nowTick.value = Date.now(); // 先推进时间锚再取数：手动刷新要看到「此刻」为止的数据
  await Promise.all([refresh(), loadDetail()]);
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

// ===== 明细筛选 =====
function applyFilter() {
  page.value = 1;
  loadDetail();
}
function resetFilters() {
  filters.model = "";
  filters.channel = "";
  filters.status = "";
  filters.keyPrefix = "";
  applyFilter();
}

// ===== 清理流水：范围二选一（仅超期=按保留期删旧 / 全部=清空整表），不可恢复所以先问一道 =====
const cleanOpen = ref(false);
const cleanScope = ref<"expired" | "all">("expired");
const cleaning = ref(false);
/** 保留期读设置页的当前值：与后端 cleanup("expired") 实际用的 logRetentionDays 同源 */
const retentionDays = computed(() => Number(app.config.localgw?.logRetentionDays) || 30);

function openClean() {
  cleanScope.value = "expired"; // 每次打开回默认档，防上次选的「全部」被顺手确认
  cleanOpen.value = true;
}
async function doCleanup() {
  cleaning.value = true;
  try {
    const mode = cleanScope.value;
    const r = await localgwStatsCleanup(mode);
    ElMessage.success(
      mode === "all"
        ? `已清空全部流水 ${fmtInt(r.deleted)} 条`
        : `已清理保留期（${retentionDays.value} 天）之前的流水 ${fmtInt(r.deleted)} 条`,
    );
    cleanOpen.value = false;
    page.value = 1;
    await reload();
  } catch (e) {
    err.value = errText(e);
  } finally {
    cleaning.value = false;
  }
}

// ===== 事件合流 =====
/** 本页是否处于前台：页面经 v-show 保活，事件刷新只在激活时跑，切走即停 */
const active = computed(() => app.activeModule === "localgw" && app.activePage === "stats");

// 概览 + 明细一起拉，1s 窗口合并防重入；先推进时间锚，让区间拿到当下
const scheduleRefresh = coalesceAsync(() => {
  nowTick.value = Date.now();
  return Promise.all([refresh(), loadDetail()]);
}, 1000);

// 档位/自定义日期变化：回到第 1 页并整体重拉。监听源头而不是 range 本身——
// nowTick 推进也会重算 range，若 watch(range) 会造成「刷新→重算→再刷新」的循环
watch([preset, customRange], () => {
  page.value = 1;
  scheduleRefresh();
});
// 文本筛选防抖 300ms（每次敲键都打一次 IPC 太浪费）
let modelTimer = 0;
let keyTimer = 0;
watch(
  () => filters.model,
  () => {
    window.clearTimeout(modelTimer);
    modelTimer = window.setTimeout(applyFilter, 300);
  },
);
watch(
  () => filters.keyPrefix,
  () => {
    window.clearTimeout(keyTimer);
    keyTimer = window.setTimeout(applyFilter, 300);
  },
);
// 下拉筛选（渠道 / 状态）都是点选，选中立即刷新
watch([() => filters.channel, () => filters.status], applyFilter);

watch(active, (on) => {
  if (on) scheduleRefresh();
  else scheduleRefresh.cancel();
});

let offEvent: (() => void) | undefined;

onMounted(async () => {
  // refreshStatus 顺带把「后端通道是否接入」问出来（backendReady），失败不抛只降级
  await Promise.all([lgw.refreshStatus(), lgw.refreshChannels()]);
  await reload();
  // 请求落账事件（后端 usagehook 广播 { event: "localgw", type: "request" }）驱动本页刷新，
  // 无需轮询；聚合是现算的，事件即变更信号
  offEvent = onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "localgw" || p.type !== "request") return;
    if (!active.value) return;
    scheduleRefresh();
  });
});

onUnmounted(() => {
  window.clearTimeout(modelTimer);
  window.clearTimeout(keyTimer);
  scheduleRefresh.cancel();
  if (offEvent) offEvent();
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="page-body">
      <!-- 顶部筛选栏：档位 + 自定义区间 + 生效范围（sticky，滚动只发生在下方内容区） -->
      <div class="stats-filters">
        <div class="chips">
          <button v-for="p in PRESETS" :key="p.key" class="chip" :class="{ active: preset === p.key }" @click="pickPreset(p.key)">
            {{ p.label }}
          </button>
        </div>
        <el-date-picker
          v-if="preset === 'custom'"
          :model-value="customRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          popper-class="glass-popper"
          class="f-date-range"
          @update:model-value="pickCustomRange"
        />
        <span class="range-hint">{{ rangeLabel }} · {{ granularity === "hour" ? "按小时" : "按天" }}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" @click="reload"><i class="ph ph-arrows-clockwise"></i> 刷新</button>
        <button class="btn btn-sm" @click="openClean"><i class="ph ph-broom"></i> 清理</button>
      </div>

      <!-- 错误横幅：只在后端已接入时展示——未接入时下面那块占位已经解释了原因，
           再叠一条红字只会让人以为「有两处坏了」 -->
      <div v-if="err && lgw.backendReady" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 后端未接入占位：与本地网关其它页一致，别让用户对着一堆 0 猜「是不是没数据」 -->
      <div v-if="!lgw.backendReady" class="lgw-backend-off">
        <i class="ph ph-link-break lgw-backend-off-icon"></i>
        <div class="lgw-backend-off-title">后端通道未接入</div>
        <div class="lgw-backend-off-desc">
          用量统计读的是 localgw_logs 请求流水，需要主进程注册 localgw_stats_overview / _detail / _cleanup 通道。
        </div>
      </div>

      <template v-else>
        <!-- KPI：区间口径（与下方所有模块同一区间）。
             六卡本体交给 UsageKpiGrid —— 与总览页的「近 7 天」共用同一个组件：
             成功率 0~100、平均耗时只算成功请求、输入+输出=总量、占比分母取 tokens，
             这些口径只写一处，两个页面就永远不会各算一个数 -->
        <UsageKpiGrid :kpis="k" :loading="!ov && !err" />

        <!-- 趋势：指标切换 + 原生 tooltip 看板（手写内联 SVG，无图表库） -->
        <div class="card">
          <div class="card-title">
            用量趋势
            <div class="chips" style="margin-left: 8px">
              <button v-for="m in METRICS" :key="m.key" class="chip" :class="{ active: metric === m.key }" @click="metric = m.key">
                {{ m.label }}
              </button>
            </div>
            <span class="right">{{ granularity === "hour" ? "按小时" : "按天" }} · {{ trend.length }} 个桶</span>
          </div>
          <div v-if="trend.length" class="trend-wrap">
            <svg class="trend-svg" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" role="img" aria-label="用量趋势折线图">
              <!-- 网格与刻度 -->
              <g class="trend-grid">
                <line v-for="t in chart.ticks" :key="`g${t.label}`" :x1="PAD_L" :x2="CHART_W - PAD_R" :y1="t.y" :y2="t.y" />
              </g>
              <!-- 面积 + 折线（单桶时折线画不出来，退化成点） -->
              <path v-if="chart.area" class="trend-area" :d="chart.area" />
              <polyline v-if="chart.n > 1" class="trend-line" :points="chart.line" />
              <circle v-else class="trend-dot" :cx="chart.single.x" :cy="chart.single.y" r="4" />
              <!-- 悬停热区：每桶一块透明矩形，<title> 走浏览器原生 tooltip -->
              <g class="trend-bands">
                <rect
                  v-for="(b, i) in chart.bands"
                  :key="`b${i}`"
                  :x="b.x"
                  :y="PAD_T"
                  :width="b.w"
                  :height="CHART_H - PAD_T - PAD_B"
                >
                  <title>{{ b.title }}</title>
                </rect>
              </g>
              <g class="trend-axis">
                <text v-for="t in chart.ticks" :key="`yt${t.label}`" :x="PAD_L - 8" :y="t.y" text-anchor="end" dominant-baseline="middle">
                  {{ t.label }}
                </text>
                <text v-for="(l, i) in xLabels" :key="`xt${i}`" :x="l.x" :y="CHART_H - 8" text-anchor="middle">{{ l.label }}</text>
              </g>
            </svg>
          </div>
          <div v-else class="empty-cell">当前时间区间暂无趋势数据</div>
        </div>

        <!-- 渠道分布 / 请求状态：CSS conic-gradient 手写环图 -->
        <div class="grid-2">
          <div class="card">
            <div class="card-title">渠道请求分布 <span class="right">共 {{ fmtInt(k?.req || 0) }} 次</span></div>
            <div class="donut-row">
              <div class="donut-wrap">
                <div class="donut" :style="{ background: conic(channelSegs) }"></div>
                <div class="donut-center">
                  <b>{{ fmtInt(k?.req || 0) }}</b>
                  <span>总请求</span>
                </div>
              </div>
              <div class="donut-legend">
                <div v-for="s in channelSegs" :key="s.label" class="legend-item">
                  <i class="legend-dot" :style="{ background: s.color }"></i>
                  <span class="legend-label" :title="s.label">{{ s.label }}</span>
                  <span class="mono">{{ fmtK(s.tokens) }}</span>
                  <span class="mono legend-pct">{{ s.pct }}%</span>
                </div>
                <div v-if="!channelSegs.length" class="empty-cell">当前时间区间暂无请求数据</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">请求状态 <span class="right">共 {{ fmtInt(k?.req || 0) }} 次</span></div>
            <div class="donut-row">
              <div class="donut-wrap">
                <div class="donut" :style="{ background: conic(statusSegs) }"></div>
                <div class="donut-center">
                  <b>{{ (k?.successRate ?? 0).toFixed(1) }}%</b>
                  <span>成功率</span>
                </div>
              </div>
              <div class="donut-legend">
                <div v-for="s in statusSegs" :key="s.label" class="legend-item">
                  <i class="legend-dot" :style="{ background: s.color }"></i>
                  <span class="legend-label">{{ s.label }}</span>
                  <span class="mono">{{ fmtInt(s.req) }} 次</span>
                  <span class="mono legend-pct">{{ s.pct }}%</span>
                </div>
                <div v-if="!statusSegs.length" class="empty-cell">当前时间区间暂无请求数据</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 用量占比 TOP：模型维度 × 排序切换。
             注意列集合：契约的桶只有 { req, tokens, err }，旧版的「请求 Tok / 响应 Tok / 平均 TTFT」
             按维度分不出来，所以这里不摆那三列；区间级的输入/输出拆分放在标题右侧。 -->
        <div class="card">
          <div class="card-title">
            用量占比 TOP
            <div class="chips" style="margin-left: 12px">
              <button class="chip" :class="{ active: topBy === 'req' }" @click="topBy = 'req'">按请求</button>
              <button class="chip" :class="{ active: topBy === 'tokens' }" @click="topBy = 'tokens'">按 Token</button>
            </div>
            <span class="right">
              TOP 8 · 区间输入 {{ fmtK(k?.promptTokens || 0) }} · 输出 {{ fmtK(k?.completionTokens || 0) }}
            </span>
          </div>
          <div class="table-scroll">
            <table class="table table-bare tbl-c">
              <thead>
                <tr>
                  <th>模型</th>
                  <th style="width: 32%">占比（{{ topBy === "tokens" ? "Token" : "请求" }}）</th>
                  <th>请求</th>
                  <th>总 Tok</th>
                  <th>失败</th>
                  <th>成功率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in topRows" :key="r.key" :style="{ '--i': i }">
                  <td>{{ r.key }}</td>
                  <td>
                    <div class="ratio">
                      <div class="ratio-track"><div class="ratio-fill" :style="{ width: Math.min(100, r.pct) + '%' }"></div></div>
                      <span class="num">{{ r.pct }}%</span>
                    </div>
                  </td>
                  <td class="mono">{{ fmtInt(r.req) }}</td>
                  <td class="mono">{{ fmtK(r.tokens) }}</td>
                  <td class="mono" :class="r.err ? 'rate-bad' : ''">{{ fmtInt(r.err) }}</td>
                  <td class="mono" :class="rateCls(r.successRate)">{{ r.successRate.toFixed(1) }}%</td>
                </tr>
                <tr v-if="!topRows.length">
                  <td colspan="6" class="empty-cell">当前时间区间暂无请求数据</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 请求明细：模型精确匹配 + 渠道 / 状态过滤 + Key 前缀 + 分页 -->
        <div class="card">
          <div class="card-title">
            请求明细
            <span class="right">{{ fmtInt(detail?.total || 0) }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          </div>
          <div class="detail-filters">
            <el-input v-model="filters.model" placeholder="模型名（精确）" clearable class="f-el-input" />
            <el-select v-model="filters.channel" placeholder="全部渠道" clearable class="f-el-select" popper-class="glass-popper">
              <el-option value="" label="全部渠道" />
              <el-option v-for="c in channelOptions" :key="c.id" :value="c.id" :label="c.label" />
            </el-select>
            <el-select v-model="filters.status" placeholder="全部状态" clearable class="f-el-select" popper-class="glass-popper">
              <el-option value="" label="全部状态" />
              <el-option value="success" label="成功" />
              <el-option value="error" label="失败" />
              <el-option value="cancelled" label="取消" />
            </el-select>
            <el-input v-model="filters.keyPrefix" placeholder="Key 前缀" clearable class="f-el-input" />
            <button class="btn btn-sm" @click="resetFilters">重置</button>
            <span class="detail-agg">
              本页 {{ pageAgg.n }} 条 · 输入 {{ fmtK(pageAgg.pt) }} · 输出 {{ fmtK(pageAgg.ct) }} · 合计 {{ fmtK(pageAgg.tokens) }}
            </span>
          </div>
          <div class="table-scroll">
            <table class="table table-bare tbl-c">
              <thead>
                <tr>
                  <th>时间</th><th>密钥</th><th>渠道</th><th>模型</th><th>状态</th>
                  <th>请求 Tok</th><th>响应 Tok</th><th>总 Tok</th><th>耗时</th><th>敏</th><th>错误</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in detail?.rows || []" :key="r.id || i" :style="{ '--i': i }">
                  <td class="mono">
                    <el-tooltip :content="fmtDate(r.ts)" placement="top"><span>{{ fmtTime(r.ts) }}</span></el-tooltip>
                  </td>
                  <td class="mono">{{ r.apiKeyPrefix || "-" }}</td>
                  <td>{{ channelName(r.channel) }}</td>
                  <td class="mono">{{ r.model || "-" }}</td>
                  <td>
                    <el-tooltip :content="r.errCode || ''" :disabled="!r.errCode" placement="top">
                      <span class="tag" :class="statusTagCls(r.status)">{{ statusText(r.status) }}</span>
                    </el-tooltip>
                  </td>
                  <td class="mono">{{ fmtInt(Number(r.promptTokens) || 0) }}</td>
                  <td class="mono">{{ fmtInt(Number(r.completionTokens) || 0) }}</td>
                  <td class="mono">{{ fmtK((Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0)) }}</td>
                  <td class="mono">{{ fmtMs(Number(r.ms) || 0) }}</td>
                  <!-- 敏：出站指纹脱敏命中的规则，悬停看完整清单（口径见 proxy/sanitize.cjs）；
                       没命中显示 "-"，不是 0 —— 0 会被误读成「命中了 0 条规则」这件事有意义 -->
                  <td>
                    <el-tooltip v-if="r.sensitiveHits" :content="`已改写上游审核指纹：${r.sensitiveHits}`" placement="top">
                      <span class="tag tag-warn">敏</span>
                    </el-tooltip>
                    <span v-else>-</span>
                  </td>
                  <td class="mono">{{ r.errCode || "-" }}</td>
                </tr>
                <tr v-if="!(detail?.rows || []).length">
                  <td colspan="11" class="empty-cell">当前筛选条件下没有请求明细（改一下筛选或点「重置」）</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pager">
            <span class="pager-info">共 {{ fmtInt(detail?.total || 0) }} 条 · 每页 {{ PAGE_SIZE }} 条</span>
            <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
            <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
          </div>
        </div>
      </template>

      <!-- 清理确认弹窗：删的是不可恢复的历史，范围与后果都写明白 -->
      <Teleport to="body">
        <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
          <div class="p-dlg glass">
            <div class="p-title">清理请求流水</div>
            <div class="chips" style="margin-bottom: 8px">
              <button class="chip" :class="{ active: cleanScope === 'expired' }" @click="cleanScope = 'expired'">仅超期流水</button>
              <button class="chip" :class="{ active: cleanScope === 'all' }" @click="cleanScope = 'all'">全部流水</button>
            </div>
            <div class="set-desc">
              <template v-if="cleanScope === 'expired'">
                将删除保留期（设置页当前为 {{ retentionDays }} 天）之前的全部请求流水，此操作不可恢复。
              </template>
              <template v-else>
                将清空<b>整张请求流水表</b>（含当前筛选范围之外的历史记录），此操作不可恢复。
              </template>
            </div>
            <div class="p-actions">
              <button class="btn" @click="cleanOpen = false">取消</button>
              <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">
                {{ cleaning ? "清理中…" : cleanScope === "all" ? "全部清空" : "确认清理" }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方内容区（对齐操作日志页的筛选栏配方） */
.stats-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--glass-a);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.stats-filters .spacer {
  flex: 1;
}
.range-hint {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* el 组件模板根是多节点结构，scoped 的 data-v 透传不到根上，必须 :deep 穿透 */
.stats-filters :deep(.f-date-range) {
  width: 260px;
}
.stats-filters :deep(.f-date-range .el-input__wrapper),
.stats-filters :deep(.f-date-range.el-date-editor) {
  min-height: 34px;
  font-size: 12.5px;
}

.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

/* ===== 趋势图 =====
   viewBox 固定 720×200、容器宽度自适应：宽高比恒定，坐标里的文字与圆点不会被拉扁 */
.trend-wrap {
  width: 100%;
}
.trend-svg {
  display: block;
  width: 100%;
  height: auto;
}
.trend-grid line {
  stroke: var(--line);
  stroke-width: 1;
}
.trend-area {
  fill: var(--accent-dim);
  stroke: none;
}
.trend-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.trend-dot {
  fill: var(--accent);
}
/* 透明填充仍能接收指针事件（fill:none 不能），原生 <title> 提示才出得来 */
.trend-bands rect {
  fill: transparent;
}
.trend-axis text {
  fill: var(--text-3);
  font-size: 11px;
  font-family: var(--font-mono);
}

/* ===== 环图 =====
   外圈用 conic-gradient 上色，再用 mask 挖掉中间 60% 变成环；
   中心文字放在**外层**（mask 会把子元素一起挖掉，塞进去就看不见了） */
.donut-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.donut-wrap {
  position: relative;
  width: 132px;
  height: 132px;
  flex-shrink: 0;
}
.donut {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  -webkit-mask: radial-gradient(farthest-side, transparent 60%, #000 61%);
  mask: radial-gradient(farthest-side, transparent 60%, #000 61%);
}
.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  pointer-events: none;
}
.donut-center b {
  font-family: var(--font-mono);
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}
.donut-center span {
  font-size: 10.5px;
  color: var(--text-3);
}
.donut-legend {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-2);
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.legend-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend-pct {
  width: 46px;
  text-align: right;
  color: var(--text-3);
}

/* 明细筛选行 */
.detail-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.detail-filters :deep(.f-el-input) {
  width: 160px;
}
.detail-filters :deep(.f-el-select) {
  width: 140px;
}
.detail-filters :deep(.f-el-input .el-input__wrapper),
.detail-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 30px;
  font-size: 12.5px;
}
.detail-agg {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

/* 两个表（TOP / 明细）字段值居中；th 全局 .table 已居中，这里覆盖默认左对齐的 td */
.tbl-c th,
.tbl-c td {
  text-align: center;
}
/* 本页表格行不可点（全局 .table 统一给了 pointer + 悬停底色，那是给「点行看详情」的表用的） */
.tbl-c tbody tr {
  cursor: default;
}

/* 成功率低于阈值时着色 */
.rate-warn {
  color: var(--warn);
}
.rate-bad {
  color: var(--danger);
}

.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 18px 0;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.pager-info {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
</style>
