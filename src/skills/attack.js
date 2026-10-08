// Attack skill: every cell of `shape` flashes and any character standing there takes a hit.
// Shape cells are [forward, right]: x forward, y to the actor's right (so [[1, 0]] is the cell in front).
import { DIRS } from '../dungeon.js';
import { Skill } from './skill.js';

let FACT_MAX = 160;
const SIDE = { up: 'above you', down: 'below you', left: 'to your left', right: 'to your right' };
const clip = (s) => (s.length <= FACT_MAX ? s : `${s.slice(0, FACT_MAX - 3)}...`);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export class AttackSkill extends Skill {
  static kind = 'attack';

  constructor({ shape = [[1, 0]], damage = 1, ...rest }) {
    super(rest);
    this.shape = shape.map(([x, y]) => [x, y]);
    this.damage = damage;
  }

  // Shape rotated to `facing` around `pos`, every cell (off-map and wall cells included: callers drop them).
  // y points down, so facing right has "to its right" = down, i.e. forward f, right hand (-fy, fx).
  cells(pos, facing) {
    const f = DIRS[facing];
    if (!f) throw new TypeError(`unknown facing ${facing}`);
    const r = [-f[1], f[0]];
    return this.shape.map(([x, y]) => [pos[0] + x * f[0] + y * r[0], pos[1] + x * f[1] + y * r[1]]);
  }

  // Loose gate (PLAN D7): offered only when ready AND self.opponentsNear. Then one option per aim
  // (DIRS order) whose cells hold a VISIBLE opponent (self.visibleOpponents: [{ id, pos, hp?, maxHp? }],
  // supplied by the caller so fog holds). With the opponent's health bar (hp) the fact says what the strike
  // does: dispel it, or knock it back and stun it self.stunTicks steps; self.coinChance > 0 adds the loot. Choice: if opponents are near but none stands in a strike cell, the attack
  // offers nothing; the aim-everywhere variant would only add noise next to `none`.
  options(view, self) {
    if (!this.ready || !self?.opponentsNear) return [];
    const pos = self.pos ?? view?.pos;
    const seen = self.visibleOpponents ?? [];
    const out = [];
    for (const dir of Object.keys(DIRS)) {
      const cells = this.cells(pos, dir);
      const held = seen.filter((o) => cells.some((c) => same(c, o.pos)));
      if (!held.length) continue;
      const wait = this.cooldown ? ` Ready again after ${this.cooldown} step${this.cooldown === 1 ? '' : 's'}.` : '';
      const fact = held.every((o) => Number.isInteger(o.hp))
        ? `Strike ${SIDE[dir]}: ${held.slice(0, 2).map((o) => `${o.id} (${o.hp} of ${o.maxHp} hp) ${this.#outcome(o, self)}`).join('; ')}.${wait}`
        : `Strike the cell ${SIDE[dir]}: ${held.slice(0, 2).map((o) => o.id).join(' and ')} ${held.length > 1 ? 'are' : 'is'} there now.${wait}`;
      out.push({
        key: `${this.id}_${dir}`,
        fact: clip(fact),
        target: { dir, cells },
      });
    }
    return out;
  }

  // What this strike does to an opponent with `o.hp` hit points.
  #outcome(o, self) {
    if (o.hp <= this.damage) return `is dispelled for good${self.coinChance > 0 ? ' (may drop a coin)' : ''}`;
    const stun = o.stun ?? self.stunTicks ?? 0;
    return `is knocked back${stun ? ` and stunned ${stun} step${stun === 1 ? '' : 's'}` : ''}`;
  }
}

// Central config hook (src/config/runtime.js).
export function configureAttack(o) { if (o.limSkillFact !== undefined) FACT_MAX = o.limSkillFact; }
export const attackSnapshot = () => ({ limSkillFact: FACT_MAX });
