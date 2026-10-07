# PLAN-motivation: loot, fight, leave

**Bottom line.** The explorer plays it safe because the text we send Jev tells it to. Survival is the
only stated value, coins and fights have no stated value, and the code itself walks the explorer
straight to the exit once it sees it. This plan states a score (coins carried out), lets Jev decide
when to leave, states the two ways to win (leave through the portal, or dispel every adversary) and
what a fight is worth, makes coins pull on the moves, and cuts the six moods to four that each say
what they go after. Measured on the same 10 gyms before and after (P5).

Status: **proposal, not approved.** Nothing here is built. Code wins over this plan (AGENTS.md rule 3).

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
