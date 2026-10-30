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
   ├─ capture.js        屏幕采样管线（getUserMedia + requestVideoFrameCallback + fps 节流）
   ├─ lens.js           Pass 1：引力透镜 GLSL
   ├─ disk.js           Pass 2：吸积盘 / 光子环 GLSL
   ├─ renderer.js       WebGL2 渲染器 + 2D 降级 + 上下文丢失兜底
   └─ app.js            编排：boot / rAF / 鼠标 / 右键 / 配置事件 / 显示变化 / 暂停恢复
```

配套：`docs/桌宠/01-模块契约.md`（对接契约）、`docs/桌宠/02-渲染层规格.md`（视觉规格）、
`tools/verify/pet-verify.cjs`（纯代码静态验证，见 §6）。

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
| `src/components/config/ConfigPetSection.vue` | 新增 | 控制台页面（含「唤回窗口」） |
| `tools/verify/pet-verify.cjs` | 新增 | 纯代码静态验证（不启动 GUI） |
| `package.json` | `verify:pet` 脚本 | `npm run verify:pet` |

三处默认值必须逐字一致（否则会出现「设置页改完、下次读回默认值」）：
`electron/backend/config.cjs` · `electron/pet/pet-config.cjs` · `src/types/index.ts`。
`tools/verify/pet-verify.cjs` 会自动比对这三处。

---

## 3. 数据流

```
设置页 ─ pet_* IPC ──► index.cjs ──► pet-config.patch() ──► config.json
                          │
                          └─► applyConfig() ──► pet-window（建/销/改尺寸/置顶/穿透）
                                              └─ pet:event(config-changed / display-changed / interactive) ─► 渲染层

右键菜单（原生 Menu）─► pet-actions ─► optimize.cjs（提示词库同一套模型/风格/历史）
                                    └► usageTodaySummary()（托盘同一份统计）

渲染层 ─ pet:rpc(boot / patch / usage-today / capture-source)
       └ pet:ipc(set-interactive / drag-start / drag-end / context-menu / hide / close / reset-position / log)
```

- 主窗口只认 6 条 `pet_*`；桌宠窗收敛到 `pet:ipc`（单向）与 `pet:rpc`（请求响应），
  并且主进程校验 `event.sender === 桌宠窗 webContents`，主窗口无法借此调用桌宠窗能力。
- 右键菜单改了配置 → 主进程发 `app:event { event: "pet-config-changed", config, visible, windowReady }`，
  `src/App.vue` 替换内存里的 `app.config.pet`；`ConfigPetSection.vue` 同时刷新「运行中/已隐藏」徽标。
- 显示器拔插 / 改分辨率 / 跨屏拖动 → 主进程推 `pet:event { event: "display-changed", geometry }`，
  渲染层重算屏幕 uv 映射并重建采样流（否则黑洞里的桌面会与背后真实桌面错位）。

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
- **预乘 alpha**（`premultipliedAlpha: true`）：Pass 1 输出 `vec4(col*alpha, alpha)`，Pass 2 输出
  `vec4(col*cover, cover)`，两个 pass 都用 `ONE, ONE` 加法。这样「自发光叠加」与「窗口不透明度」
  语义同时成立（早期版本用直线 alpha + ONE,ONE，会把盘面 alpha 累加到 1，opacity 滑块对盘面失效）。
- **只在有效区域算**：两个片元着色器都用 `r > R_outer` 早退 `discard`，窗口其余像素保持 alpha=0（透明）。
- **视界内纯黑**：`r < Rh` 直接输出黑色不透明，不采样背景。
- **引力畸变是径向位移**（`beta = theta - thetaE²/theta`），不是鱼眼/桶形；外缘 80% 处开始羽化，
  且采样位移随羽化权重一起收敛回当前像素，避免外缘出现「真实桌面 + 偏移桌面」的重影。
- **降级链**：WebGL2 不可用 → 2D canvas 静态黑洞（黑圆 + 橙环 + 光子环），绝不白屏；
  屏幕采样失败 / 首帧超时 / 采样停摆 → 程序化星空底；窗口隐藏 → 停 rAF 与采样。
- **采样**：分辨率 = 显示器物理尺寸的一半，`requestVideoFrameCallback` 跟帧上传纹理并按
  `captureFps` 限速；`getUserMedia` 建流失败/取消不会泄漏捕获流。
- **上下文丢失**：监听 `webglcontextlost/restored`，丢失期间停止绘制并写日志，避免整窗"凭空消失"却无痕迹。

---

## 6. 纯代码验证（不启动 GUI）

```bash
npm run verify:pet        # == node tools/verify/pet-verify.cjs
node tools/verify/pet-verify.cjs --assert   # CI 用：失败退出码 1
```

检查 11 项：模块文件齐全、默认值三处一致、6 条 IPC 四处对应、主进程/设置面板挂载点、
两个 shader 的 uniform 与 JS 对齐 + 有效区 discard、窗口属性（无边框/透明/置顶/穿透/不占任务栏）、
配置项覆盖、渲染脚本加载顺序、全部脚本 Node 语法。

需要看真实渲染时再开调试快照（见 §7）：设置页「显示桌宠」后，
`AGENTHUB_PET_SNAPSHOT=<png 绝对路径>` 会在启动 5s 后抓一张带 alpha 的窗口自拍。

---

## 7. 调试开关（仅本地验证用，生产不要设）

| 环境变量 | 作用 |
| --- | --- |
| `AGENTHUB_PET_NO_CAPTURE_GUARD=1` | 跳过 `setContentProtection`，让全屏截图能拍到桌宠（会失去「黑洞不递归拍自己」的保护） |
| `AGENTHUB_PET_SNAPSHOT=<png 绝对路径>` | 启动后抓一张窗口自身内容（带 alpha），用于验证渲染 |
| `AGENTHUB_PET_SNAPSHOT_DELAY` | 上面那张快照的延迟毫秒（默认 5000） |

日志：`<dataDir>/logs/pet.log`（超过 512KB 轮转一份 `.1`）。

---

## 8. 隐藏 / 唤回 / 关闭

| 操作 | 语义 | 恢复方式 |
| --- | --- | --- |
| 右键「隐藏桌宠」 | 窗口 `hide()`，`enabled` 仍为 true（不销毁、不占 GPU） | 设置 · 桌宠组件 → 状态徽标变「已隐藏」→ 点「唤回窗口」；或关闭再打开总开关 |
| 右键「关闭桌宠」 | 总开关置 false + 销毁窗口 | 设置 · 桌宠组件 → 重新打开总开关 |
| 设置页总开关 | 与右键「关闭桌宠」同一语义 | 同上 |
| 用户 Alt+F4 / 系统关窗 | 与右键「关闭桌宠」同语义（关闭拦截里置 false 并广播） | 同上 |
| 应用退出 | `before-quit` → `shutdown()`，销毁窗口、停采样/前台轮询 | — |

---

## 9. 已知限制

- **窗口对系统截图/录屏不可见**：`setContentProtection(true)`（WDA_EXCLUDEFROMCAPTURE）是必需的，
  否则 desktopCapturer 会把桌宠自己拍进去，黑洞里递归出现下一个黑洞。
  该行为在 Win10 2004+ 是「从捕获中移除」，更老系统上等价 WDA_MONITOR（会拍成黑块）。
- **键盘模拟仅 Windows**：`pet-input.cjs` 依赖 `koffi + user32.keybd_event`；
  非 Windows 上自动降级为「只处理剪贴板」，`pet_optimize_preview` 会写明原因。
- **优化回填会校验目标窗口**：模型调用结束后若用户已切走/关掉原窗口，不会把 Ctrl+A/V 发到别的程序，
  只把结果放剪贴板并如实提示。
- **屏幕采样需要 WebGL2**：2D 降级模式用程序化星空底（不采样桌面）。
- 吸积盘纹理全部程序化生成，不依赖任何图片素材（天然透明通道、无素材缺失问题）。

---

## 10. 关闭 / 卸载

- 用户级：设置 · 桌宠组件 → 关总开关（窗口销毁，零占用）；或右键 → 关闭桌宠。
- 代码级：注释 `main.cjs` 里那一行 `pet.boot(...)` 即可让整个模块不启动；
  其余改动（配置默认值、页签、IPC）都是惰性的，不会影响主程序。

---

## 11. 变更记录

### 2026-10-30 · 视觉定稿（电影感重做）
- 主体比例：`OUTER_RATIO 0.40`（黑球占窗口约 25%），280px 下盘/外环完整不裁切。
- 底层扭曲：跟随主体轮廓的包络（`dBody` 超椭圆，水平取盘外缘 3.0Rh、上下取拱弧 2.4Rh），
  `dBody<1` 区域底层就是扭曲后的桌面原色、盘叠加其上；`1~1.16` 柔和羽化；
  外扩羽化带的 alpha 按背景亮度自适应（亮桌面淡出，避免白雾/白条）。
- 盘面：`R_IN 1.15 / R_OUT 3.0 / TILT 1.30`，内缘白热 → 金橙 → 暗红外缘；
  拱弧收在 `r 1.1~1.85Rh` 与水平盘带连成一圈；光子环 `1.02Rh` 且带缓慢明暗起伏；
  盘缝隙加极低密度星尘（~1.8%，慢闪烁）；盘覆盖率改由几何权重决定（暗部不被亮桌面冲白）。
- 动效：开普勒差速 `Ω = diskSpeed·3.2·ρ^-1.5`（内快外慢），湍流条纹随转，`TURB_FREQ_MIN 2.0` 让条纹更粗、旋转更可见。
- 窗口：`thickFrame:false, roundedCorners:false` 去掉 Windows 透明窗顶部 1px 白色 DWM 边框。

### 2026-10-30 · 审查修复批次
- 渲染：预乘 alpha 修正、羽化区采样位移收敛（消除重影）、视界边缘改颜色过渡（不再半透明漏桌面）、
  双 program 的 `bindAttribLocation`、光子环设备像素下限、cover 平滑、2D 降级 opacity 双重压暗修复、
  WebGL 上下文丢失兜底。
- 采样：`getUserMedia` 取消路径停流（修泄漏）、rVFC 按 `captureFps` 节流、停摆 watchdog
  （静态桌面先做兜底上传，不误判成故障）、隐藏超过 5s 释放采集流、采样源匹配失败不再静默退回首屏。
- 窗口：Alt+F4/系统关闭拦截、关闭后总开关与广播同步、崩溃/页面加载失败也广播并置 false、
  销毁前 flush 位置、显示器变化与跨屏拖动推 `display-changed`、穿透态主进程→渲染层同步、
  右键菜单关闭恢复穿透、拖拽看门狗、加载失败可诊断、关停后不再常驻前台轮询。
- 配置：`saveConfigFromUI` 对 `pet.pos` 磁盘优先（整份保存不再把拖动位置写回 null）；
  `pet-config` 的数值归一化补 null/空串特判（不再把 null 钳成下限）。
- 右键：优化回填前校验目标窗口（失败只落剪贴板并如实提示）、剪贴板安全还原、忙碌反馈、
  通知三级兜底、删除死代码。
- 设置页：新增「唤回窗口」按钮、徽标跟随 `visible` 更新、隐藏文案修正、开关禁用态样式。
- 新增 `tools/verify/pet-verify.cjs` 静态验证（11 项）。
