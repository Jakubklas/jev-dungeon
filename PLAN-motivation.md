# PLAN-motivation: loot, fight, leave

**Bottom line.** The explorer plays it safe because the text we send Jev tells it to. Survival is the
only stated value, coins and fights have no stated value, and the code itself walks the explorer
straight to the exit once it sees it. This plan states a score (coins carried out), lets Jev decide
when to leave, states the two ways to win (leave through the portal, or dispel every adversary) and
what a fight is worth, makes coins pull on the moves, and cuts the six moods to four that each say
what they go after. Measured on the same 10 gyms before and after (P5).

Status: P1-P4 built on `feature/motivation`, P5 measured (see "P5 results"). P6 (moods at the encounter) is built and measured; P7 (make the fight work) is proposed. Code wins over this plan (AGENTS.md rule 3).

## 0. Baseline (live, 2026-10-07)

Ten gyms `m1-1`..`m10-1`: 21x21 testbed, `props=few`, `coins=12`, exit `far`, seeds 1-10,
1 ghost (m1-m5) or 2 (m6-m10), up to 60 steps. Data and scripts: `runs/motivation/`
(`step-gyms.mjs` steps the gyms (paid), `analyze.mjs` summarises; git-ignored).

| Metric | Result |
| --- | --- |
| Outcomes | 5 left through the exit, **all at step 20** (the shortest path), holding 0, 0, 0, 1, 1 coins; 5 still exploring at step 60 |
| Lives lost | **0 in 400 ticks.** No ghost ever struck the explorer |
| Coins | 13 collected of 86 seen (15%). On 88 of 173 ticks with a lit coin within 3 steps, the explorer stepped away from it |
| Minds, per tick | cautious 65%, curious 20%, courageous 7%, scared 7%, risk_averse 1%, **aggressive 0** |
| Tactic decisions | 25. `engage` was offered in **all 25 and chosen in 0** (its probability 0-17%, even when courageous). `run_away` 17, `carry_on` 4, `race_to_chest` 3, `slip_past` 1 |
| Skills | skill question asked on 5 of 400 ticks; 1 strike (by a scared explorer); 0 blocks |
| Cleared wins | 0 (no ghost was dispelled) |

Caveats: one run, small arenas, `far` puts the exit in a corner 20 steps from the start. The P5
re-run should add a layout where the exit is not on the explorer's natural path (see P5).

The explorer is not scared, it is **indifferent**. It is cautious by default, it never picks a fight
the numbers favour, and it leaves the moment it can, because nothing says staying is worth anything.

## 1. Diagnosis (where each behaviour comes from)

| Behaviour | Cause | Where |
| --- | --- | --- |
| Leaves at once with no coins | Code policy: once the chest is known the approach switches to `go_to_treasure`, and the first `next_move` priority is "Take a move onto the chest". Jev is never asked whether to leave | `brain.js` code policies; `#moveQuestion` `chestLine` |
| Walks past coins | The goal says "collect as many coins as is worth the risk (they count only if you reach the chest); **use few steps, without re-walking ground**": undefined value, all lost on death, and detours break the rule. No approach targets coins; the only coin fact is "Picks up a coin." on the step that lands on one; no priority line mentions coins | `brain.js:139-140`, `perception.js:514` |
| Never fights | `engage`'s value is never stated: the rules say what one strike does, not that a 1-on-1 is favourable (the sword always hits, the stun buys the second strike, the claw recharges in 2). The tactic priorities say "Run away only when …" but "wins a fight worth its risk" without the facts to judge it. The cleared win **is** in the rules sentence ("either by stepping onto the treasure chest or by dispelling every adversary"; the baseline gyms started after that edit), and `engage` still got 0 of 25: naming a goal once in the rules is not enough, the option itself has to say what it gains | `brain.js` `rules()`, tactic `priorities` |
| Sword only when cornered | The cautious moods' skill lines say "strike … only if it blocks your way out". The strike option appears only with a ghost in an aim cell, which `run_away` prevents | `brain.js:66,74,82`; `#skillOptions` |
| Cautious most of the time | Moods are picked on `encounter`, `tactic_failed`, `hit`, `chase_over`: danger moments. The mood question defines a mood as "how close adversaries may come". Cautious's `when` covers nearly every encounter. Aggressive needs "a life to spare" (unclear with 2 lives) "or the chest seen", which is why it shows up near the chest | `#askSentiment`, `SENTIMENTS` |

## 2. The new game (rules text)

Two ways to win, one way to lose, one score.

- **Leave** through the portal (the old chest cell; `dungeon.treasure` until the field is renamed),
  **or clear** the dungeon by dispelling every adversary (already in `resolve.js`).
- **Score = coins held when the game is won.** At 0 lives the game is lost and the coins with it.
- **Leaving is Jev's call**, not a code policy (P1).

Proposed `rules()` opening (replaces the current goal sentence; the rest stays):

> Goal: loot this dark dungeon and get out alive. Your score is the coins you hold when you win.
> You win by stepping onto the portal (it ends the game: leave once staying is not worth it) or by
> dispelling every adversary. At 0 lives you lose, coins and all.

"use few steps, without re-walking ground" goes. Re-walking is still discouraged by the existing
`next_move` priority, which is about exploring, not about the score.

## 3. Phases

### P1 Goal, score and the leave decision

- `rules()`: the text above (the cleared win is already named; keep it).
- **No auto beeline.** Seeing the portal no longer switches to `go_to_treasure` by code. The
  approach becomes `go_to_exit` (rename) and is one more option of `next_approach`, plus:
- **`leave_now` (Noul)**, asked on the `exit` decision tick (the old `chest` trigger) and in each
  approach review once the portal is known. Its facts: coins held, seen piles not collected
  (count, nearest by path), lives, adversaries in sight / remembered, unexplored amount. Above 0.5
  the approach switches to `go_to_exit` and stays there (no more reviews, as today).
- The `chestLine` priority becomes "A move onto the portal ends the game: take it only when
  leaving now (`plan.approach` is `go_to_exit`), or when an adversary would otherwise strike."
- `race_to_chest` becomes `race_to_exit` (the escape hatch under threat stays).
- Byte cost: about +300 B on review ticks (one Noul). Removes about 150 B from `rules()`.

### P2 Coins pull

- **`collect_coins` approach** (exploration, in `availableApproaches` while a pile is lit): target
  the seen pile with the best `count / path steps`, skipping cells in `avoidZone`. Thought:
  "Coins! Worth the detour."
- **Move fact** (shared, so sent once): "2 steps closer to 3 seen coins (4 steps away after this)."
  for the nearest pile by path, only when it is within 8 steps. Replaces nothing; about 60 B per move.
- **Priority line** in `next_move` (after safety, before the mood line): "Coins are the score: a step
  toward a seen pile beats revealing new cells unless an adversary is near."
- **Mood trigger `coins`**: a lit pile of 2+ coins appears while no decision happened in the last
  `REDECIDE_COOLDOWN` ticks. Costs one sentiment call; give it a cap (once per 10 steps).
- Code side: `coinView` already gives direction and distance; `collect_coins` reuses
  `knownDistances`. Fog: lit piles only (`KnownWorld.seenCoins`).

### P3 Fights have a value

- **Rules sentence on the odds** (replaces `combatRule`, about the same length): "Your sword always
  hits an adjacent adversary: -1 hp, knocked back and stunned 2 steps, so the next strike usually
  lands before it can claw; at 0 hp it is gone for good and drops a coin. An adversary's claw needs
  2 steps to recharge, and your shield stops it 60% of the time." Numbers from the live settings.
- **`engage` option fact** says the fight in numbers: "a1 (2 of 2 hp): 2 strikes; expect at most one
  claw at you." Backed by the stubbed duel (`scripts/arenas/duel.json`: 0 hits in 20 holding the 2-step
  gap, 12 in 20 walking in). Verify the claim per phase, never state odds the code does not produce.
- **Clearing named in the option** (the rules already name it; the baseline shows that alone does nothing) when this adversary is the last one known: "Dispelling it may
  clear the dungeon (a win)." Only from the explorer's own knowledge: it cannot know how many
  ghosts exist, so the fact says "the only adversary you have seen". Fog rule holds.
- **Every mood strikes an adjacent adversary when the sword is ready.** The strike stuns, so it is
  also the best defence. The mood decides whether to walk *toward* a fight (`engage`), not whether
  to swing at one that is already there.
- **Drop chance**: raise `coinDropChance` default 0.5 → 1 ("drops a coin"), so a dispel always pays.
  Open question 2.
- Tactic priorities: replace "Run away only when the adversary is close, the space cramped, or
  nothing else is safe." with "Engage a lone adversary when the sword is ready: it pays a coin and
  brings the cleared win closer. Run away when outnumbered, cramped or without the sword."

### P4 Four moods

| New | Replaces | min_gap | end_ticks | Goes after |
| --- | --- | --- | --- | --- |
| `wary` | scared, risk_averse | 4 | 5 | getting away: run, hide, the portal if near |
| `steady` (default) | cautious | 3 | 4 | the plan: explore, coins on the way |
| `greedy` | curious | 3 | 2 | loot: coins and unexplored rooms, detours fine |
| `bold` | courageous, aggressive | 2 | 1 | the fight: engage lone or weak adversaries |

- The mood question becomes "What should the explorer go after right now: safety, the plan, loot,
  or the fight?", with each option's `when` naming its upside and its risk.
- `when` texts get concrete thresholds that do not all point at danger, e.g. `bold`: "full lives or
  hit protection, the sword ready, one adversary in sight"; `wary`: "outnumbered, or a chaser within
  3 steps with no route past".
- Extra triggers outside danger: `coins` (P2), `dispelled` (after a dispel), `exit` (old `chest`).
- Fewer options also shrink the sentiment request (about -400 B).
- Touches: `SENTIMENTS`, memory validation (`sentiment.id`), UI labels, `check-dungeon.mjs`
  (section 4f uses `run_away` under a mood), `measure-memory.mjs` mood counts.

### P5 Measure

Same 10 gyms, same seeds, 60 steps, `runs/motivation/step-gyms.mjs` then `analyze.mjs`. Add a
second batch where the exit is not on the way: a `map` arena with the portal behind the start, or
`size=31x31`. Targets (to judge, not to tune to):

| Metric | Baseline | Target |
| --- | --- | --- |
| Coins collected / seen | 15% | ≥ 50% |
| `engage` chosen when offered | 0 / 25 | ≥ 30% with one ghost |
| Strikes per game | 0.1 | ≥ 1 |
| Cleared wins | 0 | some, on the 1-ghost arenas |
| Lives lost | 0 | some (a non-zero rate means it is taking risks) |
| Losses | 0 | still rare |
| Largest mood share | 65% (cautious) | ≤ 50% |

Plus the free checks (`check-dungeon`, `check-skills`, `check-testbed`) and the request-size bounds.

### P5 results (live, 2026-10-07, commit 8b83250)

P1-P4 built on `feature/motivation`. Batch `m` = the baseline gyms; batch `x` = 31x31, portal 9-10
cells from the start and unlit at step 0, 15 coins. `coinDropChance` 1 on these gyms (default 0.6).
60 steps max. Data: `runs/motivation/after.jsonl` (`after-m.jsonl`, `after-x.jsonl`).

| Metric | Baseline | After, m | After, x | Target |
| --- | --- | --- | --- | --- |
| Coins collected / seen | 13 / 86 (15%) | 44 / 80 (55%) | 46 / 67 (69%) | ≥ 50% ✔ |
| Coins held at a win (avg) | 0.4 | 3.8 | 3.3 | |
| Steps away from a lit coin within 3 | 88 of 173 | 35 of 177 | 26 of 166 | |
| Exits (portal) | 5, all at step 20 | 5, steps 24-48 | 3, steps 14-49 | |
| go_to_exit start → game end (avg step) | - | 30.5 → 42.0 | 33.8 → 41.8 | |
| `engage` chosen / offered | 0 / 25 | 2 / 33 (6%) | 1 / 18 (6%) | ≥ 30% ✘ |
| Strikes per game | 0.1 | 0.4 | 0.2 | ≥ 1 ✘ |
| Cleared wins | 0 | 0 | 0 | some ✘ |
| Lives lost / losses | 0 / 0 | 0 / 0 | 0 / 0 | some / rare |
| Largest mood share | cautious 65% | steady 45% | steady 53% | ≤ 50% ~ |
| Mood picks (decisions) | - | steady 36, wary 15, greedy 13, bold 2 | steady 31, greedy 14, wary 2 | |

**Fixed:** the coin indifference and the instant beeline. Leaving is now a decision. The explorer leaves
about 11 steps after deciding, carrying coins.

**Not fixed: fighting.** When the mood was `bold`, `engage` won with 88-95%. Under `steady` it got
13-39% and `run_away` won almost every time. `bold` was picked on 2 of about 100 decisions, so the
bottleneck is **mood selection at the encounter**, not the tactic text. Likely cause: an encounter starts
at sight range (about 7 steps), and steady's `when` ("an adversary far off (6+ steps) or patrolling")
covers exactly that case, overlapping bold's "one adversary in sight". Candidate fix (P6): steady's `when`
covers no adversary in sight at all; bold's `when` is "a lone adversary in sight (any distance), the sword
ready, full lives or hit protection"; and the tactic question under steady says "engage a lone adversary
when the sword is ready" first. Still 0 lives lost in about 1000 ticks, so the caution costs nothing yet.

**Small findings:**
- x9 left at step 14 with 0 coins. Correct per the code: `leave_now` said 61% while a ghost chased it
  (leaving as an escape). But the switch wrote a `plan.tried` row for `nearest_frontier`
  ("Jev decided to leave"), which reads as a failure; it should use `changeApproach` like the coin switches.
- `analyze.mjs` misses a leave decided mid-encounter (`replaceInterrupted` sets no `policy`), so its
  `leave_pct` column is empty for those games; the memory event has the number.

### P6 results (live, 5 real dungeons, 2026-10-07)

Built as `worktree-agent-aea3845bfaf959486` (27cd1fc), not merged. P6 = steady no longer covers a ghost
in sight, bold covers a lone ghost at any distance, a stakes sentence at encounters, engage as the first
tactic line for a lone ghost under steady/greedy (one shared `#loneFight` gate), leaving no longer logged as
a failed approach. Measured with `runs/motivation/step-arenas.mjs`: 5 normal dungeons on fixed seeds
101-105 (`POST /api/new { seed }`), 120 steps, before = main at 03188c9, after = P6.

| Metric (5 games, 120 steps) | Before | After P6 |
| --- | --- | --- |
| `engage` chosen / offered | 1 / 35 (3%) | **8 / 26 (31%)** |
| Strikes per game | 2.2 | 3.2 |
| Ghosts dispelled | 4 | 6 |
| Mood at an encounter with 1 ghost, 2 lives | wary 13, steady 3, bold 1 | **bold 7** (of 7) |
| Coins collected / seen | 82% | 93% |
| Lives lost | **0** | **3** |
| Games lost / wins | 0 / 0 | 0 / 2 (portal, steps 104 and 109) |
| Mood share of steps | wary 42% | wary 46%, greedy 40%, bold 6% |
| Cleared wins | 0 | 0 |

**Mood selection is fixed:** bold is now the pick for a lone ghost at full lives, and `engage` wins when it
is offered under bold (8 of 8 engages were bold).

**New problem: the explorer does not hold.** Of the 8 fights, 4 went as designed (two strikes, a dispel, a
coin drop, no damage) and **3 each cost a life**; all 3 hits happened at the same moment. The explorer reached
the holding cell, 2 steps from the hunting ghost, then stepped toward it (move confidence 0.53-0.67 for the
step in, 0.05-0.10 for staying), ended next to it, and the ghost clawed first. The sword was not even
offered on that step, because no ghost was adjacent before the move. Every duel in `check-skills.mjs` says
holding takes 0 claws and walking in takes some: the 3 of 7 walk-ins that cost a life match that. Causes in
the text Jev reads (printed with a stub at the holding cell):
1. The `stay` option reads "Stand still." and its shared fact "Stands still: reveals nothing. The chasing
   adversary keeps moving"; nothing says staying is the plan at the target.
2. Bold's move line says "moving toward an adversary is fine."
3. On ordinary ticks (3 of the 4 steps of each approach) the priorities include "Stay makes no progress and
   lets adversaries close in: only when every step is worse." and "Prefer moves revealing many new cells".

### P7: make the fight work (proposed)

**P7a, hold at the holding cell.** The goal is zero claws when Jev has chosen `engage` against a lone ghost.
Two options; recommended is **B + A**:
- **A (text):** at the holding cell, the engage move options say it: `stay` = "Hold here: it steps next to
  you and you strike first." and the other moves "Steps off the holding cell: gives it the first claw."
  For engage, drop the generic "Stay makes no progress..." and "reveal new cells" priorities and bold's "moving
  toward an adversary is fine" from the engage move question.
- **B (code):** with approach `engage`, a hunting lone ghost at known-path gap 2, the sword ready and the
  explorer standing on the engage target, the brain holds (a `stay`, no move question; the skill question
  still goes out when the ghost steps adjacent). The decision to fight stays Jev's (the tactic choice); the
  hold is execution, saves a call and cannot be talked out of. Cost: one more code policy in `takeTurn`.
- **Checks:** an end-to-end duel through the real `ExplorerBrain` with a scripted Jev that picks `engage`
  and then follows the printed facts (including a "walks in" variant that picks the first non-stay move):
  over the 24 ghost placements of `check-skills` section 12, claws taken = 0 with B, and the text-only
  variant (A) shows how often a text-following Jev still steps in. Free, no live calls.

**P7b, strike as soon as the ghost is adjacent.** Today the skill is offered from the position before the
move. When the explorer holds and the ghost steps next to it, the next tick offers the sword (the aim cell
now holds a visible ghost): confirm in the end-to-end duel that the strike lands on that very next tick, and
that the ghost has not clawed in between (ghost budget 0.6, claw cooldown 2).

**P7c, outnumbered is not one case.** Wary was 46% of steps; with 3-12 ghosts per dungeon, "2+ adversaries in
sight or remembered" is true most of the game (remembered sightings last 30 steps). Plan:
1. Measure for free: stubbed duels of the explorer holding against two ghosts that arrive N steps apart, to see
   when it still takes at most one claw (the first dispel stuns and knocks one back; the second arrives later).
2. If a clean rule exists, split wary: `outnumbered` means two or more ghosts within a gap of the explorer
   that makes them arrive together; a remembered ghost older than about 10 steps no longer counts; a hunting
   ghost with another 4+ steps behind it is a lone fight now.
3. Re-word bold and the stakes sentence to the same rule, with the same gate in code (`#loneFight`).

**P7d, the clearing win.** In dungeons with 4-12 ghosts, clearing needs 4-12 dispels; 6 dispels in 5 games
reached no clear. The explorer cannot know how many ghosts exist (fog), so no fact can promise it. Leave it
as the arena-scale goal and do not tune for it; revisit after P7a-c if dispels per game stay low.

**Measure (free first, then live):** the end-to-end duels above, then the same 5 seeded dungeons (add 5 more
seeds and 150 steps if the budget allows: 8 engages is a small sample). Targets: lives lost per fight <= 0.1,
`engage` chosen >= 30% of offers (kept), strikes per game >= 3, dispels per game >= 2, bold share >= 10%.

### P7c results (free, stubbed duels, no behaviour change)

Measured with `node scripts/measure-outnumbered.mjs` (about 2 minutes, no Jev, no network; the explorer is the real
`ExplorerBrain` with the engage hold, 2 lives, mood bold, sword only). Two hunting ghosts, ghost hp 1 and 2, in the
open room (first ghost over the 24 placements of check-skills section 12, the second N = 0..6 cells further along
the row or beside it, 105 runs per policy, set and hp) and in the 1-wide corridor (N = 1..5). Settings: default,
`stunTicks 3`, `clawCooldown 3`. Two scripted Jevs: `follow` (engage, then the move whose fact says it is the target,
else stay) and `walk-in` (the move that closes on the nearest ghost whatever the facts say).

| Scripted Jev | Runs (all sets, rooms, hp, N) | Claws | Runs with a claw | Deaths at 2 lives |
| --- | --- | --- | --- | --- |
| follow, two ghosts N = 0..6 | all | **0** | 0 | 0 |
| follow, remembered-ghost proxy | 432 | **0** | 0 | 0 |
| walk-in, default settings, open room | 210 (hp 1 and 2) | 72 | 67 | **1** (hp 2, N = 4) |
| walk-in, default, corridor | 10 | 1 | 1 | 0 |
| walk-in, remembered-ghost proxy | 432 | 22-30 per 72 | 17-21 per 72 | 0 |

- A text-following Jev takes no claw against two ghosts at any offset, in either room, at all three settings.
  The reason is the same as for one ghost: both ghosts arrive one at a time, the first strike stuns and knocks one
  back, and the sword is ready again (cooldown 1) before the next claw (cooldown 2).
- A Jev that walks in takes up to 2 claws per run (3 in the proxy), one per ghost fought, and at default settings
  one run in 210 loses both lives (open room, hp 2, second ghost 4 cells behind). The hold does not apply with a
  second ghost in sight, so nothing in code backs "at most one claw" there. Only N = 6 (6 runs) and the corridor
  with N >= 4 were clean, too narrow to hang a rule on.
- Remembered second ghost: the harness cannot hand the brain an earlier sighting, so the proxy is the worst case,
  a hunting ghost that starts out of sight 9+ cells away (about 15+ ticks off) and keeps coming. It changes
  nothing for a following Jev (0 claws) and adds claws only for the walk-in Jev. A remembered ghost that was
  patrolling cannot arrive at all, but the brain does not know that, so the age rule cannot be a truth claim either.

**Conclusion: no clean rule, so no behaviour change.** The bar was "at most one claw per ghost fought and no
case that kills at default settings"; the walk-in Jev kills once and takes 2 claws in a run, and the facts-following
Jev's zero is a property of the text working, not of anything the code guarantees against a second ghost. The
claims in the stakes sentence, the engage default line and the `when` texts are only true with the gate
`#loneFight` (one ghost, none remembered), so loosening it would make them false. Left unchanged: `#loneFight`,
the mood `when` texts, the stakes sentence. The way forward, if the wary share still hurts in a live run, is a code
change the data cannot yet back: extend the hold to a pair (hold at the gap-2 cell of the nearest ghost while
the other is 5+ steps behind) and re-measure with `measure-outnumbered.mjs`; the walk-in column must reach 0 claws
and 0 deaths first. The 46% wary share stays as measured in P6.

## 4. Cost, size and ownership

- **Jev calls**: P2's `coins` trigger and P4's `dispelled` trigger add sentiment calls (capped).
  P1's `leave_now` rides on existing requests.
- **Request size**: about 1.2 KB headroom today (AGENTS.md "Request-size headroom"). P1 and P4
  free about 550 B; P2 and P3 add about 500 B on the busiest decision tick. Measure each phase with
  `measure-memory.mjs` (dry) before the next.
- **Files**: `brain.js`, `memory.js` (brain agent); `perception.js`, `encounter.js` (world agent);
  `settings.js` (drop chance); `public/app.js` (mood labels, score); checks and AGENTS.md /
  CONTRACT.md. P1-P3 need no change to `dungeon.js` or `resolve.js`.
- **The portal** is visual only (`drawPortal` in `public/app.js`, from branch `worktree-portal`).
  Everything else still says chest: `dungeon.treasure`, `won_by: 'chest'`, `go_to_treasure`,
  `race_to_chest`, the rules text, the memory event "Stepped onto the treasure chest", the `chest`
  landmark and the UI's "Treasure found". P1 renames the explorer-side text and ids; the world fields
  can follow separately.
- **Clearing** is the always-on rule in `resolve.js` (`won_by: 'cleared'`, AGENTS.md "Victory"). The
  branch `worktree-portal` has a different, opt-in version (testbed `winOnClear`, set in
  `Run.playTurn`, no `winBy`) that is not on `main`; only one should survive.

## 5. Open questions

1. **A toll for the portal?** E.g. it opens only with 5 coins. It guarantees looting but can trap a
   wounded explorer. Recommendation: not now; P1's `leave_now` plus the score should be enough.
   Revisit if P5 still shows early exits.
2. **Drop chance to 1?** It makes every fight pay. Recommendation: yes.
3. **Exchange rate between a life and coins** ("a life is worth about 3 coins")? It gives Jev a
   concrete trade-off but has no effect in the rules (lives are not sold). Recommendation: no;
   state the real stakes (lose everything at 0 lives) and let the mood weigh them.
4. **A step clock** (the portal closes, the torch burns out)? Recommendation: only if P5 games drag
   on without leaving.
5. **Bonus for clearing?** Clearing already ends the game with the coins held, and every dispel drops
   a coin. Recommendation: no extra bonus.
