# Plan: adversary memory and fixed character (2026-10-07)

## Bottom line

Give every ghost (1) a **fixed character** made of five small traits, set at spawn and never re-picked, (2) the **same smart memory** the explorer is getting (frozen sightings, recent path, landmarks, counters and events, team reports), sized by the character, and (3) a **limited, per-ghost map** (home territory + what it has seen, fading) in place of the real full map. All of it sits behind one new class, `AdversaryView`, which is to ghosts what `KnownWorld` is to the explorer.

**Needs your OK:** this changes the AGENTS.md line "Adversaries know the real map" (hard rule 1 extended to ghosts), and adds one private field (`character`) to `Adversary`. The public shape stays six keys.

| Phase | What | Behaviour change | Why in this order |
| --- | --- | --- | --- |
| **A1** | `AdversaryView` in `full` mode (reads the real map) plus an extended static guard and twin tests | none, byte-identical requests | Makes the fog rule enforceable before any fog exists. Safe refactor. |
| **A2** | Character: traits, presets, assignment, code profile, priority line, `standard` = today | none until the toggle is on | Memory limits and map limits both read the character. |
| **A3** | Memory: sightings, recent, landmarks, lifetime counters, team reports, regrouped state | smarter search, ~+15% request size | Mirrors explorer P1/P2; reuses a shared pure kit. |
| **A4** | Flip the view to `limited` (home zone + seen cells, fading, capped) | ghosts can be outwitted; tune with metrics | Needs A1 (the view), A2 (radius/ttl per character) and A3 (memory to compensate). |
| **A5** | Capability hookup (`who: ['adversary']`, `prefers`/`avoids`, `self.inventory`) | when the first capability lands | Design now so A1-A3 do not need a restructure. |

**A5 is superseded by PLAN-skills.md** (ghosts get a claw strike through the shared skills layer; `src/capabilities/` is deleted).

Recommended defaults: toggles `adversaryCharacters` and `limitedMap` both **off** until A3 is measured; then on. Everything is deterministic from the seed.

Status (2026-10-07, after commit db86226): the explorer memory work is finished and committed, so its files are free to change. Its `memory.js` has `recent`, `landmarks`, `encounters`, `events` (with `backAndForth` and `addLandmark` as exported helpers), and `perception.js` has `rememberedView`/`avoidZone` (zone radius 10 for sightings under 10 steps old, 6 up to 15, plus a sector for chasing sightings). Reuse their pure helpers by extracting a shared kit (A3) rather than copying or importing across character folders. **Already built on the adversary side** (the "P2" rebuild, not part of A1-A5): `tally` + `events` instead of findings, search-only `tried`, `surroundings`, `team` roles, regrouped state `{ game, tick, self, surroundings, explorer, last_seen, team, recent }`, rules text following live tunables. **Still to build:** everything character-, view- and sighting-memory-related (A1-A5).

## What the code does today (the parts that matter)

- Ghost state: six public fields; private `#hunt` (brain state + `memory`), `#route`, `#lastRequestBody`. Memory (adversary/memory.js): `brain`, `approach{id,current,since_step,tried}`, `tally` (reset on every `brainOn`), `events` (5), `progress`, `latest_action`.
- Perception (adversary/perception.js) takes the real `game`: `floorDistances(game.dungeon, ...)`, `isFloor`, `cellsInView`, `cellKind`. Fog is by convention (`hunt.inSight` guards `game.pos`), not by API.
- Hard-coded temperament, one value for all ghosts: `CHASE_RANGE 7`, `MAX_SEARCH_TICKS 18`, `KEEP_HUNTING_MIN 0.5`, `ALERT_STEPS 24`, `SWEEP_RADIUS 10`, `CUT_MAX 24`, `PACK_ALERT`, `TEAM_SIGHT`, and one shared `game.patrolRand`.
- `team()` already tells every ghost the position and role of **every** packmate, hunting or not.
- `lastSeen` is a single cell; `heading` is frozen at the last sighting; nothing remembers earlier sightings, where sight was lost, or where it hit.
- Request size (measured after the adversary rebuild, stubbed): adversary step avg ~3.9 KB, max ~5.9 KB (was 5.5 / 7.0 KB before it). One Jev call per hunting ghost per step, hedged x2; a step happens on 0.6 of ticks (`ADVERSARY_SPEED`).
- The capability registry (src/capabilities/index.js) is a scaffold with `who: ['explorer'|'adversary']`, `feasible(view, self)`, `actionQuestion(options, contextLine)`. Nothing is registered.

## 1. Character model

### Character vs the explorer's sentiment (and mood)

| | Explorer sentiment | Adversary character |
| --- | --- | --- |
| Question it answers | How scared or bold am I right now, facing this encounter? | What kind of hunter am I? |
| Changes | Re-picked by Jev at every approach decision | Fixed at spawn |
| Axes | One axis (fear to boldness), six points | Five independent traits, three levels each |
| Mechanism | Profile table in code (`min_gap`, `end_ticks`) + `priority` line | Same: `profileOf(traits)` returns numbers + a `priority` line |

The mechanism is shared (code numbers first, a priority line second, so Jev's mood-reading cannot undo it); the tables are not. A ghost faces one situation (hunt), so a per-decision mood pick would cost a Jev call for little gain.

**Transient mood on top: yes, but code-derived, no Jev call** (A3, optional, open question 3). `mood` is one of `steady | frustrated | emboldened`, shifts one trait level for a few ticks, and is shown to Jev as `self.mood`.

| Mood | Trigger | Effect | Lasts |
| --- | --- | --- | --- |
| `frustrated` | 2 hunts ended by timeout in the last 60 ticks | persistence -1, rests 4 ticks before re-hunting | 40 ticks |
| `emboldened` | this ghost landed a hit | aggression +1 (cap 3), `rest` 0 | 12 ticks |
| `steady` | otherwise | none | |

### Traits (levels 1-3, plain words in the state, numbers in code)

| Trait | 1 / 2 (standard) / 3 | Words sent to Jev |
| --- | --- | --- |
| `aggression` | calm / steady / fierce | "hesitant", "steady", "fierce" |
| `persistence` | quick to quit / standard / relentless | "gives up fast", "standard", "relentless" |
| `horizon` | short-term / standard / long-term | "short-term", "standard", "long-term planner" |
| `roaming` | homebody / ranger / rover | "stays home", "ranges", "roams everywhere" |
| `pack` | loner / team / pack | "loner", "team player", "pack hunter" |
| `caution` (reserved) | reckless / standard / careful | dormant until an explorer attack exists (see section 5); analogue of the explorer's `min_gap` |

### Exactly what each trait changes in code

Standard (all 2) reproduces today's numbers. `profileOf(traits)` is one pure function in `src/characters/adversary/character.js`.

| Knob | Trait | 1 | 2 (today) | 3 | Where it bites |
| --- | --- | --- | --- | --- | --- |
| `chaseRange` | aggression | 5 | 7 | 7 | `startsChase` (cannot exceed `SIGHT_RANGE` 7; see AGENTS open issue). |
| `restTicks` after giving up (no new hunt) | aggression | 6 | 3 | 0 | `senseStart`/`senseAfterStep` gate `startsChase`. Brain-off bookkeeping only. |
| chase priority line | aggression | "close only when it is within 5; keep others in front" | today's pincer line | "straight at it: close the path distance first, cut-off second" | `next_move.priorities` while in sight. |
| `maxSearchTicks` | persistence | 10 | 18 | 32 | `senseStart` timeout. Today global; becomes per ghost (settings value is the standard). |
| `keepHuntingMin` | persistence | 0.65 | 0.50 | 0.30 | `keep_hunting.noul` threshold; the `keep_hunting` question gets one persistence line. |
| `sweepRadius` | horizon | 6 | 10 | 14 | `sweepPoint`, `countSwept`. |
| `cutMax` | horizon | 12 | 24 | 36 | `cutOffPoint` candidate window. |
| preferred search approach | horizon | `sweep_last_seen` | none | `cut_off` | Default when Jev's `search_approach` answer is missing, plus a "your nature favours X" clause in that question. Jev may still pick the other. |
| memory capacity and ttl | horizon | see the section 2 table | | | `memory.js` limits per character. |
| `homeRadius` (patrol pool and known home zone) | roaming | 14 path steps | 24 | whole map | `pickPatrolGoal` filters `roomCells` by path distance from home; `AdversaryView` home zone (section 4). |
| patrol goal draws | roaming | unchanged | unchanged | unchanged | **Same number of `rand()` calls per goal**: only the candidate list is filtered. |
| `alertSteps` heard | pack | 8 | 24 | 40 | `alertNearby` reach for this *receiver*. |
| answers calls | pack | no (unless the explorer is within 10 path steps of it) | yes | yes | `alertNearby` skips it. |
| makes calls | pack | no | yes | yes | A loner spotter does not alert others. |
| `teamSight` | pack | off | on | on | `tracksExplorer`. |
| pack priority line | pack | "this is your prey; do not wait for others" | today's pincer sentence | "coordinate: take the route no teammate covers" | `next_move.priorities`. |
| `keepDistance` (reserved) | caution | 0 | 0 | 2 | Dormant. Turns on with the first explorer attack capability. |

Each ghost's priority line is built from the three active pieces (aggression, horizon, pack), at most 300 characters, injected as the third `next_move` priority and into `search_approach`/`keep_hunting`. The character also appears once in state (`self.character`, section 3), in words, never numbers.

### Named characters (presets of trait levels)

Order of columns: aggression, persistence, horizon, roaming, pack.

| Id | A | P | H | R | K | Style (one sentence sent to Jev) |
| --- | --- | --- | --- | --- | --- | --- |
| `standard` | 2 | 2 | 2 | 2 | 2 | A steady hunter. (Exactly today's behaviour; the default when characters are off.) |
| `aggressive` | 3 | 2 | 1 | 2 | 2 | Charges straight at the explorer and does not plan far ahead. |
| `pursuer` | 2 | 3 | 2 | 2 | 2 | Never lets go of a trail until it is stone cold. |
| `ambusher` | 2 | 2 | 3 | 1 | 2 | Predicts where the explorer will pass and waits at the chokepoint. |
| `patient_hunter` | 2 | 3 | 3 | 2 | 3 | Methodical; keeps long memories and works with the pack. |
| `short_sighted` | 2 | 1 | 1 | 2 | 2 | Searches close, forgets quickly, gives up soon. |
| `timid` (the "coward") | 1 | 1 | 1 | 1 | 1 | Only chases what is right next to it, quits quickly, never calls for help. |
| `territorial` | 3 | 2 | 2 | 1 | 1 | Guards its own area fiercely and will not leave it far behind. |
| `rover` | 2 | 1 | 1 | 3 | 2 | Wanders widely; a hunt is a detour. |

"Coward" has no mechanical meaning until ghosts can be hurt, so `timid` is the honest name; a true coward needs the reserved `caution` trait.

### Assignment at spawn (deterministic, rng-safe)

- `assignCharacters(seed, count, mode)` in character.js uses **its own stream**, `rng(seed ^ 0x6a09e667)`, and runs **after** `spawnAdversaries` returns. It never touches `generateDungeon` or `spawnAdversaries` rng, so AGENTS rule 8 holds (same dungeons, same ghost cells for every seed). A check proves it (section 8).
- Mode `mixed`: a shuffled "deck" of the presets (excluding `standard`), drawn in id order a1, a2, ...; a second deck is shuffled when the first runs out. Ghost *i* gets deck[*i*], independent of how many ghosts exist, so changing `maxAdversaries` does not re-roll a1. Mode `standard`: everyone is `standard`.
- Wiring: `new Adversary({ id, pos, character })`; `character` defaults to `standard`, so every hand-built `new Adversary` in the checks keeps working. Stored as a private `#character` with a prototype accessor, like `hunt`, so JSON/`Object.keys` still show six keys (AGENTS rules 4 and 7 of the Adversaries section stay true). It is also copied into `memory.character = { id }` (plain JSON, in `adversaries.json`), and `run.view().adversaries[].character` for the UI (Reveal-only display; the explorer never reads it).
- Overrides:
  - **Testbed:** new key `characters`: `'standard'`, `'mixed'`, one id, or a list (`[ 'ambusher', 'timid' ]`, URL `ambusher;timid`) applied per ghost in id order and cycled. Default `standard`, so every existing testbed scenario is unchanged. Add the row to the AGENTS testbed table, `normalizeConfig`, and `check-testbed.mjs`.
  - **Settings:** toggle `adversaryCharacters` (`when: 'next'`, default off, `mixed` when on). The settings schema supports only range/toggle today; picking one id per game is testbed-only.
- Patrol RNG: today one shared `game.patrolRand`. Territory filtering keeps the call count per goal, but a shared stream still lets one ghost's draws shift the others'. Recommended: one stream per ghost, `rng(seed ^ 0x85ebca6b ^ hash(id))`. This changes patrol routes (not dungeons) for existing seeds; flagged in open question 7.

## 2. Memory model (mirrors the explorer, per ghost)

All of it is plain JSON in `memory.js`, validated, size-capped, written to `adversaries.json`. Units are **world ticks** (ghost memory ages by ticks, the explorer's by steps).

| Field | Content | Notes |
| --- | --- | --- |
| `sightings[]` | `{ cell, tick, heading, source: 'seen' \| 'called', by? }` | Frozen when the explorer was last in sight (own or team-sight/call). A new entry is stored only if the explorer moved at least 3 cells from the previous one, so a long chase is a trail, not spam. Replaces the single `a.lastSeen` for reasoning (`a.lastSeen` stays for the public shape and for the brain-on/off code). |
| `recent` | `{ moves[6], cells[8], back_and_forth }` | Same shape as the explorer. Fixes the ghost ping-pong between `sweep_last_seen` targets; one fact per move: "Returns to the cell you left 2 steps ago." Code policy: 3 ping-pongs while searching force a `search_approach` re-pick. |
| `landmarks[]` | `{ kind, cell, tick, note }` | Kinds: `home` (pinned, like the explorer's chest), `explorer_seen` (first sighting of a hunt), `explorer_lost` (where sight broke), `explorer_hid` (lost within 4 cells and every cell in view then checked: the explorer is in a pocket nearby), `hit_here`, `area_checked` (a swept area with nothing). **`chest` is not a legal kind**: validation throws on it and a twin test scrambles the chest position (section 8). One entry per kind+cell; oldest non-pinned evicted. |
| `tally` | per hunt: `sightings, lost_sight, hits, alerts_heard` | As today (reset in `brainOn`). |
| `lifetime` | `{ hunts, escapes, hits, last_hunt_end_tick }` | New, never reset. `escapes` = a hunt ended by timeout or `keep_hunting`; feeds `frustrated`. Counters never decay. |
| `events[]` | `{ tick, text }`, 5 | As today, but kept across hunts (not cleared by `brainOn`) and aged out by character ttl. |
| `team` (not stored) | read at request time from packmates' own `sightings[0]` and role | No shared mutable board, no new `Game` field. A report is included only if the packmate is within this ghost's hearing (`alertSteps` of its `pack` level) or in its view. Reports carry `source: 'called by aN'`, `ticks_ago`, and a cell only if the cell is routable in this ghost's map. |

### Character-dependent capacity and decay

| Limit | short-term (H1) | standard (H2) | long-term (H3) |
| --- | --- | --- | --- |
| sightings kept | 1 | 3 | 5 |
| sighting ttl (ticks) | 12 | 30 | 60 |
| landmarks cap (incl. pinned `home`) | 3 | 5 | 8 |
| landmark / event ttl (ticks) | 40 | 120 | 300 |
| recent moves / cells | 4 / 6 | 6 / 8 | 6 / 8 |
| seen-cell ttl in the map (section 4) | 40 | 120 | 300 |
| seen-cell cap | 120 | 300 | 600 |

`persistence` does not shorten memory; it changes how long the ghost *acts* on it (`maxSearchTicks`). Decay is applied in perception: an expired entry is dropped when memory is saved, and an age is rendered as `ticks_ago` plus a code-chosen word (`fresh` under a third of ttl, `stale` under two thirds, else `cold`), so Jev never does the arithmetic.

### Shared kit (to avoid copy-paste across the two characters)

Extract pure helpers to `src/characters/shared/memory-kit.js`: `backAndForth`, a ring-buffer push, an `addLandmark` that takes the allowed kinds and the pinned kind, `ageEntries`. The explorer's memory.js keeps its own validation. No explorer-to-adversary imports. The explorer files are no longer being edited, so the extraction can go ahead; keep the explorer's `check-dungeon` and `measure-memory` numbers unchanged by it.

## 3. State sent to Jev

Same grouping as the explorer plan (P2). Keys not new are unchanged.

```text
state = {
  game:     RULES (trimmed ~25%; "You know the whole map" replaced by the fog rule; no objective repeat),
  tick,
  self:     { id, character: { id, traits: { aggression, persistence, horizon, roaming, pack },
                               style }, mood,
              position, mode: 'chase'|'search', approach, latest_action,
              /* A5: inventory, status, cooldowns */ },
  surroundings: { here, exits, nearest_junction_or_doorway, dead_ends_within_5,
                  map_note /* "known: 212 cells, home zone + seen" */ ,
                  landmarks[] /* with direction + path_steps now */ ,
                  items_nearby[] /* A5, known cells only */ },
  explorer: in sight: { in_sight, position, direction, path_steps, heading }
            else:    { in_sight: false, sightings[]: [{ ticks_ago, freshness, direction, path_steps | null,
                                                       heading, source }], trail: "heading east over the last 3 sightings" },
  approach_target, checked_cells_near_last_seen,       // out of sight only, as today
  team:     [{ id, direction, path_steps|null, role, report? }]  // nearest 4 + { others: N }
  recent:   { path: { moves, back_and_forth }, tally, lifetime, events[], progress }
}
```

Rules: numbers only for geometry; character in words; `explorer.position` only while in sight (own or team); `path_steps: null` means "no known route" and brain code never invents one.

### Expected request size

| Part | Today (bytes) | New |
| --- | --- | --- |
| `game` rules | ~1.3 K | ~1.0 K |
| `self` (+character, mood) | ~0.4 K | ~0.8 K |
| `surroundings` (+landmarks, <= 8 x ~110 B) | ~0.25 K | 0.5-1.1 K |
| `explorer` / `last_seen` (+sightings, <= 5 x ~90 B) | ~0.3 K | 0.3-0.7 K |
| `team` (cap 4 + others) | up to ~0.8 K | <= 0.5 K |
| `recent` (+path, lifetime) | ~0.6 K | ~0.8 K |
| options (4 moves) | ~1.0 K | ~1.0 K |
| questions (+character lines) | ~1.1 K | ~1.4 K |
| **Average / max** | **3.9 K / 5.9 K** (the per-part rows above are the old, pre-rebuild split; re-measure before A3) | **~4.6 K / <= 7 K** (old estimate +15%) |

Budget: average <= 5.5 KB, max <= 8 KB (tightened from 7 / 9 KB: the baseline dropped), asserted in `measure-memory`.

### Cost

- Calls are unchanged in kind: one hedged call per brain-on ghost per **step** (0.6 steps per tick). 12 ghosts all hunting is about 7 calls per tick; that worst case does not change with this plan.
- Likely **fewer** calls on average: `timid`/`short_sighted` quit at 10 ticks, calm ghosts rest after giving up, loners ignore calls and make none, a ghost whose only route is unknown is a code move. Expect hunts per game to fall 10-25% with `mixed`; to be measured.
- ~+15% bytes per call (on the new, smaller baseline). Optional lever (open question 5): `maxConcurrentBrains` (e.g. 4); extra hunters follow a code BFS path to the freshest sighting. Not recommended for the first release.

## 4. World knowledge with limits

### Options

| Option | What a ghost knows | Gameplay | Cost | Fog proof |
| --- | --- | --- | --- | --- |
| **A. Full real map** (today) | Everything | Ghost knows every shortcut; hiding works only against sight; `sweep`/`cut_off` are perfect | cheapest (BFS over the real map) | Convention only |
| **B. Territory only** | Cells within a home radius, forever | Ghosts become zone guards; outside, helpless. Hard to tune; a far call is useless | cheap | Easy |
| **C. Hybrid (recommended)**: home zone + seen cells that fade + capped + hearsay from packmates | Home area always; elsewhere only what it has walked past and seen (LOS, <= `SIGHT_RANGE`) until it fades; calls add the caller's nearby known cells | Home ground is deadly, unknown ground is risky for the ghost too; explorer can lead a ghost out of its zone, lose it, and be hunted by the nearest ghost whose zone it entered. Fading makes `short_sighted` visibly worse than `long-term`. | BFS over a smaller set; one LOS sweep per ghost step (~225 supercover lines, same as `cellsInView` today) | Strong: one class, twin-testable |
| **D. Full map, fuzzy explorer info** | Everything, but noisier last-seen | Little change; no fog proof | cheap | Convention |

**Recommendation: C**, shipped behind `limitedMap` (A4), with A1 first proving the `full` mode is byte-identical.

### `AdversaryView` (src/characters/adversary/adversary-view.js)

One per ghost, private `#game` and private `#known`, the only adversary-side file that may hold a `Game` or touch `dungeon.tiles`. Brain and perception code takes a `view`, never a `game` (the physics in adversary.js, touch checks and spawning stay on `Game`).

Reads it exposes (all live, never cached across ticks):

- `pos`, `tick`, `character`
- `isKnown(cell)`, `knownFloor(cell)`, `neighbours(cell)`, `legalMoves()` (neighbours are always known)
- `distancesFrom(cell)`: BFS over the known set only; `null` when a cell is outside it
- `cellsInView()`, `sweep()`: LOS physics, then stamps what it sees
- `explorer()`: `null` unless `seesExplorer` or team sight is true now
- `teammates()`: packmates hunting or within hearing, never their private state
- `frontierToward(cell)`: the known frontier cell nearest (Euclid) to a target outside the map
- `stepCell`, `kindOf(cell)` (room/doorway/junction/corridor/dead end, from known cells only)
- never: `treasure`, the explorer's light/visits/trail/health, real tiles outside `K`

### Fog rules (precise)

The known set `K` of ghost *g* at tick *t* is the union of:

1. **Home `H`**: all floor cells whose real path distance from the ghost's spawn cell is <= `homeRadius` (14 / 24 / whole map by `roaming`), plus the whole spawn room. Computed **once** in the view's constructor (the single read of the real map for geometry); never expires.
2. **Seen `S`**: every floor cell in view (`euclid <= SIGHT_RANGE` and line of sight) from any cell the ghost has stood on, stamped with the tick; a re-sighting refreshes the stamp. A cell not in `H` and unstamped for more than `ttl` (40/120/300 by `horizon`) is forgotten. If `S` exceeds its cap (120/300/600), the oldest stamps are evicted.
3. **Heard `T`**: when a call is received, the receiver adds the **caller's** known floor cells within 6 path steps of the reported cell, stamped now (copied from the caller's `K`, not read from the real map). If no route connects `T` to the receiver's `K`, the target is "no known route" and the brain heads for `frontierToward(target)` ("the edge of what you know, toward the last-seen cell"). Exploring that edge grows `S`.
4. **Neighbours**: the four cells around the ghost are always known (it bumps into walls).

Derived: a wall is known iff it is 8-adjacent to a known floor cell. Anything else is unknown: BFS does not enter it, `cellKind` returns nothing for it, and no text mentions it.

Unchanged and still guarded by `inSight`: the explorer's position is known only while it is seen by this ghost or, with `teamSight`, a hunting packmate; the explorer's light/visits/trail and the treasure are never known. New: unseen packmates are not listed (today every packmate's position and role is sent).

Behaviour consequences to expect and test:
- `sweepPoint`, `cutOffPoint`, `describeMoves` distances run on `K`; an unreachable `last_seen` yields `path_steps: null` and the `frontierToward` target.
- `approach_target.what` says "the edge of what you know" when it is a frontier cell.
- Patrol goals come from rooms inside `K` within `homeRadius` of home (`rover`: any known room); a rover discovers rooms as it goes.

### How twin tests enforce it (mirror of the explorer's)

Build `g` and `g.twin({ ... })` where the twin scrambles everything outside `K_g`: tiles not in `K_g` and not 8-adjacent to it (kept valid: the ghost's immediate neighbours are untouched), the treasure cell, the explorer's position **when not in sight**, positions of packmates not in hearing, and the explorer's `visits`/`trail`. Then require **byte-identical** `lastRequestBody` for that ghost, over: patrol, chase, search, alerted-from-far, and a ghost whose `last_seen` lies outside `K`. Add a monotonic test (a forgotten cell vanishes from the request after `ttl`, an evicted cell stays out) and a "wall outside K never mentioned" scan for coordinates.

Static guard (section 0 of check-dungeon.mjs): `adversary/{perception,brain,memory,character}.js` may import only the allowlist (`DIRS`, `SIGHT_RANGE` constants, `ADVERSARY_SPEED`, sibling files, jev.js, the view) and may not use `game.x`, `.dungeon`, `isFloor`, `floorDistances`, `hasLineOfSight` from dungeon.js. `adversary.js` (physics) and `adversary-view.js` stay exempt.

## 5. Capability compatibility

Everything is built on the existing `src/capabilities` contract; no change to the registry core is needed, two small additions are.

- **Registry use:** `feasibleOptions('adversary', view, self)` with `view = AdversaryView`. Capability `feasible(view, self)` reads only the view (known items, known explorer position only while seen), so fog is the same as for moves. Static guard: `src/capabilities/*` gets the same allowlist as `explorer/*`.
- **Question:** `actionQuestion(options, contextLine)` with `contextLine` = the character's priority line. The `action` Choice rides in the same request as `next_move`; no extra round trip, and a ghost with no feasible option pays nothing.
- **Character to capability (additions):** the character profile carries `prefers[]` and `avoids[]` capability ids, derived from traits, not stored per ghost:
  - `prefers` adds "Your nature favours X" to the `action` question (same mechanism as explorer `prefers`).
  - `avoids` removes the capability from `options` in code (a hard rule, not a suggestion).
  - Traits to capabilities: `aggression 3` prefers `attack`, `sprint`; `aggression 1` avoids `attack` unless cornered (future); `roaming 3` prefers `pick_up`; `horizon 3` prefers `wait`/`set_trap` (the ambusher's "hold the chokepoint": a `wait` capability, since adversaries have no stay move today); `pack 1` avoids `call_for_help`; `caution 3` activates `keepDistance` against an armed explorer.
  - `call_for_help` is today automatic in `alertNearby`; register it as a capability with `who: ['adversary']` when `pack` should be a choice. Until then the `pack` trait already gates it in code.
- **State:** `self.inventory`, `self.status`, `self.cooldowns` and `surroundings.items_nearby` reserved in the shape above; capability facts are character-free (no mood words inside facts, like the explorer's sentiment-free encounter text).
- **Determinism:** capabilities needing chance use the game's seeded RNG; any ghost-side effect applies in id order inside `stepAdversaries` (invariant 6), and `buildRequest` stays synchronous (no `await` before it).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Limited maps make ghosts too weak (or an unreachable `last_seen` makes them wander) | `limitedMap` toggle; A1 proves `full` identical; tune `homeRadius`/ttl with `measure-memory` hit-rate; `frontierToward` gives a direction instead of idling. |
| Jev ignores priority lines (character becomes decoration) | Every trait also moves a code number (section 1). The line only adds colour. Verify live: stubbed A/B plus one paid run per fixture. |
| Breaks AGENTS rule 8 | `assignCharacters` and per-ghost patrol RNG use their own streams; check compares spawn positions with characters on and off. |
| Breaks the six-field `Adversary` shape | `character` and view are private with accessors; check-adversaries keeps the six-key test. |
| Parallel brains: shared view updates race | Views update sequentially before the `Promise.all` decide step, in id order; `buildRequest` stays synchronous. |
| Concurrent edits (explorer/adversary files are moving) | Do A1 first (smallest surface), extract the shared kit with the explorer owner, keep `standard` = today so a mid-merge state is still correct. |
| Request bloat | Caps in section 2/3; asserted budget in measure-memory. |
| `mood` makes behaviour feel erratic | Code-derived, rare, shown in UI and events ("emboldened by a hit"); off by default flag if disliked. |
| Settings page can only show range/toggle | One-toggle default; per-ghost choice is testbed-only; schema extension (select) is out of scope. |

## 7. Open questions for you

1. **Default roster:** when `adversaryCharacters` is on, should every ghost be drawn from the 8 presets, or most `standard` with a few specials (e.g. 1 in 3)?
2. **Visibility:** show the character in the UI (hover chip, Reveal only)? The explorer must never see it (would be a fog leak).
3. **Mood:** code-derived `frustrated`/`emboldened` as in section 1, or none, or Jev-picked (costs a call)? I recommend code-derived.
4. **Map knowledge:** confirm option C and the defaults (home radius 14/24/whole, ttl 40/120/300). Should a far ghost that hears a call get a route (copying the caller's cells) or must it explore toward it? The plan assumes the latter for far ghosts.
5. **Cost cap:** do you want `maxConcurrentBrains`?
6. **Hold/ambush:** the ambusher wants to wait at a chokepoint, which needs a stay move. Build `wait` as the first adversary capability, or leave `ambusher` as "targets cut-off points" only?
7. **Patrol RNG:** OK to move to per-ghost streams (patrol routes change for existing seeds, dungeons do not)?
8. **Caution trait:** will explorers get an attack/weapon capability soon? If not, drop `caution` from the first cut.
9. **Ownership:** AGENTS gives adversary files to the adversary agent, `known-world.js`/dungeon.js to the world agent, `memory.js`/brain.js to the brain agent. The shared kit and the guard extension touch all three; please confirm who does what.
10. **AGENTS.md and CONTRACT.md** need updates in the same change (fog line, `Adversary` private `character`, `AdversaryView` row, testbed `characters` key, new settings toggles).

## 8. Test plan

### Fixtures (`scripts/arenas/`, with the existing corridor, door, explore, open)

| Fixture | Setup | What it shows |
| --- | --- | --- |
| `ambush.json` | Loop of two corridors, `characters: ambusher` vs `standard` | Cut-off target and (with `wait`) holding; re-encounter after `chase_over` |
| `home.json` | Two rooms far apart, one ghost homed in room 1, explorer escapes to room 2 | Home zone vs unknown ground; `frontierToward`; forgetting after ttl |
| `pack.json` | Three ghosts: `patient_hunter`, `timid`, `territorial`; explorer seen by one | Who hears the call, who ignores it, who quits first |
| `charline.json` | Same arena, one fixture per preset | Request-size and giving-up numbers per preset |

### Check scripts (all stubbed, free)

1. **New `scripts/check-characters.mjs`:** `profileOf` snapshot for all presets; `standard` deep-equals today's constants (`chaseRange 7`, `maxSearchTicks 18`, `keepHuntingMin 0.5`, `alertSteps 24`, `sweepRadius 10`, `cutMax 24`); assignment is deterministic, independent of ghost count, independent of dungeon rng (spawn positions identical with characters on and off over 30 seeds); override parsing; priority line <= 300 chars; no preset name or number leaks into facts.
2. **`check-adversaries.mjs` additions:** per-trait behaviour with a stub `decide`: `maxSearchTicks` 10/18/32 switch-off ticks; calm ghost does not start at distance 6; rest ticks after giving up; loner neither alerts nor answers; hearing range; six-key shape; memory validation (landmark `chest` throws, ttl expiry, caps, lifetime counters survive `brainOn`/`brainOff`).
3. **Fog twins** (section 4), one per state above, plus the `limited` monotonic and "no tile outside K mentioned" scans. Existing fog twins keep passing in `full` mode (A1 acceptance: byte-identical request bodies before and after A1 on 10 seeds).
4. **Static guard** extended as in section 4.
5. **`check-testbed.mjs`:** `characters` key (string, list, URL form, bad id throws `TestbedError`), arena returns characters, defaults unchanged.
6. **`check-capabilities.mjs`:** a fake adversary capability through `feasibleOptions('adversary', view, self)` with `prefers`/`avoids`, and an infeasible one that never reaches the request.

### `measure-memory.mjs` (add `--who adversary`, stubbed)

Per fixture and per preset, over N ticks: request bytes (avg/max, budget 7 K/9 K); ticks_hunting per hunt; hunts per 100 ticks; gave-up reason mix (timeout vs `keep_hunting`); hits and ticks to first hit; re-find rate within 8 ticks of losing sight (the memory benefit); ping-pong count; known-map size per ghost and number of cells forgotten (A4); calls per tick (cost). Acceptance for A4: with `standard` characters, hits per game under `limitedMap` between 50% and 110% of `full`, no fixture where a ghost idles more than 5 ticks without a target.

### Live (only when you ask)

One paid run per fixture (about 40 ticks, 1-3 ghosts): compare a `pursuer` and a `short_sighted` ghost on `home.json` and `ambush.json` and read whether Jev's `search_approach`/`keep_hunting` answers differ by character.
