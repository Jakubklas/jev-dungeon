// Base skill: one stateful instance per character per skill (cooldown, uses). Never sent to Jev as-is:
// summary() is the plain-JSON mirror. Subclasses (attack.js, block.js) add options() and their numbers.
// Pure: no Game import. Options read only the `view` and `self` they are given (fog of war, rule 1).

const ID = /^[a-z][a-z0-9_]*$/;

export class Skill {
  static kind = 'skill';
  #cooldownLeft = 0;
  #uses = 0;
  #lastUsedStep = null;
  #time = null; // attached world-time source (ms) and the length of a step; null = the turn-counted cooldown below
  #stepMs = 400;
  #readyAt = 0;

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
  get ready() { return this.cooldownLeft === 0; }
  // Steps until ready. With a time source it is derived from the deadline: ceil(ms left / stepMs), so what Jev
  // reads stays a step count; without one, the owner's turn counter (the old behaviour).
  get cooldownLeft() {
    if (!this.#time) return this.#cooldownLeft;
    const left = this.#readyAt - this.#time();
    return left <= 0 ? 0 : Math.ceil(left / this.#stepMs - 1e-9);
  }
  get uses() { return this.#uses; }
  get lastUsedStep() { return this.#lastUsedStep; }

  // The owner used the skill at world step `step`: count the use and start the cooldown.
  markUsed(step = null) {
    this.#uses++;
    this.#lastUsedStep = step;
    this.#cooldownLeft = this.cooldown;
    // A timed sword always has at least 100 ms recovery, even with a zero-step host setting.
    if (this.#time) this.#readyAt = this.#time() + Math.max(this.id === 'sword_strike' ? 100 : 0, this.cooldown * this.#stepMs);
  }

  // Cooldown on a deadline (WP-D): `time()` is the owner's world time in ms, `stepMs` what one 'step' of cooldown lasts.
  // A deadline needs no per-turn counting and survives a pause (the time source stops). Dash overrides it.
  attachTime(time, stepMs) {
    this.#time = time;
    this.#stepMs = stepMs;
  }
  get readyAt() { return this.#time ? this.#readyAt : null; }

  serialize() {
    return { v: 1, kind: this.kind, spec: { ...this }, cooldownLeft: this.#cooldownLeft,
      uses: this.#uses, lastUsedStep: this.#lastUsedStep, stepMs: this.#stepMs, readyAt: this.#readyAt };
  }

  restoreState(saved) {
    if (saved?.v !== 1 || saved.kind !== this.kind || saved.spec?.id !== this.id) throw new TypeError('invalid skill snapshot');
    this.#cooldownLeft = saved.cooldownLeft;
    this.#uses = saved.uses;
    this.#lastUsedStep = saved.lastUsedStep;
    this.#stepMs = saved.stepMs;
    this.#readyAt = saved.readyAt;
  }

  // The owner's turn ended: count the cooldown down (a no-op once a time source is attached).
  turnPassed() {
    if (!this.#time && this.#cooldownLeft > 0) this.#cooldownLeft--;
  }

  // Feasible uses now: [{ key, fact, target }]. [] = not offered. Base skill offers nothing.
  options(view, self) { // eslint-disable-line no-unused-vars
    return [];
  }

  summary() {
    return { id: this.id, kind: this.kind, name: this.name, text: this.text, ready: this.ready, cooldown_left: this.cooldownLeft };
  }
}
