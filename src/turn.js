// One world tick: the explorer moves (Jev decides), then the adversaries move (each brain-on
// adversary's Jev brain decides, in parallel). Also builds a new game and the browser view.
// The server uses only this module.
import { createGame, generateDungeon, publicView } from './dungeon.js';
import { brainView, memoryOf, seesExplorer, spawnAdversaries, stepAdversaries } from './characters/adversary/adversary.js';
import { resetRequests } from './characters/adversary/brain.js';
import { saveMemories } from './characters/adversary/memory.js';
// Namespace import: `noteCaught` may not exist yet, and a missing named import would fail at load.
import * as brain from './characters/explorer/brain.js';

const DIR = new URL('../', import.meta.url); // dungeon-game/ (adversaries.json lives here)

export function newGame(seed) {
  const dungeon = generateDungeon(seed ?? undefined);
  const game = createGame(dungeon);
  game.lost ??= false;
  game.caughtBy ??= null;
  game.adversaries = spawnAdversaries(dungeon);
  resetRequests();
  const memory = brain.newRun(game);
  return { game, memory };
}

export async function playTurn(game, memory) {
  const wasLost = game.lost;
  const explorer = await brain.takeTurn(game, memory);
  // stepAdversaries first checks whether the explorer stepped onto an adversary, and does
  // nothing once the game is won or lost.
  const { events, turns } = await stepAdversaries(game);
  await saveMemories(game.adversaries.map(memoryOf), game.steps, DIR);
  if (game.lost && !wasLost && typeof brain.noteCaught === 'function') await brain.noteCaught(game, memory, game.caughtBy);
  return { ...explorer, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns };
}

export function view(game) {
  return {
    ...publicView(game),
    adversaries: game.adversaries.map((a) => ({
      id: a.id, pos: [...a.pos], mode: a.mode, visible: seesExplorer(game, a), brain: brainView(a),
    })),
    over: game.won || game.lost,
  };
}
