// The explorer's only window on the game. Fog-safe reads only: its own state (purse included), cells
// that are lit, the adversaries it sees right now (with the health bar over each), the portal and coins
// once lit. This is the single explorer file allowed to hold a Game (the static guard in
// check-dungeon.mjs enforces it). Reads are live, never cached: the game changes during a tick.
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
  get coins() { return this.#game.coins; } // the explorer's own purse
  // Grid size, only for sizing flat BFS arrays and bounds checks. Says nothing about the layout.
  get width() { return this.#game.dungeon.width; }
  get height() { return this.#game.dungeon.height; }

  isKnown(cell) { return this.#game.isKnown(cell); }
  knownTile(cell) { return this.#game.knownTile(cell); }
  knownFloorCount() { return this.#game.knownFloorCount(); }
  legalMoves() { return this.#game.legalMoves(); } // neighbours of the explorer are always lit
  availableMoves() { return this.#game.availableMoves(); }
  // Each adversary in sight with its health bar ({ hp, maxHp }): a bar the explorer can see, so fog-safe
  // while in sight (user-approved amendment of rule 1). Out of sight nothing is read, hp included.
  visibleAdversaries() {
    const byId = new Map(this.#game.adversaries.map((a) => [a.id, a]));
    return visibleAdversaries(this.#game).map((v) => ({ ...v, hp: byId.get(v.id).hp, maxHp: byId.get(v.id).maxHp, stun: byId.get(v.id).stunTicks }));
  }

  // The portal (dungeon.treasure) once it is lit, else null. A testbed arena may have none.
  seenTreasure() {
    const t = this.#game.dungeon.treasure;
    return t && this.#game.isKnown(t) ? t : null;
  }

  // Coin piles on lit cells only (a pile on a dark cell must never leak).
  seenCoins() {
    return this.#game.coinPiles.filter((c) => this.#game.isKnown(c)).map((c) => [...c]);
  }

  // Hearts on lit cells only (a heart on a dark cell must never leak).
  seenHearts() {
    return this.#game.heartPiles.filter((c) => this.#game.isKnown(c)).map((c) => [...c]);
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
