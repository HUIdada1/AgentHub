<!-- 设置 · 同步时间：各板块「自动同步 / 自动刷新 / 本地感知」的周期统一在这里管。
     三个配置源各自走自己的保存链路——框架（技能仓库+反代网关）app.save()、
     用量统计 syncApp.save()、记忆仓库 mem.save()；改动即改即存，状态反馈集中在顶部 -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAppStore } from "../../stores/app";
import { useSyncStore } from "../../stores/sync";
import { useMemoryStore } from "../../stores/memory";

const app = useAppStore();
const syncApp = useSyncStore();
const mem = useMemoryStore();

const ready = ref(false);
const saveState = ref("");
let stateTimer = 0;

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

/** 框架配置（技能仓库调度 / 本地感知 / 反代网关周期）改动即存 */
async function saveFramework() {
  const r = await app.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

/** 用量统计调度改动即存 */
async function saveUsage() {
  const r = await syncApp.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

/** 记忆仓库同步配置改动即存（schema 热生效，调度器下一拍自取） */
async function saveMemory(entries: Record<string, unknown>) {
  try {
    await mem.save(entries);
    feedback("已保存");
  } catch (e) {
    feedback(`保存失败：${(e as Error).message || "未知错误"}`);
  }
}

function setWatchInterval(v: number) {
  if (!Number.isFinite(v)) return;
  app.config.watch.intervalSeconds = Math.min(600, Math.max(5, Math.round(v)));
  void saveFramework();
}

function setMemInterval(v: number) {
  if (!Number.isFinite(v)) return;
  void saveMemory({ "sync.intervalMin": Math.min(1440, Math.max(5, Math.round(v))) });
}

onMounted(async () => {
  // 两个模块配置是懒加载：没加载过就先拉，否则会用默认值盖掉磁盘真实配置
  // （load() 不做幂等守卫，重复调用会重启进度轮询，所以这里自己挡一道）
  await Promise.all([syncApp.loaded ? Promise.resolve() : syncApp.load(), mem.loadAll()]);
  ready.value = true;
});
</script>

<template>
  <div v-if="ready" class="timing-sec">
    <div class="tg-head">
      <span class="tg-hint">各板块的自动同步 / 自动刷新周期统一在这里调整，改动即存即生效。各板块配置页里的同类入口已改为引导到这里。</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
    </div>

    <div class="tg-group">技能仓库</div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">每小时自动同步（WebDAV）</div>
        <div class="s-desc">开启后每小时把本机技能与中央仓库互相同步一次</div>
      </div>
      <div class="switch" :class="{ on: app.config.schedule.hourly }" role="switch" :aria-checked="app.config.schedule.hourly" @click="app.config.schedule.hourly = !app.config.schedule.hourly; saveFramework()"></div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">每天定时同步（WebDAV）</div>
        <div class="s-desc">每天到点同步一次；错过时刻（关机/睡眠）当天内补跑</div>
      </div>
      <div class="tg-ctl">
        <input v-if="app.config.schedule.daily" type="time" class="f-input" style="width: 110px" v-model="app.config.schedule.dailyTime" @change="saveFramework" />
        <div class="switch" :class="{ on: app.config.schedule.daily }" role="switch" :aria-checked="app.config.schedule.daily" @click="app.config.schedule.daily = !app.config.schedule.daily; saveFramework()"></div>
      </div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">同步成功也弹系统通知</div>
        <div class="s-desc">失败始终会提醒；开启后成功也通知一次</div>
      </div>
      <div class="switch" :class="{ on: app.config.schedule.notifyOnSuccess }" role="switch" :aria-checked="app.config.schedule.notifyOnSuccess" @click="app.config.schedule.notifyOnSuccess = !app.config.schedule.notifyOnSuccess; saveFramework()"></div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">本地目录自动感知</div>
        <div class="s-desc">按周期快照各工具技能目录，有新技能且零冲突时自动收纳</div>
      </div>
      <div class="tg-ctl">
        <template v-if="app.config.watch.enabled">
          <input type="number" class="f-input" style="width: 90px" min="5" max="600" :value="app.config.watch.intervalSeconds" @change="setWatchInterval(Number(($event.target as HTMLInputElement).value))" />
          <span class="tg-unit">秒</span>
        </template>
        <div class="switch" :class="{ on: app.config.watch.enabled }" role="switch" :aria-checked="app.config.watch.enabled" @click="app.config.watch.enabled = !app.config.watch.enabled; saveFramework()"></div>
      </div>
    </div>

    <div class="tg-group">用量统计</div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">每小时同步（WebDAV）</div>
        <div class="s-desc">开启后按选定周期自动上传本机用量并拉取他机</div>
      </div>
      <div class="tg-ctl">
        <select v-if="syncApp.config.schedule.hourly" class="f-select" style="width: 110px" v-model.number="syncApp.config.schedule.hourlyInterval" @change="saveUsage">
          <option v-for="n in [1, 2, 3, 6, 12]" :key="n" :value="n">{{ n }} 小时</option>
        </select>
        <div class="switch" :class="{ on: syncApp.config.schedule.hourly }" role="switch" :aria-checked="syncApp.config.schedule.hourly" @click="syncApp.config.schedule.hourly = !syncApp.config.schedule.hourly; saveUsage()"></div>
      </div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">每天固定时间</div>
        <div class="s-desc">每天到点同步一次（错过自动补跑）</div>
      </div>
      <div class="tg-ctl">
        <input v-if="syncApp.config.schedule.daily" type="time" class="f-input" style="width: 110px" v-model="syncApp.config.schedule.dailyTime" @change="saveUsage" />
        <div class="switch" :class="{ on: syncApp.config.schedule.daily }" role="switch" :aria-checked="syncApp.config.schedule.daily" @click="syncApp.config.schedule.daily = !syncApp.config.schedule.daily; saveUsage()"></div>
      </div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">同步成功也弹系统通知</div>
        <div class="s-desc">失败始终会提醒；开启后成功也通知一次</div>
      </div>
      <div class="switch" :class="{ on: syncApp.config.schedule.notifyOnSuccess }" role="switch" :aria-checked="syncApp.config.schedule.notifyOnSuccess" @click="syncApp.config.schedule.notifyOnSuccess = !syncApp.config.schedule.notifyOnSuccess; saveUsage()"></div>
    </div>

    <div class="tg-group">反代网关</div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">额度自动刷新周期</div>
        <div class="s-desc">逐账号批量查询各渠道额度（每渠道并发 ≤2）</div>
      </div>
      <select class="f-select" style="width: 120px" v-model.number="app.config.proxy.creditsRefreshMin" @change="saveFramework">
        <option :value="10">10 分钟</option>
        <option :value="30">30 分钟</option>
        <option :value="60">60 分钟</option>
      </select>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">定时自动签到</div>
        <div class="s-desc">每天到点自动跑全渠道签到（幂等，已签过自动跳过；到点未开机则开机后补跑）</div>
      </div>
      <div class="tg-ctl">
        <input v-if="app.config.proxy.checkinAuto" type="time" class="f-input" style="width: 110px" v-model="app.config.proxy.checkinAutoTime" @change="saveFramework" />
        <div class="switch" :class="{ on: app.config.proxy.checkinAuto }" role="switch" :aria-checked="app.config.proxy.checkinAuto" @click="app.config.proxy.checkinAuto = !app.config.proxy.checkinAuto; saveFramework()"></div>
      </div>
    </div>

    <div class="tg-group">记忆仓库</div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">自动同步（WebDAV）</div>
        <div class="s-desc">开启后按周期与其它设备互相同步记忆仓库</div>
      </div>
      <div class="switch" :class="{ on: !!mem.cfg('sync.auto', true) }" role="switch" :aria-checked="!!mem.cfg('sync.auto', true)" @click="saveMemory({ 'sync.auto': !mem.cfg('sync.auto', true) })"></div>
    </div>
    <div class="switch-row">
      <div class="s-left">
        <div class="s-title">同步间隔</div>
        <div class="s-desc">5 ~ 1440 分钟；记忆页「WebDAV 同步」也可随时手动跑</div>
      </div>
      <div class="tg-ctl">
        <input type="number" class="f-input" style="width: 90px" min="5" max="1440" :value="Number(mem.cfg('sync.intervalMin', 60))" @change="setMemInterval(Number(($event.target as HTMLInputElement).value))" />
        <span class="tg-unit">分钟</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timing-sec {
  display: flex;
  flex-direction: column;
}
.tg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
}
.tg-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.tg-state {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent-strong);
}
.tg-group {
  margin-top: 14px;
  padding-top: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
}
.tg-group:first-of-type {
  margin-top: 2px;
}
.tg-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tg-unit {
  font-size: 11px;
  color: var(--text-3);
}
</style>
