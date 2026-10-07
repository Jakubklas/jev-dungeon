// Measures how the explorer's memory and requests behave over N ticks on each fixture arena
// (scripts/arenas/*.json): request size, decisions, re-encounters, ping-pong, outcome, hits.
// Default is a dry run with stub answers (free). --live calls the real Jev and COSTS MONEY.
// Run from the dungeon-game directory:
//   node scripts/measure-memory.mjs                      all fixtures, 60 ticks, stubbed
//   node scripts/measure-memory.mjs --arena door --ticks 40
//   node scripts/measure-memory.mjs --live --arena door  (paid; do not run unless asked)
// Relies only on run.playTurn() -> { decision, events, ... }, run.game and the bodies handed to
// the injected ask/decide, so it survives changes to the explorer's memory shape.

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
}
const LIVE = flags.live === 'true';
const TICKS = Number(flags.ticks ?? 60);
const REENCOUNTER_WINDOW = 8; // steps after a 'chase_over' decision

const ARENAS = new URL('./arenas/', import.meta.url);
const names = flags.arena ? [flags.arena] : readdirSync(ARENAS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

if (LIVE) {
  // .env before the turn module pulls in jev.js (same order as server.js).
  process.loadEnvFile(new URL('../../.env', import.meta.url));
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
  console.warn('!!! LIVE RUN: REAL JEV CALLS, THIS COSTS MONEY !!!');
  console.warn(`!!! ${names.length} arena(s) x up to ${TICKS} ticks; each tick bills 1-2 explorer requests plus 1 per hunting adversary, each hedged x2. !!!`);
} else {
  globalThis.fetch = () => { throw new Error('network call in a dry run'); }; // tripwire: a missed stub must not bill
}
const { newTestGame } = await import('../src/turn.js');
const { seesExplorer } = await import('../src/characters/adversary/adversary.js');
const { askJev } = await import('../src/jev.js');

const first = (q) => Object.keys(q.criteria ?? {})[0];
const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));

const dir = mkdtempSync(join(tmpdir(), 'measure-memory-'));
const url = pathToFileURL(dir + '/');
const rows = [];

for (const name of names) {
  const config = JSON.parse(readFileSync(new URL(`${name}.json`, ARENAS), 'utf8'));
  const sizes = { 'explorer sentiment': [], 'explorer tick': [], adversary: [] };
  const record = (kind, body) => (sizes[kind] ??= []).push(Buffer.byteLength(body ?? '', 'utf8'));
  const respond = LIVE ? ({ state, questions, body }) => askJev(state, questions, body) : stub;
  const ask = async (req) => {
    record(req.kind === 'sentiment' ? 'explorer sentiment' : 'explorer tick', req.body);
    return respond(req);
  };
  const decide = async (req) => { record('adversary', req.body); return respond(req); };
  const run = newTestGame(config, { ask, decide, memoryDir: url, dir: url });
  const { game } = run;
  const chest = game.dungeon.treasure;
  const trail = [[...game.pos]];
  let decisions = 0, hits = 0, backForth = 0, chestStep = null, lostStep = null, ticks = 0;
  const chaseOvers = []; // steps of 'chase_over' decisions
  let reEncounters = 0;
  const pending = new Set(); // chase_over steps not yet followed by a sighting
  for (; ticks < TICKS && !game.won && !game.lost; ticks++) {
    const turn = await run.playTurn();
    const step = game.steps;
    if (turn.decision) {
      decisions++;
      if (turn.decision.trigger === 'chase_over') { chaseOvers.push(step); pending.add(step); }
    }
    hits += (turn.events ?? []).filter((e) => e.type === 'hit').length;
    const seen = game.adversaries.some((a) => seesExplorer(game, a));
    for (const s of [...pending]) {
      if (step - s > REENCOUNTER_WINDOW) pending.delete(s);
      else if (seen && step > s) { reEncounters++; pending.delete(s); }
    }
    trail.push([...game.pos]);
    const n = trail.length;
    if (n >= 3 && trail[n - 1].join() === trail[n - 3].join() && trail[n - 1].join() !== trail[n - 2].join()) backForth++;
    if (chestStep === null && chest && game.pos[0] === chest[0] && game.pos[1] === chest[1]) chestStep = step;
    if (game.lost && lostStep === null) lostStep = step;
  }
  const outcome = game.won ? `won@${game.steps}` : game.lost ? `lost@${lostStep ?? game.steps}` : 'running';
  rows.push({ name, ticks, sizes, decisions, chaseOvers: chaseOvers.length, reEncounters, backForth, chest: chestStep ?? '-', outcome, hits });
}

const stat = (a) => (a.length ? `${Math.round(a.reduce((s, n) => s + n, 0) / a.length)}/${Math.max(...a)} (n=${a.length})` : '-');
console.log(`measure-memory: ${LIVE ? 'LIVE (paid)' : 'dry run, stub answers'}, up to ${TICKS} ticks per arena`);
console.log('request bytes are avg/max of the JSON body sent to Jev\n');
for (const r of rows) {
  console.log(`${r.name}: ${r.ticks} ticks, ${r.outcome}, chest ${r.chest}, hits ${r.hits}`);
  console.log(`  bytes sentiment ${stat(r.sizes['explorer sentiment'])} | tick ${stat(r.sizes['explorer tick'])} | adversary ${stat(r.sizes.adversary)}`);
  console.log(`  decisions ${r.decisions} (chase_over ${r.chaseOvers}) | re-encounters ${r.reEncounters} | back-and-forth ${r.backForth}`);
}
const cols = ['arena', 'ticks', 'decisions', 're-enc', 'ping-pong', 'chest', 'outcome', 'hits'];
console.log(`\n${cols.join('\t')}`);
for (const r of rows) console.log([r.name, r.ticks, r.decisions, r.reEncounters, r.backForth, r.chest, r.outcome, r.hits].join('\t'));
rmSync(dir, { recursive: true, force: true });
