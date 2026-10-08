// Duel harness: plays a duel between the REAL ExplorerBrain and one or two hunting ghosts, end to end, in a small
// testbed arena (newTestGame), with a scripted Jev and a scripted claw-happy ghost. No network, no Jev: a throwing
// fetch tripwire is installed when this module loads, every call is a stub, and Math.random is replaced by a seeded
// function for the length of a duel (the option shuffle in jev.js uses it), so a duel is reproducible.
// Used by scripts/check-duels.mjs; later scripts (confidence C0, PLAN-motivation P7c) import it. Keep it parametric.
//
//   import { playDuel, PLACEMENTS } from './lib/duel-harness.mjs';
//   const r = await playDuel({ ghosts: [[10, 3]], policy: 'follow', hold: true });
//
// playDuel(opts), every key optional:
//   room        'open' (15x7, explorer at [3,3]), 'corridor' (1 wide, 17x5, explorer mid-way), 'deadend' (1 wide, explorer at
//               its closed end). Default 'open'. Ghost cells are map coordinates (wall ring included, y down).
//   map         ASCII rows with '@' and 'A' cells instead of a room; `ghosts` then only sets per-ghost mode by index.
//   ghosts      [[x, y] | { cell: [x, y], offset?: [dx, dy], mode?: 'chase' | 'patrol' }]; 1, 2 or 3 (4 works too; the testbed cap is 8).
//               `offset` is added to `cell`, so a pair can be "N steps apart" from one base cell. Default: the room's cell.
//   ghostMode   'chase' (default: the ghost hunts from tick 0) or 'patrol'; a per-ghost `mode` wins.
//   kinds       the monsters' kind for the testbed ('ghost' default | 'troll' | 'mixed' | a list), see src/testbed.js.
//   ghostHp     hp per ghost (the ghostHp setting otherwise).
//   settings    overrides of the skill and ghost tunables for this duel: stunTicks, swordCooldown, swordDamage,
//               clawCooldown, clawDamage, shieldChance, coinDropChance, ghostHp, graceTicks (alias grace), speed, chaseRange.
//               Applied through configureSkills / configureAdversaries (as check-skills section 12 does), restored after.
//   hold        true (default) keeps the engage hold of PLAN-motivation P7a; false turns it off; 'multi' also holds against
//               2-3 ghosts (PLAN-confidence-mood phase 2). Passed to ExplorerBrain `hold` through newTestGame.
//   policy      the scripted Jev: 'follow' (sentiment `mood`, tactic engage when offered, the move whose fact says it is
//               the target, else stay when nothing is closer, else the first non-stay move; skill = first non-none key)
//               or 'walk-in' (same, but the move that closes the gap to the nearest ghost, whatever the facts say).
//               With no ghost in sight both wait (stay). Default 'follow'.
//   mood        the sentiment pick, default 'bold'.
//   confidence  { fixedMood: true } (default: C never changes the mood, PLAN-moods), an arm object ({ start: 80 } forces the history score) or 'caps' (PLAN-confidence-mood: C caps
//               the moods; implies hold 'multi'). Passed to ExplorerBrain `confidence` through newTestGame.
//   skills      'sword' (default: sword only, like check-skills section 12), 'default' (sword and shield), or a loadout list.
//   health      lives (default 9, so a claw never ends a duel early; hits are counted, not survived). Death at L lives =
//               hitsTaken >= L (the stub ghosts ignore lives, so a run is identical up to the L-th hit); health 2 plays
//               the real thing (r.lost), used by the spot check. maxHealth = health, so lives 2, 3, 4 are real settings.
//   seed        seeds the arena AND the duel's own PRNG (default 1).
//   maxTicks    default 60.
//   onAsk(req)  called with every request the scripted Jev gets ({ kind, state, questions, body }), for text assertions.
//   onTurn(turn, game)  called with every turn the brain returns (the turn shape), after the adversaries moved.
// Returns { strikes, claws, dispelled, ticks, hitsTaken, held, trace, ... }:
//   strikes   the explorer's strikes (sword uses)        claws     ghost claw strikes aimed at the explorer's cell
//   dispelled ghosts dispelled                           hitsTaken lives lost (a claw inside the grace window is `protected`: a claw, no hit)
//   ticks     ticks played                               held      ticks the brain held (turn.held)
//   trace     one entry per tick: { tick, pos, ghosts: [{ id, pos, hp, mode }], dir, held, skill, claws, strikes, events }
//   plus start ({ pos, ghosts } before tick 1), won, lost, wonBy, clawsBetween (claws between the 1st and 2nd strike), clawsBeforeStrike (before the 1st),
//   firstAdjacentTick / firstStrikeTick (1-based tick numbers, or null), askedMove (ticks that sent a move question).
globalThis.fetch = () => { throw new Error('network call in a duel script'); };

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRS } from '../../src/dungeon.js';
import { newTestGame } from '../../src/turn.js';
import { ADVERSARY_SPEED, CHASE_RANGE, GRACE_TICKS, configureAdversaries } from '../../src/characters/adversary/adversary.js';
import { configureSkills, skillConfig } from '../../src/skills/config.js';

export const man = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

// The 24 placements of check-skills section 12: a ghost in rows 2-4 of the open room, x 6..13 (explorer at [3,3]).
export const PLACEMENTS = [];
for (const row of [2, 3, 4]) for (let x = 6; x <= 13; x++) PLACEMENTS.push([x, row]);

const ROOMS = {
  open: { rows: ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############'], ghost: [10, 3] },
  corridor: { rows: ['#################', '#################', '#.....@.........#', '#################', '#################'], ghost: [12, 2] },
  deadend: { rows: ['#################', '#################', '#@..............#', '#################', '#################'], ghost: [8, 2] },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A room's rows with the ghosts' 'A' cells put in (ids a1, a2 follow reading order, as the testbed assigns them).
function buildMap(opts, ghosts) {
  const base = opts.map ?? ROOMS[opts.room ?? 'open']?.rows;
  if (!base) throw new Error(`unknown room ${opts.room}`);
  const rows = base.map((r) => r.split(''));
  if (!opts.map) {
    for (const g of ghosts) {
      const [x, y] = g.cell;
      if (rows[y]?.[x] !== '.') throw new Error(`ghost cell ${x},${y} is not floor in room ${opts.room ?? 'open'}`);
      rows[y][x] = 'A';
    }
  }
  return rows.map((r) => r.join(''));
}

const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

// The scripted Jev. It may look at the game (to find the nearest ghost for 'walk-in'); the brain never does.
function makeAsk(game, { policy, mood }) {
  return async ({ questions, state }) => {
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(keys.includes(mood) ? mood : keys[0]);
      else if (k === 'tactic') out[k] = answer(keys.includes('engage') ? 'engage' : keys[0]);
      else if (k === 'skill') out[k] = answer(keys.find((x) => x !== 'none') ?? 'none');
      else if (k === 'next_move' || k.startsWith('move_if_')) {
        const visible = state.threats?.visible?.length > 0;
        let pick = null;
        if (visible) {
          const moves = keys.filter((d) => d !== 'stay');
          if (policy === 'walk-in') {
            const near = game.adversaries.reduce((b, a) => (!b || man(a.pos, game.pos) < man(b.pos, game.pos) ? a : b), null);
            const nx = (d) => [game.pos[0] + DIRS[d][0], game.pos[1] + DIRS[d][1]];
            pick = near ? moves.filter((d) => man(nx(d), near.pos) >= 1).sort((a, b) => man(nx(a), near.pos) - man(nx(b), near.pos))[0] : null;
          } else {
            pick = moves.find((d) => /Reaches the target/.test(q.criteria[d])) ?? moves.find((d) => /Closer to the target/.test(q.criteria[d])) ?? null;
            if (!pick && keys.includes('stay')) pick = 'stay'; // nothing is closer: the target is here
            if (!pick) pick = moves[0];
          }
        }
        out[k] = answer(pick ?? (keys.includes('stay') ? 'stay' : keys[0]));
      } else out[k] = answer(keys[0]);
    }
    return out;
  };
}

// The ghosts' Jev: step toward the explorer, claw whenever offered (check-skills section 12).
async function decide({ state, questions }) {
  const out = {};
  if (questions.next_move) {
    const t = state.explorer.in_sight ? state.explorer.position : state.last_seen.cell;
    const opts = Object.keys(questions.next_move.criteria);
    const sc = (d) => Math.abs(state.self.position[0] + DIRS[d][0] - t[0]) + Math.abs(state.self.position[1] + DIRS[d][1] - t[1]);
    out.next_move = answer(opts.reduce((best, d) => (sc(d) < sc(best) ? d : best)));
  }
  if (questions.skill) out.skill = answer(Object.keys(questions.skill.criteria).find((x) => x !== 'none') ?? 'none');
  if (questions.search_approach) out.search_approach = { choice: 'sweep_last_seen', probabilities: {}, confidence: 1 };
  if (questions.keep_hunting) out.keep_hunting = { noul: 0.9 };
  return out;
}

export async function playDuel(opts = {}) {
  const seed = opts.seed ?? 1;
  const room = ROOMS[opts.room ?? 'open'];
  const ghosts = (opts.ghosts ?? [room?.ghost ?? [10, 3]]).map((g) => {
    const o = Array.isArray(g) ? { cell: g } : g;
    return { cell: o.offset ? [o.cell[0] + o.offset[0], o.cell[1] + o.offset[1]] : o.cell, mode: o.mode ?? opts.ghostMode ?? 'chase' };
  });
  const s = { ...(opts.settings ?? {}) };
  if (opts.ghostHp !== undefined) s.ghostHp = opts.ghostHp;
  const skillsBefore = skillConfig();
  const advBefore = { graceTicks: GRACE_TICKS, speed: ADVERSARY_SPEED, chaseRange: CHASE_RANGE };
  const dir = mkdtempSync(join(tmpdir(), 'jev-duel-'));
  const url = pathToFileURL(dir + '/');
  const rnd = Math.random;
  Math.random = mulberry32(seed ^ 0x9e3779b9);
  try {
    configureSkills({ ...skillsBefore, ...s });
    configureAdversaries({ graceTicks: s.graceTicks ?? s.grace ?? advBefore.graceTicks, speed: s.speed ?? advBefore.speed, chaseRange: s.chaseRange ?? advBefore.chaseRange });
    const skills = opts.skills ?? 'sword';
    const holder = {};
    const run = newTestGame(
      { map: buildMap(opts, ghosts), seed, explorerSkills: skills === 'sword' ? ['sword_strike'] : skills, ...(opts.kinds ? { kinds: opts.kinds } : {}) },
      { ask: (req) => { opts.onAsk?.(req); return holder.ask(req); }, decide, dir: url, memoryDir: url, hold: opts.hold ?? true, confidence: opts.confidence ?? { fixedMood: true } },
    );
    const game = run.game;
    holder.ask = makeAsk(game, { policy: opts.policy ?? 'follow', mood: opts.mood ?? 'bold' });
    game.adversaries.forEach((a, i) => { a.mode = ghosts[i]?.mode ?? 'chase'; });
    game.health = game.maxHealth = opts.health ?? 9;

    const r = {
      start: { pos: [...game.pos], ghosts: game.adversaries.map((a) => [...a.pos]) },
      strikes: 0, claws: 0, dispelled: 0, ticks: 0, hitsTaken: 0, held: 0, trace: [], won: false, lost: false, wonBy: null,
      clawsBetween: 0, clawsBeforeStrike: 0, firstAdjacentTick: null, firstStrikeTick: null, askedMove: 0,
    };
    let atFirst = 0;
    for (let t = 1; t <= (opts.maxTicks ?? 60) && !game.won && !game.lost; t++) {
      const turn = await run.playTurn();
      r.ticks = t;
      opts.onTurn?.(turn, game);
      const ev = turn.events;
      const mine = ev.filter((e) => e.type === 'strike' && e.id === 'explorer').length;
      const claws = ev.filter((e) => e.type === 'strike' && e.id !== 'explorer' && ['hit', 'blocked', 'protected'].includes(e.result)).length;
      r.strikes += mine;
      r.claws += claws;
      r.hitsTaken += ev.filter((e) => e.type === 'hit').length;
      r.dispelled += ev.filter((e) => e.type === 'dispelled').length;
      if (turn.held) r.held++;
      if (turn.move_decision) r.askedMove++;
      if (r.firstAdjacentTick === null && game.adversaries.some((a) => man(a.pos, game.pos) === 1)) r.firstAdjacentTick = t;
      if (mine && r.firstStrikeTick === null) { r.firstStrikeTick = t; r.clawsBeforeStrike = r.claws - claws; atFirst = r.claws; }
      if (mine && r.strikes === 2) r.clawsBetween = r.claws - atFirst - claws;
      r.trace.push({
        tick: t, pos: [...game.pos], ghosts: game.adversaries.map((a) => ({ id: a.id, pos: [...a.pos], hp: a.hp, mode: a.mode })),
        dir: turn.dir, held: !!turn.held, skill: turn.skill_decision?.used ?? null, claws, strikes: mine, events: ev.map((e) => e.type),
      });
    }
    r.won = game.won; r.lost = game.lost; r.wonBy = game.winBy ?? null;
    return r;
  } finally {
    Math.random = rnd;
    configureSkills(skillsBefore);
    configureAdversaries(advBefore);
    rmSync(dir, { recursive: true, force: true });
  }
}
export { decide as clawDecide, mulberry32 };

// Ghost layouts for 2 and 3 ghosts, shared by check-duels and measure-outnumbered (PLAN-confidence-mood table 3).
// Open room (explorer [3,3], floor x 1..13, y 1..5): the first ghost is one of PLACEMENTS; n is the offset N.
//   2 ghosts: the second is N cells further along the row (N 0 = the cell below, above for a ghost on row 4).
//   'pairfront' (3): the first two are N 0, the third N cells behind the first.   'line' (3): spaced N apart (N >= 1).
const OPEN_FLOOR = (c) => c[0] >= 1 && c[0] <= 13 && c[1] >= 1 && c[1] <= 5;
export function openGroups(count, n, kind = 'pairfront') {
  const out = [];
  for (const g of PLACEMENTS) {
    const below = [g[0], g[1] === 4 ? 3 : g[1] + 1];
    const group = count === 2 ? [g, n === 0 ? below : [g[0] + n, g[1]]]
      : count === 4 ? [g, below, [g[0] + n, g[1]], [g[0] + n, below[1]]] // two pairs, the second N behind the first
        : kind === 'line' ? [g, [g[0] + n, g[1]], [g[0] + 2 * n, g[1]]]
        : [g, below, [g[0] + n, g[1]]];
    const keys = new Set(group.map((c) => c.join(',')));
    if (group.every((c) => OPEN_FLOOR(c) && !(c[0] === 3 && c[1] === 3)) && keys.size === group.length) out.push(group);
  }
  return out;
}
// 1-wide corridor (explorer [6,2], floor x 1..15): the first ghost [10,2]. 2 ghosts: the second N behind. 3: 'line'
// (spaced N), 'pairfront' (a pair, then one N behind), 'pincers' (one ghost on each side of the explorer, a third N
// behind the east one).
export function corridorGroup(count, n, kind = 'line') {
  if (count === 2) return [[10, 2], [10 + n, 2]];
  if (count === 4) return [[10, 2], [11, 2], [11 + n, 2], [12 + n, 2]];
  if (kind === 'pairfront') return [[10, 2], [11, 2], [11 + n, 2]];
  if (kind === 'pincers') return [[10, 2], [2, 2], [10 + n, 2]];
  return [[10, 2], [10 + n, 2], [10 + 2 * n, 2]];
}
