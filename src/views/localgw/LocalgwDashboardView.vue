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
<!-- 本地网关 · 总览：地址 / 端点 / 安全徽章 + 服务开关 / 今日核心指标 / 渠道一览 / 实时请求流 / 快速上手
     页面形式照搬 fdb3e55^ 的旧版反代网关总览（ProxyHomeView.vue 的 template 顺序：
     err-card → toolbar → kpis → agent-cards-grid → 实时请求流 → 快速上手），
     数据源全部换成现在的实现：网关自身指标走 useLocalgwStore（localgw_* 通道），
     渠道与余额只读复用号池管家，不另建一套账号模型（方案 §4.1）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { proxyVaultStatus } from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { coalesceAsync } from "../../utils/timing";
// 格式化口径与号池管家同源：余额单位（zcode=Tokens / qoder·cline=浮点 Credits / accio=百分比）
// 是号池自己的展示约定，本地网关再抄一份必然走形，所以直接复用同一份实现。
import { balanceUnit, fmtBalance, fmtInt, fmtK, fmtMs, fmtTime, isQoderChannel } from "../proxy/format";

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

/** 刷新：状态 + 最近 8 条流水（store 已把失败降级成空值/ lastError，这里不会被拒） */
async function refresh() {
  if (!lgw.snapshot) loading.value = true;
  try {
    await Promise.all([lgw.refreshStatus(), lgw.refreshLogs({ limit: 8 })]);
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

/** 渠道卡（号池只读）：id / display / accountCount / onlineCount / totalCredits */
const channelCards = computed(() => lgw.channels);

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
  start: "服务启动后网关才开始转发请求；监听端口和绑定地址在「设置 · 本地网关」里修改，改完需要重启服务。",
  // ⚠️ 与旧版口径的关键差异：新版完整 Key 只在创建响应里出现一次，列表只留前缀，
  //    所以这里绝不能写「可随时在 Key 列表里查看完整 Key」
  key: "API Key 相当于访问网关的密码。为了安全，完整 Key 只在创建响应里出现一次，列表里只留前缀——生成后请立刻保存，丢了就吊销重建一个。",
  base: "这是 OpenAI 兼容地址——所有支持“自定义 OpenAI 接口”的软件都能直接填用，不需要装任何插件。默认只监听本机，局域网其他设备访问需要在设置里改绑定地址。",
  model: "模型名必须填网关渠道实际提供的名称（在「模型目录」页能看到），填了不存在的名称会报 model not found / 404。",
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
  // loadAll = 状态 + 渠道 + 密钥 + 延时分位；日志与模型目录它不管，这里补上
  await Promise.all([lgw.loadAll(), lgw.refreshLogs({ limit: 8 }), lgw.refreshModels(), refreshVault()]);
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
      <!-- 后端通道未接入：store 保持 backendReady=false 并给出兜底快照，
           页面把原因说清楚，而不是让用户对着一片空数据猜 -->
      <div v-if="!lgw.backendReady" class="card">
        <div class="set-desc">
          后端通道未接入 —— 主进程还没注册 localgw IPC 通道（electron/main.cjs 里
          <code class="mono">lgw.register(ipcMain); lgw.boot();</code>），
          本页状态与流水为空属正常，接入后自动恢复。
        </div>
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
          <span class="pill">
            <span class="dot" :class="{ off: !running }"></span>{{ running ? "RUNNING" : "STOPPED" }}
          </span>
          <button class="btn" :class="running ? 'btn-stop' : 'btn-primary'" :disabled="busy" @click="toggleService">
            {{ busy ? "处理中…" : running ? "停止服务" : "启动服务" }}
          </button>
        </span>
      </div>

      <div class="kpis">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <span>{{ k.label }}</span><b :class="{ acc: k.acc }">{{ k.value }}</b>
        </div>
      </div>

      <!-- 渠道一览（号池只读）：可用数 + 余额大数字，与旧版同一版式 -->
      <div class="agent-cards-grid">
        <div v-for="c in channelCards" :key="c.id" class="card">
          <div class="card-title">
            {{ c.display }}
            <span class="tag" :class="c.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
              {{ c.accountCount ? `${c.onlineCount}/${c.accountCount} 可用` : "未配置" }}
            </span>
          </div>
          <div style="display: flex; align-items: baseline; gap: 8px">
            <el-tooltip
              :content="c.id === 'zcode' ? `${fmtInt(c.totalCredits)} Tokens` : isQoderChannel(c.id) ? `${c.totalCredits} Credits（精确值）` : ''"
              :disabled="c.id !== 'zcode' && !isQoderChannel(c.id)"
              placement="top"
            >
              <b class="big-num">{{ fmtBalance(c.totalCredits, c.id) }}</b>
            </el-tooltip>
            <span style="font-size: 11px; color: var(--text-3)">{{ balanceUnit(c.id) }}</span>
          </div>
          <div class="rows" style="margin-top: 6px">
            <div class="row">
              <div class="grow"><div class="name">今日请求 / Token</div></div>
              <!-- 号池 summary 里有今日口径的按渠道数据，但 store 的 channels 只收敛了
                   账号数与余额三项（不扩契约），所以这里只给可用账号数，不编造今日流量 -->
              <span class="num">{{ c.onlineCount }} / {{ c.accountCount }} 账号</span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="!channelCards.length" class="set-desc">
        号池暂无渠道 —— 先到「号池管家」添加渠道账号，网关才有可用的上游。
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          实时请求流 <span class="right">最近 {{ recent.length }} 条 · 路径 / TTFT 新版未采集，显示 -</span>
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
        <div class="ex-tabs">
          <button class="ex-tab" :class="{ on: exTab === 'curl' }" @click="exTab = 'curl'">curl 命令</button>
          <button class="ex-tab" :class="{ on: exTab === 'py' }" @click="exTab = 'py'">Python（OpenAI SDK）</button>
          <button class="ex-tab" :class="{ on: exTab === 'app' }" @click="exTab = 'app'">桌面客户端</button>
          <span class="ex-note">
            把 <b>sk-你的Key</b> 换成第 2 步生成的 Key<span class="qwrap">
              <span class="qmark" :class="{ on: openHint === 'replace' }" @click.stop="toggleHint('replace')">?</span>
              <span v-if="openHint === 'replace'" class="qpop">
                示例里的"sk-你的Key"和模型名都是占位符，替换成你自己的真实值才能跑通。
                完整 Key 只在生成时出现一次，请提前保存好。
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
.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
}
.pill .dot.off {
  background: var(--text-3);
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
.big-num {
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  letter-spacing: -1px;
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

/* 示例 tab 切换 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ex-tab {
  display: inline-flex;
  align-items: center;
  height: var(--ctl-h-sm);
  padding: 0 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.28s var(--ease-spring), box-shadow 0.25s;
}
.ex-tab:hover {
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.22);
  transform: scale(1.05);
  box-shadow: 0 0 12px -4px var(--accent-line);
}
.ex-tab.on {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
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

/* 渠道卡自适应网格，避免多渠道落单孤立 */
.agent-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
@media (min-width: 1080px) {
  .agent-cards-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
