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
// Web 托管形态的传输层：浏览器里同源调 POST /api/rpc。
// 与桌面 IPC 同契约（{cmd,args} → {ok,...} 数据 / {ok:false,message} 错误），
// 超时看门狗由 ipc.ts 的 call() 统一维护，这里只负责传输与登录态。
const TOKEN_KEY = "agenthub.adminToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // 隐私模式下 localStorage 不可用：本次会话内可用，刷新后需重登
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 同上 */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

let authLostReloading = false;
/** 令牌失效：清掉并回登录页。并发请求会同时撞 401，用一次性闸防重复 reload */
function handleAuthLost(): never {
  clearToken();
  if (!authLostReloading) {
    authLostReloading = true;
    window.location.reload();
  }
  throw new Error("登录已失效，请重新输入管理令牌");
}

export async function webInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ cmd, args: args || {} }),
    });
  } catch (e) {
    throw new Error(`无法连接网关：${(e as Error).message || e}`);
  }
  if (res.status === 401) handleAuthLost();
  const data = (await res.json().catch(() => null)) as { message?: string; code?: string; tried?: string[] } | null;
  if (!res.ok) {
    // HTTP 层失败也要把 code 带出去：与桌面端 unwrapResult 同契约，
    // 否则 Web 托管形态下「未配置模型」的引导弹窗永远识别不出来
    const err = new Error((data && data.message) || `命令 ${cmd} 执行失败（HTTP ${res.status}）`) as Error & { code?: string; tried?: string[] };
    if (data && typeof data.code === "string" && data.code) err.code = data.code;
    if (data && Array.isArray(data.tried) && data.tried.length) err.tried = data.tried;
    throw err;
  }
  return data;
}
