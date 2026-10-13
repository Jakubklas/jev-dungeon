// A movement skill with a wall-clock cooldown. Options depend only on the supplied fog-safe
// move list; the world checks the full path when the chosen move is executed.
import { Skill } from './skill.js';

export class DashSkill extends Skill {
  static kind = 'dash';
  #readyAt = 0;
  #now;

  constructor({ distance = 4, now = Date.now, ...rest }) {
    super(rest);
    if (!Number.isInteger(distance) || distance < 2 || distance > 4) throw new TypeError(`skill ${rest.id}: distance must be 2..4 cells`);
    if (typeof now !== 'function') throw new TypeError(`skill ${rest.id}: now must be a function`);
    this.distance = distance;
    this.#now = now;
    this.text = `${this.text} Ready again after ${this.cooldown} seconds.`;
  }

  get ready() { return this.#now() >= this.#readyAt; }
  get cooldownLeft() { return Math.max(0, Math.ceil((this.#readyAt - this.#now()) / 1000)); }

  markUsed(step = null) {
    super.markUsed(step);
    this.#readyAt = this.#now() + this.cooldown * 1000;
  }

  turnPassed() {} // seconds elapse even while the game is paused

  summary() {
    const left = this.cooldownLeft;
    return { ...super.summary(), ready: left === 0, cooldown_left: left };
  }

  options(view, self) { // eslint-disable-line no-unused-vars
    if (!this.ready || !self?.availableMoves?.some((dir) => dir !== 'stay')) return [];
    return [{
      key: this.id,
      fact: `Dash up to ${this.distance} cells via next_move. Stops at walls. Flee danger, chase targets, explore fast. ${this.cooldown}s cooldown.`,
      target: null,
    }];
  }
}
