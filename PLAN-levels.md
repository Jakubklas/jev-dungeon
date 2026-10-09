# Plan: enemy levels (2026-10-09)

**Status: built (2026-10-09), L1-L4 done.** All `scripts/check-*.mjs` pass with `JEV_CONFIG=none`. Deviations from the plan, as shipped (code wins):
- `KnownWorld.levelsOn` getter added (config switch); with levels off no `level` / `claw_lives` reaches Jev, so requests are byte-identical to before.
- The cautionClaws knob is wired through `configureExplorerEncounter({ levelCautionClaws })` in encounter.js; `matchup(world, th, damage)` takes the sword damage as a third argument.
- `engageTarget` skips a too-strong threat unless cornered (the caller's flag or the corner model's verdict); the weak line is in `fightFacts`.
- Extra kinds.js exports: `LEVELS`, `configureLevels`, `levelsSnapshot`, `levelsOn`, `clawMult`, `defaultLevel`, `levelsFor`. `assignLevels` draws even with levels off (a toggle never shifts the stream); all-zero weights fall back to even.
- Adversary: with levels off the level is forced to 2; an explicit skill loadout's claw is scaled by the level too.
- View field names: `level`, `claw_damage` on `view().adversaries[]`; `view().explorer.remark`. Request fields: `level`, `claw_lives`.
- L4 checks: `check-levels.mjs` (explorer side), `check-config.mjs` section 9 (draw, stats, knobs, testbed), `check-kinds.mjs` (exports, stream independence, spawn wiring, view). `check-skills` and `check-request-hashes` needed no change.

## Bottom line

Every monster gets a **level 1-3**, drawn at spawn: **ghosts 1-2, trolls 2-3**. The level scales its hp and claw damage (multiplier on the kind base). The explorer sees the level of monsters in sight (same fog amendment as the health bar), weighs it against its own lives before engaging, and says so out loud ("Ah, that's a weak target." / "I don't have enough health to fight this guy."). Builds on the uncommitted working tree as it is (skills work stays paused).

Owner decisions (2026-10-09): level visible to Jev in sight only (frozen at sighting afterwards); stats are a **multiplier on the kind base**; enemy level is **separate** from the character presets' trait levels 1/2/3 (timid/standard/aggressive are untouched).

## Design

**Distribution.** Own seeded stream `seed ^ 0x3c6ef372`, one draw per monster in id order, drawn after the kind stream, so dungeons, spawns and kinds never change. Uniform within the kind's range; per-level weights are a config knob. Testbed `levels` key (`'random'` | one number | list, cycled) like `kinds`.

**Stats.** `hp = max(1, round(kindHp * hpMult[level]))`, `clawDamage = max(1, round(kindClaw * dmgMult[level]))`. Defaults `hpMult {1: 0.5, 2: 1, 3: 1.5}`, `dmgMult {1: 1, 2: 1, 3: 1.5}` give ghost L1/L2 = 1/2 hp, claw 1/1; troll L2/L3 = 4/6 hp, claw 2/3. Level 2 equals today's base, so the default game barely shifts. Speed and stun unchanged.

**Interface (the contract between work packages).**
- `Adversary.level` (1-3, fixed at spawn, public accessor) and `Adversary.clawDamage` (resolved at construction).
- `kinds.js`: `LEVEL_RANGE = { ghost: [1, 2], troll: [2, 3] }`, `assignLevels(seed, kinds)`, `levelStats(kind, level) -> { hp, clawDamage }`. Constructor takes `level` (default: the kind's lowest-level-2 base, i.e. 2 clamped into the range).
- `publicView().adversaries[]` and `KnownWorld.visibleAdversaries()` carry `level` and `clawDamage` for monsters in sight. Remembered sightings keep both, frozen.
- Explorer: `encounter.js` threat records get `level`, `clawDamage`; `matchup(world, th)` returns `'weak' | 'even' | 'too_strong'` from the health bar, the sword damage and the explorer's lives.
- `view().explorer.remark` is a short code-chosen string (or null) for the UI bubble.

**Matchup rule (code).** `strikes = ceil(hp / swordDamage)` (strikes to dispel it); `claws = ceil(lives / clawDamage)` (claws that kill the explorer). `weak`: strikes = 1 and claws > `cautionClaws`. `too_strong`: claws <= `cautionClaws` (default 1: a single claw would kill the explorer) and strikes > 1. Else `even`. `too_strong` removes `engage` from the tactic options for that threat (like `allowedMoods` removes moods), unless it is cornered (no escape route); `weak` adds a fact line to the engage option. Both are listed in the tactic facts sent to Jev ("level 3 troll, 6 hp, claw takes 3 lives; you have 4 lives"). Remarks: pools in `ui.thoughts.explorer.weak_target` / `.too_strong` text knobs, picked deterministically (no rng), shown once per sighting.

**Knobs (registry, `monsters.levels.*`).** `enabled` (default true; off = every level 2 and today's request bytes), `hpMult`, `dmgMult` (3-tuples), `weights.ghost`, `weights.troll`, `cautionClaws`, text pools. CONFIG.md regenerated.

**Fog.** `level` and `clawDamage` join `hp` as in-sight reads in `KnownWorld`; explorer files import nothing new, so the static guard allowlist is unchanged. Update AGENTS.md rule 1 to name level.

## Work packages (Sonnet agents code, I review; files disjoint)

| | Owns | Depends |
| --- | --- | --- |
| **L1 core** | `kinds.js`, `adversary.js` (level, stats), `dungeon.js` publicView, `testbed.js` `levels` key, registry rows, `config/runtime.js`, `central-config.yaml` template, CONFIG.md regen, `check-config` | none |
| **L2 explorer** | `known-world.js`, `encounter.js`, `perception.js`, `brain.js` (matchup, option gating, facts, remark), `thoughts` text knobs | L1 |
| **L3 UI** | `public/app.js`, `public/thoughts.js`, CSS/`style` for a level badge on monsters (pip count or tint, per STYLE_GUIDELINES), explorer remark bubble | L1 (L2 for `remark`) |
| **L4 checks + docs** | new `scripts/check-levels.mjs`, update `check-kinds`, `check-skills`, `check-request-hashes`, AGENTS.md, CONTRACT.md | L1-L3 |

Order: L1, then L2 and L3 in parallel, then L4, then my review and full free checks. No Jev calls anywhere (stubs only); no paid gym runs unless you ask.

## Acceptance

- Ghost levels only 1-2, troll only 2-3, over 500 seeds; same seed gives the same levels; dungeons/spawns/kinds byte-identical to before.
- `enabled: false` reproduces today's stats and request hashes exactly.
- Fog guard passes; no level/hp for an unseen monster reaches Jev.
- Stubbed duel: explorer at 2 lives declines a level-3 troll and says the line (ghosts of any level are never too strong at 2 lives, a level-1 ghost is weak); explorer at full lives engages a level-1 ghost and says the weak-target line.
- Request size bounds (`REQUEST_BYTES`) hold.
- All `scripts/check-*.mjs` free checks pass (baseline taken first; pre-existing failures from the paused skills work are reported, not hidden).
