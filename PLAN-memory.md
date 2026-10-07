# Plan: explorer and adversary memory (2026-10-07)

## Bottom line

The explorer's memory records its own **mood and approach** well, but not the **world it has been through**. Three things stop it acting smart:

1. It forgets a ghost as soon as the ghost is out of sight.
2. It cannot see that it is going back and forth.
3. Most of its findings repeat the same chase lines.

I recommend four phases, in this order:

| Phase | What | Why first |
| --- | --- | --- |
| **P0** | ~~Fix the alerted-adversary crash and the 8 failing adversary fog checks~~ Fixed by another session during this job (02:00–02:07); one coverage gap left | It was a 502 in any game with 2+ ghosts |
| **P1** | World memory: last-known threats, recent path, landmarks | Biggest behaviour gain for the least code |
| **P2** | Regroup Jev's state into `self / surroundings / threats / memory`, trim the noise | Clearer state, ~30–60% smaller decision ticks |
| **P3** | A shared, capability-ready "options" layer for explorer and ghosts | Weapons, sprint and attack can be added without another restructure |

**Done now:** the `curious` mind replaces `calculated` (see the last section). In a live :3001 run, Jev picked `curious` at the start (p = 0.94) and dropped it (p = 0) for `courageous` when a ghost began chasing. **Needs your OK:** P1a changes hard rule 1 in AGENTS.md (the explorer may remember ghosts it *saw*, frozen at the moment it saw them).

## Evidence

### Live testbed runs on :3001
These used real Jev, one ghost each. Caveat: the 3001 server was started at 23:09 on Oct 6. The explorer files were edited until 23:59 and the adversary files until 01:59, so these runs used slightly older code.

| Run | Arena | What happened |
| --- | --- | --- |
| run1 | Two rooms joined by a door, ghost behind the door, chest down a corridor | **#7–10:** `hide` ping-pongs left/right at the door, move confidence 0.40–0.52. **#15→18:** `chase_over` after 4 unseen ticks, then the explorer walks straight back to the door and meets the same ghost. **#28–36:** it runs into a corner and ping-pongs up/down 6 times, then `stay`s 3 times while the ghost closes from 4 to 3 cells. Chest never found in 40 steps. |
| run2 | Open 21×13 room, chest far | **#1–2:** the ghost is visible at step 1, so it pays two sentiment calls back to back (`start`, then `encounter`). **#8→10:** `chase_over`, then it walks back across the ghost's column and gets re-spotted. Chest found at #28 and reached by #35. |

### Stubbed runs (free): request size per Jev call

| Request | Average | Max |
| --- | --- | --- |
| Explorer tick | 5.8 KB | **19.3 KB** (decision tick with 5 tactics) |
| Explorer sentiment | 5.8 KB | 6.7 KB |
| Adversary step | 5.5 KB | 7.0 KB |

- In the 19 KB request, `state` is only 3.6 KB. Each of the 5 `move_if_<tactic>` questions is about 2.7 KB, because each repeats the same 7-line priorities list.
- `game` (RULES, about 1 KB) and `memory.objective` are static, yet they are sent on every call.

### Old `memory.json` (374-step won game)
- 10 of the 12 findings are "Spotted an adversary…" or "Got away: no adversary in sight for N ticks (step S)". The step also appears twice in each one (once in the text, once in `step`).
- None of them says *where*.
- `sentiment_history` holds five entries like `calculated, cautious, calculated, cautious, aggressive`.

### The `calculated` mind
- It was never the top pick in any live decision, but it took 0.23–0.29 of the probability mass in contested ones.
- Its profile (min_gap 3) duplicated `cautious`.
- That supports removing it.

## Diagnosis

| # | Gap | Effect |
| --- | --- | --- |
| 1 | **No memory of where threats were.** Rule 1 sends only adversaries visible *now*. "Spotted…to the north" findings are text with no cell. | It re-enters the area it just fled, so it meets the same ghost again (seen in both runs). |
| 2 | **No short-term path.** `latest_action` holds one move, and `revisits_last_10` is only a count. | Two-cell ping-pong is invisible, especially under `hide` and `run_away`, where "keep the distance growing" pulls both ways. |
| 3 | **Findings are a flat, append-only text log** (12 lines, the oldest evicted). | Chase spam pushes out useful facts. There are no types, so code can't dedupe or summarise. |
| 4 | **Noise in memory.** | `latest_action.probabilities` (5 numbers nobody uses), `profile_note` (repeats the sentiment criteria), `sentiment_history` repeats, and `objective` (static) are all sent on every call. |
| 5 | **Mixed concerns in one `memory` blob.** | Self-state (lives, protection) sits in `situation`, mood sits in `memory`, rules sit in `game`. Jev reads the same "who am I / where am I / what threatens me" spread across three places. |
| 6 | **No "options" concept.** Moves are the only action, so tactics are hard-coded per encounter. | Every future capability (pick up, sprint, attack) would need bespoke wiring in brain.js and adversary/brain.js. |
| 7 | **Adversary memory is noisy.** | `approach.tried` fills with `direct_pursuit ↔ sweep_last_seen` flip-flops (5 rows in the sample), and findings repeat "Lost sight at tick N". |
| 8 | **The adversaries' surroundings are thin.** | `situation.map` is only width/height/room count. Other ghosts appear only as positions, so there is no shared plan. |

## P0: fix first (adversary owner's uncommitted work)

**Status:** another session fixed both issues during this job.
- `switchOnAlerted` now calls `setApproach(sweep_last_seen)`. That is exactly the fix below.
- `check-adversaries.mjs` passes again.
- The repro passed 5 times out of 5.

The coverage-gap item below is still open.

- **Crash.** `alertNearby` → `switchOnAlerted` → `brainOn`, but `approach.id` stays `null` until the next `applyDecision`. `saveMemories` then throws "approach.id must be set exactly while the brain is on", and `POST /api/step` returns 502.
  - Repro: `node scripts/run-testbed.mjs --size 15x15 --numAdversaries 2 --props few --seed 3`.
  - Fix: in `switchOnAlerted`, set the approach (`sweep_last_seen`, reason "called for help") right after `brainOn`. `pickApproach` stays `true`, so Jev still picks on the first search step.
- **Fog checks.** `check-adversaries.mjs` fails 8 fog checks:
  - "request changed when the hidden explorer moved"
  - "hidden explorer coordinates in a request"
  - "explorer block not empty"
  - "approach not sweep_last_seen / cut_off"

  These are probably the same alert path, or the new perception code reading `game.pos` out of sight. Fix before any live game with 2+ ghosts.
- **Coverage gap.** `check-testbed.mjs` passes because its ~25 stub ticks never trigger an alert. Add a 2-ghost scenario where one ghost is within `ALERT_STEPS` of the other.

## P1: world memory (biggest win)

### P1a. `threats.remembered`: last-known ghosts
**Needs your OK:** this amends rule 1.

- Per adversary id, freeze what the explorer saw at the last tick it was visible:
  - `{ id, last_seen_cell, steps_ago, was_chasing, direction_now, distance_now }`
  - `distance_now` is the known-path distance from the *current* position to the *frozen* cell.
- **Fog-safe:** it is built only from `visibleAdversaries()` at sighting time, then updated only by the explorer's own position.
  - Twin test: scramble hidden adversaries after the sighting, and require byte-identical requests.
- Drop an entry after N steps (e.g. 30) or once the explorer has re-lit and seen that cell empty.
- **Move facts:** "Heads toward where a chasing adversary was last seen 5 steps ago (3 steps from it)."
- **Approach targets:** `nearest_frontier` / `far_side` penalise frontier cells within ~6 steps of a recent sighting.
- **Sentiment criteria:** use "a ghost was seen N steps ago" instead of only "nothing in sight".

### P1b. `recent.path`: short-term motion
- The last 6 cells as compass moves, plus `undo_count_last_6`. This replaces `latest_action` and `revisits_last_10`.
- New move fact: "Returns to the cell you left 2 steps ago (you have gone back and forth 3 times)".
- Code policy: after 3 ping-pongs under a tactic, raise `tactic_failed`, so Jev re-decides instead of oscillating.

### P1c. `landmarks`: a few typed, located facts instead of chase text
- Up to 8 entries, each `{ kind, cell, direction, distance, note }`.
- Kinds: `chest` (pinned), `dead_end_explored`, `ghost_seen` (from P1a), `hit_here`, `hiding_spot_used`, `exit_unexplored`.
- Code dedupes by kind and cell, and refreshes `direction`/`distance` each tick from the current position, so Jev never has to do the arithmetic.

### P1d. Findings become counters plus a short event list
- `encounters: { count, escaped, hits, last_at_step }` replaces the "Got away…" spam.
- Keep at most 6 narrative events (chest seen, hit, approach switched), with no duplicated step in the text.

## P2: regroup and trim the state Jev reads

TypeSafe's state guidance: group related facts under descriptive names, keep the judgment in the question and the facts in state.

Proposed shape, the same for both character types where it applies:

```text
state = {
  game:      RULES (static; objective folded in; ~40% shorter),
  self:      { lives, max_lives, hit_protection_steps, mind: { id, since_step },
               /* P3: inventory, status (sprinting), cooldowns */ },
  surroundings: { here, exits, unexplored_by_direction, frontier_cells, chest,
                  landmarks[] /* P1c */, items_nearby[] /* P3 */ },
  threats:   { visible[], remembered[] /* P1a */, encounter },
  plan:      { approach { id, current, since_step, interrupted }, tried[] },
  recent:    { path /* P1b */, encounters /* P1d */, events[] }
}
```

Trims:
- Drop `latest_action.probabilities`, `profile_note` and `objective` from per-call memory.
- Collapse `sentiment_history` to runs: `cautious×3 → scared`.
- Speculative `move_if_<tactic>`: send only the 2–3 tactic-specific priorities. Keep the generic ones once, in `tactic`.
  - Target: decision tick from 19 KB to ≤ 9 KB.
- Merge the double sentiment call when `start` and `encounter` fall on the same or the next tick. One call, using the encounter facts.
- The `memory.json` file stays the "source of truth", but it becomes the persistent part only (`plan`, `recent`, `landmarks`). `self`, `surroundings` and `threats` are recomputed each tick in perception. This keeps the fog guard simple, because perception is the only place that reads the world.

Adversaries:
- `tried` keeps search-approach outcomes only, not the `direct_pursuit` flip-flops.
- Findings become counters (`sightings`, `lost_sight`, `hits`).
- Add `surroundings` (cell kind, nearest junction or doorway, exits).
- Add `team: [{ id, path_steps, role: 'pursuing' | 'searching' | 'patrolling' }]`. Role is safe to share because ghosts already call each other.

## P3: capability-ready options (design now, build when the first capability lands)

### Goals
- `pick_up`, `sprint`, `attack` and others plug in without touching brain.js question code.
- The same capabilities work for explorer and adversaries.
- Fog rules and the Jev cost stay bounded.

### Registry design (`src/capabilities/`)
```js
// one entry per capability; shared by explorer and adversaries
{ id: 'sprint', who: ['explorer'], cost: { stamina: 3 }, cooldown: 6,
  feasible(view, self) -> null | { fact, targets? },   // view = KnownWorld or adversary view
  apply(game, actor, target) }                         // world rules live in Game, not here
```

### How it works each tick
1. Code builds `options`: legal moves plus every **feasible** capability, each with a one-sentence fact. For example: "Sprint: move 2 cells this step, 3 stamina, ready again in 6 steps; would put 9 steps between you and the ghost."
2. Infeasible ones never reach Jev. This is the same pattern as `tacticFeasibility`, which already works well.
3. **Questions:**
   - `next_move` stays as it is.
   - An `action` Choice is added only when ≥ 1 non-move capability is feasible. It has a `none` option, and it is asked in the same request as the move, so there is no extra round trip.
   - Combined actions that need a direction (sprint left) reuse the move answer.
4. **State:**
   - `self.inventory`, `self.status` and `self.cooldowns`.
   - `surroundings.items_nearby` (known lit cells only, for the explorer).
   - Capability rules go into `game` RULES once, not per call.
5. **Minds interact with capabilities through a profile field.** For example, `aggressive.prefers = ['attack']` and `curious.prefers = ['pick_up']`. The field adds a priority line, the same mechanism as today's `priority`.
6. **Determinism:** capabilities that use randomness take the game's seeded RNG stream, never `Math.random`.

### Fog
- Explorer feasibility reads only `KnownWorld`. Add `knownItems()` there.
- Adversary feasibility reads the adversary view. Extend the static guard allowlist for `src/capabilities/` the same way it covers `explorer/*`.

## Test plan for P1–P3

- **Fixtures:** keep the two live arenas as fixtures, `scripts/arenas/door.txt` (run1) and `open.json` (run2), plus a corridor ping-pong map.
- **New metrics script** (`scripts/measure-memory.mjs`, dry run, free), printing per scenario:
  - request bytes (average and max, per kind);
  - re-encounters within 8 steps of `chase_over`;
  - ping-pong count;
  - steps to chest;
  - hits.
- **Live:** run each fixture before and after each phase with 1 ghost, about 40 ticks. Roughly 60–100 hedged requests per run.
- **Twin tests** for P1a (hidden ghost moves after the sighting) and P1c.

## Done now: the `curious` mind

`calculated` is removed. `curious` is the opposite of `cautious`: it is drawn to the unknown and accepts more exposure for discovery.

| | `cautious` | `curious` |
| --- | --- | --- |
| min_gap | 3 | 3 (unchanged safety floor; boldness near ghosts is still `courageous`/`aggressive`'s job) |
| end_ticks | 4 | 2 (back to exploring quickly) |
| when | Lives below the maximum, a recent hit or chase, or an adversary far or patrolling | Full lives, no adversary in sight or chasing, plenty unexplored |
| priority | Well-connected ground, avoid dead ends and corridors | Most new cells, never-visited cells, corridors and dead-end branches that still lead to unexplored space |

`cautious`'s `when` was narrowed so the two don't compete on "normal exploring". `cautious` is still the default before the first pick.
