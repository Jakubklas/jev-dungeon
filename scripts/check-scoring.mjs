// Checks for src/scoring.js: points, breakdown, every tie-break in order, forfeit, team score. Free, no Jev.
import { installTripwire } from './lib/tripwire.mjs';
import { rankParticipants, teamScore, DEFAULT_POINTS } from '../src/scoring.js';

const uninstall = installTripwire();
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log(`FAIL: ${msg}`); } };
const P = (id, o = {}) => ({ participant_id: id, name: id, slot: 0, joined_at: 0, coins: 0, strikes: 0, dispels: 0, portal: false, alive: true, forfeited: false, died_at: null, ...o });
const ids = (rows) => rows.map((r) => r.participant_id).join();

ok(JSON.stringify(DEFAULT_POINTS) === JSON.stringify({ coin: 10, strike: 3, dispel: 20, portal: 30, alive: 15 }), 'default points');

// points and breakdown: a dispel is a strike too
{
  const [r] = rankParticipants([P('a', { coins: 2, strikes: 4, dispels: 1, portal: true })]);
  ok(r.points === 20 + 12 + 20 + 30 + 15, `points sum (${r.points})`);
  ok(JSON.stringify(r.breakdown) === JSON.stringify({ coins: 20, strikes: 12, dispels: 20, portal: 30, alive: 15 }), 'breakdown');
  ok(['participant_id', 'name', 'slot', 'coins', 'strikes', 'dispels', 'portal', 'alive', 'forfeited', 'points', 'breakdown'].every((k) => k in r), 'row shape');
  const [c] = rankParticipants([P('a', { coins: 1 })], { points: { coin: 5, alive: 0 } });
  ok(c.points === 5 && c.breakdown.alive === 0, 'custom points');
}

// dead keeps coins, no alive bonus
{
  const [r] = rankParticipants([P('d', { coins: 3, alive: false, died_at: 10 })]);
  ok(r.points === 30 && r.alive === false && r.breakdown.alive === 0, 'dead keeps coins, loses alive bonus');
}

// forfeit: no alive bonus, marked, totals kept, even if flagged alive
{
  const [r] = rankParticipants([P('f', { coins: 2, strikes: 1, forfeited: true, alive: true })]);
  ok(r.forfeited && !r.alive && r.points === 23 && r.breakdown.alive === 0, 'forfeit marked, no alive bonus, totals kept');
}

// ordering by points
ok(ids(rankParticipants([P('a', { coins: 1 }), P('b', { coins: 3 })])) === 'b,a', 'more points first');

// tie-break 1: more dispels (equal points: 1 dispel = 20 vs 2 coins = 20)
{
  const rows = rankParticipants([P('coins', { coins: 2 }), P('disp', { dispels: 1 })]);
  ok(rows[0].points === rows[1].points && ids(rows) === 'disp,coins', 'tie: more dispels');
}
// tie-break 2: more coins (3 coins = 30 vs 10 strikes = 30)
{
  const rows = rankParticipants([P('strk', { strikes: 10 }), P('coin', { coins: 3 })]);
  ok(rows[0].points === rows[1].points && ids(rows) === 'coin,strk', 'tie: more coins');
}
// tie-break 3: later death, survivors first (dead both: equal points)
{
  const rows = rankParticipants([
    P('early', { alive: false, died_at: 100, joined_at: 0 }),
    P('late', { alive: false, died_at: 900, joined_at: 5 }),
  ]);
  ok(ids(rows) === 'late,early', 'tie: later death first');
  // survivor vs dead with equal points: 15 alive == 15 from 1.5 coins is not possible; use strikes 5 = 15
  const m = rankParticipants([P('dead', { alive: false, died_at: 50, strikes: 5, joined_at: 0 }), P('live', { joined_at: 9 })]);
  ok(m[0].points === m[1].points && ids(m) === 'live,dead', 'tie: survivor before the dead, despite later join');
}
// tie-break 4: earlier join
{
  const rows = rankParticipants([P('second', { joined_at: 20, slot: 1 }), P('first', { joined_at: 10, slot: 0 })]);
  ok(ids(rows) === 'first,second', 'tie: earlier join');
}
// precedence: dispels beat coins beat death time beat join
{
  const rows = rankParticipants([
    P('x', { coins: 2, alive: false, died_at: 999, joined_at: 0 }),
    P('y', { dispels: 1, alive: false, died_at: 1, joined_at: 9 }),
  ]);
  ok(ids(rows) === 'y,x', 'dispels outrank later death');
}
// final fallback is stable
ok(ids(rankParticipants([P('b', { slot: 1 }), P('a', { slot: 0 })])) === 'a,b', 'slot fallback');

// team score and purity
{
  const input = [P('a', { coins: 1 }), P('b', { coins: 2, alive: false, died_at: 3 }), P('c', { forfeited: true })];
  const before = JSON.stringify(input);
  const rows = rankParticipants(input);
  ok(JSON.stringify(input) === before, 'input not mutated');
  ok(teamScore(rows) === 25 + 20 + 0 && teamScore([]) === 0, `team score is the sum (${teamScore(rows)})`);
  ok(JSON.stringify(rankParticipants(input)) === JSON.stringify(rows), 'deterministic');
}

uninstall();
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('check-scoring: all passed');
