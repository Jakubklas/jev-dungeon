// What an adversary's brain is allowed to see, written as plain-language facts.
// Code observes; Jev decides.
//
// ADVERSARY FOG OF WAR. Everything is read through an AdversaryView (adversary-view.js), never a Game.
// In `full` mode adversaries know the real map (tiles, rooms), their own position, the
// other adversaries' positions and what each is doing (pursuing, searching or patrolling). They know the explorer's position ONLY while seesExplorer is true.
// Out of sight they know `last_seen` only: the cell, how many ticks ago, and the heading frozen at
// that moment (hunt.heading, never recomputed from the explorer's trail). Everything below that reads
// the explorer's cell (view.explorer()) is guarded by `hunt.inSight`, which brain.js sets from seesExplorer for this tick.
// Never read here: the treasure, the explorer's light/visits/trail, other adversaries' sightings.
import { DIRS } from '../../dungeon.js';
import { freshness } from './memory.js';

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

let SWEEP_RADIUS = 10; // default path steps around last_seen that sweep_last_seen searches (per ghost: hunt.profile.sweepRadius)
let CUT_MIN = 3;
let CUT_MAX = 24; // default path steps from last_seen for cut-off candidates (per ghost: hunt.profile.cutMax)
let SURROUND_REACH = 24; // path steps the surroundings facts look at

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stepCell = ([x, y], dir) => [x + DIRS[dir][0], y + DIRS[dir][1]];

const COMPASS8 = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
export function compass8([ax, ay], [bx, by]) {
  const angle = Math.atan2(ay - by, bx - ax); // y points down, so flip it
  return COMPASS8[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

export { stepCell };

// Marks everything in view as checked (search mode).
export function sweep(view, hunt) {
  for (const c of view.cellsInView()) hunt.swept.add(key(c));
}

// The cut-off point: a doorway or junction ahead of the explorer's heading from last_seen.
// Uses only last_seen, the frozen heading and the real map. Computed once per loss of sight.
export function cutOffPoint(view, lastSeen, heading, cutMax = CUT_MAX) {
  const fromSeen = view.distancesFrom(lastSeen);
  const h = heading ? DIRS[heading] : null;
  let best = null;
  for (const [k, d] of fromSeen) {
    if (d < CUT_MIN || d > cutMax) continue;
    const c = k.split(',').map(Number);
    const kind = view.kindOf(c).kind;
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
function sweepPoint(view, hunt, lastSeen, fromMe) {
  const fromSeen = view.distancesFrom(lastSeen);
  let best = null;
  for (const [k, d] of fromSeen) {
    if (d > (hunt.profile?.sweepRadius ?? SWEEP_RADIUS) || hunt.swept.has(k)) continue;
    const mine = fromMe.get(k);
    if (mine === undefined) continue;
    const score = d + mine;
    if (!best || score < best.score || (score === best.score && mine < best.steps)) best = { cell: k.split(',').map(Number), steps: mine, score };
  }
  return best && { cell: best.cell, steps: best.steps };
}

// Where an approach leads right now: { cell, steps, what } | null. In limited mode a last-seen cell with no
// known route from here turns every search approach into "head for the edge of what you know, toward it".
export function approachTarget(view, a, hunt, approachId, fromMe = view.distancesFrom(a.pos)) {
  if (view.mode === 'limited' && approachId !== 'direct_pursuit' && a.lastSeen && !fromMe.has(key(a.lastSeen))) {
    const f = view.frontierToward(a.lastSeen, fromMe);
    if (f) return { cell: f.cell, steps: f.steps, what: 'the edge of what you know, toward the last-seen cell' };
  }
  return knownApproachTarget(view, a, hunt, approachId, fromMe);
}

function knownApproachTarget(view, a, hunt, approachId, fromMe) {
  if (approachId === 'direct_pursuit') {
    const explorer = view.explorer();
    if (!hunt.inSight || !explorer) return null;
    return { cell: explorer, steps: fromMe.get(key(explorer)), what: 'the explorer' };
  }
  if (!a.lastSeen) return null;
  if (approachId === 'cut_off') {
    hunt.cutOff ??= cutOffPoint(view, a.lastSeen, hunt.heading, hunt.profile?.cutMax);
    const c = hunt.cutOff;
    return { cell: [...c.cell], steps: fromMe.get(key(c.cell)), what: `the cut-off point (a ${c.kind})` };
  }
  if (approachId === 'sweep_last_seen') {
    const s = sweepPoint(view, hunt, a.lastSeen, fromMe);
    return s ? { ...s, what: 'the nearest unchecked spot near the last-seen cell' } : null;
  }
  return null;
}

function trend(before, after, what) {
  if (before === undefined || after === undefined) return null;
  return `Path distance to ${what} ${before} → ${after}.`;
}

let COVER_RADIUS = 12; // explorer path steps around it that "coverage" looks at

// Cells the explorer can reach within COVER_RADIUS steps where `ghost` (at `at`) would be waiting:
// it gets there no later than the explorer does (1/speed ticks per step against 1). Returns a Set.
function coveredCells(view, at, explorerDist, speed) {
  const mine = view.distancesFrom(at);
  const out = new Set();
  for (const [k, e] of explorerDist) {
    const m = mine.get(k);
    if (e <= COVER_RADIUS && m !== undefined && m / speed <= e) out.add(k);
  }
  return out;
}

// Plain-language facts about each legal move, for Jev to judge. `approachIds` are the approaches
// to judge against: the current one, or both search approaches on the step that picks one.
export function describeMoves(view, a, hunt, approachIds, speed = 0.6) {
  const here = a.pos;
  const explorer = hunt.inSight ? view.explorer() : null;
  const fromMe = view.distancesFrom(here);
  const toExplorer = explorer ? view.distancesFrom(explorer) : null;
  const toSeen = !hunt.inSight && a.lastSeen ? view.distancesFrom(a.lastSeen) : null;
  const targets = approachIds
    .filter((id) => id !== 'direct_pursuit')
    .map((id) => ({ id, t: approachTarget(view, a, hunt, id, fromMe) }))
    .filter((x) => x.t)
    .map((x) => ({ ...x, dist: view.distancesFrom(x.t.cell) }));
  const unchecked = (c) => view.cellsInView(c).filter((v) => !hunt.swept.has(key(v))).length;
  const out = {};
  // In sight: which of the explorer's reachable cells the other adversaries already cover, so a
  // move can be judged by the escape routes it newly cuts (a pincer) rather than by distance alone.
  let reach = null, others = null;
  if (hunt.inSight) {
    reach = new Map([...toExplorer].filter(([, e]) => e <= COVER_RADIUS));
    others = new Set();
    for (const o of view.teammates()) {
      for (const k of coveredCells(view, o.pos, reach, speed)) others.add(k);
    }
  }

  for (const dir of view.legalMoves()) {
    const dest = stepCell(here, dir);
    const facts = [];
    if (hunt.inSight) {
      if (same(dest, explorer)) {
        out[dir] = 'Steps onto the explorer: only a bump (nobody is hurt and you are knocked back). The claw strike is what hurts it.';
        continue;
      }
      facts.push(trend(toExplorer.get(key(here)), toExplorer.get(key(dest)), 'the explorer'));
      if (view.mode === 'limited' && !toExplorer.has(key(here))) facts.push('No known route to the explorer from here.');
      const sees = view.seesExplorerFrom(dest);
      facts.push(sees ? 'Keeps the explorer in sight.' : 'Loses sight of the explorer.');
      const cover = coveredCells(view, dest, reach, speed);
      const fresh = [...cover].filter((k) => !others.has(k)).length;
      facts.push(`Cuts off ${cover.size} of the ${reach.size} cells the explorer can reach within ${COVER_RADIUS} steps (you get there first), ${fresh} of them not already covered by other adversaries.`);
    } else {
      if (toSeen) facts.push(trend(toSeen.get(key(here)), toSeen.get(key(dest)), 'the last-seen cell'));
      for (const { id, t, dist } of targets) {
        if (same(dest, t.cell)) facts.push(`Reaches ${t.what} (${id}).`);
        else facts.push(trend(dist.get(key(here)), dist.get(key(dest)), `${t.what} (${id})`));
      }
      const n = unchecked(dest);
      facts.push(n ? `Brings ${plural(n, 'unchecked cell')} into view.` : 'Brings nothing unchecked into view.');
    }
    const k = view.kindOf(dest);
    if (k.kind === 'corridor') facts.push('Stands in a corridor: blocks it.');
    else if (k.kind === 'junction') facts.push(`Stands on a junction with ${k.exits} exits: blocks it.`);
    else if (k.kind === 'doorway') facts.push('Stands in a doorway of a room: blocks it.');
    else if (k.kind === 'dead end') facts.push('Steps into a dead end.');
    else facts.push('Room floor.');
    out[dir] = facts.filter(Boolean).join(' ');
  }
  return out;
}

const NEAR_DEAD_END = 5; // path steps that dead_ends_within_5 looks at

// The place around the adversary, from the real map (adversaries know it): what its cell is, how many
// ways lead out, the nearest doorway or junction and how many dead ends lie within a few steps.
export function surroundings(view, pos, fromMe = view.distancesFrom(pos)) {
  const here = view.kindOf(pos);
  let near = null, deadEnds = 0;
  for (const [k, steps] of fromMe) {
    if (steps === 0 || steps > SURROUND_REACH) continue;
    const c = k.split(',').map(Number);
    const kind = view.kindOf(c).kind;
    if (kind === 'dead end' && steps <= NEAR_DEAD_END) deadEnds++;
    if ((kind === 'doorway' || kind === 'junction') && (!near || steps < near.steps)) near = { cell: c, steps, kind };
  }
  return {
    here: here.kind,
    exits: here.exits,
    nearest_junction_or_doorway: near && { direction: compass8(pos, near.cell), path_steps: near.steps },
    dead_ends_within_5: deadEnds,
  };
}

// The other adversaries. Their role is shared on purpose (the pack already calls for help); their
// sightings and the explorer's position are not.
export function team(view, a, fromMe) {
  return view.teammates().map((o) => ({
    id: o.id,
    direction: compass8(a.pos, o.pos),
    path_steps: fromMe.get(key(o.pos)) ?? null,
    role: o.role,
  }));
}

// Smart memory (adversaryCharacters on): the packmates this ghost can hear (within its alert reach, by path)
// or see, nearest 4, each with the freshest report from its own sightings (called, never shared state);
// every other packmate is only counted. A report carries no cell, only where it lies from here.
function teamMemory(view, a, fromMe, tick) {
  const p = a.profile;
  const inView = new Set(view.cellsInView().map(key));
  const known = view.teammates().map((o) => ({ o, d: fromMe.get(key(o.pos)) })).filter(({ o, d }) => (d !== undefined && d <= p.alertSteps) || inView.has(key(o.pos)));
  known.sort((x, y) => (x.d ?? Infinity) - (y.d ?? Infinity) || x.o.id.localeCompare(y.o.id, 'en', { numeric: true }));
  const out = known.slice(0, 4).map(({ o, d }) => {
    const e = { id: o.id, direction: compass8(a.pos, o.pos), path_steps: d ?? null, role: o.role };
    const s = o.sighting;
    if (s && tick - s.tick <= p.sightingTtl) {
      e.report = { source: `called by ${o.id}`, ticks_ago: tick - s.tick, freshness: freshness(tick - s.tick, p.sightingTtl), direction: bearing(a.pos, s.cell), path_steps: fromMe.get(key(s.cell)) ?? null };
    }
    return e;
  });
  const others = view.teammateCount() - out.length;
  if (others > 0) out.push({ others });
  return out;
}

const bearing = (from, to) => (same(from, to) ? 'here' : compass8(from, to));

// What the ghost remembers, made relative to where it stands now: its landmarks and the explorer sightings.
function landmarksFacts(a, fromMe, tick) {
  const p = a.profile;
  return a.memory.landmarks.map((l) => ({
    kind: l.kind, direction: bearing(a.pos, l.cell), path_steps: fromMe.get(key(l.cell)) ?? null,
    ...(l.kind === 'home' ? {} : { ticks_ago: tick - l.tick, freshness: freshness(tick - l.tick, p.landmarkTtl) }),
  }));
}

function sightingFacts(a, fromMe, tick) {
  const p = a.profile;
  const list = a.memory.sightings.map((s) => ({
    ticks_ago: tick - s.tick, freshness: freshness(tick - s.tick, p.sightingTtl), direction: bearing(a.pos, s.cell),
    path_steps: fromMe.get(key(s.cell)) ?? null, heading: s.heading, source: s.source,
  }));
  const cells = a.memory.sightings.map((s) => s.cell);
  let trail = null;
  if (cells.length >= 2) {
    const newest = cells[0], oldest = cells.at(-1);
    trail = `heading ${compass8(oldest, newest)} over the last ${cells.length} sightings`;
  }
  return { list, trail };
}

// The facts Jev reads that come from the map (brain.js adds the memory part). In search mode nothing
// here depends on the explorer's position.
export function situation(view, a, hunt, { smart = false, tick = 0 } = {}) {
  const fromMe = view.distancesFrom(a.pos);
  const explorer = hunt.inSight ? view.explorer() : null;
  const s = {
    position: [...a.pos],
    surroundings: surroundings(view, a.pos, fromMe),
    explorer: explorer
      ? {
          in_sight: true,
          position: explorer,
          direction: compass8(a.pos, explorer),
          path_steps: fromMe.get(key(explorer)) ?? null,
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
    team: smart ? teamMemory(view, a, fromMe, tick) : team(view, a, fromMe),
  };
  if (smart) {
    s.surroundings.landmarks = landmarksFacts(a, fromMe, tick);
    if (view.mode === 'limited') s.surroundings.map_note = `known: ${view.knownCount()} cells, home zone + seen`;
    if (!explorer) {
      const { list, trail } = sightingFacts(a, fromMe, tick);
      s.explorer.sightings = list;
      if (trail) s.explorer.trail = trail;
    }
  }
  const t = approachTarget(view, a, hunt, hunt.memory.approach.id, fromMe);
  if (!hunt.inSight) {
    s.approach_target = t ? { what: t.what, cell: t.cell, path_steps: t.steps ?? null, direction: compass8(a.pos, t.cell) } : null;
    s.checked_cells_near_last_seen = a.lastSeen ? countSwept(view, hunt, a.lastSeen) : null;
  }
  return s;
}

function countSwept(view, hunt, lastSeen) {
  const radius = hunt.profile?.sweepRadius ?? SWEEP_RADIUS;
  let checked = 0, total = 0;
  for (const [k, steps] of view.distancesFrom(lastSeen)) {
    if (steps > radius) continue;
    total++;
    if (hunt.swept.has(k)) checked++;
  }
  return `${checked} of ${total} floor cells within ${radius} steps`;
}

// A search-approach option for Jev: what it means plus where it would lead from here.
export function approachOption(view, a, hunt, id) {
  const t = approachTarget(view, a, hunt, id);
  const where = t
    ? ` Target: ${t.what}, ${compass8(a.pos, t.cell)}, ${t.steps === undefined ? 'unreachable' : plural(t.steps, 'step')} away.`
    : ' No target left: everything near the last-seen cell is checked.';
  return APPROACHES[id].text + where;
}

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen at once.
export function configureAdversaryPerception(o) {
  if (o.advSweepRadius !== undefined) SWEEP_RADIUS = o.advSweepRadius;
  if (o.advCutMin !== undefined) CUT_MIN = o.advCutMin;
  if (o.advCutMax !== undefined) CUT_MAX = o.advCutMax;
  if (o.advSurroundReach !== undefined) SURROUND_REACH = o.advSurroundReach;
  if (o.advCoverRadius !== undefined) COVER_RADIUS = o.advCoverRadius;
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const adversaryPerceptionSnapshot = () => ({ advSweepRadius: SWEEP_RADIUS, advCutMin: CUT_MIN, advCutMax: CUT_MAX, advSurroundReach: SURROUND_REACH, advCoverRadius: COVER_RADIUS });
