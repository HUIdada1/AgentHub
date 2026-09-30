# AgentHub macOS 适配方案（分阶段可执行版）

> **调研边界（必读）**
> 1. 本文是**只读调研 + 方案设计**产物：本次没有改动任何代码，实施前也不以本文为由改动代码；文中所有「改动清单」都是待排期的工作项。
> 2. **Windows 零回归是硬约束**：所有建议只允许两种形态——「新增平台分支」或「新增 mac 专属产物/配置」；不得要求改动 Windows 分支的既有行为、路径、命令与产物命名。凡会连带改变 Windows 行为的点，一律在第 8 节「Windows 可见改动账目」单独列账并给回归办法。
> 3. **证据规则**：每条技术结论都带 `仓库相对路径:行号`；仓库内无法证实的外部事实一律标注「外部事实（本次未复核）」或「待验证」并给验证方法（集中在第 7 节）。行号是**本次复核时点**的工作区快照，实施前请用关键字重新定位（工作区在被并发改动，行号会漂移，见第 1 节读表说明）。**依赖目录（node_modules）不属于仓库源码、不在引用核对范围内**：凡依赖源码/第三方文档才能证实的结论，本文只写成「依赖实现/外部事实（本次未复核）」并把复核命令放进第 7 节（统一用 `node -e "console.log(require.resolve(...))"` 定位到依赖文件后再看内容）。
> 4. 取证基线（本机实读）：`package.json:2` version 1.39.1；Electron 35.7.5、electron-builder 24.13.3、electron-updater 6.8.9（三者用 `node -p "require('./node_modules/<pkg>/package.json').version"` 在依赖目录实读）；`node -v` = v16.20.2（系统 Node，无 `node:sqlite`）；依赖目录里只装了 koffi 的 win32-x64 原生包（`ls` 实读）。撰写期间工作区被**并发外部进程**改动（`package.json` 版本号变为 1.40.0、`build/release-notes.md`、`src/stores/app.ts` 等有外部改动，均非本方案所为）。
> 5. **取证材料说明**：成文时用到三份工作流取证材料——材料 1（107 条耦合点机械核对清单，即第 1 节表格的来源）、材料 3（外部生态可行性核对：macOS 打包/签名/更新生态）、材料 4（P0 判定独立复核）。它们**不在仓库内、读者无法直接打开**，故本文不把它们当仓库证据：只由材料支撑的结论一律写成「外部事实（本次未复核）」/「待验证」并给可自行执行的验证方法（第 7 节）；能落到仓库代码的，一律给 `路径:行号`。

## 结论速览

- mac 上「连产物都没有」的根因是流水线单平台：`.github/workflows/release.yml:22` 只有 `windows-latest`，`:68` 的 `npx electron-builder --publish always` 默认只构建当前平台，Release 里永远不会出现 dmg/zip/latest-mac.yml（仓库内可核，无需外部证据）。
- 运行时唯一会把 AgentHub **打死在 mac 上**的路径只有一条：`electron/backend/sqlcipher.cjs:13` 顶层 `require("koffi")`，在拿不到 darwin 原生产物时直接抛错，并沿 `electron/backend/sync-adapter.cjs:16-23` → `electron/backend/sync-config.cjs:8` → `electron/main.cjs:13` 一路冒泡到 `app.whenReady` 之前。**这条可在本机用伪造平台复现，命令与预期见 V41**；修复只需「惰性加载 + try/catch」，是 Phase 1 的必做项。
- Trae 四源（trae / trae-cn / trae-solo / trae-solo-cn）在 mac 上整体不可用：`electron/backend/sqlcipher.cjs:27` 只认 `sqlcipher.dll`，`electron/backend/adapter-trae-common.cjs:32` 只按 `%APPDATA%` 推目录；属**局部降级**（`electron/backend/sync.cjs:339` 按源吞错继续），应在 UI 隐藏而不是假装可用。
- 凭据体系跨平台不互换：`electron/backend/config.cjs:29` 的 `enc:v1:` 信封在本机解不开异机密文（解不开即回空串，`electron/backend/config.cjs:45`；macOS 走 Keychain、Windows 走 DPAPI 属**外部事实（本次未复核，V9）**），而 `electron/backend/config.cjs:385` 的保存会把空值重新封信 → **会把 Windows 密文永久清空**，必须在 Phase 2 先修语义。
- ZCode 渠道凭据的派生密钥含平台名（`electron/backend/proxy/zcodeLocal.cjs:46`，公式来自 win32 实测）；据此**预期**Windows 搬来的 `~/.zcode/v2/credentials.json` 在 mac 上解不开 → 需重登。这是推论不是实测，**待验证 V24**（在 mac 上派生密钥试解）。
- 小浣熊设备指纹是 mac 上最严重的功能点：`electron/backend/proxy/ideswitch.cjs:77` 在 `APPDATA` 缺失时静默 `return false` → 多号共用同一 `clientDeviceId` → 命中 `electron/backend/proxy/ideswitch.cjs:73` 记录的 200003 跨号串号规则，服务端强制作废两端会话（代码注释即依据），**不可降级，必须补**。
- 外部客户端进程控制（WorkBuddy / 小浣熊）在 mac 全部落在 win32 短路分支（`electron/backend/proxy/wbClient.cjs:46/69`、`electron/backend/proxy/raccoonClient.cjs:37/71`），切号编排会「静默假成功」；仓内已有 `electron/backend/proxy/zcodeLocal.cjs:846/860/909` 的 pgrep/pkill/which 样板可照抄。
- 打包与更新：mac 目标默认 dmg+zip、Squirrel.Mac 自动更新**要求应用已签名**、mac 更新元数据叫 `latest-mac.yml` —— 这三条都出自**依赖实现/官方文档（本次未复核）**，对应 **V1/V11/V14**；仓库侧可核的是 `electron/backend/updater.cjs` 对 darwin/zip/latest-mac/process.platform 命中数为 0（本次 `grep -c -iE "darwin|latest-mac|process\.platform" electron/backend/updater.cjs` 实跑）。
- 建议节奏：Phase 0（决策）→ Phase 1（mac 可构建可启动，改动最小、风险最高）→ Phase 2（记忆中枢/用量同步等纯本地能力）→ Phase 3（反代网关与号池，含设备指纹与客户端控制）→ Phase 4（签名公证与增量更新）。**Phase 1 与 Phase 3 是两个真正的高风险关口**，Phase 4 的签名决策影响 Phase 3 的号池客户端联动方案（未签名时 Keychain 授权体验差）。不熟悉的 macOS 打包/签名/更新术语，先看 2.5 术语表。

## 1. 耦合点全景清单

| 文件:行号 | 类别 | 说明 | 代码证据 | 迁移难度 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| `package.json:47` | 打包 | electronDist 写死项目内的 node_modules/electron/dist，本机实测该目录是 Windows 版 Electron（只有 electron.exe/locales/resources，无 Electron.app）；打包器在 mac 上会把它解析成 <dist>/Electron.app，依赖实现（本次未复核，V1）。**本方案处置：不改这一行**（改的是构建纪律：mac 构建必须全新 npm ci；Windows 分支零改动）——见订正 3 与 Phase 1 第 3 条；表内旧措辞「必须先删掉或按平台分叉」是对「把 Windows node_modules 搬到 mac」这一读法的描述，不是本方案建议。 | `"electronDist": "node_modules/electron/dist",` | 中 | P0 |
| `.github/workflows/release.yml:22` | 工具链 | 发布流水线只有 windows-latest 一个 runner，因此 Release 里永远不会有 dmg/zip/latest-mac.yml —— mac 用户连可安装产物都不存在，这是「mac 上能不能用」的总开关（P0 的根因）。 | `runs-on: windows-latest` | 中 | P0 |
| `.github/workflows/release.yml:68` | 打包 | 构建命令是 `npx electron-builder --publish always`，不带 --mac/--win：electron-builder 默认只构建当前平台（依赖实现，V1），所以在 windows-latest 上只会产出 Setup.exe + portable.exe + latest.yml；要出 mac 产物必须同时加 mac runner 和平台参数。 | `run: npx electron-builder --publish always` | 低 | P0 |
| `electron/backend/sqlcipher.cjs:13` | 原生依赖 | koffi 在文件顶层无保护 require；本机 node_modules 只有 @koromix/koffi-win32-x64，mac 上拿不到 darwin 产物时这句直接抛错（消息形如 Cannot find the native Koffi module），而不是返回 false 走降级。崩溃链可用 V41 在本机复现。 | `const koffi = require("koffi");` | 中 | P0 |
| `electron/backend/sync-adapter.cjs:18` | 进程 | 适配器注册表在模块加载期就 require 全部 20 个数据源（Trae 四源在内），把 koffi 原生加载失败放大成「整个同步模块不可加载」；改为懒加载或给这几个 require 包 try/catch，就能把影响收回到 Trae 四源。 | `const trae = require("./adapter-trae.cjs");` | 低 | P0 |
| `electron/main.cjs:15` | 进程 | 主进程入口第 15 行整模块 require 用量同步且无 try/catch，整条链的任何一环抛错都发生在窗口创建之前：mac 上表现为应用起不来，而不是少一个数据源（放大点；根因同上一条）。 | `const usagesync = require("./backend/sync.cjs");` | 低 | P0 |
| `package.json:87` | 打包 | build 对象里只有 win / nsis / portable 三个平台段，没有 mac 段（本机 `grep -n -i "mac\|icns\|dmg\|notarize" package.json` 零命中）→ mac 上全部走 electron-builder 默认：target 默认 zip+dmg、图标回落默认（依赖实现，V1/V2）、且无签名/无公证配置 → 下载后 Gatekeeper 会拦（外部事实，V8）、electron-updater 的 mac 安装路径也依赖同签名身份（V11）。 | `"win": {` | 中 | P1 |
| `package.json:105` | 打包 | nsis.include 注入的 build/installer.nsh 只在 Windows NSIS 安装器里生效；mac 没有 NSIS/安装器（.app + dmg 或 zip），更新与替换走的是 Squirrel 解压替换，这段安装期钩子在 mac 上完全不执行。 | `"include": "build/installer.nsh",` | 中 | P1 |
| `package.json:79` | 原生依赖 | extraResources 把 resources/sqlcipher 复制到 resources 根的 sqlcipher（mac 即 Contents/Resources/sqlcipher，路径口径与 Windows 一致），但该目录本机实测只有 libcrypto-1_1-x64.dll、libssl-1_1-x64.dll、sqlcipher.dll 三个 Windows 二进制；electron/backend/sqlcipher.cjs:27 又硬找 sqlcipher.dll → mac 上 SQLCipher 解库整体不可用（记忆中枢与 Trae 系适配器的加密库读取直接抛错）。 | `"from": "resources/sqlcipher",` | 高 | P1 |
| `build/installer.nsh:10` | 进程 | 安装/卸载前用 taskkill /F /T 强杀全部 AgentHub.exe（注释说明是为了清掉外部客户端以 ELECTRON_RUN_AS_NODE 拉起的 MCP 桥进程对主 exe 的镜像锁）；mac 上既没有 taskkill 也没有等价钩子，更新替换 .app 时若同 bundle id 进程仍在跑（含 MCP 桥），需要另实现一套杀进程逻辑。 | `nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`` | 高 | P1 |
| `electron/backend/updater.cjs:13` | 更新 | 安装版更新源硬编码 GitHub 的 latest/download/latest.yml；electron-updater 在 darwin 上按平台拼的是 latest-mac.yml（依赖实现，本次未复核，V11/V14），Release 里只有 latest.yml → mac 上检查更新会走失败分支（错误码形如 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND）。 | `const LATEST_YML_URL = GITHUB_RELEASES_URL + "/latest/download/latest.yml";` | 中 | P1 |
| `electron/backend/updater.cjs:337` | 更新 | 便携分支也用 netFetch 直读同一个 latest.yml 做版本比对；mac 上读到的是 Windows 安装包的清单，会照常显示「发现有新版本」并引导去 Releases 手动下载，而那里只有 .exe —— 更新提示成了误导性失效。 | `const text = await netFetch(LATEST_YML_URL, 5);` | 中 | P1 |
| `electron/backend/updater.cjs:43` | 路径 | 便携模式判定完全依赖 ELECTRON_RUN_AS_NODE 之外的 PORTABLE_EXECUTABLE_DIR（`electron/backend/config.cjs:22` 同口径），该变量只由 electron-builder 的 Windows portable stub 注入，mac 上恒为空 → 便携模式在 mac 上不存在，portable.flag 也只对 exe 同目录有意义，数据目录与更新路径都会按安装版走。 | `if (process.env.PORTABLE_EXECUTABLE_DIR) return true;` | 中 | P1 |
| `electron/backend/updater.cjs:395` | 更新 | 安装入口是 autoUpdater.quitAndInstall(true, true)；mac 侧的 Squirrel.Mac 安装语义与 Windows NSIS 静默安装不同（依赖实现/外部事实，V11）：更新包需是 zip 且应用已签名，参数 isSilent/isForceRunAfter 在 mac 上不适用。 | `autoUpdater.quitAndInstall(true, true);` | 高 | P1 |
| `electron/backend/sqlcipher.cjs:27` | 原生依赖 | 库名与扩展名写死 sqlcipher.dll，dllDir() 只认这一个文件名：mac 上放 sqlcipher.dylib 也命不中，返回 null 后在 38 行抛错，四个 Trae 源全灭；需要按 process.platform 选 .dll/.dylib 与目录名。 | `if (fs.existsSync(path.join(dir, "sqlcipher.dll"))) return dir;` | 中 | P1 |
| `electron/backend/sqlcipher.cjs:40` | 原生依赖 | 先预载 OpenSSL 1.1 再载本体（注释自称 Windows 加载顺序敏感）；mac 上要么随包一份 libcrypto 等价 dylib，要么换 CommonCrypto/静态链接的 SQLCipher，否则 dlopen 会因依赖解析失败报 image not found（依赖行为，V16）。 | `koffi.load(path.join(dir, "libcrypto-1_1-x64.dll"));` | 高 | P1 |
| `electron/backend/sqlcipher.cjs:42` | 原生依赖 | 真正的加载点。本机字符串扫描（命令与结果见 V16）：这份 DLL 只引用 libcrypto-1_1-x64.dll（libssl 零命中，41 行属冗余预载）；`electron/backend/sqlcipher.cjs:46-58` 绑定的 13 个符号全是 sqlite3_*，没有 sqlcipher 专有符号 → **预期** mac 侧只要一个能解 SQLCipher 4.x 库、且导出同名 sqlite3_* 的动态库即可（这是 Phase 0 选型依据，须按 V16 验证后再定，不要先按此采购/自建）。 | `const dll = koffi.load(path.join(dir, "sqlcipher.dll"));` | 高 | P1 |
| `electron/backend/sqlcipher.cjs:111` | 凭据 | 全仓唯一的数据库加密语句就是这句 raw key，且代码从不设 cipher_compatibility：能否解开取决于所载库的默认参数。仓库这份二进制的版本标记为 4.6.1/community（本机字符串扫描，命令见 V16）；mac 上若取到 3.x 版 dylib，密钥正确也会报 file is not a database（依赖行为，V16）。 | `exec(db, `PRAGMA key = "x'${TRAE_DB_KEY}'"`);` | 高 | P1 |
| `electron/backend/adapter-trae-common.cjs:32` | 路径 | 四个 Trae 源的根目录只按 %APPDATA% 推：mac 上 APPDATA 不存在，会退成 ~/AppData/Roaming，detect() 恒为 null——即使 mac 装了 Trae 也扫不到，而 envKey 覆盖（TRAE_DATA_HOME 等）在 Finder 启动的 App 里拿不到环境变量。 | `return process.env.APPDATA \|\| path.join(homeDir(), "AppData", "Roaming");` | 中 | P1 |
| `electron/backend/adapter-trae-common.cjs:116` | 外部集成 | koffi 本身能载、只是库文件缺失/损坏时走这条分支：available() 返回 false 后抛业务错，属「局部失效」，四个 Trae 源不可用但不影响其它源与其它模块。 | `if (!sqlcipher.available()) {` | 低 | P1 |
| `electron/backend/sync.cjs:339` | 进程 | 局部失效的兜底在同步层：抽取异常按源记 error 日志后继续下一个源，所以「缺 dylib」不会让应用崩、只是 Trae 用量静默为 0——这条必须与 P0 的 require 崩溃区分开写进方案。 | `log("extract", "error", `${src.name} 抽取失败，已跳过该源继续同步`, e.message);` | 低 | P1 |
| `package.json:79` | 打包 | extraResources 无条件把 resources/sqlcipher 整目录拷进所有平台包：mac 包里会原样躺三个 Windows PE 文件（本机按 PE 头确认 machine 0x8664），「resources 里有 sqlcipher 目录」会让人误判 mac 已支持，必须按平台换资源目录/内容（换法与选型见 D8）。 | `"from": "resources/sqlcipher",` | 中 | P1 |
| `package-lock.json:4469` | 原生依赖 | koffi 3.3.0 的 darwin 预编译包在 lock 里有（4469/4470 两行 darwin-arm64/x64；实体解析条目在 `package-lock.json:899-928`），说明 mac 上正常 npm ci 预期无需自建原生模块（V15）；反过来在 Windows 上交叉打 mac 包会把 win32_x64/koffi.node 塞进 mac 包——这是本方向最关键的分叉点（本方案以「mac 上全新 npm ci」规避）。 | `"@koromix/koffi-darwin-arm64": "3.3.0",` | 低 | P1 |
| `electron/backend/config.cjs:45` | 凭据 | 凭据走 Electron safeStorage（Windows DPAPI / mac Keychain，外部事实，V9），跨平台密文不可解：把 Windows 的 config.json、号池备份或远端同步内容带到 mac，WebDAV 密码与渠道 token 会被静默判成空串（`electron/backend/proxy/store.cjs:296` 的 tokenUsable 解不开即判不可用），用户看到的是「号池全挂」而不是「凭据要重填」。 | `return ""; // 密文来自其他机器解不开，让用户重填` | 中 | P1 |
| `electron/backend/config.cjs:29` | 凭据 | 全应用只用一个 enc:v1: 前缀标记「系统密钥信封」；mac 首启读到 Windows 时代 config.json 里的 enc:v1: 串时前缀认得出、内容解不开，而前缀不携带后端语义（DPAPI vs Keychain），只能靠「解密失败」判断是否为本机密文——任何按前缀断定「这是我们的密文、可以直接用」的写法在 mac 上都会踩空。 | `const ENC_PREFIX = "enc:v1:";` | 低 | P1 |
| `electron/backend/config.cjs:385` | 凭据 | 保存时把内存中的密码重新封信，而 mac 内存里已是空串（encryptSecret 对空串原样返回空），于是任何一次保存都会把 Windows 密文永久清成空：自动触发点是 `electron/backend/proxy/index.cjs:457-462` 的 rememberRunning（启停网关即写盘，写盘在 :462），手动触发点是 `electron/backend/ipc.cjs:37-39` 的掩码回填（磁盘真值为空，回填仍是空）。同一份 config.json 被拷回或放在共享目录时，Windows 侧密码一并丢失。迁移前必须改成「解密失败则原样保留密文」。（行号：取证快照为 :384，现工作区为 :385。） | `disk.webdavShared.password = encryptSecret(disk.webdavShared.password);` | 中 | P1 |
| `electron/backend/proxy/store.cjs:296` | 凭据 | 账号可用性以「能否真解密」判定（hasToken=tokenUsable）。把 Windows 时代的 stats.db 直接搬到 mac 后所有 token_enc 解不出，hasToken 恒 false，而 pool.cjs:46 只调度 online 且 hasToken 的账号 → 号池零可用账号、代理请求全部无号可发。mac 上的恢复路径只有重新导入/重登，或走号池 WebDAV 同步（包内是明文 token、到岸重新封信）。 | `ok = !!config.decryptSecret(r.token_enc);` | 中 | P1 |
| `electron/backend/proxy/store.cjs:358` | 凭据 | 切号快照与转发取明文 token 都走这里；mac 上恒为空 → zcodeLocal.readSwitchSnapshot 返回 null、切号被如实拒绝（`electron/backend/proxy/zcodeSwitch.cjs:134`「该账号没有切号快照」），表现为「号还在库里，但既不能切也不能发请求」，且不会自动标 relogin，界面看不出是密文问题。 | `token: config.decryptSecret(r.token_enc),` | 中 | P1 |
| `electron/backend/proxy/poolsync.cjs:174` | 凭据 | 跨机同步的「凭据重新封信」触发条件：导出前先 unseal/decrypt 成明文（poolsync.cjs:144-163），导入时凡不带本机 ZCV1: 信封形态的一律用本机后端重新封信（165-187）。密文从不上网，因此 DPAPI↔Keychain 后端不同不影响号池同步本身——mac 上真正缺的只是那份被 DPAPI 锁住的 WebDAV 密码，重填一次即可全量拉回。 | `const needsSeal = sw._plain \|\| (!String(sw.accessToken \|\| "").startsWith("ZCV1:enc:v1:")` | 中 | P1 |
| `electron/backend/proxy/zcodeLocal.cjs:46` | 凭据 | ZCode 渠道凭据的 AES 密钥按平台名+主目录+用户名派生（Node 语义 win32/darwin，公式来自 win32 实测）。**预期**：从 Windows 搬来的 ~/.zcode/v2/credentials.json 在 mac 上解不开 → live 登录态失效、号池扫描降级成占位候选引导 OAuth（`electron/backend/proxy/discovery.cjs`）→ 只能靠 mac 官方客户端重新登录。这是**推论**（V24），不是已实测结论；若是官方客户端的密钥设计，AgentHub 无法代偿，方案里只能写「需重新登录」。 | `return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;` | 高 | P1 |
| `electron/backend/memory/providers.cjs:178` | 凭据 | 记忆中枢供应商 Key 自 v1.23.0 起明文落盘（providers.cjs:139），新写的配置跨平台无碍；但旧版留下的 enc:v1: 密文在 mac 上解成空串，而 memory.config.json 会随记忆同步包跨机传输（`electron/backend/memory/sync.cjs:84` 的排除表里只有 memory.config.local.json），结果是 mac 上 LLM 调用恒 401、界面上没有任何「Key 需重填」的提示（`electron/backend/memory/index.cjs:435-438` 只在导出 JSON 时抹掉 Key）。 | `return frameworkConfig.decryptSecret(provider.apiKeyRef) \|\| "";` | 中 | P1 |
| `electron/backend/proxy/ideswitch.cjs:77` | 外部集成 | 「每账号一枚设备指纹」靠写 %APPDATA%\office-raccoon\desktop-device-identity.json 实现，mac 上 APPDATA 未定义直接 return false 静默失败 → 所有账号共用同一 clientDeviceId → 命中 `electron/backend/proxy/ideswitch.cjs:73` 记录的 200003 跨号串号规则，服务端强制作废两端会话（代码注释即依据）。这是 mac 上真正会「吊销账号」的点，比密文解不开更严重。 | `const appData = process.env.APPDATA;` | 中 | P1 |
| `electron/backend/proxy/raccoonClient.cjs:37` | 进程 | mac 上进程探测恒 false、findRaccoonExe 恒空（raccoonClient.cjs:86），「切号前先关客户端」的闸门完全失效；官方客户端运行期间会用内存态回写 auth.json（raccoonAuth.cjs:3-7 记录的掉登录根因），mac 上切完号会被客户端覆盖回旧账号。需要非 Windows 的进程探测/关闭/启动实现，或改成明确的「请先手动退出客户端」流程。 | `if (process.platform !== "win32") return false;` | 高 | P1 |
| `electron/backend/proxy/discovery.cjs:53` | 凭据 | 【workbuddy / workbuddy_ai】双区凭据文件（同一客户端的国内版与国际版各一份 auth 文件：workbuddy-desktop.info / -ai.info；$wbEncrypted 用内置常量密钥解、与平台无关，`electron/backend/proxy/wbCrypto.cjs:34`）唯一主路径是 Windows 的 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth；mac 只有 55-56 行 ~/Library/Application Support/CodeBuddyExtension/... 这个猜测候选（V28），探不到时 readdir 抛错即返回空（194-198 行），本机导入整条通道失效、只能走 state 轮询 OAuth。 | `dirs.push(path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth"));` | 中 | P1 |
| `electron/backend/proxy/wbClient.cjs:96` | 外部集成 | 【workbuddy】安装位置探测只有「PowerShell 读注册表 Uninstall 的 DisplayIcon」一路（95-109 行，HKCU/HKLM/WOW6432Node 三个根），mac 上本行直接短路返回空数组；下游 findWorkbuddyExe 也在 137 行对非 win32 返回空串，候选表又写死 ProgramFiles/ProgramFiles(x86) 与 C:\\~F:\\ 盘符（116-127 行），于是 mac 上「定位 exe → 切号后自动重启客户端」只能降级为提示手动打开（165 行）；mac 需补 /Applications 扫描或 mdfind。 | `if (process.platform !== "win32") return [];` | 中 | P1 |
| `electron/backend/adapter-codebuddy.cjs:31` | 路径 | 【codebuddy 用量源】两个候选根都基于 %LOCALAPPDATA%（CodeBuddyExtension / CodeBuddyExtension CN），mac 上回落成 ~/AppData/Local/...，detect() 恒 null → sync 跳过；mac 官方 IDE 落点未实测（V30），需补 ~/Library/Application Support 一类候选后，再验 Data/<uuid>/CodeBuddyIDE/<uuid>/history 结构是否同构。 | `const localAppData = process.env.LOCALAPPDATA \|\| path.join(homeDir(), "AppData", "Local");` | 中 | P1 |
| `electron/backend/proxy/wbClient.cjs:69` | 进程 | killWorkbuddy 在非 win32 直接返回 true 谎报「已退出」，mac 上不会真的关掉客户端，后续读文件/写回/校验仍照跑；只剩写时哈希闸（写前记文件哈希、写时比对，不一致即中止本次切号；现位于 `electron/backend/proxy/ideswitch.cjs:274` 注释、:282 判定）能发现「被官方客户端改过」并中止，表现为切号静默失败而非损坏。取舍：mac 要么补 pkill/osascript 关闭分支，要么让这一步如实失败。 | `if (process.platform !== "win32") return true;` | 中 | P1 |
| `electron/backend/proxy/wbClient.cjs:46` | 进程 | procRunning 在非 win32 恒 false → isWorkbuddyRunning 永远报「未运行」：切号确认框不弹，`electron/backend/proxy/ideswitch.cjs:694` 的「运行中却定位不到 exe 就中止」保护也永不触发。mac 方案必须同时补探测，否则连「先提醒用户关客户端」都做不到。 | `if (process.platform !== "win32") return false;` | 中 | P1 |
| `electron/backend/proxy/wbClient.cjs:75` | 进程 | 软关闭那一段 = taskkill 不带 /F（只发窗口关闭请求，让编辑器保存/询问未保存内容），纯 Win32 语义，mac 无任何等价物（需 osascript quit app 或 NSRunningApplication terminate）。不补则 mac 只剩强杀，未保存内容必丢。 | `taskkill /IM "${name}" /T` | 中 | P1 |
| `electron/backend/proxy/wbClient.cjs:82` | 进程 | 强杀用 taskkill /F /IM ... /T，其中 /T「连带整棵进程树」是 Win32 概念（Chromium 多进程）；mac 上要换成 kill -9 进程组或按 ppid 自行遍历子进程，pkill 没有 /T 的等价语义。 | `taskkill /F /IM "${name}" /T` | 低 | P1 |
| `electron/backend/proxy/raccoonClient.cjs:71` | 进程 | 小浣熊的 killRaccoon 在非 win32 同样返回 true 谎报；与 WorkBuddy 不同的是它连软关闭都没有（:74 直接 taskkill /F），mac 上「关客户端防回写」整段被跳过，而 ~/.box-agent/config/auth.json 的写回（`electron/backend/proxy/ideswitch.cjs:283`）照旧执行。 | `if (process.platform !== "win32") return true;` | 中 | P1 |
| `electron/backend/proxy/raccoonClient.cjs:22` | 进程 | 被当成本客户端的进程名写死为 Windows 可执行名（含中文的 商汤小浣熊.exe；另一个是 box-agent-acp.exe，:23）；mac 上进程名不带 .exe，按名匹配的探测/查杀全部落空，需先取 CFBundleExecutable 或 bundle id 重新取值。 | `const PROC_MAIN = "商汤小浣熊.exe";` | 低 | P1 |
| `electron/backend/proxy/raccoonClient.cjs:50` | 路径 | 第三条进程线索读 %APPDATA%\office-raccoon\lockfile；mac 会回退拼出 ~/AppData/Roaming/...（必不存在），而 mac 上 Electron 的互斥文件惯例是 ~/Library/Application Support/<app>/SingletonLock（外部惯例，V29），这条线索在 mac 需整体重写（目录与文件名都不同）。 | `process.env.APPDATA \|\| path.join(os.homedir(), "AppData", "Roaming")` | 低 | P1 |
| `electron/backend/memory/index.cjs:156` | 外部集成 | MCP 桥写进外部客户端配置的 command 就取这里（app.getPath("exe")，非 Electron 环境退回 process.execPath）：Windows 得到 <安装目录>\AgentHub.exe，mac 得到 AgentHub.app/Contents/MacOS/AgentHub——zcode/codex 配置里存的是包内二进制绝对路径，App 被移动/重装即全部失效。取舍：mac 要么接受这个脆弱路径，要么改成 bundle id + open -a 或随包附真 node（V31）。 | `appPath: electron && electron.app ? electron.app.getPath("exe") : process.execPath,` | 低 | P1 |
| `electron/backend/memory/verify.cjs:53` | 工具链 | 复用自身可执行文件当 Node 跑的全部配方就这一行：env ELECTRON_RUN_AS_NODE=1，配合 :56 command=host、:57 args=[物理 JS]、:59/:60 用 fs.existsSync 判 host/bridge 可达、:128 握手 spawn(command, args)；mac 上 command 指向 .app 内层二进制，能否以 Node 模式被外部客户端拉起，本机无法核实（V31），同一招式还用在 adapter-dsh.cjs:415。 | `const env = { ELECTRON_RUN_AS_NODE: "1" };` | 低 | P1 |
| `electron/main.cjs:247` | UI | 托盘图标直接取 build/tray.png（`tools/gen-icon.cjs:165` 由彩色 logo.png 缩成 32×32 RGBA），全仓 find 无任何 *Template*/*@2x* 文件、代码中 grep setTemplateImage 零命中：macOS 菜单栏惯例只认 alpha-only 的 xxxTemplate.png（需配套 @2x，外部惯例，V33），否则彩色图标在深浅菜单栏下都不可辨识，必须补两张 Template 图并 setTemplateImage(true)。 | `const icon = iconPath("tray.png");` | 低 | P1 |
| `src/views/skills/SkillsLibraryView.vue:102` | UI | 挂载列表只把 type 为 junction 的挂载算作「可修复」，而在非 Windows 平台上后端记录的挂载类型是 symlink（`electron/backend/mounter.cjs:18`：win32 用 junction、其余平台用目录符号链接），mac 上 brokenMounts 恒为空集合，第 161 行的「修复挂载」按钮永久 disabled，渲染层唯一调用 repair_mounts 的入口在 mac 上彻底失效（`src/api/ipc.ts:204` 是唯一出口）。 | `m.enabled && m.type === "junction"` | 低 | P1 |
| `tools/memory-llm-live-check.cjs:23` | 路径 | 用 %APPDATA%/AgentHub 拼真实 userData 去拷 Local State（safeStorage 解 Key 的前提）；mac 上 APPDATA 未定义会退成 ~/AgentHub，文件拷不到 → API Key 解不出来 → 唯一一条「真模型端到端联调」在 mac 上恒报 401 假失败，且现场像 Key 失效而不是路径错，会误导排查方向。 | `const appData0 = path0.join(process.env.APPDATA \|\| os0.homedir(), "AgentHub");` | 低 | P1 |
| `package.json:102` | 打包 | icon 只在 win 段声明为 build/icon.ico，仓库内没有任何 .icns（本机 `find . -name "*.icns" -not -path "./node_modules/*"` 零命中），工具链 `tools/gen-icon.cjs:157-166` 只产 256 的 png 与 16/32/48/256 的 ico（无 icns 生成路径）→ mac 打包要么回落 Electron 默认图标、要么在 icon 转换处报错（依赖行为，V2），且现有 icon.png 只有 256×256、不足 icns 所需源尺寸。 | `"icon": "build/icon.ico"` | 低 | P2 |
| `package.json:60` | 打包 | electronLanguages 名单写的是 zh-CN/en-US；该配置在 mac 上走的是包内 *.lproj（macOS 的本地化资源目录后缀）过滤分支（依赖实现），是否与 Electron mac 包内目录名（如 zh_CN.lproj）字面匹配、会不会把本地化资源删空需要打包后确认（V3），本机无法判定。 | `"electronLanguages": [` | 低 | P2 |
| `.github/workflows/release.yml:90` | 打包 | 发布后的门禁只校验 latest.yml（版本号 + releaseNotes 非空），没有任何 mac 清单校验步骤；将来加了 mac job 也必须同步加 latest-mac.yml 的校验，否则 mac 更新清单静默缺失也照样发版成功。 | `releases/download/v${PKG_VERSION}/latest.yml"` | 低 | P2 |
| `docs/发版作业手册.md:104` | 打包 | 发版验收口径写死为 Windows 四件套（AgentHub-Setup-x.y.z.exe、portable.exe、blockmap、latest.yml），第 109 行的 latest.yml 直链验证同样只覆盖 Windows 清单；按此手册加 mac 产物时验收清单与资产命名需要整体重写。 | `资产四件齐全：`AgentHub-Setup-x.y.z.exe`、` | 低 | P2 |
| `docs/发版作业手册.md:144` | 更新 | 手册把退出静默安装描述成 "/S --force-run"（NSIS 专有参数，且该串在 electron/main.cjs 里根本不存在，实际是 electron-updater 内部拼的 NSIS 参数），mac 没有等价的静默安装语义；这段说明在 mac 上会误导实现者。 | `（`main.cjs` 的 before-quit 钩子，`/S --force-run`）。下载与安装均由用户触发` | 中 | P2 |
| `package-lock.json:3813` | 原生依赖 | 除 koffi 外唯一会进包的平台原生依赖是 chokidar 的 fsevents（darwin-only optional、带 install 脚本，3820 行标了 "darwin"，本机未安装）：mac 上安装期会真的编译/下载它，需要确认 mac 构建机有 prebuild 或工具链（V18）。 | `"node_modules/fsevents": {` | 低 | P2 |
| `electron/backend/config.cjs:34` | 凭据 | 加密不可用时静默降级明文落盘，没有任何日志或界面告警。Windows 的 DPAPI 几乎总可用，这条分支真正被踩到是在 mac：Keychain 未就绪/被用户拒绝时 isEncryptionAvailable() 为 false，WebDAV 密码会以明文写进 config.json（外部行为，V9/V21）。 | `if (!safeStorage \|\| !safeStorage.isEncryptionAvailable()) return s;` | 中 | P2 |
| `electron/backend/sync-config.cjs:20` | 凭据 | 第二套同名前缀实现：用量统计模块自己的 ~/.Dosage_sync/config.json 也存一份 enc:v1: 密码，且它的读侧只判 safeStorage 是否存在（sync-config.cjs:39），与框架侧多一个 isEncryptionAvailable 判断的口径不同。mac 上要改密文兼容逻辑必须两处一起改，否则会出现「框架侧已重填、用量模块仍空」的半瘫状态。 | `const ENC_PREFIX = "enc:v1:";` | 低 | P2 |
| `electron/backend/proxy/store.cjs:213` | 凭据 | 网关 API Key 只有「完整值展示/复制」依赖密文；鉴权走 SHA-256 哈希实时查库（`electron/backend/proxy/store.cjs:233` 按 key_hash 查）。所以 mac 上已发出的 Key 仍然可用、只是列表里看不到完整值——迁移时不必重建或重新分发 Key，也不应把它当成阻断项。 | `secret: r.key_enc ? config.decryptSecret(r.key_enc) : "",` | 低 | P2 |
| `electron/backend/proxy/poolsync.cjs:533` | 凭据 | 归档按 deviceId 命名，而 deviceId 就存在随密文一起被搬来的 config.json 里（`electron/backend/config.cjs:341` 只在字段缺失时才新生成 UUID）。mac 沿用同一个 id 时会把 Windows 那台的 pool/archives/<id>.zip 覆盖掉，并且 run() 的 devId===myId 分支会让 mac 永不合并自己的旧包 → 两台机器静默不再共享号池。`electron/backend/sync.cjs:465` 有同类「设备 ID 被多机共用」告警，poolsync 没有任何提示，迁移时应加一条同类检测（V26）。 | `await webdav.put(remoteUrl(w, POOL_DIR, "archives", `${myId}.zip`), w, zipBuf);` | 中 | P2 |
| `electron/backend/proxy/zcodeLocal.cjs:284` | 凭据 | unseal 对「解不开的 zcode 原样密文」返回真值而不是空串（避免静默丢失的设计）。于是跨机同步回来的 relay pass_hash 会被原样写回 mac 的 credentials.json；这串是 Windows 下按 win32 派生密钥加密的，mac 官方客户端能否解开、手机远程连接会不会因此失效，必须上真机验证（V25）。 | `return s.startsWith("enc:v1:") ? s : "";` | 中 | P2 |
| `electron/backend/adapter-raccoon.cjs:33` | 路径 | 设备标识读取路径写死 Windows 目录结构，mac 上拼出 ~/AppData/Roaming/office-raccoon/... 必然读不到 clientDeviceId → getDeviceId 返回 null → 用量同步的 deviceId 回退到别的适配器或随机 UUID（`electron/backend/sync.cjs:93-99`），同一台电脑在统计里变成新设备、与 Windows 时代的历史日分片对不上号。 | `const appData = process.env.APPDATA \|\| path.join(homeDir(), "AppData", "Roaming");` | 低 | P2 |
| `electron/backend/proxy/discovery.cjs:89` | 凭据 | 【trae】本机导入的凭据文件按 <App>/User/globalStorage/storage.json 拼（discovery.cjs:99），根目录 Windows 用 %APPDATA%（88 行）、mac 用 Library/Application Support（本行），与 VSCode 系客户端的 mac 落点一致，故 trae 的「从本机软件导入」在 mac 上语义成立；探不到时 readTraeStorage 返回 null、scanTrae 静默出空数组（343-357、364 行），不影响回环 OAuth 登录。 | `roots.push(path.join(os.homedir(), "Library", "Application Support"));` | 低 | P2 |
| `electron/backend/proxy/discovery.cjs:748` | 外部集成 | 【trae】OAuth 回调走本地回环监听：首选端口 17388（`electron/backend/proxy/discovery.cjs:30`），被占用时退随机端口（:734 判断 EADDRINUSE、:737 随机端口监听），不注册系统协议、不依赖 Info.plist，mac 上照样能拿到 refreshToken/userJwt/authCode；唯一失败态是监听不到端口（:1529 的「回环端口监听失败」），mac 无需改动。（行号说明：取证快照引的是 :1495 的 `callbackUrl` 常量，该常量已被并发重构，本行已改为现工作区证据；映射见读表说明的漂移段。） | `server.listen(OAUTH_PORT, "127.0.0.1");` | 低 | P2 |
| `electron/backend/proxy/raccoonAuth.cjs:17` | 凭据 | 【raccoon】凭据真身是与官方客户端共用的 ~/.box-agent/config/auth.json，纯 homedir 拼法、mac 同路径，读写双向同步（refresh 前以文件为准、刷后合并式回写），写回用 tmp+rename 原子替换（81-82 行）在 POSIX 同样成立——本条平台无关，也是「AgentHub 与官方桌面端抢同一个 refresh_token」的唯一同步点。 | `return path.join(os.homedir(), ".box-agent", "config", "auth.json");` | 低 | P2 |
| `electron/backend/proxy/index.cjs:361` | 外部集成 | 【raccoon】office-raccoon:// 深链是在 AgentHub 自己的 BrowserWindow 里拦下的（webRequest + setWindowOpenHandler:367 + will-navigate:372 + will-redirect:378 + did-fail-load:384 五路兜底），不注册系统协议也能拿到一次性授权码、不会惊动官方客户端——mac 上同样成立，不需要 Info.plist 的 CFBundleURLTypes。 | `webRequest.onBeforeRequest({ urls: ["office-raccoon://*"] }, (details, callback) => {` | 低 | P2 |
| `electron/backend/adapter-codex.cjs:20` | 路径 | 【codex 用量源】数据目录是 homedir/.codex（只读 rollout jsonl 与 archived_sessions），mac 与 Windows 同路径、无 Windows API 与原生库依赖，属平台无关源，迁移零改动。 | `return path.join(homeDir(), ".codex");` | 低 | P2 |
| `electron/backend/adapter-reasonix.cjs:49` | 路径 | 【reasonix 用量源】已显式做平台分支：只在 win32 且 APPDATA 存在时加 %APPDATA%\reasonix，其余平台落 ~/.reasonix（52 行）——这是仓内现成的跨平台样板，可直接照搬到 adapter-trae-common.cjs:31-33 与 adapter-codebuddy.cjs:27-36 两处。 | `if (process.platform === "win32" && process.env.APPDATA) {` | 低 | P2 |
| `electron/backend/adapter-qoder-common.cjs:55` | 路径 | 【qoder / qoder-cn 用量源】目录只拼 homedir/<dirName>（~/.qoder、~/.qoder-cn），mac 同路径、无 Windows 依赖，平台无关。 | `return path.join(homeDir(), dirName);` | 低 | P2 |
| `electron/backend/adapter-antigravity-common.cjs:171` | 路径 | 【antigravity / antigravity-ide 用量源】读 ~/.gemini/<homeSub>（homedir 拼法），老数据恢复适配器也已备好 .app 内的 language_server 候选（adapter-antigravity-legacy.cjs:72-75），整族在 mac 上路径层面无需改动，只待确认 mac 官方客户端确实仍落 ~/.gemini（V30）。 | `return path.join(homeDir(), ".gemini", homeSub);` | 低 | P2 |
| `electron/backend/proxy/ccswitch.cjs:77` | 外部集成 | 【生态接入 · CC Switch】写的是 CC Switch 自己的库 ~/.cc-switch/cc-switch.db（73 行同目录；写前 VACUUM INTO 备份 354 行），homedir 拼法 mac 同路径；该通道依赖对方软件安装（库不存在即 348 行报「未检测到 CC Switch」），mac 侧只需确认 CC Switch mac 版用同一目录（V30），AgentHub 侧无需平台分支。 | `return process.env.CCSWITCH_DB_PATH \|\| path.join(os.homedir(), ".cc-switch", "cc-switch.db");` | 低 | P2 |
| `electron/backend/proxy/wbClient.cjs:99` | 路径 | 唯一命中「注册表」的生产代码行：用 PowerShell 读 HKCU/HKLM Uninstall 的 DisplayIcon 定位安装 exe（覆盖装在非标准盘符的情况）；mac 无注册表，该函数在非 win32 直接 return []（同文件 :96），等价物只能改为扫 /Applications/*.app 的 Info.plist。 | `Where-Object { $_.DisplayIcon }` | 低 | P2 |
| `electron/backend/proxy/zcodeLocal.cjs:860` | 进程 | 全仓唯一的 mac 进程等价物：非 win32 走 pkill（探测配对 :846 pgrep、:909 which），说明「平台分支」这家已有先例，WorkBuddy/小浣熊可照此模式补；但它是按名匹配（:860 的 pkill -i zcode 兜底比 Windows 端精确名更宽），mac 实现建议按完整路径或包名收窄以免误伤同名进程。 | `pkill -9 -x ZCode \|\| pkill -9 -x zcode \|\| pkill -9 -i zcode` | 低 | P2 |
| `electron/backend/adapter-antigravity-legacy.cjs:418` | 进程 | 全仓唯一命中 WMI 的进程查杀：写临时 .ps1 用 Get-CimInstance Win32_Process 按 CommandLine 过滤 language_server.exe（language_server，简称 LS，是 antigravity 的后台语言服务进程），再 process.kill(pid, SIGTERM)（:430）；mac 上 PowerShell/WMI 均不存在，异常被 :432 静默吞掉 → 上轮被强杀的孤儿 LS 进程永远清不掉，会占着端口影响后续同步。 | `Get-CimInstance Win32_Process -Filter "Name='language_server.exe'"` | 中 | P2 |
| `electron/backend/memory/verify.cjs:23` | 路径 | 桥脚本定位的候选②把 appPath 同级的 'resources'（小写）拼上去：Windows 安装布局成立，mac 布局是 Contents/Resources（候选① 用 process.resourcesPath 才对），这条在 mac 恒不成立，只因候选① 先命中才没暴露；纯路径拼接，不涉系统 API。 | `path.join(path.dirname(appPath), "resources", "mcp", "mcp-memory-server.cjs")` | 低 | P2 |
| `electron/backend/memory/verify.cjs:37` | 路径 | 宿主可执行判定的快路径要求 appPath 存在且以 .exe 结尾（/\\.exe$/i）：mac 包内二进制无扩展名，这一句恒不成立，只能靠下面的候选表兜回，而表里 :41/:42 两条是 LOCALAPPDATA / Program Files 的 Windows 路径（mac 同为死路径）。 | `if (appPath && fs.existsSync(appPath) &&` | 低 | P2 |
| `build/installer.nsh:10` | 更新 | 更新/卸载前按镜像名强杀 AgentHub.exe（含被外部客户端以 ELECTRON_RUN_AS_NODE 常驻、握着主程序镜像锁的 MCP 桥）。这是 NSIS/Win32 专有：mac 既没有这个钩子，也没有「运行中的可执行文件删不掉」这一 Win32 文件系统现象（POSIX 允许 unlink），残留桥对 mac 更新多半无害；需要确认的是 mac 更新链路确无等价需求（V12）。 | `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"` | 中 | P2 |
| `electron/main.cjs:248` | UI | tray.png 缺失或解码失败时会回退 256×256 的彩色 icon.png，而 macOS 菜单栏按约 22px 渲染，回退图会被压成一团彩色且与状态栏其他图标格格不入（外部行为，V33）。 | `tray = new Tray(icon.isEmpty() ? iconPath("icon.png") : icon);` | 低 | P2 |
| `electron/main.cjs:251` | UI | 唤回窗口只挂了 double-click（243 行 setContextMenu、249 行 setToolTip 已有）；macOS 上左键点击托盘即弹出 context menu，double-click 在设了 context menu 之后是否仍触发需实机确认，否则 mac 用户只能靠菜单项「显示主界面」（V34）。 | `tray.on("double-click", showWindow);` | 低 | P2 |
| `electron/main.cjs:75` | UI | autoHideMenuBar 只对 Windows/Linux 的窗口菜单栏生效，macOS 用全局顶部菜单栏因此该参数无效；全仓 grep setApplicationMenu 零命中（Menu 只在 main.cjs:230 用于托盘），mac 上会显示 Electron 默认应用菜单（含 Cmd+Q 退出、Cmd+R 重载、开发者工具），与「只从托盘退出、关窗缩托盘」的设计不一致（V35）。 | `autoHideMenuBar: true,` | 中 | P2 |
| `electron/main.cjs:74` | 打包 | BrowserWindow 的 icon 在 macOS 被忽略、程序坞（Dock）图标只由 .app 内的 .icns 决定，而 grep app.dock 零命中（没有 app.dock.setIcon），build/ 下只有 icon.ico/icon.png/tray.png 无 .icns，package.json:87-114 也只有 win/nsis/portable 目标（grep "mac" 零命中）——mac 上程序坞会显示 Electron 默认图标（V36）。 | `icon: iconPath("icon.png"),` | 中 | P2 |
| `electron/main.cjs:273` | UI | 三处通知都自备 icon（main.cjs:273/283/304），updater 另有独立实现（updater.cjs:79 走 notifyIcon()，路径 resourcesPath/build/icon.png 本身跨平台可用）；macOS 通知的图标来自 .app 包图标、Notification 构造参数 icon 不生效（外部行为，V36），未签名或包内无 icns 时通知中心会显示 Electron 图标。 | `icon: iconPath("icon.png"),` | 低 | P2 |
| `electron/backend/ipc.cjs:398` | 路径 | 全仓 grep showItemInFolder 零命中，「打开目录/文件」统一走 shell.openPath（ipc.cjs:101/106/398、`electron/backend/memory/index.cjs:691`、`electron/backend/proxy/index.cjs:771/775`、sync-ipc.cjs:384）；打开目录在 mac 上等价于访达打开，但本行打开的是同步报告文件，mac 会直接用默认应用打开而不是在访达中定位，若产品预期是「在访达中显示」需改 showItemInFolder（**注意：这是共享代码路径，改了 Windows 也变**，默认不改，见 D6 与第 8 节账目）。 | `await shell.openPath(p);` | 低 | P2 |
| `electron/backend/config.cjs:53` | 路径 | 纯 Node 环境（tools/*.cjs 直接 require 框架 config）下 electronApp 为 null，且 mac 上不存在 APPDATA 环境变量，dataDir 会落到 ~/AgentHub，而主进程用 getPath("userData")=~/Library/Application Support/AgentHub，二者在 mac 上分裂成两份 config.json（Windows 上前者恰好等于 %APPDATA%\AgentHub 才没暴露），自测脚本与 App 会读写不同配置（V22）。 | `path.join(process.env.APPDATA \|\| os.homedir(), "AgentHub")` | 中 | P2 |
| `electron/backend/sync-ipc.cjs:473` | 进程 | 开机自启有两处独立写入：`electron/backend/config.cjs:415`（读框架 schedule.autoStart，且未打包直接 return）与本行（读渲染层传的 enabled，只挡便携版），而 macOS 登录项按 .app 粒度只有一条，两处配置不一致时后写覆盖先写，用户会看到开关自己弹回去（V40）。 | `app.setLoginItemSettings({ openAtLogin: !!args.enabled });` | 低 | P2 |
| `electron/backend/config.cjs:130` | UI | 默认开启「关窗缩到托盘」（main.cjs:109-115 拦截 close 后 hide），mac 上红叉与默认菜单的 Cmd+W 都只是隐藏窗口且无任何首次提示，而唤回入口只有菜单栏托盘图标（受 main.cjs:247 无 Template 影响可能不显眼），用户容易以为应用卡死（V38）。 | `minimizeToTray: true, // 关窗缩到托盘` | 低 | P2 |
| `src/views/skills/SkillsSkillDetailView.vue:155` | UI | 挂载类型徽标只有 junction 与「复制」两种取值，mac 上真实类型是 symlink，会被显示成「复制」，用户会误以为工具目录里是独立副本（同页 145 行文案也写「各工具目录中的 Junction」）。 | `{{ m.type === "junction" ? "Junction" : "复制" }}` | 低 | P2 |
| `src/views/skills/SkillsSyncView.vue:142` | UI | 同步确认页按 plan.mode 只区分「复制模式 / Junction 共用模式」，mac 上后端执行的是目录符号链接，界面术语与事实不符，用户无法从文案判断自己选了哪种挂载方式。 | `{{ plan.mode === "copy" ? "复制模式" : "Junction 共用模式" }}` | 低 | P2 |
| `src/types/index.ts:220` | 路径 | 配置类型 mountMode 只允许 junction 或 copy，symlink 没进配置联合类型（对比同文件 29 行 SkillMount.type 已有 symlink），mac 上即便 UI 补了符号链接选项，这个值也存不进配置、传不到主进程。 | `mountMode: "junction" \| "copy";` | 低 | P2 |
| `src/components/config/ConfigSkillsSection.vue:365` | UI | 「挂载模式」只给 Junction（推荐）与复制两个选项，且第 368 行理由写「建立目录联接，无需管理员权限」——这是 Windows 免管理员建 junction 的理由；mac 上后端实际建目录符号链接，该选项名在 mac 上无处对应，默认值同形见 `src/stores/app.ts:15`。 | `<el-radio value="junction" border>` | 低 | P2 |
| `src/components/config/ConfigGeneralSection.vue:345` | UI | 开机自启说明把平台写死成 Windows，且「注册的会是临时副本」指注册表自启；mac 上应改为登录项（Login Items，即 macOS 的「登录时打开」条目），文案与后端实现都要按平台分支。 | `{{ isPortable ? "便携版不支持开机自启（注册的会是临时副本）" : "登录 Windows 后自动运行 AgentHub，改动即时生效" }}` | 低 | P2 |
| `src/components/config/ConfigGeneralSection.vue:360` | UI | 「关闭最小化到托盘」的说明按 Windows 语义写（点关闭按钮不退出、托盘菜单「退出」才是真正退出）；mac 上关红灯本就是隐藏窗口、常驻入口是 Dock 与菜单栏图标、退出习惯是 Cmd+Q，文案与主进程行为都要按平台改。 | `<div class="set-desc">点关闭按钮不退出，仅最小化到托盘（托盘菜单「退出」才是真正退出）</div>` | 低 | P2 |
| `src/components/config/ConfigDataSection.vue:227` | UI | 按钮说明固定写「在资源管理器中打开用量统计缓存目录」，mac 上主进程实际会调到 Finder，文案需按平台改为「在访达中打开」。 | `<div class="s-desc">在资源管理器中打开用量统计缓存目录</div>` | 低 | P2 |
| `src/views/sync/BillingRulesView.vue:815` | UI | 计费公式行内 code 的字体栈是 Cascadia Code 与 Consolas（两级都是 Windows 自带字体），mac 上全部缺失、只能落到通用 monospace，字形与设计稿不一致；全站其它代码块走 --font-code（global.css:85，已含 SF Mono）所以只有这一处露馅。 | `font-family: "Cascadia Code", Consolas, monospace;` | 低 | P2 |
| `src/styles/global.css:190` | UI | -webkit-font-smoothing: antialiased 是只在 macOS 生效的属性（Windows 上无效），会把 13px 正文渲染得比 macOS 原生更细更暗，两边视觉稿无法对齐（V37）。 | `-webkit-font-smoothing: antialiased;` | 低 | P2 |
| `src/styles/global.css:1283` | UI | 全局 ::-webkit-scrollbar 固定 8px 常显，Chromium 一旦样式化滚动条就放弃 macOS 的 overlay 自动隐藏滚动条，会忽略系统「显示滚动条」偏好、并把 8px 计入布局宽度，mac 上观感与原生应用明显不同（V38）。 | `::-webkit-scrollbar {` | 低 | P2 |
| `src/styles/global.css:1299` | UI | 注释写明常态有效布局宽度恒为 1280、由主进程按窗口宽度整页缩放（0.7~1.25 连续值）撑住，下面的断点只为浏览器预览兜底；这套「按窗口宽度缩放」是按 Windows 显示缩放场景设计的，mac Retina 上非整数 zoomFactor 会让文字不走整数设备像素（清晰度待真机验证，V37）。 | `Electron 下主进程按窗口宽度整页缩放（1280 基准、0.7~1.25 钳制），` | 中 | P2 |
| `src/api/mock.ts:449` | 路径 | 浏览器预览兜底 mock 里的路径全是 C 盘 Users 目录形态的 Windows 绝对路径（该行是 get_hub_dir 的返回值；分支在 :448）；mock 只在 window.agenthub 缺失（dev:web 预览）时启用，见 `src/api/ipc.ts:82` 的 call 分支，mac 上做预览或截图会展示 Windows 假数据。（行号：取证快照为 :445。） | `return "C:\\Users\\demo\\.agent_skills";` | 低 | P2 |
| `tools/memory-llm-live-check.cjs:48` | 路径 | 同一脚本把记忆库根目录也写成 Windows 形态 ~/AgentHub/memory；该脚本注释里写的「mac 真实库在 ~/Library/Application Support/AgentHub/memory」**不成立**（记忆库默认根恒为 ~/AgentHub/memory，见订正 2），因此 mac 上这两行路径其实与 Windows 同形；真正的风险是与框架配置目录（`electron/backend/config.cjs:53`）分裂，与 23 行是两处独立路径（修 23 不解 23 之外的语义问题）。 | `const SRC = path.join(os.homedir(), "AgentHub", "memory");` | 低 | P2 |
| `tools/memory-ui-check.cjs:15` | 工具链 | 无头 UI 探针的用法注释只给 ./node_modules/electron/dist/electron.exe；mac 上按文档执行必然失败（无 electron.exe），必须改 ./node_modules/.bin/electron 或 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron，同型写死还见于 memory-layout-check.cjs:18、memory-ui-round3.cjs:19、memory-ui-round4.cjs:18，属复制粘贴传播，建议一次性收敛到一处文档/一个 npm script。 | `//   ./node_modules/electron/dist/electron.exe tools/memory-ui-check.cjs` | 低 | P2 |
| `tools/memory-runtime-smoke.cjs:27` | 工具链 | 这条 exe 路径不只写在注释里，而是运行时真的打印给用户的报错文案；mac 上跑到这里会被指引去执行一个不存在的 electron.exe，建议文案改成按 process.platform 或 process.execPath 生成。 | `./node_modules/electron/dist/electron.exe tools/memory-runtime-smoke.cjs` | 低 | P2 |
| `tools/proxy-zcode-selftest.cjs:3` | 工具链 | ELECTRON_RUN_AS_NODE 系列的用法行把「POSIX 前置环境变量语法」和「Windows 的 electron.exe」混在一句里：mac 上前置语法对、二进制路径错，Windows CMD 里则反过来；mac 应写成 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tools/xxx.cjs，proxy-wb-selftest.cjs:3 同型。 | `//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-zcode-selftest.cjs` | 低 | P2 |
| `tools/memory-smoke.cjs:9` | 工具链 | memory-smoke / memory-smoke-p1 / memory-smoke-fixes / memory-smoke-v1260 / v1270 / v1280 / antigravity-legacy-smoke / memory-import-batch-smoke / proxy-smoke 全家族的用法行统一写 electron.exe；这些脚本依赖 Electron 内置 Node 22 的 node:sqlite（本机系统 Node v16.20.2 实测 node -e "require('node:sqlite')" 报 ERR_UNKNOWN_BUILTIN_MODULE），所以 mac 上必须换成项目内 electron 才能跑，批量改文案即可。 | `// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke.cjs [--root <dir>]` | 低 | P2 |
| `tools/proxy-smoke.cjs:9` | 路径 | 把 APPDATA 当沙箱钩子（依赖 `electron/backend/config.cjs:53` 纯 Node 分支读 APPDATA），mac 上凑巧也能生效；风险在于这是语义上的 Windows 变量，一旦 config.cjs 按平台改走真实 userData，探针会直接写进用户真实数据目录。建议统一改用 `electron/backend/config.cjs:51-53` 已支持的 AGENTHUB_DATA_DIR（`scripts/test-devicemid.cjs:11` 已是这个正确写法）。 | `process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub` | 低 | P2 |
| `tools/proxy-regress.cjs:14` | 路径 | WB（WorkBuddy）登录态目录用 process.env.LOCALAPPDATA \|\| "" 拼，mac 上 LOCALAPPDATA 未定义会退化成相对 cwd 的路径 → 读不到文件，探针静默走「本机无登录文件」分支继续，看结果分不清是环境不对还是功能坏了。 | `path.join(process.env.LOCALAPPDATA \|\| "", "CodeBuddyExtension", "Data", "Public", "auth")` | 低 | P2 |
| `tools/memory-import-batch-smoke.cjs:164` | 路径 | 该断言用「盘符编码目录名」造 fixture，而 `electron/backend/memory/layout.cjs:154` 的反解正则要求首字符是字母；本机用同一正则实测：Windows 形 c-Users-hui 命中、mac 形 /-rs-hui 不命中，因此 mac 上 reverseSessionDirName 返回空串、这条断言必红（不是功能坏了，是 fixture 平台形态写死）。 | `${home[0].toLowerCase()}-${home.slice(3).split(path.sep).join("-")}` | 中 | P2 |
| `tools/gen-sync-css.cjs:9` | 路径 | 源样式表路径写死成另一个工程的 Windows 绝对路径；mac 上 readFileSync 直接 ENOENT，脚本完全无法运行（一次性代码生成器，产物 src/styles/sync.css 已入库，只有需要重生成时才受影响）。 | `const SRC = String.raw`E:\idea work\用量记录同步\src\styles\global.css`;` | 低 | P2 |
| `tools/proxy-wb-selftest.cjs:34` | 进程 | 这是 tools 下 46 个脚本里唯一命中 process.platform 的文件（本机 `grep -rl "process.platform" tools/ \| wc -l` = 1），非 Windows 时进程类红线断言（T5 等）静默跳过，最后仍打印 PASS —— mac 上是「假绿灯」：跑得过，但覆盖不到它本来守的那几条红线，建议在收尾输出里显式打印「本平台跳过 N 项」。 | `const isWin = process.platform === "win32";` | 低 | P2 |
| `package.json:83` | 工具链 | tools 下 46 个 + scripts 下 4 个 `.cjs`（本机 `find tools scripts -name "*.cjs" \| wc -l` = 50）里只有这一个随包发布（→ resources/mcp/mcp-memory-server.cjs）且是运行时依赖：Agent 接入的命令行由 `electron/backend/memory/verify.cjs:22-33` 拼、以 ELECTRON_RUN_AS_NODE 拉起；它自身路径候选已含 mac/Linux 标准路径（tools/mcp-memory-server.cjs:34/36），所以用户正常使用不会被这套自测影响，其余 49 个文件都是开发/发版期手动工具，据此判整体 P2。 | `"from": "tools/mcp-memory-server.cjs",` | 低 | P2 |

**统计：共 107 条，其中 P0 6 条 / P1 42 条 / P2 59 条。**

**读表说明**

- 「类别」按失效面归口（打包 / 更新 / 原生依赖 / 凭据 / 进程 / 路径 / UI / 工具链 / 外部集成），同一根因在不同文件里出现时会各占一行——排查时先按根因合并。
- **P0 的构成**：6 条 = 3 条「mac 产物产不出」（`.github/workflows/release.yml:22`、`:68`、`package.json:47`）+ 3 条同一处 koffi require 链的三个放大点（`electron/backend/sqlcipher.cjs:13`、`electron/backend/sync-adapter.cjs:18`、`electron/main.cjs:15`，**合并计数只有 1 个运行时根因**）。优先级口径：P0 = 阻断「mac 上能跑」或损坏数据；P1 = 功能降级/静默失效但应用可用；P2 = 体验、工具链、发版口径。
- 行号是本次复核时点的工作区快照，动手时用关键字（如 `process.platform`、`APPDATA`、`sqlcipher.dll`、`latest.yml`）重新定位。
- 表中个别「代码证据」单元格把源码里的 `||` 记成了全角 `\|\|`（例如 `adapter-trae-common.cjs:32`、`config.cjs:53`、`zcodeLocal.cjs:860`），这是取证转录时的转义；以仓库实际代码为准，行号与结论不受影响。
- **缩写与简称（首次出现的展开）**：WB / WorkBuddy＝WorkBuddy 桌面客户端（中国区 WorkBuddy.exe 与国际版 WorkBuddyAI.exe 是两个互不相干的进程；数据目录名恰好叫 CodeBuddyExtension，与腾讯 CodeBuddy、Trae 系列同机共存，进程名不可通配，见 `electron/backend/proxy/wbClient.cjs:8-11`）；双区凭据文件＝中国区与国际版各一份 auth 文件（`electron/backend/proxy/discovery.cjs:11-13`）；写时哈希闸＝切号写文件前记哈希、写时比对、不一致即中止（`electron/backend/proxy/ideswitch.cjs:274/282`）；LS＝antigravity 的 language_server 进程（`electron/backend/adapter-antigravity-legacy.cjs:418`）；ZCV1:（前缀常量 `ZSEAL_PREFIX`，`electron/backend/proxy/zcodeLocal.cjs:266`）＝本机 safeStorage 信封密文；raw key＝SQLCipher 直接以 32 字节密钥解密、跳过口令派生（`electron/backend/sqlcipher.cjs:111`）；dylib＝macOS 动态库；icns/.lproj＝macOS 应用图标 / 本地化资源目录；MCP 桥＝以 ELECTRON_RUN_AS_NODE 拉起 mcp-memory-server.cjs 的常驻进程（`electron/backend/memory/verify.cjs:53`）。
- 表中「说明」列内出现的少数不带仓库前缀的文件名（如 `Provider.js:40-42`、`MacUpdater.js:240`、`pool.cjs:46`），指的是 **electron-builder / electron-updater 依赖树里的文件**，不在本仓库源码内、不参与引用核对；涉及它们的结论在第 2、3 节与第 7 节按「依赖实现/外部事实（本次未复核）+ 复核命令」处理。
- **行号漂移（本次复核实测，表格与正文已同步改用现号）**：并发外部改动导致下列行号移位——`electron/backend/config.cjs` 设备 ID 生成/重新封信/开机自启：:340/:384/:414 → **:341/:385/:415**；`electron/backend/proxy/ideswitch.cjs` 写时哈希闸：:268 → **注释 :274、判定 :282**；`electron/backend/proxy/discovery.cjs` 回环回调常量（原 :1495 的 `callbackUrl`）已被重构 → **:737/:748**（失败文案 :1529）；`electron/backend/proxy/index.cjs` 的 `rememberRunning` → **:457-462（写盘 :462）**；`src/api/mock.ts` 的 `get_hub_dir` → **:448/:449**。`electron/backend/proxy/store.cjs` 的并发改动已按「只读调研」要求撤销、恢复为 HEAD 版本，其 :213/:296/:358 已逐行复核与表中证据逐字一致。抽查未漂移：`electron/backend/config.cjs:22/29/34/45/53/130`、`electron/backend/proxy/ideswitch.cjs:77`、`electron/backend/proxy/index.cjs:361/771/775`、`electron/backend/proxy/discovery.cjs:53/56/89`、`src/types/index.ts:220`、`tools/proxy-smoke.cjs:9`、`src/stores/app.ts:15`、`package.json:47/60/79/83/87/102/105`。并发改动仍在进行，实施前请再按关键字核对一次。

**本机复核后的补充与订正（3 条，均可在仓库内复现）**

1. `package-lock.json:4469` 那一行是 koffi 包内的 `optionalDependencies` 声明（本机实读 4469/4470）；两个 darwin 包的**实体解析条目**在 `package-lock.json:899-928`（`node_modules/@koromix/koffi-darwin-arm64`、`-x64`，version 3.3.0、`os: darwin`、`cpu: arm64/x64`、`optional: true`）。引用时按用途选：论证「lock 里有没有」用 899-928，论证「koffi 声明的可选依赖」用 4469。
2. 取证材料里 `tools/memory-llm-live-check.cjs:48` 一行的结论（「mac 真实库在 ~/Library/Application Support/AgentHub/memory」）**不成立**：记忆库默认根由 `electron/backend/memory/config.cjs:19` 的 `defaultRoot()` 决定，恒为 `~/AgentHub/memory`，解析链在 `electron/backend/memory/index.cjs:122-124`（`expandHome(fromRepo || fromFramework || defaultRoot())`）；Windows 与 mac 同路径、无需迁移。真正的分裂风险在框架配置目录（`electron/backend/config.cjs:53`，V22）。
3. `package.json:47` 的 `electronDist` 只在「把 Windows 工作区（含依赖目录）原样拷到 mac」这一读法下才会让打包失败（依赖实现，V1）；本机可核实的事实基础是：本机依赖目录里只有 electron.exe、没有 `Electron.app`（`ls` 实读）。因此本方案对它的处置是「**不动该行 + 写死构建纪律**（mac 构建必须全新 `npm ci`）」，这也与第 1 节表格该行的「本方案处置」一致——表格旧措辞不是本方案的建议。

## 2. 平台适配策略

分三档处置：**抽适配层的（2.1）／一个 `process.platform` 分支就够的（2.2）／mac 上直接降级或隐藏的（2.3）**。判据只有一条：同一语义在 ≥3 个调用点重复出现、或需要新的返回结构/错误语义时，才值得新模块；否则就地加一个 if。2.5 是给不熟悉 macOS 打包/签名/更新的读者准备的术语表。

### 2.1 (a) 值得抽平台适配层的四类

**A. 原生动态库加载（SQLCipher + koffi）**

- 证据：`electron/backend/sqlcipher.cjs:13`（顶层 require koffi）、`:22-30`（`dllDir()` 只认 `sqlcipher.dll`）、`:33-42`（先预载 libcrypto/libssl 再载本体）、`:111`（raw key，从不设 `cipher_compatibility`）、`:67-75`（`available()` 必须返回 false 而不是抛）。
- 为什么一个 if 不够：换文件名只解决 `:27`，解决不了另外三件事——① 搜索目录（mac 是 `Contents/Resources/sqlcipher`，现有 `process.resourcesPath` 拼接 `:24` 恰好可用）；② 依赖加载顺序（`:40-41` 的 Win32 OpenSSL 预载在 mac 上要么没有对应 dylib、要么不存在这种顺序敏感性）；③ **错误语义**（加载失败必须停在 `available()=false`，让 `electron/backend/adapter-trae-common.cjs:116-117` 走业务错、`electron/backend/sync.cjs:339` 吞错继续；一旦在顶层抛出，就升级成主进程 require 期崩溃）。
- 接口形态（导出面不变，上游零改动）：`dllDir()`、`ensureLib()`、`available()`、`open(dbPath)`、`close(db)`、`queryAll(db, sql)`；新增内部函数 `platformLibName()`（`sqlcipher.dll` / `libsqlcipher.dylib`）、`platformDeps()`（win 返回两个 dll，darwin 返回空数组或随包 dylib 列表）。
- 落点：**原地重构** `electron/backend/sqlcipher.cjs`，不新建目录。

**B. 凭据加解密（跨平台密文语义）**

- 证据：`electron/backend/config.cjs:29`（`ENC_PREFIX`）、`:34`（不可用时明文降级）、`:38-47`（解不开返回空串）、`:385`（保存时把内存值重新封信）；`electron/backend/sync-config.cjs:20/26-34/37-45`（第二套同名前缀实现，读侧口径不同）；`electron/backend/proxy/store.cjs:296/358`（token 可用性判定）；`electron/backend/memory/providers.cjs:178`（内存 Key 解出即用）。
- 为什么一个 if 不够：① 有 **两套独立实现**（框架 `electron/backend/config.cjs` 与用量 `electron/backend/sync-config.cjs`），各写一个 if 必然漂移，结果是「框架侧已重填、用量模块仍空」；② 真正要改的是**返回值语义**——今天「解不开 = 空串」，配合 `electron/backend/config.cjs:385` 会把 Windows 密文永久清空；跨平台需要 `{ ok, value }`，让调用方在 `!ok` 时保留原密文并触发重填提示；③ 调用点有四个（config / sync-config / store / providers），需要统一。
- 接口形态：`electron/backend/credential.cjs` 导出 `ENC_PREFIX`、`seal(plain) -> string`、`unseal(stored) -> { ok: boolean, value: string }`、`canSeal() -> boolean`。Windows 语义保持（DPAPI 下 ok=true、值不变；解不开时 ok=false），**只有调用方的写回行为变化**（不再写空），这是本方案唯一改变落盘数据的点，必须单开回归窗口（见第 8 节账目）。
- 落点：新增 `electron/backend/credential.cjs`（约 60 行）；`electron/backend/config.cjs`、`electron/backend/sync-config.cjs` 改为调用；`electron/backend/proxy/store.cjs:296` 只读，可保持现状或改调用（建议改，统一缓存）。

**C. 外部客户端探测 / 关闭 / 启动（进程与安装位置）**

- 证据：`electron/backend/proxy/wbClient.cjs:46`（探测）、`:69`（强杀谎报）、`:75`（软关闭 taskkill 不带 /F）、`:82`（强杀 /T）、`:96/137`（注册表→exe 定位）；`electron/backend/proxy/raccoonClient.cjs:22-23`（进程名写死 .exe）、`:37/71/86`（探测/查杀/定位的 win32 短路）；`electron/backend/proxy/zcodeLocal.cjs:846/860/909`（仓内唯一已实现的 mac 分支，可直接照抄）。
- 为什么一个 if 不够：每个客户端有 5 件事（探测 / 软关闭 / 强杀 / 定位 / 启动），3 个客户端 × 2 平台 = 30 个组合；且 OS 原语语义不等价——`taskkill /T` 的「整棵进程树」在 mac 没有对应（`electron/backend/proxy/raccoonClient.cjs:74`）、软关闭只能是 `osascript -e 'quit app …'`（`electron/backend/proxy/wbClient.cjs:75` 的语义）、启动是 `open -a`、mac 进程名不带 `.exe`（`electron/backend/proxy/raccoonClient.cjs:22`），定位要从注册表换成 `/Applications` 扫描或 `mdfind`（`electron/backend/proxy/wbClient.cjs:99`）。逐点加 if 会把 30 个组合散落在两个文件里。
- 接口形态：`electron/backend/proxy/clientHost.cjs` 导出 `isRunning(id) -> boolean`、`quit(id, { force }) -> boolean`、`findExe(id) -> string`、`launch(id) -> boolean`、`userDataDir(vendor) -> string`；`id ∈ {"workbuddy","workbuddy-ai","raccoon"}`。**Windows 分支 = 现有实现原样平移（命令串、超时、返回值逐字保留）**，darwin 分支新增。
- 落点：新增 `electron/backend/proxy/clientHost.cjs`（约 150 行）；`electron/backend/proxy/wbClient.cjs` / `electron/backend/proxy/raccoonClient.cjs` 保持对外导出同名同参，内部改为调用（`electron/backend/proxy/ideswitch.cjs`、`electron/backend/proxy/zcodeSwitch.cjs` 的编排零改动）。
- 边界：这条不做，mac 上「先关客户端再切号」整段是静默假成功（`electron/backend/proxy/wbClient.cjs:69`、`electron/backend/proxy/raccoonClient.cjs:71` 非 win32 直接 return true），且 `electron/backend/proxy/ideswitch.cjs:694` 的「运行中却定位不到就中止」保护永不触发。

**D. 系统共享目录定位（%APPDATA% / %LOCALAPPDATA% → ~/Library/Application Support）**

- 证据：`electron/backend/adapter-trae-common.cjs:32`、`electron/backend/adapter-codebuddy.cjs:31`、`electron/backend/adapter-raccoon.cjs:33`、`electron/backend/proxy/ideswitch.cjs:77`、`electron/backend/proxy/raccoonClient.cjs:50`、`electron/backend/proxy/discovery.cjs:53-56`（已有 darwin 候选）。
- 为什么一个 if 不够：6 个调用点、两种语义（roaming、local），mac 的「同义词」是 `~/Library/Application Support/<vendor>` 且需要 vendor 维度参数；每处各写一个三元必然出现路径漂移（今天已经有 `~/AppData/Roaming` 这种回落值出现在 4 处）。
- 接口形态：`electron/backend/osdirs.cjs` 导出 `roaming() -> string`、`local() -> string`、`vendorSupport(vendor) -> string`；**Windows 分支返回值必须与今天逐字一致**（`process.env.APPDATA || path.join(home, "AppData", "Roaming")`）。
- 落点：新增 `electron/backend/osdirs.cjs`（约 30 行）；替换 5 处调用（`electron/backend/proxy/discovery.cjs:53-56` 已有分支，保留不动）。

### 2.2 (b) 只用一个 `process.platform` 分支就够的（逐条）

| # | 文件:行号 | 该分支的判定条件与动作 |
| --- | --- | --- |
| 1 | `electron/backend/mounter.cjs:18` | `process.platform === "win32" ? "junction" : "symlink"`（已实现，mac 侧只需渲染层认这个值） |
| 2 | `electron/backend/mounter.cjs:54` | `fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir")`（已实现） |
| 3 | `electron/backend/adapter-reasonix.cjs:49` | `process.platform === "win32" && process.env.APPDATA` 才追加 `%APPDATA%\reasonix`，否则落 `~/.reasonix`（仓内样板，照抄） |
| 4 | `electron/backend/proxy/discovery.cjs:55-56` | `process.platform === "darwin"` 追加 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth`（已实现，真值待验证 V28） |
| 5 | `electron/backend/proxy/discovery.cjs:89-90` | `process.platform === "darwin"` 追加 `~/Library/Application Support`（已实现） |
| 6 | `electron/backend/proxy/zcodeLocal.cjs:846` | 非 win32 走 `pgrep -x ZCode \|\| pgrep -x zcode \|\| pgrep -i zcode`（已实现） |
| 7 | `electron/backend/proxy/zcodeLocal.cjs:860` | 非 win32 走 pkill 三级兜底（已实现；建议 mac 收窄匹配以免误伤同名进程） |
| 8 | `electron/backend/proxy/zcodeLocal.cjs:909` | 非 win32 用 `which zcode \|\| which ZCode`（已实现） |
| 9 | `electron/main.cjs:247` | `process.platform === "darwin"` 时取 `trayTemplate.png` + `setTemplateImage(true)`；Windows 分支保持 `tray.png` 逐字不变 |
| 10 | `electron/backend/memory/verify.cjs:37` | 宿主判定 `/\\.exe$/i`：darwin 直接接受 `Contents/MacOS/AgentHub`（一个条件分支；`:23` 候选②在 mac 恒不成立，但候选① `process.resourcesPath`（`:22`）先命中，可不改只加注释） |
| 11 | `electron/backend/updater.cjs:13` | `process.platform === "darwin" ? latest-mac.yml : latest.yml`（一个三元；`:337` 便携分支在 mac 恒不走） |
| 12 | `electron/backend/config.cjs:53` | 纯 Node 回退目录：darwin → `~/Library/Application Support/AgentHub`（一个三元；替代方案见 3.Phase 2 与 D7） |
| 13 | `electron/backend/adapter-trae-common.cjs:31-33` | 路径候选加 darwin 分支（照抄 reasonix）；**是否启用由 2.3 决定** |
| 14 | `electron/backend/adapter-codebuddy.cjs:27-36` | 同上，路径候选加 darwin 分支；**是否启用由 2.3 决定** |
| 15 | `src/views/skills/SkillsLibraryView.vue:102` | 把 `m.type === "junction"` 放宽为含 `"symlink"`（值判定而非平台判定，`:161` 的按钮随之解禁） |
| 16 | `src/types/index.ts:220` | `mountMode` 联合类型补 `"symlink"`；配套文案见 `src/components/config/ConfigSkillsSection.vue:365`、`src/views/skills/SkillsSkillDetailView.vue:155`、`src/views/skills/SkillsSyncView.vue:142` |

**渲染层怎么知道自己在 mac 上（Phase 2 开工前必须定）**：现仓没有任何把平台信息送到渲染层的通道——`electron/preload.cjs` 只暴露白名单 IPC（`electron/preload.cjs:6` 的 `ALLOWED_COMMANDS`、`:303` 的 `contextBridge.exposeInMainWorld`），现有命令里最接近的只有 `get_app_version`（`electron/backend/ipc.cjs:98`）与 `get_is_portable`（`:115`），本机 `grep -rn "platform" src/stores/app.ts src/composables/*.ts` 零命中。方案：**新增**一个环境信息命令（Windows 侧零行为变化，纯新增）——主进程在 `electron/backend/ipc.cjs:98` 旁加 `ipcMain.handle("get_env_info", () => ({ platform: process.platform, arch: process.arch, isPackaged: app.isPackaged }))`；preload 白名单加 `"get_env_info"`；渲染层包装加在 `src/api/ipc.ts:91` 旁（`export const getEnvInfo = () => call<{platform:string;arch:string}>("get_env_info")`）；浏览器预览的 mock 分支加在 `src/api/mock.ts:441` 旁；启动时写入 `src/stores/app.ts:57-58` 的 store state，2.3 与 Phase 2 的所有「按平台隐藏/改文案」都读这一个值。

另有两处**不需要平台分支、但要收敛为单一写入口**（mac 上会被放大）：`electron/backend/config.cjs:415` 与 `electron/backend/sync-ipc.cjs:473` 都写 `setLoginItemSettings`，macOS 登录项按 .app 粒度只有一条，两处配置来源不同（框架配置 vs 渲染层传参）会互相覆盖——统一都读 `config.schedule.autoStart` 即可。**注意：两来源当前不一致时，统一后的 Windows 行为会变**（从「后写覆盖」变为「框架配置为准」），因此计入第 8 节账目并需回归。

**明确反对过度抽象**：不新建 `electron/backend/platform/{win,darwin}/` 双目录树，不引入「平台提供者注册表」，不把 `electron/backend/mounter.cjs` / `electron/backend/adapter-reasonix.cjs` / `electron/backend/proxy/discovery.cjs` 这类**已经带好分支**的文件搬进适配层，也不给 `shell.openPath`、字体栈、托盘回退这类一次性差异建模块。全仓 windows 分支是唯一生产路径，任何「搬家式重构」都在放大回归面且不产生 mac 侧收益。

### 2.3 (c) 在 mac 上直接降级或隐藏的

| 对象 | 处置 | 判据（文件:行号）与理由 |
| --- | --- | --- |
| Trae / Trae CN / TRAE SOLO / TRAE SOLO CN（用量四源） | **隐藏** | `electron/backend/sqlcipher.cjs:27`（只认 .dll）+ `electron/backend/adapter-trae-common.cjs:32`（%APPDATA%）。即使把路径改对，没有可用 dylib 也必抛（`electron/backend/adapter-trae-common.cjs:116-117`）；落点：`electron/backend/sync-adapter.cjs:16-23` 注册表按平台过滤 + 渲染层数据源列表隐藏（平台值来自 2.2 末段新增的 `get_env_info`） |
| codebuddy（用量源） | **隐藏（待验证后定）** | `electron/backend/adapter-codebuddy.cjs:27-36` 两个候选根都基于 %LOCALAPPDATA%；mac 落点真值未实测（V30），先隐藏，验证通过再开 |
| workbuddy / workbuddy_ai · 本机导入 | **降级为主走 OAuth** | `electron/backend/proxy/discovery.cjs:53`（Windows 主路径）+ `:55-56`（mac 猜测候选）；OAuth 走 state 轮询（`electron/backend/proxy/discovery.cjs` 内实现，与本机文件无关） |
| workbuddy · 客户端进程控制 | **降级为「提示手动退出」** | `electron/backend/proxy/wbClient.cjs:46/69`（非 win32 恒 false/true）、`:75`（软关闭无 mac 等价物，强补会丢未保存内容） |
| raccoon / zcode · 客户端进程控制 | **降级为提示**（zcode 已有 pgrep/pkill，可用但需收窄） | `electron/backend/proxy/raccoonClient.cjs:37/71/86`、`electron/backend/proxy/zcodeLocal.cjs:846/860` |
| raccoon · 设备指纹 | **不可降级，必须补** | `electron/backend/proxy/ideswitch.cjs:77` 静默失败 → 多号共用 clientDeviceId → 200003 吊销（同文件 70-76 注释即依据） |
| 便携模式 | **mac 不存在，隐藏相关文案** | `electron/backend/config.cjs:22`、`electron/backend/updater.cjs:43`、`electron/backend/sync-config.cjs:53-64` 的判定在 mac 恒 false；设置页 `src/components/config/ConfigGeneralSection.vue:345` 的便携文案在 mac 隐藏 |
| 安装期杀进程 | **不移植** | `build/installer.nsh:10` 是 NSIS 钩子；mac 更新由 Squirrel 替换 .app，且 POSIX 允许 unlink。是否有等价需求见 V12 |
| Windows 专属文案/字体/滚动条 | **按平台改文案或接受差异** | `src/components/config/ConfigGeneralSection.vue:345/360`、`src/components/config/ConfigDataSection.vue:227`、`src/views/sync/BillingRulesView.vue:815`、`src/styles/global.css:190/1283` |
| `src/api/mock.ts:449` 等预览假数据 | **保留（仅 dev:web）** | `src/api/ipc.ts:82` 只在 `window.agenthub` 缺失时启用，不影响打包产物 |
| 「打开目录/文件」 | **保留 `shell.openPath`** | `electron/backend/ipc.cjs:101/106/398` 等；是否对文件改用 `showItemInFolder` 见 D6（**共享路径，默认不改**） |

### 2.4 收敛后的目录与文件清单（KISS）

| 形态 | 路径 | 规模 | 说明 |
| --- | --- | --- | --- |
| 新增 | `electron/backend/credential.cjs` | ~60 行 | 2.1-B 的接口；两个 config 改为调用 |
| 新增 | `electron/backend/osdirs.cjs` | ~30 行 | 2.1-D 的接口；替换 5 处路径拼接 |
| 新增 | `electron/backend/proxy/clientHost.cjs` | ~150 行 | 2.1-C 的接口；Windows 分支平移现有实现 |
| 新增 | `build/entitlements.mac.plist` | ~10 行 | 签名用（至少 `com.apple.security.cs.allow-jit`，见 2.5） |
| 新增（生成物） | `build/icon.icns`、`build/trayTemplate.png`、`build/trayTemplate@2x.png` | 二进制 | 由根 `logo.png`（1024×1024，`tools/gen-icon.cjs:1`）生成 |
| 原地改 | `electron/backend/sqlcipher.cjs` | +3 个平台函数 | 导出面不变 |
| 原地改（新增 IPC，纯增量） | `electron/backend/ipc.cjs`（`get_env_info`，加在 :98 旁）、`electron/preload.cjs`（白名单 :6）、`src/api/ipc.ts`（:91 旁）、`src/api/mock.ts`（:441 旁）、`src/stores/app.ts`（:57-58） | 各 1-3 行 | 渲染层拿平台值的唯一通道（见 2.2 末段） |
| 配置 | `package.json`（新增 `mac` 段）、`.github/workflows/release.yml`（新增 mac job + 校验） | — | 不动 `win`/`nsis`/`portable`/**`electronDist`** |
| 明确不做 | 平台目录树、适配层框架、Windows 逻辑搬家、`.node` 之外的打包结构改动 | — | 见 2.2 末段 |

### 2.5 术语表（macOS 打包 / 签名 / 更新，供不熟悉 mac 的读者）

> 以下为 macOS / Electron 生态的**外部通用知识**（仓库内没有对应实现，故无 `路径:行号` 可引），其在本项目的具体表现按 V1/V2/V6/V8/V11/V14/V17 验证。

- **Gatekeeper**：macOS 的安全门；从网络下载的应用首次打开会被检查来源与公证状态。未签名/未公证时用户需在「系统设置 → 隐私与安全性 → 仍要打开」手动放行（V8）。
- **签名（codesign / Developer ID）**：用 Apple 签发的证书给 .app 及其内部所有可执行文件/库逐个签名；**公证（notarization）**是另一件事——把签名后的包上传 Apple 做恶意软件扫描并领取「通行证」。只有签名没有公证仍会被拦；两者都要 Apple Developer Program 账号（年费，V10）。
- **notarytool**：Apple 现行的公证命令行工具；CI 里通过一组凭据环境变量驱动（见 Phase 4 第 2 条的三组名称，V10）。
- **Squirrel.Mac**：Electron 在 macOS 上的自动更新框架（Windows 侧对应 NSIS 安装器路径）。它**要求应用已签名**才肯安装更新，因此「不签名」等于放弃 mac 自动更新（V11）。
- **hardenedRuntime**：签名时启用的强化运行时。开启后，被 dlopen 的动态库/可执行文件也必须已签名，否则加载失败（V17）。
- **entitlements（权限声明）**：随签名提交的例外清单。`com.apple.security.cs.allow-jit` 是 Electron 在 arm64 上必需的 JIT 权限，缺失会导致应用崩溃（V17）。
- **app-update.yml**：打包进应用资源的更新配置（渠道、仓库地址）；mac 上的渠道清单文件是 `latest-mac.yml`，Windows 是 `latest.yml` —— 客户端按平台请求不同文件名，名字对不上就会拿到 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`（V14）。
- **dmg / zip**：mac 的两种分发物。dmg 是安装镜像；zip 是 Squirrel.Mac 自动更新实际使用的包，两者都要出（V1）。
- **universal / x64ArchFiles / singleArchFiles**：universal 指一个二进制同时含 arm64 与 x86_64 两套代码；合并时若某个文件只有单架构（例如本项目依赖里的 koffi 原生模块），需要用 `x64ArchFiles`（指定某架构独有文件）或 `singleArchFiles`（指定只保留单份的文件）告诉打包器怎么处理（V6）。

## 3. 分阶段路线图

### Phase 0 决策与准备

- **目标**：拍板 D1-D8；备齐 mac 构建环境、Apple 凭据渠道与 SQLCipher 渠道；**在动任何代码之前先录 Windows 基线**；不改代码。
- **改动清单**：无代码改动。要落实的事项：
  1. **录基线（第 0 步，责任人：发版负责人）**：在任何改动之前执行 `npm run electron:pack`（`package.json:15`），归档三样到发布记录（`docs/发版作业手册.md` 附录）：`release/win-unpacked` 的文件树（`find release/win-unpacked -type f | sort` 的输出）、四个 Windows 产物与 `latest.yml` 的 sha256、以及 `app.asar` 条目数（`npx asar list release/win-unpacked/resources/app.asar | wc -l`；离线时退化为「文件树 + 哈希」两样）。**基线晚于任何改动即失效**，这是第 8 节第 1 条保障的前提。
  2. 决策：D1-D8 逐条书面结论并指定责任人（D8 的渠道选择直接决定 Phase 3 能否解禁 Trae 四源）。
  3. 环境：`.github/workflows/release.yml:22` 的 runner 标签选择（`macos-14`/`macos-15` 为 arm64、`macos-15-intel` 为 x64 —— 外部事实，V42）；Apple 账号与证书现状（仓库 secrets 我无法读取，需你确认）。
- **验收标准**：① 基线归档文件存在，且时间戳早于本方案的第一处代码改动；② D1-D8 每条有书面结论与责任人；③ `gh api repos/HUIdada1/AgentHub --jq .private` 返回 `false`（本机未执行，执行即验）→ 可用 GitHub 托管 mac runner（可用性与计费见 V42）；④ 在 mac runner 上跑通一个空 job：`node -v && npm ci && node -e "require('koffi')"` 退出码 0。
- **风险与回退**：Apple 账号审批周期不可控 → 回退为「未签名直发 + 手动更新」路径，Phase 4 只做 CI 构建；无实体 mac 机 → 见 D3；SQLCipher 渠道未定 → Phase 1 不受影响（Phase 1 只做降级），但 Phase 3 的 Trae 四源保持隐藏。

### Phase 1 mac 可构建可启动

- **目标**：mac 上能打出 `.app` 并启动（窗口 + 菜单栏图标出现，无 require 期崩溃）。**本阶段不依赖 SQLCipher dylib**（Trae 四源继续隐藏）。
- **改动清单**：
  1. `electron/backend/sqlcipher.cjs:13` 顶层 `require("koffi")` 改为惰性加载（移入 `ensureLib()`）或 try/catch 置空；`:22-30` 的 `dllDir()` 增加 dylib 分支；`:40-42` 按平台决定依赖预载。目标只有一个：**让缺库走 `available()=false` 的既有降级路径**（`:67-75`），而不是在 require 期抛出。这是全方案唯一必须的运行时修复（P0）。
  2. `electron/backend/sync-adapter.cjs:16-23` 注册表改为懒加载或逐项 try/catch，把 koffi 失败的爆炸半径收回 Trae 四源（对上一条的双保险）。
  3. `package.json:47` **不动**（理由见第 1 节订正 3）；把构建纪律写进 `docs/发版作业手册.md`：mac 构建必须全新 `npm ci`，禁止搬运 Windows 工作区的依赖目录。
  4. `package.json:87` 之后新增 `mac` 段：`target` 显式写 `dmg + zip`（zip 必须开：Squirrel.Mac 自动更新要求两者同时启用——依赖实现/官方文档，**V1**）、`icon: "build/icon.icns"`、`hardenedRuntime` 与 `entitlements`（含义见 2.5）、`category`。**新增段，不触碰 `win`/`nsis`/`portable`。**
  5. 图标：`build/icon.png` 实测 256×256（本机读 PNG 头），不足以生成 icns 所需的 ≥512px 源（转换会报 `ERR_ICON_TOO_SMALL`，**V2**）；根 `logo.png` 是 1024×1024（`tools/gen-icon.cjs:1` 注释 + 本机读 PNG 头）→ 扩展 `tools/gen-icon.cjs`（或加一次性脚本）产出 `build/icon.icns` 与两张 Template 托盘图。
  6. CI：`.github/workflows/release.yml:22` 之后新增 `build-mac` job（`runs-on: macos-14`），构建命令加 `--mac`；windows job 的 `:68` 命令保持逐字不变。mac job 的 `--publish` 策略在 Phase 4 前用 `--publish never`（只产 artifact），避免与 windows job 抢同一 Release。
  7. 可选加固（**同时改善 Windows，属行为变更**，单列排期并计入第 8 节账目）：`electron/main.cjs:331-363` 的 whenReady 体内 `:336/341/345` 是裸调用、`createWindow()` 在其后 `:348`，任一环抛出即「进程活着但无窗口无托盘」；建议 try/catch + 日志 + 失败对话框。
- **验收标准（可执行、可判定）**：① mac 上 `npm ci && npm run build && npx electron-builder --mac --dir` 退出码 0，`release/mac*/AgentHub.app` 存在；② `open release/mac*/AgentHub.app` 后窗口出现、菜单栏图标出现、`ps aux | grep -i agenthub` 有主进程；③ 控制台无 `Cannot find the native Koffi module`；④ 对照实验：临时移走依赖目录里的 koffi darwin 包后仍能启动（证明降级路径生效）；⑤ Windows 侧回归：`npm run electron:pack` 产出与 Phase 0 基线一致（第 8 节第 1 条的口径）。
- **风险与回退**：若 mac 打包在 Electron 阶段失败（V1），回退手段是 CI 侧用 `-c.electronDist=<mac 版 dist>` 覆盖（是否被 24.13.3 接受，V1），Windows 命令行不加任何参数 → 零回归；若 icon 转换仍失败，回退为临时不设 `mac.icon`（Electron 默认图标）并把图标列为 Phase 2 项。

### Phase 2 核心本地功能（记忆中枢、用量同步等纯本地能力）

- **目标**：记忆中枢、用量同步（平台无关源）、设置中心在 mac 上可用；跨平台凭据有完整重填引导；UI 术语与事实一致。
- **改动清单**：
  1. 新增 `electron/backend/credential.cjs`（2.1-B）；`electron/backend/config.cjs:38-47` 的解空语义升级为 `{ ok, value }`，`:385` 保存时对 `!ok` 的字段**原样保留密文**；`electron/backend/sync-config.cjs:37-45` 同步改。
  2. 重填引导：设置页 WebDAV 密码与号池账号状态处显示「本机无法解密，请重新填写」（新增提示，不改 Windows 流程）。
  3. 平台值通道：按 2.2 末段的方案新增 `get_env_info`（主进程 handler + preload 白名单 + 渲染层包装 + mock 分支 + store 落值）。
  4. 数据源可见性：`electron/backend/sync-adapter.cjs` 与渲染层数据源列表按平台过滤 Trae 四源 + codebuddy（2.3 表）。
  5. 记忆中枢：`electron/backend/memory/config.cjs:19` 的默认根保持 `~/AgentHub/memory`（Windows 与 mac 同路径，零改动）；确认 mac 上 `~/AgentHub/` 目录可写即可。
  6. 脚本数据目录分裂：`electron/backend/config.cjs:53` 的回退分支不动，改为让工具脚本统一显式设 `AGENTHUB_DATA_DIR`（`scripts/test-devicemid.cjs:11` 已是正确写法；`tools/proxy-smoke.cjs:9`、`tools/memory-llm-live-check.cjs:23` 属要改的）。
  7. UI/托盘：`electron/main.cjs:247`（Template 图）、`electron/main.cjs:75` 与 mac 应用菜单（D6）、`src/components/config/ConfigDataSection.vue:227`、`src/components/config/ConfigGeneralSection.vue:345/360`、`src/styles/global.css:190/1283`。
  8. 挂载类型三处 UI + 类型定义（2.2 表 #15/#16）。
  9. 工具链文案：`tools/*.cjs` 里 `electron.exe` 写法（`tools/memory-ui-check.cjs:15`、`tools/memory-runtime-smoke.cjs:27`、`tools/proxy-zcode-selftest.cjs:3`、`tools/memory-smoke.cjs:9` 等）按平台生成；`tools/proxy-wb-selftest.cjs:34` 的「假绿灯」改为显式打印「本平台跳过 N 项」。
- **验收标准**：① mac 首启后数据目录生成 `config.json`，设置页保存 WebDAV 并重填成功；② 记忆中枢导入/检索/同步包导出可用，`npm run verify:memory`（`package.json:17`）通过；③ 用量同步只列出平台无关源，跑一次同步无 error 日志；④ 「Windows 密文不被清空」对照测试：造一份 `enc:v1:` 假密文，经一次保存后字节不变（Windows 与 mac 各跑一次）；⑤ 挂载/修复按钮在 mac 上可用（`src/views/skills/SkillsLibraryView.vue:161` 解禁）；⑥ 渲染层能拿到平台值（新建 `get_env_info` 后在页面里打印一次）。
- **风险与回退**：credential 语义修复会改变 Windows 的落盘写回行为 → 必须先加回归用例（第 8 节第 7 条与账目第 1 项）；若排期不允许，回退为「保留现有解空行为 + 只加显式提示」（比今天静默好，但保留清空风险，不推荐）。

### Phase 3 反代网关与号池

- **目标**：网关在本机可用；号池按 D4 边界工作；切号编排在 mac 上不「静默假成功」；设备指纹不触发吊销。
- **改动清单**：
  1. 新增 `electron/backend/proxy/clientHost.cjs`（2.1-C）；`electron/backend/proxy/wbClient.cjs:46/69/75/82/96/99/137`、`electron/backend/proxy/raccoonClient.cjs:37/50/71/74/86` 接入；`electron/backend/proxy/zcodeLocal.cjs:846/860/909` 保留（可选收窄匹配）。
  2. 设备指纹：`electron/backend/proxy/ideswitch.cjs:77` 改走 `osdirs.vendorSupport("office-raccoon")`（**必做**）；`electron/backend/adapter-raccoon.cjs:33` 同步（否则用量统计里本机会变成新设备，`electron/backend/sync.cjs:93-99`）。
  3. 号池凭据：`electron/backend/proxy/store.cjs:296/358` 的判定逻辑不改，只补 UI「需重新导入/重登」提示；恢复路径走号池 WebDAV 同步（`electron/backend/proxy/poolsync.cjs:144-187` 导入侧按本机后端重新封信），并先解决 WebDAV 密码重填。
  4. ZCode：`electron/backend/proxy/zcodeLocal.cjs:46` 的派生密钥含 `os.platform()` → mac 上预期必须重登（**推论，V24**）；`electron/backend/proxy/zcodeLocal.cjs:284` 的原样回写是否毒害 mac 客户端（V25）。
  5. Trae 四源解禁前置：按 D8 落定 SQLCipher 渠道并把二进制放进 `resources/sqlcipher`（或替换 koffi 桥），再按 V16 验证；未定则保持 2.3 的隐藏。
  6. MCP 桥：`electron/backend/memory/index.cjs:156`（command 取包内二进制）+ `electron/backend/memory/verify.cjs:22/23/37/53/59/60/128`；mac 上 `ELECTRON_RUN_AS_NODE=1 <Contents/MacOS/AgentHub> <物理 JS>` 能否被 zcode/codex 拉起（V31）；不可用时的替代方案是随包附真 node 或改成 bundle id + `open -a`。
  7. 网关服务：`electron/backend/proxy/index.cjs` 的 `127.0.0.1` 本地 HTTP 平台无关，只需在 mac 上验证绑定与鉴权（`electron/backend/proxy/store.cjs:233` 的 SHA-256 哈希查询与平台无关，已发出的 Key 仍可用）。
- **验收标准**：① 启用网关后 mac 上 `curl -s http://127.0.0.1:9527/v1/models` 返回 200；② 至少一条渠道（推荐 raccoon 授权码兑换或 trae 回环回调 `electron/backend/proxy/discovery.cjs:748`）完成导入并出现在号池；③ 外部客户端未安装/未运行时切号给出明确提示而不是静默成功（对照 `electron/backend/proxy/raccoonClient.cjs:71` 恒 true）；④ 小浣熊多账号切换不再触发服务端 200003（对照 `electron/backend/proxy/ideswitch.cjs:70-76`）；⑤ 从 Windows 侧导出的号池同步包在 mac 上成功恢复账号（对照 `electron/backend/proxy/poolsync.cjs:174` 的重新封信触发）。
- **风险与回退**：mac 上目标外部客户端可能不存在（V28-V30）→ 相关渠道按 D4 收缩为「仅网络通道」，回退=隐藏客户端控制入口并保留手工导入。

### Phase 4 发版链路

- **目标**：mac 产物进 Release、可安装、可更新（或明确降级为手动更新）；双平台发版手册可执行。
- **改动清单**：
  1. CI：`.github/workflows/release.yml:22` 新增 `build-mac` job；`:68` 对应的 mac 命令为 `npx electron-builder --mac --publish always`；`:90` 的校验扩展为同时校验 `latest-mac.yml`（版本号 + `releaseNotes` 非空）；两个 job 的并发竞争见 V13。
  2. 签名/公证：新增 `build/entitlements.mac.plist`（至少 `com.apple.security.cs.allow-jit`）；CI secrets 三选一组（名称取自依赖源码本次实读，属依赖树、不参与引用核对，最终以 V10 复核为准）：① `APPLE_API_KEY`（.p8 密钥文件路径）+ `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`；② `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`（团队标识另配 `APPLE_TEAM_ID`）；③ `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE`。三组的共同作用见 2.5 的 notarytool 条。
  3. 更新：`electron/backend/updater.cjs:13` 增加平台分支（darwin → `latest-mac.yml`）；`electron/backend/updater.cjs:395` 的 `quitAndInstall(true, true)` 在 mac 上语义不同（V11）；**不签名就必须把 mac 更新降级为「提示手动下载」**（可复用 `electron/backend/updater.cjs:337` 的便携版比对逻辑）。
  4. 文档：`docs/发版作业手册.md:104` 的「资产四件齐全」改为双平台清单；`:144` 的 `/S --force-run` 描述补「仅 Windows」限定。
- **验收标准**：① 一次发版后 Release 同时存在 win 四件套与 mac `dmg`/`zip`/`latest-mac.yml`；② 已装 mac 版能自动发现下一版并成功替换（或按降级路径给出可点击的下载引导）；③ `curl -sSL "https://github.com/HUIdada1/AgentHub/releases/download/v<版本>/latest-mac.yml" | head -1` 版本号匹配；④ 未签名路径下，下载 dmg 后按文档步骤能打开应用（系统设置 → 隐私与安全性 → 仍要打开）。
- **风险与回退**：签名/公证失败 → 发布不签名版本 + 文档写明放行步骤（不阻断发布）；CI secrets 缺位 → mac job 用 `--publish never` 保留在 workflow 里做构建回归；最坏回退=删除 mac 产物并停用 mac job，Windows 链路不受任何影响。

## 4. 需要用户拍板的决策点

### D1 Apple Developer 账号与签名、公证

- **选项 A**：加入 Apple Developer Program（年费，金额与条款以 Apple 官网为准，**外部事实、本次未复核，V10**）+ Developer ID 签名 + notarytool 公证。**影响**：可过 Gatekeeper（概念见 2.5）；mac 端自动更新可用（Squirrel.Mac 要求签名，V11）；CI 需 4-6 个 secrets；每次发版多一段公证等待。
- **选项 B**：不签名、不公证直发。**影响**：用户首启必须手动放行（V8）；mac 自动更新不可用，只能手动下载 dmg。
- **建议**：**A**。理由：本项目的更新体验是「托盘提示 + 一键安装」（`electron/main.cjs:209-213`、`electron/backend/updater.cjs:395`），不签名等于把 mac 的这条产品线砍掉一半。若 mac 用户规模不足或短期只做技术验证，先用 B 过渡，但要在发布说明里写清放行步骤。
- **待确认事实**：账号/证书是否已存在——仓库 secrets 我无法读取，需你确认。

### D2 目标架构（arm64 / x64 / universal）

- **选项**：A arm64 only；B x64 only；C universal。
- **影响**：只有 universal 能用一个产物同时覆盖两类 Mac，并规避 `latest-mac.yml` 双份的麻烦（分两次调用才互相覆盖，单次 `--mac --x64 --arm64` 会合并——依赖行为，V6）；但 universal 要合并两份 thin 单架构的 `koffi.node`（打包器先分别产出 `-x64-temp`/`-arm64-temp` 再合并——依赖实现，V6），第三方单架构文件要按 2.5 的 `x64ArchFiles`/`singleArchFiles` 处理；体积约等于两份 Electron。
- **建议**：**先 A（arm64），Phase 4 再评估 C**。理由：Apple Silicon 已是 mac 主流；arm64 runner（`macos-14`/`macos-15`）即用；x64 需要 `macos-15-intel` runner（外部事实，V42），且 dmg 打包依赖 macOS 专有工具、只能在 mac 上打。若必须覆盖 Intel，优先验证 universal 的 koffi 合并（V6），而不是发两份产物。

### D3 是否需要实体 mac 测试机

- **选项 A**：不购置，只用 GitHub 托管 runner + 请用户代跑；**选项 B**：购置一台 Apple Silicon Mac（Mac mini 起）。
- **影响**：A 能覆盖「构建、打包、纯 Node 脚本」（`npm run verify:memory` 这类），但**托盘图标、应用菜单、Keychain 授权弹窗、Gatekeeper 放行、dmg 安装、自动更新、切号客户端联动**这些只能在真机验证；本方案第 7 节里 44 条待验证项中有约一半属此类。「CI 上的 mac」无法替代：无头会话下 `tools/memory-ui-check.cjs` 这类 BrowserWindow 探针未必能跑（V39）。
- **建议**：**B**，且排在 Phase 1 之前。理由：Phase 1 的验收标准（窗口与托盘出现、无崩溃）就需要真机；没有真机则 Phase 1-3 全部验收只能靠 CI 日志 + 用户代跑，返工成本远高于一台 Mac mini。

### D4 号池各渠道在 mac 上的可用性边界

- **事实**：反代五渠道的**网络通道**（trae 本地回环回调 `electron/backend/proxy/discovery.cjs:748`、workbuddy state 轮询、raccoon 授权码兑换、zcode CLI poll）都不依赖 Windows 专有 API（代码内可核）；受影响的只有「读对方本机文件」（本机导入）与「控制对方进程」两类支路（2.3 表）。
- **选项 A**：全量承诺（补齐 mac 进程控制 + 各客户端落点）；**选项 B**：明确边界——mac 首版只保证网络通道 + 网关，客户端联动显示「请先手动退出客户端/未检测到客户端」；**选项 C**：隐藏所有涉客户端 UI。
- **建议**：**B**。理由：`electron/backend/proxy/wbClient.cjs:75` 的软关闭在 mac 只能用 `osascript quit` 近似（V32），未保存内容风险高；C 会让用户无法自助排障。B 的残留风险（客户端运行期间回写 auth.json 覆盖切号结果）由写时哈希闸 `electron/backend/proxy/ideswitch.cjs:274/:282` 兜住（发现被改会中止并提示），可接受。

### D5 既有 Windows 用户数据的兼容策略

- **事实**：`enc:v1:` 密文跨平台不可解（`electron/backend/config.cjs:29/44-46`）；号池 `token_enc` 同理（`electron/backend/proxy/store.cjs:296`）；ZCode 凭据密钥含平台名（`electron/backend/proxy/zcodeLocal.cjs:46`）→ 预期必须重登（V24）；号池 WebDAV 同步包内是明文、到岸重新封信（`electron/backend/proxy/poolsync.cjs:174`）→ 可跨平台恢复；`electron/backend/config.cjs:385` 的「保存即清空 Windows 密文」必须先修。
- **选项 A**：允许同一份 config.json 双平台流转，凭据重填即用；**选项 B**：mac 首版不承诺迁移（全部手动重配）；**选项 C**：写一次性迁移工具。
- **建议**：**A + 显式重填引导 + 迁移前先修清空问题**。理由：WebDAV 类配置（地址/账号/路径/调度）跨平台可直接用，只有密码与 token 需要重填一次；C 的投入产出比低（用户量未知，且重填路径已经足够短）。迁移时**建议重置 mac 侧 deviceId**（`electron/backend/config.cjs:341` 只在缺失时生成），否则 `electron/backend/proxy/poolsync.cjs:533` 会让两台机器的归档互相覆盖（V26）。

### D6 应用菜单与右键菜单（mac 专属交互）

- **事实**：`electron/main.cjs:75` 的 `autoHideMenuBar` 在 mac 无效，且全仓 `setApplicationMenu` 零命中（本机 grep）→ mac 上会显示 Electron 默认菜单（含 Cmd+R 重载、开发者工具）；全仓也没有右键菜单（本机在 `src/` 与 `electron/` grep `contextmenu` 零命中），mac 用户右键输入框拿不到剪切/复制/粘贴。
- **选项**：定制 mac 应用菜单（App/Edit/Window 角色 + Cmd+Q 语义）+ 补右键菜单；或接受默认。
- **建议**：**定制应用菜单**（成本低、与「只从托盘退出」的模型一致）；右键菜单列为 Phase 2 的可选项，若不做需在发布说明里告知。
- **附**：「打开报告」类文件用 `shell.openPath`（`electron/backend/ipc.cjs:398`）在 mac 会用默认应用打开；若产品预期是「在访达中显示」，需改 `showItemInFolder`——**这是共享代码路径，改了 Windows 行为同样变化**，故默认不改，需你拍板（计入第 8 节账目）。

### D7 便携模式的取舍

- **事实**：便携判定在 mac 恒 false（`electron/backend/config.cjs:22`、`electron/backend/updater.cjs:43`、`electron/backend/sync-config.cjs:53-64`）。
- **选项**：A mac 放弃便携模式；B 自造 mac 便携（.app 放任意目录 + 数据目录跟随）。
- **建议**：**A**。理由：macOS 的应用分发习惯是 dmg/App Store，便携概念收益低且要动数据目录解析（回归风险高）；设置页在 mac 隐藏便携相关文案（`src/components/config/ConfigGeneralSection.vue:345`）即可。

### D8 mac 侧 SQLCipher 二进制从哪来（决定 Trae 四源能否解禁）

- **背景**：Phase 1/2 **不依赖**它（Trae 四源先隐藏）；但 Phase 3 若要恢复 Trae 用量源，必须先有能在 mac 上加载、且能解 Trae 加密库的二进制（`electron/backend/sqlcipher.cjs:27/40/42`、`:111` 的 raw key 用法）。
- **选项 A**：改用自带 darwin 预编译的 `better-sqlite3-multiple-ciphers`（npm 包）替换 koffi 桥——改动中等（`electron/backend/proxy/store.cjs:20` 已有 better-sqlite3 的预留回退位，可作接口参考），但需先验证它的 `cipher='sqlcipher'` 读库模式与 raw key 语法等价（**V43**）。
- **选项 B**：自建 SQLCipher dylib（官方 README 列出的可选加密后端含 CommonCrypto，可做出只依赖系统库的 dylib），随包放进 `resources/sqlcipher` 并由 `sqlcipher.cjs` 按平台加载。
- **选项 C**：mac 首版不做，Trae 四源长期隐藏（成本最低，功能缺口写进发布说明）。
- **建议**：**B 为主、A 为备**，Phase 0 内定渠道；责任人建议=构建/发版负责人 + 一名能上 mac 的开发；时间盒 2 人日做可行性验证（V16/V43）。**许可提示**：无论选 A/B，随包分发前都要核对该渠道二进制的许可证与随包条款（**V44**，本次未核，不做断言）。
- **影响**：选 B 需要 Xcode 与编译环境（外部依赖获取的不确定性已计入工作量）；选 C 则第 5 节的 Phase 3 区间取下限。

## 5. 工作量粗估

| 阶段 | 区间（人日） | 估算依据 |
| --- | --- | --- |
| Phase 0 决策与准备 | 2–4 | 决策文档 0.5；**基线录制 0.5**；runner/secrets 冒烟 0.5–1；SQLCipher 渠道可行性验证（V16/V43）1–2 |
| Phase 1 可构建可启动 | 4–7 | 打包配置 1–2；icns/Template 图生成 0.5–1；CI mac job 0.5–1；koffi 惰性化 + 启动链验证 1–2；真机首启排错 1–1.5 |
| Phase 2 核心本地功能 | 7–12 | credential 统一与回归 1.5–2；平台值通道（get_env_info）0.5；UI 平台化与文案 2–3；数据源过滤 1；记忆/用量在 mac 上的验收 2–3；工具链文案 1–2；回归 1 |
| Phase 3 网关与号池 | 9–15 | clientHost 1.5–2.5；三客户端接入与真机调试 3–5；设备指纹与号池恢复路径 2–3；SQLCipher 渠道落地与 Trae 解禁 1.5–3（选 C 则减）；MCP 桥验证与替代方案 1.5–3；验收 1 |
| Phase 4 发版链路 | 5–9 | CI 双平台发版 2–3；签名与公证 1–2；updater 1–2；手册与发版演练 1–2 |
| **合计** | **27–47** | — |

估算依据补充：改动面 = `electron/backend` 下 94 个 `.cjs`（本机计数：backend 49 + proxy 22 + memory 23）中约 15 个文件 + 3 个新模块 + 渲染层 5 处小改 + `package.json`/CI/文档/图标工具 + `tools`/`scripts` 共 50 个 `.cjs`（本机 `find tools scripts -name "*.cjs" | wc -l`）中的文案类修改。不确定性主要来自三处：SQLCipher 渠道（外部二进制，可能自建）、签名/公证凭据是否齐备、真机调试（无实体 mac 时上表所有区间按 1.5-2 倍估）。不含 Apple 账号审批等待、runner 排队与公证排队时间。

## 6. Top 风险清单

**R1 SQLCipher 渠道 + koffi 在 mac 上的可用性**

- 触发条件：mac 上执行 `npm ci` 后依赖目录里没有 koffi 的 darwin 包（镜像/网络问题），或走 Trae 数据源时 `resources/sqlcipher` 里没有可用二进制。
- 影响：前者 → `electron/backend/sqlcipher.cjs:13` 抛错并沿 require 链让应用起不来（P0，V41 可复现）；后者 → Trae 四源全灭（P1，`electron/backend/adapter-trae-common.cjs:116-117`）。
- 缓解：Phase 1 的惰性加载 + `electron/backend/sync-adapter.cjs` 懒加载（把 P0 降级为 P1）；Phase 0 按 **D8** 锁定渠道并核许可（V43/V44）；**不要**走 Homebrew 拷 dylib（外部事实：其 dylib 依赖 Homebrew 私有前缀路径，拷进包内加载不了 —— 本次未复核，V16/V44）。
- 证据强度：中。`package-lock.json:899-928`（本机实读）证明确有 darwin 包声明；「mac 上装得上、dylib 可加载」均为待验证（V15/V16）。

**R2 未签名未公证 → Gatekeeper 拦截 + 增量更新失效**

- 触发条件：Phase 4 走「不签名直发」；用户从 Release 下载 dmg。
- 影响：首启被拦（需「仍要打开」放行，V8）；mac 自动更新不可用（Squirrel.Mac 要求签名，V11）。
- 缓解：D1 选 A；若选 B，则 `electron/backend/updater.cjs:13` 只做「读 `latest-mac.yml` 提示版本」，安装引导到浏览器手动下载（复用 `electron/backend/updater.cjs:337` 的便携逻辑）。
- 证据强度：中（外部事实：Electron 官方文档 + Apple 支持文档，**本次未复核，V8/V11**；仓库侧本机可核：`package.json` 无任何签名/公证配置）。

**R3 外部客户端在 mac 上不存在 → 号池大面积降级**

- 触发条件：mac 用户未安装 WorkBuddy / 小浣熊 / CodeBuddy / Trae 桌面端，或安装位置与猜测不符。
- 影响：本机导入通道失效、进程控制降级、切号编排「静默假成功」（`electron/backend/proxy/wbClient.cjs:69`、`electron/backend/proxy/raccoonClient.cjs:71`）；用量源只剩 codex / reasonix / qoder / antigravity 等平台无关项。
- 缓解：D4 选 B（明确边界 + 提示）；`clientHost.cjs` 的 mac 分支用 `/Applications` 扫描 + `mdfind` 提高命中率；所有「未检测到客户端」路径给 UI 文案而不是静默。
- 证据强度：高（代码侧：`electron/backend/proxy/wbClient.cjs:96/137`、`electron/backend/proxy/raccoonClient.cjs:37/86`、`electron/backend/proxy/discovery.cjs:53` 均为排除性证据，本机实读）；「mac 客户端是否存在/数据目录在哪」为待验证（V28-V30）。

**R4 跨平台凭据密封不可互换 + 保存清空 Windows 密文**

- 触发条件：把 Windows 的 `config.json` / `stats.db` 带进 mac 后任意一次保存设置或启停网关。
- 影响：WebDAV 密码静默变空（四套同步全停）；号池零可用账号；更糟的是 `electron/backend/config.cjs:385` 会把 Windows 密文永久清成空，若同一份文件被拷回 Windows，损失双向扩散。
- 缓解：Phase 2 的 credential 语义修复（`!ok` 保留密文）+ 重填引导；发布说明里明确「凭据需重填一次」；恢复路径走 `electron/backend/proxy/poolsync.cjs` 的明文包重新封信。
- 证据强度：高（`electron/backend/config.cjs:29/34/38-47/385`、`electron/backend/proxy/store.cjs:296/358` 均为本机实读；mac 上 Keychain 行为为待验证 V9/V21）。

**R5 设备指纹静默失败 → 服务端 200003 吊销**

- 触发条件：mac 上使用小浣熊渠道做多账号切换（`electron/backend/proxy/ideswitch.cjs:77` 写文件失败）。
- 影响：多号共用同一 `clientDeviceId`，服务端判定跨号串号并强制作废两端会话——用户侧表现为「号被吊销」，比功能降级严重。
- 缓解：Phase 3 必做项（2.3 表）；在 `osdirs.vendorSupport("office-raccoon")` 落地前，mac 上的小浣熊切号入口建议先禁用并提示。
- 证据强度：高（`electron/backend/proxy/ideswitch.cjs:70-77` 的注释即作者实测结论，本机实读）。

**R6 没有 mac 真机 → 运行时不可验证**

- 触发条件：D3 选 A（不购机）。
- 影响：第 7 节里约一半待验证项无法收敛；Phase 1-3 的验收标准只能部分由 CI 覆盖，托盘/菜单/Keychain/Gatekeeper/更新链路全部悬空；估算区间放大 1.5-2 倍。
- 缓解：D3 选 B；在真机到位前，把所有「可 CI 化」的验证（构建、打包、纯 Node 脚本、V41 的伪造平台冒烟）先做完，把真机事项集中成一份一次性执行清单。
- 证据强度：高（本次全程在 win32 执行，本文件的 mac 侧结论均为静态证据）。

**R7 universal 双架构与原生依赖（koffi / dylib / fsevents）的合并**

- 触发条件：D2 选 C。
- 影响：两个 thin 单架构 `koffi.node` 合并进同一个 .app（打包器的 universal 合并只处理 Mach-O 与 asar，第三方单架构二进制要按 2.5 的 `x64ArchFiles`/`singleArchFiles` 处理——依赖实现，V6），合并失败会让其中一类 Mac 起不来；`fsevents`（`package-lock.json:3813`）为 darwin-only optional，装不上只是文件监听降级（`electron/backend/memory/index.cjs:293` 静默 return），不致命。
- 缓解：先 arm64 单架构发版（D2 建议）；验证 universal 时按 V6 检查 `koffi.node` 的两个架构目录并存与加载。
- 证据强度：中（依赖源码本次会话读过，但依赖树不参与引用核对；`@electron/universal` 对 thin `.node` 的实际处理未实测，验证方法见 V6）。

**R8 发布流水线的双平台时序与门禁缺口**

- 触发条件：Phase 4 两个 job 并发向同一 Release 发布；或只加了 mac job 而没加 `latest-mac.yml` 校验。
- 影响：`--publish always` 会各自创建/追加 Release（tag 校验在 `.github/workflows/release.yml:33-58` 只有一份），最坏情况是 mac 资产缺失/被覆盖；门禁侧 `.github/workflows/release.yml:85-101` 只校验 `latest.yml`，mac 清单静默缺失也照样「发版成功」。
- 缓解：串行化（mac job `needs: build`）或在 mac job 使用 `--publish never` + 单独上传步骤；`:90` 的校验扩到两份清单；并发竞争按 V13 实测后再定。
- 证据强度：高（`.github/workflows/release.yml:16-22/33-58/68/85-101` 本机实读；实际并发行为属待验证 V13）。

## 7. 待验证清单与验证方法

> 全部条目都需要一台 mac（CI runner 或真机，见 D3）；标注「真机」的必须人肉执行。命令里的 `<app>` 指 `release/mac*/AgentHub.app`。涉及依赖源码的复核统一用 `node -e "console.log(require.resolve('…'))"` 定位到依赖文件后再看内容（依赖树不在仓库源码内，不参与引用核对）。凡本文标注「外部事实（本次未复核）」的结论，都在本清单里有对应条目。

**打包与构建**

1. **V1 mac 打包首错与 electronDist 实际行为**：mac 上 `npm ci && npm run build && npx electron-builder --mac --dir`，记录首个报错；随后单独验证覆盖参数是否可用：`npx electron-builder --mac --dir -c.electronDist=<dir>`（预期全新 `npm ci` 后无需覆盖）。顺带用 `node -e "console.log(require.resolve('app-builder-lib/out/options/macOptions.d.ts'))"` 定位依赖源码，复核 mac 目标默认值与「zip 必须开」的注释（本次未复跑）。
2. **V2 icns 生成链路**：`ls build/*.icns` 与 `npx electron-builder --mac --dir` 后 `ls <app>/Contents/Resources/*.icns`；若打包报 `ERR_ICON_TOO_SMALL`，用根 `logo.png`（1024×1024）重新生成后再试（外部/依赖行为：256×256 的 `build/icon.png` 预期会触发该错误）。
3. **V3 electronLanguages 与 .lproj 匹配**：`ls <app>/Contents/Resources/*.lproj` 确认 `zh_CN.lproj`/`en.lproj` 等未被删空（配置值 `zh-CN`/`en-US` 与目录名字面不同）。
4. **V4 extraResources 落点**：`ls <app>/Contents/Resources/{sqlcipher,mcp,build}` —— 确认 `mcp/mcp-memory-server.cjs`、`sqlcipher/`、`build/tray.png` 都在，且 sqlcipher 目录内容与 `package.json:79` 的源目录一致（当前是三个 Windows PE，按 D8 换掉之后再看）。
5. **V5 镜像是否提供 darwin Electron**：mac 上 `npm ci` 后 `ls node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`（`.npmrc` 指向 npmmirror，本次未核该镜像的 darwin 产物）。
6. **V6 universal 合并 koffi**：`npx electron-builder --mac --universal --dir` 后 `file <app>/Contents/Resources/app.asar.unpacked/**/koffi.node` 或解包 asar 检查两个架构是否并存；对照打包器的 universal 合并实现（用 `node -e "console.log(require.resolve('app-builder-lib/out/macPackager.js'))"` 定位后查看合并参数），注意 `mergeASARs`/`x64ArchFiles`/`singleArchFiles` 三个开关（含义见 2.5）。
7. **V7 .node 是否被解包签名**：解包 `app.asar` 头检查 `koffi.node` 是否带 unpacked 标记；若是（当前 Windows 产物实测「无 unpacked 标记」），需要在 `mac` 段显式 `asarUnpack: ["**/*.node"]`，否则 hardened runtime 下可能加载失败（V17）。

**签名、公证与更新**

8. **V8 未签名 .app 的 Gatekeeper 表现（真机）**：下载未签名 dmg 并打开，记录是「无法打开」还是「已损坏」，并按 Apple 步骤放行一次；据此写发布说明。
9. **V9 safeStorage 的 Keychain 行为**：mac 上最小 Electron 脚本调 `safeStorage.isEncryptionAvailable()` / `encryptString`，观察是否弹授权、拒绝后返回值（决定 `electron/backend/config.cjs:34` 是否会在 mac 上明文落盘）。
10. **V10 账号与签名/公证凭据可用性**：确认 Apple Developer 账号（年费与条款以官网为准）与三组凭据的可用性（名称见 Phase 4 第 2 条）：`CSC_LINK`/`CSC_KEY_PASSWORD` 是否具备、`APPLE_API_KEY`+`APPLE_API_KEY_ID`+`APPLE_API_ISSUER` 或 `APPLE_ID`+`APPLE_APP_SPECIFIC_PASSWORD`(+`APPLE_TEAM_ID`) 或 `APPLE_KEYCHAIN`+`APPLE_KEYCHAIN_PROFILE` 任一组能否在 CI 跑通公证。
11. **V11 mac 上 electron-updater 能否完成安装（真机）**：装 vN，发布 vN+1 后触发检查更新并安装；未签名与已签名各跑一次（预期：未签名失败于 Squirrel.Mac 的签名校验）。
12. **V12 更新前是否需要杀主进程/桥进程（真机）**：更新安装前后 `ps aux | grep -i agenthub`，确认残留的 MCP 桥进程是否影响替换（对照 `build/installer.nsh:10` 在 Windows 侧的动机）。
13. **V13 双平台并发发布的时序**：一次发版里让 windows 与 mac job 同时 `--publish always`，观察 tag/Release 是否冲突；若冲突，改为串行或 mac 侧 `--publish never` + 手工上传。
14. **V14 latest-mac.yml 的客户端请求名**：出一次 mac 包后读 `<app>/Contents/Resources/app-update.yml` 的 channel 字段，并与 Release 上的 `latest-mac.yml` 对照（产出侧 `getUpdateInfoFileName`、消费侧 `Provider.getChannelFilePrefix` 都在依赖源码里：用 `require.resolve('app-builder-lib/out/publish/updateInfoBuilder.js')` 与 `require.resolve('electron-updater/out/providers/Provider.js')` 定位复核；本次未复跑）。

**原生依赖与数据库**

15. **V15 koffi 在 mac 上装得上**：`ls node_modules/@koromix && node -e "require('koffi')"` 退出码 0。
16. **V16 SQLCipher 二进制可加载且版本正确**：先在 mac 上用候选二进制载入并执行 `PRAGMA cipher_version`，再打开一份 Trae `database.db` 副本执行 `SELECT count(*) FROM sqlite_master`（验证 `electron/backend/sqlcipher.cjs:111` 的 raw key 用法与所选库的默认参数匹配）。仓库侧可先做的只读对照（本次已跑）：`grep -a -o -E "libcrypto-1_1-x64\.dll|libssl-1_1-x64\.dll" resources/sqlcipher/sqlcipher.dll | sort | uniq -c` → 只命中 libcrypto 1 次、libssl 0 次；`grep -a -o -E "4\.6\.1|community|cipher_compatibility|sqlcipher_export" resources/sqlcipher/sqlcipher.dll | sort | uniq -c` → 4.6.1×1、community×1、cipher_compatibility×2、sqlcipher_export×5。
17. **V17 hardened runtime 下的库加载与签名遍历**：装签名包后运行 Trae 源抽取，确认 `Contents/Resources/sqlcipher/*.dylib` 与 asar 内 `.node` 均能 dlopen；签名侧行为用 `node -e "console.log(require.resolve('@electron/osx-sign/dist/esm/sign.js'))"` 定位依赖源码复核（是否遍历 .app 全部子项逐个签名），并顺带复核公证凭据形态（本次未复跑）。
18. **V18 fsevents 是否生效**：`ls node_modules/fsevents`；改动记忆目录看是否实时索引（`electron/backend/memory/index.cjs:293` 加载失败会静默关闭监听）。

**凭据与跨平台兼容**

19. **V19 Trae mac 落点**：装 mac 版 Trae 后定位 `User/globalStorage/storage.json`、`ModularData/ai-agent/database.db` 与 machineid 文件；确认 `TRAE_DATA_HOME` 之类 envKey 是否可用。
20. **V20 Windows 密文在 mac 上的丢件范围**：用 Windows 产出的 `config.json` + 号池备份在 mac 导入，逐字段记录哪些为空、界面是否有重填引导（对照 `electron/backend/config.cjs:45`、`electron/backend/proxy/store.cjs:296`）。
21. **V21 保存是否会清空 Windows 密文**：同上环境，执行一次「保存设置」与一次「启停网关」，比对 `config.json` 中 `enc:v1:` 字段是否被写成空（对照 `electron/backend/config.cjs:385`、`electron/backend/proxy/index.cjs:457-462`）。
22. **V22 数据目录是否分裂**：mac 上分别用 App 与 `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "console.log(require('electron').app.getPath('userData'))"`、以及 `npm run verify:memory` 观察生成目录，确认 `~/AgentHub` 与 `~/Library/Application Support/AgentHub` 是否并存（对照 `electron/backend/config.cjs:53`）。
23. **V23 密文与签名身份的绑定**：装两个 productName/签名不同的构建互读对方 `config.json`，以及重装/改名后旧密文是否失效（决定是否要教用户「改名即需重填」）。
24. **V24 ZCode mac 密钥公式（真机）**：mac 登录官方 ZCode 后，用 `zcode-credential-fallback:darwin:<homedir>:<username>` 派生密钥试解 `~/.zcode/v2/credentials.json`（`electron/backend/proxy/zcodeLocal.cjs:46` 只有 win32 实测背书；本文件第 1、2 节的「解不开」为推论，待本项确认）。
25. **V25 Windows relay pass_hash 回写是否毒药**：把 Windows 侧 `relay pass_hash` 写回 mac 的 credentials.json，验证官方客户端与手机远程连接是否仍可用（对照 `electron/backend/proxy/zcodeLocal.cjs:284`）。
26. **V26 poolsync deviceId 冲突**：用两个 `AGENTHUB_DATA_DIR` 副本模拟同 deviceId 双机同步，确认 `pool/archives/<id>.zip` 是否互覆（对照 `electron/backend/proxy/poolsync.cjs:533`），并决定迁移时是否重置 mac 的 deviceId。
27. **V27 存量用户数据口径**：向发布负责人确认现有版本分布与是否已有用户落盘 `config.json`/`stats.db`/`memory.config.json`，以及 mac 首发是否接受「凭据重填一次」。

**外部客户端与 MCP 桥**

28. **V28 WorkBuddy mac 客户端**：装一次并登录后 `ls ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth`，比对文件名与 `$wbEncrypted` 包装是否与 Windows 一致（`electron/backend/proxy/discovery.cjs:55-56` 目前是推断）。
29. **V29 小浣熊 mac 客户端**：`ls ~/.box-agent/config`、`ls ~/Library/Application Support/office-raccoon/` 与 `ps -Ao pid,comm | grep -i raccoon`，确认进程名、auth.json 与设备指纹文件落点（对照 `electron/backend/proxy/raccoonClient.cjs:22/50`、`electron/backend/proxy/ideswitch.cjs:77`）。
30. **V30 CodeBuddy IDE / Trae SOLO / antigravity / CC Switch 的 mac 落点**：分别安装后核对 `electron/backend/adapter-codebuddy.cjs:27-36`、`electron/backend/adapter-trae-common.cjs:31-33`、`electron/backend/adapter-antigravity-common.cjs:171`、`electron/backend/proxy/ccswitch.cjs:77` 假设的目录是否成立。
31. **V31 mac 上 ELECTRON_RUN_AS_NODE 拉起包内二进制**：手工执行 `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/AgentHub <桥 JS>`，从 stdin 发 `initialize` 看是否回 `tools/list`；对照记忆页三级校验的握手态（`electron/backend/memory/verify.cjs:53/128`）。
32. **V32 mac 进程探测/关闭的选型**：`pgrep -fl WorkBuddy`、`osascript -e 'quit app "WorkBuddy"'` 的可用性与副作用（未保存内容、退出码），据此定 `clientHost.cjs` 的 darwin 实现（对照 `electron/backend/proxy/wbClient.cjs:75` 的软关闭语义）。

**界面与系统集成**

33. **V33 托盘 Template 图**：把新增的 `trayTemplate.png`/`@2x` 打包后，在浅色/深色菜单栏下观察可见性，确认 `setTemplateImage(true)` 是否必需（对照 `electron/main.cjs:247`）。
34. **V34 托盘 click / double-click 行为**：真机点击与双击菜单栏图标，确认设了 context menu 后 `double-click` 是否仍触发 `showWindow`（`electron/main.cjs:251`）。
35. **V35 mac 应用菜单**：真机启动后查看顶部菜单，确认是否出现 Cmd+Q/Cmd+R/开发者工具，并据 D6 决定是否 `setApplicationMenu`（`electron/main.cjs:75`）。
36. **V36 Dock 与通知图标**：打包后看 Dock 图标、触发一次系统通知，确认是否回落 Electron 默认图标（对照 `electron/main.cjs:74`、`:273`）。
37. **V37 zoomFactor 与字体渲染**：真机把窗口从最小拖到最大逐档截图，与 Windows 对照；并做 `src/styles/global.css:190` 的 `-webkit-font-smoothing` A/B 对比，决定 mac 是否关掉整页缩放或改用整数档。
38. **V38 滚动条与关窗行为**：把系统「显示滚动条」设为自动/滚动时观察应用内是否仍常显 8px（`src/styles/global.css:1283`）；走一遍红叉/Cmd+W 后点 Dock 唤回（`electron/main.cjs:109-115/359-362`），决定是否需要首次提示。
39. **V39 无头探针与系统 Node**：`node -v`（是否 ≥22）；`./node_modules/.bin/electron tools/memory-ui-check.cjs` 在真机与 SSH 会话各跑一次对比退出码（`tools/memory-ui-check.cjs:32-49` 用 `require("electron")` 判定运行时）。
40. **V40 开机自启**：打包后在设置页开关自启，检查 系统设置 → 通用 → 登录项 是否只有一条、行为是否一致（对照 `electron/backend/config.cjs:415` 与 `electron/backend/sync-ipc.cjs:473` 两处写入）。

**本机可执行 / 外部事实复核**

41. **V41 伪造平台的启动链冒烟（本机 Windows 即可跑，用于验证 P0 崩溃链与修复效果）**：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'arch',{value:'arm64'});require('./electron/backend/sync-config.cjs')"` —— 期望：修复前抛 `Cannot find the native Koffi module`（本次会话未复跑，来自材料 4 的复现记录），Phase 1 修复后应退出码 0；并用伪造 win32 再跑一次确认 Windows 路径不受影响（第 8 节第 3 条同此命令）。
42. **V42 mac runner 可用性与计费**：`gh api repos/HUIdada1/AgentHub --jq .private`（期望 false）＋ 触发一次空 mac job 看是否被调度；同时核对 GitHub 文档里 `macos-14`/`macos-15`（arm64）与 `macos-15-intel`（x64）标签的当前状态与计费口径（外部事实，本次未复核）。
43. **V43 SQLCipher 备选渠道的读库等价性（D8 选型前置）**：在 mac 上装 `better-sqlite3-multiple-ciphers`，按 `cipher='sqlcipher'` + raw key（`PRAGMA key = "x'<64hex>'"`）打开同一份 Trae `database.db` 副本并与 Windows 侧 koffi 结果逐表对照；若不通过则退回自建 dylib 方案。
44. **V44 SQLCipher 渠道的许可与随包条款**：下载所选渠道的发布包，核对其内 LICENSE/README 的许可类型与再分发条款，确认可随 AgentHub 包分发（本次未核；Zetetic 官方仓库 README 与所选 npm 包的 license 字段都要看）。

## 8. 零回归保障

**本方案如何守住 Windows 零回归**

1. **形态约束前置**：2.1 的三类新模块全部是**新增文件**，Windows 分支是现有实现的平移（命令串、返回值、超时逐字保留）；2.2 的分支全部是「mac 分支新增、win32 分支不动」；2.3 只做可见性开关，不改 Windows 代码路径；渲染层平台值走**新增 IPC**（不动既有命令）。
2. **不动的清单（写进评审 checklist）**：`package.json` 的 `electronDist`（`:47`，处置见订正 3 与 Phase 1 第 3 条）、`win`/`nsis`/`portable` 三段（`:87-114`）、`build/installer.nsh`、`electron/backend/updater.cjs` 的 Windows 分支（`:13/43/337/395` 的既有语义）、`resources/sqlcipher` 的 Windows 内容与加载顺序（`electron/backend/sqlcipher.cjs:40-42`）。
3. **Windows 可见改动账目（共 4 处，逐项回归）**——这一节替代「唯一例外」的说法，凡清单外出现新的 Windows 行为变更，都必须先入此账目再开工：
   - ①**凭据写回语义**（`electron/backend/config.cjs:385`、`electron/backend/sync-config.cjs:37-45`）：解不开时不再写空、改为保留原密文 ——**唯一改变落盘数据的行为**，回归用例见本节第 7 条；
   - ②**开机自启写入口收敛**（`electron/backend/config.cjs:415` 与 `electron/backend/sync-ipc.cjs:473`）：两来源不一致时以框架配置为准（Windows 行为会变），回归=在 Windows 上分别用设置页开关与配置字段各写一次，确认结果一致且不再互相覆盖（V40 的 Windows 侧对照）；
   - ③**whenReady 加固**（`electron/main.cjs:331-363`，Phase 1 第 7 条，可选）：多一层 try/catch 与失败提示，Windows 同样生效，属行为变更，单列排期；
   - ④**`electron/backend/ipc.cjs:398` 若改 `showItemInFolder`**（D6 附）：共享路径，Windows 行为同样变化 —— **默认不改**，改动需拍板并入账。
   - 另记两处「语义不变但实现动」的点供回归关注：`electron/backend/sync-adapter.cjs:16-23` 注册表懒加载（Windows 上同一批模块最终都会被加载，只是时机变化）、`electron/backend/sqlcipher.cjs:13` 惰性 require（Windows 侧行为不变，但 require 时机变化，需跑一次真实 Trae 抽取确认）。
4. **平台分支写法规范**：新分支一律写成 `if (process.platform === "darwin") { … }` 且放在 win32 判断之前；禁止把 win32 分支改成 `else`、禁止用 `a || b` 合并两平台逻辑、禁止在 Windows 代码里引入平台判断的副作用（例如把同步 `execSync` 换成异步）。
5. **CI 双平台并存**：`.github/workflows/release.yml` 的 windows job 保持逐字不变；mac job 在 Phase 4 前用 `--publish never`，与 Windows 发布完全解耦。

**为守住这条线需要新增的回归验证手段**

1. **Windows 产物基线对照**：基线在 **Phase 0 第 0 步由发版负责人录制**（口径与归档位置见第 3 节 Phase 0 改动清单第 1 条；**必须在任何代码改动之前**）。此后每次发版前重跑 `npm run electron:pack`（`package.json:15`），与基线 diff：文件树一致、`app.asar` 条目数一致、产物哈希一致（`--mac` 不在 Windows 上执行，预期 Windows 产物零变化）。
2. **Windows 冒烟套件全绿**：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs`、`tools/proxy-regress.cjs`、`tools/proxy-wb-selftest.cjs`、`tools/proxy-zcode-selftest.cjs`、`tools/memory-smoke.cjs`、`npm run verify:memory`（`package.json:17`）逐条跑并留档；其中 `tools/proxy-wb-selftest.cjs:34` 的「假绿灯」问题要顺手修正为显式打印跳过数——**只加打印，不改 Windows 断言语义**。
3. **伪造 darwin 的 require 冒烟**（本机即可跑）：命令与预期见 **V41** —— 落地后该命令应退出码 0（今天抛 `Cannot find the native Koffi module`）；同时用伪造 win32 再跑一次，确认 Windows 路径不受影响。
4. **平台分支单元用例**：对 `electron/backend/osdirs.cjs` / `electron/backend/proxy/clientHost.cjs` / `electron/backend/sqlcipher.cjs` 的平台函数写纯函数断言（给定 `process.platform` 与 env，返回期望字符串/布尔），放在 `tools/` 下，Windows 与 mac 都跑。
5. **打包期配置断言**：在 CI 里加一步「win 段与 mac 段互斥检查」（读取 `package.json` 的 build 段，断言 win/nsis/portable 三块与本方案落地前一致）——防的是后续改动顺手「统一」平台配置。
6. **双平台发版门禁**：`.github/workflows/release.yml:85-101` 的校验扩展为 `latest.yml` + `latest-mac.yml` 双清单；任一缺失即发版失败（今天只有 Windows 清单，见 `.github/workflows/release.yml:90`）。
7. **数据面保护测试（credential 专用）**：在 Windows 上构造一份「非本机密文」（`enc:v1:` + 随机 base64），跑「加载 → 保存」两轮，断言文件里的密文字节未变、且 UI 收到 `needRefill` 标记；mac 上反向跑同一用例（用 Windows 密文）。这是第 3 节账目第 ① 项的专用回归。
8. **发版后人工验收口径**：Windows 四件套 + mac 三件（dmg/zip/latest-mac.yml）分开验收（`docs/发版作业手册.md:104` 需按此重写），并要求在真机上各安装一次、跑一遍「启动 → 托盘 → 记忆检索 → 用量同步 → 网关 curl」最小路径。

---

**文档信息**：本文件是只读调研产物——除本文件外未主动修改任何仓库文件；调研期间工作区被并发外部进程改动，其中 `electron/backend/proxy/store.cjs` 的改动已按「只读调研」要求撤销并恢复为 HEAD 版本（其余并发改动属其它任务，未处理），因此本文行号以**本次复核时点**为准、并在第 1 节读表说明给出漂移映射，实施前请按关键字重新定位。文中引用的代码证据都指向仓库内可定位的文件；依赖目录 node_modules 内的实现不在引用范围内，凡涉及其的结论均写成「依赖实现/外部事实（本次未复核）」并在第 6/7 节给复核命令。待验证项共 44 条，集中在本文件第 7 节（表格内另有若干「Vxx / 待验证」行内标注，为对应条目编号）。
