// Checks that only the gateway can create a paid call (AGENTS.md rule 2, PLAN-multiplayer "Decision routing and cost").
// Static: only src/gateway/*, src/jev.js and src/openai-decider.js call fetch(), and nothing under src/characters (or any
// other file but the gateway) imports askJev. Dynamic, with the fetch tripwire installed: an ExplorerBrain or Run built
// without `ask` throws, a hunting ghost stepped without `decide` throws instead of fetching, and a patrol-only step
// needs neither. Free.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTripwire } from './lib/tripwire.mjs';

process.env.JEV_CONFIG = 'none';
const uninstall = installTripwire();
const root = fileURLToPath(new URL('..', import.meta.url));
let fails = 0;
const test = async (name, fn) => {
  try { await fn(); } catch (err) { fails++; console.log(`FAIL: ${name}: ${err.message}`); }
};

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.js')) yield p;
  }
}
// Code only: whole-line // comments are dropped, so a comment may mention fetch( or askJev.
const code = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const rel = (p) => relative(root, p).split(sep).join('/');
const files = [...walk(join(root, 'src'))];

await test('only the gateway, the dev providers and the OpenAI adapter call fetch()', () => {
  const allowed = (r) => r.startsWith('src/gateway/') || r === 'src/jev.js' || r === 'src/openai-decider.js';
  const bad = files.filter((f) => /\bfetch\s*\(/.test(code(f)) && !allowed(rel(f))).map(rel);
  assert.deepEqual(bad, []);
  assert.ok(files.some((f) => rel(f) === 'src/gateway/gateway.js'), 'the gateway is missing');
});

await test('nothing under src/ but the gateway imports askJev (the brains get their caller injected)', () => {
  const bad = files.filter((f) => /\baskJev\b/.test(code(f)) && !['src/jev.js', 'src/gateway/gateway.js'].includes(rel(f))).map(rel);
  assert.deepEqual(bad, []);
  const chars = files.filter((f) => rel(f).startsWith('src/characters/'));
  assert.ok(chars.length > 5);
  assert.ok(chars.every((f) => !/askJev|gateway\//.test(code(f))), 'a character file reaches for a paid path');
});

await test('the gateway is the only importer of the dev providers (src/jev.js askJev)', () => {
  const users = files.filter((f) => /import\s*\{[^}]*\baskJev\b[^}]*\}/.test(code(f))).map(rel);
  assert.deepEqual(users, ['src/gateway/gateway.js']);
});

const stubAnswers = async () => ({});
const config = { size: '9x9', numAdversaries: 1, adversariesInSight: true, props: 'none', treasure: 'far', seed: 3 };
const { ExplorerBrain } = await import('../src/characters/explorer/brain.js');
const { KnownWorld } = await import('../src/characters/explorer/known-world.js');
const { newTestGame } = await import('../src/turn.js');
const { stepAdversaries } = await import('../src/characters/adversary/adversary.js');

await test('a Run or an ExplorerBrain built without ask throws instead of defaulting to a real caller', () => {
  assert.throws(() => newTestGame(config, { decide: stubAnswers }), /ask is required/);
  assert.throws(() => newTestGame(config), /ask is required/);
  const run = newTestGame(config, { ask: stubAnswers, decide: stubAnswers });
  const world = new KnownWorld(run.game);
  assert.throws(() => new ExplorerBrain(world, {}), /ask is required/);
  assert.throws(() => new ExplorerBrain(world, { ask: null }), /ask is required/);
});

await test('a hunting ghost stepped without decide throws; nothing is fetched', async () => {
  const run = newTestGame(config, { ask: stubAnswers, decide: stubAnswers });
  // Speed 0.6: the ghost needs a couple of ticks of budget before it acts and asks.
  let err = null;
  for (let i = 0; i < 6 && !err; i++) await stepAdversaries(run.game).catch((e) => { err = e; });
  assert.match(err?.message ?? 'no error', /decide is required/);
  assert.equal(uninstall.wire.hits, 0);
});

await test('a patrol-only step needs no decide (and never fetches)', async () => {
  const run = newTestGame({ ...config, adversariesInSight: false, minAdversaryGap: 6, size: '25x25', seed: 5 }, { ask: stubAnswers, decide: stubAnswers });
  assert.ok(run.game.adversaries.every((a) => a.mode === 'patrol'));
  await stepAdversaries(run.game);
  assert.equal(uninstall.wire.hits, 0);
});

await test('the tripwire itself fires', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid'), /tripwire/);
  assert.equal(uninstall.wire.hits, 1);
});

console.log(fails ? `${fails} FAIL(S)` : 'check-paid-paths: ok');
process.exit(fails ? 1 : 0);
