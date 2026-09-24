/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 目录布局与项目归类引擎：Git 远程规范化 → slug；名称模糊匹配进待确认队列。
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
    m = { host, owner, repo, display: `${owner}/${repo}` };
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
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{3,}/g, "--")
    .slice(0, 120);
}

// cwd → 远程地址的进程内缓存：每条记忆都起一次 git 子进程代价太高（写入路径要 <50ms）
const remoteCache = new Map();

function detectGitRemote(cwd) {
  if (!cwd) return null;
  const cached = remoteCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = normalizeGitRemote(out.trim());
    remoteCache.set(cwd, parsed);
    return parsed;
  } catch {
    remoteCache.set(cwd, null);
    return null;
  }
}

const gitRootCache = new Map();

function findGitRoot(cwd) {
  if (!cwd) return null;
  const cached = gitRootCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const root = out.trim() || null;
    gitRootCache.set(cwd, root);
    return root;
  } catch {
    gitRootCache.set(cwd, null);
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

// Claude Code 的会话目录名是把原路径的 "/" 换成 "-"：取最后一段做项目名候选
// （不还原完整路径：路径里的连字符无法与分隔符区分，只取末段对"归类到哪个项目"足够）
function reverseClaudeDirName(name) {
  if (!name || typeof name !== "string") return null;
  if (!name.startsWith("-")) return null;
  const parts = name.split("-").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
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
  }

  list() {
    return this._load().projects;
  }

  get(slug) {
    return this._load().projects.find((p) => p.slug === slug) || null;
  }

  upsert(entry) {
    const data = this._load();
    const prevJson = JSON.stringify(data);
    const idx = data.projects.findIndex((p) => p.slug === entry.slug);
    const now = Date.now();
    if (idx >= 0) {
      const merged = { ...data.projects[idx], ...entry, updated: now };
      merged.remotes = Array.from(new Set([...(data.projects[idx].remotes || []), ...(entry.remotes || [])]));
      merged.localPaths = Array.from(new Set([...(data.projects[idx].localPaths || []), ...(entry.localPaths || [])]));
      merged.aliases = Array.from(new Set([...(data.projects[idx].aliases || []), ...(entry.aliases || [])]));
      merged.agents = Array.from(new Set([...(data.projects[idx].agents || []), ...(entry.agents || [])]));
      data.projects[idx] = merged;
    } else {
      data.projects.push({
        slug: entry.slug,
        name: entry.name || entry.slug,
        remotes: entry.remotes || [],
        aliases: entry.aliases || [],
        localPaths: entry.localPaths || [],
        agents: entry.agents || [],
        origin: entry.origin || "git",
        created: now,
        updated: now,
      });
    }
    this._save(prevJson);
    return this.get(entry.slug);
  }

  remove(slug) {
    const data = this._load();
    data.projects = data.projects.filter((p) => p.slug !== slug);
    this._save();
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
function classify(input, registry, cfg) {
  const { project, cwd, agent } = input || {};
  const fuzzyThreshold = cfg && cfg.fuzzyThreshold != null ? cfg.fuzzyThreshold : 0.62;
  const gitPreferred = !cfg || cfg.gitPreferred !== false;

  if (project && typeof project === "string" && project.trim()) {
    const slug = sanitizeSlug(project.trim());
    registry.upsert({ slug, name: project.trim(), agents: agent ? [agent] : [], origin: "explicit" });
    return { slug, name: project.trim(), origin: "explicit" };
  }

  const remote = gitPreferred ? detectGitRemote(cwd) : null;
  if (remote) {
    registry.upsert({
      slug: remote.slug,
      name: remote.repo,
      remotes: [remote.display],
      localPaths: cwd ? [findGitRoot(cwd) || cwd] : [],
      agents: agent ? [agent] : [],
      origin: "git",
    });
    return { slug: remote.slug, name: remote.repo, origin: "git" };
  }

  const gitRoot = gitPreferred ? findGitRoot(cwd) : null;
  if (gitRoot) {
    const base = path.basename(gitRoot);
    const slug = sanitizeSlug(base);
    registry.upsert({ slug, name: base, localPaths: [gitRoot], agents: agent ? [agent] : [], origin: "gitroot" });
    return { slug, name: base, origin: "gitroot" };
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
        registry.upsert({ slug, name: dirName, localPaths: [cwd], agents: agent ? [agent] : [], origin: "fuzzy-auto" });
        return { slug, name: dirName, origin: "fuzzy-auto", confidence: suggestion.score };
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
    return type === "decision" || type === "knowledge" || type === "insight" || type === "summary"
      ? `${base}/${id || date}.md`
      : `${base}.md`;
  }
  const base = slug ? `projects/${slug}/l1/${agent || "manual"}` : `general/l1/${agent || "manual"}`;
  if (type === "daily") return `${base}/${date}.md`;
  return `${base}/${date}-${id || "note"}.md`;
}

module.exports = {
  normalizeGitRemote, sanitizeSlug, detectGitRemote, findGitRoot,
  nameSimilarity, reverseClaudeDirName, ProjectRegistry, classify, memoryRelPath,
};
