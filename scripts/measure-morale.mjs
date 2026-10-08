// Measures monster morale (PLAN-monster-morale.md M6) over generated dungeons: how morale moves, which tiers
// and moods are actually reached, how often a monster routs, what it costs in Jev calls and request bytes,
// and the same run with the toggle off for comparison. Prints a table and exits 0 (a measurement, not a check),
// except for the two gates it does assert: every tier must be reachable and the call count must not rise.
//
// Dry run only: stub answers, fetch is a tripwire, nothing is billed. There is no --live mode.
//   node scripts/measure-morale.mjs [--seeds 12] [--ticks 200] [--characters on|off]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REQUEST_BYTES } from '../src/config/registry.js';

globalThis.fetch = () => { throw new Error('network call in a measurement: it must stay free'); };

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
const SEEDS = Number(flag('seeds', 12));
const TICKS = Number(flag('ticks', 200));
const CHARACTERS = flag('characters', 'on') !== 'off';

const { newGame } = await import('../src/turn.js');
const { configureAdversaries } = await import('../src/characters/adversary/adversary.js');
const { MOODS, MOOD_IDS } = await import('../src/characters/adversary/morale.js');

const first = (q) => [...Object.keys(q.criteria ?? {})].sort()[0]; // sorted: the option order is shuffled
const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));
// The explorer's stub fights back: it always takes a skill when one is offered, so monsters are wounded and
// dispelled and the low tier is actually exercised. Without it a stub explorer never swings and morale only rises.
const fighter = async (req) => {
  const out = await stub(req);
  const keys = [...Object.keys(req.questions.skill?.criteria ?? {})].sort().filter((k) => k !== 'none');
  if (keys.length) out.skill = { choice: keys[0], probabilities: { [keys[0]]: 1 } };
  return out;
};

const dir = mkdtempSync(join(tmpdir(), 'measure-morale-'));
const url = pathToFileURL(dir + '/');

async function play(seed, morale) {
  configureAdversaries({ adversaryCharacters: CHARACTERS, monsterMorale: morale });
  const bytes = [];
  let calls = 0;
  const ask = async (req) => fighter(req);
  const decide = async (req) => { calls++; bytes.push(Buffer.byteLength(req.body, 'utf8')); return stub(req); };
  const run = newGame(seed, { ask, decide, memoryDir: url, dir: url });
  const game = run.game;
  const stats = {
    ticks: 0, calls: 0, bytes, hunts: 0, hits: 0, routs: 0, dispels: 0, strikes: 0,
    moods: Object.fromEntries(MOOD_IDS.map((m) => [m, 0])), tiers: { low: 0, mid: 0, high: 0 },
    lowest: 100, highest: 0, monsters: game.adversaries.length,
  };
  for (; stats.ticks < TICKS && !game.won && !game.lost; stats.ticks++) {
    const turn = await run.playTurn();
    for (const e of turn.events ?? []) {
      if (e.type === 'brain_on') stats.hunts++;
      if (e.type === 'hit') stats.hits++;
      if (e.type === 'routed') stats.routs++;
      if (e.type === 'dispelled') stats.dispels++;
      if (e.type === 'struck') stats.strikes++;
    }
    for (const a of game.adversaries) {
      const m = a.memory.morale;
      if (!m) continue;
      stats.moods[m.mood]++;
      stats.tiers[m.tier]++;
      stats.lowest = Math.min(stats.lowest, m.value);
      stats.highest = Math.max(stats.highest, m.value);
    }
  }
  stats.calls = calls;
  return stats;
}

const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(0)}%` : '-');

const on = [], off = [];
console.log(`measure-morale: ${SEEDS} generated dungeons x up to ${TICKS} ticks, stubbed (free), characters ${CHARACTERS ? 'on' : 'off'}\n`);
for (let i = 0; i < SEEDS; i++) {
  off.push(await play(1000 + i, false));
  on.push(await play(1000 + i, true));
}

const sizes = (rows) => { const b = rows.flatMap((r) => r.bytes); return { avg: b.length ? Math.round(b.reduce((x, y) => x + y, 0) / b.length) : 0, max: b.length ? Math.max(...b) : 0 }; };
const { avg, max } = sizes(on);
const offSizes = sizes(off);
const moodTicks = sum(on, 'ticks') ? Object.values(on[0].moods).length : 0;
const totalMoodTicks = on.reduce((n, r) => n + Object.values(r.moods).reduce((a, b) => a + b, 0), 0);

console.log('                      morale off     morale on');
const row = (label, f) => console.log(`  ${label.padEnd(20)}${String(f(off)).padStart(10)}${String(f(on)).padStart(14)}`);
row('ticks played', (r) => sum(r, 'ticks'));
row('monster Jev calls', (r) => sum(r, 'calls'));
row('calls per tick', (r) => (sum(r, 'calls') / Math.max(1, sum(r, 'ticks'))).toFixed(2));
row('hunts started', (r) => sum(r, 'hunts'));
row('explorer hits taken', (r) => sum(r, 'hits'));
row('monsters struck', (r) => sum(r, 'strikes'));
row('monsters dispelled', (r) => sum(r, 'dispels'));
row('routs', (r) => sum(r, 'routs'));

console.log('\n  tier share (morale on, per monster-tick)');
for (const t of ['low', 'mid', 'high']) console.log(`    ${t.padEnd(6)} ${pct(sum(on, 'tiers') ? 0 : 0, 1) && pct(on.reduce((n, r) => n + r.tiers[t], 0), totalMoodTicks)}`);
console.log('\n  mood share');
for (const m of MOOD_IDS) {
  const n = on.reduce((a, r) => a + r.moods[m], 0);
  if (n) console.log(`    ${m.padEnd(11)} ${pct(n, totalMoodTicks)}  (${MOODS[m].tier})`);
}
console.log(`\n  morale seen: ${Math.min(...on.map((r) => r.lowest))} .. ${Math.max(...on.map((r) => r.highest))}`);
console.log(`  monster request bytes: avg ${avg}, max ${max} (morale off: ${offSizes.avg} / ${offSizes.max}; bounds ${REQUEST_BYTES.adversaryAvg} / ${REQUEST_BYTES.adversaryMax})`);

// The two gates the plan sets: every tier is reachable (a model whose extremes never fire is decoration),
// and morale adds no Jev calls (the mood rides on the request the monster already sends).
const reached = ['low', 'mid', 'high'].filter((t) => on.some((r) => r.tiers[t] > 0));
const callsOn = sum(on, 'calls') / Math.max(1, sum(on, 'ticks'));
const callsOff = sum(off, 'calls') / Math.max(1, sum(off, 'ticks'));
let bad = 0;
const gate = (ok, what) => { if (!ok) { bad++; console.error(`FAIL: ${what}`); } else console.log(`ok   ${what}`); };
console.log('');
gate(reached.length === 3, `every tier is reached (${reached.join(', ')})`);
gate(callsOn <= callsOff * 1.05 + 0.01, `morale costs no extra Jev calls (${callsOn.toFixed(2)} vs ${callsOff.toFixed(2)} per tick)`);
gate(avg <= REQUEST_BYTES.adversaryAvg && max <= REQUEST_BYTES.adversaryMax, 'requests stay inside the size bounds');

rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
