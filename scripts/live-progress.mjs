// LIVE A/B DRIVER FOR THE PHASE-4 RETREAT REDIRECT (explorerProgress). WITHOUT --dry THIS SCRIPT MAKES PAID JEV CALLS:
// IT STEPS REAL GAMES THROUGH THE HUB, ABOUT 1-2 REQUESTS PER STEP FOR THE EXPLORER PLUS GHOST REQUESTS. IT IS NOT A CHECK.
// Run it only on purpose. `--dry` is free: it plays scratch in-process Runs with stub answers (fetch is a tripwire).
//
// For every arm it starts hub instances (scripts/arenas.mjs, labelled pon / poff, same defaults except
// `--set explorerProgress=true|false`), plays every seed on them over plain HTTP (POST /api/new {seed}, then POST /api/step
// until `over` or the step cap), writes one jsonl line per step, and summarises per game and per arm (summary.json + a table).
// One game at a time per instance; arms and instances run in parallel (--concurrency instances per arm). The instances are
// brought `down` at the end and on SIGINT / SIGTERM / a crash.
//
//   node scripts/live-progress.mjs --seeds motivated --steps 250 --arms on,off --concurrency 5 --label run1   (PAID)
//   node scripts/live-progress.mjs --dry --seeds 1,2 --steps 40                                               (free)
//
//   --seeds a,b,c    integers, or `motivated` = the 5 seeds in /tmp/jev-motivated-observation/motivated{1..5}-initial.json
//   --steps N        step cap per game (default 250)
//   --arms on,off    which arms (on = explorerProgress true, off = false; default both)
//   --out <dir>      default runs/live-progress/<timestamp>/ (runs/ is git-ignored)
//   --concurrency N  instances per arm, so up to N games per arm at once (default 1, never more than the seed count)
//   --label <text>   a run label: recorded in summary.json, and prefixed to the instance names (<label>-pon1, ...)
//   --dry            no hub, no Jev: stub ask/decide in process, the same summariser
//
// jsonl line: { turn, game: view, memory: { exit_seen, approach } }. `game` is /api/step's game view; `tiles`, `decor` and
// `props` are static, so only the first line of a game keeps them. Jev requests are ESTIMATED from the turns: 1 per explorer
// tick with apiMs > 0 (+1 when a non-automatic mood was asked beside a move), +1 per ghost turn with apiMs > 0.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOTIVATED_DIR = '/tmp/jev-motivated-observation';
const DEEP = 10; // a backtracking episode counts once it is this many cells behind the furthest point
const ARMS = { on: { name: 'pon', progress: true }, off: { name: 'poff', progress: false } };

// ---------------------------------------------------------------- summariser (pure)

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

// Jev requests this turn (an estimate, see the header).
export function requestsOf(turn) {
  if (!turn) return 0;
  let n = turn.apiMs > 0 ? 1 : 0;
  if (n && turn.decision?.sentiment && !turn.decision.sentiment.automatic && turn.move_decision) n++;
  for (const a of turn.adversaryTurns ?? []) if (a.apiMs > 0) n++;
  return n;
}

// records: [{ turn, game, memory? }] in step order. Returns the per-game summary row.
export function summarise(records, { seed = null, arm = null, error = null, noRequests = false } = {}) {
  const last = records.at(-1);
  const g = last?.game ?? {};
  const row = { seed: seed ?? g.seed ?? null, arm, ticks: records.length, won: !!g.won, lost: !!g.lost };
  row.result = g.won ? 'won' : g.lost ? 'lost' : 'alive';
  row.steps = g.steps ?? 0;
  row.steps_to_win = g.won ? g.steps : null;

  let portalStep = null, maxProgress = null, finalProgress = null, cues = 0, cueOn = false;
  let furthest = 0, ep = null, episodes = 0, recovered = 0, recoveryTicks = 0;
  const cells = new Set();
  let dispels = 0, hits = 0, hearts = 0, requests = 0;
  records.forEach((rec, ticks) => {
    const game = rec.game ?? {}, turn = rec.turn ?? {}, route = game.route ?? null;
    if (game.pos) cells.add(game.pos.join(','));
    requests += requestsOf(turn);
    for (const e of turn.events ?? []) {
      if (e.type === 'dispelled') dispels++;
      else if (e.type === 'hit') hits++;
      else if (e.type === 'heart') hearts++;
    }
    if (portalStep == null && (rec.memory?.exit_seen || route?.suppressed === 'portal_known')) portalStep = game.steps ?? ticks + 1;
    if (!route) return;
    maxProgress = Math.max(maxProgress ?? 0, route.furthest ?? route.progress ?? 0);
    finalProgress = route.progress;
    if (route.cue && !cueOn) cues++;
    cueOn = !!route.cue;
    // Backtracking episodes with no objective (route.suppressed null: not combat, a detour, the portal in view or over),
    // the same bookkeeping as scripts/measure-progress.mjs.
    const free = route.suppressed == null;
    if (ep) {
      ep.min = Math.min(ep.min, route.distance);
      if (route.distance > ep.before) { if (ep.counted) { recovered++; recoveryTicks += ticks - ep.start; } ep = null; }
      else if (route.state !== 'backtracking' && route.state !== 'stationary' && route.distance >= furthest) ep = null;
    }
    if (!ep && route.state === 'backtracking' && free && furthest - route.distance >= 1) ep = { start: ticks, before: furthest, min: route.distance, counted: false };
    if (ep && !ep.counted && free && furthest - ep.min >= DEEP) { ep.counted = true; episodes++; }
    furthest = Math.max(furthest, route.distance);
  });
  row.portal_first_seen_step = portalStep;
  row.discovery_to_win = g.won && portalStep != null ? g.steps - portalStep : null;
  row.max_progress = r3(maxProgress);
  row.final_progress = r3(finalProgress);
  row.deep_backtracks = episodes;
  row.recovered = recovered;
  row.recovery_ticks_mean = recovered ? r1(recoveryTicks / recovered) : null;
  row.cues = cues;
  row.explored_pct = g.explored_pct ?? null;
  row.unique_cells = cells.size;
  row.dispels = dispels;
  row.hits = hits;
  row.hearts = hearts;
  row.coins = g.coins ?? 0;
  row.jev_requests_est = noRequests ? null : requests; // dry: the stub answers instantly, apiMs says nothing
  if (error) row.error = error;
  return row;
}

export function summariseArm(rows) {
  const done = rows.filter((r) => !r.error);
  const wins = rows.filter((r) => r.won);
  const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  return {
    games: rows.length, won: wins.length, lost: rows.filter((r) => r.lost).length, alive: rows.filter((r) => r.result === 'alive').length, errored: rows.length - done.length,
    steps_mean: r1(mean(rows.map((r) => r.steps))), steps_to_win_mean: r1(mean(wins.map((r) => r.steps_to_win))),
    portal_seen_mean: r1(mean(rows.map((r) => r.portal_first_seen_step).filter((x) => x != null))),
    discovery_to_win_mean: r1(mean(wins.map((r) => r.discovery_to_win).filter((x) => x != null))),
    max_progress_mean: r3(mean(rows.map((r) => r.max_progress).filter((x) => x != null))), final_progress_mean: r3(mean(rows.map((r) => r.final_progress).filter((x) => x != null))),
    deep_backtracks: sum('deep_backtracks'), recovered: sum('recovered'),
    recovery_ticks_mean: r1(mean(rows.filter((r) => r.recovered).map((r) => r.recovery_ticks_mean))),
    cues: sum('cues'), explored_pct_mean: r1(mean(rows.map((r) => r.explored_pct).filter((x) => x != null))), unique_cells_mean: r1(mean(rows.map((r) => r.unique_cells))),
    dispels: sum('dispels'), hits: sum('hits'), hearts: sum('hearts'), coins: sum('coins'), jev_requests_est: rows.some((r) => r.jev_requests_est != null) ? sum('jev_requests_est') : null,
  };
}

function table(rows, cols) {
  const cell = (v) => (v == null ? '-' : String(v));
  const w = cols.map(([h, k]) => Math.max(h.length, ...rows.map((r) => cell(r[k]).length)));
  const line = (vals) => vals.map((v, i) => v.padStart(w[i])).join('  ');
  return [line(cols.map(([h]) => h)), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map(([, k]) => cell(r[k]))))].join('\n');
}

export function printSummary(summary) {
  const gameCols = [['arm', 'arm'], ['seed', 'seed'], ['result', 'result'], ['steps', 'steps'], ['to_win', 'steps_to_win'], ['portal@', 'portal_first_seen_step'], ['disc>win', 'discovery_to_win'], ['maxprog', 'max_progress'], ['final', 'final_progress'],
    ['deepbt', 'deep_backtracks'], ['recov', 'recovered'], ['rec_t', 'recovery_ticks_mean'], ['cues', 'cues'], ['expl%', 'explored_pct'], ['cells', 'unique_cells'], ['disp', 'dispels'], ['hits', 'hits'], ['hrts', 'hearts'], ['coins', 'coins'], ['jev~', 'jev_requests_est']];
  console.log('\nPer game');
  console.log(table(summary.games, gameCols));
  const armCols = [['arm', 'arm'], ['games', 'games'], ['won', 'won'], ['lost', 'lost'], ['alive', 'alive'], ['err', 'errored'], ['steps', 'steps_mean'], ['to_win', 'steps_to_win_mean'], ['portal@', 'portal_seen_mean'], ['disc>win', 'discovery_to_win_mean'],
    ['maxprog', 'max_progress_mean'], ['final', 'final_progress_mean'], ['deepbt', 'deep_backtracks'], ['recov', 'recovered'], ['rec_t', 'recovery_ticks_mean'], ['cues', 'cues'], ['expl%', 'explored_pct_mean'], ['cells', 'unique_cells_mean'],
    ['disp', 'dispels'], ['hits', 'hits'], ['hrts', 'hearts'], ['coins', 'coins'], ['jev~', 'jev_requests_est']];
  console.log('\nPer arm (means over games; counts are totals)');
  console.log(table(Object.entries(summary.arms).map(([arm, a]) => ({ arm, ...a })), armCols));
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const o = { seeds: 'motivated', steps: 250, arms: 'on,off', out: null, concurrency: 1, label: '', dry: false };
  const need = (i, f) => (argv[i + 1] === undefined ? die(`${f} needs a value`) : argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (['--seeds', '--steps', '--arms', '--out', '--concurrency', '--label'].includes(a)) o[a.slice(2)] = need(i++, a);
    else die(`unknown argument "${a}"`);
  }
  o.steps = Number(o.steps); o.concurrency = Number(o.concurrency);
  if (!Number.isInteger(o.steps) || o.steps < 1) die('--steps must be a positive integer');
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) die('--concurrency must be a positive integer');
  o.arms = String(o.arms).split(',').map((s) => s.trim()).filter(Boolean);
  if (!o.arms.length || o.arms.some((a) => !ARMS[a])) die('--arms must be a list from: on, off');
  if (new Set(o.arms).size !== o.arms.length) die('--arms lists an arm twice');
  if (o.label && !/^[a-z][a-z0-9-]{0,14}$/.test(o.label)) die('--label must be lowercase letters, digits and dashes, starting with a letter (it prefixes the instance names)');
  o.seeds = parseSeeds(o.seeds);
  return o;
}

function die(msg) { console.error(`live-progress: ${msg}`); process.exit(1); }

function parseSeeds(text) {
  if (text === 'motivated') {
    const seeds = [];
    for (let i = 1; i <= 5; i++) {
      const f = join(MOTIVATED_DIR, `motivated${i}-initial.json`);
      if (!existsSync(f)) die(`--seeds motivated needs ${f}`);
      const seed = JSON.parse(readFileSync(f, 'utf8'))?.game?.seed;
      if (!Number.isInteger(seed)) die(`${f} holds no game.seed`);
      seeds.push(seed);
    }
    return seeds;
  }
  const seeds = text.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!seeds.length || seeds.some((s) => !Number.isInteger(s))) die('--seeds must be integers a,b,c or "motivated"');
  return seeds;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATIC_KEYS = ['tiles', 'decor', 'props']; // never change within a game: kept on the first line only

function lineOf(d, first) {
  const game = { ...d.game };
  if (!first) for (const k of STATIC_KEYS) delete game[k];
  return JSON.stringify({ turn: d.turn, game, memory: { exit_seen: !!d.memory?.landmarks?.some((l) => l.kind === 'exit'), approach: d.memory?.approach?.id ?? null } });
}

function recordOf(d) {
  return { turn: d.turn, game: d.game, memory: { exit_seen: !!d.memory?.landmarks?.some((l) => l.kind === 'exit') } };
}

// ---------------------------------------------------------------- live mode (hub, HTTP)

function arenas(args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'arenas.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`arenas.mjs ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

// One step with retries. Returns { d } or { over: true } (the server says the game is already over) or { error }.
async function stepOnce(base, log) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let r;
    try { r = await post(`${base}/api/step`); } catch (err) { r = { status: 0, data: { error: err.message } }; }
    if (r.status === 200) return { d: r.data };
    const msg = r.data?.error ?? `HTTP ${r.status}`;
    if (r.status === 409 && /already (won|lost)/.test(msg)) return { over: true };
    log(`step ${r.status}: ${msg} (attempt ${attempt}/4)`);
    if (attempt < 4) await sleep(r.status === 409 ? 500 : 2000 * attempt);
    else return { error: msg };
  }
}

async function playLive({ base, seed, arm, steps, file, log, stopping }) {
  const records = [];
  let error = null;
  const nw = await post(`${base}/api/new`, { seed });
  if (nw.status !== 200) return summarise([], { seed, arm, error: `new game: ${nw.data?.error ?? nw.status}` });
  let first = true;
  while (records.length < steps && !stopping()) {
    const r = await stepOnce(base, log);
    if (r.over) break;
    if (r.error) { error = r.error; break; }
    appendFileSync(file, lineOf(r.d, first) + '\n');
    first = false;
    records.push(recordOf(r.d));
    if (r.d.game?.over) break;
    if (records.length % 25 === 0) log(`seed ${seed} step ${r.d.game?.steps} pos ${r.d.game?.pos} explored ${r.d.game?.explored_pct}% progress ${r.d.game?.route?.progress ?? '-'}`);
  }
  if (stopping() && !error) error = 'interrupted';
  return summarise(records, { seed, arm, error });
}

async function runLive(o, outDir) {
  const label = o.label ? `${o.label}-` : '';
  const perArm = Math.min(o.concurrency, o.seeds.length);
  const groups = o.arms.flatMap((a) => ['--arena', String(perArm), '--label', `${label}${ARMS[a].name}`, '--set', `explorerProgress=${ARMS[a].progress}`]);
  let upped = [];
  let stopRequested = false;
  const down = () => {
    if (!upped.length) return;
    const names = upped; upped = [];
    try { arenas(['down', ...names]); console.log(`Stopped ${names.join(', ')}`); } catch (err) { console.error(`COULD NOT STOP ${names.join(' ')}: ${err.message}\nRun: node scripts/arenas.mjs down ${names.join(' ')}`); }
  };
  const onSignal = (sig) => { if (stopRequested) return; stopRequested = true; console.error(`\n${sig}: finishing the step in flight, then stopping the instances`); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const rows = [];
  try {
    console.log(arenas(['up', ...groups]).split('\n')[0]);
    const names = o.arms.flatMap((a) => Array.from({ length: perArm }, (_, i) => `arena/${label}${ARMS[a].name}${i + 1}`));
    upped = names;
    const hubFile = join(ROOT, 'runs', 'hub.json');
    const hub = `http://localhost:${JSON.parse(readFileSync(hubFile, 'utf8')).port}`;
    const armWork = o.arms.map(async (a) => {
      const queue = [...o.seeds];
      const workers = Array.from({ length: perArm }, async (_, i) => {
        const name = `${label}${ARMS[a].name}${i + 1}`;
        const base = `${hub}/arena/${name}`;
        const log = (m) => console.log(`[${name}] ${m}`);
        while (queue.length && !stopRequested) {
          const seed = queue.shift();
          log(`seed ${seed}: start`);
          const row = await playLive({ base, seed, arm: a, steps: o.steps, file: join(outDir, `${a}-${seed}.jsonl`), log, stopping: () => stopRequested });
          log(`seed ${seed}: ${row.result} after ${row.steps} steps${row.error ? ` (${row.error})` : ''}`);
          rows.push(row);
        }
      });
      await Promise.all(workers);
    });
    await Promise.all(armWork);
  } finally {
    down();
  }
  return { rows, interrupted: stopRequested };
}

// ---------------------------------------------------------------- dry mode (in process, free)

async function runDry(o, outDir) {
  process.env.JEV_CONFIG = 'none';
  globalThis.fetch = () => { throw new Error('network call in --dry mode'); }; // the tripwire
  const { DIRS, rng } = await import('../src/dungeon.js');
  const { newGame } = await import('../src/turn.js');

  const towardEntrance = (game, ids) => {
    const { tiles, start } = game.dungeon;
    const dist = new Map([[start.join(), 0]]);
    const q = [start];
    for (let i = 0; i < q.length; i++) for (const d of Object.values(DIRS)) {
      const c = [q[i][0] + d[0], q[i][1] + d[1]];
      const t = tiles[c[1]]?.[c[0]];
      if (t === undefined || t === '#' || dist.has(c.join())) continue;
      dist.set(c.join(), dist.get(q[i].join()) + 1);
      q.push(c);
    }
    let best = null;
    for (const id of ids) {
      if (!DIRS[id]) continue;
      const d = dist.get([game.pos[0] + DIRS[id][0], game.pos[1] + DIRS[id][1]].join());
      if (d !== undefined && (!best || d < best.d)) best = { id, d };
    }
    return best?.id;
  };

  const rows = [];
  for (const a of o.arms) for (const seed of o.seeds) {
    const folder = mkdtempSync(join(tmpdir(), 'jev-live-progress-dry-'));
    const dir = pathToFileURL(folder + '/');
    let run;
    // Stub answers: follow the approach target, but in 20-tick bursts every 80 walk toward the entrance (a model losing its bearings).
    const ask = async ({ state, questions }) => Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : 0.9 }];
      const ids = Object.keys(q.criteria);
      let choice = ids[0];
      if (key === 'sentiment') choice = ids.includes('steady') ? 'steady' : ids[0];
      else if (key === 'skill') choice = ids.includes('none') ? 'none' : ids[0];
      else if (key === 'next_approach') choice = ids.includes(state.plan?.approach?.current) ? state.plan.approach.current : ids[0];
      else if (key === 'next_move' || key.startsWith('move_if_')) {
        const drifting = run.game.steps % 80 >= 30 && run.game.steps % 80 < 50;
        choice = (drifting && towardEntrance(run.game, ids)) || ids.find((id) => /Closer to the (?:target|portal)|Steps onto the portal/.test(String(q.criteria[id]))) || ids.find((id) => id !== 'stay') || ids[0];
      }
      return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
    }));
    const realRandom = Math.random;
    Math.random = rng(seed * 7919 + 1);
    const records = [];
    let error = null;
    try {
      run = newGame(seed, { ask, decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true }, progress: ARMS[a].progress });
      run.game.adversaries = []; // stub ghost decisions would only add noise
      const file = join(outDir, `${a}-${seed}.jsonl`);
      while (records.length < o.steps && !run.game.won && !run.game.lost) {
        const turn = await run.playTurn();
        const d = { game: run.view(), memory: run.memory, directive: run.directive, turn };
        appendFileSync(file, lineOf(d, records.length === 0) + '\n');
        records.push(recordOf(JSON.parse(JSON.stringify(d))));
      }
    } catch (err) {
      error = err.message;
    } finally {
      Math.random = realRandom;
      rmSync(folder, { recursive: true, force: true });
    }
    const row = summarise(records, { seed, arm: a, error, noRequests: true });
    console.log(`[dry ${a}] seed ${seed}: ${row.result} after ${row.steps} steps${error ? ` (${error})` : ''}`);
    rows.push(row);
  }
  return { rows, interrupted: false };
}

// ---------------------------------------------------------------- main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const outDir = resolve(o.out ?? join(ROOT, 'runs', 'live-progress', stamp()));
  mkdirSync(outDir, { recursive: true });
  if (o.dry) console.log('DRY RUN: in-process stub answers, no hub, no Jev.');
  else {
    const games = o.seeds.length * o.arms.length;
    console.log(`PAID RUN: ${games} games x up to ${o.steps} steps = up to ${games * o.steps} steps; expect ~${games * o.steps}-${games * o.steps * 2} explorer Jev calls plus ghost calls.`);
  }
  console.log(`seeds ${o.seeds.join(',')}  arms ${o.arms.join(',')}  out ${outDir}`);
  const { rows, interrupted } = o.dry ? await runDry(o, outDir) : await runLive(o, outDir);
  rows.sort((x, y) => o.arms.indexOf(x.arm) - o.arms.indexOf(y.arm) || o.seeds.indexOf(x.seed) - o.seeds.indexOf(y.seed));
  const summary = {
    label: o.label || null, dry: o.dry, interrupted, steps_cap: o.steps, seeds: o.seeds, arms: Object.fromEntries(o.arms.map((a) => [a, summariseArm(rows.filter((r) => r.arm === a))])),
    games: rows,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  printSummary(summary);
  console.log(`\nWrote ${join(outDir, 'summary.json')}`);
  if (interrupted) process.exitCode = 130;
}
