/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import { isElectron } from "./api/ipc";
import { probeCaps } from "./api/caps";
import { getToken } from "./api/web-transport";
// 服务式 API 不经模板渲染，插件接管不到它们的样式：全库只用到这两个（② 段重数）。
// 中文 locale 的注入点随全量注册一起没了，改由 App.vue 的 <el-config-provider> 承接。
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
// Phosphor 子集：只保留全库真正用到的 98 条字形规则（全量 1530 条 / 82 KB）
// 图标增删后重跑 node tools/gen-phosphor-subset.cjs 再生成
import "./assets/phosphor/phosphor-used.css";
import "./styles/global.css";
import "./styles/skills.css";
import "./styles/sync.css";
import "./styles/memory.css";
import "./styles/prompts.css";
import "./styles/localgw.css";
import "./styles/element.css";
// 液滴光标 + 点击涟漪（纯装饰动效层：触屏/减弱动效下自动不安装）
// 首帧镜像（与 config 异步加载形成双轨）：界面动效默认开启，镜像为 "0" 才关（缺失跟随默认）；
// 粒子尘场 / 光池追随默认关闭，镜像为 "1" 才开；个性化鼠标样式默认开启，镜像为 "0" 才关。
// html 类在这里同步切好，首帧即按配置态渲染
import { setCursorFX } from "./motion/cursor";

const app = createApp(App);
app.use(createPinia());
// mount 前安装：动效开启的用户光标已就位，避免先闪一下系统箭头
const fxOn = localStorage.getItem("agenthub.fx") !== "0";
// 液滴光标与总开关联动：任一关掉都恢复系统指针
const cursorOn = fxOn && localStorage.getItem("agenthub.fxCursor") !== "0";
const root = document.documentElement;
root.classList.toggle("fx-off", !fxOn);
root.classList.toggle("fx-particles-off", localStorage.getItem("agenthub.fxParticles") !== "1");
root.classList.toggle("fx-pools-off", localStorage.getItem("agenthub.fxPools") !== "1");
// 桌面端标记：窗口是无边框的，顶栏要靠 -webkit-app-region: drag 当拖拽区。
// 浏览器里这个属性会吃掉点击，所以只在 Electron 下挂，CSS 用 html.is-electron 限定作用域
root.classList.toggle("is-electron", isElectron());
setCursorFX(cursorOn);

// 启动形态三选一：Electron 直接挂载（IPC）；浏览器先探测网关托管（有后端走 RPC，
// 无令牌先挂登录页）；纯静态预览（dev:web）回落挂载走 mock
async function bootstrap() {
  if (isElectron()) {
    app.mount("#app");
    return;
  }
  const caps = await probeCaps();
  if (caps && !getToken()) {
    const { default: WebLogin } = await import("./views/WebLogin.vue");
    createApp(WebLogin).mount("#app");
    return;
  }
  app.mount("#app");
}
void bootstrap();
