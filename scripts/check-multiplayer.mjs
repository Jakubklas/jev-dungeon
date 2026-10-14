// Multi-target monster sight and frozen teammate help. All decisions are stubs; no paid fetch.
import assert from 'node:assert/strict';
import { installTripwire } from './lib/tripwire.mjs';
import { Game } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { Adversary, beginAdversaryTick, decideAdversary, applyAdversaryResult } from '../src/characters/adversary/adversary.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { situation } from '../src/characters/explorer/perception.js';
import { ExplorerBrain } from '../src/characters/explorer/brain.js';
import { GameActor } from '../src/runtime/game-actor.js';
import { FakeClock, settle } from '../src/runtime/clock.js';

const uninstall = installTripwire();
const open = [
  '#############', '#...........#', '#..@.A......#', '#...........#', '#...........#', '#...........#',
  '#############',
];
const make = (rows, starts, monster) => {
  const { dungeon } = buildArena({ map: rows, numAdversaries: 0, treasure: null });
  const game = new Game(dungeon, { explorers: starts.map((start, i) => ({ id: `p${i + 1}`, start })) });
  game.adversaries = [new Adversary({ id: 'a1', pos: monster, budget: 1 })];
  return game;
};
const answer = ({ questions }) => Object.fromEntries(Object.entries(questions).map(([key, q]) => {
  if (q.type === 'noul') return [key, { noul: 0.9 }];
  const choices = Object.keys(q.criteria);
  return [key, { choice: key === 'target' ? choices.at(-1) : choices[0] }];
}));

try {
  // The nearer explorer is behind a wall. A ghost must start its hunt on the one it can see.
  const split = [
    '#############', '#...#.......#', '#.@.#...A...#', '#...#.......#', '#...#.......#', '#...#.......#',
    '#############',
  ];
  const hidden = make(split, [[2, 2], [8, 3]], [8, 2]);
  beginAdversaryTick(hidden);
  assert.equal(hidden.adversaries[0].hunt.targetId, 'p2');
  hidden.inTick = false;

  const game = make(open, [[3, 2], [7, 2]], [5, 2]);
  const a = game.adversaries[0];
  const { ctx } = beginAdversaryTick(game);
  let request;
  const result = await decideAdversary(game, a, ctx, { decide: async (r) => { request = r; return answer(r); } });
  assert.equal(request.questions.target.type, 'choice');
  assert.deepEqual(new Set(Object.keys(request.questions.target.criteria)), new Set(['p1', 'p2']));
  assert.deepEqual(new Set(request.state.explorers.map((e) => e.id)), new Set(['p1', 'p2']));
  applyAdversaryResult(game, a, ctx, result);
  game.inTick = false;
  assert.equal(a.hunt.targetId, 'p2');
  assert.equal(a.lastSeen.join(','), '7,2');
  const restored = Adversary.restore(a.serialize());
  assert.equal(restored.hunt.targetId, 'p2');
  assert.equal(restored.hunt.sightings.get('p2').cell.join(','), '7,2');

  // A direct encounter calls once, reaches a teammate over known floor, and freezes the cell.
  const team = make(open, [[3, 2], [8, 2]], [5, 2]);
  const clock = new FakeClock();
  const brains = team.explorers.map((e) => ({ id: e.id, brain: new ExplorerBrain(new KnownWorld(team, e.id),
    { ask: async (r) => answer(r), persistMemory: false }) }));
  const events = [];
  const actor = new GameActor({ game: team, clock, explorers: brains,
    decideMonster: async (r) => answer(r), onEvent: (e) => events.push(e) });
  await actor.start();
  clock.advance(0);
  await settle();
  assert.equal(events.filter((e) => e.type === 'help_called' && e.actor === 'p1').length, 1);
  const reports = new KnownWorld(team, 'p2').helpReports();
  assert.ok(reports.some((r) => r.id === 'a1' && r.by === 'p1' && r.cell.join(',') === '5,2'));
  team.adversaries[0].pos = [6, 3];
  assert.equal(new KnownWorld(team, 'p2').helpReports().find((r) => r.by === 'p1').cell.join(','), '5,2');
  assert.ok(situation(new KnownWorld(team, 'p2')).threats.reported?.some((r) => r.id === 'a1'));
  const snapshot = team.serialize();
  const recovered = Game.restore(snapshot, { restoreAdversary: Adversary.restore });
  assert.deepEqual(new KnownWorld(recovered, 'p2').helpReports(), new KnownWorld(team, 'p2').helpReports());
  await actor.stop();
  console.log('multiplayer: visible target choice, wall-hidden target, frozen help, snapshot: ok');
} finally { uninstall(); }
