# 升级与回退（板块 5）

面向已经跑着容器、要换版本或改端口的使用者。

> ⚠️ **先确认你处在哪一档**：本文的 `pull` 类命令前提是 **GHCR 上已有预构建镜像**。
> 截至 2026-11-12 取证，产它的 `.github/workflows/docker.yml` **尚未进入主干**
> （GitHub API 列主干只有 `pool-ci.yml` 与 `release.yml`；`release.yml` 不含 docker 步骤），
> 所以**首次部署不要直接 `pull`**：走 `gateway/docker-compose.yml` 的现场 build，
> 或先合入 `docker.yml` 并打 `v*` tag 触发一次。分档说明见 [`README.md`](README.md) 开头。
> 验证镜像在不在：`docker manifest inspect ghcr.io/huidada1/agenthub-gateway:latest`。

## 日常升级：两条命令（前提是镜像已发布）

```bash
docker compose -f deploy/compose.yml pull
docker compose -f deploy/compose.yml up -d
```

`compose.yml` 的镜像是 `ghcr.io/huidadada1/agenthub-gateway:${AGENTHUB_IMAGE_TAG:-latest}`。

- 默认跟着 `latest` 走：**只有你显式 `pull` 才会换镜像**（容器不会自己更新）。
- 想锁住版本：在 `deploy/.env` 写 `AGENTHUB_IMAGE_TAG=2.0.5`（不带 `v`），
  此后 `pull` 只会在该版本滚动时变化。镜像同时打了 `latest` / `完整版本` / `主版本` 三种标签，
  所以也可以只锁大版本（如 `2`）拿补丁更新。
- 主程序升级走镜像、**插件升级走 feed**，两者互不阻塞；已装插件在数据卷里
  （`/data/plugins`、`/data/plugin-data`），换镜像不会丢。

## 升级前必做的两件事

1. **备份**。`GET /api/backup` 只导出数据库，**不含配置与插件授权**，
   必须一起抄的文件清单见 [`backup-restore.md`](backup-restore.md)。
2. **看清你的数据目录属主**。容器内以 uid 1000 运行，宿主目录若不是它属有，
   表现为启动失败或写不进 `gateway.lock` / `config.json` / `stats.db`：

   ```bash
   ls -ld deploy/data            # 看当前属主
   sudo chown 1000:1000 deploy/data
   ```

## 版本跨度大时：先读这两段

- 数据库结构变更由启动流程自行迁移，**不需要手工执行 SQL**；但迁移不可回退，
  所以**降级不受支持**（见下一节）。
- 插件兼容性看宿主 API 版本：镜像里的 `hostApi` 与插件清单的 `host.api` 范围不匹配时，
  该插件会在列表里显示为不兼容并给出原因，不会静默半坏。

## 回退（不推荐，但给出做法）

1. 停当前容器：`docker compose -f deploy/compose.yml down`
2. **先恢复备份的数据目录**（数据库不可回退，用新库配旧镜像是 unsupported 状态）
3. 指定旧标签起：`AGENTHUB_IMAGE_TAG=2.0.5 docker compose -f deploy/compose.yml up -d`

如果只是想回到"改动之前"而没做备份，唯一可用的事实来源是当时的数据目录副本 ——
没有副本就没有回退路径，这也是上面要求先备份的原因。

## 从旧版 9527 / 9528 迁移到 19527 / 19528（一次性）

为什么换：桌面版把本地网关默认占在 `9527/127.0.0.1`。容器沿用 9527 且无前缀映射时，
同机共存必冲突，而冲突表现为"桌面版的网关起不来"，排查成本极高（方案 v2 §D5）。

**只改 compose 里的两个端口值不够** —— 端口由环境变量决定，改法是一行：

```bash
# 编辑 deploy/.env，加这两行（值随你选，下面用旧端口演示"保持原样"的写法）
AGENTHUB_PROXY_PORT=9527
AGENTHUB_ADMIN_PORT=9528
```

- 想**保持旧端口不变**（客户端配置一个字都不改）：照上面写，然后
  `docker compose -f deploy/compose.yml up -d` 重建容器即可。
- 想**迁到新默认**（推荐，与桌面版不再抢端口）：删掉这两行（回到 19527/19528），
  然后把所有客户端里指向 `http://<主机>:9527/v1` 的 `base_url` 改成 `:19527/v1`。
  已发放的 API Key 不受影响（Key 存在库里，与端口无关）。
- 改完务必确认外网/局域网的防火墙与反向代理上游也一起换端口，否则会看到
  "容器健康但客户端连不上"。

## 为什么重启策略是 `unless-stopped` 而不是 `always`

`restart: always` 会让容器在**宿主重启后自启**，包括你之前用 `docker stop` 手动停掉的那些 ——
表现为"我明明关掉了，开机它又活了"，在 NAS 上尤其难解释。

`unless-stopped` 的行为正好是我们要的：

- 崩溃 / OOM / 宿主重启 → **自动回来**（这是服务该有的行为）；
- 你手动 `docker stop` → **保持停止**，直到你显式 `up -d`（尊重运维意图）。

顺带一个已被门禁盯住的教训：这个键曾在一次重写中被整段丢掉，而当时**没有任何检查会发现**
（缺 `restart` 不影响启动，只影响"崩了之后不回来"）。现在 `tools/verify/gw-gates.cjs` 的
T9 断言会直接判红，摘掉它必红。

## 容器"起来了但控制台打不开"——这多半是刻意默认，不是坏了

管理面安全闸的四态里，第 ② 态就是这个现象：**没有设置任何管理令牌时，容器照常启动**，
但入口会把管理面绑定**强制降回容器回环**。后果：

- 宿主的端口映射**转不进来**（容器内的 `127.0.0.1` 不是宿主的 `127.0.0.1`）；
- `HEALTHCHECK` 不受影响（它是在容器内部 curl 回环），所以 `docker ps` 显示 `healthy`；
- 容器日志里会有三行醒目 WARN，明确说这是刻意的安全默认、并给出一行修法。

正确处置：在 `deploy/.env` 设 `AGENTHUB_ADMIN_TOKEN=<你自己的密码>` 后 `up -d` 重建。
**不要**为了"先打开看看"就把 `AGENTHUB_ADMIN_PUBLIC` 设成 `0.0.0.0` —— 那个组合是
"要公开却没令牌"，入口会直接拒绝启动（这是设计，不是故障）。

远程访问的四种正规做法（SSH 隧道 / 反代 / 显式公开 / 群晖）见
[`remote-access.md`](remote-access.md)；令牌与只读令牌的能力边界、以及配置读写的分工表，
见 [`../gateway/README.md`](../gateway/README.md) 的「管理 API 一览」与「安全闸」两节
（本文件不复述，两份真值必然漂移）。

## 插件相关

容器形态只支持 v2 provider 型插件；装完为什么不自动启用、feed 该指哪一份
（linux/glibc 要指带 libc 段的专用索引）、以及自动更新默认关的原因，
权威说明只在 [`../gateway/README.md`](../gateway/README.md) 的
「插件：容器形态只支持 v2 provider 型」一节 —— 本文件不复制该内容。

升级后想确认插件是否随容器恢复：看容器启动日志里的
`[AgentHub Gateway] 插件更新器已就绪 form=node autoApply=…` 一行，
或在控制台插件页看列表状态（已启用的插件会在启动时自动恢复运行）。
