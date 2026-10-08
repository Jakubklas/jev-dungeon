// Wiring of cornerMode (PLAN-corner.md) in the explorer brain, perception and config. No Jev, no network: `ask` is a stub.
// In a cornered ASCII testbed arena, each mode's tactic / move requests are compared: the urgent text, the diagram, the
// breakout route, the relaxed gap lines and slip_past on the menu; and mode 'off' leaves the requests as they were.
// Run from the dungeon-game directory: node scripts/check-corner-wiring.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { configureExplorerBrain, explorerBrainSnapshot } from '../src/characters/explorer/brain.js';
import * as R from '../src/config/registry.js';

let fails = 0;
const check = (ok, what) => { if (ok) console.log(`ok   ${what}`); else { fails++; console.log(`FAIL: ${what}`); } };
const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'corner-wiring-')) + '/');

// Two walls round the explorer in the corner of a big room, the ghost between it and the room: cornered, with a breakout.
const CORNER = [
  '####################',
  '#@.................#',
  '#..................#',
  '#..................#',
  '#...A..............#',
  '#..................#',
  '#..................#',
  '#..................#',
  '#..................#',
  '####################',
];
// A 2-wide nook, the ghost in its mouth: cornered, and no way past it (breakout null): urgent text, no route.
const NOOK = [
  '#################',
  '#...............#',
  '#...............#',
  '#...............#',
  '#...............#',
  '#...............#',
  '#####..##########',
  '#####.A##########',
  '#####..##########',
  '#####@.##########',
  '#################',
];
const OPEN = [ // nothing near: not cornered in any mode
  '#################',
  '#...............#',
  '#.......@.......#',
  '#...............#',
  '#...A...........#',
  '#...............#',
  '#################',
];

const URGENT = 'You are cornered';
// Plays the first ticks; returns every request (parsed) and the chosen tactics.
async function play(map, mode, { ticks = 1, tactic = 'slip_past' } = {}) {
  configureExplorerBrain({ cornerMode: mode });
  const reqs = [];
  let seed = 12345; // the option shuffle in jev.js uses Math.random: same stream for every mode
  const real = Math.random;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ask = async (req) => {
    reqs.push({ size: req.body.length, body: req.body, kind: req.kind, state: req.state, questions: req.questions });
    return Object.fromEntries(Object.entries(req.questions).map(([k, q]) => {
      const keys = Object.keys(q.criteria ?? {});
      if (q.type === 'noul') return [k, { noul: 0.9 }];
      const pick = k === 'skill' ? (keys.includes('none') ? 'none' : keys[0]) : k === 'tactic' ? (keys.includes(tactic) ? tactic : keys[0]) : k === 'sentiment' ? (keys.includes('steady') ? 'steady' : keys[0]) : keys.find((x) => x !== 'stay') ?? keys[0];
      return [k, { choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 1 : 0])) }];
    }));
  };
  const run = newTestGame({ map, seed: 1, explorerSkills: 'none' },{ ask, decide: async () => ({}), dir, memoryDir: dir });
  for (const a of run.game.adversaries) a.mode = 'chase';
  try { for (let i = 0; i < ticks && !run.game.won && !run.game.lost; i++) await run.playTurn(); } finally { Math.random = real; }
  return reqs;
}
const text = (r) => JSON.stringify(r.questions);
const first = (reqs) => reqs.find((r) => r.questions.tactic) ?? reqs.find((r) => r.questions.next_move || Object.keys(r.questions).some((k) => k.startsWith('move_if_')));
const MODES = ['off', 'urgent', 'ascii', 'route', 'full'];

try {
  // 1. The knob: registered, default off, a choice of five; the live snapshot follows configureExplorerBrain.
  const knob = R.KNOBS.find((k) => k.key === 'cornerMode');
  check(knob && knob.def === 'off' && knob.type === 'choice' && knob.options.join() === MODES.join() && knob.path === 'explorer.brain.cornerMode', 'cornerMode is a registered choice knob, default off');
  configureExplorerBrain({ cornerMode: 'route' });
  check(explorerBrainSnapshot().cornerMode === 'route', 'the snapshot follows configureExplorerBrain');
  configureExplorerBrain({ cornerMode: 'off' });
  check(explorerBrainSnapshot().cornerMode === 'off', '... and back to off');

  // 2. A cornered nook (ghost 2 steps up the nook mouth): every mode but off carries the urgent text and keeps slip_past.
  const map = CORNER;
  const by = {};
  for (const m of MODES) by[m] = first(await play(map, m));
  for (const m of MODES) check(by[m], `${m}: a request with a tactic or move question was made`);
  const T = Object.fromEntries(MODES.map((m) => [m, text(by[m])]));
  check(!T.off.includes(URGENT) && !T.off.includes('Cornered:') && !by.off.state.surroundings.local_map, 'off: no urgent text, no map');
  for (const m of ['urgent', 'ascii', 'route', 'full']) check(T[m].includes(URGENT) || T[m].includes('Cornered:'), `${m}: the question says the explorer is cornered`);
  for (const m of ['off', 'urgent', 'ascii', 'route', 'full']) {
    const hasMap = Boolean(by[m].state.surroundings.local_map);
    check(hasMap === (m === 'ascii' || m === 'full'), `${m}: local map ${hasMap ? 'present' : 'absent'}`);
  }
  for (const m of ['route', 'full']) check(/Break out: /.test(T[m]), `${m}: the breakout route is in the question`);
  for (const m of ['urgent', 'ascii']) {
    const priorities = Object.values(by[m].questions).flatMap((q) => q.instructions?.priorities ?? []);
    check(!priorities.some((p) => /^Break out: /.test(p)), `${m}: no route line in the move priorities`);
  }
  for (const m of ['route', 'full']) check(Object.values(by[m].questions).flatMap((q) => q.instructions?.priorities ?? []).some((p) => /^Break out: /.test(p)), `${m}: the route line is in a move priority`);
  const tac = by.urgent.questions.tactic;
  check(tac && 'slip_past' in tac.criteria, 'urgent: slip_past is on the tactic menu');
  check(tac && !/never move toward an enemy/i.test(T.urgent), 'urgent: the "never move toward an enemy" line is gone');
  const mv = Object.entries(by.urgent.questions).filter(([k]) => k.startsWith('move_if_') || k === 'next_move');
  check(mv.length > 0 && mv.every(([, q]) => !q.instructions.priorities.some((p) => /minimum gap|undo the previous move/.test(p))), 'urgent: no "minimum gap" / "undo the previous move" priorities in the move questions');
  check(by.urgent.questions.tactic && by.urgent.questions.tactic.instructions.priorities[0].includes('Cornered'), 'urgent: the tactic question opens with the cornered line');
  check(!by.off.questions.tactic?.instructions.priorities.some((p) => /Cornered/.test(p)), 'off: the tactic question does not mention it');

  // 2b. The nook: cornered but nothing to break out along: the urgent text comes, the route does not, nothing throws.
  const nook = {};
  for (const m of MODES) nook[m] = first(await play(NOOK, m));
  check(MODES.every((m) => nook[m]), 'nook: every mode asks a question');
  check(nook.off && !text(nook.off).includes(URGENT), 'nook, off: no urgent text');
  for (const m of ['urgent', 'route', 'full']) check(text(nook[m]).includes(URGENT) || text(nook[m]).includes('Cornered:'), `nook, ${m}: urgent text`);
  check(!text(nook.route).includes('Break out: '), 'nook, route: no route line without a breakout');

  // 3. Size deltas (bytes of the whole request body vs off).
  const dl = MODES.slice(1).map((m) => `${m} +${by[m].size - by.off.size}`).join(', ');
  console.log(`info request size: off ${by.off.size} B; ${dl}`);
  check(by.ascii.size - by.urgent.size <= 700 && by.full.size - by.off.size <= 1500, 'the diagram and the route stay inside the size budget');

  // 4. An open room (nothing cornered): requests are identical in every mode (code reads cornerFacts and gets null).
  const open = {};
  for (const m of MODES) open[m] = JSON.stringify((await play(OPEN, m, { ticks: 2 })).map((r) => r.body));
  check(MODES.slice(1).every((m) => open[m] === open.off), 'not cornered: every mode sends the same requests as off');

  // 5. Route commitment: with route, slip_past picked, the kept goal is the route end for the next ticks (no flip).
  const walk = await play(map, 'route', { ticks: 4 });
  const goals = walk.filter((r) => r.questions.next_move || Object.keys(r.questions).some((k) => k.startsWith('move_if_'))).length;
  check(walk.length >= 2 && goals >= 1, `route: the explorer keeps being asked about moves while it breaks out (${walk.length} requests)`);
} finally {
  configureExplorerBrain({ cornerMode: 'off' });
}
if (fails) { console.log(`check-corner-wiring: ${fails} failure(s)`); process.exit(1); }
console.log('check-corner-wiring: ok');
