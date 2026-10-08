// Monster kinds: what an adversary IS (ghost, troll), apart from its personality (`character.js`, a preset of
// traits). A kind owns the attributes that differ per monster: hit points, skill loadout, and later lives, speed
// and traits of its own. The troll is a ghost in everything but looks today; its row is where it will diverge.
// Pure data plus one seeded draw; imports only the skill config and `rng`.
import { rng } from '../../dungeon.js';
import { skillConfig } from '../../skills/config.js';

// stunTicks: ticks a hit stuns this kind; null = the global stunTicks, 0 = never staggered (hp loss only).
// speed: a multiplier of ADVERSARY_SPEED; tuning: per-loadout number overrides for this kind's own skills.
// hp: a function, so a settings change is read when the monster is built (never cached).
// skills: a name for buildSkillSet (loadouts.js DEFAULT_SETS) or a list of loadout ids.
export const KINDS = {
  ghost: {
    id: 'ghost', name: 'Ghost', hp: () => skillConfig().ghostHp, speed: () => skillConfig().ghostSpeed, skills: 'ghost', stunTicks: () => null,
    tuning: () => (skillConfig().ghostClawCooldown == null ? {} : { claw_strike: { cooldown: skillConfig().ghostClawCooldown } }),
  },
  // Slower, tougher and harder-hitting than a ghost, and a sword hit does not stagger it (trollStunTicks 0): without
// that the explorer's engage hold (strike first, then it is knocked back and stunned) kept it from ever clawing.
  troll: {
    id: 'troll', name: 'Troll', hp: () => skillConfig().trollHp, speed: () => skillConfig().trollSpeed, get skills() { return skillConfig().trollSkills; },
    stunTicks: () => skillConfig().trollStunTicks,
    tuning: () => ({ claw_strike: { damage: skillConfig().trollClawDamage, ...(skillConfig().trollClawCooldown == null ? {} : { cooldown: skillConfig().trollClawCooldown }) } }),
  },
};
export const KIND_IDS = Object.keys(KINDS);

export function kindOf(id) {
  const k = KINDS[id];
  if (!k || !Object.hasOwn(KINDS, id)) throw new TypeError(`unknown monster kind ${JSON.stringify(id)} (one of ${KIND_IDS.join(', ')})`);
  return k;
}

// Spawn kinds from their own stream (`seed ^ 0x7f4a7c15`), drawn after every spawn rng call and one draw per
// monster in order, so a monster's kind never depends on how many monsters exist and dungeons never change.
export function assignKinds(seed, count, trollShare) {
  const rand = rng(seed ^ 0x7f4a7c15);
  return Array.from({ length: count }, () => (rand() < trollShare ? 'troll' : 'ghost'));
}

// Testbed `kinds` value -> one kind id per monster: 'ghost' | 'troll' | 'mixed' (the spawn draw at 0.5) | a list, cycled.
export function kindsFor(spec, seed, count) {
  if (spec === 'mixed') return assignKinds(seed, count, 0.5);
  if (Array.isArray(spec)) return Array.from({ length: count }, (_, i) => spec[i % spec.length]);
  return Array.from({ length: count }, () => spec);
}
