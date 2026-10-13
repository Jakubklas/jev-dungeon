// Time sources for the hosted runtime (PLAN-multiplayer-impl WP-E). A clock gives monotonic milliseconds and one-shot
// timers; the GameActor owns everything else (pause offsets, the game's world clock). `MonotonicClock` is the real
// one; `FakeClock` is for the checks: time moves only when the check calls advance(), which runs the due timers in
// order, so a whole schedule is replayed without waiting or flaking.

export class MonotonicClock {
  now() { return performance.now(); }
  setTimeout(fn, ms) { return globalThis.setTimeout(fn, Math.max(0, ms)); }
  clearTimeout(handle) { globalThis.clearTimeout(handle); }
}

export class FakeClock {
  #now;
  #timers = [];
  #seq = 0;

  constructor(start = 0) { this.#now = start; }

  now() { return this.#now; }
  get pending() { return this.#timers.length; }

  setTimeout(fn, ms) {
    const handle = { at: this.#now + Math.max(0, ms), fn, seq: ++this.#seq };
    this.#timers.push(handle);
    return handle;
  }

  clearTimeout(handle) {
    const i = this.#timers.indexOf(handle);
    if (i >= 0) this.#timers.splice(i, 1);
  }

  // Moves time forward by `ms`, running every timer that comes due, earliest first (ties in creation order). A timer
  // may schedule another one inside the window; that one runs too. Synchronous: promises only settle between calls.
  advance(ms) {
    const target = this.#now + ms;
    for (;;) {
      let next = null;
      for (const t of this.#timers) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      if (!next) break;
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = Math.max(this.#now, next.at);
      next.fn();
    }
    this.#now = target;
    return this.#now;
  }

  // advance(ms) in slices of `step`, letting pending promises settle after each slice (stub askers resolve in
  // microtasks or immediates). The usual way a check plays a stretch of game time.
  async tick(ms, step = 10) {
    for (let done = 0; done < ms; done += step) {
      this.advance(Math.min(step, ms - done));
      await settle();
    }
  }
}

// Lets every already-resolved promise (and a few chained ones) run before the caller looks at the world.
export async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
