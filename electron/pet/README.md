# 桌宠组件（悬浮桌宠 · 卡冈图雅）

独立模块。一个置顶、无边框、透明的悬浮窗，渲染《星际穿越》的卡冈图雅黑洞：
事件视界纯黑 + 相对论吸积盘 + 史瓦西引力透镜（实时采样它背后的桌面画面并做径向弯曲）。

**不新建独立主程序**：窗口由 AgentHub 主进程创建，与主窗口生命周期解耦；
关掉桌宠 = 销毁窗口，不残留定时器、采样流或进程。

---

## 1. 目录结构

```
electron/pet/
├─ index.cjs            模块入口：boot / shutdown / reloadConfig（主进程只认这三个）
├─ pet-config.cjs       配置读写与脏数据归一化（落在主 config.json 的 pet 段）
├─ pet-window.cjs       悬浮窗：置顶 / 穿透 / 拖拽 / 缩放 / 位置持久化 / 显示器变化
├─ pet-menu.cjs         右键菜单（原生 Menu，按 rightMenu.* 动态显隐）
├─ pet-actions.cjs      右键动作：优化提示词、今日 token 用量、隐藏 / 重置 / 关闭
├─ pet-input.cjs        前台窗口键盘模拟（koffi → user32，仅 Windows）
├─ pet-capture.cjs      屏幕捕获源代理（按窗口所在显示器取 sourceId）
├─ pet-ipc.cjs          IPC 注册：主窗口 6 条命令 + 桌宠窗 2 条聚合通道
├─ preload-pet.cjs      桌宠窗专用 preload（暴露 window.petHost）
└─ web/                 渲染层（file:// 加载，classic script，禁用 ES module）
   ├─ index.html        画布 + 按序加载脚本
   ├─ pet.css           透明窗样式（html/body/canvas 全透明）
   ├─ capture.js        屏幕采样管线（getUserMedia + requestVideoFrameCallback）
   ├─ lens.js           Pass 1：引力透镜 GLSL
   ├─ disk.js           Pass 2：吸积盘 / 光子环 GLSL
   ├─ renderer.js       WebGL2 渲染器 + 2D 降级
   └─ app.js            编排：boot / rAF / 鼠标 / 右键 / 配置事件 / 暂停恢复
```

---

## 2. 挂载点（与现有项目对接的**全部**位置）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `electron/main.cjs` | `require("./pet/index.cjs")` | 顶部与其它模块并列 |
| `electron/main.cjs` | `pet.boot({ ipcMain, usageTodaySummary, formatNum, notify })` | `app.whenReady()` 内、`createWindow()` 之后；宿主能力由主进程注入，pet 不重复实现统计口径 |
| `electron/main.cjs` | `ipc.onConfigSaved(() => pet.reloadConfig())` | 设置面板整份保存后重读应用（改尺寸/置顶/采样即时生效） |
| `electron/main.cjs` | `pet.shutdown()` | `before-quit` 的 cleanup 末尾；透明置顶窗不会随主窗关闭而消失 |
| `electron/backend/config.cjs` | `defaultConfig().pet` | 首次落盘的默认值基线 |
| `electron/preload.cjs` | `ALLOWED_COMMANDS` 增 6 条 | `pet_status` / `pet_config_save` / `pet_set_enabled` / `pet_reset_position` / `pet_usage_today` / `pet_optimize_preview` |
| `src/types/index.ts` | `PetConfig` / `PET_CONFIG_DEFAULTS` / `SettingsTab` + `SETTINGS_TABS` | 设置弹窗左列新增「桌宠组件」页签 |
| `src/api/ipc.ts` | 6 个 `pet*` 函数 | 主界面唯一调用面 |
| `src/api/mock.ts` | 6 个 case + `mergePet` | 浏览器预览可跑通配置读写 |
| `src/stores/app.ts` | `defaultConfig.pet` | 深合并基线，防 `app.config.pet` 为 undefined |
| `src/components/config/SettingsDialog.vue` | 懒挂载 + 宽度/高度 | 与其它分节同款 |
| `src/components/config/ConfigPetSection.vue` | 新增 | 控制台页面 |

三处默认值必须逐字一致（否则会出现「设置页改完、下次读回默认值」）：
`electron/backend/config.cjs` · `electron/pet/pet-config.cjs` · `src/types/index.ts`。

---

## 3. 数据流

```
设置页 ─ pet_* IPC ──► index.cjs ──► pet-config.patch() ──► config.json
                          │
                          └─► applyConfig() ──► pet-window（建/销/改尺寸/置顶/穿透）
                                              └─ pet:event(config-changed) ─► 渲染层

右键菜单（原生 Menu）─► pet-actions ─► optimize.cjs（提示词库同一套模型/风格/历史）
                                    └► usageTodaySummary()（托盘同一份统计）

渲染层 ─ pet:rpc(boot / patch / usage-today / capture-source)
       └ pet:ipc(set-interactive / drag-start / drag-end / context-menu / hide / close / reset-position / log)
```

- 主窗口只认 6 条 `pet_*`；桌宠窗收敛到 `pet:ipc`（单向）与 `pet:rpc`（请求响应），
  并且主进程校验 `event.sender === 桌宠窗 webContents`，主窗口无法借此调用桌宠窗能力。
- 右键菜单改了配置 → 主进程发 `app:event { event: "pet-config-changed" }`，
  `src/App.vue` 直接替换内存里的 `app.config.pet`，避免之后保存整份 config 时把改动冲掉。

---

## 4. 配置字段（`config.json → pet`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；关闭即销毁窗口 |
| `theme` | `"gargantua"` | 预留多桌宠扩展位 |
| `size` | `240` | 窗口边长 DIP，120~720 |
| `diskSpeed` | `1` | 吸积盘转速倍率 0~3（开普勒差速：内快外慢） |
| `lensStrength` | `1` | 引力扭曲强度 0~2.5 |
| `fxEnabled` | `true` | 特效总开关：关掉后不采样、不畸变 |
| `screenSample` | `true` | 是否采样背后的实时桌面（关闭用程序化星空底） |
| `captureFps` | `30` | 采样帧率 15/30/60 |
| `opacity` | `1` | 0.35~1，只作用于渲染 alpha |
| `alwaysOnTop` | `true` | `floating` 级别，不抢全屏内容层级 |
| `clickThrough` | `true` | true = 仅盘面热区可交互；false = 整窗接收鼠标 |
| `pos` | `{x:null,y:null}` | 运行时由窗口独占写入，配置补丁不接受该字段 |
| `rightMenu.*` | 全 `true` | 右击菜单项显隐 |
| `optimize.{styleId,source,pasteBack,extra}` | — | 提示词优化偏好 |

---

## 5. 渲染与性能

- **两 pass**：Pass 1 覆盖写「被引力弯曲的桌面采样」；Pass 2 加法叠加吸积盘 + 光子环。
- **只在有效区域算**：两个片元着色器都用 `r > R_outer` 早退 `discard`，窗口其余像素保持 alpha=0（透明）。
- **视界内纯黑**：`r < Rh` 直接输出黑色不透明，不采样背景。
- **引力畸变是径向位移**（`beta = theta - thetaE²/theta`），不是鱼眼/桶形；外缘 80% 处开始羽化。
- **降级链**：WebGL2 不可用 → 2D canvas 静态黑洞（黑圆 + 橙环 + 光子环），绝不白屏；
  屏幕采样失败 → 程序化星空底；窗口隐藏 → 停 rAF 与采样。
- **采样分辨率**为显示器物理尺寸的一半，并用 `requestVideoFrameCallback` 跟视频帧上传纹理。

---

## 6. 调试开关（仅本地验证用，生产不要设）

| 环境变量 | 作用 |
| --- | --- |
| `AGENTHUB_PET_NO_CAPTURE_GUARD=1` | 跳过 `setContentProtection`，让全屏截图能拍到桌宠（会失去「黑洞不递归拍自己」的保护） |
| `AGENTHUB_PET_SNAPSHOT=<png 绝对路径>` | 启动后抓一张窗口自身内容（带 alpha），用于验证渲染 |
| `AGENTHUB_PET_SNAPSHOT_DELAY` | 上面那张快照的延迟毫秒（默认 5000） |

日志：`<dataDir>/logs/pet.log`（超过 512KB 轮转一份 `.1`）。

---

## 7. 已知限制

- **窗口对系统截图/录屏不可见**：`setContentProtection(true)`（WDA_EXCLUDEFROMCAPTURE）是必需的，
  否则 desktopCapturer 会把桌宠自己拍进去，黑洞里递归出现下一个黑洞。
- **键盘模拟仅 Windows**：`pet-input.cjs` 依赖 `koffi + user32.keybd_event`；
  非 Windows 上自动降级为「只处理剪贴板」，`pet_optimize_preview` 会写明原因。
- **屏幕采样需要 WebGL2**：2D 降级模式用程序化星空底（不采样桌面）。
- 吸积盘纹理全部程序化生成，不依赖任何图片素材。

---

## 8. 关闭 / 卸载

- 用户级：设置 · 桌宠组件 → 关总开关（窗口销毁，零占用）；或右键 → 关闭桌宠。
- 代码级：注释 `main.cjs` 里那一行 `pet.boot(...)` 即可让整个模块不启动；
  其余改动（配置默认值、页签、IPC）都是惰性的，不会影响主程序。
