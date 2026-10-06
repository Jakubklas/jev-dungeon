// Adversaries: spawning, senses, the brain on/off state machine, and movement.
// Brain off (mode 'patrol'): code wanders between room cells, no Jev.
// Brain on (mode 'chase' while it sees the explorer, 'search' otherwise): every step is a Jev
// decision (brain.js), made in parallel for all adversaries stepping this tick.
// Adversaries know the real map; the explorer does not.
import { DIRS, SIGHT_RANGE, damageExplorer, floorDistances, hasLineOfSight, isFloor, rng } from '../../dungeon.js';
import {
  KEEP_HUNTING_MIN, applyDecision, decide, huntOf, hunted, lostSight, searchTick, seen, sweepFrom, switchOff, switchOn,
} from './brain.js';
import { approachTarget, stepCell } from './perception.js';

export { setDecider, lastRequest, brainView, memoryOf } from './brain.js';

export const ADVERSARY_SPEED = 0.5; // budget gained per tick; one step per whole point
export const CHASE_RANGE = 7; // chase trigger distance, kept apart from SIGHT_RANGE on purpose
export const MAX_SEARCH_TICKS = 12; // ticks without sight before code switches the brain off
export const HIT_DAMAGE = 1; // lives an adversary's touch takes
// Ticks after a hit during which no touch hurts (game.graceTicks counts them down). A knocked-back
// adversary needs 1/ADVERSARY_SPEED = 2 ticks to step back in, so 4 gives the explorer a real head start.
export const GRACE_TICKS = 4;
const MIN_SPAWN_STEPS = 20; // path distance from the explorer's start
const FLOOR_PER_ADVERSARY = 700;
const MAX_ADVERSARIES = 8;

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const neighbours = (dungeon, [x, y]) =>
  Object.values(DIRS).map(([dx, dy]) => [x + dx, y + dy]).filter((c) => isFloor(dungeon, c));

// Cached patrol route per adversary (cells still to walk, next first), and a seeded
// PRNG per game for patrol goals. Kept off the objects so the Adversary shape stays as contracted.
const routes = new WeakMap();
const patrolRand = new WeakMap();
const tickCount = new WeakMap(); // game -> ticks run by stepAdversaries

function roomCells(dungeon) {
  const cells = [];
  for (const r of dungeon.rooms ?? []) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isFloor(dungeon, [x, y])) cells.push([x, y]);
  }
  return cells;
}

function countFloor(dungeon) {
  let n = 0;
  for (const row of dungeon.tiles) for (const c of row) if (c === '.') n++;
  return n;
}

function shuffleWith(rand, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function spawnAdversaries(dungeon) {
  const rand = rng(dungeon.seed ^ 0x9e3779b9);
  const count = Math.min(MAX_ADVERSARIES, Math.max(1, Math.round(countFloor(dungeon) / FLOOR_PER_ADVERSARY)));
  const dist = floorDistances(dungeon, dungeon.start);
  const ok = (c) =>
    (dist.get(key(c)) ?? -1) >= MIN_SPAWN_STEPS &&
    !(euclid(c, dungeon.start) <= SIGHT_RANGE && hasLineOfSight(dungeon, dungeon.start, c));
  // One candidate list per room, so adversaries spread over different rooms first.
  const perRoom = (dungeon.rooms ?? [])
    .map((r) => shuffleWith(rand, roomCells({ ...dungeon, rooms: [r] }).filter(ok)))
    .filter((cells) => cells.length);
  shuffleWith(rand, perRoom);
  const picked = [];
  for (let round = 0; picked.length < count && perRoom.some((cells) => cells.length > round); round++) {
    for (const cells of perRoom) if (picked.length < count && cells[round]) picked.push(cells[round]);
  }
  return picked.map((pos, i) => ({ id: `a${i + 1}`, pos: [...pos], mode: 'patrol', budget: 0, lastSeen: null, goal: null }));
}

// Sight is symmetric: always tested explorer -> adversary so both sides agree.
export function seesExplorer(game, adversary) {
  return euclid(game.pos, adversary.pos) <= SIGHT_RANGE && hasLineOfSight(game.dungeon, game.pos, adversary.pos);
}

// Trigger for patrol/search -> chase. The user wrote "has a direct line of sight ... and is at
// least 7 steps away"; we build the "within 7" reading pending confirmation. To flip it,
// change `<= CHASE_RANGE` to `>= CHASE_RANGE` on the line below. Note: seesExplorer already caps
// distance at SIGHT_RANGE (7), so the flipped trigger only fires when SIGHT_RANGE is raised too.
export function startsChase(game, adversary) {
  return seesExplorer(game, adversary) && euclid(game.pos, adversary.pos) <= CHASE_RANGE;
}

export function visibleAdversaries(game) {
  return (game.adversaries ?? [])
    .filter((a) => seesExplorer(game, a))
    .map((a) => ({ id: a.id, pos: [...a.pos], mode: a.mode, distance: Math.round(euclid(game.pos, a.pos) * 10) / 10 }));
}

// Route from `from` to `to` along a shortest floor path, excluding `from`.
function routeTo(dungeon, from, to) {
  const dist = floorDistances(dungeon, to);
  if (!dist.has(key(from))) return [];
  const route = [];
  let cur = from;
  while (!same(cur, to)) {
    const d = dist.get(key(cur));
    cur = neighbours(dungeon, cur).find((n) => dist.get(key(n)) === d - 1);
    route.push(cur);
  }
  return route;
}

function pickPatrolGoal(game, a) {
  let rand = patrolRand.get(game);
  if (!rand) patrolRand.set(game, (rand = rng(game.dungeon.seed ^ 0x85ebca6b)));
  const cells = roomCells(game.dungeon);
  for (let tries = 0; tries < 20 && cells.length; tries++) {
    const c = cells[Math.floor(rand() * cells.length)];
    if (!same(c, a.pos)) return [...c];
  }
  // No rooms (or a single-cell world): wander to a random neighbour.
  const n = neighbours(game.dungeon, a.pos);
  return n.length ? n[Math.floor(rand() * n.length)] : [...a.pos];
}

// --- the brain on/off state machine --------------------------------------------------------

function turnOn(game, a, events, tick) {
  a.mode = 'chase';
  a.lastSeen = [...game.pos];
  a.goal = null;
  routes.delete(a);
  events.push({ id: a.id, type: 'spotted', at: [...a.pos] });
  switchOn(game, a, tick);
  events.push({ id: a.id, type: 'brain_on', at: [...a.pos] });
}

function turnOff(a, events, tick, reason) {
  a.mode = 'patrol';
  a.lastSeen = null;
  a.goal = null;
  routes.delete(a);
  switchOff(a, tick, reason);
  events.push({ id: a.id, type: 'brain_off', at: [...a.pos], reason });
}

// Sight while the brain is on: chase while it sees the explorer, search otherwise.
function senseHunting(game, a, events, tick, startOfTick) {
  if (seesExplorer(game, a)) {
    if (a.mode !== 'chase') {
      a.mode = 'chase';
      events.push({ id: a.id, type: 'spotted', at: [...a.pos] });
    }
    a.lastSeen = [...game.pos];
    seen(game, a, tick, { startOfTick });
    return true;
  }
  if (a.mode === 'chase') {
    a.mode = 'search';
    lostSight(game, a, tick);
    events.push({ id: a.id, type: 'lost_sight', at: [...a.pos] });
  } else {
    sweepFrom(game, a);
  }
  return false;
}

// Start of a tick (after the explorer moved).
function senseStart(game, a, events, tick) {
  const h = huntOf(a);
  if (!h.on) {
    if (startsChase(game, a)) turnOn(game, a, events, tick);
    return;
  }
  hunted(a);
  if (senseHunting(game, a, events, tick, true)) return;
  searchTick(a);
  if (h.ticksSinceSeen > MAX_SEARCH_TICKS) turnOff(a, events, tick, `no sight of the explorer for ${MAX_SEARCH_TICKS} ticks`);
}

// After this adversary's own step (the explorer has not moved).
function senseAfterStep(game, a, events, tick) {
  if (!huntOf(a).on) {
    if (startsChase(game, a)) turnOn(game, a, events, tick);
    return;
  }
  senseHunting(game, a, events, tick, false);
}

// --- movement -------------------------------------------------------------------------------

// Code patrol step (brain off).
function patrolStep(game, a) {
  let route = routes.get(a);
  if (!a.goal || same(a.pos, a.goal) || !route?.length) {
    a.goal = pickPatrolGoal(game, a);
    route = routeTo(game.dungeon, a.pos, a.goal);
    routes.set(a, route);
  }
  if (route.length) a.pos = route.shift();
}

// Fallback when Jev fails: the old code move. Shortest path to the explorer while in sight, else
// to the last-seen cell, else to the nearest unchecked cell around it. Returns a direction or null.
function codeHuntDir(game, a) {
  const h = huntOf(a);
  let target = h.inSight ? game.pos : a.lastSeen;
  if (target && same(target, a.pos)) target = approachTarget(game, a, h, 'sweep_last_seen')?.cell ?? null;
  if (!target) return null;
  const dist = floorDistances(game.dungeon, target);
  const d = dist.get(key(a.pos));
  return Object.keys(DIRS).find((dir) => dist.get(key(stepCell(a.pos, dir))) === d - 1) ?? null;
}

// Deterministic knockback: the adversary leaves the explorer's cell. Back to `from` (the cell it
// stepped in from) when given, else the first floor neighbour in DIRS order that is not the
// explorer's cell, preferring one that is not the cell the explorer just came from. Stays put
// only when boxed in. No rng, so seeds stay reproducible.
function knockBack(game, a, from = null) {
  routes.delete(a); // patrol routes assume contiguous cells
  a.budget = 0; // no step straight back in this tick
  if (from && isFloor(game.dungeon, from) && !same(from, game.pos)) {
    a.pos = [...from];
    return;
  }
  const prev = game.trail?.length > 1 ? game.trail.at(-2) : null;
  const options = neighbours(game.dungeon, a.pos).filter((c) => !same(c, game.pos));
  const pick = options.find((c) => !prev || !same(c, prev)) ?? options[0];
  if (pick) a.pos = pick;
}

// Touch check: an adversary on the explorer's cell. Outside grace and with no hit yet this tick it
// takes HIT_DAMAGE lives (event 'hit', plus 'caught' when that was the last life), starts the
// grace period and is knocked back. During grace (or after this tick's hit) a touching adversary
// is only knocked back, so no adversary ever ends a tick on a living explorer. Returns true when
// the game is now lost.
function touchCheck(game, a, events, touch, from = null) {
  if (game.lost || !same(a.pos, game.pos)) return false;
  if (touch.canHit()) {
    touch.hit = true;
    const { health, lost } = damageExplorer(game, HIT_DAMAGE, a.id);
    events.push({ id: a.id, type: 'hit', at: [...a.pos], health });
    if (lost) {
      events.push({ id: a.id, type: 'caught', at: [...a.pos] });
      return true;
    }
    game.graceTicks = GRACE_TICKS;
  }
  knockBack(game, a, from);
  return false;
}

// Grace ticks left after the latest hit (0 = the explorer can be hit). Fog-safe: it is the
// explorer's own state.
export function graceLeft(game) {
  return game.graceTicks ?? 0;
}

const byId = (p, q) => p.id.localeCompare(q.id, 'en', { numeric: true });

// One tick for every adversary. Also hits an explorer that stepped onto an adversary.
// Brain-on adversaries with a step this tick ask Jev in parallel, from the state after the
// explorer's move; the steps are then applied in id order with a touch check after each.
// At most one hit per tick: grace is decided once at the start of the tick and `hit` latches.
// -> { events, turns: [{ id, dir, decision|null, keep_hunting, brain: 'on'|'off', apiMs, error? }] }
export async function stepAdversaries(game) {
  const events = [];
  const turns = [];
  if (game.won || game.lost) return { events, turns };
  const protectedNow = graceLeft(game) > 0;
  if (protectedNow) game.graceTicks--;
  const touch = { hit: false, canHit() { return !protectedNow && !this.hit; } };
  const order = [...game.adversaries].sort(byId);
  for (const a of order) if (touchCheck(game, a, events, touch)) return { events, turns };
  const tick = (tickCount.get(game) ?? 0) + 1;
  tickCount.set(game, tick);

  for (const a of order) senseStart(game, a, events, tick);
  for (const a of order) a.budget += ADVERSARY_SPEED;

  const cfg = { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS };
  const thinking = order.filter((a) => a.budget >= 1 && huntOf(a).on);
  const results = new Map(await Promise.all(thinking.map(async (a) => [a, await decide(game, a, tick, cfg)])));

  for (const a of order) {
    const turn = { id: a.id, dir: null, decision: null, keep_hunting: null, brain: 'off', apiMs: 0 };
    turns.push(turn);
    if (a.budget >= 1) {
      // At most one step per tick (ADVERSARY_SPEED < 1); the remainder carries over.
      a.budget -= 1;
      const res = results.get(a);
      const from = [...a.pos];
      if (res) {
        let dir = res.dir;
        if (res.error) {
          console.warn(`[adversary ${a.id}] Jev call failed, code move instead: ${res.error}`);
          dir = codeHuntDir(game, a);
          turn.error = res.error;
        }
        applyDecision(a, tick, { ...res, dir }, { fallback: Boolean(res.error) });
        if (dir) a.pos = stepCell(a.pos, dir);
        Object.assign(turn, { dir, decision: res.decision, keep_hunting: res.keep_hunting, apiMs: res.apiMs });
      } else {
        patrolStep(game, a);
        turn.dir = Object.keys(DIRS).find((d) => same(stepCell(from, d), a.pos)) ?? null;
      }
      if (touchCheck(game, a, events, touch, from)) {
        turn.brain = huntOf(a).on ? 'on' : 'off';
        return { events, turns };
      }
      if (res && res.keep_hunting !== null && res.keep_hunting < KEEP_HUNTING_MIN && huntOf(a).on) {
        turnOff(a, events, tick, `Jev judged the hunt not worth it (keep_hunting ${res.keep_hunting.toFixed(2)})`);
      }
      senseAfterStep(game, a, events, tick);
    }
    turn.brain = huntOf(a).on ? 'on' : 'off';
  }
  return { events, turns };
}
