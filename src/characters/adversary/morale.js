// A monster's morale M (PLAN-monster-morale.md): the ghost-side twin of the explorer's confidence.
// M = combine(capability(...), history), 0..100, capped by the monster's own hit points. Code turns it into a
// tier, the tier into a mood, and the mood into real knobs (keep-distance, strike level, how fast it gives up,
// whether it calls for help, rout). Called "morale", not confidence, because `confidence` already means Jev's
// own answer confidence in this folder (memory.latest_action.confidence, decision.confidence).
//
// Pure: no imports, no clock, no randomness, so the adversary static guard (check-dungeon.mjs section 0b) is
// untouched and every value is deterministic from the seed. Numbers that live outside this folder (the
// explorer's sword damage, the claw) are passed IN by adversary.js, which is the guard-exempt file.
//
// State (plain JSON): { value, baseline, hurt, regen, idle, counts: { clawed, wounded, blocked, lost }, hunt: { slipped } }
//   value    the history score H (starts at the character's baseline, so the history shift starts at 0)
//   baseline where regen pulls H back to: the character's `moraleStart` (aggression)
//   hurt     multiplier on every negative event: the character's `moraleHurt` (the `caution` trait)
//   regen    points per quiet tick: the character's `moraleRegen` (persistence)
//   idle     ticks since H last moved (regen waits REGEN_WAIT of them, like the explorer's)
//
// Event vocabulary (apply(state, event, hp, maxHp); `event` is a string or { type, damage }):
//   clawed        my claw took a life from the explorer: +8
//   wounded       I lost hp to a sword strike (and the turn its stun costs me): D_WOUNDED, scaled by the
//                 share of my health gone. Capability already knows I am hurt, so this is the sting, not the sum.
//   blocked       my claw was stopped by the shield: -5
//   shrugged      my claw landed during the explorer's grace (result 'protected'): -2
//   packmate_lost a packmate was dispelled within sight or hearing (the death cry): -15
//   help_came     a packmate answered my call: +4, only up to HELP_CEILING
//   cornered      the explorer is in sight, close, with almost no way out: +3, only up to CORNERED_CEILING
//   slipped       I lost sight of the explorer: -2, at most SLIPPED_MAX per hunt
//   gave_up       the hunt ended (timeout or keep_hunting): -6
//   regen         `regen` points toward `baseline` from either side, once REGEN_WAIT quiet ticks have passed
// Every change ends clamped to 0..100 and to the hp cap.

export let D_CLAWED = 8;
export let D_WOUNDED = -10; // at full damage share (a strike that takes half my health costs half of it)
export let D_BLOCKED = -5;
export let D_SHRUGGED = -2;
export let D_PACKMATE_LOST = -15;
export let D_HELP = 4;
export let D_CORNERED = 3;
export let D_SLIPPED = -2;
export let SLIPPED_MAX = 8; // per hunt
export let D_GAVE_UP = -6;
export let HELP_CEILING = 65;
export let CORNERED_CEILING = 65;
export let REGEN_WAIT = 10; // quiet ticks before regen starts (any event that moves H restarts the wait)
export let TIER_LOW_MAX = 35; // low tier: M <= 35, mid 36..69, high >= 70
export let TIER_HIGH_MIN = 70;
export let TIER_HYST = 5; // a tier is kept this far past its edge
// Rout is the monster's panic. It sits LOWER than the explorer's (20/25) on purpose: a monster has less
// survival instinct than the knight, so it holds on longer before it breaks (owner's decision).
export let ROUT_ENTER = 12;
export let ROUT_EXIT = 20;
export let ROUT_REST = 8; // ticks a routed monster will not start a new hunt
export let LAST_HP_CAP = 40; // highest M on the last hit point
export let CAP_FLOOR = 0.3; // cap = 100 * (CAP_FLOOR + (1 - CAP_FLOOR) * hp / maxHp)
export let SPAN = 30; // history shifts capability by at most +-SPAN
export let CAPABILITY_MAX = 70; // capability alone never exceeds this
export let EXPOSURE = 0.5; // how much of capability an armed explorer that can kill me in one strike takes away
export let PACK_BONUS = 8; // capability per supporting packmate (weighted by the `pack` trait)
export let PACK_MAX = 3; // supporting packmates counted
export let STUN_MAX = 20; // capability while stunned: it cannot act at all
// Band lower bounds, the words Jev reads: <30 broken, 30-39 wavering, 40-64 steady, 65-79 eager, 80+ savage.
export const BANDS = [[80, 'savage'], [65, 'eager'], [40, 'steady'], [30, 'wavering'], [0, 'broken']];

const EVENTS = new Set(['clawed', 'wounded', 'blocked', 'shrugged', 'packmate_lost', 'help_came', 'cornered', 'slipped', 'gave_up', 'regen']);
export const EVENT_IDS = [...EVENTS];

const round2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const freshHunt = () => ({ slipped: 0 });

// `profile` is the character's profile (character.js profileOf): moraleStart, moraleRegen, moraleHurt.
export function createMorale({ start = 55, regen = 0.25, hurt = 1 } = {}) {
  return { value: start, baseline: start, hurt, regen, idle: 0, counts: { clawed: 0, wounded: 0, blocked: 0, lost: 0 }, hunt: freshHunt() };
}
export const moraleOf = (profile = {}) => createMorale({ start: profile.moraleStart, regen: profile.moraleRegen, hurt: profile.moraleHurt });

// Highest M the hit points left allow: 100 at full hp (or with a single hit point in all), LAST_HP_CAP on the
// last one, else 100 * (0.3 + 0.7 * hp/maxHp) rounded. A wounded monster can never reach the high tier.
export function cap(hp, maxHp) {
  if (maxHp <= 1 || hp >= maxHp) return 100;
  if (hp <= 1) return LAST_HP_CAP;
  return Math.round(100 * (CAP_FLOOR + (1 - CAP_FLOOR) * hp / maxHp));
}

// Returns a new state (the input is never mutated). `hp`/`maxHp` only scale a wound; the cap is combine's.
export function apply(state, event, hp, maxHp) {
  const type = typeof event === 'string' ? event : event?.type;
  if (!EVENTS.has(type)) throw new Error(`unknown morale event: ${type}`);
  const counts = { ...state.counts };
  const hunt = { ...(state.hunt ?? freshHunt()) };
  const idle = state.idle ?? 0;
  const hurt = state.hurt ?? 1;
  const baseline = state.baseline ?? 55;
  const regen = state.regen ?? 0.25;
  let v = state.value;
  const down = (d) => v + d * hurt; // every negative event is scaled by the character's sensitivity
  const upTo = (d, ceiling) => (v >= ceiling ? v : Math.min(ceiling, v + d)); // never pulls a higher M down
  switch (type) {
    case 'clawed': v += D_CLAWED; counts.clawed += 1; break;
    case 'wounded': {
      const share = maxHp > 0 ? clamp(2 * (typeof event === 'object' ? (event.damage ?? 1) : 1) / maxHp, 0, 2) : 1;
      v = down(D_WOUNDED * share);
      counts.wounded += 1;
      break;
    }
    case 'blocked': v = down(D_BLOCKED); counts.blocked += 1; break;
    case 'shrugged': v = down(D_SHRUGGED); break;
    case 'packmate_lost': v = down(D_PACKMATE_LOST); counts.lost += 1; break;
    case 'help_came': v = upTo(D_HELP, HELP_CEILING); break;
    case 'cornered': v = upTo(D_CORNERED, CORNERED_CEILING); break;
    case 'slipped': {
      const d = Math.min(-D_SLIPPED * hurt, SLIPPED_MAX - hunt.slipped);
      hunt.slipped += d;
      v -= d;
      break;
    }
    case 'gave_up': v = down(D_GAVE_UP); break;
    case 'regen': if (idle >= REGEN_WAIT) v = v < baseline ? Math.min(baseline, v + regen) : Math.max(baseline, v - regen); break;
  }
  // The hp cap is applied by combine(), not here: H is the history, M is what the hit points allow.
  const value = clamp(round2(v), 0, 100);
  const nextIdle = type === 'regen' ? idle + 1 : value !== state.value ? 0 : idle;
  return { ...state, value, idle: nextIdle, counts, hunt };
}

// A new hunt begins: the per-hunt `slipped` budget starts over. H itself persists (a monster does not forget
// that it was nearly killed), which is the whole point of morale lasting across hunts.
export function startHunt(state) {
  return { ...state, hunt: freshHunt() };
}

// Capability R, 0..100: what this monster can take on right now, from its own state and what its view shows.
//   hp, maxHp         own hit points
//   strikesToDispel   how many sword strikes would finish it (ceil(hp / swordDamage)), passed in by adversary.js
//   armed             the explorer's sword is a threat (view.explorerArmed(): in sight = armed)
//   stunned           it is stunned this tick (it cannot act at all)
//   support           packmates hunting within earshot (view.teammates())
//   packWeight        the character's `moralePack` (loner 0, pack hunter 1)
export function capability({ hp, maxHp = hp, strikesToDispel = Math.max(1, hp), armed = false, stunned = false, support = 0, packWeight = 0.5 }) {
  const base = Math.min(CAPABILITY_MAX, (100 * hp) / (hp + 1));
  const exposure = armed ? 1 / Math.max(1, strikesToDispel) : 0; // one strike from death = fully exposed
  const help = PACK_BONUS * packWeight * Math.min(PACK_MAX, Math.max(0, support));
  const R = clamp(Math.round(base * (1 - EXPOSURE * exposure) + help), 0, 100);
  return stunned ? Math.min(R, STUN_MAX) : R;
}

// M = clamp(R + h, 0, cap(hp, maxHp)), h = clamp(H - baseline, -SPAN, SPAN).
export function combine(R, H, hp, maxHp, baseline = 55) {
  return clamp(Math.round(R + clamp(H - baseline, -SPAN, SPAN)), 0, cap(hp, maxHp));
}

export function tierOf(M, prev = null) {
  if (M <= TIER_LOW_MAX || (prev === 'low' && M <= TIER_LOW_MAX + TIER_HYST)) return 'low';
  if (M >= TIER_HIGH_MIN || (prev === 'high' && M >= TIER_HIGH_MIN - TIER_HYST)) return 'high';
  return 'mid';
}

// Rout starts below ROUT_ENTER and ends only at ROUT_EXIT or more (no flicker at the edge).
export function routNext(M, wasRout = false) {
  return wasRout ? M < ROUT_EXIT : M < ROUT_ENTER;
}

export function band(M) {
  for (const [lo, name] of BANDS) if (M >= lo) return name;
  return 'broken';
}

// ---- moods: what a tier actually changes in code -------------------------------------------------
// `stalking` is the identity row: a mid-tier monster behaves exactly as it does with morale off, so turning
// morale on only changes a monster whose morale has actually moved. Every other row moves a knob that
// knobsOf() (adversary.js) or the strike line (character.js) already reads:
//   keepDistance      cells kept from an armed explorer (wakes the previously dormant brain.js hook)
//   strikeLevel       1/2/3 of character.js STRIKE_LINE: when it uses the claw
//   keepHunting       added to its keepHuntingMin threshold (higher = gives up sooner)
//   searchFactor      multiplies maxSearchTicks
//   calls             true = calls for help even if its `pack` trait says loner; null = as its character
//   prefer            search approach it leans to, or null for its character's own preference
//   line              the priority line Jev reads (<= 110 chars), '' for the identity row
export const MOODS = {
  skittish: {
    tier: 'low', keepDistance: 2, strikeLevel: 1, keepHunting: 0.2, searchFactor: 0.6, calls: true, prefer: 'cut_off',
    line: 'You are badly shaken: keep away from the explorer, watch it from a distance and call the pack in.',
    note: 'Shaken: keeps its distance and calls for help.',
  },
  cagey: {
    tier: 'low', keepDistance: 1, strikeLevel: 1, keepHunting: 0.1, searchFactor: 0.8, calls: true, prefer: 'cut_off',
    line: 'You are wary of that sword: block its way and wait for an opening instead of walking into it.',
    note: 'Wary: blocks the way instead of closing in.',
  },
  stalking: {
    tier: 'mid', keepDistance: 0, strikeLevel: 2, keepHunting: 0, searchFactor: 1, calls: null, prefer: null,
    line: '', note: 'Hunting steadily.',
  },
  pressing: {
    tier: 'mid', keepDistance: 0, strikeLevel: 2, keepHunting: -0.1, searchFactor: 1.2, calls: null, prefer: 'direct_pursuit',
    line: 'You have the upper hand: press the explorer, keep the pressure on and do not let it rest.',
    note: 'Pressing the explorer hard.',
  },
  relentless: {
    tier: 'high', keepDistance: 0, strikeLevel: 3, keepHunting: -0.2, searchFactor: 1.5, calls: null, prefer: 'direct_pursuit',
    line: 'You are strong and it is weak: close in and claw it at every chance; do not give up the trail.',
    note: 'Relentless: closes in and claws.',
  },
  frenzied: {
    tier: 'high', keepDistance: 0, strikeLevel: 3, keepHunting: -0.4, searchFactor: 1.8, calls: null, prefer: 'direct_pursuit',
    line: 'Nothing frightens you: hunt it down, take every strike you can and never break off.',
    note: 'Frenzied: hunts it down, never breaks off.',
  },
  // Rout is entered by code below ROUT_ENTER: the monster breaks off the hunt (adversary.js turnOff) and
  // keeps away until it recovers. It is never offered to Jev and never reaches a request.
  rout: {
    tier: 'low', keepDistance: 3, strikeLevel: 1, keepHunting: 1, searchFactor: 0, calls: false, prefer: 'cut_off',
    line: '', note: 'Routed: broke off and fled.',
  },
};
export const MOOD_IDS = Object.keys(MOODS);
export const TIER_MOODS = { low: ['skittish', 'cagey'], mid: ['stalking', 'pressing'], high: ['relentless', 'frenzied'] };
export const DEFAULT_MOOD = 'stalking';

// The mood a monster is in at M. Each tier holds two: the steadier one in the lower half of the tier's band,
// the bolder one in the upper half, with 3 points of hysteresis around that midpoint so it does not flicker.
// `prev` is the mood it is in now (it also carries the tier hysteresis through tierOf).
export function moodFor(M, prev = null) {
  const tier = tierOf(M, MOODS[prev]?.tier ?? null);
  const [lower, upper] = TIER_MOODS[tier];
  const lo = tier === 'low' ? 0 : tier === 'mid' ? TIER_LOW_MAX + 1 : TIER_HIGH_MIN;
  const hi = tier === 'low' ? TIER_LOW_MAX : tier === 'mid' ? TIER_HIGH_MIN - 1 : 100;
  const mid = (lo + hi) / 2;
  if (prev === upper) return M >= mid - 3 ? upper : lower;
  if (prev === lower) return M > mid + 3 ? upper : lower;
  return M >= mid ? upper : lower;
}

// The knobs in force: the mood's row, with the per-hunt numbers already folded in. `profile` is the
// character's (character.js); a null in the mood row means "as this character".
export function moodKnobs(mood, profile = {}) {
  const m = MOODS[mood] ?? MOODS[DEFAULT_MOOD];
  return {
    keepDistance: Math.max(m.keepDistance, profile.keepDistance ?? 0),
    strikeLevel: m.strikeLevel,
    keepHuntingMin: clamp(round2((profile.keepHuntingMin ?? 0.5) + m.keepHunting), 0, 1),
    maxSearchTicks: Math.max(1, Math.round((profile.maxSearchTicks ?? 18) * m.searchFactor)),
    calls: m.calls === null ? (profile.makesCalls ?? true) : m.calls,
    prefer: m.prefer ?? profile.preferredSearch ?? null,
    line: m.line,
    note: m.note,
  };
}

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen at once.
export function configureMorale(o) {
  if (o.morClawed !== undefined) D_CLAWED = o.morClawed;
  if (o.morWounded !== undefined) D_WOUNDED = o.morWounded;
  if (o.morBlocked !== undefined) D_BLOCKED = o.morBlocked;
  if (o.morShrugged !== undefined) D_SHRUGGED = o.morShrugged;
  if (o.morPackmateLost !== undefined) D_PACKMATE_LOST = o.morPackmateLost;
  if (o.morHelp !== undefined) D_HELP = o.morHelp;
  if (o.morCornered !== undefined) D_CORNERED = o.morCornered;
  if (o.morSlipped !== undefined) D_SLIPPED = o.morSlipped;
  if (o.morSlippedMax !== undefined) SLIPPED_MAX = o.morSlippedMax;
  if (o.morGaveUp !== undefined) D_GAVE_UP = o.morGaveUp;
  if (o.morHelpCeiling !== undefined) HELP_CEILING = o.morHelpCeiling;
  if (o.morCorneredCeiling !== undefined) CORNERED_CEILING = o.morCorneredCeiling;
  if (o.morRegenWait !== undefined) REGEN_WAIT = o.morRegenWait;
  if (o.morTierLowMax !== undefined) TIER_LOW_MAX = o.morTierLowMax;
  if (o.morTierHighMin !== undefined) TIER_HIGH_MIN = o.morTierHighMin;
  if (o.morTierHyst !== undefined) TIER_HYST = o.morTierHyst;
  if (o.morRoutEnter !== undefined) ROUT_ENTER = o.morRoutEnter;
  if (o.morRoutExit !== undefined) ROUT_EXIT = o.morRoutExit;
  if (o.morRoutRest !== undefined) ROUT_REST = o.morRoutRest;
  if (o.morLastHpCap !== undefined) LAST_HP_CAP = o.morLastHpCap;
  if (o.morCapFloor !== undefined) CAP_FLOOR = o.morCapFloor;
  if (o.morSpan !== undefined) SPAN = o.morSpan;
  if (o.morCapabilityMax !== undefined) CAPABILITY_MAX = o.morCapabilityMax;
  if (o.morExposure !== undefined) EXPOSURE = o.morExposure;
  if (o.morPackBonus !== undefined) PACK_BONUS = o.morPackBonus;
  if (o.morPackMax !== undefined) PACK_MAX = o.morPackMax;
  if (o.morStunMax !== undefined) STUN_MAX = o.morStunMax;
  if (o.morBandSavage !== undefined) BANDS[0][0] = o.morBandSavage;
  if (o.morBandEager !== undefined) BANDS[1][0] = o.morBandEager;
  if (o.morBandSteady !== undefined) BANDS[2][0] = o.morBandSteady;
  if (o.morBandWavering !== undefined) BANDS[3][0] = o.morBandWavering;
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const moraleSnapshot = () => ({
  morClawed: D_CLAWED, morWounded: D_WOUNDED, morBlocked: D_BLOCKED, morShrugged: D_SHRUGGED,
  morPackmateLost: D_PACKMATE_LOST, morHelp: D_HELP, morCornered: D_CORNERED, morSlipped: D_SLIPPED, morSlippedMax: SLIPPED_MAX,
  morGaveUp: D_GAVE_UP, morHelpCeiling: HELP_CEILING, morCorneredCeiling: CORNERED_CEILING, morRegenWait: REGEN_WAIT,
  morTierLowMax: TIER_LOW_MAX, morTierHighMin: TIER_HIGH_MIN, morTierHyst: TIER_HYST,
  morRoutEnter: ROUT_ENTER, morRoutExit: ROUT_EXIT, morRoutRest: ROUT_REST,
  morLastHpCap: LAST_HP_CAP, morCapFloor: CAP_FLOOR, morSpan: SPAN, morCapabilityMax: CAPABILITY_MAX,
  morExposure: EXPOSURE, morPackBonus: PACK_BONUS, morPackMax: PACK_MAX, morStunMax: STUN_MAX,
  morBandSavage: BANDS[0][0], morBandEager: BANDS[1][0], morBandSteady: BANDS[2][0], morBandWavering: BANDS[3][0],
});
