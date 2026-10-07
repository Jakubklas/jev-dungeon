// Skill tunables (settings.js feeds them through configureSkills; 'next' knobs apply from the next game).
// Pure data, no imports: loadouts.js reads the per-skill numbers when it builds a SkillSet, and resolve.js
// reads ghostHp / stunTicks (skillConfig().ghostHp, skillConfig().stunTicks) when a ghost is created / hit.
const DEFAULTS = Object.freeze({
  swordDamage: 1, swordCooldown: 1, shieldChance: 0.6, shieldCooldown: 2,
  clawDamage: 1, clawCooldown: 2, ghostHp: 2, stunTicks: 2,
});
let current = DEFAULTS;

export const skillDefaults = () => ({ ...DEFAULTS });
// Current values (a frozen object; call it again after configureSkills, do not cache it).
export const skillConfig = () => current;
// Unknown keys are ignored; missing keys fall back to the defaults.
export function configureSkills(values = {}) {
  const next = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof values?.[k] === 'number' && Number.isFinite(values[k])) next[k] = values[k];
  current = Object.freeze(next);
}

// Per-loadout number overrides derived from the current config (loadouts.js merges them under the caller's tuning).
export function loadoutTuning() {
  const c = current;
  return {
    sword_strike: { damage: c.swordDamage, cooldown: c.swordCooldown },
    shield_block: { effectiveness: c.shieldChance, cooldown: c.shieldCooldown },
    claw_strike: { damage: c.clawDamage, cooldown: c.clawCooldown },
  };
}
