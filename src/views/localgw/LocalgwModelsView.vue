<!--
  ============================================================
   作者：沐晖
   日期：2026-10-27
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 模型目录：合并视图（渠道 + overrides + aliases + custom）
     只读展示；编辑通过 override/alias/custom 三张本地配置表 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";

const app = useAppStore();
const lgw = useLocalgwStore();
const query = ref("");
/** 保存中标志：避免连点重复提交 */
const saving = ref(false);

/** 统一取字符串：后端漏字段时不能直接 .toLowerCase()（会整页 TypeError 白屏） */
function text(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return lgw.models;
  return lgw.models.filter((m) =>
    text(m.display).toLowerCase().includes(q) ||
    text(m.channel).toLowerCase().includes(q) ||
    text(m.realModel).toLowerCase().includes(q)
  );
});

const grouped = computed(() => {
  const by = new Map<string, typeof filtered.value>();
  for (const m of filtered.value) {
    const key = text(m.channel);
    const list = by.get(key) || [];
    list.push(m);
    by.set(key, list);
  }
  return [...by.entries()].map(([channel, models]) => ({ channel: channel || "未指定渠道", models }));
});

const stats = computed(() => {
  const total = lgw.models.length;
  const overrides = lgw.models.filter((m) => m.source === "override").length;
  const aliases = lgw.models.filter((m) => m.source === "alias").length;
  const customs = lgw.models.filter((m) => m.source === "custom").length;
  return { total, overrides, aliases, customs };
});

const exposeOn = computed(() => app.config.localgw?.models?.exposeInV1Models !== false);

/** 切换「在 /v1/models 中暴露」：只提交这一个键，
 *  后端 config_patch 是深合并，overrides/aliases/custom 不会被本地旧副本覆盖掉 */
async function exposeToggle(v: any) {
  if (saving.value) return;
  const on = v === true;
  saving.value = true;
  try {
    const r = await localgwApi.configPatch({ models: { exposeInV1Models: on } });
    if (r && r.ok) {
      // 回填本地配置，开关立刻反映真实状态（否则下一次渲染又会弹回旧值）
      if (app.config.localgw?.models) app.config.localgw.models.exposeInV1Models = on;
      ElMessage.success("已保存");
    } else {
      ElMessage.error("保存失败");
    }
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  // refreshModels 成功即置 backendReady，不依赖先打开总览页
  await lgw.refreshModels();
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">模型目录</span>
      <span class="lgw-kpi-sub">
        {{ stats.total }} 个模型 · {{ stats.overrides }} 覆盖 · {{ stats.aliases }} 别名 · {{ stats.customs }} 自定义
      </span>
      <el-input v-model="query" size="small" placeholder="搜索模型 / 渠道" style="width:220px" clearable />
    </div>

    <!-- 错误横幅：加载失败时把原因显式说出来 -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <div v-if="!lgw.backendReady" class="lgw-backend-off">
      <i class="ph ph-link-break lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入</div>
      <div class="lgw-backend-off-desc">模型目录需要主进程 localgw IPC 通道，由渠道 discovery 汇总生成。</div>
    </div>

    <template v-else>
      <div class="lgw-section">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="lgw-section-title" style="margin:0">在 /v1/models 中暴露</div>
          <el-switch :model-value="exposeOn" size="small" :loading="saving" @change="(v: any) => exposeToggle(v)" />
        </div>
        <div class="lgw-kpi-sub">
          开启后客户端调 <code style="font-family:var(--font-mono)">GET /v1/models</code> 可拿到全部启用渠道的合并视图；
          关闭则只返回 overrides/aliases/custom 三张表的显式声明（用于"我要严格收窄对外可见模型"的场景）。
        </div>
      </div>

      <div v-for="g in grouped" :key="g.channel" class="lgw-section">
        <div class="lgw-section-title">{{ g.channel }}</div>
        <table class="lgw-table">
          <thead>
            <tr><th>对外名</th><th>实际模型</th><th>来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in g.models" :key="`${m.id}|${m.source}`">
              <td>{{ text(m.display) || "—" }}</td>
              <td>{{ text(m.realModel) || "—" }}</td>
              <td>
                <el-tag size="small" :type="m.source === 'custom' ? 'success' : m.source === 'alias' ? 'warning' : m.source === 'override' ? 'primary' : 'info'">
                  {{ m.source === "custom" ? "自定义" : m.source === "alias" ? "别名" : m.source === "override" ? "覆盖" : "渠道" }}
                </el-tag>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!lgw.models.length" class="lgw-section" style="padding:32px;text-align:center;color:var(--text-3)">
        暂无模型 —— 先到「路由与渠道」启用至少一个渠道，并到号池管家刷新模型目录
      </div>
    </template>
  </div>
</template>
