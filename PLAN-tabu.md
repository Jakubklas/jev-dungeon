# PLAN-tabu: hard exclusion of options that keep failing

A plan, not documentation of the code. **Phases 0, 1, 2, 3, 4 and 5 are built** (see Status at the end and AGENTS.md "Tabu"); phase 6 (measurement script) is built, its live comparison is open. Phases need the user's approval
(AGENTS.md rule 9: `explorer/brain.js` and `adversary/brain.js` belong to other agents).

## Goal

When a character keeps repeating something that is not working, take that option **out of the
request**. Jev never sees it, so it has to pick something else. This is not a prompt hint. It applies
at three levels for the explorer (moves, moods, tactics) and two for **every monster** (moves, search
approach). "Monster" means every kind (`ghost`, `troll`, `tree_giant`, `wolf`, and any kind added later):
they all decide through the same `adversary/brain.js` (`decide` -> `buildRequest`, called for each hunting
monster from `stepAdversaries`), so one implementation there covers all of them. No per-kind code.

Tabu search here has no randomness: an option is excluded because of what the character did, not
by a dice roll. So it adds no `rng()` stream, keeps rule 8 and is replayable in the checks.

## Design principles

1. **Tabu is keyed on attributes, not on raw directions.** "left" means nothing two ticks later.
   A move is tabu when its **destination cell** is tabu (or it is `stay` and `stay` is tabu). Each
   tick the tabu cells are turned back into the directions to drop.
2. **Something becomes tabu only after a detected stall.** A one-off choice never becomes tabu.
   Each rule below names the stall that triggers it.
3. **Tenure.** Each entry expires after N steps, or at an event (the encounter ends).
4. **Aspiration rules come before the filter.** A tabu entry is lifted when keeping it would be
   unsafe or would leave nothing to choose from. Safety beats variety.
5. **Fog-safe by construction.** Tabu state is built only from the character's own choices, its
   own cells and outcomes it already records (`recent`, encounter bookkeeping, its own strikes and
   hits). It reads nothing new from the world.
6. **On by default.** Off is a kill switch and a measurement arm, and it is byte-identical to today's
   code. With it on and nothing tabu, requests are also identical (nothing removed, no new text), so
   requests differ only after a stall has actually fired.
7. **Removing options only shrinks requests.** The only new text is one memory event per new tabu
   entry, which reaches Jev through `recent.events` and explains why an option is gone. The bounds
   in `check-dungeon.mjs` (9500 / 10500 B) cannot be broken by the filter itself.

## The module: `src/characters/shared/tabu.js`

Pure, imports nothing, no clock, no rng (like `progress.js` and `memory-kit.js`). Shared by both
characters so the rules are written once.

```js
// One list per level. Entries: { attr, until, reason, since }.
export function createTabu() -> { cells: [], moves: [], moods: [], tactics: [], approaches: [], strikes: {} }
export function age(tabu, step)                       // drops entries with until <= step (and per-encounter ones on endEncounter)
export function add(tabu, level, attr, { step, tenure, reason }) -> boolean   // true when new (the caller logs one event)
export function isTabu(tabu, level, attr, step) -> boolean
export function strike(tabu, level, attr) -> count    // "it failed again" counter toward the threshold
export function clearStrikes(tabu, level, attr?)      // progress resets the counters
export function endEncounter(tabu)                    // drops the entries with until === 'encounter'

// The filter, with aspiration: returns the options to send and the ones lifted, with the reason.
export function filterOptions(ids, isTabuFn, { keep = [], min = 1, order }) -> { allowed, removed, lifted }
//   keep:  ids that are never removed (aspiration: portal move, the engage holding cell, safety)
//   min:   the menu never drops below this; if it would, the entries with the least tenure left are
//          lifted first (ties in `order`), so the result is deterministic
export function snapshot(tabu, step) -> { moves, moods, tactics, approaches }   // for turn.tabu / view(), never sent to Jev
```

Tabu state is a **private field** (`#tabu` in `ExplorerBrain`, inside each monster's private hunt state).
It is **not in `memory.json`**, so the memory shape and `validateMemory` stay unchanged, like
`#exclude` and `#seen` today.

Static guard: add `'../shared/tabu.js'` to the explorer allowlist (`check-dungeon.mjs:56`) and the
adversary allowlist (`:102`), next to `memory-kit.js`. Purity is asserted the same way as
`progress.js`: it imports nothing.

## Level 1: moves (direction of travel)

### When a cell or move becomes tabu

| Rule | Stall detected | Becomes tabu | Tenure |
| --- | --- | --- | --- |
| M1 bounce | `backAndForth(recent.cells)` >= 2 in the last 6 moves | the cell bounced back to (the one 2 back) | 6 steps |
| M2 loop | a cell entered >= 3 times in the last 12 steps (a 3-4 cell shuttle round a corner, which M1 misses) | that cell | 8 steps |
| M3 idle | `stay` chosen 3 ticks in a row, none of them a hold tick | `stay` | 4 steps |

M2 needs a 12-cell window. `memory.recent.cells` holds 8 (`LIMITS`), so the brain keeps its own
12-entry ring (private, not memory). The explorer's tabu list absorbs today's `#exclude` *cell*
use (phase 4). `#exclude`'s *target* use (no tactic may target those cells) stays as it is.

### Where the filter runs (explorer)

`takeTurn` (`brain.js` around line 830):

```js
const legal = world.availableMoves();
const moves = this.#tabuMoves(legal, sit);   // NEW: filterOptions over legal
```

- `#moveQuestion` takes `moves` instead of calling `world.availableMoves()` (today
  `const dirs = shuffle(world.availableMoves())` and the `shared` map). The speculative
  `move_if_<tactic>` questions and `surroundings.moves` use the same filtered list.
- Answer validation becomes `moves.includes(a.choice) ? a.choice : moves[0]` (today `legal`).
- **One move left after filtering** means code takes it with no `next_move` question (money saved).
  `turn.forced` stays the raw "one legal move" meaning. The new `turn.tabu.forced` is set instead.
- `#lethalWalkIn` still runs after the answer and may still turn the move into `stay` (aspiration A2).

### Move aspiration (a tabu move stays on the menu when...)

- **A1** it steps onto the portal (`whole` win move).
- **A2** removing it would leave only moves that are "below your minimum gap" / onto an enemy while
  this one is not. Needs a per-move safety flag from `describeMoveParts`: it already computes the
  gap per move, so it can return `{ safe }` beside `shared` / `target` without changing text.
- **A3** it is the engage holding cell or its approach (under `engage`, destination = the engage
  target): the hold is the measured zero-claw play (`check-duels.mjs`).
- **A4** cornered (`#cornerOpt()`): the pocket cells are the way out, same reason `#bounce()`
  returns early today. In corner mode only M3 (`stay`) applies.
- **A5** `min = 2`: the menu never shrinks below 2 moves by tabu alone.
- Never on a hold tick (no question is asked), and not while a player directive is live: the player
  steers then.

### Monsters (all kinds)

`buildRequest` in `adversary/brain.js` filters `view.legalMoves()` the same way (M1-M3, A1 does not
apply). Cells come from the monster's own `recent` (filled only with `adversaryCharacters` on, so with it
off the monster keeps its own private ring in the hunt state). Aspiration: never drop the move that
strikes or bumps the explorer (it is in sight and adjacent), and keep `min = 2`. Keep `buildRequest`
synchronous (the shuffle ordering rule).

## Level 2: moods (sentiment)

### When a mood becomes tabu

A mood is **charged** when a sentiment decision in the same encounter re-decides (`tactic_failed`,
`hit`, `confidence`), the previous pick was that mood, and **nothing got better** since it was picked:

- no strike landed, no dispel;
- no heal (heart, regen above the level at pick time);
- the nearest chaser's gap did not grow by >= 2 and sight was not lost;
- C did not rise by >= 5.

| Rule | Becomes tabu | Tenure |
| --- | --- | --- |
| D1 | a mood charged **2** times in one encounter | until the encounter ends, at least 10 steps |
| D2 (outside encounters) | a mood under which **2** approach reviews in a row judged the approach failing (`approach_working < 0.5`) | 20 steps |

D1 is the "keeps choosing to run when a fight would help" case seen from the mood side: two
re-decisions under `cautious` / `wary` with no gain take that mood off the menu, so Jev must pick
`steady` / `bold` (if the tier allows them) or the other low mood.

### Where the filter runs

`#allowed(cap)` stays the tier rule. The filter goes right after it, in **both** places:

- `#askSentiment` (`brain.js:1253`): `ids = filterOptions(this.#allowed(caps), moodTabu, { min: 1 })`.
  One id left means code takes it with no call (the existing `ids.length === 1` branch). The
  question text already lists `ids`, so it follows automatically.
- The tier-swap block in `takeTurn` (`brain.js:841`): if the current mood becomes tabu with nothing in
  sight, it is a silent swap to `defaultMood(filtered list)`. With an enemy in sight it is a `confidence`-style
  trigger (reuse the once-per-encounter latch).

### Mood aspiration

- `panic` is code's, never tabu, never filtered.
- **Last life or sword down with a chaser close** (the forced-low-tier cases of `allowedMoods`): the
  low tier's moods (`wary`, `guarded`) are never both tabu. If both are, lift the older entry.
- `min = 1`. A tier with one mood is never emptied.
- `fixedMood` arm (duels, request-size checks): off.

## Level 3: tactics

### When a tactic becomes tabu

| Rule | Stall detected | Becomes tabu | Tenure |
| --- | --- | --- | --- |
| T1 ping-pong | `tactic_failed` fired by `#pingPong` (today it only excludes cells) | that tactic | 8 steps |
| T2 repeat | the same tactic picked **2** times in one encounter, charged as in D1 (no gain) | that tactic | until the encounter ends |
| T3 endless retreat | `run_away` or `hide` on for **12** ticks with the same chaser in sight or remembered within 15 steps, its gap not up by >= 2 and sight never lost for `end_ticks` | that tactic | until the encounter ends |
| T4 bad fight | `engage` cost **2** hits in this encounter with no strike landing | `engage` | until the encounter ends |

T3 is the "running away when a fight would be useful" case. T4 is the mirror, so the mechanism doesn't
push only one way. When the active tactic becomes tabu, `#encounterPolicy` fires `tactic_failed` (within
`REDECIDE_COOLDOWN`), so the re-decision happens on a menu without it.

### Where the filter runs

`tacticFeasibility(...)` is called in two places: the tactic menu (`brain.js:881`) and the "Tactics it
leaves here" list in `#askSentiment` (`brain.js:1265`). Wrap both in one private `#tactics(minGap, retreat)`
that applies the tabu filter, so the mood's description never lists a tactic the menu won't offer.
One tactic left means the existing branch where code takes it with no Choice.

### Tactic aspiration

- **`race_to_exit` is never tabu.** It is the win.
- `min = 1`.
- **Never remove the last retreat when the only tactic left is `engage` against a `too_strong`
  matchup**, or at `lives <= clawDamage` (one claw ends the game). Running is the right answer there,
  however often it repeats.
- `panic`'s menu (`run_away`, `race_to_exit`, a blocking `engage`) is never filtered.
- A live directive suspends tactic tabu (the player's call outranks it, as it outranks moods).
- `#retreatOK` still runs first: tabu only removes from what the tier allows, and never adds anything back.

### Monster search approach

The monsters' 3-ping-pong rule (`noteStep`, `adversary/brain.js:273`) sets `pickApproach` today, and
Jev often picks the same approach again. With tabu: the approach that ping-ponged becomes tabu for
`maxSearchTicks`. With only two search approaches, that leaves one, so code takes it and the
`search_approach` question is not asked (one fewer Choice).

## What Jev and the UI see

- **Jev**: the missing options, and one memory event per new tabu entry, e.g.
  `Ruled out run_away: 12 steps of running with the chaser no further away.` /
  `Ruled out the cell to the west for 6 steps: kept stepping back and forth.` (explorer
  `addEvent`, monster `addEvent` with its own tick). No rules sentence, no new state key.
- **Turn report**: `turn.tabu = { moves, moods, tactics, removed, lifted, forced }` (null when off).
  The adversary `turns[]` gets the same. Not sent to Jev.
- **UI (later, UI agent)**: a small "ruled out" line in the pane from `turn.tabu`.

## Config (central config, registry rows, all `when: 'next'`, file-only)

| Key | Default | Meaning |
| --- | --- | --- |
| `explorer.tabu.enabled` | `true` | master toggle (explorer) |
| `explorer.tabu.moves` / `.moods` / `.tactics` | `true` | per level, only with `enabled` |
| `explorer.tabu.bounceTenure` | 6 | M1 |
| `explorer.tabu.loopWindow` / `.loopVisits` / `.loopTenure` | 12 / 3 / 8 | M2 |
| `explorer.tabu.stayRun` / `.stayTenure` | 3 / 4 | M3 |
| `explorer.tabu.moodStrikes` | 2 | D1 / D2 threshold |
| `explorer.tabu.tacticStrikes` | 2 | T2 threshold |
| `explorer.tabu.retreatTicks` | 12 | T3 |
| `explorer.tabu.engageHits` | 2 | T4 |
| `explorer.tabu.minMoves` | 2 | A5 |
| `monsters.tabu.enabled` | `true` | every monster kind (moves + search approach) |

Wiring as usual: `let` constants with a `configureTabu` hook called from `src/config/runtime.js`,
a `tabuSnapshot()`, coverage in `check-config.mjs`, then regenerate CONFIG.md. Explorer files import nothing new.

These numbers are starting points, chosen so each rule needs about two failures before it acts:
- Tenures of 6-8 steps are just past the 6-move / 8-cell `recent` window, so a bounce can't simply
  resume the moment it drops out of memory.
- 12 ticks for T3: in 12 steps a ghost at speed 0.6 takes about 7, enough for a real escape to show
  as a growing gap or lost sight.

Tune them with phase 5's measurement, not by feel.

## Order of operations in `ExplorerBrain.takeTurn`

1. `#observe()` then `age(tabu, step)`. Score the **previous** tick's outcome: M1-M3 from `recent`, the
   "gain" checks for D/T charges. New entries log their event.
2. `#encounterPolicy`: if the active tactic is tabu, set `tactic_failed`.
3. Mood tier swap: filter `#allowed`.
4. `#askSentiment`: filter moods. Its tactic list goes through `#tactics()`.
5. Tactic menu: `#tactics()`.
6. Moves: `#tabuMoves(legal)`, used by every move question and for answer validation.
7. After the answers, record the picks (mood, tactic, move) with the step and the gain baseline
   (gap, C, lives, strikes) for the next tick's charge check.
8. `endEncounter(tabu)` where `chase_over` / dispel ends the encounter (beside today's `#exclude = null`).

No `await` is added. Everything here is synchronous bookkeeping.

## Phases

| Phase | Scope | Files | Done when |
| --- | --- | --- | --- |
| **0** | `shared/tabu.js` + `scripts/check-tabu.mjs` (pure: add/age/strike/filter, aspiration order, determinism, purity) + guard allowlist + config rows | `src/characters/shared/tabu.js`, `scripts/check-tabu.mjs`, `scripts/check-dungeon.mjs` (allowlist), `src/config/*`, CONFIG.md | check-tabu, check-dungeon section 0, check-config pass |
| **1** | Explorer **tactics** (T1-T4) + the shared `#tactics()` wrapper | `explorer/brain.js` | a stub that always answers `run_away` in a closed testbed room gets a tactic menu without `run_away` after T3, and the re-decision picks something else; duels unchanged |
| **2** | Explorer **moods** (D1, D2) | `explorer/brain.js` | a stub that always answers `cautious` sees it disappear from the sentiment criteria after 2 no-gain re-decisions; last-life aspiration holds |
| **3** | Explorer **moves** (M1-M3, A1-A5), `describeMoveParts` gains `safe` | `explorer/brain.js`, `explorer/perception.js` | the run_away corner shuttle (AGENTS.md open issue) and the dead-end bounce stop; no request ever has fewer than 2 moves; portal move never removed |
| **4** | Fold `#exclude`'s cell use into tabu; remove `#bounce()`'s cell half | `explorer/brain.js` | check-dungeon 4f numbers do not get worse |
| **5** | Monsters (all kinds): moves + search approach | `adversary/brain.js`, `adversary.js` (hunt state) | `check-adversaries` passes; a ping-ponging searching monster of each kind (ghost, troll, tree_giant, wolf) picks the other approach with no `search_approach` call |
| **6** | Measure (free, stubs) and one live comparison (paid, on request only) | `scripts/measure-tabu.mjs` | table below filled in |

Each phase ships **on** (its level's knob defaults to true). Turning it off must give today's behaviour exactly.

### What on-by-default means for the existing checks

The check scripts run with `JEV_CONFIG=none`, i.e. the code defaults, so they will run with tabu **on**.
That's intended: the regressions are tested against what ships. Three consequences:

- **`check-request-hashes.mjs`**: a scenario where a stall fires gets a different request. In each
  phase, run it. A mismatch must be explained by a tabu entry (the scenario has a stubborn stub). Then
  regenerate the fixture with `node scripts/request-hashes.mjs --write` **in its own commit** (AGENTS.md:
  regenerate only on purpose). Add an off-arm pass to the same check (tabu off) that must match the *old*
  fixture, which proves off is exactly today's code.
- **Measurement scripts and the duel harness** (`measure-*.mjs`, `scripts/lib/duel-harness.mjs`) gain a
  `tabu` opt (`true` | `false`), default `true`, so off-vs-on comparisons can run.
- **AGENTS.md / CONFIG.md** document it as on by default. The 'Open questions' section records the
  measured numbers from phase 6.

## Checks (`scripts/check-tabu.mjs`, free, fetch tripwire, stub `ask` / `decide`)

1. **Pure module**: tenure expiry, per-encounter entries, strike counters reset on gain, `filterOptions`
   never below `min`, lifts least tenure first, deterministic on ties.
2. **Hard exclusion**: after a rule fires, the excluded id is **absent from the request body**
   (`lastRequests()`), not just discouraged: criteria keys, the mood list in the question text, the
   "Tactics it leaves here" lists, `surroundings.moves`.
3. **Stubborn stubs** (testbed arenas): always-`run_away` in a closed room (T3), always-`cautious` (D1),
   always-reverse-move in a dead end (M1), a 4-cell corner shuttle (M2), always-`stay` (M3). Each must
   break the loop within the rule's threshold plus one re-decision.
4. **Aspiration**: portal move kept; engage holding cell kept; last life keeps a retreat; `race_to_exit`
   never removed; cornered mode skips M1/M2; panic untouched; a directive suspends moods/tactics.
5. **Fog twin**: two games with different hidden tiles / hidden ghosts and the same lit region and
   history produce identical tabu state and byte-identical requests.
6. **Off = today's code**: with both toggles off, `check-request-hashes.mjs` matches the pre-tabu
   fixture. On (the default), with no stall, requests are identical too.
7. **Regressions to re-run**: `check-duels.mjs` (0 claws must stay 0), `check-dungeon.mjs` (request-size
   bounds, 4f), `check-progress.mjs`, `check-confidence-wiring.mjs`, `check-adversaries.mjs`.

## Measurement (phase 6, `scripts/measure-tabu.mjs`, free by default)

Tabu off vs on over testbed arenas (closed room, dead-end corridor, 2-ghost room, `scripts/arenas/*`)
and 20 linear seeds. Per game: back-and-forth count, longest repeated-cell run, encounter length,
strikes / dispels / hits / deaths, portal wins, Jev calls per tick (it should drop: tabu makes some
choices forced), request bytes. The stubs need a "stubborn" mode that repeats its last answer, since a
stub that already varies never stalls. A live comparison (`--live`, paid) only when the user asks for it.

### Free results (stubbed Jev, `node scripts/measure-tabu.mjs`, 20 dungeon seeds, 5 reps per arena, about 50 s)

`off` = both tabu toggles off, `on` = the default. Per game averages unless noted; same dice in both arms. Monsters use the duel harness's claw stub.

```
group        stub      arm    n   b&f   rep encLen  strk  disp  hits dead portal clear call/t   expB   monB  tbT/M/Mv   fMv  mMv/fA
closed-room  stubborn  off    5   1.0   9.0   34.0   0.0   0.0   4.4    5      0     0   1.71   4615   3727 0.0/0.0/0.0   0.0 0.0/0.0
closed-room  stubborn  on     5   2.6   5.2   80.0   0.0   0.0   3.6    0      0     0   1.67   4992   3710 8.8/5.4/13.8   0.0 2.6/0.0
dead-end     stubborn  off    5   0.0  10.0   33.8   0.0   0.0   4.6    5      0     0   1.70   4362   3261 0.0/0.0/0.0   0.0 0.0/0.0
dead-end     stubborn  on     5   0.2   9.2   33.8   0.0   0.0   4.6    5      0     0   1.72   4364   3261 1.6/0.0/0.0   0.0 0.0/0.0
two-ghosts   stubborn  off    5   1.4  10.2   42.2   0.0   0.0   4.8    5      0     0   2.29   5204   3735 0.0/0.0/0.0   0.0 0.0/0.0
two-ghosts   stubborn  on     5   2.0   5.2   69.8   0.0   0.0   4.4    3      0     0   2.26   5613   3744 8.6/6.6/10.0   0.0 4.2/0.0
fixtures     stubborn  off   30   0.4  10.0   29.3   0.0   0.0   3.7   23      0     0   1.67   4368   3998 0.0/0.0/0.0   0.0 0.0/0.0
fixtures     stubborn  on    30   1.7   4.9   39.7   0.0   0.0   3.4   13      1     0   1.79   4802   4074 3.6/1.7/7.2   0.0 1.6/0.0
dungeons     stubborn  off   20   1.2  10.9   15.1   0.0   0.0   2.6   12      0     0   1.31   3953   4423 0.0/0.0/0.0   0.0 0.0/0.0
dungeons     stubborn  on     20   3.8   7.2   22.7   0.0   0.0   3.5   13      0     0   1.61   4472   4523 1.8/0.4/15.8   0.0 7.2/0.1
TOTAL        stubborn  off   65   0.7  10.2   26.3   0.0   0.0   3.6   50      0     0   1.52   4221   4033
TOTAL        stubborn  on    65   2.3   6.0   38.3   0.0   0.0   3.6   34      1     0   1.74   4727   4134
TOTAL        fight     off   65   6.2   4.0    8.1   4.7   2.1   0.4    2      0    33   1.35   4181   4550
TOTAL        fight     on    65   3.8   3.8    8.3   4.7   2.1   0.4    1      2    33   1.35   4201   4559
```

(The `fight` rows of the arena groups are identical on and off: that stub never stalls, so tabu never fires there; the full table is the script's output. Columns: see the script header.)

Reading it, without more claims than the numbers carry:
- With the stalling stub tabu cuts the longest repeated-cell run (10.2 to 6.0 entries in 12 steps) and the deaths (50 to 34 of 65 games); in the closed-room shuttle none of 5 games ends in death against 5 of 5.
- Back-and-forth *rises* with the stubborn stub (0.7 to 2.3 per game): a stub that repeats its last answer takes the one cell tabu leaves it, then steps back, so M1/M2 turn a long shuttle into short bounces. The repeated-cell run and the deaths are the better measure of the stall here.
- Jev calls per tick do **not** drop (1.52 to 1.74 with the stubborn stub, 1.35 both with `fight`): a rule-out does not force a call away unless one option is left, and `minMoves` 2 plus the never-empty rules keep two (forced moves: 0 in every group). The promise in the plan ("tabu makes some choices forced, so calls should drop") does not hold with these defaults. Part of the rise is that longer encounters (80 vs 34 ticks in the closed room) are more ticks with a ghost in sight.
- Request bytes rise about 12 percent for the explorer with the stubborn stub (4221 to 4727 B; not traced further); with `fight` they are within 1 percent.
- The `fight` stub (strikes and dispels as before: 4.7 and 2.1 per game both arms; hits 0.4 both) shows no regression in fights; fixtures: back-and-forth 7.1 to 4.0 on the 30 fixture games.
- Monster tabu: with the claw stub it fires in both stub sets (ticks with a dropped monster move per game: 3.5 stubborn, 1.4 `fight`, 4.4 in the dungeons with `fight`); forced search approaches are rare (0.1 to 0.9 per game). With `--monsters stubborn` (stubborn explorer, 130 games, 23 s): explorer deaths 26 to 11 of 65, repeated-cell run 11.5 to 6.7.

### Live comparison

(To be filled in after a paid `--live` run.)

## Risks

- **Over-exclusion makes things worse.** Removing the safe option in a genuinely bad spot. The
  aspiration rules A2, last-life and `too_strong` exist for this. Check-duels and the death counts in
  phase 6 are the guard.
- **Tabu fights other code policies.** `#retreatOK`, the engage hold, corner mode and the retreat
  redirect all already shape the menu. Order is fixed above: their rules first, tabu only removes on
  top of them, aspiration last.
- **Hidden reason.** Jev only learns why an option vanished from one event line. If live runs show
  Jev confused by it, add one short clause to the affected question, then re-measure the request bytes.

## Status

**Built: phases 0 to 6** (phase 6: measurement script only; the live comparison is open; branch `feat/tabu-search`).

- Phase 0: `src/characters/shared/tabu.js` (also exports `entryOf`), `scripts/check-tabu.mjs` section 1, both fog-guard
  allowlists, six registry rows (`explorer.tabu.enabled`, `.tactics`, `.tacticStrikes`, `.retreatTicks`, `.engageHits`,
  `.pingpongTenure`). Knobs are `live` like the other brain knobs (the plan said `next`). The `monsters.tabu.*`,
  move and mood knobs come with their phases.
- Phase 1: T1-T4 in `explorer/brain.js` (`#menu`, `#charge`, `#retreatStalled`, `#trackGain`, `#ruleOut`), `turn.tabu`.
  Changes from the plan, found while testing:
  - **T1 needs no gain during the bounce.** A fight bounces too (strike, knockback, close in). Without this, engage was
    ruled out in fights that were landing strikes.
  - **A last life never rules out a retreat.** The filter would keep it anyway, and the memory event would then tell Jev
    something false.
  - **The memory event is written by the filter** the first time a menu really drops the option, not when the rule
    fires. When the never-empty rule lifts an entry straight back, nothing is announced.
  - `check-dungeon.mjs` 4f now counts only moves made under `run_away`. Its 12x5-room case is exactly the corner
    shuttle: with tabu, T3 rules `run_away` out at tick 12 and the explorer engages and holds. Without tabu it keeps
    shuttling, then runs past the ghost.
  - Request-hash fixture: re-recorded only the 6 scenarios tabu changed. With tabu off, each one matches the old fixture
    byte for byte. `dungeon:1-4,6` were already stale before this work.
- Phase 2 (moods): D1 and D2 in `explorer/brain.js` (`#moodMenu`, `#chargeMood`, `#trackMood`, `#reviewVerdict`, `#endTabuEncounter`), four knobs
  (`explorer.tabu.moods`, `.moodStrikes`, `.moodTenure`, `.moodReviewTenure`), `scripts/check-tabu.mjs` section 3.
  - **The mood is charged against its own gain baseline** (`#moodTrack`, set when a mood is picked and kept on a re-pick), so a
    gain between two decisions clears its strikes exactly as for tactics.
  - **"For at least 10 steps"**: the D1 entry is an encounter entry; when the encounter ends `#endTabuEncounter` turns it into a
    timed entry of `since + moodTenure`.
  - **Aspiration is `min = 1`**: with the tier's moods all ruled out the entry with the least tenure left comes back, which is
    also the "older entry" rule for `wary` / `guarded` on a last life. No `keep` list is needed.
  - **Tier-swap**: a mood ruled out while the tier still allows it swaps silently (policy reason `<mood> ruled out`) or, with an
    enemy in sight, fires `confidence` once per encounter under its own latch key `tabu`.
  - **`turn.tabu`** keeps `removed` / `lifted` for tactics and adds `removed_moods` / `lifted_moods` and a `mood` entry list.
  - Request hashes: four scenarios change (`fixture:{corridor,duel,skills}:first`, `no-explorer-skills`); the first differing
    request of each is the first mood rule-out, and each matches the old fixture with `tabuMoods` off. Re-recorded (only those four) in their own commit.
  - Not tested in isolation: the 10-step tenure after an encounter ends (the check scenarios never leave the encounter).
- Phase 3 (moves): M1-M3 and A1-A5 in `explorer/brain.js` (`#scoreMoves`, `#noteMove`, `#moveMenu`, `#moveParts` extracted from `#moveQuestion`), `describeMoveParts` returns `safe` per move (no text change), eight knobs (`explorer.tabu.moves`, `.bounceTenure`, `.loopWindow`, `.loopVisits`, `.loopTenure`, `.stayRun`, `.stayTenure`, `.minMoves`), `check-tabu.mjs` section 4, `turn.tabu` gains `removed_moves`, `lifted_moves`, `forced`.
  - **M1 needs the last move itself to be a return** (`cells[-1] == cells[-3]` and `cells[-1] != cells[-2]`). Without it a stay after an old bounce (`back_and_forth` stays >= 2 for 6 moves) ruled out the cell the explorer stood on.
  - **M1 and M2 stand aside for 12 steps after a strike or dispel** (same lesson as phase 1: a fight bounces). Without it check-duels' scripted duels lost a placement.
  - **The tabu cell is the one stepped back to** (`cells[-2]`, the cell a further bounce would enter), not literally "two back" from the cell the explorer stands on.
  - **A3 keeps every step that closes the known-path distance to the engage target** (and `stay` when the target is the own cell), under `engage` or while `engage` is a tactic being decided. The same keeps `stay` under `hide` (or `hide` being decided) while the explorer stands on the hiding spot: standing still is the tactic (added in review). **A2** is judged against the current approach's move facts (`memory.approach.id`), not per tactic: one list per tick.
  - **Panic is not exempt** (it only runs; A2 keeps the safe way out). A1 can never be triggered by a rule (stepping on the portal ends the game, so its cell never enters the history); the check proves the end-to-end behaviour only.
  - **The memory event says the steps left at the time a request drops the move** ("for 5 steps"), since M2 re-extends a live entry while the loop goes on.
  - **`turn.tabu.forced`** can only be true with `minMoves` 1 (stay is always legal, so the raw legal list has >= 2 moves and the default minimum is 2). Covered in 4j with a corridor dead end.
  - Existing checks touched: `check-tabu.mjs` sections 2-3 run with `tabuMoves` off (they isolate the tactic and mood levels); `check-dungeon.mjs` worst-case size check runs with it off (its stub stays put on every tick, exactly the stall M3 stops; it would step away and light cells the hand-set fixture keeps dark; tabu only removes options, so those sizes stay an upper bound); `check-duels.mjs` section 10 (health 2 spot check) runs with it off: the scripted policies wait while nothing is in sight, M3 sends them wandering, and the 2-life vs 9-life traces then differ by the wander, not by the lethal guard (the 24 placements run with moves on and show 0 claws).
  - The corner shuttle of AGENTS "Open questions" (run_away in a closed room, tactic level off, 60 ticks, check-tabu 4k): 10 bounces with the move level off, 8 on. It dampens the shuttle, it does not stop it: the stub follows "Closer to the target", and with minMoves 2 the menu keeps the way back whenever the corner leaves only two moves. The tactic level (T3) is what stops it.
  - Request hashes: 19 non-dungeon scenarios change (the first diff of each is the first move event in `state.recent.events`); with `tabuMoves` off every one matches the old fixture byte for byte (only the stale `dungeon:1-4,6` differ). Re-recorded (only those 19) in their own commit.
- Phase 4 (`#exclude` cell half): `#bounce(step)` in `explorer/brain.js`. With the move level on (`tabuEnabled` and `tabuMoves`) the two bounce cells go into the tabu list as `cell` entries (`encounter: true`, reason "kept stepping back and forth under a tactic"), so phase 3's `#moveMenu` also drops the steps onto them (with its aspiration rules). `#exclude` keeps only the old goal. With the move level off the old path runs unchanged (`#exclude` holds the cells and the goal).
  - **Target exclusion** is `#excluded()` = `#exclude` plus `#bounceCells`, a private Set of just the ping-pong's two cells, cleared wherever `#exclude` is (encounter start and end, the same moments the `encounter` tabu entries die). Every place that passed `this.#exclude` (tacticFeasibility x3, approachTarget x4, the frontier filter) now passes `#excluded()`. Deliberately NOT all live tabu cells: M1/M2 cells are timed, ring-based and meant for the move menu; widening target exclusion to them would change target choice in far more situations than the old `#exclude` did. check-dungeon 4f never reaches `PINGPONG_FAILS` (undone moves stay at 2), so it could not tell the two apart; this was not measured, it is the conservative reading of "target use stays".
  - `ExplorerBrain.excluded` (getter, sorted cell keys) is a read-only view for the checks.
  - Entry lifetime: encounter entries die in `#endTabuEncounter` at the same two moments `#exclude` was cleared.
  - check-dungeon 4f before and after: identical ("undone moves (A-B-A) 2, 2, 2, 2 (bound < 3 each)", "next 8 moves stay at distance 9+ from the sighting (was 9)"); the full check output is identical to a run with the fold disabled. (The 4e line "encounter counters ... events N" is not seeded and varies run to run, 2-6 events, on any code.)
  - New check-tabu section 5: the reverser under a tactic ping-pongs into `tactic_failed`; the two bounce cells are `cell` entries until the encounter ends; a later request drops a step onto them (absent from questions and `surroundings.moves`); one lazy event per cell; the cells stay target exclusions; with `tabuMoves` off `#exclude` holds the cells exactly as before and no bounce entry exists, and the requests equal those of `tabuEnabled` off.
  - Request hashes: four scenarios change (`fixture:skills:first`, `duel-2ghosts-hp3`, `no-explorer-skills`, `one-life-wary`; first diff in `state.recent`). With the fold off (old `#bounce`) each matches the fixture byte for byte. Re-recorded (only those four) in their own commit.
- Phase 5 (monsters, every kind): `adversary/brain.js` (`scoreTabu`, `moveMenu`, `forceApproach`, `tabuReport`), `adversary.js` (one `turn.tabu` line), six knobs (`monsters.tabu.enabled`, `.bounceTenure`, `.loopWindow`, `.loopVisits`, `.loopTenure`, `.minMoves`, registry rows after `advSkillNear`), `check-tabu.mjs` section 6. One implementation covers ghost, troll, tree_giant and wolf (they all decide through `buildRequest`); no per-kind code.
  - **State** is in the private hunt state (`newHunt`: `tabu`, `ring`, `told`, `tabuTurn`, `searchTicks`), never in `memory.json` / `adversaries.json`, never sent. **A hunt starts and ends clean**: `switchOn`, `switchOnAlerted` and `switchOff` reset it. Regaining sight clears the `approach` entries (a new search starts clean).
  - **Moves**: M1 and M2 as the explorer's, by destination cell, steps = world ticks, over a private ring of the hunt's cells (the last `loopWindow` + 1 steps, every step incl. a fast monster's extra steps), which works with smart memory off (the memory's `recent.cells` is empty then). Monsters have no `stay` (`legalMoves` is the four directions), so there is no M3. The explorer's "no rule right after a strike" exemption is not copied (a monster knocked back by a strike does not step). Aspiration: the step onto the explorer (in sight) is never removed; `minMoves` 2. The filtered list feeds the `next_move` options, `describeMoves` and the answer validation in `decide`, so `req.legal` is now the listed moves (its only users are `decide` and the checks). Only while the brain is on (patrol has no Jev). With `minMoves` 1 a single move left takes today's path (no `next_move`; a skill-only request if a skill is offered).
  - **Search approach**: when the 3-ping-pong rule fires, the approach in force becomes tabu for the character's `maxSearchTicks`. The two search approaches leave one, so **code takes it at once** (in `noteStep`, via `setApproach`) and clears `pickApproach`: the next request has no `search_approach` question and `self.approach` already shows the new one. The plan said `applyDecision` would apply the forced approach; setting it where the rule fires keeps `self.approach` truthful in the next request and needs no second path. A ruled-out approach is never re-offered later within its tenure: sight regained ends it, and a new `lostSight` after that picks normally. When both approaches end up tabu the one with the least tenure left comes back (`min` 1) and is taken the same way.
  - **Ping detection without smart memory**: with `adversaryCharacters` off `noteStep` used to return at once, so the 3-ping-pong rule never ran. With tabu on it now runs there too, from the private ring (so `pickApproach` / the forced approach also fire in that mode). With tabu off nothing runs there (byte-identical).
  - **Events** go through the monster's own `addEvent`: `Ruled out the cell to the east for 6 steps: kept stepping back and forth.` (lazy, the first request that really drops the move; one per entry) and `Ruled out sweep_last_seen for 18 ticks: kept stepping back and forth. Taking cut_off.` (written when the approach is forced, since the question's absence is certain; it replaces the old "choosing a search approach again" event for that firing). They sit in `recent.events`, which every monster request already carries (also with characters off); the cap of 5 means they can push older events out.
  - **`turn.tabu`** per acting monster: `{ cell?, approach?, removed_moves, lifted_moves, forced_approach }` (the first two are the live entries, as `T.snapshot`), null with the level off or when the monster did not act.
  - Existing check touched: `check-adversaries.mjs` 5f (re-sighting memory shape) runs with monster tabu off: its stub teleports and shuttles on purpose, tabu rules that stall out and adds events/`tried` rows (tabu behaviour is covered by check-tabu section 6).
  - Off arm proof: the same stall and no-stall scenarios for the four kinds, with smart memory on and off, hash identically between this tree with `advTabuEnabled: false` and a copy with HEAD's `brain.js` (no tabu code); on differs only in the stall scenarios.
  - Request hashes: eight non-dungeon scenarios change (`fixture:{charline,duel,home,open,pack,skills}:first`, `no-explorer-skills`, `no-skill-answers`; the explorer's request differs where a monster that used to ping-pong now takes another route); each matches the fixture with `advTabuEnabled: false`. Re-recorded (only those eight) in their own commit; two of them differ only in option order, because a monster request with fewer options draws `Math.random` fewer times. `dungeon:1-4,6` are the old stale ones.
  - Chase not weakened (review): `measure-memory --who adversary --accept --seeds 16 --ticks 250` (stubbed, wandering explorer) gives full-map hits 81 off / 80 on, limited-map 77 / 76.
  - Size: `measure-memory --who adversary` (avg 4.3 KB / max 6.5 KB on the pack fixture) and `--morale on` (avg 4.7 / max 6.4 KB) pass their asserts.
- Phase 6 (measurement): `scripts/measure-tabu.mjs` (free by default, `--live` needs `--games N`), results above under Measurement. `scripts/request-hashes.mjs` now exports `fightAsk` (no behaviour change, fixture untouched).
