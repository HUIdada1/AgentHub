# ModelScope（魔搭）渠道反代接入方案（2026-10-06）

> 分支：`feat/modelscope-channel`（仅本地，未推送）
> 参考体例：`docs/LobsterAI渠道反代接入方案.md`、`docs/Qoder渠道反代接入方案.md`

---

## 0. 结论速览

| 项 | 结论 |
|----|------|
| 渠道类型 | **首个「官方公开 API」型渠道**——非逆向、无客户端、无签名 |
| 鉴权 | **OAuth 2.0 + OIDC（主，含授权窗顺带采集 Web Cookie）** / 用户自建 ms- 令牌（兜底） |
| 对话面 | `https://api-inference.modelscope.cn/v1/chat/completions`（原生 OpenAI 兼容） |
| 每日额度 | **日活 200 + 绑云 50 + 点赞 40**（短期魔粒 **24 小时**有效，非「每日重置」） |
| 计费分档 | 交易记录带 `model_tier`：**standard=1 魔粒/次、ultra=2 魔粒/次** |
| 前置门槛 | **需绑定阿里云账号 + 完成实名认证**（未绑定 → 401；仅绑定未实名 → 403） |
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
| ⑤ 每日额度 | ✅ | 日活 200 + 绑云 50（短期 24h 有效）+ 点赞 40 可争取 |

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

**⚠️ 魔粒有效期（官方文档「三、注意事项」原文，纠正「每日重置」的误解）**：

> - **短期魔粒**：生效时长 **24 小时**
> - **长期魔粒**：生效时长 **90 天**
> - 过期时间从发放时刻开始统计。两种魔粒在消耗时等价，系统将**自动优先扣减最临近过期的魔粒**。

| 类型 | 时长 | 覆盖哪些任务 |
|------|------|-------------|
| **短期** | **24 小时** | `daily_active` 200、`aliyun_bindlogin` 50、`interaction_like` 2×20、`interaction_comment` 5×2、AIGC 发布 10×10 |
| **长期** | **90 天** | 邀请好友 20/人、模型（AIGC）影响力 50/次 |

**这纠正了一个常见误解**：不存在「平台每天发 250 魔粒额度、零点重置」这回事。真实机制是
**每天可以重新赚取一次**（各任务的「每日上限」按日刷新），而赚到的**短期魔粒 24 小时后自行过期**。

由此推出三条对本渠道有实际影响的结论：

1. **签到要按时跑**：短期魔粒 24 小时失效，漏一天就少一天的量；自动签到默认 09:00 正是为此
2. **攒着不用会浪费**：短期魔粒无法结转，且系统优先扣减最临近过期的（无法干预）
3. **余额是「滚动值」**：账面余额 = Σ(未过期的 EARN) − Σ(SPEND)，因此**数值下降不代表签到失败**，
   可能只是早先赚的那批过期了——判定签到成败必须看**交易记录新增**，不能只看余额涨跌

> 实测对账（2026-10-06，两账号，核算完全吻合）：
>
> | 账号 | EARN 明细 | SPEND | 余额 |
> |------|----------|-------|------|
> | 账号 A | 点赞 40 + 邮箱 50 + 资料 50 + 绑云 50 + 日活 200 = **390** | −51（推理 24 次） | **339** |
> | 账号 B | 点赞 40 + 绑云 50 + 日活 200 = **290** | −2（推理 1 次） | **288** |

### 2.7 前置门槛：绑定阿里云 + **实名认证**（两道，缺一不可）

未绑定阿里云账号时，**清单接口可用但推理调用一律 401**：

```json
{"error":{"message":"Please bind your Alibaba Cloud account before use."}}
```

> ⚠️ **2026-10-06 双账号实测补充：绑定之后还有第二道门槛——实名认证。**
> 仅绑定而未实名的账号，推理返回 **403**：
>
> ```json
> {"error":{"message":"To use API-Inference, please make sure your associated Aliyun account is real-name verified. You can do so at your account setting page https://www.modelscope.cn/my/accountsettings."}}
> ```

实测对照（同一时刻、两个真实账号）：

| 账号 | OAuth 凭据 | `/oauth/userinfo` | `/magicubes/balance` | `/v1/chat/completions` |
|------|-----------|------------------|---------------------|----------------------|
| A（已实名） | ✅ 475 字符 | ✅ 200 | ✅ 311 魔粒 | ✅ **200 正常出流** |
| B（仅绑定未实名） | ✅ 475 字符 | ✅ **200** | ✅ **250 魔粒** | ❌ **403 需实名认证** |

**关键判读**：两账号的**凭据、身份、余额全部正常**，只有推理被拒 —— 证明接入链路完好，
被拒是上游的账号资质门槛。B 完成实名后立即转为 200（实测复验通过）。

实现上：
- 粘贴令牌入池时探测余额端点，命中 401 则**如实提示但不阻断入池**（用户可先入池、后去绑定）
- **推理 403 单独归类**并给出可操作指引（`accountsettings` 链接），不混成通用 502
  —— 与「未绑定阿里云」同为**账号侧可自行修复**的前置条件，值得独立提示
  （自测 T22 锁定该行为；⚠️ 403 由 `fetchStream` 抛出而非 SSE 帧，判定必须放在抛错路径上，
  放在 SSE pump 里永远走不到）

---

### 2.8 Cookie 双凭据设计（方案 A1，本渠道最关键的结构决策）

**问题起点**：用户期望「OAuth 登录后就全通」（其它渠道都是这样）。实测却发现魔搭做不到——
OAuth 令牌**能推理、不能点赞、不计日活**。

#### 2.8.1 端点分族：两族严格互斥（实测确立）

| 端点族 | 代表端点 | OAuth 令牌 | ms- 令牌 | **Cookie** |
|--------|---------|-----------|---------|-----------|
| 推理族 | `/v1/chat/completions` | ✅ | ✅ | ✅ |
| 魔粒族 | `/openapi/v1/magicubes/*` | ✅ | ✅ | ✅ |
| 身份族 | `/openapi/v1/users/me`、`/oauth/userinfo` | ✅ | ✅ | ✅ |
| **星标族** | `/api/v1/mcpServers/*/stars` | ❌ **401** | ✅ | ✅ |
| **令牌管理族** | `/api/v1/users/tokens*` | ❌ **401** | ✅ | — |

OAuth 令牌被拒时的响应体明确指认原因：

```json
{"Code":10010101003,"Message":"oauth token is not supported by this endpoint","Success":false}
```

**四条绕过路径全部实证失败**（穷尽验证，不要重复尝试）：

| # | 尝试 | 结果 |
|---|------|------|
| ① | 点赞端点仅发 `Authorization`（去掉 `OpenAPI-Token`/`X-Modelfun-Token`） | ❌ 一样 401 |
| ② | 在 `/openapi/v1` 族找 MCP/互动替代端点（7 个候选） | ❌ 全 404 |
| ③ | OAuth scope 扩到全部 6 个已知项 | ⚠️ 被接受，但**不含任何 `/api/v1` 权限** |
| ④ | 动态注册声明 `extra_permissions` / `client_id_metadata` / `allowed_scopes` | ❌ 服务端忽略（回显默认 scope） |

#### 2.8.2 为什么 ms- 令牌也不够：Bearer 不计日活

参考实现 `xxy9468615/cat_checkin`（`scripts/modelscope.py`）的源码注释（2026-08-25 修复）实测记录：

> 凭证优先级：**Cookie 优先，Token 回退**。
> 实测 Bearer Token 虽能通过 OpenAPI 鉴权，但 OpenAPI 调用不计入「日活」，
> `daily_active` 每日魔粒不会发放；只有 Web 会话（Cookie）活动才触发奖励。

它的 `_touch_user` 正是为此设计：有 Cookie 时先访问 6 个 Web 页面，再补两个
**登录事件端点**（`/api/v1/users/login/info`、`/api/v1/users/authorized/check`，
HAR 抓包确认前端每次页面加载都会调），最后才用 Bearer 触碰 openapi 端点。

**⇒ Cookie 是唯一同时覆盖「点赞」与「日活」的凭据。**

#### 2.8.3 AgentHub 的做法：授权窗顺带采集（用户零额外操作）

关键洞察：**OAuth 授权时，浏览器/授权窗已经与魔搭建立了 Web 会话**——那些 Cookie 就在窗口的
cookie jar 里，直接读走即可，用户仍然只需点一次「授权」。

```
用户点「打开授权页」
  ↓
应用内授权窗（独立 partition）打开 /oauth/authorize
  ↓ 用户点「授权」
回环回调收到 code
  ↓
① 读授权窗 partition 的 cookie jar（整组拼接，2591 字符 / 30 项）
② POST /oauth/token 换 OAuth 令牌（30 天 + refresh 轮换）
  ↓
双凭据落库：OAuth 令牌 → token_enc；Cookie → meta.msCookie（DPAPI 加密）
```

**可行性验证实测**（`tools/probe-modelscope-cookie.cjs`，受控窗口）：

| 验证点 | 结果 |
|--------|------|
| Cookie 捕获 | ✅ 31 个（4 个魔搭域，含 `m_session_id`/`csrf_token`/`_tb_token_`） |
| `GET /api/v1/users/login/info` | ✅ 200（日活触发端点） |
| `PUT /api/v1/dolphins…`（列目标） | ✅ 200 |
| `PUT /api/v1/mcpServers/{}/stars` | ✅ **200 点赞成功**（Stars=756） |

**端到端实测（2026-10-06 两账号，交易记录为铁证）**：

| 账号 | Cookie 采集 | 点赞 | 余额构成 |
|------|-----------|------|---------|
| 账号 A | ✅ 2591 字符 / 30 项 | ✅ **20/20，+40** | EARN 390 − SPEND 51 = **339** |
| 账号 B | ✅ 2537 字符 / 30 项 | ✅ **20/20，+40** | EARN 290 − SPEND 2 = **288** |

> `EARN interaction_like +40 count=20` 正是 OAuth 令牌做不到、只有 Cookie 才能完成的部分。

#### 2.8.4 实现要点与坑

| 要点 | 说明 |
|------|------|
| **必须整组 Cookie** | 魔搭登录态由多个 cookie 共同构成（`cookie2`/`_tb_token_`/`m_session_id`/`csrf_token`），只挑一个会失效 |
| 授权窗须**应用内** | 系统浏览器拿不到 partition 的 cookie jar；无窗口能力时降级回系统浏览器（仍得 OAuth 令牌，仅缺点赞/日活） |
| Cookie **加密落库** | 经 `config.encryptSecret`（DPAPI）存 `meta.msCookie`；`store.accountSecrets` 解密后透传适配器 |
| 未采到新 Cookie **保留旧值** | 避免一次失败的采集把可用会话清空 |
| Cookie 失效**要能识别** | 401/403 或未登录文案 → `needReauth`，提示用户重新授权 |
| ⚠️ 探针脚本**不可共用 userData** | 初版误用 `%APPDATA%\agenthub`，与运行中主进程争抢 `lockfile`/`Cookies`/`Local Storage` → 弹出一连串 Electron 锁冲突错误窗口（功能仍成功，因 Cookie 走独立 partition） |

#### 2.8.5 凭据分层（最终形态）

| 能力 | 凭据 | 理由 |
|------|------|------|
| 推理 `/v1/chat` | OAuth 令牌 | 该族两种凭据均可；OAuth 有 30 天自动续期 |
| 魔粒余额/规则 | OAuth 令牌 | 同上 |
| **点赞** `/api/v1/mcpServers/*` | **Cookie**（回退 ms- 令牌） | OAuth 令牌被上游 401 拒绝 |
| **每日登录奖励** | **Cookie + webTouch** | Bearer 调用不计日活，必须走真实 Web 请求 |
| 令牌管理 | ms- 令牌 | OAuth 令牌被拒 |

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
| `checkin()` | **Cookie 触碰 Web 会话（触发 daily_active）** + 按 `today_used` 补做剩余点赞（Cookie 星标族）+ 复核 | 🟡 | **核心新增**；幂等 + 安全阀 |
| `checkinStatus()` | 读 `earn/rules`（**纯只读，零副作用**） | 🟢 | 与 checkin 严格分离 |
| `refreshToken()` | refresh_token grant（**依赖注入**，避免循环依赖） | 🟡 | 一次性轮换，需回写新值 |
| `trial()` | 明确返回不可用 | 🟢 | |
| OAuth | `discovery.beginModelScopeOAuth`：**动态注册 + 回环回调 + 应用内窗口采集 Cookie** | 🟡 | 见 §2.1、§2.8 |
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
| 前置提示 | 探测余额端点，401 提示「需先绑定阿里云账号」；推理 403 区分「未绑定」与「未实名」并给 accountsettings 链接 | 不阻断入池 |
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
- **Cookie 通道**（§2.8）：星标族与日活触碰走 httpJson 带 Cookie 头；无 Cookie 时自动回退 ms- 令牌

---

## 8. 自测清单（tools/proxy-modelscope-selftest.cjs）

### 离线 19 项（不联网，CI/空环境可全绿）

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
| T22 | **403 前置门槛识别**（未实名/未绑云 → 可操作提示；含「判定必须在 fetchStream 抛错路径上」断言） |
| T23 | **双账号共存前提**（uid 取 userinfo.sub、按 uid 查重落库、凭据独立） |
| T24 | **Cookie 通道**（星标族用 starHeaders 而非 apiHeaders、日活靠 webTouch 触碰登录事件端点、无凭据时如实提示、失效提示重新授权） |
| T25 | **Cookie 采集链路**（授权窗 collectCookie 整组拼接、DPAPI 加密落库、未采到保留旧值、accountSecrets 解密透传） |

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

**实测结果：25 passed, 0 failed。**

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
| 号池级并发调度 | 双账号各自独立推理已验证；但**多号并发压测**未做（credit_first 排序在双号下的表现未观察） |
| 组织权限 scope | `read-repos` 等组织级授权未探索（本渠道不需要） |
| `model_tier` 完整档位表 | 只实测到 standard=1 / ultra=2；其余模型档位未逐个确认 |

### 待办

- [x] **双账号共存实测**（2026-10-06，见 §13）
- [x] asar 补丁试用（1.45.1 与 1.46.0 各打过一次，均验证通过）
- [ ] 可选：补 `proxy-smoke.cjs` 的 modelscope 断言块
- [ ] 可选：提上游 PR（需先确认动态注册的合规边界）
- [ ] 可选：OAuth 路径的「晚到回调补救」（参照 LobsterAI 的宽限表设计）

---

## 13. 双账号共存实测（2026-10-06）

**背景**：LobsterAI 的官方客户端只有**单登录槽**（换号会顶掉旧号），故其多账号必须靠 AgentHub 的
OAuth 池实现。ModelScope 本就无客户端，多账号是否天然友好需要实测。

### 13.1 实测结果

两个账号均经 **OAuth 动态注册路径**入池，各自独立完成全链路：

| 账号 | uid | 凭据 | 推理 | TTFT | 思考链 | usage | 余额 |
|------|-----|------|------|------|--------|-------|------|
| 账号 A | `msub_REDACTED…` | `ms_oauth` 475 字符 + 独立 refresh/clientId | ✅ 200 | 1365ms | 138 字 | 35/42/77 | 309 魔粒 |
| 账号 B | `msub_REDACTED…` | 同上（各自独立） | ✅ 200 | 1157ms | 50 字 | 35/30/65 | 248 魔粒 |

**结论**：双账号可共存、各自独立推理与计费，无「单登录槽」限制。

### 13.2 过程中发现的两个问题

**① 实名认证门槛（新发现，已写入 §2.7）**

首次实测时 B 推理 403，错误为「associated Aliyun account is real-name verified」。
两账号的 userinfo/balance 都 200 —— 证明接入链路完好，被拒纯属账号资质。
B 完成实名后立即转为 200。

**② 403 错误分类的落点错误（已修）**

初版把 403 判定放在 SSE pump 回调里 —— 但 **403 是非 2xx，由 `fetchStream` 直接抛出，
SSE pump 根本不会执行**，该分支永远走不到。已改到 `fetchStream` 的 catch 路径上，
并区分「未绑定」与「未实名」两种可操作提示（自测 T22 锁定）。

### 13.3 Cookie 方案端到端实测（A1 落地后，交易记录为铁证）

重新以 OAuth 授权（应用内窗口自动采 Cookie）入池两个账号后实测：

| 账号 | Cookie 采集 | 点赞 | 余额核算 |
|------|-----------|------|---------|
| 账号 A | ✅ 2591 字符 / 30 项 | ✅ **20/20，+40** | EARN 390 − SPEND 51 = **339** |
| 账号 B | ✅ 2537 字符 / 30 项 | ✅ **20/20，+40** | EARN 290 − SPEND 2 = **288** |

两个账号的今日交易均含 `EARN interaction_like +40 count=20`——这正是 OAuth 令牌做不到、
只有 Cookie 才能完成的部分；`EARN daily_active +200` 已领也证明 webTouch 的日活触碰生效。

**注意**：手动点「一键签到」时若显示「点赞今日已满 / 余额 Δ0」，**不代表失败**——
授权完成时 onDone 里的自动签到已把 20 次点赞做完。判定签到成败要看**交易记录新增**，
不能只看余额涨跌（短期魔粒 24 小时过期，余额是滚动值，见 §2.6）。

### 13.4 一个反证：usage 相同说明被路由转走

调试早期，对三个模型分别调用时拿到的 usage **完全相同**（12/4/16）——不同模型家族的分词器
不应给出同一组数字。查 `usage_requests` 证实：请求被记在 `raccoon` 渠道且带
`fallback→deepseek-v4.1-flash` 标记，即 **modelscope 号池当时无账号，auto 路由回退到了别处**。

**教训**：「调用成功」不等于「走的是你以为的渠道」。判定渠道归属要看 `usage_requests.channel`，
不能只看响应 200。双账号直连后 usage 各不相同（77 vs 65），恰好反证各自走了自己的凭据。

---

## 14. 合并前复核修订

（待 PR 阶段填写）
