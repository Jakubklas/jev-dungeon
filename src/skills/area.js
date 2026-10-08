// Area skill: one blast over a block of cells around the actor (the fire strike: 4x4, the actor in its
// central 2x2). Every character in the block takes `damage`. Unlike AttackSkill it offers ONE option, aimed
// by code at the placement that holds the most visible opponents, because the four placements differ by one
// row or column and an aim per direction would only add noise to the request.
// Its own kind ('area', not 'attack'), so every "the sword" lookup (kind === 'attack') keeps meaning the sword.
import { DIRS } from '../dungeon.js';
import { AttackSkill } from './attack.js';

// [forward, right] cells of a 4x4 block whose central 2x2 holds the actor: one row behind, two ahead.
export const BLOCK_4X4 = Object.freeze([-1, 0, 1, 2].flatMap((x) => [-1, 0, 1, 2].map((y) => Object.freeze([x, y]))));
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export class AreaSkill extends AttackSkill {
  static kind = 'area';

  // minSeen: opponents that must be in sight before it is offered (2 = outnumbered: one enemy is the sword's job).
  constructor({ shape = BLOCK_4X4, minSeen = 2, ...rest }) {
    super({ shape, ...rest });
    this.minSeen = minSeen;
  }

  // Offered when ready, at least minSeen opponents in sight (self.visibleOpponents, supplied by the caller so
  // fog holds) and at least one of them inside the block. The fact counts outcomes from the visible health
  // bars only and never names a kind.
  options(view, self) {
    const seen = self?.visibleOpponents ?? [];
    if (!this.ready || !self?.opponentsNear || seen.length < this.minSeen) return [];
    const pos = self.pos ?? view?.pos;
    let best = null;
    for (const dir of Object.keys(DIRS)) { // DIRS order breaks ties
      const cells = this.cells(pos, dir);
      const held = seen.filter((o) => cells.some((c) => same(c, o.pos)));
      if (held.length && (!best || held.length > best.held.length)) best = { dir, cells, held };
    }
    if (!best) return [];
    return [{ key: this.id, fact: this.#fact(best.held), target: { dir: best.dir, cells: best.cells } }];
  }

  #fact(held) {
    const known = held.filter((o) => Number.isInteger(o.hp));
    const gone = known.filter((o) => o.hp <= this.damage).length;
    const left = known.filter((o) => o.hp > this.damage).map((o) => o.hp - this.damage);
    const parts = [
      ...(gone ? [`dispels ${gone}`] : []),
      ...(left.length ? [`leaves ${left.length} at ${[...new Set(left)].sort().join('/')} hp`] : []),
      ...(known.length < held.length ? [`hits ${held.length - known.length} more`] : []),
    ];
    const wait = this.cooldown ? ` Ready again after ${this.cooldown} steps.` : '';
    return `${this.name} (4x4 around you, ${this.damage} hp to each enemy in it): ${parts.join(', ')}. Best way to break out when outnumbered.${wait}`;
  }
}
