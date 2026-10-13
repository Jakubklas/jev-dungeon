// An adversary's brain: one Jev request per adversary step while the brain is on.
// Code observes (perception.js), Jev decides, memory.js remembers. adversary.js runs the
// on/off state machine and calls decide() for every brain-on adversary with a step this tick,
// all in parallel.
//
// FOG: everything is read through an AdversaryView (adversary-view.js), never a Game. The explorer's
// position reaches Jev only while hunt.inSight (seesExplorer) is true.
// Out of sight, Jev gets last_seen only. Never the treasure, never the explorer's light/visits.
// Each Adversary keeps the exact body of its last request, for auditing.
//
// Code policies (no Jev): switch on at startsChase, direct_pursuit while in sight, take the only legal move
// (unless a skill is offered: then a skill-only request), switch off after MAX_SEARCH_TICKS. A patrolling ghost
// (brain off) never strikes: it has not seen the explorer hunt-wise, and a bump only starts a hunt through the
// usual sight rules. Stepping onto the explorer is only a bump now (PLAN-skills D3), so it is no longer forced.
// Jev decides: every other move, cut_off vs sweep_last_seen on the first search step, keep_hunting on every
// search step, and (in sight, explorer adjacent) the claw `skill` question, in the SAME request as next_move.
import { SIGHT_RANGE } from '../../dungeon.js';
import { APPROACHES, SEARCH_APPROACHES, approachOption, compass8, describeMoves, situation, stepCell, sweep } from './perception.js';
import { addEvent, addLandmark, addSighting, ageMemory, brainOff, brainOn, count, createMemory, recordAction, recordStep, setApproach, setMorale } from './memory.js';
import { shuffle, jevModel } from '../../jev.js';
import { PRESETS, profileOf, strikeLineFor, traitsOf } from './character.js';
import { DEFAULT_MOOD, apply as applyMoraleEvent, band as moraleBand, capability, combine, moodFor, moodKnobs, moraleOf, routNext, startHunt, tierOf, MOODS } from './morale.js';
import { pickSkill, skillQuestion } from '../../skills/question.js';
import { add as tabuAdd, age as tabuAge, createTabu, filterOptions, snapshot as tabuSnapshot } from '../shared/tabu.js';

export let KEEP_HUNTING_MIN = 0.5; // keep_hunting.noul below this switches the brain off (live: src/settings.js)
export const setKeepHuntingMin = (v) => { KEEP_HUNTING_MIN = v; };
// Smart memory (sightings, landmarks, recent path, lifetime counters, team reports) is active only with the
// adversaryCharacters toggle (src/settings.js -> configureAdversaries). Off: memory and requests are as before.
export let MEMORY_ON = false;
export const setMemoryOn = (v) => { MEMORY_ON = Boolean(v); };
// Monster morale (PLAN-monster-morale.md, morale.js) is active only with the monsterMorale toggle
// (src/settings.js -> configureAdversaries). Off: no morale state reaches a request and every knob is today's.
export let MORALE_ON = false;
export const setMoraleOn = (v) => { MORALE_ON = Boolean(v); };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
let PINGPONGS = 3; // back-and-forth steps while searching before the search approach is chosen again
// Tabu for monsters (PLAN-tabu phase 5, shared/tabu.js): a cell the hunt kept bouncing to or looping through, and a search
// approach that ping-ponged, are taken off the request. Defaults are the explorer's (live: src/settings.js -> configureAdversaryBrain).
let TABU_ON = true;
let TABU_BOUNCE_TENURE = 6;
let TABU_LOOP_WINDOW = 12;
let TABU_LOOP_VISITS = 3;
let TABU_LOOP_TENURE = 8;
let TABU_MIN_MOVES = 2;

const PRESET_STYLE = (id) => PRESETS[id].style;
const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

// The rules text, built from the live tunables: speed, search time, hit damage, grace ticks (cfg) and SIGHT_RANGE.
function rules({ speed, maxSearchTicks, hitDamage = 1, graceTicks = 4, limited = false }, smart = false, morale = false) {
  const lives = hitDamage === 1 ? 'a life' : `${hitDamage} lives`;
  const ticks = `${graceTicks} tick${graceTicks === 1 ? '' : 's'}`;
  // With morale on the objective is honest: the explorer also wins by dispelling every monster, so survival counts.
  const survive = morale
    ? ' Its sword can dispel you for good, and clearing us all out wins it the dungeon, so surviving is part of your objective; `self.morale` is how your fight is going.'
    : '';
  const claw = `Touching is harmless: stepping onto the explorer only bumps it and you are knocked back. Only your claw strike (\`self.skills\`, one skill per step at most, most steps need none) hurts it: the explorer loses ${lives} and cannot be hurt for ${ticks} after a hit. `;
  if (smart) {
    // Shorter text for ghosts with memory: the state carries the rest (landmarks, sightings, team reports).
    return (
      'A dungeon grid of walls and floor. You are one of several adversaries hunting an explorer who seeks a hidden treasure chest. ' +
      `You move one cell per step (up, down, left, right) at ${Math.round(speed * 100)}% of the explorer's speed, so you cannot outrun it. ` +
      (limited
        ? 'You know only your home area and the cells you have seen lately; the rest is unknown and old cells fade. A spot with path_steps null has no known route: head for the edge of what you know. '
        : 'You know the whole map. ') +
      `You see the explorer only with a clear line of sight within ${SIGHT_RANGE} cells; out of sight you only have your remembered sightings (frozen, with their age) and landmarks. ` +
      claw +
      `Your objective: catch the explorer before it finds the treasure. After ${maxSearchTicks} ticks without sight, or if you stop hunting, you go back to patrolling.` + survive
    );
  }
  return (
    'A dungeon on a grid of walls and floor. You are one of several adversaries hunting an explorer who is looking for a hidden treasure chest. ' +
    `You move one cell per step (up, down, left or right) at ${Math.round(speed * 100)}% of the explorer's speed, so you cannot outrun it in a straight race. ` +
    `You know the whole map. You see the explorer only with a clear line of sight within ${SIGHT_RANGE} cells; out of sight you only know where and when you last saw it and which way it was heading. ` +
    claw +
    'The explorer is caught when its last life is gone. Adversaries may share a cell. ' +
    'Your objective: catch the explorer before it finds the treasure. ' +
    `If you stop hunting, or go ${maxSearchTicks} ticks without seeing the explorer, you go back to patrolling.` + survive
  );
}

// Hunt state of one adversary (owned by the Adversary as a private field, so its contracted shape
// stays the same).
//   on, inSight (seesExplorer this tick), heading (explorer's last move when last seen, frozen out of
//   sight), ticksSinceSeen, swept (cells checked since sight was lost), cutOff (cached cut-off point),
//   dists (recent path distances while in sight), trend (frozen distance trend), pickApproach,
//   probabilities (of the last next_move answer: for the UI only, Jev never reads them), memory
//   profile (the ghost's character numbers: sweepRadius, cutMax, preferredSearch, ...), restUntil (world tick before which a
//   ghost that just gave up does not start a new hunt)
export function newHunt(id, profile = profileOf(traitsOf('standard')), character = 'standard') {
  return {
    on: false, inSight: false, heading: null, ticksSinceSeen: 0, swept: new Set(), cutOff: null, dists: [], trend: null,
    pickApproach: false, probabilities: null, profile, restUntil: 0, pingpongs: 0, lostNear: false, hidLogged: false, areaLogged: false,
    // Morale (morale.js): the score itself, the events waiting for the next morale phase, and the derived
    // mood. It is never reset by a hunt (startHunt only clears the per-hunt slip budget), so a monster
    // remembers that it was nearly killed. `knobs` is null while the toggle is off: then nothing changes.
    morale: moraleOf(profile), moraleQueue: [], mood: DEFAULT_MOOD, tier: 'mid', rout: false, knobs: null,
    // Tabu (PLAN-tabu phase 5): private, never in memory, never sent. `ring` is the cells of the current hunt's steps (the
    // memory's own `recent.cells` is empty with adversaryCharacters off), `told` the entries already written as an event.
    tabu: createTabu(), ring: [], told: new Set(), tabuTurn: null, searchTicks: 18,
    memory: createMemory(id, character),
  };
}

// A hunt starts and ends clean: no cell or approach carries over.
const resetTabu = (h) => { h.tabu = createTabu(); h.ring = []; h.told = new Set(); };

// Default Jev call, in the shape of an injected `ask`.

function trendText(dists) {
  if (dists.length < 2) return `${dists[0] ?? '?'} path steps away`;
  const first = dists[0], last = dists.at(-1);
  const word = last < first ? 'closing' : last > first ? 'widening' : 'steady';
  return `${word}: ${first} → ${last} path steps over the last ${dists.length - 1} tick${dists.length === 2 ? '' : 's'}`;
}

// --- state transitions (called by adversary.js) -------------------------------------------

// The explorer is in sight now (seesExplorer). Call once per sense.
export function seen(view, a, tick, { startOfTick, own = true }) {
  const h = a.hunt;
  const resighted = !h.inSight; // sight is called twice a tick: only the change counts
  h.inSight = true;
  h.heading = view.heading() ?? h.heading;
  h.ticksSinceSeen = 0;
  h.swept.clear();
  h.cutOff = null;
  h.pickApproach = false;
  if (resighted) h.tabu.entries = h.tabu.entries.filter((e) => e.level !== 'approach'); // sight regained: a new search starts clean
  if (startOfTick) {
    const d = view.distancesFrom(a.pos).get(key(view.explorer()));
    if (d !== undefined) h.dists = [...h.dists, d].slice(-4);
  }
  const m = h.memory;
  if (resighted && count(m, 'sightings') === 1) {
    const e = view.explorer();
    const n = Math.round(Math.hypot(e[0] - a.pos[0], e[1] - a.pos[1]));
    addEvent(m, `First sighting: the explorer to the ${compass8(a.pos, e)}, about ${n} cells away.`, tick);
  }
  if (MEMORY_ON) {
    const e = view.explorer();
    addSighting(m, { cell: e, tick, heading: h.heading, source: own ? 'seen' : 'called' }, h.profile.sightingsKept);
    if (resighted && m.tally.sightings === 1) addLandmark(m, { kind: 'explorer_seen', cell: e, tick, note: 'where the explorer was first seen in this hunt' }, h.profile.landmarksCap);
    h.pingpongs = 0;
    h.lostNear = false;
  }
  m.progress.ticks_since_seen = 0;
  m.progress.distance_trend = trendText(h.dists);
  setApproach(m, { id: 'direct_pursuit', text: APPROACHES.direct_pursuit.text }, 'the explorer is in sight again', tick);
}

export function switchOn(view, a, tick) {
  const h = a.hunt;
  h.on = true;
  h.dists = [];
  resetTabu(h);
  brainOn(h.memory, tick, 'spotted the explorer', { keepEvents: MEMORY_ON });
  h.morale = startHunt(h.morale); // a new hunt, a fresh slip budget; the score itself carries over
  if (MEMORY_ON) addHome(a, tick);
  seen(view, a, tick, { startOfTick: true });
}

// The pinned landmark: the ghost's spawn cell (its home territory).
function addHome(a, tick) {
  addLandmark(a.hunt.memory, { kind: 'home', cell: a.home, tick, note: 'your home ground' }, a.hunt.profile.landmarksCap);
}

// A neighbour spotted the explorer and shouted: this adversary joins the hunt in search mode at the
// spot where it was seen, heading as it was then. No sight, so nothing beyond last_seen leaks.
export function switchOnAlerted(a, tick, at, heading, by) {
  const h = a.hunt;
  h.on = true;
  h.inSight = false;
  h.dists = [];
  resetTabu(h);
  h.heading = heading;
  h.ticksSinceSeen = 0;
  h.swept.clear();
  h.cutOff = null;
  h.pickApproach = true;
  h.trend = null;
  brainOn(h.memory, tick, `${by} spotted the explorer and called for help`, { keepEvents: MEMORY_ON });
  h.morale = startHunt(h.morale);
  queueMorale(a, 'help_came'); // it is not alone: the pack is on the explorer
  if (MEMORY_ON) {
    addHome(a, tick);
    addSighting(h.memory, { cell: at, tick, heading, source: 'called', by }, h.profile.sightingsKept);
  }
  setApproach(h.memory, { id: 'sweep_last_seen', text: APPROACHES.sweep_last_seen.text }, `${by} called for help`, tick);
  count(h.memory, 'alerts_heard');
  addEvent(h.memory, `${by} spotted the explorer and called for help; last seen at [${at[0]}, ${at[1]}].`, tick);
}

// Sight lost: the next step picks a search approach.
export function lostSight(view, a, tick) {
  const h = a.hunt;
  h.inSight = false;
  h.trend = h.memory.progress.distance_trend;
  h.pickApproach = true;
  h.cutOff = null;
  sweepFrom(view, a);
  count(h.memory, 'lost_sight');
  queueMorale(a, 'slipped');
  if (MEMORY_ON && a.lastSeen) {
    addLandmark(h.memory, { kind: 'explorer_lost', cell: a.lastSeen, tick, note: 'where sight of the explorer broke' }, h.profile.landmarksCap);
    h.lostNear = dist(a.pos, a.lastSeen) <= 4;
    h.hidLogged = false;
    h.areaLogged = false;
  }
}

// Once per tick while searching.
export function searchTick(a, view = null, tick = 0) {
  const h = a.hunt;
  h.inSight = false;
  h.ticksSinceSeen += 1;
  h.memory.progress.ticks_since_seen = h.ticksSinceSeen;
  h.memory.progress.distance_trend = `out of sight for ${h.ticksSinceSeen} tick${h.ticksSinceSeen === 1 ? '' : 's'}; before that ${h.trend ?? 'unknown'}`.slice(0, 160);
  if (MEMORY_ON && view && a.lastSeen && !(h.hidLogged && h.areaLogged)) noteSearchResults(view, a, tick);
}

// Two facts a search can establish, each logged once per loss of sight: the explorer lost within 4 cells
// and everything near there now checked (it is in a pocket nearby), and the whole sweep area checked.
function noteSearchResults(view, a, tick) {
  const h = a.hunt;
  const radius = h.profile.sweepRadius;
  let nearAll = true, checked = 0, total = 0;
  for (const [k, d] of view.distancesFrom(a.lastSeen)) {
    if (d <= 4 && !h.swept.has(k)) nearAll = false;
    if (d <= radius) {
      total++;
      if (h.swept.has(k)) checked++;
    }
  }
  const cap = h.profile.landmarksCap;
  if (!h.hidLogged && h.lostNear && h.ticksSinceSeen >= 1 && nearAll) {
    h.hidLogged = true;
    addLandmark(h.memory, { kind: 'explorer_hid', cell: a.lastSeen, tick, note: 'lost within 4 cells and everything in view since is checked: it is in a pocket nearby' }, cap);
  }
  if (!h.areaLogged && total > 0 && checked === total) {
    h.areaLogged = true;
    addLandmark(h.memory, { kind: 'area_checked', cell: a.lastSeen, tick, note: `everything within ${radius} steps of here is checked: nothing found` }, cap);
  }
}

export function hunted(a) {
  a.hunt.memory.progress.ticks_hunting += 1;
}

// Marks what this adversary sees from its cell as checked (search mode only).
export function sweepFrom(view, a) {
  sweep(view, a.hunt);
}

export function switchOff(a, tick, reason) {
  const h = a.hunt;
  h.on = false;
  h.inSight = false;
  h.swept.clear();
  h.cutOff = null;
  h.dists = [];
  h.pickApproach = false;
  h.ticksSinceSeen = 0;
  resetTabu(h);
  brainOff(h.memory, tick, reason);
  addEvent(h.memory, `Gave up: ${reason}`, tick);
  if (!reason.startsWith('routed')) queueMorale(a, 'gave_up'); // a rout already paid for itself
}

// This adversary just hit the explorer (called by adversary.js when its claw strike lands).
export function noteHit(a, tick) {
  const m = a.hunt.memory;
  addEvent(m, `Hit the explorer (hit ${count(m, 'hits')}).`, tick);
  m.lifetime.hits += 1;
  if (MEMORY_ON) addLandmark(m, { kind: 'hit_here', cell: a.pos, tick, note: 'where you hit the explorer' }, a.hunt.profile.landmarksCap);
}

// This ghost stepped `dir` from `from` (a brain-on step). Smart memory records its own path and, while
// searching, forces a new search_approach choice after PINGPONGS steps that returned to the cell it left.
// Tabu (monsters, phase 5) keeps its own ring of cells so it works with smart memory off too, rules out the cell a
// bounce or loop keeps returning to (M1, M2) and, when the search ping-pong fires, the approach that ping-ponged.
export function noteStep(a, from, dir, tick) {
  const h = a.hunt;
  const tabuPing = TABU_ON ? scoreTabu(a, from, tick) : false;
  if (!MEMORY_ON && !TABU_ON) return;
  const p = h.profile;
  const m = h.memory;
  let ping = tabuPing;
  if (MEMORY_ON) {
    if (!m.recent.cells.length) m.recent.cells = [[...from]];
    ping = recordStep(m, a.pos, dir, { moves: p.recentMoves, cells: p.recentCells });
  }
  if (!h.on || h.inSight) { h.pingpongs = 0; return; }
  if (ping) h.pingpongs += 1;
  if (h.pingpongs >= PINGPONGS) {
    h.pingpongs = 0;
    h.pickApproach = true;
    if (TABU_ON && forceApproach(a, tick)) return;
    addEvent(m, 'Kept stepping back and forth while searching: choosing a search approach again.', tick);
  }
}

// The search ping-pong fired: the approach in force becomes tabu for the character's search time, and when that leaves
// one search approach code takes it (no `search_approach` question next). Returns true when it did.
function forceApproach(a, tick) {
  const h = a.hunt;
  const m = h.memory;
  const was = m.approach.id;
  if (!SEARCH_APPROACHES.includes(was)) return false;
  tabuAdd(h.tabu, 'approach', was, { step: tick, tenure: h.searchTicks, reason: 'kept stepping back and forth' });
  const { allowed } = filterOptions(SEARCH_APPROACHES, h.tabu, 'approach', tick, { min: 1 });
  if (allowed.length !== 1) return false;
  const id = allowed[0];
  if (id !== was) setApproach(m, { id, text: APPROACHES[id].text }, `kept stepping back and forth under ${was}`, tick);
  h.pickApproach = false;
  h.tabuTurn = { ...(h.tabuTurn ?? {}), forced_approach: id };
  addEvent(m, `Ruled out ${was} for ${h.searchTicks} ticks: kept stepping back and forth. Taking ${id}.`, tick);
  return true;
}

// Scores one step for the move level; returns whether the last move returned to the cell two back (the ring's ping).
function scoreTabu(a, from, tick) {
  const h = a.hunt;
  if (!h.on) return false;
  const c = h.ring;
  if (!c.length) c.push([...from]);
  c.push([...a.pos]);
  if (c.length > TABU_LOOP_WINDOW + 1) c.shift();
  tabuAge(h.tabu, tick);
  const n = c.length;
  let bounces = 0; // backAndForth over the last 6 moves, as the explorer's memory counts it
  for (let t = 0; t < 6; t++) {
    const i = n - 1 - t;
    if (i < 2) break;
    if (same(c[i], c[i - 2]) && !same(c[i], c[i - 1])) bounces++;
  }
  const ping = n >= 3 && same(c[n - 1], c[n - 3]) && !same(c[n - 1], c[n - 2]);
  if (ping && bounces >= 2) tabuAdd(h.tabu, 'cell', key(c[n - 2]), { step: tick, tenure: TABU_BOUNCE_TENURE, reason: 'kept stepping back and forth' });
  const seen = new Map();
  for (const e of c) seen.set(key(e), (seen.get(key(e)) ?? 0) + 1);
  for (const [k, v] of seen) if (v >= TABU_LOOP_VISITS) tabuAdd(h.tabu, 'cell', k, { step: tick, tenure: TABU_LOOP_TENURE, reason: 'kept coming back to it' });
  return ping;
}

// The legal moves minus the cells ruled out (by destination, so M1 and M2 hold whichever way the cell is reached).
// Aspiration: the step onto the explorer (in sight) is never removed, and the list keeps `TABU_MIN_MOVES`.
// One memory event per entry, the first time a request really drops its move. -> { moves, removed, lifted }
function moveMenu(view, a, h, legal, tick) {
  const none = { moves: legal, removed: [], lifted: [] };
  if (!TABU_ON || !h.on || legal.length < 2) return none;
  const entries = [];
  for (const e of h.tabu.entries) {
    if (e.level !== 'cell' || e.until <= tick) continue;
    for (const d of legal) if (key(stepCell(a.pos, d)) === e.attr) entries.push({ level: 'm', attr: d, since: e.since, until: e.until, encounter: false, reason: e.reason });
  }
  if (!entries.length) return none;
  const x = h.inSight ? view.explorer() : null;
  const keep = x ? legal.filter((d) => same(stepCell(a.pos, d), x)) : [];
  const f = filterOptions(legal, { entries }, 'm', tick, { keep, min: TABU_MIN_MOVES });
  for (const d of f.removed) {
    const e = entries.find((o) => o.attr === d);
    const id = `cell:${e.since}:${d}`;
    if (h.told.has(id)) continue;
    h.told.add(id);
    addEvent(h.memory, `Ruled out the cell to the ${compassWord(d)} for ${e.until - tick} steps: ${e.reason}.`, tick);
  }
  return { moves: f.allowed, removed: f.removed, lifted: f.lifted };
}
// The tabu part of the adversary turn report (adversary.js, once per acting monster): the live entries by level
// (`cell`, `approach`: { attr, steps_left, reason }), what this tick's request dropped or put back, and the search approach
// code took. null with the level off. For the UI and checks, never for Jev.
export function tabuReport(a, tick) {
  if (!TABU_ON) return null;
  const h = a.hunt;
  const t = h.tabuTurn;
  h.tabuTurn = null;
  return { ...tabuSnapshot(h.tabu, tick), removed_moves: t?.removed_moves ?? [], lifted_moves: t?.lifted_moves ?? [], forced_approach: t?.forced_approach ?? null };
}
const compassWord = (d) => ({ up: 'north', down: 'south', left: 'west', right: 'east' }[d]);

// Start of a world tick: drops what has outlived this ghost's character-sized memory.
export function ageHunt(a, tick) {
  if (MEMORY_ON) ageMemory(a.hunt.memory, tick, a.hunt.profile);
}

// --- morale (PLAN-monster-morale.md) -------------------------------------------------------
// Code keeps the score; the mood it derives moves real knobs (knobsOf in adversary.js, the keep-distance
// and strike lines below). Events are QUEUED where they happen (a strike, a block, a death cry) and applied
// in one fixed phase per tick, in id order, so the parallel Jev calls can never change the outcome.

// Queues one morale event for the next morale phase. A no-op with the toggle off, so nothing is paid for.
export function queueMorale(a, event) {
  if (MORALE_ON) a.hunt.moraleQueue.push(event);
}

// One morale phase for one monster. `ctx` carries everything morale.js may not read itself (fog-safe, from
// adversary.js and its AdversaryView): own hit points, how many sword strikes would finish it, whether the
// explorer's sword is a threat right now, whether it is stunned, how many packmates hunt within earshot and
// whether the explorer is cornered next to it. Returns the report, or null with the toggle off.
// -> { value, band, tier, mood, rout, entered } (`entered` = it just broke off this tick)
export function applyMorale(a, tick, ctx) {
  const h = a.hunt;
  if (!MORALE_ON) { h.knobs = null; setMorale(h.memory, null); return null; }
  const { hp, maxHp, strikesToDispel, armed, stunned, support, cornered } = ctx;
  for (const e of h.moraleQueue) h.morale = applyMoraleEvent(h.morale, e, hp, maxHp);
  h.moraleQueue = [];
  if (cornered) h.morale = applyMoraleEvent(h.morale, 'cornered', hp, maxHp);
  h.morale = applyMoraleEvent(h.morale, 'regen', hp, maxHp);
  const R = capability({ hp, maxHp, strikesToDispel, armed, stunned, support, packWeight: h.profile.moralePack });
  const value = combine(R, h.morale.value, hp, maxHp, h.morale.baseline);
  const wasRout = h.rout;
  h.rout = routNext(value, wasRout);
  h.mood = h.rout ? 'rout' : moodFor(value, h.mood === 'rout' ? null : h.mood);
  h.tier = MOODS[h.mood].tier;
  h.knobs = moodKnobs(h.mood, h.profile);
  setMorale(h.memory, { value, baseline: h.morale.baseline, tier: h.tier, mood: h.mood, counts: h.morale.counts });
  return { value, band: moraleBand(value), tier: h.tier, mood: h.mood, rout: h.rout, entered: h.rout && !wasRout };
}

// What Jev reads: "48 steady". The number is floored, like the explorer's self.confidence.
export const moraleWord = (a) => `${Math.floor(a.memory.morale?.value ?? 0)} ${moraleBand(a.memory.morale?.value ?? 0)}`;

// The knobs in force for this monster: its mood's while morale is on, else its character's.
export const moodKnobsOf = (a) => a.hunt.knobs;
// --- the decision -------------------------------------------------------------------------

// What Jev reads, grouped like the explorer's state. `recent` and `self.approach` are the persistent
// memory (memory.js); the rest is recomputed from the real map each step (perception.js), and the
// explorer block holds a position only while it is in sight.
function jevState(view, a, h, tick, rulesText, withCharacter, smart) {
  const morale = MORALE_ON ? { morale: moraleWord(a) } : {};
  const m = h.memory;
  const { position, surroundings, explorer, last_seen, team, ...search } = situation(view, a, h, { smart, tick });
  return {
    game: rulesText,
    tick,
    self: {
      id: a.id,
      ...(withCharacter ? { character: { id: a.character, traits: h.profile.words, style: PRESET_STYLE(a.character) } } : {}),
      position, mode: h.inSight ? 'chase' : 'search', ...morale, approach: m.approach, latest_action: m.latest_action,
      skills: a.skills.summaries().map(({ text, ...rest }) => rest), // `text` is in the rules sentence
    },
    surroundings,
    explorer,
    last_seen,
    ...search,
    team,
    recent: smart
      ? { path: { moves: m.recent.moves, back_and_forth: m.recent.back_and_forth }, tally: m.tally, lifetime: m.lifetime, events: m.events, progress: m.progress }
      : { tally: m.tally, events: m.events, progress: m.progress },
  };
}

let SKILL_NEAR = 10; // loose gate (PLAN D7): the explorer in sight within this many cells

// The `skill` options from this ghost's own view: the explorer's position only while it is in sight (view.explorer()).
// Loose gate: a skill is ready and the explorer is in sight within SKILL_NEAR; the claw then lists one option per
// aim whose cell holds the explorer (so only when it is adjacent). {} when nothing is feasible.
function skillOptionsOf(view, a) {
  const e = view.explorer();
  if (!e || !a.skills.size) return {};
  const self = { pos: [...a.pos], opponentsNear: dist(a.pos, e) <= SKILL_NEAR, visibleOpponents: [{ id: 'the explorer', pos: e }] };
  return a.skills.options({ pos: [...a.pos], facing: a.facing }, self);
}

// Builds the request for one step. No world state changes (only the SkillSet's latest-options map). Returns { legal, forced } when no
// Jev call is needed (code policy), else { legal, state, questions, body, options, skillOptions }.
export function buildRequest(view, a, tick, cfg) {
  const { speed, maxSearchTicks } = cfg;
  const h = a.hunt;
  const special = a.character !== 'standard'; // a standard ghost's request text stays exactly today's
  const withCharacter = special || Boolean(cfg.characters);
  const all = view.legalMoves();
  if (!all.length) return { legal: all, forced: null };
  h.searchTicks = maxSearchTicks; // noteStep (tabu on the search approach) has no cfg
  const menu = moveMenu(view, a, h, all, tick);
  const legal = menu.moves; // the filtered list feeds the options AND the answer validation in decide()
  h.tabuTurn = menu.removed.length || menu.lifted.length ? { removed_moves: menu.removed, lifted_moves: menu.lifted } : null;
  const skillOptions = h.inSight ? skillOptionsOf(view, a) : {};
  const hasSkill = Object.keys(skillOptions).length > 0;
  const searching = !h.inSight;
  // Morale decides the stance: its line, how close it stays and how freely it claws. With the toggle off
  // (h.knobs null) these are exactly the character's own, so the request is byte-identical to today's.
  const strike = {
    line: MORALE_ON && h.knobs ? h.knobs.line : '',
    keepDistance: h.knobs?.keepDistance ?? h.profile.keepDistance,
    priority: MORALE_ON && h.knobs ? strikeLineFor(h.knobs.strikeLevel) : h.profile.skillPriority,
  };
  const approachIds = searching ? (h.pickApproach ? SEARCH_APPROACHES : [h.memory.approach.id]) : ['direct_pursuit'];
  const questions = {};
  let options = null;
  if (legal.length > 1) {
    const moves = describeMoves(view, a, h, approachIds, speed);
    options = Object.fromEntries(shuffle(legal).map((d) => [d, moves[d]]));
    const priorities = searching
      ? [
          h.pickApproach
            ? 'The explorer was just lost from sight and the search approach is being chosen this step (`search_approach`): prefer the move that serves the better search approach, starting from the path to the last-seen cell.'
            : 'Follow `self.approach.current`: prefer the move that brings this adversary closer to `approach_target`.',
          'Prefer moves that bring unchecked cells into view over moves that bring nothing new into view.',
          'Avoid undoing the previous move (`self.latest_action`) unless the target lies behind.',
          'Standing in a corridor, doorway or junction the explorer must pass is better than open room floor.',
        ]
      : [
          'You are slower than the explorer, so chasing from behind never catches it: the hit comes from cutting off its escape routes. Prefer the move that cuts off the most cells, especially cells no other adversary covers, so the explorer is boxed in between you and the others.',
          'Among moves that cut off about as much, prefer one that closes the path distance (`explorer.path_steps`), then one that keeps the explorer in sight, then one that blocks a corridor, doorway or junction ahead of it (`explorer.heading`).',
        ];
    if (special) priorities.splice(2, 0, h.profile.priority); // third priority: this ghost's character
    if (strike.line) priorities.splice(special ? 3 : 2, 0, strike.line); // ... then how its morale has it hunting
    // Caution: keep its distance from an explorer whose sword is ready (the trait is 3 only through a traits object).
    if (h.inSight && strike.keepDistance > 0 && view.explorerArmed()) {
      priorities.push(`The explorer's sword is ready: keep at least ${strike.keepDistance} cells away from it, and close in only to strike.`);
    }
    if (hasSkill && strike.priority) priorities.push(`Skills: ${strike.priority}`);
    questions.next_move = {
      type: 'choice',
      instructions: {
        question: searching && h.pickApproach
          ? 'The explorer just went out of sight. Which way should this adversary step next to achieve its objective, starting the search from `last_seen`? Judge each move from its description, the state and `recent.progress`.'
          : 'Which way should this adversary step next to achieve its objective, following `self.approach.current`? Judge each move from its description, the state and `recent.progress`.',
        priorities,
      },
      criteria: options,
    };
  }
  if (searching && h.pickApproach) {
    questions.search_approach = {
      type: 'choice',
      instructions:
        'The explorer just went out of sight (`last_seen`). Which search approach gives this adversary the best chance to catch it? Use `last_seen.heading`, the map facts and how far each target is.' +
        (special && h.profile.preferredSearch ? ` Your nature favours ${h.profile.preferredSearch}, but pick the other if it is clearly better. ${h.profile.priority}` : special ? ` ${h.profile.priority}` : ''),
      criteria: Object.fromEntries(shuffle(SEARCH_APPROACHES).map((id) => [id, approachOption(view, a, h, id)])),
    };
  }
  if (searching) {
    questions.keep_hunting = {
      type: 'noul',
      instructions:
        'Is it still worth hunting the explorer? Judge from `last_seen` (how long ago, how far), `checked_cells_near_last_seen`, `approach_target` and `recent.progress`. ' +
        `Hunting stops anyway after ${maxSearchTicks} ticks without sight; giving up sends this adversary back to patrolling the dungeon, where it may run into the explorer again.` +
        (special ? ` You are ${h.profile.words.persistence} (persistence).` : '') +
        (MORALE_ON ? ' Weigh `self.morale`: a monster with none left should let this one go.' : ''),
      criteria: {
        true: 'Keep hunting: the explorer was seen recently, and the approach still has a target worth reaching (unchecked space near the last-seen cell, or a cut-off point not reached yet).',
        false: 'Give up: the trail is cold. The explorer was seen long ago, the area around the last-seen cell is checked, or the cut-off point was reached and nothing came.',
      },
    };
  }
  // ONE skill question, in the same request as next_move. With no move question (one legal move) it is asked alone:
  // a skill-only request (PLAN D4-a), since a strike matters most in a cornered moment.
  if (hasSkill) questions.skill = skillQuestion(skillOptions, strike.priority);
  if (!Object.keys(questions).length) return { legal, forced: legal[0] };
  const state = jevState(view, a, h, tick, rules(cfg, Boolean(cfg.characters), MORALE_ON), withCharacter, Boolean(cfg.characters));
  const body = JSON.stringify({ model: jevModel(), state, questions });
  return { legal, state, questions, body, options, skillOptions };
}

// One step's decision. Never throws: a failed call returns { error } and the caller falls back
// to the code move. -> { dir|null, decision, keep_hunting, approach, forced, apiMs, error }
// `ask` replaces the Jev call (the checks inject stubs); required: build it with the gateway.
export async function decide(view, a, tick, cfg, ask = null, signal = null) {
  const h = a.hunt;
  const req = buildRequest(view, a, tick, cfg);
  if (!req.body) return { dir: req.forced, decision: null, keep_hunting: null, approach: null, forced: true, apiMs: 0, error: null, skill: 'none', skill_decision: null };
  a.lastRequestBody = req.body;
  if (typeof ask !== 'function') throw new Error('decide is required: build it with the gateway'); // outside the try: a missing caller is a bug, not a Jev failure
  const started = performance.now();
  let answers;
  try {
    answers = await ask({ id: a.id, state: req.state, questions: req.questions, body: req.body, signal });
  } catch (err) {
    return { dir: null, decision: null, keep_hunting: null, approach: null, forced: false, apiMs: Math.round(performance.now() - started), error: err.message ?? String(err), errorName: err.name ?? null, skill: 'none', skill_decision: null };
  }
  const apiMs = Math.round(performance.now() - started);
  let dir = req.legal.length === 1 ? req.legal[0] : null;
  let decision = null;
  if (req.questions.next_move) {
    const n = answers?.next_move;
    dir = req.legal.includes(n?.choice) ? n.choice : req.legal[0];
    decision = { choice: dir, probabilities: n?.probabilities ?? null, confidence: n?.confidence ?? null, options: req.options };
  }
  const approach = req.questions.search_approach && SEARCH_APPROACHES.includes(answers?.search_approach?.choice)
    ? answers.search_approach.choice
    : null;
  const keep = typeof answers?.keep_hunting?.noul === 'number' ? answers.keep_hunting.noul : null;
  // The skill answer: a key of the options Jev saw, only at or above SKILL_MIN, else none.
  let skill = 'none', skill_decision = null;
  if (req.questions.skill) {
    skill = pickSkill(answers?.skill, req.skillOptions);
    skill_decision = { choice: answers?.skill?.choice ?? null, probabilities: answers?.skill?.probabilities ?? null, used: null };
  }
  return { dir, decision, keep_hunting: keep, approach, forced: !decision, apiMs, error: null, answers, skill, skill_decision };
}

// Applies the parts of a decision that change memory (approach choice, latest action).
export function applyDecision(a, tick, res, { fallback = false } = {}) {
  const h = a.hunt;
  if (h.pickApproach && h.on && !h.inSight) {
    const id = res.approach ?? h.profile.preferredSearch ?? 'sweep_last_seen';
    const why = res.approach ? `lost sight of the explorer; Jev chose ${id}` : (id === 'sweep_last_seen' ? 'lost sight of the explorer; no Jev answer, sweeping by default' : `lost sight of the explorer; no Jev answer, ${id} by its nature`);
    setApproach(h.memory, { id, text: APPROACHES[id].text }, why, tick);
    h.pickApproach = false;
  }
  if (res.dir) {
    recordAction(h.memory, { dir: res.dir, decision: res.decision, forced: res.forced, fallback });
    h.probabilities = res.decision?.probabilities ?? null;
  }
}

// The brain part of Run.view().adversaries[] (turn.js).
export function brainView(a) {
  const m = a.memory;
  const l = m.latest_action;
  return {
    on: m.brain.on,
    approach: m.approach.id,
    approach_text: m.approach.current,
    approach_since: m.approach.since_step,
    objective: m.objective,
    latest_action: l ? { choice: l.choice, probabilities: a.hunt.probabilities, confidence: l.confidence } : null,
    last_reason: m.brain.last_reason,
  };
}

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen at once.
export function configureAdversaryBrain(o) {
  if (o.advPingpongs !== undefined) PINGPONGS = o.advPingpongs;
  if (o.advSkillNear !== undefined) SKILL_NEAR = o.advSkillNear;
  if (o.advTabuEnabled !== undefined) TABU_ON = o.advTabuEnabled;
  if (o.advTabuBounceTenure !== undefined) TABU_BOUNCE_TENURE = o.advTabuBounceTenure;
  if (o.advTabuLoopWindow !== undefined) TABU_LOOP_WINDOW = o.advTabuLoopWindow;
  if (o.advTabuLoopVisits !== undefined) TABU_LOOP_VISITS = o.advTabuLoopVisits;
  if (o.advTabuLoopTenure !== undefined) TABU_LOOP_TENURE = o.advTabuLoopTenure;
  if (o.advTabuMinMoves !== undefined) TABU_MIN_MOVES = o.advTabuMinMoves;
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const adversaryBrainSnapshot = () => ({ advPingpongs: PINGPONGS, advSkillNear: SKILL_NEAR, advTabuEnabled: TABU_ON, advTabuBounceTenure: TABU_BOUNCE_TENURE, advTabuLoopWindow: TABU_LOOP_WINDOW, advTabuLoopVisits: TABU_LOOP_VISITS, advTabuLoopTenure: TABU_LOOP_TENURE, advTabuMinMoves: TABU_MIN_MOVES });
