# PLAN-confidence: an explorer that learns its odds as it plays

**Bottom line.** Give the explorer a confidence score `C` (0..100, 50 at the start of every game) that its own
fights move, and let **code** turn it into a risk dial (`min_gap`, whether `engage` is offered) while Jev gets
one short word for it. The dial has a **neutral zone**: at the start value and anywhere a game can reach
without a hit or a kill, every gate is the identity, so `C` only **brakes after hits** and **frees after kills**.
Build it behind a toggle that is off by default, **after PLAN-motivation P7a** (the hold fix, which removes
the main source of hits today), and prove in free stubbed runs, with a new fighting stub, that it carries
signal before any paid run. The first sketch had eight weaknesses (section 2). The most serious is that fights
are rare, so a fight-driven score barely moves. The plan says plainly when to stop.

Status: **C1, C0, C2, C3 and C4 built and measured (module, duel harness, measurement, wiring, request-hash baseline, gates and the word, UI meter, calibration and sweep). C4 result: the reliability gate FAILED (0.6 points against 15 over 9739 fights) and no arm beat the null arm, so the plan is closed as "measured, not worth it" under stubs. The toggle code stays in and the default stays OFF; C5 (paid ablation) is the only open phase and needs user approval.** Per AGENTS.md this plan is not code until the user approves a phase.
Code wins over this plan (rule 3).

## 1. The model (v3)

State: a plain-JSON field in explorer memory, `progress.confidence`, **present only with the toggle on** (so
memory-shape asserts and `memory.json` do not move with it off). It is not sent verbatim: `#state` picks
`progress` fields one by one, and only `self.confidence` (section 3) reaches Jev.

```
value     number 0..100, starts at 50 every game
counts    { strikes, blocked, evaded, pressed }   // only what memory.encounters does not already count
```

**Events and changes** (defaults are constants in `confidence.js` until C4 fits them; no settings knobs before then):

| Event | Where the brain sees it (fog-safe: own state only) | ΔC |
| --- | --- | --- |
| Hit taken | `noteHit` (called by `Run.playTurn` when a `hit` event fired) | −15, then the lives cap |
| Strike lands, ghost survives | `struck` event in `#useSkill` | +6 |
| Ghost dispelled | `dispelled` event in `#useSkill` (the dispelling strike emits `dispelled`, **not** `struck`, so a default 2 hp ghost gives +6 +12 = +18) | +12 |
| Claw blocked | **no hook today**: `blocked` is emitted inside `stepAdversaries` and `Run.playTurn` forwards only `hit` / `caught`. Needs a `noteBlocked(id)` call in `turn.js` (its own cell, own shield: fog-safe) | +3, only up to 65 |
| **Evaded**: an encounter with a chasing sighting ended with no hit and no dispel | `chase_over` in `#encounterPolicy`, plus two new per-encounter flags in `#encounter` (`hurt`, set by `noteHit`; `killed`, set on a dispel) and "some visible id had mode `chase`" (`info.modes`). Today `encounters.escaped` counts **every** `chase_over`, hurt or not, and `chase_over` fires only while a tactic is on | +4, only up to 65 |
| **Pressed**: a visible chasing adversary within 2 steps, sword not ready | `visibleAdversaries()` + `#armed()`; **not** while the approach is `engage` or the adversary is in `#stunnedIds()` (after a strike the stunned ghost at the hold gap is the design, not a threat) | −2 per tick, at most −8 per encounter |
| Calm step (no adversary in sight) | each step | +0.3, **only while `C < 50`** (repairs toward the start, never above it) |

Coins are **not** an event (the first sketch had +1 per coin): they are loot, not evidence about fights, and
30 coins per map would swamp the fight signal. `self.coins` already carries them.

**Lives cap.** After any change, `C = min(C, cap)`, with `cap = 45` on the last life when `maxLives > 1`, else
`100 · (0.3 + 0.7 · lives / maxLives)`. The first sketch's formula alone gave the last life 65 at the default 2
lives (the confident threshold, so "never confident on the last life" was false) and 100 at `maxLives` 1.

| maxLives (setting 1..9) | cap per lives left (full → last) |
| --- | --- |
| 1 | 100 (a hit ends the game through `noteCaught`, so `C` never sees one) |
| 2 (default) | 100, 45 |
| 3 | 100, 77, 45 |
| 4 | 100, 83, 65, 45 |

**Bands** (the word goes to Jev, the thresholds to code). The names avoid the mood ids `wary` and `steady`,
which Jev already reads in `self.mind`: `<30` shaken, `30-39` unsure, `40-64` even, `65-79` sure, `80+` dominant.
Without a hit or a kill, `C` stays in 42..65 (pressed −8 from 50, evaded and blocked capped at 65), so a quiet
game reads `even` or, at most, `sure`.

## 2. Critique of the first sketch, and what changes

1. **The signal is sparse.** The live baseline had 0 lives lost and 1 strike in 400 ticks (PLAN-motivation
   section 0). P6 (live, 5 real dungeons, 120 steps; a worktree, not merged) raised that to 8 fights, 3.2
   strikes per game, 6 dispels and **3 lives lost**, all 3 from one walk-in bug that P7a (proposed, not built)
   fixes. So about 1-2 fights per game, and fewer hits once P7a lands. **Fix:** count non-fight experience too
   (evaded, pressed), wait for P7a so `C` is not calibrated on a bug, and make "does `C` leave the neutral
   zone" a measured gate (C0).
2. **It may only restate what Jev already sees.** `recent.encounters` (`count`, `escaped`, `hits`,
   `dispelled`) and `self.lives` are sent verbatim every tick, and `fightFacts` states the present odds. So:
   no evidence note (the first sketch's `"dispelled 1, hit 0, evaded 1, 2 of 2 lives"` repeated them word for
   word), no stored counters that `encounters` already holds, and **no threat term** in the gates (the first
   sketch's `Ceff = C − 10·(threat − 1)` triple-counted with `fightFacts` and wary's "outnumbered" `when`).
   `C` is the **history**; `fightFacts` and `threats` are the **present**. C4 keeps a null arm.
3. **Two sources of truth for risk.** Fixed precedence: `C` sets bounds in code (the gap, whether `engage` is
   offered); the mood picks within them. Mood texts are not edited to quote `C`. No sentiment option is
   removed or reordered (the options are shuffled on purpose, and `check-dungeon` asserts 4 of them).
4. **Hand-set weights are arbitrary.** They are a parameter vector fitted on a small grid in C4. The Beta
   posterior `(landed + 2) / (landed + taken + 4)` (no weights, shrunk to 50%) runs as an alternative arm; ship
   the simpler one that does not lose.
5. **Defaults must not change.** The first sketch failed this: its `min_gap` formula gives
   `round(m + (60 − 50)/20) = m + 1` at the start value (`Math.round` rounds .5 up), so every mood's gap rose by
   1 on tick 1; its bold gate (`Ceff ≥ 65`) kept bold off for the first ~50 calm steps of every game and, with
   the threat term, against every lone 2 hp ghost, undoing P6's main win. **Fix:** the neutral zone (section
   3), asserted in `check-confidence`, and with the toggle off, requests byte-identical to today's.
6. **"Number of visible ghosts" is a crude threat measure.** Dropped from the gates (2.2). If C4 wants it back,
   it is an arm (`Σ visible hp / swordDamage`, fog-safe from the health bars), measured within strata.
7. **A bare number reads inconsistently to an LLM.** Send the band word with the number, nothing else, and
   explain it once in the sentiment question only (section 3).
8. **Calibration under stubs measures the stub.** Stubs never read text, so free runs test only the code
   gates against a scripted executor. Whether Jev uses the word is answered only by the paid ablation (C5).

Also noted, not fixed here: `C` is per game. A cross-game prior is C6, optional.

## 3. How `C` drives behaviour (code, then Jev)

**Code gates (C3, deterministic, own state only):**

| Effect | Rule |
| --- | --- |
| `min_gap` | Δ = +2 if `C < 30`, +1 if `30 ≤ C < 40`, 0 if `40 ≤ C < 80`, −1 if `C ≥ 80` (never below 2; `engage` keeps its gap of 1). One hit from 50 gives 35: +1 |
| `engage` offered | only if `C ≥ 40` and the sword is ready (today: sword ready). One fresh hit from 50 turns it off until a strike, an evade or about 17 calm steps (+0.3 each) repair it |
| Re-decision after a hit | **nothing new**: `noteHit` already sets the pending `hit` trigger whenever a tactic is on |

The neutral zone (Δ = 0, `engage` as today) is `40 ≤ C < 80`; a game without a hit or a kill stays in 42..65,
inside it. `check-confidence` asserts the gates are the identity over that whole range.

**One gap, everywhere.** The effective gap must replace `profile.min_gap` at every reader, or Jev reads two
numbers: `tacticFeasibility` / `approachTarget` / `describeMoveParts` callers, `#tacticFailing`,
`#keepEscapeGoal`, the sentiment question's "Effect: min gap N" (`profileNote`) and "Tactics it leaves here",
and the mood `priority` / `move_priority` lines, which hard-code "keep at least 4 / 3 / 3 / 2 steps". Template
those from the effective gap (byte-identical while Δ = 0). One helper (`effectiveProfile(memory, C)`).

**What Jev reads:** `self.confidence = "35 unsure"` (about 25 B) on every request, toggle on only. The one
explaining sentence goes in the **sentiment question's instructions**, not in `rules()` (which rides on every
request, the tactic one included): "`self.confidence` sums up how your fights in this dungeon went; `threats`
and the tactic facts say how this one stands." No `confidence_note`, and no memory event per change (events
are a 6-entry ring sent verbatim: confidence lines would push real milestones out); the change goes in the
turn shape for the UI instead.

## 4. Failure modes and their guards

| Mode | Guard |
| --- | --- |
| Death spiral (hit → no fights → no recovery) | calm drift back to 50 (about 17 calm steps to re-open `engage`, 50 to reach 50); evades lift it too |
| Euphoria (kill streak → bold into a pack) | lives cap; `min_gap` −1 only at 80+ (needs about 2 kills); `engage` still shows the odds |
| Farming | not possible: every strike removes hp, ghost hp (1..5) bounds the strikes per ghost |
| Punishing the plan | pressed excludes `engage` and stunned ghosts (the hold at 2 steps is the design) |
| Dead signal | C0 gate; stop if it fails |
| Bytes | about 25 B per request plus about 120 B on the sentiment question; worst-case decision tick today 9038 / 9602 B against 9500 / 10500 (`check-dungeon`, run for this review): about 460 / 900 B left; the sentiment request is 4082 B at the start, about 5.1 KB with an adversary in sight, and has no bound |
| Toggle regression | off by default; a request-hash baseline (to be built, see C2) and the existing checks |
| Fog | own events, own lives, own strikes only; a twin scrambles hidden adversaries and requires identical `C` and requests |
| Ghost side | `C` reaches no ghost request; ghosts' behaviour changes only through the explorer's moves; the adversary checks run with the explorer stubbed and stay unchanged |

## 5. Phases

Each phase ends with the checks green. Stop at any gate marked **GATE**. Prerequisite: P6 merged and P7a built.

- **C1 (free): the pure module.** `src/characters/explorer/confidence.js` imports nothing (so the explorer
  static guard and the acyclic chain are untouched): `createConfidence()`, `apply(state, event, lives, maxLives)`,
  `cap(lives, maxLives)`, `calm(state)`, `band(C)`, `gaps(C)`, `engageOpen(C)`. `scripts/check-confidence.mjs`:
  cap table over lives 1..9, clamp after a hit, the 65 ceiling for evaded / blocked, drift only below 50,
  bands, the neutral-zone identity over 40..79, determinism, JSON round-trip.
- **C0 (free): does `C` move? GATE.** The existing stubs cannot answer it: `measure-memory`'s explorer stub
  answers `none` to every skill question and its ghost stub never claws (a stubbed run for this review: 0
  strikes, 0 dispels, 0 hits over all 10 fixtures × 60 ticks), the `check-dungeon` 4f smart stub always picks
  `run_away`, and the `check-skills` duel bypasses the brain. Build `scripts/measure-confidence.mjs` with:
  - a **fighting executor** driving the real `ExplorerBrain` through `newTestGame` / `newGame` (P7a's
    end-to-end duel stub, reused): a fixed mood policy, `engage` when offered else `run_away`, the first
    non-`none` skill key, moves read from the facts like the 4f stub, plus a seeded walk-in probability `p`
    (0, 0.2, 0.5) so fights have mixed outcomes;
  - a **clawing ghost stub** (first non-`none` skill, moves that shorten the path, as in `check-skills` 12);
  - **varied placements**: generated testbed arenas (`size` 13..17, `numAdversaries` 1..3 placed by `seed`,
    `ghostHp` 1..3) and `newGame(seed)` dungeons; the fixture maps have fixed `A` cells and give no variance;
  - `Math.random` seeded per game (the option shuffle), and `fetch` as a tripwire, as in `measure-memory`.
  `C` is computed passively by `confidence.js` from the turn shape (`skill_events`, `events`,
  `decision.trigger`, `game.health`), toggle off. **GATE:** `C` leaves the neutral zone in at least 20% of
  dungeon games (not arenas, which are built to fight). If not, stop.
- **C2 (free): wiring, toggle off.** First, **build the request-hash baseline** (none exists today, see Review
  notes): at the base commit, sha256 of every explorer request body over the fixtures and the
  `check-dungeon` brain scenarios, `Math.random` seeded, committed as a fixture and compared by a check. Then
  the brain hooks (`noteHit`, `#useSkill`, `#encounterPolicy` flags, the calm step, `noteBlocked` from
  `turn.js`), `progress.confidence` (toggle on only; validation and `memory.md`), and the toggle. How it
  reaches the brain: there is no explorer configure hook and AGENTS forbids module-level mutable state in
  `explorer/*`, so pass it as a constructor option (`new ExplorerBrain(world, { ask, memoryDir, confidence })`,
  through `newGame` / `newTestGame` `opts`, and from the `confidenceModel` setting, `when: 'next'`, where the
  server builds the Run). Checks: hash baseline equal with the toggle off; twins unchanged.
- **C3 (free): the gates and the word.** `gaps`, `engageOpen`, the effective-gap templating, `self.confidence`,
  the sentiment sentence, the UI meter. Checks: gate table, neutral-zone identity end to end (a stubbed game
  with the toggle on and no hit or kill plays the same moves as with it off), tactic twins, request-size
  bounds, the fog twin.
- **C4 (free): calibration and sweep. GATE. (built; gate failed, ship = false, see C4 results.)** (a) Reliability: at the start of each fight (first tick with
  `engage` or a strike offered) record `C`; win = dispelled with no hit taken; bucket by band **within strata
  of visible ghost count** (count alone predicts outcome, and `fightFacts` already says it); win rate must rise
  with the band by at least 15 points, 300+ fights (expect a few hundred arena games; time it). (b) Sweep the
  weights on a small grid; arms: toggle off (the null arm: under stubs it differs only by the code gates), the
  Beta posterior. (c) Report win rate, hits and coins per game, request bytes. **Ship only if `C` beats the
  null arm on hits per game or fight win rate without losing coins.** Otherwise record the result here and stop.
- **C5 (paid, only on user approval): live ablation.** P6's 5 seeded dungeons (`POST /api/new { seed }`,
  seeds 101-105, 120 steps, the stepping script in `runs/motivation/`), toggle on versus off. About 8 fights
  per arm is too few to judge win rate: judge whether Jev's mood and tactic picks move with the word, plus
  bytes and hits. Ask first: every step costs Jev calls.
- **C6 (optional, later): ghost morale and a cross-game prior.** Ghost morale is the unbuilt `mood` layer of
  PLAN-adversary-memory. It must use the ghost's own state (`tally.hits`, stuns and hp lost), never the
  explorer's lives or `C` (ghosts do not see them). A prior across games goes through `memory.json`.

## C0 results (measured 2026-10-07, free, stubbed)

`node scripts/measure-confidence.mjs` (defaults: 40 `newGame(seed)` dungeons seeds 1..40 and 40 testbed arenas
per p, 150 ticks max, default lives 2, mood `bold`, engage when offered else `run_away`, first non-`none` skill,
clawing ghost stub from the duel harness, `Math.random` and the walk-in draws seeded per game, `fetch` a tripwire).
`C` is computed passively by `applyTurn` from the turn shape plus the brain's own request (visible ghosts and
their `chasing` flag, sword ready, approach); brain, memory and turn.js are untouched.

| p | dungeon games leaving 40..79 | below 40 / above 80 | C range | ticks / game | s / game | per game: dispelled, hits, evaded |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 34 of 40 (85%) | 5 / 32 | 30..100 | 127.9 | 1.00 | 3.55, 0.25, 0.33 |
| 0.2 | 36 of 40 (90%) | 5 / 33 | 30..100 | 125.0 | 1.19 | 3.58, 0.17, 0.23 |
| 0.5 | 35 of 40 (87.5%) | 3 / 32 | 30..100 | 125.0 | 1.23 | 3.65, 0.20, 0.28 |

Arenas (reference, built to fight): 62.5..65% leave the zone, 0.16..0.20 s and 17..24 ticks per game.

**GATE: PASS** (90% at p = 0.2, needed 20%). Reading it honestly:
- The exits are almost all **upward** (a kill streak: +18 per default 2 hp ghost reaches 80 after about 2 kills).
  Only 3..5 of 40 dungeon games fall below 40, because only 7..9 of 40 games take any hit (0.17..0.25 hits per
  game). The brake side of `C` is therefore rarely exercised; the freeing side is. C4 must check that `min_gap` -1
  at 80+ does not make a stubbed explorer reckless, and should raise `p` or the claw rate to stress the brake.
- Dungeon games are cheap: about 1.0..1.2 s per game of 125 ticks (about 9 ms per tick), so C4's 300+ fights need
  a few hundred arena games at 0.2 s or about 100 dungeon games, a few minutes.
- Events not derivable from the turn shape today: `stunned` ids (the brain's private `#struck`), so `pressed`
  here is an upper bound and counted 0 anyway (the stub's explorer rarely has a chaser within 2 with the sword
  down); `evaded` needs `chase_over`, which fires only while a tactic is on, and is counted from the turn's
  `decision.trigger` with `enc.chased` taken from the request's visible ghosts (0.0..0.33 per game, so rare);
  `blocked` comes from `turn.events` (the explorer has the default sword and shield in these runs).
  C2's per-encounter flags would make `evaded` exact.
- The stub explorer wins by clearing the dungeon in some games, which shortens them (mean 125 of 150 ticks).

## C4 results (measured 2026-10-07, free, stubbed)

Tool: `node scripts/calibrate-confidence.mjs` (workers forked, 9 at a time) with the fighting executor now in
`scripts/lib/fight-executor.mjs` (shared with `measure-confidence.mjs`; its C0 numbers did not move). The brain's
`confidence` option now also takes `{ weights }` or `{ model: 'beta' }` (CONTRACT.md), and `confidence.js` exports
`WEIGHTS`; with the toggle `true` the default state shape is unchanged (`check-confidence` section 11). Games:
`newGame(seed)` dungeons, generated arenas (13..17 squares, 1..3 ghosts, 1..3 hp), and **crowd arenas** (3..5 ghosts,
2..3 hp; added before the first full run because the C0 arenas gave near-certain wins), each at walk-in p = 0, 0.2, 0.5,
150 ticks, clawing ghost stub, mood `bold`, `Math.random` seeded per game (same stream for every arm), `fetch` a tripwire.
The design (what counts as a fight, the gate, the winner rule, the ship rule) is written at the top of the script and was fixed
before the first run. The only change after it: the sweep grid was cut from 14 to 10 weight sets and the sample sizes were
trimmed for time (below); nothing was changed after seeing a result.

**What free runs can and cannot show.** The stubs never read text. An arm differs from the null arm only through the two code
gates (a wider `min_gap` below C 40 or narrower from 80, and `engage` closed below 40). Whether Jev uses the word
`self.confidence` is untested and is C5's job. The brake side is barely exercised: hits are rare.

### (a) Reliability. GATE: FAIL

Arm `weighted` (default weights, toggle on), 3480 games (dungeons 1..40 and 1001..1300, arenas 1..60 and 1001..1400, crowds 1..60
and 1001..1300, three p each), **9739 fights**, 9651 resolved by a win or a hit, the rest by 12 idle ticks or the end of the game
(counted as no win). C is the value before the first tick with `engage` or a strike offered; win = a ghost dispelled with no hit
taken since the fight began; a fight ends at its win, its first hit, 12 ticks with no ghost in sight, or the game's end; no fight
opens within 4 ticks of the last close. Win rate (wins/fights) by band, within strata of visible ghosts at the start:

| ghosts | shaken | unsure | even | sure | dominant |
| --- | --- | --- | --- | --- | --- |
| 1 | 0/0 | 0/0 | 96.1% (2648/2755) | 97.4% (1341/1377) | 96.0% (2005/2088) |
| 2 | 0/0 | 0/0 | 86.7% (957/1104) | 81.8% (266/325) | 88.5% (533/602) |
| 3+ | 0/0 | 0/0 | 78.1% (800/1024) | 82.5% (179/217) | 79.4% (196/247) |

High bands (sure, dominant) minus low (even): 0.4, -0.5 and 2.7 points in the three strata; stratum-weighted **0.6 points**,
needed 15. The null arm's passive C on the held-out seeds (4157 fights) gives 1.1 points. **Two reasons, both structural:**
no fight ever started in `shaken` and only 49 in `unsure` (hits are rare, 0.29 per game, and calm drift and kills repair C before
the next fight), so the low side is just `even`; and what predicts a fight's outcome is the ghost count (96% / 87% / 78%), which
C does not add to. Per the plan, nothing was tuned to make the gate pass.

### (b) Sweep (train seeds; dungeons 1..40, arenas 1..40, crowds 1..40, p 0 / 0.2 / 0.5 = 360 games per arm, paired against `off`)

| arm | win % | hits/g | coins/g | disp/g | lost | d hits (z) | d coins (z) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| off (null) | 92.2 | 0.26 | 1.79 | 3.14 | 10 | 0 | 0 |
| weighted (default) | 91.8 | 0.27 | 1.77 | 3.08 | 13 | +0.01 (1.74) | -0.02 (-1.90) |
| beta, (landed+2)/(landed+taken+4) | 92.2 | 0.26 | 1.79 | 3.14 | 10 | 0 | 0 |
| hit -10 | 92.2 | 0.26 | 1.79 | 3.14 | 10 | 0 | 0 |
| hit -25 | 91.5 | 0.27 | 1.75 | 3.07 | 14 | +0.01 (1.42) | -0.04 (-1.45) |
| struck 9, dispelled 6, dispelled 18, evaded 0, pressed -4, calm 0 | 91.8 | 0.27 | 1.77 | 3.08 | 13 | identical to default | |
| brake (hit -25, pressed -4, dispelled 6) | 91.4 | 0.27 | 1.74 | 3.07 | 14 | +0.01 (1.42) | -0.05 (-1.83) |
| free (hit -10, struck 9, dispelled 18) | 92.2 | 0.26 | 1.79 | 3.14 | 10 | 0 | 0 |

Reading: **only the HIT weight matters.** One hit from 50 gives 35 (default) and closes `engage` (below 40) and widens the gap; at
-10 a hit gives exactly 40, which keeps `engage` open and changes nothing, so `hit -10`, `free` and `beta` (one hit = 40.0) play
the **identical** games as `off`. Every other weight is inert in these runs, probably because C must cross 40 (down) or 80 (up) to
change behaviour, and only a hit moves it down (not tested further).
Whenever the gate acts (default, hit -25, brake) it is slightly **worse** than `off` on hits, coins, dispels and games lost:
closing `engage` after a hit presumably makes the explorer run instead of striking (mechanism not isolated), against the P7a hold
design. Winner by the pre-declared rule (fewest hits per game, coins not more than 1 SE below `off`, tie to the earlier row):
`hit-10`, which is a no-op arm, so the fitted arm equals the null arm. That is a result about the grid, not a model that works.

### (c) Held-out comparison (dungeons 1001..1150, arenas 1001..1200, crowds 1001..1150, p 0 / 0.2 / 0.5 = 1500 games per arm, 4157 fights in `off`; none of these seeds was used in (b); same seeds for every arm)

| arm | win % | hits/g | coins/g | dispelled/g | games lost | request bytes avg / max | d hits (z) | d coins (z) | d win pts (z) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off (null) | 91.2 | 0.29 | 1.60 | 2.95 | 72 | 4843 / 9313 | | | |
| weighted | 91.1 | 0.29 | 1.61 | 2.94 | 77 | 4890 / 9336 | 0.00 (1.21) | +0.00 (0.28) | -0.2 (-0.25) |
| fitted (hit-10) | 91.2 | 0.29 | 1.60 | 2.95 | 72 | 4887 / 9336 | 0 | 0 | 0 |
| beta | 91.2 | 0.29 | 1.60 | 2.95 | 72 | 4886 / 9336 | 0 | 0 | 0 |

By kind (hits/game off vs weighted): dungeons 0.18 vs 0.18, arenas 0.14 vs 0.14 (z +2.01, the wrong sign), crowds 0.60 vs 0.60.
Coins per game: dungeons 4.44 vs 4.46, arenas 0.17 vs 0.16, crowds 0.68 vs 0.67. Request bytes are the JSON bodies of every
explorer request: the toggle adds about 47 B on average (the confidence field, the sentence on the sentiment request) and 23 B at
the maximum, inside the 9500 / 10500 bounds (those are asserted by `check-dungeon`'s worst case, not by this run).

**SHIP RULE: not satisfied. Ship = false.** No arm beats `off` on hits per game (needs z <= -2.4; the default is z +1.21, i.e. no
better) or on fight win rate (needs z >= 2.4; the default is -0.25), and coins are kept only because nothing changes. The threshold
2.4 is a Bonferroni correction for the 3 C arms. Decision: **measured, not worth it, under stubs.** The toggle and its code
stay in, the default stays OFF, no weight is changed.

### Honest limits

- The executor is a script: it picks `engage` whenever offered, so closing the gate can only hurt it. Jev might use a `sure` or
  `shaken` word to pick a mood or tactic better than the scripted gate does, or worse; free runs cannot say.
- Few hits (0.29 per game; 72 of 1500 games lost): the brake side has little to act on, and a 10% hit-rate change would not be
  visible at this sample size. A difference of a few hundredths of a hit per game is roughly the limit of what 1500 paired games detect.
- Wins are very common (91%); fights are mostly 1 ghost against the hold-and-strike design of P7a, so there is little outcome
  variance for a history score to explain. A weaker explorer (no hold, `hold: false`) would give C more to explain; not run.
- Fights are not independent (the same game contributes several), so the win-rate z-scores are somewhat optimistic; the
  conclusions are all "no effect", where this only strengthens the point. Evaded and pressed are approximations from the turn
  shape in the null arm's passive C (the brain's own flags are used in the on-arms).
- The reliability run (13.3 min) used the first invocation's default sizes; a first sweep with 14 weight sets was stopped after
  about 4 minutes to cut the grid to 10 sets and the sizes to those above, so the total compute was about 54 minutes plus that
  stopped part. Reproduce with: `node scripts/calibrate-confidence.mjs --phase reliability`, `--phase sweep --dtrain 40 --atrain 40 --ctrain 40`,
  `--phase compare --fitted hit-10 --dtest 150 --atest 200 --ctest 150`.

### What the live ablation C5 should judge

1. Whether Jev's mood and tactic picks move with the word (`wary` more after `shaken`, `bold` more after `dominant`), measured
   as pick rates per band over P6's seeds 101-105, toggle on versus off. This is the only effect the stubs could not test.
2. Hits per game and lives lost, with the caveat that about 8 fights per arm cannot show a win-rate difference.
3. Bytes: about +47 B per request, as measured here.
4. Because the code gates were neutral-to-harmful under stubs, C5 should include a **word-only arm** (the `self.confidence` field
   and sentence, no `min_gap` change and `engage` always open) so Jev's use of the word is separated from the code gates. This
   needs a small switch in `brain.js` (not built: C4 is free-run only, and C5 needs approval anyway).
5. Do not spend live calls on C5 unless the user wants the word tested; the free evidence says the gates alone do not pay.

## 6. Files and ownership

| File | Change | Owner |
| --- | --- | --- |
| `src/characters/explorer/confidence.js` (new), `scripts/check-confidence.mjs` (new), `scripts/measure-confidence.mjs` (new), the request-hash fixture and its check | the model, its checks, the measurement, the baseline | brain agent |
| `src/characters/explorer/brain.js`, `memory.js` | hooks, `progress.confidence`, the gates, the effective gap, the request field | brain agent (needs user approval: brain is "stay unchanged") |
| `src/turn.js` | `noteBlocked` call; the `confidence` option through `opts` | adversary agent |
| `src/settings.js`, `server.js` | the `confidenceModel` toggle; passing it when the Run is built | shared; UI agent |
| `public/app.js`, `public/index.html`, `public/style.css` | the meter (from the turn shape) | UI agent |
| `CONTRACT.md`, `AGENTS.md` | updated when a phase lands | whoever lands it |

No `rng()` call is added anywhere (rule 8); the executor's walk-in draws use their own stream in the script.

## 7. Open questions

1. **Drift.** Drift only repairs toward 50. Alternative: no drift, only evades. C4 compares both.
2. **Shield blocks.** A block means the claw nearly landed. +3, capped at 65, for now; it costs a `turn.js` hook.
3. **The last life.** Cap 45 keeps `engage` open (gate 40). Wary's `when` already says "only 1 life is left";
   a cap below 40 would close `engage` on every last life, a bigger change than this plan wants.
4. **Per-ghost confidence**, keyed by `#seen` id. Skipped in C1-C5.
5. **Mood versus `C`.** If C4 shows `C` explains mood choice, the moods could shrink. Not before the data.
6. **Number or band only.** C5 can include an arm that sends only the band word.

## 8. Success criteria

- Toggle off: the existing checks pass and the request-hash baseline matches.
- Toggle on, no hit or kill: the same moves as toggle off under stubs; requests differ only by `self.confidence`
  and the sentiment sentence; the largest decision tick stays within 9500 / 10500 bytes.
- C0 and C4 gates pass and `C` beats the null arm; otherwise this plan is closed as "measured, not worth it",
  which is also a valid result. (Outcome: C0 passed, C4 did not; closed under stubs, toggle stays off.)

## Review notes

Changes made in review (2026-10-07), each checked against the code:
- **`min_gap` formula** replaced by a banded table: at `C = 50` the old formula gave `m + 1` (`Math.round(x.5)` rounds up), changing every game from tick 1.
- **Bold gate dropped:** at `Ceff ≥ 65` it hid bold for ~50 steps of every game and, with the threat term, against every lone 2 hp ghost (P6's win). The "Sentiment order" row dropped: `#askSentiment` shuffles on purpose, and `check-dungeon` asserts 4 options.
- **The `tactic_failed` re-decision after a hit** is already the pending `hit` trigger (`noteHit`).
- **Threat term (`Ceff`) dropped from the gates:** it counted the same odds as `fightFacts` and wary's "outnumbered" text a second and third time.
- **Calm drift** now only repairs toward 50. A resting ceiling of 65 sat in the confident band.
- **Evaded and blocked are capped at 65.** The neutral zone (40..79) now holds every no-hit, no-kill state. The death-spiral figure is corrected: 17 calm steps to re-open `engage`, 50 to reach 50 (not 15).
- **Lives cap:** the old formula gave 65 on the last of 2 lives and 100 at `maxLives` 1. The new last-life cap is 45, and the table covers the settings range 1..9.
- **Band names** no longer reuse the mood ids `wary` and `steady`.
- **Events:**
  - `blocked` has no brain hook: it needs a `turn.js` `noteBlocked`, owned by the adversary agent.
  - Coins came from the move result, not the `coin` event, and the coin event is dropped altogether.
  - The per-ghost `struck` cap never binds: the dispelling strike emits `dispelled`, not `struck`.
  - "Evaded" needs new per-encounter flags, because `escaped` counts every `chase_over`. `check-dungeon` printed `escaped 1, hits 2`. AGENTS.md's "ended unhurt" is wrong about this.
  - "Pressed" (renamed from cornered) exempts `engage` and stunned ghosts.
- **Evidence counters** no longer duplicate `encounters`. The `confidence_note` is dropped (it repeated `recent.encounters` and `self.lives`). The `rules()` sentence moved to the sentiment question, so it stays off the tactic request.
- **Bytes:** the headroom is about 460 / 900 B (worst case 9038 / 9602 B measured today), not 250 B. The sentiment request has no asserted bound.
- **C0 and C4:**
  - The existing stubs never strike or claw (0 strikes, 0 hits measured), so these phases need a new fighting executor, a clawing ghost stub and varied placements.
  - C1 now comes before C0.
  - Calibration is stratified by ghost count.
  - C5 moves to P6's seeded dungeons, with the power caveat.
- **Prerequisites:** P6 is unmerged (worktree 27cd1fc) and P7a is unbuilt. Both come first.
- **Plumbing:** the toggle travels as a constructor option, since there is no explorer configure hook. The weights stay constants until C4.

Not verified or not true:
- **No request-hash baseline exists.** `git log --all -S createHash` finds nothing, and no check script hashes requests, although AGENTS.md says the `adversaryCharacters` toggle is "checked against a request-hash baseline". C2 must build one.
- P6 and P7 numbers come from PLAN-motivation, not re-measured.
- The time per tick of the C0 and C4 runs is not measured.
