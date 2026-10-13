// The hosted runtime for one game (PLAN-multiplayer-impl WP-E; PLAN-multiplayer "Continuous time and actor decisions").
// There is no world tick: every explorer and monster has its own schedule and at most one decision in flight. Jev
// calls run OUTSIDE the mutation lock; the lock is a queue of synchronous commands (never an `await` inside one), so
// the world only changes in short critical sections and a slow actor never stops a fast one.
//
//   explorer: wake -> brain.decide({ signal })  (outside)  -> apply_intent (inside, re-checks generation + liveness,
//             brain.apply validates against the world NOW) -> next decision `cadenceMs` after the apply or the failure.
//   monster:  patrol on its own interval (brain off), or monsterTurnStart (inside) / decideAdversary (outside) /
//             monsterTurnApply (inside); next turn max(cadenceMs, moveIntervalMs) after the apply.
//
// Time: `game.managed = true` and `game.clock` = the runtime clock's elapsed time with paused stretches left out, written
// before every critical section. Records carry that world time in ms (observed_at, completed_at, applied_at).
// Nothing runs until start() (autoplay defaults to false). No Jev call here: the brains' `ask` and `decideMonster` do it.
import { MonotonicClock } from './clock.js';
import { ExplorerActor } from './explorer-actor.js';
import { MonsterActor } from './monster-actor.js';
import { Game } from '../dungeon.js';
import { Adversary, adversaryView } from '../characters/adversary/adversary.js';
import { KnownWorld } from '../characters/explorer/known-world.js';
import { ExplorerBrain } from '../characters/explorer/brain.js';
import { visibleAdversaries } from '../characters/adversary/adversary.js';
import { HELP_REACH_STEPS } from '../dungeon.js';
import { knownDistances } from '../characters/explorer/known-map.js';

export class GameActor {
  #game;
  #clock;
  #state = 'idle'; // 'idle' | 'running' | 'paused' | 'finished' | 'stopped'
  #anchor = 0; // clock.now() at the last start / resume
  #base = 0; // game.clock at that moment
  #queue = [];
  #inLock = false;
  #seq = 0;
  #pending = new Set(); // background promises (memory saves)
  #explorers = new Map();
  #monsters = new Map();
  #hooks;
  #outcome = null;
  #gameId = null;
  #coldEvery = 50;

  // explorers: [{ id, brain }] (each brain already built on KnownWorld(game, id) with its own asker). decideMonster: the
  // monsters' paid call ({ id, state, questions, body, signal } -> answers). rules: optional { stepMs, cadenceMs } override.
  // Hooks: onEvent(record), onKeyRejected(actorId), onServerKeyRejected(), onFinished(summary), onError(err).
  // `store` is reserved for the persistence work package; the runtime only publishes through onEvent.
  constructor({ game, clock = new MonotonicClock(), rules = null, explorers = [], decideMonster = null, store = null, gameId = null, coldEvery = 50, autoplay = false, startSeq = 0,
    onEvent = null, onKeyRejected = null, onServerKeyRejected = null, onFinished = null, onError = null } = {}) {
    if (!game) throw new Error('GameActor needs a game');
    this.#game = game;
    this.#clock = clock;
    this.store = store;
    this.#gameId = gameId;
    this.#coldEvery = coldEvery;
    this.decideMonster = decideMonster;
    this.#seq = startSeq;
    this.#hooks = { onEvent, onKeyRejected, onServerKeyRejected, onFinished, onError };
    if (rules) game.rules = { ...game.rules, ...rules };
    game.managed = true;
    for (const { id, brain } of explorers) {
      game.explorer(id); // throws on an unknown id
      this.#explorers.set(id, new ExplorerActor(this, id, brain));
    }
    for (const a of game.adversaries) this.#monsters.set(a.id, new MonsterActor(this, a.id));
    if (autoplay) this.start();
  }

  // ---- the host API the actors use ----------------------------------------------------------------------------------
  get game() { return this.#game; }
  get rules() { return this.#game.rules; }
  get running() { return this.#state === 'running'; }
  get state() { return this.#state; }
  get inLock() { return this.#inLock; }
  get seq() { return this.#seq; }
  get outcome() { return this.#outcome; }

  // A direct sighting starts one call per encounter. Recipients are reached over shared known
  // floor, and the report is copied now; later monster movement cannot update it.
  noteHelp(id) {
    if (!this.#inLock || this.#game.explorers.length < 2) return;
    const game = this.#game;
    const sender = game.explorer(id);
    const seen = visibleAdversaries(game, id);
    if (!seen.length) { game.helpActive[id] = false; return; }
    if (game.helpActive[id]) return;
    game.helpActive[id] = true;
    const world = new KnownWorld(game, id);
    const map = { width: world.width, height: world.height,
      knownTile: (cell) => world.knownTile(cell), isKnown: (cell) => world.isKnown(cell),
      seenTreasure: () => null, teammates: () => [] };
    const distances = knownDistances(map, sender.pos);
    const recipients = [];
    for (const other of game.activeExplorers()) {
      if (other.id === id || (distances.get(other.pos) ?? Infinity) > HELP_REACH_STEPS) continue;
      const reports = game.helpReports[other.id] ?? [];
      game.helpReports[other.id] = [...reports.filter((r) => other.steps - r.step <= 30 && !seen.some((s) => s.id === r.id)),
        ...seen.map((s) => ({ id: s.id, by: id, cell: [...s.pos], step: other.steps }))];
      recipients.push(other.id);
    }
    this.record('help_called', { actor: id, who: id, recipients, sightings: seen.map((s) => s.id) });
  }

  serialize() {
    return { v: 1, event_seq: this.#seq, status: this.#state, outcome: this.#outcome,
      game: this.#game.serialize(),
      brains: Object.fromEntries([...this.#explorers].map(([id, x]) => [id, x.brain.serialize()])),
      explorers: Object.fromEntries([...this.#explorers].map(([id, x]) => [id, { status: x.status, generation: x.generation }])),
      monsters: Object.fromEntries([...this.#monsters].map(([id, x]) => [id, { status: x.status, generation: x.generation }])),
      views: Object.fromEntries(this.#game.adversaries.map((a) => [a.id, adversaryView(this.#game, a).serialize()])),
    };
  }

  // Restore always starts paused. Calls in flight at the crash are discarded; no old answer can apply.
  static restore(saved, { clock = new MonotonicClock(), askFor, decideMonster = null, store = null,
    gameId = null, onEvent = null, onKeyRejected = null, onServerKeyRejected = null, onFinished = null, onError = null } = {}) {
    if (saved?.v !== 1 || !saved.game || !saved.brains) throw new TypeError('invalid game actor snapshot');
    const game = Game.restore(saved.game, { restoreAdversary: (a) => Adversary.restore(a) });
    const explorers = Object.entries(saved.brains).map(([id, brain]) => ({ id,
      brain: ExplorerBrain.restore(new KnownWorld(game, id), brain, { ask: askFor(id), persistMemory: !store }) }));
    const actor = new GameActor({ game, clock, explorers, decideMonster, store, gameId,
      startSeq: saved.event_seq, onEvent, onKeyRejected, onServerKeyRejected, onFinished, onError });
    actor.#state = saved.status === 'finished' ? 'finished' : 'paused';
    actor.#outcome = saved.outcome;
    for (const [id, state] of Object.entries(saved.explorers)) {
      const x = actor.#explorers.get(id);
      x.status = state.status;
      x.generation = state.generation + 1;
    }
    for (const [id, state] of Object.entries(saved.monsters)) {
      const x = actor.#monsters.get(id);
      if (x) { x.status = state.status; x.generation = state.generation + 1; }
    }
    for (const a of game.adversaries) if (saved.views[a.id]) adversaryView(game, a).restore(saved.views[a.id]);
    game.freeze();
    return actor;
  }
  after(ms, fn) { return this.#clock.setTimeout(fn, ms); }
  cancel(handle) { this.#clock.clearTimeout(handle); }
  track(promise) {
    if (!promise || typeof promise.then !== 'function') return;
    const p = promise.catch((e) => this.fault(e)).finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }
  fault(err) {
    if (this.#hooks.onError) this.#hooks.onError(err);
    else console.error('[runtime]', err);
  }

  // World time now, without writing it (usable outside the lock): the clock's elapsed time minus paused stretches.
  clockNow() {
    return this.#state === 'running' ? this.#base + (this.#clock.now() - this.#anchor) : this.#game.clock;
  }

  // Writes game.clock (inside the lock, before a mutation reads a deadline). A frozen game ignores it.
  syncClock() {
    if (this.#state === 'running') this.#game.setClock(this.clockNow());
  }

  // ---- the mutation queue -------------------------------------------------------------------------------------------
  // `command` is a synchronous function. Commands run one at a time, in arrival order, each to completion before the
  // next starts; one enqueued from inside a command waits its turn. Returns a promise of the command's result. Never
  // put an await inside a command: decisions are started inside (their request is built synchronously) and awaited
  // outside.
  enqueue(command) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ command, resolve, reject });
      if (!this.#inLock) this.#drain();
    });
  }

  #drain() {
    this.#inLock = true;
    try {
      while (this.#queue.length) {
        const { command, resolve, reject } = this.#queue.shift();
        try {
          resolve(command());
        } catch (err) {
          reject(err);
        }
        this.#checkEnd();
      }
    } finally {
      this.#inLock = false;
    }
  }

  // ---- events -------------------------------------------------------------------------------------------------------
  // One record per applied action (also a stale no-op or a failed decision), plus lifecycle records. `seq` strictly
  // increases; `applied_at` is the world time the record was written.
  record(type, fields = {}) {
    const rec = { seq: ++this.#seq, type, actor: null, generation: null, observed_at: null, completed_at: null, ...fields, applied_at: this.#game.clock };
    if (this.store) {
      if (!this.#gameId) throw new Error('gameId is required for persisted actors');
      this.store.appendEvent(this.#gameId, rec);
      const snapshot = this.serialize();
      this.store.writeJson(this.#gameId, 'state.json', snapshot);
      if (type === 'game_started' || type === 'game_over' || (this.#coldEvery > 0 && rec.seq % this.#coldEvery === 0)) {
        this.store.writeCold(this.#gameId, rec.seq, snapshot);
      }
    }
    try {
      this.#hooks.onEvent?.(rec);
    } catch (err) {
      this.fault(err);
    }
    return rec;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------
  start() {
    if (this.#state !== 'idle') return this.enqueue(() => undefined);
    return this.enqueue(() => {
      const game = this.#game;
      this.#state = 'running';
      this.#anchor = this.#clock.now();
      this.#base = game.clock;
      game.thaw();
      for (const x of this.#explorers.values()) {
        x.brain.attachClock(() => this.clockNow()); // Dash follows world time (fresh, never stale), so a pause freezes its cooldown
        x.schedule(0);
      }
      for (const m of this.#monsters.values()) {
        const a = game.adversaries.find((q) => q.id === m.id);
        if (a) m.schedule(m.nextDelay(a));
      }
      this.record('game_started', { lifecycle: true, explorers: [...this.#explorers.keys()], monsters: [...this.#monsters.keys()] });
    });
  }

  // Pause: in-flight decisions are aborted and their late answers dropped, the game clock freezes (every deadline keeps its
  // remaining ms) and nothing is scheduled until resume().
  pause(reason = 'paused') {
    return this.enqueue(() => this.#pause(reason));
  }

  #pause(reason) {
    if (this.#state !== 'running') return false;
    this.syncClock();
    this.#state = 'paused';
    this.#each((x) => x.invalidate());
    this.#game.freeze();
    this.record('game_paused', { lifecycle: true, reason });
    return true;
  }

  // Resume re-anchors the clock to now and gives every active actor one fresh decision after its cadence: no catch-up.
  resume() {
    return this.enqueue(() => {
      if (this.#state !== 'paused') return false;
      this.#state = 'running';
      this.#anchor = this.#clock.now();
      this.#base = this.#game.clock;
      this.#game.thaw();
      for (const x of this.#explorers.values()) x.schedule(this.rules.cadenceMs);
      for (const m of this.#monsters.values()) {
        const a = this.#game.adversaries.find((q) => q.id === m.id);
        if (a) m.schedule(m.nextDelay(a));
      }
      this.record('game_resumed', { lifecycle: true });
      return true;
    });
  }

  // Stops for good: aborts everything in flight, clears the timers, freezes the clock. Resolves once background saves settle.
  async stop() {
    await this.enqueue(() => {
      if (this.#state === 'stopped' || this.#state === 'finished') return;
      this.syncClock();
      this.#halt('stopped');
      this.record('game_stopped', { lifecycle: true });
    });
    await this.whenIdle();
  }

  async whenIdle() {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  #halt(state) {
    this.#state = state;
    this.#each((x) => x.invalidate());
    this.#game.freeze();
  }

  #each(fn) {
    for (const x of this.#explorers.values()) fn(x);
    for (const m of this.#monsters.values()) fn(m);
  }

  // The game ended (a team win at the portal, or no active explorer left): everything stops and one final record goes out.
  #checkEnd() {
    const game = this.#game;
    if (this.#state !== 'running' && this.#state !== 'paused') return;
    if (!game.won && !game.lost) return;
    this.syncClock();
    this.#halt('finished');
    const winner = game.explorers.find((e) => e.status === 'won')?.id ?? null;
    this.#outcome = {
      result: game.won ? 'won' : 'lost', won: game.won, lost: game.lost, winner, win_by: game.winBy, caught_by: game.caughtBy,
      explorers: game.explorers.map((e) => ({ id: e.id, status: e.status, coins: e.coins, health: e.health,
        strikes: e.outcome.strikes, dispels: e.outcome.dispels, diedAt: e.outcome.diedAt, portal: e.outcome.portal })),
    };
    this.record('game_over', { lifecycle: true, ...this.#outcome });
    try {
      this.#hooks.onFinished?.(this.#outcome);
    } catch (err) {
      this.fault(err);
    }
  }

  // ---- keys and forfeits (hooks for the service) --------------------------------------------------------------------
  keyRejected(actorId) {
    try {
      this.#hooks.onKeyRejected?.(actorId);
    } catch (err) {
      this.fault(err);
    }
  }

  // The server's own key was rejected by a monster call: the game pauses (an operator fixes the key, then resume()).
  serverKeyRejected() {
    try {
      this.#hooks.onServerKeyRejected?.();
    } catch (err) {
      this.fault(err);
    }
    this.#pause('server_key_rejected');
  }

  // A rejected explorer starts deciding again (the service stored a new key).
  resumeExplorer(id) {
    return this.enqueue(() => {
      const x = this.#explorers.get(id);
      if (!x || x.status !== 'awaiting_key') return false;
      x.status = 'active';
      this.syncClock();
      if (this.running) x.schedule(this.rules.cadenceMs);
      this.record('explorer_resumed', { lifecycle: true, actor: id, generation: x.generation });
      return true;
    });
  }

  // The player leaves for good: generation bump (an answer in flight is dropped), no longer occupies a cell or draws monsters.
  // The game is lost when nobody active is left.
  forfeitExplorer(id) {
    return this.enqueue(() => {
      const x = this.#explorers.get(id);
      if (!x || x.status === 'forfeited') return false;
      this.syncClock();
      x.retire('forfeited');
      this.#game.forfeit(id);
      this.record('explorer_forfeited', { lifecycle: true, actor: id, generation: x.generation });
      return true;
    });
  }

  // After a monster's turn (inside the lock): tell each explorer what happened to it, like Run does, and retire the dead.
  afterMonsterTurn(events) {
    const game = this.#game;
    const primary = game.explorers[0].id;
    for (const x of this.#explorers.values()) {
      const ex = game.explorer(x.id);
      const mine = (e) => (e.explorer ?? primary) === x.id;
      const hit = events.find((e) => e.type === 'hit' && mine(e));
      if (x.status === 'active' && ex.status === 'dead') {
        x.retire('dead');
        this.track(x.brain.noteCaught(hit?.id ?? game.caughtBy));
        continue;
      }
      if (x.status !== 'active') continue;
      if (hit) this.track(x.brain.noteHit(hit.id));
      for (const e of events) if (e.type === 'blocked' && mine(e)) this.track(x.brain.noteBlocked());
    }
  }

  // ---- read-only views for the service and the checks ---------------------------------------------------------------
  actorStatus(id) { return (this.#explorers.get(id) ?? this.#monsters.get(id))?.status ?? null; }
  brain(id) { return this.#explorers.get(id)?.brain ?? null; }
  generation(id) { return (this.#explorers.get(id) ?? this.#monsters.get(id))?.generation ?? null; }
  inFlight(id) { return Boolean((this.#explorers.get(id) ?? this.#monsters.get(id))?.inFlight); }
}
