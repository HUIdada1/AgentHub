<!--
  ============================================================
   作者：沐晖
   日期：2026-10-23
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 提示词库 · 配置（方案 §3.6）
     四个二级 tab：优化偏好 / 提示词库 / 同步 / 注入与消费（二期占位）。
     改动即存：与记忆中枢配置页同款交互（每项 change 就落盘，不做「保存」按钮，
     因为用户改完常常直接关弹窗，漏存比多存烦人得多）。 -->
<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { usePromptsStore } from "../../stores/prompts";
import { pipc, PROMPTS_CONFIG_DEFAULTS, type PromptsConfig, type PromptStyle } from "../../views/prompts/promptTypes";

const store = usePromptsStore();
const tab = ref<"optimize" | "library" | "sync" | "inject">("optimize");
const libDir = ref("");
const editingId = ref("");
const editForm = reactive<Partial<PromptStyle>>({ name: "", description: "", systemTemplate: "", userTemplate: "", maxLength: 800, temperature: 0.7 });

const form = reactive<PromptsConfig>({ ...PROMPTS_CONFIG_DEFAULTS });
watch(
  () => store.cfg,
  (v) => Object.assign(form, v),
  { immediate: true, deep: true },
);

/** 改动即存；失败要把错误说出来（静默失败会让用户以为设置生效了） */
async function patch(k: keyof PromptsConfig, v: unknown) {
  try {
    await store.saveCfg({ [k]: v } as Partial<PromptsConfig>);
    ElMessage.success("已保存");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function saveDir() {
  try {
    const r = await pipc.promptsSetDir({ dir: libDir.value.trim() });
    ElMessage.success(`库目录已设为 ${r.dir}`);
    await store.loadLibrary(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "设置失败");
  }
}

async function openDir() {
  try { await pipc.promptsOpenDir(); } catch (e) { ElMessage.error((e as Error).message || "打开失败"); }
}

async function rebuild() {
  try {
    await ElMessageBox.confirm("将以 items/ 目录里的文件为准重建台账（不会删除任何提示词），继续？", "重建台账", { type: "warning" });
  } catch { return; }
  try {
    const r = await pipc.promptsRebuild();
    ElMessage.success(`台账已重建，共 ${r.count} 条`);
    await store.loadLibrary(true);
  } catch (e) {
    ElMessage.error((e as Error).message || "重建失败");
  }
}

function startEdit(s: PromptStyle) {
  editingId.value = s.id;
  editForm.name = s.name;
  editForm.description = s.description;
  editForm.systemTemplate = s.systemTemplate;
  editForm.userTemplate = s.userTemplate || "";
  editForm.maxLength = s.maxLength ?? 800;
  editForm.temperature = s.temperature ?? 0.7;
}

async function saveStyle() {
  try {
    await pipc.promptsStylesSave({ style: { ...(editForm as PromptStyle), id: editingId.value } });
    ElMessage.success("风格已保存");
    editingId.value = "";
    await store.loadStyles();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function removeStyle(s: PromptStyle) {
  try {
    await ElMessageBox.confirm(`确定删除风格「${s.name}」吗？`, "删除风格", { type: "warning" });
  } catch { return; }
  try {
    await pipc.promptsStylesDelete({ id: s.id });
    ElMessage.success("已删除");
    await store.loadStyles();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function resetStyles() {
  try {
    await ElMessageBox.confirm("将把内置风格恢复为默认内容（自定义风格保留），继续？", "恢复内置默认", { type: "warning" });
  } catch { return; }
  try {
    await pipc.promptsStylesReset();
    ElMessage.success("已恢复内置默认");
    await store.loadStyles();
  } catch (e) {
    ElMessage.error((e as Error).message || "恢复失败");
  }
}

async function setDefaultStyle(id: string) {
  await patch("defaultStyleId", id);
}

onMounted(async () => {
  await store.loadAll();
  libDir.value = form.rootDir || "";
});
</script>

<template>
  <div class="cfg-sec prompts-scope">
    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'optimize' }" @click="tab = 'optimize'"><i class="ph ph-sparkle"></i>优化偏好</button>
      <button class="cfg-subtab" :class="{ active: tab === 'library' }" @click="tab = 'library'"><i class="ph ph-books"></i>提示词库</button>
      <button class="cfg-subtab" :class="{ active: tab === 'sync' }" @click="tab = 'sync'"><i class="ph ph-cloud-arrow-up"></i>同步</button>
      <button class="cfg-subtab" :class="{ active: tab === 'inject' }" @click="tab = 'inject'"><i class="ph ph-plug"></i>注入与消费</button>
    </div>

    <!-- ① 优化偏好 -->
    <template v-if="tab === 'optimize'">
      <div class="pr-field-row">
        <div><div class="f-label">默认优化风格</div><div class="f-desc">打开「优化提示词」页时预先选中的风格</div></div>
        <div class="f-ctl">
          <el-select :model-value="form.defaultStyleId" style="width: 220px" @change="(v: string) => patch('defaultStyleId', v)">
            <el-option v-for="s in store.styles" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">默认模型</div><div class="f-desc">留空 = 跟随「设置 · 模型与网关」的默认模型</div></div>
        <div class="f-ctl"><el-input :model-value="form.defaultModel" placeholder="留空表示跟随默认" style="width: 280px" @change="(v: string) => patch('defaultModel', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">结果长度上限</div><div class="f-desc">改写后建议不超过的字符数（注入 system 模板）</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.maxLength" :min="100" :max="20000" :step="100" @change="(v: number | undefined) => patch('maxLength', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">温度</div><div class="f-desc">改写任务需要多样性，建议 0.6 ~ 0.8</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.temperature" :min="0" :max="2" :step="0.1" @change="(v: number | undefined) => patch('temperature', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">最大输出 token</div><div class="f-desc">单次改写允许生成的最大长度</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.maxTokens" :min="256" :max="200000" :step="256" @change="(v: number | undefined) => patch('maxTokens', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">请求超时（秒）</div><div class="f-desc">超过该时长视为失败，可在优化页临时调大</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.timeoutSec" :min="5" :max="600" :step="5" @change="(v: number | undefined) => patch('timeoutSec', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">目标场景</div><div class="f-desc">注入模板，告诉模型这次改写是给谁用的</div></div>
        <div class="f-ctl"><el-input :model-value="form.scenario" style="width: 280px" @change="(v: string) => patch('scenario', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">优化历史条数上限</div><div class="f-desc">超出后按最旧淘汰（单条超长会截断且不可回填）</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.historyLimit" :min="1" :max="500" @change="(v: number | undefined) => patch('historyLimit', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">流式输出</div><div class="f-desc">边生成边显示。上游不支持时后端会自动回退为一次性返回，只是那一次会慢一点</div></div>
        <div class="f-ctl"><el-switch :model-value="form.stream !== false" @change="(v: any) => patch('stream', v === true)" /></div>
      </div>

      <div class="pr-row" style="margin-top: 10px">
        <div class="pr-card-title">风格管理</div>
        <span class="pr-inline-ctl"><el-button size="small" @click="resetStyles">恢复内置默认</el-button></span>
      </div>
      <div class="pr-hint">内置风格可编辑但不能删除；模板里可用 <code>{input}</code>、<code>{maxLength}</code>、<code>{scenario}</code>、<code>{extra}</code> 占位（<code>{extra}</code> 是「本次额外要求」，值为空时整段消失，要紧贴 <code>{input}</code> 写）。</div>
      <div class="pr-grid">
        <div v-for="s in store.styles" :key="s.id" class="pr-style-card" :class="{ on: store.cfg.defaultStyleId === s.id }">
          <div class="pr-row">
            <b>{{ s.name }}</b>
            <span v-if="s.builtin" class="pr-chip">内置</span>
            <span v-if="store.cfg.defaultStyleId === s.id" class="pr-chip accent">默认</span>
          </div>
          <div class="pr-hint">{{ s.description }}</div>
          <div class="pr-row">
            <el-button size="small" text @click="startEdit(s)">编辑</el-button>
            <el-button size="small" text :disabled="store.cfg.defaultStyleId === s.id" @click="setDefaultStyle(s.id)">设为默认</el-button>
            <el-button size="small" text :disabled="s.builtin" @click="removeStyle(s)">删除</el-button>
          </div>
        </div>
      </div>

      <div v-if="editingId" class="pr-card" style="margin-top: 10px">
        <div class="pr-card-title">编辑风格</div>
        <div class="pr-col">
          <el-input v-model="editForm.name" placeholder="风格名称" />
          <el-input v-model="editForm.description" placeholder="一句话说明这套风格侧重什么" />
          <div class="pr-hint">system 模板（可用 {maxLength}、{scenario}）</div>
          <textarea v-model="editForm.systemTemplate" class="pr-area" rows="10"></textarea>
          <div class="pr-hint">user 模板（必须含 {input}）</div>
          <textarea v-model="editForm.userTemplate" class="pr-area" rows="6"></textarea>
          <div class="pr-row">
            <span class="pr-hint">长度上限</span>
            <el-input-number v-model="editForm.maxLength" :min="100" :max="20000" :step="100" />
            <span class="pr-hint">温度</span>
            <el-input-number v-model="editForm.temperature" :min="0" :max="2" :step="0.1" />
            <span class="pr-inline-ctl">
              <el-button size="small" @click="editingId = ''">取消</el-button>
              <el-button size="small" type="primary" @click="saveStyle">保存</el-button>
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- ② 提示词库 -->
    <template v-else-if="tab === 'library'">
      <div class="pr-field-row">
        <div><div class="f-label">库根目录</div><div class="f-desc">默认 <code>~/AgentHub/prompts</code>；留空恢复默认。库目录参与同步，本机偏好（风格/历史）不在此目录</div></div>
        <div class="f-ctl">
          <el-input v-model="libDir" placeholder="留空使用默认目录" style="width: 320px" />
          <el-button size="small" @click="saveDir">保存</el-button>
          <el-button size="small" @click="openDir">打开目录</el-button>
        </div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">版本保留数</div><div class="f-desc">每条提示词保留的历史版本数；同步自动合并产生的版本优先保留</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.versionKeep" :min="1" :max="500" @change="(v: number | undefined) => patch('versionKeep', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">回收站保留天数</div><div class="f-desc">超期自动清理；0 表示不自动清理</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.trashDays" :min="0" :max="3650" @change="(v: number | undefined) => patch('trashDays', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">新建默认分类</div><div class="f-desc">新建提示词时预填的分类</div></div>
        <div class="f-ctl"><el-input :model-value="form.defaultCategory" style="width: 220px" @change="(v: string) => patch('defaultCategory', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">单条大小上限（KB）</div><div class="f-desc">超过则拒绝保存，避免一条超大文本拖垮同步</div></div>
        <div class="f-ctl"><el-input-number :model-value="form.itemMaxKB" :min="1" :max="10240" :step="64" @change="(v: number | undefined) => patch('itemMaxKB', v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">重建台账</div><div class="f-desc">台账损坏、或你手工往 items/ 里放过文件时使用；以文件为准，不会删提示词</div></div>
        <div class="f-ctl"><el-button size="small" @click="rebuild">重建</el-button></div>
      </div>
    </template>

    <!-- ③ 同步 -->
    <template v-else-if="tab === 'sync'">
      <div class="pr-field-row">
        <div><div class="f-label">同步根目录</div><div class="f-desc">服务器地址与凭据在「设置 · WebDAV 同步」里统一维护，本板块只用自己的根目录</div></div>
        <div class="f-ctl"><span class="pr-mono">/agenthub-prompts</span></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">冲突自动合并策略</div><div class="f-desc">两边都改了同一条时如何自动裁决；被放弃的版本会存入版本历史</div></div>
        <div class="f-ctl">
          <el-select :model-value="form.mergeStrategy" style="width: 220px" @change="(v: PromptsConfig['mergeStrategy']) => patch('mergeStrategy', v)">
            <el-option label="新者优先（推荐）" value="newer-wins" />
            <el-option label="本地优先" value="local-wins" />
            <el-option label="远端优先" value="remote-wins" />
            <el-option label="内容更长者优先" value="longer-wins" />
            <el-option label="全部人工裁决" value="manual" />
          </el-select>
        </div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">删除冲突处理</div><div class="f-desc">一边删除、另一边修改时怎么办</div></div>
        <div class="f-ctl">
          <el-select :model-value="form.onDeleteConflict" style="width: 220px" @change="(v: PromptsConfig['onDeleteConflict']) => patch('onDeleteConflict', v)">
            <el-option label="保留删除（默认）" value="tombstone" />
            <el-option label="保留修改" value="keep-modified" />
          </el-select>
        </div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">同步版本历史</div><div class="f-desc">关闭后只同步当前版本（跨设备回滚能力会随之消失）</div></div>
        <div class="f-ctl"><el-switch :model-value="form.syncVersions" @update:model-value="(v: string | number | boolean) => patch('syncVersions', !!v)" /></div>
      </div>
      <div class="pr-field-row">
        <div><div class="f-label">同步周期</div><div class="f-desc">按小时设置，默认 4 小时</div></div>
        <div class="f-ctl"><span class="pr-hint">请到「设置 · 同步时间 → 提示词库」里调整</span></div>
      </div>
    </template>

    <!-- ④ 注入与消费（二期） -->
    <template v-else>
      <div class="pr-empty">
        <i class="ph ph-plug ph"></i>
        <div class="es-title">待版本更新</div>
        <div class="pr-hint">
          二期将支持把提示词库中的条目以受控块方式注入各 Agent 的指令文件（独立标记，可一键卸载），
          并通过 MCP 工具通道暴露检索能力。当前版本请使用「优化提示词」与「个人提示词库」。
        </div>
      </div>
    </template>
  </div>
</template>
