// Talks to hosted Jev, local Laya or OpenAI Decisions. Jev requests are hedged: copy 0 goes at once, each further copy (HEDGE in all) only if no answer has
// come after HEDGE_DELAY_MS, so a normal call costs one request and only a slow one gets a second; the first answer wins, the rest are aborted and each copy retries rate limits and network errors with backoff.
import { askOpenAIDecider } from './openai-decider.js';
const API = 'https://api.typesafe.ai/v1/systemone';
let HEDGE = 2; // copies of a request that may be in flight (jev.hedgeCopies)
let HEDGE_DELAY_MS = 800; // measured: a call takes ~250 ms, the slow tail is 1-4 s; a second copy only pays for the tail
let RETRY_STATUS = new Set([429, 502, 503, 504, 529]); // rate limit, and an upstream that is briefly down (503 'no healthy upstream')
let RETRIES = 3;
let TIMEOUT_MS = 20_000;
let MODEL = 'jev-latest';
let PROVIDER = 'jev';
let OPENAI_MODEL = 'gpt-6-luna';
let OPENAI_TIMEOUT_MS = 30_000;
let LAYA_ENDPOINT = 'http://127.0.0.1:8000/v1/systemone';
let LAYA_MODEL = 'multilingual';
let LAYA_MAX_LEN = 8192;
let LAYA_HEAD_MAX_LEN = 1024;
let LAYA_TIMEOUT_MS = 120_000;

export function validateLayaEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Laya endpoint must be an HTTP URL on localhost without credentials, query or fragment');
  }
  return endpoint;
}

export function validateDecisionCredentials() {
  if (PROVIDER === 'jev' && !process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is required for decision.provider=jev');
  if (PROVIDER === 'openai' && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for decision.provider=openai');
}

// Sends one copy, retrying 429/529 and network errors until it succeeds, gives up,
// or another copy wins (abort).
async function sendCopy(body, abort, copy, transport) {
  for (let attempt = 0; ; attempt++) {
    if (abort.aborted) throw new Error('aborted: another copy answered first');
    let res;
    try {
      res = await fetch(transport.endpoint, {
        method: 'POST',
        headers: transport.headers,
        body,
        signal: AbortSignal.any([abort, AbortSignal.timeout(transport.timeout)]),
      });
    } catch (err) {
      if (abort.aborted) throw new Error('aborted: another copy answered first');
      // Dropped connection or timeout: retry with backoff, like a rate limit.
      if (attempt < transport.retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Couldn't reach ${transport.name}: ${err.cause?.code || err.message}`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < transport.retries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${transport.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { data: await res.json(), copy };
  }
}

// `body` may be passed pre-serialized (the brain does, so it can keep the exact string it sent).
export async function askJev(state, questions, body = JSON.stringify({ model: jevModel(), state, questions })) {
  validateDecisionCredentials();
  if (PROVIDER === 'openai') {
    const request = JSON.parse(body);
    return askOpenAIDecider(request.state, request.questions, { model: OPENAI_MODEL, timeoutMs: OPENAI_TIMEOUT_MS });
  }
  const local = PROVIDER === 'laya';
  // Local inference controls are added at the transport boundary; hosted bytes stay unchanged.
  if (local) body = JSON.stringify({ ...JSON.parse(body), max_len: LAYA_MAX_LEN, head_max_len: LAYA_HEAD_MAX_LEN });
  const transport = {
    endpoint: local ? validateLayaEndpoint(LAYA_ENDPOINT) : API,
    headers: local ? { 'Content-Type': 'application/json' } : { Authorization: `Bearer ${process.env.JEV_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: local ? LAYA_TIMEOUT_MS : TIMEOUT_MS,
    retries: local ? 0 : RETRIES,
    name: local ? 'local Laya API' : 'TypeSafe API',
  };
  const controllers = Array.from({ length: local ? 1 : HEDGE }, () => new AbortController());
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
      return sendCopy(body, c.signal, copy, transport);
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
export const jevModel = () => PROVIDER === 'openai' ? OPENAI_MODEL : PROVIDER === 'laya' ? LAYA_MODEL : MODEL;
// Central config hook. Hosted credentials never go to the local endpoint.
export function configureJev(o) {
  if (o.decisionProvider !== undefined) {
    if (!['jev', 'laya', 'openai'].includes(o.decisionProvider)) throw new Error('Unknown decision provider');
    PROVIDER = o.decisionProvider;
  }
  if (o.openaiDecisionModel !== undefined) OPENAI_MODEL = o.openaiDecisionModel;
  if (o.openaiDecisionTimeoutMs !== undefined) OPENAI_TIMEOUT_MS = o.openaiDecisionTimeoutMs;
  if (o.layaEndpoint !== undefined) LAYA_ENDPOINT = validateLayaEndpoint(o.layaEndpoint);
  if (o.layaHeadMaxLen !== undefined) LAYA_HEAD_MAX_LEN = o.layaHeadMaxLen;
  if (o.layaMaxLen !== undefined) LAYA_MAX_LEN = o.layaMaxLen;
  if (o.layaModel !== undefined) LAYA_MODEL = o.layaModel;
  if (o.layaTimeoutMs !== undefined) LAYA_TIMEOUT_MS = o.layaTimeoutMs;
  if (o.jevHedgeCopies !== undefined) HEDGE = o.jevHedgeCopies;
  if (o.jevHedgeDelayMs !== undefined) HEDGE_DELAY_MS = o.jevHedgeDelayMs;
  if (o.jevRetries !== undefined) RETRIES = o.jevRetries;
  if (o.jevTimeoutMs !== undefined) TIMEOUT_MS = o.jevTimeoutMs;
  if (o.jevRetryStatus !== undefined) RETRY_STATUS = new Set(o.jevRetryStatus);
  if (o.jevModel !== undefined) MODEL = o.jevModel;
}
export const jevSnapshot = () => ({ decisionProvider: PROVIDER, openaiDecisionModel: OPENAI_MODEL, openaiDecisionTimeoutMs: OPENAI_TIMEOUT_MS, layaEndpoint: LAYA_ENDPOINT, layaModel: LAYA_MODEL, layaMaxLen: LAYA_MAX_LEN, layaHeadMaxLen: LAYA_HEAD_MAX_LEN, layaTimeoutMs: LAYA_TIMEOUT_MS, jevHedgeCopies: HEDGE, jevHedgeDelayMs: HEDGE_DELAY_MS, jevRetries: RETRIES, jevTimeoutMs: TIMEOUT_MS, jevRetryStatus: [...RETRY_STATUS], jevModel: MODEL });
