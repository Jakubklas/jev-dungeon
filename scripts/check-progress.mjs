// Known-path progress and retreat redirect (DUNGEON_DIRECTION_PLAN section 4, fog-safe form), end to end through the
// real ExplorerBrain on testbed ASCII corridors. All Jev calls are stubs; any network call fails the check.
// Run: JEV_CONFIG=none node scripts/check-progress.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { rng, DIRS } from '../src/dungeon.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { approachTarget } from '../src/characters/explorer/perception.js';
import * as P from '../src/characters/explorer/progress.js';

const root = mkdtempSync(join(tmpdir(), 'jev-progress-check-'));
let n = 0;
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } };

// A one-row corridor x 1..len with optional vertical shafts (x -> depth) hanging off it, start at x=1.
function corridor({ len, shafts = {}, extra = {} }) {
  const H = 18;
  const rows = Array.from({ length: H }, () => Array(len + 2).fill('#'));
  for (let x = 1; x <= len; x++) rows[1][x] = '.';
  for (const [sx, depth] of Object.entries(shafts)) for (let y = 2; y <= depth; y++) rows[y][Number(sx)] = '.';
  rows[1][1] = '@';
  for (const [k, ch] of Object.entries(extra)) { const [x, y] = k.split(',').map(Number); rows[y][x] = ch; }
  return rows.map((r) => r.join(''));
}

// choose(kind, key, ids, q, state) -> id. Defaults: steady mood, no skill, high approach_working, keep the approach.
function build(config, { move = 'target', tactic = 'run_away', coins = null } = {}) {
  const folder = join(root, String(++n));
  mkdirSync(folder);
  const dir = pathToFileURL(folder + '/');
  const log = [];
  const ctl = { move, tactic, coins };
  const ask = async ({ state, questions }) => {
    log.push(JSON.stringify(questions));
    return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : 0.9 }];
      const ids = Object.keys(q.criteria);
      let choice = ids[0];
      if (key === 'sentiment') choice = ids.includes('steady') ? 'steady' : ids[0];
      else if (key === 'tactic') choice = ids.includes(ctl.tactic) ? ctl.tactic : ids[0];
      else if (key === 'skill') choice = ids.includes('none') ? 'none' : ids[0];
      else if (key === 'next_approach') choice = ctl.coins && ids.includes(ctl.coins) ? ctl.coins : (ids.includes(state.plan?.approach?.current) ? state.plan.approach.current : ids[0]);
      else if (key === 'next_move' || key.startsWith('move_if_')) {
        if (ctl.move === 'entrance') choice = ids.includes('left') ? 'left' : ids[0];
        else if (ctl.move === 'back') choice = stepBack(ctl.run, ids);
        else choice = ids.find((id) => /Closer to the (?:target|portal)/.test(String(q.criteria[id]))) ?? ids.find((id) => id !== 'stay') ?? ids[0];
      }
      return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
    }));
  };
  const run = newTestGame(config, { ask, decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true } });
  ctl.run = run;
  return { run, log, ctl };
}
// Test-side ground truth (the check may read the map; the brain may not): the legal move that most reduces the walking distance to the start.
function stepBack(run, ids) {
  const tiles = run.game.dungeon.tiles;
  const start = run.game.dungeon.start;
  const dist = new Map([[start.join(), 0]]);
  const q = [start];
  for (let i = 0; i < q.length; i++) for (const d of Object.values(DIRS)) {
    const c = [q[i][0] + d[0], q[i][1] + d[1]];
    if (tiles[c[1]]?.[c[0]] === '#' || tiles[c[1]]?.[c[0]] === undefined || dist.has(c.join())) continue;
    dist.set(c.join(), dist.get(q[i].join()) + 1);
    q.push(c);
  }
  const here = run.game.pos;
  let best = null;
  for (const id of ids) {
    if (!DIRS[id]) continue;
    const d = dist.get([here[0] + DIRS[id][0], here[1] + DIRS[id][1]].join());
    if (d !== undefined && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? ids[0];
}
const walk = (run, dir, k) => { for (let i = 0; i < k; i++) run.game.applyMove(dir); };
const x = (run) => run.game.pos[0];
const y = (run) => run.game.pos[1];

try {
  // 0. progress.js is pure and its window rules are what the brain relies on.
  {
    const src = readFileSync(new URL('../src/characters/explorer/progress.js', import.meta.url), 'utf8');
    ok(!/^\s*import\b/m.test(src), 'progress.js imports nothing');
    const feed = (ds, rev = true) => { const s = []; for (const d of ds) P.pushSample(s, { d, revisit: rev }); return s; };
    ok(!P.isRetreat(feed([30, 29, 28, 27, 26, 25, 24, 23])), 'a window shorter than RETREAT_WINDOW + 1 samples never fires');
    ok(P.isRetreat(feed([30, 29, 28, 27, 26, 25, 24, 23, 22])), 'a steady 8-cell walk back over visited ground fires');
    ok(!P.isRetreat(feed([30, 29, 28, 27, 26, 25, 24, 23, 22], false)), 'the same drop over new ground is not a retreat');
    ok(!P.isRetreat(feed([30, 29, 28, 29, 30, 29, 28, 29, 28])), 'a net drop under RETREAT_CELLS is not a retreat');
    ok(P.isRetreat(feed([30, 30, 30, 29, 28, 27, 26, 25, 24])), 'a drop of exactly RETREAT_CELLS fires');
    ok(!P.isRetreat(feed([30, 30, 30, 30, 30, 30, 30, 30, 30])), 'standing still never fires');
    const fe = P.forwardEdge([{ cell: [1, 0] }, { cell: [2, 0] }, { cell: [3, 0] }], (c) => ({ 1: 10, 2: 26, 3: undefined })[c[0]]);
    ok(fe.length === 1 && fe[0].cell[0] === 2, 'forwardEdge keeps only frontiers within FORWARD_SLACK of the deepest frontier (unknown distance is out)');
    ok(P.closingOnGoal([{ g: 9 }, { g: 8 }]) && !P.closingOnGoal([{ g: 8 }, { g: 9 }]) && !P.closingOnGoal([{ g: 9 }, {}]), 'closingOnGoal');
  }

  // (a) midway, explored behind, a nearer-looking edge behind (the shaft at x=9), unexplored ahead; Jev keeps choosing the way to the entrance.
  {
    const cfg = { map: corridor({ len: 50, shafts: { 9: 16 } }), numAdversaries: 0, treasure: null };
    const { run, log, ctl } = build(cfg, { move: 'entrance' });
    walk(run, 'right', 23);
    const world = new KnownWorld(run.game);
    ok(approachTarget(world, 'nearest_frontier').cell[0] > 24, '(a) precondition: ahead is nearest from the far end');
    let fired = null;
    for (let t = 1; t <= 14 && !fired; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.progress.retreats) fired = { t, ...run.explorer.progress, pos: [...run.game.pos] };
    }
    ok(fired, '(a) a retreat fired');
    if (fired) {
      ok(fired.t <= P.RETREAT_WINDOW + 2, `(a) fired within the window (tick ${fired.t})`);
      ok(fired.furthestEntry >= 23, '(a) furthestEntry tracked');
      ok(fired.forward && fired.forward[0] >= 30 && !fired.backtrack, `(a) redirect goal is a forward frontier ahead (${fired.forward})`);
      ok(approachTarget(new KnownWorld(run.game), 'nearest_frontier').cell[0] === 9, '(a) precondition: the plain nearest edge from here is the shaft behind');
      const last = JSON.parse(log.at(-1));
      ok(/Closer to the target/.test(last.next_move?.criteria?.right ?? ''), '(a) the request on the firing tick already points right');
      ok(!/Closer to the target/.test(last.next_move?.criteria?.left ?? ''), '(a) and not left');
      ok(run.explorer.progress.forward[0] > fired.pos[0], '(a) goal lies ahead of the explorer');
    }
    ctl.move = 'target';
    const x0 = x(run);
    for (let t = 0; t < 22; t++) await run.explorer.takeTurn();
    ok(x(run) > x0 + 15 && x(run) > 30, `(a) following the target afterwards makes forward progress (x ${x0} -> ${x(run)})`);
    ok(run.explorer.progress.retreats === 1, '(a) fired once');
  }

  // (b) a coin pile 8 steps behind: the detour is allowed, then exploration resumes forward.
  {
    const cfg = { map: corridor({ len: 50 }), numAdversaries: 0, treasure: null };
    const dropCoin = (r) => { r.game.coinPiles = [...r.game.coinPiles, [r.game.pos[0] - 8, 1]]; }; // dropped after the walk: lit, 8 steps behind
    const { run, ctl } = build(cfg, { move: 'target', coins: 'collect_coins' });
    walk(run, 'right', 25);
    dropCoin(run);
    let sawCollect = false, picked = false, firedWhile = false;
    for (let t = 0; t < 40 && !picked; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.memory.approach.id === 'collect_coins') sawCollect = true;
      if (sawCollect && run.explorer.memory.approach.id === 'collect_coins' && run.explorer.progress.retreats) firedWhile = true;
      picked = run.game.coins >= 1;
    }
    ok(sawCollect && picked, '(b) the coin detour ran and the coin was taken');
    ok(!firedWhile && run.explorer.progress.retreats === 0, '(b) no redirect while collecting');
    ok(x(run) <= 19, `(b) the detour really went back (x ${x(run)})`);
    for (let t = 0; t < 30; t++) await run.explorer.takeTurn();
    ok(x(run) > 30 && run.explorer.progress.retreats === 0, `(b) after the pickup exploration resumes forward (x ${x(run)}, retreats ${run.explorer.progress.retreats})`);
    // ... and if Jev then keeps walking toward the entrance, that IS a retreat, detected from fresh samples (the detour itself is not counted).
    const { run: r2, ctl: c2 } = build(cfg, { move: 'target', coins: 'collect_coins' });
    walk(r2, 'right', 25);
    dropCoin(r2);
    for (let t = 0; t < 40 && r2.game.coins < 1; t++) await r2.explorer.takeTurn();
    c2.move = 'entrance';
    let after = 0;
    while (!r2.explorer.progress.retreats && after < 14) { await r2.explorer.takeTurn(); after++; }
    ok(r2.explorer.progress.retreats === 1 && after >= P.RETREAT_WINDOW, `(b) walking back after the pickup is flagged only after a fresh window (${after} ticks)`);
  }

  // (c) heart run behind while hurt: never redirected, even when Jev walks that way.
  {
    const cfg = { map: corridor({ len: 50 }), numAdversaries: 0, treasure: null, hearts: [[6, 1]] };
    const { run } = build(cfg, { move: 'entrance' });
    walk(run, 'right', 25);
    run.game.health = run.game.maxHealth / 2;
    let heal = 0;
    for (let t = 0; t < 40 && run.game.heartPiles.length; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.memory.approach.id === 'heal') heal++;
    }
    ok(heal >= 10 && !run.game.heartPiles.length, `(c) the heart run happened (${heal} heal ticks, hearts left ${run.game.heartPiles.length})`);
    ok(run.explorer.progress.retreats === 0, '(c) the heart run was never redirected');
  }

  // (d) adversary in sight / tactic on, and a young sighting afterwards: never redirected.
  {
    const cfg = { map: corridor({ len: 50, extra: { '30,1': 'A' } }), treasure: null, ghostSkills: 'none' };
    const { run } = build(cfg, { move: 'entrance', tactic: 'run_away' });
    walk(run, 'right', 23);
    let tactic = 0, inSight = 0;
    for (let t = 0; t < 14; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.memory.approach.id === 'run_away') tactic++;
      if (run.game.adversaries.length) inSight++;
    }
    ok(tactic >= 3 && inSight > 0, `(d) a tactic was on (${tactic} ticks)`);
    ok(run.explorer.progress.retreats === 0, '(d) no redirect with an adversary in sight / a tactic on / a young sighting');
  }
  // (d2) a player directive.
  {
    const cfg = { map: corridor({ len: 50 }), numAdversaries: 0, treasure: null };
    const { run } = build(cfg, { move: 'entrance' });
    walk(run, 'right', 23);
    run.explorer.setDirective('go back toward the start', { steps: 40 });
    for (let t = 0; t < 14; t++) await run.explorer.takeTurn();
    ok(run.explorer.directive, '(d2) the directive was live throughout');
    ok(run.explorer.progress.retreats === 0, '(d2) a live player directive is never redirected');
  }

  // (e) everything ahead is explored, the only edge is behind: fall back to it, once, no oscillation.
  {
    const cfg = { map: corridor({ len: 30, shafts: { 10: 16 } }), numAdversaries: 0, treasure: null };
    const { run, ctl } = build(cfg, { move: 'entrance' });
    walk(run, 'right', 29);
    let fired = null;
    for (let t = 1; t <= 14 && !fired; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.progress.retreats) fired = { ...run.explorer.progress };
    }
    ok(fired && fired.forward && fired.forward[0] === 10 && fired.forward[1] > 1, `(e) fell back to the shaft edge (${fired?.forward})`);
    ctl.move = 'target';
    const dirs = [];
    let prev = null;
    for (let t = 0; t < 70 && !(x(run) === 10 && y(run) > 5); t++) {
      const before = [...run.game.pos];
      await run.explorer.takeTurn();
      if (run.game.pos[0] !== before[0] || run.game.pos[1] !== before[1]) { const d = [run.game.pos[0] - before[0], run.game.pos[1] - before[1]].join(); if (prev && d === prev.split(',').map((v) => -v).join()) dirs.push(t); prev = d; }
    }
    ok(run.explorer.progress.retreats === 1, `(e) fired exactly once (${run.explorer.progress.retreats})`);
    ok(x(run) === 10 && y(run) > 5, `(e) the back-track reached the shaft (${run.game.pos})`);
    ok(dirs.length <= 2, `(e) no oscillation (${dirs.length} reversals)`);
  }
  // (e2) the cooldown: even a persistent walk to the entrance with a forward edge available fires at most once per RETREAT_COOLDOWN steps.
  {
    const cfg = { map: corridor({ len: 50 }), numAdversaries: 0, treasure: null };
    const { run } = build(cfg, { move: 'entrance' });
    walk(run, 'right', 40);
    const stamps = [];
    let seen = 0;
    for (let t = 0; t < 45; t++) {
      await run.explorer.takeTurn();
      if (run.explorer.progress.retreats > seen) { seen = run.explorer.progress.retreats; stamps.push(run.game.steps); }
    }
    ok(stamps.length >= 1, '(e2) fired');
    ok(stamps.every((s, i) => i === 0 || s - stamps[i - 1] >= P.RETREAT_COOLDOWN), `(e2) firings respect the cooldown (${stamps})`);
  }

  // (g) a deep dead-end side room must not inflate "forward": the main edge (not the pocket near the entry) is the redirect goal, and retreats stay detectable.
  {
    // main corridor to x=50; the side room hangs off x=12: down to y=16, then 18 cells east (explored end to end, deeper by
    // known path than the main edge); an unexplored pocket (shaft at x=4) near the entry.
    const rows = corridor({ len: 50, shafts: { 4: 16, 12: 16 } }).map((r) => r.split(''));
    for (let xx = 12; xx <= 30; xx++) rows[16][xx] = '.';
    const cfg = { map: rows.map((r) => r.join('')), numAdversaries: 0, treasure: null };
    const { run, ctl } = build(cfg, { move: 'back' });
    walk(run, 'right', 20); walk(run, 'left', 9); walk(run, 'down', 15); walk(run, 'right', 18);
    const fires = [];
    let seen = 0;
    for (let t = 1; t <= 48; t++) {
      await run.explorer.takeTurn();
      const pr = run.explorer.progress;
      if (pr.retreats > seen) { seen = pr.retreats; fires.push({ t, forward: pr.forward, backtrack: pr.backtrack, pos: [...run.game.pos] }); }
    }
    ok(fires.length >= 1, '(g) a retreat fired on the way out of the side room');
    const f = fires[0];
    ok(f && f.forward && f.forward[1] === 1 && f.forward[0] >= 20 && !f.backtrack, `(g) the goal is the main-corridor edge, not the pocket by the entry (${f && JSON.stringify(f)})`);
    ok(fires.length >= 2, `(g) later retreats are still detected (${fires.length} firings)`);
  }

  // (f) fog twin: same lit region, different hidden map (walls, shafts, portal elsewhere). Requests and redirect decisions are byte-identical.
  {
    const A = { map: corridor({ len: 50, shafts: { 9: 16 }, extra: { '49,1': 'T' } }), numAdversaries: 0 };
    const B = { map: corridor({ len: 46, shafts: { 9: 16, 41: 12, 44: 9 }, extra: { '45,1': 'T' } }), numAdversaries: 0 };
    const out = [];
    for (const cfg of [A, B]) {
      const { run, log, ctl } = build(cfg, { move: 'entrance' });
      const realRandom = Math.random;
      Math.random = rng(4242);
      try {
        walk(run, 'right', 23);
        const trace = [];
        for (let t = 0; t < 14; t++) { await run.explorer.takeTurn(); trace.push(JSON.stringify([run.game.pos, run.explorer.progress])); }
        ctl.move = 'target';
        for (let t = 0; t < 14; t++) { await run.explorer.takeTurn(); trace.push(JSON.stringify([run.game.pos, run.explorer.progress])); }
        out.push({ log, trace, retreats: run.explorer.progress.retreats });
      } finally { Math.random = realRandom; }
    }
    ok(out[0].retreats >= 1, '(f) the twin scenario does redirect');
    ok(out[0].log.length === out[1].log.length && out[0].log.every((r, i) => r === out[1].log[i]), '(f) requests byte-identical across hidden-map twins');
    ok(out[0].trace.every((r, i) => r === out[1].trace[i]), '(f) positions and redirect decisions identical across hidden-map twins');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`check-progress: ${failures} failure(s)`); process.exit(1); }
console.log('check-progress: all ok');
