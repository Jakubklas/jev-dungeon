// The explorer's confidence score C (PLAN-confidence.md, model v3): pure functions, no imports, no clock,
// no randomness. C is 0..100, 50 at the start of every game. The explorer's own fights move it; code turns
// it into a risk dial (gaps, engageOpen) and Jev gets only its band word. Nothing imports this module yet
// (C2 wires it), so the explorer static guard and the acyclic chain are untouched.
//
// State (plain JSON): { value, counts: { strikes, blocked, evaded, pressed },
//   enc: { chased, hurt, killed, pressed } } where `enc` is the current encounter's bookkeeping
//   (pressed = points lost so far this encounter, for the per-encounter cap).
//
// Event vocabulary (apply(state, event, lives, maxLives); `event` is a string or { type }):
//   hit       a life was lost to a strike: -15, then the lives cap; marks the encounter hurt
//   struck    own strike landed, ghost survived: +6
//   dispelled own strike dispelled a ghost (it emits `dispelled`, not `struck`): +12; marks the encounter killed
//   blocked   own shield stopped a claw: +3, only up to BLOCK_CEILING (never lowers a higher C)
//   evaded    an encounter with a chasing sighting ended with no hit and no dispel: +4, only up to
//             EVADE_CEILING; closes the encounter
//   pressed   a chaser within 2 steps with the sword not ready: -2 per tick, at most -8 per encounter
//   calm      a step with no adversary in sight: +0.3, only while C < CALM_TARGET (repairs, never exceeds it)
// Every change ends with C clamped to 0..100 and to the lives cap.

export const START = 50;
export const D_HIT = -15;
export const D_STRUCK = 6;
export const D_DISPELLED = 12;
export const D_BLOCKED = 3;
export const D_EVADED = 4;
export const D_PRESSED = -2;
export const PRESSED_MAX = 8; // per encounter
export const D_CALM = 0.3;
export const CALM_TARGET = 50;
export const BLOCK_CEILING = 65;
export const EVADE_CEILING = 65;
export const LAST_LIFE_CAP = 45;
export const CAP_FLOOR = 0.3; // cap = 100 * (CAP_FLOOR + (1 - CAP_FLOOR) * lives / maxLives)
// Band lower bounds: <30 shaken, 30-39 unsure, 40-64 even, 65-79 sure, 80+ dominant.
export const BANDS = [[80, 'dominant'], [65, 'sure'], [40, 'even'], [30, 'unsure'], [0, 'shaken']];
// Gap deltas: +2 below 30, +1 below 40, 0 up to 79, -1 from 80. ENGAGE_MIN: engage needs C >= this.
export const GAP_STEPS = [[80, -1], [40, 0], [30, 1], [0, 2]];
export const ENGAGE_MIN = 40;
export const PRESSED_RANGE = 2; // steps, for applyTurn

const EVENTS = new Set(['hit', 'struck', 'dispelled', 'blocked', 'evaded', 'pressed', 'calm']);

const round2 = (v) => Math.round(v * 100) / 100; // keeps 0.3 steps free of float drift
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const freshEnc = () => ({ chased: false, hurt: false, killed: false, pressed: 0 });

export function createConfidence() {
  return { value: START, counts: { strikes: 0, blocked: 0, evaded: 0, pressed: 0 }, enc: freshEnc() };
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
  let v = state.value;
  const upTo = (d, ceiling) => (v >= ceiling ? v : Math.min(ceiling, v + d)); // never pulls a higher C down
  switch (type) {
    case 'hit': v += D_HIT; enc.hurt = true; break;
    case 'struck': v += D_STRUCK; counts.strikes += 1; break;
    case 'dispelled': v += D_DISPELLED; counts.strikes += 1; enc.killed = true; break;
    case 'blocked': v = upTo(D_BLOCKED, BLOCK_CEILING); counts.blocked += 1; break;
    case 'evaded': v = upTo(D_EVADED, EVADE_CEILING); counts.evaded += 1; Object.assign(enc, freshEnc()); break;
    case 'pressed': {
      const d = Math.min(-D_PRESSED, PRESSED_MAX - enc.pressed);
      enc.pressed += d; v -= d; counts.pressed += 1; break;
    }
    case 'calm': if (v < CALM_TARGET) v = Math.min(CALM_TARGET, v + D_CALM); break;
  }
  return { value: clamp(round2(Math.min(v, cap(lives, maxLives))), 0, 100), counts, enc };
}

// The idle step: a convenience for apply(state, 'calm', ...). Calm never lowers C, so the lives cap
// (default: none) only matters when the caller passes it.
export function calm(state, lives = 2, maxLives = 2) {
  return apply(state, 'calm', lives, maxLives);
}

export function band(C) {
  for (const [lo, name] of BANDS) if (C >= lo) return name;
  return 'shaken';
}

// min_gap delta for the mood's gap (the caller keeps the result at 2 or more; engage keeps its gap of 1).
export function gaps(C) {
  for (const [lo, d] of GAP_STEPS) if (C >= lo) return d;
  return 2;
}

export function engageOpen(C) {
  return C >= ENGAGE_MIN;
}

// Derives this turn's events from the explorer's turn shape as Run.playTurn returns it
// ({ skill_events, events, decision, ... }) and applies them in a fixed order: strikes, hit, blocked,
// then the encounter-end / pressed / calm step. Own state only (fog-safe). `ctx`:
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
  if (!visible.length) step('calm');
  else if (!armed && !engaging && visible.some((a) => a.mode === 'chase' && a.distance <= PRESSED_RANGE && !stunned.includes(a.id))) step('pressed');
  return s;
}
