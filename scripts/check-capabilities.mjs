// Checks for the capability scaffold (src/capabilities/index.js): empty registry, validator,
// feasibility filtering and deterministic order. Pure, no Jev, no game.
// Run from the dungeon-game directory: node scripts/check-capabilities.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { CAPABILITIES, actionQuestion, defineCapability, feasibleOptions } from '../src/capabilities/index.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg); } };
const throws = (fn, label) => {
  try { fn(); check(false, `${label}: expected a throw`); } catch (err) { check(err instanceof TypeError, `${label}: threw ${err.constructor.name}`); }
};

// 1. The shipped registry is empty, so no question is ever built.
check(Object.keys(CAPABILITIES).length === 0, 'registry starts empty');
check(Object.keys(feasibleOptions('explorer', {}, {})).length === 0, 'no options from the empty registry');
check(actionQuestion({}, 'ctx') === null && actionQuestion(null) === null, 'empty options -> null question');

// 2. Test-only capabilities (a private registry, never the shipped one).
const mk = (id, who, ok) => defineCapability({
  id, who, text: `${id} test capability`,
  feasible: (view) => (ok(view) ? { fact: `${id} is possible (energy ${view.energy})` } : null),
  apply: () => {},
});
const reg = {};
for (const c of [mk('sprint', ['explorer'], (v) => v.energy >= 3), mk('attack', ['adversary'], () => true), mk('pick_up', ['explorer', 'adversary'], (v) => v.item)]) reg[c.id] = c;
const idsOf = (who, view) => Object.keys(feasibleOptions(who, view, {}, reg)).join();
check(idsOf('explorer', { energy: 0 }) === '', 'nothing feasible -> none listed');
check(idsOf('explorer', { energy: 5 }) === 'sprint', 'feasible one appears');
check(idsOf('explorer', { energy: 5, item: true }) === 'pick_up,sprint', 'sorted by id, not registration order');
check(idsOf('adversary', { energy: 5, item: true }) === 'attack,pick_up', 'who filter');
check(feasibleOptions('explorer', { energy: 5 }, {}, reg).sprint.includes('energy 5'), 'fact text carried through');
check(Object.isFrozen(reg.sprint) && Object.isFrozen(reg.sprint.who), 'defined spec is frozen');

const q = actionQuestion(feasibleOptions('explorer', { energy: 5, item: true }, {}, reg), 'Ghost close.');
check(q.type === 'choice' && Object.keys(q.criteria).join() === 'pick_up,sprint,none', 'question lists options then none');
check(q.criteria.none === 'Do nothing special this step', 'none option text');
check(q.instructions.question.startsWith('Ghost close.'), 'context line leads the question');
check(JSON.stringify(q) === JSON.stringify(actionQuestion(feasibleOptions('explorer', { energy: 5, item: true }, {}, reg), 'Ghost close.')), 'deterministic');

// 3. Validator.
const ok = { id: 'x', who: ['explorer'], text: 't', feasible: () => null, apply: () => {} };
check(defineCapability(ok).id === 'x', 'valid spec accepted');
throws(() => defineCapability(null), 'null spec');
throws(() => defineCapability({ ...ok, id: 'Bad Id' }), 'bad id');
throws(() => defineCapability({ ...ok, id: 'none' }), 'reserved id');
throws(() => defineCapability({ ...ok, who: [] }), 'empty who');
throws(() => defineCapability({ ...ok, who: ['dragon'] }), 'unknown who');
throws(() => defineCapability({ ...ok, who: ['explorer', 'explorer'] }), 'duplicate who');
throws(() => defineCapability({ ...ok, text: '' }), 'empty text');
throws(() => defineCapability({ ...ok, feasible: null }), 'missing feasible');
throws(() => defineCapability({ ...ok, apply: 1 }), 'missing apply');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('All capability checks passed.');
