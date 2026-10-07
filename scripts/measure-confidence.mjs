// PLAN-confidence phase C0: does the confidence score C leave its neutral zone (40..79) in real play?
// Plays the REAL ExplorerBrain end to end (newGame dungeons and newTestGame arenas) with a FIGHTING executor
// (fixed mood, engage when offered else run_away, the first non-none skill key, moves read from the move facts
// like the check-dungeon 4f stub, plus a seeded walk-in probability p) against CLAWING ghosts (duel-harness
// decide), and feeds every turn to confidence.js applyTurn passively (brain, memory and turn.js untouched).
// Free: stub ask / decide everywhere, fetch is a throwing tripwire (duel-harness installs it), no network.
//   node scripts/measure-confidence.mjs [--seeds 40] [--arenas 40] [--ticks 150] [--p 0,0.2,0.5] [--mood bold]
// Exit 0 always (it measures); it prints the C0 gate. Events derived from the turn shape and the brain's own
// request: struck / dispelled / hit / blocked (turn.events), chase_over (decision.trigger), visible ghosts and
// their chasing flag, the sword's readiness and the approach (the request state). NOT derivable today: `stunned`
// ids (the brain's private #struck), so `pressed` can count a stunned ghost at the hold gap (an upper bound).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide, mulberry32, man } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { DIRS } from '../src/dungeon.js';
import { newGame, newTestGame } from '../src/turn.js';
import { createConfidence, applyTurn } from '../src/characters/explorer/confidence.js';

const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
const SEEDS = Number(flags.seeds ?? 40);
const ARENAS = Number(flags.arenas ?? 40);
const TICKS = Number(flags.ticks ?? 150);
const PS = (flags.p ?? '0,0.2,0.5').split(',').map(Number);
const MOOD = flags.mood ?? 'bold';
const ZONE = [40, 80]; // neutral: 40 <= C < 80

const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

// The fighting executor. `own` is the script's PRNG for walk-in draws (never rng() of the game).
function makeAsk(game, p, own, probe) {
  return async ({ questions, state }) => {
    probe.state = state;
    const visible = state.threats?.visible?.length > 0;
    const out = {};
    // One walk-in draw per tick (a decision tick makes two requests).
    if (probe.drawnAt !== game.steps) { probe.drawnAt = game.steps; probe.walkIn = visible && own() < p; }
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(keys.includes(MOOD) ? MOOD : keys[0]);
      else if (k === 'tactic') out[k] = answer(keys.includes('engage') ? 'engage' : keys.includes('run_away') ? 'run_away' : keys[0]);
      else if (k === 'skill') out[k] = answer(keys.find((x) => x !== 'none') ?? 'none');
      else if (k === 'next_move' || k.startsWith('move_if_')) {
        const moves = keys.filter((d) => d !== 'stay');
        let pick = null;
        if (probe.walkIn) {
          const near = game.adversaries.reduce((b, a) => (!b || man(a.pos, game.pos) < man(b.pos, game.pos) ? a : b), null);
          const nx = (d) => [game.pos[0] + DIRS[d][0], game.pos[1] + DIRS[d][1]];
          if (near) pick = moves.filter((d) => man(nx(d), near.pos) >= 1).sort((a, b) => man(nx(a), near.pos) - man(nx(b), near.pos))[0] ?? null;
        }
        pick ??= moves.find((d) => /Reaches the target/.test(q.criteria[d])) ?? moves.find((d) => /Closer to the target/.test(q.criteria[d])) ?? null;
        out[k] = answer(pick ?? moves[0] ?? 'stay');
      } else out[k] = answer(keys[0]);
    }
    return out;
  };
}

async function playGame(kind, seed, p) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-conf-'));
  const url = pathToFileURL(dir + '/');
  const rnd = Math.random;
  Math.random = mulberry32(seed * 7919 ^ 0x9e3779b9); // the option shuffle, per game
  const probe = {};
  const holder = {};
  const t0 = performance.now();
  try {
    const opts = { ask: (req) => holder.ask(req), decide: clawDecide, dir: url, memoryDir: url };
    let run;
    if (kind === 'dungeon') run = newGame(seed, opts);
    else run = newTestGame({ size: 13 + (seed % 5), seed, numAdversaries: 1 + (seed % 3), ghostHp: 1 + (seed % 3) }, opts);
    const game = run.game;
    holder.ask = makeAsk(game, p, mulberry32(seed * 104729 + Math.round(p * 1000)), probe);
    let C = createConfidence();
    let lastState = null; // an engage-hold tick with no skill offered sends no request: it keeps the last one's view
    const r = { kind, seed, p, ticks: 0, min: 50, max: 50, left: false, hits: 0, strikes: 0, dispelled: 0, blocked: 0, evaded: 0, pressed: 0, won: false, lost: false };
    for (let t = 0; t < TICKS && !game.won && !game.lost; t++) {
      probe.state = null;
      const turn = await run.playTurn();
      r.ticks = t + 1;
      // A held tick (turn.held) makes no request when no skill is offered; a ghost is still in sight, so reuse the
      // previous request's view instead of reading the tick as calm (no ghost visible).
      const st = probe.state ?? (turn.held ? lastState : null);
      if (probe.state) lastState = probe.state;
      const visible = (st?.threats?.visible ?? []).map((a) => ({ id: a.id, distance: a.distance, mode: a.chasing ? 'chase' : 'patrol' }));
      const sk = st?.self?.skills ?? {};
      const armed = Object.entries(sk).some(([id, v]) => id.startsWith('sword') && v === 'ready');
      const engaging = st?.plan?.approach?.id === 'engage';
      r.hits += turn.events.filter((e) => e.type === 'hit').length;
      r.strikes += turn.events.filter((e) => e.type === 'struck').length;
      r.dispelled += turn.events.filter((e) => e.type === 'dispelled').length;
      r.blocked += turn.events.filter((e) => e.type === 'blocked').length;
      C = applyTurn(C, turn, { lives: game.health, maxLives: game.maxHealth, armed, visible, engaging, stunned: [] });
      r.min = Math.min(r.min, C.value);
      r.max = Math.max(r.max, C.value);
      if (C.value < ZONE[0] || C.value >= ZONE[1]) r.left = true;
    }
    r.evaded = C.counts.evaded; r.pressed = C.counts.pressed;
    r.won = game.won; r.lost = game.lost; r.ms = performance.now() - t0;
    return r;
  } finally {
    Math.random = rnd;
    rmSync(dir, { recursive: true, force: true });
  }
}

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0.0');
const summary = {};
for (const p of PS) {
  for (const [kind, n] of [['dungeon', SEEDS], ['arena', ARENAS]]) {
    const games = [];
    for (let s = 1; s <= n; s++) games.push(await playGame(kind, s, p));
    const left = games.filter((g) => g.left).length;
    const row = {
      left, leftPct: Number(pct(left, n)), ticks: sum(games, (g) => g.ticks) / n, sec: sum(games, (g) => g.ms) / n / 1000,
      hits: sum(games, (g) => g.hits) / n, strikes: sum(games, (g) => g.strikes) / n, dispelled: sum(games, (g) => g.dispelled) / n,
      blocked: sum(games, (g) => g.blocked) / n, evaded: sum(games, (g) => g.evaded) / n, pressed: sum(games, (g) => g.pressed) / n,
      withFight: games.filter((g) => g.strikes + g.dispelled > 0).length, withHit: games.filter((g) => g.hits > 0).length,
      lost: games.filter((g) => g.lost).length, minC: Math.min(...games.map((g) => g.min)), maxC: Math.max(...games.map((g) => g.max)),
      below40: games.filter((g) => g.min < ZONE[0]).length, above80: games.filter((g) => g.max >= ZONE[1]).length,
    };
    summary[`${kind} p=${p}`] = row;
    console.log(`${kind.padEnd(7)} p=${p}  games ${n}  left zone ${left} (${row.leftPct}%)  below40 ${row.below40} above80 ${row.above80}  C range ${row.minC}..${row.maxC}  ` +
      `ticks/game ${row.ticks.toFixed(1)}  s/game ${row.sec.toFixed(2)}  per game: strikes ${row.strikes.toFixed(2)} dispelled ${row.dispelled.toFixed(2)} hits ${row.hits.toFixed(2)} ` +
      `blocked ${row.blocked.toFixed(2)} evaded ${row.evaded.toFixed(2)} pressed ${row.pressed.toFixed(2)}  games with a fight ${row.withFight}, with a hit ${row.withHit}, lost ${row.lost}`);
  }
}
const g02 = summary['dungeon p=0.2'];
console.log(`C0 GATE (dungeon games leaving 40..79 at p=0.2, need >= 20%): ${g02 ? g02.leftPct + '%' : 'p=0.2 not run'} -> ${g02 && g02.leftPct >= 20 ? 'PASS' : 'FAIL'}`);
