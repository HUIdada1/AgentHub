<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · Agent 接入：本地服务状态 + Agent 卡（三级校验）+ 一键注入/卸载 + 手动接入（折叠，备用路径） -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryAgentCard, MemoryAgentVerify } from "../../types";
import { timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "agents");

const agents = ref<MemoryAgentCard[]>([]);
const command = ref<{ command: string | null; args: string[]; env: Record<string, string>; hostExists: boolean; bridgeExists: boolean } | null>(null);
const verifying = ref<string>("");
const busy = ref<string>("");
const verifyResults = ref<Record<string, MemoryAgentVerify>>({});
/** 三级明细默认收起，校验不通过时自动展开（排障信息不该常驻） */
const verifyOpen = ref<Record<string, boolean>>({});
const snippetFor = ref<string>("zcode");
const snippetFormat = ref<"json" | "toml" | "cli">("json");
const snippet = ref<{ json: string; toml: string; cli: string; instruction: string; hint: string; configPath: string; instructionPath: string } | null>(null);
const manualOpen = ref(false);
const customOpen = ref(false);
const custom = ref({ name: "", path: "", format: "json-mcpServers", instructionPath: "" });

const levelText: Record<string, string> = {
  verified: "真实调用过 ✓",
  handshaked: "握手通过",
  configured: "仅配置",
  detected: "仅检测到",
  none: "未接入",
};
const levelClass: Record<string, string> = {
  verified: "accent",
  handshaked: "warn",
  configured: "",
  detected: "warn",
  none: "",
};

/** 路径预检只在异常时才值得显示（正常时是三条绿色噪音） */
const precheckBad = computed(() => (!!command.value && (!command.value.hostExists || !command.value.bridgeExists)) || !mem.bridge.running);

async function refresh() {
  try {
    const r = await api.memoryAgentsList();
    agents.value = r.agents;
    command.value = r.command;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取 Agent 列表失败");
  }
}

async function loadSnippet() {
  try {
    snippet.value = await api.memoryAgentSnippet(snippetFor.value, snippetFormat.value);
  } catch (e) {
    ElMessage.error((e as Error).message || "生成片段失败");
  }
}

/** 测试连接：一次跑完三级（配置检测 → 握手 → 真实调用观察），不必让用户选“要不要握手” */
async function verify(id: string) {
  verifying.value = id;
  try {
    const r = await api.memoryAgentVerify(id, false);
    verifyResults.value = { ...verifyResults.value, [id]: r };
    const ok = r.level === "verified" || r.level === "handshaked";
    verifyOpen.value = { ...verifyOpen.value, [id]: !ok };
    ElMessage[ok ? "success" : "warning"](`${r.name}：${levelText[r.level] || r.level}`);
  } catch (e) {
    ElMessage.error((e as Error).message || "校验失败");
  } finally {
    verifying.value = "";
    await refresh();
  }
}

async function inject(id: string) {
  try {
    const r = await api.memoryAgentInject(id);
    const files = (r.steps || []).filter((s) => s.file).map((s) => s.file).join("\n");
    ElMessage.success(`注入完成：\n${files}`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "注入失败");
  }
}

async function uninject(id: string) {
  try {
    await ElMessageBox.confirm("卸载会移除 MCP 配置条目与指令受控块（写前自动备份），确认卸载？", "卸载接入", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryAgentUninject(id);
    ElMessage.success("已卸载（配置条目停用 / 受控块移除）");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "卸载失败");
  }
}

async function copy(text: string, label = "内容") {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`${label}已复制`);
  } catch {
    ElMessage.warning("复制失败，请手动选择复制");
  }
}

async function restartBridge() {
  busy.value = "bridge";
  try {
    const r = await api.memoryBridgeRestart();
    ElMessage.success(`本地服务已重启，端口 ${r.port}`);
    await mem.loadStatus();
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "重启失败");
  } finally {
    busy.value = "";
  }
}

async function saveCustom() {
  if (!custom.value.name || !custom.value.path) {
    ElMessage.warning("请填写名称与配置文件路径");
    return;
  }
  try {
    await api.memoryAgentCustomSave(custom.value);
    ElMessage.success("自定义 Agent 已保存（仅本机生效）");
    custom.value = { name: "", path: "", format: "json-mcpServers", instructionPath: "" };
    customOpen.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

let offEvent: (() => void) | undefined;
// 只对影响 Agent 列表/心跳的事件刷新（index 事件是 watcher 风暴源，不刷）
const REFRESH_TYPES = new Set(["memory-new", "deleted", "config-changed", "bridge", "root-changed"]);
onMounted(async () => {
  await mem.loadAll();
  await Promise.all([refresh(), loadSnippet()]);
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "memory" && REFRESH_TYPES.has(p.type || "")) void refresh();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
watch(active, (v) => {
  if (v) void refresh();
});
watch([snippetFor, snippetFormat], () => void loadSnippet());
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        MCP stdio 桥 + 本地 HTTP 单写者；三级校验区分「配置了」与「真的连上了」
        <MemHelp text="接入分两件事：给 Agent 的配置加一条 MCP 启动项（让它能拉起本地桥），再往它的指令文件（AGENTS.md/CLAUDE.md）写一段受控块（告诉它什么时候读写记忆）。两步都能一键回退。" />
      </p>
      <div class="mem-head-actions">
        <button class="btn btn-ghost" :disabled="busy === 'bridge'" @click="restartBridge">
          {{ busy === "bridge" ? "重启中…" : "重启本地服务" }}
        </button>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        本地 MCP 服务状态
        <span class="mem-hint">仅绑 127.0.0.1 + 一次性 token</span>
        <MemHelp text="所有 Agent 的记忆调用都经这个本地服务转手，好处是「只有一个写者」——不会出现两个 Agent 同时写同一个文件而互相覆盖。只监听本机回环地址，token 每次启动轮换。" />
      </div>
      <div class="mem-kv">
        <span class="k">运行状态</span>
        <span class="v">
          <span class="mem-dot" :class="mem.bridge.running ? 'ok' : 'bad'"></span>
          {{ mem.bridge.running ? `运行中 · 127.0.0.1:${mem.bridge.port}` : "未运行（AgentHub 启动后自动拉起）" }}
          <span v-if="precheckBad" class="mem-chip danger" style="margin-left: 6px">
            路径预检：主程序 {{ command?.hostExists ? "✓" : "✗" }} · 桥脚本 {{ command?.bridgeExists ? "✓" : "✗" }}
          </span>
        </span>
        <span class="k">已连通</span>
        <span class="v">{{ mem.verifiedAgents }} 个 Agent 有真实调用记录</span>
      </div>
    </div>

    <div class="mem-col" style="gap: 10px">
      <div v-for="a in agents" :key="a.id" class="mem-card">
        <div class="mem-card-title">
          <span style="display: flex; align-items: center; gap: 8px">
            <span class="mem-dot" :class="a.beat ? 'ok' : a.injected ? 'warn' : 'bad'"></span>
            {{ a.name }}
            <span v-if="a.custom" class="mem-chip">自定义</span>
            <span v-if="a.optional" class="mem-chip">扩展位</span>
          </span>
          <span class="mem-row" style="gap: 4px">
            <span class="mem-chip" :class="levelClass[verifyResults[a.id]?.level || (a.beat ? 'verified' : a.injected ? 'handshaked' : 'detected')]">
              {{ levelText[verifyResults[a.id]?.level || (a.beat ? "verified" : a.injected ? "handshaked" : "detected")] }}
            </span>
            <MemHelp text="三级校验：① 配置文件里条目在不在、路径可达不可达 → ② 真拉起桥发 initialize + tools/list → ③ 观察这个 Agent 有没有真的调用过。只有 ③ 有心跳才说明它真的在用。" />
          </span>
        </div>

        <div class="mem-kv">
          <span class="k">配置文件</span>
          <span class="v">
            <span class="mem-mono">{{ a.configPath }}</span>
            <span class="mem-chip" :class="a.configExists ? 'accent' : 'danger'" style="margin-left: 6px">{{ a.configExists ? "存在" : "不存在" }}</span>
          </span>
          <span class="k">指令文件</span>
          <span class="v">
            <span class="mem-mono">{{ a.instructionPath || "—" }}</span>
            <span class="mem-chip" :class="verifyResults[a.id]?.instructionInjected ? 'accent' : ''" style="margin-left: 6px">
              {{ verifyResults[a.id]?.instructionInjected ? "含受控块" : a.instructionExists ? "未注入" : "将新建" }}
            </span>
          </span>
          <span class="k">真实调用</span>
          <span class="v">
            {{ a.beat ? `最近 ${timeAgo(a.beat.lastCall)} · 共 ${a.beat.calls} 次（写 ${a.beat.writes} / 检索 ${a.beat.searches} / 错误 ${a.beat.errors}）` : "尚未观察到调用（若长期未调用，检查 Agent 是否重启过）" }}
          </span>
        </div>

        <div v-if="verifyResults[a.id] && verifyOpen[a.id]" class="mem-kv" style="margin-top: 8px">
          <span class="k">① 配置检测</span>
          <span class="v">{{ verifyResults[a.id].config.ok ? "✓ 通过" : "✗ " + verifyResults[a.id].config.message }}</span>
          <span class="k">② 握手测试</span>
          <span class="v">
            {{ verifyResults[a.id].handshake.ok ? `✓ 通过 ${verifyResults[a.id].handshake.latencyMs}ms · ${verifyResults[a.id].handshake.tools} 个工具` : `✗ ${verifyResults[a.id].handshake.message || "失败"}` }}
          </span>
          <span class="k">③ 真实调用</span>
          <span class="v">{{ verifyResults[a.id].real.ok ? "✓ 通过" : "✗ 尚未调用" }}</span>
        </div>

        <div class="mem-tile-foot" style="margin-top: 10px">
          <button class="btn btn-ghost" :disabled="verifying === a.id" @click="verify(a.id)">
            {{ verifying === a.id ? "校验中…" : "测试连接" }}
          </button>
          <button class="btn btn-cta" @click="inject(a.id)">一键注入</button>
          <MemHelp text="注入 = 往它的配置文件加 MCP 条目 + 往指令文件追加受控块（都在写前自动备份）。卸载时只删自己的块并把条目停用，不动你原有的配置。「测试连接」会真启动一次桥（约 1 秒）。" />
          <span class="mem-inline-ctl">
            <button class="mem-chip click" @click="() => { manualOpen = true; snippetFor = a.id; }">手动接入片段</button>
            <button class="mem-chip click" @click="uninject(a.id)">卸载</button>
          </span>
          <span v-if="a.note" class="mem-hint" style="margin-left: auto">{{ a.note }}</span>
        </div>
      </div>
    </div>

    <!-- 手动接入：一键注入不适用时才需要（备用路径，默认收起） -->
    <div class="mem-card">
      <div class="mem-card-title">
        手动接入
        <span class="mem-hint">{{ snippet?.hint }}</span>
        <button class="mem-chip click" @click="manualOpen = !manualOpen">{{ manualOpen ? "收起" : "展开" }}</button>
      </div>
      <template v-if="manualOpen">
        <div class="mem-row" style="margin-bottom: 10px">
          <select v-model="snippetFor" class="f-select" style="max-width: 210px">
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <div class="mem-seg" style="flex: 0 0 auto">
            <button class="btn" :class="snippetFormat === 'json' ? 'btn-outline' : 'btn-ghost'" @click="snippetFormat = 'json'">JSON</button>
            <button class="btn" :class="snippetFormat === 'toml' ? 'btn-outline' : 'btn-ghost'" @click="snippetFormat = 'toml'">TOML</button>
            <button class="btn" :class="snippetFormat === 'cli' ? 'btn-outline' : 'btn-ghost'" @click="snippetFormat = 'cli'">命令行</button>
          </div>
          <button class="btn btn-ghost" @click="copy(snippetFormat === 'json' ? snippet?.json || '' : snippetFormat === 'toml' ? snippet?.toml || '' : snippet?.cli || '', '配置片段')">复制配置</button>
          <button class="btn btn-ghost" @click="copy(snippet?.instruction || '', '指令块')">复制指令块</button>
          <button class="btn btn-ghost" @click="copy(`${command?.command || ''} ${(command?.args || []).join(' ')}`, '启动命令行')">复制启动命令</button>
        </div>
        <pre class="mem-pre">{{ snippetFormat === "json" ? snippet?.json : snippetFormat === "toml" ? snippet?.toml : snippet?.cli }}</pre>
        <details style="margin-top: 10px">
          <summary style="cursor: pointer; font-size: 12px; color: var(--text-3)">指令受控块（写入 AGENTS.md / CLAUDE.md 的内容）</summary>
          <pre class="mem-pre" style="margin-top: 8px">{{ snippet?.instruction }}</pre>
        </details>
        <div style="margin-top: 10px; font-size: 12px; color: var(--text-3)">
          手动步骤：① 打开配置文件 → ② 粘贴上面的片段（或直接在 Agent 内执行命令行）→ ③ 重启对应 Agent → ④ 回到本页「测试连接」确认。
        </div>
      </template>
    </div>

    <!-- 自定义 Agent（扩展位）：一次性设置，收进按钮 -->
    <div class="mem-card">
      <div class="mem-card-title">
        自定义 Agent（扩展位）
        <span class="mem-hint">填名称 + 配置文件路径即可生成同样的接入片段</span>
        <button class="mem-chip click" @click="customOpen = !customOpen">{{ customOpen ? "收起" : "＋ 添加" }}</button>
      </div>
      <div v-if="customOpen" class="mem-row">
        <input v-model="custom.name" class="f-input" style="max-width: 180px" placeholder="名称，如 Cline" />
        <input v-model="custom.path" class="f-input" style="max-width: 320px" placeholder="配置文件绝对路径" />
        <select v-model="custom.format" class="f-select" style="max-width: 220px">
          <option value="json-mcpServers">JSON · mcpServers</option>
          <option value="json-mcp.servers">JSON · mcp.servers</option>
          <option value="toml-mcp_servers">TOML · mcp_servers</option>
        </select>
        <input v-model="custom.instructionPath" class="f-input" style="max-width: 300px" placeholder="指令文件路径（可空）" />
        <button class="btn btn-cta" @click="saveCustom">保存</button>
      </div>
    </div>
  </div>
</template>
