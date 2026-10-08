#!/usr/bin/env node
// CLI for central-config.yaml (src/config/). Free: nothing here calls Jev. JEV_CONFIG=<path> picks another file.
//   init [--force]            write the commented template (never overwrites without --force)
//   path                      where the file is
//   get <path|key> [--instance arena/main]   the effective value (defaults + file + that instance's block)
//   set <path> <value>        edit one value in place, comments kept; <value> is YAML (0.5, true, "text"); refuses an unknown path or a bad value
//   validate                  print every warning the loader has for the file; exit 1 if any
//   diff                      the values that differ from the built-in defaults
//   user                      the knobs flagged userSetting (what a player UI may list)
//   docs                      a markdown table of every knob
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { KNOBS, isUserSetting } from '../src/config/registry.js';
import { parseConfig, templateYaml, defaults } from '../src/config/load.js';
import { configFile } from '../src/config/runtime.js';

const [cmd, ...rest] = process.argv.slice(2);
const file = configFile();
const flag = (name) => { const i = rest.indexOf(name); return i < 0 ? null : rest.splice(i, 2)[1]; };
const fail = (msg) => { console.error(msg); process.exit(1); };
const read = () => (file && existsSync(file) ? readFileSync(file, 'utf8') : null);
const rowFor = (id) => KNOBS.find((k) => k.path === id || k.key === id);
const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

if (!cmd || cmd === 'help') {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
} else if (cmd === 'path') {
  console.log(file ?? '(no file: JEV_CONFIG=none)');
} else if (cmd === 'init') {
  if (!file) fail('JEV_CONFIG=none: there is no file to write');
  const force = rest.includes('--force');
  if (existsSync(file) && !force) fail(`${file} exists (use --force to overwrite)`);
  writeFileSync(file, templateYaml());
  console.log(`wrote ${file}`);
} else if (cmd === 'get') {
  const instance = flag('--instance');
  const id = rest[0] ?? fail('usage: get <path|key> [--instance name]');
  const row = rowFor(id) ?? fail(`unknown setting: ${id}`);
  const text = read();
  const names = instance ? [instance.split('/')[0], instance] : [];
  const { values } = parseConfig(text ? YAML.parse(text) : null, names);
  console.log(fmt(values[row.key] ?? row.def));
} else if (cmd === 'set') {
  const [id, raw] = rest;
  if (!file) fail('JEV_CONFIG=none: there is no file to edit');
  if (id === undefined || raw === undefined) fail('usage: set <path> <value>');
  const row = KNOBS.find((k) => k.path === id) ?? fail(`unknown path: ${id} (see: docs)`);
  const doc = YAML.parseDocument(read() ?? templateYaml());
  doc.setIn(id.split('.'), YAML.parse(raw));
  const { warnings } = parseConfig(doc.toJS());
  const mine = warnings.filter((w) => w.startsWith(row.path));
  if (mine.length) fail(mine.join('\n'));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  console.log(`${row.path} = ${raw}`);
} else if (cmd === 'validate') {
  const text = read();
  if (!text) { console.log(file ? `no file at ${file}: defaults apply` : 'no file (JEV_CONFIG=none)'); process.exit(0); }
  let parsed;
  try { parsed = parseConfig(YAML.parse(text)); } catch (err) { fail(`${file}: ${err.message}`); }
  for (const w of parsed.warnings) console.log(w);
  console.log(parsed.warnings.length ? `${parsed.warnings.length} warning(s)` : 'ok');
  process.exit(parsed.warnings.length ? 1 : 0);
} else if (cmd === 'diff') {
  const text = read();
  const { values } = parseConfig(text ? YAML.parse(text) : null);
  const d = defaults();
  for (const row of KNOBS) if (row.key in values && values[row.key] !== d[row.key]) console.log(`${(row.path ?? row.key).padEnd(40)} ${fmt(d[row.key])} -> ${fmt(values[row.key])}`);
} else if (cmd === 'user') {
  for (const row of KNOBS.filter(isUserSetting)) console.log(`${(row.path ?? row.key).padEnd(28)} ${row.label}`);
} else if (cmd === 'docs') {
  console.log('| path | default | range | applies | player UI |\n| --- | --- | --- | --- | --- |');
  for (const r of KNOBS) console.log(`| ${r.path ?? `(${r.key}, derived)`} | ${fmt(r.def)} | ${r.type === 'range' ? `${r.min}..${r.max}` : 'on/off'} | ${r.when} | ${isUserSetting(r) ? 'yes' : 'no'} |`);
} else fail(`unknown command: ${cmd} (try: help)`);
