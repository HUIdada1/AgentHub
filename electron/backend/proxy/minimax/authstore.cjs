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
// 号池 · MiniMax Code 本机登录态读写（与桌面端共存的唯一一处写文件逻辑）
//
// 为什么需要这一层：MiniMax Code 把 OAuth 登录态落在
//   ~/.minimax/auth/prod/<region>/mcode-public/auth.json
// 且**桌面端与号池读的是同一份**。refresh_token 是轮换语义，谁先刷谁作废旧值——
// 号池若无脑刷新并只写自己的库，桌面端下一次刷新就会 invalid_grant（用户被踢下线）。
//
// 因此本文件只做三件事，且顺序不可颠倒（方案 §6 不确定项 #3 的推荐做法）：
//   ① 读文件优先：文件里的 accessToken 比库里的更新且仍在有效期 → **直接采纳**，不打上游；
//   ② 真需要刷新时才刷新；
//   ③ 刷新成功后**原子写回**（临时文件 + rename），保留其余 records 与所有未知字段。
//
// 两条铁律：
//   · 绝不创建 / 等待 / 删除 `auth.lock`——那是桌面端自己的刷新锁，第二方碰它就可能打断官方刷新；
//   · 写回前必须确认文件里的 refreshToken 仍是我们刷新前用的那一枚；不等说明桌面端已自行刷新，
//     此时覆盖会把对方刚写下的新凭据顶掉，宁可放弃写回（号池库里的凭据仍可用）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CLIENT_ID = "mcode-public";

/** `~` 展开（本文件的路径来自号池自己的 meta，不接受任意用户输入拼接） */
function expandHome(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 账号元数据的合并视图：secrets.meta 逐键覆盖 account.meta。
 *  不能写成 `secrets.meta || account.meta`——空对象也是真值，会把 account.meta 整个遮蔽掉，
 *  于是 authFile 丢失、回落到默认路径（同机多区域时就是"写错了另一份登录态"）。 */
function metaOf(account, secrets) {
  return { ...((account && account.meta) || {}), ...((secrets && secrets.meta) || {}) };
}

/** 账号 → auth.json 绝对路径。
 *  meta.authFile 由本机扫描写入（唯一可靠来源，国际版目录名未取证也不受影响）；
 *  缺省按 region 拼标准路径，供「粘贴导入 + 手工指定区域」的账号使用。 */
function authFileOf(account, secrets) {
  const meta = metaOf(account, secrets);
  const explicit = expandHome(meta.authFile);
  if (explicit) return explicit;
  const region = String(meta.region || "").toLowerCase() === "en" ? "en" : "cn";
  const clientId = String(meta.clientId || DEFAULT_CLIENT_ID);
  return path.join(os.homedir(), ".minimax", "auth", "prod", region, clientId, "auth.json");
}

/**
 * 在文件里定位「这个账号」对应的 record。
 * 匹配优先级：loginEpoch（同一次登录的唯一标识）→ refreshToken（同一份凭据）→ 唯一一条 clientId 记录。
 * 返回 null 表示文件不存在 / 结构不认识 / 定位不到——调用方一律按"不可写回"处理，绝不新建文件。
 */
function locate(account, secrets) {
  const file = authFileOf(account, secrets);
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const records = raw && raw.records;
  if (!records || typeof records !== "object" || Array.isArray(records)) return null;
  const entries = Object.entries(records).filter(([, v]) => v && typeof v === "object");
  if (!entries.length) return null;
  const meta = metaOf(account, secrets);
  const epoch = String(meta.loginEpoch || "");
  const refresh = String((secrets && secrets.refreshToken) || "");

  let hit = epoch ? entries.find(([, v]) => String(v.loginEpoch || "") === epoch) : null;
  if (!hit && refresh) hit = entries.find(([, v]) => String(v.refreshToken || "") === refresh);
  if (!hit) {
    const clientId = String(meta.clientId || DEFAULT_CLIENT_ID);
    const sameClient = entries.filter(([, v]) => String(v.clientId || "") === clientId);
    if (sameClient.length === 1) hit = sameClient[0];
  }
  if (!hit) return null;
  return { file, raw, key: hit[0], record: hit[1] };
}

/**
 * 读文件优先：桌面端可能已经自己刷过（文件比号池库更新），此时直接采纳，**不消耗一次 refresh 轮换**。
 * 只在「文件里的凭据更新、且距离过期还有 1 分钟以上」时采纳；否则返回 null 走正常刷新。
 */
function adoptNewer(account, secrets) {
  const loc = locate(account, secrets);
  if (!loc) return null;
  const rec = loc.record;
  const token = String(rec.accessToken || "").trim();
  if (!token.startsWith("mmoat_")) return null;
  const fileExp = Number(rec.expiresAtMs) || 0;
  const mineExp = Number(metaOf(account, secrets).expiresAtMs) || 0;
  if (fileExp <= mineExp) return null;
  if (fileExp <= Date.now() + 60_000) return null;
  return {
    token,
    refreshToken: String(rec.refreshToken || (secrets && secrets.refreshToken) || ""),
    expiresAtMs: fileExp,
    generation: Number(rec.generation) || 0,
    loginEpoch: String(rec.loginEpoch || ""),
    file: loc.file,
  };
}

/**
 * 原子写回：临时文件 + rename（同目录，保证同一文件系统、rename 才是原子操作）。
 * 只改 accessToken / refreshToken / expiresAtMs / generation，其余字段与其余 records 原样保留。
 * 不触碰 auth-state.json（客户端以 records 为准；少动一个文件就少一分破坏登录态的概率）。
 */
function writeBack(account, secrets, next) {
  const token = String((next && next.token) || "").trim();
  if (!token.startsWith("mmoat_")) return { ok: false, reason: "invalid-token" };
  const loc = locate(account, secrets);
  if (!loc) return { ok: false, reason: "no-record" };

  // 守卫：文件里的 refreshToken 必须仍是我们刷新前用的那一枚。
  // 不等 = 桌面端已经自行刷新过（它先轮换了），覆盖会把对方刚写下的凭据顶掉。
  const mine = String((secrets && secrets.refreshToken) || "");
  const current = String(loc.record.refreshToken || "");
  if (mine && current && current !== mine) return { ok: false, reason: "rotated-elsewhere" };

  const rec = loc.record;
  const prevGeneration = Number(rec.generation) || 0;
  rec.accessToken = token;
  rec.refreshToken = String((next && next.refreshToken) || current || mine);
  if (next && Number(next.expiresAtMs) > 0) rec.expiresAtMs = Number(next.expiresAtMs);
  rec.generation = prevGeneration + 1;

  const tmp = `${loc.file}.ah-${process.pid}-${Date.now()}.tmp`;
  try {
    // 缩进用 tab：与客户端自己写出的形态一致（JSON.parse 不关心，但 diff/人工排查时少一层噪音）
    fs.writeFileSync(tmp, JSON.stringify(loc.raw, null, "\t"), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, loc.file);
    return { ok: true, file: loc.file, generation: rec.generation };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    // 客户端正在写 / 权限不足都会走到这里：号池库里的凭据已经落库，写回失败只影响桌面端同步，
    // 不能反过来把刷新判成失败
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { authFileOf, locate, adoptNewer, writeBack, DEFAULT_CLIENT_ID };
