// A character's skills: at most MAX_SKILLS, unique ids. Builds the ordered option map for the
// `skill` question and turns an answered key back into { skill, target }.
import { AttackSkill } from './attack.js';
import { AreaSkill } from './area.js';
import { BlockSkill } from './block.js';
import { DashSkill } from './dash.js';

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

  // Put every cooldown on a deadline timeline (see Skill.attachTime). Dash keeps its own real-time clock.
  attachTime(time, stepMs) { for (const s of this.#skills) s.attachTime(time, stepMs); }
  turnPassed() { for (const s of this.#skills) s.turnPassed(); }

  serialize() { return { v: 1, skills: this.#skills.map((s) => s.serialize()) }; }

  static restore(saved) {
    if (saved?.v !== 1 || !Array.isArray(saved.skills)) throw new TypeError('invalid skill set snapshot');
    const classes = { attack: AttackSkill, area: AreaSkill, block: BlockSkill, dash: DashSkill };
    return new SkillSet(saved.skills.map((entry) => {
      const Type = classes[entry.kind];
      if (!Type) throw new TypeError(`unknown skill kind ${entry.kind}`);
      const spec = { ...entry.spec };
      if (entry.kind === 'dash') spec.text = spec.text.replace(` Ready again after ${spec.cooldown} seconds.`, '');
      const skill = new Type(spec);
      skill.restoreState(entry);
      return skill;
    }));
  }
}
