// Central config, live part: finds central-config.yaml, layers it, keeps the effective and applied settings, and
// pushes them into the game modules through their configureX hooks. src/settings.js re-exports this for the old callers.
//   Layers, lowest first: built-in defaults < central-config.yaml < instances.<kind> < instances.<kind/name> <
//   this server's own settings.json (the settings page saves only the keys that differ from the layers below).
//   File: JEV_CONFIG=<path> (default central-config.yaml next to server.js); JEV_CONFIG=none reads and writes no file (checks use it).
//   The file is re-read by mtime on refresh(), applyNextGame() and saveSettings(); a broken file keeps the last good values.
import { existsSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { configureWorld } from '../dungeon.js';
import { configureProps } from '../props/catalog.js';
import { configureTestbed } from '../testbed.js';
import { configureAdversaries } from '../characters/adversary/adversary.js';
import { configureSkills } from '../skills/config.js';
import { configureCoins } from '../coins.js';
import { configureHearts } from '../hearts.js';
import { configureCharacters, configureDistribution, configureTraits } from '../characters/adversary/character.js';
import { configureQuestion } from '../skills/question.js';
import { configureExplorerPrompts } from '../characters/explorer/brain.js';
import { configureCharacterPrompts } from '../characters/adversary/character.js';
import { configureMonsterPrompts } from '../characters/adversary/memory.js';
import { configureSkillPrompts } from '../skills/question.js';
import { configureExplorerBrain } from '../characters/explorer/brain.js';
import { configureExplorerPerception } from '../characters/explorer/perception.js';
import { configureExplorerEncounter } from '../characters/explorer/encounter.js';
import { configureConfidence } from '../characters/explorer/confidence.js';
import { configureExplorerMemory } from '../characters/explorer/memory.js';
import { configureAdversaryLimits } from '../characters/adversary/memory.js';
import { configureAttack } from '../skills/attack.js';
import { configureAdversaryBrain } from '../characters/adversary/brain.js';
import { configureAdversaryPerception } from '../characters/adversary/perception.js';
import { configureAdversaryMemory } from '../characters/adversary/memory.js';
import { configureAdversaryView } from '../characters/adversary/adversary-view.js';
import { KNOBS, isUserSetting } from './registry.js';
import { SCHEMA, defaults, validate, clean, crossProblems, parseConfig, templateYaml, eq } from './load.js';

export { SCHEMA, defaults, validate };

const BY_KEY = new Map(KNOBS.map((s) => [s.key, s]));

// Resolved when called, not at import, so a script can set JEV_CONFIG first. null = no file.
export function configFile() {
  const e = process.env.JEV_CONFIG;
  if (e === 'none') return null;
  return e ? resolve(e) : fileURLToPath(new URL('../../central-config.yaml', import.meta.url));
}

// Hub instances run with DATA_DIR = runs/<arena|gym>/<name>: ['arena', 'arena/main'].
function instanceNames() {
  if (!process.env.DATA_DIR) return [];
  const [kind, name] = resolve(process.env.DATA_DIR).split(sep).slice(-2);
  return kind === 'arena' || kind === 'gym' ? [kind, `${kind}/${name}`] : [];
}

export const appliedValue = (key) => applied[key];

let file = null; // this server's settings.json
let saved = defaults(); // the effective settings (all layers)
let applied = defaults(); // what the game modules run with right now
let base = defaults(); // defaults + the central layers: what a server with no settings.json of its own gets
let own = {}; // keys this server's settings.json overrides
let central = { path: null, mtimeMs: null, warnings: [] };

function push() {
  configureWorld(applied);
  configureProps(applied);
  configureTestbed(applied);
  configureAdversaries(applied);
  configureSkills(applied);
  configureQuestion(applied);
  configureTraits(applied);
  configureExplorerBrain(applied);
  configureExplorerPerception(applied);
  configureExplorerEncounter(applied);
  configureConfidence(applied);
  configureAdversaryBrain(applied);
  configureAdversaryPerception(applied);
  configureAdversaryMemory(applied);
  configureAdversaryView(applied);
  configureExplorerMemory(applied);
  configureAdversaryLimits(applied);
  configureAttack(applied);
  configureExplorerPrompts(applied);
  configureCharacterPrompts(applied);
  configureMonsterPrompts(applied);
  configureSkillPrompts(applied);
  configureCoins(applied);
  configureHearts(applied);
}

function recompute(values) {
  const warnings = [];
  let layered = { ...defaults(), ...values };
  if (crossProblems(layered).length) { warnings.push(...crossProblems(layered).map((p) => `${p} (ignored the file)`)); layered = defaults(); }
  base = layered;
  const merged = { ...base, ...own };
  const bad = crossProblems(merged);
  if (bad.length) warnings.push(`settings.json: ${bad[0]} (ignored it)`);
  saved = bad.length ? base : merged;
  return warnings;
}

// Reads the file if its mtime moved (or on force). Returns true when something changed.
async function readCentral(force = false) {
  const path = configFile();
  let st = null;
  if (path) try { st = await stat(path); } catch { /* no file: the layer is empty */ }
  if (!force && path === central.path && (st?.mtimeMs ?? null) === central.mtimeMs) return false;
  let parsed = parseConfig(null);
  if (st) {
    try {
      parsed = parseConfig(YAML.parse(await readFile(path, 'utf8')), instanceNames());
    } catch (err) {
      central = { ...central, path, mtimeMs: st.mtimeMs, warnings: [`${path}: ${String(err.message).split('\n')[0]} (kept the previous values)`] };
      console.warn(central.warnings[0]);
      return false;
    }
  }
  parsed.warnings.push(...configureCharacters(parsed.presets), ...configureDistribution(parsed.mix));
  parsed.warnings.push(...recompute(parsed.values));
  for (const w of parsed.warnings) console.warn(`config: ${w}`);
  central = { path, mtimeMs: st?.mtimeMs ?? null, warnings: parsed.warnings };
  return true;
}

// Loads (or starts) this server's settings and applies everything. Bad or stale entries fall back to defaults.
export async function loadSettings(path) {
  file = path;
  const cf = configFile();
  if (cf && !existsSync(cf)) {
    try { await writeFile(cf, templateYaml(), { flag: 'wx' }); } catch { /* another server won the race, or the folder is read-only */ }
  }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const legacy = !raw?._sparse; // older files hold every key: a value equal to the default is not an override
    for (const [k, v] of Object.entries(raw ?? {})) {
      const def = BY_KEY.get(k);
      if (!def) continue;
      try {
        const val = clean(def, v);
        if (!legacy || !eq(val, def.def)) own[k] = val;
      } catch { /* skip the bad value */ }
    }
  } catch { /* no file yet */ }
  recompute({});
  await readCentral(true);
  applied = { ...saved };
  push();
}

// Picks up an edit of the file: live knobs apply now, the rest wait for applyNextGame().
export async function refresh() {
  if (!(await readCentral())) return false;
  for (const s of KNOBS) if (s.when === 'live') applied[s.key] = saved[s.key];
  push();
  return true;
}

// Saves, then applies the live knobs now; the rest wait for applyNextGame().
// Only values that differ from the central layers go to this server's file, so later edits of the central file still reach it.
export async function saveSettings(input) {
  await readCentral();
  const next = validate(input, saved);
  const overrides = Object.fromEntries(KNOBS.filter((s) => !eq(next[s.key], base[s.key])).map((s) => [s.key, next[s.key]]));
  await writeFile(file, JSON.stringify({ _sparse: true, ...overrides }, null, 2) + '\n');
  own = overrides;
  saved = next;
  for (const s of KNOBS) if (s.when === 'live') applied[s.key] = saved[s.key];
  push();
  return view();
}

// Called when a new game starts: everything saved is now in force.
export async function applyNextGame() {
  await readCentral();
  applied = { ...saved };
  push();
}

export const view = () => ({
  schema: SCHEMA,
  values: saved,
  defaults: defaults(),
  pending: KNOBS.filter((s) => s.when === 'next' && !eq(applied[s.key], saved[s.key])).map((s) => s.key),
  central: { file: central.path, warnings: central.warnings },
});

// ---------- the player-facing scope (userSetting) ----------
const userRows = () => KNOBS.filter(isUserSetting);

// Only the knobs flagged userSetting: what a player-facing UI may list.
export function userView() {
  const rows = userRows();
  return {
    schema: rows.map(({ key, path, group, label, hint, type, min, max, step, def, when }) => ({ key, path, group, label, hint, type, ...(type === 'range' ? { min, max, step } : {}), def, when })),
    values: Object.fromEntries(rows.map((r) => [r.key, saved[r.key]])),
    pending: view().pending.filter((k) => rows.some((r) => r.key === k)),
  };
}

// Saves player-scope values (keyed by flat key or file path). Any other key throws with status 403.
export async function saveUserSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('values must be an object'), { status: 400 });
  const rows = userRows();
  const flat = {};
  for (const [k, v] of Object.entries(input)) {
    const row = rows.find((r) => r.key === k || r.path === k);
    if (!row) throw Object.assign(new Error(`${k} is not a player setting`), { status: 403 });
    flat[row.key] = v;
  }
  await saveSettings({ ...saved, ...flat });
  return userView();
}
