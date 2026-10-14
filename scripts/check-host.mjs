// Hosted gateway/worker integration: participant keys stay separate, and rejected server keys pause.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTripwire } from './lib/tripwire.mjs';
import { WorkerHost } from '../src/service/worker.js';
import { FileStore } from '../src/service/store.js';
import { defaults } from '../src/config/load.js';
import { newTestGame } from '../src/turn.js';
import { GameActor } from '../src/runtime/game-actor.js';

const uninstall = installTripwire();
const root = mkdtempSync(join(tmpdir(), 'jev-host-check-'));
const store = new FileStore(root);
const posts = [];
const answer = (questions) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: Object.keys(q.criteria)[0] }]));
const transport = async (_, options) => {
  const key = options.headers.Authorization;
  posts.push({ key, body: JSON.parse(options.body) });
  if (key === 'Bearer bad' || key === 'Bearer bad-server') return { ok: false, status: 401, text: async () => 'denied' };
  if (key === 'Bearer hold') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  return { ok: true, status: 200, json: async () => ({ answers: answer(JSON.parse(options.body).questions) }) };
};
const waitFor = (events, predicate) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    if (events.some(predicate)) { clearInterval(timer); resolve(); }
    else if (Date.now() - started > 4000) { clearInterval(timer); reject(new Error('worker event timeout')); }
  }, 10);
});

try {
  const events = [];
  const worker = new WorkerHost({ root, revision: 1, rules: { ...defaults(), maxAdversaries: 0 },
    serverKey: 'server', fetchImpl: transport, emit: (e) => events.push(e) });
  store.createGameDir('gm_keys');
  await worker.command({ id: 'gm_keys', op: 'set_key', participantId: 'p1', key: 'bad' });
  await worker.command({ id: 'gm_keys', op: 'set_key', participantId: 'p2', key: 'good' });
  await worker.create({ id: 'gm_keys', seed: 1, participants: [{ participantId: 'p1' }, { participantId: 'p2' }] });
  await waitFor(events, (e) => e.type === 'key_rejected' && e.participantId === 'p1');
  await waitFor(events, (e) => e.record?.type === 'explorer_turn' && e.record.actor === 'p2');
  assert.equal(posts.filter((p) => p.key === 'Bearer bad').length, 1);
  assert.ok(posts.some((p) => p.key === 'Bearer good'));
  assert.ok(!posts.some((p) => p.key === 'Bearer server'));
  await worker.command({ id: 'gm_keys', op: 'stop' });

  const serverEvents = [];
  const server = new WorkerHost({ root, revision: 1, rules: defaults(), serverKey: 'bad-server',
    fetchImpl: transport, emit: (e) => serverEvents.push(e) });
  store.createGameDir('gm_server');
  const run = newTestGame({ map: ['#########', '#.......#', '#..@A...#', '#.......#', '#########'], treasure: null },
    { ask: async ({ questions }) => answer(questions), decide: async ({ questions }) => answer(questions) });
  const actor = new GameActor({ game: run.game, explorers: run.explorers, decideMonster: async ({ questions }) => answer(questions) });
  server.restore({ id: 'gm_server', state: actor.serialize() });
  await server.command({ id: 'gm_server', op: 'set_key', participantId: 'explorer', key: 'hold' });
  await server.command({ id: 'gm_server', op: 'resume' });
  await waitFor(serverEvents, (e) => e.type === 'server_key_rejected');
  assert.equal((await server.command({ id: 'gm_server', op: 'status' })).state, 'paused');
  assert.equal(posts.filter((p) => p.key === 'Bearer bad-server').length, 1);
  await server.command({ id: 'gm_server', op: 'stop' });
  console.log('host workers: separate participant keys, one rejected post, teammates continue, server rejection pauses: ok');
} finally { uninstall(); rmSync(root, { recursive: true, force: true }); }
