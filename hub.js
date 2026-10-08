// The hub: one port that hosts any number of game servers under paths, so one URL space holds them all.
//   /arena/            the normal dungeon "main"      /gym/            the testbed "main"
//   /arena/<name>/     another normal dungeon         /gym/<name>/     another testbed arena
// Each instance is its own server.js process with its own settings, data folder and log (settings are
// process-wide state in the game modules, so separate processes are what keeps them independent).
// Every instance serves the usual UI and API below its path: /arena/a1/, /arena/a1/settings, /arena/a1/api/settings, ...
// Management API (what scripts/arenas.mjs calls): GET /api/instances, POST /api/instances, POST /api/instances/down.
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, defaults } from './src/settings.js';
import { buildArena, TestbedError } from './src/testbed.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNS = join(ROOT, 'runs');
const PORT = Number(process.env.PORT) || 3000;
const WORKER_PORT_FROM = 3100;
const LEGACY_PORT = { arena: 3000, gym: 3001 }; // the valid kinds (the old settings-<port>.json seeding is gone: instances.arena/main and gym/main in central-config.yaml replace it)
const PREFIX = { arena: 'a', gym: 'g' };
const RESERVED = new Set(['api', 'settings', 'props']);
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

const instances = new Map(); // 'arena/a1' -> { kind, name, port, pid, dir, log, overrides, options, main, child }
let queue = Promise.resolve(); // starts and stops one at a time, so ports and names never race
const serialise = (fn) => (queue = queue.then(fn, fn));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((ok) => {
  const s = createNetServer();
  s.once('error', () => ok(false));
  s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
});
async function freePort() {
  const used = new Set([...instances.values()].map((i) => i.port));
  for (let p = WORKER_PORT_FROM; p < 65000; p++) if (!used.has(p) && p !== PORT && (await portFree(p))) return p;
  throw new Error('no free port');
}

class BadSpec extends Error {}

// One spec { kind, count, label, settings, options } -> checked and cleaned, or BadSpec.
function checkSpec(g) {
  if (!g || !(g.kind in LEGACY_PORT)) throw new BadSpec(`kind must be "arena" or "gym", got ${JSON.stringify(g?.kind)}`);
  const count = g.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new BadSpec('count must be an integer 1..50');
  if (g.label != null && (!NAME_RE.test(g.label) || RESERVED.has(g.label) || g.label === 'main')) throw new BadSpec(`label "${g.label}" must be lowercase letters, digits and dashes, start with a letter, and not be "main", ${[...RESERVED].join(', ')}`);
  const overrides = g.settings ?? {};
  const options = g.options ?? {};
  try {
    validate(overrides, defaults());
    if (g.kind === 'gym') buildArena(options);
    else if (Object.keys(options).length) throw new BadSpec('options (testbed config) only apply to gym instances');
  } catch (err) {
    if (err instanceof BadSpec) throw err;
    throw new BadSpec(`${g.label ?? g.kind}: ${err instanceof TestbedError ? `bad testbed config: ${err.message}` : err.message}`);
  }
  return { kind: g.kind, count, label: g.label ?? PREFIX[g.kind], overrides, options };
}

const tail = (file, n) => {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return '(no log)'; }
};

async function waitReady(inst, deadline) {
  while (Date.now() < deadline) {
    if (inst.exited) return false;
    try { if ((await fetch(`http://127.0.0.1:${inst.port}/api/state`)).ok) return true; } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

// Starts one server.js. `main` instances keep their settings file between hub runs; central-config.yaml (instances.arena/main) carries their tuning.
async function startInstance({ kind, name, overrides, options, main = false }) {
  const key = `${kind}/${name}`;
  const dir = join(RUNS, kind, name);
  mkdirSync(dir, { recursive: true });
  const settingsFile = join(dir, 'settings.json');
  if (Object.keys(overrides).length || !main) {
    const cleaned = validate(overrides, defaults()); // throws on a bad key or value
    writeFileSync(settingsFile, JSON.stringify({ _sparse: true, ...Object.fromEntries(Object.keys(overrides).map((k) => [k, cleaned[k]])) }, null, 2) + '\n'); // sparse: only the keys asked for, so central-config.yaml edits still reach the instance
  }
  const port = await freePort();
  const logFile = join(dir, 'server.log');
  const fd = openSync(logFile, 'a');
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir };
  delete env.TESTBED;
  if (kind === 'gym') env.TESTBED = JSON.stringify(options);
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const inst = { key, kind, name, port, pid: child.pid, dir, log: logFile, overrides, options: kind === 'gym' ? options : null, main, child, exited: false };
  child.on('exit', () => {
    inst.exited = true;
    if (instances.get(key) === inst) { instances.delete(key); console.log(`${key} exited`); }
  });
  instances.set(key, inst);
  if (!(await waitReady(inst, Date.now() + 20_000))) {
    const why = tail(logFile, 8);
    stopInstance(inst);
    throw new Error(`${key} did not start:\n${why}`);
  }
  await fetch(`http://127.0.0.1:${port}/api/new`, { method: 'POST' }); // free; the arena now has a game
  console.log(`started ${key} on :${port}`);
  return inst;
}

function stopInstance(inst) {
  instances.delete(inst.key);
  if (!inst.exited) inst.child.kill('SIGTERM');
}

const view = (i) => ({
  key: i.key, kind: i.kind, name: i.name, main: i.main, pid: i.pid, port: i.port,
  path: i.main ? `/${i.kind}/` : `/${i.kind}/${i.name}/`,
  settings_path: `${i.main ? `/${i.kind}/` : `/${i.kind}/${i.name}/`}settings`,
  log: i.log, dir: i.dir, overrides: i.overrides, options: i.options, running: !i.exited,
});

// Creates every spec'd instance or none.
function createInstances(specs) {
  return serialise(async () => {
    const groups = specs.map(checkSpec);
    const made = [];
    try {
      for (const g of groups) {
        for (let n = 1, done = 0; done < g.count; n++) {
          const name = `${g.label}${n}`;
          if (instances.has(`${g.kind}/${name}`)) continue;
          made.push(await startInstance({ kind: g.kind, name, overrides: g.overrides, options: g.options }));
          done++;
        }
      }
    } catch (err) {
      for (const i of made) stopInstance(i);
      throw err;
    }
    return made.map(view);
  });
}

// `names`: 'arena/a1', a bare unique name, a kind ('gym' = every non-main gym) or 'all'. Mains are never stopped.
function stopInstances(names) {
  return serialise(async () => {
    const all = [...instances.values()].filter((i) => !i.main);
    const picked = new Set();
    for (const n of names) {
      const hits = n === 'all' ? all : all.filter((i) => i.key === n || i.name === n || i.kind === n);
      if (!hits.length) throw new BadSpec(`no stoppable instance matches "${n}" (the main arena and gym stay up; see GET /api/instances)`);
      hits.forEach((i) => picked.add(i));
    }
    for (const i of picked) stopInstance(i);
    await sleep(200);
    return [...picked].map((i) => i.key);
  });
}

// ---- HTTP ----
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readJson(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 200_000) throw new BadSpec('Request too large'); }
  try { return JSON.parse(body || '{}'); } catch { throw new BadSpec('Body must be JSON'); }
}

function indexPage() {
  const rows = [...instances.values()].sort((a, b) => a.key.localeCompare(b.key)).map((i) => {
    const v = view(i);
    return `<li><a href="${v.path}">${v.key}</a> (<a href="${v.settings_path}">settings</a>) :${i.port}</li>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Jev Dungeon hub</title><body style="font:14px monospace;background:#0b1020;color:#ddd"><h1>Jev Dungeon</h1><ul>${rows.join('')}</ul>`;
}

function proxy(req, res, inst, path) {
  const up = request({ host: '127.0.0.1', port: inst.port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${inst.port}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (err) => json(res, 502, { error: `${inst.key} is not answering: ${err.message}` }));
  req.pipe(up);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(indexPage()); }
    if (p === '/api/instances' && req.method === 'GET') return json(res, 200, { instances: [...instances.values()].map(view) });
    if (p === '/api/instances' && req.method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.instances)) throw new BadSpec('body must be { instances: [{ kind, count, label?, settings?, options? }] }');
      return json(res, 200, { instances: await createInstances(body.instances) });
    }
    if (p === '/api/instances/down' && req.method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.names) || !body.names.length) throw new BadSpec('body must be { names: ["arena/a1", "gym", "all", ...] }');
      return json(res, 200, { stopped: await stopInstances(body.names) });
    }
    const m = p.match(/^\/(arena|gym)(\/.*)?$/);
    if (m) {
      const kind = m[1];
      let rest = m[2] ?? '/';
      let name = 'main';
      const seg = rest.split('/')[1];
      if (seg && instances.has(`${kind}/${seg}`)) {
        name = seg;
        rest = rest.slice(seg.length + 1);
        if (!rest) { res.writeHead(301, { Location: `${p}/${url.search}` }); return res.end(); } // relative URLs need the slash
      } else if (!m[2]) { res.writeHead(301, { Location: `${p}/${url.search}` }); return res.end(); }
      const inst = instances.get(`${kind}/${name}`);
      if (!inst) return json(res, 502, { error: `${kind}/${name} is not running` });
      return proxy(req, res, inst, rest + url.search);
    }
    json(res, 404, { error: 'Not found. Try /arena/, /gym/ or /api/instances.' });
  } catch (err) {
    json(res, err instanceof BadSpec ? 400 : 500, { error: err.message });
  }
});

function shutdown() {
  for (const i of instances.values()) if (!i.exited) i.child.kill('SIGTERM');
  rmSync(join(RUNS, 'hub.json'), { force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

mkdirSync(RUNS, { recursive: true });
await startInstance({ kind: 'arena', name: 'main', overrides: {}, options: {}, main: true });
await startInstance({ kind: 'gym', name: 'main', overrides: {}, options: {}, main: true });
await new Promise((ok, bad) => { server.once('error', bad); server.listen(PORT, ok); }).catch((err) => {
  console.error(`hub cannot listen on :${PORT}: ${err.message}`);
  shutdown();
});
writeFileSync(join(RUNS, 'hub.json'), JSON.stringify({ pid: process.pid, port: PORT }) + '\n');
console.log(`Jev Dungeon hub at http://localhost:${PORT}  (/arena/, /gym/, /api/instances)`);
