// Adversaries: spawning, senses, the brain on/off state machine, and movement.
// Brain off (mode 'patrol'): code wanders between room cells, no Jev.
// Brain on (mode 'chase' while it sees the explorer, 'search' otherwise): every step is a Jev
// decision (brain.js), made in parallel for all adversaries stepping this tick.
// Adversaries read the world through an AdversaryView (adversary-view.js); in `full` mode that is the real map.
// This file holds the physics (movement, touch, spawning) and stays on Game.
import { DIRS, SIGHT_RANGE, floorDistances, hasLineOfSight, isFloor, rng } from '../../dungeon.js';
import {
  KEEP_HUNTING_MIN, ageHunt, applyDecision, decide, hunted, newHunt, lostSight, noteHit, noteStep, searchTick, seen, setKeepHuntingMin, setMemoryOn, sweepFrom, switchOff, switchOn, switchOnAlerted,
} from './brain.js';
import { approachTarget, stepCell } from './perception.js';
import { AdversaryView } from './adversary-view.js';
import { assignCharacters, profileOf, traitsOf } from './character.js';

export { brainView } from './brain.js';

// The tunables below are `export let` so src/settings.js can change them through configureAdversaries().
export let ADVERSARY_SPEED = 0.6; // budget gained per tick; one step per whole point
export let CHASE_RANGE = 7; // chase trigger distance, kept apart from SIGHT_RANGE on purpose
export let MAX_SEARCH_TICKS = 18; // ticks without sight before code switches the brain off
export let HIT_DAMAGE = 1; // lives an adversary's touch takes
// Ticks after a hit during which no touch hurts (game.graceTicks counts them down). A knocked-back
// adversary needs 1/ADVERSARY_SPEED = 2 ticks to step back in, so 4 gives the explorer a real head start.
export let GRACE_TICKS = 4;
export let ALERT_STEPS = 24; // path steps within which a patrolling adversary hears a spotter's call
const MIN_SPAWN_STEPS = 20; // path distance from the explorer's start
let FLOOR_PER_ADVERSARY = 150; // one adversary per this many floor cells (350 cells: 2, 1700: 11)
let MAX_ADVERSARIES = 12;
let PACK_ALERT = true; // a spotter calls in packmates (alertNearby)
let TEAM_SIGHT = true; // a hunter tracks the explorer through a packmate's sight
export let CHARACTERS_ON = false; // adversaryCharacters toggle: mixed characters at spawn, per-ghost patrol RNG, self.character in state
export let LIMITED_ON = false; // limitedMap toggle: ghosts know their home zone + what they have seen, not the real map
// Limited maps need the characters (home radius, ttl and memory come from the character and its memory
// compensates for the fog), so limitedMap only acts together with adversaryCharacters.
export const limitedActive = () => LIMITED_ON && CHARACTERS_ON;

export function configureAdversaries(o) {
  if (o.speed !== undefined) ADVERSARY_SPEED = o.speed;
  if (o.chaseRange !== undefined) CHASE_RANGE = o.chaseRange;
  if (o.maxSearchTicks !== undefined) MAX_SEARCH_TICKS = o.maxSearchTicks;
  if (o.hitDamage !== undefined) HIT_DAMAGE = o.hitDamage;
  if (o.graceTicks !== undefined) GRACE_TICKS = o.graceTicks;
  if (o.alertSteps !== undefined) ALERT_STEPS = o.alertSteps;
  if (o.floorPerAdversary !== undefined) FLOOR_PER_ADVERSARY = o.floorPerAdversary;
  if (o.maxAdversaries !== undefined) MAX_ADVERSARIES = o.maxAdversaries;
  if (o.packAlert !== undefined) PACK_ALERT = o.packAlert;
  if (o.teamSight !== undefined) TEAM_SIGHT = o.teamSight;
  if (o.keepHuntingMin !== undefined) setKeepHuntingMin(o.keepHuntingMin);
  if (o.limitedMap !== undefined) LIMITED_ON = Boolean(o.limitedMap);
  if (o.adversaryCharacters !== undefined) {
    CHARACTERS_ON = o.adversaryCharacters;
    setMemoryOn(o.adversaryCharacters); // smart memory comes with the characters
  }
}

// One view per (game, ghost). A ghost shared with a twin game gets a fresh view per game.
const views = new WeakMap();
function viewOf(game, a) {
  const cached = views.get(a);
  if (cached?.game === game) return cached.view;
  const view = new AdversaryView(game, a, { limited: limitedActive() });
  views.set(a, { game, view });
  return view;
}
export { viewOf as adversaryView }; // the checks and measure-memory read a ghost's known map through it

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const neighbours = (dungeon, [x, y]) =>
  Object.values(DIRS).map(([dx, dy]) => [x + dx, y + dy]).filter((c) => isFloor(dungeon, c));

// One adversary. The six public fields are the contracted shape (adversaries.json, perception);
// the hunt state, patrol route and last Jev request body are private so JSON/Object.keys/spread
// never see them. Never spread or JSON-clone one: only the constructor makes a working adversary.
export class Adversary {
  // Declared in this order: Object.keys/JSON must stay exactly the contracted shape.
  id;
  pos;
  mode;
  budget;
  lastSeen;
  goal;
  #hunt; // brain state (brain.js newHunt)
  #route = null; // cached patrol route, cells still to walk, next first
  #lastRequestBody = null; // exact body of the last Jev request, for auditing
  #character; // preset id (character.js), fixed at spawn
  #profile; // profileOf(traits) for that preset
  #home; // spawn cell: the centre of the patrol territory

  constructor({ id, pos, mode = 'patrol', budget = 0, lastSeen = null, goal = null, character = 'standard' }) {
    this.id = id;
    this.pos = pos;
    this.mode = mode;
    this.budget = budget;
    this.lastSeen = lastSeen;
    this.goal = goal;
    this.#character = character;
    this.#profile = profileOf(traitsOf(character)); // throws on an unknown id
    this.#home = [...pos];
    this.#hunt = newHunt(id, this.#profile, character);
  }

  get character() {
    return this.#character;
  }

  get profile() {
    return this.#profile;
  }

  get home() {
    return this.#home;
  }

  get hunt() {
    return this.#hunt;
  }

  get memory() {
    return this.#hunt.memory;
  }

  get route() {
    return this.#route;
  }

  set route(cells) {
    this.#route = cells;
  }

  get lastRequestBody() {
    return this.#lastRequestBody;
  }

  set lastRequestBody(body) {
    this.#lastRequestBody = body;
  }

  lastRequest() {
    return this.#lastRequestBody === null ? null : JSON.parse(this.#lastRequestBody);
  }
}

// The patrol-goal PRNG lives on the Game (patrolRand).

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
  const count = Math.min(MAX_ADVERSARIES, Math.max(1, Math.round(countFloor(dungeon) / FLOOR_PER_ADVERSARY))); // 0 when MAX_ADVERSARIES is 0
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
  // Characters come from their own stream and are drawn after every spawn rng call, so dungeons and ghost cells never change.
  const characters = CHARACTERS_ON ? assignCharacters(dungeon.seed, picked.length, 'mixed') : [];
  return picked.map((pos, i) => new Adversary({ id: `a${i + 1}`, pos: [...pos], character: characters[i] ?? 'standard' }));
}

// The numbers this ghost's code runs with. A standard ghost follows the live settings (today's behaviour);
// any other character uses its profile (character.js). Loners answer a call only when the explorer is close.
function knobsOf(a) {
  if (a.character === 'standard') {
    return { chaseRange: CHASE_RANGE, maxSearchTicks: MAX_SEARCH_TICKS, keepHuntingMin: KEEP_HUNTING_MIN, alertSteps: ALERT_STEPS, teamSight: TEAM_SIGHT, restTicks: 0, makesCalls: true, answersCalls: true, answersWithin: null };
  }
  const p = a.profile;
  return {
    chaseRange: Math.min(p.chaseRange, SIGHT_RANGE),
    maxSearchTicks: p.maxSearchTicks,
    keepHuntingMin: p.keepHuntingMin,
    alertSteps: p.alertSteps,
    teamSight: TEAM_SIGHT && p.teamSight,
    restTicks: p.traits.aggression === 1 ? p.restTicks : 0, // only a calm ghost rests; level 2 is today's no-rest
    makesCalls: p.makesCalls,
    answersCalls: p.answersCalls,
    answersWithin: p.answersCallsWithin,
  };
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
  return seesExplorer(game, adversary) && euclid(game.pos, adversary.pos) <= knobsOf(adversary).chaseRange;
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

// Per-ghost patrol streams (adversaryCharacters on): one ghost's draws never shift another's.
const patrolRands = new WeakMap();
const hashId = (id) => [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
function patrolRandOf(game, a) {
  let m = patrolRands.get(game);
  if (!m) patrolRands.set(game, (m = new Map()));
  if (!m.has(a.id)) m.set(a.id, rng((game.dungeon.seed ^ 0x85ebca6b ^ hashId(a.id)) >>> 0));
  return m.get(a.id);
}

// Patrol pool of a non-standard ghost: rooms within homeRadius path steps of its spawn cell (and its
// spawn room). Only the candidate list shrinks, so the number of rand() calls per goal is unchanged.
const homeDists = new WeakMap();
function homePool(game, a, cells) {
  const radius = a.profile.homeRadius;
  if (a.character === 'standard' || radius === null) return cells;
  let cached = homeDists.get(a);
  if (cached?.dungeon !== game.dungeon) homeDists.set(a, (cached = { dungeon: game.dungeon, dist: floorDistances(game.dungeon, a.home) }));
  const room = (game.dungeon.rooms ?? []).find((r) => a.home[0] >= r.x && a.home[0] < r.x + r.w && a.home[1] >= r.y && a.home[1] < r.y + r.h);
  const pool = cells.filter((c) => (cached.dist.get(key(c)) ?? Infinity) <= radius || (room && c[0] >= room.x && c[0] < room.x + room.w && c[1] >= room.y && c[1] < room.y + room.h));
  return pool.length ? pool : cells;
}

function pickPatrolGoal(game, a) {
  const rand = CHARACTERS_ON ? patrolRandOf(game, a) : (game.patrolRand ??= rng(game.dungeon.seed ^ 0x85ebca6b)); // lazy: one stream per game
  let cells = homePool(game, a, roomCells(game.dungeon));
  if (limitedActive()) {
    // Patrol goals come from rooms the ghost knows (home zone + seen); only the candidate list shrinks.
    const view = viewOf(game, a);
    const known = cells.filter((c) => view.isKnown(c));
    if (known.length) cells = known;
  }
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
  a.route = null;
  events.push({ id: a.id, type: 'spotted', at: [...a.pos] });
  switchOn(viewOf(game, a), a, tick);
  events.push({ id: a.id, type: 'brain_on', at: [...a.pos] });
  if (PACK_ALERT) alertNearby(game, a, events, tick);
}

// The spotter calls out: every patrolling adversary within ALERT_STEPS (path) joins the hunt in
// search mode, last_seen = where the explorer is now. Alerted ghosts do not alert further.
function alertNearby(game, spotter, events, tick) {
  if (!knobsOf(spotter).makesCalls) return; // a loner does not call
  const near = floorDistances(game.dungeon, spotter.pos);
  for (const o of game.adversaries) {
    if (o === spotter || o.hunt.on) continue;
    const d = near.get(key(o.pos));
    const hear = knobsOf(o);
    if (d === undefined || d > hear.alertSteps) continue;
    if (!hear.answersCalls) {
      // A loner answers only when the explorer is already close to it.
      const toExplorer = hear.answersWithin === null ? undefined : floorDistances(game.dungeon, o.pos).get(key(game.pos));
      if (toExplorer === undefined || toExplorer > hear.answersWithin) continue;
    }
    o.mode = 'search';
    o.lastSeen = [...game.pos];
    o.goal = null;
    o.route = null;
    switchOnAlerted(o, tick, game.pos, spotter.hunt.heading, spotter.id);
    viewOf(game, o).hear(viewOf(game, spotter), game.pos, tick); // the call carries the spotter's nearby known cells
    sweepFrom(viewOf(game, o), o);
    events.push({ id: o.id, type: 'alerted', at: [...o.pos], by: spotter.id });
    events.push({ id: o.id, type: 'brain_on', at: [...o.pos] });
  }
}

function turnOff(a, events, tick, reason) {
  a.hunt.restUntil = tick + knobsOf(a).restTicks; // a calm ghost does not start a new hunt straight away
  a.mode = 'patrol';
  a.lastSeen = null;
  a.goal = null;
  a.route = null;
  switchOff(a, tick, reason);
  events.push({ id: a.id, type: 'brain_off', at: [...a.pos], reason });
}

// Team sight: a hunting adversary tracks the explorer while it sees it itself or any other hunting
// adversary does (they call out its position), so the pack closes in together instead of one
// ghost losing it behind a corner.
function tracksExplorer(game, a) {
  return seesExplorer(game, a) || (knobsOf(a).teamSight && game.adversaries.some((o) => o !== a && o.hunt.on && seesExplorer(game, o)));
}

// Sight while the brain is on: chase while it (or a packmate) sees the explorer, search otherwise.
function senseHunting(game, a, events, tick, startOfTick) {
  if (tracksExplorer(game, a)) {
    if (a.mode !== 'chase') {
      a.mode = 'chase';
      events.push({ id: a.id, type: 'spotted', at: [...a.pos] });
    }
    a.lastSeen = [...game.pos];
    const own = seesExplorer(game, a);
    // Team sight: a packmate that sees the explorer calls out where it is, and its nearby known cells come with the call.
    if (!own && limitedActive()) {
      const caller = [...game.adversaries].sort(byId).find((o) => o !== a && o.hunt.on && seesExplorer(game, o));
      if (caller) viewOf(game, a).hear(viewOf(game, caller), game.pos, tick);
    }
    seen(viewOf(game, a), a, tick, { startOfTick, own });
    return true;
  }
  if (a.mode === 'chase') {
    a.mode = 'search';
    lostSight(viewOf(game, a), a, tick);
    events.push({ id: a.id, type: 'lost_sight', at: [...a.pos] });
  } else {
    sweepFrom(viewOf(game, a), a);
  }
  return false;
}

// Start of a tick (after the explorer moved).
function senseStart(game, a, events, tick) {
  const h = a.hunt;
  if (!h.on) {
    if (tick >= h.restUntil && startsChase(game, a)) turnOn(game, a, events, tick);
    return;
  }
  hunted(a);
  if (senseHunting(game, a, events, tick, true)) return;
  searchTick(a, viewOf(game, a), tick);
  const maxSearch = knobsOf(a).maxSearchTicks;
  if (h.ticksSinceSeen > maxSearch) turnOff(a, events, tick, `no sight of the explorer for ${maxSearch} ticks`);
}

// After this adversary's own step (the explorer has not moved).
function senseAfterStep(game, a, events, tick) {
  if (!a.hunt.on) {
    if (tick >= a.hunt.restUntil && startsChase(game, a)) turnOn(game, a, events, tick);
    return;
  }
  senseHunting(game, a, events, tick, false);
}

// --- movement -------------------------------------------------------------------------------

// Code patrol step (brain off).
function patrolStep(game, a) {
  let route = a.route;
  if (!a.goal || same(a.pos, a.goal) || !route?.length) {
    a.goal = pickPatrolGoal(game, a);
    route = routeTo(game.dungeon, a.pos, a.goal);
    a.route = route;
  }
  if (route.length) a.pos = route.shift();
}

// Fallback when Jev fails: the old code move. Shortest path to the explorer while in sight, else
// to the last-seen cell, else to the nearest unchecked cell around it. Returns a direction or null.
function codeHuntDir(game, a) {
  const h = a.hunt;
  let target = h.inSight ? game.pos : a.lastSeen;
  if (target && same(target, a.pos)) target = approachTarget(viewOf(game, a), a, h, 'sweep_last_seen')?.cell ?? null;
  if (!target) return null;
  if (limitedActive()) {
    // Over the ghost's own map only; a target it has no route to becomes the edge of what it knows.
    const view = viewOf(game, a);
    let dist = view.distancesFrom(target);
    if (!dist.has(key(a.pos))) {
      const edge = view.frontierToward(target);
      if (!edge) return null;
      target = edge.cell;
      dist = view.distancesFrom(target);
    }
    const d = dist.get(key(a.pos));
    return view.legalMoves().find((dir) => dist.get(key(stepCell(a.pos, dir))) === d - 1) ?? null;
  }
  const dist = floorDistances(game.dungeon, target);
  const d = dist.get(key(a.pos));
  return Object.keys(DIRS).find((dir) => dist.get(key(stepCell(a.pos, dir))) === d - 1) ?? null;
}

// Deterministic knockback: the adversary leaves the explorer's cell. Back to `from` (the cell it
// stepped in from) when given, else the first floor neighbour in DIRS order that is not the
// explorer's cell, preferring one that is not the cell the explorer just came from. Stays put
// only when boxed in. No rng, so seeds stay reproducible.
function knockBack(game, a, from = null) {
  a.route = null; // patrol routes assume contiguous cells
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
    const { health, lost } = game.damage(HIT_DAMAGE, a.id);
    events.push({ id: a.id, type: 'hit', at: [...a.pos], health });
    noteHit(a, game.adversaryTicks);
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
  return game.graceTicks;
}

const byId = (p, q) => p.id.localeCompare(q.id, 'en', { numeric: true });

// One tick for every adversary. Also hits an explorer that stepped onto an adversary.
// Brain-on adversaries with a step this tick ask Jev in parallel, from the state after the
// explorer's move; the steps are then applied in id order with a touch check after each.
// At most one hit per tick: grace is decided once at the start of the tick and `hit` latches.
// -> { events, turns: [{ id, dir, decision|null, keep_hunting, brain: 'on'|'off', apiMs, error? }] }
export async function stepAdversaries(game, { decide: ask = null } = {}) {
  const events = [];
  const turns = [];
  if (game.won || game.lost) return { events, turns };
  const protectedNow = graceLeft(game) > 0;
  if (protectedNow) game.graceTicks--;
  const touch = { hit: false, canHit() { return !protectedNow && !this.hit; } };
  const order = [...game.adversaries].sort(byId);
  for (const a of order) if (touchCheck(game, a, events, touch)) return { events, turns };
  const tick = game.adversaryTicks + 1;
  game.adversaryTicks = tick;

  for (const a of order) ageHunt(a, tick);
  for (const a of order) viewOf(game, a).update(tick); // limited maps: stamp what each ghost sees, in id order, before anyone senses
  for (const a of order) senseStart(game, a, events, tick);
  for (const a of order) a.budget += ADVERSARY_SPEED;

  const cfg = { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS, hitDamage: HIT_DAMAGE, graceTicks: GRACE_TICKS };
  const thinking = order.filter((a) => a.budget >= 1 && a.hunt.on);
  const cfgOf = (a) => ({ ...cfg, maxSearchTicks: knobsOf(a).maxSearchTicks, characters: CHARACTERS_ON, limited: limitedActive() });
  const results = new Map(await Promise.all(thinking.map(async (a) => [a, await decide(viewOf(game, a), a, tick, cfgOf(a), ask)])));

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
        if (dir) {
          a.pos = stepCell(a.pos, dir);
          noteStep(a, from, dir, tick);
        }
        Object.assign(turn, { dir, decision: res.decision, keep_hunting: res.keep_hunting, apiMs: res.apiMs });
      } else {
        patrolStep(game, a);
        turn.dir = Object.keys(DIRS).find((d) => same(stepCell(from, d), a.pos)) ?? null;
      }
      if (touchCheck(game, a, events, touch, from)) {
        turn.brain = a.hunt.on ? 'on' : 'off';
        return { events, turns };
      }
      if (res && res.keep_hunting !== null && res.keep_hunting < knobsOf(a).keepHuntingMin && a.hunt.on) {
        turnOff(a, events, tick, `Jev judged the hunt not worth it (keep_hunting ${res.keep_hunting.toFixed(2)})`);
      }
      senseAfterStep(game, a, events, tick);
    }
    turn.brain = a.hunt.on ? 'on' : 'off';
  }
  return { events, turns };
}
