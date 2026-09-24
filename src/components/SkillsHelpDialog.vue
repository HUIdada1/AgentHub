<script setup lang="ts">
// 技能仓库 · 全局帮助对话框：各页面的「这是什么？」链接都指向这里。
// 只讲清楚六件事：同步什么 / 为什么扫出来多 / 孤儿是什么 / 来源标识 / 如何让工具用上中央库 / 安全底线
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const scroller = ref<HTMLElement | null>(null);

watch(
  () => app.helpOpen,
  async (open) => {
    if (open) {
      window.addEventListener("keydown", onEsc);
      if (app.helpSection) {
        await nextTick();
        scroller.value?.querySelector(`#${app.helpSection}`)?.scrollIntoView({ block: "start" });
      } else {
        scroller.value?.scrollTo({ top: 0 });
      }
    } else {
      window.removeEventListener("keydown", onEsc);
      app.helpSection = "";
    }
  }
);

function onEsc(e: KeyboardEvent) {
  if (e.key === "Escape") app.helpOpen = false;
}

onBeforeUnmount(() => window.removeEventListener("keydown", onEsc));
</script>

<template>
  <transition name="help-fade">
    <div v-if="app.helpOpen" class="help-overlay" @click.self="app.helpOpen = false">
      <div class="help-panel" role="dialog" aria-label="使用帮助">
        <div class="help-head">
          <i class="ph ph-lifebuoy"></i>
          <div>
            <div class="sk-strong">使用帮助</div>
            <div class="sk-muted sk-small">技能仓库是怎么工作的</div>
          </div>
          <button class="btn btn-ghost btn-sm help-close" @click="app.helpOpen = false"><i class="ph ph-x"></i>关闭</button>
        </div>

        <div class="help-body" ref="scroller">
          <section :id="'help-what'">
            <h3><i class="ph ph-arrows-left-right"></i>这个模块在同步什么</h3>
            <p>扫描对象是各 AI 编程工具的<b>全局技能目录</b>：内置 <span class="sk-mono">~\.zcode\skills</span>（ZCode）、<span class="sk-mono">~\.codex\skills</span>（Codex CLI）、<span class="sk-mono">~\.claude\skills</span>（Claude Code）、Antigravity 与通用 <span class="sk-mono">~\.agents\skills</span>，没装的目录自动跳过。设置里还可以<b>扫描电脑发现</b>其他 agent（Cursor、Qoder、Roo Code 等），或<b>手动新增任意工具适配器</b>（名字 + 技能目录），外加无身份的自定义目录。</p>
            <p>「同步」= 把这些目录里的技能<b>去重后收纳</b>进中央仓库 <span class="sk-mono">~\.agent_skills\skills</span>（唯一真身），再在原位置建好指向中央的 Junction，让多个工具共用同一份内容，并产出 MD 报告。</p>
          </section>

          <section :id="'help-why'">
            <h3><i class="ph ph-packages"></i>为什么扫出来的比装过的多</h3>
            <ul>
              <li><b>每个工具各算一份</b>：同一个技能装在 ZCode 和 Codex 里，就是两份独立副本，会被分别扫到。</li>
              <li><b>一个技能包往往含多个技能</b>：比如设计类技能包一次会带进十几个目录，看起来就「一大堆」。</li>
              <li><b>同一技能在不同工具下目录名可能不同</b>（如 <span class="sk-mono">gpt-taste</span> / <span class="sk-mono">taste-skill</span>），现阶段按两个技能收纳，交给去重页的 L2 归一提示处理。</li>
              <li><b>工具自带目录</b>（如 Codex 的 <span class="sk-mono">.system</span>，内含 skill-creator、imagegen 等官方技能）由工具自己维护：<b>默认不在技能库显示，只有搜索时才会出现</b>（带「系统自带」标识），并且永不参与收纳与同步。</li>
              <li>ZCode 插件自带的技能存放在插件缓存（<span class="sk-mono">~\.zcode\cli\plugins\cache\…</span>），不在扫描范围内。</li>
            </ul>
          </section>

          <section :id="'help-orphans'">
            <h3><i class="ph ph-folder-plus"></i>孤儿目录是什么</h3>
            <p><b>定义</b>：工具技能目录里真实存在、但中央仓库还没记录的技能目录——通常就是你新装、还没同步的技能。</p>
            <p>它<b>不是垃圾</b>：点一次同步的「确认执行」，就会被收进中央库并在原位转为挂载，孤儿列表随之清零。</p>
            <p>软件对孤儿<b>只标记、绝不自动删除</b>；任何删除/覆盖都先进回收站保留 7 天。</p>
            <p class="sk-muted sk-small">开源多设备提示：每台电脑装的东西不同，孤儿列表因机器而异是正常现象；配好 WebDAV 后，跨设备以中央仓库为准。</p>
          </section>

          <section :id="'help-origin'">
            <h3><i class="ph ph-seal-check"></i>来源标识怎么看</h3>
            <ul>
              <li><span class="sk-badge warn">系统自带</span>　工具自动维护的官方技能（目录内有 <span class="sk-mono">.codex-system-skills.marker</span> 等标记）。<b>默认隐藏，搜索时可见</b>；软件不收纳、不挂载、不删除。</li>
              <li><span class="sk-badge info">你安装的</span>　工具技能目录里的真实目录，来自你手动安装或技能包带入。</li>
              <li><span class="sk-badge ok">已挂载</span>　指向中央仓库的 Junction 链接。真身只有 <span class="sk-mono">~\.agent_skills\skills</span> 里那一份，改一处全工具生效。</li>
            </ul>
          </section>

          <section :id="'help-reference'" class="help-hl">
            <h3><i class="ph ph-plug"></i>如何让 ZCode / Codex 用上中央库</h3>
            <p><b>不需要改提示词，也不需要改 ZCode / Codex 的任何设置。</b>它们只认自己的默认技能目录，而同步之后，默认目录里的条目就是指向中央仓库的 Junction。</p>
            <ol>
              <li>打开<b>同步中心</b> → 扫描 → 确认执行；</li>
              <li>各工具默认技能目录里出现指向 <span class="sk-mono">~\.agent_skills\skills</span> 的 Junction（复制模式则是放回一份副本）；</li>
              <li>工具照常加载默认目录，读到的就是中央库的内容。</li>
            </ol>
            <p>之后的日常用法：<b>新技能装到任意一个工具 → 同步收进中央 → 自动分发到其他所有已连接工具</b>，一处更新处处生效。</p>
          </section>

          <section :id="'help-safety'">
            <h3><i class="ph ph-shield-check"></i>安全底线</h3>
            <p>默认干跑预览，你确认了才动文件；删除/覆盖先进 <span class="sk-mono">.trash</span> 保留 7 天；同名不同内容的冲突永远人工裁决；陌生目录只标记不删除。</p>
          </section>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.help-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(8, 10, 14, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.help-panel {
  width: 680px;
  max-width: 100%;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.help-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-soft);
}
.help-head > i {
  font-size: 26px;
  color: var(--accent);
}
.help-close {
  margin-left: auto;
}
.help-body {
  padding: 8px 20px 20px;
  overflow-y: auto;
}
.help-body section {
  padding: 14px 0;
  border-bottom: 1px dashed var(--border-soft);
}
.help-body section:last-child {
  border-bottom: none;
}
.help-body h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 14px;
}
.help-body h3 i {
  color: var(--accent);
  font-size: 18px;
}
.help-body p,
.help-body li {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-2);
  margin: 4px 0;
}
.help-body ul,
.help-body ol {
  margin: 4px 0;
  padding-left: 20px;
}
.help-body b {
  color: var(--text-2);
  font-weight: 600;
}
.help-hl {
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 14px 16px !important;
  margin: 8px 0;
}
.help-fade-enter-active,
.help-fade-leave-active {
  transition: opacity 0.18s ease;
}
.help-fade-enter-from,
.help-fade-leave-to {
  opacity: 0;
}
</style>
