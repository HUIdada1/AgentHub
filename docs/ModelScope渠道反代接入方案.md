# ModelScope（魔搭）渠道反代接入方案（2026-10-06）

> 分支：`feat/modelscope-channel`（仅本地，未推送）
> 参考体例：`docs/LobsterAI渠道反代接入方案.md`、`docs/Qoder渠道反代接入方案.md`

---

## 0. 结论速览

| 项 | 结论 |
|----|------|
| 渠道类型 | **首个「官方公开 API」型渠道**——非逆向、无客户端、无签名 |
| 鉴权 | **OAuth 2.0 + OIDC（主）** / 用户自建 ms- 令牌（兜底） |
| 对话面 | `https://api-inference.modelscope.cn/v1/chat/completions`（原生 OpenAI 兼容） |
| 每日额度 | **250 魔粒/日**（登录 200 + 绑云 50，自动发放）+ 点赞 40（20×2，需执行） |
| 计费分档 | 交易记录带 `model_tier`：**standard=1 魔粒/次、ultra=2 魔粒/次** |
| 前置门槛 | **需绑定阿里云账号**才能调用推理（未绑定 → 401 `Please bind your Alibaba Cloud account`） |
| 可自助续期 | ✅ access_token 30 天 + refresh_token 轮换 |
| 主要风险 | 官方公开服务，额度规则可能调整；点赞是**对外可见**动作 |

---

## 1. 背景与准入判定

### 1.1 目标对象

ModelScope（魔搭社区，阿里）的 **API-Inference** 服务：把社区开源模型标准化为可调用的 OpenAI 兼容 API。
与已接入的 8 个渠道相比，它是唯一**官方公开、无需逆向**的渠道：

| 维度 | 其它渠道（Trae/WorkBuddy/Lobster/Qoder…） | ModelScope |
|------|------------------------------------------|-----------|
| 协议来源 | 逆向客户端或网页 | **官方文档公开** |
| 客户端依赖 | 多数需要 | **完全不需要** |
| 签名/指纹 | 多数需要 | **无** |
| 凭据 | OAuth / 本机导入 / 复杂信封 | **OAuth 或静态令牌** |

### 1.2 五条准入判据（沿用 LobsterAI/Qoder 的判据体系）

| 判据 | 满足 | 证据 |
|------|------|------|
| ① 协议可代理 | ✅ | 原生 OpenAI `/v1/chat/completions`，实测 stream / tool_calls / reasoning_content 全支持 |
| ② 凭据可脱离客户端 | ✅ | OAuth 或用户自建令牌；**本机无任何客户端登录态可依赖**（实测未装 SDK/CLI） |
| ③ 可自助续期 | ✅ | OIDC 元数据声明 `authorization_code` + `refresh_token`；实测续期成功 |
| ④ 可计量 | ⚠️ 部分 | 有余额端点（魔粒）与交易明细；**无可编程用量接口**（`/v1/usage`、`/v1/quota` 均 404） |
| ⑤ 每日额度 | ✅ | 250 魔粒/日自动发放 + 40 可争取（点赞） |

---

## 2. 协议栈（全部实测）

### 2.1 凭据链（双轨设计）

```
主路径 OAuth 2.0 + OIDC：
  POST /oauth/register            ← 动态注册（RFC 7591），只需 client_name + redirect_uris
    ↓ 得 client_id / client_secret
  GET  /oauth/authorize?...       ← 用户点「授权」
    ↓ 回环回调 http://127.0.0.1:<port>/oauth/callback?code=…&state=…
  POST /oauth/token               ← client_secret_post 表单换令牌
    ↓ access_token（ms_oauth…，30 天）+ refresh_token
  GET  /oauth/userinfo            ← 取 sub 作 uid、nickname 作展示名

兜底路径 用户自建访问令牌：
  用户在 modelscope.cn/my/myaccesstoken 新建 ms- 令牌 → 粘贴
    ↓
  GET  /openapi/v1/users/me       ← 校验令牌有效性 + 取 username 作 uid
```

**关键实测约束**（每一条都对应一个实现决策）：

| # | 事实 | 实现要求 |
|---|------|---------|
| ① | `POST /oauth/register` **无需鉴权**即可注册 | AgentHub 可全自动注册，用户零操作（只需点一次授权） |
| ② | access_token 前缀 `ms_oauth`、475 字符、`expires_in=2592000`（30 天） | 与自建令牌（`ms-`、39 字符）**形态不同**，落库需区分 |
| ③ | refresh_token **一次性轮换**（旧的重放 → `invalid_grant`） | 续期成功后**必须立即持久化新 refresh** |
| ④ | **OAuth 错误以 HTTP 200 + `body.error` 返回** | 判成败必须查 `body.error`，绝不能只看状态码 |
| ⑤ | 无 PKCE（`code_challenge_methods` 未声明） | 必须用 `client_secret_post`/`basic`；Secret 由本机持有 |

> ④ 是本渠道最容易踩的坑：实现初版用 `status === 200` 判成功，把 `invalid_grant` 误报为「续期成功」。

### 2.2 续期（判据 3）

- access_token 30 天；refresh_token 一次性轮换
- 续期端点：`POST /oauth/token`，`grant_type=refresh_token`
- 实现要点：**续期成功 → 立即写回新 refresh**（见 `saveModelScopeAccount` 的 meta 合并）

### 2.3 对话端点

| 项 | 值 |
|----|-----|
| URL | `https://api-inference.modelscope.cn/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <token>` |
| 协议 | 原生 OpenAI Chat Completions（SSE） |
| 模型 id | 形如 `deepseek-ai/DeepSeek-V4.1-Flash`（**含斜杠，大小写敏感**） |

**两个实测发现的陷阱**：

1. **`usage` 恒为 0**：上游每个 delta 帧都带 `usage:{prompt_tokens:0,…}` 占位，且**必须显式请求
   `stream_options.include_usage=true` 才发最终真实帧**。不带则真实帧永不出现——表现为
   「对话完全正常但 token 统计全 0」。修复：`rewriteBody` 对流式注入该字段；`chat` 只在
   usage 有真实数值时 emit。
2. **delta 空壳污染**：上游 delta 带 `role:null` / `tool_calls:null` / `function_calls:null`，
   直接透传给下游客户端。修复：剥掉纯 null 字段（保留空串 `content` 作结束标记）。

### 2.4 计量 API（判据 4）

| 端点 | 用途 |
|------|------|
| `GET /openapi/v1/magicubes/balance` | 魔粒余额（`data.total_balance`） |
| `GET /openapi/v1/magicubes/earn/rules` | **任务规则表（28 条）**：rule_key / amount / daily_cap / today_used / today_remain |
| `GET /openapi/v1/magicubes/transactions` | 交易明细（含 `model_tier`，可对账与判定扣费档位） |

**鉴权要求**：三头同发 + 浏览器上下文，缺一不可（实测只带 Authorization 会被风控中间件静默忽略）：

```
Authorization: Bearer <token>
OpenAPI-Token: <token>
X-Modelfun-Token: <token>
User-Agent / Origin / Referer  ← 必须
```

> ⚠️ **无逐请求用量接口**（`/v1/usage`、`/v1/quota` 均 404）→ 额度只能靠交易明细对账或本地计数。

### 2.5 模型目录（清单 ≠ 全集）

- 上游清单：`GET https://api-inference.modelscope.cn/v1/models`（需 Bearer）→ **35 个模型**
- ⚠️ **清单按社区热度精选，不是全集**：`ZhipuAI/GLM-5.3-Flash` **不在清单内但直调 200**
- 故静态目录显式收录它，并以**直调**而非清单作为可用性判据
- 这是本项目第三次踩「清单 ≠ 全集」：raccoon 的 `sn-` 前缀、qoder 的 `gfmodel/dfmodel` key 名

### 2.6 每日任务（判据 5，核心新增能力）

**魔粒体系**（官方文档 `magicube/intro` 权威定义 + 实测对账）：

| rule_key | 标题 | 奖励 | 每日上限 | 触发 |
|----------|------|------|---------|------|
| `daily_active` | 注册并登录 | **+200** | 1 | 活跃会话（自动） |
| `aliyun_bindlogin` | 绑定阿里云账号 | **+50** | 1 | 自动 |
| `interaction_like` | 收藏/喜欢 | **+2/次** | **20** | **需主动 PUT 星标** |
| `interaction_comment` | 高质量讨论 | +5 | 2 | 需他人点赞（难自动化） |
| `badge_magicube_shortterm` | 勋章 | +20 | 1 | 条件未明 |
| `opensource_aigcworks_publish` | 发布 AIGC 作品 | +10 | 10 | 需内容产出 |
| `infocomplement_*` | 信息完善（邮箱/简介/主页） | +50 各 | 一次性 | 手动 |

**点赞接口**（`interaction_like` 的实现）：

```
列目标：PUT /api/v1/dolphin/mcpServers   {PageSize:30, PageNumber:1, Query:"", Criterion:[]}
        → Data.McpServer.McpServers[].{Path, Name, AlreadyStar}
点赞  ：PUT /api/v1/mcpServers/{path}/{name}/stars   {}
        → 200 {Code:200, Data:{Stars:N}, Success:true}
```

实测：一次点赞 → 余额 **+2**、交易记录出现 `EARN interaction_like`（秒级到账）。

### 2.7 前置门槛：阿里云账号绑定

未绑定阿里云账号时，**清单接口可用但推理调用一律 401**：

```json
{"error":{"message":"Please bind your Alibaba Cloud account before use."}}
```

实现上：粘贴令牌入池时顺带探测余额端点，命中 401 则**如实提示但不阻断入池**
（用户可先入池、后去绑定）。

---

## 3. AgentHub 契约映射（adapters.cjs 十件套逐项）

| 契约项 | ModelScope 实现 | 等级 | 说明 |
|--------|----------------|------|------|
| 渠道注册 | `store.CHANNELS` 加 `{id:"modelscope", display:"ModelScope（魔搭）", domain:"api-inference.modelscope.cn"}` | 🟢 | 与 `ADAPTERS` 双表同步（红线） |
| `models()` | 静态目录 23 模型（含清单外的 GLM-5.3-Flash） | 🟢 | 可用性以直调为准 |
| `fetchModels()` | `GET /v1/models` → 整形；401 报 authError | 🟢 | 清单仅供展示 |
| `chatHeaders()` | 仅 Bearer（官方网关不需要三头） | 🟢 | 与站点控制面区分 |
| `apiHeaders()` | **三头同发 + 浏览器上下文** | 🟡 | 缺头被风控静默忽略 |
| `rewriteBody()` | `max_completion_tokens→max_tokens`；**流式注入 `stream_options.include_usage`** | 🟡 | usage 恒为 0 的修复点 |
| `chat()` | 原生 OpenAI SSE 透传 + 非对象帧守卫 + **剥 null 空壳** + usage 真值才 emit | 🟡 | 两个实测陷阱 |
| `queryCredits()` | `GET /magicubes/balance` → `total_balance` | 🟢 | |
| `checkin()` | 会话触碰 + 按 `today_used` 补做剩余点赞 + 复核（余额/进度） | 🟡 | **核心新增**；幂等 + 安全阀 |
| `checkinStatus()` | 读 `earn/rules`（**纯只读，零副作用**） | 🟢 | 与 checkin 严格分离 |
| `refreshToken()` | refresh_token grant（**依赖注入**，避免循环依赖） | 🟡 | 一次性轮换，需回写新值 |
| `trial()` | 明确返回不可用 | 🟢 | |
| OAuth | `discovery.beginModelScopeOAuth`：**动态注册 + 回环回调** | 🟡 | 见 §2.1 |
| 令牌导入 | `discovery.importModelScopeToken`：校验 + 取 uid + 绑定门槛探测 | 🟡 | 兜底路径 |
| uid 口径 | OAuth 用 `userinfo.sub`；粘贴用 `users/me.username` | 🟡 | ⚠️ `/api/v1/users/{tokens,detail,current}` 的 `UserName` 是**路径回显**，绝不可用 |

### 3.1 安全设计：状态面与动作面严格分离

点赞是**对外可见的公开动作**（星标会展示在 MCP 服务页与用户动态），故：

| 方法 | 契约 |
|------|------|
| `checkinStatus()` | **纯只读**——绝不产生写入；自测 T8 用源码级断言锁定（体内出现 `likeOne`/`PUT` 即失败） |
| `checkin()` | 唯一执行点赞的入口；幂等（读 `today_used` 只补剩余）；`likeHardCap=25` 安全阀 |

---

## 4. 落地组件清单

```
electron/backend/proxy/
  ├─ rules.cjs       + headers.json.modelscope（对话/鉴权/魔粒三组端点 + 任务规则键 + 安全阀）
  │                  + catalog.json.modelscope（23 模型静态兜底，含清单外的 GLM-5.3-Flash）
  ├─ adapters.cjs    + modelscope 适配器（十件套 + fetchLikeTargets/likeOne）
  │                  + ADAPTERS 注册 + setModelScopeRefresh（续期实现注入点）
  ├─ discovery.cjs   + registerModelScopeApp（动态注册 RFC 7591）
  │                  + beginModelScopeOAuth（回环 + state 校验 + 换令牌 + 落库）
  │                  + exchangeModelScopeCode / refreshModelScopeToken
  │                  + saveModelScopeAccount（双轨共用，空 uid 拒绝落库）
  │                  + importModelScopeToken（粘贴兜底：校验 + uid + 绑定门槛探测）
  ├─ index.cjs       + 启动时注入续期实现（避免循环依赖）
  │                  + proxy_account_add 的 modelscope 分支（专用导入 + 入池即跑每日任务）
  ├─ store.cjs       + CHANNELS 注册
  └─ ideswitch.cjs   + ideSwitchStatus 上报 modelscopeInstalled（渠道在册即 true，无需客户端）
src/
  ├─ types/index.ts     + ProxyChannelId 加 "modelscope"
  ├─ api/ipc.ts         + modelscopeInstalled 字段
  ├─ api/mock.ts        + 演示数据
  └─ views/proxy/
       ├─ format.ts            + CHANNEL_NAMES.modelscope
       ├─ ProxyAgentsView.vue  + CHANNEL_META / OAUTH_HELP（OAuth 主）/ 令牌粘贴页签 / 隐藏 JSON 方式 / 签到提示
       └─ ProxyPoolSyncView.vue + 渠道下拉项
tools/proxy-modelscope-selftest.cjs（新）  21 项断言（15 离线 + 6 联网只读）
tools/probe-modelscope-oauth.cjs（新）     一次性 OAuth 端到端验证探针
docs/ModelScope渠道反代接入方案.md（本文）
```

---

## 5. UX 流程设计

| 环节 | 设计 | 说明 |
|------|------|------|
| 添加途径 | **OAuth 登录（主）/ 粘贴令牌（兜底）** | 隐藏「从本机软件导入」「从 JSON/ZIP 文件」（本机无客户端登录态、凭据非 JSON） |
| OAuth 形态 | **动态注册 + 回环回调**：点「打开登录页」→ 魔搭授权页点「授权」→ 自动入池 | 用户**只需点一次授权**；无需懂 OAuth、无需建应用 |
| 粘贴兜底 | 专用令牌输入框 + 「魔搭访问令牌」页直达链接 | 标签如实改名「粘贴令牌」（非 JSON） |
| 入池前校验 | 先打 `users/me`：401 → 拒绝；200 → 取 `username` 作 uid | 防脏记录入池 |
| 前置提示 | 探测余额端点，401 提示「需先绑定阿里云账号」 | 不阻断入池 |
| 登录后动作 | 刷新余额 + 跑一次每日任务（与 OAuth 路径行为对齐） | 否则新号停在 credits=0 |
| 签到 | 一键执行：会话触碰（保 200+50）+ 点赞补足（+40） | 文案如实说明「点赞是公开星标动作」 |
| relogin 文案 | 「令牌失效，请到魔搭重新生成访问令牌」/「请重新执行 OAuth 登录」 | 不照抄 WB 的「去客户端重登」 |
| 写回本机 | **不支持**（`ideSupported` 返回 false） | 无客户端登录态可写 |

---

## 6. 持久化

- 凭据：`token_enc` / `refresh_enc`（DPAPI 信封，与其它渠道一致）
- OAuth 客户端信息：账号 `meta` 的 `oauthClientId` / `oauthClientSecret`
- 令牌形态：`meta.tokenKind`（`oauth` | `token`）——决定续期路径
- 余额快照：沿用 `credits_history` 日快照（魔粒为浮点）

---

## 7. 通信层适配

- 对话：`fetchStream` + `pumpSse`（与其它渠道共用），首字节预算按 prompt 规模
- 控制面：`httpJson`（三头 + 浏览器上下文）
- **不新增通信原语**——本渠道是唯一「无签名、无特殊编码」的渠道

---

## 8. 自测清单（tools/proxy-modelscope-selftest.cjs）

### 离线 15 项（不联网，CI/空环境可全绿）

| # | 断言 |
|---|------|
| T1 | 双注册一致性（CHANNELS ∩ ADAPTERS 零差异） |
| T2 | 适配器必需接口齐备 |
| T3 | `mapModel` 处理斜杠 id 与简写回退 |
| T4 | 静态目录含清单外的 GLM-5.3-Flash |
| T5 | `rewriteBody` 注入 `stream_options.include_usage`（usage 修复回归） |
| T6 | `apiHeaders` 三头同发 + 浏览器上下文 |
| T7 | rules 配置键齐备 |
| T8 | **状态面/动作面分离**（源码级：checkinStatus 体内无 likeOne/PUT） |
| T9 | `checkin` 幂等（读 today_used + 安全阀） |
| T10 | 非对象帧守卫存在 |
| T16 | OAuth 配置齐备（动态注册/端点/scope） |
| T17 | **OAuth 必须查 body.error**（源码级，防「200 即成功」误判） |
| T18 | refresh 轮换 + 适配器不得 require discovery（循环依赖防线） |
| T19 | 令牌形态判别（ms_oauth vs ms-） |

### LIVE 6 项（联网只读，**绝不调用 checkin**）

| # | 断言 |
|---|------|
| T11 | 魔粒余额 |
| T12 | 任务进度（纯只读） |
| T13 | 上游清单 ≥30 |
| T14 | 点赞目标发现（只读） |
| T15 | 对话出流且 **usage 非 0** |
| T20 | OAuth 动态注册可用 |
| T21 | OIDC 元数据声明 authorization_code + refresh_token |

**实测结果：21 passed, 0 failed。**

---

## 9. 风险与风控边界

| 风险 | 等级 | 说明与对策 |
|------|------|-----------|
| 点赞是对外可见动作 | 🟡 中 | 星标展示在 MCP 服务页；故**只读状态与写动作严格分离**、需显式点签到才执行、有安全阀 |
| 官方公开服务的规则可变 | 🟡 中 | 额度/端点可能调整（官方文档自述 Beta 期）；已实现「清单≠全集」的直调判据与降级提示 |
| 动态注册未被产品文档收录 | 🟡 中 | 属 OIDC 标准能力（元数据公开声明），但产品文档只讲页面创建；若上游收紧，**自动降级到粘贴令牌** |
| 阿里云账号绑定门槛 | 🟢 低 | 如实提示，不阻断入池 |
| 多账号 | 🟢 低 | 本渠道一令牌一账号，粘贴/授权 N 次即 N 个号；无「客户端单登录槽」限制（对比 LobsterAI） |
| 无可编程用量接口 | 🟡 中 | 只能靠交易明细对账或本地计数；已如实记录 |

**合规声明**：本方案仅针对**用户自有账号**的本地互操作；请勿用于批量薅取或对外提供付费中转。

---

## 10. 分阶段实施路线

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 协议侦察：对话/魔粒/任务/清单全部实测 | ✅ 完成 |
| P1 | 适配器十件套 + 双注册 + 前端渠道卡 | ✅ 完成 |
| P2 | 每日任务（会话触碰 + 点赞）实测验证 | ✅ 完成（点赞 +2 即时到账） |
| P3 | OAuth 端到端验证（动态注册 → 授权 → 换令牌 → 调推理 → 续期） | ✅ 完成（7 步全通） |
| P4 | OAuth 落地（discovery + 前端 OAuth 主路径 + 令牌兜底） | ✅ 完成 |
| P5 | 自测 + 全套回归 | ✅ 完成（21/21 + smoke + vue-tsc） |
| P6 | asar 补丁试用 | ⏳ **待用户确认** |
| P7 | 提上游 PR（可选） | ⏳ 待定 |

---

## 11. 证据索引

| 证据 | 位置 |
|------|------|
| OAuth 端到端验证结果（7 步） | `%TEMP%\ms-oauth-result.json` |
| OAuth 令牌复验（调推理/查魔粒/续期） | `%TEMP%\ms-oauth-verify2.json` |
| 一次性验证探针 | `tools/probe-modelscope-oauth.cjs` |
| 官方 OAuth 文档（镜像） | `xiaoqianran/modelscope-docs → docs/pages/accounts/oauth/oauth.md` |
| 官方魔粒体系文档（镜像） | `xiaoqianran/modelscope-docs → docs/pages/magicube/intro/intro.md` |
| OIDC 元数据 | `https://modelscope.cn/.well-known/openid-configuration` |
| 交易明细（计费分档实证） | `GET /openapi/v1/magicubes/transactions` |

---

## 12. 待办与未验证项（如实记录）

### 未验证项

| 项 | 说明 |
|----|------|
| `api-inference` scope 的额度上限 | 未测「OAuth token 与自建令牌是否共享同一魔粒池」——推断共享（同一账号），但未实测 |
| 点赞的长期风控影响 | 仅单次实测；连续 20 次/日是否会触发风控未验证（已加 400-900ms 抖动 + 安全阀） |
| refresh_token 的绝对有效期 | 只知道一次性轮换；未验证「长期不续期是否失效」 |
| 多账号并发 | 未测；本渠道无客户端指纹，多号切换的行为特征比桌面渠道明显 |
| 组织权限 scope | `read-repos` 等组织级授权未探索（本渠道不需要） |
| `model_tier` 完整档位表 | 只实测到 standard=1 / ultra=2；其余模型档位未逐个确认 |

### 待办

- [ ] asar 补丁试用（待用户确认）
- [ ] 可选：补 `proxy-smoke.cjs` 的 modelscope 断言块
- [ ] 可选：提上游 PR（需先确认动态注册的合规边界）
- [ ] 可选：OAuth 路径的「晚到回调补救」（参照 LobsterAI 的宽限表设计）

---

## 13. 合并前复核修订

（待 PR 阶段填写）
