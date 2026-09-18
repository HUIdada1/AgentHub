import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./assets/phosphor/style.css";
import "./styles/global.css";
import "./styles/skills.css";
import "./styles/sync.css";
import "./styles/element.css";
// 液滴光标 + 点击涟漪（纯装饰动效层：触屏/减弱动效下自动不安装；「界面动效」关闭时
// 也不安装 —— 开关镜像存 localStorage，配置异步加载前就能同步判定，冷启动不闪系统箭头）
import { setCursorFX } from "./motion/cursor";

const app = createApp(App);
app.use(createPinia());
// 中文 locale：日期面板月份/星期/按钮等 Element 内置文案全部中文化
app.use(ElementPlus, { locale: zhCn });
// mount 前安装：应用首帧渲染时光标已就位，避免先闪一下系统箭头
setCursorFX(localStorage.getItem("agenthub.fx") !== "0");
app.mount("#app");
