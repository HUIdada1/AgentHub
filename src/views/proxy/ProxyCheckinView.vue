<!--
  ============================================================
   作者：沐晖
   日期：2026-11-09
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 号池管家 · 签到中心（方案对齐示例项目 Agent2Providers 的 ui/checkin，数据源全部是本仓真实实现）
     四节内容由后端 adminPanels 决定显隐：后端没有能力的整节不渲染，不给用户一个永远空的区块。
       · 每日签到：按渠道分组的账号签到状态；点行展开账号表，可单账号签 / 整渠道签
       · 新手福利：一次性，台账在 meta.onboardingGrants；查询即领取（上游接口幂等）
       · 活动福利：ZCode 套餐，逐份查看与领取；领取需滑块验证码时主进程弹官方 SDK
       · 成长任务：能力位预留（当前无渠道申报 —— WorkBuddy 的 growth 端点在 5.6.2 已不存在）
     错误一律 toast + 页面内横幅双落点：toast 给「刚才那一下」的即时反馈，
     横幅给「页面现在是什么状态」的持续可见性（toast 3 秒就没了，不能当唯一出口）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type {
  CheckinCenterSnapshot,
  CheckinCenterProvider,
  CheckinCenterAccount,
  CheckinOnboardingRow,
  CheckinOnboardingResult,
  CheckinPlansRow,
  CheckinPlansPreview,
  ProxyChannelId,
} from "../../types";
import { useAppStore } from "../../stores/app";
import { isWebTransport } from "../../api/caps";
import { toast } from "../../utils/toast";
import { fmtAgo, fmtDate } from "./format";

const app = useAppStore();
const active = computed(() => app.activeModule === "proxy" && app.activePage === "checkin");
/** 容器（Docker / 浏览器托管）形态：没有图形环境，滑块验证码过不了。
 *  这里只是提前把按钮置灰并给指引 —— 真正兜底在 platform/node.cjs 的 solveCaptcha（诚实拒绝）。 */
const webMode = isWebTransport();

const snap = ref<CheckinCenterSnapshot | null>(null);
const loading = ref(false);
const err = ref("");

/** 展开状态：键 = `daily:渠道` / `onboarding:账号` / `plans:账号` */
const expanded = reactive(new Set<string>());
/** 忙碌键：与 expanded 同一套键名，按钮据此置灰 */
const busy = reactive(new Set<string>());
/** 新手福利查询结果缓存（按账号）：查询即领取，结果留在页面上供反复查看 */
const onboardingResult = reactive<Record<string, CheckinOnboardingResult>>({});
/** 活动福利套餐预览缓存（按账号） */
const plansResult = reactive<Record<string, CheckinPlansPreview>>({});

const daily = computed(() => snap.value?.daily);
const onboardingRows = computed(() => snap.value?.extras.onboarding || []);
const planRows = computed(() => snap.value?.extras.plans || []);
const growthRows = computed(() => snap.value?.extras.growth || []);
const panels = computed(() => new Set(snap.value?.adminPanels || []));

const donePct = computed(() => {
  const d = daily.value;
  if (!d || !d.todayEligible) return 0;
  return Math.round((d.todayDone / d.todayEligible) * 100);
});
/** 待领新手福利：没落台账的账号数（不是任务条数 —— 任务明细要实查上游才有） */
const pendingOnboarding = computed(() => onboardingRows.value.filter((r) => !r.settled).length);
/** 今日已领活动福利的账号数 */
const claimedPlans = computed(() => planRows.value.filter((r) => r.claimAt > 0).length);

function keyOf(...parts: string[]) {
  return parts.join(":");
}

function toggle(key: string) {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}

function isBusy(key: string) {
  return busy.has(key);
}

/** 统一的动作包装：忙碌互斥 + 异常兜底 + 失败提示。
 *  所有动作都必须走这里 —— 直接调 api 再各自 catch 会让「哪一步失败、失败后按钮还锁不锁」散开。 */
async function run<T>(key: string, task: () => Promise<T>, successText?: string): Promise<T | null> {
  if (busy.has(key)) return null;
  busy.add(key);
  try {
    const r = await task();
    if (successText) toast.success(successText);
    return r;
  } catch (e) {
    const msg = String((e as Error)?.message || e || "操作失败");
    // 页面横幅留最近一次错误；toast 给即时反馈。两处都写，避免用户错过。
    err.value = msg;
    toast.error(msg);
    return null;
  } finally {
    busy.delete(key);
  }
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  err.value = "";
  try {
    snap.value = await api.proxyCheckinCenter();
  } catch (e) {
    const msg = String((e as Error)?.message || e || "签到数据读取失败");
    err.value = msg;
    toast.error(msg);
  } finally {
    loading.value = false;
  }
}

/** 整渠道签到：走既有 proxy_checkin_run（批量执行器：串行 + 互斥 + 验证码二段流都在里面） */
async function signChannel(p: CheckinCenterProvider) {
  const key = keyOf("daily", p.channel);
  const r = await run(key, () => api.proxyCheckinRun({ channel: p.channel, action: "checkin" }));
  if (!r) return;
  const ok = Number(r.okCount) || 0;
  const total = Number(r.total) || 0;
  if (total && ok === total) toast.success(`${p.label} 签到完成（${ok}/${total}）`);
  else if (ok) toast.warning(`${p.label} 部分完成（${ok}/${total}），其余可重试`);
  else toast.error(`${p.label} 签到失败：${r.message || "全部账号未成功"}`);
  await refresh();
}

/** 单账号签到 */
async function signAccount(acc: CheckinCenterAccount) {
  const key = keyOf("acc", acc.id);
  const r = await run(key, () => api.proxyCheckinRun({ accountId: acc.id, action: "checkin" }));
  if (!r) return;
  if (r.okCount) toast.success(`${acc.name} 签到成功`);
  else toast.error(`${acc.name} 签到失败：${r.message || "上游未返回成功"}`);
  await refresh();
}

/** 新手福利：查询即领取（上游两个首登端点本身幂等，不存在「只读预览」） */
async function claimOnboarding(row: CheckinOnboardingRow) {
  const key = keyOf("onboarding", row.id);
  const r = await run(key, () => api.proxyOnboardingClaim(row.id));
  if (!r) return;
  onboardingResult[row.id] = r;
  expanded.add(key);
  if (r.failed) toast.warning(`${row.name}：${r.failed} 项领取失败，可重试`);
  else if (r.claimed) toast.success(`${row.name}：领取 ${r.claimed} 项${r.points ? `（+${r.points} 积分）` : ""}`);
  else toast.info(`${row.name}：${r.message || "没有可领取的项"}`);
  await refresh();
}

/** 活动福利：预览套餐（只读） */
async function previewPlans(row: CheckinPlansRow) {
  const key = keyOf("plans", row.id);
  const r = await run(key, () => api.proxyPlansPreview(row.id));
  if (!r) return;
  plansResult[row.id] = r;
  expanded.add(key);
  if (!r.ok) toast.error(`${row.name}：${r.message}`);
  else if (r.unavailable) toast.info(`${row.name}：${r.message || "当前没有可领取的活动"}`);
}

/** 活动福利：领取单份套餐（需要过码时主进程弹 SDK；容器形态回 needCaptcha） */
async function claimPlan(row: CheckinPlansRow, plan: { planId: string; name: string }) {
  const key = keyOf("plan", row.id, plan.planId);
  const r = await run(key, () => api.proxyPlansClaim({ accountId: row.id, planId: plan.planId }));
  if (!r) return;
  if (r.ok) {
    toast.success(`${row.name}：${r.message || "领取成功"}`);
    await previewPlans(row);
    await refresh();
  } else if (r.needCaptcha) {
    // 不是失败：需要人工过码。容器形态 platform 会诚实拒绝，所以这里给「去桌面版」的指引
    toast.warning(`${row.name}：${r.message || "需要完成人机校验后才能领取"}`);
  } else {
    toast.error(`${row.name}：${r.message || "领取失败"}`);
  }
}

/** 成长任务：查询（当前无渠道申报，后端如实返回不支持） */
async function queryGrowth(row: { id: string; name: string }) {
  const key = keyOf("growth", row.id);
  const r = await run(key, () => api.proxyGrowthQuery(row.id));
  if (!r) return;
  if (r.ok) toast.success(`${row.name}：查询完成`);
  else toast.info(`${row.name}：${r.message}`);
}

function accountTag(acc: CheckinCenterAccount) {
  if (acc.unavailable) return { text: "不开放", cls: "plain" };
  if (acc.checkedInToday) return { text: "已签", cls: "ok" };
  if (acc.status === "disabled") return { text: "已禁用", cls: "plain" };
  return { text: "待签", cls: "warn" };
}

function providerTag(p: CheckinCenterProvider) {
  if (!p.totalCount) return { text: "无账号", cls: "plain" };
  if (p.doneCount === p.totalCount) return { text: "已签完", cls: "ok" };
  if (p.doneCount > 0) return { text: `${p.doneCount}/${p.totalCount}`, cls: "warn" };
  return { text: "待签", cls: "warn" };
}

function planTag(row: CheckinPlansRow) {
  if (row.claimAt > 0) return { text: "今天已领", cls: "ok" };
  return { text: "今天未领", cls: "plain" };
}

/** 台账 → 可读的结算时间；-1 是「端点已下线」哨兵 */
function ledgerText(v: number) {
  const n = Number(v) || 0;
  if (n === -1) return "端点已下线";
  if (n > 0) return fmtDate(n);
  return "-";
}

onMounted(() => {
  if (active.value) refresh();
});

// 切到本页时拉一次：首次进入与从别的页签切回来都走这里（页面是 v-show，不会重新 mount）
const stopWatch = watch(active, (on) => {
  if (on) refresh();
});

onUnmounted(() => {
  stopWatch();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">签到中心</h2>
        <span class="page-sub">
          每日签到 / 新手福利 / 活动福利 / 成长任务 —— 按渠道真实能力显示，没有能力的整节不出现
        </span>
      </div>
      <div class="page-actions">
        <span class="ck-day">{{ snap?.today || "—" }}</span>
        <button class="btn btn-sm" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
      </div>
    </div>

    <div class="page-body">
      <div v-if="err" class="ck-err" role="alert">
        <span>{{ err }}</span>
        <button class="btn btn-sm" @click="err = ''">知道了</button>
      </div>

      <!-- 总览：四张卡，语义与示例项目一致（进度 / 定时 / 待领福利 / 今日活动） -->
      <div class="ck-stats">
        <div class="ck-stat">
          <span class="ck-stat-label">今日签到进度</span>
          <span class="ck-stat-value">{{ daily?.todayDone ?? 0 }}<small>/ {{ daily?.todayEligible ?? 0 }}</small></span>
          <div class="ck-bar"><i :style="{ width: donePct + '%' }"></i></div>
          <span class="ck-stat-foot">已签 {{ donePct }}%</span>
        </div>
        <div class="ck-stat">
          <span class="ck-stat-label">渠道分组</span>
          <span class="ck-stat-value">{{ daily?.providers.length ?? 0 }}<small>个</small></span>
          <span class="ck-stat-foot">按渠道展开可逐账号签到</span>
        </div>
        <div class="ck-stat">
          <span class="ck-stat-label">待领新手福利</span>
          <span class="ck-stat-value">{{ pendingOnboarding }}<small>/ {{ onboardingRows.length }}</small></span>
          <span class="ck-stat-foot">一次性，领完不再查上游</span>
        </div>
        <div class="ck-stat">
          <span class="ck-stat-label">今日活动福利</span>
          <span class="ck-stat-value">{{ claimedPlans }}<small>/ {{ planRows.length }}</small></span>
          <span class="ck-stat-foot">领取需滑块验证码</span>
        </div>
      </div>

      <!-- 每日签到 -->
      <section class="ck-panel">
        <header class="ck-panel-head">
          <h3>每日签到</h3>
          <span class="ck-panel-sub">按渠道分组 · 点击行展开账号 · 签到动作走既有批量执行器（串行 + 互斥）</span>
        </header>
        <div v-if="!daily?.providers.length" class="ck-empty">没有可用账号。先到「号池」页登录或导入。</div>
        <div v-for="p in daily?.providers || []" :key="p.channel" class="ck-row" :class="{ open: expanded.has(keyOf('daily', p.channel)) }">
          <div class="ck-row-main" role="button" tabindex="0" @click="toggle(keyOf('daily', p.channel))" @keydown.enter="toggle(keyOf('daily', p.channel))">
            <span class="ck-badge">{{ p.label.slice(0, 1) }}</span>
            <div class="ck-row-info">
              <span class="ck-row-name">{{ p.label }}</span>
              <span class="ck-row-desc">{{ p.doneCount }} / {{ p.totalCount }} 已签</span>
            </div>
            <div class="ck-row-right">
              <span class="ck-tag" :class="'ck-tag-' + providerTag(p).cls">{{ providerTag(p).text }}</span>
              <button class="btn btn-sm" :disabled="isBusy(keyOf('daily', p.channel))" @click.stop="signChannel(p)">
                {{ isBusy(keyOf("daily", p.channel)) ? "签到中…" : "全部签到" }}
              </button>
              <i class="ck-chev">›</i>
            </div>
          </div>
          <div v-if="expanded.has(keyOf('daily', p.channel))" class="ck-row-detail">
            <table class="ck-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>今日</th>
                  <th>上次签到</th>
                  <th>连登</th>
                  <th class="ta-r">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in p.accounts" :key="a.id">
                  <td>
                    <span class="ck-name">{{ a.name }}</span>
                    <span class="ck-uid">{{ a.uid }}</span>
                  </td>
                  <td><span class="ck-tag" :class="'ck-tag-' + accountTag(a).cls">{{ accountTag(a).text }}</span></td>
                  <td>{{ a.checkinAt ? fmtAgo(a.checkinAt) : "—" }}</td>
                  <td>{{ a.streakDays || "—" }}</td>
                  <td class="ta-r">
                    <button class="btn btn-sm" :disabled="isBusy(keyOf('acc', a.id))" @click="signAccount(a)">
                      {{ isBusy(keyOf("acc", a.id)) ? "签到中…" : "签到" }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="p.accounts.some((a) => a.unavailable)" class="ck-note">标「不开放」的账号是上游明确表示当前没有签到活动（不是失败）。</p>
          </div>
        </div>
      </section>

      <!-- 新手福利：后端 adminPanels 里有 onboarding 才渲染 -->
      <section v-if="panels.has('onboarding')" class="ck-panel">
        <header class="ck-panel-head">
          <h3>新手福利</h3>
          <span class="ck-panel-sub">一次性福利 · 已领取状态保存在本机台账（meta.onboardingGrants）· 领完无需重复查询 · 点击行展开任务清单</span>
        </header>
        <div v-for="row in onboardingRows" :key="row.id" class="ck-row" :class="{ open: expanded.has(keyOf('onboarding', row.id)) }">
          <div class="ck-row-main">
            <span class="ck-badge">{{ row.channel.slice(0, 1).toUpperCase() }}</span>
            <div class="ck-row-info">
              <span class="ck-row-name">{{ row.name }}</span>
              <span class="ck-row-desc">
                <template v-if="row.settled">已结清 {{ row.settledCount }} 项 · 结算于 {{ row.settledAt ? fmtDate(row.settledAt) : "—" }}</template>
                <template v-else>未结算 · {{ row.note || "点「查询任务」实查上游" }}</template>
              </span>
            </div>
            <div class="ck-row-right">
              <span class="ck-tag" :class="row.settled ? 'ck-tag-ok' : 'ck-tag-warn'">{{ row.settled ? "全部领取" : "待查询" }}</span>
              <button class="btn btn-sm" :disabled="isBusy(keyOf('onboarding', row.id))" @click="claimOnboarding(row)">
                {{ isBusy(keyOf("onboarding", row.id)) ? "查询中…" : row.settled ? "重新查询" : "查询任务" }}
              </button>
              <button class="ck-chev-btn" :aria-expanded="expanded.has(keyOf('onboarding', row.id))" @click="toggle(keyOf('onboarding', row.id))">
                <i class="ck-chev">›</i>
              </button>
            </div>
          </div>
          <div v-if="expanded.has(keyOf('onboarding', row.id))" class="ck-row-detail">
            <div v-if="onboardingResult[row.id]" class="ck-tasks">
              <div v-for="t in onboardingResult[row.id].tasks" :key="t.key" class="ck-task-line">
                <i class="ck-tick" :class="{ done: t.ok }"></i>
                <span class="ck-task-title">{{ t.title }}</span>
                <span class="ck-task-pts">{{ t.points ? `+${t.points}` : "" }}</span>
                <span class="ck-task-st" :class="t.ok ? 'ck-tag-ok' : 'ck-tag-err'">
                  {{ t.gone ? "端点已下线" : t.ok ? (t.already ? "此前已领" : "已领取") : t.error || "失败" }}
                </span>
              </div>
              <p class="ck-note">
                本轮：领取 {{ onboardingResult[row.id].claimed }} 项 · 已领过 {{ onboardingResult[row.id].already }} 项 ·
                失败 {{ onboardingResult[row.id].failed }} 项<template v-if="onboardingResult[row.id].points"> · 累计 {{ onboardingResult[row.id].points }} 积分</template>
              </p>
            </div>
            <div v-else class="ck-empty-sm">还没有查询结果。点「查询任务」会实查上游并顺手领取（接口本身幂等）。</div>
            <p v-if="Object.keys(row.ledger).length" class="ck-note">
              台账：<template v-for="(v, k, i) in row.ledger" :key="k">{{ i ? " · " : "" }}{{ k }} → {{ ledgerText(v) }}</template>
            </p>
          </div>
        </div>
      </section>

      <!-- 活动福利 -->
      <section v-if="panels.has('plans')" class="ck-panel">
        <header class="ck-panel-head">
          <h3>活动福利</h3>
          <span class="ck-panel-sub">限时体验套餐 · 领取需滑块验证码 · 逐份查看与领取</span>
        </header>
        <div v-for="row in planRows" :key="row.id" class="ck-row" :class="{ open: expanded.has(keyOf('plans', row.id)) }">
          <div class="ck-row-main">
            <span class="ck-badge">{{ row.channel.slice(0, 1).toUpperCase() }}</span>
            <div class="ck-row-info">
              <span class="ck-row-name">{{ row.name }}</span>
              <span class="ck-row-desc">
                <template v-if="row.claimAt">上次领取 {{ fmtAgo(row.claimAt) }} · 领取需通过滑块验证码</template>
                <template v-else>{{ row.note || "活动期内每天一份 · 领取需滑块验证码" }}</template>
              </span>
            </div>
            <div class="ck-row-right">
              <span class="ck-tag" :class="'ck-tag-' + planTag(row).cls">{{ planTag(row).text }}</span>
              <button class="btn btn-sm" :disabled="isBusy(keyOf('plans', row.id))" @click="previewPlans(row)">
                {{ isBusy(keyOf("plans", row.id)) ? "查询中…" : "套餐明细" }}
              </button>
              <button class="ck-chev-btn" :aria-expanded="expanded.has(keyOf('plans', row.id))" @click="toggle(keyOf('plans', row.id))">
                <i class="ck-chev">›</i>
              </button>
            </div>
          </div>
          <div v-if="expanded.has(keyOf('plans', row.id))" class="ck-row-detail">
            <div v-if="plansResult[row.id]">
              <div v-if="plansResult[row.id].unavailable" class="ck-empty-sm">{{ plansResult[row.id].message || "当前没有可领取的活动" }}</div>
              <div v-else-if="!plansResult[row.id].plans.length" class="ck-empty-sm">没有可领取的套餐。</div>
              <div v-for="pl in plansResult[row.id].plans" :key="pl.planId" class="ck-plan-line">
                <div class="ck-plan-info">
                  <span class="ck-plan-name">{{ pl.name || pl.planId }}</span>
                  <span class="ck-plan-desc">{{ pl.description || "—" }}</span>
                  <span v-if="pl.endsAt" class="ck-plan-ends">截止 {{ fmtDate(pl.endsAt) }}</span>
                </div>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="webMode || isBusy(keyOf('plan', row.id, pl.planId))"
                  :title="webMode ? '容器版没有图形环境，滑块验证码需要在桌面版完成' : ''"
                  @click="claimPlan(row, pl)"
                >
                  {{ webMode ? "需桌面版" : isBusy(keyOf("plan", row.id, pl.planId)) ? "领取中…" : "领取" }}
                </button>
              </div>
              <p class="ck-note">
                领取需要完成一次人机校验（滑块 / 点选），桌面版会弹出官方验证窗口。
                <template v-if="webMode">当前是容器形态，没有图形环境 —— 领取按钮已置灰，请到桌面版操作。</template>
              </p>
            </div>
            <div v-else class="ck-empty-sm">点「套餐明细」查询当前可领的活动套餐。</div>
          </div>
        </div>
      </section>

      <!-- 成长任务：只有后端 adminPanels 里有时才渲染（当前版本无渠道申报） -->
      <section v-if="panels.has('growth')" class="ck-panel">
        <header class="ck-panel-head">
          <h3>成长任务</h3>
          <span class="ck-panel-sub">任务清单 · 一键完成 / 领取奖励</span>
        </header>
        <div v-for="row in growthRows" :key="row.id" class="ck-row">
          <div class="ck-row-main">
            <span class="ck-badge">{{ row.channel.slice(0, 1).toUpperCase() }}</span>
            <div class="ck-row-info">
              <span class="ck-row-name">{{ row.name }}</span>
              <span class="ck-row-desc">查询任务清单并执行</span>
            </div>
            <div class="ck-row-right">
              <button class="btn btn-sm" :disabled="isBusy(keyOf('growth', row.id))" @click="queryGrowth(row)">
                {{ isBusy(keyOf("growth", row.id)) ? "查询中…" : "查询任务" }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <p v-if="!snap && !loading && !err" class="ck-empty">还没有读到签到数据。点右上角「刷新」。</p>
    </div>
  </section>
</template>

<style scoped>
.ck-day {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  margin-right: 8px;
}

/* 页面内错误横幅：toast 3 秒就没了，横幅负责「现在页面是坏的」这件事 */
.ck-err {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--r-md, 10px);
  border: 1px solid var(--danger);
  background: var(--danger-dim);
  color: var(--danger);
  font-size: 13px;
}

/* 总览卡：4 列，窄屏 2 列 */
.ck-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 900px) {
  .ck-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.ck-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 16px;
  border-radius: var(--r-md, 10px);
  border: 1px solid var(--glass-bd, rgba(0, 0, 0, 0.08));
  background: var(--glass-a, rgba(255, 255, 255, 0.6));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.ck-stat-label {
  font-size: 12px;
  color: var(--text-3);
}
.ck-stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.ck-stat-value small {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 4px;
}
.ck-stat-foot {
  font-size: 11.5px;
  color: var(--text-3);
}
.ck-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-soft);
  overflow: hidden;
}
.ck-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.25s ease;
}

/* 面板：与号池其他页的卡片同材质（全局 .glass 的渐变 + 边框） */
.ck-panel {
  border-radius: var(--r-md, 10px);
  border: 1px solid var(--glass-bd, rgba(0, 0, 0, 0.08));
  background: var(--glass-a, rgba(255, 255, 255, 0.6));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}
.ck-panel-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.ck-panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}
.ck-panel-sub {
  font-size: 12px;
  color: var(--text-3);
}

/* 可展开行 */
.ck-row + .ck-row {
  border-top: 1px solid var(--line);
}
.ck-row-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.ck-row-main:hover,
.ck-row.open .ck-row-main {
  background: var(--bg-soft);
}
.ck-badge {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 700;
}
.ck-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.ck-row-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.ck-row-desc {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ck-row-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.ck-chev {
  display: inline-block;
  font-style: normal;
  font-size: 16px;
  line-height: 1;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.ck-row.open .ck-chev {
  transform: rotate(90deg);
}
.ck-chev-btn {
  border: 0;
  background: none;
  padding: 2px 4px;
  cursor: pointer;
  line-height: 1;
}

/* 展开区：左缩进对齐文字（与示例项目 58px 同一口径） */
.ck-row-detail {
  padding: 2px 16px 12px 58px;
}

/* 状态徽标 */
.ck-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 550;
  white-space: nowrap;
}
/* 与全局 .tag-ok / .tag-warn 同口径（global.css:982-990）：亮色 + 低透明底 */
.ck-tag-ok {
  color: var(--accent-strong);
  background: var(--accent-dim);
}
.ck-tag-warn {
  color: var(--warn);
  background: var(--warn-dim);
}
.ck-tag-err {
  color: var(--danger);
  background: var(--danger-dim);
}
.ck-tag-plain {
  color: var(--text-3);
  background: var(--bg-soft);
}

/* 账号小表 */
.ck-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  background: var(--bg-soft);
  border-radius: var(--r-sm, 7px);
  overflow: hidden;
}
.ck-table th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-3);
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
}
.ck-table td {
  padding: 7px 12px;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}
.ck-table tr:last-child td {
  border-bottom: 0;
}
.ck-name {
  color: var(--text);
  font-weight: 550;
}
.ck-uid {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ta-r {
  text-align: right;
}

/* 任务行 */
.ck-tasks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ck-task-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
}
.ck-task-title {
  color: var(--text);
}
.ck-task-pts {
  font-size: 11.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.ck-task-st {
  margin-left: auto;
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
}
.ck-tick {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  border-radius: 50%;
  border: 1px dashed var(--line-strong);
}
.ck-tick.done {
  border: 1px solid var(--accent-strong);
  background: var(--accent-dim);
}

/* 套餐行 */
.ck-plan-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.ck-plan-line:last-of-type {
  border-bottom: 0;
}
.ck-plan-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.ck-plan-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ck-plan-desc,
.ck-plan-ends {
  font-size: 11.5px;
  color: var(--text-3);
}

.ck-note {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.ck-empty,
.ck-empty-sm {
  padding: 16px;
  font-size: 12.5px;
  color: var(--text-3);
  text-align: center;
}
.ck-empty-sm {
  padding: 10px 0;
  text-align: left;
}
</style>
