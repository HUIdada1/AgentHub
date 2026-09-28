/**
 * 异步函数合流器：事件风暴场景（主进程高频广播、watcher 连发）下保护重量级刷新函数。
 *
 * 语义：
 *  - 同一时刻最多一个在跑：在跑期间的触发只记一笔「待跑」，本次结束后补跑一次；
 *  - 距上次开始不足 minIntervalMs 的触发推迟到间隔末尾，期间多次触发合并为一次；
 *  - 永不抛出：fn 内部的错误应自行捕获，这里兜底防未捕获拒绝打断合流循环。
 *
 * 返回的 trigger 是 fire-and-forget；组件卸载时应调 trigger.cancel() 清掉待发的一次。
 */
export function coalesceAsync(fn: () => Promise<unknown> | void, minIntervalMs = 800): (() => void) & { cancel: () => void } {
  let running = false;
  let queued = false;
  let lastStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    running = true;
    lastStart = Date.now();
    try {
      await fn();
    } catch {
      /* fn 应自行捕获；兜底防合流循环被打断 */
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  }

  function schedule() {
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastStart));
    if (wait === 0) {
      void run();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, wait);
  }

  const trigger = (() => {
    if (running) {
      queued = true;
      return;
    }
    if (timer) return; // 已排在延迟队列里，多次触发合并
    schedule();
  }) as (() => void) & { cancel: () => void };

  trigger.cancel = () => {
    queued = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return trigger;
}
