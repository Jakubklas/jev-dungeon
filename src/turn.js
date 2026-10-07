// One world tick: the explorer moves (Jev decides), then the adversaries move (each brain-on
// adversary's Jev brain decides, in parallel). A Run owns one game plus its explorer memory and
// builds the browser view. The server uses only this module.
import { Game, generateDungeon } from './dungeon.js';
import { spawnCoins } from './coins.js';
import { brainView, graceLeft, seesExplorer, spawnAdversaries, stepAdversaries } from './characters/adversary/adversary.js';
import { saveMemories } from './characters/adversary/memory.js';
import { buildArena, explorerSkillSetOf } from './testbed.js';
import { saveMemory } from './characters/explorer/memory.js';
import { ExplorerBrain } from './characters/explorer/brain.js';
import { KnownWorld } from './characters/explorer/known-world.js';

const DIR = new URL('../', import.meta.url); // dungeon-game/ (adversaries.json lives here)

// One game in progress. `opts`: `ask` / `decide` replace the explorer's / adversaries' Jev call
// (the checks pass stubs), `memoryDir` is where the explorer's memory files go, `dir` where
// adversaries.json goes. Without them a Run talks to the real Jev and writes next to the server.
// `confidence` (default false) switches on the explorer's confidence model (PLAN-confidence, the `confidenceModel` setting).
export class Run {
  #dir;
  #memoryDir;
  #decide; // null = the real Jev

  constructor(dungeon, adversaries, { ask = null, decide = null, dir = null, memoryDir = null, skills = 'explorer', hold = true, confidence = false } = {}) {
    this.game = new Game(dungeon);
    this.game.adversaries = adversaries;
    this.#decide = decide;
    this.explorer = new ExplorerBrain(new KnownWorld(this.game), { ask, memoryDir, skills, hold, confidence });
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
    game.clearTickState(); // strikes are per tick; a lapsed block stance goes
    const coinsBefore = game.coins;
    const explorer = await this.explorer.takeTurn();
    // The explorer's skill events: the brain's own list when it hands one back, else the strike flash
    // read from game.strikes (struck / dispelled need the brain's list).
    const skillEvents = explorer.skill_events ?? game.strikes.filter((s) => s.by === 'explorer').map((s) => ({ id: s.by, type: 'strike', cells: s.cells, result: s.result }));
    // stepAdversaries first bumps an adversary the explorer stepped onto (knockback only), and does
    // nothing once the game is won or lost.
    const { events: adversaryEvents, turns } = await stepAdversaries(game, { decide: this.#decide });
    const coinEvents = game.coins > coinsBefore ? [{ id: 'explorer', type: 'coin', at: [...game.pos], gained: game.coins - coinsBefore, total: game.coins }] : [];
    const events = [...skillEvents, ...coinEvents, ...adversaryEvents];
    await saveMemories(game.adversaries.map((a) => a.memory), game.steps, this.#dir);
    const hit = events.find((e) => e.type === 'hit');
    if (game.lost && !wasLost) await this.explorer.noteCaught(game.caughtBy);
    else if (hit) await this.explorer.noteHit(hit.id);
    // The explorer's own shield stopped a claw (the confidence model's +3). Its own cell, its own shield: fog-safe.
    if (!(game.lost && !wasLost)) for (const e of events) if (e.type === 'blocked') await this.explorer.noteBlocked();
    return { ...explorer, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns };
  }

  view() {
    const { game } = this;
    return {
      ...game.publicView(),
      adversaries: game.adversaries.map((a) => ({
        id: a.id, pos: [...a.pos], mode: a.mode, visible: seesExplorer(game, a), brain: brainView(a), character: a.character, // character, facing: Reveal-only display; hp is drawn over ghosts in sight (the explorer reads the same bar)
        facing: a.facing, hp: a.hp, max_hp: a.maxHp,
      })),
      block: game.block, // the explorer's shield stance: null | { effectiveness, until_step } (its own state)
      grace_ticks: graceLeft(game),
      invulnerable: graceLeft(game) > 0,
      over: game.won || game.lost,
      testbed: !!game.dungeon.testbed,
    };
  }
}

export function newGame(seed, opts = {}) {
  const base = generateDungeon(seed ?? undefined);
  const dungeon = { ...base, coins: spawnCoins(base) }; // own PRNG stream: the layout and spawns never change
  return new Run(dungeon, spawnAdversaries(dungeon), opts);
}

// A small configured arena (src/testbed.js) instead of a generated dungeon. Throws TestbedError
// on a bad config. Costs no Jev calls.
export function newTestGame(config, opts = {}) {
  const { dungeon, adversaries, config: cfg } = buildArena(config);
  return new Run(dungeon, adversaries, { skills: explorerSkillSetOf(cfg), ...opts });
}
