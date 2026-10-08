// Checks for the player-directive API (PLAN-inject I2): Run.submitDirective policy (sanitising, limits,
// cooldown, queueing during a step, view/turn exposure) and the HTTP statuses of POST /api/inject.
// Free: stub Jev, fetch tripwire, never calls /api/step. If the brain's setDirective is not built yet,
// a stub is installed on the explorer instance and the live-server 200 / 429 paths are skipped.
// Run from the dungeon-game directory: node scripts/check-inject-api.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { newTestGame, sanitiseDirective } from '../src/turn.js';
import { ExplorerBrain } from '../src/characters/explorer/brain.js';
import { SCHEMA, validate, defaults } from '../src/settings.js';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; if (failures <= 25) console.error('FAIL:', msg); } };

const brainBuilt = typeof ExplorerBrain.prototype.setDirective === 'function';
const tmp = mkdtempSync(join(tmpdir(), 'inject-run-'));
const mk = () => {
  const run = newTestGame({ size: [9, 9], numAdversaries: 0 }, { ask: async () => ({}), decide: async () => ({}), memoryDir: pathToFileURL(tmp + '/'), dir: pathToFileURL(tmp + '/') });
  const log = [];
  if (!brainBuilt) {
    let d = null;
    Object.defineProperty(run.explorer, 'directive', { get: () => d, configurable: true });
    run.explorer.setDirective = (text, { steps }) => { log.push(['set', text, steps]); d = { text, from_step: 0, until_step: steps, steps_left: steps }; };
    run.explorer.clearDirective = (reason) => { log.push(['clear', reason]); d = null; };
  } else {
    const set = run.explorer.setDirective.bind(run.explorer);
    const clr = run.explorer.clearDirective.bind(run.explorer);
    run.explorer.setDirective = (t, o) => { log.push(['set', t, o.steps]); return set(t, o); };
    run.explorer.clearDirective = (r) => { log.push(['clear', r]); return clr(r); };
  }
  return { run, log };
};

// 1. sanitising
check(sanitiseDirective('  go \n\t to   the\u0000 east​ room ‮ ') === 'go to the east room', 'sanitise collapses whitespace and strips control / bidi chars');
check(sanitiseDirective('\n \t') === '' && sanitiseDirective(null) === '', 'sanitise: nothing left is empty');

// 2. settings group
const keys = SCHEMA.filter((s) => s.group === 'Player').map((s) => s.key);
check(['injectEnabled', 'injectMaxChars', 'injectSteps', 'injectCooldownS'].every((k) => keys.includes(k)), 'Player settings group has the four knobs');
const d = defaults();
check(d.injectEnabled === true && d.injectMaxChars === 140 && d.injectSteps === 20 && d.injectCooldownS === 10, 'Player defaults');
let threw = false;
try { validate({ injectMaxChars: 500 }, d); } catch { threw = true; }
check(threw, 'injectMaxChars above 140 is rejected');

// 3. Run.submitDirective
{
  const { run, log } = mk();
  const opts = { maxChars: 20, steps: 7, cooldownMs: 10_000 };
  let r = run.submitDirective(42, { ...opts, now: 0 });
  check(r.status === 400, 'non-string text -> 400');
  r = run.submitDirective('x'.repeat(21), { ...opts, now: 0 });
  check(r.status === 400 && log.length === 0, 'too long (after sanitising) -> 400, nothing set');
  r = run.submitDirective('  ' + 'x'.repeat(10) + '\n' + 'y'.repeat(9) + '  ', { ...opts, now: 0 });
  check(r.status === 200 && r.body.queued === false && log.length === 1 && log[0][1] === 'x'.repeat(10) + ' ' + 'y'.repeat(9) && log[0][2] === 7, '20 chars exactly is accepted, sanitised, steps passed');
  check(r.body.directive?.text?.length === 20 && run.view().directive?.text === run.directive?.text, 'response and view() carry the directive');
  r = run.submitDirective('again', { ...opts, now: 4_000 });
  check(r.status === 429 && r.body.retry_in_ms === 6000 && log.length === 1, '429 inside the cooldown with retry_in_ms');
  r = run.submitDirective('', { ...opts, now: 4_001 });
  check(r.status === 200 && r.body.directive === null && log.at(-1)[0] === 'clear' && run.view().directive === null, 'empty text clears, ignores the cooldown');
  r = run.submitDirective('again', { ...opts, now: 4_002 });
  check(r.status === 429, 'clearing does not reset the cooldown');
  r = run.submitDirective('again', { ...opts, now: 10_000 });
  check(r.status === 200 && log.at(-1)[1] === 'again', 'accepted after the cooldown');
  r = run.submitDirective('zero', { ...opts, cooldownMs: 0, now: 10_001 });
  check(r.status === 200, 'cooldown 0 never blocks');
}

// 4. queued while a step is in flight, applied at the start of the next step
{
  const { run, log } = mk();
  const realTurn = run.explorer.takeTurn.bind(run.explorer);
  let release;
  const hold = () => { const g = new Promise((res) => { release = res; }); run.explorer.takeTurn = async () => { await g; return realTurn(); }; };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  hold();
  const turn = run.playTurn();
  await settle();
  let r = run.submitDirective('queue me', { steps: 5, cooldownMs: 0, now: 0 });
  check(r.status === 200 && r.body.queued === true && log.length === 0, 'during a step: 200 queued, brain untouched');
  r = run.submitDirective('replace me', { steps: 5, cooldownMs: 0, now: 1 });
  check(r.body.queued === true && log.length === 0, 'a second one during the step replaces the queued one');
  release();
  const t1 = await turn;
  check(log.length === 0, 'nothing applied by the step already in flight');
  check('directive' in t1, 'the step result carries directive');
  run.explorer.takeTurn = realTurn;
  await run.playTurn();
  check(log.length === 1 && log[0][1] === 'replace me', 'queued directive applied before the next step (only the latest)');
  hold();
  const t2 = run.playTurn();
  await settle();
  r = run.submitDirective('', {});
  check(r.status === 200 && r.body.queued === true && log.at(-1)[0] === 'set', 'clear during a step is queued too');
  release();
  await t2;
  run.explorer.takeTurn = realTurn;
  await run.playTurn();
  check(log.at(-1)[0] === 'clear', 'queued clear applied at the next step');
}

// 5. game over -> 409
{
  const { run } = mk();
  run.game.lost = true;
  check(run.submitDirective('hi', { now: 0 }).status === 409, 'game over -> 409');
}
rmSync(tmp, { recursive: true, force: true });

// 5b. A REAL run (real brain, stub Jev, no network): submitDirective then 24 playTurns. turn.directive and
// view().directive count down, expire, and the parked approach resumes with no plan.tried row.
{
  const tmp2 = mkdtempSync(join(tmpdir(), 'inject-real-'));
  const ask = async ({ questions }) => {
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: 0.1 }; continue; }
      const keys = Object.keys(q.criteria);
      const c = k === 'sentiment' ? 'steady' : keys.find((d) => d !== 'stay' && d !== 'none') ?? keys[0];
      out[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
    }
    return out;
  };
  const run = newTestGame({ size: [30, 12], start: [1, 1], numAdversaries: 0 }, { ask, decide: async () => ({}), memoryDir: pathToFileURL(tmp2 + '/'), dir: pathToFileURL(tmp2 + '/') });
  for (let i = 0; i < 3; i++) await run.playTurn();
  const before = run.explorer.memory.approach.id;
  const r = run.submitDirective('explore the east side', { steps: 20, cooldownMs: 0, now: 0 });
  check(r.status === 200 && r.body.directive?.steps_left === 20, 'real run: 200 with 20 steps left');
  check(run.view().directive?.steps_left === 20, 'real run: view().directive before the first step');
  const lefts = [];
  let t;
  for (let i = 0; i < 24 && !run.game.won && !run.game.lost; i++) {
    t = await run.playTurn();
    lefts.push(t.directive?.steps_left ?? null);
    check((run.view().directive?.steps_left ?? null) === lefts[i], `real run: view and turn agree at step ${i + 1}`);
  }
  check(lefts.slice(0, 20).every((v, i) => v === 19 - i || (i === 19 && v === null)), `real run: countdown 19..0 (${lefts.slice(0, 21).join(',')})`);
  check(lefts.slice(19).every((v) => v === null) && run.view().directive === null, 'real run: expired after 20 steps and stays null');
  check(run.explorer.memory.events.some((e) => e.text === 'Directive ended: ran out of steps.'), 'real run: expiry event');
  { const a = run.explorer.memory.approach; check(a.tried.length === 0 && a.id !== 'directive', `real run: approach resumed, no plan.tried row (${before} -> ${a.id}, tried ${a.tried.length})`); }
  check(run.explorer.lastRequest()?.state?.directive === undefined, 'real run: requests plain after expiry');
  rmSync(tmp2, { recursive: true, force: true });
}

// 6. HTTP statuses on a live server (starting a game and injecting never call Jev; /api/step is never hit).
// node:http, because the fetch tripwire above is global.
const dir = mkdtempSync(join(tmpdir(), 'inject-api-'));
const port = 4100 + Math.floor(Math.random() * 800);
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, JEV_CONFIG: 'none', PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', TESTBED: 'size=9x9&numAdversaries=0&seed=2' }, stdio: ['ignore', 'ignore', 'inherit'] });
const req = (method, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const r = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: j }); });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
try {
  for (let i = 0; i < 100; i++) { try { await req('GET', '/api/settings'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  let r = await req('POST', '/api/inject', { text: 'hi' });
  check(r.status === 409, `HTTP no game -> 409 (got ${r.status})`);
  r = await req('POST', '/api/new', {});
  check(r.status === 200, 'HTTP new game');
  r = await req('POST', '/api/inject', 'not json');
  check(r.status === 400, 'HTTP bad JSON -> 400');
  r = await req('POST', '/api/inject', { text: 'x'.repeat(141) });
  check(r.status === 400, 'HTTP over 140 chars -> 400');
  r = await req('POST', '/api/inject', { text: 5 });
  check(r.status === 400, 'HTTP non-string -> 400');
  r = await req('POST', '/api/inject', { text: '' });
  check(r.status === 200 && r.body.directive === null, 'HTTP empty text clears -> 200');
  if (brainBuilt) {
    r = await req('POST', '/api/inject', { text: ' go  east\n' });
    check(r.status === 200 && r.body.directive?.text === 'go east' && r.body.directive.steps_left === 20, 'HTTP 200 with the sanitised directive and 20 steps');
    const st = await req('GET', '/api/state');
    check(st.body.game.directive?.text === 'go east', 'GET /api/state game.directive');
    r = await req('POST', '/api/inject', { text: 'again' });
    check(r.status === 429 && r.body.retry_in_ms > 0 && r.body.retry_in_ms <= 10000, 'HTTP second inject -> 429 with retry_in_ms');
  } else console.log('note: brain.setDirective not built yet, HTTP 200 / 429 paths skipped');
  r = await req('POST', '/api/settings', { values: { injectEnabled: false } });
  check(r.status === 200, 'settings save');
  r = await req('POST', '/api/inject', { text: 'hi' });
  check(r.status === 403, `HTTP injectEnabled off -> 403 (got ${r.status})`);
} catch (err) {
  check(false, `HTTP section threw: ${err.message}`);
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('check-inject-api: all passed' + (brainBuilt ? '' : ' (brain stubbed)'));
