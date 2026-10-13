// Measures what tabu (PLAN-tabu.md) buys: the same games with tabu OFF and ON (explorer tabuEnabled via
// configureExplorerBrain, monster advTabuEnabled via configureAdversaryBrain), per scenario group: back-and-forth,
// longest repeated-cell run, encounter length, strikes / dispels / hits / deaths, portal wins, Jev calls per tick
// (the plan expected forced choices to lower it; with minMoves 2 none are) and request bytes, plus how often tabu fired.
// Not a check: prints tables and exits 0 (1 only on a crash).
// Default is FREE: fetch is a throwing tripwire, Jev is replaced by stubs, Math.random (the option shuffle) is a seeded
// PRNG per game so both arms see the same dice. --live plays the same scenarios with the real Jev and COSTS MONEY
// (needs --games N; explorer and monsters both call the real Jev).
//   node scripts/measure-tabu.mjs                                 both arms, stubs stubborn + fight, every scenario, 20 seeds
//   node scripts/measure-tabu.mjs --arm on|off|both               which arm(s)
//   node scripts/measure-tabu.mjs --stub stubborn,fight           explorer stubs: 'stubborn' repeats its last answer for every
//                                                                 question kind (the stub that stalls), 'fight' is request-hashes' fightAsk
//   node scripts/measure-tabu.mjs --monsters claw|stubborn        monster stub: 'claw' steps toward the explorer and claws (duel harness),
//                                                                 'stubborn' repeats its last move
//   node scripts/measure-tabu.mjs --scenario closed-room,dead-end,two-ghosts,fixture:door,dungeons   filter (substring match on name or group)
//   node scripts/measure-tabu.mjs --seeds 20 --reps 5 --ticks 80 --dticks 150   dungeon seeds, arena repetitions, ticks per arena / dungeon
//   node scripts/measure-tabu.mjs --json out.json                 raw per-game results
//   node scripts/measure-tabu.mjs --live --games 6 --ticks 80 --scenario closed-room   PAID: real Jev, refuses without --games
// Memory files go to a temp dir. In --live mode --ticks applies to every scenario.

import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const ARMS = flags.arm === 'on' ? ['on'] : flags.arm === 'off' ? ['off'] : ['off', 'on'];
const STUBS = (flags.stub ?? 'stubborn,fight').split(',');
const MONSTERS = flags.monsters ?? 'claw';
const SEEDS = Number(flags.seeds ?? 20);
const REPS = Number(flags.reps ?? 5);
const ARENA_TICKS = Number(flags.ticks ?? 80);
const DUNGEON_TICKS = Number(flags.dticks ?? (flags.ticks ? Number(flags.ticks) : 150));
const FILTER = flags.scenario ? flags.scenario.split(',') : null;
for (const s of STUBS) if (!['stubborn', 'fight'].includes(s)) throw new Error(`unknown --stub ${s}`);
if (!['claw', 'stubborn'].includes(MONSTERS)) throw new Error(`unknown --monsters ${MONSTERS}`);

if (LIVE) {
  if (!flags.games || flags.games === 'true') { console.error('--live needs an explicit --games N cap (it costs money).'); process.exit(2); }
  // .env before the turn module pulls in jev.js (same order as server.js).
  process.loadEnvFile(new URL('../../.env', import.meta.url));
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
} else {
  globalThis.fetch = () => { throw new Error('network call in a dry run'); }; // tripwire: a missed stub must not bill
}
const { newGame, newTestGame } = await import('../src/turn.js');
const { configureExplorerBrain, explorerBrainSnapshot } = await import('../src/characters/explorer/brain.js');
const { configureAdversaryBrain, adversaryBrainSnapshot } = await import('../src/characters/adversary/brain.js');
const { Gateway } = await import('../src/gateway/gateway.js');
const gateway = new Gateway(); // --live only: the gateway's dev askers are the only paid path
// The stubs and the seeded PRNG live in files that install the tripwire when imported: free mode only.
let fightAsk, clawDecide, mulberry32;
if (!LIVE) {
  ({ fightAsk } = await import('./request-hashes.mjs'));
  ({ clawDecide, mulberry32 } = await import('./lib/duel-harness.mjs'));
}

const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// Repeats its last answer for every kind of question: the same mood, the same tactic, the same move direction while
// it is still offered (else the first option). A stub that already varies never stalls, so this is the one that does.
function stubbornAsk() {
  const last = {};
  return async ({ questions }) => {
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      const g = k === 'next_move' || k.startsWith('move_if_') ? 'move' : k;
      const pick = keys.includes(last[g]) ? last[g] : keys[0];
      last[g] = pick;
      out[k] = answer(pick);
    }
    return out;
  };
}

// The monsters' stub that stalls: repeats its last move (else the first option); claws whenever offered.
function stubbornDecide() {
  const last = {};
  return async ({ id, questions }) => {
    const out = {};
    if (questions.next_move) {
      const keys = Object.keys(questions.next_move.criteria);
      last[id] = keys.includes(last[id]) ? last[id] : keys[0];
      out.next_move = answer(last[id]);
    }
    if (questions.skill) out.skill = answer(Object.keys(questions.skill.criteria).find((x) => x !== 'none') ?? 'none');
    if (questions.search_approach) out.search_approach = { choice: Object.keys(questions.search_approach.criteria)[0], probabilities: {}, confidence: 1 };
    if (questions.keep_hunting) out.keep_hunting = { noul: 0.9 };
    return out;
  };
}

// --- scenarios -----------------------------------------------------------------------------------
const ARENAS = new URL('./arenas/', import.meta.url);
const ROOM = (w, h, cells) => {
  const rows = [];
  for (let y = 0; y < h + 2; y++) rows.push([...'#'.repeat(w + 2)].map((c, x) => (y === 0 || y === h + 1 || x === 0 || x === w + 1 ? '#' : '.')));
  for (const [c, x, y] of cells) rows[y][x] = c;
  return rows.map((r) => r.join(''));
};
function scenarios() {
  const list = [];
  const arena = (group, name, config, reps = REPS) => { for (let r = 1; r <= reps; r++) list.push({ group, name: `${name}#${r}`, kind: 'arena', config: { ...config, seed: (config.seed ?? 1) + r - 1 }, ticks: ARENA_TICKS }); };
  // The run_away corner shuttle: a 12x5 room with no exit and a ghost 4 cells off.
  arena('closed-room', 'closed-room', { map: ROOM(12, 5, [['@', 3, 3], ['A', 7, 3]]) });
  arena('dead-end', 'dead-end', { map: ['#################', '#################', '#@......A.......#', '#################', '#################'] });
  arena('two-ghosts', 'two-ghosts', { map: ROOM(13, 5, [['@', 3, 3], ['A', 8, 2], ['A', 9, 4]]) });
  for (const f of readdirSync(ARENAS).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()) {
    arena('fixtures', `fixture:${f}`, JSON.parse(readFileSync(new URL(`${f}.json`, ARENAS), 'utf8')), Math.max(1, Math.ceil(REPS / 2)));
  }
  for (let seed = 1; seed <= SEEDS; seed++) list.push({ group: 'dungeons', name: `dungeon:${seed}`, kind: 'dungeon', seed, ticks: DUNGEON_TICKS });
  return FILTER ? list.filter((s) => FILTER.some((f) => s.name.includes(f) || s.group.includes(f))) : list;
}

// --- one game ------------------------------------------------------------------------------------
const hash = (s) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
const explorerBefore = explorerBrainSnapshot();
const adversaryBefore = adversaryBrainSnapshot();

async function playGame(s, arm, stub) {
  const on = arm === 'on';
  configureExplorerBrain({ tabuEnabled: on });
  configureAdversaryBrain({ advTabuEnabled: on });
  const dir = mkdtempSync(join(tmpdir(), 'measure-tabu-'));
  const url = pathToFileURL(dir + '/');
  const real = Math.random;
  if (!LIVE) Math.random = mulberry32(0x7ab0 ^ hash(s.name)); // same dice in both arms
  const m = { expReq: 0, expBytes: 0, monReq: 0, monBytes: 0 };
  const holder = {};
  const respondExplorer = LIVE ? gateway.devAsker() : (req) => holder.ask(req);
  const respondMonster = LIVE ? gateway.devDecider() : MONSTERS === 'claw' ? clawDecide : stubbornDecide();
  const ask = (req) => { m.expReq++; m.expBytes += (req.body ?? JSON.stringify(req.state) + JSON.stringify(req.questions)).length; return respondExplorer(req); };
  const decide = (req) => { m.monReq++; m.monBytes += (req.body ?? JSON.stringify(req.state) + JSON.stringify(req.questions)).length; return respondMonster(req); };
  try {
    const o = { ask, decide, dir: url, memoryDir: url };
    const run = s.kind === 'dungeon' ? newGame(s.seed, o) : newTestGame(s.config, o);
    const { game } = run;
    if (!LIVE) holder.ask = stub === 'fight' ? fightAsk(game, { mood: 'bold', p: 0.3, seed: s.seed ?? s.config.seed ?? 1 }) : stubbornAsk();
    const cells = [game.pos.join()];
    const r = {
      scenario: s.name, group: s.group, arm, stub: LIVE ? 'live' : stub, ticks: 0, backAndForth: 0, maxRepeat: 0, encounters: 0, encounterTicks: 0,
      strikes: 0, dispels: 0, hits: 0, died: false, wonBy: null, tabu: { tactic: 0, mood: 0, move: 0, forcedMove: 0, monMove: 0, monForcedApproach: 0 },
    };
    let encStart = null;
    const closeEnc = (t) => { if (encStart !== null) { r.encounters++; r.encounterTicks += t - encStart; encStart = null; } };
    for (let t = 1; t <= s.ticks && !game.won && !game.lost; t++) {
      const turn = await run.playTurn();
      r.ticks = t;
      cells.push(game.pos.join());
      const n = cells.length;
      if (n >= 3 && cells[n - 1] === cells[n - 3] && cells[n - 1] !== cells[n - 2]) r.backAndForth++;
      const win = cells.slice(-12);
      const counts = new Map();
      for (const c of win) counts.set(c, (counts.get(c) ?? 0) + 1);
      r.maxRepeat = Math.max(r.maxRepeat, ...counts.values());
      if (turn.decision?.trigger === 'encounter' && encStart === null) encStart = t;
      if (turn.decision?.trigger === 'chase_over') closeEnc(t);
      for (const e of turn.events) {
        if (e.type === 'strike' && e.id === 'explorer') r.strikes++;
        else if (e.type === 'dispelled') r.dispels++;
        else if (e.type === 'hit') r.hits++;
      }
      const tb = turn.tabu;
      if (tb) {
        if (tb.removed?.length) r.tabu.tactic++;
        if (tb.removed_moods?.length) r.tabu.mood++;
        if (tb.removed_moves?.length) r.tabu.move++;
        if (tb.forced) r.tabu.forcedMove++;
      }
      for (const at of turn.adversaryTurns ?? []) {
        if (at.tabu?.removed_moves?.length) r.tabu.monMove++;
        if (at.tabu?.forced_approach) r.tabu.monForcedApproach++;
      }
    }
    closeEnc(r.ticks + 1);
    r.died = game.lost;
    r.wonBy = game.won ? game.winBy ?? 'chest' : null;
    r.expReq = m.expReq; r.expBytes = m.expBytes; r.monReq = m.monReq; r.monBytes = m.monBytes;
    return r;
  } finally {
    Math.random = real;
    configureExplorerBrain(explorerBefore);
    configureAdversaryBrain(adversaryBefore);
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- tables --------------------------------------------------------------------------------------
const COLS = [
  ['group', 12], ['stub', 9], ['arm', 4], ['n', 3], ['b&f', 5], ['rep', 5], ['encLen', 6], ['strk', 5], ['disp', 5], ['hits', 5], ['dead', 4],
  ['portal', 6], ['clear', 5], ['call/t', 6], ['expB', 6], ['monB', 6], ['tbT/M/Mv', 9], ['fMv', 5], ['mMv/fA', 7],
];
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
function row(label, stubName, arm, rs) {
  const n = rs.length;
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
  const ticks = Math.max(sum((r) => r.ticks), 1);
  const enc = sum((r) => r.encounters);
  const reqs = sum((r) => r.expReq);
  const mreqs = sum((r) => r.monReq);
  const avg = (f) => sum(f) / Math.max(n, 1);
  return [
    label, stubName, arm, String(n), f1(avg((r) => r.backAndForth)), f1(avg((r) => r.maxRepeat)), enc ? f1(sum((r) => r.encounterTicks) / enc) : '-',
    f1(avg((r) => r.strikes)), f1(avg((r) => r.dispels)), f1(avg((r) => r.hits)), String(sum((r) => (r.died ? 1 : 0))),
    String(sum((r) => (r.wonBy === 'chest' ? 1 : 0))), String(sum((r) => (r.wonBy === 'cleared' ? 1 : 0))),
    ((sum((r) => r.expReq) + sum((r) => r.monReq)) / ticks).toFixed(2), reqs ? String(Math.round(sum((r) => r.expBytes) / reqs)) : '-',
    mreqs ? String(Math.round(sum((r) => r.monBytes) / mreqs)) : '-',
    `${f1(avg((r) => r.tabu.tactic))}/${f1(avg((r) => r.tabu.mood))}/${f1(avg((r) => r.tabu.move))}`, f1(avg((r) => r.tabu.forcedMove)),
    `${f1(avg((r) => r.tabu.monMove))}/${f1(avg((r) => r.tabu.monForcedApproach))}`,
  ];
}
const fmt = (cells) => cells.map((c, i) => (i < 3 ? c.padEnd(COLS[i][1]) : c.padStart(COLS[i][1]))).join(' ');
function printTable(results) {
  console.log(fmt(COLS.map((c) => c[0])));
  const stubs = [...new Set(results.map((r) => r.stub))];
  const groups = [...new Set(results.map((r) => r.group))];
  for (const st of stubs) {
    for (const g of groups) for (const arm of ARMS) {
      const rs = results.filter((r) => r.stub === st && r.group === g && r.arm === arm);
      if (rs.length) console.log(fmt(row(g, st, arm, rs)));
    }
    for (const arm of ARMS) console.log(fmt(row('TOTAL', st, arm, results.filter((r) => r.stub === st && r.arm === arm))));
    console.log('');
  }
  console.log('b&f = explorer returns to the cell two back per game; rep = most entries of one cell in any 12-step window (game max, averaged); encLen = mean ticks per encounter');
  console.log('(encounter trigger to chase_over); strk/disp/hits per game; dead/portal/clear = counts of games; call/t = explorer + monster Jev requests per tick; expB/monB = mean request bytes;');
  console.log('tbT/M/Mv = ticks per game in which the explorer\'s tactic / mood / move menu really dropped an option; fMv = ticks with a tabu-forced move; mMv/fA = monster ticks with a dropped move / forced search approach.');
}

// --- main ----------------------------------------------------------------------------------------
const plan = [];
for (const st of LIVE ? ['live'] : STUBS) for (const s of scenarios()) for (const arm of ARMS) plan.push({ s, arm, st });
const cap = LIVE ? Number(flags.games) : Infinity;
if (LIVE && !(cap > 0)) { console.error('--games must be a positive number.'); process.exit(2); }
const todo = plan.slice(0, cap);
if (LIVE) {
  const ticks = todo.reduce((n, p) => n + p.s.ticks, 0);
  console.warn('!!! LIVE RUN: REAL JEV CALLS, THIS COSTS MONEY !!!');
  console.warn(`!!! ${todo.length} game(s), up to ${ticks} ticks in total; each tick bills 1-2 explorer requests plus 1 per hunting adversary: roughly up to ${ticks * 4} requests. !!!`);
}
console.log(`measure-tabu: ${LIVE ? 'LIVE (paid)' : 'dry run, stub answers'}, arms ${ARMS.join('/')}, ${LIVE ? '' : `explorer stubs ${STUBS.join('/')}, monsters ${MONSTERS}, `}${todo.length} games`);
const t0 = Date.now();
const results = [];
for (const p of todo) {
  const r = await playGame(p.s, p.arm, p.st);
  results.push(r);
  if (LIVE) console.log(`game ${results.length}/${todo.length} ${r.scenario} tabu ${r.arm}: ${r.ticks} ticks, b&f ${r.backAndForth}, rep ${r.maxRepeat}, strikes ${r.strikes}, dispels ${r.dispels}, hits ${r.hits}, ${r.died ? 'DIED' : r.wonBy ?? 'running'}, requests ${r.expReq}+${r.monReq}, tabu ${JSON.stringify(r.tabu)}`);
}
console.log('');
printTable(results);
console.log(`\nruntime ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (flags.json) { writeFileSync(flags.json, JSON.stringify(results, null, 1) + '\n'); console.log(`wrote ${flags.json}`); }
