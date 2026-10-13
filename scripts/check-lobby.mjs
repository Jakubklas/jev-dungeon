// Checks for src/service/lobby.js: membership, start/join race, leader transfer, expiry, key windows and forfeit,
// restart pause-until-keys, serialize round trip. Free, no Jev (fetch tripwire).
import { installTripwire } from './lib/tripwire.mjs';
import { Lobby } from '../src/service/lobby.js';

const uninstall = installTripwire();
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log(`FAIL: ${msg}`); } };
const err = (r, status, error, msg) => ok(r.ok === false && r.status === status && r.error === error, `${msg} (got ${JSON.stringify(r)})`);

let t = 1000;
const clock = () => t;
const mk = (o = {}) => new Lobby({ id: 'gm_x', mode: 'shared', createdAt: t, now: clock, ...o });
const j = (l, id, keyPresent = true) => l.join({ participantId: id, name: id, keyPresent });

// 1. waiting room
{
  const l = mk({ capacity: 3 });
  ok(l.status === 'waiting' && l.leader === null, 'starts waiting, no leader');
  err(l.start('p1'), 403, 'not_participant', 'start by a stranger');
  ok(j(l, 'p1').ok && l.leader === 'p1', 'first joiner leads');
  t += 10; j(l, 'p2'); t += 10; j(l, 'p3');
  err(j(l, 'p4'), 400, 'room_full', 'room full');
  err(j(l, 'p2'), 409, 'already_joined', 'double join');
  err(l.start('p2'), 403, 'not_leader', 'non-leader start');
  err(l.leave('zz'), 403, 'not_participant', 'leave by a stranger');
  const r = l.leave('p1');
  ok(r.ok && r.leaderChanged && l.leader === 'p2', 'leader transfers to the oldest remaining');
  ok(j(l, 'p1').ok && l.leader === 'p2', 'a returning leader does not take the lead back (joins last)');
  err(l.finish({}), 409, 'not_started', 'cannot finish a waiting room');
  err(l.pause(), 409, 'not_running', 'cannot pause a waiting room');
  const s = l.start('p2');
  ok(s.ok && l.status === 'running', 'leader starts');
  ok(l.participants.map((p) => `${p.participantId}:${p.slot}`).join() === 'p2:0,p3:1,p1:2', 'slots by join order');
  // the race: a join after the seal is rejected, slots do not move
  err(j(l, 'late'), 409, 'game_started', 'join after start');
  err(l.leave('p3'), 409, 'game_started', 'leave after start');
  err(l.start('p2'), 409, 'not_waiting', 'second start');
  ok(l.participant('p3').slot === 1, 'slot stable');
  ok(l.activeCount() === 3, 'all active after start');
  ok(l.participant('p3') && l.participant('late') === null, 'reconnect lookup, no join path');
}

// 2. empty roster, empty leave
{
  const l = mk();
  j(l, 'a');
  const r = l.leave('a');
  ok(r.ok && !r.leaderChanged && l.leader === null, 'last leaver leaves no leader');
  err(l.start('a'), 403, 'not_participant', 'start on empty roster is rejected');
  ok(l.participants.length === 0, 'empty');
}

// 3. private mode
{
  const l = mk({ mode: 'private', capacity: 4 });
  ok(l.capacity === 1, 'private has one slot');
  const r = j(l, 'solo');
  ok(r.ok && l.status === 'running' && l.participant('solo').slot === 0, 'private starts immediately');
  err(j(l, 'two'), 409, 'game_started', 'private rejects a second');
}

// 4. expiry
{
  t = 5000;
  const l = mk({ idleMs: 1000 });
  err(l.expire(), 409, 'not_expired', 'not expired yet');
  t += 900; j(l, 'a');
  t += 900;
  err(l.expire(), 409, 'not_expired', 'activity resets the clock');
  t += 200;
  ok(l.expire().ok && l.status === 'abandoned', 'expires after idleMs without membership activity');
  err(j(l, 'b'), 409, 'game_started', 'abandoned rooms take no joins');
  const d = mk();
  ok(d.idleMs === 30 * 60 * 1000 && d.keyRetryMs === 120000 && d.capacity === 4, 'defaults 30 min / 2 min / 4');
  const r = mk(); j(r, 'a'); r.start('a');
  err(r.expire(t + 1e9), 409, 'not_expired', 'running rooms never expire');
}

// 5. key window and forfeit
{
  t = 10000;
  const l = mk({ keyRetryMs: 1000 });
  j(l, 'a'); j(l, 'b'); l.start('a');
  const km = l.keyMissing('b', t);
  ok(km.ok && km.deadline === t + 1000 && l.participant('b').state === 'awaiting_key', 'awaiting_key with deadline');
  ok(l.activeCount() === 1, 'activeCount excludes awaiting_key');
  ok(l.tick(t + 999).length === 0, 'inside the window');
  ok(l.keyRestored('b').ok && l.participant('b').state === 'active' && l.participant('b').keyDeadline === null, 'key restored in time');
  ok(l.tick(t + 5000).length === 0, 'restored participant is not forfeited');
  l.keyMissing('b', t + 2000);
  const out = l.tick(t + 3000);
  ok(out.length === 1 && out[0] === 'b' && l.participant('b').state === 'forfeited', 'window ran out -> forfeited');
  ok(l.tick(t + 9000).length === 0, 'forfeit reported once');
  err(l.keyRestored('b'), 409, 'participant_forfeited', 'forfeit is final: key does not re-activate');
  err(l.keyMissing('b', t), 409, 'participant_forfeited', 'forfeited cannot await again');
  ok(l.participant('b').state === 'forfeited' && l.status === 'running', 'still forfeited, game goes on');
  err(l.keyMissing('zz', t), 403, 'not_participant', 'stranger');
  // death and team loss
  const d = l.died('a', t + 4000);
  ok(d.ok && d.teamLoss && l.status === 'finished' && l.result.outcome === 'team_loss', 'no one left -> team loss');
  err(l.died('a', t), 409, 'participant_dead', 'cannot die twice');
  ok(l.participant('a').diedAt === t + 4000, 'death time recorded');
}

// 6. team loss via forfeit; awaiting_key still counts as alive
{
  t = 20000;
  const l = mk({ keyRetryMs: 100 });
  j(l, 'a'); j(l, 'b'); l.start('a');
  l.keyMissing('a', t);
  l.died('b', t + 10);
  ok(l.status === 'running', 'an awaiting_key participant keeps the game alive');
  l.tick(t + 100);
  ok(l.status === 'finished' && l.result.outcome === 'team_loss', 'last forfeit ends the game');
}

// 7. pause/resume shifts key windows; tick idle while paused
{
  t = 30000;
  const l = mk({ keyRetryMs: 1000 });
  j(l, 'a'); l.start('a'); j(l, 'x');
  l.keyMissing('a', t);
  ok(l.pause('host', t + 100).ok, 'pause');
  err(l.pause(), 409, 'not_running', 'double pause');
  ok(l.tick(t + 5000).length === 0, 'no forfeit while paused');
  ok(l.resume(t + 5100).ok && l.status === 'running', 'resume');
  ok(l.participant('a').keyDeadline === t + 1000 + 5000, 'deadline shifted by the paused time');
  err(l.resume(), 409, 'not_paused', 'resume when running');
  ok(l.finish({ outcome: 'won' }).ok && l.status === 'finished', 'finish');
  err(l.finish({}), 409, 'not_running', 'finish twice');
}

// 8. restart: pause until keys
{
  t = 40000;
  const l = mk({ keyRetryMs: 1000 });
  j(l, 'a'); j(l, 'b'); j(l, 'c'); l.start('a');
  l.died('c', t);
  const snap = JSON.parse(JSON.stringify(l.serialize()));
  ok(!JSON.stringify(snap).match(/"key"|secret/i), 'serialized form carries no key field');
  const r = Lobby.restore(snap, { now: clock });
  ok(r.restoreAfterRestart().changed, 'restart changes a running game');
  ok(r.status === 'paused' && r.pauseReason === 'keys_needed', 'paused for keys');
  ok(r.participant('a').state === 'awaiting_key' && r.participant('a').keyDeadline === null && !r.participant('a').keyPresent, 'living -> awaiting_key, no deadline');
  ok(r.participant('c').state === 'dead', 'dead stays dead');
  ok(r.tick(t + 1e9).length === 0, 'no forfeit while waiting for keys');
  ok(!r.allKeysPresent(), 'keys missing');
  r.keyRestored('a');
  ok(r.participant('a').state === 'active' && !r.allKeysPresent() && r.status === 'paused', 'one key back, still paused');
  r.keyRestored('b');
  ok(r.allKeysPresent(), 'all living keys present -> service may auto-resume');
  ok(r.resume(t + 10).ok && r.status === 'running', 'auto-resume');
  // host resume path
  const h = Lobby.restore(snap, { now: clock });
  h.restoreAfterRestart();
  h.keyRestored('a');
  ok(h.hostResume(t + 500).ok && h.status === 'running', 'host resumes');
  ok(h.participant('b').keyDeadline === t + 1500 && h.participant('a').keyDeadline === null, 'only keyless get a window');
  ok(h.tick(t + 1499).length === 0 && h.tick(t + 1500).join() === 'b', 'keyless forfeits after keyRetryMs');
  ok(h.participant('a').state === 'active', 'participant with a key keeps playing');
  // restart twice and on non-running
  const w = mk(); j(w, 'a');
  ok(w.restoreAfterRestart().changed === false && w.status === 'waiting', 'waiting room unaffected by restart');
  const f = Lobby.restore(snap, { now: clock }); f.restoreAfterRestart(); f.restoreAfterRestart();
  ok(f.status === 'paused' && f.pauseReason === 'keys_needed', 'idempotent');
}

// 9. serialize round trip
{
  t = 50000;
  const l = mk({ keyRetryMs: 777 });
  j(l, 'a', false); j(l, 'b'); l.start('a'); l.keyMissing('b', t); l.died('a', t + 1);
  const s1 = l.serialize();
  const r = Lobby.restore(JSON.parse(JSON.stringify(s1)), { now: clock });
  ok(JSON.stringify(r.serialize()) === JSON.stringify(s1), 'round trip is exact');
  ok(r.keyRetryMs === 777 && r.participant('b').keyDeadline === t + 777, 'settings and deadlines survive');
  const w = mk(); j(w, 'a'); j(w, 'b');
  ok(JSON.stringify(Lobby.restore(w.serialize(), { now: clock }).serialize()) === JSON.stringify(w.serialize()), 'waiting round trip');
}

// 10. determinism: same calls, same state
{
  const run = () => { t = 70000; const l = mk(); j(l, 'a'); t += 1; j(l, 'b'); l.leave('a'); j(l, 'c'); l.start('b'); return JSON.stringify(l.serialize()); };
  ok(run() === run(), 'deterministic');
}

try { new Lobby({ mode: 'x' }); ok(false, 'bad mode throws'); } catch { /* expected */ }
try { new Lobby({ capacity: 0 }); ok(false, 'bad capacity throws'); } catch { /* expected */ }

uninstall();
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('check-lobby: all passed');
