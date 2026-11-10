# AgentHub Docker 版（headless：号池管家 + 本地网关）

> 方案与进度：仓库根 `docs/docker-上线/`。本文件是操作手册，事实以方案文档与代码为准。
> 不能破的约束：数据目录与桌面版相互独立；对外只提供本地网关（localgw）的 OpenAI / Anthropic 兼容端点，渠道能力通过插件适配。

## 快速启动

```bash
# ① 复制环境变量模板
cp gateway/.env.example gateway/.env

# ② 编辑 gateway/.env，填入你自己定义的密钥与令牌（见文件内注释示例）
#    AGENTHUB_SECRET_KEY=你的凭据加密密钥（自定义，建议 32+ 字符）
#    AGENTHUB_ADMIN_TOKEN=你的管理密码（自定义，好记即可）

# ③ 启动（compose 自动读 gateway/.env）
docker compose --env-file gateway/.env -f gateway/docker-compose.yml up -d --build
```

- 网关：`http://<主机>:9527/v1`（OpenAI / Anthropic / Responses 三协议兼容）
- 管理：`http://127.0.0.1:9528/api`（默认只绑宿主本机）
- Web 控制台：`http://<主机>:9528/`（输入 `AGENTHUB_ADMIN_TOKEN` 登录）
- 本地验证（无 Docker）：`npm run verify:gateway`（闭包检查 + 临时数据目录冒烟）

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGENTHUB_SECRET_KEY` | ✅ | 凭据加密密钥（enc:v2 AES-256-GCM），**自定义一个足够长的随机字符串**（建议 32+ 字符，字母数字混合）；未设置时入口拒绝启动（本地调试逃生门：`AGENTHUB_ALLOW_PLAINTEXT=1`） |
| `AGENTHUB_ADMIN_TOKEN` | 可选 | 管理 API 完整令牌 / Web 控制台登录密码，**自定义一个好记的密码**；未设置时管理面只绑回环 |
| `AGENTHUB_ADMIN_READONLY_TOKEN` | 可选 | 只读令牌（自定义，与完整令牌不同）：只放行监视类命令（`commands.cjs` 的 READ 集合） |
| `AGENTHUB_PROXY_PORT` / `AGENTHUB_HOST` | 默认 9527 / 0.0.0.0 | 本地网关监听参数（进程内覆盖，**不回写桌面语义**） |
| `AGENTHUB_ADMIN_PORT` | 默认 9528 | 管理 API 端口 |
| `TZ` | 默认 Asia/Shanghai | 签到时刻与日额度重置按本地时间计算 |

> **密钥与令牌都是用户自定义的**：不需要会 `openssl`，也不需要记住随机字符串。选一个你自己记得住的密码即可（比如 `MySecretKey2024` 或 `MyAdminPass-AgentHub`）。`.env` 文件已在 `.gitignore` 中，不会提交到仓库。

## 号从哪来（两形态互联）

**原则：桌面凭据是 safeStorage(DPAPI) 密文，容器解不开——两形态绝不共享数据卷，传号只走号池同步。**

1. **推荐**：容器配与桌面版同一个 WebDAV/S3：
   `PUT /api/config/webdav` 写入后号池自动同步（口令信封通道，两边 `AGENTHUB_SECRET_KEY` 相同即可互相解开）。
2. 备选：`POST /api/accounts/import` 导入 JSON（桌面版导出的快照或手工凭据；元数据包不含 token 会被明确拒绝并提示）。

桌面版反过来可把容器实例配为「自建 OpenAI 兼容端点」provider：`http://<容器主机>:9527/v1` + 容器里创建的 API Key（`localgw_keys_create` 经管理 RPC）。

## 管理 API 一览

- `GET /api/livez`（恒 200，HEALTHCHECK 用）· `GET /api/readyz`（有在线账号才 200）
- `GET /api/status` · `GET /api/channels` · `GET /api/accounts` · `GET /api/models`
- `GET/PUT /api/config` · `GET/PUT /api/config/webdav` · `GET /api/backup`
- `GET /api/capabilities`：完整命令表与 read/write/deny 标注（109 条 = proxy 66 + localgw 43）
- `POST /api/rpc/:cmd`：远程命令通道，信封与桌面 IPC 完全一致
- `GET /api/events`：SSE 事件流（proxy + localgw）

**容器里不可用**（DENY，返回原因与替代路径）：服务启停、OAuth 网页登录、短信登录、扫码/人机校验、CC Switch / IDE 切号、导出到本机目录、ZCode 设备指纹操作。

## 安全基线

- 管理面未设 token 时只绑回环；远程管理请前置带 TLS 的反向代理
- token 校验恒定时间比较；只读令牌与完整令牌分离
- 单实例锁：同一数据目录只允许一个网关进程
- 日志全走 redact；`.dockerignore` 排除 `*.db`、`.env`、`gateway-data/`
- qoder 双区需要本机 wasm 签名，容器里首启自动关闭并记日志

## 构建

`docker build -f gateway/Dockerfile -t agenthub-gateway .`（三阶段：deps → ui 构建 → 运行时 node:22.22.0-bookworm-slim）。
国内网络构建可加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` 或 `export NPM_REGISTRY=...`。
