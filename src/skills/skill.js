// Base skill: one stateful instance per character per skill (cooldown, uses). Never sent to Jev as-is:
// summary() is the plain-JSON mirror. Subclasses (attack.js, block.js) add options() and their numbers.
// Pure: no Game import. Options read only the `view` and `self` they are given (fog of war, rule 1).

const ID = /^[a-z][a-z0-9_]*$/;

export class Skill {
  static kind = 'skill';
  #cooldownLeft = 0;
  #uses = 0;
  #lastUsedStep = null;

  // source: what grants it ('sword', 'shield', 'claw'); cooldown: turns before it is ready again.
  constructor({ id, name, source = '', text = '', cooldown = 0 }) {
    if (typeof id !== 'string' || !ID.test(id) || id === 'none') throw new TypeError(`skill id must be snake_case and not 'none': ${id}`);
    if (!Number.isInteger(cooldown) || cooldown < 0) throw new TypeError(`skill ${id}: cooldown must be a whole number >= 0`);
    this.id = id;
    this.name = name ?? id;
    this.source = source;
    this.text = text;
    this.cooldown = cooldown;
  }

  get kind() { return this.constructor.kind; }
  get ready() { return this.#cooldownLeft === 0; }
  get cooldownLeft() { return this.#cooldownLeft; }
  get uses() { return this.#uses; }
  get lastUsedStep() { return this.#lastUsedStep; }

  // The owner used the skill at world step `step`: count the use and start the cooldown.
  markUsed(step = null) {
    this.#uses++;
    this.#lastUsedStep = step;
    this.#cooldownLeft = this.cooldown;
  }

  // The owner's turn ended: count the cooldown down.
  turnPassed() {
    if (this.#cooldownLeft > 0) this.#cooldownLeft--;
  }

  // Feasible uses now: [{ key, fact, target }]. [] = not offered. Base skill offers nothing.
  options(view, self) { // eslint-disable-line no-unused-vars
    return [];
  }

  summary() {
    return { id: this.id, kind: this.kind, name: this.name, text: this.text, ready: this.ready, cooldown_left: this.#cooldownLeft };
  }
}
