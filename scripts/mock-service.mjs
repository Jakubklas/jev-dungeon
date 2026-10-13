// DEV TOOL ONLY: a zero-dependency mock of the hosted /v1 API (PLAN-multiplayer-impl.md "/v1 API contract") and the
// pages, so public/play.html and public/host.html can be built and screenshotted before the real service (WP-G) exists.
// It keeps everything in memory, plays real dungeons through src/turn.js with STUB answers (no Jev, no network: a fetch
// tripwire is installed), projects each GameView through the fog like the contract says (unknown cells are null) and
// fakes the co-op teammates by trailing the primary explorer. It is not the service: no auth, no persistence.
//
//   node scripts/mock-service.mjs [--port 3100]
//   http://localhost:3100/             entry page
//   http://localhost:3100/g/demo-lobby       lobby with 3 players (you are the leader)
//   http://localhost:3100/g/demo-join        a waiting room you are not in (join form)
//   http://localhost:3100/g/demo-run         running co-op game, 3 explorers
//   http://localhost:3100/g/demo-key         your key was rejected (awaiting_key, countdown)
//   http://localhost:3100/g/demo-forfeit     your key never came (forfeited, spectator)
//   http://localhost:3100/g/demo-spec        you died: spectator banner
//   http://localhost:3100/g/demo-end         finished game with the ranking table
//   http://localhost:3100/host#token=mock    host page (any token works)
// Visiting a demo room sets the member cookie for you. Real flows (create / join / start) work too; add fake players
// to a waiting room with POST /mock/<id>/bot.
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

process.env.JEV_CONFIG ??= 'none';
process.env.JEV_API_KEY ??= 'dummy-never-used';
const { installTripwire } = await import('./lib/tripwire.mjs');
installTripwire({ message: 'mock-service: no network call is allowed' });
const { newGame } = await import('../src/turn.js');
const { SCHEMA, defaults } = await import('../src/config/load.js');
const { rankParticipants, teamScore } = await import('../src/scoring.js');

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT ?? 3100);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const START_AT = Date.now();
const rid = (n = 4) => randomBytes(n).toString('hex');

// ---------------- static pages ----------------
const STATIC = {
  '/': 'play.html', '/play.js': 'play.js', '/play.css': 'play.css', '/host': 'host.html', '/host.js': 'host.js',
  '/render.js': 'render.js', '/sprites.js': 'sprites.js', '/thoughts.js': 'thoughts.js', '/style.css': 'style.css',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
async function serveStatic(res, path) {
  const file = STATIC[path] ?? (path.startsWith('/props/') && /^\/props\/[\w.-]+\.js$/.test(path) ? path.slice(1) : path.startsWith('/g/') ? 'play.html' : null);
  if (!file) return false;
  try {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'text/plain', 'Cache-Control': 'no-store' });
    res.end(await readFile(PUBLIC + file));
  } catch { res.writeHead(404); res.end('not found'); }
  return true;
}

// ---------------- games ----------------
const games = new Map();
const NAMES = ['Mira', 'Oskar', 'Tilda', 'Brann'];
const dirUrl = async (tag) => pathToFileURL((await mkdtemp(join(tmpdir(), `mock-${tag}-`))) + '/');
const stub = async ({ questions }) => {
  const first = (q) => Object.keys(q.criteria ?? {})[0];
  return Object.fromEntries(Object.entries(questions).map(([k, q]) =>
    [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));
};

function newParticipant(name, slot, extra = {}) {
  return { participant_id: 'p' + rid(3), name, slot, state: 'ready', key_present: true, joined_at: Date.now(), fake: false, stats: { strikes: 0, dispels: 0, portal: false }, ...extra };
}

function makeGame({ id = 'g' + rid(3), mode = 'shared', seed = 7 } = {}) {
  const g = { id, mode, status: 'waiting', pause_reason: null, capacity: 4, participants: [], created_at: Date.now(), rules_revision: 1, seed,
    run: null, seq: 0, log: [], clients: new Set(), busy: false, timer: null, directive: null, lastDirectiveAt: 0, turns: 0, result: null, calls: [] };
  games.set(g.id, g);
  return g;
}
const leaderOf = (g) => g.participants.filter((p) => p.state !== 'left')[0] ?? null;
const roster = (g) => g.participants.filter((p) => p.state !== 'left');

function summary(g, viewer) {
  const lead = leaderOf(g);
  return {
    id: g.id, mode: g.mode, status: g.status, pause_reason: g.pause_reason, capacity: g.capacity, leader: lead?.participant_id ?? null,
    rules_revision: g.rules_revision, created_at: g.created_at,
    participants: roster(g).map((p) => ({
      ...(p === viewer ? { participant_id: p.participant_id } : {}), name: p.name, slot: p.slot, state: p.state, key_present: p.key_present,
      is_leader: p === lead, is_self: p === viewer,
      ...(p.state === 'awaiting_key' && p.deadline ? { key_deadline_ms_left: Math.max(0, p.deadline - Date.now()) } : {}),
    })),
  };
}

// The fog projection: unknown cells are null, props / decor / the portal only where lit, no seed.
function project(g, viewer, { reveal = false } = {}) {
  const run = g.run, v = run.view();
  const lit = (x, y) => (v.light[y]?.[x] ?? 0) > 0;
  const tiles = reveal ? v.tiles.map((r) => [...r]) : v.tiles.map((row, y) => [...row].map((c, x) => (lit(x, y) ? c : null)));
  const me = viewer ?? g.participants[0];
  const mates = roster(g).filter((p) => p !== me && p.state !== 'ready');
  const trail = v.trail ?? [];
  // Teammates trail the primary explorer by a few cells; the viewer is the real explorer.
  const explorers = [];
  const meDead = me && (me.state === 'dead' || me.state === 'forfeited');
  const all = roster(g).filter((p) => p.state !== 'ready');
  all.forEach((p, i) => {
    const self = p === me;
    const lag = self ? 0 : 3 + i * 4;
    const pos = lag ? (trail[Math.max(0, trail.length - 1 - lag)] ?? v.pos) : v.pos;
    const prev = lag ? trail[Math.max(0, trail.length - 2 - lag)] : null;
    const facing = self ? v.facing : prev && pos[0] !== prev[0] ? (pos[0] > prev[0] ? 'right' : 'left') : 'down';
    const status = p.state === 'awaiting_key' ? 'awaiting_key' : p.state === 'dead' ? 'dead' : p.state === 'forfeited' ? 'forfeited' : 'active';
    explorers.push({ id: p.participant_id, participant_id: p.participant_id, name: p.name, slot: p.slot, pos: [...pos], facing, status, self,
      health: status === 'dead' ? 0 : self ? v.health : Math.max(1, v.max_health - (i % 2)), max_health: v.max_health, invulnerable: self && v.invulnerable,
      coins: self ? v.coins : 2 + i * 3 });
  });
  const advs = reveal ? v.adversaries : v.adversaries.filter((a) => a.visible).map((a) => ({ ...a }));
  if (!reveal) {
    // One monster only a teammate sees: any lit-cell monster within 9 cells of a teammate that the viewer does not.
    for (const a of v.adversaries) {
      if (a.visible || !lit(a.pos[0], a.pos[1])) continue;
      if (explorers.some((e) => !e.self && e.status === 'active' && Math.hypot(e.pos[0] - a.pos[0], e.pos[1] - a.pos[1]) <= 9)) advs.push({ ...a, team_visible: true });
    }
  }
  for (const a of advs) { delete a.brain; delete a.morale; delete a.character; if (!reveal) a.team_visible ??= false; }
  const out = {
    ...v, seed: 0, tiles,
    treasure: reveal || (v.treasure && lit(v.treasure[0], v.treasure[1])) ? v.treasure : null,
    props: reveal ? v.props : v.props.filter((p) => lit(p.x, p.y)),
    decor: reveal ? v.decor : v.decor.filter((d) => lit(d.x, d.y)),
    coin_piles: reveal ? v.coin_piles : v.coin_piles.filter(([x, y]) => lit(x, y)),
    adversaries: advs, route: null, visits: undefined, self: me?.participant_id ?? null,
    explorers, memory: meDead ? null : run.memory, directive: g.directive, lobby: summary(g, me),
  };
  if (me && !meDead && me.state === 'awaiting_key') out.memory = run.memory;
  if (meDead) { out.spectator = true; }
  if (g.status === 'finished') { out.over = true; out.ranking = rankingOf(g); out.result = g.result; out.team_score = teamScore(out.ranking); }
  return out;
}

function rankingOf(g) {
  const rows = roster(g).filter((p) => p.state !== 'ready').map((p, i) => ({
    participant_id: p.participant_id, name: p.name, slot: p.slot, joined_at: p.joined_at,
    coins: p.final?.coins ?? Math.max(0, (g.run?.game.coins ?? 0) + (p.fake ? 3 * i : 0)), strikes: p.stats.strikes + 2 * i, dispels: p.stats.dispels + (i === 1 ? 2 : 0),
    portal: g.result === 'won' && i === 0, alive: p.state === 'active' || (g.result === 'won' && p.state !== 'dead' && p.state !== 'forfeited'),
    forfeited: p.state === 'forfeited', died_at: p.state === 'dead' ? 40 + i : null,
  }));
  return rankParticipants(rows);
}

async function startGame(g) {
  const run = newGame(g.seed, { ask: stub, decide: stub, memoryDir: await dirUrl('mem'), dir: await dirUrl('adv') });
  g.run = run; g.status = 'running';
  for (const p of roster(g)) if (p.state === 'ready') p.state = 'active';
  push(g, 'lobby', null, summary(g, null));
  g.timer = setInterval(() => tick(g), 1000);
}

async function tick(g) {
  if (g.busy || g.status !== 'running') return;
  g.busy = true;
  try {
    const t = await g.run.playTurn();
    g.turns++;
    const events = [...(t.events ?? [])];
    if (g.mode === 'shared' && g.turns % 23 === 0) events.push({ id: roster(g)[1]?.participant_id ?? 'p', type: 'help_called', who: roster(g)[1]?.name ?? 'Mira' });
    for (const e of events) {
      const ev = { seq: ++g.seq, type: e.type, ...e };
      if (e.id === 'explorer') ev.id = leaderOf(g)?.participant_id;
      g.log.push(ev); g.log = g.log.slice(-200);
      push(g, 'event', ev.seq, ev);
    }
    g.calls.push({ at: Date.now(), kind: 'tick', ok: true, ms: 120 + Math.round(Math.random() * 200), participant: leaderOf(g)?.name, tick: g.turns });
    g.calls = g.calls.slice(-200);
    if (g.run.game.won || g.run.game.lost || g.turns > 400) finish(g, g.run.game.won ? 'won' : 'lost');
    else broadcastViews(g);
  } catch (err) {
    console.warn('mock tick failed:', err.message);
  } finally { g.busy = false; }
}

function finish(g, result) {
  g.status = 'finished'; g.result = result; clearInterval(g.timer);
  broadcastViews(g);
  const ranking = rankingOf(g);
  push(g, 'end', null, { result, ranking, team_score: teamScore(ranking) });
}

// ---------------- SSE ----------------
function push(g, event, id, data, only = null) {
  for (const c of g.clients) {
    if (only && c.viewer !== only) continue;
    c.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
function broadcastViews(g) {
  for (const c of g.clients) {
    if (!g.run) { c.res.write(`event: lobby\ndata: ${JSON.stringify(summary(g, c.viewer))}\n\n`); continue; }
    c.res.write(`event: view\ndata: ${JSON.stringify(project(g, c.viewer))}\n\n`);
  }
}
setInterval(() => { for (const g of games.values()) for (const c of g.clients) c.res.write(': heartbeat\n\n'); }, 15000).unref();

// ---------------- demo rooms ----------------
async function demo(id, build) {
  const g = makeGame({ id, mode: 'shared', seed: 11 });
  const me = newParticipant('You', 0, { participant_id: 'me-' + id });
  g.participants.push(me, newParticipant(NAMES[0], 1, { fake: true }), newParticipant(NAMES[1], 2, { fake: true }));
  g.demoMe = me;
  await build(g, me);
  return g;
}
async function advance(g, n) { clearInterval(g.timer); for (let i = 0; i < n && g.run && !g.run.game.won && !g.run.game.lost; i++) { await g.run.playTurn(); g.turns++; } g.timer = setInterval(() => tick(g), 1000); }

await demo('demo-lobby', async (g) => { g.participants.push(newParticipant(NAMES[2], 3, { fake: true })); g.participants.pop(); });
await demo('demo-join', async (g) => { g.demoMe = null; g.participants[0].name = 'Ada'; g.participants[0].fake = true; g.participants[0].participant_id = 'ada'; });
await demo('demo-run', async (g) => { await startGame(g); await advance(g, 28); });
await demo('demo-key', async (g, me) => { await startGame(g); await advance(g, 20); me.state = 'awaiting_key'; me.key_present = false; me.deadline = Date.now() + 95000; });
await demo('demo-forfeit', async (g, me) => { await startGame(g); await advance(g, 14); me.state = 'forfeited'; me.key_present = false; });
await demo('demo-spec', async (g, me) => { await startGame(g); await advance(g, 22); me.state = 'dead'; });
await demo('demo-end', async (g) => { await startGame(g); await advance(g, 30); finish(g, 'won'); });

// ---------------- HTTP ----------------
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
const err = (res, status, error, message, extra = {}) => send(res, status, { error, message, ...extra });
async function body(req) { let s = ''; for await (const c of req) s += c; try { return s ? JSON.parse(s) : {}; } catch { return null; } }
const viewerOf = (g, req) => {
  const c = cookies(req)['jd_par_' + g.id];
  return roster(g).find((p) => p.participant_id === c) ?? null;
};
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cookie = (g, p) => `jd_par_${g.id}=${p.participant_id}; Path=/; HttpOnly; SameSite=Strict`;
let hostOk = false;
const isHost = (req) => cookies(req).jd_host === 'mock';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, games: games.size, uptime_s: Math.round((Date.now() - START_AT) / 1000) });
    if (req.method === 'GET' && !path.startsWith('/v1/') && await (async () => {
      // A demo room link sets the member cookie so the page opens as that participant.
      const m = path.match(/^\/g\/([\w-]+)$/);
      const g = m && games.get(m[1]);
      if (g?.demoMe && !viewerOf(g, req)) res.setHeader('Set-Cookie', cookie(g, g.demoMe));
      if (g?.demoMe && url.searchParams.has('reset')) res.setHeader('Set-Cookie', cookie(g, g.demoMe));
      return serveStatic(res, path);
    })()) return;

    // ---- host ----
    if (path === '/v1/host/session' && req.method === 'POST') {
      const b = await body(req);
      if (!b?.token) return err(res, 400, 'bad_request', 'token required');
      hostOk = true;
      return send(res, 200, {}, { 'Set-Cookie': 'jd_host=mock; Path=/; HttpOnly; SameSite=Strict' });
    }
    if (path.startsWith('/v1/host/')) {
      if (!isHost(req)) return err(res, 403, 'forbidden', 'host session required');
      if (path === '/v1/host/settings' && req.method === 'GET') return send(res, 200, { revision: hostSettings.revision, values: hostSettings.values, schema: SCHEMA });
      if (path === '/v1/host/settings' && req.method === 'PUT') {
        const b = await body(req);
        const fields = {};
        for (const [k, v] of Object.entries(b?.values ?? {})) {
          const s = SCHEMA.find((x) => x.key === k);
          if (!s) fields[k] = 'unknown setting';
          else if (s.type === 'range' && (!Number.isFinite(v) || v < s.min || v > s.max)) fields[k] = `must be ${s.min}..${s.max}`;
        }
        if (Object.keys(fields).length) return err(res, 400, 'invalid', 'invalid settings', { fields });
        const changed = Object.keys(b.values).filter((k) => b.values[k] !== hostSettings.values[k]);
        if (changed.length) { Object.assign(hostSettings.values, b.values); hostSettings.revision++; }
        return send(res, 200, { revision: hostSettings.revision, values: hostSettings.values, changed });
      }
      if (path === '/v1/host/games' && req.method === 'GET') {
        return send(res, 200, { games: [...games.values()].map((g) => ({ ...summary(g, null),
          calls: { posts: 40 + g.turns * 2, failures: g.id === 'demo-key' ? 3 : 0, timeouts: 0, p50_ms: 240 }, counters: { turns: g.turns, sse_clients: g.clients.size } })) });
      }
      let m = path.match(/^\/v1\/host\/games\/([\w-]+)\/(pause|resume|end|reveal)$/);
      if (m && req.method === 'POST') {
        const g = games.get(m[1]);
        if (!g) return err(res, 404, 'not_found', 'no such game');
        if (m[2] === 'reveal') return g.run ? send(res, 200, { view: project(g, null, { reveal: true }) }) : err(res, 409, 'not_running', 'game has not started');
        if (m[2] === 'pause') { g.status = 'paused'; g.pause_reason = 'host'; }
        if (m[2] === 'resume' && g.status === 'paused') { g.status = 'running'; g.pause_reason = null; }
        if (m[2] === 'end') { if (g.run) finish(g, 'lost'); else g.status = 'abandoned'; }
        return send(res, 200, { game: summary(g, null) });
      }
      m = path.match(/^\/v1\/host\/games\/([\w-]+)\/calls$/);
      if (m && req.method === 'GET') {
        const g = games.get(m[1]);
        return g ? send(res, 200, { calls: g.calls.slice(-Number(url.searchParams.get('limit') ?? 200)).reverse() }) : err(res, 404, 'not_found', 'no such game');
      }
      if (path === '/v1/host/metrics' && req.method === 'GET') {
        const j = () => Math.round(Math.random() * 40);
        return send(res, 200, { posts: 1200 + games.size * 40, failures: 6, timeouts: 1, latency_p50_ms: 240 + j(), latency_p95_ms: 910 + j() * 3,
          actor_queue_delay_ms: 3 + j() / 10, event_write_delay_ms: 2 + j() / 10, sse_lag_ms: 8 + j() / 4, sse_clients: [...games.values()].reduce((n, g) => n + g.clients.size, 0) });
      }
      return err(res, 404, 'not_found', 'no such host route');
    }

    // ---- players ----
    if (path === '/v1/games' && req.method === 'POST') {
      const b = await body(req);
      const name = cleanName(b?.name);
      if (!name) return err(res, 400, 'bad_name', 'Name must be 1-20 characters.');
      if (!b.key || typeof b.key !== 'string') return err(res, 400, 'bad_key', 'A Jev key is required.');
      if (!['private', 'shared'].includes(b.mode)) return err(res, 400, 'bad_mode', 'mode must be private or shared');
      const g = makeGame({ mode: b.mode, seed: 1 + Math.floor(Math.random() * 900) });
      g.capacity = b.mode === 'private' ? 1 : 4;
      const p = newParticipant(name, 0); g.participants.push(p);
      if (b.mode === 'private') await startGame(g);
      return send(res, 201, { game: summary(g, p), participant_id: p.participant_id }, { 'Set-Cookie': cookie(g, p) });
    }
    let m = path.match(/^\/v1\/games\/([\w-]+)(?:\/(\w+))?$/);
    if (m) {
      const g = games.get(m[1]), act = m[2] ?? '';
      if (!g) return err(res, 404, 'not_found', 'No such room. It may have expired.');
      const me = viewerOf(g, req);
      if (req.method === 'GET' && act === '') {
        if (me) return send(res, 200, g.run ? project(g, me) : { lobby: summary(g, me), self: me.participant_id, status: g.status, mode: g.mode });
        if (g.status === 'waiting') return send(res, 200, { game: summary(g, null) });
        return err(res, 403, 'forbidden', 'You are not in this game.');
      }
      if (req.method === 'GET' && act === 'events') {
        if (!me) return err(res, 403, 'forbidden', 'You are not in this game.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const c = { res, viewer: me };
        g.clients.add(c);
        req.on('close', () => g.clients.delete(c));
        const last = Number(req.headers['last-event-id'] ?? 0);
        for (const ev of g.log) if (ev.seq > last) res.write(`id: ${ev.seq}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`);
        res.write(g.run ? `event: view\ndata: ${JSON.stringify(project(g, me))}\n\n` : `event: lobby\ndata: ${JSON.stringify(summary(g, me))}\n\n`);
        if (g.status === 'finished') { const ranking = rankingOf(g); res.write(`event: end\ndata: ${JSON.stringify({ result: g.result, ranking, team_score: teamScore(ranking) })}\n\n`); }
        return;
      }
      if (req.method !== 'POST') return err(res, 405, 'method', 'method not allowed');
      const b = await body(req);
      if (b === null) return err(res, 400, 'bad_json', 'Body must be JSON.');
      if (act === 'join') {
        if (g.status !== 'waiting') return err(res, 409, 'game_started', 'That game has already started.');
        if (roster(g).length >= g.capacity) return err(res, 409, 'room_full', 'The room is full.');
        const name = cleanName(b.name);
        if (!name) return err(res, 400, 'bad_name', 'Name must be 1-20 characters.');
        if (!b.key) return err(res, 400, 'bad_key', 'A Jev key is required.');
        const used = new Set(roster(g).map((p) => p.slot));
        const p = newParticipant(name, [0, 1, 2, 3].find((s) => !used.has(s))); g.participants.push(p);
        push(g, 'lobby', null, summary(g, null));
        for (const c of g.clients) c.res.write(`event: lobby\ndata: ${JSON.stringify(summary(g, c.viewer))}\n\n`);
        return send(res, 200, { game: summary(g, p), participant_id: p.participant_id }, { 'Set-Cookie': cookie(g, p) });
      }
      if (!me) return err(res, 403, 'forbidden', 'You are not in this game.');
      if (act === 'leave') { me.state = g.status === 'waiting' ? 'left' : 'forfeited'; broadcastViews(g); return send(res, 200, { game: summary(g, me) }); }
      if (act === 'key') {
        if (!b.key) return err(res, 400, 'bad_key', 'A Jev key is required.');
        if (b.key === 'bad') return err(res, 400, 'key_rejected', 'That key was rejected by Jev.');
        if (me.state === 'forfeited') return err(res, 409, 'forfeited', 'You were removed from the game.');
        me.key_present = true; if (me.state === 'awaiting_key') { me.state = 'active'; me.deadline = null; }
        broadcastViews(g);
        return send(res, 200, { participant: { state: me.state, key_present: true } });
      }
      if (act === 'start') {
        if (leaderOf(g) !== me) return err(res, 403, 'not_leader', 'Only the room leader can start.');
        if (g.status !== 'waiting') return err(res, 409, 'game_started', 'Already started.');
        await startGame(g);
        return send(res, 200, { game: summary(g, me) });
      }
      if (act === 'directives') {
        const text = String(b.text ?? '').trim().slice(0, 140);
        const wait = g.lastDirectiveAt + 10000 - Date.now();
        if (text && wait > 0) return err(res, 429, 'cooldown', 'Wait a moment before whispering again.', { retry_in_ms: wait });
        if (!text) { g.directive = null; return send(res, 200, { directive: null, queued: false }); }
        g.lastDirectiveAt = Date.now();
        const steps = g.run?.game.steps ?? 0;
        g.directive = { text, from_step: steps, until_step: steps + 20, steps_left: 20 };
        return send(res, 200, { directive: g.directive, queued: true });
      }
      if (act === 'pause' || act === 'resume') {
        if (g.mode !== 'private') return err(res, 403, 'forbidden', 'Only the host can pause a shared game.');
        g.status = act === 'pause' ? 'paused' : 'running'; g.pause_reason = act === 'pause' ? 'player' : null;
        broadcastViews(g);
        return send(res, 200, { game: summary(g, me) });
      }
    }
    m = path.match(/^\/mock\/([\w-]+)\/bot$/);
    if (m && req.method === 'POST') {
      const g = games.get(m[1]);
      if (!g || g.status !== 'waiting' || roster(g).length >= g.capacity) return err(res, 409, 'room_full', 'cannot add');
      const used = new Set(roster(g).map((p) => p.slot));
      g.participants.push(newParticipant(NAMES[roster(g).length % NAMES.length], [0, 1, 2, 3].find((s) => !used.has(s)), { fake: true }));
      for (const c of g.clients) c.res.write(`event: lobby\ndata: ${JSON.stringify(summary(g, c.viewer))}\n\n`);
      return send(res, 200, { ok: true });
    }
    err(res, 404, 'not_found', 'no such route');
  } catch (e) {
    console.warn('mock error:', e.message);
    if (!res.headersSent) err(res, 500, 'internal', e.message);
  }
});

const hostSettings = { revision: 3, values: defaults() };
server.listen(PORT, '127.0.0.1', () => console.log(`mock /v1 service on http://localhost:${PORT}/ (dev only, no Jev; host: /host#token=mock)`));
