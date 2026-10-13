// Development providers: hosted Jev, local Laya or OpenAI Decisions, behind `askJev` (reached through
// `gateway.devAsker()`; nothing in src/characters imports it). One logical call is `postWithRetry` (src/gateway/jev-client.js):
// one copy, retries with backoff, one deadline for all of it. With `jev.hedgeCopies` > 1 (dev only) a further copy goes
// out only if no answer has come after HEDGE_DELAY_MS; the first answer wins and the rest are aborted.
import { askOpenAIDecider } from './openai-decider.js';
import { JEV_ENDPOINT, postWithRetry } from './gateway/jev-client.js';
let HEDGE = 1; // copies of a request that may be in flight (jev.hedgeCopies); the hosted gateway never hedges
let HEDGE_DELAY_MS = 800; // measured: a call takes ~250 ms, the slow tail is 1-4 s; a second copy only pays for the tail
let RETRY_STATUS = new Set([429, 502, 503, 504, 529]); // rate limit, and an upstream that is briefly down (503 'no healthy upstream')
let RETRIES = 3;
let TIMEOUT_MS = 7000; // per call, retries and backoff included (jev.timeoutMs)
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

// The development asker behind `gateway.devAsker()`: the provider switch (Jev, Laya, OpenAI) for the dev server and
// the live scripts. The hosted game never comes through here (its askers are `explorerAsker` / `monsterDecider`).
// `body` may be passed pre-serialized (the brain does, so it can keep the exact string it sent). `opts.onAttempt` and
// `opts.signal` are the gateway's recording and abort hooks.
export async function askJev(state, questions, body = JSON.stringify({ model: jevModel(), state, questions }), opts = {}) {
  validateDecisionCredentials();
  if (PROVIDER === 'openai') {
    const request = JSON.parse(body);
    return askOpenAIDecider(request.state, request.questions, { model: OPENAI_MODEL, timeoutMs: OPENAI_TIMEOUT_MS });
  }
  const local = PROVIDER === 'laya';
  // Local inference controls are added at the transport boundary; hosted bytes stay unchanged.
  if (local) body = JSON.stringify({ ...JSON.parse(body), max_len: LAYA_MAX_LEN, head_max_len: LAYA_HEAD_MAX_LEN });
  const send = (signal) => postWithRetry(body, {
    key: local ? null : process.env.JEV_API_KEY,
    signal,
    endpoint: local ? validateLayaEndpoint(LAYA_ENDPOINT) : JEV_ENDPOINT,
    name: local ? 'local Laya API' : 'TypeSafe API',
    timeoutMs: local ? LAYA_TIMEOUT_MS : TIMEOUT_MS,
    retries: local ? 0 : RETRIES,
    retryStatus: [...RETRY_STATUS],
    onAttempt: opts.onAttempt,
  });
  const copies = local ? 1 : HEDGE;
  if (copies <= 1) return send(opts.signal ?? null);
  // Hedging (dev server only, `jev.hedgeCopies` > 1): copy i starts after i * HEDGE_DELAY_MS unless some copy has
  // answered by then; the first answer wins and the others are aborted.
  const controllers = Array.from({ length: copies }, () => new AbortController());
  let winner;
  try {
    winner = await Promise.any(controllers.map(async (c, copy) => {
      if (copy > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, copy * HEDGE_DELAY_MS);
          c.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (c.signal.aborted) throw new Error('aborted: another copy answered first');
      }
      const signal = opts.signal ? AbortSignal.any([c.signal, opts.signal]) : c.signal;
      return { answers: await send(signal), copy };
    }));
  } catch (err) {
    throw err.errors?.[0] ?? err; // every copy failed; report the first reason
  }
  controllers.forEach((c, i) => i !== winner.copy && c.abort());
  return winner.answers;
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
