// PLAN-corner measurement rig: the REAL ExplorerBrain starts in/near a corner with a chasing ghost between it and the
// room (scripts/corner-arenas/corner-*.json: ASCII map + placements + seeds) and we count whether it gets out or shuffles.
//   node scripts/measure-corners.mjs [--arena open-corner,alcove,...] [--seeds 1,2,3] [--policy follow|bounce-prone]
//        [--corner-mode off|urgent|ascii|route|full] [--ticks 20] [--json] [--trace]
//   node scripts/measure-corners.mjs --live --max-calls 150 [...]     PAID: the real Jev answers the explorer (ghosts stay scripted).
// FREE mode (default): scripted Jev through scripts/lib/duel-harness.mjs playDuel({ map }), no network (throwing fetch tripwire).
// LIVE: needs an explicit --max-calls N; the run aborts cleanly at N explorer requests (hedge copies/retries not counted),
//   prints how many were used; the aborted run is reported from its partial trace and marked "cut".
// Metrics per (arena, placement, seed): escaped10 (within 10 ticks: the explorer is outside nearSide on a cell with >= 3 orthogonal floor
//   neighbours AND >= 3 steps (Manhattan) from every ghost, or has dispelled the ghost), ticks to escape, ABA (positions p[t]==p[t-2]
//   != p[t-1], p[0] = start), hits taken, loops (moves back onto a cell of the last 6 positions: also catches 4-cycles), Jev calls. Deviation from the brief: "outside the pocket" is judged against `nearSide` (floor
//   cells the explorer reaches strictly before the ghost's start cell), because the brief's pocket (reachable without coming within
//   1 step of the ghost, helper `pocket()`, size reported) is nearly the whole room in an open room. Dispelling the ghost also counts.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const realFetch = globalThis.fetch; // the harness installs a throwing tripwire when imported
const { playDuel, man } = await import('./lib/duel-harness.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the cornerMode knob (agent C adds it to src/config) ---------------------------------------------------------------
export const CORNER_MODES = ['off', 'urgent', 'ascii', 'route', 'full'];
export async function applyCornerMode(mode) {
  if (!CORNER_MODES.includes(mode)) throw new Error(`--corner-mode must be one of ${CORNER_MODES.join('|')}`);
  const { defaults } = await import('../src/config/runtime.js');
  if (!('cornerMode' in defaults())) {
    if (mode !== 'off') console.error(`warning: config knob cornerMode does not exist yet: --corner-mode ${mode} is a NO-OP`);
    return false;
  }
  // Same hook runtime.js push() uses: the explorer modules read o.cornerMode in their configure* functions.
  const o = { cornerMode: mode };
  (await import('../src/characters/explorer/brain.js')).configureExplorerBrain(o);
  (await import('../src/characters/explorer/perception.js')).configureExplorerPerception(o);
  (await import('../src/characters/explorer/encounter.js')).configureExplorerEncounter(o);
  return true;
}

// ---- geometry --------------------------------------------------------------------------------------------------------
const key = (c) => c.join(',');
const floorAt = (rows, x, y) => rows[y]?.[x] === '.';
const orthFloor = (rows, [x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => floorAt(rows, x + dx, y + dy)).length;

export function pocket(rows, start, ghost, r = 1) {
  const seen = new Set([key(start)]);
  const q = [start];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = [x + dx, y + dy];
      if (!floorAt(rows, c[0], c[1]) || seen.has(key(c)) || man(c, ghost) <= r) continue;
      seen.add(key(c)); q.push(c);
    }
  }
  return seen;
}
// The explorer's side of the field: floor cells it reaches strictly before the ghost's start (walking distance). In an open room the
// spec's pocket above is nearly the whole room, so "escaped" is judged against THIS region: out of it = slipped past / got clear.
export function nearSide(rows, start, ghost) {
  const dist = (from) => {
    const d = new Map([[key(from), 0]]);
    const q = [from];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = [x + dx, y + dy];
        if (floorAt(rows, c[0], c[1]) && !d.has(key(c))) { d.set(key(c), d.get(key(q[i])) + 1); q.push(c); }
      }
    }
    return d;
  };
  const de = dist(start);
  const dg = dist(ghost);
  return new Set([...de].filter(([k, v]) => v < (dg.get(k) ?? Infinity)).map(([k]) => k));
}
const isEscapedAt = (rows, pos, ghosts, near) => !near.has(key(pos)) && orthFloor(rows, pos) >= 3 && ghosts.every((g) => man(g, pos) >= 3);

export function abaCount(path) {
  let n = 0;
  for (let t = 2; t < path.length; t++) if (key(path[t]) === key(path[t - 2]) && key(path[t]) !== key(path[t - 1])) n++;
  return n;
}

// Moves that land on a cell visited within the last 6 positions (catches the 4-cycles ABA misses, e.g. round a 2x2 nook).
export function loopCount(path, window = 6) {
  let n = 0;
  for (let t = 1; t < path.length; t++) if (key(path[t]) !== key(path[t - 1]) && path.slice(Math.max(0, t - window), t - 1).some((c) => key(c) === key(path[t]))) n++;
  return n;
}

// ---- arenas ----------------------------------------------------------------------------------------------------------
export function loadArenas(dir = join(HERE, 'corner-arenas')) {
  return readdirSync(dir).filter((f) => /^corner-.*\.json$/.test(f)).sort().map((f) => ({ name: f.slice(7, -5), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
const stamp = (map, e, g) => map.map((row, y) => row.split('').map((ch, x) => (x === e[0] && y === e[1] ? '@' : x === g[0] && y === g[1] ? 'A' : ch)).join(''));

class CapReached extends Error {}

// One (arena, placement, seed). Returns the metrics row.
export const EXTRA = {};
export async function runOne(arena, pl, seed, { policy = 'follow', ticks = 20, escapeWithin = 10, live = null } = {}) {
  const map = stamp(arena.map, pl.explorer, pl.ghost);
  const pos = [pl.explorer];
  const gpos = [[pl.ghost]];
  const near = nearSide(arena.map, pl.explorer, pl.ghost);
  let escapedAt = null;
  let dispelledAt = null;
  let calls = 0;
  let cut = false;
  const opts = {
    map, ghosts: [{ cell: pl.ghost }], seed, policy, maxTicks: ticks, health: 9, hold: true, ...EXTRA,
    onAsk: () => { if (live) { if (calls >= live.maxCalls) throw new CapReached(); } calls++; },
    onTurn: (turn, game) => {
      const t = pos.length;
      pos.push([...game.pos]);
      gpos.push(game.adversaries.map((a) => [...a.pos]));
      if (dispelledAt === null && turn.events.some((e) => e.type === 'dispelled')) dispelledAt = t;
      if (escapedAt === null && isEscapedAt(arena.map, game.pos, game.adversaries.map((a) => a.pos), near)) escapedAt = t;
    },
    ...(live ? { ask: live.ask } : {}),
  };
  let r = null;
  try { r = await playDuel(opts); } catch (e) { if (!(e instanceof CapReached)) throw e; cut = true; }
  const escT = dispelledAt !== null && (escapedAt === null || dispelledAt < escapedAt) ? dispelledAt : escapedAt;
  return {
    arena: arena.name, explorer: pl.explorer, ghost: pl.ghost, seed, policy,
    nearSide: near.size, pocket: pocket(arena.map, pl.explorer, pl.ghost).size,
    escaped10: escT !== null && escT <= escapeWithin, escTicks: escT, dispelled: dispelledAt !== null, aba: abaCount(pos), loops: loopCount(pos),
    hits: r?.hitsTaken ?? null, strikes: r?.strikes ?? null, calls, cut, ticks: pos.length - 1, path: pos.map(key).join(' '),
  };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function aggregate(rows) {
  const by = new Map();
  for (const r of rows) (by.get(r.arena) ?? by.set(r.arena, []).get(r.arena)).push(r);
  return [...by].map(([arena, rs]) => ({
    arena, runs: rs.length, escaped10: rs.filter((r) => r.escaped10).length, dispelled: rs.filter((r) => r.dispelled).length,
    avgEscTicks: avg(rs.filter((r) => r.escTicks !== null).map((r) => r.escTicks)), aba: rs.reduce((a, r) => a + r.aba, 0), loops: rs.reduce((a, r) => a + r.loops, 0),
    maxAba: Math.max(...rs.map((r) => r.aba)), hits: rs.reduce((a, r) => a + (r.hits ?? 0), 0), calls: rs.reduce((a, r) => a + r.calls, 0),
  }));
}

// ---- CLI -------------------------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
  if (val("--skills", null) === "none") EXTRA.skills = [];
  if (val("--ghost-hp", null)) EXTRA.ghostHp = Number(val("--ghost-hp"));
  if (val("--health", null)) EXTRA.health = Number(val("--health"));
  const live = flag('--live');
  const maxCalls = val('--max-calls');
  if (live && (maxCalls === undefined || !(Number(maxCalls) > 0))) { console.error('--live is paid: pass an explicit --max-calls N (> 0), e.g. --max-calls 150'); process.exit(2); }
  const mode = val('--corner-mode', 'off');
  const policy = val('--policy', 'follow');
  const seedsArg = val('--seeds');
  const want = val('--arena')?.split(',');
  const ticks = Number(val('--ticks', 20));
  const applied = await applyCornerMode(mode);

  let liveCfg = null;
  if (live) {
    process.loadEnvFile(new URL('../../.env', import.meta.url));
    if (!process.env.JEV_API_KEY) { console.error('JEV_API_KEY missing from ../.env'); process.exit(2); }
    globalThis.fetch = realFetch; // lift the harness tripwire
    const { Gateway } = await import('../src/gateway/gateway.js');
    liveCfg = { maxCalls: Number(maxCalls), ask: new Gateway().devAsker() };
  }

  const arenas = loadArenas().filter((a) => !want || want.includes(a.name));
  const rows = [];
  let used = 0;
  outer: for (const a of arenas) {
    for (const pl of a.placements) {
      for (const seed of seedsArg ? seedsArg.split(',').map(Number) : a.seeds ?? [1]) {
        if (liveCfg) liveCfg.maxCalls = Number(maxCalls) - used;
        const row = await runOne(a, pl, seed, { policy, ticks, live: liveCfg });
        rows.push(row);
        used += row.calls;
        if (flag('--trace')) console.error(`${a.name} E${pl.explorer} G${pl.ghost} s${seed}: ${row.path}`);
        if (row.cut) { console.error(`call cap ${maxCalls} reached: aborting after ${rows.length} runs (last one cut)`); break outer; }
      }
    }
  }
  const agg = aggregate(rows);
  if (flag('--json')) {
    console.log(JSON.stringify({ mode: live ? 'live' : 'free', policy, cornerMode: mode, cornerModeApplied: applied, jevCalls: used, aggregate: agg, runs: rows }, null, 1));
    return;
  }
  console.log(`mode ${live ? 'LIVE' : 'free'}, policy ${policy}, cornerMode ${mode}${applied ? '' : ' (knob absent: no-op)'}, ${ticks} ticks, ${rows.length} runs`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('arena', 13)}${pad('runs', 5)}${pad('esc10', 6)}${pad('dispel', 7)}${pad('escTicks', 9)}${pad('ABA(sum/max)', 13)}${pad('loops', 6)}${pad('hits', 5)}calls`);
  for (const g of agg) console.log(`${pad(g.arena, 13)}${pad(g.runs, 5)}${pad(`${g.escaped10}/${g.runs}`, 6)}${pad(g.dispelled, 7)}${pad(g.avgEscTicks === null ? '-' : g.avgEscTicks.toFixed(1), 9)}${pad(`${g.aba}/${g.maxAba}`, 13)}${pad(g.loops, 6)}${pad(g.hits, 5)}${g.calls}`);
  if (live) console.log(`Jev calls used: ${used} of ${maxCalls}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
