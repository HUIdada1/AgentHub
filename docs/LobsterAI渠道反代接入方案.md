# LobsterAI 渠道反代接入方案（2026-10-05）

> 状态：**已落地，端到端实测通过（含签到真实到账）**。本方案基于 2026-10-05 对 LobsterAI（网易有道龙虾）
> 线上服务的实测、官方开源仓库（`netease-youdao/LobsterAI`，MIT）文档与源码的交叉验证，
> 以及 `lobsterai2api@21c39a4`（第三方反代）与 `dsh-lobsterai-daddy`（第三方签到面板）的旁证。
> 适用 AgentHub v1.43.1。自测：`tools/proxy-lobster-selftest.cjs`（**26 项**，20 离线 + 6 联网只读，全通过）。
>
> **实测数据**（真实账号，2026-10-05）：
> - 单号：对话出流正常（TTFT 297–3688ms）、余额读数 `299.65736`、**签到 +100 到账且幂等**、
>   模型目录 30 个、8 个免费模型逐个调用通过
> - **双号共存**：两号各自余额/签到/调模型完全独立（账号 A 余额 399.59 / 账号 B 余额 697.42），
>   扣费各自记账（0.10320 vs 0.02508），号池 uid 唯一无重复

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
→ { code:0, data:{ accessToken, refreshToken, expiresIn,
                   user:{ id, yid, userId, nickname, phone, accountMode },
                   quota:{ freeCreditsTotal, freeCreditsRemaining, freeCreditsUsed, … } } }
```
- **无需 Bearer**（exchange/refresh 都是无鉴权端点）
- access token 实测 HS512 JWT，约 30 天（`expiresIn` 缺失时从 JWT `exp` 解）
- `uuid` / `firstKeyfrom` 是**设备安装标识**，刷新时必须回传 → 落 `accounts.meta`（丢失会导致 refresh 被拒）
- **`user` 字段的 uid 口径（踩过坑，务必按此解析）**：
  - `user.userId` = `"100001"`（数字 uid，**权威**）
  - `user.yid` = `"urs-phoneyd.<hash>@163.com"`（**邮箱标识，不是 uid**）
  - JWT payload `sub` = `"100001"`（兜底来源）
  - ⚠️ 把 `yid` 当 uid 候选会污染号池去重与排序 → 实现里用 `resolveLobsterUid()` 显式排除含 `@` 的值（见 §15.3 缺陷 1）
- **`quota` 随 exchange 一起返回**（含 `freeCreditsRemaining`）——可用于首屏余额，省一次查询
- **授权码一次性**：重复消费时仍返回 HTTP 200 但 `data.user` 为空（`code` 仍为 0）→
  必须校验 token 非空且 uid 可解析，否则会把空凭据落库（见 §15.3 缺陷 2/3）

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

### 2.5.1 同系列模型的区分（易混点）

目录里若干模型 ID 只差一个后缀，**能力相同、只有速度或价格分档**，不要误当不同能力等级。

#### GLM-5.3-Flash vs GLM-5.3-FlashX —— **同一个模型的两个速度档**

智谱官方文档把两者放在**同一页**（标题即「GLM-5.3-Flash/FlashX」，Model Code 写作
`glm-5.3-flash/glm-5.3-flashx`），确认是同源模型：

| 字段 | glm-5.3-flash | glm-5.3-flashx | 关系 |
|------|---------------|----------------|------|
| 上下文窗口 | 1,000,000 | 1,000,000 | 相同 |
| 最大输出 | 128K | 128K | 相同 |
| 能力位 | 图片 ✓ / 思考 ✓ | 图片 ✓ / 思考 ✓ | 相同 |
| 倍率 `costMultiplier` | **0.06** | **0.15** | **2.5 倍** |
| 输入积分/1M | 80 | 200 | 2.5 倍 |
| 输出积分/1M | 280 | 700 | 2.5 倍 |
| 缓存输入积分 | 23 | 57 | ≈2.5 倍 |
| `freeAccess` | true | true | 都免费 |
| 推理速度 | 基准 | **最高 200 tokens/s** | **快 5 倍** |

- 官方描述除速度外**逐字相同**（都是「Coding 表现与 Claude Opus 4.8 相当，并强化了前端、游戏及 3D 仿真等视觉 Coding 能力」）；
  FlashX 是 2026-09-18 新增的高速版，[官方口径](https://stcn.com/article/detail/4190490.html)是「推理速度最高 200 tokens/s，较 Flash 提升 5 倍，定价提升至 2.5 倍」。
- **选型**：大批量/日常任务用 `glm-5.3-flash`（0.06，全场最低档之一）；交互式编程等对等待敏感的场景再换 FlashX
  ——用 2.5 倍成本换 5 倍速度。
- **对号池的影响**：两者都 `freeAccess=true`，AgentHub 都算免费额度；但扣费按积分计，
  倍率差异会直接反映在**消耗速度**上（FlashX 烧分快 2.5 倍）。

#### 其它易混对

| 易混对 | 关系 |
|--------|------|
| `glm-5.3-flash` / `glm-5.3-flashx` / `glm-5.3` | 前两者是 Flash 系列（1M、原生多模态、0.06/0.15）；`glm-5.3` 是**另一能力等级的旗舰**（倍率 1.08，`freeAccess=false`，不支持图片），不是同一系列 |
| `deepseek-flash` / `deepseek-v4-flash` | **两个不同模型**：前者是 **V4.1**-Flash（`supportsImage=true`，多模态）；后者是 V4-Flash（纯文本）。ID 里没有版本号，极易混淆 |
| `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` | 同代文本版与视觉实验版；**两者都 `moreModel=true`**（默认折叠） |
| `kimi-k2.7-code` / `kimi-k2.7-code-highspeed` | 同模型，Highspeed 输出约 180 tokens/s（短上下文可达 260），倍率 0.73 → 1.46 |
| `qwen3.8-flash` / `qwen3.8-omni-flash` | 后者是全模态版（文本/图像/音频/视频输入），倍率相同（0.06） |
| `MiniMax-M3` / `MiniMax-M3.1-Flash-Preview` | 后者是限时免费预览版（`costMultiplier=0`，但 `freeAccess=false`），1M 上下文 |

> `moreModel: true` 的模型在官方客户端里默认折叠在「更多模型」分组下——**这是展示层字段，
> 不影响可用性、计费与路由**（官方 `2026-08-27-more-models.md` 明确说明）。AgentHub 侧不做折叠。
> 实测分布（30 个文本模型）：`moreModel=true` **16 个**、`false` **14 个**。
> 注意 `glm-5.2` 与 `glm-5` 也在折叠组里，但它们**并非低配**——`glm-5.2` 倍率 1.08、1M 窗口，
> 与 `glm-5.3` 同档；折叠只表示官方客户端 UI 的默认收起，不代表能力或授权等级。

#### 完整目录（30 个文本模型，按倍率升序）

| modelId | 名称 | 上下文 | 图 | 倍率 | 免费 | more |
|---------|------|--------|----|------|------|------|
| `MiniMax-M3.1-Flash-Preview` | MiniMax-M3.1-Flash-Preview | 1,000,000 | ✓ | **0** | – | – |
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1,000,000 | ✓ | 0.05 | **✓** | – |
| `deepseek-v4-flash-vision-exp` | DeepSeek-V4-Flash-Vision-Exp | 1,000,000 | ✓ | 0.05 | **✓** | ✓ |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | 1,000,000 | – | 0.05 | **✓** | ✓ |
| `glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | ✓ | 0.06 | **✓** | – |
| `qwen3.8-flash` | Qwen3.8-Flash | 1,000,000 | ✓ | 0.06 | – | – |
| `qwen3.8-omni-flash` | Qwen3.8-Omni-Flash | 1,000,000 | ✓ | 0.06 | – | – |
| `qwen3.5-plus-2026-04-20` | Qwen3.5-plus | 0 | ✓ | 0.12 | – | ✓ |
| `glm-5.3-flashx` | GLM-5.3-FlashX | 1,000,000 | ✓ | 0.15 | **✓** | – |
| `MiniMax-M3` | MiniMax-M3 | 1,000,000 | ✓ | 0.24 | **✓** | – |
| `MiniMax-M2.7` | MiniMax-M2.7 | 0 | – | 0.24 | – | ✓ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1,000,000 | – | 0.26 | **✓** | – |
| `doubao-seed-2-1-turbo-260628` | Doubao-Seed-2.1-Turbo | 256,000 | ✓ | 0.34 | – | ✓ |
| `qwen3.6-plus` | Qwen3.6-Plus | 0 | ✓ | 0.34 | – | ✓ |
| `kimi-k2.5` | Kimi-K2.5 | 0 | ✓ | 0.41 | – | ✓ |
| `qwen3.7-plus` | Qwen3.7-Plus | 1,000,000 | ✓ | 0.53 | – | ✓ |
| `doubao-seed-2-0-code-preview-260215` | Doubao-Seed-2.0-Code | 0 | ✓ | 0.54 | – | ✓ |
| `kimi-k2.6` | Kimi-K2.6 | 0 | ✓ | 0.64 | – | ✓ |
| `glm-5` | GLM-5 | 0 | – | 0.64 | – | ✓ |
| `doubao-seed-2-1-pro-260915` | Doubao-Seed-2.1-Pro | 256,000 | ✓ | 0.68 | – | – |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | 262,144 | ✓ | 0.73 | – | – |
| `kimi-k2.7-code` | Kimi-K2.7-Code | 262,144 | ✓ | 0.73 | – | – |
| `qwen3.8-max` | Qwen3.8-Max | 1,000,000 | ✓ | 0.91 | – | – |
| `glm-5v-turbo` | GLM-5V-Turbo | 0 | ✓ | 0.96 | – | ✓ |
| `glm-5.1` | GLM-5.1 | 0 | – | 1.07 | – | ✓ |
| `glm-5.2` | GLM-5.2 | 1,000,000 | – | 1.08 | – | ✓ |
| `glm-5.3` | GLM-5.3 | 1,000,000 | – | 1.08 | – | – |
| `qwen3.7-max` | Qwen3.7-Max | 1,000,000 | – | 1.33 | – | ✓ |
| `kimi-k2.7-code-highspeed` | Kimi-K2.7-Code-Highspeed | 262,144 | ✓ | 1.46 | – | ✓ |
| `kimi-k3` | Kimi-K3 | 1,048,576 | ✓ | 20.00 | – | – |

> 上下文 `0` = 服务端返回 `contextWindow: null`（未知），见上文说明。
> 另有 5 个图像模型（Seedream 5.0 系列、MiniMax-Image-01、Wan2.7-Image 系列）
> 与 4 个视频模型（HappyHorse-1.1、Seedance 2.0 系列、MiniMax-Hailuo-2.3）——**AgentHub 暂不接入**（非文本对话）。

#### 免费模型实测（2026-10-05，真实账号逐模型调用）

`freeAccess=true` 共 **7 个**，另有 1 个 `costMultiplier=0` 的零扣费预览版。实测结果：

| 模型 | TTFT | 输出帧 | 内容 | 实测扣费 |
|------|------|--------|------|----------|
| `deepseek-flash` | 870ms | 36 | 正常 | −0.01750 |
| `deepseek-v4-flash` | 729ms | 77 | 正常 | −0.03390 |
| `deepseek-v4-flash-vision-exp` | 369ms | 43 | 正常 | −0.02030 |
| `deepseek-v4-pro` | 469ms | 50 | 正常 | −0.11160 |
| `glm-5.3-flash` | 638ms | 84 | 正常 | −0.02516 |
| `glm-5.3-flashx` | 752ms | 185 | 正常 | −0.13430 |
| `MiniMax-M3` | 817ms | 43 | 正常 | 见下注 |
| `MiniMax-M3.1-Flash-Preview` | 817ms | 3 | 正常 | **0（真零扣费）** |

**⚠️ 「免费」不等于「零扣费」**：`freeAccess=true` 是**访问权限**（免费用户可调用），
不是「不扣积分」——只有 `MiniMax-M3.1-Flash-Preview`（`costMultiplier=0`）实测零扣费。
其余免费模型的倍率仍会按用量扣积分（如 `glm-5.3-flashx` 倍率 0.15，同样长度扣费是 Flash 的 2.5 倍）。
这一点直接影响号池策略：**免费模型之间仍应按倍率区分优先级**，不能一视同仁。

**分时计价**：DeepSeek 系（`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`）
有高峰/空闲两档——空闲 `x0.05`、高峰（09:00–12:00、14:00–18:00 北京时间）`x2`。
实测时刻 `currentPeriod=offPeak`。号池若按余额排序，高峰期消耗会快一倍。

#### ⚠️ MiniMax 系思考链形态差异（已适配）

实测三例对照（同一 prompt），**思考链的承载字段不一致**：

| 模型 | `usage` | 思考链位置 |
|------|---------|-----------|
| `MiniMax-M3` / `M3.1-Flash-Preview` | ✅ 有（但 `reasoning_tokens: 0`） | ❌ **内嵌在 `content`**：`<think>…</think>` 文本 |
| `glm-5.3-flash` | ✅ 有（`reasoning_tokens: 255`） | ✅ 独立 `reasoning_content` 字段 |
| `deepseek-v4-pro` | ✅ 有（`reasoning_tokens: 148`） | ✅ 独立 `reasoning_content` 字段 |

通用层 `server.cjs` 只识别独立的 `reasoning_content`（`server.cjs:435`），若不归一，
MiniMax 的思考链会**被当正文原样透传给客户端**（用户看到一串 `<think>The user simply…`）。

**适配方案**（`adapters.cjs` 的 `createThinkSplitter` / `splitThinkDelta`）：
在 lobster 适配器的 `chat()` 内做 per-request 归一——把 `content` 里的 `<think>…</think>`
抽出来改挂 `reasoning_content`，与其它模型形态对齐。要点：
- **跨帧状态机**而非逐帧正则：标签会被切成多帧（`<thi` + `nk>`），逐帧 `replace` 必然漏。
- 疑似半个标签的尾巴**推迟到下一帧**判定，故调用方须按帧累积 `reasoning`。
- 无 `<think` 时走快路径原样透传，零开销、不误吞正文。

自测 T16 覆盖 6 个场景（单帧完整 / 开标签跨帧 / 闭标签跨帧 / 无标签原样 / 段内跨多帧累积 /
**正文绝不含标签**）。

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
| `models()` | catalog.json 静态兜底 **30 模型**（拉取后整段覆盖） | 🟢 | 权威源 = 公开 `pricing-catalog` |
| `fetchModels()` | `GET /api/models/available` → 整形 `{id,name,rate,capabilities,contextLength,maxOutputTokens}`；401 就地刷新重试一次 | 🟢 | 拉取失败保留旧目录 |
| `headers()` | 静态头组（Bearer + UA + 2 个 `X-LobsterAI-*`），无需签名 | 🟢 | 与 WB 同级，远简于 Qoder |
| `rewriteBody()` | 强制 `stream=true` + `include_usage`；`tool_choice` 归一（空/none/null 删除）；剥离内部字段 | 🟢 | 上游非流式返回 500 |
| `chat()` | 原生 OpenAI SSE 透传 + **首块错误帧窥探**（`event:error` 或 data 带 error 对象）+ **非对象帧守卫**（null/数组/裸标量丢弃）+ **MiniMax 系 `<think>` 归一**（抽成 `reasoning_content`） | 🟡 | 200-流内错误与思考链形态是两个最大陷阱 |
| `queryCredits()` | `GET /api/user/profile-summary` → `totalCreditsRemaining` | 🟢 | 实测通过；余额为浮点（如 `299.65736`） |
| `checkin()` | 三段式（slot → context → check_in → 复核）；幂等：已签/无活动都返回 ok | 🟢 | **本渠道核心新增**；实测 +100 到账且二次幂等 |
| `checkinStatus()` | 读 context 的 `claimedToday`（不消费动作） | 🟢 | 带 `reward` 与 `already` |
| `refreshToken()` | `POST /api/auth/refresh`（含 keyfrom 载荷，meta 取 uuid/firstKeyfrom） | 🟢 | 参考实现口径：缺 accessToken = 终止性拒绝 |
| `trial()` | 明确返回不可用（龙虾无加油包） | 🟢 | |
| 回环 OAuth | `discovery.beginLobsterOAuth`：`listenLoopback` + `/auth/callback` + exchange | 🟢 | 复用 Trae 范式 |
| **uid 解析** | `discovery.resolveLobsterUid()`：`userId` > `id` > JWT `sub`，**显式排除含 `@` 的值**（yid 是邮箱形态） | 🟡 | 号池去重与排序的依据（见 §15.3） |
| **晚到回调补救** | `lobsterIssuedStates` 宽限表（30min TTL）+ `submitLobsterCallback()` | 🟡 | 会话超时后授权码仍可救（见 §15.4） |

---

## 4. 落地组件清单

```
electron/backend/proxy/
  ├─ rules.cjs          + headers.json.lobster（端点/版本/UA/公开目录，热加载）
  │                     + catalog.json.lobster（30 模型静态兜底，权威源 = 公开 pricing-catalog）
  ├─ adapters.cjs       + lobster 适配器（十件套）+ ADAPTERS 注册 + 版本号缓存
  │                     + createThinkSplitter/splitThinkDelta（MiniMax 系 <think> 归一）
  ├─ discovery.cjs      + beginLobsterOAuth()：回环 OAuth
  │                     + resolveLobsterUid()（uid 口径，排除 yid 邮箱形态）
  │                     + lobsterIssuedStates 宽限表 + submitLobsterCallback()（晚到回调补救）
  │                     + exchangeLobsterAuthCode / saveLobsterAccount（空 uid 拒绝落库）
  ├─ index.cjs          + proxy_oauth_submit_callback 补跑「刷新余额 + 自动签到」
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
tools/proxy-lobster-selftest.cjs（新）  26 项断言（20 离线 + 6 联网只读）
tools/proxy-smoke.cjs               + lobster 断言块（渠道注册/双表同步/模型归属/OAuth 形态）
docs/LobsterAI渠道反代接入方案.md（本文）
```

---

## 5. UX 流程设计

| 环节 | 设计 | 说明 |
|------|------|------|
| 添加途径 | **OAuth 登录**（主）/ file / paste | 无「从本机软件导入」——官方登录态在客户端 SQLite（且**只有一个登录槽**，多号需各自重新授权），本渠道无需装客户端 |
| OAuth 形态 | **回环**：跳官方登录页 → 回调 `127.0.0.1/auth/callback` → 自动入池 | 与 Trae 同构；文案明说「无需安装客户端」 |
| 兜底 | 浏览器没跳回时可整段粘贴回调地址 | 走 `submitLobsterCallback`（**不要求存在活动会话**，见 §15.3 缺陷 4） |
| 登录后动作 | 刷新余额 + 自动签到一次（`onDone` 路径）；补交路径由 IPC 层补跑 | 否则新入池号停在 `credits=0`，被 `credit_first` 误判为末位（见 §15.3 缺陷 5） |
| 签到 | 一键签到（挂 `checkinBatch`，含 800–2000ms 抖动）；结果带 `+100 积分` | 定时 `checkinAuto` 同样生效 |
| 签到提示 | 「每日签到领 100 积分（常驻活动，需客户端版本 ≥ 2026.9.4）」 | 如实说明版本门禁 |
| relogin 文案 | 「请重新执行 OAuth 登录」 | 无客户端可依赖，不能照抄 WB 的「去客户端重登」 |
| 写回本地 | **不支持**（`ideSupported` 返回 false） | 登录态在客户端 SQLite 且为单槽，写回会顶掉用户当前登录 |
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
| **非对象帧** | 上游可能夹字面量 `null`/数组/裸标量 → 显式判类型丢弃（Qoder `body:"null"` 同款坑，见 §14 ①） |
| **思考链形态** | MiniMax 系把 `<think>` 塞在 `content` 里（GLM/DeepSeek 用独立 `reasoning_content`）→ 适配器归一（见 §2.5.1） |
| 首字节 | 默认 30s 预算充裕：**实测 TTFT 297–3688ms**（8 模型 × 6 能力维度），最快 `deepseek-v4-flash-vision-exp` 369ms，最慢 `glm-5.3-flash` 工具调用 3688ms |
| 流式真实性 | 已用原始 TCP chunk 时序验证：`deepseek-flash` 368 chunk / 602ms、`glm-5.3-flash` 252 chunk / 1811ms —— 适配器**纯透传无缓冲**，帧分布差异来自上游 |
| 幂等 | 签到带 `idempotencyKey`（uuid4）+ 复核 `claimedToday`，双重防重复发放（实测二次签到返回 `already:true` 且余额不变） |

---

## 8. 自测清单（tools/proxy-lobster-selftest.cjs）

共 **26 项**（**20 离线 + 6 联网只读**），全通过。

| # | 断言 | 类型 | 状态 |
|---|------|------|------|
| T1 | 渠道已注册（adapters / store.CHANNELS 双表同步） | 离线 | ✅ |
| T2 | 适配器接口完整（12 个方法） | 离线 | ✅ |
| T3 | headers.json.lobster 端点齐备 | 离线 | ✅ |
| T4 | catalog.json 静态兜底目录非空且含关键模型 | 离线 | ✅ |
| T4b | 上下文取真实值（非 131072 占位；1M 档正确；未标记 0） | 离线 | ✅ |
| T4c | 能力位/倍率取自公开目录实测值 | 离线 | ✅ |
| T4e | 同系列易混模型齐备（Flash/FlashX、DeepSeek V4.1/V4、code/highspeed） | 离线 | ✅ |
| T5 | rewriteBody 强制 `stream=true` + `include_usage` | 离线 | ✅ |
| T6 | rewriteBody 剥离内部字段 + `tool_choice` 归一 | 离线 | ✅ |
| T7 | mapModel 归一大小写/下划线变体 | 离线 | ✅ |
| T9 | chatHeaders 头组正确 | 离线 | ✅ |
| T10 | refreshToken 缺凭据时明确报错（不发请求） | 离线 | ✅ |
| T11 | trial 返回不可用 | 离线 | ✅ |
| T16 | **`<think>` 归一**：跨帧标签切分正确、正文与思考分离（6 场景） | 离线 | ✅ |
| T17 | **畸形帧守卫**：null/数组/裸标量均不中断（Qoder `body:"null"` 同款坑） | 离线 | ✅ |
| T18 | **端点全部走 headers.json 配置**（无硬编码 URL） | 离线 | ✅ |
| T19 | **预刷新窗口**：用默认 24h（凭据独立，不照抄 raccoon 的 300s） | 离线 | ✅ |
| T20 | **uid 解析**：yid 不污染 uid，优先级与 JWT 兜底正确 | 离线 | ✅ |
| T21 | **空 uid 拒绝落库** + token 非空校验 | 离线 | ✅ |
| T22 | **state 宽限表**：会话关闭后仍认已签发 state，未知 state 仍被拒 | 离线 | ✅ |
| T4d | 公开 pricing-catalog 可达且含真实 contextWindow | 联网 | ✅ |
| T8 | fetchSlot 对 `slotState=empty` 的处理（版本门禁非错误） | 联网 | ✅ |
| T12 | refreshVersion 取到 2026.x 版本号（实测 `2026.9.23`） | 联网 | ✅ |
| T13 | **签到活动存在且奖励 100 积分** | 联网 | ✅ |
| T14 | 旧版本号被服务端隐藏活动（版本门禁防回归） | 联网 | ✅ |
| T15 | 上游端点存在（无鉴权 401 而非 404） | 联网 | ✅ |

跑法：
```powershell
# 离线 20 项（不联网、不读本机客户端凭据，CI/空环境可全绿）
$env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\electron\dist\electron.exe tools\proxy-lobster-selftest.cjs
# 全量 26 项（含 6 项联网只读探针，不带任何账号凭据）
$env:LOBSTER_SELFTEST_LIVE="1"; $env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\electron\dist\electron.exe tools\proxy-lobster-selftest.cjs
```

> **设计原则**：联网探针由 `LOBSTER_SELFTEST_LIVE` 门控、默认跳过；自测**不读本机客户端凭据**
> （只用公开端点 + 合成数据），故空 APPDATA 环境可全绿（对齐 Qoder 的 `0f4f4dd`/`a924831` 教训）。

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
| **P2 自测** | 离线 20 项 + 联网 6 项 | `tools/proxy-lobster-selftest.cjs` | ✅ 26/26 |
| **P3 端到端实测** | 真实账号跑通「登录 → 对话 → 查余额 → 签到 +100」 | 真实账号（单号 + 双号共存） | ✅ 完成 |
| **P3b 缺陷修复** | 双号实测暴露的 OAuth 落库缺陷 + 晚到回调 | `resolveLobsterUid` / 空 uid 拒绝 / state 宽限表 | ✅ 完成 |
| **P4 收尾** | smoke 断言 + 文档定稿 + 上游 PR | `tools/proxy-smoke.cjs` 已加断言 | ⏳ 待推送 |

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
| **`user` 字段 uid 口径（yid 是邮箱不是 uid）** | `POST /api/auth/exchange` 真实响应（2026-10-05）：`userId:"100001"` / `yid:"urs-phoneyd.<hash>@163.com"` | **一手** |
| **授权码一次性（重复消费返回 200 但 user 为空）** | 同上，同一 code 二次 exchange 实测 | **一手** |
| **客户端单登录槽（多号不共存）** | `%APPDATA%\LobsterAI\lobsterai.sqlite` 的 `kv.auth_tokens`/`auth_user` 为单值；两号先后登录后仅剩后登号凭据 | **一手** |
| **双号独立可用性** | 真实双号实测：余额/签到/调模型/扣费四项全独立（见 §15.2） | **一手** |
| **免费模型实测扣费** | 8 个 `freeAccess=true` 模型逐个调用 + 余额前后对比（见 §2.5.1） | **一手** |
| **思考链形态差异** | 三例对照实测：MiniMax-M3/M3.1 内嵌 `content`；GLM/DeepSeek 用独立 `reasoning_content` | **一手** |

> **关于「有没有签到」的信息混乱**：网上早期教程称「没有签到」，是因为参考实现的签到功能 **2026-10-02** 才提交（此前是 no-op 空实现）。本方案以服务端接口的一手实测为准。

---

## 13. 待办

- [x] **P3 端到端实测**：真实账号跑通「回环 OAuth 入池 → 对话出流 → 余额读数 → 签到 +100 到账」
- [x] **P3b 双号共存实测** + 暴露缺陷修复（见 §15）
- [x] `tools/proxy-smoke.cjs` 加 lobster 断言（跟随 Qoder 先例）
- [x] 真实账号下补测：TTFT、多轮上下文、图片多模态、8 个免费模型逐个调用
- [x] **tool_calls 回路**（见 §16，2026-10-05 补测；此前误勾为已完成，实际只验证了「发起」未验证「回路」）
- [x] **推送上游**：PR [#54](https://github.com/HUIdada1/AgentHub/pull/54)（mergeable_state=clean）
- [ ] 若上游收紧签到规则，考虑把 `checkinPlacement` / 活动码也外置
- [ ] 可选：把 `store.cjs` 的 credits 精度从 2 位小数放宽（当前对 LobsterAI 影响轻微，
      见 §14 ②；改动影响全渠道，收益不足故暂缓）

### 未验证项（如实记录）

| 项 | 说明 |
|----|------|
| 长上下文（1M）实测 | 只验证了模型声明与短对话，未跑接近 1M 的真实长文 |
| `refresh` 是否吊销其它会话 | 未实测（避免动用户客户端凭据）。LobsterAI 走独立 OAuth，理论上不冲突，但若服务端 refresh 轮换并吊销旧 refresh_token，AgentHub 与客户端可能互相影响——**待观察** |
| 图片多模态各模型表现 | 只测了 `glm-5.3-flash` / `deepseek-flash`（发现 alpha 合成理解差异），`glm-5v-turbo` 等未逐个验证 |
| 签到跨天行为 | 只验证了当日幂等；跨天 `claimedToday` 自动归 false 是**依据服务端字段语义推断**，未跨天实测 |
| 高并发下的账号调度 | 未做并发压测；号池 `credit_first` 排序在双号下已验证，N 号未测 |

---

## 14. Qoder 历史坑位审计（2026-10-05）

接入完成后，回查 Qoder 渠道从接入到定稿的 **25 个提交**，逐个核对 LobsterAI 是否有同款问题。
Qoder 的价值不只在于「怎么接」，更在于它踩过哪些坑——这些坑大多与**渠道无关**，是协议/上游的通用陷阱。

| # | Qoder 坑（提交） | 问题本质 | LobsterAI 审计结果 |
|---|-----------------|---------|-------------------|
| ① | `81cf50b` 上游夹 `body:"null"` 字面量帧 → `JSON.parse` 得 `null` → 访问 `.choices` 抛 TypeError，整条流以内部异常中断 | 非对象帧未守卫 | ⚠️ **已加固**：原有 `if (!data)` 只挡 falsy，`[]`/`"abc"`/`123` 等 truthy 非对象仍会穿透 → 改为显式判类型；T17 锁 6 种畸形帧 |
| ② | `13d7653` Qoder 浮点 Credits 被整数化 | 落库精度 | ⚠️ **影响轻微**：`store.cjs` 统一四舍五入 2 位小数，而 LobsterAI 余额是 5 位小数（`299.65736` → `299.66`）。实测单次消耗 0.0175–0.1343，远大于 0.01 精度，**余额展示与消耗统计不受影响**；仅当两号真实差 <0.01 时 `credit_first` 排序会并列（退化为稳定序，不选错号）。未改动（改全渠道精度影响面更大，收益不足） |
| ③ | `813617a`/`75df349` role 白名单冲突（上游只收特定枚举，`developer`/`function` 直接 400） | 入口 role 归一 | ✅ **已覆盖**：`util.normalizeRoles` 在入口统一归一（`developer→system`、`function→tool/user`、大小写变体降级）。实测 LobsterAI 上游**确实拒 `developer`**（返回「角色信息不正确」），走真实链路归一后正常 |
| ④ | `4069acf` 每日领取窗口未开（Qoder 10:00 重置）导致自动签到永久错过当日额度 | 窗口未开需延后 | ✅ **不适用**：LobsterAI 的 `claimedToday` 是服务端**按日**字段（跨天自动归 false），且活动为常驻（`endAt`=2126），**不存在「窗口未开」状态**，无需 deferred 机制 |
| ⑤ | `5dda7af` OAuth 落库缺口：`expires_at` 未落库（轮询响应不含到期时间）/ `email` 恒空（塞在 name 里）/ 字段名差异 | 落库字段完整性 | ⚠️ **初次审计判为「已规避」是错的**——双号共存实测（2026-10-05）暴露了**同类缺陷的变体**：uid 解析把 `yid`（邮箱形态）当候选、空 uid 照样落库、token 未校验非空。三项均已修复（见 §15）。教训：**「字段有没有落库」不等于「落库的值对不对」**，静态审计看不出语义错误，必须用真实账号跑多号场景 |
| ⑥ | `5ced951` 端点硬编码 gateway，CN 的 gateway/openApi 恰好都通掩盖了 INTL 只在 openapi 的差异 | 端点须外置 | ✅ **已规避**：lobster 适配器内**零硬编码 URL**，7 个端点全走 `headers.json`（热加载）；T18 锁该不变量 |
| ⑦ | `0f4f4dd`/`a924831` 自测缺「无客户端/无凭据」守卫，CI 空环境下必然失败 | 自测环境守卫 | ✅ **已规避**：联网探针由 `LOBSTER_SELFTEST_LIVE` 门控、默认跳过；自测**不读本机客户端凭据**（只用公开端点 + 合成数据），空 APPDATA 环境可全绿 |
| ⑧ | `67bb827` 风控身份按 uid 缓存 → N 账号白付 N×3.6s（实为机器级信息） | 缓存键语义 | ✅ **已规避**：版本号缓存是**全局单值**（版本号是机器级信息），非按 uid，无 N 倍浪费 |
| ⑨ | `5ced951` 脚本缺 `process.exit(0)` → fetch keep-alive 句柄让事件循环不退出、进程挂死 | 脚本收尾 | ⚠️ **本轮审计中我自己踩到 3 次**（写审计脚本时忘了 `process.exit`，被转入后台作业）。已按既有约定在所有脚本末尾显式 `process.exit` |
| ⑩ | `4069acf`/`13d7653` 会话池 `free` 语义（池化后归还取代销毁，catch-free 会销毁复用中实例） | 资源归还 | ✅ **不适用**：LobsterAI 无 WASM 会话/签名器，无池化资源 |
| ⑪ | raccoon `refreshWindowSec=300`（与桌面端共用 `auth.json`，抢刷互相作废） | 预刷新窗口 | ✅ **不适用**：LobsterAI 走**独立回环 OAuth**（AgentHub 持自己那份凭据，不与客户端共用文件），沿用默认 24h；T19 锁「不要照抄 raccoon 的 300s」 |

**审计结论**：11 项中 **6 项已规避、2 项不适用、3 项需修**（①②⑤）。其中：
- ① 是**真实加固**——初版守卫（`if (!data) return`）挡不住 `[]`/裸标量这类 truthy 非对象帧，与 Qoder 同款隐患，已改显式类型判定 + T17 锁定。
- ⑤ 初次判为「已规避」**是错的**——双号实测暴露了同类缺陷的变体（见 §15）。

> **方法论收获（一）**：Qoder 的 25 个提交里有 6 个是纯 `fix`，全部源于「实测才发现」的差异。
> 这些坑的共同特征是**上游行为与文档/直觉不符**（null 帧、浮点精度、role 枚举、窗口重置、
> 字段名漂移、端点分域）。故新渠道接入时，**逐项回查历史 fix 提交**是性价比很高的审计手段——
> 它把「别人踩过的坑」变成了「我的检查清单」。

> **方法论收获（二）**：静态审计有天花板。⑤ 之所以被误判为「已规避」，是因为我只核对了
> 「字段有没有落库」，而真实缺陷是「落库的**值**是错的」（uid 被 yid 污染）。
> **语义正确性必须靠真实数据 + 多号场景验证**，单号 happy path 也测不出来。
> 结论：静态审计（回查历史坑）与动态实测（真实账号、多账号、异常路径）**互补，不可互相替代**。

### 审计中确认的两个 LobsterAI 特有事实

1. **`refreshWindowSec` 无需收紧**：raccoon 之所以要压到 300s，是因为它与桌面端**共用**
   `~/.box-agent/config/auth.json`（同一份 `refresh_token`，抢刷会互相作废）。
   LobsterAI 走独立回环 OAuth，AgentHub 持自己那一份凭据，**不存在共用文件冲突**。
   access token 实测 30 天有效，24h 预刷新窗口不会每轮触发。

2. **`role` 归一是入口层职责，不是适配器职责**：实测 LobsterAI 上游**确实拒绝 `developer`**
   （返回「角色信息不正确」），与 workbuddy 同款。但 `util.normalizeRoles` 已在入口统一归一，
   故适配器**不需要也不应该**再维护一份 role 白名单（渠道/模型组合会持续增加，表必然过期）。
   审计时若绕过入口直接调 `adapter.chat()`，会误判为「适配器缺归一」——**测试要走真实链路**。

---

## 15. 双号共存实测与缺陷修复（2026-10-05）

### 15.1 客户端不支持多账号，号池才是解法

LobsterAI 桌面端只有**一个登录槽**：`lobsterai.sqlite` 的 `kv.auth_tokens` / `kv.auth_user`
是单值。实测两号先后登录后，SQLite 里只剩后登号（100002）的 access + refresh，
旧号（100001）**凭据无任何残留**（只在 `sidebar_purchase_guide.v1.personal:100001`
这个 UI 状态键里留下过 uid 字样）。

> 这恰好说明 AgentHub 号池的价值：**上游客户端的多账号能力缺口，由号池补齐**。
> 但代价是每个号都必须经 AgentHub 的 OAuth 重新授权一次（客户端已有的登录态无法复用）。

### 15.2 双号实测结果

| 账号 | 余额 | 签到 | 调模型（glm-5.3-flash） | 扣费 |
|------|------|------|------------------------|------|
| 账号 A（后注册） | 399.59 | ✅ 今日已签到 | ✅ TTFT 865ms，362 tok | 0.10320 |
| 账号 B（先注册） | 697.42 | ✅ 今日已签到 | ✅ TTFT 530ms，83 tok | 0.02508 |

- 两号余额、签到状态、扣费**完全独立**；号池 `uid` 唯一、无空值、全部 `online`。
- **注意**：模型不知道自己被哪个账号调用（让两号各自「回复账号尾号」，都答「我没有账号」），
  故**无法从回答内容区分是哪个号出的流**——只能靠扣费记录与 `accountId` 落库区分。

### 15.3 实测暴露并修复的 5 个缺陷

| # | 缺陷 | 后果 | 修法 |
|---|------|------|------|
| 1 | `uid` 解析把 `yid` 当候选 | `yid` 实测是 `urs-phoneyd.<hash>@163.com`（**邮箱形态**）。`userId` 缺失时退化成邮箱字符串 → 号池去重 `find(a => a.uid === uid)` 失效、同一账号被判成不同号、反复登录生成重复行，`credit_first` 排序也把邮箱当余额主体 | 抽出 `resolveLobsterUid()`：只用 `userId`/`id`/`uid`，**显式排除含 `@` 的值**，最后回落 JWT `sub`（同样排除邮箱形态） |
| 2 | 空 `uid` 照样落库 | 去重查找恒不命中 → 同一账号反复登录生成重复行（实测踩到：授权码被重复消费时 `exchange` 返回 200 但 `user` 为空，脏记录就这样进了号池） | `saveLobsterAccount` 在 `uid` 为空时返回 `ok:false` 拒绝落库；调用方如实报错，不再显示「登录成功」而号池里什么都没有 |
| 3 | token 未校验非空 | `String(undefined)` 得到字面量 `"undefined"`（**truthy**），能穿过 `if (... && token)` 判定 | 改为 `typeof token === "string" && token.trim()` |
| 4 | 晚到的回调被丢弃 | 回环会话 3 分钟超时，但用户登录慢、回调晚到——而授权码**仍然有效**（实测晚到数分钟仍能成功 `exchange`）。旧实现因「无活动会话」或「state 与当前会话不符」直接丢弃，用户白跑一趟 | 新增**已签发 state 宽限表**（30min TTL）：只接受本进程生成过的 state（128 位随机，不可猜），CSRF 防护不削弱；新增 `submitLobsterCallback()` 供无活动会话时补交；兑换成功即作废该 state |
| 5 | 补交路径漏跑「刷新余额 + 自动签到」 | `submitCallbackUrl` 不经过 `beginOAuth` 的 `onDone`，新入池账号停在 `credits=0` / `creditsAt=0`，被 `credit_first` 策略误判为最末位 | IPC handler 在 `ok:true` 且带 `id` 时补跑 `refreshAccount` + `checkinBatch`，与 `onDone` 路径行为对齐，并广播 `oauth-done` |

**修复后自测**：新增 3 项防回归断言（T20 uid 解析 / T21 空 uid 拒绝 / T22 state 宽限表），
自测总数 **26 项全通过**。

### 15.4 一个安全设计说明：宽限表为什么不削弱 CSRF 防护

宽限表放宽的是「必须**正在**进行的会话」，收紧的是「必须是**本进程生成过的** state」：

| 攻击向量 | 是否可被利用 |
|---------|-------------|
| 攻击者构造自己的 state 注入授权码 | ❌ 不可——state 是 128 位随机值，不在宽限表内一律拒绝 |
| 攻击者拿到用户浏览器里的回调 URL 重放 | ❌ 不可——授权码一次性，且兑换成功即作废 state |
| 用户在别的站被诱导登录后回调到本机 | ❌ 不可——`redirect_uri` 是回环地址，且 state 必须匹配本进程签发值 |
| 30 分钟后重放旧 state | ❌ 不可——TTL 过期即清理 |

> 宽限表**只在进程内存**，重启即失效——这是有意的：跨进程持久化会让「已用过的 state」
> 长期存活，反而扩大重放面。代价是「重启后再补交旧回调」不可用，但那种场景下授权码
> 基本也已过期，不值得为它扩大攻击面。

---

## 16. tool_calls 回路实测（2026-10-05 补测）

### 16.1 为什么补测：此前勾选是错的

§13 待办里曾把「tool_calls 回路」勾为已完成——**那是误记**。实际当时只验证到
「模型发起了 `tool_calls`」（响应里出现工具调用帧），**没有验证回路**（把工具执行结果
喂回后模型能否正确使用）。两者是不同的事：前者只证明上游会吐 `tool_calls` 帧，
后者才证明多轮工具编排可用（coding agent 的硬需求）。

### 16.2 实测结果（真实账号，glm-5.3-flash）

| 场景 | 过程 | 结果 |
|------|------|------|
| **基础回路** | 第 1 轮发起 `get_weather({"city":"北京"})`（分 6 个流式片段到达，合并后参数完整）→ 喂回 `{weather:"晴",temp_c:22}` → 第 2 轮 | ✅ 模型正确使用：正文含「天气状况：晴」「温度：22°C」 |
| **并行多工具** | 一次发起 2 个调用（`get_weather(北京)` + `get_time(Asia/Tokyo)`）→ 两条 `tool` 消息一起喂回 | ✅ 两个结果都被使用（正文同时含「多云 18°C」与「15:30」） |
| **工具报错** | 喂回 `{error:"CITY_NOT_FOUND"}` | ✅ 错误被正确消费，模型如实说明查不到并给出替代信息（未中断、未伪造数据） |

### 16.3 关键实现事实

- **`tool_calls` 是流式分片到达的**：实测一次调用被切成 **6 个片段**，`arguments`
  按片段累积拼接。客户端必须按 `index` 聚合，不能只取第一片（AgentHub 侧为纯透传，
  由下游客户端聚合）。
- **`tool` 消息需要 `tool_call_id`**：回路的第 2 轮消息序列为
  `user → assistant(tool_calls) → tool(tool_call_id)`。实测该序列被上游正确接受。
- **入口 role 归一已覆盖**：`util.normalizeRoles` 会把 legacy `function` 归一为 `tool`
  （带 `tool_call_id` 时）或 `user`（仅 `name` 时）。实测 LobsterAI 上游**拒绝**
  裸 `function` role，故这一步是必需的前置（详见 §14 ③）。

> **方法论教训**：把「部分验证」记成「已完成」比不验证更危险——它会让人以为该能力
> 已被覆盖，从而在后续改动中不再关注。这次是靠使用者追问才发现的。**勾选待办前
> 应确认验证的是「完整链路」而非「其中一个环节」。**

---

## 17. 合并前复核修订（2026-10-05）

合并前的独立复核（本地实测 + 代码交叉核对）确认方案与实现一致，另修订三处：

1. **回调补交的副作用收口到 lobster**（`index.cjs`）：`proxy_oauth_submit_callback` 原先对
   「任何渠道只要返回 `id`」都补跑余额刷新 + 自动签到 + `oauth-done` 事件。但 raccoon 与
   zcode 的 `submit` 内部本就调 `finishOAuth`（已触发一遍同款副作用），补交时会执行第二遍
   （重复余额请求 / 重复签到（撞 `checkinBusy`）/ 重复事件）。现限定 `channel === "lobster"`
   ——只有龙虾的「晚到回调」路径才真的绕过 `onDone`。
2. **`checkin` 的「看不到活动」改判不开放**（`adapters.cjs`）：版本门禁导致 `slotState=empty`
   时原返回 `ok:false`，号池页对 `ok:false` 一律显示红色「失败」；已对齐 trae 的既有约定
   改回 `ok:true + unavailable`，界面显示黄色「不开放」。文案同时改成「已自动取线上版本号，
   仍为空请稍后重试」（实现本就是动态取版本，不存在让用户手动核对版本号的必要）。
3. **`ideSwitchStatus` 的 `lobsterInstalled` 注释更正**：该字段是信息性上报（前端对 lobster
   的 `ideSupported()` 直接返回 false，不参与 OAuth 入口的可达性判断），原注释把它描述成
   「否则登录入口会被禁用」，与实现不符。README 同步补上本渠道的登录形态与签到说明。

验证：`tools/proxy-lobster-selftest.cjs` 27/27（含 LIVE 6 项：动态版本号 2026.9.23、
活动 `daily-check-in-evergreen-prod-20260814` 每日 100 积分、`0.1.0` 被门禁隐藏、端点 401 存活）、
`tools/proxy-smoke.cjs` SMOKE OK、`tools/proxy-failover-selftest.cjs` OK。
