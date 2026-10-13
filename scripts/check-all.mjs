// Runs every scripts/check-*.mjs in parallel (free, no Jev: each check installs its own fetch tripwire)
// and prints one line per check plus the FAIL lines of the ones that failed. Exit 1 if any failed.
// Usage: node scripts/check-all.mjs [--jobs 6] [--only name,name] [--skip name,name]
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const jobs = Number(opt('jobs', 6));
const only = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
const skip = new Set(opt('skip', '').split(',').filter(Boolean));
const names = readdirSync(here).filter((f) => /^check-.*\.mjs$/.test(f) && f !== 'check-all.mjs')
  .map((f) => f.replace(/\.mjs$/, '')).filter((n) => (!only || only.has(n)) && !skip.has(n)).sort();

function run(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [`${here}${name}.mjs`], { env: { ...process.env, JEV_CONFIG: process.env.JEV_CONFIG ?? 'none' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ name, code, out, ms: Date.now() - t0 }));
  });
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, async () => {
  while (next < names.length) {
    const r = await run(names[next++]);
    results.push(r);
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
  }
}));
const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  console.log(`\n== ${r.name} (exit ${r.code})`);
  const lines = r.out.split('\n');
  const fails = lines.filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12);
  console.log((fails.length ? fails : lines.slice(-12)).join('\n'));
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
