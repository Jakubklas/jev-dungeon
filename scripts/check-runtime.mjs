// The hosted runtime (PLAN-multiplayer-impl WP-E): GameActor with ExplorerActor / MonsterActor on a FakeClock. Every Jev
// call is a stub (controlled promises: instant, hanging, manual or failing), the fetch tripwire is installed, nothing is
// paid. Covers: nothing runs before start(); the mutation queue; cadence and no backlog; a slow explorer stops nobody;
// late and old-generation answers never apply; a late sword swings at the old cells and misses; pause freezes grace,
// cooldowns and Dash and resume continues them; seq, one record per action, observed/completed/applied times; no world
// write outside the lock; key rejection (one explorer), forfeit, server-key rejection (pauses the game); team win and
// team loss. Run: JEV_CONFIG=none node scripts/check-runtime.mjs
import { installTripwire } from './lib/tripwire.mjs';
const uninstall = installTripwire();
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { buildSkillSet } from '../src/skills/loadouts.js';
import { GameActor } from '../src/runtime/game-actor.js';
import { FakeClock, MonotonicClock, settle } from '../src/runtime/clock.js';
import { CallAborted, CallFailed, CallTimeout, KeyRejected } from '../src/gateway/errors.js';
import { moveIntervalMs } from '../src/characters/adversary/adversary.js';

const root = mkdtempSync(join(tmpdir(), 'jev-runtime-check-'));
let n = 0;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log(`FAIL: ${msg}`); } };
const dirs = () => { const f = join(root, String(++n)); mkdirSync(f); return pathToFileURL(f + '/'); };

// Seeded Math.random (the option shuffles use it), so a failure replays.
let seedState = 11;
Math.random = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 2 ** 32; };

// ---- stubs --------------------------------------------------------------------------------------------------------
// The default explorer answer: bold, engage, the sword whenever offered, the first move that is not `stay`.
function defaultAnswer({ questions }) {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : 0.9 }];
    const ids = Object.keys(q.criteria);
    let choice = ids[0];
    if (key === 'sentiment') choice = ids.includes('bold') ? 'bold' : ids[0];
    else if (key === 'tactic') choice = ids.includes('engage') ? 'engage' : ids[0];
    else if (key === 'skill') choice = ids.find((id) => id.startsWith('sword_strike')) ?? 'none';
    else if (key.startsWith('move_if_') || key === 'next_move') choice = ids.find((id) => id !== 'stay') ?? ids[0];
    return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}
// Modes: 'instant' answers at once, 'manual' parks each call until the check resolves it, 'hang' never answers.
// `fail` (a function returning an error) rejects every call. `ignoreAbort`: the stub does not watch the signal (the
// generation guard must catch the late answer on its own).
class Stub {
  constructor(mode = 'instant', answer = defaultAnswer) { this.mode = mode; this.answer = answer; this.calls = []; this.waiting = []; this.fail = null; this.ignoreAbort = false; this.aborted = 0; }
  asker() {
    return (req) => {
      this.calls.push(req);
      const err = this.fail?.();
      if (err) return Promise.reject(err);
      if (this.mode === 'instant') return Promise.resolve(this.answer(req));
      return new Promise((resolve, reject) => {
        this.waiting.push({ req, resolve: (a) => resolve(a ?? this.answer(req)), reject });
        if (!this.ignoreAbort) req.signal?.addEventListener('abort', () => { this.aborted++; reject(new CallAborted()); }, { once: true });
      });
    };
  }
  // Resolves the oldest parked call of `kind` (any kind when omitted); false when none is parked.
  release(kind = null, answer = null) {
    const i = this.waiting.findIndex((w) => !kind || w.req.kind === kind);
    if (i < 0) return false;
    const [w] = this.waiting.splice(i, 1);
    w.resolve(answer);
    return true;
  }
}
// The monsters' stub: first listed move, a claw whenever one is offered.
function clawAnswer({ questions }) {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { noul: 0.9 }];
    const ids = Object.keys(q.criteria);
    const choice = key === 'skill' ? (ids.find((id) => id !== 'none') ?? 'none') : ids[0];
    return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}
class MonsterStub {
  constructor(mode = 'instant') { this.mode = mode; this.calls = []; this.waiting = []; this.fail = null; }
  decider() {
    return (req) => {
      this.calls.push(req);
      const err = this.fail?.();
      if (err) return Promise.reject(err);
      if (this.mode === 'instant') return Promise.resolve(clawAnswer(req));
      return new Promise((resolve, reject) => { this.waiting.push({ req, resolve: (a) => resolve(a ?? clawAnswer(req)), reject }); });
    };
  }
  release() { const w = this.waiting.shift(); if (!w) return false; w.resolve(); return true; }
}

// An arena + its runtime. `stubs`: { explorer: Stub, explorer2: Stub }; `monster`: MonsterStub.
function setup(config, { stubs = {}, monster = new MonsterStub(), skills = undefined, autoplay = false, hooks = {} } = {}) {
  const d = dirs();
  const all = new Map();
  const stubOf = (id) => { if (!all.has(id)) all.set(id, stubs[id] ?? new Stub()); return all.get(id); };
  const run = newTestGame(config, { askFor: (id) => stubOf(id).asker(), decide: monster.decider(), memoryDir: d, dir: d, confidence: { fixedMood: true }, ...(skills ? { skills } : {}) });
  const clock = new FakeClock();
  const records = [];
  const actor = new GameActor({ game: run.game, clock, explorers: run.explorers, decideMonster: monster.decider(), autoplay, onEvent: (r) => records.push(r), onError: (e) => { fails++; console.log('FAIL: runtime fault', e); }, ...hooks });
  return { run, game: run.game, clock, actor, records, stubOf, monster, brain: (id = 'explorer') => run.explorers.find((e) => e.id === id).brain };
}
// start() arms the timers; the first decisions begin when the fake clock reaches them.
const kick = async (s) => { await s.actor.start(); s.clock.advance(0); await settle(); };
const sync = (s) => s.actor.enqueue(() => s.actor.syncClock()); // writes game.clock now (it is only written inside critical sections)
const of = (records, type, actor = null) => records.filter((r) => r.type === type && (!actor || r.actor === actor));
const ACTIONS = ['explorer_turn', 'monster_turn', 'decision_failed', 'decision_dropped'];

// A closed room with a ghost sealed off behind a wall: explorers move freely and the ghost patrols its own half.
const SPLIT = ['#######################', '#@....#...............#', '#.....#...............#', '#.....#...............#', '#######################'];
const CLOSE = ['#########', '#.......#', '#..@A...#', '#.......#', '#########']; // explorer and a ghost next to it

// ---- 1. nothing runs before start(); the queue ----------------------------------------------------------------------
{
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 0, adversaries: [[10, 2]] });
  await s.clock.tick(2000);
  ok(s.actor.state === 'idle' && s.records.length === 0 && s.game.clock === 0 && s.stubOf('explorer').calls.length === 0, 'autoplay false: nothing runs, no record, no Jev call, no clock before start()');
  ok(s.game.managed === true, 'the runtime sets game.managed');
  await s.actor.start();
  ok(s.actor.state === 'running' && s.records[0]?.type === 'game_started', 'start() runs and logs game_started');
  await s.clock.tick(300);
  ok(of(s.records, 'explorer_turn').length >= 2, `an explorer decides after start (${of(s.records, 'explorer_turn').length} turns)`);
  await s.actor.stop();

  const order = [];
  const q = setup({ map: SPLIT, treasure: null, numAdversaries: 0 });
  const p1 = q.actor.enqueue(() => { order.push('a1'); q.actor.enqueue(() => { order.push('inner'); }); order.push('a2'); return 'A'; });
  const p2 = q.actor.enqueue(() => { order.push('b'); return 'B'; });
  ok(order.join() === 'a1,a2,inner,b' && (await p1) === 'A' && (await p2) === 'B', `commands run one at a time to completion, a nested one waits (${order.join()})`);
  const bad = q.actor.enqueue(() => { throw new Error('boom'); });
  let caught = null; await bad.catch((e) => { caught = e; });
  ok(caught?.message === 'boom' && q.actor.inLock === false, 'a throwing command rejects its promise and releases the lock');

  const auto = setup({ map: SPLIT, treasure: null, numAdversaries: 0 }, { autoplay: true });
  await auto.clock.tick(200);
  ok(auto.actor.state === 'running' && of(auto.records, 'explorer_turn').length >= 1, 'autoplay: true starts at construction');
  await auto.actor.stop();
}

// ---- 2. cadence, times, seq; a stall leaves no backlog --------------------------------------------------------------
{
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]] });
  await s.actor.start();
  await s.clock.tick(3000);
  const turns = of(s.records, 'explorer_turn');
  ok(turns.length >= 10 && turns.length <= 3000 / 90 + 1, `cadence: ${turns.length} explorer turns in 3 s (at most one per 90 ms)`);
  let gapOk = true;
  for (let i = 1; i < turns.length; i++) if (turns[i].observed_at < turns[i - 1].applied_at + 90) gapOk = false;
  ok(gapOk, 'the next decision starts at least cadenceMs after the previous apply');
  ok(turns.every((t) => t.observed_at <= t.completed_at && t.completed_at <= t.applied_at && t.generation === 0), 'observed_at <= completed_at <= applied_at');
  ok(s.records.every((r, i) => r.seq === i + 1), 'seq is strictly increasing, 1, 2, 3, ... with no gap');
  ok(s.records.every((r, i) => i === 0 || r.applied_at >= s.records[i - 1].applied_at), 'applied_at never goes back');
  await sync(s);
  ok(s.game.clock === 3000 && s.actor.clockNow() === 3000, `game.clock follows the runtime clock (${s.game.clock})`);
  const mon = of(s.records, 'monster_turn', 'a1');
  const interval = moveIntervalMs(s.game, s.game.adversaries[0]);
  ok(mon.length >= 3000 / interval - 2 && mon.length <= 3000 / interval + 1, `a patrolling monster turns every moveIntervalMs (${mon.length} turns, interval ${Math.round(interval)} ms)`);
  ok(mon.every((m) => m.brain === 'off'), 'the sealed-off monster patrols with its brain off (no Jev)');
  ok(s.monster.calls.length === 0, 'no monster Jev call for a patrolling monster');

  // A stall: the explorer's answer arrives 60 s late. One apply, then the next decision cadence later: no catch-up.
  const st = new Stub('manual');
  const t = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]] }, { stubs: { explorer: st } });
  await t.actor.start();
  await t.clock.tick(60_000, 100);
  ok(of(t.records, 'explorer_turn').length === 0 && t.actor.inFlight('explorer'), 'a parked explorer has no turn and one decision in flight');
  ok(st.calls.length === 1, `one decision in flight at most (${st.calls.length} call while it waits)`);
  ok(of(t.records, 'monster_turn').length >= 60_000 / interval - 5, 'the monster kept moving through the stall');
  while (st.waiting.length) { st.release(); await settle(); }
  await settle();
  const first = of(t.records, 'explorer_turn');
  ok(first.length === 1 && first[0].applied_at >= 60_000, `the late answer applies once (${first.length})`);
  for (let i = 0; i < 6 && !st.waiting.length; i++) await t.clock.tick(20);
  const nextCall = st.calls.length;
  ok(nextCall >= 2, 'the next decision started after the apply');
  await t.clock.tick(0);
  ok(of(t.records, 'explorer_turn').length === 1, 'no backlog: no catch-up turns for the stalled minute');
  await t.actor.stop();

  // One long advance without settling starts at most one decision per actor.
  const u = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]] });
  await u.actor.start();
  u.clock.advance(10_000);
  await settle();
  ok(u.stubOf('explorer').calls.length <= 2, `a 10 s jump starts one decision, not a backlog (${u.stubOf('explorer').calls.length} calls)`);
  await u.actor.stop();
}

// ---- 3. a slow explorer stops nobody ----------------------------------------------------------------------------------
{
  const slow = new Stub('hang');
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]], explorers: [[3, 3]] }, { stubs: { explorer2: slow } });
  await s.actor.start();
  await s.clock.tick(3000);
  ok(of(s.records, 'explorer_turn', 'explorer').length >= 10, `the fast explorer kept playing (${of(s.records, 'explorer_turn', 'explorer').length} turns)`);
  ok(of(s.records, 'explorer_turn', 'explorer2').length === 0 && s.actor.inFlight('explorer2') && slow.calls.length === 1, 'the slow explorer is in flight with one call');
  ok(of(s.records, 'monster_turn').length >= 3, 'the monster kept moving');
  await s.actor.stop();
}

// ---- 4. a late sword swings at the old cells and misses a ghost that moved ---------------------------------------------
async function swordCase(moveGhost) {
  const st = new Stub('manual');
  const s = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3 }, { stubs: { explorer: st } });
  await kick(s);
  st.release('sentiment');
  await settle();
  const tickCall = st.waiting.find((w) => w.req.kind === 'tick');
  const ghost = s.game.adversaries[0];
  if (moveGhost) ghost.pos = [ghost.pos[0] + 1, ghost.pos[1] + 1]; // out of the aimed cells, still in sight
  const hp = ghost.hp;
  st.release('tick');
  await settle();
  const turn = of(s.records, 'explorer_turn')[0];
  await s.actor.stop();
  return { turn, hpLost: hp - ghost.hp, hadTick: Boolean(tickCall), clock: s.game.clock };
}
{
  const hit = await swordCase(false);
  ok(hit.hadTick && hit.turn?.skill?.startsWith('sword_strike') && hit.hpLost === 1 && hit.turn.strikes[0]?.result !== 'miss', `a fresh sword lands (${hit.turn?.skill}, hp lost ${hit.hpLost}, ${JSON.stringify(hit.turn?.strikes)})`);
  const miss = await swordCase(true);
  ok(miss.turn?.skill?.startsWith('sword_strike') && miss.hpLost === 0, `a late sword does not retarget (hp lost ${miss.hpLost})`);
  ok(miss.turn?.strikes?.length === 1 && miss.turn.strikes[0].result === 'miss', `the late sword swings and misses (${JSON.stringify(miss.turn?.strikes)})`);
  ok(miss.turn?.stale?.some(([k, r]) => k === 'skill' && /old cells/.test(r)) && miss.turn.skill_used === miss.turn.skill, `reported as a swing at the old cells (${JSON.stringify(miss.turn?.stale)})`);
}

// ---- 5. an aborted, paused or old-generation answer never applies ---------------------------------------------------------
{
  // pause during a call: the call is aborted, the late answer (even from a stub that ignores the signal) does nothing
  for (const ignore of [false, true]) {
    const st = new Stub('manual');
    st.ignoreAbort = ignore;
    const s = setup({ map: SPLIT, treasure: null, numAdversaries: 0 }, { stubs: { explorer: st } });
    await kick(s);
    const gen = s.actor.generation('explorer');
    await s.actor.pause('test');
    ok(s.actor.generation('explorer') === gen + 1 && !s.actor.inFlight('explorer'), 'pause bumps the generation and clears the in-flight decision');
    ok(ignore || st.aborted === 1, 'pause aborts the transport signal');
    const pos = [...s.game.pos];
    const steps = s.game.steps;
    st.release('sentiment');
    await settle();
    st.release('tick');
    await s.clock.tick(500);
    ok(s.game.steps === steps && s.game.pos[0] === pos[0] && s.game.pos[1] === pos[1] && of(s.records, 'explorer_turn').length === 0, `a late answer after pause never applies (ignoreAbort ${ignore})`);
    await s.actor.stop();
  }
  // forfeit during a call: dropped
  const st = new Stub('manual');
  st.ignoreAbort = true;
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 0, explorers: [[3, 3]] }, { stubs: { explorer2: st } });
  await kick(s);
  await s.actor.forfeitExplorer('explorer2');
  st.release('sentiment'); await settle(); st.release('tick'); await settle();
  ok(of(s.records, 'explorer_turn', 'explorer2').length === 0 && s.game.explorer('explorer2').steps === 0, 'an answer that outlives a forfeit never applies');
  await s.actor.stop();
}

// ---- 6. pause freezes grace, cooldowns and Dash; resume continues them ---------------------------------------------------------
{
  const skills = buildSkillSet(['sword_strike', 'dash']);
  const dash = skills.skills.find((k) => k.id === 'dash');
  const st = new Stub('hang');
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 0 }, { stubs: { explorer: st }, skills });
  await s.actor.start();
  await s.clock.tick(1000);
  await sync(s);
  dash.markUsed(0); // 20 s cooldown from world time 1000
  s.game.setGrace(s.game.explorers[0], 4); // 1600 ms of protection
  await s.clock.tick(400);
  await s.actor.pause();
  const cdBefore = dash.cooldownLeft;
  const graceBefore = s.game.timersLeft().explorers.explorer.grace;
  const clockBefore = s.game.clock;
  ok(clockBefore === 1400 && graceBefore === 4 * s.game.rules.stepMs - 400, `pause syncs the clock first (clock ${clockBefore}, grace left ${graceBefore})`);
  await s.clock.tick(30_000, 1000);
  ok(s.game.clock === clockBefore, `paused: game.clock stands still (${s.game.clock} vs ${clockBefore})`);
  ok(dash.cooldownLeft === cdBefore && s.game.timersLeft().explorers.explorer.grace === graceBefore, `paused: Dash cooldown (${dash.cooldownLeft}s) and grace (${graceBefore} ms) keep their remaining time`);
  ok(s.game.graceActive(s.game.explorers[0]), 'paused: the explorer is still protected after 30 s of pause');
  await s.actor.resume();
  await s.clock.tick(500);
  await sync(s);
  ok(s.game.clock === clockBefore + 500, `resume re-anchors: the clock moved only by the time since resume (${s.game.clock - clockBefore})`);
  const graceAfter = s.game.timersLeft().explorers.explorer.grace;
  ok(graceAfter === graceBefore - 500, `grace continued from where it stopped (${graceBefore} -> ${graceAfter})`);
  await s.clock.tick(21_000, 1000);
  await sync(s);
  ok(dash.cooldownLeft === 0, 'Dash follows the game clock and is ready after its 20 s of world time');
  ok(of(s.records, 'game_paused').length === 1 && of(s.records, 'game_resumed').length === 1, 'pause and resume are logged once each');
  await s.actor.stop();
}

// ---- 7. no world write outside the lock; one record per action -------------------------------------------------------------
{
  const st = new Stub('manual');
  const s = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3, explorers: [[6, 3]] }, { stubs: { explorer: st }, monster: new MonsterStub('manual') });
  const g = s.game;
  const writes = [];
  for (const name of ['applyMove', 'damage', 'setGrace', 'forfeit', 'respawnHearts', 'regenerate']) {
    const real = g[name].bind(g);
    g[name] = (...a) => { if (!s.actor.inLock) writes.push(name); return real(...a); };
  }
  await s.actor.start();
  await settle();
  const before = JSON.stringify([g.explorers[0].pos, g.explorers[0].steps, g.explorers[0].health]);
  await s.clock.tick(2000);
  ok(st.waiting.length >= 1 && !of(s.records, 'explorer_turn', 'explorer').length, 'the explorer is awaiting a decision');
  ok(JSON.stringify([g.explorers[0].pos, g.explorers[0].steps, g.explorers[0].health]) === before, 'a pending decision leaves its explorer untouched while it awaits');
  st.release(); await settle(); st.release(); await settle();
  await s.clock.tick(1500);
  ok(writes.length === 0, `no world mutation outside the lock (${writes.join()})`);
  await s.actor.stop();
}
{
  // one record per applied action: count the brain applies and the failures against the records
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]], explorers: [[3, 3]] });
  let calls = 0;
  s.stubOf('explorer').fail = () => (++calls % 4 === 0 ? new CallFailed(500, 'x') : null);
  const applies = { explorer: 0, explorer2: 0 };
  for (const id of ['explorer', 'explorer2']) { const b = s.brain(id); const apply = b.apply.bind(b); b.apply = (i) => { applies[id]++; return apply(i); }; }
  await s.actor.start();
  await s.clock.tick(4000);
  const turns = of(s.records, 'explorer_turn');
  ok(turns.length === applies.explorer + applies.explorer2 && turns.length > 20, `exactly one explorer_turn record per brain.apply (${turns.length} vs ${applies.explorer + applies.explorer2})`);
  ok(of(s.records, 'decision_failed').length >= 1 && of(s.records, 'decision_failed').every((r) => r.reason === 'failed'), `a failed decision is one decision_failed record (${of(s.records, 'decision_failed').length})`);
  const seqs = s.records.map((r) => r.seq);
  ok(seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1), 'event seq strictly increasing');
  ok(s.records.filter((r) => ACTIONS.includes(r.type)).every((r) => r.actor && r.generation !== null && r.observed_at !== null && r.completed_at !== null), 'every action record carries actor, generation and the three times');
  await s.actor.stop();
}

// ---- 8. failures cost only that decision ------------------------------------------------------------------------------------
{
  const st = new Stub('instant');
  let k = 0;
  st.fail = () => (++k <= 2 ? new CallTimeout(7000) : null);
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 0 }, { stubs: { explorer: st } });
  await s.actor.start();
  await s.clock.tick(1000);
  const failed = of(s.records, 'decision_failed');
  ok(failed.length === 2 && failed.every((r) => r.reason === 'timeout') && s.actor.actorStatus('explorer') === 'active', 'a timeout is one decision_failed record and the explorer stays active');
  ok(failed[1].observed_at >= failed[0].applied_at + 90, 'the next decision is a cadence after the failure');
  ok(of(s.records, 'explorer_turn').length >= 3, 'the explorer plays on after the failures');
  await s.actor.stop();
}

// ---- 9. a rejected key stops one explorer; forfeit removes it -----------------------------------------------------------
{
  const bad = new Stub('instant');
  bad.fail = () => new KeyRejected(401);
  const rejected = [];
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]], explorers: [[3, 3]] }, { stubs: { explorer2: bad }, hooks: { onKeyRejected: (id) => rejected.push(id) } });
  await s.actor.start();
  await s.clock.tick(1500);
  ok(s.actor.actorStatus('explorer2') === 'awaiting_key' && rejected.join() === 'explorer2', `explorer2 awaits a key; the hook fired once (${rejected.join()})`);
  const callsAfter = bad.calls.length;
  const e1 = of(s.records, 'explorer_turn', 'explorer').length;
  const m1 = of(s.records, 'monster_turn').length;
  await s.clock.tick(1500);
  ok(bad.calls.length === callsAfter && callsAfter === 1, `a rejected explorer makes no further call (${callsAfter})`);
  ok(of(s.records, 'explorer_turn', 'explorer').length > e1 && of(s.records, 'monster_turn').length > m1, 'the other explorer and the monsters continue');
  ok(of(s.records, 'decision_failed').length === 1 && of(s.records, 'decision_failed')[0].reason === 'key_rejected', 'one decision_failed record, reason key_rejected');
  // a new key arrives: resumeExplorer re-arms it
  bad.fail = null;
  await s.actor.resumeExplorer('explorer2');
  await s.clock.tick(500);
  ok(s.actor.actorStatus('explorer2') === 'active' && of(s.records, 'explorer_turn', 'explorer2').length >= 1, 'resumeExplorer re-arms the explorer and it decides again');
  // forfeit: gone from occupancy and targets, generation bumped
  const cell = [...s.game.explorer('explorer2').pos];
  const gen = s.actor.generation('explorer2');
  ok(s.game.explorerAt(cell)?.id === 'explorer2', 'before the forfeit it occupies its cell');
  await s.actor.forfeitExplorer('explorer2');
  ok(s.actor.actorStatus('explorer2') === 'forfeited' && s.actor.generation('explorer2') > gen && s.game.explorer('explorer2').status === 'forfeited', 'forfeit bumps the generation and marks it forfeited');
  ok(!s.game.explorerAt(cell), 'a forfeited explorer no longer occupies a cell');
  ok(s.game.targetExplorer(cell)?.id === 'explorer' && !s.game.activeExplorers().some((e) => e.id === 'explorer2'), 'monsters no longer target it');
  const n2 = of(s.records, 'explorer_turn', 'explorer2').length;
  await s.clock.tick(800);
  ok(of(s.records, 'explorer_turn', 'explorer2').length === n2 && s.actor.state === 'running', 'the forfeited explorer never plays again and the game goes on');
  ok(s.actor.state === 'running' && !s.game.lost, 'one explorer left: the game is not lost');
  await s.actor.forfeitExplorer('explorer');
  ok(s.game.lost && s.actor.state === 'finished' && s.actor.outcome.result === 'lost', 'forfeiting the last active explorer loses the game');
  await s.actor.stop();
}

// ---- 10. a rejected server key pauses the game --------------------------------------------------------------------------------
{
  const mon = new MonsterStub('instant');
  mon.fail = () => new KeyRejected(403);
  let hookCalls = 0;
  const s = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3 }, { stubs: { explorer: new Stub('hang') }, monster: mon, hooks: { onServerKeyRejected: () => hookCalls++ } });
  await s.actor.start();
  await s.clock.tick(1500);
  ok(hookCalls === 1 && s.actor.state === 'paused', `a server-key rejection fires the hook once and pauses the game (${hookCalls}, ${s.actor.state})`);
  ok(of(s.records, 'decision_failed').some((r) => r.reason === 'key_rejected' && r.server_key) && of(s.records, 'game_paused')[0]?.reason === 'server_key_rejected', 'logged as decision_failed + game_paused(server_key_rejected)');
  const clock = s.game.clock;
  const nrec = s.records.length;
  await s.clock.tick(3000);
  ok(s.game.clock === clock && s.records.length === nrec && s.game.frozen, 'the paused game does not move');
  ok(of(s.records, 'monster_turn').every((r) => !r.events.some((e) => e.type === 'hit')), 'the rejected monster turn was not applied');
  mon.fail = null;
  await s.actor.resume();
  await s.clock.tick(1500);
  ok(s.actor.state === 'running' && of(s.records, 'monster_turn').length > 0, 'after the operator fixes the key, resume() continues');
  await s.actor.stop();
}

// ---- 11. a stale claw hits whoever stands in its cells now (a miss when the explorer left) ------------------------------------------
{
  const mon = new MonsterStub('manual');
  const s = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3 }, { stubs: { explorer: new Stub('hang') }, monster: mon });
  await s.actor.start();
  await s.clock.tick(900, 50);
  ok(mon.waiting.length === 1, 'the hunting monster parked its decision');
  const hp = s.game.health;
  s.game.explorers[0].pos = [6, 3]; // the explorer stepped away from the claw's cells
  mon.release();
  await settle();
  const t = of(s.records, 'monster_turn').at(-1);
  ok(s.game.health === hp && !t.events.some((e) => e.type === 'hit'), 'a claw whose target left hits nobody');
  await s.actor.stop();
  const m2 = new MonsterStub('manual');
  const q = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3 }, { stubs: { explorer: new Stub('hang') }, monster: m2 });
  await q.actor.start();
  await q.clock.tick(900, 50);
  m2.release();
  await settle();
  ok(q.game.health < 4 && of(q.records, 'monster_turn').at(-1).events.some((e) => e.type === 'hit'), 'the claw hits the explorer where it still stands');
  await q.actor.stop();
}

// ---- 12. a Dash whose path closed since the observation stops early ---------------------------------------------------------------------
{
  const dashDown = (req) => {
    const out = defaultAnswer(req);
    if (out.skill) out.skill = { choice: 'dash', probabilities: { dash: 1 }, confidence: 1 };
    for (const key of Object.keys(req.questions)) if (key === 'next_move' || key.startsWith('move_if_')) {
      const ids = Object.keys(req.questions[key].criteria);
      const c = ids.includes('down') ? 'down' : ids[0];
      out[key] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
    }
    return out;
  };
  const room = ['############', '#..........#', '#@.........#', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '############'];
  const skills = buildSkillSet(['sword_strike', 'dash']);
  const st = new Stub('manual', dashDown);
  const s = setup({ map: room, treasure: null, numAdversaries: 1, adversaries: [[9, 2]] }, { stubs: { explorer: st }, skills });
  await kick(s);
  st.release('sentiment');
  await settle();
  const tick = st.waiting.find((w) => w.req.kind === 'tick');
  ok(tick?.req.questions.skill && 'dash' in tick.req.questions.skill.criteria, 'the dash option is offered with an enemy near');
  const row = s.game.dungeon.tiles[4];
  s.game.dungeon.tiles[4] = typeof row === 'string' ? row.slice(0, 1) + '#' + row.slice(2) : row.map((c, x) => (x === 1 ? '#' : c)); // a wall appears 2 cells below
  st.release('tick');
  await settle();
  const t = of(s.records, 'explorer_turn')[0];
  ok(t && t.skill === 'dash' && s.game.pos[0] === 1 && s.game.pos[1] === 3, `the dash stops before the new wall at (1,3) (now ${s.game.pos})`);
  await s.actor.stop();
}

// ---- 13. team win at the portal; team loss ------------------------------------------------------------------------------------------
{
  const toPortal = (req) => {
    const out = defaultAnswer(req);
    for (const key of Object.keys(req.questions)) if (key === 'next_move' || key.startsWith('move_if_')) {
      const ids = Object.keys(req.questions[key].criteria);
      const c = ids.includes('right') ? 'right' : ids[0];
      out[key] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
    }
    if (out.skill) out.skill = { choice: 'none', probabilities: { none: 1 }, confidence: 1 };
    return out;
  };
  const fin = [];
  const other = new Stub('hang');
  const s = setup({ map: ['###########', '#@T.......#', '###########', '###########', '###########'], treasure: [2, 1], numAdversaries: 0, explorers: [[8, 1]] }, { stubs: { explorer: new Stub('instant', toPortal), explorer2: other }, hooks: { onFinished: (o) => fin.push(o) } });
  await s.actor.start();
  await s.clock.tick(1500);
  ok(s.game.won && s.actor.state === 'finished', 'the first explorer through the portal wins the game for the team');
  ok(fin.length === 1 && fin[0].result === 'won' && fin[0].winner === 'explorer' && fin[0].explorers.length === 2 && fin[0].explorers.find((e) => e.id === 'explorer2').status === 'active', 'one onFinished with the winner and every explorer in the result');
  const over = of(s.records, 'game_over');
  ok(over.length === 1 && s.records.at(-1).type === 'game_over', 'game_over is the last record');
  ok(s.clock.pending === 0 && !s.actor.inFlight('explorer2') && other.aborted === 1, 'everything stopped: no timers, the other explorer\'s call aborted');
  const n1 = s.records.length;
  await s.clock.tick(2000);
  ok(s.records.length === n1, 'nothing is scheduled after the game ends');

  // team loss: the only explorer dies to a claw
  const mon = new MonsterStub('instant');
  const lost = new Stub('hang');
  const l = setup({ map: CLOSE, treasure: null, numAdversaries: 1, ghostHp: 3 }, { stubs: { explorer: lost }, monster: mon });
  l.game.explorers[0].health = 1;
  await l.actor.start();
  await l.clock.tick(2500, 50);
  ok(l.game.lost && l.actor.outcome?.result === 'lost' && l.actor.outcome.caught_by === 'a1' && l.actor.state === 'finished', `no active explorer left: team loss (${l.actor.outcome?.result})`);
  ok(l.actor.actorStatus('explorer') === 'dead' && lost.aborted === 1, 'the dead explorer\'s generation was bumped and its call aborted');
  await l.actor.whenIdle();
  ok(l.brain().memory.events.some((e) => /Caught by a1/.test(e.text)), 'the explorer brain was told it was caught (noteCaught)');

  // one dies, the other plays on
  const two = setup({ map: ['#########', '#.......#', '#..@A...#', '#.......#', '#...#...#', '#########'], treasure: null, numAdversaries: 1, ghostHp: 3, explorers: [[1, 4]] }, { stubs: { explorer: new Stub('hang'), explorer2: new Stub('instant') }, monster: new MonsterStub('instant') });
  two.game.explorers[0].health = 1;
  await two.actor.start();
  await two.clock.tick(3000, 50);
  ok(two.game.explorers[0].status === 'dead' && two.game.explorers[1].status === 'active' && !two.game.lost && two.actor.state === 'running', 'one explorer dies, the team plays on');
  ok(of(two.records, 'explorer_turn', 'explorer2').length > 5, 'the surviving explorer keeps deciding');
  await two.actor.stop();
}

// ---- 14. stop(), the clocks, zero Jev ----------------------------------------------------------------------------------------------------
{
  const s = setup({ map: SPLIT, treasure: null, numAdversaries: 1, adversaries: [[10, 2]] });
  await s.actor.start();
  await s.clock.tick(500);
  await s.actor.stop();
  const n1 = s.records.length;
  await s.clock.tick(2000);
  ok(s.actor.state === 'stopped' && s.clock.pending === 0 && s.records.length === n1 && s.records.at(-1).type === 'game_stopped', 'stop() ends it: no timers, no more records');
  const mono = new MonotonicClock();
  const t0 = mono.now();
  await new Promise((r) => mono.setTimeout(r, 20));
  ok(mono.now() - t0 >= 15, 'MonotonicClock measures real time and runs timers');
}
ok(uninstall.wire.hits === 0, `the fetch tripwire was never hit (${uninstall.wire.hits})`);

if (fails) { console.log(`${fails} runtime check(s) failed`); process.exit(1); }
console.log('all runtime checks passed');
