// Adversary character: five fixed traits (levels 1-3) set at spawn, never re-picked. `profileOf(traits)`
// turns them into the numbers the brain code uses (standard, all 2s, equals today's constants) plus a
// short priority line and plain words for Jev. Pure: no game state, no Jev. See PLAN-adversary-memory.md.
import { rng } from '../../dungeon.js';

export const TRAITS = ['aggression', 'persistence', 'horizon', 'roaming', 'pack'];
export const RESERVED_TRAITS = ['caution']; // dormant until an explorer attack capability exists

// Order: aggression, persistence, horizon, roaming, pack. Style is the one sentence sent to Jev.
export const PRESETS = {
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
export const PRESET_IDS = Object.keys(PRESETS);
export const SPECIAL_IDS = PRESET_IDS.filter((id) => id !== 'standard');

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
export const PRIORITY_MAX = 300;

const at = (arr, level) => arr[level - 1];

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
  keepDistance: ['caution', [0, 0, 2]], // reserved
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
  p.answersCallsWithin = traits.pack === 1 ? 10 : null;
  p.makesCalls = traits.pack > 1;
  p.teamSight = traits.pack > 1;
  // roaming: path-step radius of the home zone; null = the whole map.
  p.homeRadius = [14, 24, null][traits.roaming - 1];
  p.preferredSearch = ['sweep_last_seen', null, 'cut_off'][traits.horizon - 1];
  p.priority = priorityLine(traits);
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
