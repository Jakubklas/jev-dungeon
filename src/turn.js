// One world tick: the explorer moves (Jev decides), then the adversaries move (each brain-on
// adversary's Jev brain decides, in parallel). A Run owns one game plus its explorer memory and
// builds the browser view. The server uses only this module.
import { Game, generateDungeon } from './dungeon.js';
import { brainView, graceLeft, seesExplorer, spawnAdversaries, stepAdversaries } from './characters/adversary/adversary.js';
import { saveMemories } from './characters/adversary/memory.js';
import { buildArena } from './testbed.js';
import { saveMemory } from './characters/explorer/memory.js';
import { ExplorerBrain } from './characters/explorer/brain.js';
import { KnownWorld } from './characters/explorer/known-world.js';

const DIR = new URL('../', import.meta.url); // dungeon-game/ (adversaries.json lives here)

// One game in progress. `opts`: `ask` / `decide` replace the explorer's / adversaries' Jev call
// (the checks pass stubs), `memoryDir` is where the explorer's memory files go, `dir` where
// adversaries.json goes. Without them a Run talks to the real Jev and writes next to the server.
export class Run {
  #dir;
  #memoryDir;
  #decide; // null = the real Jev

  constructor(dungeon, adversaries, { ask = null, decide = null, dir = null, memoryDir = null } = {}) {
    this.game = new Game(dungeon);
    this.game.adversaries = adversaries;
    this.#decide = decide;
    this.explorer = new ExplorerBrain(new KnownWorld(this.game), { ask, memoryDir });
    this.#dir = dir ?? DIR;
    this.#memoryDir = memoryDir ?? DIR;
  }

  get memory() {
    return this.explorer.memory;
  }

  // Writes the opening memory files (memory.json/md, adversaries.json) so a new game does not leave the
  // previous game's files lying around until its first paid step. The server calls this; the checks
  // do not (unless they pass temp dirs).
  async persist() {
    await saveMemory(this.explorer.memory, this.#memoryDir);
    await saveMemories(this.game.adversaries.map((a) => a.memory), this.game.steps, this.#dir);
  }

  async playTurn() {
    const { game } = this;
    const wasLost = game.lost;
    const explorer = await this.explorer.takeTurn();
    // stepAdversaries first checks whether the explorer stepped onto an adversary, and does
    // nothing once the game is won or lost.
    const { events, turns } = await stepAdversaries(game, { decide: this.#decide });
    await saveMemories(game.adversaries.map((a) => a.memory), game.steps, this.#dir);
    const hit = events.find((e) => e.type === 'hit');
    if (game.lost && !wasLost) await this.explorer.noteCaught(game.caughtBy);
    else if (hit) await this.explorer.noteHit(hit.id);
    return { ...explorer, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns };
  }

  view() {
    const { game } = this;
    return {
      ...game.publicView(),
      adversaries: game.adversaries.map((a) => ({
        id: a.id, pos: [...a.pos], mode: a.mode, visible: seesExplorer(game, a), brain: brainView(a),
      })),
      grace_ticks: graceLeft(game),
      invulnerable: graceLeft(game) > 0,
      over: game.won || game.lost,
      testbed: !!game.dungeon.testbed,
    };
  }
}

export function newGame(seed, opts = {}) {
  const dungeon = generateDungeon(seed ?? undefined);
  return new Run(dungeon, spawnAdversaries(dungeon), opts);
}

// A small configured arena (src/testbed.js) instead of a generated dungeon. Throws TestbedError
// on a bad config. Costs no Jev calls.
export function newTestGame(config, opts = {}) {
  const { dungeon, adversaries } = buildArena(config);
  return new Run(dungeon, adversaries, opts);
}
