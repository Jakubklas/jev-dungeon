// One explorer's schedule inside a GameActor (PLAN-multiplayer-impl WP-E). It owns the actor-side state: a
// `generation` (bumped on death, forfeit and pause, so a late answer cannot act for a replaced session), at most one
// decision in flight, and the next time one is due. The brain does the thinking: `decide()` runs outside the
// mutation lock and never writes to the Game, `apply()` runs inside it against the world as it is NOW.
// The host (GameActor) is the only caller; everything that mutates runs through host.enqueue().
import { KeyRejected } from '../gateway/errors.js';

// 'active' (schedules decisions) | 'awaiting_key' (its Jev key was rejected; nothing runs until resume) | 'forfeited' | 'dead' | 'won' | 'done'
export class ExplorerActor {
  kind = 'explorer';
  generation = 0;
  status = 'active';
  inFlight = null; // { generation, observedAt, controller } of the decision being thought
  timer = null;

  constructor(host, id, brain) {
    this.host = host;
    this.id = id;
    this.brain = brain;
  }

  // The next decision starts `delayMs` of clock time from now (never a backlog: one timer, rearmed after each apply).
  schedule(delayMs) {
    this.cancelTimer();
    if (this.status !== 'active') return;
    this.timer = this.host.after(delayMs, () => { this.timer = null; this.host.enqueue(() => this.wake()).catch((e) => this.host.fault(e)); });
  }

  cancelTimer() {
    if (this.timer) this.host.cancel(this.timer);
    this.timer = null;
  }

  // Invalidates everything in flight: the controller aborts the transport, the generation drops a late answer.
  invalidate() {
    this.generation++;
    this.cancelTimer();
    this.inFlight?.controller.abort();
    this.inFlight = null;
  }

  retire(status) {
    this.invalidate();
    this.status = status;
  }

  // Timer fired (inside the lock). Starts a decision: the observation is the world now, the request is built
  // synchronously by decide(); the Jev calls then run outside the lock.
  wake() {
    const host = this.host;
    if (!host.running || this.status !== 'active' || this.inFlight) return;
    host.syncClock();
    const game = host.game;
    const ex = game.explorer(this.id);
    if (game.won || game.lost || ex.status !== 'active') return;
    const token = { generation: this.generation, observedAt: game.clock, controller: new AbortController() };
    host.noteHelp(this.id);
    this.inFlight = token;
    let thinking;
    try {
      thinking = this.brain.decide({ signal: token.controller.signal });
    } catch (err) {
      thinking = Promise.reject(err);
    }
    thinking.then(
      ({ intent }) => host.enqueue(() => this.apply(token, intent, host.clockNow())).catch((e) => host.fault(e)),
      (err) => host.enqueue(() => this.fail(token, err)).catch((e) => host.fault(e)),
    );
  }

  // The answer arrived (inside the lock). Re-checks that this session is still the one that asked and the explorer
  // is still in play, then lets the brain apply the intent against the current world.
  apply(token, intent, completedAt) {
    const host = this.host;
    const base = { actor: this.id, generation: token.generation, observed_at: token.observedAt, completed_at: completedAt };
    if (this.inFlight !== token || token.generation !== this.generation || this.status !== 'active' || !host.running) {
      host.record('decision_dropped', { ...base, reason: this.status !== 'active' ? this.status : 'old generation' });
      return;
    }
    this.inFlight = null;
    host.syncClock();
    const game = host.game;
    const ex = game.explorer(this.id);
    if (game.won || game.lost || ex.status !== 'active') {
      host.record('decision_dropped', { ...base, reason: game.won || game.lost ? 'game over' : ex.status });
      return;
    }
    game.strikes = []; // effects belong to this applied action, never the whole hosted session
    const coins = ex.coins;
    const turn = this.brain.apply(intent);
    host.record('explorer_turn', {
      ...base,
      step: turn.step, dir: turn.dir, forced: turn.forced, won: turn.won, held: turn.held,
      skill: intent.skill, skill_used: turn.skill_decision?.used ?? null,
      ...(turn.stale ? { stale: turn.stale } : {}),
      coins_gained: ex.coins - coins, pos: [...ex.pos], health: ex.health,
      strikes: game.strikes.filter((s) => s.by === this.id).map((s) => ({ cells: s.cells, result: s.result })),
      events: turn.skill_events ?? [],
    });
    host.track(this.brain.save());
    this.schedule(host.rules.cadenceMs);
  }

  // The decision ended without an answer (inside the lock): a timeout or a failed call costs only this decision; a
  // rejected key stops this explorer until the service gives it a new one; an abort was ours (pause, forfeit).
  fail(token, err) {
    const host = this.host;
    if (this.inFlight !== token || token.generation !== this.generation) return; // aborted by us: the new session owns the schedule
    this.inFlight = null;
    if (!host.running || this.status !== 'active') return;
    host.syncClock();
    const keyRejected = err instanceof KeyRejected || err?.name === 'KeyRejected' || err?.name === 'NoKey';
    const reason = keyRejected ? 'key_rejected' : err?.name === 'CallTimeout' ? 'timeout' : err?.name === 'CallAborted' ? 'aborted' : 'failed';
    host.record('decision_failed', {
      actor: this.id, generation: token.generation, observed_at: token.observedAt, completed_at: host.game.clock,
      reason, message: String(err?.message ?? err), ...(keyRejected ? { awaiting_key: true } : {}),
    });
    if (keyRejected) {
      this.status = 'awaiting_key';
      this.cancelTimer();
      host.keyRejected(this.id);
    } else {
      this.schedule(host.rules.cadenceMs);
    }
  }
}
