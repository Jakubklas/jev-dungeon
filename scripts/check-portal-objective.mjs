// Public testbed regressions for portal-only motivation and persistent destination.
// All explorer/enemy decisions are injected; any accidental network call fails.
globalThis.fetch = () => { throw new Error('network call in portal objective check'); };
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { tacticFeasibility } from '../src/characters/explorer/perception.js';
import { SENTIMENTS } from '../src/characters/explorer/brain.js';
import { validateMemory } from '../src/characters/explorer/memory.js';

const root = mkdtempSync(join(tmpdir(), 'jev-portal-check-'));
let n = 0;
function build(config, { tactic = 'engage', advance = false } = {}) {
  const folder = join(root, String(++n));
  mkdirSync(folder);
  const dir = pathToFileURL(folder + '/');
  const requests = [];
  const ask = async ({ state, questions }) => {
    requests.push({ state, questions });
    return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { noul: 0.1 }]; // refusal must never veto the objective
      const ids = Object.keys(q.criteria);
      let choice = ids[0];
      if (key === 'sentiment') choice = ids.includes('steady') ? 'steady' : ids[0];
      else if (key === 'tactic') choice = ids.includes(tactic) ? tactic : ids[0];
      else if (key === 'skill') choice = ids.includes('none') ? 'none' : ids[0];
      else if (key === 'next_move' || key.startsWith('move_if_')) {
        choice = advance ? ids.find(id => /Closer to the (?:target|portal)|Steps onto the portal/.test(String(q.criteria[id]))) ?? 'stay' : 'stay';
        if (!ids.includes(choice)) choice = ids[0];
      }
      return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
    }));
  };
  const run = newTestGame(config, { ask, decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true } });
  return { run, requests };
}
try {
  // Portal is known at creation: low hypothetical leave_now confidence never keeps exploring.
  {
    const { run, requests } = build({ map: ['#########', '#@..T...#', '#########', '#########', '#########'], numAdversaries: 0 });
    assert(new KnownWorld(run.game).seenTreasure());
    for (let i = 0; i < 12; i++) await run.explorer.takeTurn();
    assert.equal(run.explorer.memory.approach.id, 'go_to_exit');
    assert(!requests.some(r => r.questions.leave_now || r.questions.next_approach || r.questions.approach_working));
    assert.match(requests[0].state.game, /only.*portal|portal.*only/i);
    assert(!/early way out|early exit|cleared win|dispelling every enemy.*win/i.test(JSON.stringify(requests)));
    validateMemory(run.explorer.memory);
    assert(!run.game.won, 'standing still must not win merely because enemies are absent');
  }
  // Unknown portal supplies objective knowledge, never its hidden location or an exit approach.
  {
    const { run, requests } = build({ map: ['################################', '#@...........................T.#', '################################', '################################', '################################'], numAdversaries: 0 });
    assert.equal(new KnownWorld(run.game).seenTreasure(), null);
    await run.explorer.takeTurn();
    assert.notEqual(run.explorer.memory.approach.id, 'go_to_exit');
    assert.match(requests[0].state.game, /portal/i);
    assert(!requests.some(r => r.questions.leave_now));
  }
  // Seeing the portal later commits immediately; hidden layout/loot never alter requests.
  {
    const map = ['################################', '#@...........................T.#', '################################', '################################', '################################'];
    const A = build({ map, numAdversaries: 0 });
    const B = build({ map, numAdversaries: 0, coins: [[25, 1]] });
    B.run.game.dungeon.tiles[1] = B.run.game.dungeon.tiles[1].slice(0, 24) + '#' + B.run.game.dungeon.tiles[1].slice(25);
    await A.run.explorer.takeTurn();
    await B.run.explorer.takeTurn();
    assert.deepEqual(A.requests, B.requests, 'hidden loot/wall must not affect assembled request');
    A.run.game.pos = [26, 1];
    A.run.game.applyMove('right'); // illuminate the portal through the public movement path
    assert(new KnownWorld(A.run.game).seenTreasure());
    await A.run.explorer.takeTurn();
    assert.equal(A.run.explorer.memory.approach.id, 'go_to_exit');
  }
  // A known portal replaces the parked exploration plan while encounter tactics remain usable.
  {
    const { run, requests } = build({ map: ['############', '#..........#', '#.A..@..T..#', '#..........#', '############'], ghostSkills: 'none' });
    const options = tacticFeasibility(new KnownWorld(run.game), 1, { armed: true, retreat: false });
    assert(options.engage, 'test setup must offer forward combat');
    assert(options.race_to_exit, 'forward combat must not remove the portal option');
    await run.explorer.takeTurn();
    const a = run.explorer.memory.approach;
    assert(a.id === 'go_to_exit' || a.interrupted?.id === 'go_to_exit', `portal destination lost in encounter: ${JSON.stringify(a)}`);
    assert(requests.some(r => r.questions.tactic), 'test setup must exercise a tactic request');
    assert(!/cleared win|clear the dungeon \(a win\)/i.test(JSON.stringify(requests)));
    run.game.adversaries = [];
    for (let i = 0; i < 12; i++) await run.explorer.takeTurn();
    assert.equal(run.explorer.memory.approach.id, 'go_to_exit', 'encounter must resume portal destination');
    validateMemory(run.explorer.memory);
  }
  // Player directives retain precedence; the portal remains the plan resumed afterward.
  {
    const { run, requests } = build({ map: ['#########', '#@..T...#', '#########', '#########', '#########'], numAdversaries: 0 });
    run.explorer.setDirective('Wait here', { steps: 3 });
    await run.explorer.takeTurn();
    assert.equal(run.explorer.directive?.text, 'Wait here');
    assert.equal(requests.at(-1).state.directive?.text, 'Wait here');
    assert.equal(run.explorer.memory.approach.id, 'go_to_exit');
    run.explorer.clearDirective('test complete');
    await run.explorer.takeTurn();
    assert.equal(run.explorer.memory.approach.id, 'go_to_exit');
  }
  // The chosen portal route must actually win when the executor follows progress facts.
  {
    const { run } = build({ map: ['#########', '#@..T...#', '#########', '#########', '#########'], numAdversaries: 0 }, { advance: true });
    for (let i = 0; i < 8 && !run.game.won; i++) await run.explorer.takeTurn();
    assert(run.game.won, 'portal commitment must produce reachable winning movement');
    assert.equal(run.game.pos.join(), run.game.dungeon.treasure.join());
  }
  for (const [id, mood] of Object.entries(SENTIMENTS)) {
    assert(!/cleared win|clearing.*wins|early way out/i.test(JSON.stringify(mood)), `false win in ${id}`);
  }
  console.log('Portal objective checks passed: known/unknown destination, encounter resume, directive precedence, portal win, honest prompts.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
