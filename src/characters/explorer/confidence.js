// The explorer's confidence score C (PLAN-confidence.md, model v3): pure functions, no imports, no clock,
// no randomness. C is 0..100, 50 at the start of every game. The explorer's own fights move it; code turns
// it into the history term of C = capability + history (below), which caps the moods. brain.js and memory.js import it
// (C2); it imports nothing itself, so the acyclic chain and the explorer static guard stay intact.
//
// State (plain JSON): { value, counts: { strikes, blocked, evaded, pressed },
//   enc: { chased, hurt, killed, pressed } } where `enc` is the current encounter's bookkeeping
//   (pressed = points lost so far this encounter, for the per-encounter cap).
//
// Event vocabulary (apply(state, event, lives, maxLives); `event` is a string or { type }):
//   hit       a life was lost to a strike: -7, then the lives cap; marks the encounter hurt
//   struck    own strike landed, ghost survived: +5
//   dispelled own strike dispelled a ghost (it emits `dispelled`, not `struck`): +8; marks the encounter killed
//   blocked   own shield stopped a claw: +3, only up to BLOCK_CEILING (never lowers a higher C)
//   evaded    an encounter with a chasing sighting ended with no hit and no dispel: +2, only up to
//             EVADE_CEILING; closes the encounter
//   pressed   a chaser within 2 steps with the sword not ready: -2 per tick, at most -8 per encounter
//   regen     PLAN-moods: 0.25 toward 50 from either side, but only after REGEN_WAIT ticks with no change to C
//             (any other event that moves C restarts the wait); the caller sends one per tick
// Every change ends with C clamped to 0..100 and to the lives cap.

export const START = 50;
export const D_HIT = -7;
export const D_STRUCK = 5;
export const D_DISPELLED = 8;
export const D_BLOCKED = 3;
export const D_EVADED = 2;
export const D_PRESSED = -2;
export const PRESSED_MAX = 8; // per encounter
export const REGEN = 0.25; // PLAN-moods: per tick, toward START, from above and below
export const REGEN_WAIT = 10; // ticks since C last changed before regen starts
export const TIER_LOW_MAX = 35; // low tier: C <= 35, mid 36..75, high > 75
export const TIER_HIGH_MIN = 76;
export const TIER_HYST = 5; // a tier is kept this far past its edge (low up to 40, high down to 71)
export const PANIC_ENTER = 20; // panic starts below this
export const PANIC_EXIT = 25; // and ends only at or above this
export const BLOCK_CEILING = 65;
export const EVADE_CEILING = 65;
export const LAST_LIFE_CAP = 45;
export const CAP_FLOOR = 0.3; // cap = 100 * (CAP_FLOOR + (1 - CAP_FLOOR) * lives / maxLives)
// Band lower bounds: <30 shaken, 30-39 unsure, 40-64 even, 65-79 sure, 80+ dominant.
export const BANDS = [[80, 'dominant'], [65, 'sure'], [40, 'even'], [30, 'unsure'], [0, 'shaken']];
export const PRESSED_RANGE = 2; // steps, for applyTurn

// The default event weights as one object, so C4's sweep can swap them (createConfidence({ weights })).
export const WEIGHTS = { hit: D_HIT, struck: D_STRUCK, dispelled: D_DISPELLED, blocked: D_BLOCKED, evaded: D_EVADED, pressed: D_PRESSED };

const EVENTS = new Set(['hit', 'struck', 'dispelled', 'blocked', 'evaded', 'pressed', 'regen']);

const round2 = (v) => Math.round(v * 100) / 100; // keeps 0.3 steps free of float drift
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const freshEnc = () => ({ chased: false, hurt: false, killed: false, pressed: 0 });

// createConfidence() is the shipped model. C4's arms: { weights: {hit, struck, ...} } overrides some weights
// (kept in the state as `w`, only when given, so the default state shape is unchanged), and { model: 'beta' }
// is the weight-free alternative: value = 100 * (landed + 2) / (landed + taken + 4), landed = own strikes that
// landed (struck or dispelled), taken = hits; blocked, evaded, pressed and regen do not move it. The lives cap
// still applies to both. `start` (default START) forces the history score from tick 0: the caps checks drive C with it
// (PLAN-confidence-mood phase 3); with the lives cap applied by the first event, never by the constructor.
export function createConfidence({ weights = null, model = null, start = START } = {}) {
  return {
    value: start, idle: 0, counts: { strikes: 0, blocked: 0, evaded: 0, pressed: 0 }, enc: freshEnc(),
    ...(weights ? { w: { ...WEIGHTS, ...weights } } : {}),
    ...(model === 'beta' ? { model: 'beta', beta: { landed: 0, taken: 0 } } : {}),
  };
}

// Highest C the lives left allow: 100 with full lives (or one life in all), LAST_LIFE_CAP on the last
// life, else 100 * (0.3 + 0.7 * lives / maxLives) rounded.
export function cap(lives, maxLives) {
  if (maxLives <= 1 || lives >= maxLives) return 100;
  if (lives <= 1) return LAST_LIFE_CAP;
  return Math.round(100 * (CAP_FLOOR + (1 - CAP_FLOOR) * lives / maxLives));
}

// Returns a new state (the input is never mutated).
export function apply(state, event, lives, maxLives) {
  const type = typeof event === 'string' ? event : event?.type;
  if (!EVENTS.has(type)) throw new Error(`unknown confidence event: ${type}`);
  const counts = { ...state.counts };
  const enc = { ...(state.enc ?? freshEnc()) };
  const w = state.w ?? WEIGHTS;
  const beta = state.model === 'beta' ? { ...state.beta } : null;
  let v = state.value;
  const idle = state.idle ?? 0;
  const upTo = (d, ceiling) => (v >= ceiling ? v : Math.min(ceiling, v + d)); // never pulls a higher C down
  switch (type) {
    case 'hit': v += w.hit; enc.hurt = true; if (beta) beta.taken += 1; break;
    case 'struck': v += w.struck; counts.strikes += 1; if (beta) beta.landed += 1; break;
    case 'dispelled': v += w.dispelled; counts.strikes += 1; enc.killed = true; if (beta) beta.landed += 1; break;
    case 'blocked': v = upTo(w.blocked, BLOCK_CEILING); counts.blocked += 1; break;
    case 'evaded': v = upTo(w.evaded, EVADE_CEILING); counts.evaded += 1; Object.assign(enc, freshEnc()); break;
    case 'pressed': {
      const d = Math.min(-w.pressed, PRESSED_MAX - enc.pressed);
      enc.pressed += d; v -= d; counts.pressed += 1; break;
    }
    case 'regen': if (idle >= REGEN_WAIT) v = v < START ? Math.min(START, v + REGEN) : Math.max(START, v - REGEN); break;
  }
  if (beta) v = 100 * (beta.landed + 2) / (beta.landed + beta.taken + 4); // the posterior replaces every weighted change
  const value = clamp(round2(Math.min(v, cap(lives, maxLives))), 0, 100);
  // regen counts the quiet ticks and never restarts its own wait; any other event restarts it when it moved C
  const nextIdle = type === 'regen' ? idle + 1 : value !== state.value ? 0 : idle;
  return {
    value, idle: nextIdle, counts, enc,
    ...(state.w ? { w: state.w } : {}), ...(beta ? { model: 'beta', beta } : {}),
  };
}

// The brain saw a chasing adversary: this encounter now counts for 'evaded'. Returns a new state.
export function seeChase(state) {
  return { ...state, enc: { ...(state.enc ?? freshEnc()), chased: true } };
}

// The encounter is over (the brain's chase_over): 'evaded' if it had a chasing sighting and neither a hit nor a
// dispel, then a fresh encounter record either way. Returns a new state (same rule as applyTurn).
export function closeEncounter(state, lives, maxLives) {
  const e = state.enc ?? freshEnc();
  if (e.chased && !e.hurt && !e.killed) return apply(state, 'evaded', lives, maxLives);
  return { ...state, enc: freshEnc() };
}

// PLAN-moods tiers. `prev` is the tier held so far (hysteresis at both edges); null starts from C alone.
export function tierOf(C, prev = null) {
  if (C <= TIER_LOW_MAX || (prev === 'low' && C <= TIER_LOW_MAX + TIER_HYST)) return 'low';
  if (C >= TIER_HIGH_MIN || (prev === 'high' && C >= TIER_HIGH_MIN - TIER_HYST)) return 'high';
  return 'mid';
}

// Panic starts below PANIC_ENTER and ends only at PANIC_EXIT or more (no flicker at the edge).
export function panicNext(C, wasPanic = false) {
  return wasPanic ? C < PANIC_EXIT : C < PANIC_ENTER;
}

export function band(C) {
  for (const [lo, name] of BANDS) if (C >= lo) return name;
  return 'shaken';
}

// Derives this turn's events from the explorer's turn shape as Run.playTurn returns it
// ({ skill_events, events, decision, ... }) and applies them in a fixed order: strikes, hit, blocked,
// then the encounter-end / regen / pressed step. Own state only (fog-safe). `ctx`:
//   lives, maxLives  after the turn
//   armed            the sword was ready at the start of the turn
//   visible          [{ id, distance, mode }] adversaries in sight (the brain's own view)
//   engaging         the approach is `engage`
//   stunned          ids the explorer's own strike stunned recently (never "pressing")
export function applyTurn(state, turn, { lives, maxLives, armed = true, visible = [], engaging = false, stunned = [] } = {}) {
  let s = state;
  const step = (e) => { s = apply(s, e, lives, maxLives); };
  // Run.playTurn's `events` already contains skill_events, so count each struck / dispelled once.
  const events = turn.events ?? [];
  const strikeEvents = (turn.skill_events ?? turn.events ?? []).filter((e) => e.type === 'struck' || e.type === 'dispelled');
  for (const e of strikeEvents) step(e.type);
  if (events.some((e) => e.type === 'hit')) step('hit');
  for (const e of events) if (e.type === 'blocked') step('blocked');
  if (visible.some((a) => a.mode === 'chase')) s = { ...s, enc: { ...s.enc, chased: true } };
  if (turn.decision?.trigger === 'chase_over') {
    if (s.enc.chased && !s.enc.hurt && !s.enc.killed) step('evaded');
    else s = { ...s, enc: freshEnc() };
  }
  step('regen');
  if (visible.length && !armed && !engaging && visible.some((a) => a.mode === 'chase' && a.distance <= PRESSED_RANGE && !stunned.includes(a.id))) step('pressed');
  return s;
}

// ---- PLAN-confidence-mood phase 1: capability R, combine, the mood caps (pure; nothing here touches apply()) ----
// R is what the explorer can take on right now, from own state and what it knows of the ghosts; H (the score
// above) shifts it. allowedMoods turns C into the list of moods the sentiment question may offer.

// Expected lives lost per extra ghost beyond the first, per point of claw damage. 0.35 is the owner's default (a bolder
// explorer: three 2-hp ghosts at 2 lives read 'even', 43); 0.5 is the measured worst case (a walk-in Jev, PLAN-confidence-mood
// table 3) and stays exported so tests and the later measurement can compare the two.
export const W_PER_EXTRA = 0.35;
export const W_PER_EXTRA_SAFE = 0.5;
export const HIST_SPAN = 30; // a remembered sighting fades linearly to nothing over this many steps; h = clamp(H - 50, -30, +30)
export const NO_SWORD_MAX = 20; // without an attack skill R never exceeds this
const HP_BASE = 0.75; // hpW(g) = 0.75 + 0.125 * min(5, strikes to dispel it): 1 strike 0.875, 2 strikes 1.0, 3 strikes 1.125
const HP_SLOPE = 0.125;
const HP_STRIKES_MAX = 5;

// Weight of a remembered sighting `ageSteps` old: 1 when fresh, 0 from HIST_SPAN on (a visible ghost has weight 1).
export function sightWeight(ageSteps) {
  return clamp(1 - Math.max(0, ageSteps) / HIST_SPAN, 0, 1);
}

// Capability R, 0..100. ghosts: [{ hp, weight }] (visible: weight 1; remembered: sightWeight(age)). `steady` is the brain's
// stunHolds rule (stun >= 2 and sword cooldown < stun). Worst-case expected lives lost clearing the ghosts:
//   W = clawDamage * wPerExtra * max(0, k - 1)   when steady (the first ghost is free: the hold lets the sword strike first)
// ASSUMPTION: for a non-steady setting W = clawDamage * wPerExtra * k (no free first ghost). Only sword cooldown 2 follow was
// measured (PLAN-confidence-mood table 3b); phase 2 verifies it. Without an attack skill R <= NO_SWORD_MAX.
export function capability({ lives, maxLives = lives, clawDamage = 1, swordDamage = 1, steady = true, armed = true, ghosts = [] }, wPerExtra = W_PER_EXTRA) {
  const sd = swordDamage > 0 ? swordDamage : 1;
  let k = 0;
  for (const g of ghosts) {
    const strikes = Math.min(HP_STRIKES_MAX, Math.ceil(Math.max(0, g.hp) / sd));
    k += (g.weight ?? 1) * (HP_BASE + HP_SLOPE * strikes);
  }
  const W = clawDamage * wPerExtra * (steady ? Math.max(0, k - 1) : k);
  const R = clamp(Math.round(100 * (lives - W) / (lives + 1)), 0, 100);
  return armed ? R : Math.min(R, NO_SWORD_MAX);
}

// C = clamp(R + h, 0, cap(lives, maxLives)): history shifts capability by at most +-HIST_SPAN, the lives cap still applies.
export function combine(R, H, lives, maxLives) {
  const h = clamp(H - START, -HIST_SPAN, HIST_SPAN);
  return clamp(R + h, 0, cap(lives, maxLives));
}

// PLAN-moods: the moods each tier offers, in the order the sentiment question lists them. `panic` is entered by code below
// PANIC_ENTER and is never offered; a tier never offers another tier's moods.
export const TIER_MOODS = { low: ['wary', 'guarded'], mid: ['cautious', 'steady', 'greedy'], high: ['bold', 'fearless'] };
export const tierOfMood = (id) => (id === 'panic' || TIER_MOODS.low.includes(id) ? 'low' : TIER_MOODS.high.includes(id) ? 'high' : TIER_MOODS.mid.includes(id) ? 'mid' : null);

// The moods the sentiment question may list at C. ctx: { lastLife, swordDown, current }. The tier comes from C with the hysteresis
// of tierOf, held from the tier the current mood belongs to; a last life or a chaser close by with the sword down (dangers code
// can name) force the low tier.
export function allowedMoods(C, { lastLife = false, swordDown = false, current = null } = {}) {
  if (lastLife || swordDown) return [...TIER_MOODS.low];
  return [...TIER_MOODS[tierOf(C, tierOfMood(current))]];
}

// The mood a silent swap lands on when the current one is no longer offered: steady if offered, else guarded, else bold, else the first.
export function defaultMood(list) {
  return ['steady', 'guarded', 'bold'].find((id) => list.includes(id)) ?? list[0];
}
