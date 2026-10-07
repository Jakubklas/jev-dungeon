// What Jev is allowed to see, written as plain-language facts.
// Code observes; Jev decides. FOG OF WAR: the explorer's KnownWorld is the only window on the
// game, unknown cells are neither wall nor floor, and paths only run over known floor. Past the
// map edge is rock that is known once lit, like any other rock, so nothing here reveals where
// the map ends. Adversaries are read only through world.visibleAdversaries() (the ones the
// explorer sees right now).
//
// Layering: known-map.js (pure known-floor helpers) <- encounter.js (the encounter model:
// safe distances, route survey, hide/slip/escape targets, `threats.encounter` facts) <- this
// file (approaches, tactic feasibility and options, the situation and per-move facts).
//
// Memory of threats (P1a): the brain keeps adversaries it SAW, frozen where they were last seen,
// and passes them in as plain data ({ id, cell, step, chasing }). Nothing here reads an adversary
// that is out of sight; a frozen cell only ever meets the explorer's own position and known cells.
//
// v4 encounters: when an adversary is in sight, `threats.encounter` lists sentiment-free
// facts (space, gap, speed, best route past it, nearest hiding cell, escape spot, dead ends),
// and `tacticOptions(world, minGap)` turns them into the feasible tactics for one sentiment's
// minimum gap. Line of sight there is judged over known tiles only: unknown cells block.

import { LIGHT_RADIUS, STAY } from '../../dungeon.js';
import {
  compass, compass8, euclid, isFrontier, key, knownDistances, knownFloor, neighbours, pick, plural, reachableFrontier, sameCell, step, wouldReveal,
} from './known-map.js';
import {
  FACE_OFF_MIN_SIDE, encounterFacts, escapeTarget, faceOffTarget, goalsAt, hiddenFromAll, isRoomCell, openArea, safeDistances,
  threatDistance, threatsOf,
} from './encounter.js';

// `brief` (tactics) is the short option text Jev reads in the tactic question; `text` is what memory keeps.
// `thought` is the first-person line the UI shows in the explorer's thought bubble (≤ 60 chars).
// Tactics (`tactic: true`) are encounter approaches: chosen in a decision step, never logged in `tried`.
export const APPROACHES = {
  nearest_frontier: { text: 'Explore the closest edge of the known map first, clearing nearby gaps before travelling.', thought: "Let's check the closest dark edge." },
  largest_unexplored: { text: 'Head for the largest dark region, judged by how much unknown space lies in each direction.', thought: 'That big dark patch looks promising.' },
  far_side: { text: 'Travel to the part of the dungeon farthest from where the explorer has already been.', thought: "Let's try the far side of this place." },
  go_to_treasure: { text: 'The chest has been seen: walk the shortest known path to it.', thought: 'The chest! Straight to it.', needsTreasure: true },
  slip_past: {
    text: 'Slip past the adversary: follow a known route around it toward unexplored space, never letting it closer than the minimum gap, using the speed edge.',
    thought: 'I can slip past!', tactic: true, brief: 'Slip past it along a known route, keeping the minimum gap.',
  },
  run_away: { text: 'Run away from the adversary: get away from it, keep escape routes open, and avoid dead ends.', thought: 'Run away!', tactic: true, brief: 'Run away: get clear and keep escape routes open.' },
  face_off: {
    text: 'Face off: hold ground in the open space, keep a safe gap, and dodge around the adversary as it commits (it is slower), then continue.',
    thought: 'Face off.', tactic: true, brief: 'Hold ground in the open and dodge around it as it commits (it is slower).',
  },
  hide: { text: "Duck out of sight: reach a known cell outside the adversary's line of sight before it gets there.", thought: 'Duck out of sight.', tactic: true, brief: 'Get out of its line of sight before it arrives.' },
  race_to_chest: { text: 'Race the adversary to the seen chest along the known path, staying out of its reach.', thought: 'Go for the chest!', tactic: true, needsTreasure: true, brief: 'Race it to the seen chest along the known path.' },
  carry_on: { text: 'The adversary is patrolling and has not seen the explorer: keep exploring, but stay out of its sight.', thought: "It hasn't seen me, keep going.", tactic: true, brief: 'It has not seen you: keep exploring out of its sight.' },
};
export const TACTICS = Object.keys(APPROACHES).filter((id) => APPROACHES[id].tactic);
export const isTactic = (id) => Boolean(APPROACHES[id]?.tactic);

export const DEFAULT_MIN_GAP = 3; // used when no sentiment is given

// Remembered sightings (see the header): a move ending within SIGHTING_NEAR steps of one gets a fact;
// exploration targets keep clear of sightings of the last ZONE_RECENT steps: ZONE_STEPS steps around
// the frozen cell, ZONE_NEAR_STEPS while it is younger than ZONE_FRESH steps (the adversary has had
// less time to leave, and it was heading toward the explorer), and, for a chasing one, the part of the
// known map that lies closer to the sighting than the explorer does (its "sector": the way back).
const SIGHTING_NEAR = 8;
const ZONE_STEPS = 6;
const ZONE_NEAR_STEPS = 10;
const ZONE_FRESH = 10;
const ZONE_RECENT = 15;
const SECTOR_SLACK = 2; // a cell is "behind" a sighting when the route to it via the sighting is at most this much longer
const FACT_SIGHTINGS = 3; // at most this many (the most recent) get a BFS per describeMoves call

// How far (in cells, each way) unexplored_by_direction looks. Fixed, so it never depends on the map size.
const SURVEY_REACH = 12;

// The treasure position is only ever read through KnownWorld.seenTreasure (null until lit).
export function treasureSeen(world) {
  return world.seenTreasure() !== null;
}

// Unknown cells in a fixed window around the explorer (SURVEY_REACH each way), split into
// half-planes. Out-of-map cells count like any other rock: unknown until lit.
function unknownByDirection(world) {
  const [px, py] = world.pos;
  const R = SURVEY_REACH;
  const count = { north: 0, south: 0, east: 0, west: 0 };
  for (let y = py - R; y <= py + R; y++) {
    for (let x = px - R; x <= px + R; x++) {
      if (world.isKnown([x, y])) continue;
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

// Exploration approaches Jev may pick in a review (tactics are offered by tacticOptions).
export function availableApproaches(world) {
  return Object.keys(APPROACHES).filter((id) => !APPROACHES[id].tactic && (!APPROACHES[id].needsTreasure || treasureSeen(world)));
}

// Tactic targets need a visible adversary; without one, the move-on tactics fall back to the
// closest edge of the known map.
function noThreatFallback(world, dist) {
  const best = pick(reachableFrontier(world, dist), (f) => -f.steps * 1000 + wouldReveal(world, f.cell));
  return best ? { ...best, why: `No adversary in sight right now; closest edge of the known map, ${plural(best.steps, 'step')} away.` } : null;
}

// Known cells to keep exploration targets out of (a Set of cell keys, for approachTarget's `avoid`),
// from the brain's frozen sightings of the last ZONE_RECENT steps: within ZONE_NEAR_STEPS known-path
// steps of one younger than ZONE_FRESH, ZONE_STEPS of an older one, plus, for a chasing one (the most
// recent FACT_SIGHTINGS), its sector: every known cell nearer to it than the explorer is, and every
// cell whose shortest route from the explorer runs through (within SECTOR_SLACK steps of) the frozen
// cell. Frozen cells and the explorer's own position only, never where an adversary is now. One BFS
// per sighting plus one from the explorer; `remembered` is the brain's list.
export function avoidZone(world, remembered) {
  const zone = new Set();
  const recent = remembered.filter((r) => world.steps - r.step <= ZONE_RECENT);
  const sector = new Set([...recent].sort((a, b) => b.step - a.step || (a.id < b.id ? -1 : 1)).filter((r) => r.chasing).slice(0, FACT_SIGHTINGS).map((r) => r.id));
  const mine = sector.size ? knownDistances(world, world.pos) : null;
  for (const r of recent) {
    const inSector = sector.has(r.id);
    const radius = world.steps - r.step < ZONE_FRESH ? ZONE_NEAR_STEPS : ZONE_STEPS;
    const dist = knownDistances(world, r.cell, null, inSector ? null : (_, d) => d <= radius);
    const toSpot = mine?.get(r.cell); // the explorer's own distance to the frozen cell
    const here = dist.get(world.pos);
    for (const c of dist.order) {
      const d = dist.get(c);
      if (d <= radius) zone.add(key(c));
      else if (inSector && toSpot !== undefined && here !== undefined && (d < here || toSpot + d <= (mine.get(c) ?? Infinity) + SECTOR_SLACK)) zone.add(key(c));
    }
  }
  return zone;
}

// The recent chasing sightings (the 3 latest) as stand-in threats for run_away while nothing is in sight:
// frozen at the cell where they were seen, never moved.
function frozenThreats(world, remembered) {
  return [...remembered].filter((r) => r.chasing && world.steps - r.step <= ZONE_RECENT)
    .sort((a, b) => b.step - a.step || (a.id < b.id ? -1 : 1)).slice(0, FACT_SIGHTINGS)
    .map((r) => ({ id: r.id, pos: r.cell, chasing: true, dist: knownFloor(world, r.cell) ? knownDistances(world, r.cell) : null }));
}

// `goal` (optional): the cell this tactic was heading for. slip_past, hide and carry_on keep it
// while it stays reachable at the minimum gap (and, for hide, out of sight), so the target does not jump
// around as the explorer moves (the "past the adversary" test depends on where the explorer is).
// `avoid` (optional Set from avoidZone): the exploration approaches skip frontier cells in it
// while any other frontier cell exists.
export function approachTarget(world, approachId, { minGap = DEFAULT_MIN_GAP, goal = null, avoid = null, exclude = null, remembered = [] } = {}) {
  const dist = knownDistances(world, world.pos);

  if (approachId === 'run_away') {
    const threats = threatsOf(world);
    // The adversary slipped out of sight mid-run: keep running from where it was last seen (the frozen
    // sighting, the same record Jev reads as threats.remembered) until the encounter is over, instead of
    // wandering with no target once the escape spot is reached.
    const from = threats.length ? threats : frozenThreats(world, remembered);
    if (!from.length && goal && !sameCell(goal, world.pos) && dist.has(goal)) {
      return { cell: [...goal], steps: dist.get(goal), why: `Keep going to the escape spot to the ${compass(world.pos, goal)}, ${plural(dist.get(goal), 'step')} away.` };
    }
    return escapeTarget(world, dist, from, { goal, exclude, minGap });
  }

  if (isTactic(approachId)) {
    const threats = threatsOf(world);
    const chest = world.seenTreasure();
    if (approachId === 'race_to_chest') {
      if (!chest) return null;
      if (!threats.length) return approachTarget(world, 'go_to_treasure');
      const safe = safeDistances(world, threats, minGap);
      if (!safe.has(chest)) return null;
      return { cell: [...chest], steps: safe.get(chest), why: `The chest is ${plural(safe.get(chest), 'step')} away by a known path that keeps the adversary at least ${plural(minGap, 'step')} off.` };
    }
    if (!threats.length) return approachId === 'hide' ? null : noThreatFallback(world, dist);
    if (approachId === 'face_off') return faceOffTarget(world, threats, minGap, openArea(world));
    const safe = safeDistances(world, threats, minGap);
    const goals = goalsAt(world, threats, safe);
    if (goal && !sameCell(goal, world.pos) && safe.has(goal)) {
      const kept = { cell: [...goal], steps: safe.get(goal) };
      // A route goal stays good while reachable (walking toward it lights it up, so it soon stops
      // being an edge); a hiding cell must still be out of sight.
      const stillGood = approachId !== 'hide' || hiddenFromAll(world, threats, goal);
      if (stillGood) goals[approachId === 'slip_past' ? 'slip' : approachId === 'hide' ? 'hide' : 'frontier'] = kept;
    }
    if (approachId === 'slip_past') {
      const g = goals.slip;
      if (!g) return null;
      const to = chest && sameCell(g.cell, chest) ? 'to the chest' : 'toward unexplored space';
      return { ...g, why: `Route past the adversary ${to}, ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}, keeping at least ${plural(minGap, 'step')} between you.` };
    }
    if (approachId === 'hide') {
      const g = goals.hide;
      if (!g) return null;
      return { ...g, why: `Cell out of the adversary's sight, ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}, reached while keeping at least ${plural(minGap, 'step')} between you.` };
    }
    // carry_on
    const g = goals.frontier;
    if (!g) return null;
    const hidden = hiddenFromAll(world, threats, g.cell);
    return { ...g, why: `Edge of the known map ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}${hidden ? ', out of the adversary\'s sight' : ''}.` };
  }

  const frontier = reachableFrontier(world, dist);

  if (approachId === 'go_to_treasure') {
    const t = world.seenTreasure();
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
  const open = avoid?.size ? frontier.filter((f) => !avoid.has(key(f.cell))) : frontier;
  const cands = open.length ? open : frontier;

  if (approachId === 'largest_unexplored') {
    // Score each edge by the dark space around it (fixed as the explorer walks), minus a
    // travel cost: walking towards the chosen edge makes it cheaper, so it stays chosen.
    const best = pick(cands, (f) => wouldReveal(world, f.cell, LIGHT_RADIUS * 2) - 4 * f.steps);
    return { ...best, why: `Edge of the largest dark region, to the ${compass(world.pos, best.cell)}, ${plural(best.steps, 'step')} away.` };
  }

  if (approachId === 'far_side') {
    // Farthest edge from the average of every cell visited so far.
    const visited = Object.keys(world.visits).map((k) => k.split(',').map(Number));
    const cx = visited.reduce((s, v) => s + v[0], 0) / visited.length;
    const cy = visited.reduce((s, v) => s + v[1], 0) / visited.length;
    // Minus a travel cost (one cell of distance per step) so the target doesn't flip
    // back and forth as that average drifts towards it.
    const best = pick(cands, (f) => Math.round(Math.hypot(f.cell[0] - cx, f.cell[1] - cy) * 10) - 10 * f.steps);
    return { ...best, why: `Edge of the known map farthest from where the explorer has been, to the ${compass(world.pos, best.cell)}, ${plural(best.steps, 'step')} away.` };
  }

  // nearest_frontier (also the fallback for unknown ids): fewest steps, then most to reveal.
  const best = pick(cands, (f) => -f.steps * 1000 + wouldReveal(world, f.cell));
  return { ...best, why: `Closest edge of the known map, ${plural(best.steps, 'step')} away.` };
}

function hereKind(world) {
  if (isRoomCell(world, world.pos)) return 'room';
  const exits = neighbours(world.pos).filter((c) => knownFloor(world, c)).length;
  return exits >= 3 ? 'junction' : exits === 2 ? 'corridor' : 'dead end';
}

// Feasible tactics for a minimum gap, from known cells and visible adversaries only.
// -> { [id]: { target, fact } } (infeasible tactics are left out); empty while nothing is in sight.
export function tacticFeasibility(world, minGap = DEFAULT_MIN_GAP, { exclude = null } = {}) {
  const threats = threatsOf(world);
  if (!threats.length) return {};
  const enc = encounterFacts(world, threats);
  const out = {};
  const s = enc.survey;
  const add = (id, ok) => {
    if (!ok) return;
    const target = approachTarget(world, id, { minGap, exclude });
    // `exclude` (cells a ping-pong bounced between, and the target that led there) rules a tactic out
    // when its only target is one of them; run_away picks another cell by itself.
    if (target && !exclude?.has(key(target.cell))) out[id] = { target, fact: target.why };
  };
  add('slip_past', s.slip && s.slip.gap >= minGap);
  add('run_away', true);
  add('face_off', enc.area && Math.min(enc.area.w, enc.area.h) >= FACE_OFF_MIN_SIDE && enc.facts.gap_now >= minGap);
  add('hide', s.hide && s.hide.gap >= minGap);
  add('race_to_chest', treasureSeen(world) && s.chest && s.chest.gap >= minGap);
  add('carry_on', threats.every((th) => !th.chasing) && s.frontier && s.frontier.gap >= minGap);
  return out;
}

// Choice criteria for the tactic question: { id: what it means + the concrete fact }, in TACTICS order.
export function tacticOptions(world, minGap = DEFAULT_MIN_GAP) {
  const f = tacticFeasibility(world, minGap);
  return Object.fromEntries(TACTICS.filter((id) => f[id]).map((id) => [id, `${APPROACHES[id].brief} ${f[id].fact}`]));
}

// Remembered adversaries (the brain's frozen sightings, not visible now) as Jev reads them: how long
// ago, whether it was chasing, and where that frozen cell lies from the explorer's position now.
function rememberedView(world, dist, remembered) {
  return remembered.map((r) => ({
    id: r.id,
    last_seen_steps_ago: world.steps - r.step,
    was_chasing: r.chasing,
    direction: sameCell(world.pos, r.cell) ? 'here' : compass8(world.pos, r.cell),
    distance: dist.get(r.cell) ?? Math.round(euclid(world.pos, r.cell)),
  }));
}

// Landmarks (memory.landmarks) made relative to the explorer's position, recomputed every tick.
function landmarkView(world, dist, landmarks) {
  return landmarks.map((l) => ({
    kind: l.kind,
    note: l.note,
    direction: sameCell(world.pos, l.cell) ? 'here' : compass8(world.pos, l.cell),
    distance: dist.get(l.cell) ?? Math.round(euclid(world.pos, l.cell)),
    steps_ago: world.steps - l.step,
  }));
}

// The facts about the world right now, grouped the way Jev reads them (brain.js adds game, plan,
// recent and the mind). `remembered` ({ id, cell, step, chasing }, not visible now) and
// `landmarks` (memory.landmarks) are the brain's own records; both are optional.
export function situation(world, { remembered = [], landmarks = [] } = {}) {
  const dist = knownDistances(world, world.pos);
  const t = world.seenTreasure();
  let chest = 'not seen yet';
  if (t) {
    chest = dist.has(t)
      ? `seen, ${plural(dist.get(t), 'step')} away by known path`
      : 'seen, no fully known path yet';
  }
  const unknown = unknownByDirection(world);
  const threats = threatsOf(world);
  return {
    self: {
      lives: world.health, // the explorer's own state: fog-safe
      max_lives: world.maxHealth,
      hit_protection_steps: world.graceLeft, // steps left in which no adversary can hurt it (0 = none)
    },
    surroundings: {
      here: hereKind(world),
      steps: world.steps,
      known_floor_cells: world.knownFloorCount(), // a count, not a %: a % would leak the dungeon's size
      chest,
      unexplored_by_direction: {
        north: amount(unknown.north),
        south: amount(unknown.south),
        east: amount(unknown.east),
        west: amount(unknown.west),
      },
      frontier_cells: reachableFrontier(world, dist).length,
      landmarks: landmarkView(world, dist, landmarks),
    },
    threats: {
      visible: threats.map((th) => ({
        id: th.id,
        direction: compass8(world.pos, th.pos),
        distance: threatDistance(th, world.pos),
        chasing: th.chasing,
      })),
      remembered: rememberedView(world, dist, remembered),
      encounter: encounterFacts(world, threats)?.facts ?? null,
    },
  };
}

function visitSentence(n) {
  if (!n) return 'Never visited.';
  if (n === 1) return 'Visited once.';
  return `Visited ${n} times.`;
}

// What stepping onto an adversary costs: a life (the last one ends the game), or nothing while
// the hit protection after an earlier hit lasts (the adversary is only pushed off the cell).
function touchSentence(world) {
  if (world.graceLeft > 0) return 'Steps into the adversary: no life lost while your hit protection lasts; it is pushed off your cell.';
  if (world.health <= 1) return 'Steps into the adversary: costs your last life and the game is lost.';
  return `Steps into the adversary: costs 1 life (${world.health - 1} of ${world.maxHealth} left) and it is knocked back.`;
}

// Threat sentences for one move, one per visible adversary.
function threatSentences(world, threats, dest, minGap) {
  const facts = [];
  for (const th of threats) {
    if (sameCell(dest, th.pos)) {
      facts.unshift(touchSentence(world));
      continue;
    }
    const where = threats.length > 1 ? ` to the ${compass8(world.pos, th.pos)}` : '';
    const who = th.chasing ? `the chasing adversary${where}` : `an adversary${where}`;
    const before = threatDistance(th, world.pos), after = threatDistance(th, dest);
    const gap = `(${plural(after, 'step')} between you after this${after < minGap ? `, below your minimum gap of ${minGap}` : ''})`;
    if (after > before) facts.push(`Moves away from ${who} ${gap}.`);
    else if (after < before) facts.push(`Moves toward ${who} ${gap}.`);
    else facts.push(`Keeps the same distance from ${who} ${gap}.`);
  }
  return facts;
}

// The remembered sighting nearest to `dest` (within SIGHTING_NEAR known-path steps) as one sentence
// about the move, or null. Judged against the explorer's cell now, so "toward" / "away" is real.
function sightingSentence(world, sightings, here, dest) {
  let best = null;
  for (const s of sightings) {
    const after = s.dist.get(dest);
    if (after === undefined || after > SIGHTING_NEAR) continue;
    if (!best || after < best.after) best = { ...s, after };
  }
  const before = best?.dist.get(here);
  if (before !== undefined) {
    const who = best.r.chasing ? 'a chasing adversary' : 'an adversary';
    const spot = `where ${who} was last seen ${plural(world.steps - best.r.step, 'step')} ago (${plural(best.after, 'step')} from that spot after this)`;
    if (best.after < before) return `Heads toward ${spot}.`;
    if (best.after > before) return `Moves away from ${spot}.`;
    return `Keeps the same distance from ${spot}.`;
  }
  // Farther than SIGHTING_NEAR from every sighting, but a recent chasing one still lies ahead: it was
  // heading for the explorer and may have kept coming, so a move back toward it is worth a warning.
  let back = null;
  for (const s of sightings) {
    const after = s.dist.get(dest), now = s.dist.get(here);
    if (!s.r.chasing || world.steps - s.r.step > ZONE_RECENT || after === undefined || now === undefined || after >= now) continue;
    if (!back || world.steps - s.r.step < world.steps - back.r.step) back = { ...s, after };
  }
  return back ? `Heads back toward where a chasing adversary was ${plural(world.steps - back.r.step, 'step')} ago (${plural(back.after, 'step')} from that spot after this).` : null;
}

// Facts about standing still: nothing is revealed and the position (and every distance) stays put,
// so with an adversary in sight it only lets the gap shrink as the adversary moves.
function stayFacts(world, approachId, threats, minGap) {
  const facts = ['Stands still: reveals nothing.'];
  for (const th of threats) {
    const d = threatDistance(th, world.pos);
    const who = th.chasing ? 'the chasing adversary' : 'an adversary';
    facts.push(`${who[0].toUpperCase()}${who.slice(1)} keeps moving (${plural(d, 'step')} away${d < minGap ? `, below your minimum gap of ${minGap}` : ''}).`);
  }
  if (!threats.length) facts.push('Makes no progress toward the target.');
  return facts.join(' ');
}

// Plain-language facts about each legal move, for Jev to judge.
// The biggest risk for one-step greedy play is walking back and forth, so every
// move states what it reveals, how worn the destination is, and whether it gets
// closer to the current approach's target. Visible adversaries add threat facts,
// judged against the sentiment's minimum gap.
export function describeMoves(world, approachId, opts = {}) {
  return Object.fromEntries(Object.entries(describeMoveParts(world, approachId, opts)).map(([dir, p]) => [dir, p.whole ?? [p.shared, p.target].filter(Boolean).join(' ')]));
}

// The same facts split in two: `shared` (threats, sightings, chest, reveal, visits, dead ends: they do
// not depend on the approach) and `target` (progress toward this approach's target). A move that wins
// has only `whole`. Several tactics asked about the same position can then share one copy of `shared`.
export function describeMoveParts(world, approachId, { minGap = DEFAULT_MIN_GAP, goal = null, avoid = null, exclude = null, remembered = [], prev = null, backAndForth = 0 } = {}) {
  const target = approachId === 'go_to_treasure' ? null : approachTarget(world, approachId, { minGap, goal, avoid, exclude, remembered });
  const toTarget = target ? knownDistances(world, target.cell) : null;
  const t = world.seenTreasure();
  const toTreasure = t ? knownDistances(world, t) : null;
  const threats = threatsOf(world);
  const here = world.pos;
  // When the chest is seen but has no known path, judge moves against the edge nearest it.
  let toNearEdge = null;
  if (t && approachId === 'go_to_treasure' && !toTreasure.has(here)) {
    const near = approachTarget(world, 'go_to_treasure');
    toNearEdge = near ? knownDistances(world, near.cell) : null;
  }
  // One BFS per remembered sighting (the most recent few), shared by every move: never per move.
  const sightings = [...remembered].sort((a, b) => b.step - a.step || (a.id < b.id ? -1 : 1)).slice(0, FACT_SIGHTINGS)
    .map((r) => ({ r, dist: knownDistances(world, r.cell) }));
  const otherExits = (dest) => neighbours(here).filter((n) => !sameCell(n, dest) && knownFloor(world, n));
  const out = {};

  for (const dir of world.legalMoves()) {
    const dest = step(here, dir);
    const facts = [];
    const targetFacts = [];

    if (t && sameCell(dest, t)) {
      out[dir] = { whole: 'Steps onto the treasure chest and wins the game.' };
      continue;
    }
    facts.push(...threatSentences(world, threats, dest, minGap));
    const spot = sightingSentence(world, sightings, here, dest);
    if (spot) facts.push(spot);

    if (t) {
      const before = toTreasure.get(here), after = toTreasure.get(dest);
      if (before !== undefined && after !== undefined) {
        facts.push(after < before
          ? `Closer to the chest (${plural(after, 'step')} left by known path).`
          : `Farther from the chest (${plural(after, 'step')} by known path).`);
      } else if (toNearEdge?.has(here) && toNearEdge.has(dest)) {
        facts.push(toNearEdge.get(dest) < toNearEdge.get(here)
          ? 'No known path to the chest yet; heads for the dark edge nearest it.'
          : 'No known path to the chest yet; leaves the dark edge nearest it.');
      }
    }

    const reveal = wouldReveal(world, dest);
    facts.push(reveal ? `Reveals about ${plural(reveal, 'new cell')}.` : 'Reveals nothing new.');
    facts.push(visitSentence(world.visits[key(dest)]));
    if (prev && sameCell(dest, prev)) {
      facts.push(`Goes back to the cell you left 2 steps ago${backAndForth ? ` (back-and-forth ${plural(backAndForth, 'time')} in the last 6 moves)` : ''}.`);
    }

    if (approachId !== 'go_to_treasure') {
      if (!target) {
        targetFacts.push(isTactic(approachId)
          ? (threats.length ? 'The tactic has no workable target from here.' : 'No adversary in sight right now.')
          : 'No target left: everything reachable is explored.');
      } else {
        const before = toTarget.get(here), after = toTarget.get(dest);
        if (sameCell(dest, target.cell)) targetFacts.push('Reaches the target.');
        else if (after < before) targetFacts.push(`Closer to the target (${plural(after, 'step')} left).`);
        else if (after > before) targetFacts.push(`Farther from the target (${plural(after, 'step')} after this).`);
        else targetFacts.push('Same distance to the target.');
      }
    }

    // Is there anything left past this cell without coming back this way?
    if (!reveal || threats.length) {
      const beyond = knownDistances(world, dest, here);
      const explorable = beyond.order.some((c) => isFrontier(world, c)) || (t && beyond.has(t));
      if (threats.length) {
        // Cornered = nothing unexplored past it and no known loop back around the explorer.
        const loops = otherExits(dest).some((n) => beyond.has(n));
        if (!explorable && !loops) facts.push('Leads into a known dead end: risk of being cornered.');
        else if (!reveal) facts.push(explorable ? 'Leads towards unexplored space.' : 'Leads into a known dead end, nothing left to explore.');
      } else {
        facts.push(explorable ? 'Leads towards unexplored space.' : 'Leads into a known dead end, nothing left to explore.');
      }
    }
    out[dir] = { shared: facts.join(' '), target: targetFacts.join(' ') };
  }
  if (world.legalMoves().length) out[STAY] = { whole: stayFacts(world, approachId, threats, minGap) };
  return out;
}
