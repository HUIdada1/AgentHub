/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 目录布局与项目归类引擎：Git 远程规范化 → slug；名称模糊匹配进待确认队列。
// slug 只由 Git 远程地址决定，与本地路径无关（跨机归并的关键）。
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { readJsonSafe, writeJsonAtomic } = require("./config.cjs");

// ---------- Git 地址规范化 ----------

function normalizeGitRemote(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^git@([^:]+):/, "ssh://git@$1/");
  s = s.replace(/^ssh:\/\/git@/, "https://");
  s = s.replace(/^git:\/\//, "https://");
  if (!/^https?:\/\//i.test(s)) {
    // 形如 github.com/owner/repo 的裸串
    if (/^[\w.-]+\.[a-z]{2,}\//i.test(s)) s = "https://" + s;
    else return null;
  }
  let m;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/i, "").replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    if (!owner || !repo) return null;
    // url 保留 host（display 会丢掉它）：界面「悬停显示 git 地址」需要能一眼认出是哪个托管站
    m = { host, owner, repo, display: `${owner}/${repo}`, url: `${host}/${owner}/${repo}` };
  } catch {
    return null;
  }
  const isKnownHost = ["github.com", "gitlab.com", "gitee.com", "bitbucket.org"].includes(m.host);
  const slug = isKnownHost
    ? `${m.owner}--${m.repo}`
    : `${m.host}--${m.owner}--${m.repo}`;
  return { ...m, slug: sanitizeSlug(slug) };
}

function sanitizeSlug(s) {
  return String(s || "")
    .toLowerCase() // NTFS 不区分大小写：不折叠的话 MyApp 与 myapp 两个 slug 落到同一目录互混
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{3,}/g, "--")
    .slice(0, 120);
}

// ---------- 远程/路径的通用解析（项目身份归一的唯一口径） ----------
// 台账里同一仓库的远程有三种历史写法：完整 URL、host/owner/repo（gitUrl）、owner/repo（展示名）。
// 三者必须能互相比较，否则「同一远程」在不同写入路径下判不相等，项目就会裂卡。

const KNOWN_GIT_HOSTS = ["github.com", "gitlab.com", "gitee.com", "bitbucket.org"];

/**
 * 把任意远程写法解析成统一结构。
 * @returns {{host:string, owner:string, repo:string, display:string, url:string, slug:string}|null}
 *   display 是 `owner/repo`（界面列与台账 remotes 的历史口径）；
 *   url 是 `host/owner/repo`（台账 gitUrl 的历史口径，不带协议）；
 *   slug 与 normalizeGitRemote 同口径（已知托管站省略 host）。
 */
function parseRemote(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^git@([^:]+):/, "ssh://git@$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git:\/\//, "https://");
  let host = "";
  let owner = "";
  let repo = "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname.toLowerCase();
      const parts = u.pathname.replace(/^\//, "").replace(/\.git$/i, "").replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts.length < 2) return null;
      owner = parts[parts.length - 2];
      repo = parts[parts.length - 1];
    } catch {
      return null;
    }
  } else {
    const parts = s.replace(/\.git$/i, "").replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    if (parts.length >= 3 && /^[\w.-]+\.[a-z]{2,}$/i.test(parts[0])) {
      host = parts[0].toLowerCase();
      owner = parts[parts.length - 2];
      repo = parts[parts.length - 1];
    } else {
      owner = parts[parts.length - 2];
      repo = parts[parts.length - 1];
    }
  }
  if (!owner || !repo) return null;
  const withHost = host && !KNOWN_GIT_HOSTS.includes(host);
  return {
    host,
    owner,
    repo,
    display: `${owner}/${repo}`,
    url: host ? `${host}/${owner}/${repo}` : `${owner}/${repo}`,
    slug: sanitizeSlug(withHost ? `${host}--${owner}--${repo}` : `${owner}--${repo}`),
  };
}

/**
 * 远程身份键：只用 owner/repo（小写）。
 * 为什么不带 host：台账既有 `owner/repo`（展示名）也有 `host/owner/repo`（gitUrl），
 * 带 host 会让同一仓库判成两个键；跨托管站同名 owner/repo 的概率远低于这个误判。
 */
function remoteKeyOf(raw) {
  const info = parseRemote(raw);
  return info ? `${info.owner}/${info.repo}`.toLowerCase() : "";
}

function sameRemote(a, b) {
  const ka = remoteKeyOf(a);
  return !!ka && ka === remoteKeyOf(b);
}

/**
 * 一个台账条目的全部远程（remotes 数组 + gitUrl 推导），按身份键去重、保留展示名。
 * 只读历史字段，不猜 slug：gitUrl 里带 host，能可靠转回 `owner/repo`。
 */
function effectiveRemotes(entry) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const info = parseRemote(raw);
    const key = info ? `${info.owner}/${info.repo}`.toLowerCase() : "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(info.display);
  };
  for (const r of (entry && entry.remotes) || []) push(r);
  if (entry && entry.gitUrl) push(entry.gitUrl);
  return out;
}

/** 路径形态的项目名：盘符开头 / UNC / 含反斜杠的绝对路径（owner/repo 形态不算路径） */
function isPathLike(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.includes("\\") && !s.includes("://"));
}

/** 条目可供「同一项目」比对的全部名称候选（名称、slug、反解仓库名、别名、本地路径末段） */
function nameCandidates(entry) {
  const out = [];
  const push = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (s) out.push(s);
  };
  push(entry.name);
  push(entry.slug);
  push(repoNameFromSlug(entry.slug));
  for (const a of entry.aliases || []) push(a);
  for (const p of [...(entry.localPaths || []), ...(entry.manualPaths || [])]) {
    push(path.basename(String(p || "")));
  }
  if (isPathLike(entry.name)) push(path.basename(String(entry.name).replace(/[\\/]+$/, "")));
  return out;
}

// cwd → 远程地址的进程内缓存：每条记忆都起一次 git 子进程代价太高（写入路径要 <50ms）
const remotesCache = new Map();
const gitRootCache = new Map();

function setBoundedCache(map, key, val, limit = 1000) {
  if (map.size >= limit) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, val);
}

/**
 * 枚举工作目录下的**全部** Git 远程（不只 origin）。
 *
 * 为什么必须全取：一个仓库常同时挂 origin（自己的 fork）与 upstream（上游）。
 * 项目卡的列就叫「远程仓库列表」，只读 origin 会让 upstream 永远不显示——
 * 这不是数据缺失，是探测面窄了一截。
 *
 * 顺序约定：origin 永远排最前（它是归类 slug 的依据），其余按 git 返回顺序。
 * 返回归一化对象数组；非 Git 目录、未装 Git、超时一律返回空数组（绝不抛）。
 */
function detectGitRemotes(cwd) {
  if (!cwd) return [];
  const cached = remotesCache.get(cwd);
  if (cached !== undefined) return cached;
  let list = [];
  try {
    // 单次 git remote -v 拿全部（行格式: name<TAB>url<TAB>(fetch|push)）：
    // 曾经的写法每个 remote 再起一个 git 子进程，N 个 remote = N×4s 最坏耗时
    const out = execFileSync("git", ["-C", cwd, "remote", "-v"], {
      encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const byName = new Map();
    for (const line of out.split(/\r?\n/)) {
      // 实际输出格式是 `origin<TAB>https://host/owner/repo.git (fetch)`：
      // 远程名与 URL 之间是 TAB，而 URL 与 (fetch|push) 之间是**空格**。
      // 旧正则写成 `\t(fetch)`（要求 URL 后也是 TAB），于是永远匹配不到——
      // 探测结果恒为空 → 项目卡永远「未记录远程」、classify 的 Git 收敛永不触发、
      // 同一仓库必然裂成多张卡。这里按真实格式解析。
      const m = line.match(/^(\S+)\t(.+?)\s+\((fetch|push)\)\s*$/);
      if (!m) continue;
      const [, name, url, kind] = m;
      if (kind !== "fetch") continue; // fetch 与 push 的 URL 通常相同，只取 fetch
      if (!byName.has(name)) byName.set(name, []);
      const urls = byName.get(name);
      if (!urls.includes(url)) urls.push(url);
    }
    // origin 优先，其余保持 git 的字母序（git remote -v 按名称排序，稳定可预期）
    const names = [...byName.keys()].sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
    const seen = new Set();
    for (const name of names) {
      const urls = byName.get(name) || [];
      for (const raw of urls) {
        const parsed = normalizeGitRemote(raw);
        if (!parsed) continue;
        // 去重按 host+owner+repo：同名仓库挂两个 URL（ssh/https）只留一条
        const key = `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...parsed, name });
      }
    }
  } catch {
    list = [];
  }
  setBoundedCache(remotesCache, cwd, list);
  return list;
}

/**
 * 兼容入口：**身份**只取 origin（无 origin 则 null）。
 *
 * 为什么不取「任意第一个远程」：slug（项目身份）与 frontmatter 的 git 字段都由它派生。
 * 一个仓库可能挂着 upstream（上游）、别人的 remote（参考/误配）——把它们当身份，
 * 会让项目被判成另一个仓库。旧实现走 `git remote get-url origin`（origin 缺失即失败），
 * 这里保持同一语义；其余远程只用于「远程仓库列表」展示（detectGitRemotes）。
 */
function detectGitRemote(cwd) {
  const list = detectGitRemotes(cwd);
  return list.find((r) => r.name === "origin") || null;
}

/** 家目录下这些子目录本身永远不是项目根（项目只会在它们的子级里） */
const GENERIC_HOME_DIRS = ["Desktop", "Documents", "Downloads", "AppData", "Pictures", "Videos", "Music", "OneDrive"];

/**
 * 该路径是否算「本项目的本地路径」——比 isProjectDirCandidate 更严：要求**能证明归属**。
 *
 * 为什么不能只按「存在 + 不太浅」收：cwd 记的是**会话启动目录**，一次会话完全可能在
 * 与本项目无关的目录里启动（实测收进来过 `~/.dsh`、WorkBuddy 会话目录）。这类路径
 * 记到项目卡上就是错的。
 *
 * 归属证明有两条，满足其一即可：
 *   ① 它是 Git 仓库，且 origin 与该项目已确认的远程一致（项目身份的强证据）
 *   ② 它的目录名与项目名/slug 归一后相同（如 `~/_work/my-proj` ↔ 项目 my-proj）
 * 否则不收——宁可少记一条路径，也不要把别的目录挂到项目上。
 */
function isPathForProject(dir, project) {
  if (!isProjectDirCandidate(dir)) return false;
  if (!fs.existsSync(dir)) return false;
  const names = [project && project.slug, project && project.name, ...((project && project.aliases) || [])]
    .filter(Boolean).map(normalizeName);
  const base = normalizeName(path.basename(dir));
  if (base && names.includes(base)) return true;
  const origin = detectGitRemote(dir);
  if (origin && (project.remotes || []).includes(origin.display)) return true;
  return false;
}

/**
 * 台账「远程仓库」列的内容 —— **必须有 origin 才算身份**。
 * 为什么不是「列出全部 remote」：一个目录可能只挂了 upstream、或误配了别人的仓库
 * （实测某项目目录里只有一条指向他人仓库的 upstream）。这类 remote 不代表本项目身份，
 * 列出来等于把项目卡显示成别人的仓库。有 origin 时才返回全部 remote（origin 优先），
 * 这样 fork + 上游能同时看到；没有 origin 就返回空，UI 显示「未记录远程」。
 */
function displayRemotesFor(cwd) {
  if (!cwd) return [];
  const all = detectGitRemotes(cwd);
  if (!all.some((r) => r.name === "origin")) return [];
  return all.map((r) => r.display);
}

/**
 * 该路径是否像「项目根」——用于过滤 cwd 里混进来的过浅路径。
 *
 * 为什么需要：会话 cwd 可能是家目录或盘符根（实测有记忆把家目录本身记成了项目路径）。
 * 这类路径收进 localPaths 没有意义，还会让项目卡显示一个像样的「本地路径」。
 * 判定刻意保守：只挡「盘符根 / 家目录本身 / 家目录下的通用目录本身」，
 * 不按目录名黑名单（`work`、`src` 这类名字完全可能是真项目），也不按层级深度。
 */
function isProjectDirCandidate(p) {
  if (!p || typeof p !== "string") return false;
  let abs;
  try { abs = path.resolve(p); } catch { return false; }
  if (path.dirname(abs) === abs) return false; // 盘符根（C:\）或文件系统根（/）
  const home = (() => { try { return path.resolve(require("os").homedir()); } catch { return ""; } })();
  if (home && abs.toLowerCase() === home.toLowerCase()) return false; // 家目录本身
  if (home && path.dirname(abs).toLowerCase() === home.toLowerCase()) {
    if (GENERIC_HOME_DIRS.includes(path.basename(abs))) return false;
  }
  return true;
}

function findGitRoot(cwd) {
  if (!cwd) return null;
  const cached = gitRootCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const root = out.trim() || null;
    setBoundedCache(gitRootCache, cwd, root);
    return root;
  } catch {
    setBoundedCache(gitRootCache, cwd, null);
    return null;
  }
}

// ---------- 名称相似度（模糊归类的依据） ----------

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[-_\s]+/g, "");
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function nameSimilarity(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const dist = editDistance(x, y);
  return 1 - dist / Math.max(x.length, y.length);
}

// ---------- 项目归类：显示名裁决与 Git 分组 ----------

/**
 * 从 slug 反解仓库名：slug 由 `host--owner--repo` / `owner--repo` 拼成，末段即 repo。
 * 单段 slug（显式项目名/中文名/目录名）不反解——无法区分「名字」与「repo」，猜错的代价大于收益。
 */
function repoNameFromSlug(slug) {
  const parts = String(slug || "").split("--").filter(Boolean);
  if (parts.length < 2) return "";
  return parts[parts.length - 1];
}

/**
 * 显示名质量分：越高越像「人看的名字」。
 * 0 空 / 1 机器串 / 2 URL 或路径形态 / 3 真名。
 *
 * 判定「name 是否只是 slug 的机器串」时不能只看「两者相等」：显式项目名的 slug 本身就是
 * 中文/真名（虎林农业、吉林前端），此时 name===slug 恰恰是最好的名字。只有 slug 呈
 * `owner--repo` / `host--owner--repo` 形态时，相等才说明卡名是机器名。
 * 路径形态名（D:\私人项目\虎林农业）也不是人读的项目名，与 URL 形态同档——
 * 否则合并「虎林农业」与「D:\私人项目\虎林农业」时，路径名会以 3 分压过真名，卡名被写成路径。
 */
function scoreDisplayName(name, slug) {
  const n = String(name || "").trim();
  if (!n) return 0;
  const s = String(slug || "").toLowerCase();
  if (n.toLowerCase() === s) return s.includes("--") ? 1 : 3;
  if (isPathLike(n)) return 2;
  if (n.includes("/")) return 2;
  return 3;
}

/**
 * 写入时的显示名裁决：已有台账名不比新候选差就保留原值。
 *
 * 为什么不能直接用调用方传入的串：同一个项目的写入方五花八门——MCP 传 slug、
 * 导入传目录名、老版本传项目名，无条件覆盖会让卡片名在「真名 ↔ 机器串」之间来回抖动
 * （实测 AgentHub 项目的名字被写成 huidada1--agenthub）。用户手动改的名（nameManual）永远优先。
 */
function resolveWriteName(entry, candidate) {
  const cur = entry ? String(entry.name || "").trim() : "";
  const next = String(candidate == null ? "" : candidate).trim();
  if (entry && entry.nameManual && cur) return cur;
  if (cur && scoreDisplayName(cur, entry.slug) >= scoreDisplayName(next, entry.slug)) return cur;
  return next;
}

function pickBestName(candidates, slug) {
  let best = "";
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreDisplayName(c, slug);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= 2 ? best : "";
}

/**
 * 按 Git 远程地址把项目台账条目归组（并查集）。
 *
 * 强证据：两张卡持有同一个远程（归一化后相等）⇒ 同一仓库。
 * 弱证据（仅对**没有远程**的条目启用）：候选名（name / slug 反解 repo / 本地路径目录名）
 * 与某个「有远程条目」的仓库名精确相等 ⇒ 归入该组。用于救「早期显式项目名写入不探测 Git」
 * 的卡片（实测 AgentHub 项目就因此裂成 `huidada1--agenthub` 与无远程的 `agenthub` 两张卡）。
 * 刻意不做模糊相似度：模糊匹配是 classify 建议队列的活（只给人看、不落台账），
 * 自动改名必须可预测、可复核。
 * @returns {Array<Array<object>>} 每个元素是一组台账条目（单条自成一组的也返回）
 */
function groupEntries(entries) {
  const list = (entries || []).filter((e) => e && e.slug);
  const key = (e) => String(e.slug).toLowerCase();
  const parent = new Map();
  for (const e of list) if (!parent.has(key(e))) parent.set(key(e), key(e));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const hasRemote = (e) => effectiveRemotes(e).length > 0;

  // ① 远程交集连边：remotes 与 gitUrl 都算证据（gitUrl 是历史同步带过来的完整地址，
  //    此前只认 remotes，导致「有 gitUrl 却 remotes 为空」的卡片归不进同仓库组）
  const owner = new Map(); // 远程身份键 → 首个持有条目
  for (const e of list) {
    for (const r of effectiveRemotes(e)) {
      const k = remoteKeyOf(r);
      if (!k) continue;
      if (owner.has(k)) union(key(e), owner.get(k));
      else owner.set(k, key(e));
    }
  }
  const repoIndex = new Map(); // 归一化仓库名 → 有远程条目的 slug
  for (const remote of owner.keys()) {
    const k = normalizeName(remote.split("/").pop());
    // 长度阈值挡「app」「ui」这类极短名的偶合
    if (k && k.length >= 4 && !repoIndex.has(k)) repoIndex.set(k, owner.get(remote));
  }

  // ② 无远程条目 ↔ 有远程条目：候选名与仓库名精确相等（救早期显式项目名写入不探测 Git 的卡）
  for (const e of list) {
    if (hasRemote(e)) continue;
    for (const c of nameCandidates(e)) {
      const k = normalizeName(c);
      if (!k || k.length < 4) continue;
      const hit = repoIndex.get(k);
      if (hit) { union(key(e), hit); break; }
    }
  }

  // ③ 无远程条目之间：名称候选精确相等（含路径形态名取末段）。
  //    典型场景：「D:\私人项目\虎林农业」与「虎林农业」是同项目的两种写法，两边都没有远程，
  //    只靠 ② 永远连不上。仍然只做**完全相等**，不做模糊相似度。
  const nameIndex = new Map(); // 归一化名称 → 首个条目 slug
  for (const e of list) {
    for (const c of nameCandidates(e)) {
      const k = normalizeName(c);
      if (!k || k.length < 4) continue;
      if (!nameIndex.has(k)) nameIndex.set(k, key(e));
    }
  }
  for (const e of list) {
    if (hasRemote(e)) continue;
    for (const c of nameCandidates(e)) {
      const k = normalizeName(c);
      if (!k || k.length < 4) continue;
      const hit = nameIndex.get(k);
      if (hit && hit !== key(e)) { union(key(e), hit); break; }
    }
  }

  const groups = new Map();
  for (const e of list) {
    const root = find(key(e));
    const g = groups.get(root);
    if (g) g.push(e);
    else groups.set(root, [e]);
  }
  return [...groups.values()];
}

/**
 * 组内统一显示名。优先级：
 *   ① 用户手动改过的名（nameManual，多条时取 updated 最新）——自动归类绝不覆盖人工命名；
 *   ② 真实来源候选：远程仓库名、非 slug 形态的既有 name（取其中打分最高者）；
 *   ③ 从 slug 反解的仓库名（推导，仅在没有真实来源时兜底）；
 *   ④ 兜底保留组内最早条目的 slug。
 * 遍历按 created 升序、同分保留先出现的候选 —— 同一份台账每次得到同一个名字（幂等）。
 */
function pickGroupName(members) {
  const sorted = [...members].sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
  const manual = sorted
    .filter((e) => e.nameManual && String(e.name || "").trim())
    .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
  if (manual.length) return String(manual[0].name).trim();

  const baseSlug = String(sorted[0].slug || "");
  const candidates = [];
  for (const e of sorted) {
    if (scoreDisplayName(e.name, e.slug) >= 2) candidates.push(String(e.name).trim());
    for (const r of effectiveRemotes(e)) {
      const repo = String(r || "").split("/").pop();
      if (repo && repo.trim()) candidates.push(repo.trim());
    }
  }
  const best = pickBestName(candidates, baseSlug);
  if (best) return best;
  for (const e of sorted) {
    const repo = repoNameFromSlug(e.slug);
    if (repo) return repo;
  }
  return baseSlug;
}

// Claude Code 的会话目录名是把原路径的 "/" 换成 "-"：取最后一段做项目名候选
// （不还原完整路径：路径里的连字符无法与分隔符区分，只取末段对"归类到哪个项目"足够）
function reverseClaudeDirName(name) {
  if (!name || typeof name !== "string") return null;
  if (!name.startsWith("-")) return null;
  const parts = name.split("-").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}

// 会话目录名反解成工作目录：workbuddy 这类工具把 cwd 编码进目录名（首段是盘符、其余按 "-" 分段），
// 例如 "e-公司项目-商丘水闸前端" → E:\公司项目\商丘水闸前端。
// 段本身可能带连字符（"deepseek-harness" 是一层目录还是两层，名字上看不出来），所以必须消歧。
// 做法：按「目录层级从少到多」迭代加深，但每一层先用 statSync 剪枝——前缀不是真实目录的分支
// 根本走不到底，搜索量随真实目录结构收敛。既保住「层级越少越优先」的老偏好（层级越多、
// 恰好存在同名路径的概率越低），又不像穷举 2^(n-1) 那样必须设段数上限
// （旧实现超过 8 段直接放弃，深层 cwd 一律归 general）。
// 解不出来就返回空串、由调用方归 general——猜错的代价（记忆挂到别的项目下）远大于不猜
function reverseSessionDirName(name) {
  const raw = String(name == null ? "" : name).trim();
  const direct = reverseEncodedDir(raw);
  if (direct) return direct;
  // WorkBuddy 系（中国版 ~/.workbuddy 与国际版 ~/.workbuddy-ai 同构）把「cwd + 会话启动时间」
  // 一起编码进目录名（如 "c-Users-...-WorkBuddy-2026-08-17-17-27-00"）：整名反解必然失败，
  // 去掉尾部时间戳再解一次。只认日历上说得通的六段，避免把项目名里的数字段剥掉
  // （如 "e-idea work-AgentHub" 若被剥成 "e-idea work" 会把记忆挂到错误项目下）
  const stripped = stripSessionTimestamp(raw);
  return stripped ? reverseEncodedDir(stripped) : "";
}

/** 尾部 "-YYYY-MM-DD-HH-mm-ss" 会话时间戳（校验数值范围，合法才返回去掉后的名字） */
function stripSessionTimestamp(name) {
  const m = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return "";
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100) return "";
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return "";
  return name.slice(0, m.index);
}

/** 单次反解（编码 cwd → 真实目录），供 reverseSessionDirName 复用 */
function reverseEncodedDir(name) {
  const m = /^([a-zA-Z])-(.+)$/.exec(name);
  if (!m) return "";
  const drive = m[1].toUpperCase() + ":" + path.sep;
  const segs = m[2].split("-").filter(Boolean);
  const n = segs.length;
  if (!n) return "";
  const isDir = (p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  };
  if (!isDir(drive)) return "";
  // 搜索预算：只在「前缀确实是真实目录」的分支上消耗，正常路径几十次 stat 内命中；
  // 留上限是防病态目录名把主进程拖住
  let budget = 512;
  // 用恰好 depthLeft 个目录名覆盖 segs[i..n-1]，最后一个目录名吃满剩余段
  const build = (i, depthLeft, parent) => {
    if (--budget < 0) return "";
    if (depthLeft === 1) {
      const candidate = parent + segs.slice(i).join("-");
      return isDir(candidate) ? candidate : "";
    }
    // 当前目录名最多吃到第 n-depthLeft 段：后面每层至少还要吃掉一段
    for (let j = i; j <= n - depthLeft; j++) {
      const here = parent + segs.slice(i, j + 1).join("-");
      if (!isDir(here)) continue;
      const found = build(j + 1, depthLeft - 1, here + path.sep);
      if (found) return found;
    }
    return "";
  };
  for (let depth = 1; depth <= n; depth++) {
    const found = build(0, depth, drive);
    if (found) return found;
    if (budget < 0) return "";
  }
  return "";
}

// ---------- 项目台账 ----------

class ProjectRegistry {
  constructor(rootDir) {
    this.root = rootDir;
    this.file = path.join(rootDir, "projects", "_index.json");
    this._cache = null;
  }

  _signature() {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  }

  _load() {
    // 台账可能被另一台设备同步进来/被用户手改：按文件签名失效，别拿旧缓存覆盖它
    const sig = this._signature();
    if (this._cache && sig === this._cacheSig) return this._cache;
    const r = readJsonSafe(this.file);
    this._cache = r.ok && r.data && Array.isArray(r.data.projects) ? r.data : { projects: [] };
    this._cacheSig = sig;
    return this._cache;
  }

  _save(prevJson) {
    // 台账内容没变化就不落盘（写入路径高频调用，避免每条记忆重写整个 JSON）
    const next = JSON.stringify(this._cache);
    if (prevJson === next) return;
    writeJsonAtomic(this.file, this._cache);
    this._cacheSig = this._signature();
    invalidateClassifyCache();
  }

  list() {
    return this._load().projects;
  }

  /**
   * 按 slug 取条目：大小写不敏感。
   * slug 自 v1.41.0 起一律折小写（NTFS 目录大小写不敏感，不折会让 MyApp/myapp 混住同一目录），
   * 但台账里可能还留着迁移前的大写条目（AgentHub / China_Cities）。精确匹配会让新写入的
   * 小写 slug 找不到既有卡片、于是又新建一张 —— UI 上同一个项目裂成两张同名卡。
   */
  get(slug) {
    const want = String(slug || "").toLowerCase();
    return this._load().projects.find((p) => String(p.slug).toLowerCase() === want) || null;
  }

  /**
   * 按远程找已登记的项目卡（同一仓库不论写成 URL / host+owner+repo / owner/repo 都能命中）。
   * 用于写入时把「显式项目名」与「Git 归类」收敛到同一张卡，避免同一仓库裂出第二张卡。
   */
  findByRemote(remote) {
    const key = remoteKeyOf(remote);
    if (!key) return null;
    return this._load().projects.find((p) =>
      effectiveRemotes(p).some((r) => remoteKeyOf(r) === key),
    ) || null;
  }

  /**
   * 按名称精确找卡（name/slug/反解仓库名/别名/本地路径目录名，归一后相等）。
   * 只有**唯一命中**才返回：同名多卡时不做猜测，交给调用方按原逻辑建卡/归类。
   */
  findByNameOrAlias(name) {
    const want = normalizeName(name);
    if (!want) return null;
    const hits = this._load().projects.filter((p) =>
      nameCandidates(p).some((c) => normalizeName(c) === want),
    );
    if (hits.length === 1) return hits[0];
    // 多张卡同名时优先「真名卡」：路径形态名（D:\...\虎林农业）不是人读的项目名，
    // 若把它和「虎林农业」判成两张同名卡就不敢归一了；这里把非路径形态的候选挑出来，
    // 只有唯一一个时才认。
    const clean = hits.filter((p) => !isPathLike(p.name));
    return clean.length === 1 ? clean[0] : null;
  }

  upsert(entry) {
    const data = this._load();
    const prevJson = JSON.stringify(data);
    const want = String(entry.slug || "").toLowerCase();
    const idx = data.projects.findIndex((p) => String(p.slug).toLowerCase() === want);
    const now = Date.now();
    if (idx >= 0) {
      const cur = data.projects[idx];
      // 命中旧的大写条目时把 slug 归一到小写：否则本次写入会带着小写 slug 落到索引，
      // 而卡片还叫大写，projects() 的 slug 精确关联随即对不上（卡片条数显示 0）
      const merged = { ...cur, ...entry, slug: sanitizeSlug(entry.slug || cur.slug) || cur.slug || "unknown", updated: now };
      // 空值不覆盖已有名：写入方不带 name 时（如 projectAttachPath 传 name: undefined）
      // 之前会把台账里的真名抹成 undefined，卡片随即显示空白
      if (!merged.name && cur.name) merged.name = cur.name;
      if (entry.gitUrl || cur.gitUrl) merged.gitUrl = String(entry.gitUrl || cur.gitUrl);
      if (entry.nameManual || cur.nameManual) merged.nameManual = true;
      merged.remotes = Array.from(new Set([...(cur.remotes || []), ...(entry.remotes || [])]));
      merged.localPaths = Array.from(new Set([...(cur.localPaths || []), ...(entry.localPaths || [])]));
      // manualPaths 记录「用户手动关联」的路径（可信断言，自愈不得以缺证明为由清除）
      merged.manualPaths = Array.from(new Set([...(cur.manualPaths || []), ...(entry.manualPaths || [])]));
      merged.aliases = Array.from(new Set([...(cur.aliases || []), ...(entry.aliases || [])]));
      merged.agents = Array.from(new Set([...(cur.agents || []), ...(entry.agents || [])]));
      // 写入路径每条记忆都会来一次 upsert：除 updated 外没有任何实质变化就不动台账，
      // 否则每条都要重写整个 JSON，白白拖慢导入
      const strip = (o) => { const { updated, ...rest } = o; return JSON.stringify(rest); };
      if (strip(cur) === strip(merged)) return cur;
      data.projects[idx] = merged;
    } else {
      const added = {
        slug: entry.slug,
        name: entry.name || entry.slug,
        remotes: entry.remotes || [],
        aliases: entry.aliases || [],
        localPaths: entry.localPaths || [],
        manualPaths: entry.manualPaths || [],
        agents: entry.agents || [],
        origin: entry.origin || "git",
        created: now,
        updated: now,
      };
      if (entry.gitUrl) added.gitUrl = String(entry.gitUrl);
      if (entry.nameManual) added.nameManual = true;
      data.projects.push(added);
    }
    this._save(prevJson);
    return this.get(entry.slug);
  }

  remove(slug) {
    const data = this._load();
    // 大小写归一比较：slug 生成已折小写，但历史脏数据/手工台账可能残留大写，
    // 严格相等会让「删不掉」——前端点删除静默无效果
    const target = String(slug || "").toLowerCase();
    data.projects = data.projects.filter((p) => String(p.slug || "").toLowerCase() !== target);
    this._save();
  }

  /**
   * 覆盖式写元数据（仅自愈纠正用，不是常规写入路径）。
   *
   * 为什么需要：`upsert` 对 remotes/localPaths 是**并集**语义，只增不减——于是自愈一旦写入
   * 无效路径（如家目录），就永远清不掉。自愈需要「纠正」能力，故单独给一个整体覆盖的入口，
   * 且只覆盖这两个数组，其余字段（name/aliases/agents/origin/created）保持不动。
   */
  setMeta(slug, patch) {
    const data = this._load();
    const prevJson = JSON.stringify(data);
    const want = String(slug || "").toLowerCase();
    const idx = data.projects.findIndex((p) => String(p.slug).toLowerCase() === want);
    if (idx < 0) return null;
    const cur = data.projects[idx];
    const next = { ...cur };
    if (Array.isArray(patch.remotes)) next.remotes = Array.from(new Set(patch.remotes.filter(Boolean)));
    if (Array.isArray(patch.localPaths)) next.localPaths = Array.from(new Set(patch.localPaths.filter(Boolean)));
    if (Array.isArray(patch.manualPaths)) next.manualPaths = Array.from(new Set(patch.manualPaths.filter(Boolean)));
    // 合并项目时要把源卡的别名/Agent 并进来：别名是「同一项目的另一种写法」的稳定映射，
    // 少了它，合并后旧写法再写入仍会裂出一张新卡
    if (Array.isArray(patch.aliases)) next.aliases = Array.from(new Set(patch.aliases.filter(Boolean)));
    if (Array.isArray(patch.agents)) next.agents = Array.from(new Set(patch.agents.filter(Boolean)));
    if (typeof patch.gitUrl === "string") next.gitUrl = patch.gitUrl;
    if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim();
    if (patch.nameManual === true) next.nameManual = true;
    if (Number.isFinite(patch.created)) next.created = Math.min(Number(cur.created) || Number(patch.created), Number(patch.created));
    next.updated = Date.now();
    const strip = (o) => { const { updated, ...rest } = o; return JSON.stringify(rest); };
    if (strip(cur) === strip(next)) return cur;
    data.projects[idx] = next;
    this._save(prevJson);
    return this.get(slug);
  }

  /**
   * 台账自愈：slug 折小写 + 合并「折小写后撞车」的重复条目。
   * v1.42.1 之前写入路径按小写 slug 找台账、watcher 按目录真名建卡，同一个项目在台账里
   * 留下两条（AgentHub / agenthub）：projects() 逐条出卡就是「同一项目两张卡」，其中一张
   * 条数还是 0（索引行的 project 值对不上）。这里是存量数据的收口——只折大小写，
   * 不动 sanitizeSlug 的其它变换（去非法字符/截断会改名，反而让卡片与索引行对不上）。
   *
   * 注意「折」与「并」是两件事：没有孪生条目的单条大写 slug 也必须折（索引侧 reindexFile
   * 会把 project 折成小写，台账不折就永远对不上 → 卡片 0 条），所以改动计数要覆盖改名。
   * 幂等：折完没有条目被改名/合并就不落盘。
   * @returns {number} 被改名或合并掉的条目数（0 表示台账本来就没有大写 slug）
   */
  normalize() {
    const data = this._load();
    const prevJson = JSON.stringify(data);
    const out = [];
    const bySlug = new Map();
    let changed = 0;
    for (const p of data.projects) {
      const slug = String(p.slug || "").toLowerCase();
      const hit = bySlug.get(slug);
      if (!hit) {
        if (slug === p.slug) { bySlug.set(slug, p); out.push(p); continue; }
        const entry = { ...p, slug };
        bySlug.set(slug, entry);
        out.push(entry);
        changed++;
        continue;
      }
      changed++;
      const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
      hit.remotes = union(hit.remotes, p.remotes);
      hit.localPaths = union(hit.localPaths, p.localPaths);
      hit.aliases = union(hit.aliases, p.aliases);
      hit.agents = union(hit.agents, p.agents);
      const created = [hit.created, p.created].filter((x) => Number.isFinite(x));
      const updated = [hit.updated, p.updated].filter((x) => Number.isFinite(x));
      if (created.length) hit.created = Math.min(...created);
      if (updated.length) hit.updated = Math.max(...updated);
      if (!hit.gitUrl && p.gitUrl) hit.gitUrl = p.gitUrl;
      if (p.nameManual) hit.nameManual = true;
      // 名字留着给人看：取质量分更高的（真名 > URL 形态 > slug 机器串）
      if (scoreDisplayName(p.name, slug) > scoreDisplayName(hit.name, slug)) hit.name = p.name;
    }
    if (!changed) return 0;
    data.projects = out;
    this._save(prevJson);
    return changed;
  }

  /**
   * 项目归类（启动自愈与 6 小时索引扫描都调用）：把同一 Git 仓库的多个台账条目归为一组，
   * 组内统一显示名（name），并互相补全 remotes / gitUrl。
   *
   * 为什么需要：同一仓库会因不同写入路径裂成多张卡——显式项目名写入（slug=项目名）与
   * Git 归类（slug=owner--repo）各建一张；早期显式写入不探测 Git，于是卡片既没远程、
   * 名字又是 slug 机器串（界面上的「huidada1--agenthub」就是这么来的）。
   * 归组证据与命名规则见 groupEntries / pickGroupName；**只统一显示名与元数据，
   * 不合并卡片、不搬动任何记忆文件**：slug 是记忆归属的稳定键，物理合并（projectMerge）
   * 会搬文件、改索引，风险远大于收益。幂等：无实际变化不落盘。
   * @returns {{changed:number, groups:number}} changed = 被改名/补元数据的条目数
   */
  regroup() {
    const data = this._load();
    const prevJson = JSON.stringify(data);
    const groups = groupEntries(data.projects);
    let changed = 0;
    for (const members of groups) {
      if (!members.length) continue;
      const displayName = pickGroupName(members);
      // 组内 remotes 并集：同一仓库的多个 remote 对组内每张卡都成立（fork/上游都能看到）
      const remotes = [];
      const seen = new Set();
      for (const e of members) {
        for (const r of e.remotes || []) {
          const k = String(r || "").trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          remotes.push(String(r).trim());
        }
      }
      const gitUrl = members.map((e) => String(e.gitUrl || "").trim()).find(Boolean) || "";
      for (const e of members) {
        if (displayName && e.name !== displayName) { e.name = displayName; changed++; }
        const sameRemotes = (e.remotes || []).length === remotes.length
          && (e.remotes || []).every((r, i) => String(r || "").trim().toLowerCase() === remotes[i].toLowerCase());
        if (!sameRemotes) { e.remotes = [...remotes]; changed++; }
        if (gitUrl && e.gitUrl !== gitUrl) { e.gitUrl = gitUrl; changed++; }
      }
    }
    if (!changed) return { changed: 0, groups: groups.length };
    this._save(prevJson);
    return { changed, groups: groups.length };
  }

  // 名称模糊匹配：返回最相似的已登记项目（不自动合并，只给建议）
  suggest(nameCandidate, threshold) {
    const projects = this._load().projects;
    let best = null;
    for (const p of projects) {
      const names = [p.name, p.slug, ...(p.aliases || []), ...(p.localPaths || []).map((x) => path.basename(x))];
      let score = 0;
      for (const n of names) score = Math.max(score, nameSimilarity(nameCandidate, n));
      if (!best || score > best.score) best = { slug: p.slug, name: p.name, score };
    }
    if (best && best.score >= (threshold || 0.62)) return best;
    return null;
  }
}

// ---------- 归类判定树（§21.7） ----------

/**
 * 判定一条记忆的归属项目。
 * @param {object} input { project?, cwd?, agent? }
 * @param {ProjectRegistry} registry
 * @param {object} cfg { fuzzyThreshold, autoCreateProject }
 * @returns {{ slug: string|null, name: string|null, origin: string, suggestion?: object }}
 *   slug 为 null 表示归入 general/；origin ∈ explicit|git|gitroot|fuzzy-auto|general-suggest|general
 */
// 归类结果缓存：同一个 (项目/工作目录/agent) 的结论是一致的，而导入时同一个 cwd 会被问上千次，
// 每次都跑 git 子命令（十几毫秒一次）。台账真正落盘时才整体作废，避免拿过期项目列表归类
const classifyCache = new Map();
function invalidateClassifyCache() {
  classifyCache.clear();
}

function classify(input, registry, cfg) {
  const key = [
    (registry && registry.root) || "",
    (input && input.project) || "",
    (input && input.cwd) || "",
    (input && input.agent) || "",
    // 归类配置参与 key：fuzzyThreshold/gitPreferred 等改动后旧结论不能继续命中
    // （general/general-suggest 结果不落 registry 台账，台账作废清不到它们）
    (cfg && cfg.fuzzyThreshold) ?? "",
    (cfg && cfg.autoCreateProject) ?? "",
    (cfg && cfg.gitPreferred) ?? "",
  ].join("\u0000");
  const hit = classifyCache.get(key);
  if (hit) return hit;
  const result = classifyUncached(input, registry, cfg);
  if (classifyCache.size >= 5000) classifyCache.clear();
  classifyCache.set(key, result);
  return result;
}

function classifyUncached(input, registry, cfg) {
  const { project, cwd, agent } = input || {};
  const fuzzyThreshold = cfg && cfg.fuzzyThreshold != null ? cfg.fuzzyThreshold : 0.62;
  const gitPreferred = !cfg || cfg.gitPreferred !== false;

  if (project && typeof project === "string" && project.trim()) {
    const raw = project.trim();
    // 项目名允许写成绝对路径（Agent 常把 cwd 当 project 传）：身份取末段目录名，
    // 否则「D:\私人项目\虎林农业」会被 sanitize 成一整串路径 slug，与「虎林农业」裂成两张卡。
    const looksPath = isPathLike(raw);
    const baseName = looksPath ? (path.basename(raw.replace(/[\\/]+$/, "")) || raw) : raw;
    // 探测目录：优先调用方 cwd；没有 cwd 但显式项目名本身就是存在的路径时，用它探测（同一身份证据）
    const probe = cwd || (looksPath && fs.existsSync(raw) ? raw : "");
    const remote = gitPreferred && probe ? detectGitRemote(probe) : null;
    let slug = sanitizeSlug(baseName);
    let nameCandidate = baseName;
    if (remote) {
      // 显式项目名与 cwd 探测到的仓库是同一身份时，收敛到 **Git 规范 slug**：
      // 客户端写法五花八门（"AgentHub" / "HUIdada1/AgentHub" / "huidada1--agenthub"），
      // 各写各的就会给同一仓库裂出多张卡。仓库名/展示名/规范 slug 都算同一身份。
      const variants = [
        remote.repo, remote.display, remote.slug, remote.url,
        `${remote.owner}-${remote.repo}`, `${remote.owner}--${remote.repo}`,
      ].filter(Boolean).map(normalizeName);
      const holder = registry.findByRemote(remote);
      if (variants.includes(normalizeName(baseName))) {
        slug = remote.slug;
        nameCandidate = remote.repo;
      } else if (holder) {
        // 自定义项目名也归到该仓库已登记的卡上：同一仓库只应有一张卡
        slug = holder.slug;
        nameCandidate = holder.name || baseName;
      }
    } else {
      // 没有 cwd/远程证据：按名称/别名/路径末段精确对齐已登记卡片（唯一命中才用，避免猜错）
      const hit = registry.findByNameOrAlias(baseName);
      if (hit) {
        slug = hit.slug;
        nameCandidate = hit.name || baseName;
      }
    }
    // 显式项目名优先只决定「归到哪张卡」，不该顺手丢掉可探测的元数据：
    // 探测目录存在就一并补远程与本地路径（此前提前 return，导致显式项目卡永远没有远程）。
    const remotes = remote ? displayRemotesFor(probe) : [];
    const gitUrl = remote ? remote.url : "";
    const gitRoot = gitPreferred && probe ? findGitRoot(probe) : null;
    const localPath = gitRoot || probe || "";
    // 只记「能证明属于本项目」的路径：目录名匹配项目名，或该仓库 origin 与本次探测到的远程一致。
    // 会话 cwd 可能是任意目录（实测收进过 ~/.dsh、WorkBuddy 会话目录），不能无脑记。
    const proven = !!(localPath && isPathForProject(localPath, {
      slug, name: nameCandidate, aliases: [], remotes,
    }));
    // 原始写法留作别名：把路径形态/展示形态的用户写法记下来，后续同类写入能对齐到同一张卡
    const aliases = [];
    if (sanitizeSlug(raw) !== slug) aliases.push(raw);
    if (looksPath && baseName && normalizeName(baseName) !== normalizeName(nameCandidate)) aliases.push(baseName);
    // 显示名裁决：调用方传的多半是项目名，但 Agent 常把 slug 当项目名传进来 —— 不能无条件
    // 覆盖已登记的真名，否则同一张卡的名字会在「真名 ↔ 机器串」之间随写入方来回抖动
    const name = resolveWriteName(registry.get(slug), nameCandidate);
    registry.upsert({
      slug,
      name,
      remotes,
      gitUrl,
      aliases,
      localPaths: proven ? [localPath] : [],
      agents: agent ? [agent] : [],
      origin: "explicit",
    });
    return { slug, name, origin: "explicit" };
  }

  const remote = gitPreferred ? detectGitRemote(cwd) : null;
  if (remote) {
    // 已登记卡持有同一远程时优先沿用它（哪怕 slug 还是历史非规范写法），
    // 否则会在同一仓库旁边再建一张「规范 slug」新卡——这正是裂卡的来源之一
    const holder = registry.findByRemote(remote);
    const slug = holder ? holder.slug : remote.slug;
    const name = resolveWriteName(registry.get(slug), remote.repo);
    registry.upsert({
      slug,
      name,
      remotes: displayRemotesFor(cwd),
      gitUrl: remote.url,
      localPaths: cwd ? [findGitRoot(cwd) || cwd] : [],
      agents: agent ? [agent] : [],
      origin: "git",
    });
    return { slug, name, origin: "git" };
  }

  const gitRoot = gitPreferred ? findGitRoot(cwd) : null;
  if (gitRoot) {
    const base = path.basename(gitRoot);
    const slug = sanitizeSlug(base);
    const name = resolveWriteName(registry.get(slug), base);
    registry.upsert({ slug, name, localPaths: [gitRoot], agents: agent ? [agent] : [], origin: "gitroot" });
    return { slug, name, origin: "gitroot" };
  }

  const dirName = cwd ? path.basename(cwd) : "";
  if (dirName) {
    const exact = registry.list().find((p) =>
      [p.name, p.slug, ...(p.aliases || [])].some((n) => normalizeName(n) === normalizeName(dirName)));
    if (exact) {
      registry.upsert({ slug: exact.slug, localPaths: cwd ? [cwd] : [], agents: agent ? [agent] : [] });
      return { slug: exact.slug, name: exact.name, origin: "fuzzy-auto", confidence: 1 };
    }
    const suggestion = registry.suggest(dirName, fuzzyThreshold);
    if (suggestion) {
      if (cfg && cfg.autoCreateProject) {
        const slug = sanitizeSlug(dirName);
        const name = resolveWriteName(registry.get(slug), dirName);
        registry.upsert({ slug, name, localPaths: [cwd], agents: agent ? [agent] : [], origin: "fuzzy-auto" });
        return { slug, name, origin: "fuzzy-auto", confidence: suggestion.score };
      }
      return { slug: null, name: null, origin: "general-suggest", suggestion: { ...suggestion, candidate: dirName, cwd } };
    }
  }

  return { slug: null, name: null, origin: "general" };
}

// ---------- 路径拼装 ----------

function memoryRelPath({ slug, layer, agent, type, dateStr, id }) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  if (layer === "l2") {
    const sub = type === "decision" ? "decisions" : type === "knowledge" ? "knowledge" : type === "insight" ? "insight" : "summary";
    const base = slug ? `projects/${slug}/l2/${sub}` : `general/l2/${sub}`;
    // l2 一律每条一个文件。白名单外的 type（如 profile）原先落到共享的 l2/summary.md：
    // 后写覆盖先写，索引里两条指向同一路径，删一条会把另一条变成 bodyMissing
    return `${base}/${id || date}.md`;
  }
  const base = slug ? `projects/${slug}/l1/${agent || "manual"}` : `general/l1/${agent || "manual"}`;
  if (type === "daily") return `${base}/${date}.md`;
  return `${base}/${date}-${id || "note"}.md`;
}

module.exports = {
  normalizeGitRemote, parseRemote, remoteKeyOf, sameRemote, effectiveRemotes, isPathLike, nameCandidates,
  sanitizeSlug, detectGitRemote, detectGitRemotes, displayRemotesFor, findGitRoot, normalizeName,
  isProjectDirCandidate, isPathForProject,
  nameSimilarity, reverseClaudeDirName, reverseSessionDirName, ProjectRegistry, classify, memoryRelPath,
  repoNameFromSlug, scoreDisplayName, resolveWriteName, groupEntries, pickGroupName,
};
