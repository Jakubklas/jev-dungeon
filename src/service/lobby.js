// One hosted game's membership and lifecycle (PLAN-multiplayer "Waiting room and membership", "Key failure",
// "Storage and recovery"). A deterministic state machine: no I/O, no timers, time only through the injected `now` or an
// explicit `at`. The game actor calls it one request at a time, so join/start races are just sequential calls: the one
// after `start` gets 409 game_started. Keys are never stored here: only the `keyPresent` boolean.
// Every mutating method returns { ok: true, ... } or { ok: false, status, error } so the HTTP layer maps it directly.

export const STATUSES = ['waiting', 'running', 'paused', 'finished', 'abandoned'];
export const PARTICIPANT_STATES = ['waiting', 'active', 'awaiting_key', 'dead', 'forfeited'];
export const DEFAULTS = Object.freeze({ capacity: 4, idleMs: 30 * 60 * 1000, keyRetryMs: 120000 });

const fail = (status, error) => ({ ok: false, status, error });
const LIVING = new Set(['active', 'awaiting_key']);

export class Lobby {
  #now;

  constructor({ id, mode = 'shared', capacity = DEFAULTS.capacity, createdAt, now = Date.now, idleMs = DEFAULTS.idleMs, keyRetryMs = DEFAULTS.keyRetryMs } = {}) {
    if (mode !== 'private' && mode !== 'shared') throw new Error(`Lobby: bad mode ${JSON.stringify(mode)}`);
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Lobby: capacity must be a positive integer');
    this.#now = now;
    const t = createdAt ?? now();
    this.id = id;
    this.mode = mode;
    this.capacity = mode === 'private' ? 1 : capacity;
    this.idleMs = idleMs;
    this.keyRetryMs = keyRetryMs;
    this.createdAt = t;
    this.status = 'waiting';
    this.pauseReason = null;
    this.pausedAt = null;
    this.lastActivityAt = t;
    this.startedAt = null;
    this.result = null;
    this.participants = []; // join order; slot is assigned at start
  }

  // ---- lookup ----
  participant(participantId) { return this.participants.find((p) => p.participantId === participantId) ?? null; }
  get leader() { return this.participants[0]?.participantId ?? null; }
  activeCount() { return this.participants.filter((p) => p.state === 'active').length; }
  livingCount() { return this.participants.filter((p) => LIVING.has(p.state)).length; }
  allKeysPresent() { return this.participants.filter((p) => LIVING.has(p.state)).every((p) => p.keyPresent); }

  // ---- waiting room ----
  join({ participantId, name, keyPresent = false } = {}) {
    if (this.status !== 'waiting') return fail(409, 'game_started');
    if (this.participant(participantId)) return fail(409, 'already_joined');
    if (this.participants.length >= this.capacity) return fail(400, 'room_full');
    const at = this.#now();
    this.participants.push({ participantId, name, slot: null, joinedAt: at, keyPresent: !!keyPresent, state: 'waiting', keyDeadline: null, diedAt: null, forfeitedAt: null });
    this.lastActivityAt = at;
    if (this.mode === 'private') return { ...this.start(participantId), leader: this.leader };
    return { ok: true, leader: this.leader, participants: this.participants.length };
  }

  leave(participantId) {
    if (this.status !== 'waiting') return fail(409, 'game_started');
    const i = this.participants.findIndex((p) => p.participantId === participantId);
    if (i < 0) return fail(403, 'not_participant');
    const wasLeader = i === 0;
    this.participants.splice(i, 1);
    this.lastActivityAt = this.#now();
    return { ok: true, leader: this.leader, leaderChanged: wasLeader && this.participants.length > 0 };
  }

  start(by) {
    if (this.status !== 'waiting') return fail(409, 'not_waiting');
    if (!this.participant(by)) return fail(403, 'not_participant');
    if (by !== this.leader) return fail(403, 'not_leader');
    if (this.participants.length === 0) return fail(400, 'empty_roster');
    this.participants.forEach((p, slot) => { p.slot = slot; p.state = 'active'; });
    this.status = 'running';
    this.startedAt = this.#now();
    this.lastActivityAt = this.startedAt;
    return { ok: true, slots: this.participants.map((p) => ({ participantId: p.participantId, slot: p.slot })) };
  }

  expire(at = this.#now()) {
    if (this.status !== 'waiting' || at - this.lastActivityAt < this.idleMs) return fail(409, 'not_expired');
    this.status = 'abandoned';
    return { ok: true };
  }

  // ---- lifecycle ----
  pause(reason = 'host', at = this.#now()) {
    if (this.status !== 'running') return fail(409, 'not_running');
    this.status = 'paused';
    this.pauseReason = reason;
    this.pausedAt = at;
    return { ok: true };
  }

  // Key windows do not run while paused: resuming pushes every open deadline back by the time spent paused.
  resume(at = this.#now()) {
    if (this.status !== 'paused') return fail(409, 'not_paused');
    const shift = this.pausedAt == null ? 0 : Math.max(0, at - this.pausedAt);
    for (const p of this.participants) if (p.keyDeadline != null) p.keyDeadline += shift;
    this.status = 'running';
    this.pauseReason = null;
    this.pausedAt = null;
    return { ok: true };
  }

  // The host resumes a restart-paused game: those still without a key get a fresh keyRetryMs window.
  hostResume(at = this.#now()) {
    if (this.status !== 'paused') return fail(409, 'not_paused');
    this.status = 'running';
    this.pauseReason = null;
    this.pausedAt = null;
    for (const p of this.participants) {
      if (p.state === 'awaiting_key' && !p.keyPresent) p.keyDeadline = at + this.keyRetryMs;
    }
    return { ok: true };
  }

  finish(result = {}) {
    if (this.status === 'finished' || this.status === 'abandoned') return fail(409, 'not_running');
    if (this.status === 'waiting') return fail(409, 'not_started');
    this.status = 'finished';
    this.result = result;
    this.pauseReason = null;
    return { ok: true };
  }

  // ---- participants after start ----
  keyMissing(participantId, at = this.#now()) {
    const p = this.participant(participantId);
    if (!p) return fail(403, 'not_participant');
    if (p.state !== 'active' && p.state !== 'awaiting_key') return fail(409, `participant_${p.state}`);
    p.keyPresent = false;
    p.state = 'awaiting_key';
    p.keyDeadline = at + this.keyRetryMs;
    return { ok: true, deadline: p.keyDeadline };
  }

  keyRestored(participantId) {
    const p = this.participant(participantId);
    if (!p) return fail(403, 'not_participant');
    if (p.state === 'forfeited' || p.state === 'dead') return fail(409, `participant_${p.state}`);
    p.keyPresent = true; // also valid while waiting: a rejoining player pastes a key
    if (p.state === 'awaiting_key') { p.state = 'active'; p.keyDeadline = null; }
    return { ok: true };
  }

  // Participants whose window ran out become forfeited (final). Only while running.
  tick(at = this.#now()) {
    if (this.status !== 'running') return [];
    const out = [];
    for (const p of this.participants) {
      if (p.state === 'awaiting_key' && p.keyDeadline != null && at >= p.keyDeadline) {
        p.state = 'forfeited';
        p.forfeitedAt = at;
        p.keyDeadline = null;
        out.push(p.participantId);
      }
    }
    if (out.length) this.#checkTeamLoss();
    return out;
  }

  died(participantId, at = this.#now()) {
    const p = this.participant(participantId);
    if (!p) return fail(403, 'not_participant');
    if (!LIVING.has(p.state)) return fail(409, `participant_${p.state}`);
    p.state = 'dead';
    p.diedAt = at;
    p.keyDeadline = null;
    this.#checkTeamLoss();
    return { ok: true, teamLoss: this.status === 'finished' };
  }

  // No active or awaiting_key participant left: the team lost.
  #checkTeamLoss() {
    if ((this.status === 'running' || this.status === 'paused') && this.livingCount() === 0) {
      this.status = 'finished';
      this.result = { outcome: 'team_loss' };
      this.pauseReason = null;
    }
  }

  // ---- restart recovery ----
  restoreAfterRestart() {
    if (this.status !== 'running' && this.status !== 'paused') return { ok: true, changed: false };
    this.status = 'paused';
    this.pauseReason = 'keys_needed';
    this.pausedAt = null;
    for (const p of this.participants) {
      if (LIVING.has(p.state)) { p.state = 'awaiting_key'; p.keyPresent = false; p.keyDeadline = null; }
    }
    return { ok: true, changed: true };
  }

  // ---- persistence ----
  serialize() {
    return JSON.parse(JSON.stringify({
      id: this.id, mode: this.mode, capacity: this.capacity, idleMs: this.idleMs, keyRetryMs: this.keyRetryMs,
      createdAt: this.createdAt, status: this.status, pauseReason: this.pauseReason, pausedAt: this.pausedAt,
      lastActivityAt: this.lastActivityAt, startedAt: this.startedAt, result: this.result,
      participants: this.participants,
    }));
  }

  static restore(json, { now = Date.now } = {}) {
    const l = new Lobby({ id: json.id, mode: json.mode, capacity: json.capacity, createdAt: json.createdAt, now, idleMs: json.idleMs, keyRetryMs: json.keyRetryMs });
    l.status = json.status;
    l.pauseReason = json.pauseReason ?? null;
    l.pausedAt = json.pausedAt ?? null;
    l.lastActivityAt = json.lastActivityAt;
    l.startedAt = json.startedAt ?? null;
    l.result = json.result ?? null;
    l.participants = (json.participants ?? []).map((p) => ({ participantId: p.participantId, name: p.name, slot: p.slot ?? null, joinedAt: p.joinedAt, keyPresent: p.keyPresent === true, state: p.state, keyDeadline: p.keyDeadline ?? null, diedAt: p.diedAt ?? null, forfeitedAt: p.forfeitedAt ?? null }));
    return l;
  }
}
