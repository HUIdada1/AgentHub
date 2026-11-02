"use strict";

class Gate {
  constructor(max = 16, maxQueue = 64) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.inFlight = 0;
    this.queue = [];
  }

  acquire(timeoutMs = 10000, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("CANCELLED"));
    if (this.inFlight < this.max && !this.queue.length) {
      this.inFlight++;
      return Promise.resolve(this.lease());
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error("QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: null };
      const remove = (error) => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.cleanup();
        reject(error);
      };
      const abort = () => remove(signal.reason || new Error("CANCELLED"));
      const timer = setTimeout(() => remove(new Error("QUEUE_TIMEOUT")), Math.max(1, timeoutMs));
      waiter.cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
    });
  }

  lease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) { next.cleanup(); next.resolve(this.lease()); }
      else this.inFlight--;
    };
  }
}

class BodyQueue {
  constructor() { this.entries = new Map(); this.waiting = 0; }

  async acquire(key, timeoutMs, signal) {
    if (this.waiting >= 256) throw new Error("QUEUE_FULL");
    let gate = this.entries.get(key);
    if (!gate) { gate = new Gate(1, 32); this.entries.set(key, gate); }
    this.waiting++;
    try {
      const release = await gate.acquire(timeoutMs, signal);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (!gate.inFlight && !gate.queue.length && this.entries.get(key) === gate) this.entries.delete(key);
      };
    } finally {
      this.waiting--;
      if (!gate.inFlight && !gate.queue.length && this.entries.get(key) === gate) this.entries.delete(key);
    }
  }
}

module.exports = { Gate, BodyQueue };
