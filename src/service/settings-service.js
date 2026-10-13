// The ONE central settings document of the hosted service (PLAN-multiplayer "Settings"). Values are the flat registry
// keys of src/config/ (same validation: `clean` per knob, `crossProblems` across them), seeded from central-config.yaml
// (defaults < file; hub `instances.*` blocks are NOT applied here) and published as append-only revisions in the FileStore.
// This module never calls the configure* hooks: it only holds and validates values (a game's worker applies its snapshot).
//
// What is in the document: game-rule knobs and service knobs (world, explorer, skills, monsters, limits, prompts, Jev
// client tuning, player directive limits). Left out on purpose: group `UI` (browser timings), group `Decision` (provider
// choice and endpoints), and any key named like an endpoint. Secrets and endpoints are not registry knobs at all.
// Hub-only per-instance overrides and the player-facing `scope=user` config do not exist here.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { KNOBS } from '../config/registry.js';
import { SCHEMA, clean, crossProblems, defaults, parseConfig } from '../config/load.js';

const EXCLUDED_GROUPS = new Set(['UI', 'Decision']);
const isEditable = (row) => !EXCLUDED_GROUPS.has(row.group) && !/endpoint|secret|apikey/i.test(row.key);
const ROWS = new Map(KNOBS.filter(isEditable).map((k) => [k.key, k]));
export const EDITABLE_KEYS = [...ROWS.keys()];

export function configPath() {
  const e = process.env.JEV_CONFIG;
  if (e === 'none') return null;
  return e ? resolve(e) : fileURLToPath(new URL('../../central-config.yaml', import.meta.url));
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const pick = (values) => Object.fromEntries(EDITABLE_KEYS.map((k) => [k, values[k]]));

// Defaults overlaid with the YAML file. -> { values, warnings }
export function fileValues(path = configPath()) {
  let parsed = parseConfig(null);
  if (path && existsSync(path)) {
    try { parsed = parseConfig(YAML.parse(readFileSync(path, 'utf8'))); } catch (err) { parsed = { ...parseConfig(null), warnings: [`${path}: ${String(err.message).split('\n')[0]}`] }; }
  }
  let values = { ...defaults(), ...parsed.values };
  const warnings = [...parsed.warnings];
  if (crossProblems(values).length) { warnings.push(`${crossProblems(values)[0]} (ignored the file)`); values = defaults(); }
  return { values: pick(values), warnings };
}

export class SettingsService {
  #store;
  #current;
  warnings = [];

  // path: the YAML file (default per JEV_CONFIG). Seeds revision 1 from defaults + file when the store has none.
  constructor(store, { path = configPath() } = {}) {
    this.#store = store;
    this.#current = store.currentRevision();
    if (!this.#current) {
      const f = fileValues(path);
      this.warnings = f.warnings;
      this.#current = store.publishRevision(f.values);
    } else {
      // A stored revision from an older registry: fill new knobs with defaults, drop retired ones (in memory only).
      this.#current = { revision: this.#current.revision, values: { ...pick(defaults()), ...this.#current.values } };
    }
  }

  get revision() { return this.#current.revision; }

  // -> { revision, values, schema }: the page rows the host editor shows (file-only knobs are in `values` only).
  get() {
    return { revision: this.#current.revision, values: { ...this.#current.values }, schema: SCHEMA.filter((r) => ROWS.has(r.key)) };
  }

  // Partial or full object of key -> value. -> { ok: true, revision, values, changed } or
  // { ok: false, status: 400, error, fields: { key: message } }. Nothing is published unless everything validates.
  put(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, status: 400, error: 'values must be an object', fields: {} };
    const fields = {};
    const next = { ...this.#current.values };
    for (const [k, v] of Object.entries(input)) {
      const row = ROWS.get(k);
      if (!row) { fields[k] = KNOBS.some((x) => x.key === k) ? 'not editable on the hosted service' : 'unknown setting'; continue; }
      try { next[k] = clean(row, v); } catch (err) { fields[k] = err.message; }
    }
    if (!Object.keys(fields).length) {
      const bad = crossProblems(next);
      if (bad.length) fields._ = bad[0];
    }
    if (Object.keys(fields).length) return { ok: false, status: 400, error: 'invalid settings', fields };
    const same = EDITABLE_KEYS.every((k) => JSON.stringify(next[k]) === JSON.stringify(this.#current.values[k]));
    if (same) return { ok: true, revision: this.#current.revision, values: { ...next }, changed: false };
    this.#current = this.#store.publishRevision(next);
    return { ok: true, revision: this.#current.revision, values: { ...this.#current.values }, changed: true };
  }

  // The snapshot a new game keeps in rules.json: a deep-frozen copy, unaffected by later puts.
  rulesForNewGame() {
    return { rules_revision: this.#current.revision, rules: deepFreeze(structuredClone(this.#current.values)) };
  }
}
