// Adversary character: five fixed traits (levels 1-3) set at spawn, never re-picked. `profileOf(traits)`
// turns them into the numbers the brain code uses (standard, all 2s, equals today's constants) plus a
// short priority line and plain words for Jev. Pure: no game state, no Jev. See PLAN-adversary-memory.md.
import { rng } from '../../dungeon.js';

export const TRAITS = ['aggression', 'persistence', 'horizon', 'roaming', 'pack'];
export const RESERVED_TRAITS = ['caution']; // not in any preset; wakes keepDistance (brain.js) when set to 3 through a traits object

// Order: aggression, persistence, horizon, roaming, pack. Style is the one sentence sent to Jev.
export const PRESETS = {
  ancient_guardian: { traits: [3, 3, 3, 1, 1], style: 'An ancient keeper of roots and stone; remembers trespassers, guards its grove and speaks with slow certainty.' },
  pack_stalker: { traits: [3, 3, 2, 3, 3], style: 'A sharp-nosed hunter; follows the scent, howls to the pack and circles around prey before snapping.' },
  standard: { traits: [2, 2, 2, 2, 2], style: 'A steady hunter.' },
  aggressive: { traits: [3, 2, 1, 2, 2], style: 'Charges straight at the explorer and does not plan far ahead.' },
  pursuer: { traits: [2, 3, 2, 2, 2], style: 'Never lets go of a trail until it is stone cold.' },
  ambusher: { traits: [2, 2, 3, 1, 2], style: 'Predicts where the explorer will pass and waits at the chokepoint.' },
  patient_hunter: { traits: [2, 3, 3, 2, 3], style: 'Methodical; keeps long memories and works with the pack.' },
  short_sighted: { traits: [2, 1, 1, 2, 2], style: 'Searches close, forgets quickly, gives up soon.' },
  timid: { traits: [1, 1, 1, 1, 1], style: 'Only chases what is right next to it, quits quickly, never calls for help.' },
  territorial: { traits: [3, 2, 2, 1, 1], style: 'Guards its own area fiercely and will not leave it far behind.' },
  rover: { traits: [2, 1, 1, 3, 2], style: 'Wanders widely; a hunt is a detour.' },
};
const DEFAULT_PRESETS = JSON.parse(JSON.stringify(PRESETS));
export const defaultPresets = () => JSON.parse(JSON.stringify(DEFAULT_PRESETS)); // the built-in presets, whatever the central file says
export const PRESET_IDS = Object.keys(PRESETS);
export const SPECIAL_IDS = PRESET_IDS.filter((id) => !['standard', 'ancient_guardian', 'pack_stalker'].includes(id));

export const WORDS = {
  aggression: ['hesitant', 'steady', 'fierce'],
  persistence: ['gives up fast', 'standard', 'relentless'],
  horizon: ['short-term', 'standard', 'long-term planner'],
  roaming: ['stays home', 'ranges', 'roams everywhere'],
  pack: ['loner', 'team player', 'pack hunter'],
};

const AGGRESSION_LINE = [
  'Close in only when it is near; keep other moves in front of you.',
  'Close the distance while keeping its escape routes cut off.',
  'Go straight at it: close the path distance first, cut-off second.',
];
// The skill question's priority line (PLAN-skills.md S4): level 2 adds nothing.
const STRIKE_LINE = [
  'Strike only when cornered.',
  '',
  'Strike whenever the explorer is adjacent and the claw is ready.',
];
const PACK_LINE = [
  'This is your prey; do not wait for others.',
  'Close in together with your packmates.',
  'Coordinate: take the route no teammate covers.',
];
const HORIZON_LINE = [
  'Think about the next few steps only.',
  '',
  'Predict where it will go and plan ahead.',
];
export let PRIORITY_MAX = 300;
// The strike line at a given level (1-3). Monster morale overrides the character's own level with its mood's.
export const strikeLineFor = (level) => at(STRIKE_LINE, Math.min(3, Math.max(1, level)));

const at = (arr, level) => arr[level - 1];
let HOME_RADIUS = [14, 24, null]; // path-step radius of the home zone per roaming level; null = the whole map
let LONER_HEARING = 10; // a loner answers a call only when the explorer is this close

// Levels 1/2/3 -> number. Standard (2) is today's value.
const TABLE = {
  chaseRange: ['aggression', [5, 7, 7]],
  restTicks: ['aggression', [6, 3, 0]],
  maxSearchTicks: ['persistence', [10, 18, 32]],
  keepHuntingMin: ['persistence', [0.65, 0.5, 0.3]],
  sweepRadius: ['horizon', [6, 10, 14]],
  cutMax: ['horizon', [12, 24, 36]],
  alertSteps: ['pack', [8, 24, 40]],
  sightingsKept: ['horizon', [1, 3, 5]],
  sightingTtl: ['horizon', [12, 30, 60]],
  landmarksCap: ['horizon', [3, 5, 8]],
  landmarkTtl: ['horizon', [40, 120, 300]],
  eventTtl: ['horizon', [40, 120, 300]],
  recentMoves: ['horizon', [4, 6, 6]],
  recentCells: ['horizon', [6, 8, 8]],
  seenTtl: ['horizon', [40, 120, 300]],
  seenCap: ['horizon', [120, 300, 600]],
  keepDistance: ['caution', [0, 0, 2]], // cells kept from an explorer whose sword is ready (0 = off)
  // Morale (morale.js, PLAN-monster-morale.md): where this monster's morale starts and sits, how fast it
  // recovers, how hard a setback hits it, and how much a packmate is worth to it.
  moraleStart: ['aggression', [40, 55, 70]],
  moraleRegen: ['persistence', [0.15, 0.25, 0.4]],
  moraleHurt: ['caution', [0.6, 1, 1.6]],
  moralePack: ['pack', [0, 0.5, 1]],
};

export function normalizeTraits(traits) {
  const out = {};
  for (const t of [...TRAITS, ...RESERVED_TRAITS]) {
    const v = traits?.[t] ?? 2;
    if (![1, 2, 3].includes(v)) throw new Error(`character trait ${t} must be 1, 2 or 3, got ${JSON.stringify(v)}`);
    out[t] = v;
  }
  return out;
}

export function traitsOf(id) {
  const p = PRESETS[id];
  if (!p) throw new Error(`unknown character '${id}' (known: ${PRESET_IDS.join(', ')})`);
  return Object.fromEntries(TRAITS.map((t, i) => [t, p.traits[i]]));
}

export function profileOf(traitsIn) {
  const traits = normalizeTraits(traitsIn);
  const p = { traits };
  for (const [knob, [trait, values]] of Object.entries(TABLE)) p[knob] = at(values, traits[trait]);
  // Loners ignore calls unless the explorer is close; loners make none either.
  p.answersCalls = traits.pack > 1;
  p.answersCallsWithin = traits.pack === 1 ? LONER_HEARING : null;
  p.makesCalls = traits.pack > 1;
  p.teamSight = traits.pack > 1;
  // roaming: path-step radius of the home zone; null = the whole map.
  p.homeRadius = HOME_RADIUS[traits.roaming - 1];
  p.preferredSearch = ['sweep_last_seen', null, 'cut_off'][traits.horizon - 1];
  p.priority = priorityLine(traits);
  p.skillPriority = at(STRIKE_LINE, traits.aggression);
  p.words = Object.fromEntries(TRAITS.map((t) => [t, at(WORDS[t], traits[t])]));
  return p;
}

export function priorityLine(traits) {
  const parts = [at(AGGRESSION_LINE, traits.aggression), at(HORIZON_LINE, traits.horizon), at(PACK_LINE, traits.pack)];
  return parts.filter(Boolean).join(' ').slice(0, PRIORITY_MAX);
}

// Deterministic assignment on its own stream, run after spawnAdversaries. Mode 'standard': all standard.
// Mode 'mixed': ghost i takes deck[i] of shuffled specials (a new deck when one runs out), so the
// first ghosts keep their character whatever `count` is.
export function assignCharacters(seed, count, mode = 'mixed') {
  if (mode === 'standard') return Array.from({ length: count }, () => 'standard');
  if (mode !== 'mixed') throw new Error(`unknown character mode '${mode}'`);
  const rand = rng((seed ^ 0x6a09e667) >>> 0);
  const out = [];
  while (out.length < count) {
    const deck = [...SPECIAL_IDS];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    out.push(...deck);
  }
  return out.slice(0, count);
}

// Testbed override: 'standard' | 'mixed' | one id | a list applied per ghost in id order, cycled.
export function charactersFor(spec, seed, count) {
  if (Array.isArray(spec)) return Array.from({ length: count }, (_, i) => spec[i % spec.length]);
  if (spec === 'standard' || spec === 'mixed') return assignCharacters(seed, count, spec);
  return Array.from({ length: count }, () => spec);
}

// Central settings (src/settings.js): per-character trait/style overrides and the spawn distribution. Both are
// empty by default, so nothing changes until a settings file asks. `standard` is never overridable (it follows the live settings).
let WEIGHTS = null; // null = the shuffled deck; else [[id, weight], ...] in PRESET_IDS order

// overrides: { id: { aggression: 3, ..., style: '...' } }. Resets to the built-in presets first. Returns warnings.
export function configureCharacters(overrides = {}) {
  const warnings = [];
  for (const id of PRESET_IDS) PRESETS[id] = JSON.parse(JSON.stringify(DEFAULT_PRESETS[id]));
  for (const [id, o] of Object.entries(overrides ?? {})) {
    if (id.startsWith('_')) continue; // a comment
    if (!Object.hasOwn(PRESETS, id) || id === 'standard') { warnings.push(`characters.${id}: not an editable character (one of ${SPECIAL_IDS.join(', ')})`); continue; }
    if (!o || typeof o !== 'object') { warnings.push(`characters.${id}: must be an object`); continue; }
    const next = [...PRESETS[id].traits];
    let ok = true;
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_')) continue;
      if (k === 'style') {
        if (typeof v === 'string' && v.length <= 200) PRESETS[id].style = v; else { warnings.push(`characters.${id}.style must be a string of at most 200 characters`); ok = false; }
      } else if (TRAITS.includes(k)) {
        if ([1, 2, 3].includes(v)) next[TRAITS.indexOf(k)] = v; else { warnings.push(`characters.${id}.${k} must be 1, 2 or 3`); ok = false; }
      } else { warnings.push(`characters.${id}.${k}: unknown (traits: ${TRAITS.join(', ')}, style)`); ok = false; }
    }
    if (ok) PRESETS[id].traits = next;
    else PRESETS[id] = { ...JSON.parse(JSON.stringify(DEFAULT_PRESETS[id])) }; // all or nothing per character
  }
  return warnings;
}

// spec: 'mixed' (the deck), 'standard' (everyone standard) or weights { preset: number }. Returns warnings.
export function configureDistribution(spec = 'mixed') {
  if (spec === 'mixed' || spec == null) { WEIGHTS = null; return []; }
  if (spec === 'standard') { WEIGHTS = [['standard', 1]]; return []; }
  if (typeof spec !== 'object' || Array.isArray(spec)) return ['distribution.characters must be "mixed", "standard" or an object of weights'];
  const entries = [];
  for (const [id, w] of Object.entries(spec)) {
    if (id.startsWith('_')) continue;
    if (!Object.hasOwn(DEFAULT_PRESETS, id)) return [`distribution.characters.${id}: unknown character (one of ${PRESET_IDS.join(', ')})`];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) return [`distribution.characters.${id} must be a number >= 0`];
    entries.push([id, w]);
  }
  if (!entries.some(([, w]) => w > 0)) return ['distribution.characters needs at least one weight above 0'];
  WEIGHTS = PRESET_IDS.map((id) => [id, spec[id] ?? 0]);
  return [];
}

// What spawnAdversaries calls. Without weights this is the deck (unchanged); with weights each ghost is one draw on the
// same stream, so ghost i keeps its character whatever `count` is.
export function assignSpawnCharacters(seed, count) {
  if (!WEIGHTS) return assignCharacters(seed, count, 'mixed');
  const rand = rng((seed ^ 0x6a09e667) >>> 0);
  const total = WEIGHTS.reduce((n, [, w]) => n + w, 0);
  return Array.from({ length: count }, () => {
    let x = rand() * total;
    for (const [id, w] of WEIGHTS) { if (x < w) return id; x -= w; }
    return WEIGHTS.findLast(([, w]) => w > 0)[0];
  });
}

// Central config: the trait-level tables (flat keys trait_<knob>, a list of 3 numbers each), the home radius and the loner hearing.
export function configureTraits(o) {
  for (const knob of Object.keys(TABLE)) {
    const v = o[`trait_${knob}`];
    if (Array.isArray(v) && v.length === 3) TABLE[knob][1] = [...v];
  }
  if (Array.isArray(o.trait_homeRadius) && o.trait_homeRadius.length === 3) HOME_RADIUS = [...o.trait_homeRadius];
  if (typeof o.lonerHearing === 'number') LONER_HEARING = o.lonerHearing;
  if (typeof o.limPriorityLine === 'number') PRIORITY_MAX = o.limPriorityLine;
}
// The built-in tables, for the config check: { knob: [l1, l2, l3], homeRadius: [...], lonerHearing }. Fresh until configureTraits runs.
export const traitDefaults = () => ({ ...Object.fromEntries(Object.entries(TABLE).map(([k, [, v]]) => [`trait_${k}`, [...v]])), trait_homeRadius: [...HOME_RADIUS], lonerHearing: LONER_HEARING, limPriorityLine: PRIORITY_MAX });

// ---- Prompt wording from the central config: the per-level lines and trait words Jev reads (a key set to null = built-in).
const LINE_TABLES = { line_aggression: AGGRESSION_LINE, line_strike: STRIKE_LINE, line_pack: PACK_LINE, line_horizon: HORIZON_LINE };
const BUILTIN_LINES = Object.fromEntries([...Object.entries(LINE_TABLES).map(([k, a]) => [k, [...a]]), ...Object.entries(WORDS).map(([t, a]) => [`words_${t}`, [...a]])]);
const wordTable = (key) => (key.startsWith('words_') ? WORDS[key.slice(6)] : LINE_TABLES[key]);
export function configureCharacterPrompts(o) {
  for (const key of Object.keys(BUILTIN_LINES)) {
    const v = Array.isArray(o[key]) && o[key].length === 3 ? o[key] : BUILTIN_LINES[key];
    const t = wordTable(key);
    for (let i = 0; i < 3; i++) t[i] = v[i];
  }
}
export const characterPromptDefaults = () => JSON.parse(JSON.stringify(BUILTIN_LINES));
export const characterPromptSnapshot = () => Object.fromEntries(Object.keys(BUILTIN_LINES).map((k) => [k, [...wordTable(k)]]));
