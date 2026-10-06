// What Jev is allowed to see, written as plain-language facts.
// Code observes; Jev decides. FOG OF WAR: every map read here goes through
// isKnown/knownTile, unknown cells are neither wall nor floor, and paths only
// run over known floor. Past the map edge is rock that is known once lit, like
// any other rock, so nothing here reveals where the map ends. Adversaries are
// read only through visibleAdversaries (the ones the explorer sees right now).
//
// v4 encounters: when an adversary is in sight, `situation.encounter` lists sentiment-free
// facts (space, gap, speed, best route past it, nearest hiding cell, escape spot, dead ends),
// and `tacticOptions(game, minGap)` turns them into the feasible tactics for one sentiment's
// minimum gap. Line of sight here is judged over known tiles only: unknown cells block.

import { DIRS, LIGHT_RADIUS, STAY, legalMoves, isKnown, knownTile, knownFloorCount } from '../../dungeon.js';
import { ADVERSARY_SPEED, graceLeft, visibleAdversaries } from '../adversary/adversary.js';

// `thought` is the first-person line the UI shows in the explorer's thought bubble (≤ 60 chars).
// Tactics (`tactic: true`) are encounter approaches: chosen in a decision step, never logged in `tried`.
export const APPROACHES = {
  nearest_frontier: { text: 'Explore the closest edge of the known map first, clearing nearby gaps before travelling.', thought: "Let's check the closest dark edge." },
  largest_unexplored: { text: 'Head for the largest dark region, judged by how much unknown space lies in each direction.', thought: 'That big dark patch looks promising.' },
  far_side: { text: 'Travel to the part of the dungeon farthest from where the explorer has already been.', thought: "Let's try the far side of this place." },
  go_to_treasure: { text: 'The chest has been seen: walk the shortest known path to it.', thought: 'The chest! Straight to it.', needsTreasure: true },
  slip_past: {
    text: 'Slip past the adversary: follow a known route around it toward unexplored space, never letting it closer than the minimum gap, using the speed edge.',
    thought: 'I can slip past!', tactic: true,
  },
  run_away: { text: 'Run away from the adversary: get away from it, keep escape routes open, and avoid dead ends.', thought: 'Run away!', tactic: true },
  face_off: {
    text: 'Face off: hold ground in the open space, keep a safe gap, and dodge around the adversary as it commits (it is slower), then continue.',
    thought: 'Face off.', tactic: true,
  },
  hide: { text: "Duck out of sight: reach a known cell outside the adversary's line of sight before it gets there.", thought: 'Duck out of sight.', tactic: true },
  race_to_chest: { text: 'Race the adversary to the seen chest along the known path, staying out of its reach.', thought: 'Go for the chest!', tactic: true, needsTreasure: true },
  carry_on: { text: 'The adversary is patrolling and has not seen the explorer: keep exploring, but stay out of its sight.', thought: "It hasn't seen me, keep going.", tactic: true },
};
export const TACTICS = Object.keys(APPROACHES).filter((id) => APPROACHES[id].tactic);
export const isTactic = (id) => Boolean(APPROACHES[id]?.tactic);

export const DEFAULT_MIN_GAP = 3; // used when no sentiment is given
const MAX_GAP = 6; // the route survey looks for closest approaches up to this many steps
const HIDE_MAX_STEPS = 10; // a hiding cell farther than this is not "ducking"
const FACE_OFF_REACH = 6; // face_off stays within this many steps of where it stood
const AREA_CAP = 600; // flood-fill cap for the open area around the explorer
const FACE_OFF_MIN_SIDE = 5; // an open area narrower than this is no place to dodge

// How far (in cells, each way) unexplored_by_direction looks. Fixed, so it never depends on the map size.
const SURVEY_REACH = 12;

const key = ([x, y]) => `${x},${y}`;
const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1];
const step = ([x, y], dir) => [x + DIRS[dir][0], y + DIRS[dir][1]];
const neighbours = (c) => Object.keys(DIRS).map((d) => step(c, d));
const knownFloor = (game, c) => knownTile(game, c) === '.';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
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

// The one place that touches the treasure position, and only once it is lit.
function seenTreasureCell(game) {
  const t = game.dungeon.treasure;
  return t && isKnown(game, t) ? t : null; // null treasure: a testbed arena with no chest
}

export function treasureSeen(game) {
  return seenTreasureCell(game) !== null;
}

// Known floor that touches at least one unknown cell: the edge of the known map.
function isFrontier(game, c) {
  return knownFloor(game, c) && neighbours(c).some((n) => !isKnown(game, n));
}

// Step counts over known floor only, optionally with one cell blocked off.
// Flat Int32Array (index y * width + x, -1 = not reached) plus the visiting order.
// Known floor is always inside the map, so the index never wraps.
// `admit(cell, steps)` (optional) rejects cells that may not be entered at that step count;
// `endCell` may be entered regardless but is not expanded (the chest: stepping on it wins).
function knownDistances(game, from, blocked = null, admit = null, endCell = null) {
  const W = game.dungeon.width;
  const dist = new Int32Array(W * game.dungeon.height).fill(-1);
  const order = [];
  const at = (c) => c[1] * W + c[0];
  const result = {
    get: (c) => {
      if (c[0] < 0 || c[0] >= W || c[1] < 0 || c[1] >= game.dungeon.height) return undefined;
      const d = dist[at(c)];
      return d < 0 ? undefined : d;
    },
    has: (c) => result.get(c) !== undefined,
    // Reached cells in fixed (y, x) order, so tie-breaks never depend on where the BFS started.
    cells: () => order.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    order,
  };
  dist[at(from)] = 0;
  order.push(from);
  const blockedIdx = blocked ? at(blocked) : -1;
  const endIdx = endCell ? at(endCell) : -1;
  for (let i = 0; i < order.length; i++) {
    const d = dist[at(order[i])] + 1;
    for (const n of neighbours(order[i])) {
      if (!knownFloor(game, n)) continue;
      const ni = at(n);
      if (dist[ni] >= 0 || ni === blockedIdx) continue;
      if (ni === endIdx) { dist[ni] = d; continue; }
      if (admit && !admit(n, d)) continue;
      dist[ni] = d;
      order.push(n);
    }
  }
  return result;
}

// Line of sight judged from known tiles only: any cell strictly between that is not known
// floor (known wall OR unknown) blocks. Same supercover walk as dungeon.hasLineOfSight.
export function knownLineOfSight(game, a, b) {
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b] = [b, a];
  const wall = (c) => !knownFloor(game, c);
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

// Unknown cells that a visit to `c` would light up. Light needs no line of sight,
// so this counts unknown space without peeking at what it holds.
function wouldReveal(game, [cx, cy], radius = LIGHT_RADIUS) {
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius && !isKnown(game, [x, y])) n++;
    }
  }
  return n;
}

// Compass name for the direction from `a` to `b` (y points down, so north is smaller y).
function compass([ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

const COMPASS8 = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
function compass8([ax, ay], [bx, by]) {
  const angle = Math.atan2(ay - by, bx - ax); // y points down, so flip it
  return COMPASS8[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

// Unknown cells in a fixed window around the explorer (SURVEY_REACH each way), split into
// half-planes. Out-of-map cells count like any other rock: unknown until lit.
function unknownByDirection(game) {
  const [px, py] = game.pos;
  const R = SURVEY_REACH;
  const count = { north: 0, south: 0, east: 0, west: 0 };
  for (let y = py - R; y <= py + R; y++) {
    for (let x = px - R; x <= px + R; x++) {
      if (isKnown(game, [x, y])) continue;
      if (y < py) count.north++;
      if (y > py) count.south++;
      if (x > px) count.east++;
      if (x < px) count.west++;
    }
  }
  return count;
}

// Each half-plane holds SURVEY_REACH * (2 * SURVEY_REACH + 1) = 300 cells.
const amount = (n) => (n === 0 ? 'none' : n <= 30 ? 'little' : n <= 120 ? 'some' : 'a lot');

// Reachable frontier cells with their step counts, in a fixed (y, x) order.
function reachableFrontier(game, dist) {
  return dist.cells()
    .filter((c) => isFrontier(game, c))
    .map((c) => ({ cell: c, steps: dist.get(c) }));
}

// Picks the best entry: highest score first, then fewest steps, then fixed cell order.
function pick(list, score) {
  let best = null;
  for (const f of list) {
    const s = score(f);
    if (!best || s > best.s || (s === best.s && f.steps < best.f.steps)) best = { f, s };
  }
  return best?.f ?? null;
}

// Adversaries the explorer sees now, each with a BFS over known floor from its cell
// (only when that cell is known floor). Distances fall back to Euclidean otherwise.
function threatsOf(game) {
  return visibleAdversaries(game).map((a) => ({
    pos: a.pos,
    chasing: a.mode === 'chase',
    dist: knownFloor(game, a.pos) ? knownDistances(game, a.pos) : null,
  }));
}

function threatDistance(threat, cell) {
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
// at least `minGap` steps away when the explorer arrives (the chest may always be entered).
function safeDistances(game, threats, minGap) {
  return knownDistances(game, game.pos, null, (c, d) => gapAt(threats, c, d) >= minGap, seenTreasureCell(game));
}

function nearestThreat(game, threats) {
  return pick(threats.map((th) => ({ th, steps: threatDistance(th, game.pos) })), (f) => -f.steps)?.th ?? null;
}

// A goal lies "past" the adversary when it is beyond it as seen from the explorer: within 60
// degrees of the adversary's bearing and at least as far away as the adversary is.
const PAST_COS = 0.5;
function isPast(game, th, cell) {
  const [px, py] = game.pos;
  const dot = (th.pos[0] - px) * (cell[0] - px) + (th.pos[1] - py) * (cell[1] - py);
  const da = euclid(game.pos, th.pos), dc = euclid(game.pos, cell);
  return dc >= da && dot >= PAST_COS * da * dc;
}

const hiddenFromAll = (game, threats, c) => threats.every((th) => !sameCell(th.pos, c) && !knownLineOfSight(game, th.pos, c));

// The goal cells each tactic needs, found in one gap-limited BFS.
function goalsAt(game, threats, dist) {
  const chest = seenTreasureCell(game);
  const near = nearestThreat(game, threats);
  const cells = dist.cells().filter((c) => !sameCell(c, game.pos)).map((c) => ({ cell: c, steps: dist.get(c) }));
  const frontier = cells.filter((f) => isFrontier(game, f.cell));
  const chestGoal = chest && dist.has(chest) ? { cell: [...chest], steps: dist.get(chest) } : null;
  const pastCands = [...frontier, ...(chestGoal ? [chestGoal] : [])].filter((f) => near && isPast(game, near, f.cell));
  return {
    slip: pick(pastCands, (f) => -f.steps),
    hide: pick(cells.filter((f) => f.steps <= HIDE_MAX_STEPS && hiddenFromAll(game, threats, f.cell)), (f) => -f.steps),
    chest: chestGoal,
    frontier: pick(frontier, (f) => (hiddenFromAll(game, threats, f.cell) ? 1000 : 0) - f.steps),
  };
}

// For each goal type, the largest gap (1..MAX_GAP) at which a route to it still exists:
// that is the route's closest approach. -> { slip, hide, chest, frontier }: { gap, cell, steps } | null
function routeSurvey(game, threats) {
  const out = { slip: null, hide: null, chest: null, frontier: null };
  for (let k = MAX_GAP; k >= 1; k--) {
    const missing = Object.keys(out).filter((t) => !out[t]);
    if (!missing.length) break;
    const goals = goalsAt(game, threats, safeDistances(game, threats, k));
    for (const t of missing) if (goals[t]) out[t] = { gap: k, ...goals[t] };
  }
  return out;
}

const gapWords = (g) => (g >= MAX_GAP ? `${MAX_GAP} or more steps` : plural(g, 'step'));

// Exploration approaches Jev may pick in a review (tactics are offered by tacticOptions).
export function availableApproaches(game) {
  return Object.keys(APPROACHES).filter((id) => !APPROACHES[id].tactic && (!APPROACHES[id].needsTreasure || treasureSeen(game)));
}

// A reachable known floor cell that keeps the most distance between the explorer and the
// nearest visible adversary (their distance minus ours), preferring cells with more than one
// exit. A small bonus for travelling (capped) stops it from picking the explorer's own cell.
function escapeTarget(game, dist, threats) {
  if (!threats.length) return null;
  const candidates = dist.cells()
    .filter((c) => !sameCell(c, game.pos))
    .map((c) => {
      const steps = dist.get(c);
      const theirs = Math.min(...threats.map((t) => threatDistance(t, c)));
      const exits = neighbours(c).filter((n) => knownFloor(game, n)).length;
      return { cell: c, steps, theirs, exits };
    });
  const open = candidates.filter((f) => f.exits > 1);
  const best = pick(open.length ? open : candidates, (f) => (f.theirs - f.steps) * 10 + Math.min(f.steps, 15));
  if (!best) return null;
  return {
    cell: best.cell,
    steps: best.steps,
    exits: best.exits,
    theirs: best.theirs,
    why: `Escape spot to the ${compass(game.pos, best.cell)}, ${plural(best.steps, 'step')} away; the nearest adversary is about ${plural(best.theirs, 'step')} from it.`,
  };
}

// A cell is open-room space when it sits in a 2x2 block of known floor.
function isRoomCell(game, p) {
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const block = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([ox, oy]) => [p[0] + dx + ox, p[1] + dy + oy]);
    if (block.every((c) => knownFloor(game, c))) return true;
  }
  return false;
}

// The known open area (room) around the explorer: flood fill over room cells, capped.
// -> { cells: [[x,y]], set: Set<key>, w, h, exits, unexplored } | null when not in a room.
function openArea(game) {
  if (!isRoomCell(game, game.pos)) return null;
  const set = new Set([key(game.pos)]);
  const cells = [game.pos];
  for (let i = 0; i < cells.length && cells.length < AREA_CAP; i++) {
    for (const n of neighbours(cells[i])) {
      if (set.has(key(n)) || !isRoomCell(game, n)) continue;
      set.add(key(n));
      cells.push(n);
    }
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const mouths = new Set();
  let unexplored = false;
  for (const c of cells) {
    x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
    if (!unexplored && neighbours(c).some((n) => !isKnown(game, n))) unexplored = true;
    for (const n of neighbours(c)) if (knownFloor(game, n) && !set.has(key(n))) mouths.add(key(n));
  }
  return { cells, set, w: x1 - x0 + 1, h: y1 - y0 + 1, exits: mouths.size, unexplored };
}

function faceOffTarget(game, threats, minGap, area) {
  if (!threats.length || !area || Math.min(area.w, area.h) < FACE_OFF_MIN_SIDE) return null;
  if (Math.min(...threats.map((t) => threatDistance(t, game.pos))) < minGap) return null;
  const dist = safeDistances(game, threats, minGap);
  const cands = area.cells
    .filter((c) => !sameCell(c, game.pos) && dist.has(c) && dist.get(c) <= FACE_OFF_REACH)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map((c) => ({ cell: c, steps: dist.get(c), theirs: Math.min(...threats.map((t) => threatDistance(t, c))) }));
  // Hold the room: the nearby cell that gains the most gap, not the farthest bolt-hole.
  const best = pick(cands, (f) => (f.theirs - advSteps(f.steps)) * 10 - f.steps);
  if (!best) return null;
  return {
    cell: best.cell,
    steps: best.steps,
    why: `Dodge spot in this ${area.w}×${area.h} room, ${plural(best.steps, 'step')} to the ${compass(game.pos, best.cell)}; the adversary is about ${plural(best.theirs, 'step')} from it.`,
  };
}

// Tactic targets need a visible adversary; without one, the move-on tactics fall back to the
// closest edge of the known map.
function noThreatFallback(game, dist) {
  const best = pick(reachableFrontier(game, dist), (f) => -f.steps * 1000 + wouldReveal(game, f.cell));
  return best ? { ...best, why: `No adversary in sight right now; closest edge of the known map, ${plural(best.steps, 'step')} away.` } : null;
}

// `goal` (optional): the cell this tactic was heading for. slip_past, hide and carry_on keep it
// while it stays reachable at the minimum gap (and, for hide, out of sight), so the target does not jump
// around as the explorer moves (the "past the adversary" test depends on where the explorer is).
export function approachTarget(game, approachId, { minGap = DEFAULT_MIN_GAP, goal = null } = {}) {
  const dist = knownDistances(game, game.pos);

  if (approachId === 'run_away') return escapeTarget(game, dist, threatsOf(game));

  if (isTactic(approachId)) {
    const threats = threatsOf(game);
    const chest = seenTreasureCell(game);
    if (approachId === 'race_to_chest') {
      if (!chest) return null;
      if (!threats.length) return approachTarget(game, 'go_to_treasure');
      const safe = safeDistances(game, threats, minGap);
      if (!safe.has(chest)) return null;
      return { cell: [...chest], steps: safe.get(chest), why: `The chest is ${plural(safe.get(chest), 'step')} away by a known path that keeps the adversary at least ${plural(minGap, 'step')} off.` };
    }
    if (!threats.length) return approachId === 'hide' ? null : noThreatFallback(game, dist);
    if (approachId === 'face_off') return faceOffTarget(game, threats, minGap, openArea(game));
    const safe = safeDistances(game, threats, minGap);
    const goals = goalsAt(game, threats, safe);
    if (goal && !sameCell(goal, game.pos) && safe.has(goal)) {
      const kept = { cell: [...goal], steps: safe.get(goal) };
      // A route goal stays good while reachable (walking toward it lights it up, so it soon stops
      // being an edge); a hiding cell must still be out of sight.
      const stillGood = approachId !== 'hide' || hiddenFromAll(game, threats, goal);
      if (stillGood) goals[approachId === 'slip_past' ? 'slip' : approachId === 'hide' ? 'hide' : 'frontier'] = kept;
    }
    if (approachId === 'slip_past') {
      const g = goals.slip;
      if (!g) return null;
      const to = chest && sameCell(g.cell, chest) ? 'to the chest' : 'toward unexplored space';
      return { ...g, why: `Route past the adversary ${to}, ${plural(g.steps, 'step')} to the ${compass(game.pos, g.cell)}, keeping at least ${plural(minGap, 'step')} between you.` };
    }
    if (approachId === 'hide') {
      const g = goals.hide;
      if (!g) return null;
      return { ...g, why: `Cell out of the adversary's sight, ${plural(g.steps, 'step')} to the ${compass(game.pos, g.cell)}, reached while keeping at least ${plural(minGap, 'step')} between you.` };
    }
    // carry_on
    const g = goals.frontier;
    if (!g) return null;
    const hidden = hiddenFromAll(game, threats, g.cell);
    return { ...g, why: `Edge of the known map ${plural(g.steps, 'step')} to the ${compass(game.pos, g.cell)}${hidden ? ', out of the adversary\'s sight' : ''}.` };
  }

  const frontier = reachableFrontier(game, dist);

  if (approachId === 'go_to_treasure') {
    const t = seenTreasureCell(game);
    if (!t) return null;
    if (dist.has(t)) {
      return { cell: [...t], steps: dist.get(t), why: `The chest is ${plural(dist.get(t), 'step')} away by known path.` };
    }
    // Seen, but the way there still crosses dark cells: head for the edge nearest to it.
    const near = pick(frontier, (f) => -Math.hypot(f.cell[0] - t[0], f.cell[1] - t[1]));
    if (!near) return null;
    return { ...near, why: `No fully known path to the chest yet; this edge of the known map is closest to it, ${plural(near.steps, 'step')} away.` };
  }

  if (!frontier.length) return null;

  if (approachId === 'largest_unexplored') {
    // Score each edge by the dark space around it (fixed as the explorer walks), minus a
    // travel cost: walking towards the chosen edge makes it cheaper, so it stays chosen.
    const best = pick(frontier, (f) => wouldReveal(game, f.cell, LIGHT_RADIUS * 2) - 4 * f.steps);
    return { ...best, why: `Edge of the largest dark region, to the ${compass(game.pos, best.cell)}, ${plural(best.steps, 'step')} away.` };
  }

  if (approachId === 'far_side') {
    // Farthest edge from the average of every cell visited so far.
    const visited = Object.keys(game.visits).map((k) => k.split(',').map(Number));
    const cx = visited.reduce((s, v) => s + v[0], 0) / visited.length;
    const cy = visited.reduce((s, v) => s + v[1], 0) / visited.length;
    // Minus a travel cost (one cell of distance per step) so the target doesn't flip
    // back and forth as that average drifts towards it.
    const best = pick(frontier, (f) => Math.round(Math.hypot(f.cell[0] - cx, f.cell[1] - cy) * 10) - 10 * f.steps);
    return { ...best, why: `Edge of the known map farthest from where the explorer has been, to the ${compass(game.pos, best.cell)}, ${plural(best.steps, 'step')} away.` };
  }

  // nearest_frontier (also the fallback for unknown ids): fewest steps, then most to reveal.
  const best = pick(frontier, (f) => -f.steps * 1000 + wouldReveal(game, f.cell));
  return { ...best, why: `Closest edge of the known map, ${plural(best.steps, 'step')} away.` };
}

function hereKind(game) {
  if (isRoomCell(game, game.pos)) return 'room';
  const exits = neighbours(game.pos).filter((c) => knownFloor(game, c)).length;
  return exits >= 3 ? 'junction' : exits === 2 ? 'corridor' : 'dead end';
}

// Per legal move: does it lead into a known dead end (nothing unexplored past it, no loop back)?
function deadEndMoves(game) {
  const here = game.pos;
  const t = seenTreasureCell(game);
  return legalMoves(game).filter((dir) => {
    const dest = step(here, dir);
    const beyond = knownDistances(game, dest, here);
    const explorable = beyond.order.some((c) => isFrontier(game, c)) || (t && beyond.has(t));
    const loops = neighbours(here).some((n) => !sameCell(n, dest) && knownFloor(game, n) && beyond.has(n));
    return !explorable && !loops;
  });
}

// Sentiment-free encounter facts (null while no adversary is in sight). Request 1 (sentiment)
// and every tick request read these; tactic feasibility then applies one sentiment's minimum gap.
function encounterFacts(game, threats) {
  if (!threats.length) return null;
  const here = game.pos;
  const area = openArea(game);
  const exits = neighbours(here).filter((c) => knownFloor(game, c)).length;
  let space;
  if (area) {
    space = `Open room, about ${area.w}×${area.h} known cells, ${plural(area.exits, 'known way')} out` +
      `${area.unexplored ? ', parts of it still unexplored' : ''}.`;
  } else if (exits >= 3) space = `Junction with ${exits} ways on.`;
  else if (exits === 2) space = 'Narrow corridor: one way forward, one way back.';
  else space = 'Dead end: only one way out.';

  const gapNow = Math.min(...threats.map((th) => threatDistance(th, here)));
  const survey = routeSurvey(game, threats);
  const run = escapeTarget(game, knownDistances(game, here), threats);
  const dead = deadEndMoves(game);
  const legal = legalMoves(game).length;
  const chest = seenTreasureCell(game);
  const facts = {
    space,
    adversaries: threats.map((th) =>
      `${th.chasing ? 'Chasing' : 'Patrolling (has not reacted yet)'} adversary to the ${compass8(here, th.pos)}, ` +
      `${plural(threatDistance(th, here), 'step')} away.`),
    gap_now: gapNow,
    speed: `Adversaries move ${speedPhrase()}: every step straight away from one gains about ${Math.round((1 - ADVERSARY_SPEED) * 10) / 10} of a step.`,
    slip_past: survey.slip
      ? `Best known route past it ${chest && sameCell(survey.slip.cell, chest) ? 'to the chest' : 'toward unexplored space'}: ` +
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
  if (chest) {
    facts.chest = survey.chest
      ? `The chest is ${plural(survey.chest.steps, 'step')} away; on that path the adversary gets no closer than ${gapWords(survey.chest.gap)}.`
      : 'The chest is seen, but no known path reaches it without running into the adversary.';
  }
  return { facts, survey, area, threats };
}

// Feasible tactics for a minimum gap, from known cells and visible adversaries only.
// -> { [id]: { target, fact } } (infeasible tactics are left out); empty while nothing is in sight.
export function tacticFeasibility(game, minGap = DEFAULT_MIN_GAP) {
  const threats = threatsOf(game);
  if (!threats.length) return {};
  const enc = encounterFacts(game, threats);
  const out = {};
  const s = enc.survey;
  const add = (id, ok) => {
    if (!ok) return;
    const target = approachTarget(game, id, { minGap });
    if (target) out[id] = { target, fact: target.why };
  };
  add('slip_past', s.slip && s.slip.gap >= minGap);
  add('run_away', true);
  add('face_off', enc.area && Math.min(enc.area.w, enc.area.h) >= FACE_OFF_MIN_SIDE && enc.facts.gap_now >= minGap);
  add('hide', s.hide && s.hide.gap >= minGap);
  add('race_to_chest', treasureSeen(game) && s.chest && s.chest.gap >= minGap);
  add('carry_on', threats.every((th) => !th.chasing) && s.frontier && s.frontier.gap >= minGap);
  return out;
}

// Choice criteria for the tactic question: { id: what it means + the concrete fact }, in TACTICS order.
export function tacticOptions(game, minGap = DEFAULT_MIN_GAP) {
  const f = tacticFeasibility(game, minGap);
  return Object.fromEntries(TACTICS.filter((id) => f[id]).map((id) => [id, `${APPROACHES[id].text} ${f[id].fact}`]));
}

export function situation(game) {
  const dist = knownDistances(game, game.pos);
  const t = seenTreasureCell(game);
  let treasure = 'not seen yet';
  if (t) {
    treasure = dist.has(t)
      ? `seen, ${plural(dist.get(t), 'step')} away by known path`
      : 'seen, no fully known path yet';
  }
  const unknown = unknownByDirection(game);
  const threats = threatsOf(game);
  return {
    steps: game.steps,
    lives: game.health, // the explorer's own state: fog-safe
    hit_protection_steps: graceLeft(game), // steps left in which no adversary can hurt it (0 = none)
    known_floor_cells: knownFloorCount(game), // a count, not a %: a % would leak the dungeon's size
    here: hereKind(game),
    treasure,
    unexplored_by_direction: {
      north: amount(unknown.north),
      south: amount(unknown.south),
      east: amount(unknown.east),
      west: amount(unknown.west),
    },
    frontier_cells: reachableFrontier(game, dist).length,
    threats: threats.map((th) => ({
      direction: compass8(game.pos, th.pos),
      distance: threatDistance(th, game.pos),
      chasing: th.chasing,
    })),
    encounter: encounterFacts(game, threats)?.facts ?? null,
  };
}

function visitSentence(n) {
  if (!n) return 'Never visited.';
  if (n === 1) return 'Visited once already.';
  return `Visited ${n} times already.`;
}

// What stepping onto an adversary costs: a life (the last one ends the game), or nothing while
// the hit protection after an earlier hit lasts (the adversary is only pushed off the cell).
function touchSentence(game) {
  if (graceLeft(game) > 0) return 'Steps into the adversary: no life lost while your hit protection lasts; it is pushed off your cell.';
  if (game.health <= 1) return 'Steps into the adversary: costs your last life and the game is lost.';
  return `Steps into the adversary: costs 1 life (${game.health - 1} of ${game.maxHealth} left) and it is knocked back.`;
}

// Threat sentences for one move, one per visible adversary.
function threatSentences(game, threats, dest, minGap) {
  const facts = [];
  for (const th of threats) {
    if (sameCell(dest, th.pos)) {
      facts.unshift(touchSentence(game));
      continue;
    }
    const where = threats.length > 1 ? ` to the ${compass8(game.pos, th.pos)}` : '';
    const who = th.chasing ? `the chasing adversary${where}` : `an adversary${where}`;
    const before = threatDistance(th, game.pos), after = threatDistance(th, dest);
    const gap = `(${plural(after, 'step')} between you after this${after < minGap ? `, below your minimum gap of ${minGap}` : ''})`;
    if (after > before) facts.push(`Moves away from ${who} ${gap}.`);
    else if (after < before) facts.push(`Moves toward ${who} ${gap}.`);
    else facts.push(`Keeps the same distance from ${who} ${gap}.`);
  }
  return facts;
}

// Facts about standing still: nothing is revealed and the position (and every distance) stays put,
// so with an adversary in sight it only lets the gap shrink as the adversary moves.
function stayFacts(game, approachId, threats, minGap) {
  const facts = ['Stands still: stays on this cell, reveals nothing new, and the step passes.'];
  for (const th of threats) {
    const d = threatDistance(th, game.pos);
    const who = th.chasing ? 'the chasing adversary' : 'an adversary';
    facts.push(`${who} is ${plural(d, 'step')} away${d < minGap ? `, below your minimum gap of ${minGap}` : ''} and keeps moving while you wait.`);
  }
  if (!threats.length) facts.push('With no adversary in sight, waiting makes no progress toward the approach target.');
  return facts.join(' ');
}

// Plain-language facts about each legal move, for Jev to judge.
// The biggest risk for one-step greedy play is walking back and forth, so every
// move states what it reveals, how worn the destination is, and whether it gets
// closer to the current approach's target. Visible adversaries add threat facts,
// judged against the sentiment's minimum gap.
export function describeMoves(game, approachId, { minGap = DEFAULT_MIN_GAP, goal = null } = {}) {
  const target = approachId === 'go_to_treasure' ? null : approachTarget(game, approachId, { minGap, goal });
  const toTarget = target ? knownDistances(game, target.cell) : null;
  const t = seenTreasureCell(game);
  const toTreasure = t ? knownDistances(game, t) : null;
  const threats = threatsOf(game);
  const here = game.pos;
  // When the chest is seen but has no known path, judge moves against the edge nearest it.
  let toNearEdge = null;
  if (t && approachId === 'go_to_treasure' && !toTreasure.has(here)) {
    const near = approachTarget(game, 'go_to_treasure');
    toNearEdge = near ? knownDistances(game, near.cell) : null;
  }
  const otherExits = (dest) => neighbours(here).filter((n) => !sameCell(n, dest) && knownFloor(game, n));
  const out = {};

  for (const dir of legalMoves(game)) {
    const dest = step(here, dir);
    const facts = [];

    if (t && sameCell(dest, t)) {
      out[dir] = 'Steps onto the treasure chest and wins the game.';
      continue;
    }
    facts.push(...threatSentences(game, threats, dest, minGap));

    if (t) {
      const before = toTreasure.get(here), after = toTreasure.get(dest);
      if (before !== undefined && after !== undefined) {
        facts.push(after < before
          ? `Moves closer to the chest (${plural(after, 'step')} left by known path).`
          : `Moves farther from the chest (${plural(after, 'step')} by known path).`);
      } else if (toNearEdge?.has(here) && toNearEdge.has(dest)) {
        facts.push(toNearEdge.get(dest) < toNearEdge.get(here)
          ? 'No known path to the chest yet; this heads for the dark edge nearest it.'
          : 'No known path to the chest yet; this moves away from the dark edge nearest it.');
      }
    }

    const reveal = wouldReveal(game, dest);
    facts.push(reveal ? `Would reveal about ${plural(reveal, 'new cell')}.` : 'Reveals nothing new.');
    facts.push(visitSentence(game.visits[key(dest)]));

    if (approachId !== 'go_to_treasure') {
      if (!target) {
        facts.push(isTactic(approachId)
          ? (threats.length ? 'The current tactic has no workable target from here.' : 'No adversary in sight right now.')
          : 'The current approach has no target left: everything reachable is explored.');
      } else {
        const before = toTarget.get(here), after = toTarget.get(dest);
        if (sameCell(dest, target.cell)) facts.push('Reaches the current approach target.');
        else if (after < before) facts.push(`Gets closer to the approach target (${plural(after, 'step')} left).`);
        else if (after > before) facts.push(`Gets farther from the approach target (${plural(after, 'step')} after this).`);
        else facts.push('Keeps the same distance to the approach target.');
      }
    }

    // Is there anything left past this cell without coming back this way?
    if (!reveal || threats.length) {
      const beyond = knownDistances(game, dest, here);
      const explorable = beyond.order.some((c) => isFrontier(game, c)) || (t && beyond.has(t));
      if (threats.length) {
        // Cornered = nothing unexplored past it and no known loop back around the explorer.
        const loops = otherExits(dest).some((n) => beyond.has(n));
        if (!explorable && !loops) facts.push('Leads into a known dead end: risk of being cornered.');
        else if (!reveal) facts.push(explorable ? 'Leads towards unexplored space.' : 'Leads into a known dead end with nothing left to explore.');
      } else {
        facts.push(explorable ? 'Leads towards unexplored space.' : 'Leads into a known dead end with nothing left to explore.');
      }
    }
    out[dir] = facts.join(' ');
  }
  if (legalMoves(game).length) out[STAY] = stayFacts(game, approachId, threats, minGap);
  return out;
}
