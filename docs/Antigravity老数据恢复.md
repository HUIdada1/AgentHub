# Antigravity 老数据恢复（2026-05~07 加密 .pb 会话）

> 适配器：`electron/backend/adapter-antigravity-legacy.cjs`
> 数据源 id：`antigravity-legacy`（用量设置页默认关闭，打开后随下一轮同步自动恢复）

## 背景

现行 Antigravity（0.1.x 之后）把会话改写成明文 SQLite（`~/.gemini/antigravity/conversations/<conversationId>.db`，每行 gen_metadata 对应一次 LLM 调用），由同目录
`adapter-antigravity.cjs` 正常增量采集。

但 **2026 年 5~7 月**（含 2026-05-20 官方迁移快照 `~/.gemini/antigravity-backup/conversations/*.pb`）的会话文件是整文件加密。密钥不落在本机：
- 文件头 100 个样本全随机、无共享前缀（每文件自带 nonce/IV，指向流式 AEAD）；
- 二进制里只有 `chacha20poly1305.New`，没有 `NewX` 与任何 DPAPI 调用；`tink/aead/KeyRing` 符号全部来自无关 Google 库；
- 拿 DPAPI 解出的 Chromium 32B 主密钥 / installation_uuid / installation_id / machineid / Google 邮箱 / file uuid 等共 **2 万多种密钥派生组合暴力试解全部失败**；
- 证明本地根本没有密钥材料，只能借助官方进程本身的解密通道。

## 恢复原理

`language_server.exe` 本身就有 `.pb → SQLite` 的官方迁移能力（同一份二进制在
`.db` 迁移时把旧 .pb 解了出来）。我们让它帮我们读：

1. 把老 .pb 文件 **只读复制** 到 `%TEMP%/dosage-sync-ag-legacy*/.gemini/antigravity/conversations`；
2. 用 Antigravity 安装目录下的 `language_server.exe`（探测链：安装目录 / `%LOCALAPPDATA%/Programs` / `%APPDATA%` / 用户目录下的 `bin/language_server`）指向该沙盒启动；
3. 启动时 LS 需要 stdin 读一个合法 protobuf 的 `exa.codeium_common_pb.Metadata`——我们构造了最小合法输入 **2 字节 `\x10\x01`**（field 2 = varint 1）即可让服务器正常初始化；
4. 通过 HTTP RPC `GetCascadeTrajectoryGeneratorMetadata` 拉到每个 `cascadeId` 的 `chatModel.usage`（inputTokens / outputTokens / thinkingOutputTokens / responseOutputTokens）；
5. 语言服务器只在内存里解密，**不会改写任何原始 .pb 文件**（沙盒字节与源完全一致）。

幂等键：`deviceId:antigravity-legacy:<cascadeId>:<调用序号>`（调用序号 = 该会话 generatorMetadata 数组下标，服务端稳定返回）。
粒度与 .db 时代的 `adapter-antigravity.cjs` 完全一致：**每次 LLM 调用一条记录**，不入账则重复同步只覆盖不重复。

> ⚠️ 跨设备可见性要点：上传是**按本机 deviceId 过滤**日分片的
> （`getRecordDays(deviceId)` → `getRecordsByDay(deviceId, day)`）。
> 因此适配器产出的记录必须带**本机真实 deviceId**（即 `ensureLocalDeviceId()` 的结果，
> 来自 `antigravity_state.pbtxt` 的 installation_uuid），否则记录只存在本机库、
> 永远不会进入上传清单——表现为「本机看得到、别的电脑同步不到」。

## 在其他电脑上开箱使用（开源项目给社区用户）

前提：
- 机器上装过 Antigravity（任一能启动的版本，`language_server.exe` 需要现场探测，本仓库不分发）；
- 五月老数据在 `~/.gemini/antigravity-backup/conversations/*.pb`（官方 2026-05-20 迁移快照）；没有老数据时适配器自动跳过，不影响其他源。

步骤：
1. 用量设置 → 数据源 → 打开 **「Antigravity 老数据恢复」**；
2. 手动触发一次同步（或等下一次自动同步）；
3. 同步期间会在 `%TEMP%` 建沙盒、启动 LS、跑 RPC，约 1-3 分钟（取决于 .pb 数量）；
4. 完成后自动清理沙盒与 LS 进程，下一次同步不重复跑一次（幂等键去重）。

边界与降级：
- 没找到 `language_server.exe`（未安装 Antigravity）→ 跳过，不报错；
- 老 .pb 目录不存在 → 跳过；
- 单个会话 RPC 失败（比如 implicit 的轨迹）→ 跳过该会话，其他不受影响；
- LS 启动超过 60 秒未就绪（杀软/360 拦截）→ 立即终止进程，记错误日志，不影响其他源；
- 残留清理：每轮自清 `%TEMP%/dosage-sync-ag-legacy*`，不堆积。

## 自测

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe tools/antigravity-legacy-smoke.cjs
```

输出示例（本机 200 个 .pb，约 100 秒）：

```
=== Antigravity 老数据恢复适配器自测 ===
extract() 完成，耗时 101.7s，共 180 条记录

--- 汇总 ---
输入 token: 31,980,278
输出 token: 4,393,405
思考 token: 2,017,331

--- 按月份 ---
  2026-04: 28 条，输入 1,963,310 / 输出 333,744 / 思考 138,756
  2026-05: 60 条，输入 8,170,726 / 输出 1,232,639 / 思考 434,335
  2026-07: 92 条，输入 21,846,242 / 输出 2,827,022 / 思考 1,444,240
```

## 已知边界

- **implicit 目录**（`~/.gemini/antigravity{,-backup}/implicit/*.pb`）是另一种轨迹格式（用户主线），RPC 明确报 "trajectory not found"——经核验全部 38 个文件不含 token 元数据，不属于用量；
- **5 个五月会话**（`18e764e6-…`、`2813b6c8-…`、`3d3c313a-…`、`b20084ed-…`、`e60c3cba-…`）在任何口径下都查不到 token 记录——是仅有用户输入、模型未回话的空会话，确认无遗漏；
- 现行 7 月 .pb 也会一并被该适配器扫到（同目录 adapter-antigravity.cjs 读的是 .db，不冲突；两边的幂等键不同）。
