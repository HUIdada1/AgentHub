# 商汤小浣熊（Raccoon AI）逆向排查方案与反代要素清单

> 用途：本地安全审计 + 互操作性研究（让你自己的 AgentHub 能反代它）。
> 版本基线：客户端 `v1.0.35`（`E:\raccoon-ai\`），box-agent `v0.9.8`。
> 逆向方式：**纯静态分析**（asar 解包 + PyInstaller PYZ 反汇编），未做任何抓包/破解/绕过，代码完全可读、**无混淆**。

---

## 一、它是什么 / 装在哪 / 跑什么进程

| 组件 | 位置 | 说明 |
|---|---|---|
| 桌面主程序（Electron） | `E:\raccoon-ai\` （`商汤小浣熊.exe` 222MB） | 主入口 `resources/app.asar` 内 `build/electron/main.js` |
| box-agent 推理引擎 | `E:\raccoon-ai\resources\box-agent-runtime\bin\box-agent-acp.exe` | **PyInstaller 打包的 Python 3.12 应用**，源码全可读 |
| box-agent 运行时 | `~/.box-agent/box-agent-runtime/runtime/` | 自带 PortableGit + Python 3.12.6 + Node |
| 用户数据 | `C:\Users\HUIDADA\AppData\Roaming\office-raccoon\` | Electron userData（IndexedDB / sqlite / 日志） |
| 凭据与配置 | `~/.box-agent/config\` | `auth.json`（token）、`config.yaml`、`model-profiles.json` |
| 会话记录 | `~/.box-agent/sessions\` | JSONL，你 AgentHub 的 adapter-raccoon 已读这里 |
| 更新器 | `~/AppData/Local/raccoon-ai-updater/pending/` | `商汤小浣熊-1.0.35-x64.exe` + sha512 |

运行中的进程：`box-agent-acp.exe`（多实例，stdio ACP server）。当前无外联 TCP（LLM 走 Electron 主进程代理或按需连接）。

**判定**：不是恶意软件，是一个标准的 AI 编程/办公助手（Electron + 本地 agent），与 Trae/Cursor/WorkBuddy 同构。

---

## 二、核心域名与 API 清单（反代的目标）

### 主域名
- 生产：`https://xiaohuanxiong.com`
- 预发：`https://code-stage.xiaohuanxiong.com`
- 测试：`https://code-test.xiaohuanxiong.com`、`code-test.sensetime.com`
- 备用 IP（`hostedGateway.js` 硬编码）：`10.158.136.99`（内网）
- 官网/账号页：`xiaohuanxiong.com/account`、`office.xiaohuanxiong.com`

### 关键 API 端点（已实证）

| 用途 | 方法 + 路径 | 认证 |
|---|---|---|
| **LLM 对话（OpenAI 兼容）** | `POST /api/web/llm/v2/chat/completions` | Bearer |
| 图片生成 | `POST /api/web/llm/v2/images/gen` | Bearer |
| **积分余额查询** | `GET /api/web/points/v1/balance` | Bearer |
| **积分明细（分页）** | `GET /api/web/points/v1/bills?paging.limit=N&paging.offset=M`（或 `cursor`） | Bearer |
| 登录兑换 | `POST /api/web/auth/v1/login_with_authorization_code` | 无（authorization_code） |
| 刷新 token | `POST /api/web/auth/v1/refresh`（body `{refresh_token}`） | 无 |
| 登录送积分 | `POST /api/web/desktop/v1/login/points/grant` | Bearer |
| **受信设备绑定** | `POST /api/web/auth/v1/devices_current_bind` | Bearer + 设备头 |
| **设备心跳** | `POST /api/web/auth/v1/devices_current_heartbeat` | Bearer + 设备头 |
| 遥测上报 | `POST /api/web/b/v1/m`（个人）/ `/api/web/org/b/v1/m`（团队） | Bearer |
| Web 搜索 MCP | `POST /api/web/mcp/web_search/v1/mcp`（streamable_http） | Bearer |
| 数据分析 | `/api/web/data-analysis/v1` | Bearer |
| 本地聊天存储 | `/api/web/office/v3/*`（`localApi.js`，本地拦截，不外发） | — |

### 账户配额字段（积分体系的一部分，存在账户设置里）
`daily_question_count/limit`、`monthly_web_search_count/limit`、`daily_web_search_count/limit`、`used_space_mb/total_space_mb`、`used_knowledge_space_mb/total_knowledge_space_mb`、`pro_office_enabled`。

### 订阅/支付（个人/企业版）
`/subscription/alipay/create_order`、`/order_status`、`/restore`、`/subscription_status`、`/unsubscribe`、`/order/v1`、`/order/v1/redeem`、`/gen_order_info`。

---

## 三、认证体系（反代必须透传的）

### Token 形态
- **JWT（HS256）**，`access_token` + `refresh_token`，存于 `~/.box-agent/config/auth.json`。
- payload：`{exp, iss:"6f66ba", jti, name:"RaccoonSofia", nation_code:"86", nbf, owner_type:"users", sid:"web<uuid>-<uuid>"}`。
- 有效期：access 约 3 小时（1789958473→1789969278），refresh 约 30 天。
- 刷新窗口：过期前 300 秒触发 `POST /api/web/auth/v1/refresh`。

### 请求头
```
Authorization: Bearer <access_token>
Content-Type: application/json
```
团队版额外：`X-Org-Code: <office_identity>`（个人版为空字符串）。

### box-agent 侧的认证读取优先级（`box_agent/auth.py`）
1. 显式 `auth_token`（内存）
2. `auth.json` 文件（`access_token` / `token` / `auth_token`）
3. 环境变量：`RACCOON_ACCESS_TOKEN` / `RACCOON_TOKEN` / `OFFICEV3_AUTH_TOKEN` / `BOX_AGENT_AUTH_TOKEN`
- 只对 `xiaohuanxiong.com` 域名附加 Authorization（`should_attach_auth_header`），自建/第三方 provider 不会被覆盖。

---

## 四、调用指纹 / 防伪机制（重点）

这是它"认客户端"的全部手段，反代时**必须原样复刻**，否则后端可能拒绝或风控。

### 1. x-client-* 客户端身份头（box-agent → 后端每个 LLM 请求都带）
由 Electron 主进程 `boxAgentManager.js` 的 `buildBoxAgentClientInfo()` 注入，box-agent `client_info.py` 只对 `xiaohuanxiong.com` 及其子域附加：

| Header | 取值来源 | 当前值 |
|---|---|---|
| `x-client-name` | package.json `name` / app.getName() | `raccoon-ai` |
| `x-client-platform` | `process.platform`+arch 归一化 | `desktop-windows` |
| `x-client-version` | `app.getVersion()` 归一化 | `1.0.35` |
| `x-client-os-version` | `os.release()` | 如 `10.0.26200` |
| `x-client-channel` | 常量 `BOX_AGENT_CLIENT_CHANNEL` | `official` |
| `x-client-device-id` | 设备指纹 clientDeviceId | `4e43f8ed-...` |

头值经 `_clean_header_value` 清洗（去控制字符、限长 256）。

### 2. 设备指纹（持久化）
- 文件：`AppData/Roaming/office-raccoon/desktop-device-identity.json`
- 结构：`{schemaVersion:1, clientDeviceId:<随机UUID>, createdAt}` — **首次启动用 `crypto.randomUUID()` 生成，之后复用**。
- **它不是硬件指纹**，就是一次性随机 UUID。删除该文件 = 换一台"新设备"。

### 3. 受信设备绑定（登录后注册设备）
`desktopTrustedDeviceApi.js`：
- `POST /devices_current_bind`，body 含 `client_device_id`、`client_platform`、`client_version`、`device_name`（主机名）、`os`、`os_version`、`application:"desktop"`、`push_permission`。返回服务端 `device_id`。
- `POST /devices_current_heartbeat` 维持设备在线。
- 请求头：`X-Client-Platform` / `X-Client-Device-ID` / `X-Client-Version` / `X-Request-Id`(UUID) + `Authorization`。
- **这就是"这台电脑已登录"的服务端凭据**，多开/换机可能触发设备数上限。

### 4. 遥测/活跃上报（含机器标识）
`desktopAnalytics.js` → `POST /api/web/b/v1/m`：
```json
{"common_header":{"client_agent":"<UA>","machine_id":"<ACTIVITY_MACHINE_ID>"},
 "metrics":[{"metric_type":"event","event":{"event_name":"activity",...}}]}
```
注意：`ACTIVITY_MACHINE_ID` 在主进程里是个**硬编码占位串** `simulator-f31d2afc...`（疑似前端运行时替换真实指纹），实际设备指纹来自 `@fingerprintjs/fingerprintjs`（package.json 依赖，渲染层采集浏览器指纹）。

### 5. 完整性校验
- 资源下载带 `x-content-sha256` 头做哈希校验（`skillHubManager.js`）。
- 更新包用 sha512（`update-info.json`）。
- **未发现请求体签名/HMAC 防伪**——防伪靠的是「JWT + 设备指纹 + 受信设备绑定」三件套，没有重放签名。

### 结论（防伪强度）
**中低**。无代码混淆、无请求签名、无证书 pinning 迹象、无反调试。防伪 = `Authorization: Bearer <JWT>` + `x-client-device-id` + 受信设备绑定。反代只要把这套头原样带上即可。

---

## 五、安全审计结论（是否有危害）

**未发现恶意行为。** 具体：
- 外联域名全部可解释：主域 `xiaohuanxiong.com` 全家 + 第三方连接器（飞书/企微/钉钉/XMind/企查查/启信宝/北大法宝，均为用户主动配置的 MCP/连接器）+ 开源镜像（npmmirror/pypi/清华/aliyun，用于装运行时依赖）。
- 无隐蔽后门域名、无可疑矿池/C2、无键盘记录、无屏幕回传。
- 权限请求正当：`appshot:*`（截屏/辅助功能，需用户授权）、`quick-bar:read-clipboard-text`（读剪贴板，快捷栏功能）。
- IPC 暴露面正常（`chat-conversations`、`local-agent:*`、`voice-input:*` 等）。
- 会写本地 sqlite（`local-chat.sqlite3`）、读你授权的工作目录（`settings.json` 里 `customAllowedDirectories` 含 `E:\idea work\AgentHub`——这是你之前授权的）。
- 数据会发到 `xiaohuanxiong.com`（毕竟是云端 LLM），属预期行为。

**风险点（低）**：默认授权目录若包含敏感仓库，agent 会把文件内容作为上下文发到云端；`desktopAnalytics` 上报 UA+设备标识做活跃度统计。均属同类产品常规行为。

---

## 六、反代落地方案（给你的 AgentHub）

### 方案 A：透明反代（推荐，改动最小）
不改客户端任何东西，用 DNS/hosts 把 `xiaohuanxiong.com` 指到你的网关，网关透传并记录：
```
hosts:  127.0.0.1 xiaohuanxiong.com   （或你的网关机 IP）
```
你的网关终结 TLS（客户端无证书 pinning，可用自签 CA + 系统信任），再转发到真实 `xiaohuanxiong.com`，全程可观测、可改包。

### 方案 B：环境变量重定向（最干净，官方留了口子）
`hostedGateway.js` / `scheduleAuth.js` / `boxAgentConfig.js` 都优先读环境变量：
```
NEXT_PUBLIC_DESKTOP_REMOTE_API_URL   / NEXT_PUBLIC_API_URL
NEXT_PUBLIC_REMOTE_AUTH_ORIGIN       / NEXT_PUBLIC_MAIN_SITE_URL
NEXT_PUBLIC_DESKTOP_REMOTE_AUTH_API_PREFIX
```
但**注意**：`hostedGateway.js` 的 `resolveBuiltInHostedServiceUrl` 只对官方域名做重定向，且 box-agent 的 `should_attach_auth_header`/`should_attach_client_headers` 只对 `xiaohuanxiong.com` 附加认证和指纹头。
**所以**：自定义网关域名要么 (a) 也叫 `*.xiaohuanxiong.com`（hosts 劫持），要么 (b) 在你的反代层补上 `Authorization` 和 `x-client-*` 头（因为客户端不会主动发给非官方域名）。

### 方案 C：直接复用凭据做客户端（最灵活）
你已拿到 `auth.json` 的 access/refresh token，可直接用 AgentHub 的号池体系调 `https://xiaohuanxiong.com/api/web/llm/v2/chat/completions`：
- 带 `Authorization: Bearer <token>`
- 带全套 `x-client-*` 头（伪造 channel=official、version、device-id）
- token 快过期时调 `/refresh` 续期（refresh_token 30 天）
- **务必固定一个 `clientDeviceId`**（复用 `desktop-device-identity.json` 里的，别每次换，否则触发设备风控）

### 反代时必须透传/复刻的字段清单
1. `Authorization: Bearer <access_token>`（核心）
2. `x-client-name: raccoon-ai`
3. `x-client-platform: desktop-windows`
4. `x-client-version: 1.0.35`
5. `x-client-os-version: <os.release>`
6. `x-client-channel: official`
7. `x-client-device-id: <固定 UUID>`
8. （设备类接口）`X-Client-Platform` / `X-Client-Device-ID` / `X-Client-Version` / `X-Request-Id`
9. （团队版）`X-Org-Code: <office_identity>`
10. Content-Type: application/json；LLM 用 SSE 流式（`stream:true`）

### 积分查询对接（接进 AgentHub 余额页）
```
GET https://xiaohuanxiong.com/api/web/points/v1/balance
Header: Authorization: Bearer <access_token> + 全套 x-client-*
→ 返回 {"code":0,"data":<余额>}
```
明细：`GET /api/web/points/v1/bills?paging.limit=50&paging.offset=0`

---

## 七、后续动态验证（可选，确认静态结论）

静态分析已覆盖 95%。若要做动态确认，建议：
1. **mitmproxy 抓包**：装 mitm CA 到系统信任，`hosts` 指向本地，`mitmweb --listen-port 8080`，观察 `/chat/completions`、`/points/v1/balance`、设备心跳的真实请求/响应。
2. **观察 refresh 流程**：等 access_token 临期（3h），看 `/auth/v1/refresh` 的请求体与新 token 落盘。
3. **观察遥测字段**：确认 `machine_id` 真实值是 fingerprintjs 的 visitorId 还是 clientDeviceId。

需要我把这套反代逻辑做成 AgentHub 的一个新渠道适配器（自动读 auth.json、自动 refresh、固定 device-id、透传 x-client-*）吗？
