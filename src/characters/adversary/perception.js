// What an adversary's brain is allowed to see, written as plain-language facts.
// Code observes; Jev decides.
//
// ADVERSARY FOG OF WAR. Adversaries know the real map (tiles, rooms), their own position and the
// other adversaries' positions. They know the explorer's position ONLY while seesExplorer is true.
// Out of sight they know `last_seen` only: the cell, how many ticks ago, and the heading frozen at
// that moment (hunt.heading, never recomputed from game.trail). Everything below that reads
// game.pos is guarded by `hunt.inSight`, which brain.js sets from seesExplorer for this tick.
// Never read here: the treasure, the explorer's light/visits/trail, other adversaries' modes or
// sightings.
import { DIRS, SIGHT_RANGE, floorDistances, hasLineOfSight, isFloor } from '../../dungeon.js';

export const APPROACHES = {
  direct_pursuit: { text: 'The explorer is in sight: close the path distance to it as fast as possible and keep it in view.' },
  cut_off: {
    text: 'Head for the junction or corridor the explorer most likely passes through next, judged from its heading when last seen, and block it.',
  },
  sweep_last_seen: {
    text: 'Go to where the explorer was last seen and search outward from there, bringing nearby rooms and corridors not checked yet into view.',
  },
};
export const SEARCH_APPROACHES = ['cut_off', 'sweep_last_seen'];

const SWEEP_RADIUS = 10; // path steps around last_seen that sweep_last_seen searches
const CUT_MIN = 3, CUT_MAX = 24; // path steps from last_seen for cut-off candidates

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stepCell = ([x, y], dir) => [x + DIRS[dir][0], y + DIRS[dir][1]];
const neighbours = (dungeon, c) => Object.keys(DIRS).map((d) => stepCell(c, d)).filter((n) => isFloor(dungeon, n));

const COMPASS8 = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
export function compass8([ax, ay], [bx, by]) {
  const angle = Math.atan2(ay - by, bx - ax); // y points down, so flip it
  return COMPASS8[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

// Legal directions for an adversary: onto real floor.
export function adversaryMoves(dungeon, pos) {
  return Object.keys(DIRS).filter((d) => isFloor(dungeon, stepCell(pos, d)));
}
export { stepCell };

const inRoom = (dungeon, [x, y]) => (dungeon.rooms ?? []).some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

// What kind of place a cell is, from the real map.
export function cellKind(dungeon, c) {
  const exits = neighbours(dungeon, c);
  if (inRoom(dungeon, c)) return { kind: 'room', exits: exits.length };
  if (exits.some((n) => inRoom(dungeon, n))) return { kind: 'doorway', exits: exits.length };
  if (exits.length >= 3) return { kind: 'junction', exits: exits.length };
  return { kind: exits.length === 2 ? 'corridor' : 'dead end', exits: exits.length };
}

// Floor cells this adversary sees from `pos` (same sight rule as seesExplorer).
export function cellsInView(dungeon, pos) {
  const out = [];
  const R = SIGHT_RANGE;
  for (let y = pos[1] - R; y <= pos[1] + R; y++) {
    for (let x = pos[0] - R; x <= pos[0] + R; x++) {
      const c = [x, y];
      if (euclid(pos, c) <= R && isFloor(dungeon, c) && hasLineOfSight(dungeon, pos, c)) out.push(c);
    }
  }
  return out;
}

// Marks everything in view as checked (search mode).
export function sweep(dungeon, hunt, pos) {
  for (const c of cellsInView(dungeon, pos)) hunt.swept.add(key(c));
}

// The cut-off point: a doorway or junction ahead of the explorer's heading from last_seen.
// Uses only last_seen, the frozen heading and the real map. Computed once per loss of sight.
export function cutOffPoint(dungeon, lastSeen, heading) {
  const fromSeen = floorDistances(dungeon, lastSeen);
  const h = heading ? DIRS[heading] : null;
  let best = null;
  for (const [k, d] of fromSeen) {
    if (d < CUT_MIN || d > CUT_MAX) continue;
    const c = k.split(',').map(Number);
    const kind = cellKind(dungeon, c).kind;
    if (kind !== 'doorway' && kind !== 'junction') continue;
    const len = euclid(c, lastSeen) || 1;
    const align = h ? ((c[0] - lastSeen[0]) * h[0] + (c[1] - lastSeen[1]) * h[1]) / len : 0; // -1..1
    const score = align * 10 - d * 0.3;
    if (!best || score > best.score) best = { cell: c, score, kind };
  }
  return best ? { cell: best.cell, kind: best.kind } : { cell: [...lastSeen], kind: 'last-seen cell' };
}

// An unchecked floor cell within SWEEP_RADIUS of last_seen, searching outward from last_seen:
// the one with the lowest (steps from last_seen + steps from the adversary).
function sweepPoint(dungeon, hunt, lastSeen, fromMe) {
  const fromSeen = floorDistances(dungeon, lastSeen);
  let best = null;
  for (const [k, d] of fromSeen) {
    if (d > SWEEP_RADIUS || hunt.swept.has(k)) continue;
    const mine = fromMe.get(k);
    if (mine === undefined) continue;
    const score = d + mine;
    if (!best || score < best.score || (score === best.score && mine < best.steps)) best = { cell: k.split(',').map(Number), steps: mine, score };
  }
  return best && { cell: best.cell, steps: best.steps };
}

// Where an approach leads right now: { cell, steps, what } | null.
export function approachTarget(game, a, hunt, approachId, fromMe = floorDistances(game.dungeon, a.pos)) {
  const d = game.dungeon;
  if (approachId === 'direct_pursuit') {
    if (!hunt.inSight) return null;
    return { cell: [...game.pos], steps: fromMe.get(key(game.pos)), what: 'the explorer' };
  }
  if (!a.lastSeen) return null;
  if (approachId === 'cut_off') {
    hunt.cutOff ??= cutOffPoint(d, a.lastSeen, hunt.heading);
    const c = hunt.cutOff;
    return { cell: [...c.cell], steps: fromMe.get(key(c.cell)), what: `the cut-off point (a ${c.kind})` };
  }
  if (approachId === 'sweep_last_seen') {
    const s = sweepPoint(d, hunt, a.lastSeen, fromMe);
    return s ? { ...s, what: 'the nearest unchecked spot near the last-seen cell' } : null;
  }
  return null;
}

function trend(before, after, what) {
  if (before === undefined || after === undefined) return null;
  return `Path distance to ${what} ${before} → ${after}.`;
}

// Plain-language facts about each legal move, for Jev to judge. `approachIds` are the approaches
// to judge against: the current one, or both search approaches on the step that picks one.
export function describeMoves(game, a, hunt, approachIds) {
  const d = game.dungeon;
  const here = a.pos;
  const fromMe = floorDistances(d, here);
  const toExplorer = hunt.inSight ? floorDistances(d, game.pos) : null;
  const toSeen = !hunt.inSight && a.lastSeen ? floorDistances(d, a.lastSeen) : null;
  const targets = approachIds
    .filter((id) => id !== 'direct_pursuit')
    .map((id) => ({ id, t: approachTarget(game, a, hunt, id, fromMe) }))
    .filter((x) => x.t)
    .map((x) => ({ ...x, dist: floorDistances(d, x.t.cell) }));
  const unchecked = (c) => cellsInView(d, c).filter((v) => !hunt.swept.has(key(v))).length;
  const out = {};

  for (const dir of adversaryMoves(d, here)) {
    const dest = stepCell(here, dir);
    const facts = [];
    if (hunt.inSight) {
      if (same(dest, game.pos)) {
        out[dir] = 'Steps onto the explorer: hits it (it loses a life, the last one ends the game).';
        continue;
      }
      facts.push(trend(toExplorer.get(key(here)), toExplorer.get(key(dest)), 'the explorer'));
      const sees = euclid(dest, game.pos) <= SIGHT_RANGE && hasLineOfSight(d, dest, game.pos);
      facts.push(sees ? 'Keeps the explorer in sight.' : 'Loses sight of the explorer.');
    } else {
      if (toSeen) facts.push(trend(toSeen.get(key(here)), toSeen.get(key(dest)), 'the last-seen cell'));
      for (const { id, t, dist } of targets) {
        if (same(dest, t.cell)) facts.push(`Reaches ${t.what} (${id}).`);
        else facts.push(trend(dist.get(key(here)), dist.get(key(dest)), `${t.what} (${id})`));
      }
      const n = unchecked(dest);
      facts.push(n ? `Brings ${plural(n, 'unchecked cell')} into view.` : 'Brings nothing unchecked into view.');
    }
    const k = cellKind(d, dest);
    if (k.kind === 'corridor') facts.push('Stands in a corridor: blocks it.');
    else if (k.kind === 'junction') facts.push(`Stands on a junction with ${k.exits} exits: blocks it.`);
    else if (k.kind === 'doorway') facts.push('Stands in a doorway of a room: blocks it.');
    else if (k.kind === 'dead end') facts.push('Steps into a dead end.');
    else facts.push('Room floor.');
    out[dir] = facts.filter(Boolean).join(' ');
  }
  return out;
}

// The situation Jev reads. In search mode nothing here depends on game.pos.
export function situation(game, a, hunt, tick) {
  const d = game.dungeon;
  const fromMe = floorDistances(d, a.pos);
  const k = cellKind(d, a.pos);
  const s = {
    tick,
    you: { id: a.id, position: [...a.pos], here: k.kind, exits: k.exits },
    map: { width: d.width, height: d.height, rooms: (d.rooms ?? []).length },
    explorer: hunt.inSight
      ? {
          in_sight: true,
          position: [...game.pos],
          direction: compass8(a.pos, game.pos),
          path_steps: fromMe.get(key(game.pos)) ?? null,
          heading: hunt.heading,
        }
      : { in_sight: false },
    last_seen: a.lastSeen && !hunt.inSight
      ? {
          cell: [...a.lastSeen],
          ticks_ago: hunt.ticksSinceSeen,
          heading: hunt.heading,
          direction: compass8(a.pos, a.lastSeen),
          path_steps: fromMe.get(key(a.lastSeen)) ?? null,
        }
      : null,
    // Positions only: another adversary's mode or sightings would leak what it knows.
    other_adversaries: (game.adversaries ?? [])
      .filter((o) => o.id !== a.id)
      .map((o) => ({ id: o.id, position: [...o.pos], path_steps: fromMe.get(key(o.pos)) ?? null })),
  };
  const t = approachTarget(game, a, hunt, hunt.memory.approach.id, fromMe);
  if (!hunt.inSight) {
    s.approach_target = t ? { what: t.what, cell: t.cell, path_steps: t.steps ?? null, direction: compass8(a.pos, t.cell) } : null;
    s.checked_cells_near_last_seen = a.lastSeen ? countSwept(d, hunt, a.lastSeen) : null;
  }
  return s;
}

function countSwept(dungeon, hunt, lastSeen) {
  let checked = 0, total = 0;
  for (const [k, steps] of floorDistances(dungeon, lastSeen)) {
    if (steps > SWEEP_RADIUS) continue;
    total++;
    if (hunt.swept.has(k)) checked++;
  }
  return `${checked} of ${total} floor cells within ${SWEEP_RADIUS} steps`;
}

// A search-approach option for Jev: what it means plus where it would lead from here.
export function approachOption(game, a, hunt, id) {
  const t = approachTarget(game, a, hunt, id);
  const where = t
    ? ` Target: ${t.what}, ${compass8(a.pos, t.cell)}, ${t.steps === undefined ? 'unreachable' : plural(t.steps, 'step')} away.`
    : ' No target left: everything near the last-seen cell is checked.';
  return APPROACHES[id].text + where;
}
