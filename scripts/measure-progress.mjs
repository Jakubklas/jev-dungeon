// Measurement (not a check; prints a table, exits 0): the phase-4 retreat redirect against route ground truth.
// Plays the real ExplorerBrain through Run on generated LINEAR dungeons with stub Jev answers (no network, no ghosts),
// with the redirect on and off (the `progress` arm of ExplorerBrain / Run), and counts with the spectator route
// (src/route.js via run.view().route; imported by this SCRIPT's Run only, never by explorer code):
//   episodes   route 'backtracking' episodes at least DEEP cells back from the furthest point, with no objective
//              (approach not heal / collect_coins / a tactic / go_to_exit, no directive)
//   retreats   brain retreat firings (brain.progress.retreats)
//   recovery   ticks from an episode's start until route distance exceeds the furthest it had before it (mean over those that did)
// Policies: 'follow' = the move whose fact says it is the approach target; 'drift' = follows the target but, in bursts of
// 20 ticks every 80, walks toward the entrance (test-side BFS over the tiles: emulates Jev losing its bearings).
// Usage: node scripts/measure-progress.mjs [--seeds 20] [--ticks 300]
globalThis.fetch = () => { throw new Error('network call in a measurement script'); };
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRS, rng, generateDungeon, configureWorld } from '../src/dungeon.js';
import { Run, newGame } from '../src/turn.js';

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('seeds', 20), TICKS = arg('ticks', 300), DEEP = 10;
const OBJECTIVE = new Set(['heal', 'collect_coins', 'go_to_exit']);

function towardEntrance(game, ids) {
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
}

async function play(seed, policy, progress) {
  const folder = mkdtempSync(join(tmpdir(), 'jev-measure-progress-'));
  const dir = pathToFileURL(folder + '/');
  let run;
  const ask = async ({ state, questions }) => Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : 0.9 }];
    const ids = Object.keys(q.criteria);
    let choice = ids[0];
    if (key === 'sentiment') choice = ids.includes('steady') ? 'steady' : ids[0];
    else if (key === 'tactic') choice = ids[0];
    else if (key === 'skill') choice = ids.includes('none') ? 'none' : ids[0];
    else if (key === 'next_approach') choice = ids.includes(state.plan?.approach?.current) ? state.plan.approach.current : ids[0];
    else if (key === 'next_move' || key.startsWith('move_if_')) {
      const drifting = policy === 'drift' && run.game.steps % 80 >= 30 && run.game.steps % 80 < 50;
      choice = (drifting && towardEntrance(run.game, ids)) || ids.find((id) => /Closer to the (?:target|portal)|Steps onto the portal/.test(String(q.criteria[id]))) || ids.find((id) => id !== 'stay') || ids[0];
    }
    return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
  const realRandom = Math.random;
  Math.random = rng(seed * 7919 + 1);
  try {
    run = newGame(seed, { ask, decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true }, progress });
    run.game.adversaries = []; // no combat noise
    let episodes = 0, recovered = 0, recoveryTicks = 0;
    let ep = null;
    let furthest = 0, ticks = 0;
    for (; ticks < TICKS && !run.game.won && !run.game.lost; ticks++) {
      await run.playTurn();
      const r = run.view().route;
      if (!r) return null;
      const objective = OBJECTIVE.has(run.explorer.memory.approach.id) || run.explorer.directive;
      if (ep) {
        ep.min = Math.min(ep.min, r.distance);
        if (r.distance > ep.before) { recovered++; recoveryTicks += ticks - ep.start; ep = null; }
        else if (r.state !== 'backtracking' && r.state !== 'stationary' && r.distance >= furthest) ep = null;
      }
      if (!ep && r.state === 'backtracking' && !objective && furthest - r.distance >= 1) ep = { start: ticks, before: furthest, min: r.distance, counted: false };
      if (ep && !ep.counted && !objective && furthest - ep.min >= DEEP) { ep.counted = true; episodes++; }
      furthest = Math.max(furthest, r.distance);
    }
    return { episodes, recovered, recoveryTicks, retreats: run.explorer.progress.retreats, won: run.game.won, steps: run.game.steps, furthest: furthest / (run.view().route?.length || 1) };
  } finally {
    Math.random = realRandom;
    rmSync(folder, { recursive: true, force: true });
  }
}

configureWorld({ layout: 'linear' });
try {
  const rows = [];
  for (const policy of ['follow', 'drift']) {
    for (const progress of [false, true]) {
      const agg = { runs: 0, episodes: 0, recovered: 0, recoveryTicks: 0, retreats: 0, won: 0, steps: 0, furthest: 0 };
      for (let seed = 1; seed <= SEEDS; seed++) {
        if (generateDungeon(seed).layout?.kind !== 'linear') continue;
        const r = await play(seed, policy, progress);
        if (!r) continue;
        agg.runs++;
        for (const k of ['episodes', 'recovered', 'recoveryTicks', 'retreats', 'steps', 'furthest']) agg[k] += r[k];
        agg.won += r.won ? 1 : 0;
      }
      rows.push({ policy, redirect: progress ? 'on' : 'off', runs: agg.runs, 'deep backtracks': agg.episodes, 'recovered': agg.recovered, 'mean recovery ticks': agg.recovered ? +(agg.recoveryTicks / agg.recovered).toFixed(1) : '-', 'brain retreats': agg.retreats, won: agg.won, 'mean steps': +(agg.steps / Math.max(1, agg.runs)).toFixed(0), 'mean furthest': +(agg.furthest / Math.max(1, agg.runs)).toFixed(2) });
    }
  }
  console.table(rows);
} finally {
  configureWorld({ layout: 'maze' });
}
