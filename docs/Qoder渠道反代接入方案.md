# Qoder 渠道反代接入方案（2026-10-04）

> 状态：**方案定稿，探针验证中**。本方案基于 2026-10-04 对 Qoder CN / Qoder International 0.4.3（commit e921dfbf）的完整逆向与本机实测，全部关键结论均有实证。适用 AgentHub v1.42.0。

---

## 0. 结论速览

**Qoder 具备完整反代可行性**，四条渠道准入判据全部实测通过：

| # | 判据 | 结论 | 关键证据 |
|---|------|------|----------|
| 1 | 协议可代理 | ✅ | SSE 响应内层即标准 OpenAI `chat.completion.chunk`（含 usage、[DONE]），端到端实测出流 |
| 2 | 凭据可脱离持有 | ✅ | auth.v1.dat 经 DPAPI+AES-GCM 解密出 `{token, refreshToken, uid}`；签名材料可本地派生 |
| 3 | 可自助续期 | ✅ | `POST /api/v1/deviceToken/refresh` 实测轮换成功（refresh_token 轮换制） |
| 4 | 用量可计量 | ✅ | `GET /api/v2/quota/usage` 纯 Bearer 实测（userQuota+addOnQuota）；响应内 usage.credits 精确 1e-16 |

与 WorkBuddy 的形态差异（决定工程量）：
- WB：静态出站头组 + 纯 OpenAI 上游，适配器薄；
- Qoder：**每请求 WASM 签名（20 头）+ Encode=1 编码体**，签名器需随 AgentHub 分发，签名下沉进 `chat()`。

> **v2 增补（2026-10-04 交叉审查）**：对照 `docs/raccoon-反代/会话5-6` 的方案标准后，补充了原稿缺失的**号池运营层**——关联信号矩阵、调用节奏、池级熔断、健康度巡检、集中刷新调度、分阶段路线、适配器伪代码、证据索引与安全审计，见 §13-§16。核心结论：Qoder 无受信设备绑定/心跳机制，machine_id 实测不校验——**唯一硬关联锚点是出口 IP**，反关联工程量显著低于 raccoon。

风险边界见 §10。

---

## 1. 背景与准入判定

### 1.1 目标对象
- **Qoder CN**（`gateway.qoder.com.cn`，阿里云运营）：本机 0.4.3 已装已登录
- **Qoder International**（`api2-v2.qoder.sh`，BRIGHT ZENITH 运营）：本机已卸载，凭据已留存
- 两版同一份代码（同 commit），仅 productId/appId/环境表不同；账号与额度池互不相通 → **作为两个渠道接入**（对齐 workbuddy / workbuddy_ai 双区先例）

### 1.2 与 inkstone 的对照（准入判据的由来）
渠道准入不看「模型跑在谁家云上」，只看「AgentHub 能否独立持有并运营该上游凭据」：协议可代理 / 凭据可脱离 / 可自助续期 / 可计量。inkstone 四条全不中（DPAPI 绑机、SSO 一次性、无私有协议推理面、无计量）；Qoder 四条全中且已端到端实测。

---

## 2. 协议栈（全部实测）

### 2.1 凭据链
```
%APPDATA%\com.qoder[.cn].app.stable\
  ├─ Local State           → os_crypt.encrypted_key（base64，剥 "DPAPI" 5B 后 CryptUnprotectData CurrentUser → 32B AES-256 key）
  └─ auth.v1.dat           → "v10" + nonce(12B) + ciphertext+tag(16B)，AES-256-GCM 解密
      → { schemaVersion:1, token:"dt-…"(30天), refreshToken:"drt-…"(1年),
          expiresAt, refreshTokenExpiresAt, user:{id(=uid), name, email, phone, avatarUrl} }
```
- `dt-` 设备令牌**本身就是 Bearer access_token**（`buildUserInfoFromDeviceToken`：security_oauth_token = access_token = token）
- 解密脚本：`tmp-re/decrypt-v10.cjs`（Node aes-256-gcm）

### 2.2 续期（判据 3）
```
POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
Content-Type: application/json      （无需签名头）
{ "refresh_token": "drt-…", "machine_id": "<~/.qoder-cn/.auth/machine_id>" }
→ { device_token, refresh_token, token_type, expires_at, refresh_token_expires_at, created_at }
```
- 实测成功；**refresh_token 轮换制**（旧的立即失效）→ 刷新后必须双 token 同步落库
- 响应 `expires_at` = 新 token 30 天后；`refresh_token_expires_at` ≈ 1 年

### 2.3 签名链（核心工程件）
签名器是 **qoder_auth_wasm_bg.wasm**（298,606 B，wasm 导出 34 个），以 base64 内嵌于
`app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`
（dAi 工厂，`AGFzbQ` 起始，398,144 b64 字符）。

**提取方案（已实现，见 `electron/backend/proxy/qoderSigner.cjs`）**：不 vendor 厂商产物，改为**运行时从本机安装提取**，两条路径（补丁产物对上层暴露同一套 `initGlue()` / `glue()` API）：
1. **0.4.x 截断路径**：在 worker 入口 `SY(),Bir(` 处**截断**（不截断会启动 worker 主循环挂住，实测 60s 超时）；追加 `export{t9 as initGlue,Hm as glue}`；
2. **通用路径**（0.3.x 等入口标记不存在的版本，实测 0.3.3 INTL）：混淆变量名随版本变化，故不认名字认结构——按 wasm-bindgen 稳定特征现取变量名（内嵌 wasm 的 `"AGFzbQ…` base64 与其懒加载器、`er(<容器>,{…QoderContext:()=>…})` 胶水容器、`ProfileEncryptor` 实现类的 `=class` 前定位胶水懒加载器），追加补丁触发懒加载并导出 `initGlue()` / `glue()`（内部用内嵌 base64 走 async init，wasm 二次 init 为 no-op）；产物 20 头 + Encode=1 体齐备；
3. 写入 `%APPDATA%\AgentHub\proxy\qoder-signer\worker-<渠道>-<obf hash>.mjs` 缓存（**先查缓存再读 33MB 原件**），动态 import；
4. `initGlue()` 后 `glue()` 返回 **17 个公开 API**（wasm 的 34 个导出含 `__wbg_*_free`/`__wbindgen_*` 等内部符号，不对外）。

胶水为**标准 wasm-bindgen 产物**（31 个 import 全部来自 `./qoder_auth_wasm_bg.js` 内建集），因此截断+追加导出即可，无需重写 ABI。缓存键 = obf size+mtime+版本，客户端升级自动重建并清理旧缓存。

**运行时开销**：缓存模块 31.7 MB（Node 解析约 1s），仅首次使用 qoder 渠道时惰性加载。P1 优化方向：收窄为「胶水区段 + wasm base64」约 10KB 切片（边界已定位：import 表 `EAi` @3468036、辅助函数簇 @3470789–3472144、类定义 `qnA`/`khe` @3475600+）。

调用链（全部在 Node 实测跑通）：
```js
// 1) 从真 token 派生签名材料（这就是 "Signature invalid" 的缺环所在）
runtime = JSON.parse(g.generate_runtime_auth_fields(JSON.stringify({
  uid, security_oauth_token: token, organization_id: "", organization_tags: [], data_policy_agreed: true
})))  // → { encrypt_user_info, key }

// 2) 构造上下文（organization_tags 必须是数组——Rust serde 校验）
userAuth = { uid, encrypt_user_info: runtime.encrypt_user_info, key: runtime.key,
             organization_id: "", organization_tags: [], data_policy_agreed: true }
ctx = new g.QoderContext(machineId, "0.4.3", JSON.stringify(userAuth), "{}")
ctx.refreshAuthFields(JSON.stringify(userAuth))

// 3) 签名+编码：arg1=origin 字符串，arg2=请求体 JSON，arg3=modelKey，arg4=source
r = ctx.prepareInferRequest("https://gateway.qoder.com.cn", bodyJson, "dfmodel", "system")
// → RequestResult { url, headers(Map,20项), body(Uint8Array, Encode=1 编码) }
```

**⚠️ Authorization 不是原始 token——是每请求现签的 `COSY.*` 密文信封**（自测实证，长度约 513）：
```
Authorization: Bearer COSY.<base64(payload)>.<32 字节二进制签名>
payload = { version:"v1", requestId:"<uuid>", info:"<加密载荷>" }
```
- **适配器必须原样透传该头**，绝不能自作主张拼 `Bearer dt-…`（裸 token 会被拒）；
- payload 含 `requestId` 且每次签名都不同 → **不存在可缓存的静态令牌**，每请求现签；
- 签名与请求体**强绑定**（体改一字节签名即变）→ 这是重放被 `code 103 Duplicate request` 拒绝的根因，也意味着**重试必须重新签名**（换新 request_id）。

20 个签名头：`Accept, Authorization(COSY.* 信封), Cache-Control, Connection, Content-Type,
Cosy-Business-Product, Cosy-Business-Type, Cosy-ClientType, Cosy-Data-Policy, Cosy-Date,
Cosy-Key, Cosy-MachineId, Cosy-MachineToken, Cosy-MachineType, Cosy-Scene, Cosy-User,
Cosy-Version, Login-Version, X-Model-Key, X-Model-Source`（Cosy-* 为灵码血统头组）。

**clientInfo 可传空对象**：wasm 内置默认值，仍产出完整 Cosy-* 头（`ClientType:5`、`Business-Product:cli`、`Business-Type:agent`、`Scene:assistant`）。

WASM 同模块还提供：`decrypt_server_response`（响应解密）、`credential_storage_encrypt/decrypt`、
`model_cache_encrypt/decrypt`（目录缓存）、`get_httpdns_account_id/secret`、`ProfileEncryptor`、
`generate_runtime_auth_fields`。

### 2.4 推理端点
```
POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
Headers: 上述 20 个签名头
Body:    Encode=1 自定义编码（由 WASM 产出，不可自行构造），明文结构：
{
  session_id, source_session_id: "", request_id, request_set_id,
  model_config: { key, display_name, model:"", format:"openai", is_vl, is_reasoning,
                  api_key:"", url:"", source:"system", max_input_tokens },
  messages: [{ role, content: [{type:"text", text}] }],
  tools: [], business: {}
}
Response: SSE（text/event-stream），每帧 data:{"headers":{…},"body":"<内层JSON>","statusCode":"OK"}
内层 = 标准 OpenAI chat.completion.chunk：
  { choices:[{delta:{reasoning_content|content},index}], created, id, model:"auto",
    object:"chat.completion.chunk", system_fingerprint }
末帧含 finish_reason:"stop" + usage{billable, completion_tokens, completion_tokens_details.reasoning_tokens,
  credits, original_credits, prompt_tokens, prompt_tokens_details.cached_tokens, total_tokens}
收尾帧 body:"[DONE]"（在 body 字段内，非裸 SSE 层）
```
- 伪 session_id/request_id 直接可用，无需预注册会话
- **model_config.key 决定路由**：dfmodel(DeepSeek-Flash) 与 gfmodel(GLM-5.3-Flash) 均实测出流，
  响应 id 格式随上游变化（UUID vs GLM 时间戳），路由确证
- 请求体是 WASM 编码的，**签名请求不可手工构造**；工程上把内层 JSON 交给 WASM 即可

### 2.5 计量 API（判据 4）
```
GET https://gateway.qoder.com.cn/api/v2/quota/usage?requestId=<uuid>
Authorization: Bearer <token>          （无需签名）
→ { userId, userType:"personal_professional_trial", usageType:"credits",
    userQuota:{total:300, used:1, remaining:299, unit:"credits"},
    addOnQuota:{total:100, used:0, …}, expiresAt, upgradeUrl }
```
- 扣减顺序：免费额度 > 资源包 > 节省计划 > 按量付费（FIFO 最早到期优先）
- 每日 100 Credits（Add-on）：桌面端手动领取（10:00 窗口），30 天有效期
- `used:1` 与转录 credits（0.9825）对账吻合

### 2.6 模型目录（14 模型，已解密）
解密：`g.model_cache_decrypt(文件utf8文本, uid)` → JSON（按场景分组 chat/quest/inline/qwork/…）。
产物：`catalog-CN.json` / `catalog-INTL.json`。

| key | 模型 | price_factor | 上下文 | 备注 |
|-----|------|-------------|--------|------|
| qfmodel | Qwen3.8-Flash | **0（免费）** | 180K | 原价 0.1 |
| qmodel_38max | Qwen3.8-Max | 0.5 | 180K | is_free；错峰 22:00-08:00 4 折 |
| qmodel | Qwen3.7-Plus | 0.1 | 180K | 错峰 4 折 |
| q37fmodel | Qwen3.7-Flash | 0.1 | 180K | |
| qmodel_latest | Qwen3.7-Max | 0.5 | 180K | |
| dfmodel | DeepSeek-Flash | 0.1 | 180K | ✅ 实测 |
| dmodel | DeepSeek-V4-Pro | 0.5 | 96K | |
| gfmodel | GLM-5.3-Flash | 0.1 | **1M** | ✅ 实测 |
| gmodel | GLM-5.3 | 0.8 | 180K | |
| gm51model | GLM-5.2 | 0.6 | 180K | |
| kmodel | Kimi-K2.8-Preview | 0.8 | 180K | |
| kmodel_latest | Kimi-K3 | 1.4 | 180K | |
| mmodel | MiniMax-M2.7 | 0.2 | 200K | |
| auto | 自动路由 | 0.5 | 200K | 各场景默认 |

各场景（chat/quest/inline/qwork/…）清单略有差异；请求侧场景由签名头 `Cosy-Scene` 决定。

### 2.7 国际版差异
- inferBaseUrl：`api2-v2.qoder.sh`（CN 为 gateway.qoder.com.cn）
- `POST https://api2-v2.qoder.sh/model/v1/chat/completions`（`/model/v1/` 路径）**无签名头直达配额层**
  （CN token → 401 账号域隔离；INTL token → 402 quota exceeded）。若 INTL 账号有额度，
  该路径可能免签名直用（P0-5 探针验证中）
- 每日 100 Credits 活动两版对称（Free/Pro Trial/Pro/Pro+/Ultra 可领；Teams/Enterprise 排除）

---

## 3. AgentHub 契约映射（adapters.cjs 十件套逐项）

| 契约项 | Qoder 实现 | 等级 | 说明 |
|--------|-----------|------|------|
| 渠道注册 | `store.CHANNELS` 加 `{id:"qoder", display:"Qoder CN", domain:"gateway.qoder.com.cn"}`（+ qoder_intl） | 🟢 | agents 表自动种子 |
| `models()` | catalog-CN 14 key 落静态表 | 🟢 | |
| `fetchModels()` | 本地 catalog-v6 解密（`model_cache_decrypt(text, uid)`）→ 整形为 `{id,name,rate:price_factor,capabilities,reasoning,contextLength,maxOutputTokens}` | 🟡 | 远端目录端点待 RE（worker `fetchFromRemote`）；解密失败保留旧目录（先例：拉取失败不写空） |
| `headers()` | **架构偏差**：Qoder 头是每请求 WASM 签名（含 Cosy-Date/绑定 body），不能静态构造。headers() 只返回非签名基础头，签名下沉进 chat() | 🟡 | 与 WB 最大的形状差异 |
| `rewriteBody()` | OpenAI body → QoderInferRequest。细节：content 数组化、system 消息处置、stableConvId→session_id、reasoning_effort→thinking_config.efforts 映射 | 🟡 | |
| `chat()` | 签名→POST→**信封解包**（data:{headers,body,statusCode}）→内层 OpenAI chunk→emit。`model:"auto"` 改写回请求 key；[DONE] 在 body 字段内；错误分类见 §7 | 🟡 | |
| `queryCredits()` | `GET /api/v2/quota/usage?requestId=`（纯 Bearer）。可用额度 = userQuota.remaining + addOnQuota.remaining（FIFO） | 🟢 | 实测通过 |
| `checkin()` | 每日 100 Credits 领取入口在桌面端 UI；claim API 待渲染层 RE（P0-7） | 🔴 | 未 RE 出则 UX 走「去桌面端领取」引导 |
| `refreshToken()` | deviceToken/refresh（§2.2）。**双 token 同时轮换、同时落库**；machine_id 从 accounts.meta 读取 | 🟢 | 实测通过 |
| WASM 签名器 | 随 app resources 分发 wasm（298KB）+ 从 obf 提取的胶水模块；`chat()` 内每请求：derive → ctx → refreshAuthFields → prepareInferRequest | 🔴 | 最大工程件；提取方案见 §4 |

---

## 4. 落地组件清单

```
electron/backend/proxy/
  ├─ adapters.cjs            + qoder 适配器（十件套）+ ADAPTERS 注册
  ├─ qoderSigner.cjs（新）    WASM 加载 + 胶水封装 + 每账号签名缓存
  ├─ qoderAuth.cjs（新）      auth.v1.dat 解密（DPAPI+AES-GCM）、deviceToken/refresh
  ├─ discovery.cjs           + scanQoder()：扫两版 appId 目录，产出候选（含 expiresAt/machineId/productId）
  ├─ store.cjs               + CHANNELS 注册（qoder / qoder_intl）
  ├─ pool.cjs                冷却窗口渠道可配（10:00 领取制 ≠ 次日 4AM）
  └─ rules/headers.json      + qoder 条目（版本常量/origin/端点，热加载）
resources/
  └─ qoder/qoder_auth_wasm_bg.wasm + qoder-glue.mjs（从 obf 提取的 wasm-bindgen 胶水）
src/views/proxy/…            + 渠道名/单位/状态文案特判
src/types/index.ts           + ProxyChannelId 加 "qoder" | "qoder_intl"
tools/proxy-smoke.cjs        + qoder 断言（信封解包/错误分类/目录整形）
docs/Qoder渠道反代接入方案.md（本文）
```

胶水提取方案（三选一，推荐 a）：
- **a) 从 obf 截取胶水区段**为独立 mjs（wasm-bindgen 运行时 + QoderContext/RequestResult 类，边界在 Kt/qnA/khe 一带）——已验证可行（worker-patched.mjs 即截断+追加 export 的原型）
- b) 手写最小胶水（ABI：`__wbindgen_export2/3/4` + 表）
- c) 打包 33MB worker-patched.mjs（❌ 不可接受）

---

## 5. UX 流程设计（对照现有渠道范式）

| 环节 | 设计 | 说明 |
|------|------|------|
| 添加途径 | local / file / paste 三种（无回环 OAuth） | PAT（qoder.com/account/integrations 手建）归入 paste 变体，文案给创建指引 |
| 本机导入向导 | 弹窗即扫描；候选列 productId 标签 + 账号 email + expiresAt(30天) + machineId 摘要 | DPAPI 解密失败给可读原因（常见：AgentHub 与客户端不同 Windows 用户） |
| 导入风险文案 | 「导入后请勿在 Qoder 客户端退出/重登其他账号——refresh_token 轮换会作废号池凭据」 | 对齐 raccoon 强警告先例 |
| 导入后自动动作 | refreshAccount（quota）+ 本地 catalog 解密自动建目录 | 零网络，首次体验优于 WB |
| 模型拉取 | 首版按钮=「从本机读取目录」（本地解密）；远端端点 RE 后改真云端拉取 | 沿用「拉取失败不写空」 |
| 模型列表 | display_name 映射（dfmodel→DeepSeek-Flash）+ price_factor 倍率列 + is_free 标记 + 三档上下文 | contextLength 取最大档，默认档进说明 |
| 签到/领取 | claim API RE 成功→一键领取（挂 checkinBatch，含抖动）；否则「去 Qoder 桌面端用量面板领取」引导（WB AI 特判模式） | checkinAuto 定时对 qoder 视 claim 而定 |
| relogin 文案 | 「请在本机 Qoder 客户端重新登录后，回号池页『从本机软件导入』刷新凭据」 | Qoder 无回环 OAuth，不能照抄 WB |
| 额度展示 | userQuota（套餐）与 addOnQuota（每日领取）分层展示 + expiresAt | credits_history 日快照沿用 |

---

## 6. 持久化

| 项 | 设计 |
|----|------|
| accounts.meta | `{machineId, uid, productId}` 随包 PoolSync 走；machineId 非加密物，无需 zcode 式 unseal/seal，直接透传 |
| accounts.expires_at | **扫描/导入/refresh 三处都写**——PoolSync 凭据仲裁（Validity First）完全依赖它；qoder 无 JWT exp 可现算 |
| usage_requests | 建议在线迁移加 `credits REAL` 列（qoder 每请求 credits 精确计量落库；WB credit 同样受益）。schema 声明 INTEGER 但 affinity 宽容存 REAL，展示/聚合核对无取整 |
| rules/catalog.json | `{qoder:{syncedAt, models:[…]}}`；解密失败保留旧目录 |
| 冷却窗口 | exhausted「次日 4AM」对 qoder 不适用——渠道可配置（10:00 领取制 + 30 天 FIFO） |
| WASM 产物 | 随 app resources 分发，不进 proxyDir/备份包 |
| TEMP 清理 | 调试解密凭据（%TEMP%\qoder_auth_*.json、AES key）接入完成后删除 |

---

## 7. 通信层适配

| 层 | 结论 |
|----|------|
| 入线 | 零改动：Express /v1/chat/completions（SSE 双态）+ /v1/models，渠道无关 |
| 出线 body | Buffer（Encode=1 编码）透传 fetch 支持；Content-Type 用签名头里的 application/json |
| **redirect** | `fetchStream` 硬编码 `redirect:"follow"` 会破坏签名（30x 后签名头落到新地址）→ 改为按渠道可配，qoder 传 `"error"`（qoder 客户端自身即如此） |
| **代理** | Node fetch 不走系统代理——CN gateway 国内直连实测通；INTL api2-v2 需「无代理直连」探针，若不通则 fetchStream 需按渠道可选 ProxyAgent |
| 流中错误 | 信封 200+内部错误→解包后按 WB 模式构造：内层 code116/quota→planLimit；HTTP 401→relogin |
| **新分类「版本漂移」** | 信封 403+code101 Signature invalid：非账号故障、非 WAF、重试无用 → 零冷却 + 渠道级告警「客户端已升级，请更新适配器」+ 引导改 headers.json 版本常量 |
| TTFT | 实测 450-700ms，默认 30s 首字节预算充裕 |
| DNS/TLS | httpdns 非必需（系统 DNS 直连实测通，双 IP failover 可选增强）；gateway 未做 TLS 指纹强校验（当前，列为监控项） |

---

## 8. 外围功能面（反代之外，第六轮全库扫描新发现）

| 面 | 现状 | Qoder 动作 |
|----|------|-----------|
| 记忆中枢 Agent 注入 | `memory/agents.cjs` ADAPTERS 有 zcode/codex/workbuddy/… | **缺 qoder**：查 Qoder CLI 文档确定 MCP 配置路径（cli/mcp-servers）+ AGENTS.md（~/.qoder），加适配器；config-schema options 加 qoder |
| 记忆会话导入 | import engine 源清单 | 加 ~/.qoder(-cn)/projects jsonl（与 sync 同源；cwd 反解同款编码，parser 待确认兼容） |
| 技能仓库 | TOOL_REGISTRY 已注册 `{suggestId:"qoder", hitPaths:[".qoder/skills"]}` | ⚠️ 0.4.3 实测该目录不存在——核实 Qoder 技能真实落盘位置后修 hitPaths |
| deviceId 回退链 | sync.cjs 按适配器注册表顺序 | 追加 qoder installation_id（非必需） |
| 前端类型/映射 | ProxyChannelId / channelName / 额度单位 / agentLabel / ideStatus | 逐一加 qoder；额度单位=Credits |
| ToS 免责名单 | ConfigGeneralSection 点名第三方平台 | 追加 Qoder/千问系 |
| CC Switch / IPC / main | 渠道无关 | 零改动 |

---

## 9. 探针清单（P0 → P2）

| # | 优先级 | 探针 | 方法 | 状态 |
|---|--------|------|------|------|
| P0-1 | P0 | 同机多账号互斥（登录 B 是否吊销 A） | 双账号实测：A 登录→导入→切 B→导入→切回 A→双向回测 | ✅ **无互斥**：两账号 quota/refresh/推理三项全部正常，见 §9.4 |
| P0-2 | P0 | machine_id 绑定强度 | 伪 machineId 构造 ctx 发 infer；refresh 换 machine_id | ✅ infer 与 refresh 均不绑 machine_id（见 9.1） |
| P0-3 | P0 | tool_calls 回路 | 带 1 个工具 + 强制调用 prompt 走全链 | ✅ OpenAI tool_calls 格式全链透传 |
| P0-4 | P0 | 401/无效 token 形态 | 垃圾 token 打 quota + infer | ✅ 两种 401 形态已捕获（见 9.1） |
| P0-5 | P0 | INTL 免费模型裸 Bearer | api2-v2/model/v1 + intl token + qfmodel（price 0） | ⚠️ 部分结论：免签名过鉴权层，卡配额门（INTL 账号无 credits） |
| P0-7 | P0 | claim API 渲染层 RE | grep CN asar renderer gift/claim/activity | ✅ **已解出并落地**：早前"渲染层无端点"是**关键词错误**（活动系统叫 campaign，不是 gift/claim）。真实契约见 §9.3，已实现自动领取 |
| P0-8 | P0 | expiresAt 口径对齐 | refresh expires_at vs quota expiresAt 换算比对 | ✅ 双时钟确认（见 9.1） |
| P1-1 | P1 | fetchFromRemote 端点 | worker obf 内提取 catalog 远端 URL | ✅ 端点确认：`/api/v2/model/list?Encode=1`（须走 WASM 编码通道，裸 GET 503 实证） |
| P1-2 | P1 | 版本漂移敏感度 | Cosy-Version 0.4.2/9.9.9 试阈值 | ✅ **宽容**：新旧版本串均 PASS，风险降级（此前 Signature invalid 实为 runtime fields 缺失） |
| P1-3 | P1 | Cosy-Scene 枚举 | 签名头实测 | ✅ assistant（chat 场景默认值）；其余场景随 catalog 分组待接 |
| P1-4 | P1 | 限流错误码 | qoder 版 4008 等价物 | ✅ **静态逆向闭环**（见 §9.3）：客户端退避算法已提取；平台分类器认 429+Retry-After，适配器无需特判 |
| P2-1 | P2 | Encode=0 明文通道 | prepareRequest（6 参）分工探测 | ⏳ 低优先（Encode=1 通道已可用；不采用明文通道亦为指纹考虑） |
| P2-2 | P2 | 真实 sg() clientInfo | 签名头实测 | ✅ WASM 内置默认 client 信息——空 clientJson 仍产出完整 Cosy 头，保真度问题消解 |
| P2-3 | P2 | 多轮缓存命中 | 多轮历史后 cached_tokens | ✅ **大前缀命中确认**（见 §9.3）：76.8k token 前缀第二轮 cached_tokens=76672，**命中率 99.8%、成本降 45 倍** |
| P2-4 | P2 | Cosy-Date 重放窗口 | 同签名延迟重试 | ✅ 签名仍有效，重放被 request_id 去重（code 103）→ 重试必须换新 request_id |
| P2-5 | P2 | gateway 30x 行为 | http/伪路径探测 | ✅ http→**301 https**（实证会重定向，redirect:"error" 建议成立）；未知路径 503（WAF 层） |
| P2-6 | P2 | 长推理流间隔 | qmodel_38max 长推理实测 | ✅ maxGap=1181ms，300s 空闲预算充裕 |

**探针总账（截至第三轮）**：17 项中 **14 项闭环**、2 项低优先待办（P0-1 需桌面端人工配合；P2-1 Encode=0 通道不采用）、1 项部分结论（P0-5，因 INTL 已暂停启用而搁置）。

> P0-1（多账号互斥）与登出标记探测需要桌面端人工配合，单列。

### 9.1 探针结果（2026-10-04 实测）

**P0-2 machine_id 绑定强度：不绑定。**
- infer：伪造 machineId（全零 UUID）构造 ctx 签名发送 → 200 正常出流（60KB）；
- refresh：INTL 域用伪造 machine_id 调 deviceToken/refresh → 200 接受。
- 结论：machine_id 只是风控指纹/统计字段，**不构成凭据绑定**。号池账号可跨机迁移（PoolSync），可给每账号派生稳定虚拟 machineId（对齐 WB 的 X-Machine-ID 派生先例）。

**P0-3 tool_calls 回路：✅ 打通。**
- 带 OpenAI function 定义（get_weather）+ 强制调用 prompt → SSE 流中出现标准 `tool_calls` 帧（`sawTool=true`，14KB）。
- 结论：coding agent 硬需求满足，工具调用无需额外转换。

**P0-4 401/无效 token 形态：两种形态已捕获。**
- quota/usage：HTTP 401 `{"code":"TOKEN_EXPIRE","message":"token is not active"}`
- INTL model/v1：HTTP 401 `{"error":"unauthorized"}`
- 映射：任何 401 → pool 的 relogin 状态。注意 CN gateway 对 infer 的错误走 SSE 信封（200 包 403），**不能只看 HTTP 状态码**。

**P0-5 INTL 裸 Bearer：部分结论。**
- INTL catalog 含 qfmodel（price_factor 0）；`api2-v2.qoder.sh/model/v1/chat/completions` 携带有效 INTL token（无任何签名头）→ **穿过鉴权层**，卡在配额门（HTTP 402 `{"code":116,"error":"quota exceeded"}`——INTL 账号无 credits）。
- 无效 token 对照组 → 401，证明鉴权在配额之前且**不依赖签名头**。若 INTL 账号领到 credits，裸 Bearer 推理大概率直通（待 INTL 桌面端领取后复测）。

**P0-7 claim API：负结果。**
- CN 渲染层 80 个大文件全文扫描，无 gift/claim/welfare/activity 端点，亦无 /api/ credit 类端点。
- 结论：每日领取入口为服务端下发的活动页（webview 形态），无静态可复用 API → 签到 UX 采用「去桌面端领取」引导；定时签到对 qoder 不生效（UI 需说明）。

**P0-8 expiresAt 双时钟：确认。**
- `quota.expiresAt = 2026-10-18`（试用积分包到期，14 天）
- `refresh.expires_at = 2026-11-03`（设备令牌 30 天）
- 落库规则：`accounts.expires_at` 存 **token 到期**（供临期预刷新与 PoolSync 仲裁）；credits 到期从 quota API 实时取，仅展示。

**P2-4 Cosy-Date 重放：签名长期有效，但 request_id 去重。**
- 同一签名请求 45 秒后原样重放 → HTTP 200 但返回 `{"code":"103","message":"Duplicate request"}`（165B 信封）。
- 签名本身未过期（未报 Signature invalid）；服务端按 request_id 去重。
- 工程含义：网络失败重试必须**换新 request_id 并重新签名**——适配器每次尝试现场签名天然满足；绝不缓存重放同一签名请求。

**附带发现：refresh_token 轮换有宽限。** 同一代 drt- 在轮换后被再次使用仍返回 200（本轮 STEP1 与早前实验各刷一次均成功），且旧 access token 在轮换后依然有效（402 而非 401）——对「AgentHub 与桌面端双持凭据」的共存是利好。（此处原先附加的"建议冷账号原则"已由 §9.4 双账号实测推翻，不再需要。）探针后已将最新凭据对加密写回两版桌面端 auth.v1.dat（roundtrip 校验通过），桌面端无感续用。

### 9.2 第二轮探针（2026-10-04，P1/P2 补测）

**P1-2 版本漂移：宽容，风险降级。** Cosy-Version=0.4.2（旧）与 9.9.9（未来）签名均通过推理（12-13KB 出流）。此前判断「版本漂移=硬风险」不成立——真正导致 Signature invalid 的是 runtime fields 缺失，不是版本号。版本漂移分类保留为监控项（上游收紧时才触发），`headers.json` 版本常量机制照留。

**P1-1 目录端点确认。** obf 内常量 `_5A="/api/v2/model/list?Encode=1"`、`uuc=6`（=catalog-v6 版本号）、120s 超时、100000 缓存上限。裸 GET 返回 503 的根因：该端点要求 Encode=1 编码请求体（WASM 通道）。落地时 fetchModels 走签名器同一通道即可。

**P2-5 网关重定向实证。** `http://gateway.qoder.com.cn/…` → **301 `HTTPS://gateway.qoder.com.cn:443/…`**（协议升级重定向真实存在）；未知路径与根路径 → 503（WAF 层拦截，无重定向）。结论：`redirect:"error"` 建议成立——签名请求被 301 后签名必然失效，不如直接报错。

**P2-6 长推理流间隔。** qmodel_38max 长推理（is_reasoning:true）实测 300KB 流，**最大帧间隔 1181ms**——思考增量也是流式帧，不存在长时间静默，300s 空闲预算充裕。

**P2-3 多轮与缓存。** 两轮对话正常（prompt_tokens 38→61，历史被正确计入）；`cached_tokens` 字段存在但两轮均为 0——小上下文（<200 tokens）未触发前缀缓存。大前缀命中率（WB 实测 34k token 前缀可命中）需实现期用真实长会话验证，不影响接入。

**探针总账**：16 项中 13 项闭环、1 项部分结论（P0-5 待 INTL credits）、2 项需人工/谨慎（P0-1 多账号互斥、P1-4 限流码）。未发现任何推翻「四判据全中」的反证；所有新证据均指向工程可行性进一步提升（machine_id 不绑定、版本宽容、流式健康）。

### 9.3 第三轮探针（2026-10-04：P1-4 限流语义 / P2-3 大前缀缓存 / P0-7 claim 补正）

**P1-4 限流语义：静态逆向闭环（零风控暴露）。** 先前因"避免自有账号风控暴露"故意不触发限流，改为纯静态提取，结论比实测更完整：

客户端退避算法（`N_t`）：
```
retryAfter 存在 → 用它，且 clamp 到 [1s, 60s]
否则          → min(5000 * 2^(failures-1), 10) * (1 - 0.2 + rand * 0.4)
               再 clamp 到 [1000, 10]
```
注意 `h0e=10` **不是 10 秒而是数值 10**（该分支实际几乎不生效，因为 `bHe=1000` 会把结果抬到 1000）；
真正起作用的是 `D_t=5000` 基数与 `k_t=60`（Retry-After 上限 60s）。

可重试判定：`iCe(t) = t===429 || t===502 || t===503 || t===504`。
错误码映射 `_$()`：429→`RATE_LIMITED`、401/403→`AUTH_REJECTED`、≥500→`SERVER_ERROR`、其余→`REQUEST_REJECTED`。
另有 12 个 `QODER_APP_QCS_*` 内部码（含 `RATE_LIMIT_COOLDOWN`）与结构化契约 `{code, message, retryAfterMs, retryable}`。

**落地结论：适配器无需特判。** 平台侧 `server.cjs:classifyUpstream` 已认 `status===429` 并把
`retryAfterMs` 换算为墙钟 `resetMs`（`adapters.cjs` 的 `fetchStream` 已用 `util.parseRetryAfterHeaders`
解析三头族），且有"无明示时间的 429 就地退避重试一次再换号"的逻辑。Qoder 走通用路径即正确。

**顺带发现并修复的真实缺陷（签名安全）**：`adapters.cjs:fetchStream` 原先写死
`fetch(url, { ...rest, signal, redirect: "follow" })`——`redirect` 位于 `...rest` **之后**，
会**覆盖**调用方传入的 `redirect`。Qoder 依赖 `redirect:"error"` 保证签名不被 301 破坏
（P2-5 实测 http→301 https 真实存在，跟随重定向后签名必然失效且报错难懂）。
已改为 `{ redirect: "follow", ...rest, signal }`，允许调用方覆盖。

**P2-3 大前缀缓存：真实命中，命中率 99.8%（本轮重点）。**
用 `tools/proxy-qoder-probe-cache.cjs` 构造 96k 字符（约 76.8k token）固定前缀，连续两轮调
dfmodel（DeepSeek-Flash，rate 0.1）：

| 轮次 | prompt_tokens | cached_tokens | credits |
|---|---|---|---|
| 第 1 轮（冷前缀） | 76844 | **0** | 3.42188 |
| 第 2 轮（同前缀） | 76844 | **76672** | **0.07615** |

**命中率 99.8%，第 2 轮成本降至 1/45。** 这修正了 §9.2 的"cached_tokens 恒为 0"疑虑——
根因是小上下文（<200 token）未达缓存阈值，**功能本身正常**。
工程含义：多轮会话（Agent/编码场景天然带长固定前缀）的实际成本远低于按 prompt_tokens 线性估算；
号池选号与成本预估不应只看 `rate` 倍率，还应考虑前缀复用率。缓存由服务端自动生效，**无需客户端参数**
（无 cache_control 之类标记）。

**P0-7 claim 补正：先前"渲染层无静态端点"是关键词错误。**
活动系统叫 **campaign**，不在 gift/claim/welfare 词族里，导致首轮 grep 漏检。真实契约（已实现自动领取）：

```
① GET  {openApi}/sash/api/v1/me/campaigns      → campaigns[]（含 campaignId/campaignKey/actionType/claimStatus/benefit）
② POST {openApi}/sash/api/v1/me/campaigns/{campaignId}/claim   body={}
     → {grantId, status:"CLAIMED", replayed:bool, benefit:{kind,amount,validity}}
```
三个必须做对的点：路径参数是 **campaignId(UUID)** 而非 campaignKey（用 key → 400 `FIELD_VALIDATION_FAILED`）；
必须带 **Cosy-ClientType** 那组头，否则服务端**静默**返回 `claimable:false`（表现为"今天没有可领活动"，
极易误判）；`Cosy-Machine{Token,Type,Code}` 由客户端自带 `runtime-info.exe --account-stdin` 生成
（**机器级**身份，与账号无关，单次约 3.6s，故按 product 缓存）。

**P2-1 Encode=0 明文通道：通道存在，但我们的封装根本不暴露它（实测确认）。**
wasm 的 `QoderContext.prepareRequest(endpoint, path, method, authMode, body, headers)` 是 6 参，
第 4 参是**认证模式**（`"auth"` / `"sign"`），**不是编码开关**——Encode 由 wasm 内部按 endpoint
固定选择。实测对照：给 `prepareInferRequest` 传 `Encode=0` 与 `Encode=1` 的 URL，
产出的 body **完全相同**（均为 164B 编码态，前缀 `"QwDSQwBM)umYKwmxd..."`），
因为我们的封装签名是 `prepareInferRequest(origin, bodyJson, modelKey, source)`，**没有 Encode 入参**。

故结论：明文通道要走到 it 必须**绕开现有封装直接调 wasm 的 prepareRequest 并自行拼 URL**——
为无功能增益的路径增加代码与维护面，且请求体形态与官方客户端不一致会**增大指纹暴露面**。
维持不采用。此项属"已查清、主动放弃"，非遗留未知。

### 9.4 第四轮探针（2026-10-04：P0-1 多账号互斥 / OAuth 登录可行性）

**P0-1 多账号互斥：无互斥（结论推翻原先的"冷账号"担忧）。**

方法（真实双账号，桌面端人工配合）：
1. 客户端登录账号 A（`账号 A 邮箱`）→ 导入 AgentHub
2. 客户端切到账号 B（`账号 B`）→ 导入 AgentHub
3. 客户端再切回账号 A
4. 对**两个账号同时**回测三项：quota（纯 Bearer）/ refresh（token 轮换）/ 推理（完整签名链）

| 检测项 | 账号 A | 账号 B |
|---|---|---|
| queryCredits | ✅ 495 credits | ✅ 300 credits |
| refreshToken | ✅ 成功轮换 | ✅ 成功轮换 |
| 推理（签名链） | ✅ 200，回复 OK | ✅ 200，回复 OK |

**结论**：登录/切换账号**不会**吊销其它账号的凭据；两个账号的 token 各自独立轮换、互不影响。
号池可安全容纳多账号，**不需要**"冷账号"策略。

这直接推翻本方案早前的两处保守假设：
- §10.3「refresh 轮换会使桌面端持有凭据落后一代 → 建议号池账号保持冷账号」——不成立，
  实测两侧凭据各自有效。
- §13.1 关于"登录 B 可能吊销 A"的关联担忧——不成立。

**副作用与处置**：探针轮换了两个账号的 token，客户端持有的是旧一代。
处置：把最新凭据对（token + refreshToken + 双到期时间）**加密写回当前登录账号的 auth.v1.dat**，
写回后实测 quota 200 / 495 credits，客户端无感续用。注意写回时**必须校验 uid 与当前客户端一致**，
否则会把别的账号写进去（本脚本已实现该守卫）。

**OAuth 弹窗登录：可行，且与 WorkBuddy 形态一致（本轮新增结论）。**

从主进程 `startDeviceFlow()` 逆向出完整的 PKCE 设备码流程：

```
① 生成 PKCE：verifier = 64 位随机串
   challenge = base64url(sha256(verifier))
② 打开登录页：
   https://qoder.cn/users/sign-in?biz_variant=qoder
     &oauth_callback=<device/selectAccounts URL>
   其中 device/selectAccounts URL =
   https://qoder.cn/device/selectAccounts?challenge=<c>&challenge_method=S256
     &nonce=<n>&machine_id=<mid>&client_id=732aef47-9cf2-46a2-95fe-4cebb5d0d1fa
③ 轮询换 token（每 1s，直到拿到凭据）：
   GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll
       ?nonce=<n>&verifier=<v>&challenge_method=S256
   → { token, refresh_token }        # 注意：返回的就是 dt-/drt- 设备凭据对
```

实测可达性：登录页 `HTTP 200`（真实页面）；轮询端点未登录时 `HTTP 404`——
与客户端代码 `d.status===404 → continue` 的分支完全吻合，说明端点语义正确。

客户端常量（CN）：`authBaseUrl=https://qoder.cn`、`authClientIds.prod=732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`、
`authBizVariant=qoder`；支持 `QODER_AUTH_CLIENT_ID` / `QODER_AUTH_REDIRECT_URI` / `QODER_AUTH_BASE_URL`
等环境变量覆盖（对测试环境有用）。

**工程含义**：AgentHub 可以实现「Qoder OAuth 登录」添加方式——弹一个 web 窗打开登录页，
用户在里面完成登录，主进程轮询换到凭据对后直接入库。**无需本机安装客户端**，
这补上了「凭据可独立持有」判据的最后一环（原先只能靠扫描本机 auth.v1.dat）。

### 9.5 第五轮探针（2026-10-04：图片多模态实测 + 顺带修掉一个流解析缺陷）

**图片多模态：上游原生支持 OpenAI 的 `image_url` 形态，实测通过。**

先确认 Qoder 侧的内容部件形态（从 bundle 逆向）：
```js
// O9c：Anthropic 风格 → OpenAI 风格（Qoder 内部就在做这个转换）
{ type:"image_url", image_url:{ url:`data:${media_type};base64,${data}` } }
{ type:"image_url", image_url:{ url } }
// _Zc：OpenAI → 内部
{ type:"input_image", image_url: A.image_url.url, ...(detail ? {detail} : {}) }
```
即**适配器的「原样透传 image_url」是对的**，无需转换。

实测（`tools/proxy-qoder-vision-probe.cjs`，现场生成 64x64 PNG：红底 + 中心白方块）：

| 测试 | 结果 | 判读 |
|---|---|---|
| 纯文本基线 | 200，回复「正常」 | 模型可用 |
| 图片 + 问主体色 | 200，回复「**红**」 | 图片被**真实解码识别** |
| 图片 + `detail:"low"` | 200，回复「**白色**」（问中心色） | `detail` 字段被接受 |
| `mmodel`（目录标 is_vl=false）+ 图片 | 200，详细描述了「纯红背景 + 中央白色正方形」 | **实际支持视觉，目录标注不准** |

`prompt_tokens` 66（纯文本）→ 149（带图），印证图片确实进入上下文。

**结论**：`image_url` 透传正确，data URL 与 `detail` 均可用；目录的 `is_vl` 仅作参考，
不能作为「该模型不能收图」的硬判据（`mmodel` 即反例）。

**顺带发现并修复一个流解析缺陷（非图片专有）**：
上游会在流中间夹一帧 `body:"null"`（**字面量 null，不是空串**）。
`JSON.parse("null")` 得到 `null`，旧代码随即 `chunk.choices` 抛 `TypeError`，
表现为**整条流以内部异常中断**（用户看到的是 "Cannot read properties of null"，
而非可读错误）。该帧无内容，正确做法是跳过。
已加 `if (!chunk || typeof chunk !== "object") return;` 并补 3 条断言锁定。
注：`mmodel` 最初「抛错」正是这个缺陷所致，修复后它正常返回了图片描述。

---

## 10. 风险与风控边界

1. **ToS/风控**：阿里系条款明示「严禁异常方式套取积分，违者回收积分并封号」。设计约束：小号起步、限速、不做高并发轮换；号池价值在续命与容灾，不在压榨。
2. **版本演进**：签名 WASM/端点随客户端版本演进；Cosy-Version 常量化在 headers.json，升级时改配置；建议监控 fast-update 的 build-manifest。
3. **桌面端共存（已由 P0-1 实测澄清，无需冷账号）**：双账号实测证明登录/切换账号不会吊销其它账号的凭据，两账号 token 各自独立轮换。故「AgentHub 与桌面端双持同一账号」也安全——只是每次桌面端刷新会让 AgentHub 持有的那一代落后，反之亦然；两侧都有宽限期（旧 drt- 仍可用一次），且 AgentHub 侧 401 后经 PoolSync 仲裁自愈。**推荐做法**：AgentHub 每次刷新后把最新凭据对写回 `auth.v1.dat`（写回前必须校验 uid 与当前客户端登录账号一致，否则会串号）。
4. **账号域隔离**：CN/INTL 互不通用（401 实证），双渠道独立接入。
5. **额度真实消耗**：推理 billable:true；qfmodel price_factor=0 可扛高频。
6. **合规声明**：逆向仅限本机自有账号的互操作研究；分发 WASM 属厂商混淆产物，发布形态需评估（本地使用 vs 开源分发分开对待）。

---

## 11. v1.42.0 影响评估

v1.41.2 → v1.42.0 单提交（40f7df1）：`listableModels()`（mergedModels 减 disabledModels）仅用于对外 `/v1/models` 与未知模型提示；管理页仍全量。**对本方案零影响**——适配器契约/池/发现/持久化/通信全部未动；且停用模型自动从对外列表隐藏的能力对 Qoder 直接适用（例如停用 1.4 倍率的 kmodel_latest）。`tools/proxy-smoke.cjs` 新增 4 断言——Qoder 适配器 smoke 断言按同一工具追加。

---

## 12. 附录

**逆向产物**（`tmp-re/`，已 git 本地排除）：
`qoder_auth_wasm_bg.wasm` / `worker-patched.mjs`（截断+导出的胶水原型）/ `forge-harness5.mjs`（derive→sign→send→SSE 全链）/ `decrypt-v10.cjs` / `signed5.resp.txt`（完整 SSE 样本）

**上游参考**：
- docs.qoder.com：cli/authentication（PAT）、cli/custom-models（BYOK）、events/100credits、cloud-agents/api/models/list（Cloud API）、account/teams/openapi（组织面，无推理端点）
- 目录缓存：`~/.qoder(-cn)/.models/<uid>/catalog-v6`（UMC 信封，model_cache_decrypt 解）

**凭据安全**：本方案涉及的全部凭据仅限本机自有账号；`tmp-re/` 与 %TEMP% 下的解密产物在接入完成后清理。

---

## 13. 号池运营与反关联设计（v2 增补，对齐 raccoon-反代/会话5-6 的方案标准）

> 交叉审查结论：原方案在协议/契约/探针层完整，但**号池运营层**（反关联、节奏控制、池级熔断、集中刷新、健康度巡检）只有原则没有设计。本节补齐，方法论对齐 `docs/raccoon-反代/会话5-号池风控与反关联.md`。

### 13.1 关联信号矩阵（Qoder 特有，逐项评级）

| # | 信号 | 载体 | 同源可见 | 风险 | 缓解 |
|---|------|------|---------|------|------|
| 1 | **出口 IP** | 全部请求 | 同机必然相同 | **高** | >3 号配代理池，号-IP 一对一绑定 |
| 2 | **Cosy-MachineId / Cosy-MachineToken** | 20 签名头之一，进签名；**值由 wasm 派生而非透传** | 同机默认相同（同一 ctx machineId 派生） | **中高**（实测服务端**不校验** machineId 绑定——伪造 MID infer/refresh 均通过） | 每号固定一个独立 machineId 写入 meta；⚠️ 见下方「machineId 派生行为」注 |
| 3 | **遥测 / tracking / RUM** | `/api/v1/tracking`、`/api/v2/quota/usage` 的 cmcc 参数、RUM(aliyuncs) | 反代**天然不发** | 低（反而是行为差异：官方客户端常驻上报，池号静默） | 接受静默；不要主动补发遥测 |
| 4 | **request_id / traceId 关联** | metadata.context + sw-trace-id | 每请求独立 | 低 | 重试换新 request_id（code103 去重已实证），跨号不复用 |
| 5 | **刷新相位** | deviceToken/refresh | 同机多号同时刻刷新 | 低-中 | 批量刷新加 ±60s 抖动（对齐 raccoon §7.2） |
| 6 | **Cosy-Version / UA** | 签名头 | 同机相同 | 低 | 全号同版本是自然态（官方同版本），**不要错开** |
| 7 | **uid / token** | 每号独立 | 天然隔离 | 无 | — |

> 与 raccoon 的关键差异：raccoon 的硬锚点是 clientDeviceId+IP（服务端设备表主键）；**Qoder 实测无受信设备绑定/心跳机制**（无 bind/heartbeat 端点），machineId 不校验——因此 Qoder 的硬锚点只剩 **出口 IP**。反关联工程量显著低于 raccoon。

#### machineId 派生行为（自测实证，实现层必读）

传入 `QoderContext` 的 machineId **不会原样出现在头里**，wasm 会做一次派生：

| 传入 ctx 的 machineId | 产出的 `Cosy-MachineId` | 说明 |
|---|---|---|
| `~/.qoder-cn/.auth/machine_id`（真实值，形如 `<uuid-a>`） | 另一个 UUID（**派生值**，形如 `<uuid-b>`） | 走官方派生路径（可能掺入 UMID/设备熵） |
| `00000000-…-000000000000`（伪造） | `00000000-…`（**原样**） | 无法派生，回退为原值——**但服务端仍接受** |

推论：
1. 反关联不能简单"每号塞一个随机 MID"——随机值大概率走"原样透传"分支，与官方客户端派生出的值**形态不同**，反而可能成为异常特征（服务端若做熵/形态校验即可识别）。
2. 更稳妥的策略：**每号使用各自的真实 machine_id**（从对应客户端安装扫描获得）。单机多号场景下，若无法为每号准备独立机器，则该信号无法隔离——这正是 §13.2 建议"规模化配代理池/多机采集"的原因。
3. 待验证（P1）：随机 UUID 是否也能被 wasm 正常派生（若派生只依赖输入则任意 UUID 均可，隔离就成立）。当前证据不足以判定，故本表按"不校验但形态敏感"处理。

### 13.2 调用节奏（保守建议值）

| 维度 | 建议值 |
|------|--------|
| 单号 QPS | ≤ 0.5，突发 ≤ 2 |
| 单号并发 | 1（同号不并发多会话） |
| 单号日上限 | 对齐额度（CN 免费号 ≈ 每日 100 + 存量 300 credits），预留 20% 余量 |
| 同 IP 总 QPS | ≤ 2 |
| 间隔抖动 | ±30% 随机 |
| 夜间静默（可选） | 02:00-06:00 降频 |

### 13.3 池级熔断（超出单号冷却的池级动作）

| 条件 | 动作 |
|------|------|
| 同出口 IP 下 ≥50% 号 5min 内连续 429 | 熔断该 IP 出口，切备用，冷却 30min |
| ≥2 个号同时 Signature invalid | **熔断该渠道**——版本漂移告警，更新适配器，绝不逐号冷却 |
| 整池 ≥30% 同时 401 | 池级告警，暂停调用排查批量风控 |

### 13.4 健康度巡检（成本从低到高）

1. **本地 expiresAt 判断**（零成本）：accounts.expires_at 临期 → 触发预刷新（P-3 修复后可用）。
2. **余额探针** `GET /api/v2/quota/usage`（每 30min，纯 Bearer 零签名）：token 存活 + credits 余额 + 积分包到期。
3. **refresh 探针**（每日 1 次）：验证 refresh 链有效（注意轮换写回）。
4. **uid 比对防串号**：refresh/查询返回的 uid 与登记值比对，突变=串号告警（对齐 raccoon sid 自检）。

### 13.5 集中刷新调度（池管理器独占）

- **池管理器是唯一刷新者**：临期（token expiresAt 前 24h）统一预刷新，业务请求永远拿到 ready token；`refreshTokenLocked` 单飞。
- **与桌面端共存（P0-1 实测后已无此顾虑）**：双账号实测证明账号间无互斥，同一账号也可双持。推荐：AgentHub 刷新后把最新凭据对写回 `auth.v1.dat`（写回前校验 uid 一致），桌面端即无感续用；两侧都有宽限期，401 后经 PoolSync 仲裁自愈。
- **元数据绝不写 auth.v1.dat**（桌面端刷新会整体覆盖该文件）——machineId/productId 一律放池索引 meta（对齐 raccoon「Electron 刷新抹掉未知字段」教训）。

---

## 14. 分阶段实施路线

| 阶段 | 目标 | 交付 |
|------|------|------|
| **P0 单号打通** | 一个号反代对话+查余额 | qoderSigner（wasm+胶水）+ 适配器骨架 + 信封解包 + queryCredits；手工导入一个 token 验证 |
| **P1 多号池化** | N 号轮换 + 冷却换号 + 版本漂移分类 | 本机导入向导 + 集中刷新调度 + 错误映射接 pool + 池级熔断 |
| **P2 目录/签到** | 模型目录页 + 领取引导（或 claim API 自动化） | catalog 解密进 ProxyModelsView + 签到 UX + usage credits 列 |
| **P3 反关联加固** | 代理池 + 节奏控制 | 号-IP 绑定 + QPS/并发限制 + 虚拟 machineId 分配 |
| **P4 实测收尾** | 剩余探针 + smoke 断言 | tools/proxy-smoke.cjs qoder 断言 + 记忆中枢适配器 + 文档定稿 |

---

## 15. 适配器核心伪代码

```js
const qoder = {
  id: "qoder",
  cfg: () => rules.get("headers.json").qoder,     // 版本常量/origin/端点（热加载）

  models() { /* catalog-CN 14 key（本地解密 + 静态表并集） */ },

  async fetchModels(account, secrets) {
    // 优先：本地 ~/.qoder(-cn)/.models/<uid>/catalog-v6 解密（model_cache_decrypt）
    // 兜底：静态表；远端端点 RE 后补在线拉取
  },

  // 注意：headers() 仅返回非签名基础头——签名在 chat() 内按账号现场完成
  async chat({ account, secrets, model, body, emit, meta }) {
    const signer = await getSigner(account.meta.machineId, account.uid, secrets.token);
    const req = toQoderInferRequest(model, body, account, meta);   // rewriteBody 产物
    const r = signer.prepareInferRequest(cfg.gateway, JSON.stringify(req), modelKey(model), "system");
    const resp = await fetchStream(r.url, { method: "POST", headers: r.headers,
      body: Buffer.from(r.body), redirect: "error", firstByteMs: firstByteBudgetMs(payload) });
    return pumpSse(resp, (_e, raw) => {
      const env = parseJson(raw); if (!env) return;
      const inner = parseJson(env.body);            // 信封解包
      if (env.statusCode !== "OK") return handleEnvelopeError(env);  // 403/101→版本漂移、402→planLimit…
      if (inner === "[DONE]") return emit({ type: "finish", reason: "" });
      emitOpenAIChunk(inner, { model });            // model:auto 改写回请求 key；usage 透传含 credits
    });
  },

  async queryCredits(account, secrets) {
    // GET /api/v2/quota/usage?requestId= → credits = userQuota.remaining + addOnQuota.remaining
  },

  async refreshToken(account, secrets) {
    // POST openapi…/api/v1/deviceToken/refresh {refresh_token, machine_id: account.meta.machineId}
    // 双 token 同落库 + expires_at 落库；刷新后 uid 比对防串号
  },
};
```

---

## 16. 证据索引与安全审计

**证据索引**（详见记忆库 mem_20261004_* 系列）：凭据链/签名链/推理端点/计量 API/模型目录——均以本机 0.4.3 双版本实测；关键文件：`qoder-worker-runtime.obf.mjs`（33MB，签名 WASM 内嵌于 dAi 工厂）、`auth.v1.dat`+`Local State`（凭据）、`catalog-v6`（模型目录）、`qodercli.log`（运行时端点实证 `agent_chat_generation`）。

**安全审计定性**：Qoder 桌面端为标准 Electron AI IDE（外联域名全部可解释：gateway/openapi/api2/download/center、RUM aliyuncs、HTTPDNS），未发现隐蔽后门。防伪强度**中高**（WASM 签名 + 代码混淆 + Encode=1 编码体 + httpdns），高于 raccoon（无签名）低于 inkstone（全链私有）；本方案已完整破解且留有可复现工件。

**风险与合规**（补强）：本方案仅针对**用户自有账号**的本地互操作；勿对池子对外提供付费服务（二次分发风险更高）；多账号批量领取每日积分大概率违反用户协议，最坏封号——号池规模与风控暴露成正比，文档须随包声明。

---

## 17. 合并前复核修订（v1.43.0）

社区 PR 审核阶段对本方案做了四处加固，均已落地（代码即事实源，本节只记动因）：

1. **安装定位从单路径改为多候选**（新增 `qoderInstall.cjs`，qoderAuth 与 qoderSigner 共用）：
   原实现硬编码 `%LOCALAPPDATA%\Programs\<exeLabel>\resources`，在两种真实安装形态上会失明——
   ① 客户端自带启动器（launcher）形态：应用本体在 `<installDir>\.qoder-versions\<ver>\`，
   启动器信息在 `%LOCALAPPDATA%\<exeLabel>\<...>Launcher\state.ini`（UTF-16LE，`installDir` + `appExecutable` 两字段）；
   ② 自定义安装路径（注册表 Uninstall 项的 `DisplayIcon` / `InstallLocation`）。
   现按「环境变量覆盖 → 默认路径 → 解包直装 → launcher 版本目录 → 注册表」依次尝到命中为止，
   且 CN 与 INTL 的目录/注册表项按产品名严格区分（两套并行安装不会互相命中）；失败不缓存（装完客户端无需重启）。
2. **SDK 目录名按实测放宽**：0.3.3 INTL 客户端为 `qoder-agent-sdk`（无 `-cn` 后缀），与 0.4.x CN 的
   `qoder-cn-agent-sdk` 相反——改为两候选都试，不按产品名硬编码。
3. **INTL 渠道启用**：原实现 `QODER_INTL_ENABLED = false`（理由：免费额度不含 DeepSeek/GLM Flash + 依赖 INTL 客户端）。
   复核时本机实测形态恰为「INTL 客户端已装、CN 客户端已卸载」，且 0.3.3 INTL 的签名链已用通用提取路径跑通
   （20 头 + Encode=1 体），故改为启用；界面提示仍保留「需订阅覆盖才有可用模型」的说明。
4. **Credits 浮点口径贯通**：queryCredits 返回两位小数、前端 fmtCredits 也按浮点显示，
   但 store 落库（updateAccount / snapshotCredits）原为 `Math.round` 取整——小额消耗会在余额里消失。
   现落库保留两位小数（整数渠道不受影响）；号池页与总览页的余额 tooltip、单位标签同步补上 Credits。

另修三处小问题：测试脚本「签名实测对象」改为**已安装 + 有凭据**的渠道（凭据存在 ≠ 客户端已安装，
CN 卸载后凭据仍在，原逻辑在该形态下直接失败）；`qoderAdapter.chat` 的 HTTP 层异常补 `session.free()`
（原实现只在流读取的 finally 释放，请求失败会漏放 wasm 会话）；`agents.cjs` 关于双区目录的注释
（CN=`~/.qoder-cn`、INTL=`~/.qoder`，与用量同步模块一致；反代渠道 id 命名相反，`qoder`=CN）。
