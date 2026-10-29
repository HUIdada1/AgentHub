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
<!-- 本地网关 · 总览：地址 / 端点 / 安全徽章 + 服务开关 / 今日核心指标 / 近 7 天用量 / 实时请求流 / 快速上手
     骨架沿用 fdb3e55^ 旧版反代网关总览（err-card → toolbar → kpis → 渠道一览 → 实时请求流 → 快速上手）。
     其中「渠道一览」（各渠道余额与可用账号）已撤销：余额归号池管家管，总览再摆一份既重复，
     又把首屏注意力从「网关到底跑了多少量」抢走；腾出的位置换成「近 7 天用量」六卡，
     数据与「用量统计」页同源（localgw_stats_overview 的 kpis），组件也共用（UsageKpiGrid）。
     其余数据全走 useLocalgwStore（localgw_* 通道），不另建一套账号模型（方案 §4.1）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { localgwStatsOverview, proxyVaultStatus, type LocalgwStatsOverview } from "../../api/ipc";
import UsageKpiGrid from "../../components/localgw/UsageKpiGrid.vue";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { coalesceAsync } from "../../utils/timing";
// 格式化口径与号池管家同源：大数缩写 / 毫秒 / 时间都复用同一份实现，本地网关再抄一份必然走形。
// （渠道余额的 fmtBalance / balanceUnit 原先给「渠道余量卡」用，卡片撤掉后本页不再需要）
import { fmtInt, fmtK, fmtMs, fmtTime } from "../proxy/format";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 页面级错误（启动前置校验）+ store 的 lastError 合成一条错误文案：
 *  store 把异常收敛进 lastError，页面只负责展示与清除，不再各写一份 try/catch */
const localErr = ref("");
const err = computed(() => localErr.value || lgw.lastError);
function dismissErr() {
  localErr.value = "";
  lgw.clearError();
}

/** 安全徽章：凭证加密状态走 proxy_vault_status 读真实现状。
 *  拿不到就整条徽章不渲染 —— 硬编一个 "ok" 等于对用户撒谎 */
const vault = ref<{ encrypted: boolean; driver: string } | null>(null);
async function refreshVault() {
  const v = await proxyVaultStatus().catch(() => null);
  vault.value = v && typeof v === "object" ? { encrypted: !!v.encrypted, driver: String(v.driver || "") } : null;
}

const loading = ref(false);
const busy = ref(false);
const running = computed(() => !!lgw.snapshot?.running);

/** 监听 0.0.0.0 / :: 是「所有网卡」而不是可连的地址：地址条是要复制出去给客户端用的，
 *  必须落回回环地址，否则用户复制到一个自己都连不上的串 */
const bindAddr = computed(() => {
  const b = lgw.snapshot?.bind || "127.0.0.1";
  return b === "0.0.0.0" || b === "::" || b === "[::]" ? "127.0.0.1" : b;
});
/** 根地址（Anthropic 系客户端要填这个，它们自己拼 /v1/messages） */
const rootUrl = computed(() => `http://${bindAddr.value}:${lgw.snapshot?.port || 9527}`);
/** OpenAI 兼容地址（客户端填到 /v1 为止） */
const base = computed(() => `${rootUrl.value}/v1`);

/** 端点标签：只列新版真实提供的三条，工具栏保持一行不换行。
 *  ⚠️ 探活端点是 GET /health —— 旧版写的 /healthz 在新版后端里不存在；
 *  Anthropic 的两条（POST /v1/messages、GET /v1/anthropic/models）在「接入与文档」页里单列 */
const endpoints = [
  { key: "chat", text: "POST /v1/chat/completions" },
  { key: "models", text: "GET /v1/models" },
  { key: "health", text: "GET /health" },
] as const;

/** 地址 / 端点快捷复制：点一下整条进剪贴板，图标短暂变对勾 */
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function copyText(text: string, key: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1500);
}

/** 刷新：状态 + 最近 8 条流水 + 近 7 天聚合（store 已把失败降级成空值/ lastError，这里不会被拒） */
async function refresh() {
  if (!lgw.snapshot) loading.value = true;
  try {
    await Promise.all([lgw.refreshStatus(), lgw.refreshLogs({ limit: 8 }), refreshWeek()]);
  } finally {
    loading.value = false;
  }
}

/** 启停：停止前先过一次自研确认弹窗 —— 停网关会让所有客户端立刻连不上，
 *  不能一个误点就停掉。旧版没有这一步，但用自研弹窗补齐，不引 Element Plus 的 MessageBox */
const stopConfirmOpen = ref(false);
function toggleService() {
  if (busy.value) return;
  if (!running.value && !lgw.canStart) {
    localErr.value = "号池还没有在线账号，请先到「号池管家」添加渠道账号，网关才有可用的上游";
    return;
  }
  if (running.value) {
    stopConfirmOpen.value = true;
    return;
  }
  void doToggle(true);
}
async function doToggle(enable: boolean) {
  if (busy.value) return;
  busy.value = true;
  stopConfirmOpen.value = false;
  localErr.value = "";
  try {
    const ok = await lgw.toggle(enable);
    if (!ok) localErr.value = lgw.lastError || (enable ? "启动失败" : "停止失败");
    await refresh();
  } finally {
    busy.value = false;
  }
}

/** 今日核心指标 4 格（旧版是 今日请求 / 今日 Token / 成功率 / TTFT 均值；
 *  新版没有 TTFT 采集，末格换成延时分位里的平均值） */
const kpis = computed(() => {
  const s = lgw.snapshot;
  const req = s?.todayReq || 0;
  // errRate 后端给的是 0~1 的比例（errCount / todayReq），成功率 = 1 - errRate。
  // 今日零请求时 errRate 恒为 0，直接显示 "100.0%" 会被读成「今天全成功」，所以给 —。
  const successRate = req > 0 ? `${((1 - (s?.errRate || 0)) * 100).toFixed(1)}%` : "—";
  return [
    { label: "今日请求", value: fmtInt(req), acc: true },
    { label: "今日 Token", value: fmtK(s?.todayTokens || 0), acc: false },
    { label: "成功率", value: successRate, acc: false },
    { label: "平均延迟", value: fmtMs(lgw.pot?.avgMs || 0), acc: false },
  ];
});

// ===== 近 7 天用量（区间口径）=====
// 原「渠道余量卡」已撤掉：余额 / 可用账号数属于号池管家的职责，总览页再摆一份既重复
// 又和「号池页的余额」抢同一屏注意力；腾出的位置给真正需要常看的「近 7 天用量」。
//
// 数据源与「用量统计」页**完全同一个接口**（localgw_stats_overview：只读 localgw_logs 现算聚合），
// 本页只消费它的 kpis 六项，绝不自己扫流水再算一份——口径一旦分叉，两页数字就会互相打脸。
const week = ref<LocalgwStatsOverview["kpis"] | null>(null);
const weekFrom = ref(0);
const weekTo = ref(0);
const weekLoading = ref(false);

/** 7 天聚合的拉取节流：这是一次区间扫描，5s 轮询没必要重扫（用量统计页有请求落账事件驱动，
 *  总览这里「激活即刷 + 30s 兜底」已经够）；in-flight 去重避免首屏两处调用并发打两次 */
const WEEK_TTL_MS = 30_000;
let weekAt = 0;
let weekInflight: Promise<void> | null = null;

function refreshWeek(force = false): Promise<void> {
  if (weekInflight) return weekInflight;
  if (!force && Date.now() - weekAt < WEEK_TTL_MS) return Promise.resolve();
  const p = (async () => {
    if (!week.value) weekLoading.value = true;
    try {
      const ov = await localgwStatsOverview({ range: "7d" });
      week.value = ov.kpis;
      weekFrom.value = Number(ov.from) || 0;
      weekTo.value = Number(ov.to) || 0;
      weekAt = Date.now();
    } catch {
      // 失败保留上一次结果：统计卡不该因为一次 IPC 抖动被擦成空白（真错误由 store 的横幅展示）
    } finally {
      weekLoading.value = false;
      weekInflight = null;
    }
  })();
  weekInflight = p;
  return p;
}

/** 区间文案：优先用后端回显的 from/to（它就是这份数据的真实区间），拿不到才退回落文案 */
function md(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const weekLabel = computed(() => (weekFrom.value && weekTo.value ? `${md(weekFrom.value)} ~ ${md(weekTo.value)}` : "最近 7 天"));

/** 去「用量统计」页看完整区间 / 趋势 / 渠道分布 / 明细（同模块内切页） */
function goStats() {
  app.setPage("stats");
}

/** 实时请求流：8 列照旧版。⚠️ 新版日志没有「路径」与「TTFT」字段，
 *  两列一律显示 -（表头与卡片标题里注明），绝不按旧版硬编成 /v1/chat/completions */
const recent = computed(() => lgw.logs.slice(0, 8));

/** 状态 → 旧版四态 pill：success=ok / error=err / cancelled=warn；未知落 blue */
function statusPill(s: string) {
  return s === "success" ? "ok" : s === "error" ? "err" : s === "cancelled" ? "warn" : "blue";
}
function statusText(s: string) {
  return s === "success" ? "成功" : s === "error" ? "失败" : s === "cancelled" ? "已取消" : s || "-";
}

/** 快速上手四步 + 每步的问号提示（地址随监听端口实时联动） */
const steps = computed<{ id: string; title: string; desc: string; link?: boolean }[]>(() => [
  { id: "start", title: "启动网关服务", desc: "点页面上方的服务开关，状态变为 RUNNING 即可开始接收请求。" },
  { id: "key", title: "生成一个 API Key", desc: "到「API Keys」页点“生成 Key”，立刻复制保存好。", link: true },
  { id: "base", title: "记下接入地址", desc: `就是上方地址条里的 Base URL，当前为 ${base.value}。` },
  { id: "model", title: "在客户端填三项", desc: "接入地址、API Key、模型名，填完用下面的示例先发一条测试。" },
]);
const tips: Record<string, string> = {
  start: "启动后网关才开始转发；端口与绑定地址在「设置 · 本地网关」修改，改完需重启服务。",
  // ⚠️ 与旧版口径的关键差异：新版完整 Key 只在创建响应里出现一次，列表只留前缀，
  //    所以这里绝不能写「可随时在 Key 列表里查看完整 Key」
  key: "API Key 是访问网关的密码。完整 Key 只在创建时出现一次，列表只留前缀 —— 请立刻保存，丢了只能吊销重建。",
  base: "OpenAI 兼容地址，支持「自定义 OpenAI 接口」的软件可直接填用。默认仅本机可访问，局域网访问需在设置里改绑定地址。",
  model: "模型名要填「模型目录」里实际提供的名称，填错会报 model not found / 404。",
};
const openHint = ref<string | null>(null);
function toggleHint(id: string) {
  openHint.value = openHint.value === id ? null : id;
}
function closeHint() {
  openHint.value = null;
}

/** 去 API Keys 页生成 Key（同模块内切页，setPage 即可） */
function goKeys() {
  app.setPage("keys");
}

const exTab = ref<"curl" | "py" | "app">("curl");
/** 示例里的模型名取「模型目录」第一条真实模型，拉不到才回落占位文案 —— 不硬编一个可能不存在的模型 */
const exampleModel = computed(() => lgw.models[0]?.display || "deepseek-v4-flash");
const curlCmd = computed(
  () =>
    `curl ${base.value}/chat/completions \\\n` +
    `  -H "Authorization: Bearer sk-你的Key" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"${exampleModel.value}","messages":[{"role":"user","content":"你好"}]}'`,
);
const pyCmd = computed(
  () =>
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    base_url="${base.value}",  # 网关地址，以 /v1 结尾\n` +
    `    api_key="sk-你的Key",\n` +
    `)\n` +
    `resp = client.chat.completions.create(\n` +
    `    model="${exampleModel.value}",\n` +
    `    messages=[{"role": "user", "content": "你好"}],\n` +
    `)\n` +
    `print(resp.choices[0].message.content)`,
);

/** 本页是否处于前台：页面经 v-show 保活，切走后轮询必须停下来，
 *  否则总览在后台持续拉数据重渲染，挤占前台页的每一帧 */
const active = computed(() => app.activeModule === "localgw" && app.activePage === "dashboard");

// 轮询防重入：refresh 在跑时再触发只补一次，不叠加并发（5s 轮询 + 手动刷新共用同一条链路）
const scheduleRefresh = coalesceAsync(refresh, 1000);

let pollTimer: ReturnType<typeof setInterval> | undefined;
function startPoll() {
  stopPoll(); // 先清旧轮询再建，快速来回切页不会叠出多个 interval
  pollTimer = setInterval(scheduleRefresh, 5000);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

watch(active, (on) => {
  if (on) {
    void refresh();
    startPoll();
  } else {
    stopPoll();
    scheduleRefresh.cancel();
  }
});

onMounted(async () => {
  // loadAll = 状态 + 渠道 + 密钥 + 延时分位；日志 / 模型目录 / 近 7 天聚合它不管，这里补上
  await Promise.all([lgw.loadAll(), lgw.refreshLogs({ limit: 8 }), lgw.refreshModels(), refreshVault(), refreshWeek()]);
  if (active.value) startPoll();
  document.addEventListener("click", closeHint);
});
onUnmounted(() => {
  stopPoll();
  scheduleRefresh.cancel();
  clearTimeout(copiedTimer);
  document.removeEventListener("click", closeHint);
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">
          {{ err }}
          <button class="btn-link btn-sm" style="margin-left: 8px" @click="dismissErr">知道了</button>
        </div>
      </div>
      <!-- 后端通道未接入：store 保持 backendReady=false 并给出兜底快照。
           文案只留结论（谁没接上 + 会不会自愈），实现细节不往用户面前堆 -->
      <div v-if="!lgw.backendReady" class="card">
        <div class="set-desc">后端通道未接入：主进程尚未注册 localgw IPC。本页状态与流水为空属正常，接入后自动恢复。</div>
      </div>

      <!-- 页头工具栏：地址条 / 端点 / 安全徽章与状态、服务开关排成一行 -->
      <div class="toolbar">
        <el-tooltip :content="`点击复制：${base}`" placement="top">
          <button class="pill mono copy-chip" @click="copyText(base, 'base')">
            {{ base }}<i class="ph" :class="copied === 'base' ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>
        <el-tooltip v-for="ep in endpoints" :key="ep.key" :content="`点击复制：${ep.text}`" placement="top">
          <button class="tag tag-dim copy-chip" @click="copyText(ep.text, ep.key)">
            {{ ep.text }}<i class="ph" :class="copied === ep.key ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>
        <!-- 安全徽章：只在真拿到 proxy_vault_status 时渲染（旧版这里是 DPAPI 徽章） -->
        <span v-if="vault" class="tag" :class="vault.encrypted ? 'tag-ok' : 'tag-warn'">
          {{ vault.encrypted ? `凭证加密（${vault.driver || "本地凭证库"}）` : "凭证加密不可用" }}
        </span>
        <span class="toolbar-right">
          <!-- 服务状态徽章：样式在 src/styles/localgw.css 的 .lgw-svc-*（与「接入与文档」页共用）。
               不用全局 .pill + .dot：那套的涟漪色缺省是主绿，停服时会渲染成「灰点 + 绿涟漪」，
               与真实状态相反。RUNNING = 绿点（--accent）；STOPPED = 红点 + 红色涟漪（--danger）。 -->
          <span class="lgw-svc-state" :class="running ? 'is-on' : 'is-off'">
            <span class="lgw-svc-dot" aria-hidden="true"></span>
            <span class="lgw-svc-text">{{ running ? "RUNNING" : "STOPPED" }}</span>
          </span>
          <button class="btn" :class="running ? 'btn-stop' : 'btn-primary'" :disabled="busy" @click="toggleService">
            {{ busy ? "处理中…" : running ? "停止服务" : "启动服务" }}
          </button>
        </span>
      </div>

      <!-- 顶部 4 张卡：label 与数值同一行（横向），高度低于全局 .kpi 的上下两行版式。
           覆盖只写在组件 scoped 里，global.css 的 .kpi 不动（另有 5 处页面在用） -->
      <div class="kpis lgw-kpis-inline">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <span>{{ k.label }}</span><b :class="{ acc: k.acc }">{{ k.value }}</b>
        </div>
      </div>

      <!-- 近 7 天用量：原「渠道余量卡」的位置。
           区块头给出真实区间（后端回显的 from/to，不是前端自己推的）与去统计页的入口，
           六张卡本体交给 UsageKpiGrid —— 与「用量统计」页共用同一个组件，口径与版式都只有一份。
           头与卡包一层 .week-block：页面级的 12px 区块间距对「标题-内容」太松，这里收紧到 8px -->
      <div class="week-block">
        <div class="sec-head">
          <span class="sec-title">近 7 天用量</span>
          <span class="sec-hint">{{ weekLabel }}</span>
          <span class="sec-spacer"></span>
          <button class="btn-link" @click="goStats">查看用量统计 →</button>
        </div>
        <UsageKpiGrid :kpis="week" :loading="weekLoading" />
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          实时请求流 <span class="right">最近 {{ recent.length }} 条 · 路径 / TTFT 未采集</span>
        </div>
        <div class="table-scroll">
          <table class="table table-bare">
            <thead>
              <tr>
                <th>时间</th>
                <th title="新版请求日志未记录路径字段（旧版此处硬编为 /v1/chat/completions）">路径</th>
                <th>模型</th>
                <th>KEY</th>
                <th>渠道</th>
                <th>状态</th>
                <th title="新版请求日志未采集 TTFT（首字延迟），该列显示 -，不做替位">TTFT</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              <!-- 加载中骨架屏 -->
              <template v-if="loading && !recent.length">
                <tr v-for="n in 5" :key="'sk-' + n">
                  <td><div class="skeleton" style="height: 18px; width: 60px"></div></td>
                  <td><div class="skeleton" style="height: 18px; width: 140px"></div></td>
                  <td><div class="skeleton" style="height: 18px; width: 90px"></div></td>
                  <td><div class="skeleton" style="height: 18px; width: 80px"></div></td>
                  <td><div class="skeleton" style="height: 18px; width: 60px"></div></td>
                  <td><div class="skeleton" style="height: 18px; width: 50px"></div></td>
                  <td style="text-align: right"><div class="skeleton" style="height: 18px; width: 45px; margin-left: auto"></div></td>
                  <td style="text-align: right"><div class="skeleton" style="height: 18px; width: 45px; margin-left: auto"></div></td>
                </tr>
              </template>
              <!-- 空状态 -->
              <tr v-else-if="!recent.length">
                <td colspan="8" style="text-align: center; color: var(--text-3); padding: 24px 0">
                  暂无请求记录 —— 用上方地址发起第一个请求即出现在这里
                </td>
              </tr>
              <!-- 数据行 -->
              <template v-else>
                <tr v-for="(r, i) in recent" :key="r.id" :style="{ '--i': i }">
                  <td class="mono">{{ fmtTime(r.ts) }}</td>
                  <td class="mono" style="color: var(--text-3)">-</td>
                  <td class="mono">{{ r.model || "-" }}</td>
                  <td class="mono">{{ r.apiKeyPrefix || "-" }}</td>
                  <td>{{ r.channel || "-" }}</td>
                  <td>
                    <span class="pill" :class="statusPill(r.status)">{{ statusText(r.status) }}</span>
                  </td>
                  <td class="mono num" style="text-align: right">-</td>
                  <td class="mono num" style="text-align: right">{{ fmtMs(r.ms) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">快速上手 <span class="right">四步完成接入</span></div>
        <div class="steps">
          <div v-for="(s, i) in steps" :key="s.id" class="step">
            <span class="step-no">{{ i + 1 }}</span>
            <div class="step-main">
              <div class="step-t">
                {{ s.title }}
                <span class="qwrap">
                  <span class="qmark" :class="{ on: openHint === s.id }" @click.stop="toggleHint(s.id)">?</span>
                  <span v-if="openHint === s.id" class="qpop" @click.stop>{{ tips[s.id] }}</span>
                </span>
              </div>
              <div class="step-d">
                {{ s.desc }}
                <button v-if="s.link" class="step-link" @click="goKeys">去生成 →</button>
              </div>
            </div>
          </div>
        </div>
        <!-- 示例切换：用全站 .chip（与用量统计页的档位切换同一套），不再自带 .ex-tab -->
        <div class="ex-tabs">
          <button class="chip" :class="{ active: exTab === 'curl' }" @click="exTab = 'curl'">curl 命令</button>
          <button class="chip" :class="{ active: exTab === 'py' }" @click="exTab = 'py'">Python（OpenAI SDK）</button>
          <button class="chip" :class="{ active: exTab === 'app' }" @click="exTab = 'app'">桌面客户端</button>
          <span class="ex-note">
            把 <b>sk-你的Key</b> 换成第 2 步生成的 Key<span class="qwrap">
              <span class="qmark" :class="{ on: openHint === 'replace' }" @click.stop="toggleHint('replace')">?</span>
              <span v-if="openHint === 'replace'" class="qpop">
                示例里的 Key 与模型名都是占位符，换成真实值才能跑通；完整 Key 只在生成时出现一次。
              </span>
            </span>
          </span>
        </div>
        <div v-if="exTab === 'curl'" class="code">{{ curlCmd }}</div>
        <div v-if="exTab === 'py'" class="code">{{ pyCmd }}</div>
        <ol v-if="exTab === 'app'" class="app-steps">
          <li>打开客户端的「设置 → 模型服务」，点「添加」，选择 <b>OpenAI 兼容 / 自定义</b> 类型。</li>
          <li>API 地址：填上方第 3 步的 Base URL（以 <b>/v1</b> 结尾；个别客户端只要求填到端口，按它的提示来）。</li>
          <li>API Key：填第 2 步生成的 <b>sk-</b> 开头的 Key。</li>
          <li>模型：手动输入模型名（以「模型目录」页实际提供的为准），保存后发一句话测试。</li>
        </ol>
      </div>
    </div>

    <!-- 停止服务确认（自研弹窗，与 Keys 页同一套 .p-mask / .p-dlg 版式） -->
    <Teleport to="body">
      <div v-if="stopConfirmOpen" class="p-mask" @click.self="stopConfirmOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">停止本地网关</div>
          <div class="set-desc">
            停止后所有通过该网关的 API 调用都会失败（客户端连不上 {{ base }}），已发出的请求不会重试。确认停止？
          </div>
          <div class="p-actions">
            <button class="btn" @click="stopConfirmOpen = false">取消</button>
            <button class="btn danger-solid" :disabled="busy" @click="doToggle(false)">{{ busy ? "处理中…" : "停止服务" }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：地址条 / 端点 / 安全徽章与状态、开关固定一行，不换行
   （.toolbar / .copy-chip / .steps / .qmark 等旧版各页自带的原子类照搬自 ProxyHomeView 的 <style scoped>） */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.toolbar-right {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* ===== 顶部 4 张 KPI 卡：单行横排 =====
   全局 .kpi b 是 display:block（label 一行、数值一行），这里 scoped 覆盖成
   「label 左 / 数值右」同一行，并把内边距与字号收一档，卡片高度明显下降。
   ⚠️ 只覆盖 .lgw-kpis-inline 下的 .kpi，不动 global.css 的 .kpi（另有 5 处页面在用） */
.lgw-kpis-inline .kpi {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 13px 8px;
}
.lgw-kpis-inline .kpi span {
  font-size: 11.5px;
  white-space: nowrap;
}
.lgw-kpis-inline .kpi b {
  display: inline;
  margin-top: 0;
  font-size: 17px;
  line-height: 1.15;
  letter-spacing: -0.4px;
  white-space: nowrap;
}
/* 窄屏：4 列挤成 2 列后 label 与数值仍要同一行，不被压成两行 */
@media (max-width: 720px) {
  .lgw-kpis-inline .kpi {
    gap: 6px;
  }
  .lgw-kpis-inline .kpi b {
    font-size: 15px;
  }
}
/* 地址 / 端点快捷复制：悬停点亮，点击后图标短暂变对勾 */
.copy-chip {
  cursor: pointer;
  border: 1px solid transparent;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.copy-chip .ph {
  font-size: 11px;
  margin-left: 2px;
  opacity: 0.5;
}
.copy-chip:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
}
.copy-chip:hover .ph {
  opacity: 1;
}
/* 停止服务用危险色描边，与启动服务的实心主色形成状态区分 */
.btn-stop {
  color: var(--danger);
}
.btn-stop:hover {
  border-color: var(--danger);
  background: var(--danger-dim);
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

/* ===== 快速上手 ===== */
.steps {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.step-no {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.step-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.step-d {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 2px;
}
.step-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-strong);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.step-link:hover {
  text-decoration: underline;
}

/* 问号徽章 + 点击气泡 */
.qwrap {
  position: relative;
  display: inline-flex;
}
.qmark {
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--text-3);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.qmark:hover,
.qmark.on {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
}
.qpop {
  position: absolute;
  top: calc(100% + 7px);
  left: -10px;
  z-index: 30;
  width: 250px;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg-soft);
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.55);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.65;
  white-space: normal;
  animation: qpop-in 0.16s ease-out;
}
@keyframes qpop-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

/* 示例切换：切换按钮本身走全站 .chip，这里只管这一行的排布与右侧说明 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ex-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ex-note b {
  color: var(--text-2);
  font-weight: 600;
}

/* 客户端配置步骤 */
.app-steps {
  margin: 0;
  padding: 11px 13px 11px 28px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  display: grid;
  gap: 6px;
}
.app-steps b {
  color: var(--text);
  font-weight: 600;
}

/* ===== 近 7 天用量区块头 =====
   与卡片同为一行：左「标题 + 区间」，右侧「去统计页」入口；区间用等宽字，
   与卡内的数字同一套字体，扫读时不会因为字体跳变而断行 */
.week-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sec-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sec-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.sec-hint {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.sec-spacer {
  flex: 1;
}
</style>
