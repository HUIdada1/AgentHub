# LobsterAI 渠道反代接入方案（2026-10-05）

> 状态：**已落地，待真实账号端到端验证**。本方案基于 2026-10-05 对 LobsterAI（网易有道龙虾）线上服务的实测、
> 参考实现 `lobsterai2api@21c39a4`（2026-10-02，MIT）的交叉验证，以及 `dsh-lobsterai-daddy`（第三方签到面板）的旁证。
> 适用 AgentHub v1.43.1。自测：`tools/proxy-lobster-selftest.cjs`（15 项，含 4 项联网只读探针，全通过）。

---

## 0. 结论速览

**LobsterAI 四条准入判据全部实测通过，且是迄今接入成本最低的渠道**（无需本机安装客户端、无需 WASM 签名、无需逆向混淆产物）：

| # | 判据 | 结论 | 关键证据 |
|---|------|------|----------|
| 1 | 协议可代理 | ✅ | 上游即**原生 OpenAI Chat Completions**（SSE），无需协议翻译 |
| 2 | 凭据可脱离持有 | ✅ | 回环 OAuth 授权码换 `{accessToken, refreshToken}`；AgentHub 自己就是回调方，凭据不经过官方客户端 |
| 3 | 可自助续期 | ✅ | `POST /api/auth/refresh`（refreshToken + keyfrom 载荷，无需 Bearer） |
| 4 | 用量可计量 | ✅ | `GET /api/user/profile-summary` 的 `totalCreditsRemaining`（含活动积分） |
| 5 | **每日额度** | ✅ | `POST …/client-activities/{code}/actions/check_in` 每日 **100 积分**，服务端标注**常驻活动**（至 2126 年） |

与既有渠道的形态对比（决定工程量）：

| 渠道 | 出站头 | 上游协议 | 签到 | 需装客户端 |
|------|--------|----------|------|-----------|
| WorkBuddy | 静态头组 | 纯 OpenAI | 有 | 否（服务端轮询 OAuth） |
| Qoder | **每请求 WASM 签名（20 头）+ Encode=1 体** | 私有信封（内层 OpenAI） | 每日领取（campaign） | 是（签名器依赖本机 wasm） |
| **LobsterAI** | **静态 Bearer + 2 个客户端头** | **原生 OpenAI** | **每日 100 积分** | **否（回环 OAuth）** |

> 工程量与 WorkBuddy 同级，显著低于 Qoder：无签名器、无 wasm 提取、无信封解包。

---

## 1. 背景与准入判定

### 1.1 目标对象
- **LobsterAI（网易有道龙虾）**：网易有道 2026-02 推出的开源桌面级 AI Agent，MIT 协议（[netease-youdao/LobsterAI](https://github.com/netease-youdao/LobsterAI)），被称「中国版 OpenClaw」
- 上游服务域：`lobsterai-server.youdao.com`（API）/ `lobsterai.youdao.com`（登录门户）
- **注意**：官网宣传域 `getlobster.ai` 的 DNS 已失效（本机实测无 A 记录），实际门户在 `youdao.com` 下

### 1.2 为什么选它（对比同批候选）
2026-10-05 对 20+ 个「多模型 + 每日免费额度」客户端做了并行调研，LobsterAI 是唯一三项全齐的：

- **原生 OpenAI 兼容**（多数候选是私有协议，需自写转换层）
- **每日签到接口已被公开逆向**（有开源反代 + 可运行脚本可对照）
- **回环 OAuth 与 AgentHub 现有链路同构**（可复用 `listenLoopback` / 回环回调范式）

被排除的同批候选（详见 §11）：QClaw（腾讯已公告 2026-12-24 关停）、CodeBuddy CN（与已接入的 WorkBuddy 同后端同积分池）、Trae Solo（与已接入 Trae 同一套）、扣子桌面（非 OpenAI 兼容 + 免费版仅 500 次）、纳米 Work（凭证全在云端）、iFlow（已关停）。

---

## 2. 协议栈（全部实测）

### 2.1 凭据链（回环 OAuth）
```
登录页：{portal}/portal#/login?source=electron&redirect_uri=http://127.0.0.1:<port>/auth/callback&state=<state>
登录成功 → 前端导航到 redirect_uri?code=…&state=…
  ↓
POST https://lobsterai-server.youdao.com/api/auth/exchange
{ "authCode": "<code>", "firstKeyfrom": "<ms>", "latestKeyfrom": "<ms>", "uuid": "<uuid4>", "version": "0.1.0" }
→ { code:0, data:{ accessToken, refreshToken, expiresIn, user:{ id, yid, userId, nickname } } }
```
- **无需 Bearer**（exchange/refresh 都是无鉴权端点）
- access token 实测 HS512 JWT，约 30 天（`expiresIn` 缺失时从 JWT `exp` 解）
- `uuid` / `firstKeyfrom` 是**设备安装标识**，刷新时必须回传 → 落 `accounts.meta`（丢失会导致 refresh 被拒）

### 2.2 续期（判据 3）
```
POST https://lobsterai-server.youdao.com/api/auth/refresh
{ "refreshToken": "…", "firstKeyfrom": "…", "latestKeyfrom": "…", "version": "0.1.0", "uuid": "…", "userId": "…" }
→ { code:0, data:{ accessToken, refreshToken, expiresIn } }
```
- 参考实现口径：响应缺 `accessToken` 即视为 refresh 被拒（**终止性**，需重新登录）；错误码 `401/40100/40101` 同类处理
- 与桌面端**共用同一份凭据链**时需注意：官方客户端登录会写自己的库，AgentHub 持独立副本（回环 OAuth 拿的是自己那一份），互不覆盖

### 2.3 对话端点
```
POST https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions
Headers: Authorization: Bearer <accessToken>
         Content-Type: application/json
         Accept: text/event-stream, application/json
         User-Agent: LobsterAI/<version>
         X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1
         X-LobsterAI-Client-Version: <version>
Body:   标准 OpenAI Chat Completions
```
- **⚠️ 上游只接受 `stream=true`**（非流式实测 500）→ `rewriteBody` 强制开启
- **⚠️ 业务错误会藏在 HTTP 200 的 SSE 流里**（`event:error` 帧）→ 必须窥探首块，否则「额度不足」会表现为「空内容的正常响应」穿透给客户端
- 参考实现的实测教训（commit `28e6ace` / `e8f2866`）：错误帧总在流首（<200 字节），用 4KB 无损 Peek 判定

### 2.4 计量 API（判据 4）
```
GET https://lobsterai-server.youdao.com/api/user/profile-summary
Authorization: Bearer <accessToken>
→ { code:0, data:{ totalCreditsRemaining, … } }
```
- **必须用 profile-summary**：`/api/user/quota` 只含 `freeCreditsTotal=300`，**不含活动积分**（参考实现踩坑记录）
- 无鉴权实测：`profile-summary` → 200（返回未登录态），`/api/proxy/v1/models` → **401**（端点存在，仅缺鉴权）

### 2.5 模型目录（**权威源 = 公开端点**）

**两个目录端点，字段都含真实 `contextWindow` / `supportsImage` / `supportsThinking`**（实证自官方开源仓库
`docs/server-integration/2026-06-24-explicit-context-cache-models.md` 与 `specs/features/model-thinking-level-control`）：

```
① GET https://lobsterai-server.youdao.com/api/models/available        （需 Bearer）
② GET https://lobsterai-server.youdao.com/api/models/pricing-catalog  （**公开，无需鉴权**）
```
- ② 由官方文档 `docs/server-integration/2026-08-27-more-models.md` 明确标注 `remains public`。
  实测 HTTP 200 / 37KB，返回 **30 个 textModels + 5 个 imageModels + 4 个 videoModels**，
  含 `contextWindow` / `supportsImage` / `supportsThinking` / `costMultiplier` / `freeAccess` / 分时计价。
- ① 的模型对象字段（官方文档示例）：`{modelId, modelName, provider, apiFormat, supportsImage,
  supportsThinking, contextWindow, explicitContextCache, thinkingConfig, runtimeProfile, requestCapabilities}`。

**真实上下文窗口**（我第一版写错了，见下）：

| 档位 | 模型 |
|------|------|
| **1,000,000** | deepseek-flash / deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp / glm-5.3-flash / glm-5.3-flashx / glm-5.3 / glm-5.2 / MiniMax-M3 / MiniMax-M3.1-Flash-Preview / qwen3.8-max / qwen3.8-flash / qwen3.8-omni-flash / qwen3.7-max / qwen3.7-plus |
| **1,048,576** | kimi-k3 |
| **262,144** | kimi-k2.8-preview / kimi-k2.7-code / kimi-k2.7-code-highspeed |
| **256,000** | doubao-seed-2-1-pro-260915 / doubao-seed-2-1-turbo-260628 |
| **未标（记 0）** | MiniMax-M2.7 / qwen3.6-plus / qwen3.5-plus-2026-04-20 / kimi-k2.6 / kimi-k2.5 / glm-5.1 / glm-5v-turbo / glm-5 / doubao-seed-2-0-code-preview-260215 |

> 服务端对部分模型返回 `contextWindow: null`。官方客户端此时回落 OpenClaw 默认 200k，但按本仓库约定
> **「模型上限类字段绝不给编造的默认值」**（假值会让客户端把正常回答误判成上下文溢出），故一律记 `0`（未知）。

**⚠️ 踩坑记录（第一版写错的地方）**：初版静态表照抄了第三方反代项目 `lobsterai2api` 的清单，两处错误：
1. **上下文全部写成 131072** —— 那是该项目 `handler.go` 里的**硬编码占位值**，它解析 `/api/models/available`
   时只取了 `modelId/modelName/provider/apiFormat` 四个字段，**根本没读 `contextWindow`**。真实值多为 **1,000,000**（差 8 倍）。
2. **漏了 `deepseek-flash`（DeepSeek-V4.1-Flash）和 `glm-5.3-flash`（GLM-5.3-Flash）** —— 恰恰是两个
   **限时免费**（`freeAccess: true`）且倍率最低（0.05 / 0.06）的模型。该项目的静态表是 2026-08-06 的快照，已过期。

**教训**：模型清单与能力元数据必须以**服务端公开端点**为准，不要采信第三方项目的静态表——
它们可能只取了部分字段、且随上游发版而过期。本渠道已把 `pricingCatalogUrl` 落进 `headers.json`（热加载）作为权威兜底源。

### 2.6 每日签到（判据 5，核心新增能力）

**三段式协议**（`client-activities` 活动系统）：
```
① GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=<ver>&containerApiVersion=2&platform=win32
   → { code:0, data:{ slotState:"available", activity:{ activityCode, configRevision, activityType:"daily_check_in", … } } }

② GET  /api/client-activities/{activityCode}/context?configRevision={N}
   → { code:0, data:{ lifecycleState:"active", authenticated, loginRequired:true,
                      state:{ claimedToday, rewardCredits:100, claimedDays, totalDays:36500 },
                      actions:["check_in"] } }

③ POST /api/client-activities/{activityCode}/actions/check_in
   { "configRevision": N, "idempotencyKey": "<uuid4>", "payload": {} }

④ GET  …/context  （复核 claimedToday 真的翻转才算成功）
```

**本机实测（2026-10-05，无鉴权只读）**：
```json
{"slotState":"available",
 "activity":{"activityCode":"daily-check-in-evergreen-prod-20260814",
             "activityType":"daily_check_in",
             "placement":"desktop_sidebar",
             "cardTitle":"每日积分礼","periodLabel":"常驻活动",
             "loginRequired":true,
             "startAt":"2026-08-13T16:00:00Z","endAt":"2126-07-20T16:00:00Z"}}
```
```json
{"lifecycleState":"active","authenticated":false,"loginRequired":true,
 "state":{"claimedToday":false,"rewardCredits":100,"totalDays":36500,"claimedDays":0},
 "actions":["check_in"]}
```

**结论**：每日签到**确实存在**，奖励 **100 积分/天**，服务端标记为**常驻活动**（有效期至 2126 年，非限时活动）。

### 2.7 ⚠️ 版本门禁（必须动态取版本号）

签到活动**按 `clientVersion` 下发**——旧版本号会被服务端隐藏。本机实测：

| clientVersion | slotState | 结果 |
|---------------|-----------|------|
| `0.1.0` | `empty` | **看不到活动** |
| `2026.9.4` | `available` | 可见 |
| `2026.9.23` | `available` | 可见 |

→ 故适配器从官方更新接口动态取版本号：
```
GET https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update
→ { data:{ value:{ version:"2026.9.23", date, windowsX64:{url}, … } } }
```
1h 缓存、失败 10min 后重试、取不到回落 `headers.json.lobster.clientVersion` 常量。

> **这条不是可选项**：写死版本号会在官方发版后某天静默失效（活动消失），且失败形态是 `slotState=empty` 而非报错——不动态取版本号，签到会「看起来正常但永远领不到分」。

---

## 3. AgentHub 契约映射（adapters.cjs 十件套逐项）

| 契约项 | LobsterAI 实现 | 等级 | 说明 |
|--------|---------------|------|------|
| 渠道注册 | `store.CHANNELS` 加 `{id:"lobster", display:"LobsterAI（有道）", domain:"lobsterai-server.youdao.com"}` | 🟢 | 与 `ADAPTERS` 双表同步（红线） |
| `models()` | catalog.json 静态兜底 19 模型（拉取后整段覆盖） | 🟢 | |
| `fetchModels()` | `GET /api/models/available` → 整形 `{id,name,rate,capabilities,contextLength,maxOutputTokens}`；401 就地刷新重试一次 | 🟢 | 拉取失败保留旧目录 |
| `headers()` | 静态头组（Bearer + UA + 2 个 `X-LobsterAI-*`），无需签名 | 🟢 | 与 WB 同级，远简于 Qoder |
| `rewriteBody()` | 强制 `stream=true` + `include_usage`；`tool_choice` 归一（空/none/null 删除）；剥离内部字段 | 🟢 | 上游非流式返回 500 |
| `chat()` | 原生 OpenAI SSE 透传 + **首块错误帧窥探**（`event:error` 或 data 带 error 对象） | 🟡 | 200-流内错误是最大陷阱 |
| `queryCredits()` | `GET /api/user/profile-summary` → `totalCreditsRemaining` | 🟢 | 实测通过 |
| `checkin()` | 三段式（slot → context → check_in → 复核）；幂等：已签/无活动都返回 ok | 🟢 | **本渠道核心新增** |
| `checkinStatus()` | 读 context 的 `claimedToday`（不消费动作） | 🟢 | 带 `reward` 与 `already` |
| `refreshToken()` | `POST /api/auth/refresh`（含 keyfrom 载荷，meta 取 uuid/firstKeyfrom） | 🟢 | 参考实现口径：缺 accessToken = 终止性拒绝 |
| `trial()` | 明确返回不可用（龙虾无加油包） | 🟢 | |
| 回环 OAuth | `discovery.beginLobsterOAuth`：`listenLoopback` + `/auth/callback` + exchange | 🟢 | 复用 Trae 范式 |

---

## 4. 落地组件清单

```
electron/backend/proxy/
  ├─ rules.cjs          + headers.json.lobster（端点/版本/UA 常量，热加载）
  │                     + catalog.json.lobster（19 模型静态兜底）
  ├─ adapters.cjs       + lobster 适配器（十件套）+ ADAPTERS 注册 + 版本号缓存
  ├─ discovery.cjs      + beginLobsterOAuth()：回环 OAuth + exchangeLobsterAuthCode + saveLobsterAccount
  ├─ store.cjs          + CHANNELS 注册
  └─ ideswitch.cjs      + ideSwitchStatus 上报 lobsterInstalled（渠道启用即 true，无需装客户端）
src/
  ├─ types/index.ts     + ProxyChannelId 加 "lobster"
  ├─ api/ipc.ts         + lobsterInstalled 字段
  ├─ api/mock.ts        + 演示数据
  └─ views/proxy/
       ├─ format.ts            + CHANNEL_NAMES.lobster
       ├─ ProxyAgentsView.vue  + CHANNEL_META / OAUTH_HELP / ideSupported / 签到提示
       └─ ProxyPoolSyncView.vue + 渠道下拉项
tools/proxy-lobster-selftest.cjs（新）  15 项断言（11 离线 + 4 联网只读）
docs/LobsterAI渠道反代接入方案.md（本文）
```

---

## 5. UX 流程设计

| 环节 | 设计 | 说明 |
|------|------|------|
| 添加途径 | **OAuth 登录**（主）/ file / paste | 无「从本机软件导入」——官方登录态在客户端 SQLite，且本渠道无需装客户端 |
| OAuth 形态 | **回环**：跳官方登录页 → 回调 `127.0.0.1/auth/callback` → 自动入池 | 与 Trae 同构；文案明说「无需安装客户端」 |
| 兜底 | 浏览器没跳回时可整段粘贴回调地址（`submit` 钩子） | 复用 `parseCallbackInput` |
| 签到 | 一键签到（挂 `checkinBatch`，含 800–2000ms 抖动）；结果带 `+100 积分` | 定时 `checkinAuto` 同样生效 |
| 签到提示 | 「每日签到领 100 积分（常驻活动，需客户端版本 ≥ 2026.9.4）」 | 如实说明版本门禁 |
| relogin 文案 | 「请重新执行 OAuth 登录」 | 无客户端可依赖，不能照抄 WB 的「去客户端重登」 |
| 写回本地 | **不支持**（`ideSupported` 返回 false） | 登录态在客户端 SQLite，且渠道设计上不依赖客户端 |
| 额度展示 | `totalCreditsRemaining` 单值（含活动积分） | 沿用 credits_history 日快照 |

---

## 6. 持久化

| 项 | 设计 |
|----|------|
| accounts.meta | `{uuid, firstKeyfrom, latestKeyfrom, youdaoUserId}`——**refresh 必需**，随包 PoolSync 走 |
| accounts.expires_at | 登录/刷新/导入三处都写（PoolSync 凭据仲裁 Validity First 依赖它） |
| accounts.token_enc / refresh_enc | 沿用 DPAPI `enc:v1:` 信封，不落明文 |
| rules/catalog.json | `{lobster:{syncedAt, models:[…]}}`；拉取失败保留旧目录 |
| 版本号缓存 | 进程内 1h TTL（非持久化；重启重取，避免缓存陈旧版本号） |

---

## 7. 通信层适配

| 层 | 结论 |
|----|------|
| 入线 | 零改动：Express `/v1/chat/completions`（SSE 双态）+ `/v1/models`，渠道无关 |
| 出线 | 标准 `fetch` + JSON body（无 Encode/无 Buffer 编码） |
| redirect | 默认 `follow` 即可（无签名，不惧 30x） |
| 代理 | Node fetch 不走系统代理；国内直连实测通（`lobsterai-server.youdao.com` → 220.197.31.38） |
| **流中错误** | **200 + `event:error` 帧** → 按错误处理（`isQuota` 判 402/planLimit），绝不能当空响应放行 |
| 首字节 | 默认 30s 预算充裕（无实测 TTFT 数据，待真实账号补测） |
| 幂等 | 签到带 `idempotencyKey`（uuid4）+ 复核 `claimedToday`，双重防重复发放 |

---

## 8. 自测清单（tools/proxy-lobster-selftest.cjs）

| # | 断言 | 类型 | 状态 |
|---|------|------|------|
| T1 | 渠道已注册（adapters / store.CHANNELS 双表同步） | 离线 | ✅ |
| T2 | 适配器接口完整（12 个方法） | 离线 | ✅ |
| T3 | headers.json.lobster 端点齐备 | 离线 | ✅ |
| T4 | catalog.json 静态兜底目录非空且含关键模型 | 离线 | ✅ |
| T4b | 上下文取真实值（非 131072 占位；1M 档正确；未标记 0） | 离线 | ✅ |
| T4c | 能力位/倍率取自公开目录实测值 | 离线 | ✅ |
| T4d | 公开 pricing-catalog 可达且含真实 contextWindow | 联网 | ✅ |
| T5 | rewriteBody 强制 `stream=true` + `include_usage` | 离线 | ✅ |
| T6 | rewriteBody 剥离内部字段 + `tool_choice` 归一 | 离线 | ✅ |
| T7 | mapModel 归一大小写/下划线变体 | 离线 | ✅ |
| T8 | fetchSlot 对 `slotState=empty` 的处理（版本门禁非错误） | 联网 | ✅ |
| T9 | chatHeaders 头组正确 | 离线 | ✅ |
| T10 | refreshToken 缺凭据时明确报错（不发请求） | 离线 | ✅ |
| T11 | trial 返回不可用 | 离线 | ✅ |
| T12 | refreshVersion 取到 2026.x 版本号（实测 `2026.9.23`） | 联网 | ✅ |
| T13 | **签到活动存在且奖励 100 积分** | 联网 | ✅ |
| T14 | 旧版本号被服务端隐藏活动（版本门禁防回归） | 联网 | ✅ |
| T15 | 上游端点存在（无鉴权 401 而非 404） | 联网 | ✅ |

跑法：
```powershell
# 离线（11 项）
$env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\electron\dist\electron.exe tools\proxy-lobster-selftest.cjs
# 含联网只读探针（15 项，不带任何账号凭据）
$env:LOBSTER_SELFTEST_LIVE="1"; $env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\electron\dist\electron.exe tools\proxy-lobster-selftest.cjs
```

---

## 9. 风险与风控边界

| 风险 | 等级 | 说明与缓解 |
|------|------|-----------|
| 积分有效期短 | 中 | 注册赠 300（**14 天**）、签到 100（**30 天**）→ 攒着就是浪费，接入后应尽快用掉；不适合当长期稳定额度 |
| 上游改协议 | 中 | 端点已全部外置到 `headers.json`（热加载，改文件即生效，无需发版）；版本号动态取 |
| 200-流内错误 | 中 | 已实现首块窥探；若上游改变错误帧位置需同步调整 |
| 签到活动下线 | 低 | 服务端标注**常驻**（至 2126 年）；但官方可随时改规则 |
| 多账号刷分 | 中 | **多账号批量领取每日积分大概率违反用户协议**，最坏封号——号池规模与风控暴露成正比，仅限自有账号 |
| 手机号注册门槛 | 低 | 必须手机号注册（无邮箱通道） |
| 额度计量口径 | 低 | `totalCreditsRemaining` 含 free + campaign 活动积分；`/api/user/quota` 只含 free，勿混用 |

---

## 10. 分阶段实施路线

| 阶段 | 目标 | 交付 | 状态 |
|------|------|------|------|
| **P0 协议验证** | 端点实测 + 签到活动确认 | 本机无鉴权探针（slot/context 读活动与奖励） | ✅ 完成 |
| **P1 适配器落地** | 十件套 + 双表同步 + 回环 OAuth | adapters/rules/store/discovery/ideswitch + UI 四处 | ✅ 完成 |
| **P2 自测** | 离线 11 项 + 联网 4 项 | `tools/proxy-lobster-selftest.cjs` | ✅ 15/15 |
| **P3 端到端实测** | 真实账号跑通「登录 → 对话 → 查余额 → 签到 +100」 | 需一个手机号注册的账号 | ⏳ **待账号** |
| **P4 收尾** | smoke 断言 + 文档定稿 + 上游 PR | `tools/proxy-smoke.cjs` 加断言 | ⏳ 待 P3 |

---

## 11. 同批候选评估（为什么不是它们）

| 候选 | 每日额度 | 排除原因 |
|------|---------|---------|
| QClaw（腾讯） | 4000 万 token/日 | **技术最优但已判死刑**：腾讯 2026-09-24 公告 **2026-12-24 关停**，新用户注册已停止，补号接口 4026/4050 已关闭 |
| CodeBuddy CN | 活跃赠 30/日 | **与已接入的 WorkBuddy 同后端同积分池**（同 host `copilot.tencent.com`、同凭证池、同签到接口）→ 零增量 |
| CodeBuddy Intl | 30/日 | 与 CN 路径相同仅换 host；无签到端点可自动化 → 中优先级 |
| Trae Solo | 签到 150–200/日 | **与已接入的 Trae 同一套**账号与签到接口（仅 client_id 不同）→ 已覆盖 |
| WPS 灵犀 | 签到约 200 智点/日 | 可行性高（有现成签到脚本），但 cookie 鉴权（`wps_sid`）+ 非 OpenAI 协议 → 下一批 |
| 扣子桌面 Coze | 登录 1500/日 | 非 OpenAI 兼容（`api.coze.cn/v3` 需 bot_id），免费版仅 500 次调用，无逆向实现 |
| Marvis（腾讯） | 1000 万 token/日 | 协议干净但需 **macOS 设备注册 + 专有 dylib**，且有账号级自适应风控（不可压测） |
| 千问办公 QwenWork | 每日 100 分 | WASM 签名 + DPAPI 加密 + 非 OpenAI 协议，且**无签到端点**（服务端自动发放） |
| TeleAgent（电信） | 每日登录 100 分 | 密钥在**进程内存**（非配置文件），强依赖桌面端常驻 + HMAC 签名 → 「提取文件 token」模式不成立 |
| 纳米 Work（360） | 一次性 1 亿 | 凭证与调度全在云端，无本地 token 可提取，无第三方先例 |
| 百度搭子 | 登录 1000/日 | 额度最优但**无任何逆向先例**，接口与鉴权未证实 |
| StepClaw（阶跃） | 一次性 160 | 官方明确「API 使用不属会员权益」→ 积分无法转 API |
| Kimi Work | 按月刷新 | 非每日发放；桌面通道未证实 |
| iFlow 心流 CLI | — | **已关停**（2026-04-17 官方关闭 API 与模型库） |

---

## 12. 证据索引

| 证据 | 来源 | 性质 |
|------|------|------|
| 签到活动元数据 + 奖励 100 | `GET /api/client-activities/slot` + `/context`（本机 2026-10-05 无鉴权实测） | **一手** |
| 版本门禁（0.1.0 → empty） | 同上，四档版本号对照实测 | **一手** |
| 端点存活（401 vs 404） | `GET /api/proxy/v1/models` → 401 | **一手** |
| 客户端版本号 | `api-overmind.youdao.com/.../prod/update` → `2026.9.23` | **一手** |
| 完整协议（exchange/refresh/chat/checkin） | [xinxinshuhao-create/lobsterai2api](https://github.com/xinxinshuhao-create/lobsterai2api) `@21c39a4`（2026-10-02，MIT，Go 纯标准库） | 交叉验证 |
| 签到实现时序 | 同上 commit `d650d9c`「feat: implement daily check-in」——**2026-10-02 才提交**，此前 README 明写 `DailyCheckin is currently a no-op` | 交叉验证 |
| 19 模型清单 | 同上 commit `a08ce1f`「update static model fallback table to real 19 models」 | ⚠️ **已弃用**（见下） |
| **30 模型 + 真实 contextWindow** | **`GET /api/models/pricing-catalog`（公开端点，本机 2026-10-05 实测 200/37KB）** | **一手（权威）** |
| 目录字段契约 | 官方开源仓库 `docs/server-integration/2026-06-24-explicit-context-cache-models.md`、`2026-08-27-more-models.md`、`specs/features/model-thinking-level-control/` | **一手（官方文档）** |
| 模型注册表（客户端侧） | 官方开源仓库 `src/shared/providers/constants.ts`（含各 provider 的 contextWindow 真值） | **一手（官方源码）** |
| 200-流内错误帧 | 同上 commit `28e6ace` / `e8f2866` | 交叉验证 |
| 签到面板旁证 | [dsh-lobsterai-daddy](https://github.com/loyalchiiina/dsh-lobsterai-daddy)（第三方 DSH 插件，含「立即全部签到」「自动签到开关」「最近签到时间」） | 旁证 |
| 积分规则（注册 300/14 天、签到 100/30 天） | [lobsterai2api 部署教程](https://qianling.pw/lobsterai2api)（2026-09-14） | 二手（金额已由服务端接口证实） |

> **关于「有没有签到」的信息混乱**：网上早期教程称「没有签到」，是因为参考实现的签到功能 **2026-10-02** 才提交（此前是 no-op 空实现）。本方案以服务端接口的一手实测为准。

---

## 13. 待办

- [ ] **P3 端到端实测**：需一个手机号注册的 LobsterAI 账号（本机未安装客户端、无账号）
      - 验证：回环 OAuth 入池 → 对话出流 → `totalCreditsRemaining` 读数 → 签到 `+100` 到账
- [ ] `tools/proxy-smoke.cjs` 加 lobster 断言（跟随 Qoder 先例）
- [ ] 真实账号下补测：TTFT、多轮上下文、tool_calls 回路、图片多模态（`glm-5v-turbo`）
- [ ] 若上游收紧签到规则，考虑把 `checkinPlacement` / 活动码也外置
