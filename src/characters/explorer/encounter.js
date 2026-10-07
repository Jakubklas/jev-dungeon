// The encounter model: what the explorer can work out about visible adversaries from known
// cells alone. Gap-limited BFS ("safe distances"), route survey (closest approach per goal
// type), hiding cells (line of sight over known tiles, unknown blocks), slip/escape/engage
// targets, dead ends, and the sentiment-free `threats.encounter` facts (who and where is in
// `threats.visible`). Tactic feasibility
// and options stay in perception.js because they need approachTarget, which needs this model.
// FOG OF WAR as in known-map.js: known floor and adversaries the explorer sees now, nothing else.

import { ADVERSARY_SPEED } from '../adversary/adversary.js';
import { compass, compass8, euclid, isFrontier, key, knownDistances, knownFloor, neighbours, pick, plural, sameCell, step } from './known-map.js';

const MAX_GAP = 6; // the route survey looks for closest approaches up to this many steps
const HIDE_MAX_STEPS = 10; // a hiding cell farther than this is not "ducking"
const AREA_CAP = 600; // flood-fill cap for the open area around the explorer

// Most steps an adversary can have taken by the time the explorer has taken `i` (rounded up: conservative).
const advSteps = (i) => Math.ceil(i * ADVERSARY_SPEED - 1e-9);

// "1 step for every 2 of yours", from ADVERSARY_SPEED (so it follows the constant).
export function speedPhrase() {
  for (let q = 1; q <= 8; q++) {
    const p = Math.round(ADVERSARY_SPEED * q);
    if (p > 0 && Math.abs(p / q - ADVERSARY_SPEED) < 0.02) {
      return p === 1 && q === 1 ? 'as fast as the explorer' : `${p === 1 ? '1 step' : `about ${p} steps`} for every ${q} of the explorer's`;
    }
  }
  return `${Math.round(ADVERSARY_SPEED * 100)}% of the explorer's speed`;
}

// Line of sight judged from known tiles only: any cell strictly between that is not known
// floor (known wall OR unknown) blocks. Same supercover walk as dungeon.hasLineOfSight.
export function knownLineOfSight(world, a, b) {
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b] = [b, a];
  const wall = (c) => !knownFloor(world, c);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const nx = Math.abs(dx), ny = Math.abs(dy);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let x = a[0], y = a[1];
  for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      if (wall([x + sx, y]) || wall([x, y + sy])) return false;
      x += sx; y += sy; ix++; iy++;
    } else if (decision < 0) {
      x += sx; ix++;
    } else {
      y += sy; iy++;
    }
    if ((x !== b[0] || y !== b[1]) && wall([x, y])) return false;
  }
  return true;
}

// Adversaries the explorer sees now, each with a BFS over known floor from its cell
// (only when that cell is known floor). Distances fall back to Euclidean otherwise.
export function threatsOf(world) {
  return world.visibleAdversaries().map((a) => ({
    id: a.id,
    pos: a.pos,
    chasing: a.mode === 'chase',
    hp: a.hp, // the health bar over it (KnownWorld: seen, so fog-safe)
    maxHp: a.maxHp,
    dist: knownFloor(world, a.pos) ? knownDistances(world, a.pos) : null,
  }));
}

export function threatDistance(threat, cell) {
  return threat.dist?.get(cell) ?? Math.round(euclid(threat.pos, cell));
}

// Smallest predicted gap (adversary path distance minus the steps it can take meanwhile) at
// `cell` when the explorer gets there after `steps` steps.
function gapAt(threats, cell, steps) {
  let g = Infinity;
  for (const th of threats) g = Math.min(g, threatDistance(th, cell) - advSteps(steps));
  return g;
}

// Known-floor BFS from the explorer that only enters cells where every visible adversary stays
// at least `minGap` steps away when the explorer arrives (the portal may always be entered).
// Only `withPortal` (race_to_exit, the portal fact) may end on the portal; every other route keeps off it.
export function safeDistances(world, threats, minGap, withPortal = false) {
  return knownDistances(world, world.pos, null, (c, d) => gapAt(threats, c, d) >= minGap, withPortal ? world.seenTreasure() : null);
}

function nearestThreat(world, threats) {
  return pick(threats.map((th) => ({ th, steps: threatDistance(th, world.pos) })), (f) => -f.steps)?.th ?? null;
}

// A goal lies "past" the adversary when it is beyond it as seen from the explorer: within 60
// degrees of the adversary's bearing and at least as far away as the adversary is.
const PAST_COS = 0.5;
function isPast(world, th, cell) {
  const [px, py] = world.pos;
  const dot = (th.pos[0] - px) * (cell[0] - px) + (th.pos[1] - py) * (cell[1] - py);
  const da = euclid(world.pos, th.pos), dc = euclid(world.pos, cell);
  return dc >= da && dot >= PAST_COS * da * dc;
}

export const hiddenFromAll = (world, threats, c) => threats.every((th) => !sameCell(th.pos, c) && !knownLineOfSight(world, th.pos, c));

// The goal cells each tactic needs, found in one gap-limited BFS.
// `distExit` (optional): the same BFS allowed to end on the portal, for the `exit` goal only; slip, hide and
// frontier goals never use the portal.
export function goalsAt(world, threats, dist, distExit = null) {
  const exitCell = world.seenTreasure();
  const near = nearestThreat(world, threats);
  const cells = dist.cells().filter((c) => !sameCell(c, world.pos)).map((c) => ({ cell: c, steps: dist.get(c) }));
  const frontier = cells.filter((f) => isFrontier(world, f.cell));
  const exitGoal = exitCell && distExit?.has(exitCell) ? { cell: [...exitCell], steps: distExit.get(exitCell) } : null;
  const pastCands = frontier.filter((f) => near && isPast(world, near, f.cell));
  return {
    slip: pick(pastCands, (f) => -f.steps),
    hide: pick(cells.filter((f) => f.steps <= HIDE_MAX_STEPS && hiddenFromAll(world, threats, f.cell)), (f) => -f.steps),
    exit: exitGoal,
    frontier: pick(frontier, (f) => (hiddenFromAll(world, threats, f.cell) ? 1000 : 0) - f.steps),
  };
}

// For each goal type, the largest gap (1..MAX_GAP) at which a route to it still exists:
// that is the route's closest approach. -> { slip, hide, exit, frontier }: { gap, cell, steps } | null
function routeSurvey(world, threats) {
  const out = { slip: null, hide: null, exit: null, frontier: null };
  for (let k = MAX_GAP; k >= 1; k--) {
    const missing = Object.keys(out).filter((t) => !out[t]);
    if (!missing.length) break;
    const goals = goalsAt(world, threats, safeDistances(world, threats, k), world.seenTreasure() ? safeDistances(world, threats, k, true) : null);
    for (const t of missing) if (goals[t]) out[t] = { gap: k, ...goals[t] };
  }
  return out;
}

const gapWords = (g) => (g >= MAX_GAP ? `${MAX_GAP} or more steps` : plural(g, 'step'));

// Bonuses that make an escape lead OUT of a room instead of into its far corner: a cell on the edge of
// the known map (the run continues into new space) or in a corridor/junction (past a room's exit).
const ESCAPE_FRONTIER = 20;
const ESCAPE_THROUGH_EXIT = 12;
const ESCAPE_KEEP_GAP = 2; // a kept goal stays good while a route to it keeps this gap
const ESCAPE_TRAVEL = 4; // the first steps toward a new escape spot cost nothing: it is picked by distance from the adversary, so no hopping to the next cell and back

// A reachable known floor cell that keeps the most distance between the explorer and the
// nearest visible adversary (their distance minus ours), preferring cells with more than one
// exit, then cells that lead on (edge of the known map, or beyond a room's exit) over a corner of the
// room already reached. A small bonus for travelling (capped) stops it from picking the explorer's own cell.
// `goal` (optional) is the escape spot picked earlier: it stays the target until it is reached or no
// route keeps ESCAPE_KEEP_GAP steps from every adversary, so the target does not flip between two
// cells as the adversary moves (which made the explorer bounce). `exclude` (optional Set of cell
// keys) are cells that must not be picked (the ones a ping-pong was bouncing between).
export function escapeTarget(world, dist, threats, { goal = null, exclude = null, minGap = ESCAPE_KEEP_GAP } = {}) {
  if (!threats.length) return null;
  // Only spots a route reaches while keeping the minimum gap from every adversary are real escapes (a
  // spot "far from it" behind the adversary is not): the mood's gap first, then ESCAPE_KEEP_GAP, then
  // any known cell. A tier is used only when it holds a spot ESCAPE_TRAVEL steps off, so a tight
  // gap that leaves only the neighbouring cells does not make the target hop from cell to cell.
  const keep = safeDistances(world, threats, ESCAPE_KEEP_GAP);
  const tiers = minGap > ESCAPE_KEEP_GAP ? [safeDistances(world, threats, minGap), keep, dist] : [keep, dist];
  if (goal && !sameCell(goal, world.pos) && keep.has(goal) && !exclude?.has(key(goal))) return result(world, rate(world, threats, keep, goal));
  let base = [];
  for (const reach of tiers) {
    base = reach.cells()
      .filter((c) => !sameCell(c, world.pos) && !exclude?.has(key(c)))
      .map((c) => ({ ...rate(world, threats, reach, c), score: 0 }));
    if (base.some((f) => f.steps >= ESCAPE_TRAVEL)) break;
  }
  for (const f of base) f.score = (f.theirs - f.steps) * 10 + 10 * Math.min(f.steps, ESCAPE_TRAVEL) + Math.min(f.steps, 15);
  const open = base.filter((f) => f.exits > 1);
  const pool = open.length ? open : base;
  // The bonuses cost a few lookups per cell, so only cells that could still win get them.
  const top = Math.max(-Infinity, ...pool.map((f) => f.score)) - (ESCAPE_FRONTIER + ESCAPE_THROUGH_EXIT);
  for (const f of pool) {
    if (f.score < top) continue;
    if (isFrontier(world, f.cell)) f.score += ESCAPE_FRONTIER;
    else if (!isRoomCell(world, f.cell)) f.score += ESCAPE_THROUGH_EXIT;
  }
  const best = pick(pool, (f) => f.score);
  return best ? result(world, best) : null;
}

const rate = (world, threats, reach, c) => ({
  cell: c,
  steps: reach.get(c),
  theirs: Math.min(...threats.map((t) => threatDistance(t, c))),
  exits: neighbours(c).filter((n) => knownFloor(world, n)).length,
});

const result = (world, f) => ({
  cell: f.cell,
  steps: f.steps,
  exits: f.exits,
  theirs: f.theirs,
  why: `Escape spot to the ${compass(world.pos, f.cell)}, ${plural(f.steps, 'step')} away; the nearest adversary is about ${plural(f.theirs, 'step')} from it.`,
});

// A cell is open-room space when it sits in a 2x2 block of known floor.
export function isRoomCell(world, p) {
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const block = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([ox, oy]) => [p[0] + dx + ox, p[1] + dy + oy]);
    if (block.every((c) => knownFloor(world, c))) return true;
  }
  return false;
}

// The known open area (room) around the explorer: flood fill over room cells, capped.
// -> { cells: [[x,y]], set: Set<key>, w, h, exits, unexplored } | null when not in a room.
export function openArea(world) {
  if (!isRoomCell(world, world.pos)) return null;
  const set = new Set([key(world.pos)]);
  const cells = [world.pos];
  for (let i = 0; i < cells.length && cells.length < AREA_CAP; i++) {
    for (const n of neighbours(cells[i])) {
      if (set.has(key(n)) || !isRoomCell(world, n)) continue;
      set.add(key(n));
      cells.push(n);
    }
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const mouths = new Set();
  let unexplored = false;
  for (const c of cells) {
    x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
    if (!unexplored && neighbours(c).some((n) => !world.isKnown(n))) unexplored = true;
    for (const n of neighbours(c)) if (knownFloor(world, n) && !set.has(key(n))) mouths.add(key(n));
  }
  return { cells, set, w: x1 - x0 + 1, h: y1 - y0 + 1, exits: mouths.size, unexplored };
}

// "1 of 2 hp": the health bar the explorer sees over a visible adversary.
export const hpText = (th) => `${th.hp} of ${th.maxHp} hp`;

// engage: where to stand to fight. The explorer acts first in a tick (its strike lands before the ghosts
// move) and a hit stuns, so the safe way in is to let a ghost step next to you and strike first: walking up
// to a hunting ghost hands it the first claw. So, per visible adversary: one the explorer stunned with its
// own strike (`stunned`, ids from the brain's own strike record: fog-safe) is closed in on (target: a cell
// next to it); any other is met HOLD_GAP known-path steps off (target: the nearest such cell, or the
// explorer's own cell when it is already there). Already next to one: the own cell (strike now). The
// cheapest target wins (the weaker adversary on a tie). No minimum gap: closing in is the point.
const HOLD_GAP = 2;
// The fight in numbers, from the health bar in sight and the sword's damage only. "At most one claw" is claimed
// for up to 2 strikes, one adversary in sight and `fight.steady` (the stun outlasts the sword's cooldown): in stubbed
// duels (check-skills section 12) holding the 2-step gap took no claw and walking in at most one, always before the
// first strike; two ghosts, a sword cooldown above the stun or no stun gave two. `fight.only`: the one adversary
// the explorer knows of.
function fightFacts(th, { damage, only, steady = false }, alone) {
  const n = Math.max(1, Math.ceil(th.hp / damage));
  return `${plural(n, 'strike')} dispel${n === 1 ? 's' : ''} it${n <= 2 && steady && alone ? '; expect at most one claw at you' : ''}.` +
    `${only ? ' Dispelling it may clear the dungeon (a win).' : ''}`;
}
export function engageTarget(world, threats, { stunned = null, fight = null } = {}) {
  if (!threats.length) return null;
  const here = world.pos;
  const dist = knownDistances(world, here);
  const cands = [];
  for (const th of threats) {
    const now = threatDistance(th, here);
    const close = stunned?.has(th.id);
    if (now <= 1) { cands.push({ cell: [...here], steps: 0, th, kind: 'adjacent' }); continue; }
    if (!close && now === HOLD_GAP) { cands.push({ cell: [...here], steps: 0, th, kind: 'hold' }); continue; }
    const want = close ? 1 : HOLD_GAP;
    for (const c of dist.order) {
      if (threats.some((o) => sameCell(o.pos, c)) || threatDistance(th, c) !== want) continue;
      cands.push({ cell: c, steps: dist.get(c), th, kind: close ? 'close' : 'approach' });
    }
  }
  cands.sort((a, b) => a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
  const best = pick(cands, (f) => -f.steps * 10 - f.th.hp);
  if (!best) return null;
  const { th } = best;
  const who = `${th.id} (${hpText(th)})`;
  const where = `${plural(best.steps, 'step')} to the ${compass(here, best.cell)}`;
  const why = {
    adjacent: `${who} is next to you: strike it now.`,
    hold: `Hold here, 2 steps from ${who}: let it step in.`,
    approach: `${where} puts you 2 steps from ${who}: wait there.`,
    close: `${where} puts you next to ${who}, still stunned by your strike.`,
  }[best.kind];
  return { cell: [...best.cell], steps: best.steps, why: fight ? `${why} ${fightFacts(th, fight, threats.length === 1)}` : why };
}

// Per legal move: does it lead into a known dead end (nothing unexplored past it, no loop back)?
function deadEndMoves(world) {
  const here = world.pos;
  const t = world.seenTreasure();
  return world.legalMoves().filter((dir) => {
    const dest = step(here, dir);
    const beyond = knownDistances(world, dest, here);
    const explorable = beyond.order.some((c) => isFrontier(world, c)) || (t && beyond.has(t));
    const loops = neighbours(here).some((n) => !sameCell(n, dest) && knownFloor(world, n) && beyond.has(n));
    return !explorable && !loops;
  });
}

// Sentiment-free encounter facts (null while no adversary is in sight). Request 1 (sentiment)
// and every tick request read these; tactic feasibility then applies one sentiment's minimum gap.
export function encounterFacts(world, threats) {
  if (!threats.length) return null;
  const here = world.pos;
  const area = openArea(world);
  const exits = neighbours(here).filter((c) => knownFloor(world, c)).length;
  let space;
  if (area) {
    space = `Open room, about ${area.w}×${area.h} known cells, ${plural(area.exits, 'known way')} out` +
      `${area.unexplored ? ', parts of it still unexplored' : ''}.`;
  } else if (exits >= 3) space = `Junction with ${exits} ways on.`;
  else if (exits === 2) space = 'Narrow corridor: one way forward, one way back.';
  else space = 'Dead end: only one way out.';

  const gapNow = Math.min(...threats.map((th) => threatDistance(th, here)));
  const survey = routeSurvey(world, threats);
  const run = escapeTarget(world, knownDistances(world, here), threats);
  const dead = deadEndMoves(world);
  const legal = world.legalMoves().length;
  const exitCell = world.seenTreasure();
  const facts = {
    space,
    gap_now: gapNow,
    speed: `Every step straight away from an adversary gains about ${Math.round((1 - ADVERSARY_SPEED) * 10) / 10} of a step.`,
    slip_past: survey.slip
      ? `Best known route past it toward unexplored space: ` +
        `${plural(survey.slip.steps, 'step')}, closest approach ${gapWords(survey.slip.gap)}.`
      : 'No known route gets past it: it blocks the way, or every way past runs into it.',
    hide: survey.hide
      ? `Nearest cell out of its sight: ${plural(survey.hide.steps, 'step')} to the ${compass(here, survey.hide.cell)}, closest approach on the way ${gapWords(survey.hide.gap)}.`
      : `No known cell out of its sight within ${HIDE_MAX_STEPS} steps can be reached before it closes in.`,
    run_away: run
      ? `Best escape spot: ${plural(run.steps, 'step')} to the ${compass(here, run.cell)}, about ${plural(run.theirs, 'step')} from the adversary, ${plural(run.exits, 'exit')} there.`
      : 'Nowhere known to run to.',
    dead_ends: dead.length ? `${dead.length} of ${plural(legal, 'move')} lead${dead.length === 1 ? 's' : ''} into a known dead end (${dead.join(', ')}).` : 'No move leads into a known dead end.',
  };
  if (exitCell) {
    facts.exit = survey.exit
      ? `The portal is ${plural(survey.exit.steps, 'step')} away; on that path the adversary gets no closer than ${gapWords(survey.exit.gap)}.`
      : 'The portal is seen, but no known path reaches it without running into the adversary.';
  }
  return { facts, survey, area, threats };
}
