// Unit checks for src/characters/shared/memory-kit.js. Pure, no game, no Jev.
import { addLandmarkTo, ageEntries, backAndForth, pushRing } from '../src/characters/shared/memory-kit.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg); } };

check(backAndForth([[0, 0], [1, 0], [0, 0], [1, 0]], 6) === 2, 'ping-pong counts twice');
check(backAndForth([[0, 0], [0, 0], [0, 0]], 6) === 0, 'standing still never counts');
check(backAndForth([[0, 0], [1, 0], [2, 0]], 6) === 0, 'a straight walk is not back-and-forth');
check(backAndForth([[0, 0], [1, 0], [0, 0], [1, 0]], 1) === 1, 'window limits the moves judged');

const ring = pushRing([1, 2, 3], 4, 3);
check(ring.join() === '2,3,4', 'pushRing keeps the newest');

let lm = [];
const opts = { max: 3, noteMax: 5, pinnedKind: 'home' };
lm = addLandmarkTo(lm, { kind: 'home', cell: [1, 1], tick: 0, note: 'home' }, opts);
lm = addLandmarkTo(lm, { kind: 'a', cell: [2, 2], tick: 1, note: 'toolongnote' }, opts);
check(lm[1].note === 'toolo', 'note is capped');
lm = addLandmarkTo(lm, { kind: 'b', cell: [3, 3], tick: 2, note: 'b' }, opts);
lm = addLandmarkTo(lm, { kind: 'c', cell: [4, 4], tick: 3, note: 'c' }, opts);
check(lm.length === 3 && lm[0].kind === 'home' && !lm.some((l) => l.kind === 'a'), 'oldest non-pinned evicted, pinned kept');
lm = addLandmarkTo(lm, { kind: 'b', cell: [3, 3], tick: 9, note: 'b2' }, opts);
check(lm.length === 3 && lm[2].tick === 9 && lm.filter((l) => l.kind === 'b').length === 1, 'repeat refreshes and becomes newest');

const aged = ageEntries([{ tick: 0 }, { tick: 50 }, { tick: 0, keep: true }], 60, 30, { pinned: (e) => e.keep });
check(aged.length === 2 && aged.some((e) => e.keep) && aged.some((e) => e.tick === 50), 'ageEntries drops expired, keeps pinned');

if (failures) process.exit(1);
console.log('All memory-kit checks passed.');
