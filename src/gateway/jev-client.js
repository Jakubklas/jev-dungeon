// One logical Jev call: a single in-flight request, retried on transient statuses and network errors, under ONE
// deadline that covers the retries and the backoff between them. No hedging here (the hosted policy is one copy).
// A response that arrives after the deadline or an abort is discarded: the promise has already rejected, so it can
// never enqueue an action. The key is a plain argument per call; this file reads no environment.
import { CallAborted, CallFailed, CallTimeout, KeyRejected } from './errors.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_RETRY_STATUS = [429, 502, 503, 504, 529];

// A failure body as text (a transport double with only json() works too); '' when unreadable.
async function readText(res) {
  try {
    return typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  } catch {
    return '';
  }
}

// `onAttempt({ attempt, bytesOut })` runs before each fetch and may return `done({ status, bytesIn, outcome })`, which
// runs after it (the gateway records through these). It never sees the key. Resolves to the `answers` object.
export async function postWithRetry(body, {
  key = null, signal = null, endpoint = JEV_ENDPOINT, name = 'Jev API', timeoutMs = 7000, retries = 3,
  retryStatus = DEFAULT_RETRY_STATUS, backoffMs = 500, fetchImpl = (...a) => globalThis.fetch(...a), onAttempt = null,
} = {}) {
  const retryable = new Set(retryStatus);
  const ctl = new AbortController();
  let over = false; // set when the deadline or the caller ends the call; later results are dropped
  let activeDone = null;
  let fail;
  const ended = new Promise((_, reject) => { fail = (e) => {
    if (over) return;
    over = true;
    activeDone?.({ status: 0, bytesIn: 0, outcome: e instanceof CallTimeout ? 'timeout' : 'aborted' });
    reject(e);
    ctl.abort();
  }; });
  ended.catch(() => {}); // it is consumed through the race below
  const timer = setTimeout(() => fail(new CallTimeout(timeoutMs)), timeoutMs);
  const onExternal = () => fail(new CallAborted());
  if (signal?.aborted) onExternal(); else signal?.addEventListener('abort', onExternal, { once: true });
  // Backoff that the deadline or an abort cuts short.
  const pause = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    ctl.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  const scrub = (s) => (key ? s.split(key).join('[key]') : s);
  const bytesOut = Buffer.byteLength(body);

  async function work() {
    for (let attempt = 0; ; attempt++) {
      if (over) return undefined;
      const rawDone = onAttempt?.({ attempt, bytesOut });
      let completed = false;
      const done = (result) => { if (completed) return; completed = true; rawDone?.(result); };
      activeDone = done;
      let res;
      try {
        res = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: ctl.signal });
      } catch (err) {
        done?.({ status: 0, bytesIn: 0, outcome: over ? 'aborted' : 'network_error' });
        if (over) return undefined;
        if (attempt < retries) { await pause(backoffMs * 2 ** attempt); continue; }
        throw new CallFailed(0, scrub(String(err.cause?.code || err.message || err)), name);
      }
      // A 200 is read as JSON (a non-JSON 200 is a CallFailed below); any other status as text for the error.
      let data;
      let text = '';
      if (res.ok) {
        try { data = await res.json(); } catch { /* not JSON */ }
        text = data === undefined ? '' : JSON.stringify(data);
      } else {
        text = await readText(res);
      }
      const bytesIn = Buffer.byteLength(text);
      if (over) { done?.({ status: res.status, bytesIn, outcome: 'aborted' }); return undefined; }
      if (res.status === 401 || res.status === 403) {
        done?.({ status: res.status, bytesIn, outcome: 'key_rejected' });
        throw new KeyRejected(res.status);
      }
      if (res.ok) {
        const answers = data?.answers;
        if (answers && typeof answers === 'object') {
          done?.({ status: res.status, bytesIn, outcome: 'ok' });
          return answers;
        }
        done?.({ status: res.status, bytesIn, outcome: 'bad_body' });
        throw new CallFailed(res.status, 'no answers in the response', name);
      }
      const again = retryable.has(res.status) && attempt < retries;
      done?.({ status: res.status, bytesIn, outcome: again ? 'retry' : 'failed' });
      if (!again) throw new CallFailed(res.status, scrub(text.slice(0, 300)), name);
      await pause(backoffMs * 2 ** attempt);
    }
  }

  const running = work();
  running.catch(() => {}); // a rejection after the race was lost must not be unhandled
  try {
    return await Promise.race([ended, running]); // ended first: an already-ended call must reject, not resolve undefined
  } finally {
    over = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternal);
    ctl.abort(); // frees a fetch still waiting
  }
}
