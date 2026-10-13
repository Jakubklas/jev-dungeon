// The only place that creates paid askers. An explorer asker carries its own participant's key and nothing else (no
// fallback to the server key or another player's key); a monster decider carries the server key. Every HTTP attempt is
// recorded before it goes out and completed after (see recorder.js): who, which kind, status, sizes, time; never a key
// or a body. The dev askers wrap `askJev` (src/jev.js, with the Laya and OpenAI dev providers) for server.js and the
// live scripts; the hosted runtime uses `explorerAsker` / `monsterDecider` only.
import { askJev } from '../jev.js';
import { NoKey } from './errors.js';
import { DEFAULT_RETRY_STATUS, JEV_ENDPOINT, postWithRetry } from './jev-client.js';
import { NullRecorder } from './recorder.js';

export class Gateway {
  #fetchImpl;
  #serverKey;
  #opts;
  #recorder;
  #now;

  // `serverKey` is a string or a function returning one (read per call, never cached). `fetchImpl` defaults to the
  // global fetch looked up at call time, so a tripwire installed later still catches a stray call.
  constructor({ fetchImpl = null, serverKey = null, model = 'jev-latest', endpoint = JEV_ENDPOINT, timeoutMs = 7000, retries = 3,
    retryStatus = DEFAULT_RETRY_STATUS, backoffMs = 500, recorder = new NullRecorder(), now = () => Date.now() } = {}) {
    this.#fetchImpl = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.#serverKey = serverKey;
    this.#opts = { model, endpoint, timeoutMs, retries, retryStatus, backoffMs };
    this.#recorder = recorder;
    this.#now = now;
  }

  // An `onAttempt` hook for postWithRetry that records the attempt (before the fetch) and completes it (after).
  #attempt(game, actor, kind) {
    return ({ attempt, bytesOut }) => {
      const started = this.#now();
      const handle = this.#recorder.record({ at: started, game, actor, kind, attempt, bytes_out: bytesOut, outcome: 'pending' });
      return ({ status, bytesIn, outcome }) => this.#recorder.update(handle, { status, bytes_in: bytesIn, ms: this.#now() - started, outcome });
    };
  }

  async #call(key, { game, actor, kind, signal, body }) {
    return postWithRetry(body, {
      key, signal, ...this.#opts, fetchImpl: this.#fetchImpl, onAttempt: this.#attempt(game, actor, kind),
    });
  }

  #body({ state, questions, body }) {
    return body ?? JSON.stringify({ model: this.#opts.model, state, questions });
  }

  // `ask({ kind, state, questions, body })` for one participant's explorer. `getKey()` is read for every call.
  explorerAsker({ gameId, actorId, getKey, signal = null }) {
    return async (req) => {
      const key = getKey();
      if (!key) throw new NoKey(actorId);
      return this.#call(key, { game: gameId, actor: actorId, kind: req.kind, signal, body: this.#body(req) });
    };
  }

  // `decide({ id, state, questions, body })` for the game's monsters, always on the server's key.
  monsterDecider({ gameId, signal = null }) {
    return async (req) => {
      const key = typeof this.#serverKey === 'function' ? this.#serverKey() : this.#serverKey;
      if (!key) throw new NoKey('the server');
      return this.#call(key, { game: gameId, actor: req.id, kind: 'monster', signal, body: this.#body(req) });
    };
  }

  // Development askers: the provider switch of src/jev.js (key from JEV_API_KEY, or Laya / OpenAI). Recorded too.
  devAsker() {
    return ({ kind, state, questions, body }) => askJev(state, questions, body, { onAttempt: this.#attempt('dev', 'explorer', kind) });
  }

  devDecider() {
    return ({ id, state, questions, body }) => askJev(state, questions, body, { onAttempt: this.#attempt('dev', id, 'monster') });
  }
}
