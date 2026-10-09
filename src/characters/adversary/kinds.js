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

// ---- Levels (PLAN-levels.md): every monster has a level 1-3 that scales its hp and claw damage ----

// The levels each kind can be drawn at. A constructor may be given any level 1-3 (tests); the draw stays in range.
export const LEVEL_RANGE = Object.freeze({ ghost: Object.freeze([1, 2]), troll: Object.freeze([2, 3]) });
export const LEVELS = Object.freeze([1, 2, 3]);

// Central config (monsters.levels.*; runtime.js calls configureLevels). Off = every monster is level 2 with today's stats.
let LEVELS_ON = true;
let HP_MULT = [0.5, 1, 1.5]; // by level 1/2/3
let DMG_MULT = [1, 1, 1.5];
let WEIGHTS = { ghost: [1, 1], troll: [1, 1] }; // per level of LEVEL_RANGE[kind], low to high
const tuple = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
export function configureLevels(o) {
  if (o.levelsEnabled !== undefined) LEVELS_ON = Boolean(o.levelsEnabled);
  if (tuple(o.levelHpMult, 3)) HP_MULT = [...o.levelHpMult];
  if (tuple(o.levelDmgMult, 3)) DMG_MULT = [...o.levelDmgMult];
  if (tuple(o.levelWeightGhost, 2)) WEIGHTS.ghost = [...o.levelWeightGhost];
  if (tuple(o.levelWeightTroll, 2)) WEIGHTS.troll = [...o.levelWeightTroll];
}
export const levelsSnapshot = () => ({
  levelsEnabled: LEVELS_ON, levelHpMult: [...HP_MULT], levelDmgMult: [...DMG_MULT], levelWeightGhost: [...WEIGHTS.ghost], levelWeightTroll: [...WEIGHTS.troll],
});
export const levelsOn = () => LEVELS_ON;
// The claw multiplier of a level (1 with levels off): adversary.js scales the claw skill it built by it.
export const clawMult = (level) => (LEVELS_ON ? DMG_MULT[level - 1] : 1);

// The level a monster has when none is given: 2, clamped into the kind's range.
export function defaultLevel(kind) {
  const [lo, hi] = LEVEL_RANGE[kindOf(kind).id];
  return Math.min(hi, Math.max(lo, 2));
}

// One level per monster from its own stream (`seed ^ 0x3c6ef372`), one draw per monster in order and drawn after the
// kind stream, so dungeons, spawns and kinds never change. `kinds` = the kind id per monster. Levels off: all default.
export function assignLevels(seed, kinds) {
  const rand = rng(seed ^ 0x3c6ef372);
  return kinds.map((kind) => {
    const r = rand(); // drawn even when levels are off, so a toggle never shifts the stream
    const [lo, hi] = LEVEL_RANGE[kindOf(kind).id];
    if (!LEVELS_ON) return defaultLevel(kind);
    const w = WEIGHTS[kind].map((x) => Math.max(0, x));
    const total = w.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return lo + Math.min(hi - lo, Math.floor(r * (hi - lo + 1))); // all weights 0: uniform
    let acc = 0;
    for (let i = 0; i < w.length; i++) { acc += w[i]; if (r * total < acc) return lo + i; }
    return hi;
  });
}

// Testbed `levels` value -> one level per monster: 'random' (assignLevels) | a number 1-3 | a list, cycled.
export function levelsFor(spec, seed, kinds) {
  if (spec === 'random') return assignLevels(seed, kinds);
  if (Array.isArray(spec)) return kinds.map((_, i) => spec[i % spec.length]);
  return kinds.map(() => spec);
}

// A kind's hp and claw damage at a level: the kind base times the level's multiplier (min 1, rounded).
// Levels off: the base, whatever the level. Speed and stun never change with level.
export function levelStats(kind, level) {
  const spec = kindOf(kind);
  if (!Number.isInteger(level) || level < 1 || level > 3) throw new TypeError(`monster level must be 1, 2 or 3, got ${JSON.stringify(level)}`);
  const cfg = skillConfig();
  const baseClaw = spec.id === 'troll' ? cfg.trollClawDamage : cfg.clawDamage;
  if (!LEVELS_ON) return { hp: spec.hp(), clawDamage: baseClaw };
  return {
    hp: Math.max(1, Math.round(spec.hp() * HP_MULT[level - 1])),
    clawDamage: Math.max(1, Math.round(baseClaw * DMG_MULT[level - 1])),
  };
}
