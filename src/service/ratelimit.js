// Token-bucket rate limiter per (route class, client address). `take(cls, addr)` -> { ok, retryMs }. The clock is injected
// (`now()` in ms) so checks do not sleep. Classes are the hosted routes that cost something: create, join, directives.
export const DEFAULT_LIMITS = {
  create: { capacity: 5, perSecond: 5 / 60 }, // 5 rooms, then one per 12 s
  join: { capacity: 10, perSecond: 10 / 60 },
  directives: { capacity: 6, perSecond: 6 / 30 },
};

export class RateLimiter {
  #limits;
  #now;
  #buckets = new Map();
  #lastSweep = 0;

  constructor({ limits = DEFAULT_LIMITS, now = () => Date.now() } = {}) {
    this.#limits = limits;
    this.#now = now;
  }

  take(cls, addr, cost = 1) {
    const lim = this.#limits[cls];
    if (!lim) throw new Error(`RateLimiter: unknown class ${cls}`);
    const t = this.#now();
    this.#sweep(t);
    const k = `${cls}\u0000${addr}`;
    const b = this.#buckets.get(k) ?? { tokens: lim.capacity, at: t };
    b.tokens = Math.min(lim.capacity, b.tokens + Math.max(0, t - b.at) / 1000 * lim.perSecond);
    b.at = t;
    let ok = false;
    let retryMs = 0;
    if (b.tokens >= cost) { b.tokens -= cost; ok = true; } else retryMs = Math.ceil((cost - b.tokens) / lim.perSecond * 1000);
    this.#buckets.set(k, b);
    return { ok, retryMs };
  }

  // Forgets buckets that would be full again, at most once a minute, so the map cannot grow without bound.
  #sweep(t) {
    if (t - this.#lastSweep < 60000) return;
    this.#lastSweep = t;
    for (const [k, b] of this.#buckets) {
      const lim = this.#limits[k.split('\u0000')[0]];
      if (b.tokens + (t - b.at) / 1000 * lim.perSecond >= lim.capacity) this.#buckets.delete(k);
    }
  }

  get size() { return this.#buckets.size; }
}
