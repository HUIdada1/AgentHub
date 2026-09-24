<script setup lang="ts">
// 技能仓库 · 技能详情：已收纳（manifest）/ 待收纳（工具目录里还没进中央仓库）/ 不存在 / 加载中 四态
import { ref, computed, onMounted, watch } from "vue";
import { getSkill, toggleMount, removeSkill, type SkillDetail } from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { fmtDate } from "../../utils/format";

const app = useAppStore();
// undefined = 加载中，null = 技能不存在
const detail = ref<SkillDetail | null | undefined>(undefined);
const actionMsg = ref("");

async function load() {
  if (!app.skillDetailName) {
    detail.value = null;
    return;
  }
  detail.value = undefined;
  try {
    detail.value = await getSkill(app.skillDetailName);
  } catch {
    detail.value = null;
  }
}

async function doToggleMount(tool: string, enable: boolean) {
  if (!detail.value?.manifest) return;
  const r = await toggleMount(detail.value.manifest.name, tool, enable).catch(() => null);
  actionMsg.value = r?.ok ? r.message : r?.message || "操作失败";
  await load();
}

async function doRemove() {
  if (!detail.value?.manifest) return;
  const name = detail.value.manifest.name;
  if (!confirm(`确定把技能 ${name} 移到回收站吗？\n真身将移入 .trash 保留 7 天，可还原。`)) return;
  const r = await removeSkill(name).catch(() => null);
  if (r?.ok) {
    app.go("library");
  } else {
    actionMsg.value = r?.message || "操作失败";
  }
}

const frontmatter = computed(() => {
  const md = detail.value?.skillMd || "";
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : md.slice(0, 600);
});

// 工具自带的系统技能：只读展示，不给收纳引导
const isSystemSkill = computed(() => (detail.value?.sources || []).some((s) => s.origin === "system"));

function mountedAll(): boolean {
  const mounts = detail.value?.manifest?.mounts || [];
  return mounts.length > 0 && mounts.every((m) => m.enabled);
}

async function toggleAll(enable: boolean) {
  const name = detail.value?.manifest?.name;
  if (!name) return;
  const mounts = detail.value?.manifest?.mounts || [];
  for (const m of mounts) {
    if (m.enabled === enable) continue;
    await toggleMount(name, m.tool, enable);
  }
  await load();
}

watch(() => app.skillDetailName, load);
onMounted(load);
</script>

<template>
  <section class="page sk-page">
    <div style="margin-bottom:22px">
      <a class="sk-row sk-muted sk-small" style="gap:6px; cursor:pointer" @click="app.go('library')"><i class="ph ph-arrow-left"></i>返回中央技能库</a>
    </div>

    <div class="sk-note sk-mt-8 sk-mb-16" v-if="actionMsg"><i class="ph ph-info"></i><div>{{ actionMsg }}</div></div>

    <!-- 已收纳：完整管理视图 -->
    <template v-if="detail && detail.manifest">
      <div class="sk-page-head">
        <div class="sk-row" style="gap:14px">
          <div class="s-icon" style="width:46px; height:46px; display:grid; place-items:center; border-radius:12px; background:var(--accent-dim); color:var(--accent); font-size:24px"><i class="ph ph-package"></i></div>
          <div>
            <h1 style="font-size:24px">{{ detail.manifest.name }}</h1>
            <p class="sub" style="margin-top:4px">
              v{{ detail.manifest.version || "0.0.0" }} · {{ detail.manifest.description?.slice(0, 60) || "（无描述）" }}
            </p>
          </div>
        </div>
        <div class="sk-head-actions">
          <label class="sk-row" style="gap:8px; cursor:pointer">
            <span class="sk-small" style="color:var(--text-2)">全工具启用</span>
            <div class="switch" :class="{ on: mountedAll() }" role="switch" :aria-checked="mountedAll()" @click="toggleAll(!mountedAll())"></div>
          </label>
          <button class="btn btn-outline danger" @click="doRemove"><i class="ph ph-trash"></i>移到回收站</button>
        </div>
      </div>

      <div class="sk-panel">
        <div class="sk-small" style="font-weight:600; margin-bottom:6px">描述</div>
        <div style="color:var(--text-2); font-size:13px">{{ detail.manifest.description || "（缺 description，Agent 将无法触发该技能）" }}</div>
      </div>

      <div class="sk-grid sk-grid-2 sk-section">
        <div>
          <h2>SKILL.md frontmatter</h2>
          <p class="desc">解析自中央仓库真身文件，只读展示。</p>
          <div class="sk-code">{{ frontmatter }}</div>
        </div>
        <div>
          <h2>指纹与来源</h2>
          <p class="desc">内容树哈希是去重与变更检测的依据。</p>
          <div class="sk-panel" style="padding:6px 18px">
            <div class="sk-tool-row">
              <div class="sk-tool-icon"><i class="ph ph-fingerprint"></i></div>
              <div class="t-main">
                <div class="t-name">内容树哈希</div>
                <div class="t-path">{{ detail.manifest.treeHash }}</div>
              </div>
            </div>
            <div class="sk-tool-row">
              <div class="sk-tool-icon"><i class="ph ph-git-branch"></i></div>
              <div class="t-main">
                <div class="t-name">收录来源</div>
                <div class="t-path">{{ detail.manifest.sources.map((s) => `${s.tool}:${s.originalName || s.name}`).join(" · ") || "—" }}</div>
              </div>
            </div>
            <div class="sk-tool-row">
              <div class="sk-tool-icon"><i class="ph ph-clock-counter-clockwise"></i></div>
              <div class="t-main">
                <div class="t-name">合并历史</div>
                <div class="t-path">{{ detail.manifest.mergeHistory.length }} 条记录 · 最近 {{ fmtDate(detail.manifest.mergeHistory[detail.manifest.mergeHistory.length - 1]?.at) }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sk-section">
        <h2>挂载状态</h2>
        <p class="desc">中央真身与各工具目录中的 Junction。摘除某个挂载即代表该工具停用此技能。</p>
        <div class="sk-panel" style="padding: 6px 8px; overflow-x:auto" v-if="detail.manifest.mounts.length">
          <table class="sk-table">
            <thead>
              <tr><th>工具</th><th>挂载点</th><th>类型</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in detail.manifest.mounts" :key="m.tool + m.path">
                <td class="strong">{{ app.toolName(m.tool) }}</td>
                <td class="sk-mono" style="font-size:11px">{{ m.path }}</td>
                <td><span class="sk-badge info">{{ m.type === "junction" ? "Junction" : "复制" }}</span></td>
                <td>
                  <span class="sk-badge ok" v-if="m.enabled"><i class="ph ph-check"></i>有效</span>
                  <span class="sk-badge mute" v-else><i class="ph ph-minus-circle"></i>已停用</span>
                </td>
                <td>
                  <button class="btn btn-ghost btn-sm" v-if="m.enabled" @click="doToggleMount(m.tool, false)"><i class="ph ph-link-break"></i>摘除</button>
                  <button class="btn btn-ghost btn-sm" v-else @click="doToggleMount(m.tool, true)"><i class="ph ph-arrow-clockwise"></i>重建</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="sk-panel" v-else>
          <div class="sk-empty-state" style="padding:26px">
            <i class="ph ph-link-break"></i>
            <div class="es-title">该技能尚未挂载到任何工具</div>
            <div class="es-desc">去同步中心执行一次同步，将自动发布挂载到全部已连接工具。</div>
          </div>
        </div>
        <div class="sk-note sk-mt-16">
          <i class="ph ph-shield-check"></i>
          <div>摘除只删除 Junction 本身，不影响中央真身与技能内容。删除 Junction 使用系统删除语义，不会穿透到目标目录。</div>
        </div>
      </div>

      <div class="sk-section">
        <h2>变更历史</h2>
        <p class="desc">manifest 记录的全部合并与裁决动作，可追溯。</p>
        <div class="sk-panel sk-timeline">
          <div class="tl-row" v-for="(h, i) in detail.manifest.mergeHistory" :key="i">
            <span class="tl-time">{{ fmtDate(h.at) }}</span>
            <div class="tl-main">
              <div class="tl-title">{{ h.action }}</div>
              <div class="tl-desc">{{ h.detail }}</div>
            </div>
          </div>
          <div class="tl-row" v-if="!detail.manifest.mergeHistory.length">
            <div class="tl-main"><div class="tl-desc sk-muted">暂无记录</div></div>
          </div>
        </div>
      </div>
    </template>

    <!-- 待收纳：内容可看，引导去同步 -->
    <template v-else-if="detail">
      <div class="sk-page-head">
        <div class="sk-row" style="gap:14px">
          <div class="s-icon" style="width:46px; height:46px; display:grid; place-items:center; border-radius:12px; background:var(--info-dim); color:var(--info); font-size:24px"><i class="ph ph-package"></i></div>
          <div>
            <h1 style="font-size:24px">{{ app.skillDetailName }}</h1>
            <p class="sub" style="margin-top:4px" v-if="isSystemSkill">工具自动维护的系统技能，默认不在技能库展示，也不参与收纳与同步。</p>
            <p class="sub" style="margin-top:4px" v-else>该技能还在各工具目录里，尚未收进中央仓库。</p>
          </div>
        </div>
        <div class="sk-head-actions">
          <span class="sk-badge warn" v-if="isSystemSkill" style="align-self:center"><i class="ph ph-shield-check"></i>系统自带</span>
          <template v-else>
            <span class="sk-badge info" style="align-self:center"><i class="ph ph-download-simple"></i>待收纳</span>
            <button class="btn btn-cta" @click="app.go('sync')"><i class="ph ph-arrows-left-right"></i>去同步中心收纳</button>
          </template>
        </div>
      </div>

      <div class="sk-panel">
        <div class="sk-small" style="font-weight:600; margin-bottom:6px">描述</div>
        <div style="color:var(--text-2); font-size:13px">{{ detail.health.length ? detail.health.map((h) => h.text).join("；") : "SKILL.md 体检通过，无异常提醒" }}</div>
      </div>

      <div class="sk-grid sk-grid-2 sk-section">
        <div>
          <h2>SKILL.md frontmatter</h2>
          <p class="desc">读取自工具目录中的原始文件，收纳后以中央仓库为准。</p>
          <div class="sk-code">{{ frontmatter }}</div>
        </div>
        <div>
          <h2>来源</h2>
          <p class="desc" v-if="isSystemSkill">来自工具的系统技能目录，由工具自动维护。</p>
          <p class="desc" v-else>同步时会把下面这些目录里的同名技能合并收纳。</p>
          <div class="sk-panel" style="padding:6px 18px">
            <div class="sk-tool-row" v-for="(s, i) in detail.sources || []" :key="i">
              <div class="sk-tool-icon"><i class="ph ph-git-branch"></i></div>
              <div class="t-main">
                <div class="t-name">{{ app.toolName(s.tool) }}</div>
                <div class="t-path">{{ s.name }}</div>
              </div>
            </div>
            <div class="sk-tool-row" v-if="!(detail.sources || []).length">
              <div class="t-main"><div class="t-path">未探测到来源目录，请先执行一次同步扫描</div></div>
            </div>
          </div>
          <div class="sk-note sk-mt-16">
            <i class="ph ph-lightbulb"></i>
            <div>收纳后中央仓库只保留一份真身，各工具目录改为 Junction 共用，改一处全部生效。</div>
          </div>
        </div>
      </div>
    </template>

    <div class="sk-panel" v-else-if="detail === null">
      <div class="sk-empty-state">
        <i class="ph ph-file-x"></i>
        <div class="es-title">找不到这个技能</div>
        <div class="es-desc">它可能已被移到回收站，或目录已改名。回技能库刷新看看。</div>
      </div>
    </div>
    <div class="sk-panel" v-else>
      <div class="sk-empty-state"><i class="ph ph-file-text"></i><div class="es-title">加载中…</div></div>
    </div>
  </section>
</template>
