// The explorer's only window on the game. Fog-safe reads only: its own state, cells that are lit,
// the adversaries it sees right now and the chest once it is lit. This is the single explorer
// file allowed to hold a Game (the static guard in check-dungeon.mjs enforces it). Reads are
// live, never cached: the game changes during a tick.
import { graceLeft, visibleAdversaries } from '../adversary/adversary.js';
import { EXPLORER, resolveAttack } from '../../skills/resolve.js';

export class KnownWorld {
  #game;

  constructor(game) {
    this.#game = game;
  }

  get pos() { return this.#game.pos; } // the game's own array; callers never mutate it
  get steps() { return this.#game.steps; }
  get visits() { return this.#game.visits; } // same object: far_side averages iterate its keys in insertion order
  get health() { return this.#game.health; }
  get maxHealth() { return this.#game.maxHealth; }
  get graceLeft() { return graceLeft(this.#game); }
  get won() { return this.#game.won; }
  get facing() { return this.#game.facing; }
  // Grid size, only for sizing flat BFS arrays and bounds checks. Says nothing about the layout.
  get width() { return this.#game.dungeon.width; }
  get height() { return this.#game.dungeon.height; }

  isKnown(cell) { return this.#game.isKnown(cell); }
  knownTile(cell) { return this.#game.knownTile(cell); }
  knownFloorCount() { return this.#game.knownFloorCount(); }
  legalMoves() { return this.#game.legalMoves(); } // neighbours of the explorer are always lit
  availableMoves() { return this.#game.availableMoves(); }
  visibleAdversaries() { return visibleAdversaries(this.#game); }

  // The chest cell once it is lit, else null. A testbed arena may have no chest at all.
  seenTreasure() {
    const t = this.#game.dungeon.treasure;
    return t && this.#game.isKnown(t) ? t : null;
  }

  // The explorer's own step.
  move(dir) { return this.#game.applyMove(dir); }

  // Uses the skill behind `key` of `skillSet`'s latest options() call, before the step: an attack turns to
  // its aim and strikes its cells, a block raises the stance until the next step. Returns the events
  // (strike, struck, dispelled), or null when the key is unknown or the skill is not ready.
  useSkill(skillSet, key) {
    const picked = skillSet.get(key);
    if (!picked || !picked.skill.ready || this.#game.won || this.#game.lost) return null;
    const { skill, target } = picked;
    let events = [];
    if (skill.kind === 'attack') {
      this.#game.facing = target.dir;
      events = resolveAttack(this.#game, EXPLORER, target.cells, skill.damage);
    } else if (skill.kind === 'block') {
      this.#game.block = { effectiveness: skill.effectiveness, until_step: this.#game.steps + 1 };
    } else {
      return null;
    }
    skill.markUsed(this.#game.steps);
    return events;
  }
}
