// Kill a child runtime while it is waiting on a decision and between event append/state commit.
// This is local-only; all brains are injected stubs and no paid fetch is possible.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../src/service/store.js';
import { GameActor } from '../src/runtime/game-actor.js';
import { Game } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { ExplorerBrain } from '../src/characters/explorer/brain.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { Adversary } from '../src/characters/adversary/adversary.js';

const self = fileURLToPath(import.meta.url);
const answer = ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
  if (q.type === 'noul') return [k, { noul: 0.9 }];
  const choice = Object.keys(q.criteria)[0];
  return [k, { choice }];
}));

if (process.argv[2] === 'child') {
  const [mode, root] = process.argv.slice(3);
  const store = new FileStore(root);
  const id = `gm_${mode}`;
  store.createGameDir(id);
  const { dungeon } = buildArena({ map: ['#########', '#@......#', '#.......#', '#.......#', '#########'], numAdversaries: 0, treasure: null });
  const game = new Game(dungeon, { explorers: [{ id: 'p1', start: dungeon.start }] });
  game.adversaries = [];
  const ask = mode === 'decision'
    ? async () => { process.send('decision_in_flight'); return new Promise(() => {}); }
    : async (request) => answer(request);
  const brain = new ExplorerBrain(new KnownWorld(game, 'p1'), { ask, persistMemory: false });
  const actor = new GameActor({ game, explorers: [{ id: 'p1', brain }], store, gameId: id,
    onError: (error) => process.send(`error:${error.message}`) });
  if (mode === 'event') {
    const append = store.appendEvent.bind(store);
    store.appendEvent = (gameId, event) => {
      append(gameId, event);
      if (event.type === 'explorer_turn') {
        process.send('event_appended_before_state');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      }
    };
  }
  store.writeJson(id, 'state.json', actor.serialize());
  store.writeCold(id, 0, actor.serialize());
  await actor.start();
  process.send('started');
} else {
  const root = mkdtempSync(join(tmpdir(), 'jev-crash-check-'));
  const waitMessage = (child, wanted) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${wanted}`)), 5000);
    child.on('message', (message) => {
      if (message === wanted) { clearTimeout(timer); resolve(); }
      else if (typeof message === 'string' && message.startsWith('error:')) { clearTimeout(timer); reject(new Error(message)); }
    });
    child.once('error', reject);
  });
  const run = async (mode, signal) => {
    const child = fork(self, ['child', mode, root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, JEV_CONFIG: 'none' } });
    await waitMessage(child, signal);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const store = new FileStore(root);
    const recovered = store.readGame(`gm_${mode}`);
    assert.ok(recovered.state, `${mode}: state snapshot survives`);
    assert.equal(recovered.events.at(-1)?.seq ?? 0, recovered.state.event_seq, `${mode}: event stream and state agree after recovery`);
    if (mode === 'event') assert.equal(recovered.dropped, 1, 'uncommitted event tail is dropped exactly once');
    const actor = GameActor.restore(recovered.state, { askFor: () => async (r) => answer(r),
      decideMonster: async (r) => answer(r), store, gameId: `gm_${mode}` });
    assert.equal(actor.state, 'paused', `${mode}: recovered actor is paused`);
    assert.equal(actor.seq, recovered.state.event_seq, `${mode}: no action applies twice`);
  };
  try {
    await run('decision', 'decision_in_flight');
    await run('event', 'event_appended_before_state');
    console.log('service crash recovery: in-flight decision and uncommitted event are not replayed twice: ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
