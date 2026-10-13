// The explorer's only window on the game. Fog-safe reads only: its own state (purse included), cells
// that are lit, the adversaries it sees right now (with the health bar over each), the portal and coins
// once lit. This is the single explorer file allowed to hold a Game (the static guard in
// check-dungeon.mjs enforces it). Reads are live, never cached: the game changes during a tick.
import { graceLeft, visibleAdversaries } from '../adversary/adversary.js';
import { levelsOn } from '../adversary/kinds.js';
import { hasLineOfSight } from '../../dungeon.js';
import { EXPLORER, resolveAttack } from '../../skills/resolve.js';

export class KnownWorld {
  #game;
  #id;

  // One window per explorer: `explorerId` (default: the primary) says whose position, purse and sight every read is.
  // Light is shared, so isKnown / knownTile are the same for every explorer of a game.
  constructor(game, explorerId = null) {
    this.#game = game;
    this.#id = game.explorer(explorerId).id;
  }

  get #me() { return this.#game.explorer(this.#id); }
  get id() { return this.#id; }
  get pos() { return this.#me.pos; } // the game's own array; callers never mutate it
  get steps() { return this.#me.steps; }
  get visits() { return this.#me.visits; } // same object: far_side averages iterate its keys in insertion order
  get health() { return this.#me.health; }
  get maxHealth() { return this.#me.maxHealth; }
  // The explorer's own time in ms (the clock its cooldowns and deadlines run on).
  timeNow() { return this.#game.timeOf(this.#me); }
  get stepMs() { return this.#game.rules.stepMs; }
  get graceLeft() { return graceLeft(this.#game, this.#id); }
  get won() { return this.#game.won; }
  get facing() { return this.#me.facing; }
  get coins() { return this.#me.coins; } // the explorer's own purse
  // Grid size, only for sizing flat BFS arrays and bounds checks. Says nothing about the layout.
  get width() { return this.#game.dungeon.width; }
  get height() { return this.#game.dungeon.height; }

  isKnown(cell) { return this.#game.isKnown(cell); }
  knownTile(cell) { return this.#game.knownTile(cell); }
  knownFloorCount() { return this.#game.knownFloorCount(); }
  legalMoves() { return this.#game.legalMoves(this.#id); } // neighbours of the explorer are always lit; a teammate's cell is not a move
  availableMoves() { return this.#game.availableMoves(this.#id); }
  // The other active explorers, wherever they are (through walls: user-approved, a teammate's position reveals no tile).
  // Teammates are on the same side: never threats. Their private state (health, purse, memory) is not exposed.
  teammates() {
    return this.#game.explorers.filter((e) => e.status === 'active' && e.id !== this.#id).map((e) => ({ id: e.id, pos: [...e.pos] }));
  }
  // Help calls from teammates (a frozen sighting each; filled by the multiplayer runtime). Empty for now.
  helpReports() { return []; }
  // Each adversary in sight with its health bar ({ hp, maxHp }): a bar the explorer can see, so fog-safe
  // while in sight (user-approved amendment of rule 1). Out of sight nothing is read, hp included.
  visibleAdversaries() {
    const byId = new Map(this.#game.adversaries.map((a) => [a.id, a]));
    // level and clawDamage are read like the health bar: what an adversary in sight shows (PLAN-levels.md).
    return visibleAdversaries(this.#game, this.#id).map((v) => ({ ...v, hp: byId.get(v.id).hp, maxHp: byId.get(v.id).maxHp, stun: byId.get(v.id).stunTicks, level: byId.get(v.id).level, clawDamage: byId.get(v.id).clawDamage }));
  }
  // Whether monster levels are on (the monsters.levels.enabled knob): a config switch, no game state. Off, the explorer
  // neither weighs nor tells Jev a level, so requests are byte-identical to the game without levels.
  get levelsOn() { return levelsOn(); }

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
  move(dir, distance = 1) { return this.#game.applyMove(dir, distance, this.#id); }

  // The strike handle: the shared EXPLORER for the primary (id 'explorer'), else { id, explorer: true }.
  get #attacker() { return this.#id === EXPLORER.id ? EXPLORER : { id: this.#id, explorer: true }; }

  // Uses the skill behind `key` of `skillSet`'s latest options() call, before the step: an attack turns to
  // its aim and strikes its cells, a block raises the stance until the next step. Returns the events
  // (strike, struck, dispelled), or null when the key is unknown or the skill is not ready.
  useSkill(skillSet, key) {
    const picked = skillSet.get(key);
    const me = this.#me;
    if (!picked || !picked.skill.ready || this.#game.won || this.#game.lost || me.status !== 'active') return null;
    const { skill, target } = picked;
    this.#game.inTick = false; // the explorer phase of a new turn
    let events = [];
    if (skill.kind === 'attack') {
      me.facing = target.dir;
      events = resolveAttack(this.#game, this.#attacker, target.cells, skill.damage);
    } else if (skill.kind === 'area') {
      // A blast hits only cells in real line of sight (inside 2 cells that is "in sight"), so it never strikes
      // an enemy the explorer cannot see round a wall corner (rule 1). Facing is unchanged: it is not aimed.
      const pos = me.pos;
      const cells = target.cells.filter((c) => hasLineOfSight(this.#game.dungeon, pos, c));
      const xs = target.cells.map((c) => c[0]), ys = target.cells.map((c) => c[1]);
      const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; // the whole block's middle, for the UI
      events = resolveAttack(this.#game, this.#attacker, cells, skill.damage, { skill: skill.id, centre });
    } else if (skill.kind === 'block') {
      me.block = { effectiveness: skill.effectiveness, until: this.#game.timeOf(me) + this.#game.rules.stepMs, until_step: me.steps + 1 };
    } else if (skill.kind === 'dash') {
      // The brain applies the chosen movement direction after this skill is marked used.
    } else {
      return null;
    }
    skill.markUsed(me.steps);
    return events;
  }
}
