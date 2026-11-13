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
<!-- 本地网关 · 接入与文档：地址 / 端点 / 快速上手 / API Key / 客户端片段 / 协议兼容
     页面形式照搬 fdb3e55^ 旧版反代网关总览里的「快速上手」卡（ProxyHomeView.vue 行 290-327：
     .steps 四步 + 问号气泡 + 三档示例切换 + .code 示例 + .app-steps 客户端步骤），
     示例切换按钮已从页内自带的 .ex-tab 换成全站 .chip（与用量统计页的档位切换同一套），
     数据源换成现在的实现（useLocalgwStore + 号池只读渠道）。

     ⚠️ 端点事实（新版后端 server.cjs 实际提供的路由，不要照抄旧版）：
       GET  /health                  ← 旧版写的是 /healthz，新版不存在
       POST /v1/chat/completions
       GET  /v1/models
       POST /v1/messages             ← Anthropic 系
       GET  /v1/anthropic/models     ← Anthropic 系
     新版没有 /v1/responses，也不支持 Google Gemini 协议。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { coalesceAsync } from "../../utils/timing";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 页面级错误 + store 的 lastError 合成一条文案 */
const localErr = ref("");
const err = computed(() => localErr.value || lgw.lastError);
function dismissErr() {
  localErr.value = "";
  lgw.clearError();
}

/** 监听 0.0.0.0 / :: 是「所有网卡」而不是可连的地址，客户端必须用回环地址连自己 */
const bindAddr = computed(() => {
  const b = lgw.snapshot?.bind || "127.0.0.1";
  return b === "0.0.0.0" || b === "::" || b === "[::]" ? "127.0.0.1" : b;
});
/** 根地址（不含 /v1）：Anthropic 系客户端要填这个，它们自己拼 /v1/messages */
const rootUrl = computed(() => `http://${bindAddr.value}:${lgw.snapshot?.port || 9527}`);
/** OpenAI 兼容端点前缀：客户端要填到 /v1 为止 */
const base = computed(() => `${rootUrl.value}/v1`);
const running = computed(() => !!lgw.snapshot?.running);
/** 监听全网卡时的风险提示（方案 §7 安全口径：默认只监听回环） */
const exposedToLan = computed(() => {
  const b = lgw.snapshot?.bind || "";
  return b === "0.0.0.0" || b === "::" || b === "[::]";
});

/** 地址 / 端点快捷复制：点一下整条进剪贴板，图标短暂变对勾 */
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function copyText(text: string, key: string) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1500);
}

/** 端点清单：工具栏放常用的三条，全量（含 Anthropic 两条）在下方「协议兼容」卡里列全 */
const endpoints = [
  { key: "chat", text: "POST /v1/chat/completions" },
  { key: "models", text: "GET /v1/models" },
  { key: "health", text: "GET /health" },
] as const;
const endpointRows = [
  { method: "GET", path: "/health", note: "探活（新版是 /health，不是旧版的 /healthz）" },
  { method: "POST", path: "/v1/chat/completions", note: "OpenAI 兼容对话补全" },
  { method: "GET", path: "/v1/models", note: "OpenAI 兼容模型清单" },
  { method: "POST", path: "/v1/messages", note: "Anthropic Messages（Claude Code 等）" },
  { method: "GET", path: "/v1/anthropic/models", note: "Anthropic 模型清单" },
];

/** 当前 API Key：默认选第一个有效 Key —— 否则下拉框显示占位文案，
 *  而下面的示例片段已经在用这个 Key，前后对不上 */
const activeKeys = computed(() => lgw.keys.filter((k) => k.status === "active"));
const activeKeyId = ref("");
const currentKey = computed(() => activeKeys.value.find((k) => k.id === activeKeyId.value) || activeKeys.value[0]);

/** 快速上手四步 + 每步的问号提示（地址随监听端口实时联动） */
const steps = computed<{ id: string; title: string; desc: string; link?: boolean }[]>(() => [
  { id: "start", title: "启动网关服务", desc: "到「总览」点服务开关，状态变为 RUNNING 即可开始接收请求。" },
  { id: "key", title: "生成一个 API Key", desc: "到「API Keys」页点“生成 Key”，之后可随时在列表复制。", link: true },
  { id: "base", title: "记下接入地址", desc: `就是上方地址条里的 Base URL，当前为 ${base.value}。` },
  { id: "model", title: "在客户端填三项", desc: "接入地址、API Key、模型名，填完用下面的示例先发一条测试。" },
]);
const tips: Record<string, string> = {
  start: "启动后网关才开始转发；端口与绑定地址在「设置 · 本地网关」修改，改完需重启服务。",
  // 口径（2026-11-03 修正）：完整 Key 加密存库，列表可随时查看 / 复制，不存在「只出现一次」
  key: "API Key 是访问网关的密码。完整 Key 经系统凭据加密留存，可随时在「API Keys」页查看 / 复制；不用了直接停用或删除。",
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
/** 去 API Keys 页生成 Key（同模块内切页） */
function goKeys() {
  app.setPage("keys");
}

/** 模式切换：quick 简约版（快速复制、开箱即用） / detailed 详细版（深入原理解析、完整示例、避坑指南） */
const viewMode = ref<"quick" | "detailed">("quick");

/** 主功能 Tab 分区 */
type AccessTab = "quickstart" | "clients" | "api" | "troubleshooting";
const accessTab = ref<AccessTab>("quickstart");

const exTab = ref<"curl" | "py" | "anthropic" | "node">("curl");
/** 示例里的模型名取「模型目录」第一条真实模型，拉不到才回落占位文案 —— 不硬编一个可能不存在的模型 */
const exampleModel = computed(() => lgw.models[0]?.display || "deepseek-v4-flash");

const curlCmd = computed(() =>
  `curl ${base.value}/chat/completions \\\n` +
  `  -H "Authorization: Bearer sk-你的Key" \\\n` +
  `  -H "Content-Type: application/json" \\\n` +
  `  -d '{"model":"${exampleModel.value}","messages":[{"role":"user","content":"你好"}],"stream":false}'`
);

const curlStreamCmd = computed(() =>
  `# 流式输出 (Server-Sent Events)\n` +
  `curl ${base.value}/chat/completions -N \\\n` +
  `  -H "Authorization: Bearer sk-你的Key" \\\n` +
  `  -H "Content-Type: application/json" \\\n` +
  `  -d '{"model":"${exampleModel.value}","messages":[{"role":"user","content":"讲个简短笑话"}],"stream":true}'`
);

const pyCmd = computed(() =>
  `from openai import OpenAI\n\n` +
  `client = OpenAI(\n` +
  `    base_url="${base.value}",  # 本地网关地址，以 /v1 结尾\n` +
  `    api_key="sk-你的Key",\n` +
  `)\n\n` +
  `resp = client.chat.completions.create(\n` +
  `    model="${exampleModel.value}",\n` +
  `    messages=[{"role": "user", "content": "你好"}],\n` +
  `)\n` +
  `print(resp.choices[0].message.content)`
);

const pyStreamCmd = computed(() =>
  `from openai import OpenAI\n\n` +
  `# 详细版：带流式输出与异常捕获\n` +
  `client = OpenAI(\n` +
  `    base_url="${base.value}",\n` +
  `    api_key="sk-你的Key",\n` +
  `    timeout=60.0,\n` +
  `)\n\n` +
  `try:\n` +
  `    stream = client.chat.completions.create(\n` +
  `        model="${exampleModel.value}",\n` +
  `        messages=[{"role": "user", "content": "写一首五言绝句"}],\n` +
  `        stream=True,\n` +
  `    )\n` +
  `    for chunk in stream:\n` +
  `        text = chunk.choices[0].delta.content or ""\n` +
  `        print(text, end="", flush=True)\n` +
  `    print()\n` +
  `except Exception as e:\n` +
  `    print(f"请求发生异常: {e}")`
);

const anthropicPyCmd = computed(() =>
  `import anthropic\n\n` +
  `# 注意：Anthropic 协议请填根地址，SDK 会自动追加 /v1/messages\n` +
  `client = anthropic.Anthropic(\n` +
  `    base_url="${rootUrl.value}",\n` +
  `    api_key="sk-你的Key",\n` +
  `)\n\n` +
  `message = client.messages.create(\n` +
  `    model="${exampleModel.value}",\n` +
  `    max_tokens=1024,\n` +
  `    messages=[{"role": "user", "content": "你好"}],\n` +
  `)\n` +
  `print(message.content[0].text)`
);

const nodeCmd = computed(() =>
  `import OpenAI from "openai";\n\n` +
  `const openai = new OpenAI({\n` +
  `  baseURL: "${base.value}",\n` +
  `  apiKey: "sk-你的Key",\n` +
  `});\n\n` +
  `async function main() {\n` +
  `  const completion = await openai.chat.completions.create({\n` +
  `    model: "${exampleModel.value}",\n` +
  `    messages: [{ role: "user", content: "Hello!" }],\n` +
  `  });\n` +
  `  console.log(completion.choices[0].message.content);\n` +
  `}\n` +
  `main();`
);

/** 客户端片段：OpenAI 兼容系填 base（到 /v1），Anthropic 系填根地址 */
const clients = computed(() => {
  const key = currentKey.value?.secret || "<你的Key>";
  return [
    {
      id: "cursor",
      name: "Cursor",
      tag: "OpenAI 兼容",
      path: "Settings → Models → OpenAI API Key & Base URL",
      desc: "在 Cursor 设置中开启 Override OpenAI Base URL 并填入网关地址。",
      snippet: `Base URL: ${base.value}\nAPI Key: ${key}`,
      tip: "建议在 Model Names 中添加「模型目录」中提供的模型名（如 deepseek-v4-flash），并关闭默认的 gpt-4o 等未授权项。",
    },
    {
      id: "claude",
      name: "Claude Code",
      tag: "Anthropic 协议",
      path: "命令行环境变量配置",
      desc: "Anthropic 系官方终端工具，支持高阶自主编程与工具调用。",
      // Anthropic 系客户端会自己在 BASE_URL 后面拼 /v1/messages，必须填根地址
      snippet: `export ANTHROPIC_BASE_URL=${rootUrl.value}\nexport ANTHROPIC_API_KEY=${key}`,
      winSnippet: `$env:ANTHROPIC_BASE_URL="${rootUrl.value}"\n$env:ANTHROPIC_API_KEY="${key}"`,
      tip: "【避坑铁律】必须填不带 /v1 的根地址！若填成 /v1，Claude 会请求 /v1/v1/messages 直接报错 404。",
    },
    {
      id: "continue",
      name: "Continue (VSCode / JetBrains)",
      tag: "OpenAI 兼容",
      path: "~/.continue/config.json",
      desc: "开源全能 AI 编码伴侣，支持智能补全与侧边栏对话。",
      snippet: `"models": [{\n  "title": "AgentHub 本地网关",\n  "provider": "openai",\n  "model": "${exampleModel.value}",\n  "apiBase": "${base.value}",\n  "apiKey": "${key}"\n}]`,
      tip: "也可以在 Continue 的快捷配置菜单选择 OpenAI Provider，填入上述 Base URL 与 Key。",
    },
    {
      id: "cline",
      name: "Cline / Roo Code",
      tag: "OpenAI 兼容",
      path: "插件设置 → API Provider → OpenAI Compatible",
      desc: "VSCode 极其火爆的自主 Agent 编码插件。",
      snippet: `Base URL: ${base.value}\nAPI Key: ${key}\nModel ID: ${exampleModel.value}`,
      tip: "在 Provider 选择「OpenAI Compatible」，Base URL 填入到 /v1 结束即可完美运行。",
    },
    {
      id: "jetbrains",
      name: "JetBrains · AI Assistant",
      tag: "OpenAI 兼容",
      path: "Settings → Tools → AI Assistant → Custom Provider",
      desc: "IntelliJ IDEA / WebStorm / PyCharm 原生集成。",
      snippet: `URL: ${base.value}\nAPI Key: ${key}`,
      tip: "部分旧版 JetBrains 仅需填到端口号，请参考界面输入框下方的示例提示。",
    },
    {
      id: "chatbox",
      name: "Chatbox / NextChat",
      tag: "OpenAI 兼容",
      path: "设置 → 模型服务 → 自定义 OpenAI 接口",
      desc: "常用桌面与 Web 端大模型对话客户端。",
      snippet: `API 域名 (Base URL): ${base.value}\nAPI Key: ${key}\n模型列表: ${exampleModel.value}`,
      tip: "关闭客户端自带的「模型代理探活」或忽略代理警告，填好模型名即可畅快交谈。",
    },
  ];
});

/** 常见问题与排查手册 */
const faqs = [
  {
    q: "请求提示 401 Unauthorized（未授权 / 密钥无效）？",
    a: "1) 检查是否在请求头中提供了有效的 Bearer Token（Authorization: Bearer sk-xxx）或 x-api-key；\n2) 到「API Keys」页检查该 Key 是否处于停用、已删除或已过期状态；\n3) 如果开启了管理员口令或只读口令，请确保口令完全匹配。",
  },
  {
    q: "请求提示 404 Not Found（模型未找到或路由不存在）？",
    a: "1) 检查模型名是否与「模型目录」中提供的「对外模型名」完全一致；\n2) 检查 Base URL 是否多拼或漏拼了 /v1。OpenAI 兼容端点需以 /v1 结尾；Anthropic 客户端（如 Claude Code）必须填根地址（不带 /v1）；\n3) 检查本地网关服务是否已启动（右上角需显示 RUNNING）。",
  },
  {
    q: "请求提示 429 Too Many Requests（超过限流频次）？",
    a: "1) 本地网关对单个 API Key 限制了每分钟请求次数（可在「API Keys」页编辑单 Key 限流或在设置中提高全局阈值）；\n2) 也可能是上游对应渠道的账号触发了官方服务商的并发/频次风控，网关已尝试自动故障转移或报错。",
  },
  {
    q: "请求提示 502 Bad Gateway 或 503 Service Unavailable？",
    a: "1) 检查「号池管家」中对应渠道的账号是否已全部离线、额度耗尽或凭证失效；\n2) 检查该渠道对应的外置执行插件是否处于运行中且已获得授权；\n3) 在「网络代理」中检查上游出站网络连接是否通畅。",
  },
  {
    q: "如何在局域网内的手机或其他电脑上访问本地网关？",
    a: "1) 打开 AgentHub「设置 · 本地网关」，将「绑定地址」从 127.0.0.1 修改为 0.0.0.0 并重启网关；\n2) 在 Windows 防火墙中放行本网关端口（默认 9527）；\n3) 在其他设备的客户端填入本机的局域网 IP（如 http://192.168.1.100:9527/v1）。",
  },
  {
    q: "WSL2 或 Docker 容器内如何连接宿主机的本地网关？",
    a: "在 WSL2 或 Docker 容器中，请勿直接使用 127.0.0.1（它指向容器自身）。请将网关绑定到 0.0.0.0，并在容器内使用宿主机别名：如 http://host.docker.internal:9527/v1，或 WSL 宿主机虚拟网卡 IP。",
  },
];

/** 拉取本页要用的数据：状态 / 密钥 / 模型目录（示例模型名要用真实模型） */
async function refresh() {
  await Promise.all([lgw.refreshStatus(), lgw.refreshKeys(), lgw.refreshModels()]);
  if (!activeKeyId.value) activeKeyId.value = activeKeys.value[0]?.id || "";
}
const scheduleRefresh = coalesceAsync(refresh, 1000);

/** 本页是否处于前台：页面经 v-show 保活，切回本页时补一次刷新 */
const active = computed(() => app.activeModule === "localgw" && app.activePage === "access");
watch(active, (on) => {
  if (on) scheduleRefresh();
});

onMounted(async () => {
  await refresh();
  document.addEventListener("click", closeHint);
});
onUnmounted(() => {
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

      <!-- 监听 0.0.0.0 的安全提示 -->
      <div v-if="exposedToLan" class="card warn-card">
        <div class="set-desc warn-text">
          当前监听 <b>0.0.0.0</b>（局域网内其它设备也能访问本网关）。请确认已为每个客户端单独签发密钥，
          且不需要外部访问时把监听地址改回 <b>127.0.0.1</b>（设置 · 本地网关）。
        </div>
      </div>

      <!-- 页头工具栏：Base URL 复制 / 状态徽章 / 简约与详细版切换 -->
      <div class="toolbar">
        <el-tooltip :content="`点击复制 Base URL：${base}`" placement="top">
          <button class="pill mono copy-chip" @click="copyText(base, 'base')">
            {{ base }}<i class="ph" :class="copied === 'base' ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>
        <el-tooltip v-for="ep in endpoints" :key="ep.key" :content="`点击复制：${ep.text}`" placement="top">
          <button class="tag tag-dim copy-chip" @click="copyText(ep.text, ep.key)">
            {{ ep.text }}<i class="ph" :class="copied === ep.key ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>

        <span class="toolbar-right">
          <!-- 简约版与详细版切换 -->
          <div class="mode-toggle">
            <button
              class="mode-btn"
              :class="{ active: viewMode === 'quick' }"
              @click="viewMode = 'quick'"
            >
              <i class="ph ph-lightning"></i> 简约版
            </button>
            <button
              class="mode-btn"
              :class="{ active: viewMode === 'detailed' }"
              @click="viewMode = 'detailed'"
            >
              <i class="ph ph-book-open"></i> 详细版
            </button>
          </div>

          <!-- 服务状态徽章 -->
          <span class="lgw-svc-state" :class="running ? 'is-on' : 'is-off'">
            <span class="lgw-svc-dot" aria-hidden="true"></span>
            <span class="lgw-svc-text">{{ running ? "RUNNING" : "STOPPED" }}</span>
          </span>
        </span>
      </div>

      <!-- 主板块 Tab 分区切换 -->
      <div class="access-tabs">
        <button
          class="access-tab-btn"
          :class="{ active: accessTab === 'quickstart' }"
          @click="accessTab = 'quickstart'"
        >
          <i class="ph ph-rocket-launch"></i> 快速上手
        </button>
        <button
          class="access-tab-btn"
          :class="{ active: accessTab === 'clients' }"
          @click="accessTab = 'clients'"
        >
          <i class="ph ph-laptop"></i> 客户端接入
        </button>
        <button
          class="access-tab-btn"
          :class="{ active: accessTab === 'api' }"
          @click="accessTab = 'api'"
        >
          <i class="ph ph-code"></i> 协议与端点
        </button>
        <button
          class="access-tab-btn"
          :class="{ active: accessTab === 'troubleshooting' }"
          @click="accessTab = 'troubleshooting'"
        >
          <i class="ph ph-lifebuoy"></i> 故障排查与高级
        </button>
      </div>

      <!-- ===== Tab 1：快速上手 ===== -->
      <template v-if="accessTab === 'quickstart'">
        <!-- 密钥快速选用卡片 -->
        <div class="card">
          <div class="card-title">
            API Key 快速选用
            <span class="right">{{ activeKeys.length }} 个有效密钥</span>
          </div>
          <template v-if="activeKeys.length">
            <div class="set-row">
              <div class="set-info">
                <div class="set-name">当前选用 Key</div>
                <div class="set-desc">点击右侧按钮复制完整 Key；管理与限流请到「API Keys」页</div>
              </div>
              <el-select v-model="activeKeyId" class="f-el-select" popper-class="glass-popper" style="width: 260px">
                <el-option v-for="k in activeKeys" :key="k.id" :value="k.id" :label="`${k.name || '未命名'}（${k.keyPrefix || '—'}…）`" />
              </el-select>
              <button
                class="btn btn-primary"
                :disabled="!currentKey?.secret"
                @click="copyText(currentKey?.secret || '', 'secret')"
              >
                {{ copied === "secret" ? "已复制 Key" : "复制完整 Key" }}
              </button>
            </div>
          </template>
          <div v-else class="set-desc">还没有有效密钥 —— 到「API Keys」页点「生成 Key」创建一个。</div>
        </div>

        <!-- 四步流程 -->
        <div class="card">
          <div class="card-title">
            接入流程
            <span class="right">{{ viewMode === 'quick' ? '简约步骤' : '详细原理解析' }}</span>
          </div>
          <div class="steps">
            <div v-for="(s, i) in steps" :key="s.id" class="step">
              <span class="step-no">{{ i + 1 }}</span>
              <div class="step-main">
                <div class="step-t">
                  {{ s.title }}
                  <span v-if="viewMode === 'detailed'" class="step-badge">核心要点</span>
                </div>
                <div class="step-d">
                  {{ s.desc }}
                  <button v-if="s.link" class="step-link" @click="goKeys">去生成 →</button>
                </div>
                <!-- 详细版展开原理解释与易错提醒 -->
                <div v-if="viewMode === 'detailed'" class="step-detail-box">
                  {{ tips[s.id] }}
                </div>
              </div>
            </div>
          </div>

          <!-- 代码调用示例 -->
          <div class="ex-tabs">
            <button class="chip" :class="{ active: exTab === 'curl' }" @click="exTab = 'curl'">cURL 终端</button>
            <button class="chip" :class="{ active: exTab === 'py' }" @click="exTab = 'py'">Python (OpenAI)</button>
            <button class="chip" :class="{ active: exTab === 'anthropic' }" @click="exTab = 'anthropic'">Python (Anthropic)</button>
            <button class="chip" :class="{ active: exTab === 'node' }" @click="exTab = 'node'">Node.js (OpenAI)</button>
          </div>

          <div class="code-wrap">
            <div class="code-actions">
              <span class="code-tag">{{ exTab.toUpperCase() }} {{ viewMode === 'detailed' ? '流式与异常处理版' : '极简快速版' }}</span>
              <button
                class="btn-link btn-sm"
                @click="copyText(
                  exTab === 'curl' ? (viewMode === 'detailed' ? curlStreamCmd : curlCmd)
                  : exTab === 'py' ? (viewMode === 'detailed' ? pyStreamCmd : pyCmd)
                  : exTab === 'anthropic' ? anthropicPyCmd
                  : nodeCmd,
                  'code-snippet'
                )"
              >
                {{ copied === 'code-snippet' ? '已复制' : '复制代码' }}
              </button>
            </div>
            <pre class="code">{{
              exTab === 'curl' ? (viewMode === 'detailed' ? curlStreamCmd : curlCmd)
              : exTab === 'py' ? (viewMode === 'detailed' ? pyStreamCmd : pyCmd)
              : exTab === 'anthropic' ? anthropicPyCmd
              : nodeCmd
            }}</pre>
          </div>
        </div>
      </template>

      <!-- ===== Tab 2：客户端接入大全 ===== -->
      <template v-else-if="accessTab === 'clients'">
        <div class="card">
          <div class="card-title">
            主流客户端配置指南
            <span class="right">{{ viewMode === 'quick' ? '开箱一键复制' : '含深度踩坑避险' }}</span>
          </div>
          <div class="cli-grid">
            <div v-for="c in clients" :key="c.id" class="cli-card">
              <div class="cli-head">
                <div class="cli-title-box">
                  <b>{{ c.name }}</b>
                  <span class="tag tag-dim">{{ c.tag }}</span>
                </div>
                <button class="btn-link btn-sm" @click="copyText(c.snippet, c.id)">
                  {{ copied === c.id ? "已复制" : "复制配置" }}
                </button>
              </div>
              <div class="cli-path">{{ c.path }}</div>
              <pre class="code">{{ c.snippet }}</pre>

              <!-- 详细版：展示深入提示与踩坑指南 -->
              <div v-if="viewMode === 'detailed'" class="cli-deep-tip">
                <div class="cdt-title"><i class="ph ph-warning-circle"></i> 配置要点与避坑</div>
                <div class="cdt-desc">{{ c.tip }}</div>
                <div v-if="c.winSnippet" class="cdt-powershell">
                  <div class="cdt-ps-title">PowerShell 环境变量命令：</div>
                  <pre class="code">{{ c.winSnippet }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ===== Tab 3：协议与端点规范 ===== -->
      <template v-else-if="accessTab === 'api'">
        <div class="card">
          <div class="card-title">
            支持的协议与端点清单
            <span class="right">完全兼容标准上游客户端</span>
          </div>
          <div class="rows">
            <div v-for="ep in endpointRows" :key="ep.method + ep.path" class="row">
              <div class="grow">
                <div class="name mono">{{ ep.method }} {{ ep.path }}</div>
                <div class="sub">{{ ep.note }}</div>
              </div>
              <span class="tag tag-dim mono">{{ ep.method }}</span>
            </div>
          </div>

          <!-- 详细版：协议规范与鉴权报文解析 -->
          <div v-if="viewMode === 'detailed'" class="api-deep-spec">
            <div class="card-title" style="margin-top: 16px; margin-bottom: 8px">
              鉴权与 Header 规范
            </div>
            <div class="set-desc" style="line-height: 1.8">
              • <b>Bearer 授权</b>：标准的 <code class="mono">Authorization: Bearer sk-xxx</code> 头。<br />
              • <b>x-api-key 兼容</b>：Anthropic 客户端或部分专有工具发送的 <code class="mono">x-api-key: sk-xxx</code> 头自动识别，两者任选其一。<br />
              • <b>模型转发机制</b>：接收客户端请求中的 <code class="mono">model</code> 字段后，网关在 1 毫秒内完成「别名映射 → 改名覆盖 → 模型组故障转移」的路由决策，自动附加真实凭据并转发上游。<br />
              • <b>流式与脱敏保护</b>：全链路支持双向 Server-Sent Events (SSE) 流式传输，并在出站前执行敏感指纹脱敏改写。
            </div>
          </div>
          <div v-else class="set-desc" style="margin-top: 10px">
            网关提供 <b>OpenAI 兼容</b>与 <b>Anthropic Messages</b> 两套主流协议；切换右上角「详细版」可查看协议结构与 Header 要求。
          </div>
        </div>
      </template>

      <!-- ===== Tab 4：故障排查与高级 ===== -->
      <template v-else-if="accessTab === 'troubleshooting'">
        <div class="card">
          <div class="card-title">
            常见问题与错误排查速查表
            <span class="right">快速诊断与解决方案</span>
          </div>
          <div class="faq-list">
            <div v-for="(f, i) in faqs" :key="i" class="faq-item">
              <div class="faq-q">
                <i class="ph ph-question"></i>
                <span>{{ f.q }}</span>
              </div>
              <div class="faq-a">
                <pre class="faq-text">{{ f.a }}</pre>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  flex-wrap: wrap;
}
.toolbar-right {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.copy-chip {
  cursor: pointer;
  border: 1px solid transparent;
  user-select: none;
  transition: all 0.15s;
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
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.warn-card {
  margin-bottom: 12px;
  border-color: var(--warn);
}
.warn-text {
  color: var(--warn);
}

/* 简约版与详细版切换 */
.mode-toggle {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: var(--r-sm, 6px);
  background: var(--surface-2);
  border: 1px solid var(--line);
}
.mode-btn {
  border: none;
  background: none;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}
.mode-btn:hover {
  color: var(--text);
}
.mode-btn.active {
  background: var(--surface-3);
  color: var(--accent);
  font-weight: 600;
}

/* 主 Tab 分区 */
.access-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 0;
  overflow-x: auto;
}
.access-tab-btn {
  border: none;
  background: none;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text-3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.18s;
  white-space: nowrap;
}
.access-tab-btn:hover {
  color: var(--text);
}
.access-tab-btn.active {
  color: var(--accent-strong, var(--accent));
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* 步骤 */
.steps {
  display: grid;
  gap: 12px;
  margin-bottom: 14px;
}
.step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.step-no {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
  color: var(--accent-strong);
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}
.step-main {
  flex: 1;
  min-width: 0;
}
.step-t {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.step-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text-3);
  font-weight: 400;
}
.step-d {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
  line-height: 1.6;
}
.step-link {
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
}
.step-link:hover {
  text-decoration: underline;
}
.step-detail-box {
  margin-top: 6px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--surface-2);
  border-left: 2px solid var(--accent);
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
}

/* 代码示例 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.code-wrap {
  position: relative;
  border: 1px solid var(--line);
  border-radius: var(--r-ctl, 8px);
  background: var(--surface-2);
  overflow: hidden;
}
.code-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--surface-3);
  border-bottom: 1px solid var(--line);
}
.code-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.code {
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}

/* 客户端网格 */
.cli-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.cli-card {
  border: 1px solid var(--line);
  border-radius: var(--r-ctl, 8px);
  background: var(--surface-2);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: all 0.2s;
}
.cli-card:hover {
  border-color: var(--line-strong);
}
.cli-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cli-title-box {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cli-path {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cli-card .code {
  padding: 8px;
  border-radius: 6px;
  background: var(--surface-3);
  font-size: 11.5px;
}
.cli-deep-tip {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cdt-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--warn, #f59e0b);
  display: flex;
  align-items: center;
  gap: 4px;
}
.cdt-desc {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}
.cdt-powershell {
  margin-top: 4px;
}
.cdt-ps-title {
  font-size: 10.5px;
  color: var(--text-3);
}

/* 协议兼容行 */
.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--r-ctl, 8px);
  background: var(--surface-2);
}
.row .grow {
  flex: 1;
  min-width: 0;
}
.row .name {
  font-size: 12px;
  color: var(--text);
  font-weight: 600;
}
.row .sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

/* FAQ 列表 */
.faq-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.faq-item {
  border: 1px solid var(--line);
  border-radius: var(--r-ctl, 8px);
  background: var(--surface-2);
  padding: 12px 14px;
}
.faq-q {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.faq-q .ph {
  color: var(--accent);
  font-size: 15px;
  flex: none;
}
.faq-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: inherit;
}
</style>
