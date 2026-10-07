# Plan: skills (attack and block) for the explorer and the ghosts (2026-10-07)

## Bottom line

Every character gets a **skill set**: up to 4 stateful skill instances built from its equipment or nature. The set is mirrored as plain JSON into its memory and its Jev state. On any tick Jev may answer one extra `skill` Choice question **in the same request as the move**. The question is asked only when some skill can actually do something right now, and `none` is always an option. The first two skills are universal:

- **Attack.** The actor turns to an aim, and every cell in the skill's shape flashes red for an instant. Any character standing in those cells takes a hit. The base shape is the one cell in front.
- **Block.** A stance. Until the blocker's next turn, an attack that lands on its cell is stopped completely with probability `effectiveness`; otherwise the full hit lands. The roll uses a seeded RNG.

The explorer gets a **sword strike** and a **shield block**; each ghost gets a **claw strike** (the same base attack) and **no block**. Later skills (area attacks, better shields, and others) are subclasses or loadout entries, with no brain changes.

Skills ride on the existing request, so they add bytes, never calls, on a normal tick. Restraint ("only when needed") comes from Jev: `none` is listed first, the instruction says most steps need none, and a confidence floor applies. A code gate also decides when the question is asked at all (D7).

**This supersedes** PLAN-memory.md P3 and PLAN-adversary-memory.md A5. Both describe this same hookup, so this plan replaces both.

**Decisions (final, 2026-10-07): all agreed; D2 and D3 as changed by the user.**

| # | Decision | Recommendation | Alternatives |
| --- | --- | --- | --- |
| D1 ✔ | What a hit does to a ghost (ghosts have no health today) | Ghosts get 2 hit points (private). A hit knocks the ghost 1 cell away from the attacker and **stuns** it for 2 ticks (no step, no Jev call). At 0 it is **dispelled**: removed from the game, with a `dispelled` event. | Stun only, no death; or a dispelled ghost respawns far away after N ticks |
| D2 ✔ | Ghost skills | **Decided:** ghosts get the same base attack (claw strike, 1 cell in front) and **no block skill**. An explorer strike on a ghost always lands (no roll). | |
| D3 ✔ | Touch damage (AGENTS rule 6) | **Decided:** a touch **no longer damages**. Only attacks take lives. A touch becomes a bump: knockback only, no event beyond `bump`. Grace and the one-hit-per-tick latch now apply to attacks. Because ghosts would be harmless in between, touch damage goes away **in the same phase** that gives ghosts their attack (S4), not before. | |
| D4 ✔ | Forced ticks (one legal move: the explorer makes no Jev call today) and ghost ticks with `next_move` unasked | If a skill is feasible, send a **skill-only request** (state + 1 question). Those are cornered moments, exactly when a block or strike matters. Cost: +1 call on such ticks only. A ghost whose move already steps onto the explorer asks nothing (the touch is that tick's hit). | A code policy (for example, always strike when adjacent and ready), at no cost |
| D5 ✔ | Default numbers (settings knobs) | Sword: 1 damage, ready again after 1 turn. Shield: 0.6, ready again after 2 turns. Claw: 1 damage, 2 turns. Ghost hit points 2, stun 2 ticks. | Any; all of them are on the `/settings` page |
| D6 ✔ | Facing | A real 4-way `facing` on the server: the last step's direction, or the last strike's aim. The UI uses it instead of guessing from movement. right/up still draw facing right and left/down facing left, so the sprite rule is unchanged. | Keep the UI-only facing (then "front" only exists for the skill's aim) |
| D7 ✔ | When the `skill` question is asked | **Loose gate:** whenever at least one skill is ready **and** an opponent is visible or remembered within 10 steps. Jev keeps the discretion you asked for: it can pre-block or strike something code didn't foresee, and restraint comes from `none`, the instruction and `SKILL_MIN`. Cost: about 350-450 B on those ticks, no extra calls. | **Strict gate:** only when a skill would land now (an opponent in a strike cell, or one able to reach you before your next turn). Cheaper: about 0 B on most encounter ticks. Code then decides when a skill is even possible. |
| D8 ✔ | "Directly in front" vs turning | **Free turn (decided):** the strike aims at any of the 4 sides (one option per aim that holds an opponent, or every aim under the loose gate), and the actor turns to face it. The aim is part of the answer, so it never depends on the move answer. That avoids silent misses, because Jev answers each question independently. Facing still sets the shape for later cone or sweep skills. | **Literal:** strike only the cell in front of the current facing (at most one option). Hitting a ghost to the side then takes a step that turns you first. |

## Design

### Classes (`src/skills/`, replacing `src/capabilities/`)

```js
// skill.js: one instance per character per skill. Stateful (cooldown, uses), never sent as-is.
export class Skill {
  static kind = 'skill';
  #cooldownLeft = 0; #uses = 0; #lastUsedStep = null;
  constructor({ id, name, source, text, cooldown })  // source: 'sword' | 'shield' | 'claw' ...
  get ready()                                        // cooldownLeft === 0
  turnPassed()                                       // the owner's turn ended: count the cooldown down
  options(view, self) -> [{ key, fact, target }]     // feasible uses now; [] = not offered. Fog-safe view only.
  use(act, target) -> outcome                        // act = the actor's world handle (KnownWorld / ghost act)
  summary() -> { id, kind, name, text, ready, cooldown_left }   // plain JSON for memory and Jev
}

// attack.js
export class AttackSkill extends Skill {
  static kind = 'attack';
  shape = [[1, 0]];        // cells relative to the actor, x = forward, y = to its right; base = 1 cell in front
  damage = 1;
  cells(pos, facing)       // rotates `shape` to the aim, drops walls
  options(view, self)      // one option per aim (up/down/left/right); strict gate (D7): only aims whose cells hold a VISIBLE opponent now
}

// block.js
export class BlockSkill extends Skill {
  static kind = 'block';
  effectiveness;           // 0..1, from equipment
  options(view, self)      // one option; strict gate (D7): only if a visible hunting opponent is within 2 path steps (it could be adjacent at its next turn)
}

// skill-set.js
export const MAX_SKILLS = 4;
export class SkillSet { constructor(skills) /* throws over 4 or on duplicate ids */; options(view, self); get(key); summaries(); turnPassed(); }

// loadouts.js: data, not code. Kind -> class; a new behaviour (sweep, cone, radius) is a subclass.
export const LOADOUTS = {
  explorer: [{ kind: 'attack', id: 'sword_strike', name: 'Sword strike', source: 'sword', damage: 1, cooldown: 1 },
             { kind: 'block',  id: 'shield_block', name: 'Shield block', source: 'shield', effectiveness: 0.6, cooldown: 2 }],
  ghost:    [{ kind: 'attack', id: 'claw_strike',  name: 'Claw strike',  source: 'claw',  damage: 1, cooldown: 2 },
           ], // no block (D2)
};
```

- `defineCapability` / `feasibleOptions` / `actionQuestion` are retired. `actionQuestion`'s idea survives as `skillQuestion(options, contextLine, priorityLine)`. `check-capabilities.mjs` becomes `check-skills.mjs`, and the AGENTS.md repo-map row follows.
- **The aim is part of the option** (`sword_strike_up`, D8), never "whatever the move answer is". Jev answers each question independently, so "attack + move away" must not be able to silently miss. On a decision tick the request carries **one** `skill` question, not one per tactic.
- Area skills later only change `shape` (a 3-cell sweep is `[[1,-1],[1,0],[1,1]]`, a radius is a ring). Feasibility and resolution don't change.

### Where state lives (rules 4, 7 and the memory rule)

| State | Explorer | Ghost |
| --- | --- | --- |
| `SkillSet` (stateful instances) | `ExplorerBrain` private field `#skills` | `Adversary` private `#skills`, behind an accessor (not an own property, so JSON still shows 6 keys) |
| Facing | `Game.facing` (public field, like `graceTicks`) | private `#facing`, accessor `facing`, sent in `view()` only |
| Block stance | `Game.block = null \| { effectiveness, until_step }` | none (no block skill; a later loadout may add one) |
| Ghost hit points, stun | n/a | private (D1) |
| Block-roll RNG | `game.skillRand`, a new lazy seeded stream (`seed ^ <new constant>`), created on the first roll, like `patrolRand`. It never touches `generateDungeon` / `spawnAdversaries` rng order. | same stream |
| Memory mirror | `memory.skills[]` (≤ 4) | `memory.skills[]` (≤ 4) |

`memory` stays plain JSON. `skills` is regenerated from `SkillSet.summaries()` every turn (`{ id, kind, name, text, ready, cooldown_left }`), and both `validateMemory`s get new `LIMITS` (`skills: 4`, `skillText: 120`). Skill events go into the existing event rings: "Struck a1 with the sword", "Shield stopped a1's claw", "Dispelled a1".

### Order inside one tick

The skill resolves **before** the step. The facts Jev read are then exact at resolution: nobody moves between the explorer's decision and its strike, and the explorer does not move during the ghost phase.

1. **Explorer turn** (`ExplorerBrain.takeTurn`): one request with `next_move` (+ `skill` when feasible) → `world.useSkill(key)` (a new `KnownWorld` method, the only path from explorer code to the game): set facing to the aim, record the strike cells, apply hits to ghosts (block roll, knockback/stun/dispel) → `world.move(dir)` → `skills.turnPassed()`. A step that wins the game still wins.
2. **`stepAdversaries`**: grace read and decrement, then bump checks (a touch only knocks the ghost back, D3), sensing and budgets. Thinking ghosts' requests carry `skill` when feasible. Then, in id order, for each ghost that acts: **skill → step → bump check**. A ghost strike on the explorer uses the grace read and the one-hit-per-tick latch (today's `touch.canHit()`, renamed `hit.canHit()`): at most one life lost per tick, none during grace (the strike still flashes, with result `protected`). The explorer's shield rolls before damage. Losing the last life still emits `hit` then `caught`.
3. `game.strikes` (cleared at the start of each tick) collects `{ by, cells, result }` for `view().strikes`.

A ghost acts only on ticks where its budget allows a step (speed 0.6), so its attack rate is naturally lower than the explorer's.

Resolution code: `src/skills/resolve.js` (`resolveAttack(game, attacker, cells, damage, { canHit })`). It is world rules, so it may read the `Game`, and it is called from `KnownWorld.useSkill` and from `stepAdversaries`. `dungeon.js` stays untouched apart from the new public fields; its `placeProps`-only import rule holds.

### How Jev sees skills (requirement a: callable any time; c: optional)

- `game` rules: one sentence, once per request: "You have up to 4 skills (`self.skills`). Besides moving you may use at most one per step; most steps need none."
- `self.skills`: the mirror above.
- `skill` question (Choice), present only when `options` is non-empty:

```
question: "Besides the move, use at most one skill this step. Choose `none` unless a skill clearly helps right now. <mind's skill_priority line>"
criteria: {
  none:              "Use no skill this step (the usual choice).",
  sword_strike_left: "Strike the cell to your left: a1 is there now (you have hit it once). Ready again next step.",
  shield_block:      "Raise the shield until your next step: 60% chance to stop an attack on your cell. a1 is adjacent and chasing you."
}
```

**Fog (rule 1) for skill facts.** Explorer facts use only what the explorer can observe: positions and modes from `visibleAdversaries()`, its own skills, and its own memory of strikes it landed ("you have hit a1 once", counted per seen id in its private bookkeeping). They never use a ghost's cooldown, hit points or loadout, which `visibleAdversaries()` does not expose. Showing a ghost's health or readiness as a visible tell would amend rule 1 and needs its own OK. The ghost side reads the real game today (an explorer's sword cooldown is allowed there). When `AdversaryView` lands it must decide whether the explorer's readiness is observable, and `keepDistance` then reads only what the view allows.

Three layers keep skills optional, cheapest first:
1. **Gate** (code, D7): the question is asked only when a skill is ready and an opponent is near (loose) or a skill would land now (strict). Until ghosts get attacks (S4), the explorer's block option is left out: it has nothing to stop.
2. **`none` option** plus the instruction. `none` is listed first and not shuffled (Jev leans toward the first option; here that bias is wanted). Measure it in S6.
3. **Confidence floor** (code): a skill is used only when its probability is ≥ `SKILL_MIN` (0.5); otherwise `none`. Logged in the turn as `skill_decision: { choice, probabilities, used }`.

### Skills shape the mind (requirement b)

- **Explorer minds:** each entry in `SENTIMENTS` gets a `skill_priority` line, used in the `skill` question and appended to `next_move` priorities while a skill is feasible.

  | mind | skill_priority (draft) |
  | --- | --- |
  | aggressive | Strike an adjacent adversary whenever the sword is ready. |
  | courageous | Strike when it is adjacent and you have a life to spare; otherwise block. |
  | curious | Use a skill only to clear the way to unexplored ground. |
  | cautious | Block when an adversary can reach you; strike only to open a way out. |
  | risk_averse | Block when an adversary can reach you; never stay adjacent to strike. |
  | scared | Block if caught close; never strike. |

- **Tactics:** `face_off` (today only "hold an open area") gains a fact when the explorer holds a ready attack: "you can strike it if it comes adjacent". `tacticFeasibility` is unchanged in S3; a real `fight` tactic is a follow-up, decided after S6 metrics.
- **Encounter facts:** the sentiment request sees `self.skills`, so it can pick a bolder mind with a sword and a shield in hand. No new encounter sentence.
- **Ghost characters:** the `aggression` trait gets an attack line ("strike whenever adjacent" at 3, "strike only when cornered" at 1). The reserved `caution` trait (character.js `RESERVED_TRAITS`, "dormant until an explorer attack capability exists") becomes live: with no ghost block, it only wakes the dormant `keepDistance` row (keep 2 cells from an explorer with a ready sword). `standard` stays all 2s.

## Phases

Each phase leaves all checks green. Ghost-side phases wait until the in-flight adversary work (12 uncommitted files on `main` today) is committed.

| Phase | What | Behaviour change | Files (owner) |
| --- | --- | --- | --- |
| **S1 Engine** | `src/skills/` classes, loadouts, `SkillSet`, `resolve.js`; `Game.facing`, `Game.block`, `game.skillRand`, `game.strikes`; ghost private skill set (claw), facing, hit points, stun; dispel cleanup (the ghost leaves `game.adversaries`, `team()`, pack alert and `adversaries.json`); `KnownWorld.useSkill`; settings knobs (Skills group: per-skill numbers, no feature toggles: S4 switches the damage model in one step); testbed knobs. No Jev wiring: skills are only driven by checks. | none in play | `src/skills/*` (new, shared); `dungeon.js`, `known-world.js` (world agent); `adversary.js` (adversary agent); `settings.js`, `testbed.js` (shared) |
| **S2 Memory and state** | `memory.skills` in both memories, `LIMITS`, `self.skills`, the rules sentence; request-size re-measure | requests grow ~200-300 B | explorer `memory.js`, `brain.js` (brain agent); adversary `memory.js`, `brain.js` (adversary agent) |
| **S3 Explorer wiring** | `skill` question (normal, decision and forced ticks per D4), `SKILL_MIN`, dropping a dispelled ghost's sighting from `#seen` and the avoid zone (fog-safe: the explorer saw the dispel), `skill_priority` lines, `face_off` fact, turn shape `skill_decision`, events | the explorer strikes ghosts; ghosts take hits per D1 | `brain.js`, `perception.js` (brain / world agent) |
| **S4 Ghost wiring + damage switch** | the ghost `skill` question, the aggression line, `caution` → `keepDistance`; **in the same change** touch becomes a bump (D3), `rules()` texts on both sides and the "Steps into the adversary" move facts are rewritten (a touch costs nothing, an adjacent ghost with a claw does) | ghosts strike, touches stop hurting, the explorer's block becomes useful | `adversary/*`, `character.js` (adversary agent) |
| **S5 UI** | red flash on `view().strikes` cells (fog: hidden unless Reveal, like ghosts), shield glyph while blocking, server facing, a skills list with readiness in the pane, event log lines, ghost hit points in Reveal | visual only | `turn.js` `view()` (adversary agent); `public/*` (UI agent) |
| **S6 Measure** | dry `measure-memory.mjs` + a new `skills` fixture arena; then **one live run only on your go-ahead** | tune `none` placement, `SKILL_MIN`, numbers | `scripts/*` (shared) |

### Testbed knobs (rule 10)

| Key | Default | Meaning |
| --- | --- | --- |
| `explorerSkills` | `'default'` | `'default'`, `'none'`, or a list of loadout ids (≤ 4), e.g. `"sword_strike,shield_block"` |
| `ghostSkills` | `'default'` | `'default'` (claw) or `'none'` (a harmless ghost, for exploring tests) |
| `ghostHp` | from settings | 1..5 |

A `map` with an `A` next to `@` gives the adjacency scenarios with no new knob.

## Checks (all free, stubbed)

- **`check-skills.mjs`** (replaces `check-capabilities.mjs`): `SkillSet` caps at 4 and rejects duplicates; shape rotation for all 4 facings (and a 3-cell sweep, so area skills are covered before they exist); cooldown counting; `summary()` is plain JSON; deterministic block rolls (same seed → same sequence; 10 000 rolls at 0.6 land within ±0.02); `resolveAttack` covering a hit, block success, block failure, grace (`protected`), the one-hit-per-tick latch with two ghost strikes on the same tick, a touch never costing a life, knockback, stun, dispel.
- **Fog of skill facts:** a twin that scrambles a *visible* ghost's cooldown, hit points and loadout requires an identical `skill` question and identical move facts (the hidden-ghost twins below do not cover this).
- **`check-dungeon.mjs`:** the static guard allowlist adds the `src/skills/` exports for explorer files. `src/skills/` itself gets a guard: `options()` reads only its `view` argument (no `game.`, no `.dungeon`). **Twin tests:** a hidden ghost moved or scrambled gives a byte-identical `skill` question and `self.skills`. A stub-brain run asserts that no `skill` question is sent while the D7 gate is closed. After a dispel, `threats.remembered` no longer lists that ghost. Request-size asserts are re-checked: the budget is **+600 B** on the largest decision tick. If 9500 / 10500 break, `text` leaves `self.skills` (the rules sentence covers it) before raising a bound, and any raise is recorded in AGENTS open issues.
- **`check-adversaries.mjs`:** ghost strike under grace, shield vs claw, a touch is a bump (no `hit`, the ghost is knocked back), the existing damage checks rewritten from touch to strike, a stunned ghost makes no Jev call, a dispelled ghost leaves the tick order cleanly, and requests are still built synchronously in id order.
- **`check-testbed.mjs`:** the new knobs, plus a scripted adjacency scenario where a stub picks `sword_strike_<dir>` and the ghost takes the hit.

## Cost

- Normal ticks: **0 extra calls**. The `skill` question rides in the existing request, only while the D7 gate is open: about 350-450 B with the loose gate, less with the strict one.
- Forced ticks with the gate open: +1 small request each (D4). This is the only new call site; with a code policy it costs 0.
- Stunned ghosts skip their Jev call, which saves calls.
- Every check stays stubbed with the `fetch` tripwire.

## Docs to update when a phase lands

AGENTS.md: rule 6 rewritten (a touch is a bump; only attacks take lives, with grace and one hit per tick), a new **Skills** section, the repo-map rows (`src/skills/`, `check-skills.mjs`), the open issues "capabilities are a scaffold" and request size. CONTRACT.md: `Game.facing / block / strikes / skillRand`, `KnownWorld.useSkill`, the turn shape `skill_decision`, `view().strikes`, the memory `skills`. PLAN-memory.md P3 and PLAN-adversary-memory.md A5 each get a one-line "superseded by PLAN-skills.md".

## Execution (2026-10-07)

Phases run in order, each by one Sonnet coding agent; Opus orchestrates and reviews each phase (diff read + all `check-*.mjs` green) before the next starts. Gym scenarios after S5, on hub instances (`node scripts/arenas.mjs up --gym ...`), bounded live runs, instances downed afterwards:

| Scenario | Arena | Expect |
| --- | --- | --- |
| adjacent ghost | 9x9, ghost 1 cell from the start | explorer strikes (sword_strike_<dir>), ghost knocked back and stunned; second hit dispels |
| corridor duel | corridor map, ghost at the far end | ghost strikes when adjacent; shield block rolls; touches only bump |
| no threat | 11x11, `numAdversaries=0` | no `skill` question ever asked |
| two ghosts | open room, 2 ghosts | at most one life lost per tick; block offered |

## Status at pause (2026-10-07, ~12:10) — resume here

Nothing from this plan is committed. All work is in the working tree on `main` (some of it staged by an earlier `git add` from another session; the index is not meaningful). The other session's adversary-memory work is committed (623b5db) and it is idle.

### Done and reviewed

| Phase | Files | Notes |
| --- | --- | --- |
| S1 engine | `src/skills/{skill,attack,block,skill-set,loadouts,question,resolve,config}.js`, `src/dungeon.js` (`facing`, `block`, `strikes`, `skillRand`, `skillRandom()`, `clearTickState()`), `known-world.js` (`facing`, `useSkill`), `scripts/check-skills.mjs` | Attack offers only aims whose cells hold a visible opponent (stricter than "every aim"; deliberate). `useSkill` returns an events array or null. Explorer strikes emit `struck` / `dispelled` + `strike` events. |
| S2 + S3 explorer | `explorer/brain.js`, `perception.js`, `memory.js` | One `skill` question per request, never per tactic or in the sentiment call; `none` first; `SKILL_MIN` 0.5; `skill_priority` per mind; `face_off` "can strike" fact; `memory.skills` mirror (≤4); `self.skills` without `text` (size bound). `GHOSTS_CAN_ATTACK = true` in brain.js keeps the shield offered. Forced-tick path (D4-a) exists but is dormant: `availableMoves()` always includes `stay`. Request sizes 9436 / 10389 B (bounds 9500 / 10500). |
| Settings, testbed, guard | `settings.js` (Skills group, 8 knobs, `when: next`), `src/skills/config.js` (`configureSkills`, `skillConfig()`), `testbed.js` (`explorerSkills`, `ghostSkills`, `ghostHp`; helpers `explorerSkillSetOf(cfg)`, `ghostSkillSetOf(cfg)`), `check-testbed.mjs` 5b, `check-dungeon.mjs` (allowlist, section 0c skills guard, visible-ghost fog twin, dispel twin, bump wording), `scripts/arenas/skills.json`; `src/capabilities/` + `check-capabilities.mjs` deleted | |
| S5 UI | `public/app.js`, `style.css`, `index.html` | Red/steel strike diamonds (fog-hidden unless Reveal), shield glyph, hp pips (Reveal), Skills pane block, log lines from `struck`/`dispelled`/`strike`/`blocked`/`bump`. Headless-checked against a fake server only. |

### S4 ghost side: mostly written, NOT reviewed (agent was stopped mid-run)

In the tree: `Adversary` private `#skills`, `#facing`, `#hp/#maxHp`, `#stun` with accessors, `takeHit()` (stun from `skillConfig()`), `tickStun()`; `stepAdversaries` with `bumpCheck` (touch = bump), stunned ghosts skip, claw strike via `resolveAttack` for hunting ghosts; adversary `brain.js` skill question (loose gate, skill-only request, `skillPriority` line, new rules text); adversary memory skills mirror; `turn.js` calls `clearTickState()` and sends `facing`, `hp`, `max_hp`; `check-adversaries.mjs` partly rewritten.

### Remaining work, in order

1. **Finish S4** (DONE) (one Sonnet agent, files: `adversary/*`, `turn.js`, `skills/resolve.js`, `check-adversaries.mjs`, `check-skills.mjs`):
   - `turn.js` `newTestGame`: read `config` from `buildArena`; pass `skills: explorerSkillSetOf(config)` to `ExplorerBrain` (Run needs an opt for it); give ghosts `ghostSkillSetOf(config)` and `config.ghostHp ?? skillConfig().ghostHp`. `view()` top-level `block: game.block`.
   - `resolve.js`: drop the temporary ghost WeakMap / `hitGhost` fallback now that `Adversary.takeHit` exists (update `check-skills.mjs` and the check-dungeon fog twin, which calls `hitGhost` when `takeHit` is missing); read hp/stun from `skillConfig()`.
   - Verify the caution trait → `keepDistance` and aggression → strike line; ghost strikes respect grace + one-hit-per-tick latch; 'caught' on last life.
   - Get `check-adversaries.mjs` green (strike damage, bump, grace → protected, two strikes one hit, shield vs claw seeded, stunned = no Jev call, dispel, six public keys, synchronous request building).
2. **Review + full check run** (DONE): `check-skills`, `check-dungeon`, `check-adversaries`, `check-testbed`, `check-characters`, `check-memory-kit`, `check-props`; dry `measure-memory.mjs --arena skills`. Report ghost request max size.
3. **Docs** (DONE; one Sonnet agent): AGENTS.md rule 6 rewritten (touch = bump, only strikes take lives), a Skills section, repo-map rows (`src/skills/`, `check-skills.mjs`, capabilities gone), open issues (request size headroom ~60 B, dormant D4-a path); CONTRACT.md (`Game.facing/block/strikes/skillRand`, `KnownWorld.useSkill`, turn `skill_decision`, `view().strikes/block`, adversary `facing/hp/max_hp`, memory `skills`, new event types); one-line "superseded by PLAN-skills.md" in PLAN-memory.md P3 and PLAN-adversary-memory.md A5.
4. **Commit** (DONE: 727aa56 on feature/skills; ask the user first).
5. **Gym runs (DONE, see below; paid, user-approved)**: the four scenarios in the Execution table via `node scripts/arenas.mjs up --gym ...` with `--opt` maps, ~30 ticks each, then `arenas.mjs down`. Report strikes, blocks, bumps, lives lost, how often `skill` was asked vs used, and request sizes.

## Gym results (2026-10-07)

4 scenarios x 30 ticks on the live Jev.

| Scenario | Skill asked / used | Outcome |
| --- | --- | --- |
| Adjacent ghost | asked 7x, used 0 (sword 0.14 at best) | Explorer ran away, 2/2 lives. |
| Corridor | asked 9x, used 4 (all shield) | 6 bumps, the ghost never struck: a **bump-lock**. Fixed here: a bump keeps the ghost's budget (only a sword hit's knockback stuns). Check added in `check-adversaries.mjs`. |
| No threat | never asked | As designed. |
| Two ghosts | asked 3x, used 1 (shield) | One claw hit landed, 1/2 lives, pack alert fired. |

Open:
- Jev rarely picks the sword (0.01-0.19): tune the skill text / `SKILL_MIN`.
- Per-ghost skill decisions are not in the turn's `adversaryTurns`.
