# Explorer follow-up after portal motivation fixes

## Live comparison, 9 October 2026

Five headless Chromium games ran at a 50 ms browser delay, stopping on victory/loss or 250 steps.
The replay used the same five seeds, map tiles, initial enemy positions/HP/levels, three starting lives,
and mechanical settings as the preceding linear-layout run. Only explorer prompts and portal policy changed.
Jev responses and shuffled options remain variable; one replay per seed is exploratory evidence, not a causal estimate.

| Seed | Before | After | Dispels before → after | Portal discovery → victory, before / after |
| --- | --- | --- | --- | --- |
| 2523595354 | Won, 134 steps | Won, 134 steps | 2 → 2 | 121 → 134 / 127 → 134 |
| 2702359518 | Alive at 250 | Alive at 250 | 2 → 3 | Not seen / not seen |
| 1678307943 | Alive at 250 | Alive at 250 | 5 → 5 | Seen at 183, no victory / not seen |
| 4294615505 | Won, 167 steps | Won, 129 steps | 4 → 4 | 139 → 167 / 121 → 129 |
| 1289938263 | Lost, 213 steps | Alive at 250 | 4 → 5 | Not seen / not seen |

Both replays that discovered the portal won within 7–8 further steps. The old third game's refusal
to finish after seeing the portal cannot be compared directly: its replay had not discovered it by the cap.
The deterministic commitment and stubbed regressions establish the behavior independently of those live choices.

Game 2's retreat tactic selections fell from 17 to 2, and ticks with back-and-forth in the recent window
fell from 63 to 6. It advanced over 207 distinct cells, compared with 185 before, but took a hit and needed recovery.
After the hit at step 203 it found hearts at 227 and 249, restoring all three lives.
Game 5 survived a hit at step 200, entered panic, and pursued healing rather than dying as in its old run.
It still repeatedly dropped and restarted the heal approach while travelling across known ground.

Fearless was never selected in either linear run. The new wording did not establish a glory-hunting behavior.
Several encounters offered only engage: their outcomes measure execution, not Jev choosing risk over safety.
Keep the offered menu, selected tactic, mood eligibility, and outcome separate in future measurements.

## Changes now implemented

- Every request identifies stepping through the portal as the win and dispelling as permanent obstacle/pursuer removal.
- Moods describe stances serving progress; caution is recovery/repositioning, bold favours manageable fights,
  and fearless explicitly hunts visible enemies for glory.
- Portal discovery commits a persistent destination, including the interrupted plan during encounters.
  Active player directives remain in charge, with the portal plan available afterward.
- Ordinary reviews and coin detours cannot replace that destination. A feasible portal tactic remains available
  alongside forward combat rather than being pruned as retreat.
- No confidence parameters, enemy policies, fog rules, or memory schema changed.

## Next implementation plan

1. **Preserve useful travel commitments.** Judge healing and other long journeys by decreasing known-path
   distance and recovery achieved, not mainly newly revealed cells. A review must not reject heal and
   immediately restart it without a changed route or reason. Retain destination, interruption reason,
   and a recovery condition through encounters. Test long travel to a heart across explored ground.
2. **Make encounter execution coherent.** Reproduce the earlier fatal cases in testbed arenas: the tactic
   says hold while its move question has no workable target, or movement enters lethal claw range while
   the independently selected skill is none. Derive speculative moves from the same tactic target/options;
   explain exposure using observed claw damage, readiness, stun and grace. Do not claim every fight is safe.
3. **Improve portal discovery before increasing aggression.** Game 3 cleared all five enemies but still
   had not found the portal at 250 steps. Preserve chosen frontiers across combat and bounded coin detours;
   remember completed branches and their return junction using known tiles only. Never read hidden room
   roles, order, or the portal position to supply a forward direction.
4. **Measure glory hunting directly.** In a matched arena with a feasible advance and an optional visible
   enemy, compare eligible bold/fearless choices, target selection and pursuit persistence. Both moods
   remain subordinate to the portal win. Assess whether the choice is too weak or merely rarely warranted
   before changing confidence eligibility or removing cautious options.
5. **Repeat paired live measurements.** Use the same seeds and settings, multiple replays per seed, and
   dedicated encounter arenas. Report portal discovery-to-win steps, frontier/heart distance trends,
   repeated retreats without recovery, lethal exposure, healing, dispels, and offered choices.

## Verification and artifacts

Dungeon, skills, testbed, portal objective, config, confidence/caps/wiring and inject checks pass.
Request-size limits remain unchanged (largest measured chase 9,338/9,500 bytes; patrol 9,904/10,500).
The request-hash check reports 39 expected differences beginning at the changed `state.game` objective;
its fixture is intentionally left for the separately planned regeneration commit.

Local turn traces, effective config snapshots, initial states, and screenshots are in
`/tmp/jev-motivated-observation/`; the preceding run is in `/tmp/jev-linear-observation/`.
These temporary artifacts are not committed. All five observation instances were stopped.
