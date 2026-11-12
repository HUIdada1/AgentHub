# deploy/ —— 部署与升级（板块 5）

面向**使用者**的部署资料。

## ⚠️ 先看清你现在处在哪一档（**今天**是第 1 档）

`compose.yml` 拉的是 GHCR 预构建镜像，但**预构建镜像目前还不存在** —— 产出它的
`.github/workflows/docker.yml` 还没进入仓库主干（取证 2026-11-12 17:58：GitHub API 列出主干只有
`pool-ci.yml` 与 `release.yml`，`contents/.github/workflows/docker.yml` 返回 404；
而 `release.yml` 全文不含任何 docker 步骤）。也就是说"流水线跑过一次"这件事还没发生，
把 `pull` 当成首次部署的默认第一步，就会在第一步撞 `manifest unknown` / `denied`。

| 档 | 什么时候适用 | 怎么起 |
| --- | --- | --- |
| **① 现场 build（今天唯一可用）** | 镜像尚未发布，或你要跑未发布的改动 | 见下面「三条命令（现场 build 版）」 |
| ② 拉预构建镜像 | `docker.yml` 已随第一个 `v*` tag 跑过一次、GHCR 上确有该包 | 见「两条命令（镜像已发布版）」 |

## 三条命令（现场 build 版 —— 当前默认路径）

需要本机有 Docker；**不需要** clone 整个仓库，但需要仓库里的 `gateway/` 目录
（Dockerfile 的 build context 是仓库根，所以要带上根 `package.json`、`package-lock.json`、`src/`、`index.html`、`vite.config.ts`、`electron/backend`）。最省事就是 clone 后切到要部署的版本。

```bash
# ① 准备配置与数据目录
cp gateway/.env.example gateway/.env
#    编辑 gateway/.env，填两个必填项：AGENTHUB_SECRET_KEY 与 AGENTHUB_ADMIN_TOKEN
mkdir -p gateway-data && sudo chown 1000:1000 gateway-data     # 容器内是 uid 1000 在写

# ② 现场构建并启动（这一份 compose 就是 build 版）
docker compose --env-file gateway/.env -f gateway/docker-compose.yml up -d --build

# ③ 打开控制台
#    http://127.0.0.1:19528/     输入 AGENTHUB_ADMIN_TOKEN 登录
```

## 两条命令（镜像已发布版 —— `docker.yml` 跑过之后才成立）

```bash
# ① 准备配置与数据目录
cp deploy/.env.example deploy/.env
#    编辑 deploy/.env，只填两个必填项：AGENTHUB_SECRET_KEY 与 AGENTHUB_ADMIN_TOKEN
mkdir -p deploy/data && sudo chown 1000:1000 deploy/data     # 容器内是 uid 1000 在写

# ② 起服务
docker compose -f deploy/compose.yml up -d

# ③ 打开控制台
#    http://127.0.0.1:19528/     输入 AGENTHUB_ADMIN_TOKEN 登录
```

> 首次发布镜像的操作：把 `docker.yml` 合入主干 → 打一个 `v*` tag（或到 Actions 里手动
> `Run workflow`，它带 `workflow_dispatch`）→ Actions 跑完才有 `ghcr.io/…/agenthub-gateway:latest`。
> 想确认有没有：`docker manifest inspect ghcr.io/huidada1/agenthub-gateway:latest`。

对外提供模型服务的地址是 `http://<主机>:19527/v1`（OpenAI / Anthropic / Responses 三协议兼容），
API Key 在控制台「本地网关 → API Keys」里创建。


## 这个目录里有什么

| 文件 | 什么时候看 |
| --- | --- |
| `compose.yml` | 主配置。每一项都有注释说明"不设会怎样" |
| `.env.example` | 复制成 `.env` 用。**变量全集以此为准**，compose 里没有的设了不生效 |
| `remote-access.md` | 想在家里/手机上打开控制台 —— 四档做法（SSH 隧道 / 反代 / 直接公开 / 群晖） |
| `caddy/Caddyfile` | 自动 HTTPS 的反代样例（含 SSE 不缓冲那条硬要求） |
| `nas-群晖.md` | Container Manager 图形化步骤 + uid 1000 权限那一行 |
| `upgrade.md` | 升级两步走；以及从旧 9527/9528 端口迁移的一次性改法 |
| `backup-restore.md` | 备份**必须抄哪些文件**（`/api/backup` 只含数据库，不含配置与授权） |

## 起步后先看这两件事

1. **号池是不是空的**：新容器的数据目录是空的，`GET /api/readyz` 返回 503 是**合法状态**
   （空池 ≠ 故障）。传号走 WebDAV/S3 号池同步，前提是两个前提：两侧配了同一台服务器、
   **口令一致**（口令信封 `AHPPOOL1`）。`AGENTHUB_SECRET_KEY` 只管容器内落盘加密，
   与两形态能否互解无关。
2. **容器里天生不可用的能力**：OAuth 网页登录 / 扫码 / 短信 / 人机校验一律诚实拒绝；
   qoder 双区需要本机 wasm 签名，容器首启自动关闭并记日志；技能仓库（skills）仅桌面版。
   界面表现都是"灰 + 原因"，不会给你一个裸 403。

## 功能边界在哪

- **插件**：容器形态只支持 v2 provider 型插件；为什么不做界面型 v1、装完为什么不自动启用、
  feed 该指哪一份 —— 权威说明在 [`../gateway/README.md`](../gateway/README.md)
  的「插件：容器形态只支持 v2 provider 型」一节，本目录**不复述**（两份真值必然漂移）。
- **管理面安全闸四态**（无 token 也能启动、但管理面只绑容器回环）：见
  `remote-access.md` 开头，那里是操作视角的同一件事。

## 内存

`compose.yml` 默认限 `1G`。跑不加插件的最小四模块 + sqlite 时 512M 也够，
但装插件后插件子进程与容器共享同一 cgroup，OOM 会连坐主进程被杀、服务整体不可用。
**实测数据（RSS 曲线）尚未取得 —— 本机无 Docker CLI**，需要在目标机上跑
`docker stats agenthub-gateway` 观察后再收紧，方法写在 `../gateway/README.md` 的待实机清单里。
