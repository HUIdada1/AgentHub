<!-- 技能仓库 · 配置页（右上「配置」按钮切换的模块页）：工具适配器 / 同步与去重 / 调度 / 回收站 / 危险区
     内容承接原技能仓库「模块设置页」（sk- 版式）；页面内的二级子板块 tab 在这里切换；
     WebDAV 服务器在左下角「设置 · WebDAV 同步」配置，中央仓库跨设备同步在「WebDAV 同步」页 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { fmtTime, fmtSize } from "../../utils/format";
import type { AppConfig, ToolRow, TrashRow, ProbeRow } from "../../types";

const app = useAppStore();

// 页面内的二级子板块：工具适配器 / 同步与调度 / 回收站与危险区
const tab = ref<"tools" | "sync" | "data">("tools");

// 表单独立持一份磁盘配置快照（技能仓库的字段都在这份上改），保存时整份回写并同步 store
const skCfg = ref<AppConfig | null>(null);
const skTools = ref<ToolRow[]>([]);
const skTrash = ref<TrashRow[]>([]);
const skHubDir = ref("%USERPROFILE%\\.agent_skills");
const skMsg = ref("");
const skSaving = ref(false);

// ---- 工具适配器：扫描发现 / 手动新增 ----
const probeOpen = ref(false);
const probeLoading = ref(false);
const probed = ref<ProbeRow[]>([]);

const manualOpen = ref(false);
const manual = ref({ name: "", id: "", path: "" });
const idTouched = ref(false); // 用户手动改过 id 后，改名字就不再覆盖它

// 名字改了就联动生成 id，除非用户已经自己改过 id
function onNameInput() {
  if (!idTouched.value) manual.value.id = slugId(manual.value.name);
}

// 每次激活都重新拉磁盘配置，避免其它入口改完这里显示旧值
const active = computed(() => app.activeModule === "skills" && app.activePage === "config");
watch(active, (v) => { if (v) loadSkillsSettings(); }, { immediate: true });

async function loadSkillsSettings() {
  try {
    skCfg.value = await api.loadConfig();
    skTools.value = (await api.listTools()) || [];
    // 旧配置里工具条目可能没存 name，按后端解析结果补齐，让卡片显示默认名
    for (const t of skTools.value) {
      const tc = skCfg.value?.tools?.[t.id];
      if (tc && !tc.name) tc.name = t.name;
    }
    skTrash.value = (await api.trashList()) || [];
    const dir = await api.getDataDir();
    if (dir) skHubDir.value = dir;
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  }
}

async function saveSkillsSettings() {
  if (!skCfg.value) return;
  skSaving.value = true;
  try {
    const r = await api.saveConfig(skCfg.value);
    skMsg.value = r?.ok ? "设置已保存，同步中心重新扫描后生效" : r?.message || "保存失败";
    if (r?.ok) {
      // 回写 store 里的共享配置（主题 / 调度等字段同一份），并刷新全站工具显示名
      Object.assign(app.config, JSON.parse(JSON.stringify(skCfg.value)));
      skTools.value = (await api.listTools()) || [];
      await app.refreshTools();
    }
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  } finally {
    skSaving.value = false;
  }
}

// 名称转 id：英文数字连字符保留，其余压成 -，给手动新增当默认值，用户可改
function slugId(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(s) ? s : "agent";
}

async function doProbe() {
  probeLoading.value = true;
  probed.value = [];
  try {
    probed.value = (await api.probeAgents()) || [];
    probeOpen.value = true;
    manualOpen.value = false;
    skMsg.value = probed.value.length ? `扫描到 ${probed.value.length} 个未注册的 agent 技能目录` : "没有发现未注册的 agent 技能目录";
  } catch (e) {
    skMsg.value = String((e as Error).message || e);
  } finally {
    probeLoading.value = false;
  }
}

function adopt(row: ProbeRow) {
  if (!skCfg.value) return;
  let id = row.suggestId;
  let n = 2;
  while (skCfg.value.tools[id]) id = `${row.suggestId}-${n++}`; // 理论不撞，防御一下
  const paths = row.hitDirs.length ? [row.hitDirs[0]] : [""];
  skCfg.value.tools[id] = { name: row.name, icon: row.icon, enabled: true, paths };
  skTools.value.push({ id, name: row.name, icon: row.icon, builtin: false, deletable: true, enabled: true, dir: paths[0], candidatePaths: paths });
  skMsg.value = `已添加「${row.name}」，保存后生效`;
}

function openManual() {
  manualOpen.value = !manualOpen.value;
  probeOpen.value = false;
  manual.value = { name: "", id: "", path: "" };
  idTouched.value = false;
}

async function browseManualPath() {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) manual.value.path = r.path;
}

function submitManual() {
  if (!skCfg.value) return;
  const name = manual.value.name.trim();
  const id = (manual.value.id.trim() || slugId(name)).toLowerCase();
  if (!name) { skMsg.value = "先给工具起个名字"; return; }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { skMsg.value = "id 只能用小写字母数字开头，可含 -_，最长 32 位"; return; }
  if (skCfg.value.tools[id]) { skMsg.value = `id「${id}」已被占用，换一个`; return; }
  const paths = manual.value.path.trim() ? [manual.value.path.trim()] : [""];
  skCfg.value.tools[id] = { name, enabled: true, paths };
  skTools.value.push({ id, name, icon: "ph-robot", builtin: false, deletable: true, enabled: true, dir: paths[0], candidatePaths: paths });
  manualOpen.value = false;
  skMsg.value = `已添加「${name}」，保存后生效`;
}

async function startRemove(t: ToolRow) {
  const plan = await api.removeTool(t.id).catch(() => null);
  if (!plan || plan.ok === false) { skMsg.value = plan?.message || "删除失败，请重试"; return; }
  if (plan.openConflicts) {
    await ElMessageBox.alert(`该工具还有 ${plan.openConflicts} 条未裁决冲突，请先去「去重与冲突」页处理，再回来删除。`, "暂不能删除", { confirmButtonText: "知道了", type: "warning" });
    return;
  }
  const mounts = plan.mounts || [];
  const src = plan.sourceCount || 0;
  let text = `删除工具适配器「${t.name}」？`;
  if (mounts.length) text += `\n将摘除 ${mounts.length} 处挂载（只删链接，技能与目录都不动）。`;
  if (src) text += `\n${src} 条来源记录会保留为历史档案，显示为原 id。`;
  try {
    await ElMessageBox.confirm(text, "删除工具适配器", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
  } catch {
    return; // 用户点了取消
  }
  const r = await api.removeTool(t.id, true).catch(() => null);
  skMsg.value = r?.ok ? r.message || "已删除" : r?.message || "删除失败，请重试";
  await loadSkillsSettings();
  await app.refreshTools();
}

async function browseToolPath(toolId: string, idx: number) {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) {
    if (toolId === "custom") skCfg.value!.customDirs[idx] = r.path;
    else skCfg.value!.tools[toolId].paths[idx] = r.path;
  }
}

async function browseCustomAdd() {
  const r = await api.browseDir().catch(() => null);
  if (r?.ok && r.path) skCfg.value!.customDirs.push(r.path);
}

async function restoreTrash(name: string) {
  const r = await api.trashRestore(name).catch(() => null);
  skMsg.value = r?.ok ? `已还原到 ${r.dest}` : r?.message || "还原失败";
  await loadSkillsSettings();
}

async function purgeAll() {
  try {
    await ElMessageBox.confirm("立即永久删除 .trash 内的全部历史版本，此操作不可恢复。", "清空回收站", {
      confirmButtonText: "清空",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return; // 用户点了取消
  }
  const r = await api.trashPurge().catch(() => null);
  skMsg.value = r ? `已清理 ${r.purged} 项` : "清理失败，请重试";
  await loadSkillsSettings();
}

async function openDataDir() {
  try {
    await api.openDataDir();
  } catch {
    /* 浏览器预览无此能力 */
  }
}
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 技能仓库</div>
        <div class="cfg-sec-sub">工具适配器 · 同步与去重 · 调度 · 回收站。WebDAV 服务器在左下角「设置 · WebDAV 同步」配置；中央仓库跨设备同步在「WebDAV 同步」页。</div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn" @click="openDataDir"><i class="ph ph-folder-open"></i>打开数据目录</button>
        <button class="btn btn-cta" :disabled="skSaving" @click="saveSkillsSettings">{{ skSaving ? "保存中" : "保存配置" }}</button>
      </div>
    </div>

    <!-- 二级子板块 tab：页面内切换，不占横条菜单的位置 -->
    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'tools' }" @click="tab = 'tools'"><i class="ph ph-plugs"></i>工具适配器</button>
      <button class="cfg-subtab" :class="{ active: tab === 'sync' }" @click="tab = 'sync'"><i class="ph ph-arrows-counter-clockwise"></i>同步与调度</button>
      <button class="cfg-subtab" :class="{ active: tab === 'data' }" @click="tab = 'data'"><i class="ph ph-trash"></i>回收站与危险区</button>
    </div>

    <div class="sk-note" v-if="skMsg"><i class="ph ph-info"></i><div>{{ skMsg }}</div></div>

    <template v-if="skCfg">
      <template v-if="tab === 'tools'">
      <div class="sk-section">
        <h2>工具适配器</h2>
        <p class="desc">内置五个常用 agent，也可以扫描电脑自动发现其他 agent，或手动新增适配器（名字 + 候选技能目录）。候选路径按顺序探测，取第一个存在的。</p>
        <div class="sk-panel">
          <div class="tool-block" v-for="t in skTools" :key="t.id">
            <div class="tool-head">
              <div class="tool-title">
                <el-input size="small" v-model="skCfg!.tools[t.id]!.name" class="name-in" placeholder="显示名" />
                <span class="tool-id sk-mono">{{ t.id }}</span>
                <span class="sk-badge mute" v-if="t.builtin" title="内置工具不可删除，只能停用">内置</span>
              </div>
              <div class="sk-row" style="gap:10px">
                <label class="sk-row" style="gap:8px; cursor:pointer">
                  <span class="sk-small" style="color:var(--text-2)">启用</span>
                  <el-switch v-model="skCfg!.tools[t.id]!.enabled" />
                </label>
                <el-button size="small" type="danger" text v-if="t.deletable" @click="startRemove(t)"><i class="ph ph-trash"></i>删除</el-button>
              </div>
            </div>
            <div class="path-row" v-for="(p, i) in skCfg!.tools[t.id]!.paths" :key="i">
              <el-input size="small" v-model="skCfg!.tools[t.id]!.paths[i]" placeholder="候选路径（~ 开头或绝对路径）" class="mono-in" />
              <el-button size="small" @click="browseToolPath(t.id, i)" title="浏览"><i class="ph ph-folder-open"></i></el-button>
              <el-button size="small" v-if="skCfg!.tools[t.id]!.paths.length > 1" @click="skCfg!.tools[t.id]!.paths.splice(i, 1)" title="移除"><i class="ph ph-x"></i></el-button>
            </div>
            <div class="hit-line" v-if="t.dir"><span class="sk-badge ok"><i class="ph ph-check-circle"></i>命中：{{ t.dir }}</span></div>
            <div class="hit-line" v-else-if="t.enabled"><span class="sk-badge warn"><i class="ph ph-warning"></i>候选路径均不存在</span></div>
            <div class="add-line">
              <el-button size="small" @click="skCfg!.tools[t.id]!.paths.push('')"><i class="ph ph-plus"></i>添加候选路径</el-button>
            </div>
            <div class="sk-help" v-if="t.id === 'antigravity'">Antigravity 各版本全局技能路径有漂移（旧版 .gemini\antigravity\skills，新版 .gemini\config\skills），多候选按顺序取第一个命中项。</div>
          </div>

          <div class="probe-area">
            <div class="sk-row" style="gap:10px">
              <el-button size="small" :loading="probeLoading" @click="doProbe"><i class="ph ph-radar"></i>扫描电脑发现</el-button>
              <el-button size="small" @click="openManual"><i class="ph ph-plus"></i>手动新增适配器</el-button>
              <span class="sk-small sk-muted" style="align-self:center">探测只读不写配置，你点添加才会进列表。</span>
            </div>

            <!-- 发现结果：点添加即进工具列表，保存后生效 -->
            <div class="probe-panel" v-if="probeOpen">
              <div class="sk-muted sk-small" v-if="!probed.length">没有发现未注册的 agent 技能目录。装过 Cursor、Qoder、Roo Code 等但没扫到？用「手动新增」直接填目录。</div>
              <div class="sk-tool-row" v-for="r in probed" :key="r.suggestId">
                <div class="sk-tool-icon"><i class="ph" :class="r.icon"></i></div>
                <div class="t-main">
                  <div class="t-name">{{ r.name }}</div>
                  <div class="t-path">{{ r.hitDirs.join(" · ") }}{{ r.skillCount ? `（${r.skillCount} 个技能目录）` : "（空目录）" }}</div>
                </div>
                <el-button size="small" type="primary" text @click="adopt(r)"><i class="ph ph-plus"></i>添加</el-button>
              </div>
            </div>

            <!-- 手动新增：名字 + id + 首个路径 -->
            <div class="probe-panel" v-if="manualOpen">
              <div class="sk-field">
                <label>显示名</label>
                <el-input size="small" v-model="manual.name" placeholder="例如 Cursor" style="max-width:360px" @input="onNameInput" />
              </div>
              <div class="sk-field">
                <label>id（引用键，创建后不可改，用于来源与挂载记录）</label>
                <el-input size="small" v-model="manual.id" placeholder="例如 cursor" class="mono-in" style="max-width:360px" @input="idTouched = true" />
              </div>
              <div class="sk-field" style="margin-bottom:4px">
                <label>技能目录（可留空，保存后回到上面卡片再补候选路径）</label>
                <div class="path-row">
                  <el-input size="small" v-model="manual.path" placeholder="~/.cursor/skills 或绝对路径" class="mono-in" />
                  <el-button size="small" @click="browseManualPath" title="浏览"><i class="ph ph-folder-open"></i></el-button>
                </div>
              </div>
              <div class="sk-row" style="gap:10px">
                <el-button type="primary" size="small" @click="submitManual"><i class="ph ph-check"></i>添加</el-button>
                <el-button size="small" @click="manualOpen = false">取消</el-button>
              </div>
            </div>
          </div>

          <hr class="sk-divider" />
          <div class="tool-block" style="border-top:none; padding-top:0">
            <div class="tool-head">
              <span class="tool-name">自定义目录</span>
            </div>
            <p class="sk-help" style="margin-bottom:10px">没有 agent 身份的裸目录。若它是某个 agent 的技能目录，建议用上面的「手动新增适配器」挂个名字，来源归属和挂载状态会更清楚。</p>
            <div class="path-row" v-for="(p, i) in skCfg!.customDirs" :key="i">
              <el-input size="small" v-model="skCfg!.customDirs[i]" class="mono-in" />
              <el-button size="small" @click="browseToolPath('custom', i)" title="浏览"><i class="ph ph-folder-open"></i></el-button>
              <el-button size="small" @click="skCfg!.customDirs.splice(i, 1)" title="移除"><i class="ph ph-x"></i></el-button>
            </div>
            <div class="add-line">
              <el-button size="small" @click="browseCustomAdd"><i class="ph ph-plus"></i>添加自定义目录</el-button>
            </div>
          </div>
        </div>
      </div>
      </template>

      <template v-else-if="tab === 'sync'">
      <div class="sk-grid sk-grid-2 sk-section top-grid">
        <div>
          <h2>同步与去重</h2>
          <p class="desc">动作策略。调整只影响之后的同步。</p>
          <div class="sk-panel">
            <div class="sk-field">
              <label>挂载模式</label>
              <el-radio-group v-model="skCfg!.mountMode" class="mount-radio">
                <el-radio value="junction" border>
                  <span class="r-wrap">
                    <span class="r-title">Junction（推荐）</span>
                    <span class="r-desc">按技能粒度建立目录联接，无需管理员权限，中央仓库即时生效。</span>
                  </span>
                </el-radio>
                <el-radio value="copy" border>
                  <span class="r-wrap">
                    <span class="r-title">复制</span>
                    <span class="r-desc">直接复制文件，兼容性最好，但存在漂移风险。</span>
                  </span>
                </el-radio>
              </el-radio-group>
            </div>
            <div class="opt-row">
              <div>
                <div class="opt-title">L3 语义去重提示</div>
                <div class="sk-help">本地相似度计算，仅提示不动作</div>
              </div>
              <el-switch v-model="skCfg!.l3.enabled" />
            </div>
            <div class="sk-field days-field">
              <label>回收站保留天数</label>
              <el-input-number size="small" v-model="skCfg!.trashDays" :min="1" :max="90" style="width:150px" />
              <div class="sk-help">超期后由同步与清理动作自动清除；回收站内容见「回收站与危险区」子板块。</div>
            </div>
          </div>
        </div>

        <div>
          <h2>中央仓库</h2>
          <p class="desc">真身位置：skills（真身）、manifest.json、reports、.trash 四部分。</p>
          <div class="sk-panel">
            <div class="sk-field" style="margin-bottom:0">
              <label>中央仓库位置</label>
              <div class="path-row">
                <el-input size="small" :model-value="skHubDir" disabled class="mono-in" />
                <el-button size="small" @click="openDataDir" title="打开"><i class="ph ph-folder-open"></i></el-button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 后台与调度：定时 WebDAV 同步（托盘常驻 / 开机自启是框架级设置，在「设置 · 通用」） -->
      <div class="sk-section">
        <h2>后台与调度</h2>
        <p class="desc">定时同步。关闭窗口默认缩到托盘（在左下角「设置 · 通用」可改），托盘菜单可随时手动同步或暂停调度。</p>
        <div class="sk-panel">
          <div class="opt-row">
            <div>
              <div class="opt-title">每小时自动同步</div>
              <div class="sk-help">需先在左下角「设置 · WebDAV 同步」配置好 WebDAV 服务器</div>
            </div>
            <el-switch v-model="skCfg!.schedule.hourly" />
          </div>
          <div class="opt-row">
            <div>
              <div class="opt-title">每天定时同步</div>
              <div class="sk-help">错过时刻（关机 / 睡眠）后当天内会补跑一次</div>
            </div>
            <div class="opt-inline">
              <el-switch v-model="skCfg!.schedule.daily" />
              <el-time-picker size="small" v-model="skCfg!.schedule.dailyTime" value-format="HH:mm" format="HH:mm" style="width:120px" :disabled="!skCfg!.schedule.daily" placeholder="选择时间" />
            </div>
          </div>
          <div class="opt-row" style="padding-bottom:2px">
            <div>
              <div class="opt-title">同步成功也弹系统通知</div>
              <div class="sk-help">失败始终会提醒；开启后成功也通知一次</div>
            </div>
            <el-switch v-model="skCfg!.schedule.notifyOnSuccess" />
          </div>
        </div>
      </div>

      <!-- 自动感知：AI 在任一工具里新加技能，后台自动收纳分发 -->
      <div class="sk-section">
        <h2>自动感知</h2>
        <p class="desc">后台每 15 秒扫一遍各工具技能目录的目录名和修改时间：发现新技能且内容零冲突时自动收纳进中央并分发挂载；有冲突（同名不同内容）只弹通知、绝不替你选边。</p>
        <div class="sk-panel">
          <div class="opt-row" style="padding-bottom:2px">
            <div>
              <div class="opt-title">自动收纳新技能</div>
              <div class="sk-help">在 ZCode / Codex / Claude / 反重力等任一工具里让 AI 加技能，几十秒内自动入中央库并对各工具可见；关闭后在同步中心手动收纳</div>
            </div>
            <el-switch v-model="skCfg!.watch.enabled" />
          </div>
        </div>
      </div>
      </template>

      <template v-else>
      <div class="sk-section">
        <h2>回收站（{{ skTrash.length }} 项）</h2>
        <p class="desc">被替换 / 删除的技能目录先进回收站，保留 {{ skCfg!.trashDays }} 天可还原。</p>
        <div class="sk-panel" style="padding: 6px 18px;" v-if="skTrash.length">
          <div class="sk-tool-row" v-for="t in skTrash" :key="t.name">
            <div class="sk-tool-icon"><i class="ph ph-trash"></i></div>
            <div class="t-main">
              <div class="t-name">{{ t.name }}</div>
              <div class="t-path">{{ fmtTime(t.trashedAt) }} · {{ fmtSize(t.sizeBytes) }}</div>
            </div>
            <el-button size="small" @click="restoreTrash(t.name)"><i class="ph ph-arrow-u-up-left"></i>还原</el-button>
          </div>
        </div>
        <div class="sk-panel" v-else>
          <div class="sk-empty-state" style="padding:24px"><i class="ph ph-trash"></i><div class="es-title">回收站是空的</div></div>
        </div>
      </div>

      <div class="sk-section" style="margin-bottom: 8px">
        <h2>危险区</h2>
        <div class="sk-panel">
          <div class="opt-row" style="padding:2px 0">
            <div>
              <div class="opt-title" style="color:var(--danger)">清空回收站</div>
              <div class="sk-help">立即永久删除 <span class="sk-mono">.trash\</span> 内的全部历史版本，不可恢复。</div>
            </div>
            <el-button size="small" type="danger" plain @click="purgeAll"><i class="ph ph-trash"></i>清空</el-button>
          </div>
        </div>
      </div>
      </template>
    </template>
    <div class="sk-panel" v-else style="color:var(--text-3); text-align:center">读取配置中…</div>
  </div>
</template>

<style scoped>
.mono-in :deep(.el-input__inner) { font-family: var(--font-code); font-size: 12px; }

/* 统一 el 控件圆角：Element Plus 默认 4px，项目统一 8px */
:deep(.el-button),
:deep(.el-input__wrapper),
:deep(.el-select__wrapper),
:deep(.el-input-number),
:deep(.el-input-number .el-input__wrapper),
:deep(.el-date-editor),
:deep(.el-date-editor .el-input__wrapper) { border-radius: var(--r-sm); }

/* 左右两栏内容高度不同，顶对齐即可 */
.top-grid { align-items: start; }

/* 选项行：左标题+描述，右控件；相邻行用分隔线 */
.opt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 0;
}
.opt-row + .opt-row { border-top: 1px solid var(--border-soft); }
.opt-title { font-size: 13px; font-weight: 500; }
.opt-row .sk-help { margin-top: 2px; }
.opt-inline { display: flex; align-items: center; gap: 10px; }

/* 工具块：标题行 + 路径行 + 命中/添加，间距统一 */
.tool-block { padding: 16px 0; }
.tool-block + .tool-block { border-top: 1px solid var(--border-soft); }
.tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.tool-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.tool-name { font-weight: 600; font-size: 13.5px; }
.tool-id { color: var(--text-3); font-size: 11px; flex: none; }
.name-in { max-width: 220px; }
.path-row { display: flex; gap: 8px; margin-bottom: 8px; }
.path-row :deep(.el-input) { flex: 1; }
.hit-line { margin: 8px 0; }
.add-line { margin-top: 4px; }

/* 发现/新增面板：工具区底部的一组入口 + 内联结果 */
.probe-area { border-top: 1px solid var(--border-soft); padding: 16px 0 4px; }
.probe-panel { margin-top: 14px; padding: 14px 16px; background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 10px; }
.probe-panel .sk-tool-row { padding: 10px 0; }
.probe-panel .sk-field { margin-bottom: 12px; }

/* 挂载模式：两张可选卡片 */
.mount-radio {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  width: 100%;
}
.mount-radio :deep(.el-radio) {
  height: auto;
  align-items: flex-start;
  padding: 12px 14px;
  margin: 0;
  width: 100%;
  border-radius: var(--r-sm);
}
.mount-radio :deep(.el-radio__input) { margin-top: 3px; }
.mount-radio :deep(.el-radio__label) { white-space: normal; line-height: 1.55; padding-left: 8px; }
.r-wrap { display: block; }
.r-title { display: block; font-size: 13px; font-weight: 500; }
.r-desc { display: block; font-size: 11.5px; color: var(--text-3); margin-top: 2px; }

/* 回收站天数：最后一行不留大空隙 */
.days-field { margin-bottom: 0; padding-top: 13px; }
.days-field + .opt-row { border-top: 1px solid var(--border-soft); }
</style>
