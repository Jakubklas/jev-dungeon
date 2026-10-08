// Per-server tunables: the schema (what the settings page shows), validation, persistence and the
// hook into the game modules. Each server keeps its own file (settings-<port>.json), so the normal
// server (3000) and the testbed server (3001) can be tuned separately.
//   when: 'live'  applies the moment it is saved (read every tick),
//         'next'  applies from the next game (it shapes the map, the spawn or the lives).
import { readFile, writeFile } from 'node:fs/promises';
import { configureWorld } from './dungeon.js';
import { configureAdversaries } from './characters/adversary/adversary.js';
import { configureSkills } from './skills/config.js';
import { configureCoins } from './coins.js';
import { configureHearts } from './hearts.js';

export const SCHEMA = [
  { key: 'speed', group: 'Adversaries', label: 'Speed', hint: 'Fraction of the explorer\'s speed (1 = as fast).', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.6, when: 'live' },
  { key: 'chaseRange', group: 'Adversaries', label: 'Chase range', hint: 'Cells within which a seen explorer starts a hunt.', type: 'range', min: 1, max: 12, step: 1, def: 7, when: 'live' },
  { key: 'sightRange', group: 'Adversaries', label: 'Sight range', hint: 'How far anyone sees along a clear line (both sides).', type: 'range', min: 3, max: 12, step: 1, def: 7, when: 'live' },
  { key: 'maxSearchTicks', group: 'Adversaries', label: 'Search time', hint: 'Ticks without sight before a ghost gives up.', type: 'range', min: 1, max: 60, step: 1, def: 18, when: 'live' },
  { key: 'keepHuntingMin', group: 'Adversaries', label: 'Give-up threshold', hint: 'Jev\'s keep-hunting answer below this ends the hunt.', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5, when: 'live' },
  { key: 'adversaryCharacters', group: 'Adversaries', label: 'Ghost characters', hint: 'Each ghost gets a fixed character (mixed presets) and its own patrol stream. Off = every ghost is standard.', type: 'toggle', def: false, when: 'next' },
  { key: 'limitedMap', group: 'Adversaries', label: 'Limited ghost map', hint: 'Ghosts know only their home zone and what they have seen (fading), not the real map. Needs Ghost characters; ignored without it.', type: 'toggle', def: false, when: 'next' },
  { key: 'injectEnabled', group: 'Player', label: 'Player directives', hint: 'Let the player send the explorer a short instruction (POST /api/inject). Sending costs no Jev call.', type: 'toggle', def: true, when: 'live' },
  { key: 'injectMaxChars', group: 'Player', label: 'Directive length', hint: 'Longest directive in characters (the server enforces it).', type: 'range', min: 20, max: 140, step: 10, def: 140, when: 'live' },
  { key: 'injectSteps', group: 'Player', label: 'Directive lifetime', hint: 'Game steps a directive stays live before it expires.', type: 'range', min: 1, max: 100, step: 1, def: 20, when: 'live' },
  { key: 'injectCooldownS', group: 'Player', label: 'Directive cooldown', hint: 'Seconds between two directives (0 = none).', type: 'range', min: 0, max: 120, step: 1, def: 10, when: 'live' },
  { key: 'graceTicks', group: 'Damage', label: 'Grace after a hit', hint: 'Ticks of protection after a hit.', type: 'range', min: 0, max: 12, step: 1, def: 4, when: 'live' },
  { key: 'packAlert', group: 'Pack', label: 'Pack alert', hint: 'A spotter calls nearby patrolling ghosts into the hunt.', type: 'toggle', def: true, when: 'live' },
  { key: 'alertSteps', group: 'Pack', label: 'Alert reach', hint: 'Path steps within which a call is heard.', type: 'range', min: 1, max: 80, step: 1, def: 24, when: 'live' },
  { key: 'teamSight', group: 'Pack', label: 'Team sight', hint: 'Hunters track the explorer through a packmate\'s eyes.', type: 'toggle', def: true, when: 'live' },
  { key: 'floorPerAdversary', group: 'Spawn', label: 'Floor cells per ghost', hint: 'Fewer cells = more ghosts on a map.', type: 'range', min: 40, max: 1000, step: 10, def: 150, when: 'next' },
  { key: 'trollShare', group: 'Spawn', label: 'Troll share', hint: 'Chance a spawned monster is a troll instead of a ghost (trolls behave like ghosts for now).', type: 'range', min: 0, max: 1, step: 0.05, def: 0.25, when: 'next' },
  { key: 'maxAdversaries', group: 'Spawn', label: 'Max ghosts', hint: '0 = none.', type: 'range', min: 0, max: 24, step: 1, def: 12, when: 'next' },
  { key: 'floorPerCoin', group: 'Spawn', label: 'Floor cells per coin', hint: 'Fewer cells = more coins lying around a map.', type: 'range', min: 10, max: 1000, step: 10, def: 60, when: 'next' },
  { key: 'maxCoins', group: 'Spawn', label: 'Max coins', hint: 'Coins lying around at the start. 0 = none (ghost drops still happen).', type: 'range', min: 0, max: 100, step: 1, def: 30, when: 'next' },
  { key: 'swordDamage', group: 'Skills', label: 'Sword damage', hint: 'Hit points a sword strike takes from a ghost.', type: 'range', min: 1, max: 3, step: 1, def: 1, when: 'next' },
  { key: 'swordCooldown', group: 'Skills', label: 'Sword cooldown', hint: 'Steps before the sword strike is ready again.', type: 'range', min: 0, max: 6, step: 1, def: 1, when: 'next' },
  { key: 'shieldChance', group: 'Skills', label: 'Shield chance', hint: 'Chance a raised shield stops an attack on the explorer.', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, when: 'next' },
  { key: 'shieldCooldown', group: 'Skills', label: 'Shield cooldown', hint: 'Steps before the shield can be raised again.', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'clawDamage', group: 'Skills', label: 'Claw damage', hint: 'Lives a ghost claw strike takes.', type: 'range', min: 1, max: 3, step: 1, def: 1, when: 'next' },
  { key: 'clawCooldown', group: 'Skills', label: 'Claw cooldown', hint: 'Steps before a ghost can strike again.', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'ghostHp', group: 'Skills', label: 'Ghost hit points', hint: 'Hits a ghost takes before it is dispelled.', type: 'range', min: 1, max: 5, step: 1, def: 2, when: 'next' },
  { key: 'roomsPerHeart', group: 'Spawn', label: 'Rooms per heart', hint: 'One heart (restores a life) per this many rooms, at least one. Hearts are rare.', type: 'range', min: 1, max: 20, step: 1, def: 4, when: 'next' },
  { key: 'maxHearts', group: 'Spawn', label: 'Max hearts', hint: 'Hearts lying around at the start. 0 = none.', type: 'range', min: 0, max: 20, step: 1, def: 6, when: 'next' },
  { key: 'coinDropChance', group: 'Skills', label: 'Coin drop chance', hint: 'Chance a dispelled ghost drops a coin.', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, when: 'next' },
  { key: 'stunTicks', group: 'Skills', label: 'Stun ticks', hint: 'Ticks a struck ghost loses (no step, no Jev call).', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'lives', group: 'Explorer', label: 'Lives', hint: 'Lives the explorer starts with.', type: 'range', min: 1, max: 9, step: 1, def: 2, when: 'next' },
  { key: 'lightRadius', group: 'Explorer', label: 'Light radius', hint: 'Cells each visited cell lights up.', type: 'range', min: 3, max: 12, step: 1, def: 7, when: 'next' },
  { key: 'minSize', group: 'Map', label: 'Min map side', hint: 'Smallest width or height.', type: 'range', min: 25, max: 90, step: 1, def: 25, when: 'next' },
  { key: 'maxSize', group: 'Map', label: 'Max map side', hint: 'Largest width or height.', type: 'range', min: 25, max: 90, step: 1, def: 90, when: 'next' },
  { key: 'roomArea', group: 'Map', label: 'Cells per room', hint: 'Fewer cells = more, closer rooms.', type: 'range', min: 120, max: 800, step: 10, def: 290, when: 'next' },
];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));
// What the running game modules were last given (saved values that wait for a new game are not in force yet).
export const appliedValue = (key) => applied[key];
export const defaults = () => Object.fromEntries(SCHEMA.map((s) => [s.key, s.def]));

// Checks one value against its knob. Returns the cleaned value or throws a message.
function clean(def, v) {
  if (def.type === 'toggle') {
    if (typeof v !== 'boolean') throw new Error(`${def.label} must be on or off`);
    return v;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${def.label} must be a number`);
  if (v < def.min || v > def.max) throw new Error(`${def.label} must be between ${def.min} and ${def.max}`);
  const dp = (String(def.step).split('.')[1] ?? '').length;
  return Number((Math.round(v / def.step) * def.step).toFixed(dp));
}

// Whole-object validation: unknown keys are errors, missing keys keep their current value.
export function validate(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('values must be an object');
  const out = { ...base };
  for (const [k, v] of Object.entries(input)) {
    const def = BY_KEY.get(k);
    if (!def) throw new Error(`Unknown setting: ${k}`);
    out[k] = clean(def, v);
  }
  if (out.minSize > out.maxSize) throw new Error('Min map side cannot be larger than Max map side');
  return out;
}

let file = null;
let saved = defaults(); // what is persisted
let applied = defaults(); // what the game modules run with right now

function push() {
  configureWorld({ lightRadius: applied.lightRadius, sightRange: applied.sightRange, minSize: applied.minSize, maxSize: applied.maxSize, lives: applied.lives, roomArea: applied.roomArea });
  configureAdversaries(applied);
  configureSkills(applied);
  configureCoins(applied);
  configureHearts(applied);
}

// Loads (or starts) this server's settings and applies everything. Bad or stale entries fall back to defaults.
export async function loadSettings(path) {
  file = path;
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const next = defaults();
    for (const [k, v] of Object.entries(raw ?? {})) {
      const def = BY_KEY.get(k);
      if (!def) continue;
      try { next[k] = clean(def, v); } catch { /* keep the default */ }
    }
    saved = next.minSize <= next.maxSize ? next : defaults();
  } catch { /* no file yet */ }
  applied = { ...saved };
  push();
}

// Saves, then applies the live knobs now; the rest wait for applyNextGame().
export async function saveSettings(input) {
  const next = validate(input, saved);
  await writeFile(file, JSON.stringify(next, null, 2) + '\n');
  saved = next;
  for (const s of SCHEMA) if (s.when === 'live') applied[s.key] = saved[s.key];
  push();
  return view();
}

// Called when a new game starts: everything saved is now in force.
export function applyNextGame() {
  applied = { ...saved };
  push();
}

export const view = () => ({
  schema: SCHEMA,
  values: saved,
  defaults: defaults(),
  pending: SCHEMA.filter((s) => s.when === 'next' && applied[s.key] !== saved[s.key]).map((s) => s.key),
});
