# 群晖 NAS 部署（Container Manager 图形化步骤）

面向 DSM 7.x + Container Manager 的机器。**没有 Docker CLI 也能见**。

> 关于"图文"：本文件给的是**逐级菜单名 + 字段名**的精确操作路径，不含截图 ——
> 编写时手上没有可登录的 DSM 环境，凭印象画示意图只会误导（截图必须来自真实机型）。
> 需要配图请在自己的 DSM 上按下面步骤截，或直接按 `compose.yml` 走项目模式（更快）。

## 先决定走哪条路

| 路子 | 适合 | 步骤 |
| --- | --- | --- |
| **A. 项目（推荐）** | 想和文档完全一致、以后一条 `pull` 升级 | 下面「A：项目模式」 |
| B. 手动建容器 | 只想点几下、不要 compose 文件 | 下面「B：手动建容器」 |

两条路都必须先做**权限那一步**，否则容器起不来或写不进数据（这是群晖上最常见的坑）。

## 0. 必做的准备：目录与 uid 1000

镜像内以非 root 的 `node` 用户运行，**uid 是 1000**。它要对数据目录有写权限
（`gateway.lock` / `config.json` / `stats.db` / `plugins*` 都写在这里）。
DSM 的图形界面里看不到 uid，所以这一步只能走 SSH：

```bash
# ① 打开 DSM 控制面板 → 终端机和 SNMP → 勾选「启用 SSH」，用你的管理员账号登录
ssh <你的管理员账号>@<nas-ip> -p 22

# ② 建数据目录（路径随你，这里用 docker 共享文件夹下的 agenthub）
sudo mkdir -p /volume1/docker/agenthub/data

# ③ 关键一步：属主给 uid 1000（群晖自己的账号体系里通常没有 1000，直接写数字最稳）
sudo chown 1000:1000 /volume1/docker/agenthub/data

# ④ 核对（应显示 1000 users 或 1000 1000）
ls -ld /volume1/docker/agenthub/data
```

不做 ③ 的现象：容器反复重启，日志里是 `EACCES` 或"锁文件不可用/写不进配置"，
而 Container Manager 只会显示"容器已退出"，看不出原因。

## A：项目模式（与 `deploy/compose.yml` 一致）

1. **放文件**：把 `deploy/` 整个目录拷到 NAS，例如
   File Station 里拖进 `docker/agenthub/`，得到
   `docker/agenthub/deploy/compose.yml` 与 `.env.example`。
2. **建 .env**：File Station 里复制 `.env.example` → `.env`，右键「文本编辑」，
   只改两个必填项：
   - `AGENTHUB_SECRET_KEY=<你自己定的长随机串>`（丢了它，容器内已存的凭据解不开）
   - `AGENTHUB_ADMIN_TOKEN=<你的控制台密码>`
     **不设它也能启动**，但管理面会被强制降回容器回环 → 你在浏览器里打不开控制台
     （这是刻意的安全默认，不是配坏了；详见 `upgrade.md` 最后一节）。
   再把数据目录指到你刚建的路径：`AGENTHUB_DATA_DIR_HOST=/volume1/docker/agenthub/data`
3. **建项目**：Container Manager → **项目** → **新增**
   - 项目名称：`agenthub`
   - 路径：选 `docker/agenthub/deploy`（**必须选到含 `compose.yml` 的那一层**）
   - 「使用新的容器组」保持默认；来源选「现有 Docker Compose 项目路径」
   - 下一步直到完成，DSM 会自动 `pull` 镜像并 `up -d`
4. **看健康**：容器列表里 `agenthub-gateway` 应显示**运行中**；
   稍等约 15-30 秒（HEALTHCHECK 的 start-period）后健康状态转成 **healthy**。
   若显示 unhealthy，先看容器日志（点容器 → 日志），不要先重启。
5. **打开控制台**：`http://<NAS-IP>:19528/`，输入 `AGENTHUB_ADMIN_TOKEN`。

> 端口若与 NAS 上别的服务撞：在 `.env` 里改 `AGENTHUB_PROXY_PORT` / `AGENTHUB_ADMIN_PORT`
> 后回到「项目」里点**重新部署**。`compose.yml` 的端口映射是引用这两个变量的，
> 直接改 yml 里的数字会在重新部署时被变量替换覆盖 —— 改 `.env` 才是对的入口。

## B：手动建容器（不推荐，仅作应急）

Container Manager → **容器** → **新增** → 搜索/选择 `huidadada1/agenthub-gateway`（
需在「注册表」里先添加 `ghcr.io` 并登录可不登录，公共镜像匿名可拉）→ 向导：

- **高级设置 → 卷**：`/volume1/docker/agenthub/data` → 挂载路径 `/data`（可读写）
- **高级设置 → 端口**：本地 `19527` → 容器 `19527`；本地 `19528` → 容器 `19528`
  （管理口只想本机用，就把本地 IP 填 `127.0.0.1`）
- **高级设置 → 环境**：`AGENTHUB_SECRET_KEY`、`AGENTHUB_ADMIN_TOKEN`、`TZ=Asia/Shanghai`
- **高级设置 → 常规**：**重启策略选 `unless-stopped`**（与文档一致；选 `always` 会让
  你手动停掉的容器在开机后又自己起来，见 `upgrade.md`）
- **高级设置 → 资源限制**：内存上限建议 `1G`（装插件时尤其不要给 512M，
  插件子进程与容器同 cgroup，OOM 会连坐主进程把整个服务打死）

手动方式的问题：升级要自己换镜像标签、参数散在向导里难以核对，所以只建议应急用。

## 升级到新版本

- A 模式：Container Manager → 项目 → `agenthub` → **停止**，再 **启动** 时勾选
  「重新拉取镜像」；或 SSH 里 `docker compose -f deploy/compose.yml pull && up -d`。
- 升级前的备份清单见 [`backup-restore.md`](backup-restore.md)（`/api/backup` 只含数据库，
  配置与插件授权要另外抄）。
- 详细版本策略与回退说明在 [`upgrade.md`](upgrade.md)。

## 想要 HTTPS / 外网访问

群晖两条路：

1. **DSM 反向代理服务器**（控制面板 → 登录门户 → 高级 → 反向代理服务器）
   - 来源：https + 你的域名/端口；目的地：http + `localhost` + `19528`
   - **自定义头必须加两条**，否则 Web 控制台的实时推送（SSE）会一直不动：
     `X-Accel-Buffering = no`、`proxy-timeout` 拉长到 3600
   - 证书用 DSM 内置 Let's Encrypt 即可
2. **Caddy 容器**：仓库带了现成配置样例 [`caddy/Caddyfile`](caddy/Caddyfile)
   （自动 HTTPS，并显式关掉了 SSE 缓冲）

两条路的完整对照与 SSH 隧道应急做法见 [`remote-access.md`](remote-access.md)。

## 容器里天生不可用的功能（群晖上尤其要提前知道）

- OAuth 网页登录 / 短信 / 扫码 / 人机校验：容器内无法完成，界面会诚实拒绝并给替代路径；
  号池账号请从桌面版经 WebDAV/S3 同步过来（**互通靠两侧口令一致**，与
  `AGENTHUB_SECRET_KEY` 无关）。
- qoder 双区需要本机客户端的 wasm 签名，容器首启会自动关闭该渠道并记日志。
- 技能仓库（skills）与桌面窗口/文件对话框类操作仅桌面版。
- 若要给容器加"由 DSM 登录时自动启动"，请用项目模式或重启策略，不要依赖 DSM 的
  计划任务脚本 —— 那会绕过 `unless-stopped` 的语义。
