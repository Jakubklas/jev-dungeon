// Skill tunables (settings.js feeds them through configureSkills; 'next' knobs apply from the next game).
// Pure data, no imports: loadouts.js reads the per-skill numbers when it builds a SkillSet, and resolve.js
// reads ghostHp / stunTicks (skillConfig().ghostHp, skillConfig().stunTicks) when a ghost is created / hit.
const DEFAULTS = Object.freeze({
  swordDamage: 1, swordCooldown: 1, shieldChance: 0.6, shieldCooldown: 2,
  clawDamage: 1, clawCooldown: 2, fireDamage: 2, fireCooldown: 120, ghostHp: 2, stunTicks: 2, coinDropChance: 0.6,
  trollHp: 4, trollClawDamage: 2, trollSpeed: 0.65, // the troll's own numbers: tougher, harder-hitting, slower than a ghost
  trollStunTicks: 0, // ticks a sword hit stuns a troll; 0 = it only loses hp (no knockback, no lost step)
  treeGiantHp: 4, treeGiantClawDamage: 2, treeGiantSpeed: 0.45, treeGiantStunTicks: 0, treeGiantClawCooldown: 3,
  wolfHp: 3, wolfClawDamage: 1, wolfSpeed: 1.2, wolfStunTicks: 1, wolfClawCooldown: 1,
  treeGiantSkills: Object.freeze(['claw_strike']), wolfSkills: Object.freeze(['claw_strike']),
  ghostSpeed: 1, // share of the global monster speed
  ghostClawCooldown: null, trollClawCooldown: null, // per-kind claw cooldown; null = the global clawCooldown
  // Who has which skills (central config; lists of loadout ids, at most 4 each). loadouts.js DEFAULT_SETS and kinds.js read them.
  explorerSkills: Object.freeze(['sword_strike', 'shield_block', 'fire_strike']), ghostSkills: Object.freeze(['claw_strike']), trollSkills: Object.freeze(['claw_strike']),
});
let current = DEFAULTS;

export const skillDefaults = () => ({ ...DEFAULTS });
// Current values (a frozen object; call it again after configureSkills, do not cache it).
export const skillConfig = () => current;
// Unknown keys are ignored; missing keys fall back to the defaults.
export function configureSkills(values = {}) {
  const next = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = values?.[k];
    if (Array.isArray(DEFAULTS[k])) { if (Array.isArray(v) && v.every((x) => typeof x === 'string')) next[k] = Object.freeze([...v]); }
    else if (DEFAULTS[k] === null) { if (v === null || (typeof v === 'number' && Number.isFinite(v))) next[k] = v; }
    else if (typeof v === 'number' && Number.isFinite(v)) next[k] = v;
  }
  current = Object.freeze(next);
}

// Per-loadout number overrides derived from the current config (loadouts.js merges them under the caller's tuning).
export function loadoutTuning() {
  const c = current;
  return {
    sword_strike: { damage: c.swordDamage, cooldown: c.swordCooldown },
    shield_block: { effectiveness: c.shieldChance, cooldown: c.shieldCooldown },
    claw_strike: { damage: c.clawDamage, cooldown: c.clawCooldown },
    fire_strike: { damage: c.fireDamage, cooldown: c.fireCooldown },
  };
}
