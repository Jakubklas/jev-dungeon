# Explorer review and five live arenas — 9 October 2026

Reviewed and merged revision: `1fccb13` (main). Hub restarted on that revision.
Four starting/max lives, natural regeneration from main (0.5 life each 30 steps).
Five headless Chromium pages, 50 ms delay, until portal victory/loss or 250 turns.
Same five seeds as the earlier motivated run; initial tiles and enemy counts match.
The page delay is additional to API latency and animation delays, not a 20 Hz simulation.

## Review fixes

- Retained heart goals stop when fractional regeneration reaches full health.
- Known-floor distances replace straight-line distance in the bare lethal-walk guard.
- Winning portal steps and heart pickups that make exposure survivable remain allowed.
- A held lethal move schedules a new tactical decision rather than silently repeating it.
- Recovery destinations survive encounter completion; exploration goals can refresh around remembered chasers.
- Mood telemetry separates the actual eligible menu and code-selected moods from Jev choices.
- Merge conflicts preserve main's regeneration with four lives; request hashes regenerated separately.
- Tests assuming two default lives or identical two-/nine-life combat traces were updated.

## Outcomes

| Arena | Seed | Result | Turns | Dispels | Hits | Portal seen → win | Final lives |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| reviewed1 | 2523595354 | Portal win | 43 | 2 | 0 | 36 → 43 (7 turns) | 4 |
| reviewed2 | 2702359518 | Alive at cap | 250 | 2 | 1 | Not discovered | 4 |
| reviewed3 | 1678307943 | Portal win | 206 | 5 | 0 | 199 → 206 (7 turns) | 4 |
| reviewed4 | 4294615505 | Portal win | 150 | 4 | 0 | 141 → 150 (9 turns) | 4 |
| reviewed5 | 1289938263 | Alive at cap | 250 | 2 | 0 | Not discovered | 4 |

## Mood and strategy measurements

Across 899 turns, mood occupancy: bold 826 (91.9%), panic 32, steady 31, guarded 10.
Actual Jev mood choices: bold 54, steady 2. Panic was selected automatically three times;
other occupancy changes include silent confidence-driven swaps. Fearless was offered 49 times
and chosen zero times. Its average returned probability across each game's offers was 5.6–7.7%.
No cautious, wary, greedy or fearless choice occurred. This does not establish preferences for
moods that were not eligible.

Tactic selections: engage 24, run_away 1. Of 25 selections, 23 had a single available option.
One menu offered engage/slip_past and selected engage. One offered engage/hide/run_away and
selected engage. The sole retreat was a forced run_away after a three-life claw hit.
Most combat choices therefore measure execution under gating, not freely chosen risk appetite.

Approach occupancy: nearest_frontier 529, collect_coins 157, engage 98,
largest_unexplored 40, go_to_exit 26, run_away 19, heal 15, far_side 15 turns.
All three games that discovered the portal won within 7–9 more turns; clearing enemies alone
never ended a game. Across five games, 15 enemies were dispelled with one claw hit.

## Memory and remaining behavior

Reviewed2 took a hit at turn 172 (4 → 1 lives), then retreated and found a heart at 192.
It selected heal at 200, retained the journey without another healing review, regenerated at 210,
collected a second heart at 214, and resumed exploration at full health. It ended in engage.
Natural regeneration also occurred at 180. This is evidence of recovery followed by renewed advance.

Reviewed5 spent 91 consecutive turns in collect_coins (118–208). Reviews kept rating that
approach as working (57–80%). After completing it, the explorer cycled nearest_frontier →
largest_unexplored → far_side → nearest_frontier → largest_unexplored, with little new ground.
At the cap reviewed2 had explored 29%, reviewed5 55%; neither knew the portal yet.
Navigation and lengthy loot detours remain the clearest observed limits.

Next work should bound coin detours and retain a known return junction/branch destination,
then measure portal discovery time. Test voluntary glory hunting in a controlled arena that offers
both a viable advance and an optional visible enemy before changing fearless eligibility.

The prior motivated run won 2/5 at the same cap; this run won 3/5. Four lives, new natural
regeneration, prompt/execution changes and variable Jev responses all differ, so this is not a
causal estimate of improvement.

## Validation and artifacts

Config, skills, hearts, regen, portal objective, testbed, confidence/caps/wiring, inject,
levels, adversaries, dungeon/fog twins, duels, linear layout/spawn and property checks pass.
The regenerated request-hash fixture passes all 39 scenarios (2,169 requests).

Full response traces, initial states, effective configs, screenshots and measurement summaries:
`runs/observations/2026-10-09-explorer-review/` (ignored runtime artifacts in the primary checkout).
Five pages are closed; their hub instances remain idle and inspectable at
`http://localhost:3000/arena/reviewed1/` through `reviewed5/`.
