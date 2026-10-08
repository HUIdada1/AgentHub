/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
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
    const namesOut = execFileSync("git", ["-C", cwd, "remote"], {
      encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const names = namesOut.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    // origin 优先，其余保持 git 的字母序（git remote 本身按名称排序，稳定可预期）
    names.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
    const seen = new Set();
    for (const name of names) {
      let urls = [];
      try {
        const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "--all", name], {
          encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        });
        urls = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      } catch {
        continue;
      }
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
 * 0 空 / 1 与 slug 相同（机器串）/ 2 含 "/"（URL 形态，如 HUIdada1/AgentDrove）/ 3 真名。
 */
function scoreDisplayName(name, slug) {
  const n = String(name || "").trim();
  if (!n) return 0;
  if (n.toLowerCase() === String(slug || "").toLowerCase()) return 1;
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

  // ① 远程交集连边；同时登记「远程地址（小写）→ 首个持有条目」供弱证据使用
  const owner = new Map();
  for (const e of list) {
    for (const r of e.remotes || []) {
      const remote = String(r || "").trim().toLowerCase();
      if (!remote) continue;
      if (owner.has(remote)) union(key(e), owner.get(remote));
      else owner.set(remote, key(e));
    }
  }
  const repoIndex = new Map(); // 归一化仓库名 → 有远程条目的 slug
  for (const remote of owner.keys()) {
    const k = normalizeName(remote.split("/").pop());
    // 长度阈值挡「app」「ui」这类极短名的偶合
    if (k && k.length >= 4 && !repoIndex.has(k)) repoIndex.set(k, owner.get(remote));
  }

  // ② 无远程条目的弱证据连边
  const hasRemote = (e) => (e.remotes || []).some((r) => String(r || "").trim());
  for (const e of list) {
    if (hasRemote(e)) continue;
    const candidates = [
      String(e.name || "").trim(),
      repoNameFromSlug(e.slug),
      ...(e.localPaths || []).map((p) => path.basename(String(p || ""))),
    ];
    for (const c of candidates) {
      const k = normalizeName(c);
      if (!k || k.length < 4) continue;
      const hit = repoIndex.get(k);
      if (hit) { union(key(e), hit); break; }
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
    for (const r of e.remotes || []) {
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
  const m = /^([a-zA-Z])-(.+)$/.exec(String(name == null ? "" : name).trim());
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
      const merged = { ...cur, ...entry, slug: sanitizeSlug(entry.slug || cur.slug), updated: now };
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
    data.projects = data.projects.filter((p) => p.slug !== slug);
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
    if (typeof patch.gitUrl === "string") next.gitUrl = patch.gitUrl;
    if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim();
    if (patch.nameManual === true) next.nameManual = true;
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
    const slug = sanitizeSlug(project.trim());
    // 显式项目名优先只决定「归到哪张卡」，不该顺手丢掉可探测的元数据：
    // 客户端带了 cwd 就一并补远程与本地路径（此前提前 return，导致显式项目卡永远没有远程）。
    // 注意 slug 仍取显式项目名，不改成 owner--repo —— 否则同一项目会裂成两张卡。
    const remotes = gitPreferred ? displayRemotesFor(cwd) : [];
    const gitRoot = gitPreferred && cwd ? findGitRoot(cwd) : null;
    const localPath = gitRoot || cwd;
    // 只记「能证明属于本项目」的路径：目录名匹配项目名，或该仓库 origin 与本次探测到的远程一致。
    // 会话 cwd 可能是任意目录（实测收进过 ~/.dsh、WorkBuddy 会话目录），不能无脑记。
    const proven = localPath && isPathForProject(localPath, {
      slug, name: project.trim(), aliases: [], remotes,
    });
    // 显示名裁决：调用方传的多半是项目名，但 Agent 常把 slug 当项目名传进来 —— 不能无条件
    // 覆盖已登记的真名，否则同一张卡的名字会在「真名 ↔ 机器串」之间随写入方来回抖动
    const name = resolveWriteName(registry.get(slug), project.trim());
    registry.upsert({
      slug,
      name,
      remotes,
      gitUrl: gitPreferred && cwd ? (detectGitRemote(cwd) || {}).url : "",
      localPaths: proven ? [localPath] : [],
      agents: agent ? [agent] : [],
      origin: "explicit",
    });
    return { slug, name, origin: "explicit" };
  }

  const remote = gitPreferred ? detectGitRemote(cwd) : null;
  if (remote) {
    const name = resolveWriteName(registry.get(remote.slug), remote.repo);
    registry.upsert({
      slug: remote.slug,
      name,
      remotes: displayRemotesFor(cwd),
      gitUrl: remote.url,
      localPaths: cwd ? [findGitRoot(cwd) || cwd] : [],
      agents: agent ? [agent] : [],
      origin: "git",
    });
    return { slug: remote.slug, name, origin: "git" };
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
  normalizeGitRemote, sanitizeSlug, detectGitRemote, detectGitRemotes, displayRemotesFor, findGitRoot,
  isProjectDirCandidate, isPathForProject,
  nameSimilarity, reverseClaudeDirName, reverseSessionDirName, ProjectRegistry, classify, memoryRelPath,
  repoNameFromSlug, scoreDisplayName, resolveWriteName, groupEntries, pickGroupName,
};
