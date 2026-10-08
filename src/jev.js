// Talks to Jev. Every request is hedged: copy 0 goes at once, each further copy (HEDGE in all) only if no answer has
// come after HEDGE_DELAY_MS, so a normal call costs one request and only a slow one gets a second; the first answer wins, the rest are aborted and each copy retries rate limits and network errors with backoff.
const API = 'https://api.typesafe.ai/v1/systemone';
let HEDGE = 2; // copies of a request that may be in flight (jev.hedgeCopies)
let HEDGE_DELAY_MS = 800; // measured: a call takes ~250 ms, the slow tail is 1-4 s; a second copy only pays for the tail
let RETRY_STATUS = new Set([429, 502, 503, 504, 529]); // rate limit, and an upstream that is briefly down (503 'no healthy upstream')
let RETRIES = 3;
let TIMEOUT_MS = 20_000;
let MODEL = 'jev-latest';

// Sends one copy, retrying 429/529 and network errors until it succeeds, gives up,
// or another copy wins (abort).
async function sendCopy(body, abort, copy) {
  for (let attempt = 0; ; attempt++) {
    if (abort.aborted) throw new Error('aborted: another copy answered first');
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.JEV_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.any([abort, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (err) {
      if (abort.aborted) throw new Error('aborted: another copy answered first');
      // Dropped connection or timeout: retry with backoff, like a rate limit.
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Couldn't reach the TypeSafe API: ${err.cause?.code || err.message}`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { data: await res.json(), copy };
  }
}

// `body` may be passed pre-serialized (the brain does, so it can keep the exact string it sent).
export async function askJev(state, questions, body = JSON.stringify({ model: MODEL, state, questions })) {
  const controllers = Array.from({ length: HEDGE }, () => new AbortController());
  let winner;
  try {
    // Copy i starts after i * HEDGE_DELAY_MS unless some copy has answered by then (an abort cancels the wait).
    winner = await Promise.any(controllers.map(async (c, copy) => {
      if (copy > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, copy * HEDGE_DELAY_MS);
          c.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
      return sendCopy(body, c.signal, copy);
    }));
  } catch (err) {
    throw err.errors?.[0] ?? err; // every copy failed; report the first reason
  }
  controllers.forEach((c, i) => i !== winner.copy && c.abort());
  return winner.data.answers;
}

export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The model name the brains put in their request bodies.
export const jevModel = () => MODEL;
// Central config hook (src/config/runtime.js). The endpoint and the API key are never configurable: the key stays in ../.env.
export function configureJev(o) {
  if (o.jevHedgeCopies !== undefined) HEDGE = o.jevHedgeCopies;
  if (o.jevHedgeDelayMs !== undefined) HEDGE_DELAY_MS = o.jevHedgeDelayMs;
  if (o.jevRetries !== undefined) RETRIES = o.jevRetries;
  if (o.jevTimeoutMs !== undefined) TIMEOUT_MS = o.jevTimeoutMs;
  if (o.jevRetryStatus !== undefined) RETRY_STATUS = new Set(o.jevRetryStatus);
  if (o.jevModel !== undefined) MODEL = o.jevModel;
}
export const jevSnapshot = () => ({ jevHedgeCopies: HEDGE, jevHedgeDelayMs: HEDGE_DELAY_MS, jevRetries: RETRIES, jevTimeoutMs: TIMEOUT_MS, jevRetryStatus: [...RETRY_STATUS], jevModel: MODEL });
