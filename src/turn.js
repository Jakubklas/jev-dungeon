// One world tick: the explorer moves (Jev decides), then the adversaries move (each brain-on
// adversary's Jev brain decides, in parallel). Also builds a new game and the browser view.
// The server uses only this module.
import { EXPLORER_LIVES, createGame, generateDungeon, publicView } from './dungeon.js';
import { brainView, graceLeft, memoryOf, seesExplorer, spawnAdversaries, stepAdversaries } from './characters/adversary/adversary.js';
import { resetRequests } from './characters/adversary/brain.js';
import { saveMemories } from './characters/adversary/memory.js';
import { buildArena } from './testbed.js';
// Namespace import: `noteCaught` may not exist yet, and a missing named import would fail at load.
import * as brain from './characters/explorer/brain.js';

const DIR = new URL('../', import.meta.url); // dungeon-game/ (adversaries.json lives here)

export function newGame(seed) {
  const dungeon = generateDungeon(seed ?? undefined);
  return startGame(dungeon, spawnAdversaries(dungeon));
}

// A small configured arena (src/testbed.js) instead of a generated dungeon. Throws TestbedError
// on a bad config. Costs no Jev calls.
export function newTestGame(config) {
  const { dungeon, adversaries } = buildArena(config);
  return startGame(dungeon, adversaries);
}

// Shared by newGame and newTestGame, so both start from the same state.
function startGame(dungeon, adversaries) {
  const game = createGame(dungeon);
  game.lost ??= false;
  game.caughtBy ??= null;
  game.health ??= EXPLORER_LIVES;
  game.maxHealth ??= EXPLORER_LIVES;
  game.graceTicks ??= 0; // ticks of hit protection left (adversary.js GRACE_TICKS)
  game.adversaries = adversaries;
  resetRequests();
  const memory = brain.newRun(game);
  return { game, memory };
}

// `dir`: where adversaries.json goes (the testbed runner points it at a temp dir).
export async function playTurn(game, memory, dir = DIR) {
  const wasLost = game.lost;
  const explorer = await brain.takeTurn(game, memory);
  // stepAdversaries first checks whether the explorer stepped onto an adversary, and does
  // nothing once the game is won or lost.
  const { events, turns } = await stepAdversaries(game);
  await saveMemories(game.adversaries.map(memoryOf), game.steps, dir);
  const hit = events.find((e) => e.type === 'hit');
  if (game.lost && !wasLost && typeof brain.noteCaught === 'function') await brain.noteCaught(game, memory, game.caughtBy);
  else if (hit && typeof brain.noteHit === 'function') await brain.noteHit(game, memory, hit.id);
  return { ...explorer, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns };
}

export function view(game) {
  return {
    ...publicView(game),
    adversaries: game.adversaries.map((a) => ({
      id: a.id, pos: [...a.pos], mode: a.mode, visible: seesExplorer(game, a), brain: brainView(a),
    })),
    grace_ticks: graceLeft(game),
    invulnerable: graceLeft(game) > 0,
    over: game.won || game.lost,
    testbed: !!game.dungeon.testbed,
  };
}
