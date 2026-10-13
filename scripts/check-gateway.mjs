// Checks for the paid-call gateway (src/gateway/*) with fake transports only: retries and backoff, one deadline per call
// (retries included), abort, late responses dropped, 401/403 -> KeyRejected with one post, the recorder's exact entries
// (no key, no body), and which key each asker uses. Never touches the network: the fetch tripwire is installed and every
// call goes through a `fetchImpl` the check passes in. Free.
import assert from 'node:assert/strict';
import { installTripwire } from './lib/tripwire.mjs';

process.env.JEV_CONFIG = 'none';
const uninstall = installTripwire();
const { postWithRetry } = await import('../src/gateway/jev-client.js');
const { Gateway } = await import('../src/gateway/gateway.js');
const { MemoryRecorder } = await import('../src/gateway/recorder.js');
const { CallAborted, CallFailed, CallTimeout, KeyRejected, NoKey } = await import('../src/gateway/errors.js');

let fails = 0;
const test = async (name, fn) => {
  try { await fn(); } catch (err) { fails++; console.log(`FAIL: ${name}: ${err.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (status, answers = { x: 1 }, text = 'upstream says no') => ({
  status, ok: status >= 200 && status < 300, json: async () => ({ answers }), text: async () => text,
});
// A transport double: `script` is a list of replies (functions or objects), the last one repeats.
function transport(script) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body, signal: init.signal });
    const step = script[Math.min(posts.length - 1, script.length - 1)];
    return typeof step === 'function' ? step(init) : step;
  };
  return { fetchImpl, posts };
}
const fast = { backoffMs: 2 };
const rejects = async (promise, Type) => {
  try { await promise; } catch (err) { assert.ok(err instanceof Type, `expected ${Type.name}, got ${err.name}: ${err.message}`); return err; }
  throw new Error(`expected ${Type.name}, but it resolved`);
};

// Late rejections must never surface as unhandled.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

await test('transient statuses are retried, then the answer comes back (one post per attempt)', async () => {
  const t = transport([reply(503), reply(429), reply(200, { y: 2 })]);
  const answers = await postWithRetry('{}', { key: 'k', fetchImpl: t.fetchImpl, ...fast });
  assert.deepEqual(answers, { y: 2 });
  assert.equal(t.posts.length, 3);
  assert.equal(t.posts[0].headers.Authorization, 'Bearer k');
});

await test('network errors are retried like transient statuses', async () => {
  const t = transport([() => { throw new Error('socket hang up'); }, reply(200, { z: 1 })]);
  assert.deepEqual(await postWithRetry('{}', { key: 'k', fetchImpl: t.fetchImpl, ...fast }), { z: 1 });
  assert.equal(t.posts.length, 2);
});

await test('retries used up -> CallFailed with the last status; exactly retries + 1 posts', async () => {
  const t = transport([reply(503, null, 'no healthy upstream')]);
  const err = await rejects(postWithRetry('{}', { key: 'k', retries: 2, fetchImpl: t.fetchImpl, ...fast }), CallFailed);
  assert.equal(err.status, 503);
  assert.match(err.message, /503: no healthy upstream/);
  assert.equal(t.posts.length, 3);
});

await test('a status that is not retryable fails at once (one post)', async () => {
  const t = transport([reply(400, null, 'bad request')]);
  const err = await rejects(postWithRetry('{}', { key: 'k', fetchImpl: t.fetchImpl, ...fast }), CallFailed);
  assert.equal(err.status, 400);
  assert.equal(t.posts.length, 1);
});

await test('a 200 that is not JSON, or has no answers, is a CallFailed', async () => {
  let t = transport([{ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' }]);
  await rejects(postWithRetry('{}', { key: 'k', fetchImpl: t.fetchImpl, ...fast }), CallFailed);
  t = transport([{ status: 200, ok: true, json: async () => ({ nothing: true }), text: async () => '{}' }]);
  await rejects(postWithRetry('{}', { key: 'k', fetchImpl: t.fetchImpl, ...fast }), CallFailed);
  assert.equal(t.posts.length, 1);
});

for (const status of [401, 403]) {
  await test(`${status} -> KeyRejected after exactly one post, no retry`, async () => {
    const t = transport([reply(status, null, 'secret-key-echo')]);
    const err = await rejects(postWithRetry('{}', { key: 'secret-key-echo', fetchImpl: t.fetchImpl, ...fast }), KeyRejected);
    assert.equal(err.status, status);
    assert.ok(!err.message.includes('secret-key-echo'));
    assert.equal(t.posts.length, 1);
  });
}

await test('the failure text never carries the key', async () => {
  const t = transport([reply(500, null, 'bad token sk-live-123 in header')]);
  const err = await rejects(postWithRetry('{}', { key: 'sk-live-123', fetchImpl: t.fetchImpl, ...fast }), CallFailed);
  assert.ok(!err.message.includes('sk-live-123'));
});

await test('an abort cancels the backoff wait at once', async () => {
  const t = transport([reply(503)]);
  const ctl = new AbortController();
  const started = performance.now();
  const call = postWithRetry('{}', { key: 'k', signal: ctl.signal, backoffMs: 10_000, timeoutMs: 20_000, fetchImpl: t.fetchImpl });
  setTimeout(() => ctl.abort(), 30);
  await rejects(call, CallAborted);
  assert.ok(performance.now() - started < 1000, 'the 10 s backoff was not cut short');
  assert.equal(t.posts.length, 1);
});

await test('an already aborted signal posts nothing', async () => {
  const t = transport([reply(200)]);
  await rejects(postWithRetry('{}', { key: 'k', signal: AbortSignal.abort(), fetchImpl: t.fetchImpl }), CallAborted);
  assert.equal(t.posts.length, 0);
});

await test('one deadline covers the retries and the backoff', async () => {
  const t = transport([reply(503)]);
  const started = performance.now();
  await rejects(postWithRetry('{}', { key: 'k', timeoutMs: 120, retries: 50, backoffMs: 40, fetchImpl: t.fetchImpl }), CallTimeout);
  const took = performance.now() - started;
  assert.ok(took >= 100 && took < 600, `timeout fired at ${Math.round(took)} ms`);
  assert.ok(t.posts.length >= 2 && t.posts.length < 10, `${t.posts.length} posts`);
  const n = t.posts.length;
  await sleep(150);
  assert.equal(t.posts.length, n, 'a post went out after the deadline');
});

await test('a response that arrives after the timeout is discarded', async () => {
  let answered = false;
  const t = transport([async () => { await sleep(120); answered = true; return reply(200, { late: 1 }); }]); // ignores the signal
  const rec = new MemoryRecorder();
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: 'S', timeoutMs: 40, recorder: rec, ...fast });
  const decide = gw.monsterDecider({ gameId: 'gm_1' });
  await rejects(decide({ id: 'a1', state: {}, questions: {} }), CallTimeout);
  await sleep(200);
  assert.ok(answered, 'the double never answered');
  assert.equal(rec.entries.length, 1);
  assert.equal(rec.entries[0].outcome, 'aborted'); // the late answer was recorded as dropped, not delivered
});

await test('a per-call deadline: two calls in a row each get a fresh one', async () => {
  const t = transport([async () => { await sleep(45); return reply(200, { ok: 1 }); }]);
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: 'S', timeoutMs: 80, ...fast });
  const decide = gw.monsterDecider({ gameId: 'gm_1' });
  await decide({ id: 'a1', state: {}, questions: {} });
  await decide({ id: 'a1', state: {}, questions: {} }); // 90 ms in total: only fits if the clock restarts
});

await test('the recorder gets one entry per attempt with exact fields; no key, no body', async () => {
  const t = transport([reply(503, null, 'down'), reply(200, { a: 1 })]);
  const rec = new MemoryRecorder();
  let clock = 1000;
  const gw = new Gateway({ fetchImpl: t.fetchImpl, recorder: rec, now: () => (clock += 5), ...fast });
  const ask = gw.explorerAsker({ gameId: 'gm_1', actorId: 'par_1', getKey: () => 'KEY-par_1' });
  const body = JSON.stringify({ model: 'm', state: { secret_plan: 'x' }, questions: {} });
  await ask({ kind: 'sentiment', state: {}, questions: {}, body });
  assert.equal(rec.entries.length, 2);
  assert.deepEqual(rec.entries.map((e) => [e.attempt, e.status, e.outcome]), [[0, 503, 'retry'], [1, 200, 'ok']]);
  for (const e of rec.entries) {
    assert.deepEqual(Object.keys(e).sort(), ['at', 'actor', 'attempt', 'bytes_in', 'bytes_out', 'game', 'kind', 'ms', 'outcome', 'status'].sort());
    assert.equal(e.game, 'gm_1');
    assert.equal(e.actor, 'par_1');
    assert.equal(e.kind, 'sentiment');
    assert.equal(e.bytes_out, Buffer.byteLength(body));
    assert.ok(e.ms >= 0);
  }
  const dump = JSON.stringify(rec.entries);
  assert.ok(!dump.includes('KEY-par_1') && !dump.includes('secret_plan'));
});

await test('an explorer asker uses only its own participant key; nothing falls back', async () => {
  const t = transport([reply(200, { ok: 1 })]);
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: 'SERVER', ...fast });
  const keys = { par_a: 'KEY-A', par_b: 'KEY-B', par_c: null };
  const ask = (id) => gw.explorerAsker({ gameId: 'gm_1', actorId: id, getKey: () => keys[id] });
  await ask('par_a')({ kind: 'tick', state: {}, questions: {} });
  await ask('par_b')({ kind: 'tick', state: {}, questions: {} });
  assert.deepEqual(t.posts.map((p) => p.headers.Authorization), ['Bearer KEY-A', 'Bearer KEY-B']);
  await rejects(ask('par_c')({ kind: 'tick', state: {}, questions: {} }), NoKey);
  assert.equal(t.posts.length, 2, 'a keyless explorer must not post, least of all with another key');
  keys.par_a = 'KEY-A2'; // the key is read per call
  await ask('par_a')({ kind: 'tick', state: {}, questions: {} });
  assert.equal(t.posts[2].headers.Authorization, 'Bearer KEY-A2');
});

await test('a rejected participant key stops that call and is never replaced by the server key', async () => {
  const t = transport([reply(401)]);
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: 'SERVER', ...fast });
  const ask = gw.explorerAsker({ gameId: 'gm_1', actorId: 'par_a', getKey: () => 'KEY-A' });
  await rejects(ask({ kind: 'tick', state: {}, questions: {} }), KeyRejected);
  assert.equal(t.posts.length, 1);
  assert.ok(t.posts.every((p) => p.headers.Authorization === 'Bearer KEY-A'));
});

await test('the monster decider uses only the server key, read per call; no server key -> NoKey, no post', async () => {
  const t = transport([reply(200, { ok: 1 })]);
  let server = 'SERVER-1';
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: () => server, ...fast });
  const decide = gw.monsterDecider({ gameId: 'gm_1' });
  await decide({ id: 'a3', state: {}, questions: {} });
  server = 'SERVER-2';
  await decide({ id: 'a3', state: {}, questions: {} });
  assert.deepEqual(t.posts.map((p) => p.headers.Authorization), ['Bearer SERVER-1', 'Bearer SERVER-2']);
  server = null;
  await rejects(decide({ id: 'a3', state: {}, questions: {} }), NoKey);
  assert.equal(t.posts.length, 2);
});

await test('a body that was built without the pre-serialized string is built from state, questions and the model', async () => {
  const t = transport([reply(200, { ok: 1 })]);
  const gw = new Gateway({ fetchImpl: t.fetchImpl, serverKey: 'S', model: 'jev-x', ...fast });
  await gw.monsterDecider({ gameId: 'g' })({ id: 'a1', state: { s: 1 }, questions: { q: 1 } });
  assert.deepEqual(JSON.parse(t.posts[0].body), { model: 'jev-x', state: { s: 1 }, questions: { q: 1 } });
});

await test('dev askers go through the dev path and are recorded under game "dev"', async () => {
  const real = globalThis.fetch;
  const keyBefore = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = 'dev-key';
  const t = transport([reply(200, { d: 1 })]);
  globalThis.fetch = t.fetchImpl; // the dev path looks the global up at call time
  try {
    const rec = new MemoryRecorder();
    const gw = new Gateway({ recorder: rec });
    assert.deepEqual(await gw.devAsker()({ kind: 'tick', state: {}, questions: {} }), { d: 1 });
    assert.deepEqual(await gw.devDecider()({ id: 'a2', state: {}, questions: {} }), { d: 1 });
    assert.equal(t.posts[0].headers.Authorization, 'Bearer dev-key');
    assert.deepEqual(rec.entries.map((e) => [e.game, e.actor, e.kind, e.status]), [['dev', 'explorer', 'tick', 200], ['dev', 'a2', 'monster', 200]]);
  } finally {
    globalThis.fetch = real;
    if (keyBefore === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = keyBefore;
  }
});

await test('nothing above touched the global fetch', () => {
  assert.equal(uninstall.wire.hits, 0);
});

await sleep(50);
if (unhandled.length) { fails++; console.log(`FAIL: unhandled rejection: ${unhandled[0]?.message}`); }
console.log(fails ? `${fails} FAIL(S)` : 'check-gateway: ok');
process.exit(fails ? 1 : 0);
