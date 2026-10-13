// One monster's schedule inside a GameActor (PLAN-multiplayer-impl WP-E). A brain-off monster walks its code patrol
// on its own interval (`moveIntervalMs`); a hunting one runs monsterTurnStart (inside the lock), decideAdversary
// (outside, the paid call on the server key) and monsterTurnApply (inside the lock again, against the world as it is
// then). Its next turn is max(cadenceMs, moveIntervalMs) after the previous apply, so a slow answer never queues
// up old turns. Claw cooldowns count the monster's own turns here (Deviation 8).
import { decideAdversary, moveIntervalMs, monsterTurnApply, monsterTurnStart } from '../characters/adversary/adversary.js';
import { KeyRejected } from '../gateway/errors.js';

export class MonsterActor {
  kind = 'monster';
  generation = 0;
  status = 'active'; // 'active' | 'gone' (dispelled)
  inFlight = null;
  timer = null;

  constructor(host, id) {
    this.host = host;
    this.id = id;
  }

  schedule(delayMs) {
    this.cancelTimer();
    if (this.status !== 'active') return;
    this.timer = this.host.after(delayMs, () => { this.timer = null; this.host.enqueue(() => this.wake()).catch((e) => this.host.fault(e)); });
  }

  cancelTimer() {
    if (this.timer) this.host.cancel(this.timer);
    this.timer = null;
  }

  invalidate() {
    this.generation++;
    this.cancelTimer();
    this.inFlight?.controller.abort();
    this.inFlight = null;
  }

  // Delay to the next turn after an apply: the monster's own pace, never faster than the cadence.
  nextDelay(a) {
    const rules = this.host.rules;
    return Math.max(rules.cadenceMs, moveIntervalMs(this.host.game, a));
  }

  wake() {
    const host = this.host;
    if (!host.running || this.status !== 'active' || this.inFlight) return;
    host.syncClock();
    const game = host.game;
    if (game.won || game.lost) return;
    const a = game.adversaries.find((x) => x.id === this.id);
    if (!a) { this.status = 'gone'; return; } // dispelled: nothing to schedule
    const token = { generation: this.generation, observedAt: game.clock, controller: new AbortController() };
    const base = { actor: this.id, generation: token.generation, observed_at: token.observedAt, completed_at: token.observedAt };
    const start = monsterTurnStart(game, a, { now: game.monsterTick() });
    if (!start) { // stunned (it loses the turn), or not in the game
      host.record('monster_turn', { ...base, noop: true, reason: 'did not act', events: [] });
      this.schedule(this.nextDelay(a));
      return;
    }
    if (!start.thinks) { // brain off: a code patrol step, no Jev
      this.finish(a, start, undefined, token, base);
      return;
    }
    this.inFlight = token;
    // decideAdversary builds the request body synchronously (here, in the lock) and then awaits the paid call outside it.
    decideAdversary(game, a, start, { decide: host.decideMonster, signal: token.controller.signal }).then(
      (result) => host.enqueue(() => this.complete(token, a, start, result)).catch((e) => host.fault(e)),
      (err) => host.enqueue(() => this.fail(token, err)).catch((e) => host.fault(e)),
    );
  }

  complete(token, a, start, result) {
    const host = this.host;
    const base = { actor: this.id, generation: token.generation, observed_at: token.observedAt, completed_at: host.clockNow() };
    if (this.inFlight !== token || token.generation !== this.generation || !host.running || this.status !== 'active') {
      host.record('decision_dropped', { ...base, reason: 'old generation' });
      return;
    }
    this.inFlight = null;
    host.syncClock();
    if (result?.errorName === 'KeyRejected' || result?.errorName === 'NoKey') {
      // The server's key is wrong: no monster can think. The game pauses; the turn is not applied.
      host.record('decision_failed', { ...base, reason: 'key_rejected', message: String(result.error), server_key: true });
      host.serverKeyRejected();
      return;
    }
    this.finish(a, start, result, token, base);
  }

  fail(token, err) {
    const host = this.host;
    if (this.inFlight !== token || token.generation !== this.generation) return;
    this.inFlight = null;
    if (!host.running || this.status !== 'active') return;
    host.syncClock();
    const keyRejected = err instanceof KeyRejected || err?.name === 'KeyRejected' || err?.name === 'NoKey';
    host.record('decision_failed', { actor: this.id, generation: token.generation, observed_at: token.observedAt, completed_at: host.game.clock, reason: keyRejected ? 'key_rejected' : err?.name === 'CallAborted' ? 'aborted' : 'failed', message: String(err?.message ?? err), ...(keyRejected ? { server_key: true } : {}) });
    if (keyRejected) { host.serverKeyRejected(); return; }
    const a = host.game.adversaries.find((x) => x.id === this.id);
    if (a) this.schedule(this.nextDelay(a)); else this.status = 'gone';
  }

  // The synchronous back of the turn (inside the lock): validated by monsterTurnApply against the current world.
  finish(a, start, result, token, base) {
    const host = this.host;
    const game = host.game;
    const out = monsterTurnApply(game, a, start, result);
    host.afterMonsterTurn(out.events);
    host.record('monster_turn', {
      ...base, completed_at: game.clock,
      brain: out.turn.brain, dir: out.turn.dir, pos: [...a.pos], hp: a.hp,
      ...(out.stale ? { stale: out.stale } : {}),
      ...(out.turn.error ? { error: out.turn.error } : {}),
      events: out.events,
    });
    if (!game.adversaries.includes(a)) this.status = 'gone';
    else this.schedule(this.nextDelay(a));
  }
}
