// Adversaries: spawning, senses, the brain on/off state machine, and movement.
// Brain off (mode 'patrol'): code wanders between room cells, no Jev.
// Brain on (mode 'chase' while it sees the explorer, 'search' otherwise): every step is a Jev
// decision (brain.js), made in parallel for all adversaries stepping this tick.
// Adversaries read the world through an AdversaryView (adversary-view.js); in `full` mode that is the real map.
// This file holds the physics (movement, bumps, claw strikes, spawning) and stays on Game.
// Damage model (PLAN-skills.md S4): a touch is only a BUMP (knockback, event 'bump', no life lost, no grace).
// Only attacks take lives: a hunting ghost may use its claw strike (the `skill` question, brain.js); a patrolling
// ghost (brain off) never strikes. Grace and the one-hit-per-tick latch apply to strikes.
import { CallAborted } from '../../call-aborted.js';
import { DIRS, SIGHT_RANGE, floorDistances, hasLineOfSight, isFloor, rng, startSight } from '../../dungeon.js';
import {
  KEEP_HUNTING_MIN, MORALE_ON, ageHunt, applyDecision, applyMorale, decide, hunted, newHunt, lostSight, noteHit, noteStep, queueMorale, tabuReport, searchTick, seen, setKeepHuntingMin, setMemoryOn, setMoraleOn, sweepFrom, switchOff, switchOn, switchOnAlerted,
} from './brain.js';
import { approachTarget, stepCell } from './perception.js';
import { AdversaryView } from './adversary-view.js';
import { assignSpawnCharacters, profileOf, traitsOf } from './character.js';
import { assignKinds, assignLevels, kindOf, defaultLevel, levelStats, levelsOn, clawMult } from './kinds.js';
import { setSkills } from './memory.js';
import { buildSkillSet } from '../../skills/loadouts.js';
import { skillConfig } from '../../skills/config.js';
import { ROUT_REST } from './morale.js';
import { resolveAttack } from '../../skills/resolve.js';

export { brainView } from './brain.js';

// The tunables below are `export let` so src/settings.js can change them through configureAdversaries().
export let ADVERSARY_SPEED = 0.6; // budget gained per tick; one step per whole point
export let CHASE_RANGE = 7; // chase trigger distance, kept apart from SIGHT_RANGE on purpose
export let MAX_SEARCH_TICKS = 18; // ticks without sight before code switches the brain off
// Ticks after a hit during which no strike hurts (game.graceTicks counts them down). A knocked-back
// adversary needs 1/ADVERSARY_SPEED = 2 ticks to step back in, so 4 gives the explorer a real head start.
export let GRACE_TICKS = 4;
export let ALERT_STEPS = 24; // path steps within which a patrolling adversary hears a spotter's call
export let MIN_SPAWN_STEPS = 20; // path distance from the explorer's start (spawnMinSteps; dungeon.js mirrors it)
let FLOOR_PER_ADVERSARY = 150; // one adversary per this many floor cells (350 cells: 2, 1700: 11)
let MAX_ADVERSARIES = 12;
let PACK_ALERT = true; // a spotter calls in packmates (alertNearby)
let TEAM_SIGHT = true; // a hunter tracks the explorer through a packmate's sight
let TROLL_SHARE = 0.25; // relative troll weight within ghost + troll; derived kinds mirror these weights
export let CHARACTERS_ON = false; // adversaryCharacters toggle: mixed characters at spawn, per-ghost patrol RNG, self.character in state
export let MORALE_ON_SETTING = false; // monsterMorale toggle: every monster keeps a morale score (morale.js)
export let LIMITED_ON = false; // limitedMap toggle: ghosts know their home zone + what they have seen, not the real map
// Limited maps need the characters (home radius, ttl and memory come from the character and its memory
// compensates for the fog), so limitedMap only acts together with adversaryCharacters.
export const limitedActive = () => LIMITED_ON && CHARACTERS_ON;

export function configureAdversaries(o) {
  if (o.speed !== undefined) ADVERSARY_SPEED = o.speed;
  if (o.chaseRange !== undefined) CHASE_RANGE = o.chaseRange;
  if (o.maxSearchTicks !== undefined) MAX_SEARCH_TICKS = o.maxSearchTicks;
  if (o.graceTicks !== undefined) GRACE_TICKS = o.graceTicks;
  if (o.alertSteps !== undefined) ALERT_STEPS = o.alertSteps;
  if (o.floorPerAdversary !== undefined) FLOOR_PER_ADVERSARY = o.floorPerAdversary;
  if (o.maxAdversaries !== undefined) MAX_ADVERSARIES = o.maxAdversaries;
  if (o.packAlert !== undefined) PACK_ALERT = o.packAlert;
  if (o.teamSight !== undefined) TEAM_SIGHT = o.teamSight;
  if (o.trollShare !== undefined) TROLL_SHARE = o.trollShare;
  if (o.spawnMinSteps !== undefined) MIN_SPAWN_STEPS = o.spawnMinSteps;
  if (o.keepHuntingMin !== undefined) setKeepHuntingMin(o.keepHuntingMin);
  if (o.limitedMap !== undefined) LIMITED_ON = Boolean(o.limitedMap);
  if (o.monsterMorale !== undefined) { MORALE_ON_SETTING = Boolean(o.monsterMorale); setMoraleOn(o.monsterMorale); }
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
  #level = 2; // 1-4, fixed at spawn (kinds.js); fixed-level kinds retain their level with scaling off
  #clawDamage = 1; // lives one claw strike takes, resolved at construction
  #kind; // monster kind id (kinds.js), fixed at spawn
  #character; // preset id (character.js), fixed at spawn
  #profile; // profileOf(traits) for that preset
  #home; // spawn cell: the centre of the patrol territory
  #skills; // SkillSet (loadouts.js 'ghost': the claw strike, no block)
  #facing = 'down'; // 4-way: the last step's direction or the last strike's aim (accessor, never an own property)
  #hp; // hit points (D1) and their maximum; a hit knocks back and stuns, at 0 the ghost is dispelled
  #maxHp;
  #speed = 1; // the kind's speed multiplier of ADVERSARY_SPEED (accessor, never an own property)
  #stun = 0; // ticks of stun left: no step, no Jev call (mirror of the deadline below, and the only record without a game)
  #stunUntil = null; // world ms (Game.now timeline) the stun lasts until (exclusive); null = none or gameless

  constructor({ id, pos, mode = 'patrol', budget = 0, lastSeen = null, goal = null, character, kind = 'ghost', level, hp, skills }) {
    const spec = kindOf(kind); // throws on an unknown kind; the kind supplies hp and skills unless given
    if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 4)) throw new TypeError(`monster level must be 1, 2, 3 or 4, got ${JSON.stringify(level)}`);
    this.#level = spec.fixedLevel ?? (levelsOn() ? (level ?? defaultLevel(kind)) : defaultLevel(kind)); // kind-fixed levels survive scaling off
    character ??= spec.character ?? 'standard';
    this.id = id;
    this.pos = pos;
    this.mode = mode;
    this.budget = budget;
    this.lastSeen = lastSeen;
    this.goal = goal;
    this.#kind = spec.id;
    this.#character = character;
    this.#profile = profileOf(traitsOf(character)); // throws on an unknown id
    this.#home = [...pos];
    this.#hunt = newHunt(id, this.#profile, character);
    const stats = levelStats(kind, this.#level);
    this.#hp = this.#maxHp = hp ?? stats.hp; // an explicit hp (testbed ghostHp) is taken as given
    this.#speed = spec.speed();
    const own = skills === undefined; // a kind's own loadout carries its tuning; an explicit one is taken as given
    skills ??= spec.skills;
    const built = typeof skills === 'string' || Array.isArray(skills);
    this.#skills = built ? buildSkillSet(skills, own ? spec.tuning() : {}) : skills;
    // The level scales the claw this monster was built with (its kind's, or the plain ghost claw for an explicit loadout);
    // a ready-made SkillSet is taken as given. Levels off leaves the skill untouched.
    const claw = this.#skills.skills.find((k) => k.kind === 'attack');
    if (claw && built && levelsOn()) claw.damage = Math.max(1, Math.round(claw.damage * clawMult(this.#level)));
    this.#clawDamage = claw?.damage ?? stats.clawDamage;
    this.syncSkills();
  }

  get level() {
    return this.#level;
  }

  get clawDamage() {
    return this.#clawDamage;
  }

  get speed() {
    return this.#speed;
  }

  get skills() {
    return this.#skills;
  }

  get facing() {
    return this.#facing;
  }

  set facing(dir) {
    if (!DIRS[dir]) throw new TypeError(`unknown facing ${dir}`);
    this.#facing = dir;
  }

  get hp() {
    return this.#hp;
  }

  get maxHp() {
    return this.#maxHp;
  }

  get stun() {
    return this.#stun;
  }

  // One tick of stun passes; true when the ghost was stunned this tick (it skips its step and its Jev call).
  // With a `game` the stun is a deadline on the world clock (WP-D): stunned while game.now() is before it.
  tickStun(game = null) {
    if (game && this.#stunUntil !== null) {
      if (game.now() < this.#stunUntil) { if (this.#stun > 0) this.#stun--; return true; }
      this.#stunUntil = null;
      this.#stun = 0;
      return false;
    }
    if (this.#stun <= 0) return false;
    this.#stun--;
    return true;
  }

  // Stunned right now (a read; unlike tickStun it spends nothing).
  stunnedAt(game) {
    return this.#stunUntil !== null && game ? game.now() < this.#stunUntil : this.#stun > 0;
  }

  // A hit on this ghost from `fromPos` (the attacker's cell): lose hp, and unless that was the last hp get knocked
  // 1 cell directly away (dominant axis, ties x) when that cell is floor and not `fromPos`, and stunned
  // stunTicks ticks. Knockback needs the `game` (for its map); without it the ghost only loses hp and is stunned.
  // Returns { hp, dispelled }; the caller (resolve.js) removes a dispelled ghost from the game.
  takeHit(damage, fromPos, game = null) {
    this.#hp = Math.max(0, this.#hp - damage);
    if (this.#hp === 0) return { hp: 0, dispelled: true };
    const stun = this.stunTicks;
    if (stun === 0) return { hp: this.#hp, dispelled: false, staggered: false }; // a troll shrugs the blow off: no wound morale, knockback or lost step
    queueMorale(this, { type: 'wounded', damage }); // morale: the wound and the turn its stun costs
    const dx = this.pos[0] - fromPos[0], dy = this.pos[1] - fromPos[1];
    const step = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
    const to = [this.pos[0] + step[0], this.pos[1] + step[1]];
    if (game && (step[0] || step[1]) && isFloor(game.dungeon, to) && !same(to, fromPos)) this.pos = to;
    this.#stun = stun;
    this.#stunUntil = game ? game.now() + stun * game.rules.stepMs : null;
    this.budget = 0;
    this.#route = null; // patrol routes assume contiguous cells
    return { hp: this.#hp, dispelled: false, staggered: true };
  }

  // Ticks a sword hit stuns this monster (its kind's own, else the global stunTicks); 0 = it is never staggered.
  get stunTicks() {
    return kindOf(this.#kind).stunTicks() ?? skillConfig().stunTicks;
  }

  // Mirrors the SkillSet into the memory (plain JSON, at most 4).
  syncSkills() {
    setSkills(this.#hunt.memory, this.#skills.summaries());
  }

  get kind() {
    return this.#kind;
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

// Linear layout (dungeon.layout.kind 'linear'): the only way to the portal is through the monsters. Never in the
// start room; the portal room gets one first, each side room a guardian half the time, and the rest go to path rooms
// weighted toward the portal (spread out: a room's weight falls with every monster already in it).
function linearSpawns(dungeon, rand, count, ok) {
  const rooms = dungeon.rooms ?? [];
  const cellsOf = rooms.map((r) => (r.role === 'start' ? [] : shuffleWith(rand, roomCells({ ...dungeon, rooms: [r] }).filter(ok))));
  const taken = new Set();
  const picks = rooms.map(() => 0);
  const picked = [];
  const take = (i) => {
    const c = cellsOf[i].find((cell) => !taken.has(key(cell)));
    if (!c) return false;
    taken.add(key(c));
    picks[i]++;
    picked.push(c);
    return true;
  };
  const portal = rooms.findIndex((r) => r.role === 'portal');
  if (portal >= 0 && picked.length < count) take(portal);
  // Side-room guardians take at most half of what is left after the portal guard, so a small map
  // (2-3 monsters) still has monsters on the path itself.
  let sideLeft = Math.floor((count - picked.length) / 2);
  rooms.forEach((r, i) => {
    if (r.role !== 'side') return;
    if (rand() < 0.5 && sideLeft > 0 && take(i)) sideLeft--; // drawn for every side room, so the stream does not depend on count
  });
  const path = rooms.map((r, i) => i).filter((i) => rooms[i].role === 'path' || rooms[i].role === 'portal');
  const n = Math.max(2, path.length);
  while (picked.length < count) {
    const open = path.filter((i) => cellsOf[i].some((cell) => !taken.has(key(cell))));
    if (!open.length) break;
    const weights = open.map((i) => (1 + 2 * (rooms[i].order ?? 0) / (n - 1)) / (1 + picks[i]) ** 2);
    let t = rand() * weights.reduce((s, w) => s + w, 0);
    let at = open.length - 1;
    for (let k = 0; k < open.length; k++) if ((t -= weights[k]) < 0) { at = k; break; }
    take(open[at]);
  }
  return picked;
}

export function spawnAdversaries(dungeon) {
  const rand = rng(dungeon.seed ^ 0x9e3779b9);
  const count = Math.min(MAX_ADVERSARIES, Math.max(1, Math.round(countFloor(dungeon) / FLOOR_PER_ADVERSARY))); // 0 when MAX_ADVERSARIES is 0
  const dist = floorDistances(dungeon, dungeon.start);
  const ok = (c) =>
    (dist.get(key(c)) ?? -1) >= MIN_SPAWN_STEPS &&
    !(euclid(c, dungeon.start) <= startSight() && hasLineOfSight(dungeon, dungeon.start, c));
  const picked = dungeon.layout?.kind === 'linear' ? linearSpawns(dungeon, rand, count, ok) : [];
  if (dungeon.layout?.kind !== 'linear') {
    // One candidate list per room, so adversaries spread over different rooms first.
    const perRoom = (dungeon.rooms ?? [])
      .map((r) => shuffleWith(rand, roomCells({ ...dungeon, rooms: [r] }).filter(ok)))
      .filter((cells) => cells.length);
    shuffleWith(rand, perRoom);
    for (let round = 0; picked.length < count && perRoom.some((cells) => cells.length > round); round++) {
      for (const cells of perRoom) if (picked.length < count && cells[round]) picked.push(cells[round]);
    }
  }
  // Kinds and characters come from their own streams and are drawn after every spawn rng call, so dungeons and ghost cells never change.
  const characters = CHARACTERS_ON ? assignSpawnCharacters(dungeon.seed, picked.length) : [];
  const kinds = assignKinds(dungeon.seed, picked.length, TROLL_SHARE);
  const levels = assignLevels(dungeon.seed, kinds); // its own stream, after the kinds
  return picked.map((pos, i) => new Adversary({ id: `a${i + 1}`, pos: [...pos], character: kindOf(kinds[i]).character ?? characters[i] ?? 'standard', kind: kinds[i], level: levels[i] }));
}

// The numbers this ghost's code runs with. A standard ghost follows the live settings (today's behaviour);
// any other character uses its profile (character.js). Loners answer a call only when the explorer is close.
function knobsOf(a) {
  const base = plainKnobsOf(a);
  const mood = MORALE_ON ? a.hunt.knobs : null; // its morale's stance wins over its character's numbers
  if (!mood) return base;
  return { ...base, maxSearchTicks: mood.maxSearchTicks, keepHuntingMin: mood.keepHuntingMin, makesCalls: mood.calls };
}

// The monster's own numbers, before morale: the live settings for a standard character, else its profile.
function plainKnobsOf(a) {
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

// Sight is symmetric: always tested explorer -> adversary so both sides agree. Only in revealed
// areas: an adversary standing on an unlit (fogged) cell neither sees the explorer nor is seen by it,
// so SIGHT_RANGE may exceed LIGHT_RADIUS without the explorer seeing into the dark. Within
// LIGHT_RADIUS of the explorer every cell is lit, so the default range of 7 is unaffected.
// `explorer` (an id or ExplorerState) tests that one explorer; without it, whichever active explorer the monster
// would react to (the nearest it sees), so with one explorer nothing changes.
export function seesExplorer(game, adversary, explorer = null) {
  const e = explorer === null ? game.targetExplorer(adversary.pos) : game.explorer(explorer);
  return euclid(e.pos, adversary.pos) <= SIGHT_RANGE && game.isKnown(adversary.pos) &&
    hasLineOfSight(game.dungeon, e.pos, adversary.pos);
}

// Trigger for patrol/search -> chase. The user wrote "has a direct line of sight ... and is at
// least 7 steps away"; we build the "within 7" reading pending confirmation. To flip it,
// change `<= CHASE_RANGE` to `>= CHASE_RANGE` on the line below. Note: seesExplorer already caps
// distance at SIGHT_RANGE (7), so the flipped trigger only fires when SIGHT_RANGE is raised too.
export function startsChase(game, adversary) {
  return seesExplorer(game, adversary) && euclid(game.targetExplorer(adversary.pos).pos, adversary.pos) <= knobsOf(adversary).chaseRange;
}

// The adversaries one explorer (default: the primary) sees right now.
export function visibleAdversaries(game, explorer = null) {
  const e = game.explorer(explorer);
  return (game.adversaries ?? [])
    .filter((a) => seesExplorer(game, a, e))
    .map((a) => ({ id: a.id, pos: [...a.pos], mode: a.mode, distance: Math.round(euclid(e.pos, a.pos) * 10) / 10 }));
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
  a.lastSeen = [...game.targetExplorer(a.pos).pos];
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
  if (!knobsOf(spotter).makesCalls) return; // a loner does not call (a shaken monster calls anyway: morale)
  const near = floorDistances(game.dungeon, spotter.pos);
  const target = game.targetExplorer(spotter.pos).pos;
  let answered = false;
  for (const o of game.adversaries) {
    if (o === spotter || o.hunt.on) continue;
    const d = near.get(key(o.pos));
    const hear = knobsOf(o);
    if (d === undefined || d > hear.alertSteps) continue;
    if (!hear.answersCalls) {
      // A loner answers only when the explorer is already close to it.
      const toExplorer = hear.answersWithin === null ? undefined : floorDistances(game.dungeon, o.pos).get(key(target));
      if (toExplorer === undefined || toExplorer > hear.answersWithin) continue;
    }
    o.mode = 'search';
    o.lastSeen = [...target];
    o.goal = null;
    o.route = null;
    switchOnAlerted(o, tick, target, spotter.hunt.heading, spotter.id);
    viewOf(game, o).hear(viewOf(game, spotter), target, tick); // the call carries the spotter's nearby known cells
    sweepFrom(viewOf(game, o), o);
    events.push({ id: o.id, type: 'alerted', at: [...o.pos], by: spotter.id });
    events.push({ id: o.id, type: 'brain_on', at: [...o.pos] });
    answered = true;
  }
  if (answered) queueMorale(spotter, 'help_came'); // it is not hunting alone any more
}

function turnOff(a, events, tick, reason) {
  // A routed monster keeps away for ROUT_REST ticks whatever its character; a calm one rests its own time.
  a.hunt.restUntil = tick + (reason.startsWith('routed') ? Math.max(ROUT_REST, knobsOf(a).restTicks) : knobsOf(a).restTicks);
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
    const where = game.targetExplorer(a.pos).pos;
    a.lastSeen = [...where];
    const own = seesExplorer(game, a);
    // Team sight: a packmate that sees the explorer calls out where it is, and its nearby known cells come with the call.
    if (!own && limitedActive()) {
      const caller = [...game.adversaries].sort(byId).find((o) => o !== a && o.hunt.on && seesExplorer(game, o));
      if (caller) viewOf(game, a).hear(viewOf(game, caller), where, tick);
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

// --- morale (PLAN-monster-morale.md) ---------------------------------------------------------
// One phase per tick, after sensing and before any budget or Jev call, walked in id order, so the
// parallel decisions can never change what a monster feels. Everything here is fog-safe: a monster's own
// hit points and skills, what its AdversaryView shows, and the death cry of a packmate within earshot.

// Packmates hunting within this monster's alert reach (the same reach as a call for help).
function supportFor(game, a) {
  const mates = viewOf(game, a).teammates().filter((o) => o.role !== 'patrolling');
  if (!mates.length) return 0;
  const reach = knobsOf(a).alertSteps;
  const near = floorDistances(game.dungeon, a.pos);
  return mates.filter((o) => (near.get(key(o.pos)) ?? Infinity) <= reach).length;
}

// Is the explorer boxed in right next to this monster? Only ever asked while it is in sight, so it is
// something the monster can actually see.
function corneredNow(game, a) {
  const at = game.targetExplorer(a.pos).pos;
  if (!a.hunt.inSight || euclid(a.pos, at) > 2) return false;
  const ways = Object.values(DIRS).filter(([dx, dy]) => isFloor(game.dungeon, [at[0] + dx, at[1] + dy])).length;
  return ways <= 2;
}

// The tick's death cries: every monster that saw or heard a packmate dispelled loses morale for it.
function deathCries(game, order) {
  for (const dead of game.dispelled ?? []) {
    for (const a of order) {
      const reach = knobsOf(a).alertSteps;
      const near = floorDistances(game.dungeon, a.pos);
      const steps = near.get(key(dead.at));
      const heard = steps !== undefined && steps <= reach;
      const seenIt = euclid(a.pos, dead.at) <= SIGHT_RANGE && hasLineOfSight(game.dungeon, a.pos, dead.at);
      if (heard || seenIt) queueMorale(a, 'packmate_lost');
    }
  }
}

function moralePhase(game, order, stunned, events, tick) {
  if (!MORALE_ON) return;
  deathCries(game, order);
  const swordDamage = skillConfig().swordDamage || 1;
  for (const a of order) {
    const view = viewOf(game, a);
    const report = applyMorale(a, tick, {
      hp: a.hp,
      maxHp: a.maxHp,
      strikesToDispel: Math.max(1, Math.ceil(a.hp / swordDamage)),
      armed: view.explorerArmed(),
      stunned: stunned.has(a),
      support: supportFor(game, a),
      cornered: corneredNow(game, a),
    });
    // Rout: morale has collapsed, so the monster breaks off and keeps away until it recovers (ROUT_REST).
    if (report?.entered && a.hunt.on) {
      events.push({ id: a.id, type: 'routed', at: [...a.pos], morale: report.value });
      turnOff(a, events, tick, `routed: morale ${Math.floor(report.value)} (${report.band})`);
    }
  }
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
  let target = h.inSight ? game.targetExplorer(a.pos).pos : a.lastSeen;
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
function knockBack(game, a, from = null, ex = game.targetExplorer(a.pos)) {
  a.route = null; // patrol routes assume contiguous cells
  // The budget is kept on purpose: a bump must not cost the ghost its next act, or a ghost bumped every tick
  // (explorer pushing it down a corridor) would never strike. Only a sword hit stuns (Adversary.takeHit).
  if (from && isFloor(game.dungeon, from) && !same(from, ex.pos)) {
    a.pos = [...from];
    return;
  }
  const prev = ex.trail?.length > 1 ? ex.trail.at(-2) : null;
  const options = neighbours(game.dungeon, a.pos).filter((c) => !same(c, ex.pos) && !game.explorerAt(c));
  const pick = options.find((c) => !prev || !same(c, prev)) ?? options[0];
  if (pick) a.pos = pick;
}

// Bump check: an adversary on the explorer's cell. A touch no longer hurts (PLAN-skills D3): the ghost is only
// knocked back (event 'bump'), with no life lost and no grace started, so no adversary ever ends a tick on a
// living explorer. Only a claw strike (strikeWith) takes lives.
function bumpCheck(game, a, events, from = null) {
  if (game.lost) return;
  const ex = game.explorerAt(a.pos); // any explorer: a touch only bumps
  if (!ex) return;
  events.push({ id: a.id, type: 'bump', at: [...a.pos] });
  knockBack(game, a, from, ex);
}

// The direction of the single step from `from` to `to`, or null (no step).
const dirBetween = (from, to) => Object.keys(DIRS).find((d) => same(stepCell(from, d), to)) ?? null;

// This ghost's claw strike (key of its latest skill options): turns to the aim, flashes the cells and, if the
// explorer stands in them, rolls the explorer's block, then the grace/latch gate, then takes the life(s).
// `latch` is the tick's one-hit-per-tick gate. Returns { events, used, lost }.
function strikeWith(game, a, key, latch) {
  const picked = a.skills.get(key);
  if (!picked || !picked.skill.ready || picked.skill.kind !== 'attack') return { events: [], used: null, lost: false };
  a.facing = picked.target.dir;
  const events = resolveAttack(game, a, picked.target.cells, picked.skill.damage, {
    canHit: (e) => latch.canHit(e),
    onHit: (e) => {
      latch.markHit(e);
      game.setGrace(e, GRACE_TICKS);
      noteHit(a, game.adversaryTicks);
    },
  });
  picked.skill.markUsed(game.steps);
  // Morale: what the claw achieved. A hit raises it, the shield and the explorer's grace lower it.
  if (events.some((e) => e.type === 'hit')) queueMorale(a, 'clawed');
  else if (events.some((e) => e.type === 'blocked')) queueMorale(a, 'blocked');
  else if (game.strikes.at(-1)?.result === 'protected') queueMorale(a, 'shrugged');
  return { events, used: key, lost: events.some((e) => e.type === 'caught') };
}

// Grace ticks left after the latest hit (0 = the explorer can be hit). Fog-safe: it is the
// explorer's own state.
export function graceLeft(game, explorer = null) {
  return game.graceLeftSteps(explorer);
}

// Lives one claw strike of this ghost takes (the rules text tells Jev).
const clawDamage = (a) => a.skills.skills.find((k) => k.kind === 'attack')?.damage ?? 1;

// The tick's hit gate: one hit per explorer per tick, none while `open(explorer)` is false (grace).
function hitLatch(game, open) {
  const hurt = new Set();
  return {
    get hit() { return hurt.size > 0; },
    canHit(e = game.explorers[0]) { return !hurt.has(e.id) && open(e); },
    markHit(e) { hurt.add(e.id); },
  };
}

const byId = (p, q) => p.id.localeCompare(q.id, 'en', { numeric: true });

// One tick for every adversary. Order: grace read and decrement, stunned ghosts lose a stun tick, bump check
// (an explorer that stepped onto a ghost only knocks it back), sensing, budgets. Brain-on ghosts with a step and
// no stun ask Jev in parallel (requests built synchronously in id order, from the state after the explorer's move).
// Then, in id order, each acting ghost: skill (claw strike, hunting ghosts only) -> step -> bump check.
// A strike uses the grace read taken at the start of the tick and the `hit` latch: at most one life lost per tick,
// none during grace (the strike still flashes, result 'protected'). Losing the last life emits 'hit' then 'caught'
// and ends the tick at once.
// -> { events, turns: [{ id, dir, decision|null, keep_hunting, brain: 'on'|'off', apiMs, skill_decision: null|{ choice, probabilities, used: key|null }, stunned?, error? }] }
export async function stepAdversaries(game, { decide: ask = null } = {}) {
  const { ctx, thinkers } = beginAdversaryTick(game);
  if (ctx.over) return { events: ctx.events, turns: ctx.turns };
  try {
    // Requests are built synchronously, in id order, inside decideAdversary (the option shuffle uses Math.random).
    const results = new Map(await Promise.all(thinkers.map(async (a) => [a, await decideAdversary(game, a, ctx, { decide: ask })])));
    for (const a of ctx.order) {
      if (applyAdversaryResult(game, a, ctx, results.get(a)).lost) break;
    }
  } finally {
    game.inTick = false; // the next time is the explorer phase of the next turn
  }
  return { events: ctx.events, turns: ctx.turns };
}

// An aborted decideAdversary(): the signal fired before or while its Jev call was in flight.
export { CallAborted }; // src/call-aborted.js: one CallAborted class for the whole program

const speedOf = (a) => ['wolf', 'tree_giant'].includes(a.kind) ? a.speed : ADVERSARY_SPEED * a.speed;
// How long a monster takes per step, in ms of world time: stepMs / speed. The hosted runtime schedules a monster's
// next movement that far after its previous one (never sooner than cadenceMs). `Run` keeps the budget path (speed per tick).
export const moveIntervalMs = (game, a) => game.rules.stepMs / speedOf(a);
const cfgFor = (a) => ({ speed: speedOf(a), maxSearchTicks: knobsOf(a).maxSearchTicks, graceTicks: GRACE_TICKS, hitDamage: clawDamage(a), characters: CHARACTERS_ON, limited: limitedActive() });

// The synchronous front of a world tick: grace, stun, bumps, the tick counter, views, sensing, morale, budgets.
// -> { ctx, thinkers }: `ctx` is the tick's context (events and turns so far, the grace read, the one-hit latch,
// the id order, who is stunned, the tick number; `ctx.over` is true when the game had ended and nothing ran) and
// `thinkers` the ghosts that act this tick with the brain on (they ask Jev, all from this same snapshot).
export function beginAdversaryTick(game) {
  const events = [];
  const turns = [];
  if (game.won || game.lost) return { ctx: { over: true, events, turns, order: [] }, thinkers: [] };
  // Grace is read once per explorer at the start of the tick, then counted down; a latch allows one hit per explorer per tick.
  // The clock owns grace now (WP-D): a deadline, nothing to count down.
  game.inTick = true;
  game.tickAt = game.managed ? game.clock : (game.adversaryTicks + 1) * game.rules.stepMs;
  const protectedNow = new Set(game.explorers.filter((e) => game.graceActive(e, game.tickAt)).map((e) => e.id));
  const hit = hitLatch(game, (e) => !protectedNow.has(e.id));
  const order = [...game.adversaries].sort(byId);
  const stunned = new Set(order.filter((a) => a.tickStun(game)));
  for (const a of order) bumpCheck(game, a, events);
  const tick = game.adversaryTicks + 1;
  game.adversaryTicks = tick;

  for (const a of order) ageHunt(a, tick);
  for (const a of order) viewOf(game, a).update(tick); // limited maps: stamp what each ghost sees, in id order, before anyone senses
  for (const a of order) senseStart(game, a, events, tick);
  moralePhase(game, order, stunned, events, tick);
  for (const a of order) if (!stunned.has(a)) a.budget += speedOf(a); // a stunned ghost gains no budget
  const thinkers = order.filter((a) => !stunned.has(a) && a.budget >= 1 && a.hunt.on);
  return { ctx: { over: false, events, turns, order, stunned, tick, hit, cfgOf: cfgFor }, thinkers };
}

// One ghost's Jev decision (async). The request body is built synchronously, before the first await, so ghosts
// started in id order build theirs in id order. `decide` replaces the Jev call (null = the real one). Never throws
// on a failed call (-> { error }); an aborted `signal` rejects with CallAborted. Does not touch the Game.
export function decideAdversary(game, a, ctx, { decide: ask = null, signal = null } = {}) {
  if (signal?.aborted) return Promise.reject(new CallAborted());
  const p = decide(viewOf(game, a), a, ctx.tick, ctx.cfgOf(a), ask, signal);
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CallAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((r) => { signal.removeEventListener('abort', onAbort); resolve(r); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

// The core of one acting ghost: skill (claw strike) -> step -> bump check -> keep_hunting -> sensing. Shared by the
// tick (stepAdversaries) and the single-monster turn. `res` is the decide() result (undefined = brain off: patrol).
// Returns true when a strike took the last life (the caller stops there).
function actOne(game, a, ctx, res, turn) {
  const { events, tick, hit } = ctx;
  const from = [...a.pos];
  if (res?.skill && res.skill !== 'none') {
    const strike = strikeWith(game, a, res.skill, hit);
    events.push(...strike.events);
    if (res.skill_decision) res.skill_decision.used = strike.used;
    if (strike.lost) {
      turn.skill_decision = res.skill_decision;
      turn.brain = a.hunt.on ? 'on' : 'off';
      a.syncSkills();
      return true;
    }
  }
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
      a.facing = dir;
      noteStep(a, from, dir, tick);
    }
    Object.assign(turn, { dir, decision: res.decision, keep_hunting: res.keep_hunting, apiMs: res.apiMs, skill_decision: res.skill_decision });
  } else {
    patrolStep(game, a); // brain off: code policy, never a strike
    turn.dir = dirBetween(from, a.pos);
    if (turn.dir) a.facing = turn.dir;
  }
  bumpCheck(game, a, events, from);
  a.skills.turnPassed();
  if (res && res.keep_hunting !== null && res.keep_hunting < knobsOf(a).keepHuntingMin && a.hunt.on) {
    turnOff(a, events, tick, `Jev judged the hunt not worth it (keep_hunting ${res.keep_hunting.toFixed(2)})`);
  }
  senseAfterStep(game, a, events, tick);
  turn.tabu = tabuReport(a, tick); // before the extra steps of a tick: they only extend the same direction
  return false;
}

// The synchronous back of a tick for one ghost, in id order: the turn record, then (when its budget allows) the
// skill, the step, the bump check, and the extra steps a fast monster spends its budget on. `result` is
// decideAdversary()'s answer (undefined for a ghost that did not think). -> { turn, lost }: `lost` means a strike
// took the last life and the tick ends (the caller applies no further ghost).
export function applyAdversaryResult(game, a, ctx, result) {
  const turn = { id: a.id, dir: null, decision: null, keep_hunting: null, brain: 'off', apiMs: 0, skill_decision: null, tabu: null };
  ctx.turns.push(turn);
  if (ctx.stunned.has(a)) {
    turn.stunned = true;
    turn.brain = a.hunt.on ? 'on' : 'off';
    a.syncSkills();
    return { turn, lost: false };
  }
  if (a.budget >= 1) {
    // Resolve attacks once per tick; fast monsters spend extra budget on movement below.
    a.budget -= 1;
    const res = result;
    if (actOne(game, a, ctx, res, turn)) return { turn, lost: true };
    const { events, tick } = ctx;
    // Continue the chosen direction without another decision or attack. Check every cell
    // so fast movement cannot cross walls or skip bumps and sightings.
    while (a.budget >= 1) {
      a.budget -= 1;
      const extraFrom = [...a.pos];
      if (res) {
        if (!turn.dir || !viewOf(game, a).legalMoves().includes(turn.dir)) continue;
        a.pos = stepCell(a.pos, turn.dir);
        noteStep(a, extraFrom, turn.dir, tick);
      } else {
        patrolStep(game, a);
        const dir = dirBetween(extraFrom, a.pos);
        if (dir) a.facing = dir;
      }
      bumpCheck(game, a, events, extraFrom);
      senseAfterStep(game, a, events, tick);
    }
  }
  a.syncSkills();
  turn.brain = a.hunt.on ? 'on' : 'off';
  return { turn, lost: false };
}

// ---- One monster at a time (the hosted runtime, where every monster has its own schedule) ----
// monsterTurnStart is the synchronous front of one monster's turn: stun, bump, ageing, view, sensing and morale for
// this monster alone. -> null when it does not act (game over, not in the game, stunned: that costs it the stun
// tick), else `start`, the context decideAdversary() and monsterTurnApply() take. `now` is the tick number the
// monster's memory is stamped with (default: the game's adversary tick counter, which only stepAdversaries moves).
// Grace is NOT counted down here (the world clock owns it); the claw reads it at apply time.
export function monsterTurnStart(game, a, { now = null } = {}) {
  if (game.won || game.lost || !game.adversaries.includes(a)) return null;
  const events = [];
  if (a.tickStun(game)) return null;
  bumpCheck(game, a, events);
  const tick = Number.isFinite(now) ? now : game.monsterTick();
  ageHunt(a, tick);
  viewOf(game, a).update(tick);
  senseStart(game, a, events, tick);
  moralePhase(game, [a], new Set(), events, tick);
  const hit = hitLatch(game, (e) => !game.graceActive(e)); // grace is read when the claw lands
  return { over: false, events, turns: [], order: [a], stunned: new Set(), tick, hit, cfgOf: cfgFor, thinks: a.hunt.on, from: [...a.pos] };
}

// The synchronous back of one monster's turn, validated against the CURRENT state: a monster that was dispelled or
// stunned since the start does nothing; a monster that was moved (knockback) since the start skips its claw (its
// cells are stale), and a step that is no longer legal is dropped. A claw hits whoever stands in its cells now.
// -> { turn, events, lost, stale? } with `events` the start's plus this turn's.
export function monsterTurnApply(game, a, start, result) {
  const stale = [];
  const turn = { id: a.id, dir: null, decision: null, keep_hunting: null, brain: a.hunt.on ? 'on' : 'off', apiMs: 0, skill_decision: null, tabu: null };
  const done = (lost = false) => ({ turn, events: start.events, lost, ...(stale.length ? { stale } : {}) });
  if (game.won || game.lost) { stale.push('game over'); return done(); }
  if (!game.adversaries.includes(a)) { stale.push('dispelled'); return done(); }
  if (a.stunnedAt(game)) { stale.push('stunned'); return done(); }
  let res = result ?? undefined;
  if (res) {
    res = { ...res };
    if (res.skill && res.skill !== 'none' && (a.pos[0] !== start.from[0] || a.pos[1] !== start.from[1])) { stale.push('moved: claw cells are stale'); res.skill = 'none'; res.skill_decision && (res.skill_decision.used = null); }
    if (res.dir && !res.error && !viewOf(game, a).legalMoves().includes(res.dir)) { stale.push('step no longer legal'); res.dir = null; }
  }
  const ctx = { ...start, turns: [turn] };
  const lost = actOne(game, a, ctx, res, turn);
  if (!lost) { a.syncSkills(); turn.brain = a.hunt.on ? 'on' : 'off'; }
  return done(lost);
}
