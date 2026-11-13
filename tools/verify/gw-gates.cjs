/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * Docker 网关侧的一致性门禁（方案 v2 §六 T3 / T4 / T6）。
 *
 * 为什么单独一个文件而不塞进 gateway-closure-check：那边是**纯静态文本扫描**（不开模块、
 * 不碰配置），这边必须真的 require commands.cjs 拿到注册表才能对账门控名 —— 两种性质
 * 混在一个脚本里，会让"闭包检查"变成"要跑配置副作用"的检查，负向验证也不好分开做。
 *
 * 三条断言各自卡住的都是**真实发生过的坑**：
 *  T3 门控名一致性 —— MEMORY_READ 里写的是 `memory_project_list`，而真实注册名是
 *     `memory_projects`（memory/index.cjs:680）。错名的后果不是报错，是**静默掉到 write 档**，
 *     于是只读令牌打不开「项目归档」页，且没有任何地方会说一句话。
 *  T4 前端调用面与三态对账 —— 9 条 `plugin_*` 既不 read 也不 deny（桌面把它们注册在
 *     ipc.cjs，容器不收），前端一调就是 404 空档。差集必须**显式归类**，不许是空白。
 *  T6 compose ↔ .env.example 变量对账 —— `AGENTHUB_ADMIN_HOST` 曾"能设不能传"。
 *     判据用「.env.example 声明过 → 必须透传」，**不用**"代码里有没有 process.env.X"：
 *     后者会漏判 `process.env[FEED_ENV]` 这种计算键（实测把 3 个运行时变量误分类成宿主侧）。
 *
 * 断言里**不写死会漂移的计数**（方案 §十 / 执行期实证：并行会话把闭包 254→253、命令表
 * 296→297 都改过）。要精确对账的只有 T3/T4 的"名字集合"关系，那是恒真不变式，不怕漂移。
 *
 * 用法：node tools/verify/gw-gates.cjs [--quiet]
 * 退出码：0 = 全绿（可含 WARN）；1 = 任一断言不符；2 = 环境/文件读不到（不是代码问题）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 支持 --root 是为了**负向验证**：门禁读的是一行不能碰的产品文件，
// 造错再改回来会让任何并发读取看到坏代码；换成夹具树就能安全地"故意写错→必须红"。
const argRoot = (() => {
  const i = process.argv.indexOf("--root");
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
})();
const ROOT = argRoot || path.join(__dirname, "..", "..");
const QUIET = process.argv.includes("--quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };
// js-yaml 永远从**真仓库**的 node_modules 取（夹具树里没有依赖目录）
const DEPS_ROOT = path.join(__dirname, "..", "..");


/** 明确只作用于宿主侧 / 构建期的变量：它们出现在 compose 的 ports/volumes/build.args 里，
 *  不该进 container environment。白名单而不是黑名单——新加的 AGENTHUB_* 默认按运行时要求透传。 */
const HOST_SIDE_ONLY = new Set(["AGENTHUB_DATA_DIR_HOST", "NPM_REGISTRY"]);

/** T4 的"已知未注册"白名单：容器里**故意**没有对应 RPC 的命令，前端仍保留调用是因为
 *  桌面形态要用同一个 api 层。每条都要写清"容器里改走哪条 REST"，否则白名单会变垃圾桶。
 *  名单是逐条对着 src/api/ipc.ts:839-877 的真实调用写出来的（曾误填过一条不存在的
 *  plugin_feed_set，被本门禁的 stale 检查抓到了 —— 这也说明 stale 提示不是摆设）。 */
const KNOWN_UNREGISTERED = new Map([
  ["plugin_list", "容器走 GET /api/plugins（gateway/src/index.cjs registerPluginRoutes）"],
  ["plugin_install", "容器走 POST /api/plugins/install（原始 zip 字节流）"],
  ["plugin_uninstall", "容器走 POST /api/plugins/:id/uninstall"],
  ["plugin_toggle", "容器走 POST /api/plugins/:id/toggle"],
  ["plugin_authorize", "容器走 POST /api/plugins/:id/authorize"],
  ["plugin_update_check", "容器走 POST /api/plugins/update/check"],
  ["plugin_update_apply", "容器走 POST /api/plugins/update/apply"],
  ["plugin_update_status", "容器走 GET /api/plugins/update/status"],
  // 专项 §四 S4 明确「不需要」：它是 v1 plugin-bridge 的手动触发口，而容器默认不 resume v1
  // （入口只 resumeEnabled({schema:2})），开它等于把整池明文 token 镜像通路引进服务器。
  ["plugin_sync_now", "容器**不提供**：v1 号池镜像桥专用，而容器只跑 v2 provider 插件（专项 §四 S4 / §五）"],
]);

/** 曾在这里挂过一张 `PENDING_COMPOSE_PASSTHROUGH` 豁免表（3 个 AGENTHUB_PLUGIN_* 未透传时
 *  先 WARN 不 FAIL）。task-12 ③ 已把三行真透传补进 gateway/docker-compose.yml，
 *  按裁决 ④ 的顺序（补完 → compose-env-audit 0 缺口 → 才删豁免）于此**删除**，T6 恢复硬断言。
 *  留这段话是为了让后来人知道：豁免表是临时脚手架，删掉它才是完工；不要新加条目。 */

let failed = 0;

function assert(name, ok, detail) {
  if (ok) { say(`  ✅ ${name}`); return true; }
  failed++;
  console.error(`  ❌ ${name}${detail ? `\n       ${detail}` : ""}`);
  return false;
}

// ── 取数：注册表 / 门控表 / compose / .env.example / 前端调用面 ──────────────
function loadRegistry() {
  // commands.cjs 的 register() 首行有配置相关副作用，要求配置可读 → 给它一个一次性数据目录。
  // 留 AGENTHUB_ALLOW_PLAINTEXT 是因为本工具不该要求调用方先备一把真 SECRET_KEY。
  process.env.AGENTHUB_ALLOW_PLAINTEXT = "1";
  if (!process.env.AGENTHUB_DATA_DIR) {
    process.env.AGENTHUB_DATA_DIR = path.join(require("node:os").tmpdir(), `gw-gates-${process.pid}`);
  }
  const C = require(path.join(ROOT, "gateway", "src", "commands.cjs"));
  return { commands: C.collectCommands(), gates: C };
}

/** 从 TS 源里抠出被调用的命令名。只认 call("名字"…) 这一种形态（实测 ipc.ts 全用它），
 *  比"扫一切字符串字面量"准得多，也不会把类型名当成命令。 */
function scanIpcCalls() {
  const file = path.join(ROOT, "src", "api", "ipc.ts");
  if (!fs.existsSync(file)) {
    console.error(`读不到 ${path.relative(ROOT, file)}（前端调用面变了？请同步本门禁的取数方式）`);
    process.exit(2);
  }
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\bcall(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) names.add(m[1]);
  return names;
}

function readComposeEnvKeys() {
  const file = path.join(ROOT, "gateway", "docker-compose.yml");
  const raw = fs.readFileSync(file, "utf8");
  const keys = new Set();
  let yaml = null;
  try {
    yaml = require(path.join(DEPS_ROOT, "node_modules", "js-yaml"));
  } catch {
    yaml = null; // 没有 js-yaml（异常环境）时退回行扫描，宁可弱一点也不要整体红
  }
  if (yaml) {
    try {
      const doc = yaml.load(raw);
      for (const svc of Object.values(doc.services || {})) {
        for (const k of Object.keys((svc && svc.environment) || {})) keys.add(k);
      }
    } catch (e) {
      console.error(`compose YAML 解析失败：${String((e && e.message) || e)}`);
      process.exit(2);
    }
  } else {
    const block = raw.split(/\n\s*environment:/)[1] || "";
    for (const m of block.matchAll(/^ {4,}([A-Z_][A-Z0-9_]*)\s*:/gm)) keys.add(m[1]);
  }
  return { keys, raw };
}

function readEnvExample() {
  const file = path.join(ROOT, "gateway", ".env.example");
  const raw = fs.readFileSync(file, "utf8");
  const names = new Set();
  // 注释掉的一行也算"声明过"：用户取消注释就会撞上"设了不生效"，那正是 T6 要拦的
  for (const m of raw.matchAll(/^#?\s*(AGENTHUB_[A-Z0-9_]+|TZ)\s*=/gm)) names.add(m[1]);
  return names;
}

// ── T3 ────────────────────────────────────────────────────────────────
function checkT3(reg) {
  say("\n【T3】门控名一致性：READ 名单里的每个名字必须是真实注册名");
  const { commands, gates } = reg;
  const readSets = [["READ", gates.READ], ["LOCALGW_READ", gates.LOCALGW_READ], ["PROMPTS_READ", gates.PROMPTS_READ], ["MEMORY_READ", gates.MEMORY_READ]];
  for (const [label, set] of readSets) {
    const ghosts = [...set].filter((n) => !commands.has(n));
    assert(`${label} 的 ${set.size} 个名字都在注册表里`, ghosts.length === 0, `幽灵名（会被静默判成 write）：${ghosts.join(", ")}`);
  }
  for (const [label, set] of readSets) {
    const misMode = [...set].filter((n) => commands.has(n) && gates.modeOf(n) !== "read");
    assert(`${label} 里没有名字被 DENY 抢档`, misMode.length === 0, `这些名字既在 READ 又在 DENY，实际 mode=${misMode.map((n) => `${n}→${gates.modeOf(n)}`).join(", ")}`);
  }
  // 回归锁：本轮修掉的错标不许哪天又被改回去（memory_project_list 全库不存在）
  assert("memory_projects 在 MEMORY_READ（只读令牌能打开「项目归档」）", gates.MEMORY_READ.has("memory_projects"), "被改回 memory_project_list 了？真名见 memory/index.cjs:680");
  assert("memory_project_list 这个错名已彻底消失", ![...gates.MEMORY_READ, ...Object.keys(gates.DENY)].includes("memory_project_list"));
  const unregisteredDeny = Object.keys(gates.DENY).filter((n) => !commands.has(n));
  say(`  ℹ️ 显式 DENY 但**未注册**的命令 ${unregisteredDeny.length} 条（不进 capabilities.commands，前端无法预置灰 —— 收口归方案 §3.2 的 capabilities 扩展）`);
}

// ── T4 ────────────────────────────────────────────────────────────────
function checkT4(reg) {
  say("\n【T4】前端调用面 ↔ 容器三态：差集必须显式归类，不许留 404 空档");
  const { commands, gates } = reg;
  const called = scanIpcCalls();
  assert(`从 src/api/ipc.ts 抠到调用命令 ${called.size} 条（>0）`, called.size > 0, "取数正则失效了，本条门禁等于没跑");
  const holes = [...called].filter((n) => !commands.has(n) && gates.modeOf(n) === "write" && !KNOWN_UNREGISTERED.has(n));
  assert("未注册且未显式 DENY 的调用 = 0（否则会 404）", holes.length === 0,
    `新增空档：${holes.join(", ")}。要么注册它、要么加进 DENY 给原因、要么加进 KNOWN_UNREGISTERED 并写明改走哪个 REST`);
  const stale = [...KNOWN_UNREGISTERED.keys()].filter((n) => !called.has(n));
  for (const s of stale) say(`  ⚠️ 白名单条目 ${s} 前端已不再调用，可以从 KNOWN_UNREGISTERED 删掉`);
  const denyButMissing = [...called].filter((n) => gates.modeOf(n) === "deny" && !commands.has(n));
  say(`  ℹ️ 未注册但已给 DENY 文案（返回 403+原因而不是 404）：${denyButMissing.length} 条`);
}

// ── T6 ────────────────────────────────────────────────────────────────
function checkT6() {
  say("\n【T6】compose ↔ .env.example 变量对账（判据：声明过就必须透传）");
  const declared = readEnvExample();
  assert(`.env.example 声明了变量（${declared.size} 项）`, declared.size > 0, "取数失败，本条门禁等于没跑");
  const { keys: envKeys, raw } = readComposeEnvKeys();
  const gaps = [];
  const hostSideUsed = [];
  for (const name of [...declared].sort()) {
    if (envKeys.has(name)) continue;
    if (HOST_SIDE_ONLY.has(name)) {
      if (raw.includes("${" + name)) hostSideUsed.push(name);
      else gaps.push(`${name}（声明了但 compose 里既没透传也没插值引用）`);
      continue;
    }
    gaps.push(name);
  }
  assert("声明过的运行时变量全部出现在 compose.environment（硬断言，无豁免表）", gaps.length === 0,
    `设了不生效的有：${gaps.join(", ")}。修法：在 gateway/docker-compose.yml 的 environment 下补 "名字: \${名字:-}"`);
  say(`  ℹ️ 宿主侧/构建期项（按白名单豁免）：${hostSideUsed.join(", ") || "无"}`);


  // 反向也要成立：compose 透传了却没在模板里声明的，说明有人在偷偷加没文档的开关
  const undeclared = [...envKeys].filter((k) => !declared.has(k) && k !== "TZ");
  if (undeclared.length) say(`  ⚠️ compose 透传但 .env.example 没教的：${undeclared.join(", ")}（考虑补进模板）`);
}

/** T9 compose/Dockerfile 运维关键项（R8 的产物：本团队重写 compose 时把 `restart` 弄丢了，
 *  而**没有任何一条门禁会发现** —— 容器 OOM 后不自回，用户侧表现为"服务偶发永久消失"。
 *  所以这里钉两件事：
 *   ① compose 必须声明 restart 策略（并明确不接受空值）；
 *   ② Dockerfile 的 HEALTHCHECK 指向的端点，必须在入口的 PUBLIC_PATHS 里免鉴权可达。
 *      否则 HEALTHCHECK 会拿到 401 → Docker 判容器不健康 → 带 depends_on/健康门编排时
 *      服务被当成不可用，而这在开发机上完全看不出来（本机没有 Docker）。 */
function checkT9() {
  say("\n【T9】compose 运维关键项 + HEALTHCHECK 端点存活（R8 盲区）");
  const composeRaw = fs.readFileSync(path.join(ROOT, "gateway", "docker-compose.yml"), "utf8");
  const restart = /(^|\n) {4}restart:\s*(\S.*)?\n/.exec(composeRaw);
  assert("compose 声明了 restart 策略", !!restart && !!restart[2] && restart[2].trim().length > 0,
    "缺 restart → 容器崩溃/宿主重启后服务不会自回（这正是 R8 回归）。合法值如 unless-stopped");
  if (restart && restart[2]) {
    const v = restart[2].trim();
    assert(`restart 取值可运维（当前 ${v}）`, ["unless-stopped", "always", "on-failure"].includes(v),
      "no 会让崩溃后不自回；其它值 docker compose 直接报错");
  }
  const dockerRaw = fs.readFileSync(path.join(ROOT, "gateway", "Dockerfile"), "utf8");
  const hc = /HEALTHCHECK[\s\S]*?CMD[^\n]*/.exec(dockerRaw);
  assert("Dockerfile 声明了 HEALTHCHECK", !!hc, "没有 HEALTHCHECK 时编排器只能看到「进程在」而看不到「服务可用」");
  const hcPath = hc && (/https?:\/\/[^\s"']+(\/api\/[a-z]+)/i.exec(hc[0]) || [])[1];
  assert("HEALTHCHECK 打的是 /api 探针路径", !!hcPath, `没从 HEALTHCHECK 里解析出 /api/* 路径：${hc ? hc[0].slice(0, 90) : "无"}`);
  if (hcPath) {
    const idxRaw = fs.readFileSync(path.join(ROOT, "gateway", "src", "index.cjs"), "utf8");
    // 探针必须免鉴权：HEALTHCHECK 与编排 probe 都不带 token，一旦路径不在 PUBLIC_PATHS
    // 就会拿到 401 → 容器被判不健康
    const inPublic = new RegExp(`PUBLIC_PATHS[\\s\\S]{0,220}?"${hcPath.replace("/", "/")}"`).test(idxRaw);
    assert(`HEALTHCHECK 的 ${hcPath} 在入口 PUBLIC_PATHS 白名单里（探针不带 token）`, inPublic,
      `不在白名单的话探针会吃 401，容器被判定 unhealthy`);
  }
}

/** T10 守卫标记两端成对（task-17 ④，工程师提议 / Lead 授权）。
 *  治的空门：四个 `[guard]` 标记的鉴别力目前**只在需要 Docker 的 CI 里生效**，
 *  本机把 index.cjs 的标记删掉、verify:gateway 全绿，要等推上去才发现 —— 那已经不是门禁了。
 *  所以这里静态钉两件事：
 *   ① 每个标记必须真的由 `console.*` 输出（不是躺在注释里的死串）；
 *   ② 每个标记必须在 docker.yml 里被消费（grep 到才算有人验它）。
 *  缺一即红。 */
const GUARD_MARKERS = ["downgrade-loopback", "public-admin-requires-token", "public-admin-authorized", "secret-key-required"];
function checkT10() {
  say("\n【T10】守卫标记两端成对（index.cjs 输出 ↔ docker.yml 消费）");
  const idxRaw = fs.readFileSync(path.join(ROOT, "gateway", "src", "index.cjs"), "utf8");
  const wfRaw = fs.readFileSync(path.join(ROOT, ".github", "workflows", "docker.yml"), "utf8");
  for (const m of GUARD_MARKERS) {
    // 只认"在 console.warn/error/log 的字符串里"，注释里写一遍不算输出
    const emitted = new RegExp(`console\\.(?:warn|error|log)\\([^)]*\\[guard\\] ${m}`).test(idxRaw);
    const consumed = new RegExp(`\\[guard\\\\\\] ${m}|\\[guard\\\\\\] \\([^)]*${m}`).test(wfRaw);
    assert(`标记 [guard] ${m} 由 index.cjs 的 console.* 真实输出`, emitted,
      "入口没有输出它（被删了或只在注释里）→ CI 的 grep 会永远落空");
    assert(`标记 [guard] ${m} 被 docker.yml 消费`, consumed,
      "CI 没有任何断言引用它 → 这个标记是死字段，删了也没人知道");
  }
}

function main() {
  say("网关侧一致性门禁（T3 门控名 / T4 前端调用面 / T6 变量透传 / T9 compose 运维项 / T10 守卫标记）");


  const reg = loadRegistry();
  say(`注册表命令 ${reg.commands.size} 条（数字随并行开发漂移，本工具只断言名字集合的关系）`);
  checkT3(reg);
  checkT4(reg);
  checkT6();
  checkT9();
  checkT10();
  if (failed) { console.error(`\n❌ ${failed} 项门禁不符`); process.exit(1); }
  console.log("\n✅ T3 / T4 / T6 / T9 / T10 全绿");

  process.exit(0);
}

main();
