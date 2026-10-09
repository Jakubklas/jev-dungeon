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
  blocksOnlyRoute, encounterFacts, engageTarget, escapeTarget, goalsAt, hiddenFromAll, holdGhost, hpText, isRoomCell, strongFact, safeDistances,
  threatDistance, threatsOf,
} from './encounter.js';

// `brief` (tactics) is the short option text Jev reads in the tactic question; `text` is what memory keeps.
// `thought` is the first-person line the UI shows in the explorer's thought bubble (≤ 60 chars).
// Tactics (`tactic: true`) are encounter approaches: chosen in a decision step, never logged in `tried`.
export const APPROACHES = {
  nearest_frontier: { text: 'Explore the closest edge of the known map first, clearing nearby gaps before travelling.', thought: "Let's check the closest dark edge." },
  largest_unexplored: { text: 'Head for the largest dark region, judged by how much unknown space lies in each direction.', thought: 'That big dark patch looks promising.' },
  far_side: { text: 'Travel to the part of the dungeon farthest from where the explorer has already been.', thought: "Let's try the far side of this place." },
  collect_coins: { text: 'Go for the best seen pile of coins: coins are the score, so a detour for them can pay.', thought: 'Coins! Worth the detour.', needsCoins: true },
  heal: { text: 'Go for the nearest seen heart: it restores a life, and you are hurt.', thought: 'A heart! I need that.', needsHeart: true },
  go_to_exit: { text: 'Win through the seen portal: follow the shortest known path, clearing enemies in the way or slipping past them.', thought: 'The portal! Go for the win.', needsExit: true },
  slip_past: {
    text: 'Slip past the enemy: follow a known route around it toward unexplored space, never letting it closer than the minimum gap, using the speed edge.',
    thought: 'I can slip past!', tactic: true, brief: 'Slip past it along a known route, keeping the minimum gap.',
  },
  run_away: { text: 'Pull back to recover or reposition, keeping escape routes open; then resume advancing toward the portal. Retreat alone cannot win.', thought: 'Regroup, then press forward.', tactic: true, brief: 'Pull back to recover or reposition, then advance again.' },
  engage: {
    text: 'Engage: fight the enemy with the sword: let a hunting one step next to you and strike first, close in on one you stunned, until it is dispelled or the way is clear.',
    thought: 'Have at you!', tactic: true, brief: 'Fight it with the sword: let it step in, strike first.',
  },
  hide: { text: "Duck out of sight: reach a known cell outside the enemy's line of sight before it gets there.", thought: 'Duck out of sight.', tactic: true, brief: 'Get out of its line of sight before it arrives.' },
  race_to_exit: { text: 'Win by reaching the seen portal along the known path before the enemy can stop you.', thought: 'Go for the portal!', tactic: true, needsExit: true, brief: 'Reach the seen portal along the known path and win.' },
  carry_on: { text: 'The enemy is patrolling and has not seen the explorer: keep exploring, but stay out of its sight.', thought: "It hasn't seen me, keep going.", tactic: true, brief: 'It has not seen you: keep exploring out of its sight.' },
};
export const TACTICS = Object.keys(APPROACHES).filter((id) => APPROACHES[id].tactic);
export const isTactic = (id) => Boolean(APPROACHES[id]?.tactic);

export let DEFAULT_MIN_GAP = 3; // used when no sentiment is given

// Remembered sightings (see the header): a move ending within SIGHTING_NEAR steps of one gets a fact;
// exploration targets keep clear of sightings of the last ZONE_RECENT steps: ZONE_STEPS steps around
// the frozen cell, ZONE_NEAR_STEPS while it is younger than ZONE_FRESH steps (the adversary has had
// less time to leave, and it was heading toward the explorer), and, for a chasing one, the part of the
// known map that lies closer to the sighting than the explorer does (its "sector": the way back).
let SIGHTING_NEAR = 8;
let ZONE_STEPS = 6;
let ZONE_NEAR_STEPS = 10;
let ZONE_FRESH = 10;
let ZONE_RECENT = 15;
let SECTOR_SLACK = 2; // a cell is "behind" a sighting when the route to it via the sighting is at most this much longer
let COIN_NEAR = 8; // a seen pile this many known-path steps away or less gets a toward fact on each move that closes in
let FACT_SIGHTINGS = 3; // at most this many (the most recent) get a BFS per describeMoves call

// How far (in cells, each way) unexplored_by_direction looks. Fixed, so it never depends on the map size.
let SURVEY_REACH = 12;

// The portal position is only ever read through KnownWorld.seenTreasure (null until lit).
export function exitSeen(world) {
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
  const coins = Object.values(APPROACHES).some((a) => a.needsCoins) ? coinTarget(world, knownDistances(world, world.pos)) : null;
  const heart = heartTarget(world, knownDistances(world, world.pos));
  return Object.keys(APPROACHES).filter((id) => !APPROACHES[id].tactic && (!APPROACHES[id].needsExit || exitSeen(world)) && (!APPROACHES[id].needsCoins || coins) && (!APPROACHES[id].needsHeart || heart));
}

// The heart `heal` heads for: the nearest seen heart by known path (ties (y, x)), only while hurt (a heart is used up only
// when it heals, so a full-health explorer is never told about them). `avoid` is skipped while another heart is reachable.
// Returns { cell, steps, why } or null. Lit hearts only (KnownWorld.seenHearts).
export function heartTarget(world, dist, avoid = null) {
  if (world.health >= world.maxHealth) return null;
  const reach = world.seenHearts().filter((c) => dist.has(c)).map((c) => ({ cell: c, steps: dist.get(c) }));
  const open = avoid?.size ? reach.filter((h) => !avoid.has(key(h.cell))) : reach;
  const cands = open.length ? open : reach;
  cands.sort((a, b) => a.steps - b.steps || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
  const best = cands[0];
  return best && { cell: [...best.cell], steps: best.steps, why: `A seen heart that restores a life, ${plural(best.steps, 'step')} to the ${compass(world.pos, best.cell)} by known path.` };
}

// Seen coin piles (lit cells only) as { cell, count } per cell, other than the cell the explorer stands on.
function seenPiles(world) {
  const piles = new Map();
  for (const c of world.seenCoins()) {
    if (sameCell(c, world.pos)) continue;
    const k = key(c);
    piles.set(k, { cell: c, count: (piles.get(k)?.count ?? 0) + 1 });
  }
  return [...piles.values()];
}

// The pile collect_coins heads for: the best coins per known-path step (the portal is a wall), ties by fewer
// steps, then (y, x). `avoid` (Set from avoidZone) is skipped while any other pile is reachable.
// Returns { cell, steps, count, why } or null. `dist` is knownDistances from the explorer.
function coinTarget(world, dist, avoid = null) {
  const reach = seenPiles(world).filter((p) => dist.has(p.cell)).map((p) => ({ ...p, steps: dist.get(p.cell) }));
  const open = avoid?.size ? reach.filter((p) => !avoid.has(key(p.cell))) : reach;
  const cands = open.length ? open : reach;
  let best = null;
  for (const p of cands) {
    if (!best || p.count * best.steps > best.count * p.steps ||
      (p.count * best.steps === best.count * p.steps && (p.steps < best.steps || (p.steps === best.steps && (p.cell[1] < best.cell[1] || (p.cell[1] === best.cell[1] && p.cell[0] < best.cell[0])))))) best = p;
  }
  return best && { cell: [...best.cell], steps: best.steps, count: best.count, why: `${plural(best.count, 'seen coin')}, ${plural(best.steps, 'step')} to the ${compass(world.pos, best.cell)} by known path.` };
}

// Seen piles within known-path `reach` steps of the explorer, nearest first: [{ cell, count, steps }].
export function nearbyPiles(world, reach) {
  const dist = knownDistances(world, world.pos);
  return seenPiles(world).filter((p) => dist.has(p.cell) && dist.get(p.cell) <= reach).map((p) => ({ ...p, steps: dist.get(p.cell) }))
    .sort((a, b) => a.steps - b.steps || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
}

// Tactic targets need a visible adversary; without one, the move-on tactics fall back to the
// closest edge of the known map.
function noThreatFallback(world, dist) {
  const best = pick(reachableFrontier(world, dist), (f) => -f.steps * 1000 + wouldReveal(world, f.cell));
  return best ? { ...best, why: `No enemy in sight right now; closest edge of the known map, ${plural(best.steps, 'step')} away.` } : null;
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
// `stunned`: ids the explorer stunned with its own strike (the brain's record), for engage; `fight`: see tacticFeasibility.
export function approachTarget(world, approachId, { minGap = DEFAULT_MIN_GAP, goal = null, avoid = null, exclude = null, remembered = [], stunned = null, fight = null, breakout = null, cornered = false } = {}) {
  // Only the leaving approaches may route through the portal; for all others it is a wall.
  const dist = knownDistances(world, world.pos, null, null, null, approachId === 'go_to_exit');

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
    const exitCell = world.seenTreasure();
    if (approachId === 'race_to_exit') {
      if (!exitCell) return null;
      if (!threats.length) return approachTarget(world, 'go_to_exit');
      const safe = safeDistances(world, threats, minGap, true);
      if (!safe.has(exitCell)) return null;
      return { cell: [...exitCell], steps: safe.get(exitCell), why: `The portal is ${plural(safe.get(exitCell), 'step')} away by a known path that keeps the enemy at least ${plural(minGap, 'step')} off.` };
    }
    if (!threats.length) return approachId === 'hide' ? null : noThreatFallback(world, dist);
    if (approachId === 'engage') return engageTarget(world, threats, { stunned, fight, cornered });
    // Cornered (cornerMode): the breakout route's end is the slip_past target whatever the gap or `exclude`.
    if (breakout && approachId === 'slip_past') return { cell: [...breakout.cell], steps: breakout.steps, why: breakout.why };
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
      const to = 'toward unexplored space';
      return { ...g, why: `Route past the enemy ${to}, ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}, keeping at least ${plural(minGap, 'step')} between you.` };
    }
    if (approachId === 'hide') {
      const g = goals.hide;
      if (!g) return null;
      return { ...g, why: `Cell out of the enemy's sight, ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}, reached while keeping at least ${plural(minGap, 'step')} between you.` };
    }
    // carry_on
    const g = goals.frontier;
    if (!g) return null;
    const hidden = hiddenFromAll(world, threats, g.cell);
    return { ...g, why: `Edge of the known map ${plural(g.steps, 'step')} to the ${compass(world.pos, g.cell)}${hidden ? ', out of the enemy\'s sight' : ''}.` };
  }

  if (approachId === 'collect_coins') return coinTarget(world, dist, avoid);
  if (approachId === 'heal') {
    if (world.health >= world.maxHealth) return null;
    // A heart is a deliberate recovery trip. Keep its destination while it is still lit and
    // reachable, rather than replacing it with whichever heart happens to score best next tick.
    if (goal && !sameCell(goal, world.pos) && dist.has(goal) && world.seenHearts().some((c) => sameCell(c, goal))) {
      return { cell: [...goal], steps: dist.get(goal), why: `Seen heart to the ${compass(world.pos, goal)}, ${plural(dist.get(goal), 'step')} away.` };
    }
    return heartTarget(world, dist, avoid);
  }

  const frontier = reachableFrontier(world, dist);

  if (approachId === 'go_to_exit') {
    const t = world.seenTreasure();
    if (!t) return null;
    if (dist.has(t)) {
      return { cell: [...t], steps: dist.get(t), why: `The portal is ${plural(dist.get(t), 'step')} away by known path.` };
    }
    // Seen, but the way there still crosses dark cells: head for the edge nearest to it.
    const near = pick(frontier, (f) => -Math.hypot(f.cell[0] - t[0], f.cell[1] - t[1]));
    if (!near) return null;
    return { ...near, why: `No fully known path to the portal yet; this edge of the known map is closest to it, ${plural(near.steps, 'step')} away.` };
  }

  // Keep an exploration destination through a temporary encounter. Reaching it may reveal
  // enough that it stops being a frontier; only then do we choose a new edge.
  if (goal && !sameCell(goal, world.pos) && dist.has(goal) && isFrontier(world, goal) && !avoid?.has(key(goal))) {
    return { cell: [...goal], steps: dist.get(goal), why: `Chosen edge of the known map to the ${compass(world.pos, goal)}, ${plural(dist.get(goal), 'step')} away.` };
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
// `armed`: the explorer holds a ready attack skill; engage is offered only then (it ignores the minimum gap:
// closing in is the point).
// `fight` ({ damage, only }, the brain's): engage's fact then says the fight in numbers (see engageTarget).
let HEART_RUN_GAP = 2; // the route to the heart keeps this many steps from every enemy (as run_away's ESCAPE_KEEP_GAP)
// `retreat` false (the mid and high confidence tiers): Jev leans on any safe option it is shown, so pulling back
// (run_away, hide) is left off the menu while a forward tactic (engage, slip_past, carry_on) is open.
// The portal remains a winning tactic. With no forward tactic, or
// `cornered` (cornerMode), nothing is trimmed.
const FORWARD_TACTICS = ['engage', 'slip_past', 'carry_on'];
const RETREAT_TACTICS = ['run_away', 'hide'];
export function tacticFeasibility(world, minGap = DEFAULT_MIN_GAP, { exclude = null, armed = false, stunned = null, fight = null, panic = false, heartRun = false, retreat = true, cornered = null } = {}) {
  const threats = threatsOf(world);
  if (!threats.length) return {};
  const enc = encounterFacts(world, threats);
  const out = {};
  const s = enc.survey;
  const add = (id, ok) => {
    if (!ok) return;
    const target = approachTarget(world, id, { minGap, exclude, stunned, fight, cornered: Boolean(cornered) });
    // `exclude` (cells a ping-pong bounced between, and the target that led there) rules a tactic out
    // when its only target is one of them; run_away picks another cell by itself.
    if (target && !exclude?.has(key(target.cell))) {
      out[id] = { target, fact: target.why };
    }
  };
  add('slip_past', s.slip && s.slip.gap >= minGap);
  add('run_away', true);
  // Low tier or panic and hurt with a heart in reach: run toward the heart, by a route that keeps clear of every enemy.
  if (heartRun && out.run_away && world.health < world.maxHealth) {
    const safe = safeDistances(world, threats, HEART_RUN_GAP);
    const hearts = world.seenHearts().filter((c) => safe.has(c) && !sameCell(c, world.pos) && !exclude?.has(key(c)))
      .map((c) => ({ cell: c, steps: safe.get(c) })).sort((a, b) => a.steps - b.steps || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
    if (hearts[0]) {
      const h = hearts[0];
      const why = `Run to a seen heart that restores a life, ${plural(h.steps, 'step')} to the ${compass(world.pos, h.cell)} by a route that keeps clear of the enemies.`;
      out.run_away = { target: { cell: [...h.cell], steps: h.steps, why }, fact: why };
    }
  }
  if (out.run_away) out.run_away = { ...out.run_away, fact: out.run_away.fact + strongFact(world, threats, fight?.damage) };
  add('engage', armed && (!panic || blocksOnlyRoute(world, threats))); // panic fights only an enemy that shuts the only way out
  add('hide', s.hide && s.hide.gap >= minGap);
  add('race_to_exit', exitSeen(world) && s.exit && s.exit.gap >= minGap);
  add('carry_on', threats.every((th) => !th.chasing) && s.frontier && s.frontier.gap >= minGap);
  // Cornered (cornerMode, brain): slip_past stays on the menu whatever its gap, aimed at the breakout route
  // (`cornered` = { breakout: { cell, steps, why } | null }), and engage stays when armed, panic or not.
  if (cornered) {
    if (cornered.breakout) { const b = cornered.breakout; out.slip_past = { target: { cell: [...b.cell], steps: b.steps, why: b.why }, fact: b.why }; }
    if (armed && !out.engage) add('engage', true);
  }
  if (panic) {
    for (const id of Object.keys(out)) if (!['run_away', 'race_to_exit', 'engage'].includes(id) && !(cornered && id === 'slip_past')) delete out[id]; // panic: run, or take the portal, nothing subtler
  } else if (!retreat && !cornered && FORWARD_TACTICS.some((id) => out[id])) {
    for (const id of RETREAT_TACTICS) delete out[id];
  }
  return out;
}

// Choice criteria for the tactic question: { id: what it means + the concrete fact }, in TACTICS order.
export function tacticOptions(world, minGap = DEFAULT_MIN_GAP) {
  const f = tacticFeasibility(world, minGap);
  return Object.fromEntries(TACTICS.filter((id) => f[id]).map((id) => [id, `${APPROACHES[id].brief} ${f[id].fact}`]));
}

// Remembered adversaries (the brain's frozen sightings, not visible now) as Jev reads them: how long
// ago, whether it was chasing, and where that frozen cell lies from the explorer's position now.
// level and claw_lives beside the health bar (levels on only; off, the request is byte-identical to the game without levels).
const levelFields = (world, th) => (world.levelsOn && th.level != null ? { level: th.level, claw_lives: th.clawDamage } : {});

function rememberedView(world, dist, remembered) {
  return remembered.map((r) => ({
    id: r.id,
    last_seen_steps_ago: world.steps - r.step,
    was_chasing: r.chasing,
    ...(r.hp ? { hp: hpText(r) } : {}), // the health bar as it was at the sighting, frozen like the cell
    ...levelFields(world, r), // its level and claw, frozen likewise
    direction: sameCell(world.pos, r.cell) ? 'here' : compass8(world.pos, r.cell),
    distance: dist.get(r.cell) ?? Math.round(euclid(world.pos, r.cell)),
  }));
}

// Seen coin piles (lit cells only, via KnownWorld.seenCoins), nearest first, at most COIN_PILES of them:
// { coins: [{ direction, distance, count }] }, or {} when none is seen (the key is then left out).
let COIN_PILES = 3;
function coinView(world, dist) {
  const piles = new Map();
  for (const c of world.seenCoins()) {
    const k = key(c);
    piles.set(k, { cell: c, count: (piles.get(k)?.count ?? 0) + 1 });
  }
  const list = [...piles.values()]
    .map((p) => ({ ...p, distance: dist.get(p.cell) ?? Math.round(euclid(world.pos, p.cell)) }))
    .sort((a, b) => a.distance - b.distance || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0])
    .slice(0, COIN_PILES)
    .map((p) => ({ direction: sameCell(world.pos, p.cell) ? 'here' : compass8(world.pos, p.cell), distance: p.distance, count: p.count }));
  return list.length ? { coins: list } : {};
}

// Seen hearts (lit cells only), nearest two, while hurt: { hearts: [{ direction, distance }] }, else {} (the key is left out).
function heartView(world, dist) {
  if (world.health >= world.maxHealth) return {};
  const list = world.seenHearts()
    .map((c) => ({ c, distance: dist.get(c) ?? Math.round(euclid(world.pos, c)) }))
    .sort((a, b) => a.distance - b.distance || a.c[1] - b.c[1] || a.c[0] - b.c[0]).slice(0, 2)
    .map((h) => ({ direction: sameCell(world.pos, h.c) ? 'here' : compass8(world.pos, h.c), distance: h.distance }));
  return list.length ? { hearts: list } : {};
}

// The facts the `leave_now` question states, from this tick's situation `sit`: coins held, lit piles not yet
// taken (count, nearest by known path), the portal's known-path distance, lives, adversaries, what is left
// to explore. All fog-safe: purse, lit piles, known floor, adversaries in sight or remembered.
export function leaveFacts(world, sit) {
  const dist = knownDistances(world, world.pos);
  const piles = world.seenCoins(); // one entry per coin (a stacked pile repeats its cell)
  const near = piles.map((c) => dist.get(c)).filter((d) => d !== undefined).sort((a, b) => a - b)[0];
  const portal = world.seenTreasure();
  const toPortal = portal ? knownDistances(world, world.pos, null, null, null, true) : null;
  const t = portal && toPortal.has(portal) ? `${plural(toPortal.get(portal), 'step')} away` : 'no known path yet';
  const { visible, remembered } = sit.threats;
  return `You hold ${plural(world.coins, 'coin')}; ` +
    (piles.length ? `${plural(piles.length, 'seen coin')} left${near === undefined ? '' : `, nearest ${plural(near, 'step')} away`}; ` : 'no coins seen; ') +
    `portal ${t}; ${world.health} of ${world.maxHealth} lives; ${visible.length} ${visible.length === 1 ? 'enemy' : 'enemies'} in sight, ${remembered.length} remembered; ${plural(sit.surroundings.frontier_cells, 'unexplored edge')}.`;
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
  // The portal's own distance (and its landmark's) may route through it; every other distance treats it as a wall.
  const distX = t ? knownDistances(world, world.pos, null, null, null, true) : dist;
  let exitText = 'not seen yet';
  if (t) {
    exitText = distX.has(t)
      ? `seen, ${plural(distX.get(t), 'step')} away by known path`
      : 'seen, no fully known path yet';
  }
  const unknown = unknownByDirection(world);
  const threats = threatsOf(world);
  return {
    self: {
      lives: world.health, // the explorer's own state: fog-safe
      max_lives: world.maxHealth,
      hit_protection_steps: world.graceLeft, // steps left in which no adversary can hurt it (0 = none)
      coins: world.coins, // its own purse: fog-safe
    },
    surroundings: {
      here: hereKind(world),
      steps: world.steps,
      known_floor_cells: world.knownFloorCount(), // a count, not a %: a % would leak the dungeon's size
      exit: exitText,
      unexplored_by_direction: {
        north: amount(unknown.north),
        south: amount(unknown.south),
        east: amount(unknown.east),
        west: amount(unknown.west),
      },
      frontier_cells: reachableFrontier(world, dist).length,
      landmarks: landmarkView(world, distX, landmarks),
      ...coinView(world, dist),
      ...heartView(world, dist),
    },
    threats: {
      visible: threats.map((th) => ({
        id: th.id,
        direction: compass8(world.pos, th.pos),
        distance: threatDistance(th, world.pos),
        chasing: th.chasing,
        hp: hpText(th),
        ...levelFields(world, th),
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

// What stepping onto an adversary does: only a bump (PLAN-skills D3). A touch costs nothing; the knock goes
// to the adversary, not to the explorer's lives.
const bumpSentence = () => 'Steps into the enemy: only bumps it back, no life lost.';

// What an adversary next to you can do: strike with its claw (costs a life; the last one ends the game), or
// nothing while the hit protection after an earlier hit lasts. Fog-safe: no cooldown or hit points of the ghost.
function clawSentence(world, damage = 1) {
  if (world.graceLeft > 0) return 'An adjacent enemy can strike you, but no life is lost while your hit protection lasts.';
  if (world.health <= damage) return `An adjacent enemy can strike you: its claw costs ${damage} ${damage === 1 ? 'life' : 'lives'} and ends the game.`;
  return `An adjacent enemy can strike you (costs ${damage} ${damage === 1 ? 'life' : 'lives'}, ${world.health - damage} of ${world.maxHealth} left).`;
}

// Threat sentences for one move, one per visible adversary.
function threatSentences(world, threats, dest, minGap) {
  const facts = [];
  for (const th of threats) {
    if (sameCell(dest, th.pos)) {
      facts.unshift(bumpSentence());
      continue;
    }
    const where = threats.length > 1 ? ` to the ${compass8(world.pos, th.pos)}` : '';
    const who = th.chasing ? `the chasing enemy${where}` : `an enemy${where}`;
    const before = threatDistance(th, world.pos), after = threatDistance(th, dest);
    const gap = `(${plural(after, 'step')} between you after this${after < minGap ? `, below your minimum gap of ${minGap}` : ''})`;
    if (after > before) facts.push(`Moves away from ${who} ${gap}.`);
    else if (after < before) facts.push(`Moves toward ${who} ${gap}.`);
    else facts.push(`Keeps the same distance from ${who} ${gap}.`);
    if (th.chasing && after <= 1) facts.push(clawSentence(world, th.clawDamage ?? 1)); // a hunting ghost next to you strikes with its claw
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
    const who = best.r.chasing ? 'a chasing enemy' : 'an enemy';
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
  return back ? `Heads back toward where a chasing enemy was ${plural(world.steps - back.r.step, 'step')} ago (${plural(back.after, 'step')} from that spot after this).` : null;
}

// Facts about standing still: nothing is revealed and the position (and every distance) stays put,
// so with an adversary in sight it only lets the gap shrink as the adversary moves.
function stayFacts(world, approachId, threats, minGap, holding = false) {
  // engage, standing 2 steps from the one hunting adversary it holds against: staying IS the plan (P7a).
  if (holding) return `Holds this cell, 2 steps from ${threats.length > 1 ? 'the nearest' : 'it'}: it steps next to you and you can strike first.`;
  const facts = ['Stands still: reveals nothing.'];
  for (const th of threats) {
    const d = threatDistance(th, world.pos);
    const who = th.chasing ? 'the chasing enemy' : 'an enemy';
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

// The same facts split in two: `shared` (threats, sightings, portal, reveal, visits, dead ends: they do
// not depend on the approach) and `target` (progress toward this approach's target). A move that wins
// has only `whole`. Several tactics asked about the same position can then share one copy of `shared`.
export function describeMoveParts(world, approachId, { minGap = DEFAULT_MIN_GAP, goal = null, targetOverride = null, avoid = null, exclude = null, remembered = [], prev = null, backAndForth = 0, stunned = null, multiHold = false, breakout = null, noGapWarn = false } = {}) {
  // A decision tick evaluates tactics once. Reuse that exact observed target for its move
  // options so the selected tactic cannot lose its target between the two prompt sections.
  const target = targetOverride ?? (approachId === 'go_to_exit' ? null : approachTarget(world, approachId, { minGap, goal, avoid, exclude, remembered, stunned, breakout }));
  const warnGap = noGapWarn ? 0 : minGap; // cornered: no "below your minimum gap" warnings
  const toTarget = target ? knownDistances(world, target.cell) : null;
  const t = world.seenTreasure();
  // Distance to the portal is only a fact while leaving: otherwise it would frame every move around leaving.
  const leaving = approachId === 'go_to_exit' || approachId === 'race_to_exit';
  const toExit = t && leaving ? knownDistances(world, t) : null;
  const threats = threatsOf(world);
  const here = world.pos;
  // When the portal is seen but has no known path, judge moves against the edge nearest it.
  let toNearEdge = null;
  if (t && approachId === 'go_to_exit' && !toExit.has(here)) {
    const near = approachTarget(world, 'go_to_exit');
    toNearEdge = near ? knownDistances(world, near.cell) : null;
  }
  // One BFS per remembered sighting (the most recent few), shared by every move: never per move.
  const sightings = [...remembered].sort((a, b) => b.step - a.step || (a.id < b.id ? -1 : 1)).slice(0, FACT_SIGHTINGS)
    .map((r) => ({ r, dist: knownDistances(world, r.cell) }));
  const otherExits = (dest) => neighbours(here).filter((n) => !sameCell(n, dest) && knownFloor(world, n));
  const out = {};
  const coinPiles = world.seenCoins();
  // The nearest seen pile by known path, when it lies within COIN_NEAR steps: a "toward" fact per move that closes in.
  const pile = nearbyPiles(world, COIN_NEAR)[0] ?? null;
  const toPile = pile ? knownDistances(world, pile.cell) : null;
  const hurt = world.health < world.maxHealth;
  const hearts = hurt ? world.seenHearts() : []; // a full-health explorer is told nothing about hearts
  const heart = hearts.length ? heartTarget(world, knownDistances(world, world.pos)) : null;
  const toHeart = heart ? knownDistances(world, heart.cell) : null;

  for (const dir of world.legalMoves()) {
    const dest = step(here, dir);
    const facts = [];
    const targetFacts = [];

    if (t && sameCell(dest, t)) {
      out[dir] = { whole: 'Steps onto the portal: leaves the dungeon with your current coins and ends the game.' };
      continue;
    }
    facts.push(...threatSentences(world, threats, dest, warnGap));
    const spot = sightingSentence(world, sightings, here, dest);
    if (spot) facts.push(spot);

    if (toExit) {
      const before = toExit.get(here), after = toExit.get(dest);
      if (before !== undefined && after !== undefined) {
        facts.push(after < before
          ? `Closer to the portal (${plural(after, 'step')} left by known path).`
          : `Farther from the portal (${plural(after, 'step')} by known path).`);
      } else if (toNearEdge?.has(here) && toNearEdge.has(dest)) {
        facts.push(toNearEdge.get(dest) < toNearEdge.get(here)
          ? 'No known path to the portal yet; heads for the dark edge nearest it.'
          : 'No known path to the portal yet; leaves the dark edge nearest it.');
      }
    }

    const coinsHere = coinPiles.filter((c) => sameCell(c, dest)).length;
    if (coinsHere) facts.push(coinsHere === 1 ? 'Picks up a coin.' : `Picks up ${coinsHere} coins.`);
    // Only the moves that close in say so (as in the plan); an "Away from" twin cost ~40 B per move on the
    // busiest decision tick, and a move without the fact does not get closer.
    else if (pile && toPile.has(dest) && toPile.has(here) && toPile.get(dest) < toPile.get(here)) {
      facts.push(`Toward ${plural(pile.count, 'seen coin')} (${plural(toPile.get(dest), 'step')} after this).`);
    }
    if (hearts.some((c) => sameCell(c, dest))) facts.push('Picks up a heart: restores a life.');
    else if (heart && toHeart.has(dest) && toHeart.has(here) && toHeart.get(dest) < toHeart.get(here)) facts.push(`Toward a seen heart (${plural(toHeart.get(dest), 'step')} after this).`);
    const reveal = wouldReveal(world, dest);
    facts.push(reveal ? `Reveals about ${plural(reveal, 'new cell')}.` : 'Reveals nothing new.');
    facts.push(visitSentence(world.visits[key(dest)]));
    if (prev && sameCell(dest, prev)) {
      facts.push(`Goes back to the cell you left 2 steps ago${backAndForth ? ` (back-and-forth ${plural(backAndForth, 'time')} in the last 6 moves)` : ''}.`);
    }

    if (approachId !== 'go_to_exit') {
      if (!target) {
        targetFacts.push(isTactic(approachId)
          ? (threats.length ? 'The tactic has no workable target from here.' : 'No enemy in sight right now.')
          : 'No target left: everything reachable is explored.');
      } else {
        const before = toTarget.get(here), after = toTarget.get(dest);
        if (sameCell(dest, target.cell)) targetFacts.push('Reaches the target.');
        else if (after < before) targetFacts.push(`Closer to the target (${plural(after, 'step')} left).`);
        else if (after > before) targetFacts.push(`Farther from the target (${plural(after, 'step')} after this).`);
        else targetFacts.push('Same distance to the target.');
      }
    }

    // engage: a step that ends next to a hunting adversary the explorer has not stunned hands it the first claw.
    if (approachId === 'engage') {
      const first = threats.find((th) => th.chasing && !stunned?.has(th.id) && !sameCell(dest, th.pos) && threatDistance(th, here) > 1 && threatDistance(th, dest) <= 1);
      if (first) targetFacts.push(`Steps next to ${threats.length > 1 ? first.id : 'it'}: it can claw before you strike.`);
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
  if (world.legalMoves().length) {
    const hg = approachId === 'engage' && target?.steps === 0 ? holdGhost(threats, stunned, here, multiHold) : null;
    const holding = !!hg && threatDistance(hg, here) === 2;
    out[STAY] = { whole: stayFacts(world, approachId, threats, warnGap, holding), ...(holding ? { holding } : {}) };
  }
  return out;
}

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen by every importer.
export function configureExplorerPerception(o) {
  if (o.percSightingNear !== undefined) SIGHTING_NEAR = o.percSightingNear;
  if (o.percZoneSteps !== undefined) ZONE_STEPS = o.percZoneSteps;
  if (o.percZoneNearSteps !== undefined) ZONE_NEAR_STEPS = o.percZoneNearSteps;
  if (o.percZoneFresh !== undefined) ZONE_FRESH = o.percZoneFresh;
  if (o.percZoneRecent !== undefined) ZONE_RECENT = o.percZoneRecent;
  if (o.percSectorSlack !== undefined) SECTOR_SLACK = o.percSectorSlack;
  if (o.percCoinNear !== undefined) COIN_NEAR = o.percCoinNear;
  if (o.percFactSightings !== undefined) FACT_SIGHTINGS = o.percFactSightings;
  if (o.percSurveyReach !== undefined) SURVEY_REACH = o.percSurveyReach;
  if (o.percHeartRunGap !== undefined) HEART_RUN_GAP = o.percHeartRunGap;
  if (o.percCoinPiles !== undefined) COIN_PILES = o.percCoinPiles;
  if (o.percDefaultMinGap !== undefined) DEFAULT_MIN_GAP = o.percDefaultMinGap;
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const explorerPerceptionSnapshot = () => ({ percSightingNear: SIGHTING_NEAR, percZoneSteps: ZONE_STEPS, percZoneNearSteps: ZONE_NEAR_STEPS, percZoneFresh: ZONE_FRESH, percZoneRecent: ZONE_RECENT, percSectorSlack: SECTOR_SLACK, percCoinNear: COIN_NEAR, percFactSightings: FACT_SIGHTINGS, percSurveyReach: SURVEY_REACH, percHeartRunGap: HEART_RUN_GAP, percCoinPiles: COIN_PILES, percDefaultMinGap: DEFAULT_MIN_GAP });
