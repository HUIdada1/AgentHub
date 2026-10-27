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
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

// Electron 前端配置：dev 端口 1420（与 electron/main.cjs 的加载地址一致）
// base 用相对路径，便于 Electron 通过 file:// 加载打包后的 index.html
export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需注册：模板里的 <el-*> 自动引入组件与各自样式，替代原来的
    // app.use(ElementPlus) 全量注册 + index.css 全量样式（那份 CSS 单文件 361,258 字节，
    //   覆盖 element-plus/es/components 下 124 个组件目录，而本仓库模板里用到的 el-* 标签只有 18 个（不含不渲染 DOM 的 el-config-provider）。
    // directives: false —— 全库没用 v-loading / ElInfiniteScroll 等指令式组件（自测第 ③ 段扫）。
    // dirs: [] —— 关掉默认的 src/components 递归扫描：不关它，插件会把 34 个本地组件
    // （Sidebar / Drawer / Heatmap 这类通用名）一并登记成全局组件，与显式 import 重名时
    // 静默换实现。实测产物字节不变，这条纯粹是不引入那层歧义。
    Components({
      resolvers: [ElementPlusResolver({ directives: false })],
      dirs: [],
      dts: "src/components.d.ts",
    }),
  ],
  base: "./",
  clearScreen: false,
  // 依赖预扫描的入口只认根 index.html。
  // 默认值是 **/*.html，会把 tmp/ 与 release/ 下的杂散 HTML 一起当入口：其中
  // tmp/nsis/LICENSES.chromium.html 有 18.6MB，tmp/baseline-*/index.html 是整仓快照副本
  // （里面的 /src/main.ts 会把扫描引回真实源码图）。扫描一旦失败，dev server 直接退出，
  // 表现为「Electron 起来了但界面白屏、而 curl 单个模块却返回 200」——很难归因。
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: ["es2021", "chrome100"],
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
  },
});
