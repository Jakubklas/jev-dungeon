# Plan: monster morale — confidence for the adversaries (2026-10-08)

> **Status: built (M0-M7), 2026-10-08.** Code wins over this plan (AGENTS.md rule 3); AGENTS.md "Monster morale" and CONTRACT.md describe what shipped. Owner's decisions: monsters **may** retreat, but with **less survival instinct** than the explorer, so rout enters at M 12 and leaves at 20 (the explorer panics at 20/25); the other four questions in section 8 went the way this plan recommended.
>
> **Deviations from the plan below, all deliberate:**
> - The `stunned` event is gone. A survived strike is one cause, so it is one event: `wounded` (-10 at full damage share, not -18). With both events and the old weight, a single sword hit routed every standard monster, which would have made the cleared win unreachable.
> - The hp cap is applied by `combine` only, never inside `apply`. Capping the history too would punish a high-baseline character (an `aggressive` monster routed *harder* than a timid one) because the cap and the baseline then subtract twice.
> - Presets keep `caution` at level 2, so `moraleHurt` is wired and configurable but changes no preset's behaviour outside the toggle. Setting `timid` to 3 and `aggressive` to 1 is a one-line change whenever you want it.
> - The morale wording was cut once for bytes before it was accepted (avg 5405 / max 7282 against the 5500 / 8000 bounds).
> - The optional Jev `mood` question (M5) was **not** built: the code-chosen mood already moves every knob and the question would have cost ~400 B of the remaining headroom. The hook to add it later is `moodFor`.
> - M7's UI half is open on purpose: `view().adversaries[].morale` carries the data, but `public/app.js` belongs to the UI agent and was being edited in parallel, so nothing draws it yet.


## Bottom line

Give every monster a **morale score M (0..100)**, the ghost-side twin of the explorer's confidence C: `M = capability + history`, capped by its own hp, started and shaped by its **character**, moved by what actually happens to it (clawed the explorer, got struck, got blocked, heard a packmate dispelled, lost the trail), and read by **code** as a tier that changes real knobs (keep-distance, strike eagerness, how fast it gives up, whether it calls for help, whether it breaks off entirely). A new pure module `src/characters/adversary/morale.js` holds the model; nothing else in the fog chain changes.

**It costs zero extra Jev calls.** The tier is derived by code each tick; the only thing Jev is asked rides in the request the hunting monster already sends (one extra priority line, optionally one extra `mood` Choice applied from the next step). The explorer pays two calls on a decision tick because its mood must precede the tactic question; monsters have no such ordering need, so they must never get a second call. Everything sits behind one new registry toggle, `monsters.morale.enabled`, default **off**, so with it off every monster request stays byte-identical to today's (request-hash baseline intact).

**Needs your OK before M1 (details in [§8](#8-decisions-i-need-from-you)):** whether a monster may **retreat** at all (today it can only hunt or patrol); whether the reserved `caution` trait is finally switched on and written into the presets; and whether **standard** ghosts get morale too (if not, hp still never changes behaviour in the default game).

**One finding worth fixing regardless of this plan:** the monster objective is stale. `adversary/memory.js:33` still says *"Catch the explorer before it finds the treasure."* and `brain.js` `rules()` repeats it, but since the Victory work the explorer wins by **dispelling every monster**. A monster today has no stake in its own survival and no idea it is being hunted back. That gap is the reason morale is now worth building, and it is also why the fix is cheap: `monsters.prompts.objective` is already a P6 text knob.

---

## 1. What the explorer does today, and what the monster does not

### 1a. The explorer's stack

| Layer | File | What it is |
| --- | --- | --- |
| Window | `explorer/known-world.js` | `KnownWorld` — the only fog-safe read of the `Game`. |
| Facts | `known-map.js` → `encounter.js` → `perception.js` | Known state turned into plain-language sentences (approaches, tactic feasibility, situation, per-move facts). Acyclic chain. |
| Memory | `explorer/memory.js` | Plain JSON, validated, written every step: `approach`, `progress`, `sentiment` + `sentiment_history`, `recent`, `encounters`, `events`, `landmarks`. Picked from, never sent verbatim. |
| Score | `explorer/confidence.js` | `C = combine(capability(...), history)`, 0..100, pure, no imports. History events `hit -15 / struck +6 / dispelled +12 / blocked +3 / evaded +4 / pressed -1`, `regen` 0.25 toward 50 after 10 idle ticks, capped by lives (`cap(lives, maxLives)`, last life 45). |
| Mood | `explorer/brain.js` `SENTIMENTS` | 8 moods in 3 tiers (`tierOf`, 5 points hysteresis) plus `panic` (code-entered below C 20, exits at 25). `allowedMoods(C, …)` decides what Jev may even be offered; each mood sets `min_gap` and `end_ticks` **in code**, so it is never just a label. |
| Plan | `brain.js` + `perception.js` | **Approach** = the standing goal (`nearest_frontier`, `collect_coins`, `heal`, `go_to_exit`, …), reviewed every 8 steps with `approach_working` / `next_approach`; **tactic** = the encounter response (`run_away`, `slip_past`, `engage`, `hide`, `race_to_exit`, `carry_on`), which parks the approach and resumes it. |
| Objective | `rules()` | One sentence: clear the dungeon alive, coins are the score, the portal is an early exit. `leave_now` is the one question that can abandon it. |
| Triggers | `brain.js` | `start`, `encounter`, `tactic_failed`, `chase_over`, `exit`, `coins`, `dispelled`, `hit`, `review`, `confidence`, `directive` — merged so one tick costs at most one extra call. |

The pattern that makes it work: **code decides what is possible, Jev decides between the possibilities, memory carries the consequences forward.** A mood that did not move a number in code would be decoration.

### 1b. The monster's stack

| Layer | File | State today |
| --- | --- | --- |
| Window | `adversary/adversary-view.js` | `AdversaryView`, the exact twin of `KnownWorld`. Full or limited map. Fog-safe reads available: `explorer()` (only in sight), `heading()`, `explorerArmed()`, `teammates()` (id, pos, role, freshest called sighting), `teammateCount()`, `seesExplorerFrom()`, distances, known cells. **That list is the complete menu for a capability term** — anything else is a new view read and a new fog decision. |
| Facts | `adversary/perception.js` | Surroundings, explorer/last-seen block, team roles, cut-off and sweep targets, per-move facts incl. "cuts off N of M cells". Good. |
| Memory | `adversary/memory.js` | Already rich: `tally`, `events`, `progress`, `sightings`, `recent`, `landmarks`, `lifetime { hunts, escapes, hits }`, `latest_action`. **But `lifetime` is written and never read back into any decision.** |
| Score | — | **Nothing.** No confidence, no morale, no state that varies with how the fight is going. |
| Mood | — | **Nothing.** PLAN-adversary-memory §1 sketched a code-derived `steady / frustrated / emboldened` mood; it was never built. |
| Character | `adversary/character.js` | 5 traits × 3 levels → `profileOf()` numbers, fixed at spawn, **never changes**. `caution` is declared, reserved and dormant: it only wakes `keepDistance` (`adversary/brain.js:336`) and no preset sets it. |
| Plan | `adversary/brain.js` | Approaches `direct_pursuit`, `cut_off`, `sweep_last_seen`. No review, no tactic layer, no alternative to hunting. |
| Objective | `memory.js:33` | One frozen string, **stale** (see bottom line). |
| Give-up | `keep_hunting` (Noul) + `MAX_SEARCH_TICKS` | The only variable behaviour the monster has, and it is a fixed threshold per character. |

### 1c. The five concrete gaps

1. **Hp does nothing.** A ghost on its last hit point charges exactly like a fresh one; a 4-hp troll is no braver than a 2-hp ghost. `takeHit` (`adversary.js:168`) costs hp, knockback and stun, and changes no decision afterwards.
2. **Being fought does nothing.** `blocked`, `protected`, `bump`, a packmate dispelled next to it — none of it is remembered in a way that bears on the next step.
3. **No survival stake.** The objective says "catch the explorer"; being dispelled is not in the monster's world model at all, although it is now the explorer's win condition.
4. **Character is static.** Two ghosts of the same preset in a 300-tick game behave identically forever. The explorer's personality drifts with its fortunes; the monster's cannot.
5. **One behaviour.** Hunt or patrol. There is no "back off", no "wait for the pack", no "go home and recover".

Morale closes 1-4 directly and opens the door to 5.

---

## 2. The model: morale M

### 2a. Why "morale" and not "confidence"

`confidence` is already two other things on the monster side: `latest_action.confidence` (Jev's own answer confidence, in memory and `brainView`) and `decision.confidence` in the turn shape. A second meaning would be a reading trap in every file. **M is called morale everywhere** — field `morale`, module `morale.js`, registry `monsters.morale.*`.

### 2b. Where it lives

`src/characters/adversary/morale.js`: **pure, imports nothing**, exactly like `explorer/confidence.js`. It is a sibling adversary file, which the static guard's allowlist (`check-dungeon.mjs` section 0b) already permits, so **neither fog guard changes**, the explorer's `confidence.js` is untouched, and `check-confidence` / `check-request-hashes` cannot move.

> Rejected for now: extracting the shared math into `src/characters/shared/confidence-kit.js`. It would save ~80 duplicated lines of clamp/band/tier arithmetic but touches explorer-owned files, the explorer guard allowlist and `check-confidence`'s purity assertion. Worth doing **after** both models have settled, in its own commit, with your OK.

Because the guard forbids importing `skills/*` from adversary files, every live skill number morale needs (explorer sword damage, claw damage, stun, block chance) is **passed in**, the way `cfg.hitDamage` already reaches `rules()` from `adversary.js` (which is guard-exempt). `morale.js` takes numbers, returns numbers.

### 2c. M = capability + history, capped by hp

Mirrors `confidence.js` line for line, with lives → hp.

**Cap.** `cap(hp, maxHp)`: 100 at full hp; `MORALE_LAST_HP_CAP = 40` on the last hit point; otherwise `100 * (0.3 + 0.7 * hp/maxHp)`. A troll at 2 of 4 hp caps at 65; a ghost at 1 of 2 caps at 40 — i.e. a wounded monster can never be in the high tier, which is the whole point of gap 1.

**Capability R** (what this monster can take on right now — all inputs fog-safe and available today):

| Input | Source | Effect |
| --- | --- | --- |
| own hp / maxHp | `a.hp`, `a.maxHp` (private, accessor) | the base term, `100 * hp / (hp + 1)` style, as the explorer's lives term |
| strikes the explorer needs to dispel me | `ceil(hp / swordDamage)`, `swordDamage` passed in from `adversary.js` | more strikes to kill = higher R; a troll reads braver than a ghost without hardcoding either |
| explorer armed | `view.explorerArmed()` | the only "how dangerous is my enemy" read that exists; unarmed → R uncapped, armed → the threat term applies |
| my claw ready | `a.skills` summaries (already in state) | a monster on cooldown is briefly less able |
| packmates hunting nearby | `view.teammates()` roles + path distance | each hunting packmate within the character's alert reach adds `packWeight` (trait `pack`) |
| stunned | `a.stun` | floor R while stunned: it cannot act at all |

**History H** — events, applied once per tick in one fixed phase (see [§4](#4-wiring-order-and-determinism)):

| Event | Δ | Source |
| --- | --- | --- |
| `clawed` — my claw took a life | +8 | `strikeWith` → `noteHit` (`adversary/brain.js:233`) |
| `wounded` — I lost hp to a strike | −18 × (damage / maxHp) × 2, i.e. scaled by the share of my health gone | `Adversary.takeHit` (`adversary.js:168`) |
| `stunned` — struck but survived, lost my turn | −4 | same call, `dispelled: false` |
| `blocked` — my claw was blocked | −5 | `resolveAttack` result `blocked` |
| `shrugged` — my claw hit grace (`protected`) | −2 | `resolveAttack` result `protected` |
| `packmate_lost` — a packmate was dispelled **within sight or hearing** | −15 | new death-cry broadcast, [§3c](#3c-the-death-cry-a-new-fog-safe-channel) |
| `help_came` — a packmate joined my hunt (alert answered / pursuing packmate in view) | +4, ceiling 65 | `alertNearby`, `view.teammates()` |
| `cornered` — the explorer is in sight with few known exits from its cell | +3, ceiling 65 | `perception.js` surroundings, already computed |
| `slipped` — I lost sight of the explorer | −2, at most −8 per hunt | `lostSight` |
| `gave_up` — the hunt ended by timeout or `keep_hunting` | −6 | `switchOff` |
| `regen` | `moraleRegen` toward the character's **baseline** (not a fixed 50), after `REGEN_WAIT` idle ticks | one per tick from `stepAdversaries` |

Ceilings and the per-hunt cap on `slipped` copy the explorer's `BLOCK_CEILING` / `PRESSED_MAX` idiom so a monster cannot farm small pluses into bravery.

`combine(R, H, hp, maxHp) = clamp(R + clamp(H - baseline, -SPAN, +SPAN), 0, cap(hp, maxHp))`, `SPAN = 30`.

### 2d. Tiers, moods and rout

`tierOf(M, prev)` with 5 points of hysteresis, exactly as the explorer's. Thresholds and the tier→mood table are registry rows.

| Tier | Mood | What changes **in code** |
| --- | --- | --- |
| Low (≤ 35) | `skittish` | `keepDistance = 2` (wakes the dormant hook at `adversary/brain.js:336`), strike line = level 1 ("strike only when cornered"), `keepHuntingMin` +0.2, `maxSearchTicks` ×0.6, calls for help even if its `pack` trait says loner |
| | `cagey` | `keepDistance = 1`, prefers `cut_off` over `direct_pursuit` while the explorer is armed, strike line level 1 |
| Mid (36..69) | `stalking` | today's behaviour exactly (this is the identity row: standard ghost, mid tier, morale off ⇒ same numbers) |
| | `pressing` | `chaseRange` +0 but `keepHuntingMin` −0.1, prefers `direct_pursuit` |
| High (≥ 70) | `relentless` | `keepDistance = 0`, strike line level 3 ("strike whenever adjacent and ready"), `keepHuntingMin` −0.2, `maxSearchTicks` ×1.5 |
| | `frenzied` | as above plus: ignores `keep_hunting` below the threshold once (one stubborn extra hunt), closes distance before cut-off |
| Below 20 | `rout` (code-entered, exits at 25; never offered to Jev) | **breaks off** — see [§3b](#3b-rout-the-one-genuinely-new-behaviour) |

Every row moves a number that already exists in `knobsOf()` (`adversary.js:279`) or `profileOf()`. Nothing here is a prompt-only mood.

### 2e. Character sets the baseline — "some more, some less"

New rows in `character.js` `TABLE`, so central-config P2's trait tables tune them for free (`monsters.characters.traits.<knob>`):

| Knob | Trait | L1 | L2 | L3 | Meaning |
| --- | --- | --- | --- | --- | --- |
| `moraleStart` | aggression | 40 | 55 | 70 | where M begins and what regen pulls toward |
| `moraleRegen` | persistence | 0.15 | 0.25 | 0.40 | per quiet tick, after the wait |
| `moraleHurt` | **caution** | 0.6 | 1.0 | 1.6 | multiplier on every negative event |
| `moralePack` | pack | 0.0 | 0.5 | 1.0 | weight of each nearby hunting packmate in R |

So out of the box: `aggressive` (A3) starts at 70 and opens high-tier; `timid` (all 1s) starts at 40, one claw blocked drops it toward rout; `pursuer` (P3) recovers fastest; a troll's 4 hp keeps its cap at 100 for two hits where a ghost is already capped at 40. That is the "depends on character, health, etc." the brief asks for, with no new trait vocabulary.

`moraleHurt` is the first real use of `caution`. It works with every preset at the default level 2 (multiplier 1.0, i.e. no change), so switching it on breaks nothing; giving `timid` caution 3 and `aggressive` caution 1 is a separate, visible choice ([§8](#8-decisions-i-need-from-you)).

---

## 3. What Jev sees, and the one new behaviour

### 3a. Request shape — zero extra calls, ~130 bytes

Added to the hunting monster's **existing** per-step request, only with the toggle on:

- `self.morale: "48 steady"` — floor + band word, the explorer's `self.confidence` idiom (~22 B).
- One priority line in `next_move` from the mood (`MORALE_LINES[mood]`, ≤ 110 B), inserted where the character priority already goes.
- One clause in `keep_hunting` for the low tier ("you are hurt and losing this fight") / high tier (~60 B).
- **Optional (M5, decide later):** a `mood` Choice over the current tier's two moods, folded into the **same** request and applied **from the next step**. One step of lag, zero extra calls. Costs ~400 B, which is what the byte budget below is for. If the measurement says the code-chosen mood is as good, drop it — the explorer needs Jev's mood because it precedes a tactic menu; the monster does not.

**Byte budget.** `measure-memory --who adversary` asserts avg ≤ 5.5 KB, max ≤ 8 KB (measured ~4.6 / 7.3 KB). Morale lines add ~0.13 KB, the optional `mood` question ~0.4 KB → worst case ~7.8 KB, inside the bound but thin. M5 re-measures before the question is kept; if it does not fit, the question goes and the mood stays code-chosen.

**Never sent:** the number M itself beyond the banded word, any hp number of other monsters, any count of packmates beyond what `team` already carries. And in reverse: **monster morale never appears in an explorer request.** The explorer reads a monster's `mode`, `pos` and `hp` bar only, exactly as today.

### 3b. `rout`: the one genuinely new behaviour

Below M 20 a monster stops hunting and gets away. Two ways to express it; **I recommend (A)**:

- **(A) Brain off with a new reason.** `turnOff(a, events, tick, 'routed')` → `mode: 'patrol'`, plus a `restUntil` of ~12 ticks during which `startsChase` cannot fire, and a patrol goal biased toward `a.home`. Honest to the explorer (a patrolling monster is not chasing), reuses every existing path, needs no new mode, and `lifetime.escapes` already counts it. The monster recovers via regen and may come back.
- **(B) A `break_off` approach with the brain on.** Richer (Jev steers the retreat, it keeps calling out sightings), but the monster stays `mode: 'chase'` while it can see the explorer, and **that is a trap**: the explorer's `threats.visible[].chasing` and its own `pressed` confidence event both key off `mode === 'chase'` (`confidence.js:162`). A fleeing monster would wrongly drain the explorer's confidence. (B) would need a new public field or a mode value, and `mode` is public and read by the UI and the explorer — AGENTS "don't add public fields" applies.

Either way `rout` costs Jev calls only while the brain is on, so (A) is also the cheaper one.

### 3c. The death cry: a new fog-safe channel

`packmate_lost` is the strongest event in the table and the one that cannot be read from any existing view method — a dispelled monster is spliced out of `game.adversaries` in `resolve.js` before anyone could look. Build it as the mirror of `alertNearby` (`adversary.js:386`): on a dispel, `stepAdversaries` walks the surviving monsters and applies `packmate_lost` to each whose path distance to the death cell is within its `alertSteps`, **or** which had line of sight to it. Same reach rule as a call for help, so no new fog surface, and the twin test is the same shape as the pack-alert one.

### 3d. The stale objective

With the toggle on, `monsters.prompts.objective` becomes: *"Catch the explorer before it escapes — and survive. It carries a sword and wins by dispelling every one of us."* That is true, it is what makes morale legible to Jev, and it is already a text knob (central-config P6), so it is a YAML default change plus the built-in string, not new code. With the toggle off, the old string stands and requests stay byte-identical.

---

## 4. Wiring: order and determinism

Three hard constraints, all from existing invariants:

1. **One fixed phase, id order.** Morale events are applied in a single new pass inside `stepAdversaries`, after the bump checks and `senseStart` and **before** budgets and the parallel Jev calls, iterating `order` (already `sort(byId)`). The explorer's strike resolves in `playTurn` *before* `stepAdversaries`, so a `wounded` monster already reads its new hp on the same tick it decides. Nothing is applied inside the parallel `decide()` fan-out, where completion order is not deterministic.
2. **No rng.** Morale is a pure function of own state + view reads. No `rand()` call is added anywhere, so AGENTS rule 8 (seeds are deterministic) holds and no dungeon, prop, coin or spawn stream moves.
3. **Six public keys.** M lives in the private hunt state (`newHunt`, `brain.js:74`) like `profile` and `probabilities`, mirrored into `memory.morale` for `adversaries.json` and the UI. `Adversary` gains no public field.

**Memory shape.** `memory.morale = { value, baseline, tier, mood, counts: { clawed, wounded, blocked, lost }, since_tick }`, created in `createMemory`, checked by `validateMemory` (which is strict and throws), with `LIMITS.moraleMood = 32`. It **persists across hunts** like `lifetime` — `brainOn` must not reset it, or a monster forgets it was nearly killed. Morale is nulled in the memory when the toggle is off, so the written JSON shape stays stable for the UI.

---

## 5. Phases

Each phase is free (no Jev), ends with a passing check, and leaves the toggle off.

| Phase | What | Check (all free) | Gate to pass |
| --- | --- | --- | --- |
| **M0** | Fix the stale objective text + a short AGENTS/CONTRACT note. No model yet. | `check-config`, `check-request-hashes` (text knob off ⇒ unchanged) | hashes unchanged |
| **M1** | `morale.js`: cap, capability, combine, apply, tiers, rout, bands, `configureMorale` + snapshot. Pure, no imports. | **new** `check-morale.mjs`: cap table, clamps, ceilings, per-hunt caps, regen toward baseline, tier hysteresis, rout enter/exit, JSON round-trip, purity, determinism | mirrors `check-confidence.mjs` section for section |
| **M2** | Registry rows (`monsters.morale.*`, trait rows, tier→mood table), toggle `monsters.morale.enabled` default off, `when: 'next'` | `check-config` | every default equals the module literal |
| **M3** | Wiring: hunt state, memory field + validation, the event phase in `stepAdversaries`, the death cry, `knobsOf()` reading the mood | **new** `check-morale-wiring.mjs` (real `Adversary` + `stepAdversaries` with a stub `decide`): each event fires from the real path, hp cap bites, order is id-deterministic, death cry respects reach, morale survives `brainOn`, memory validates | toggle off ⇒ `check-adversaries` + `check-request-hashes` byte-identical |
| **M4** | Request text: `self.morale`, mood priority line, `keep_hunting` clause | `check-adversaries` fog twins extended: **a twin that scrambles the hidden explorer, hidden packmates and out-of-K tiles must produce a byte-identical request** — morale must derive only from own state + view | fog twin green; `measure-memory --who adversary` within 5.5 / 8 KB |
| **M5** | `rout` (option A) + the optional Jev `mood` question | `check-testbed` scenario: 1-hp ghost + armed explorer ⇒ routs, does not re-chase for `restUntil`, returns later. Testbed knob `ghostMorale` (start override) added per AGENTS rule 10 | explorer requests unchanged (the routed monster reads as `patrol`, which is true) |
| **M6** | Measurement: **new** `measure-morale.mjs` (stubbed, free) over generated dungeons and crowd arenas — tier distribution over time, hunts per 100 ticks, hits, dispels, routs, calls per tick, request bytes per character and kind | — | tiers all reachable (the lesson from PLAN-moods §3: a model whose extreme tiers never fire is decoration); calls/tick unchanged vs today |
| **M7** | UI + docs: morale pip / tint on a Reveal-ed monster, mood in the pane, AGENTS.md + CONTRACT.md updated to match the code | `check-moods-ui`-style pool check | — |

**A paid live run (`--live`) happens only if you ask for it**, and only after M6 is green.

### Commit order
M0 → M1+M2 → M3 → M4 → M5 → M6 → M7, each its own commit; the request-hash fixture is **not** regenerated unless M4 changes toggle-off text (it should not).

---

## 6. What this does not do

- **No monster tactic layer.** No `slip_past` / `hide` equivalent, no approach review, no `leave_now`. Morale re-weights the hunt it already has; a second decision layer would be a second request.
- **No per-monster objective switch.** Territorial monsters still hunt rather than guard; that is PLAN-adversary-memory's unbuilt `mood` layer territory and can sit on top of morale later.
- **No learning across games.** M resets at spawn like everything else.
- **No new fog surface** beyond the death cry, which reuses the pack-alert reach.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Monsters that retreat make the cleared win too easy | M6 measures hits-per-100-ticks and explorer win rate against today's numbers before the toggle is recommended on; `rout` threshold and `restUntil` are registry knobs |
| Request size creeps over 8 KB | M4 and M6 both assert; the `mood` question is the first thing dropped |
| The mood is prompt-only and changes nothing | Every row in §2d moves a knob in `knobsOf()`; the wiring check asserts the knob, not the text |
| Explorer confidence skewed by a fleeing monster reading as `chase` | Option (A) for rout: the monster goes to `patrol`, so `mode` stays honest |
| Hidden state leaks into a request | M4's fog twin is the gate; morale reads only `a.hp/stun/skills` and `AdversaryView` |

---

## 8. Decisions I need from you

1. **May monsters retreat at all?** It is the biggest behaviour change in the plan and it changes the feel of the game (and probably the win rate). Yes → `rout` via option (A). No → morale still shapes keep-distance, strike eagerness and give-up speed, which is most of the value; drop M5's first half.
2. **Switch `caution` on?** `moraleHurt` needs it. Minimal version: every preset stays at level 2 (no behaviour change, the knob simply exists). Fuller version: `timid` → 3, `aggressive` → 1, which changes those presets' trait words in requests (toggle-gated, so hashes-off is safe).
3. **Standard ghosts included?** `limitedMap` requires `adversaryCharacters`; morale need not. I recommend **independent** — otherwise hp never changes behaviour in the default game, which was gap 1. The cost is that a standard ghost's request text changes when the toggle is on (acceptable: that is what the toggle is for).
4. **Does a monster see the explorer's health bar?** Today it does not (`explorerArmed()` is the only read of the explorer's condition). Adding "the explorer is hurt" to capability would make monsters press a wounded explorer — symmetric with the explorer reading monster hp, and a genuinely better hunter. It is a new fog read and your call.
5. **Keep the Jev `mood` question (M5), or leave the mood to code?** Code-only is free and deterministic; the question is ~400 B and gives Jev a say in the monster's stance. I lean to building it, measuring it in M6, and keeping it only if it changes behaviour.
