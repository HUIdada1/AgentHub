# 备份与恢复（板块 5）

## 一句话结论

**`GET /api/backup` 只备份数据库，不备份配置、授权与插件。**
只跑它 = 恢复后号池没了、API Key 没了、插件授权范围没了。

## `/api/backup` 到底给什么

实现是 `store.vacuumInto(<临时文件>)` 后 `res.download(..., "stats.db")`
（见 `gateway/src/index.cjs` 的 `/api/backup`）：

- 用 SQLite 的 `VACUUM INTO` 产**一致性快照**，所以不需要停容器、也不会拷到半写的 WAL；
- 返回的是**单个 `stats.db`**（账号、API Key、路由与限额、用量日志都在这个库里）；
- 下载完即删除临时文件，不占数据卷空间。

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:19528/api/backup -o stats.db
```

## 数据目录里真实有什么（实测清单）

下表是**用一个空目录把网关起来、跑过一轮只读端点后枚举**得到的（Node 22.22.0，未装插件），
不是照抄文档：

| 路径 | 出现时机 | 要不要备份 | 说明 |
| --- | --- | --- | --- |
| `config.json` | 首次启动 | ✅ **必抄** | 全部配置（WebDAV/S3 与口令是 `enc:v2` 密文）。丢了要重配一遍 |
| `proxy/stats.db` | 首次启动 | ✅ 必抄 | 号池 + API Key + 用量日志。可用 `/api/backup` 取一致快照，或直接拷停容器后的整份 |
| `proxy/stats.db-wal` / `-shm` | 运行期 | ⚠️ 见下 | WAL sidecar。**热拷三件套容易拿到撕裂状态**，请用 `/api/backup` |
| `proxy/rules/*.json` | 首次启动 + 拉目录后 | ✅ 建议 | `catalog.json`（模型权威目录，**可手编**，rules.cjs 的合并逻辑明确不覆盖用户改动）、`headers.json`、`function_map.json`、`model_map.json`、`wb_models.json`、`wb_template_map.json`。丢了最坏是重新拉一轮官方目录，手编过的那份则会永久丢失 |
| `proxy/zcode-remote-anchor.json` | 用到 ZCode 渠道时 | 🔵 可选 | 运行期锚点，可再生 |
| `memory-device.json` / `memory-runtime.json` / `memory-sync-state.json` / `memory-profile-cache.json` | 记忆中枢启动时 | ✅ 建议 | 设备标识与同步状态。丢了会被当成**新设备**重新接入（同步侧会多一条设备记录） |
| `gateway.lock` | 运行期 | ❌ 不要 | 单实例锁，运行时存在是正常的；备份里带着它毫无意义 |
| `plugins.json` | 装过第一个插件后 | ✅ **必抄** | 插件启用状态与**授权范围**（哪些权限、哪些渠道被授予）。丢了 = 所有插件回到"未授权"，被接管的渠道全部 503 |
| `plugin-trust.json` | 引入非内置公钥时 | ✅ **必抄** | 信任库（含 `revoked`/`notAfter` 记录）。丢了你第三方公钥要重新导 |
| `plugin-update.json` | 检查过更新后 | 🔵 可选 | `lastCheckAt` / `lastGoodProxy`，丢了只是重新探一次代理 |
| `plugins/<manifest.id>/` | 装过插件后 | ✅ 必抄 | 解包后的插件本体（**目录名必须等于 id**） |
| `plugin-data/<id>/` | 插件自己写数据时 | ✅ 必抄 | 插件私有数据。卸载只删 `plugins/`，这一份是**故意保留**的，重装即复用 |
| `plugin-updates/*.zip` | 下载中断时 | ❌ 不要 | 更新器临时包，超过 1 小时自动清 |

> 记忆中枢与提示词库若把数据放在**数据卷之外**的目录（容器形态下 `memory_root` /
> `prompts_set_dir` 类命令是 DENY，一般不会出现），那部分不在本清单内 —— 它们属于桌面侧的本机目录。

## 正确的整机备份（停容器 30 秒，一份 zip 全带走）

```bash
cd <部署目录>            # 里有 deploy/compose.yml 与 .env
DATA=$(docker compose -f deploy/compose.yml ps -q | xargs docker inspect \
  -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Source }}{{ end }}{{ end }}')
echo "数据目录：$DATA"

docker compose -f deploy/compose.yml stop          # 停容器 → 库里没有半写事务
tar czf "agenthub-backup-$(date +%F-%H%M).tar.gz" -C "$DATA" .
docker compose -f deploy/compose.yml start         # 起来
```

不想停容器就只备"能一致性快照的那部分"：`/api/backup` 取 `stats.db` + 单独拷
`config.json`、`plugins.json`、`plugin-trust.json`、`proxy/rules/`、`plugins/`、`plugin-data/`。
**别热拷 `stats.db*` 三件套。**

## 恢复到新机 / 新目录

```bash
mkdir -p /vol1/docker/agenthub-data
tar xzf agenthub-backup-2026-11-12-1630.tar.gz -C /vol1/docker/agenthub-data
sudo chown -R 1000:1000 /vol1/docker/agenthub-data     # ← 这一步漏掉是最常见的"起不来"
```

然后在 `deploy/.env` 里写：

```bash
AGENTHUB_SECRET_KEY=<与备份时同一把>     # 换了就解不开 config.json 与库里的 enc:v2 密文
AGENTHUB_ADMIN_TOKEN=<可以换新值>        # 换了对库里存的凭据无影响，只是登录口令
AGENTHUB_DATA_DIR_HOST=/vol1/docker/agenthub-data
```

`docker compose -f deploy/compose.yml up -d` → `docker logs -f agenthub-gateway` 看四行：
`platform=node` / `数据目录` / `凭据加密` / 管理面监听。

### 恢复后必查的三件事

1. `GET /api/readyz`：200 = 有在线账号；**503 是合法状态**（空池或全部失效），不是"配坏了"。
2. 「号池管家 → 号池」里账号是否可解：解不开 = `AGENTHUB_SECRET_KEY` 不是原来那把（`enc:v2` 绑它）。
   与桌面版能否互解**无关**，互解看 WebDAV/S3 口令。
3. 装了插件的话：`GET /api/plugins` 应显示 running；若显示未授权，说明 `plugins.json` 没带回来 ——
   被该插件接管的渠道此刻是 503（宿主内没有进程内兜底），要么重新授权，要么先解绑交回宿主。

## 定时化（cron 示例）

```cron
# 每天 04:10 拉一次数据库快照到 /backup/agenthub（配置与插件请配合上面的 tar 一起做）
10 4 * * * CURL=$(cat /etc/agenthub/admin-token) curl -fsS -H "Authorization: Bearer $CURL" \
  http://127.0.0.1:19528/api/backup -o /backup/agenthub/stats-$(date +\%F).db
```

> cron 里的 `%` 要转义成 `\%`，否则被 cron 当成关键字解析（这是 cron 的经典坑，不是本项目特有）。
> 另：`/api/backup` 需要**完整令牌**，只读令牌拿不到它。
