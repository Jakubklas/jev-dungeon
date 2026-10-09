// Loadouts are data: kind -> class, plus numbers. A new behaviour (sweep, cone, radius) is a subclass
// registered in KINDS. Numbers come from config.js (settings); the `tuning` argument overrides them per loadout id.
import { AttackSkill } from './attack.js';
import { AreaSkill } from './area.js';
import { BlockSkill } from './block.js';
import { SkillSet } from './skill-set.js';
import { loadoutTuning, skillConfig } from './config.js';

export { configureSkills, skillConfig } from './config.js'; // settings.js feeds the numbers; resolve.js reads ghostHp / stunTicks

const KINDS = { attack: AttackSkill, area: AreaSkill, block: BlockSkill };

export const LOADOUTS = {
  sword_strike: { kind: 'attack', id: 'sword_strike', name: 'Sword strike', source: 'sword', damage: 1, cooldown: 1, text: 'Strike the cell in front of you with the sword.' },
  shield_block: { kind: 'block', id: 'shield_block', name: 'Shield block', source: 'shield', effectiveness: 0.6, cooldown: 2, text: 'Raise the shield until your next step to stop an attack.' },
  // The explorer's big spell: a 9x9 blast centred on it (area.js), offered only when outnumbered, then a long wait.
  fire_strike: { kind: 'area', id: 'fire_strike', name: 'Fire strike', source: 'fire', damage: 2, cooldown: 200, text: 'Burn the 9x9 cells around you: every enemy in them takes the damage.' },
  claw_strike: { kind: 'attack', id: 'claw_strike', name: 'Claw strike', source: 'claw', damage: 1, cooldown: 2, text: 'Strike the cell in front with a claw.' },
};

// Named sets. explorer and ghost follow the central config (explorerSkills / ghostSkills); `none` is fixed.
export const DEFAULT_SETS = {
  get explorer() { return skillConfig().explorerSkills; },
  get ghost() { return skillConfig().ghostSkills; }, // no block by default (PLAN D2)
  none: [],
};

// kindOrList: 'explorer' | 'ghost' | 'none' | [loadout ids]. tuning: { sword_strike: { damage: 2 }, ... }.
export function buildSkillSet(kindOrList = 'none', tuning = {}) {
  const ids = typeof kindOrList === 'string' ? DEFAULT_SETS[kindOrList] : kindOrList;
  if (!Array.isArray(ids)) throw new TypeError(`unknown skill set ${kindOrList}`);
  const configured = loadoutTuning();
  return new SkillSet(ids.map((id) => {
    const base = LOADOUTS[id];
    if (!base) throw new TypeError(`unknown loadout ${id}`);
    const { kind, ...spec } = { ...base, ...(configured[id] ?? {}), ...(tuning?.[id] ?? {}) };
    return new KINDS[kind](spec);
  }));
}
