// Hosted HTTP service: cookies and lobbies in the parent, one game worker per settings revision.
// Workers own mutable worlds and paid calls; this process owns the store lock and publishes only fog-projected views.
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from './ids.js';
import { HostAuth, checkOrigin, clearCookie, isLoopback, participantCookieName, participantCookies, participantToken, sanitiseName } from './auth.js';
import { FileStore, CallsRecorder } from './store.js';
import { SettingsService } from './settings-service.js';
import { Lobby } from './lobby.js';
import { Router, HttpError, openSse, readJson, send } from './http.js';
import { RateLimiter } from './ratelimit.js';
import { createLogger } from './log.js';
import { gameSummary } from './project.js';
import { rankParticipants, teamScore } from '../scoring.js';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
const STATIC = new Map([
  ['/', 'play.html'], ['/play.js', 'play.js'], ['/play.css', 'play.css'], ['/host', 'host.html'],
  ['/host.js', 'host.js'], ['/render.js', 'render.js'], ['/sprites.js', 'sprites.js'],
  ['/thoughts.js', 'thoughts.js'], ['/style.css', 'style.css'],
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const asError = (status, error, extra = {}) => ({ status, error, extra });

class WorkerClient {
  #child;
  #next = 0;
  #pending = new Map();
  constructor({ revision, rules, root, onEvent, onExit }) {
    this.revision = revision;
    this.#child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env } });
    this.#child.on('message', (m) => {
      if (m.event) { onEvent(m.event); return; }
      const p = this.#pending.get(m.requestId);
      if (!p) return;
      this.#pending.delete(m.requestId);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.value);
    });
    this.#child.on('exit', (code) => {
      for (const p of this.#pending.values()) p.reject(new Error(`worker exited (${code})`));
      this.#pending.clear();
      onExit?.(revision);
    });
    this.ready = this.call('init', { root, revision, rules, serverKey: process.env.JEV_API_KEY ?? null });
  }
  call(op, payload) {
    const requestId = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#child.send({ requestId, op, payload }, (err) => {
        if (err && this.#pending.delete(requestId)) reject(err);
      });
    });
  }
  stop() { this.#child.kill(); }
}

export class HostedService {
  #store;
  #settings;
  #hostAuth;
  #logger;
  #limiter;
  #router = new Router();
  #server;
  #games = new Map();
  #workers = new Map();
  #subscribers = new Map();
  #keyTimers = new Map();
  #startAt = Date.now();
  #port;
  #host;

  constructor({ root, port = 3100, host = '127.0.0.1', hostToken = process.env.HOST_TOKEN,
    logger = createLogger(), settingsPath } = {}) {
    this.#store = new FileStore(root);
    this.#store.lock();
    this.#settings = new SettingsService(this.#store, settingsPath === undefined ? {} : { path: settingsPath });
    this.hostToken = this.#store.hostToken({ pinned: hostToken });
    this.#hostAuth = new HostAuth({ token: this.hostToken });
    this.#logger = logger;
    this.#limiter = new RateLimiter();
    this.#port = port;
    this.#host = host;
    this.#routes();
    this.#server = createServer((req, res) => this.#handle(req, res));
  }

  get settings() { return this.#settings; }
  get store() { return this.#store; }
  get server() { return this.#server; }
  get games() { return this.#games.size; }

  async listen() {
    await this.#restore();
    await new Promise((resolve) => this.#server.listen(this.#port, this.#host, resolve));
    return this.#server.address();
  }

  async close() {
    for (const timer of this.#keyTimers.values()) clearTimeout(timer);
    for (const clients of this.#subscribers.values()) for (const c of clients) c.close('shutdown');
    for (const worker of this.#workers.values()) worker.stop();
    if (this.#server.listening) await new Promise((resolve) => this.#server.close(resolve));
    this.#store.unlock();
  }

  #summary(g, viewer = null) { return gameSummary({ id: g.id, mode: g.mode, lobby: g.lobby, rulesRevision: g.rulesRevision }, viewer); }
  #saveMeta(g) {
    this.#store.writeJson(g.id, 'meta.json', { v: 1, id: g.id, mode: g.mode,
      rulesRevision: g.rulesRevision, seed: g.seed, lobby: g.lobby.serialize(), ranking: g.ranking ?? null });
  }

  async #worker(revision) {
    if (this.#workers.has(revision)) return this.#workers.get(revision);
    const snapshot = this.#store.readRevision(revision);
    if (!snapshot) throw new Error(`missing rules revision ${revision}`);
    const worker = new WorkerClient({ revision, rules: snapshot.values, root: this.#store.root,
      onEvent: (e) => this.#workerEvent(e), onExit: (rev) => this.#workers.delete(rev) });
    this.#workers.set(revision, worker);
    await worker.ready;
    return worker;
  }
  async #call(g, op, extra = {}) { return (await this.#worker(g.rulesRevision)).call(op, { id: g.id, ...extra }); }

  async #restore() {
    for (const id of this.#store.listGames()) {
      const saved = this.#store.readGame(id);
      if (!saved.meta?.lobby) continue;
      const meta = saved.meta;
      const lobby = Lobby.restore(meta.lobby);
      const g = { id, mode: meta.mode, rulesRevision: meta.rulesRevision, seed: meta.seed,
        lobby, ranking: meta.ranking, directiveAt: new Map() };
      this.#games.set(id, g);
      if (saved.state) {
        const changed = lobby.restoreAfterRestart().changed;
        await this.#call(g, 'restore', { state: saved.state });
        if (changed) this.#saveMeta(g);
      }
    }
  }

  #workerEvent(e) {
    const g = this.#games.get(e.id);
    if (!g) return;
    if (e.type === 'record') {
      this.#broadcast(g, 'event', e.record.seq, this.#publicEvent(e.record));
      this.#broadcastViews(g);
    } else if (e.type === 'key_rejected') {
      g.lobby.keyMissing(e.participantId);
      this.#saveMeta(g);
      this.#armKeyTimer(g, e.participantId);
      this.#broadcastLobby(g);
    } else if (e.type === 'server_key_rejected') {
      g.lobby.pause('server_key_rejected');
      this.#saveMeta(g);
      this.#broadcastLobby(g);
    } else if (e.type === 'finished') {
      g.lobby.finish({ outcome: e.outcome.result });
      g.ranking = rankParticipants(g.lobby.participants.map((p) => {
        const x = e.outcome.explorers.find((r) => r.id === p.participantId) ?? {};
        return { participant_id: p.participantId, name: p.name, slot: p.slot, joined_at: p.joinedAt,
          coins: x.coins ?? 0, strikes: x.strikes ?? 0, dispels: x.dispels ?? 0,
          died_at: x.diedAt ?? null, portal: x.portal ?? false, alive: x.status === 'active' || x.status === 'won',
          forfeited: x.status === 'forfeited' };
      }));
      this.#saveMeta(g);
      this.#broadcast(g, 'end', null, { result: e.outcome.result, ranking: g.ranking, team_score: teamScore(g.ranking) });
    } else if (e.type === 'error') this.#logger.error('worker error', { game: g.id, message: e.message });
  }

  #publicEvent(record) {
    if (record.type.startsWith('monster') || record.type === 'decision_failed') return { seq: record.seq, type: 'world' };
    return { seq: record.seq, type: record.type, actor: record.actor,
      ...(record.type === 'explorer_turn' ? { dir: record.dir, skill: record.skill } : {}) };
  }

  #broadcast(g, event, id, data) {
    for (const client of this.#subscribers.get(g.id) ?? []) client.send({ event, id, data });
  }
  #broadcastLobby(g) {
    for (const client of this.#subscribers.get(g.id) ?? [])
      client.send({ event: 'lobby', data: this.#summary(g, client.participantId) });
  }
  async #broadcastViews(g) {
    for (const client of this.#subscribers.get(g.id) ?? []) {
      try {
        const view = await this.#call(g, 'view', { participantId: client.participantId,
          lobby: g.lobby.serialize(), mode: g.mode, ranking: g.ranking });
        client.send({ event: 'view', data: view });
      } catch (error) { this.#logger.error('view publish failed', { game: g.id, message: error.message }); }
    }
  }

  #armKeyTimer(g, participantId) {
    const tag = `${g.id}:${participantId}`;
    clearTimeout(this.#keyTimers.get(tag));
    const p = g.lobby.participant(participantId);
    if (!p?.keyDeadline) return;
    const timer = setTimeout(async () => {
      this.#keyTimers.delete(tag);
      if (!g.lobby.tick().includes(participantId)) return;
      await this.#call(g, 'forfeit', { participantId });
      this.#saveMeta(g);
      this.#broadcastLobby(g);
    }, Math.max(0, p.keyDeadline - Date.now()));
    timer.unref?.();
    this.#keyTimers.set(tag, timer);
  }

  async #static(res, path) {
    const name = STATIC.get(path) ?? (path.startsWith('/g/') ? 'play.html' :
      /^\/props\/[A-Za-z0-9_.-]+\.js$/.test(path) ? path.slice(1) : null);
    if (!name) return false;
    try {
      const data = await readFile(`${PUBLIC}${name}`);
      res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'text/plain', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch { send(res, 404, { error: 'not_found' }); }
    return true;
  }

  #member(req, g) { return g.lobby.participant(participantToken(req, g.id)); }
  #requireMember(req, g) {
    const p = this.#member(req, g);
    if (!p) throw asError(403, 'not_participant');
    return p;
  }
  #requireHost(req) {
    const result = this.#hostAuth.requireHost(req);
    if (!result.ok) throw asError(403, 'forbidden');
  }
  #take(req, cls) {
    const r = this.#limiter.take(cls, req.socket.remoteAddress ?? 'unknown');
    if (!r.ok) throw asError(429, 'rate_limited', { retry_in_ms: r.retryMs });
  }
  #getGame(id) {
    const g = this.#games.get(id);
    if (!g) throw asError(404, 'not_found');
    return g;
  }
  #ok(result) { if (!result.ok) throw asError(result.status, result.error); }

  #routes() {
    const r = this.#router;
    r.add('GET', '/health', () => ({ ok: true, games: this.#games.size,
      uptime_s: Math.floor((Date.now() - this.#startAt) / 1000) }));
    r.add('POST', '/v1/host/session', async (req, res) => {
      const body = await readJson(req);
      const session = this.#hostAuth.exchange(body.token, req);
      if (!session) throw asError(403, 'forbidden');
      return { body: {}, headers: { 'set-cookie': this.#hostAuth.sessionCookie(session) } };
    });
    r.add('GET', '/v1/host/settings', (req) => { this.#requireHost(req); return this.#settings.get(); });
    r.add('PUT', '/v1/host/settings', async (req) => {
      this.#requireHost(req);
      const value = this.#settings.put((await readJson(req)).values);
      if (!value.ok) throw asError(value.status, 'invalid', { fields: value.fields });
      return { revision: value.revision, values: value.values, changed: value.changed };
    });
    r.add('GET', '/v1/host/games', (req) => {
      this.#requireHost(req);
      return { games: [...this.#games.values()].map((g) => ({ ...this.#summary(g), calls: this.#callStats(g.id) })) };
    });
    r.add('GET', '/v1/host/metrics', (req) => {
      this.#requireHost(req);
      const all = [...this.#games].flatMap(([id]) => new CallsRecorder(this.#store, id).read());
      const durations = all.map((e) => e.ms).filter(Number.isFinite).sort((a, b) => a - b);
      const q = (p) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] ?? 0;
      return { posts: all.length, failures: all.filter((e) => e.outcome === 'failed').length,
        timeouts: all.filter((e) => e.outcome === 'timeout').length,
        latency_p50_ms: q(0.5), latency_p95_ms: q(0.95), actor_queue_delay_ms: 0,
        event_write_delay_ms: 0, sse_lag_ms: 0 };
    });
    r.add('GET', '/v1/host/games/:id/calls', (req, res, { id }) => {
      this.#requireHost(req); this.#getGame(id);
      const limit = Math.min(1000, Math.max(1, Number(new URL(req.url, 'http://localhost').searchParams.get('limit') ?? 200)));
      return { calls: new CallsRecorder(this.#store, id).read().slice(-limit).reverse() };
    });
    for (const op of ['pause', 'resume', 'end', 'reveal']) r.add('POST', `/v1/host/games/:id/${op}`, async (req, res, { id }) => {
      this.#requireHost(req);
      const g = this.#getGame(id);
      if (op === 'reveal') return { view: await this.#call(g, 'view', { participantId: null,
        lobby: g.lobby.serialize(), mode: g.mode, reveal: true, ranking: g.ranking }) };
      if (op === 'pause') { await this.#call(g, 'pause'); this.#ok(g.lobby.pause('host')); }
      if (op === 'resume') { this.#ok(g.lobby.hostResume()); await this.#call(g, 'resume'); }
      if (op === 'end') { await this.#call(g, 'stop'); this.#ok(g.lobby.finish({ outcome: 'host_ended' })); }
      this.#saveMeta(g);
      this.#broadcastLobby(g);
      return { game: this.#summary(g) };
    });

    r.add('POST', '/v1/games', async (req) => {
      this.#take(req, 'create');
      const body = await readJson(req);
      const name = sanitiseName(body.name);
      if (name.error || typeof body.key !== 'string' || !body.key.trim() || !['private', 'shared'].includes(body.mode))
        throw asError(400, 'invalid');
      const id = newId('gm_'), participantId = newId('par_');
      const { rules_revision: rulesRevision, rules } = this.#settings.rulesForNewGame();
      this.#store.createGameDir(id);
      this.#store.writeJson(id, 'rules.json', { rules_revision: rulesRevision, rules });
      const lobby = new Lobby({ id, mode: body.mode, capacity: rules.roomCapacity ?? 4,
        keyRetryMs: rules.keyRetryMs ?? 120000 });
      this.#ok(lobby.join({ participantId, name: name.name, keyPresent: true }));
      const g = { id, mode: body.mode, rulesRevision, seed: Math.floor(Math.random() * 2 ** 32),
        lobby, ranking: null, directiveAt: new Map() };
      this.#games.set(id, g);
      this.#saveMeta(g);
      await this.#call(g, 'set_key', { participantId, key: body.key });
      if (lobby.status === 'running') await this.#call(g, 'create', { participants: lobby.participants, seed: g.seed });
      return { status: 201, body: { game: this.#summary(g, participantId), participant_id: participantId },
        headers: { 'set-cookie': participantCookies(id, participantId, { pagePath: `/g/${id}` }) } };
    });
    r.add('POST', '/v1/games/:id/join', async (req, res, { id }) => {
      this.#take(req, 'join');
      const g = this.#getGame(id), body = await readJson(req), name = sanitiseName(body.name);
      if (name.error || typeof body.key !== 'string' || !body.key.trim()) throw asError(400, 'invalid');
      const participantId = newId('par_');
      this.#ok(g.lobby.join({ participantId, name: name.name, keyPresent: true }));
      this.#saveMeta(g);
      await this.#call(g, 'set_key', { participantId, key: body.key });
      this.#broadcastLobby(g);
      return { body: { game: this.#summary(g, participantId), participant_id: participantId },
        headers: { 'set-cookie': participantCookies(id, participantId, { pagePath: `/g/${id}` }) } };
    });
    r.add('GET', '/v1/games/:id', async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#member(req, g);
      if (!p) {
        if (g.lobby.status === 'waiting') return { game: this.#summary(g) };
        throw asError(403, 'not_participant');
      }
      if (g.lobby.status === 'waiting') return { lobby: this.#summary(g, p.participantId), self: p.participantId,
        status: 'waiting', mode: g.mode };
      return this.#call(g, 'view', { participantId: p.participantId, lobby: g.lobby.serialize(), mode: g.mode, ranking: g.ranking });
    });
    r.add('POST', '/v1/games/:id/leave', async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#requireMember(req, g);
      if (g.lobby.status === 'waiting') this.#ok(g.lobby.leave(p.participantId));
      else { this.#ok(g.lobby.died(p.participantId)); await this.#call(g, 'forfeit', { participantId: p.participantId }); }
      this.#saveMeta(g);
      this.#broadcastLobby(g);
      return { body: { game: this.#summary(g) }, headers: { 'set-cookie': [
        clearCookie(participantCookieName(id), `/v1/games/${id}`), clearCookie(participantCookieName(id), `/g/${id}`)] } };
    });
    r.add('POST', '/v1/games/:id/key', async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#requireMember(req, g), body = await readJson(req);
      if (typeof body.key !== 'string' || !body.key.trim()) throw asError(400, 'invalid');
      this.#ok(g.lobby.keyRestored(p.participantId));
      await this.#call(g, 'set_key', { participantId: p.participantId, key: body.key });
      clearTimeout(this.#keyTimers.get(`${id}:${p.participantId}`));
      this.#saveMeta(g);
      return { participant: { state: p.state, key_present: true } };
    });
    r.add('POST', '/v1/games/:id/start', async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#requireMember(req, g);
      this.#ok(g.lobby.start(p.participantId));
      this.#saveMeta(g);
      await this.#call(g, 'create', { participants: g.lobby.participants, seed: g.seed });
      this.#broadcastLobby(g);
      return { game: this.#summary(g, p.participantId) };
    });
    for (const op of ['pause', 'resume']) r.add('POST', `/v1/games/:id/${op}`, async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#requireMember(req, g);
      if (g.mode !== 'private' || p.participantId !== g.lobby.leader) throw asError(403, 'forbidden');
      if (op === 'pause') { await this.#call(g, 'pause'); this.#ok(g.lobby.pause('player')); }
      else { this.#ok(g.lobby.resume()); await this.#call(g, 'resume'); }
      this.#saveMeta(g);
      return { game: this.#summary(g, p.participantId) };
    });
    r.add('POST', '/v1/games/:id/directives', async (req, res, { id }) => {
      this.#take(req, 'directives');
      const g = this.#getGame(id), p = this.#requireMember(req, g), body = await readJson(req);
      if (typeof body.text !== 'string' || body.text.length > 140) throw asError(400, 'invalid');
      if (g.lobby.status !== 'running' || p.state !== 'active') throw asError(409, 'not_running');
      const previous = g.directiveAt.get(p.participantId) ?? -Infinity;
      const wait = previous + 10000 - Date.now();
      if (wait > 0) throw asError(429, 'cooldown', { retry_in_ms: wait });
      g.directiveAt.set(p.participantId, Date.now());
      return this.#call(g, 'directive', { participantId: p.participantId, text: body.text });
    });
    r.add('GET', '/v1/games/:id/events', async (req, res, { id }) => {
      const g = this.#getGame(id), p = this.#requireMember(req, g);
      const client = openSse(req, res, { onClose: () => this.#subscribers.get(id)?.delete(client) });
      client.participantId = p.participantId;
      let set = this.#subscribers.get(id);
      if (!set) this.#subscribers.set(id, (set = new Set()));
      set.add(client);
      const after = Number(client.lastEventId ?? 0);
      // Recovery reads may truncate an uncommitted tail. An SSE subscriber must never do that
      // while the worker is between its event append and state write.
      const committedSeq = this.#store.readState(id)?.event_seq ?? 0;
      for (const record of this.#store.readEvents(id, { afterSeq: after }))
        if (record.seq <= committedSeq) client.send({ id: record.seq, event: 'event', data: this.#publicEvent(record) });
      if (g.lobby.status === 'waiting') client.send({ event: 'lobby', data: this.#summary(g, p.participantId) });
      else client.send({ event: 'view', data: await this.#call(g, 'view', { participantId: p.participantId,
        lobby: g.lobby.serialize(), mode: g.mode, ranking: g.ranking }) });
      return null;
    });
  }

  #callStats(id) {
    const calls = new CallsRecorder(this.#store, id).read();
    const ms = calls.map((c) => c.ms).filter(Number.isFinite).sort((a, b) => a - b);
    return { posts: calls.length, failures: calls.filter((c) => c.outcome === 'failed').length,
      timeouts: calls.filter((c) => c.outcome === 'timeout').length, p50_ms: ms[Math.floor(ms.length / 2)] ?? 0 };
  }

  async #handle(req, res) {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && !path.startsWith('/v1/') && path !== '/health' && await this.#static(res, path)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const own = `http://${req.headers.host}`;
        if (!checkOrigin(req, own, { allowMissing: isLoopback(req) && process.env.JEV_TEST_STUB === '1' }))
          throw asError(403, 'bad_origin');
      }
      const match = this.#router.match(req.method, path);
      if (!match.handler) throw asError(match.status, match.status === 405 ? 'method_not_allowed' : 'not_found');
      const result = await match.handler(req, res, match.params);
      if (res.headersSent || result === null) return;
      send(res, typeof result?.status === 'number' ? result.status : 200, result?.body ?? result, result?.headers ?? {});
    } catch (err) {
      const status = err.status ?? (err instanceof HttpError ? err.status : 500);
      if (status === 500) this.#logger.error('request failed', { message: err.message });
      send(res, status, { error: err.error ?? (status === 500 ? 'internal' : 'invalid'),
        message: status === 500 ? 'Internal error.' : err.message ?? err.error, ...(err.extra ?? {}) });
    }
  }
}
