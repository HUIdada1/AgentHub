# AgentHub Docker 版（headless：号池管家 + 本地网关 + 提示词库 + 记忆中枢）

> 方案与进度：仓库根 `docs/docker-上线/`。本文件是操作手册，事实以方案文档与代码为准。
> 不能破的约束：数据目录与桌面版相互独立；对外只提供本地网关（localgw）的 OpenAI / Anthropic 兼容端点，渠道能力通过插件适配。

## 快速启动

```bash
# ① 复制环境变量模板
cp gateway/.env.example gateway/.env

# ② 编辑 gateway/.env，填入你自己定义的密钥与令牌（见文件内注释示例）
#    AGENTHUB_SECRET_KEY=你的凭据加密密钥（自定义，建议 32+ 字符）
#    AGENTHUB_ADMIN_TOKEN=你的管理密码（自定义，好记即可；容器形态必填，见下）

# ③ 准备数据目录（属主必须是 uid 1000：容器以 USER node 运行）
mkdir -p gateway-data && sudo chown 1000:1000 gateway-data

# ④ 启动（compose 自动读 gateway/.env）
docker compose --env-file gateway/.env -f gateway/docker-compose.yml up -d --build
```

- 网关：`http://<主机>:19527/v1`（OpenAI / Anthropic / Responses 三协议兼容）
- 管理：`http://127.0.0.1:19528/api`（默认只绑宿主本机）
- Web 控制台：`http://127.0.0.1:19528/`（输入 `AGENTHUB_ADMIN_TOKEN` 登录）
- 本地验证（无 Docker）：`npm run verify:gateway`（依赖闭包 + 第三方裸名断言 + 依赖纯净探测 + 临时数据目录冒烟）

> **端口为什么是 19527 / 19528**（方案 v2 §D5）：桌面版把本地网关默认占在 `9527/127.0.0.1`。
> 容器若沿用 9527 且无前缀映射，同机共存必冲突，而且冲突表现为"桌面版网关起不来"，排查成本极高。
> 老部署要退回旧端口，在 `gateway/.env` 显式写 `AGENTHUB_PROXY_PORT=9527` / `AGENTHUB_ADMIN_PORT=9528` 一次即可。

> **数据目录口径**：compose 内的相对路径按 **compose 文件所在目录 `gateway/`** 解析，
> 所以默认 `../gateway-data` 就是仓库根的 `gateway-data`，与上面 `mkdir -p gateway-data` 同一个位置。
> 路径不确定时用绝对路径更稳：`AGENTHUB_DATA_DIR_HOST=/vol1/docker/agenthub-data`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGENTHUB_SECRET_KEY` | ✅ | 凭据加密密钥（enc:v2 AES-256-GCM），**自定义一个足够长的随机字符串**（建议 32+ 字符，字母数字混合）；未设置时入口拒绝启动（本地调试逃生门：`AGENTHUB_ALLOW_PLAINTEXT=1`） |
| `AGENTHUB_ADMIN_TOKEN` | 远程访问必填 | 管理 API 完整令牌 / Web 控制台登录密码，**自定义一个好记的密码**。不设时入口把管理面**强制降回容器回环**并打 WARN（管理面打不开，但容器照常启动、HEALTHCHECK 不受影响）；若同时显式设了 `AGENTHUB_ADMIN_PUBLIC=0.0.0.0` 则**拒绝启动** |
| `AGENTHUB_ADMIN_READONLY_TOKEN` | 可选 | 只读令牌（自定义，与完整令牌不同）：只放行监视类命令（`commands.cjs` 的 READ 集合）；设了它也算"已有凭据" |
| `AGENTHUB_ADMIN_HOST` | 默认 0.0.0.0 | **容器内**管理面绑定地址。保持默认即可——设了 token 时它要被宿主映射转进来；无 token 时入口会把它降回 `127.0.0.1`（见安全闸四态） |
| `AGENTHUB_ADMIN_PUBLIC` | 默认 127.0.0.1 | 管理面在**宿主机**上的发布地址：`127.0.0.1` 只本机可达；`0.0.0.0` 直接发布到所有网卡（裸端口暴露，务必已设 token） |
| `AGENTHUB_PROXY_PORT` / `AGENTHUB_HOST` | 默认 19527 / 0.0.0.0 | 本地网关监听参数（进程内覆盖，**不回写桌面语义**） |
| `AGENTHUB_ADMIN_PORT` | 默认 19528 | 管理 API 端口 |
| `AGENTHUB_DATA_DIR_HOST` | 默认 `../gateway-data` | 宿主数据目录（相对 `gateway/` 解析），容器内挂到 `/data` |
| `TZ` | 默认 Asia/Shanghai | 签到时刻与日额度重置按本地时间计算 |

> **密钥与令牌都是用户自定义的**：不需要会 `openssl`，也不需要记住随机字符串。选一个你自己记得住的密码即可（比如 `MySecretKey2024` 或 `MyAdminPass-AgentHub`）。`.env` 文件已在 `.gitignore` 中，不会提交到仓库。

## 号从哪来（两形态互联）

**原则：桌面凭据是 safeStorage(DPAPI) 密文，容器解不开——两形态绝不共享数据卷，传号只走号池同步。**

1. **推荐**：容器配与桌面版同一个 WebDAV/S3：`PUT /api/config/webdav` 写入后，
   **首次配置会自动跑一次号池同步**（响应里 `autoSyncTriggered: true`；已配置过再改字段不触发，
   与桌面 `ipc.cjs:250-267` 同口径，避免每次微调都发一轮全量同步；要手动跑请调
   `proxy_poolsync_run` 或用设置页的「立即同步号池」按钮）。
   同时会通知 poolsync「口令可能变更」，让历史包按新口令重打包——桌面版有这一步，
   容器版早先漏了（会造成"只有在容器界面改过口令才同步解不开"的形态不一致 bug）。
   **互通的前提是两侧的 WebDAV/S3 口令一致**（口令信封 magic `AHPPOOL1`，scrypt + AES-256-GCM）。
   `AGENTHUB_SECRET_KEY` **只管容器内落盘加密，不参与两形态互解**——桌面版不设它照样能互联，
   两侧 SECRET_KEY 相同也解不开对方的 safeStorage 密文。
2. 备选：`POST /api/accounts/import` 导入 JSON（桌面版导出的快照或手工凭据；元数据包不含 token 会被明确拒绝并提示）。

桌面版反过来可把容器实例配为「自建 OpenAI 兼容端点」provider：`http://<容器主机>:19527/v1` + 容器里创建的 API Key（`localgw_keys_create` 经管理 RPC）。

## 管理 API 一览

- `GET /api/livez`（恒 200，HEALTHCHECK 用）· `GET /api/readyz`（有在线账号才 200；**空池 503 是合法状态**）
- `GET /api/status` · `GET /api/channels` · `GET /api/accounts` · `GET /api/models`
- `GET /api/config`（**只有 GET，没有 PUT**；需完整令牌）· `GET/PUT /api/config/webdav` · `GET/PUT /api/config/framework` · `GET /api/backup`（需完整令牌）

> **配置读写的分工（task-11 安全收口，务必按这张表接前端）**
>
> | 通路 | 只读令牌 | 完整令牌 | 说明 |
> | --- | --- | --- | --- |
> | `GET /api/config/framework` | ✅ | ✅ | **只读看板的配置视图入口**：显式路径白名单投影，永不含 `security` / 口令 / 绝对路径 |
> | `PUT /api/config/framework` | ❌ 403 | ✅ | 只放行白名单路径；未列出的**明确拒绝**而非静默丢弃；一条非法则整体不写（无半更新态） |
> | `GET /api/config` | ❌ 403 | ✅ | 含 `localgw.security.secret`（API Key 的 HMAC 签名密钥），故收归 full。**响应里有密文字段，别落日志、别让反代缓存**；只读看板请改用上一行的 framework 投影 |
> | `GET /api/backup` | ❌ 403 | ✅ | 整库快照含凭据密文与全量请求流水；**要自动备份请用完整令牌** |
> | RPC `localgw_config_get` | ❌ 403 | ✅ | 主门已从 READ 移到 write；另有第二道门（read 档响应自动剥 `security` 段）兜将来误改 |
>
> `modules.localgw.enabled` 与 `proxy.port` / `proxy.bind` **不放开**：前者关掉等于关掉容器唯一对外
> 服务（桌面侧本就锁死），后两者由编排固定，界面改了也不生效。根目录（roots）与 S3 扩展项只在
> 桌面版编辑——容器里放开只会写出指向不存在路径的配置。

- `GET /api/capabilities`：完整命令表与 read/write/deny 标注。**实测 290+ 条已注册命令**
  （数量随并行开发漂移，本轮观察 277→296→297；分项以 `gateway/src/commands.cjs` 实际注册为准，
  精确对账归门禁 T3/T4，本文件不锁死具体数字）。另有数十条"未注册但显式 DENY"的命令
  （`skills_*` / `webdav_*` / `pet_*` / `window_*` 等），拒绝文案已下发，但**不在** `commands`
  的键里（方案 v2 §3.2 已列为待办）
- `POST /api/rpc/:cmd`：远程命令通道，信封与桌面 IPC 完全一致
- `GET /api/events`：SSE 事件流（proxy + localgw）

**容器里不可用**（DENY，返回原因与替代路径）：服务启停、OAuth 网页登录、短信登录、扫码/人机校验、CC Switch / IDE 切号、导出到本机目录、ZCode 设备指纹操作、桌面窗口与文件对话框类命令。

## 安全闸（阶段 0.3 起生效 · 四态语义）

原则是**绝不明文裸奔公网**，但不让老部署升级后起不来（Lead 2026-11-12 裁决：降级不崩溃）：

| # | 令牌 | `AGENTHUB_ADMIN_PUBLIC` | 行为 |
| --- | --- | --- | --- |
| ① | 无 | `0.0.0.0` / `1` / `true`（显式要公网） | **拒绝启动**，附一行修法 |
| ② | 无 | 默认 / `127.0.0.1` / `false` | 正常启动，绑定被**强制降回容器回环** + 醒目 WARN |
| ③ | 有 | 默认 / `127.0.0.1` | 容器内 `0.0.0.0`、宿主只回环可达（**推荐态**） |
| ④ | 有 | `0.0.0.0` | 全公网可达 + WARN 建议前置 TLS 反代 |

- ② 的降级**不是故障**：容器内绑 `127.0.0.1` 时宿主 DNAT 本就转不进来，所以老部署升级前后的
  行为完全一致（管理面同样只能容器内部访问），零破坏；`HEALTHCHECK` 在容器内 curl 回环，恒绿。
- 判定口径见 `gateway/src/index.cjs` 的 `isNonLoopbackHost`：`127.0.0.0/8`、`::1`、`localhost`
  算本机；其余（含 `0.0.0.0` / `::` / 具体网卡地址）算网络可达。
- 裸机直跑同样受管：把 `AGENTHUB_ADMIN_HOST` 设成 `0.0.0.0` 或网卡地址但没设 token → 会被降回
  `127.0.0.1` 并告警，不会因为"只是没写 PUBLIC"就真的裸奔。
- token 校验恒定时间比较（先各自 SHA-256 成等长再比，长度不进时序）；只读令牌与完整令牌分离。
- 单实例锁：同一数据目录只允许一个网关进程。
- 请求体限 4mb；日志全走 redact；`.dockerignore` 排除 `*.db`、`.env`、`gateway-data/`、`tools/`。
- qoder 双区需要本机 wasm 签名，容器里首启自动关闭并记日志。

## 防复发的五道门禁（本机就能跑，不需要 Docker）

一条命令全跑：`npm run verify:gateway`（顺序即下表；任一道红就整链退红）。

| # | 门禁 | 命令 | 卡住什么 |
| --- | --- | --- | --- |
| 1 | 依赖闭包 + 第三方裸名 + **T8 顶层 electron** | `node tools/gateway-closure-check.cjs` | COPY 范围与真实闭包漂移、复活已下线的旧转发链路、**第三方包不在 gateway lock 内**、以及容器装配链上出现**顶层** `require("electron")`（专项 §八 V1：4C 刚拆掉 `plugin-updater.cjs` 那一处，谁写回来当场红）。`koffi` / `better-sqlite3` / `electron` 的**函数内** require 只 WARN 不判红 |
| 2 | 依赖纯净探测（启动链） | `node tools/gateway-deps-purity.cjs` | 把 require 环境复刻成镜像里的样子（允许集 = gateway lock），当场拦下"本机绿、镜像崩"。2026-11-11 的 `js-yaml` 事故就是这类 |
| 3 | 依赖纯净探测（**更新器链**） | `node tools/gateway-deps-purity.cjs --entry electron/backend/plugin-updater.cjs` | 更新器链上有 `semver` / `yauzl` 而启动链上没有 —— 实测过：摘掉这两个包时第 2 道全绿、只有这一道会红。所以它不是冗余探针 |
| 4 | 一致性门禁 T3/T4/T6/**T9** | `node tools/verify/gw-gates.cjs` | **T3** READ 名单里出现未注册的幽灵名（会静默掉到 write 档，`memory_project_list` 那类真出过）；**T4** 前端调用的命令既没注册也没 DENY 文案 → 容器里 404 空档；**T6** `.env.example` 声明过却没进 compose 的 `environment` → "设了不生效"（判据：声明过即须透传，**不**看代码里有没有 `process.env.X`，那会漏判 `process.env[计算键]`）；**T9** compose 必须有 `restart` 策略、Dockerfile 必须有 HEALTHCHECK 且探针路径在免鉴权白名单内（R8 那次"重写 compose 丢了 restart"没人发现，就是缺这条） |
| 5 | headless 冒烟 | `node tools/gateway-headless-smoke.cjs` | 真起进程验四模块装配、三态门控、只读令牌边界、插件 REST 面、优雅停机。端口随机 + 日志名带 pid → **可以并发跑**（写死端口时两个实例会互相 EADDRINUSE，产出看起来像代码回归的假失败）。另含**板块7 的 9 条断言**：`/api/status` 的 prompts/memory 必须是真实计数且与 RPC 单查**逐位一致**、摘要不得夹带本机绝对路径或凭据字段、`realtime` 必须如实标 `memory:false / prompts:false`（容器形态这两条广播链路接不通，界面禁止摆假实时进度条）、且 `capabilities.realtime` 与 `status.realtime` 必须同源一致 |

| — | 文档锚点自检（**未串进 verify:gateway**，接脚本需另行协调） | `node tools/doc-anchors-check.cjs [--self-test]` | 扫活的说明书（本文件 / 根 README / `deploy/**`）里每一处 `文件:行号`，逐条对磁盘核对：文件在不在、行号越不越界、那一行是不是空行。`--self-test` 会先证明本工具自己**判得红**（五类用例），防止它退化成永远绿的摆设 —— 行号写错而没人发现，是本轮"我看到的≠现在是"这类病的最后一环 |


> 一个必须知道的实测事实：`node:sqlite`（容器唯一的数据库驱动）**不在** `Module.builtinModules` 里
> （Node 22.22 实测）。所以这些工具判内建一律按 `node:` 前缀放行，不可依赖 builtinModules，
> 否则会把内建驱动误报成缺失依赖。
>
> T6 的判据是「**`.env.example` 声明过 → 必须透传**」，不是"去代码里找 `process.env.X`"：
> 后者会漏判 `process.env[FEED_ENV]` 这类**计算键**（实测把 3 个运行时变量误分类成宿主侧）。
> 目前 `AGENTHUB_PLUGIN_FEED` / `AGENTHUB_PLUGIN_TRUST_ON_INSTALL` / `AGENTHUB_PLUGIN_AUTO_UPDATE`
> 三项在 `gw-gates.cjs` 的 `PENDING_COMPOSE_PASSTHROUGH` 里挂**待补**（compose 归另一条工作线独有，
> 两人同改必覆盖）；补进 compose 后请删掉那三条，让它恢复成硬断言。


## 插件：容器形态只支持 v2 provider 型（界面型 v1 本期不做）

容器里能跑的插件只有一类：`schema: 2` 的 **provider 型** —— 经 stdio JSON-RPC 接管指定渠道的模型执行，
能力面恰好且仅有 `ai.provider@1`；凭据按 grant 领白名单投影字段；包必须 Ed25519 签名并全文件 sha256。
入口只 `resumeEnabled({ schema: 2 })`（`gateway/src/index.cjs:303`，注释原文
*Provider transport only; legacy desktop UI plugins are not headless services.*）—— 这是既定设计，不是遗漏。

**界面型（v1）不是来不及做，是判断不做**（专项 §五）。四条以磁盘为证的后果：

| 事实 | 出处 | 放到常驻服务器上意味着 |
| --- | --- | --- |
| v1 包走 `stageLegacyPackage`，这条路径**没有验签步骤**（v2 才有 `verifyManifest`） | `electron/backend/extensions/package.cjs:164-197`，对照 `:132` / `:236` | 任何 zip 都能当插件装，"官方签名"这道硬闸不存在 |
| v1 子进程用 `env: buildEnv(...)`，而它是 `Object.assign({}, process.env, …)` —— **继承整个进程环境** | `electron/backend/plugin-host.cjs:457-459`、`:402`（v2 分支在 `:445` 走 `startExtension`，环境由 `extensions/stdio-transport.cjs:10-24` 把 PATH 裁到最小、不继承 process.env） | 容器里的 `AGENTHUB_SECRET_KEY` 等一并交给插件进程 |
| `plugin-bridge` 把**整池 token / refreshToken 明文镜像** POST 给插件（单次上限 2000 账号） | `electron/backend/plugin-bridge.cjs:28`（上限）、`:48-65`（解出明文，:58-59）、`:93` `postOnce` 的出站 `fetch`（:95） | 一次泄漏 = 全池凭据外流，而插件是别人写的代码 |
| `ui.url` / `health.url` 只校验"是不是 http(s) 绝对地址"，宿主**不探测也不分配端口** | `electron/backend/plugin-host.cjs:255-257` | 清单里写死的 `127.0.0.1:<port>` 在容器网内，用户浏览器根本不可达 |

最后一条还有第二层代价：真要让浏览器打开，必须由 gateway 反代 `/plugin/<id>/*` 出同源路径，
还要透传 SSE / WebSocket —— 这是一条独立工程量（专项 §六 4F，估 2d），**本期不实现**。
因此 `plugin_embed` / `plugin_open` 在容器里按 DENY 返回原因文案
（见 `gateway/src/commands.cjs` 的 `NO_V1_UI_REASON`）；前端对 v1 项显示"界面型插件在容器形态不支持（原因）"，
不给裸 403。收益侧也不存在：现役唯一插件就是 v2 provider 型，本身没有界面。

**容器与桌面的两处安全语义差异**（专项 §四 S1/S2；收敛只发生在容器入口，桌面"装完即用"不变）：

1. **装完不自动启用**：`plugin-host` 的桌面语义是全新安装即自动授予**全部声明的 required 权限 +
   全部声明渠道**并拉起子进程（现役 v2 包：required 2 项、33 个渠道，数字随渠道增加而变）。
   容器入口在安装后立即停用并收回自动授予的范围，返回 `requiresAuthorization`，
   由人在插件页逐条勾完再启用 —— 服务器形态默认要人确认（专项 §三 F4）。
   逃生门 `AGENTHUB_PLUGIN_TRUST_ON_INSTALL=1`（保留桌面式装完即用，给个人 NAS 图省事用）。
2. **默认不自动更新**：自动链路（启动 +90s 首查、之后每小时一轮）在容器形态默认**关**，
   要跑得显式设 `AGENTHUB_PLUGIN_AUTO_UPDATE=1`；手动"检查更新 / 安装"不受这个闸约束。
   下载出口只认 `HTTPS_PROXY` / `HTTP_PROXY` 等环境变量，**不探本机端口**
   —— 容器里的 `127.0.0.1:7897` 是容器自己，探了必然假阴性（`proxy/platform/node.cjs`）。

**feed 该指哪一份**：插件仓库按构建机平台各出一个索引 —— 桌面用默认 `plugin-index.json`，
**linux/glibc 容器要指 `plugin-index-linux-x64-glibc.json`**（musl/alpine 镜像另出 `-musl` 那份；
包名同样带平台标签，装错平台会被 `extensions/manifest.cjs:146` 当场拒，不会静默半坏）。
两种改法：插件页保存（`PUT /api/plugins/feed`，入口侧强制 https + full token + 落 oplog），
或在 compose 里设 `AGENTHUB_PLUGIN_FEED`。**后者优先级更高**：一旦设置，页面上改 feed 会被明确拒绝
（`feedSource="env"` / `lockedByEnv=true`），不会出现"保存成功却不生效"；所以除非你就是要锁死来源，
`.env.example` 里这一行保持注释状态。

**两条必须知道的运行风险**（专项 §七）：

- 被插件接管的渠道在宿主内**没有进程内兜底**：插件崩溃 / 未授权 / 平台不符 → 该渠道直接 503，
  容器无桌面可救（R1）。回退办法是解绑该渠道交回宿主。
- 插件是与容器**同一个 cgroup** 的独立子进程（`spawn(process.execPath, …)` 继承资源限制），
  现役 v2 包解包后含 sharp / koffi 原生依赖 → compose 的 `memory: 512M` 不够，
  要装插件请把基线提到 **1G**（R4）。

| 6 | 只读剥段的函数级双向自测（随冒烟一起跑） | 同上（`redactUnitChecks()` 在起服务前执行） | 纵深防御**既不许多漏也不许多剥**：①`security` 段内 `secret`/`adminToken`/`readonlyToken` 三键必须消失 ②同段的 `encryptKeysAtRest`（公开布尔，前端用它显示"API Key 加密态"）**必须保留** ③同级 `routing`/`models` 原样 ④空值/null/字符串不抛错 ⑤数组里嵌的 `security` 也剥 ⑥业务中其它段的同名 `secret` 字段**不受影响**（只认段名） ⑦不得就地修改入参（full 档复用同一对象）。三条负向验证（多剥 / 少剥 / 误伤）实测都能抓到红 |

> **配置读写的三档分工（审查 R 后定稿，别混用）**
> ① **主门**＝门控表：`localgw_config_get` 是 write 档，只读令牌直接 403；
> ② **纵深**＝RPC 出口对 read 档剥 `security` 段内的**三个字段**（按字段名，不整段丢——整段丢会连
> 非敏感的 `encryptKeysAtRest` 一起吞，且将来新增任何公开字段都会被无声吞掉）；
> ③ **只读看板要配置，走 `GET /api/config/framework`**（显式叶子路径白名单，38 条，无整段放行）。

## 构建


`docker build -f gateway/Dockerfile -t agenthub-gateway .`（三阶段：deps → ui 构建 → 运行时 node:22.22.0-bookworm-slim）。
国内网络构建可加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` 或 `export NPM_REGISTRY=...`。

## 待实机验证与已知限制（本机无 Docker CLI，如实标注）

### 等待前置条件：一台有 Docker 的机器（NAS 或 CI runner）

本机只能给静态与 headless 证据，下列项**没有一项被声称"已验证"**：

1. `docker compose -f gateway/docker-compose.yml up -d --build` → `docker inspect --format '{{.State.Health.Status}}' agenthub-gateway` = `healthy`。
2. 安全闸四态在真容器网络里的表现（②态"宿主映射不可达而容器内可达"尤其要看 DNAT 行为）。
   注：`.github/workflows/docker.yml` 的冒烟步骤已经在 CI 里跑 A/B/C 三态断言，
   那属于"有 Docker 的执行环境"，但它不等于你的 NAS/群晖机型已验证。
3. `memory` 上限是否够用：**未实测 RSS**。两份 compose 取值不同是有意的 ——
   `gateway/` 那份（开发/现场 build）留 `512M`，`deploy/compose.yml`（用户部署）取 `1G`，
   因为插件子进程与容器共享同一 cgroup（专项 §S7 / R4），512M 下 OOM 会连坐主进程。
   收紧或放宽请在目标机跑 `docker stats agenthub-gateway` 取曲线后再定，不要照抄数字。
4. 容器内 `spawn` 插件子进程在 `tini` 作 PID 1 下的信号传递与优雅停机（专项 §八 V3）。
5. bind mount 下 `plugin-trust.json` / `plugins.json` 的 `0o600` + rename 写入权限（专项 §八 V4）。

### 已知限制（不是 bug，是当前边界）

- **minimax 是「半条腿」状态**：插件侧的渠道声明已经包含 minimax（现役包实测
  required 权限 2 项、providers 32 个、channels 去重 33 条），但宿主侧的 minimax 适配器
  尚未实现模型目录拉取（属用户 in-repo WIP）。后果：容器里该渠道的**模型调用**可以交给插件执行，
  但宿主管理面（拉模型列表等）不完整。**不要把它理解成"容器已打通 minimax"**。
- `GET /api/config` 与 `GET /api/backup` 需完整令牌（含密文与整库），只读看板请用
  `GET /api/config/framework`；自动备份脚本因此必须持完整令牌。
- 界面型（v1）插件、技能仓库、OAuth/短信/人机校验在容器形态不提供（原因见上两节与
  「插件」一节）。

