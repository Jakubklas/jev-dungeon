// Central config, pure part: the knob rows as the settings page and the modules see them (SCHEMA, keyed by the flat
// name), value cleaning, parsing a central-config.yaml mapping into flat values, and the commented YAML template.
// No file or game state here: runtime.js does the I/O. See PLAN-central-config.md.
import YAML from 'yaml';
import { KNOBS, KIND_WEIGHTS, CATEGORIES } from './registry.js';
import { TRAITS, SPECIAL_IDS, defaultPresets } from '../characters/adversary/character.js';
import { builtinText } from './texts.js';

// The settings page's rows (the shape settings.html has always read). File-only knobs (page: false) are not on it.
export const SCHEMA = KNOBS.filter((k) => k.page !== false).map(({ key, group, label, hint, type, min, max, step, def, when }) => ({ key, group, label, hint, type, ...(type === 'range' ? { min, max, step } : {}), def, when }));
// Every knob, page or not: validation, defaults and the flat key space cover all of them.
const BY_KEY = new Map(KNOBS.map((s) => [s.key, s]));
export const defaults = () => Object.fromEntries(KNOBS.map((s) => [s.key, s.def]));

// Checks one value against its knob. Returns the cleaned value or throws a message.
export const eq = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);
const step1 = (def, v) => {
  const dp = (String(def.step).split('.')[1] ?? '').length;
  return Number((Math.round(v / def.step) * def.step).toFixed(dp));
};
export function clean(def, v) {
  if (v === null && def.nullable) return null;
  if (def.type === 'text') {
    const one = (x) => {
      if (typeof x !== 'string') throw new Error(`${def.label} must be text`);
      if (/[\u0000-\u001f\u007f]/.test(x)) throw new Error(`${def.label} cannot contain control characters or line breaks`);
      if (x.length > def.maxLen) throw new Error(`${def.label} is ${x.length} characters; the limit is ${def.maxLen}`);
      if (!def.allowEmpty && !x.trim()) throw new Error(`${def.label} cannot be empty`);
      return x;
    };
    if (def.len) {
      if (!Array.isArray(v) || v.length !== def.len) throw new Error(`${def.label} must be a list of ${def.len} texts`);
      return v.map(one);
    }
    return one(v);
  }
  if (def.type === 'list') {
    if (!Array.isArray(v)) throw new Error(`${def.label} must be a list`);
    if (v.length > def.maxLen) throw new Error(`${def.label} holds at most ${def.maxLen} entries`);
    if (def.minLen && v.length < def.minLen) throw new Error(`${def.label} needs at least ${def.minLen} entr${def.minLen === 1 ? 'y' : 'ies'}`);
    if (new Set(v).size !== v.length) throw new Error(`${def.label} cannot repeat an entry`);
    for (const x of v) if (!def.options.includes(x)) throw new Error(`${def.label}: '${x}' is not one of ${def.options.join(', ')}`);
    return [...v];
  }
  if (def.type === 'tuple') {
    if (!Array.isArray(v) || v.length !== def.len) throw new Error(`${def.label} must be a list of ${def.len} numbers`);
    return v.map((x) => {
      if (x === null && def.nullableElements) return null;
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${def.label} entries must be numbers${def.nullableElements ? ' or null' : ''}`);
      if (x < def.min || x > def.max) throw new Error(`${def.label} entries must be between ${def.min} and ${def.max}`);
      return step1(def, x);
    });
  }
  if (def.type === 'choice') {
    if (!def.options.includes(v)) throw new Error(`${def.label} must be one of ${def.options.join(', ')}`);
    return v;
  }
  if (def.type === 'toggle') {
    if (typeof v !== 'boolean') throw new Error(`${def.label} must be on or off`);
    return v;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${def.label} must be a number`);
  if (v < def.min || v > def.max) throw new Error(`${def.label} must be between ${def.min} and ${def.max}`);
  return step1(def, v);
}

// Cross-field rules on a full flat settings object. Returns a list of problems (empty = fine).
export function crossProblems(values) {
  const out = [];
  if (values.minSize > values.maxSize) out.push('Min map side cannot be larger than Max map side');
  if (values.roomMin > values.roomMax) out.push('Smallest room side cannot be larger than the largest');
  if (values.roomMax !== undefined && values.minSize !== undefined && values.roomMax + 2 > values.minSize) out.push('Largest room side must fit the smallest map (room side + 2 <= Min map side)');
  if (values.torchMin > values.torchMax) out.push('Fewest torches cannot be more than the most');
  if (values.clusterSizeMin > values.clusterSizeMax) out.push('Smallest cluster cannot be larger than the largest');
  if (values.injectMaxChars > values.limExplorer_directive) out.push('The directive length setting cannot exceed the directive memory limit (limits.explorer.directive)');
  if (values.limExplorer_recentCells < values.limExplorer_recentMoves + 2) out.push('limits.explorer.recentCells must be at least recentMoves + 2');
  const tmax = (k) => (Array.isArray(values[k]) ? Math.max(...values[k]) : 0);
  if (tmax('trait_recentMoves') > values.limMonster_moves) out.push('A character recent-moves level exceeds limits.monster.moves');
  if (tmax('trait_recentCells') > values.limMonster_cells) out.push('A character recent-cells level exceeds limits.monster.cells');
  if (tmax('trait_sightingsKept') > values.limMonster_sightings) out.push('A character sightings level exceeds limits.monster.sightings');
  if (tmax('trait_landmarksCap') > values.limMonster_landmarks) out.push('A character landmarks level exceeds limits.monster.landmarks');
  if (values.advCutMin > values.advCutMax) out.push('Nearest cut-off candidate cannot be farther than the farthest');
  if (values.confPanicExit < values.confPanicEnter) out.push('Panic must end at or above the confidence where it starts');
  if (values.confTierLowMax >= values.confTierHighMin) out.push('The low tier must end below the confidence where the high tier starts');
  if (!(values.confBandDominant > values.confBandSure && values.confBandSure > values.confBandEven && values.confBandEven > values.confBandUnsure && values.confBandUnsure >= 0)) out.push('Confidence bands must fall: dominant > sure > even > unsure');
  for (const [name, ids] of Object.entries({ 'solid prop': ['shelf', 'crates', 'storage_chest'], 'small prop': ['pots', 'skull', 'tools', 'sword', 'anvil', 'goblet'], 'big wall piece': ['fireplace', 'arch', 'gate', 'banner'] })) {
    if (ids.every((id) => values[`propWeight_${id}`] === 0)) out.push(`At least one ${name} kind needs a weight above 0 (${ids.join(', ')})`);
  }
  return out;
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
  const bad = crossProblems(out);
  if (bad.length) throw new Error(bad[0]);
  return out;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const getPath = (o, path) => path.split('.').reduce((n, k) => (isObj(n) ? n[k] : undefined), o);
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

// Every path the file may carry, and every prefix of one (so an unknown key is reported, not silently ignored).
const FILE_PATHS = new Set([...KNOBS.filter((k) => k.path).map((k) => k.path), ...KIND_WEIGHTS.map((k) => k.path)]);
const PREFIXES = new Set(['monsters.characters.presets', 'monsters.characters.mix']);
for (const p of FILE_PATHS) { const parts = p.split('.'); for (let i = 1; i < parts.length; i++) PREFIXES.add(parts.slice(0, i).join('.')); }

function unknownPaths(node, prefix, warnings) {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (FILE_PATHS.has(path) || path === 'monsters.characters.mix' || path.startsWith('monsters.characters.presets')) continue;
    if (PREFIXES.has(path) && isObj(v)) unknownPaths(v, path, warnings);
    else warnings.push(`${path}: unknown setting`);
  }
}

// raw: the parsed YAML. names: the instance names that apply here, lowest first (['arena', 'arena/main']): each one's
// block is merged over the file, same shape as the file itself. -> { values (flat key -> cleaned), presets, mix, warnings }
export function parseConfig(raw, names = []) {
  const warnings = [];
  if (raw == null) raw = {};
  if (!isObj(raw)) return { values: {}, presets: {}, mix: 'mixed', warnings: ['the file must be a mapping at the top level'] };
  const { instances, ...rest } = raw;
  if (instances != null && !isObj(instances)) warnings.push('instances: must be a mapping');
  let merged = rest;
  for (const n of names) if (isObj(instances?.[n])) merged = deepMerge(merged, instances[n]);
  unknownPaths(merged, '', warnings);
  const values = {};
  for (const row of KNOBS) {
    if (!row.path) continue;
    const v = getPath(merged, row.path);
    if (v === undefined) continue;
    try {
      const val = clean(row, v);
      values[row.key] = row.type === 'text' && eq(val, builtinText(row.key)) ? null : val; // the built-in wording is no override
    } catch (err) { warnings.push(`${row.path}: ${err.message}`); }
  }
  // Kind weights are relative; the game reads the troll share.
  const w = KIND_WEIGHTS.map((k) => ({ ...k, v: getPath(merged, k.path) }));
  if (w.some((k) => k.v !== undefined)) {
    const bad = w.find((k) => k.v !== undefined && !(typeof k.v === 'number' && Number.isFinite(k.v) && k.v >= 0));
    if (bad) warnings.push(`${bad.path} must be a number >= 0`);
    else {
      const [g, t] = w.map((k) => k.v ?? k.def);
      if (g + t <= 0) warnings.push('monsters.kinds: the weights cannot both be 0');
      else values.trollShare = clean(BY_KEY.get('trollShare'), t / (g + t));
    }
  }
  const ch = merged.monsters?.characters;
  return { values, presets: isObj(ch?.presets) ? ch.presets : {}, mix: ch?.mix ?? 'mixed', warnings };
}

// ---------- the commented YAML template ----------
const scalar = (v) => YAML.stringify(v, { lineWidth: 0, collectionStyle: 'flow' }).trim();
const COL = 34; // comments start in this column when the line is shorter

const TRAIT_DOC = {
  aggression: '1 hesitant, 2 steady, 3 fierce (chase range, striking)',
  persistence: '1 gives up fast, 2 standard, 3 relentless (search time)',
  horizon: '1 short-term, 2 standard, 3 long-term planner (memory, cut-offs)',
  roaming: '1 stays home, 2 ranges, 3 roams everywhere (patrol area)',
  pack: '1 loner, 2 team player, 3 pack hunter (calls, team sight)',
  style: 'One line Jev reads as its personality',
};

export function templateYaml() {
  const tree = {};
  const put = (path, entry) => {
    const parts = path.split('.');
    let n = tree;
    for (const p of parts.slice(0, -1)) n = (n[p] ??= {});
    n[parts.at(-1)] = entry;
  };
  const leaf = (value, doc, block = false) => ({ __leaf: true, value, doc, block });
  for (const k of KNOBS) if (k.path) put(k.path, k.type === 'text' ? leaf(builtinText(k.key), `${k.doc} (the built-in wording; edit to change it, delete to restore)`, true) : leaf(k.def, k.doc));
  for (const k of KIND_WEIGHTS) put(k.path, leaf(k.def, k.doc));
  put('monsters.characters.mix', leaf('mixed', "'mixed' (shuffled deck), 'standard', or weights like { aggressive: 3, timid: 1 }"));
  const presets = {};
  const defs = defaultPresets();
  for (const id of SPECIAL_IDS) {
    presets[id] = {};
    TRAITS.forEach((t, i) => { presets[id][t] = leaf(defs[id].traits[i], TRAIT_DOC[t]); });
    presets[id].style = leaf(defs[id].style, TRAIT_DOC.style);
  }
  put('monsters.characters.presets', presets);

  // Order sections like CATEGORIES, then anything else.
  const lines = [
    '# central-config.yaml: every tunable of the Jev dungeon, read by all servers (arena, gym, standalone).',
    '# Edit and save: a running server picks it up on its next step or new game. Live knobs apply at once, the rest from the next game.',
    '# Delete a key to fall back to its default. A bad value is skipped with a warning in the server log. Secrets stay in ../.env.',
    '# Layers, lowest first: defaults, this file, instances.<kind>, instances.<kind/name>, the instance\'s own settings.json (settings page saves).',
    '',
  ];
  const emit = (node, indent, depthPath) => {
    for (const [k, v] of Object.entries(node)) {
      const pad = '  '.repeat(indent);
      if (v.__leaf) {
        const text = `${pad}${k}: ${scalar(v.value)}`;
        if (v.block) { lines.push(`${pad}# ${v.doc}`); lines.push(text); } else lines.push(v.doc ? `${text.padEnd(COL)}  # ${v.doc}` : text);
      } else {
        const path = depthPath ? `${depthPath}.${k}` : k;
        if (indent === 0 && CATEGORIES[k]) lines.push(`# ${CATEGORIES[k].doc}`);
        lines.push(`${pad}${k}:`);
        emit(v, indent + 1, path);
      }
    }
    if (indent === 0) lines.push('');
  };
  const order = Object.keys(CATEGORIES);
  const sorted = Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
  const top = Object.entries(sorted);
  for (const [k, v] of top) {
    if (CATEGORIES[k]) lines.push(`# ${CATEGORIES[k].doc}`);
    lines.push(`${k}:`);
    emit(v, 1, k);
    lines.push('');
  }
  lines.push('# Per-instance overrides, same shape as everything above. Names: arena, gym (every instance of that kind),');
  lines.push('# arena/main, gym/main, arena/a1, ... Example:  arena/main: { explorer: { lives: 4 } }');
  lines.push('instances: {}');
  return lines.join('\n') + '\n';
}
