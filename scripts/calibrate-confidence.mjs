// PLAN-confidence phase C4: calibration and sweep of the confidence score C. Free: the REAL ExplorerBrain plays
// newGame dungeons and generated newTestGame arenas against clawing ghosts (duel-harness) with the fighting executor
// (lib/fight-executor.mjs), stub ask / decide, Math.random seeded per game, fetch a throwing tripwire.
//   node scripts/calibrate-confidence.mjs [--phase all|reliability|sweep|compare] [--quick] [--workers 9] [--out file.json]
// Games are farmed out to child processes (this script forks itself with --job). Nothing here reads text, so a free
// run shows only what the CODE gates (min_gap delta, engage open) do against a scripted executor, never whether Jev
// uses the word. Pre-declared design (fixed before the first run, see PLAN-confidence.md 'C4 results'):
//  (a) reliability: arm `weighted` (default weights), C recorded at the start of each fight (first tick with engage or
//      a strike offered; the value BEFORE that tick), bucketed by band within strata of visible ghost count (1, 2, 3+).
//      Win = a ghost dispelled with no hit taken since the fight began. A fight ends at a win, at a hit (loss), after
//      IDLE_END ticks with no ghost in sight, or with the game (the last two count as no win and are also reported
//      apart). No new fight opens within REARM ticks of the last close. GATE: stratum-weighted win rate of the high
//      bands (sure, dominant) minus the low bands (shaken, unsure, even) >= 15 points. No tuning if it fails.
//  (b) sweep on TRAIN seeds (dungeons 1..40, arenas 1..60, crowds 1..60): the null arm `off`, `weighted` (default), `beta`, and
//      one-at-a-time plus two joint weight sets (10 in all; struck3, evaded8, pressed0 and calm0.6 were dropped for time before the sweep ran). The winner is the weight set with the fewest hits per game whose
//      coins per game are not below the null arm's by more than 1 standard error of the paired difference; ties go
//      to the default. Chosen ONCE on train seeds.
//  (c) compare on HELD-OUT seeds (dungeons 1001..1300, arenas 1001..1400, crowds 1001..1300, never used by (b)): off vs weighted vs
//      fitted vs beta, same seeds for every arm, paired differences with standard errors.
//      SHIP RULE (plan): ship only if some C arm beats `off` on hits per game or fight win rate WITHOUT losing coins.
//      "Beats" = paired z <= -2.4 on hits (z >= 2.4 on win rate; 2.4 = Bonferroni for the 3 C arms); "without
//      losing coins" = paired coin difference >= -2 standard errors.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { clawDecide, mulberry32 } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { makeAsk } from './lib/fight-executor.mjs';
import { newGame, newTestGame } from '../src/turn.js';
import { createConfidence, applyTurn, band, WEIGHTS } from '../src/characters/explorer/confidence.js';

const TICKS = 150;
const MOOD = 'bold';
const PS = [0, 0.2, 0.5];
const IDLE_END = 12;
const REARM = 4;
const BANDS = ['shaken', 'unsure', 'even', 'sure', 'dominant'];

// ---- one game (runs in a worker) -------------------------------------------------------------------------------
async function playGame({ arm, kind, seed, p }) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cal-'));
  const url = pathToFileURL(dir + '/');
  const rnd = Math.random;
  Math.random = mulberry32(seed * 7919 ^ 0x9e3779b9); // the option shuffle: the same stream for every arm
  const probe = {};
  const holder = {};
  const bytes = { n: 0, sum: 0, max: 0 };
  try {
    const ask = (req) => {
      const b = Buffer.byteLength(req.body ?? '', 'utf8');
      bytes.n++; bytes.sum += b; bytes.max = Math.max(bytes.max, b);
      return holder.ask(req);
    };
    const opts = { ask, decide: clawDecide, dir: url, memoryDir: url, confidence: arm.confidence };
    // 'crowd' (added before the first full run, to give fights that are not near-certain wins): 3..5 ghosts, 2..3 hp.
    const run = kind === 'dungeon' ? newGame(seed, opts)
      : kind === 'crowd' ? newTestGame({ size: 13 + (seed % 5), seed, numAdversaries: 3 + (seed % 3), ghostHp: 2 + (seed % 2) }, opts)
      : newTestGame({ size: 13 + (seed % 5), seed, numAdversaries: 1 + (seed % 3), ghostHp: 1 + (seed % 3) }, opts);
    const game = run.game;
    holder.ask = makeAsk(game, p, mulberry32(seed * 104729 + Math.round(p * 1000)), probe, MOOD);
    let passive = arm.confidence ? null : createConfidence(); // the null arm still gets a PASSIVE C for the buckets
    let C = 50;
    let lastState = null;
    const r = { arm: arm.name, kind, seed, p, hits: 0, strikes: 0, dispelled: 0, coins: 0, ticks: 0, won: false, lost: false, fights: [] };
    let fight = null;
    let lastClose = -99;
    const close = (t, win, why) => { r.fights.push({ n: fight.n, C: fight.C, band: band(fight.C), win, why, ticks: t - fight.t }); fight = null; lastClose = t; };
    for (let t = 0; t < TICKS && !game.won && !game.lost; t++) {
      probe.state = null; probe.offered = false;
      const before = C;
      const turn = await run.playTurn();
      r.ticks = t + 1;
      const st = probe.state ?? (turn.held ? lastState : null);
      if (probe.state) lastState = probe.state;
      const vis = st?.threats?.visible ?? [];
      const hit = turn.events.some((e) => e.type === 'hit');
      const dis = turn.events.some((e) => e.type === 'dispelled');
      r.hits += turn.events.filter((e) => e.type === 'hit').length;
      r.strikes += turn.events.filter((e) => e.type === 'struck').length;
      r.dispelled += turn.events.filter((e) => e.type === 'dispelled').length;
      if (passive) { // null arm: same derivation as C0
        const sk = st?.self?.skills ?? {};
        const armed = Object.entries(sk).some(([id, v]) => id.startsWith('sword') && v === 'ready');
        passive = applyTurn(passive, turn, {
          lives: game.health, maxLives: game.maxHealth, armed, engaging: st?.plan?.approach?.id === 'engage',
          visible: vis.map((a) => ({ id: a.id, distance: a.distance, mode: a.chasing ? 'chase' : 'patrol' })), stunned: [],
        });
        C = passive.value;
      } else C = turn.confidence.value;
      if (!fight && probe.offered && t - lastClose >= REARM && vis.length) fight = { t, n: Math.min(3, vis.length), C: before, idle: 0 };
      if (fight) {
        if (hit) close(t, false, 'hit');
        else if (dis) close(t, true, 'dispelled');
        else { fight.idle = vis.length ? 0 : fight.idle + 1; if (fight.idle >= IDLE_END) close(t, false, 'idle'); }
      }
    }
    if (fight) close(r.ticks, false, 'end');
    r.coins = game.coins; r.won = game.won; r.lost = game.lost;
    r.bytesAvg = bytes.n ? bytes.sum / bytes.n : 0; r.bytesMax = bytes.max; r.requests = bytes.n;
    return r;
  } finally {
    Math.random = rnd;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- orchestration ---------------------------------------------------------------------------------------------
function farm(jobs, workers, label) {
  return new Promise((resolve) => {
    const out = []; let next = 0; let live = 0; let doneN = 0; const t0 = Date.now();
    const self = fileURLToPath(import.meta.url);
    for (let w = 0; w < workers; w++) {
      const c = fork(self, ['--job'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      live++;
      const feed = () => { if (next < jobs.length) c.send(jobs[next++]); else c.send('exit'); };
      c.on('message', (m) => {
        if (m === 'ready') return feed();
        out.push(m); doneN++;
        if (doneN % 100 === 0) console.log(`  [${label}] ${doneN}/${jobs.length} games, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
        feed();
      });
      c.on('exit', () => { if (--live === 0) resolve(out); });
    }
  });
}

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const mean = (a, f) => (a.length ? sum(a, f) / a.length : 0);
const key = (r) => `${r.kind}|${r.seed}|${r.p}`;
function paired(base, other, f) { // mean(other - base) and its standard error over the same games
  const m = new Map(base.map((r) => [key(r), r]));
  const d = other.map((r) => f(r) - f(m.get(key(r))));
  const mu = mean(d, (x) => x);
  const sd = Math.sqrt(sum(d, (x) => (x - mu) ** 2) / Math.max(1, d.length - 1));
  const se = sd / Math.sqrt(d.length);
  return { mu, se, z: se > 0 ? mu / se : 0, n: d.length };
}
const fights = (rs) => rs.flatMap((r) => r.fights);
const winRate = (fs) => (fs.length ? fs.filter((f) => f.win).length / fs.length : NaN);
const pc = (x) => (Number.isNaN(x) ? '  - ' : (100 * x).toFixed(1).padStart(5) + '%');
function winZ(baseFs, fs) { // two-proportion z of (fs - baseFs)
  const a = winRate(baseFs), b = winRate(fs);
  const pool = (baseFs.filter((f) => f.win).length + fs.filter((f) => f.win).length) / (baseFs.length + fs.length);
  const se = Math.sqrt(pool * (1 - pool) * (1 / baseFs.length + 1 / fs.length));
  return { d: b - a, z: se > 0 ? (b - a) / se : 0 };
}
function armRow(name, rs, base) {
  const fs = fights(rs);
  const row = {
    name, games: rs.length, fights: fs.length, win: winRate(fs), hits: mean(rs, (r) => r.hits), coins: mean(rs, (r) => r.coins),
    dispelled: mean(rs, (r) => r.dispelled), strikes: mean(rs, (r) => r.strikes), ticks: mean(rs, (r) => r.ticks),
    lost: sum(rs, (r) => (r.lost ? 1 : 0)), bytesAvg: mean(rs, (r) => r.bytesAvg), bytesMax: Math.max(...rs.map((r) => r.bytesMax)),
  };
  if (base && base !== rs) {
    row.dHits = paired(base, rs, (r) => r.hits); row.dCoins = paired(base, rs, (r) => r.coins);
    row.dDisp = paired(base, rs, (r) => r.dispelled); row.dWin = winZ(fights(base), fs);
  }
  return row;
}
const f2 = (x) => x.toFixed(2);
const sg = (x) => `${x >= 0 ? '+' : ''}${f2(x)}`;
function printRows(title, rows) {
  console.log(`\n${title}`);
  console.log('arm'.padEnd(16) + 'games fights  win%   hits/g  coins/g disp/g  lost  B avg  B max   d hits (z)       d coins (z)      d win pts (z)');
  for (const r of rows) {
    console.log(r.name.padEnd(16) + String(r.games).padStart(5) + String(r.fights).padStart(7) + pc(r.win) + f2(r.hits).padStart(8) + f2(r.coins).padStart(9) + f2(r.dispelled).padStart(7) +
      String(r.lost).padStart(6) + r.bytesAvg.toFixed(0).padStart(7) + String(r.bytesMax).padStart(7) + '   ' +
      (r.dHits ? `${sg(r.dHits.mu)} (${f2(r.dHits.z)})`.padEnd(17) + `${sg(r.dCoins.mu)} (${f2(r.dCoins.z)})`.padEnd(17) + `${r.dWin.d >= 0 ? '+' : ''}${(100 * r.dWin.d).toFixed(1)} (${f2(r.dWin.z)})` : '(null arm)'));
  }
}

// ---- (a) reliability ------------------------------------------------------------------------------------------
function reliability(rs, title) {
  const fs = fights(rs);
  console.log(`\n${title}: ${fs.length} fights from ${rs.length} games (resolved by a win or a hit: ${fs.filter((f) => f.why === 'dispelled' || f.why === 'hit').length})`);
  console.log('stratum (visible ghosts at start)'.padEnd(35) + BANDS.map((b) => b.padStart(16)).join(''));
  const strata = [1, 2, 3];
  const cell = (fl) => `${pc(winRate(fl)).trim()} (${fl.filter((f) => f.win).length}/${fl.length})`.padStart(16);
  for (const n of strata) {
    const fl = fs.filter((f) => f.n === n);
    console.log(`${n === 3 ? '3+' : String(n)} ghost${n === 1 ? ' ' : 's'} (${String(fl.length).padStart(4)} fights)`.padEnd(35) + BANDS.map((b) => cell(fl.filter((f) => f.band === b))).join(''));
  }
  console.log('all strata'.padEnd(35) + BANDS.map((b) => cell(fs.filter((f) => f.band === b))).join(''));
  // Gate: stratum-weighted high - low, over the strata where both sides have >= 15 fights.
  const hi = (f) => f.band === 'sure' || f.band === 'dominant';
  let wsum = 0, dsum = 0; const parts = [];
  for (const n of strata) {
    const fl = fs.filter((f) => f.n === n); const h = fl.filter(hi), l = fl.filter((f) => !hi(f));
    const nm = n === 3 ? '3+' : n;
    if (h.length >= 15 && l.length >= 15) {
      const d = winRate(h) - winRate(l);
      parts.push(`${nm} ghost: high ${pc(winRate(h)).trim()} (n ${h.length}) vs low ${pc(winRate(l)).trim()} (n ${l.length}) = ${(100 * d).toFixed(1)} pts`);
      wsum += fl.length; dsum += d * fl.length;
    } else parts.push(`${nm} ghost: skipped (high n ${h.length}, low n ${l.length}, need 15 each)`);
  }
  const gate = wsum ? 100 * dsum / wsum : NaN;
  for (const x of parts) console.log('  ' + x);
  console.log(`RELIABILITY GATE (stratum-weighted high minus low >= 15 points): ${Number.isNaN(gate) ? 'not computable' : gate.toFixed(1) + ' points'} -> ${gate >= 15 ? 'PASS' : 'FAIL'}`);
  return gate;
}

async function main() {
  const flags = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  const phase = flags.phase ?? 'all';
  const quick = flags.quick === 'true';
  const workers = Number(flags.workers ?? Math.max(1, cpus().length - 1));
  // Sizes (games per walk-in p): override with --dtrain --atrain --ctrain --dtest --atest --ctest.
  const n = (k, full, q) => Number(flags[k] ?? (quick ? q : full));
  const D_TRAIN = n('dtrain', 40, 4), A_TRAIN = n('atrain', 60, 6), C_TRAIN = n('ctrain', 60, 6);
  const D_TEST = n('dtest', 300, 6), A_TEST = n('atest', 400, 10), C_TEST = n('ctest', 300, 10);
  const games = (arm, dn, an, cn, off = 0) => {
    const jobs = [];
    for (const p of PS) {
      for (let s = 1; s <= dn; s++) jobs.push({ arm, kind: 'dungeon', seed: off + s, p });
      for (let s = 1; s <= an; s++) jobs.push({ arm, kind: 'arena', seed: off + s, p });
      for (let s = 1; s <= cn; s++) jobs.push({ arm, kind: 'crowd', seed: off + s, p });
    }
    return jobs;
  };
  const A = (name, confidence) => ({ name, confidence });
  const OFF = A('off', false);
  const DEF = A('weighted', true);
  const BETA = A('beta', { model: 'beta' });
  const W = (name, w) => A(name, { weights: w });
  const sweep = [
    W('hit-10', { hit: -10 }), W('hit-25', { hit: -25 }),
    W('struck9', { struck: 9 }),
    W('disp6', { dispelled: 6 }), W('disp18', { dispelled: 18 }),
    W('evaded0', { evaded: 0 }),
    W('pressed-4', { pressed: -4 }),
    W('calm0', { calm: 0 }),
    W('brake', { hit: -25, pressed: -4, dispelled: 6 }), W('free', { hit: -10, struck: 9, dispelled: 18 }),
  ];
  const result = { quick, workers, weights: WEIGHTS };
  const t0 = Date.now();
  const log = (m) => console.log(`${m} (${((Date.now() - t0) / 60000).toFixed(1)} min elapsed)`);

  if (phase === 'all' || phase === 'reliability') {
    // The big pool for the default weighted arm: the held-out range plus the train range.
    const jobs = [...games(DEF, D_TEST, A_TEST, C_TEST, 1000), ...games(DEF, D_TRAIN, A_TRAIN, C_TRAIN, 0)];
    const rs = await farm(jobs, workers, 'reliability');
    const gate = reliability(rs, 'RELIABILITY, arm weighted (default weights, toggle on)');
    result.reliability = { gate, fights: fights(rs).length, games: rs.length, rows: fights(rs) };
    log('reliability done');
  }
  let bestName = null;
  if (phase === 'all' || phase === 'sweep') {
    const arms = [OFF, DEF, BETA, ...sweep];
    const rs = await farm(arms.flatMap((a) => games(a, D_TRAIN, A_TRAIN, C_TRAIN, 0)), workers, 'sweep');
    const by = (n) => rs.filter((r) => r.arm === n);
    const base = by('off');
    const rows = arms.map((a) => armRow(a.name, by(a.name), base));
    printRows(`SWEEP on TRAIN seeds (dungeons 1..${D_TRAIN}, arenas 1..${A_TRAIN}, crowds 1..${C_TRAIN}, p 0 / 0.2 / 0.5; paired against off)`, rows);
    // Winner: fewest hits per game among the weighted sets whose coins are not below off's by more than 1 SE.
    const cand = rows.filter((r) => r.name !== 'off' && r.name !== 'beta' && r.dCoins.mu >= -r.dCoins.se);
    cand.sort((a, b) => a.hits - b.hits || (a.name === 'weighted' ? -1 : 1));
    bestName = cand[0].name;
    console.log(`\nSWEEP WINNER (fewest hits/game, coins not below off by more than 1 SE): ${bestName} (hits/game ${f2(cand[0].hits)}; default ${f2(rows.find((r) => r.name === 'weighted').hits)}; null ${f2(rows[0].hits)})`);
    result.sweep = rows;
    result.fitted = bestName;
    log('sweep done');
  }
  if (phase === 'all' || phase === 'compare') {
    const fittedName = bestName ?? flags.fitted ?? 'weighted';
    const fitted = fittedName === 'weighted' ? null : sweep.find((a) => a.name === fittedName);
    const arms = [OFF, DEF, ...(fitted ? [A(`fitted:${fitted.name}`, fitted.confidence)] : []), BETA];
    const rs = await farm(arms.flatMap((a) => games(a, D_TEST, A_TEST, C_TEST, 1000)), workers, 'compare');
    const by = (n) => rs.filter((r) => r.arm === n);
    const base = by('off');
    const rows = arms.map((a) => armRow(a.name, by(a.name), base));
    printRows(`COMPARE on HELD-OUT seeds (dungeons 1001..${1000 + D_TEST}, arenas 1001..${1000 + A_TEST}, crowds 1001..${1000 + C_TEST}, p 0 / 0.2 / 0.5)`, rows);
    for (const kind of ['dungeon', 'arena', 'crowd']) {
      printRows(`  ${kind} games only`, arms.map((a) => armRow(a.name, by(a.name).filter((r) => r.kind === kind), base.filter((r) => r.kind === kind))));
    }
    for (const p of PS) printRows(`  walk-in p = ${p} only`, arms.map((a) => armRow(a.name, by(a.name).filter((r) => r.p === p), base.filter((r) => r.p === p))));
    const verdicts = rows.filter((r) => r.name !== 'off').map((r) => {
      const hitsBeat = r.dHits.z <= -2.4, winBeat = r.dWin.z >= 2.4, coinsOk = r.dCoins.mu >= -2 * r.dCoins.se;
      return { arm: r.name, hitsBeat, winBeat, coinsOk, ship: (hitsBeat || winBeat) && coinsOk };
    });
    console.log('\nSHIP RULE per arm (beats off on hits z <= -2.4 or on win rate z >= 2.4, and coins diff >= -2 SE):');
    for (const v of verdicts) console.log(`  ${v.arm}: hits ${v.hitsBeat ? 'beats' : 'no'}, win ${v.winBeat ? 'beats' : 'no'}, coins ${v.coinsOk ? 'kept' : 'LOST'} -> ${v.ship ? 'SHIP' : 'no'}`);
    console.log(`SHIP: ${verdicts.some((v) => v.ship)}`);
    result.compare = rows; result.verdicts = verdicts; result.ship = verdicts.some((v) => v.ship);
    if (phase === 'compare') reliability(by('off'), 'RELIABILITY (null arm, passive C from the turn shape)');
    log('compare done');
  }
  if (flags.out) writeFileSync(flags.out, JSON.stringify(result));
  process.exit(0);
}

if (process.argv[2] === '--job') { // worker: play the jobs it is sent, answer with results
  process.on('message', async (job) => {
    if (job === 'exit') process.exit(0);
    process.send(await playGame(job));
  });
  process.send('ready');
} else await main();
