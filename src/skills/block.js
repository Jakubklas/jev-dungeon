// Block skill: a stance until the owner's next step. An attack landing on its cell is stopped with
// probability `effectiveness`, rolled by the game's seeded stream (resolve.js), never here.
import { Skill } from './skill.js';

export class BlockSkill extends Skill {
  static kind = 'block';

  constructor({ effectiveness = 0.5, ...rest }) {
    super(rest);
    if (!(effectiveness >= 0 && effectiveness <= 1)) throw new TypeError(`skill ${rest.id}: effectiveness must be 0..1`);
    this.effectiveness = effectiveness;
  }

  // Offered when ready and self.threatNear: a visible hunting opponent within 2 path steps (the caller
  // computes it). threatNear is true, or { id, steps } for a better fact.
  options(view, self) { // eslint-disable-line no-unused-vars
    const t = self?.threatNear;
    if (!this.ready || !t) return [];
    const pct = Math.round(this.effectiveness * 100);
    let who = 'An opponent is close and chasing you.';
    if (typeof t === 'object' && t.id) who = `${t.id} is ${t.steps > 1 ? `${t.steps} steps away` : 'adjacent'} and chasing you.`;
    return [{
      key: this.id,
      fact: `Raise the shield until your next step: ${pct}% chance to stop an attack on your cell. ${who}`,
      target: null,
    }];
  }
}
