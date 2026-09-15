<!-- 反代网关 · API Keys：生成 / 列表（掩码 + 完整 Key 随时查看复制）/ 启停 / 编辑 / 删除（方案 §7 keys.html）
     安全：鉴权实时查 SHA-256 哈希；完整 Key 经 DPAPI 加密存库，列表可随时查看 / 复制；状态开关即时生效 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyKeyRow, ProxyRoute } from "../../types";
import { fmtInt, fmtK } from "./format";

const keys = ref<ProxyKeyRow[]>([]);
const err = ref("");

// 生成弹窗
const createOpen = ref(false);
const form = ref({ name: "", route: "auto" as ProxyRoute, dailyQuota: 0, rateLimit: 0 });
const creating = ref(false);

// 完整 Key 展示弹窗：生成后首次展示，之后可从列表随时打开
const secretOpen = ref(false);
const secretKey = ref("");
const secretIsNew = ref(false);
const secretCopied = ref(false);

function showSecret(key: string, isNew = false) {
  secretKey.value = key;
  secretIsNew.value = isNew;
  secretCopied.value = false;
  secretOpen.value = true;
}

// 编辑弹窗
const editOpen = ref(false);
const editRow = ref<ProxyKeyRow | null>(null);
const editForm = ref({ name: "", route: "auto" as ProxyRoute, dailyQuota: 0, rateLimit: 0 });

// 删除确认
const delOpen = ref(false);
const delRow = ref<ProxyKeyRow | null>(null);

// 路由候选 = 智能路由 + 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
const ROUTES = computed<{ value: ProxyRoute; label: string }[]>(() => [
  { value: "auto", label: "智能路由" },
  ...channels.value.map((c) => ({ value: c.id as ProxyRoute, label: c.display })),
]);
const routeLabel = (r: ProxyRoute) => ROUTES.value.find((x) => x.value === r)?.label || r;

async function refresh() {
  try {
    keys.value = await api.proxyKeysList();
    channels.value = await api.proxyPool().catch(() => channels.value);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function doCreate() {
  if (creating.value) return;
  creating.value = true;
  try {
    const row = await api.proxyKeyCreate({
      name: form.value.name.trim() || "未命名 Key",
      route: form.value.route,
      dailyQuota: Math.max(0, Number(form.value.dailyQuota) || 0),
      rateLimit: Math.max(0, Number(form.value.rateLimit) || 0),
    });
    createOpen.value = false;
    showSecret(row.secret, true);
    form.value = { name: "", route: "auto", dailyQuota: 0, rateLimit: 0 };
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    creating.value = false;
  }
}

function copySecret() {
  navigator.clipboard?.writeText(secretKey.value).catch(() => {});
  secretCopied.value = true;
  setTimeout(() => (secretCopied.value = false), 1500);
}

/** 列表行内快捷复制完整 Key（行内按钮短暂显示“已复制”） */
const copiedId = ref("");
function copyKeyRow(k: ProxyKeyRow) {
  if (!k.secret) return;
  navigator.clipboard?.writeText(k.secret).catch(() => {});
  copiedId.value = k.id;
  setTimeout(() => (copiedId.value = ""), 1500);
}

async function toggle(row: ProxyKeyRow) {
  try {
    await api.proxyKeyUpdate(row.id, { enabled: !row.enabled });
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

function openEdit(row: ProxyKeyRow) {
  editRow.value = row;
  editForm.value = { name: row.name, route: row.route, dailyQuota: row.dailyQuota, rateLimit: row.rateLimit };
  editOpen.value = true;
}

async function doEdit() {
  if (!editRow.value) return;
  try {
    await api.proxyKeyUpdate(editRow.value.id, {
      name: editForm.value.name.trim() || editRow.value.name,
      route: editForm.value.route,
      dailyQuota: Math.max(0, Number(editForm.value.dailyQuota) || 0),
      rateLimit: Math.max(0, Number(editForm.value.rateLimit) || 0),
    });
    editOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function doDelete() {
  if (!delRow.value) return;
  try {
    await api.proxyKeyDelete(delRow.value.id);
    delOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">API Keys</div>
        <div class="page-sub">生成与管理本地调用密钥</div>
      </div>
      <div class="page-actions"><button class="btn btn-primary" @click="createOpen = true">生成 Key</button></div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="tbl-wrap">
        <table class="tbl">
          <tbody>
            <tr><th>KEY</th><th>名称</th><th>路由</th><th>今日请求</th><th>今日 Token</th><th>每日配额</th><th>状态</th><th>操作</th></tr>
            <tr v-for="k in keys" :key="k.id">
              <td class="mono">{{ k.mask }}</td>
              <td>{{ k.name }}</td>
              <td>{{ routeLabel(k.route) }}</td>
              <td class="mono">{{ fmtInt(k.todayReq) }}</td>
              <td class="mono">{{ fmtK(k.todayTokens) }}</td>
              <td class="mono">{{ k.dailyQuota ? fmtInt(k.dailyQuota) : "不限" }}</td>
              <td><span class="tag" :class="k.enabled ? 'tag-ok' : 'tag-dim'">{{ k.enabled ? "启用" : "已禁用" }}</span></td>
              <td>
                <button v-if="k.secret" class="btn-link btn-sm" @click="copyKeyRow(k)">{{ copiedId === k.id ? "已复制" : "复制" }}</button>
                <button v-if="k.secret" class="btn-link btn-sm" @click="showSecret(k.secret)">查看</button>
                <button class="btn-link btn-sm" @click="openEdit(k)">编辑</button>
                <button class="btn-link btn-sm" @click="toggle(k)">{{ k.enabled ? "禁用" : "启用" }}</button>
                <button class="btn-link btn-sm danger" @click="delRow = k; delOpen = true">删除</button>
              </td>
            </tr>
            <tr v-if="!keys.length">
              <td colspan="8" style="text-align: center; color: var(--text-3); padding: 18px">
                还没有 Key —— 点右上角「生成 Key」；生成后可随时在列表复制 / 查看完整 Key
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">安全提示</div>
        <div class="code">鉴权比对只用 SHA-256 哈希 · 完整 Key 经 DPAPI 加密存储、可随时查看 / 复制 · 状态开关即时生效（鉴权实时查库）</div>
      </div>
    </div>

    <!-- 生成 Key 弹窗 -->
    <Teleport to="body">
      <div v-if="createOpen" class="p-mask" @click.self="createOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">生成 API Key</div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="form.name" class="input" style="width: 180px" placeholder="例如：本地主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">路由</div>
              <div class="set-desc">绑定渠道 = 绑定该渠道号池；智能路由按健康度 × 余额打分</div>
            </div>
            <el-select v-model="form.route" popper-class="glass-popper" style="width: 208px">
              <el-option v-for="r in ROUTES" :key="r.value" :value="r.value" :label="r.label" />
            </el-select>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">每日配额</div>
              <div class="set-desc">0 = 不限；超限返回 429，次日 00:00 重置</div>
            </div>
            <input v-model.number="form.dailyQuota" class="input mono" style="width: 100px" type="number" min="0" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">限速（次/分钟）</div>
              <div class="set-desc">0 = 继承全局默认（「配置 → 反代网关」里的单 Key 限速）</div>
            </div>
            <input v-model.number="form.rateLimit" class="input mono" style="width: 100px" type="number" min="0" />
          </div>
          <div class="p-actions">
            <button class="btn" @click="createOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="creating" @click="doCreate">{{ creating ? "生成中…" : "生成" }}</button>
          </div>
        </div>
      </div>

      <!-- 完整 Key 查看：生成后首次展示；之后从列表「查看」随时打开 -->
      <div v-if="secretOpen" class="p-mask" @click.self="secretOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">{{ secretIsNew ? "Key 已生成" : "查看完整 Key" }}</div>
          <div class="set-desc" style="margin-bottom: 10px">
            {{ secretIsNew ? "已加密存入本地凭证库，关闭后仍可在 Key 列表随时查看 / 复制。" : "完整 Key 经 DPAPI 加密存储，可随时在此查看 / 复制。" }}
          </div>
          <div class="code secret-box">{{ secretKey }}</div>
          <div class="p-actions">
            <button class="btn" @click="copySecret">{{ secretCopied ? "已复制" : "复制" }}</button>
            <button class="btn btn-primary" @click="secretOpen = false">{{ secretIsNew ? "我已保存" : "关闭" }}</button>
          </div>
        </div>
      </div>

      <!-- 编辑弹窗 -->
      <div v-if="editOpen" class="p-mask" @click.self="editOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">编辑 Key</div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="editForm.name" class="input" style="width: 180px" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">路由</div></div>
            <el-select v-model="editForm.route" popper-class="glass-popper" style="width: 208px">
              <el-option v-for="r in ROUTES" :key="r.value" :value="r.value" :label="r.label" />
            </el-select>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">每日配额</div></div>
            <input v-model.number="editForm.dailyQuota" class="input mono" style="width: 100px" type="number" min="0" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">限速（次/分钟）</div></div>
            <input v-model.number="editForm.rateLimit" class="input mono" style="width: 100px" type="number" min="0" />
          </div>
          <div class="p-actions">
            <button class="btn" @click="editOpen = false">取消</button>
            <button class="btn btn-primary" @click="doEdit">保存</button>
          </div>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除 Key</div>
          <div class="set-desc">确定删除「{{ delRow?.name }}」（{{ delRow?.mask }}）？删除立即生效，使用该 Key 的客户端将返回 401。</div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.danger {
  color: var(--err, #e05555);
}
.p-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
}
.p-dlg {
  width: 430px;
  max-width: calc(100vw - 48px);
  border-radius: var(--r-panel);
  padding: 16px 18px;
}
.p-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 12px;
}
.p-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.secret-box {
  word-break: break-all;
  user-select: all;
  padding: 10px;
}
.danger-solid {
  background: var(--err, #e05555);
  border-color: var(--err, #e05555);
}
</style>
