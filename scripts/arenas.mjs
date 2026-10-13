#!/usr/bin/env node
// CLI for the hub (hub.js): starts, lists and stops extra /arena/<name>/ (normal dungeon) and
// /gym/<name>/ (testbed) instances, each with its own settings, data folder and log.
//   dungeon-cli up --arena 3 --set speed=0.8 --gym 5 --opt size=9x9 --set lives=3
// `dungeon-cli help` has the full syntax. Starting instances is free: nothing here calls Jev.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'runs');
const HUB_FILE = join(RUNS, 'hub.json');

const HELP = `Usage: dungeon-cli <command>

  up <groups>     Start instances. A group starts at --arena N (normal dungeons, URL /arena/<name>/) or
                  --gym N (testbed arenas, URL /gym/<name>/); the options after it belong to that group:
                    --set key=value   a setting from src/settings.js (speed, lives, lightRadius, ...). Repeatable.
                    --opt key=value   a testbed option from AGENTS.md "Testbed" (size, map, numAdversaries, ...). Gym groups only.
                    --label <prefix>  names become <prefix>1, <prefix>2, ... (default a1.. for arenas, g1.. for gyms).
                  Or JSON: --spec '[{"kind":"arena","count":3,"settings":{"speed":0.8}},
                                    {"kind":"gym","count":5,"options":{"size":"9x9"},"settings":{"lives":3}}]'  (or --spec-file f.json)
                  Example: up --arena 3 --set speed=0.8 --gym 5 --opt size=9x9 --set lives=3 --gym 2 --label tight --opt 'map=#######/#@....#/#.....#/#.....#/#######'
                  Everything is validated first; if one instance fails to start, none of the batch stays up.
  list            Every instance: URL, settings URL, port, pid, log path, overrides.
  logs <name> [-n 40]   Last lines of one instance's server.log. <name> is arena/a1, gym/g2, or a bare unique name (a1).
  down <name>...  Stop instances: arena/a1, a1, "arena" or "gym" (all extra ones of that kind), or "all". The main /arena and /gym stay up.
  hub start|stop|status   The hub is started automatically by "up". Default port 3000 (PORT env or --hub-port).

Every instance serves the normal UI and API under its path: /arena/a1/, /arena/a1/settings, /arena/a1/api/settings,
/arena/a1/api/state, /arena/a1/api/new, /arena/a1/api/step. The bare /arena/ and /gym/ are the always-on main instances.
Files per instance: runs/<kind>/<name>/{server.log, settings.json, memory.json, memory.md, adversaries.json}.
Starting is free; stepping (POST .../api/step) is what costs Jev calls. Run \`down\` when you are done.`;

const fail = (msg) => { console.error(`arenas: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function parseKv(text, what) {
  const i = text.indexOf('=');
  if (i < 1) fail(`${what} expects key=value, got "${text}"`);
  const raw = text.slice(i + 1);
  let v = raw;
  if (raw === 'true' || raw === 'false') v = raw === 'true';
  else if (raw.trim() !== '' && Number.isFinite(Number(raw))) v = Number(raw);
  return [text.slice(0, i), v];
}

function parseUp(args) {
  const groups = [];
  let cur = null;
  let spec = null;
  let hubPort = null;
  const val = (i, flag) => (args[i + 1] === undefined ? fail(`${flag} needs a value`) : args[i + 1]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--arena', '--gym', '--normal', '--testbed'].includes(a)) {
      cur = { kind: a === '--arena' || a === '--normal' ? 'arena' : 'gym', count: Number(val(i++, a)), settings: {}, options: {} };
      groups.push(cur);
    } else if (a === '--set' || a === '--opt' || a === '--label') {
      if (!cur) fail(`${a} must come after --arena N or --gym N`);
      const v = val(i++, a);
      if (a === '--label') cur.label = v;
      else { const [k, x] = parseKv(v, a); (a === '--set' ? cur.settings : cur.options)[k] = x; }
    } else if (a === '--spec') spec = JSON.parse(val(i++, a));
    else if (a === '--spec-file') spec = JSON.parse(readFileSync(val(i++, a), 'utf8'));
    else if (a === '--hub-port') hubPort = Number(val(i++, a));
    else fail(`unknown argument "${a}" (try: help)`);
  }
  if (spec) {
    if (groups.length) fail('use either --spec/--spec-file or --arena/--gym groups, not both');
    if (!Array.isArray(spec)) fail('the spec must be a JSON array of groups');
    groups.push(...spec);
  }
  if (!groups.length) fail('nothing to start. Example: up --arena 2 --gym 3 --opt size=9x9');
  return { groups, hubPort };
}

// ---- hub ----
const readHubFile = () => { try { return JSON.parse(readFileSync(HUB_FILE, 'utf8')); } catch { return null; } };

async function ping(url) {
  try { return (await fetch(`${url}/api/instances`)).ok; } catch { return false; }
}

async function ensureHub(hubPort) {
  const h = readHubFile();
  if (h && alive(h.pid) && (await ping(`http://localhost:${h.port}`))) return `http://localhost:${h.port}`;
  mkdirSync(RUNS, { recursive: true });
  const log = openSync(join(RUNS, 'hub.log'), 'a');
  const port = hubPort ?? (Number(process.env.PORT) || 3000);
  const child = spawn(process.execPath, [join(ROOT, 'hub.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  const url = `http://localhost:${port}`;
  for (const deadline = Date.now() + 40_000; Date.now() < deadline;) {
    if (!alive(child.pid)) break;
    if (await ping(url)) return url;
    await sleep(200);
  }
  const tail = existsSync(join(RUNS, 'hub.log')) ? readFileSync(join(RUNS, 'hub.log'), 'utf8').trimEnd().split('\n').slice(-8).join('\n') : '';
  return fail(`the hub did not start on :${port} (is the port taken, e.g. by an old server.js? stop it or use --hub-port)\n${tail}`);
}

function runningHub() {
  const h = readHubFile();
  if (!h || !alive(h.pid)) fail('the hub is not running. Start it with: node scripts/arenas.mjs up ... (or hub start)');
  return `http://localhost:${h.port}`;
}

async function call(hub, path, body) {
  const res = await fetch(`${hub}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) fail(data.error ?? `HTTP ${res.status}`);
  return data;
}

function print(hub, list) {
  if (!list.length) return console.log('(none)');
  const w = Math.max(...list.map((i) => i.key.length));
  const pad = ' '.repeat(w);
  for (const i of list) {
    const extra = [i.options && Object.keys(i.options).length ? `options=${JSON.stringify(i.options)}` : '', Object.keys(i.overrides).length ? `settings=${JSON.stringify(i.overrides)}` : ''].filter(Boolean).join(' ');
    console.log(`${i.key.padEnd(w)}  ${hub}${i.path}  settings: ${hub}${i.settings_path}  (:${i.port}, pid ${i.pid}${i.running ? '' : ', stopped'})${extra ? `\n${pad}  ${extra}` : ''}\n${pad}  log: ${i.log}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'up') {
  const { groups, hubPort } = parseUp(rest);
  const hub = await ensureHub(hubPort);
  const { instances } = await call(hub, '/api/instances', { instances: groups });
  console.log(`Started ${instances.length} instances (nothing has called Jev; stepping does):`);
  print(hub, instances);
  console.log(`\nLogs: dungeon-cli logs <name>    Stop: dungeon-cli down ${instances.map((i) => i.key).join(' ')}`);
} else if (cmd === 'list') {
  const hub = runningHub();
  print(hub, (await call(hub, '/api/instances')).instances);
} else if (cmd === 'logs') {
  const hub = runningHub();
  const ni = rest.indexOf('-n');
  const name = rest.find((a, i) => !a.startsWith('-') && i !== (ni < 0 ? -1 : ni + 1));
  if (!name) fail('logs needs a name, e.g. logs gym/g2');
  const hits = (await call(hub, '/api/instances')).instances.filter((i) => i.key === name || i.name === name);
  if (hits.length !== 1) fail(hits.length ? `"${name}" is ambiguous: ${hits.map((i) => i.key).join(', ')}` : `no instance "${name}" (see: list)`);
  console.log(readFileSync(hits[0].log, 'utf8').trimEnd().split('\n').slice(-(ni >= 0 ? Number(rest[ni + 1]) || 40 : 40)).join('\n'));
} else if (cmd === 'down') {
  if (!rest.length) fail('down needs names (arena/a1, gym, all, ...)');
  const { stopped } = await call(runningHub(), '/api/instances/down', { names: rest });
  console.log(`Stopped ${stopped.join(', ')} (logs stay in runs/<kind>/<name>/)`);
} else if (cmd === 'hub') {
  const sub = rest[0];
  const h = readHubFile();
  if (sub === 'start') console.log(`Hub at ${await ensureHub()}`);
  else if (sub === 'stop') {
    if (!h || !alive(h.pid)) fail('the hub is not running');
    process.kill(h.pid, 'SIGTERM');
    console.log('Hub stopped (it stops every instance it started).');
  } else if (sub === 'status') console.log(h && alive(h.pid) ? `Hub running at http://localhost:${h.port} (pid ${h.pid})` : 'Hub not running');
  else fail('hub start|stop|status');
} else console.log(HELP);
