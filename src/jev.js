// Talks to Jev. Every request is hedged (HEDGE identical copies, first answer wins,
// the rest are aborted) and each copy retries rate limits and network errors with backoff.
const API = 'https://api.typesafe.ai/v1/systemone';
const HEDGE = 2;
const RETRIES = 3;
const TIMEOUT_MS = 20_000;

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
    if ((res.status === 429 || res.status === 529) && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { data: await res.json(), copy };
  }
}

// `body` may be passed pre-serialized (the brain does, so it can keep the exact string it sent).
export async function askJev(state, questions, body = JSON.stringify({ model: 'jev-latest', state, questions })) {
  const controllers = Array.from({ length: HEDGE }, () => new AbortController());
  let winner;
  try {
    winner = await Promise.any(controllers.map((c, copy) => sendCopy(body, c.signal, copy)));
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
