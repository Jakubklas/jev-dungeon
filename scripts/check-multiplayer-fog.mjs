// Frozen multiplayer sightings must not turn hidden movement into Jev input. Stub only.
import assert from 'node:assert/strict';
import { installTripwire } from './lib/tripwire.mjs';
import { Game } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { Adversary, beginAdversaryTick, decideAdversary } from '../src/characters/adversary/adversary.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { situation } from '../src/characters/explorer/perception.js';

const uninstall = installTripwire();
const rows = [
  '#############', '#...#.......#', '#.@.#...A...#', '#...#.......#', '#...#.......#', '#...#.......#',
  '#############',
];
const { dungeon } = buildArena({ map: rows, numAdversaries: 0, treasure: null });
const original = new Game(dungeon, { explorers: [
  { id: 'p1', start: [2, 2] }, { id: 'p2', start: [8, 3] },
] });
original.adversaries = [new Adversary({ id: 'a1', pos: [8, 2], budget: 1 })];
const restore = () => Game.restore(original.serialize(), { restoreAdversary: Adversary.restore });
const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([key, q]) =>
  [key, q.type === 'noul' ? { noul: 0.9 } : { choice: Object.keys(q.criteria)[0] }]));

try {
  // Establish a real sighting, then send p2 behind a wall in two different hidden cells.
  beginAdversaryTick(original);
  assert.equal(original.adversaries[0].hunt.targetId, 'p2');
  original.inTick = false;
  const a = restore(), b = restore();
  a.explorer('p2').pos = [2, 3];
  b.explorer('p2').pos = [3, 4];
  const request = async (game) => {
    game.adversaries[0].budget = 1;
    const { ctx } = beginAdversaryTick(game);
    let body = null;
    await decideAdversary(game, game.adversaries[0], ctx, { decide: async (r) => { body = r.body; return ask(r); } });
    game.inTick = false;
    return body;
  };
  assert.equal(await request(a), await request(b), 'hidden explorer movement changed a monster request');
  assert.deepEqual(a.adversaries[0].lastSeen, [8, 3]);

  // A teammate report is frozen; neither monster position nor hidden tiles may change the recipient's facts.
  const report = { id: 'a1', by: 'p1', cell: [8, 2], step: 0 };
  a.helpReports.p1 = [report];
  b.helpReports.p1 = [structuredClone(report)];
  b.explorer('p2').pos = [...a.explorer('p2').pos]; // teammate positions are intentionally known globally
  a.adversaries[0].pos = [9, 4];
  b.adversaries[0].pos = [10, 5];
  const facts = (game) => JSON.stringify(situation(new KnownWorld(game, 'p1')));
  assert.equal(facts(a), facts(b), 'hidden monster movement changed a frozen help report');
  assert.equal(new KnownWorld(a, 'p1').helpReports()[0].cell.join(','), '8,2');
  console.log('multiplayer fog: hidden target and reported monster twins: ok');
} finally { uninstall(); }
