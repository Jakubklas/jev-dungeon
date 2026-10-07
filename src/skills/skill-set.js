// A character's skills: at most MAX_SKILLS, unique ids. Builds the ordered option map for the
// `skill` question and turns an answered key back into { skill, target }.

export const MAX_SKILLS = 4;

export class SkillSet {
  #skills;
  #chosen = new Map(); // key -> { skill, target } from the latest options() call

  constructor(skills = []) {
    if (skills.length > MAX_SKILLS) throw new RangeError(`a skill set holds at most ${MAX_SKILLS} skills`);
    const ids = new Set();
    for (const s of skills) {
      if (ids.has(s.id)) throw new TypeError(`duplicate skill id ${s.id}`);
      ids.add(s.id);
    }
    this.#skills = [...skills];
  }

  get skills() { return [...this.#skills]; }
  get size() { return this.#skills.length; }

  // { key: { fact, target, skill } } in skill order, then option order. Empty when nothing is feasible.
  options(view, self) {
    const out = {};
    this.#chosen.clear();
    for (const skill of this.#skills) {
      for (const o of skill.options(view, self)) {
        out[o.key] = { fact: o.fact, target: o.target, skill };
        this.#chosen.set(o.key, { skill, target: o.target });
      }
    }
    return out;
  }

  // The skill and target behind a key of the latest options() call, else null.
  get(key) { return this.#chosen.get(key) ?? null; }

  summaries() { return this.#skills.map((s) => s.summary()); }

  turnPassed() { for (const s of this.#skills) s.turnPassed(); }
}
