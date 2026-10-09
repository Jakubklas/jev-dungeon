// The explorer's confidence score C: pure functions, no imports, no clock, no randomness. brain.js and memory.js import it;
// it imports nothing itself, so the acyclic chain and the explorer static guard stay intact.
//
// C = combine(R, H, lives, maxLives): capability R (own lives, the skill numbers, the monsters known; see capability()) shifted
// by at most +-HIST_SPAN by the history score H, then capped by the lives left. H is 0..100, START (50) at the start and the
// neutral value regen returns to. A drop must be justified by harm (a hit, fewer lives, a second monster): seeing or being chased
// by a lone monster never lowers C, and an unhurt, armed explorer keeps R >= UNHURT_FLOOR whatever it sees.
//
// State (plain JSON): { value, idle, counts: { strikes, blocked, evaded, coins, hearts }, enc: { chased, hurt, killed } }
// where `enc` is the current encounter's bookkeeping (for 'evaded').
//
// Event vocabulary (apply(state, event, lives, maxLives); `event` is a string or { type, n? }):
//   hit       a life was lost to a strike: D_HIT (-7), then the lives cap; marks the encounter hurt
//   struck    own strike landed, monster survived: D_STRUCK (+5)
//   dispelled own strike dispelled a monster (it emits `dispelled`, not `struck`): D_DISPELLED (+8); marks the encounter killed
//   blocked   own shield stopped a claw: D_BLOCKED (+3), only up to BLOCK_CEILING (never lowers a higher C)
//   evaded    an encounter with a chasing sighting ended with no hit and no dispel: D_EVADED (+2), only up to EVADE_CEILING
//   coin      picked up coins: D_COIN (+2) per coin (`n` coins in one step)
//   heart     picked up a heart (apply it after the heal, so the lives cap sees the restored life): D_HEART (+5)
//   regen     0.25 toward START from either side, but only after REGEN_WAIT ticks with no change to C
//             (any other event that moves C restarts the wait); the caller sends one per tick
// Being chased or pressed is not an event: it is no justification for losing confidence.
// Every change ends with C clamped to 0..100 and to the lives cap.

export let START = 50;
export let D_HIT = -7;
export let D_STRUCK = 5;
export let D_DISPELLED = 8;
export let D_BLOCKED = 3;
export let D_EVADED = 2;
export let D_COIN = 2; // per coin picked up
export let D_HEART = 5; // per heart picked up
export let REGEN = 0.25; // PLAN-moods: per tick, toward START, from above and below
export let REGEN_WAIT = 10; // ticks since C last changed before regen starts
export let TIER_LOW_MAX = 35; // low tier: C <= 35, midlow 36..49, mid 50..69, high >= 70
export let TIER_MID_MIN = 50; // mid tier from here; below it (and above the low tier) is midlow, where pulling back is on the menu
export let TIER_HIGH_MIN = 70; // the start C (70) is already high: Jev begins confident and takes on enemies unless it has a reason not to
export let TIER_HYST = 5; // a tier is kept this far past its edge (low up to 40, midlow up to 54, mid down to 45, high down to 65)
export let PANIC_ENTER = 20; // panic starts below this
export let PANIC_EXIT = 25; // and ends only at or above this
export let PANIC_LIVES = 1; // and only at or below this many lives (a heal above it ends panic)
export let BLOCK_CEILING = 65;
export let EVADE_CEILING = 65;
export let LAST_LIFE_CAP = 45;
export let CAP_FLOOR = 0.3; // cap = 100 * (CAP_FLOOR + (1 - CAP_FLOOR) * lives / maxLives)
// Band lower bounds: <30 shaken, 30-39 unsure, 40-64 even, 65-79 sure, 80+ dominant.
export const BANDS = [[80, 'dominant'], [65, 'sure'], [40, 'even'], [30, 'unsure'], [0, 'shaken']];

// The default event weights as one object, so C4's sweep can swap them (createConfidence({ weights })).
export const WEIGHTS = { hit: D_HIT, struck: D_STRUCK, dispelled: D_DISPELLED, blocked: D_BLOCKED, evaded: D_EVADED, coin: D_COIN, heart: D_HEART };

const EVENTS = new Set(['hit', 'struck', 'dispelled', 'blocked', 'evaded', 'coin', 'heart', 'regen']);

const round2 = (v) => Math.round(v * 100) / 100; // keeps 0.3 steps free of float drift
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const freshEnc = () => ({ chased: false, hurt: false, killed: false });

// createConfidence() is the shipped model. C4's arms: { weights: {hit, struck, ...} } overrides some weights
// (kept in the state as `w`, only when given, so the default state shape is unchanged), and { model: 'beta' }
// is the weight-free alternative: value = 100 * (landed + 2) / (landed + taken + 4), landed = own strikes that
// landed (struck or dispelled), taken = hits; blocked, evaded, coin, heart and regen do not move it. The lives cap
// still applies to both. `start` (default START) forces the history score from tick 0: the caps checks drive C with it
// (PLAN-confidence-mood phase 3); with the lives cap applied by the first event, never by the constructor.
export function createConfidence({ weights = null, model = null, start = START } = {}) {
  return {
    value: start, idle: 0, counts: { strikes: 0, blocked: 0, evaded: 0, coins: 0, hearts: 0 }, enc: freshEnc(),
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
  counts.coins ??= 0; counts.hearts ??= 0; // states from before these events
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
    case 'coin': { const n = Math.max(1, Math.floor(event?.n ?? 1)); v += (w.coin ?? D_COIN) * n; counts.coins += n; break; }
    case 'heart': v += w.heart ?? D_HEART; counts.hearts += 1; break;
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

// PLAN-moods tiers. `prev` is the tier held so far (hysteresis at every edge); null starts from C alone.
// Four tiers: low, midlow, mid, high. midlow is the cautious middle (hurt, or fights went badly): the only middle tier where
// the retreat tactics are offered (retreatTier) and the cautious mood is listed.
export function tierOf(C, prev = null) {
  if (C <= TIER_LOW_MAX || (prev === 'low' && C <= TIER_LOW_MAX + TIER_HYST)) return 'low';
  if (C >= TIER_HIGH_MIN || (prev === 'high' && C >= TIER_HIGH_MIN - TIER_HYST)) return 'high';
  if (prev === 'midlow' && C < TIER_MID_MIN + TIER_HYST) return 'midlow';
  if (C >= TIER_MID_MIN || (prev === 'mid' && C >= TIER_MID_MIN - TIER_HYST)) return 'mid';
  return 'midlow';
}

// Tiers where pulling back (run_away, hide, race_to_exit) is on the tactic menu even while a forward tactic is open.
export const retreatTier = (tier) => tier === 'low' || tier === 'midlow';

// Panic starts below PANIC_ENTER with at most PANIC_LIVES lives, and ends at PANIC_EXIT or more (no flicker at the edge) or once
// lives rise above PANIC_LIVES. `lives` defaults to 0 for callers that test the confidence edge alone.
export function panicNext(C, wasPanic = false, lives = 0) {
  if (lives > PANIC_LIVES) return false;
  return wasPanic ? C < PANIC_EXIT : C < PANIC_ENTER;
}

export function band(C) {
  for (const [lo, name] of BANDS) if (C >= lo) return name;
  return 'shaken';
}

// Derives this turn's events from the explorer's turn shape as Run.playTurn returns it
// ({ skill_events, events, decision, ... }) and applies them in a fixed order: strikes, hit, blocked,
// coins, heart, then the encounter-end / regen step. Own state only (fog-safe). `ctx`:
//   lives, maxLives  after the turn
//   armed            the sword was ready at the start of the turn
//   visible          [{ id, distance, mode }] adversaries in sight (the brain's own view)
//   (visible, engaging, stunned are accepted for old callers and ignored: being chased costs nothing)
export function applyTurn(state, turn, { lives, maxLives, armed = true, visible = [], engaging = false, stunned = [] } = {}) {
  let s = state;
  const step = (e) => { s = apply(s, e, lives, maxLives); };
  // Run.playTurn's `events` already contains skill_events, so count each struck / dispelled once.
  const events = turn.events ?? [];
  const strikeEvents = (turn.skill_events ?? turn.events ?? []).filter((e) => e.type === 'struck' || e.type === 'dispelled');
  for (const e of strikeEvents) step(e.type);
  if (events.some((e) => e.type === 'hit')) step('hit');
  for (const e of events) if (e.type === 'blocked') step('blocked');
  for (const e of events) if (e.type === 'coin') step({ type: 'coin', n: e.gained ?? 1 });
  for (const e of events) if (e.type === 'heart') step('heart');
  if (visible.some((a) => a.mode === 'chase')) s = { ...s, enc: { ...s.enc, chased: true } };
  if (turn.decision?.trigger === 'chase_over') {
    if (s.enc.chased && !s.enc.hurt && !s.enc.killed) step('evaded');
    else s = { ...s, enc: freshEnc() };
  }
  step('regen');
  return s;
}

// ---- PLAN-confidence-mood phase 1: capability R, combine, the mood caps (pure; nothing here touches apply()) ----
// R is what the explorer can take on right now, from own state and what it knows of the ghosts; H (the score
// above) shifts it. allowedMoods turns C into the list of moods the sentiment question may offer.

// Expected lives lost per extra ghost beyond the first, per point of claw damage. 0.35 is the owner's default (a bolder
// explorer: three 2-hp ghosts at 2 lives read 'even', 43); 0.5 is the measured worst case (a walk-in Jev, PLAN-confidence-mood
// table 3) and stays exported so tests and the later measurement can compare the two.
export let W_PER_EXTRA = 0.35;
export const W_PER_EXTRA_SAFE = 0.5;
export let HIST_SPAN = 30; // a remembered sighting fades linearly to nothing over this many steps; h = clamp(H - 50, -30, +30)
export let CAPABILITY_MAX = 75; // capability of an unhurt explorer; scaled by the share of lives left (lives / maxLives), so 75 at the start whatever the lives count
export let UNHURT_FLOOR = 50; // an armed explorer at full lives never has R below this (sightings alone do not justify a drop)
export let NO_SWORD_MAX = 20; // without an attack skill R never exceeds this
let HP_BASE = 0.75; // hpW(g) = 0.75 + 0.125 * min(5, strikes to dispel it): 1 strike 0.875, 2 strikes 1.0, 3 strikes 1.125
let HP_SLOPE = 0.125;
let HP_STRIKES_MAX = 5;

// Weight of a remembered sighting `ageSteps` old: 1 when fresh, 0 from HIST_SPAN on (a visible ghost has weight 1).
export function sightWeight(ageSteps) {
  return clamp(1 - Math.max(0, ageSteps) / HIST_SPAN, 0, 1);
}

// Capability R, 0..100. ghosts: [{ hp, weight }] (visible: weight 1; remembered: sightWeight(age)). `steady` (the brain's
// stunHolds rule) is accepted for old callers and unused. Worst-case expected lives lost clearing the ghosts:
//   W = clawDamage * wPerExtra * (k - the heaviest one's weight)   (the first monster is free whatever the stun settings: seeing one costs nothing)
// ASSUMPTION: a lone monster never justifies a drop, so the stun settings no longer decide it; only the extra monsters cost.
// Only sword cooldown 2 follow was measured (PLAN-confidence-mood table 3b). Without an attack skill R <= NO_SWORD_MAX.
// An unhurt (full lives), armed explorer keeps R >= UNHURT_FLOOR: sighting monsters alone cannot push it out of the mid tier.
export function capability({ lives, maxLives = lives, clawDamage = 1, swordDamage = 1, steady = true, armed = true, ghosts = [] }, wPerExtra = W_PER_EXTRA) {
  const sd = swordDamage > 0 ? swordDamage : 1;
  let k = 0, first = 0; // first = the heaviest monster: it is the free one, so a lone troll costs nothing either
  for (const g of ghosts) {
    const strikes = Math.min(HP_STRIKES_MAX, Math.ceil(Math.max(0, g.hp) / sd));
    const w1 = (g.weight ?? 1) * (HP_BASE + HP_SLOPE * strikes);
    k += w1; first = Math.max(first, w1);
  }
  const W = clawDamage * wPerExtra * Math.max(0, k - first);
  // The unhurt baseline is CAPABILITY_MAX times the share of lives left; each point of W (expected lives lost) costs 100 / maxLives,
  // i.e. its share of the lives, so the numbers do not depend on how many lives the game starts with.
  const R = clamp(Math.round(CAPABILITY_MAX * lives / maxLives - 100 * W / maxLives), 0, 100);
  if (!armed) return Math.min(R, NO_SWORD_MAX);
  return lives >= maxLives ? Math.max(R, UNHURT_FLOOR) : R;
}

// C = clamp(R + h, 0, cap(lives, maxLives)): history shifts capability by at most +-HIST_SPAN, the lives cap still applies.
export function combine(R, H, lives, maxLives) {
  const h = clamp(H - START, -HIST_SPAN, HIST_SPAN);
  return clamp(R + h, 0, cap(lives, maxLives));
}

// PLAN-moods: the moods each tier offers, in the order the sentiment question lists them. `panic` is entered by code below
// PANIC_ENTER and is never offered. Jev leans on whatever safe option is listed, so each tier lists at most one mood that holds
// back: cautious only in midlow, steady in midlow and mid; mid's other moods go after loot or the fight.
export const TIER_MOODS = { low: ['wary', 'guarded'], midlow: ['cautious', 'steady', 'bold'], mid: ['steady', 'greedy', 'bold'], high: ['bold', 'fearless'] };
// The tier a mood belongs to (it holds the hysteresis). A mood listed in several tiers belongs to the first of low, mid, midlow,
// high: steady and bold are held in mid (the tier they lean on), so a dip just under TIER_MID_MIN does not open the retreats.
export const tierOfMood = (id) => (id === 'panic' ? 'low' : ['low', 'mid', 'midlow', 'high'].find((t) => TIER_MOODS[t].includes(id)) ?? null);

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

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen by every importer.
export function configureConfidence(o) {
  if (o.confStart !== undefined) START = o.confStart;
  if (o.confHit !== undefined) D_HIT = o.confHit;
  if (o.confStruck !== undefined) D_STRUCK = o.confStruck;
  if (o.confDispelled !== undefined) D_DISPELLED = o.confDispelled;
  if (o.confBlocked !== undefined) D_BLOCKED = o.confBlocked;
  if (o.confEvaded !== undefined) D_EVADED = o.confEvaded;
  if (o.confCoin !== undefined) D_COIN = o.confCoin;
  if (o.confHeart !== undefined) D_HEART = o.confHeart;
  if (o.confBlockCeiling !== undefined) BLOCK_CEILING = o.confBlockCeiling;
  if (o.confEvadeCeiling !== undefined) EVADE_CEILING = o.confEvadeCeiling;
  if (o.confRegen !== undefined) REGEN = o.confRegen;
  if (o.confRegenWait !== undefined) REGEN_WAIT = o.confRegenWait;
  if (o.confTierLowMax !== undefined) TIER_LOW_MAX = o.confTierLowMax;
  if (o.confTierHighMin !== undefined) TIER_HIGH_MIN = o.confTierHighMin;
  if (o.confTierMidMin !== undefined) TIER_MID_MIN = o.confTierMidMin;
  if (o.confTierHyst !== undefined) TIER_HYST = o.confTierHyst;
  if (o.confPanicEnter !== undefined) PANIC_ENTER = o.confPanicEnter;
  if (o.confPanicExit !== undefined) PANIC_EXIT = o.confPanicExit;
  if (o.confPanicLives !== undefined) PANIC_LIVES = o.confPanicLives;
  if (o.confLastLifeCap !== undefined) LAST_LIFE_CAP = o.confLastLifeCap;
  if (o.confCapFloor !== undefined) CAP_FLOOR = o.confCapFloor;
  if (o.confWPerExtra !== undefined) W_PER_EXTRA = o.confWPerExtra;
  if (o.confHistSpan !== undefined) HIST_SPAN = o.confHistSpan;
  if (o.confCapabilityMax !== undefined) CAPABILITY_MAX = o.confCapabilityMax;
  if (o.confUnhurtFloor !== undefined) UNHURT_FLOOR = o.confUnhurtFloor;
  if (o.confNoSwordMax !== undefined) NO_SWORD_MAX = o.confNoSwordMax;
  if (o.confHpBase !== undefined) HP_BASE = o.confHpBase;
  if (o.confHpSlope !== undefined) HP_SLOPE = o.confHpSlope;
  if (o.confHpStrikesMax !== undefined) HP_STRIKES_MAX = o.confHpStrikesMax;
  WEIGHTS.hit = D_HIT; WEIGHTS.struck = D_STRUCK; WEIGHTS.dispelled = D_DISPELLED; WEIGHTS.blocked = D_BLOCKED; WEIGHTS.evaded = D_EVADED; WEIGHTS.coin = D_COIN; WEIGHTS.heart = D_HEART;
  if (o.confBandDominant !== undefined) BANDS[0][0] = o.confBandDominant;
  if (o.confBandSure !== undefined) BANDS[1][0] = o.confBandSure;
  if (o.confBandEven !== undefined) BANDS[2][0] = o.confBandEven;
  if (o.confBandUnsure !== undefined) BANDS[3][0] = o.confBandUnsure;
  for (const t of ['low', 'midlow', 'mid', 'high']) {
    const v = o[`tierMoods_${t}`];
    if (Array.isArray(v)) TIER_MOODS[t] = [...v];
  }
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const confidenceSnapshot = () => ({ confStart: START, confHit: D_HIT, confStruck: D_STRUCK, confDispelled: D_DISPELLED, confBlocked: D_BLOCKED, confEvaded: D_EVADED, confCoin: D_COIN, confHeart: D_HEART, confBlockCeiling: BLOCK_CEILING, confEvadeCeiling: EVADE_CEILING, confRegen: REGEN, confRegenWait: REGEN_WAIT, confTierLowMax: TIER_LOW_MAX, confTierHighMin: TIER_HIGH_MIN, confTierMidMin: TIER_MID_MIN, confTierHyst: TIER_HYST, confPanicEnter: PANIC_ENTER, confPanicExit: PANIC_EXIT, confPanicLives: PANIC_LIVES, confLastLifeCap: LAST_LIFE_CAP, confCapFloor: CAP_FLOOR, confWPerExtra: W_PER_EXTRA, confHistSpan: HIST_SPAN, confCapabilityMax: CAPABILITY_MAX, confUnhurtFloor: UNHURT_FLOOR, confNoSwordMax: NO_SWORD_MAX, confHpBase: HP_BASE, confHpSlope: HP_SLOPE, confHpStrikesMax: HP_STRIKES_MAX, confBandDominant: BANDS[0][0], confBandSure: BANDS[1][0], confBandEven: BANDS[2][0], confBandUnsure: BANDS[3][0], tierMoods_low: [...TIER_MOODS.low], tierMoods_midlow: [...TIER_MOODS.midlow], tierMoods_mid: [...TIER_MOODS.mid], tierMoods_high: [...TIER_MOODS.high] });
