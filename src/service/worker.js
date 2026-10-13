// One process owns one immutable rules revision. IPC carries commands and public events, never stored keys.
// The main service owns HTTP, cookies, lobbies and the root lock; this process owns GameActors and Jev calls.
import { generateDungeon, floorDistances, isFloor, Game } from '../dungeon.js';
import { spawnCoins } from '../coins.js';
import { spawnHearts } from '../hearts.js';
import { spawnAdversaries } from '../characters/adversary/adversary.js';
import { KnownWorld } from '../characters/explorer/known-world.js';
import { ExplorerBrain } from '../characters/explorer/brain.js';
import { GameActor } from '../runtime/game-actor.js';
import { Gateway } from '../gateway/gateway.js';
import { FileStore, CallsRecorder } from './store.js';
import { Lobby } from './lobby.js';
import { projectGame } from './project.js';
import { applyRulesSnapshot } from '../config/runtime.js';

const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: Object.keys(q.criteria)[0] }]));

function starts(dungeon, n) {
  const room = (dungeon.rooms ?? []).find((r) => dungeon.start[0] >= r.x && dungeon.start[0] < r.x + r.w &&
    dungeon.start[1] >= r.y && dungeon.start[1] < r.y + r.h);
  const candidates = [];
  const dists = floorDistances(dungeon, dungeon.start);
  for (let y = 0; y < dungeon.height; y++) for (let x = 0; x < dungeon.width; x++) {
    const p = [x, y];
    if (!isFloor(dungeon, p)) continue;
    if (room && !(x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h)) continue;
    const distance = dists.get(`${x},${y}`);
    if (distance !== undefined) candidates.push({ p, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.p[1] - b.p[1] || a.p[0] - b.p[0]);
  if (candidates.length < n) throw new Error('start room cannot hold the roster');
  return candidates.slice(0, n).map((c) => c.p);
}

export class WorkerHost {
  #store;
  #serverKey;
  #emit;
  #fetchImpl;
  #actors = new Map();
  #keys = new Map();
  #revision;
  #rules;

  constructor({ root, revision, rules, serverKey = null, emit = () => {}, fetchImpl = null } = {}) {
    this.#store = new FileStore(root);
    this.#serverKey = serverKey;
    this.#emit = emit;
    this.#fetchImpl = fetchImpl;
    this.#revision = revision;
    this.#rules = rules;
    applyRulesSnapshot(rules);
  }

  #gateway(id) {
    return new Gateway({ serverKey: () => this.#serverKey, recorder: new CallsRecorder(this.#store, id),
      timeoutMs: this.#rules.jevTimeoutMs, retries: this.#rules.jevRetries,
      retryStatus: this.#rules.jevRetryStatus, model: this.#rules.jevModel,
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}) });
  }

  #asker(gateway, gameId, id) {
    if (process.env.JEV_TEST_STUB === '1') return stub;
    return gateway.explorerAsker({ gameId, actorId: id, getKey: () => this.#keys.get(gameId)?.get(id) ?? null });
  }

  #decider(gateway, gameId) {
    return process.env.JEV_TEST_STUB === '1' ? stub : gateway.monsterDecider({ gameId });
  }

  #hooks(id) {
    return {
      onEvent: (record, metrics) => this.#emit({ type: 'record', id, record, metrics,
        participants: this.#actors.get(id)?.game.explorers.map((e) => ({ id: e.id, status: e.status })) ?? [] }),
      onKeyRejected: (participantId) => {
        this.#keys.get(id)?.delete(participantId);
        this.#emit({ type: 'key_rejected', id, participantId });
      },
      onServerKeyRejected: () => this.#emit({ type: 'server_key_rejected', id }),
      onFinished: (outcome) => { this.#keys.delete(id); this.#emit({ type: 'finished', id, outcome }); },
      onError: (error) => this.#emit({ type: 'error', id, message: String(error?.message ?? error) }),
    };
  }

  async create({ id, participants, seed }) {
    if (this.#actors.has(id)) throw new Error('game already loaded');
    const base = generateDungeon(seed);
    const withCoins = { ...base, coins: spawnCoins(base) };
    const dungeon = { ...withCoins, hearts: spawnHearts(withCoins) };
    const positions = starts(dungeon, participants.length);
    const game = new Game(dungeon, { explorers: participants.map((p, i) => ({ id: p.participantId, start: positions[i] })) });
    game.adversaries = spawnAdversaries(dungeon);
    const gateway = this.#gateway(id);
    const explorers = participants.map((p) => ({ id: p.participantId,
      brain: new ExplorerBrain(new KnownWorld(game, p.participantId), {
        ask: this.#asker(gateway, id, p.participantId), persistMemory: false,
      }) }));
    const actor = new GameActor({ game, explorers, decideMonster: this.#decider(gateway, id),
      store: this.#store, gameId: id, ...this.#hooks(id) });
    this.#actors.set(id, actor);
    this.#store.writeJson(id, 'dungeon.json', dungeon);
    this.#store.writeJson(id, 'state.json', actor.serialize());
    this.#store.writeCold(id, 0, actor.serialize());
    await actor.start();
    return { event_seq: actor.seq, status: actor.state, revision: this.#revision };
  }

  restore({ id, state }) {
    const gateway = this.#gateway(id);
    const actor = GameActor.restore(state, { askFor: (participantId) => this.#asker(gateway, id, participantId),
      decideMonster: this.#decider(gateway, id), store: this.#store, gameId: id, ...this.#hooks(id) });
    this.#actors.set(id, actor);
    return { status: actor.state, event_seq: actor.seq };
  }

  async command({ id, op, participantId, key, text, lobby, mode, reveal = false, ranking = null }) {
    if (op === 'set_key') {
      let map = this.#keys.get(id);
      if (!map) this.#keys.set(id, (map = new Map()));
      map.set(participantId, key);
      const actor = this.#actors.get(id);
      if (actor?.actorStatus(participantId) === 'awaiting_key') await actor.resumeExplorer(participantId);
      return { key_present: true };
    }
    const actor = this.#actors.get(id);
    if (!actor) throw new Error('game is not loaded');
    if (op === 'pause') return { changed: await actor.pause('host') };
    if (op === 'resume') return { changed: await actor.resume() };
    if (op === 'stop') { await actor.stop(); this.#keys.delete(id); return { changed: true }; }
    if (op === 'forfeit') {
      this.#keys.get(id)?.delete(participantId);
      return { changed: await actor.forfeitExplorer(participantId) };
    }
    if (op === 'directive') {
      const directive = await actor.enqueue(() => {
        const value = actor.brain(participantId).setDirective(text, { steps: this.#rules.injectSteps });
        actor.record('directive', { actor: participantId, text: value?.text ?? null });
        return value;
      });
      return { directive, queued: false };
    }
    if (op === 'view') {
      if (reveal) await actor.enqueue(() => actor.record('host_reveal', { lifecycle: true }));
      const restoredLobby = Lobby.restore(lobby);
      const brains = new Map(restoredLobby.participants.filter((p) => p.slot !== null).map((p) => [p.participantId, actor.brain(p.participantId)]));
      return projectGame({ game: actor.game, brains, lobby: restoredLobby, id, mode,
        rulesRevision: this.#revision, viewerId: participantId, reveal, ranking });
    }
    if (op === 'status') return { state: actor.state, seq: actor.seq };
    throw new Error(`unknown worker operation ${op}`);
  }
}

if (typeof process.send === 'function') {
  let host = null;
  process.on('message', async (message) => {
    const { requestId, op, payload } = message;
    try {
      let value;
      if (op === 'init') {
        host = new WorkerHost({ ...payload, emit: (event) => process.send({ event }) });
        value = { ready: true };
      } else if (op === 'create') value = await host.create(payload);
      else if (op === 'restore') value = host.restore(payload);
      else value = await host.command({ ...payload, op });
      process.send({ requestId, value });
    } catch (error) {
      process.send({ requestId, error: { message: String(error?.message ?? error), name: error?.name ?? 'Error' } });
    }
  });
}
