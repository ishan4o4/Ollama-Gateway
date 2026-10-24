import { config } from '../config.js';
import { ApiError } from '../errors.js';

/** Caps simultaneous inference requests; extra requests wait in a bounded queue. */
class Semaphore {
  active = 0;
  queue = [];
  constructor(max, maxQueue, timeoutMs) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
  }

  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.#releaser());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new ApiError(429, 'server_busy', 'Too many requests in progress, try again shortly'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(new ApiError(503, 'queue_timeout', 'Timed out waiting for a free slot'));
      }, this.timeoutMs);
      this.queue.push(entry);
    });
  }

  #releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        this.active++;
        next.resolve(this.#releaser());
      }
    };
  }

  stats() {
    return { active: this.active, queued: this.queue.length, max: this.max, maxQueue: this.maxQueue };
  }
}

export const slots = new Semaphore(
  config.limits.maxConcurrent,
  config.limits.maxQueue,
  config.limits.queueTimeoutMs,
);

/** Acquire a slot and release it automatically when the response finishes or the client leaves. */
export async function acquireSlot(req, res) {
  const release = await slots.acquire();
  if (req.socket.destroyed) {
    release();
    throw new ApiError(499, 'client_closed', 'Client closed the request');
  }
  res.once('close', release);
  return release;
}
