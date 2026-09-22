/**
 * Sliding-window rate limiter keyed by an arbitrary string (usually a user id).
 * Memory safe: stale keys are pruned periodically.
 */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
    this.pruneTimer = setInterval(() => this.prune(), Math.max(windowMs, 30_000));
    this.pruneTimer.unref?.();
  }

  /** Returns 0 if allowed (and records the hit), otherwise ms until the next slot frees up. */
  consume(key, now = Date.now()) {
    const windowStart = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return list[0] + this.windowMs - now;
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  prune(now = Date.now()) {
    const windowStart = now - this.windowMs;
    for (const [key, list] of this.hits) {
      if (!list.some((t) => t > windowStart)) this.hits.delete(key);
    }
  }

  destroy() {
    clearInterval(this.pruneTimer);
    this.hits.clear();
  }
}

/** Simple per-key cooldown (used for buttons). */
export class Cooldown {
  constructor(ms) {
    this.ms = ms;
    this.last = new Map();
  }

  check(key, now = Date.now()) {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.ms) return this.ms - (now - prev);
    this.last.set(key, now);
    if (this.last.size > 5000) {
      for (const [k, t] of this.last) if (now - t > this.ms) this.last.delete(k);
    }
    return 0;
  }
}
