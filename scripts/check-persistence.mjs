// WP-F: a resumed stubbed run must make the same decisions, and an uncommitted event must be ignored.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installTripwire } from './lib/tripwire.mjs';
import { newTestGame } from '../src/turn.js';
import { Game } from '../src/dungeon.js';
import { Adversary, adversaryView } from '../src/characters/adversary/adversary.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { ExplorerBrain } from '../src/characters/explorer/brain.js';
import { GameActor } from '../src/runtime/game-actor.js';
import { FakeClock } from '../src/runtime/clock.js';
import { FileStore } from '../src/service/store.js';

const uninstall = installTripwire();
const root = mkdtempSync(join(tmpdir(), 'jev-persist-'));
const answer = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([name, q]) =>
  [name, q.type === 'noul' ? { noul: 0.9 } : { choice: Object.keys(q.criteria)[0] }]));
const config = { size: '13x13', seed: 17, numAdversaries: 2, treasure: 'far' };

function make(label) {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const bodies = [];
  const monsters = [];
  const ask = (request) => { bodies.push(request.body); return answer(request); };
  const decide = (request) => { monsters.push(request.body); return answer(request); };
  const run = newTestGame(config, { ask, decide, memoryDir: pathToFileURL(dir + '/'), dir: pathToFileURL(dir + '/') });
  return { run, ask, bodies, monsters };
}

try {
  const full = make('full');
  const split = make('split');
  for (let i = 0; i < 20; i++) { await full.run.playTurn(); await split.run.playTurn(); }
  assert.equal(full.bodies.length, split.bodies.length, 'request count before snapshot');
  for (let i = 0; i < full.bodies.length; i++) assert.ok(full.bodies[i] === split.bodies[i], `request ${i} before snapshot`);
  assert.deepEqual(full.monsters, split.monsters);
  const world = JSON.parse(JSON.stringify(split.run.game.serialize()));
  const brain = JSON.parse(JSON.stringify(split.run.explorer.serialize()));
  const views = JSON.parse(JSON.stringify(Object.fromEntries(split.run.game.adversaries.map((a) =>
    [a.id, adversaryView(split.run.game, a).serialize()]))));
  const resumed = make('resumed');
  resumed.run.game = Game.restore(world, { restoreAdversary: Adversary.restore });
  for (const a of resumed.run.game.adversaries) adversaryView(resumed.run.game, a).restore(views[a.id]);
  resumed.run.explorer = ExplorerBrain.restore(new KnownWorld(resumed.run.game), brain, { ask: resumed.ask,
    memoryDir: pathToFileURL(join(root, 'resumed') + '/') });
  resumed.run.explorers = [{ id: resumed.run.game.primary.id, brain: resumed.run.explorer }];
  for (let i = 20; i < 40; i++) {
    await full.run.playTurn(); await resumed.run.playTurn();
    assert.ok(JSON.stringify(full.run.game.serialize()) === JSON.stringify(resumed.run.game.serialize()), `world at turn ${i}`);
  }
  const tail = full.bodies.slice(split.bodies.length);
  assert.equal(resumed.bodies.length, tail.length, 'request count after restore');
  for (let i = 0; i < tail.length; i++) {
    if (resumed.bodies[i] !== tail[i]) {
      const a = JSON.parse(resumed.bodies[i]), b = JSON.parse(tail[i]);
      const walk = (x, y, path = '') => {
        if (JSON.stringify(x) === JSON.stringify(y)) return null;
        if (x && y && typeof x === 'object' && typeof y === 'object') {
          for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
            const at = walk(x[k], y[k], `${path}.${k}`);
            if (at) return at;
          }
        }
        return path;
      };
      throw new Error(`request ${i} after restore differs at ${walk(a, b)}`);
    }
  }
  assert.deepEqual(resumed.run.game.serialize(), full.run.game.serialize());
  assert.deepEqual(resumed.run.explorer.serialize(), full.run.explorer.serialize());

  const actor = new GameActor({ game: full.run.game, clock: new FakeClock(), explorers: full.run.explorers,
    decideMonster: answer });
  const actorSaved = JSON.parse(JSON.stringify(actor.serialize()));
  const restoredActor = GameActor.restore(actorSaved, { clock: new FakeClock(), askFor: () => answer,
    decideMonster: answer });
  assert.equal(restoredActor.state, 'paused');
  assert.equal(restoredActor.seq, actorSaved.event_seq);

  const store = new FileStore(join(root, 'store'));
  store.lock();
  assert.throws(() => new FileStore(join(root, 'store'), { isAlive: () => true }).lock());
  store.createGameDir('gm_test');
  store.writeJson('gm_test', 'state.json', { v: 1, event_seq: 1, status: 'running' });
  store.appendEvent('gm_test', { seq: 1, type: 'committed' });
  store.appendEvent('gm_test', { seq: 2, type: 'crash_before_state_write' });
  const recovered = store.readGame('gm_test');
  assert.deepEqual(recovered.events.map((e) => e.seq), [1]);
  assert.equal(recovered.dropped, 1);
  store.appendEvent('gm_test', { seq: 2, type: 'after_restart' });
  store.writeJson('gm_test', 'state.json', { v: 1, event_seq: 2, status: 'paused' });
  assert.deepEqual(store.readGame('gm_test').events.map((e) => e.type), ['committed', 'after_restart']);
  store.createGameDir('gm_actor');
  const persistedRun = make('persisted');
  const clock = new FakeClock();
  const persisted = new GameActor({ game: persistedRun.run.game, clock, explorers: persistedRun.run.explorers,
    decideMonster: answer, store, gameId: 'gm_actor' });
  await persisted.start();
  await clock.tick(200);
  const committed = store.readGame('gm_actor');
  assert.ok(committed.events.length >= 2);
  assert.equal(committed.state.event_seq, committed.events.at(-1).seq);
  assert.ok(committed.events.every((e, i) => e.seq === i + 1));
  assert.equal(JSON.parse(readFileSync(join(root, 'store', 'games', 'gm_actor', 'state-1.json'), 'utf8')).event_seq, 1);
  await persisted.stop();
  store.unlock();
  for (const file of ['state.json', 'events.jsonl']) {
    assert.doesNotMatch(readFileSync(join(root, 'store', 'games', 'gm_test', file), 'utf8'), /JEV_API_KEY|sk-[A-Za-z0-9]+/);
  }
  console.log('persistence: 20 + restore + 20 decisions, actor pause, event rollback, lock, no keys: ok');
} finally {
  uninstall();
  rmSync(root, { recursive: true, force: true });
}
