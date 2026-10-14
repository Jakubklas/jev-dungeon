// Measures how the explorer's memory and requests behave over N ticks on each fixture arena
// (scripts/arenas/*.json): request size, decisions, re-encounters, ping-pong, outcome, hits, and combat:
// strike offers, strikes, dispels, coins, and the moods and tactics picked (`duel` is one ghost in an open room).
// Default is a dry run with stub answers (free). --live calls the real Jev and COSTS MONEY.
// Run from the dungeon-game directory:
//   node scripts/measure-memory.mjs                      all fixtures, 60 ticks, stubbed
//   node scripts/measure-memory.mjs --arena door --ticks 40
//   node scripts/measure-memory.mjs --live --arena door  (paid; do not run unless asked)
//   node scripts/measure-memory.mjs --who adversary [--memory off]   adversary side (stubbed): request bytes,
//                                hunts, give-up reasons, hits, re-finds, ping-pong, calls per tick; with the
//                                adversaryCharacters toggle on (default) it asserts avg <= 5.5 KB, max <= 8 KB
//   node scripts/measure-memory.mjs --who adversary --morale on   same with the monsterMorale toggle: the
//                                morale wording rides on the same requests, so the same bounds must still hold
//   node scripts/measure-memory.mjs --who adversary --limited on   same with the limitedMap toggle: also known-map
//                                size per ghost, cells forgotten, and the longest stretch a ghost idles without a
//                                target (fails above 5 ticks)
//   node scripts/measure-memory.mjs --who adversary --accept [--seeds 24] [--ticks 300]
//                                A4 acceptance on generated dungeons, standard ghosts, a wandering explorer and a
//                                stub that reads the move sentences: hits with limitedMap vs full map (50%..110%)
// Relies only on run.playTurn() -> { decision, events, ... }, run.game and the bodies handed to
// the injected ask/decide, so it survives changes to the explorer's memory shape.

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { REQUEST_BYTES } from '../src/config/registry.js'; // the one definition of the request-size bounds
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
const WHO = flags.who ?? 'explorer';
const ADV_BUDGET = { avg: REQUEST_BYTES.adversaryAvg, max: REQUEST_BYTES.adversaryMax }; // bytes, adversary requests with smart memory on

const ARENAS = new URL('./arenas/', import.meta.url);
const names = flags.arena ? [flags.arena] : readdirSync(ARENAS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

if (LIVE) {
  // .env before the turn module pulls in jev.js (same order as server.js).
  process.loadEnvFile(new URL('../../.env', import.meta.url));
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
  console.warn('!!! LIVE RUN: REAL JEV CALLS, THIS COSTS MONEY !!!');
  console.warn(`!!! ${names.length} arena(s) x up to ${TICKS} ticks; each tick bills 1-2 explorer requests plus 1 per hunting adversary. !!!`);
} else {
  globalThis.fetch = () => { throw new Error('network call in a dry run'); }; // tripwire: a missed stub must not bill
}
const { newTestGame } = await import('../src/turn.js');
const { seesExplorer } = await import('../src/characters/adversary/adversary.js');
const { Gateway } = await import('../src/gateway/gateway.js');
const gateway = new Gateway(); // --live only: the gateway's dev askers are the only paid path

const first = (q) => Object.keys(q.criteria ?? {})[0];
const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));

// --- adversary mode: stubbed play, per-character numbers -------------------------------------
if (WHO === 'adversary') {
  if (LIVE) throw new Error('--who adversary is stubbed only');
  const { configureAdversaries, adversaryView } = await import('../src/characters/adversary/adversary.js');
  const memoryOn = flags.memory !== 'off';
  const limitedOn = flags.limited === 'on';
  const moraleOn = flags.morale === 'on'; // monster morale (PLAN-monster-morale.md): the same size bounds apply
  configureAdversaries({ adversaryCharacters: memoryOn, limitedMap: limitedOn, monsterMorale: moraleOn });
  const advDir = mkdtempSync(join(tmpdir(), 'measure-adv-'));
  const advUrl = pathToFileURL(advDir + '/');
  if (flags.accept === 'true') {
    // A4 acceptance. Ghosts are spawned with the toggles off (so they are all `standard`), then the toggles are
    // switched on: smart memory in both runs, the limited map only in the second.
    const { generateDungeon, floorDistances, rng } = await import('../src/dungeon.js');
    const { Run } = await import('../src/turn.js');
    const { spawnAdversaries, stepAdversaries } = await import('../src/characters/adversary/adversary.js');
    const SEEDS = Number(flags.seeds ?? 24);
    const T = Number(flags.ticks ?? 300);
    const key = ([x, y]) => `${x},${y}`;
    // A stub that reads the move sentences like the priorities say: step onto the explorer, else the move that
    // shortens the path distances it names, else the one that brings most unchecked cells into view.
    const smart = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: 0.9 }];
      let best = null;
      for (const [choice, text] of Object.entries(q.criteria)) {
        const t = String(text);
        const deltas = [...t.matchAll(/(\d+) → (\d+)/g)].reduce((n, m) => n + Number(m[2]) - Number(m[1]), 0);
        const unchecked = Number(/Brings (\d+) unchecked/.exec(t)?.[1] ?? 0);
        const score = /Steps onto the explorer/.test(t) ? -1e9 : deltas * 10 - unchecked * 0.1;
        if (!best || score < best.score || (score === best.score && choice < best.choice)) best = { choice, score };
      }
      return [k, { choice: best.choice, probabilities: { [best.choice]: 1 }, confidence: 1 }];
    }));
    async function play(seed, limited) {
      const dungeon = generateDungeon(seed);
      configureAdversaries({ adversaryCharacters: false, limitedMap: false });
      const ghosts = spawnAdversaries(dungeon); // all standard
      configureAdversaries({ adversaryCharacters: true, limitedMap: limited });
      const run = new Run(dungeon, ghosts, { ask: smart, decide: smart, dir: advUrl, memoryDir: advUrl });
      const { game } = run;
      const real = Math.random;
      Math.random = rng(seed * 7 + 1);
      const wander = rng(seed ^ 0x2545f491);
      const rooms = (dungeon.rooms ?? []);
      let goal = null, path = [], hits = 0, hunting = 0, known = 0, forgotten = 0, idle = 0, maxIdle = 0, steps = 0;
      const idleRun = new Map();
      try {
        for (; steps < T && !game.won && !game.lost; steps++) {
          if (!path.length) {
            const r = rooms[Math.floor(wander() * rooms.length)];
            goal = [r.x + Math.floor(wander() * r.w), r.y + Math.floor(wander() * r.h)];
            const dist = floorDistances(dungeon, goal);
            for (let c = [...game.pos]; dist.get(key(c)) > 0;) {
              const d = dist.get(key(c));
              const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [c[0] + dx, c[1] + dy]).find((m) => dist.get(key(m)) === d - 1);
              path.push(n);
              c = n;
            }
          }
          if (!path.length) continue; // the goal was the cell it stands on
          const next = path.shift();
          const dir = { '1,0': 'right', '-1,0': 'left', '0,1': 'down', '0,-1': 'up' }[`${next[0] - game.pos[0]},${next[1] - game.pos[1]}`];
          game.applyMove(dir);
          const { events } = await stepAdversaries(game, { decide: smart });
          hits += events.filter((e) => e.type === 'hit').length;
          for (const a of game.adversaries) {
            if (!a.hunt.on) { idleRun.set(a.id, 0); continue; }
            hunting++;
            const req = a.lastRequest();
            const noTarget = a.mode === 'search' && req && req.state.approach_target === null;
            idleRun.set(a.id, noTarget ? (idleRun.get(a.id) ?? 0) + 1 : 0);
            maxIdle = Math.max(maxIdle, idleRun.get(a.id));
          }
        }
        for (const a of game.adversaries) {
          const v = adversaryView(game, a);
          known += v.knownCount() ?? 0;
          forgotten += v.forgotten;
        }
      } finally {
        Math.random = real;
      }
      return { hits, hunting, known: known / Math.max(game.adversaries.length, 1), forgotten, maxIdle, ticks: steps };
    }
    const sum = (rows, f) => rows.reduce((n, r) => n + r[f], 0);
    const full = [], lim = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      full.push(await play(seed, false));
      lim.push(await play(seed, true));
    }
    const ratio = sum(lim, 'hits') / Math.max(sum(full, 'hits'), 1);
    console.log(`A4 acceptance: ${SEEDS} dungeons x up to ${T} ticks, standard ghosts, wandering explorer`);
    console.log(`  full map   : hits ${sum(full, 'hits')}, hunting ghost-ticks ${sum(full, 'hunting')}`);
    console.log(`  limited map: hits ${sum(lim, 'hits')}, hunting ghost-ticks ${sum(lim, 'hunting')}, known cells per ghost avg ${(sum(lim, 'known') / SEEDS).toFixed(0)}, cells forgotten ${sum(lim, 'forgotten')}, longest idle ${Math.max(...lim.map((r) => r.maxIdle))} ticks`);
    console.log(`  hits limited / full = ${(ratio * 100).toFixed(0)}% (want 50%..110%)`);
    const ok = ratio >= 0.5 && ratio <= 1.1 && Math.max(...lim.map((r) => r.maxIdle)) <= 5;
    if (!ok) console.error('FAIL: A4 acceptance (hits ratio outside 50%..110%, or a ghost idled more than 5 ticks without a target)');
    rmSync(advDir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }
  const REFIND = 8; // ticks after losing sight within which the ghost sees the explorer again
  let failed = false;
  console.log(`measure-memory --who adversary: dry run, stub answers, up to ${TICKS} ticks per arena, smart memory ${memoryOn ? 'ON' : 'off'}, morale ${moraleOn ? 'ON' : 'off'}`);
  for (const name of names) {
    const config = JSON.parse(readFileSync(new URL(`${name}.json`, ARENAS), 'utf8'));
    const bytes = new Map(); // character -> sizes
    let calls = 0;
    let game;
    const record = (id, body) => {
      calls++;
      const c = game.adversaries.find((a) => a.id === id)?.character ?? '?';
      if (!bytes.has(c)) bytes.set(c, []);
      bytes.get(c).push(Buffer.byteLength(body, 'utf8'));
    };
    const ask = async (req) => stub(req);
    const decide = async (req) => { record(req.id, req.body); return stub(req); };
    const run = newTestGame(config, { ask, decide, memoryDir: advUrl, dir: advUrl });
    game = run.game;
    const hist = new Map(game.adversaries.map((a) => [a.id, [[...a.pos]]]));
    const lost = []; // { id, tick }
    let ticks = 0, hunts = 0, huntTicks = 0, hits = 0, firstHit = null, refinds = 0, losses = 0, pingpong = 0, maxIdle = 0;
    const idleRun = new Map();
    const reasons = { timeout: 0, keep_hunting: 0, other: 0 };
    for (; ticks < TICKS && !game.won && !game.lost; ticks++) {
      const turn = await run.playTurn();
      for (const e of turn.events ?? []) {
        if (e.type === 'brain_on') hunts++;
        if (e.type === 'lost_sight') { losses++; lost.push({ id: e.id, tick: ticks }); }
        if (e.type === 'brain_off') reasons[/keep_hunting/.test(e.reason) ? 'keep_hunting' : /no sight/.test(e.reason) ? 'timeout' : 'other']++;
        if (e.type === 'hit') { hits++; firstHit ??= ticks + 1; }
      }
      for (const a of game.adversaries) {
        if (limitedOn) {
          // Idle: a searching ghost whose request holds no approach target.
          const noTarget = a.hunt.on && a.mode === 'search' && a.lastRequest()?.state?.approach_target === null;
          idleRun.set(a.id, noTarget ? (idleRun.get(a.id) ?? 0) + 1 : 0);
          maxIdle = Math.max(maxIdle, idleRun.get(a.id));
        }
        if (a.memory.brain.on) huntTicks++;
        const h = hist.get(a.id);
        h.push([...a.pos]);
        const n = h.length;
        if (a.memory.brain.on && n >= 3 && h[n - 1].join() === h[n - 3].join() && h[n - 1].join() !== h[n - 2].join()) pingpong++;
      }
      for (const l of [...lost]) {
        const a = game.adversaries.find((x) => x.id === l.id);
        if (ticks - l.tick > REFIND) lost.splice(lost.indexOf(l), 1);
        else if (ticks > l.tick && seesExplorer(game, a)) { refinds++; lost.splice(lost.indexOf(l), 1); }
      }
    }
    const all = [...bytes.values()].flat();
    const avg = all.length ? Math.round(all.reduce((x, y) => x + y, 0) / all.length) : 0;
    const max = all.length ? Math.max(...all) : 0;
    console.log(`${name}: ${ticks} ticks, hits ${hits}${firstHit ? ` (first at tick ${firstHit})` : ''}, hunts ${hunts} (${(hunts * 100 / Math.max(ticks, 1)).toFixed(1)}/100 ticks), hunting ticks per hunt ${(huntTicks / Math.max(hunts, 1)).toFixed(1)}`);
    console.log(`  give-ups: timeout ${reasons.timeout}, keep_hunting ${reasons.keep_hunting}, other ${reasons.other} | re-find within ${REFIND} ticks ${refinds}/${losses} | ping-pong ${pingpong} | calls/tick ${(calls / Math.max(ticks, 1)).toFixed(2)}`);
    console.log(`  bytes avg/max ${avg}/${max} (n=${all.length})` + (bytes.size > 1 ? ` | by character ${[...bytes].map(([c, v]) => `${c} ${Math.round(v.reduce((x, y) => x + y, 0) / v.length)}/${Math.max(...v)}`).join(', ')}` : ''));
    if (limitedOn) {
      const views = game.adversaries.map((a) => adversaryView(game, a));
      const known = views.map((v) => v.knownCount() ?? 0);
      console.log(`  known cells per ghost ${known.map((n) => n).join('/')} | cells forgotten ${views.reduce((n, v) => n + v.forgotten, 0)} | longest idle without a target ${maxIdle} ticks`);
      if (maxIdle > 5) {
        console.error(`FAIL: ${name}: a ghost idled ${maxIdle} ticks without a target`);
        failed = true;
      }
    }
    if (memoryOn && all.length && (avg > ADV_BUDGET.avg || max > ADV_BUDGET.max)) {
      console.error(`FAIL: ${name}: adversary request bytes ${avg}/${max} over the budget ${ADV_BUDGET.avg}/${ADV_BUDGET.max}`);
      failed = true;
    }
  }
  rmSync(advDir, { recursive: true, force: true });
  if (failed) process.exit(1);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'measure-memory-'));
const url = pathToFileURL(dir + '/');
const rows = [];

for (const name of names) {
  const config = JSON.parse(readFileSync(new URL(`${name}.json`, ARENAS), 'utf8'));
  const sizes = { 'explorer sentiment': [], 'explorer tick': [], adversary: [] };
  const record = (kind, body) => (sizes[kind] ??= []).push(Buffer.byteLength(body ?? '', 'utf8'));
  const liveAsk = LIVE ? gateway.devAsker() : null;
  const liveDecide = LIVE ? gateway.devDecider() : null;
  const ask = async (req) => {
    record(req.kind === 'sentiment' ? 'explorer sentiment' : 'explorer tick', req.body);
    return LIVE ? liveAsk(req) : stub(req);
  };
  const decide = async (req) => { record('adversary', req.body); return LIVE ? liveDecide(req) : stub(req); };
  const run = newTestGame(config, { ask, decide, memoryDir: url, dir: url });
  const { game } = run;
  const chest = game.dungeon.treasure;
  const trail = [[...game.pos]];
  let decisions = 0, hits = 0, backForth = 0, chestStep = null, lostStep = null, ticks = 0;
  let offers = 0, strikes = 0, dispels = 0;
  const picks = { mind: {}, tactic: {} }; // what the decision ticks chose, counted
  const chaseOvers = []; // steps of 'chase_over' decisions
  let reEncounters = 0;
  const pending = new Set(); // chase_over steps not yet followed by a sighting
  for (; ticks < TICKS && !game.won && !game.lost; ticks++) {
    const turn = await run.playTurn();
    const step = game.steps;
    if (turn.decision) {
      decisions++;
      for (const [k, v] of [['mind', turn.decision.sentiment?.choice], ['tactic', turn.decision.tactic?.choice]]) if (v) picks[k][v] = (picks[k][v] ?? 0) + 1;
      if (turn.decision.trigger === 'chase_over') { chaseOvers.push(step); pending.add(step); }
    }
    hits += (turn.events ?? []).filter((e) => e.type === 'hit').length;
    if (run.explorer.lastRequests().some((r) => r.questions?.skill)) offers++;
    strikes += (turn.events ?? []).filter((e) => e.type === 'strike' && e.id === 'explorer').length;
    dispels += (turn.events ?? []).filter((e) => e.type === 'dispelled').length;
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
  rows.push({ name, ticks, sizes, decisions, chaseOvers: chaseOvers.length, reEncounters, backForth, chest: chestStep ?? '-', outcome, hits, offers, strikes, dispels, coins: game.coins, picks });
}

const stat = (a) => (a.length ? `${Math.round(a.reduce((s, n) => s + n, 0) / a.length)}/${Math.max(...a)} (n=${a.length})` : '-');
console.log(`measure-memory: ${LIVE ? 'LIVE (paid)' : 'dry run, stub answers'}, up to ${TICKS} ticks per arena`);
console.log('request bytes are avg/max of the JSON body sent to Jev\n');
for (const r of rows) {
  console.log(`${r.name}: ${r.ticks} ticks, ${r.outcome}, portal ${r.chest}, hits ${r.hits}`);
  console.log(`  bytes sentiment ${stat(r.sizes['explorer sentiment'])} | tick ${stat(r.sizes['explorer tick'])} | adversary ${stat(r.sizes.adversary)}`);
  console.log(`  decisions ${r.decisions} (chase_over ${r.chaseOvers}) | re-encounters ${r.reEncounters} | back-and-forth ${r.backForth}`);
  const counts = (o) => Object.entries(o).map(([k, n]) => `${k}×${n}`).join(', ') || '-';
  console.log(`  combat: skill offered on ${r.offers} ticks, strikes ${r.strikes}, dispels ${r.dispels}, coins ${r.coins} | minds ${counts(r.picks.mind)} | tactics ${counts(r.picks.tactic)}`);
}
const cols = ['arena', 'ticks', 'decisions', 're-enc', 'ping-pong', 'portal', 'outcome', 'hits', 'offers', 'strikes', 'dispels', 'coins'];
console.log(`\n${cols.join('\t')}`);
for (const r of rows) console.log([r.name, r.ticks, r.decisions, r.reEncounters, r.backForth, r.chest, r.outcome, r.hits, r.offers, r.strikes, r.dispels, r.coins].join('\t'));
rmSync(dir, { recursive: true, force: true });
