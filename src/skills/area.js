// Area skill: one blast over a block of cells around the actor (the fire strike: 9x9, centred on the actor).
// Every character in the block takes `damage`. Unlike AttackSkill it offers ONE option: a centred square is the
// same whatever the aim, and an uneven shape is aimed by code at the placement that holds the most visible
// opponents, so an aim per direction would only add noise to the request.
// Its own kind ('area', not 'attack'), so every "the sword" lookup (kind === 'attack') keeps meaning the sword.
import { DIRS } from '../dungeon.js';
import { AttackSkill } from './attack.js';

// [forward, right] cells of an n x n square around the actor: centred for an odd n, one more cell ahead and to the right for an even one.
export function squareBlock(n) {
  const r = Array.from({ length: n }, (_, i) => i - Math.floor((n - 1) / 2));
  return Object.freeze(r.flatMap((x) => r.map((y) => Object.freeze([x, y]))));
}
export const BLOCK_9X9 = squareBlock(9); // the fire strike: 4 cells each way
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export class AreaSkill extends AttackSkill {
  static kind = 'area';

  // minSeen: opponents that must be in sight before it is offered (2 = outnumbered: one enemy is the sword's job).
  constructor({ shape = BLOCK_9X9, minSeen = 2, ...rest }) {
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
    const xs = this.shape.map((c) => c[0]), ys = this.shape.map((c) => c[1]);
    const size = `${Math.max(...xs) - Math.min(...xs) + 1}x${Math.max(...ys) - Math.min(...ys) + 1}`;
    return `${this.name} (${size} around you, ${this.damage} hp to each enemy in it): ${parts.join(', ')}. Best way to break out when outnumbered.${wait}`;
  }
}
