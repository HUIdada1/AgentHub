import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Electron 前端配置：dev 端口 1420（与 electron/main.cjs 的加载地址一致）
// base 用相对路径，便于 Electron 通过 file:// 加载打包后的 index.html
export default defineConfig({
  plugins: [vue()],
  base: "./",
  clearScreen: false,
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
