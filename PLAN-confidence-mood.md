# PLAN-confidence-mood: confidence that caps the mood

**Decision.**
- C becomes a mechanical limit. Code builds the sentiment question only from the moods C allows:
  - `wary` is not offered above C 35 unless code can name a real danger.
  - `bold` is not offered below C 40.
- C is redefined as **capability + history**:
  - **Capability** is computed each tick from facts the explorer is allowed to know: lives, sword and stun numbers, the hp bars of ghosts in sight or remembered, and how many ghosts it knows of.
  - **History** is the existing `confidence.js` score. It now shifts C up or down around the capability value.
- The flee problem has a mechanical cause as well as a textual one. The engage hold switches off as soon as a second ghost is in sight. The plan extends it to 2-3 ghosts (the "multi hold"). Measured result: at default settings and 2 lives, a scripted Jev that walks straight into the nearest ghost (the worst case) died in 0 of 783 duels against 2-3 ghosts with hp 1-3. Today's code with the same scripted Jev dies in 0.9-15.6% of those duels.
- Everything sits behind a new setting, `confidenceCaps` (off by default). With it off, requests stay byte-identical.
- Recommendation: switch it on by default only after the paid live run in phase 5, which needs the owner's approval. Free stub runs support it: in 3-5-ghost arenas, hits per game drop from 0.20 to 0.03-0.07 and cleared wins rise from 1 to 40 of 40 games. In real dungeons, dispels rise 27% and coins 12%, with hits per game unchanged.

Code wins over this plan (AGENTS.md rule 3). Not code until the user approves a phase.

## 1. Why the explorer flees from 2+ ghosts today (verified)

| # | Cause | Where | Verdict |
| --- | --- | --- | --- |
| a | Wary's `when` says "Pick when outnumbered (2+ adversaries in sight or remembered)". Steady's says "Never with 2+ adversaries known: that is wary." Bold's says "a lone adversary is the only one known". Every mood text points to wary once a second ghost is known. | `brain.js:66`, `:74`, `:90` | **Confirmed.** Live traces (`runs/motivation/arena-{before,p6,p7}.jsonl`): every decision with 2+ ghosts visible picked wary, 34 of 34, at 0.95-1.00 probability. The tactic chosen was `run_away` in 34 of 34, with engage offered in 33 of them. |
| b | The non-lone tactic priority says "Run away when outnumbered, cramped or without the sword". An invalid tactic answer falls back to `run_away`. | `brain.js:615`, `:689` | Confirmed. |
| c | `#loneFight`, `#stakes`, the "Default: engage" line, `fightFacts`' claw clause (`alone`) and `#fight().only` all require exactly one ghost. | `brain.js:597-616`, `:856-869`, `:459`; `encounter.js:277` | Confirmed. With two ghosts, no text backs a fight. |
| c' | **The hold is off with 2+ ghosts in sight.** | `brain.js:491` (`if (threats.length !== 1) return stop();`) | **Confirmed, and the main mechanical cause.** With today's code, a walk-in Jev against 2-3 ghosts dies at 2 lives in 0.9-15.6% of duels (table 3). |
| d | Wary's `min_gap` is 4 and `run_away` is always feasible. | `brain.js:64`, `perception.js:312` | Contributes. Engage ignores the gap (`perception.js:313`), so the gap is not what blocks fighting. |
| e | Confidence cannot cap anything today. The full model (`confidenceModel`) is off and only shifts `min_gap` and closes engage below 40. The meter (`confidenceMeter`, on by default, `server.js:25`) is display-only. The owner's "DOMINANT" was the display bar: history only, invisible to Jev. | `brain.js:296-307`, `settings.js:20-21` | Confirmed. |

## 2. The model

### 2.1 Capability R (new, pure, in `confidence.js`)

Inputs, all fog-safe (own state, the live skill numbers that `rules()` already states, and hp bars of ghosts in sight or in the brain's frozen sightings):

```
L    = lives left (world.health)            d = clawDamage            Lmax = maxLives
steady = stunHolds(stunTicks, swordCooldown)  (the existing brain.js rule: stun >= 2 and sword cooldown < stun)
armed  = the skill set holds an attack skill (ready or not)
ghosts = visible (weight 1)  +  remembered sightings (weight max(0, 1 - age/30))
hpW(g) = 0.75 + 0.125 * min(5, ceil(hp / swordDamage))        // 1 strike 0.875, 2 strikes 1.0, 3 strikes 1.125
k      = sum over ghosts of weight * hpW
W      = d * 0.5 * max(0, k - 1)    if steady        // worst-case expected lives lost clearing them (measured, table 3)
       = d * 0.5 * k                otherwise          // ASSUMPTION (only swordcd2 follow measured): verified in phase 2
R      = round(100 * (L - W) / (L + 1)), clamped 0..100;  without an attack skill R = min(R, 20)
```

Calibration: W_PER_EXTRA = 0.5 is the measured worst case. A walk-in Jev under the multi hold took 0.31-0.42 lives per 2-ghost fight and 0.41-0.63 per 3-ghost fight at default settings. A fact-following Jev took 0.00-0.04. With no ghost known, k = 0, so R measures the explorer's own strength.

### 2.2 Combining with history

- `H` is the existing `confidence.js` state. Its events and weights are unchanged, it starts at 50 and it keeps its lives cap.
- `h = clamp(H - 50, -30, +30)`
- `C = clamp(R + h, 0, cap(L, Lmax))`, using the existing `cap()`, so the last life is capped at 45.

C at h = 0 (a fresh game), steady, 2-hp ghosts:

| lives left (of max) | 0 or 1 ghost | 2 ghosts | 3 ghosts | 4 ghosts |
| --- | --- | --- | --- | --- |
| 2 (of 2) | 67 sure | 50 even | 33 unsure | 17 shaken |
| 3 (of 3) | 75 sure | 63 even | 50 even | 38 unsure |
| 4 (of 4) | 80 dominant | 70 sure | 60 even | 50 even |
| 1 (of 2) | 45 (cap) | 25 | 0 | 0 |

- Two 1-hp ghosts at 2 lives give 54. Two 3-hp ghosts give 46.
- After one kill (H +18), two ghosts at 2 lives read 68; after two kills, 80.
- The owner's example (two 2-hp ghosts, 4 lives) reads 70, "sure": wary is closed and bold is open.
- Each extra ghost is a soft step of about 17 points at 2 lives and about 10 at 4 lives, not a cliff. A remembered ghost fades linearly over 30 steps.

Start of game: C = R = 67-80, so wary is not offered. In the live traces Jev picked wary at the start trigger in 0 of 15 games and greedy or steady in 15 of 15, so nothing changes in practice.

## 3. Measurements (free, stubbed, scratch scripts outside the repo)

Method:
- A copy of HEAD via `git archive` in the session scratchpad, running the real `ExplorerBrain` through `duel-harness.mjs`.
- The harness was extended with 3 ghosts, a `flee` policy, a fixed mood fallback order and per-claw tick logging.
- Two prototype hold modes were patched into the copy:
  - `multi`: the hold applies when 2-3 ghosts are in sight.
  - `kite`: hold cells must stay 3 or more steps from every other hunting ghost.
- Health was set to 9, so a run is never cut short. **Death at L lives = hits >= L** (claw damage 1). The trajectory up to the L-th hit is identical because the stub and the ghosts ignore lives.
- Layouts:
  - Open room: 24 placements × second ghost offsets N 0..6. Three ghosts come as "pairfront" (two together, one N behind) or "line" (spaced N apart).
  - Corridor: pair N 1..5, line N 1..2, and pincers (a ghost on each side of the explorer).
- 15,444 duels plus 640 games.

### Table 3: default settings (stun 2, sword cooldown 1, claw cooldown 2, speed 0.6, grace 4). Cells show mean claws per run / % of runs with ≥2 hits (death at 2 lives) / % with ≥3 hits (death at 3 lives); "P4" is death at 4 lives.

| ghosts | hp | today's hold, follow | today's hold, walk-in | **multi hold, follow** | **multi hold, walk-in** | kite, walk-in |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1-3 | 0.00 / 0 / 0 | 0.00 / 0 / 0 | 0.00 / 0 / 0 | 0.00 / 0 / 0 | 0 / 0 / 0 |
| 2 | 1 | 0.00 / 0 / 0 | 0.27 / 0 / 0 | 0.00 / 0 / 0 | 0.31 / **0** / 0 | 0.31 / 0 / 0 |
| 2 | 2 | 0.00 / 0 / 0 | 0.39 / 0.9 / 0 | 0.00 / 0 / 0 | 0.37 / **0** / 0 | 0.44 / 0 / 0 |
| 2 | 3 | 0.00 / 0 / 0 | 0.49 / 0.9 / 0 | 0.00 / 0 / 0 | 0.42 / **0** / 0 | 0.71 / 4.4 / 0 |
| 3 | 1 | 0.00 / 0 / 0 | 0.59 / 0 / 0 | 0.04 / 0 / 0 | 0.73 / **0** / 0 | 0.79 / 0 / 0 |
| 3 | 2 | 0.01 / 0 / 0 | 0.84 / 4.1 / 0 | 0.01 / 0 / 0 | 0.57 / **0** / 0 | 1.09 / 9.5 / 0 |
| 3 | 3 | 0.01 / 0 / 0 | 1.04 / 15.6 / 0 | 0.01 / 0 / 0 | 0.56 / **0** / 0 | 1.43 / 17.0 / 2.0 |

- Runs per cell: 25 (1 ghost), 114 (2), 147 (3). Every run cleared all ghosts within 90 ticks.
- P4 = 0 everywhere.
- Kite is worse than multi and is rejected.
- Multi hold with walk-in: at most 2 claws per run and at most 1 hit, because the second claw lands inside the grace window. The 1-hit cases cluster at N = 0-1, where two ghosts arrive together: 62-75% of runs, versus 7-33% at N ≥ 2.

### Table 3b: other settings, multi hold (% of runs with ≥2 hits = death at 2 lives; ≥3 hits = death at 3 lives)

| set | steady? | 2 ghosts, follow | 2 ghosts, walk-in | 3 ghosts, follow | 3 ghosts, walk-in |
| --- | --- | --- | --- | --- | --- |
| stun 1 | no | 0 | 0 | 0 | 0.7-1.4 (hp 2-3) |
| stun 3 | yes | 0 | **2.6** (two claws 5+ ticks apart, after grace ends) | 0 | 1.4 |
| stun 0 | no | 0 | 0 | 0 | 1.4 |
| claw cooldown 1 | yes | 0 | 0 | 0 | 0 |
| speed 1.0 | yes | 0 | 0 | 0 | **3.9** (0.5 die at 3 lives) |
| sword cooldown 2 | no | 0 (18% one hit) | not run | **4.8** | not run |

- For comparison, today's hold with walk-in at stun 1: 5.3 / 34.2% (2 ghosts, hp 2 / 3) and 24.5 / 55.1% (3 ghosts).
- Flee (run_away, closed room, default settings, 520 of 858 runs done): death at 2 lives in 4.1% (2 ghosts) and 9.0% (3 ghosts), worse than fighting with the multi hold. In a closed room, running is not safer.

### Table 3c: whole games, 40 seeds each, 2 lives, stub ghosts that claw, scripted mood and tactic by known-ghost count

| arm | kind | hits/game | games lost | dispels/game | coins/game | wins |
| --- | --- | --- | --- | --- | --- | --- |
| today (wary + run_away at 2+ known), today's hold | dungeon | 0.10 | 0 | 2.73 | 3.88 | 12 |
| fight up to 2 known, multi hold | dungeon | 0.10-0.13 | 0 | 3.38-3.50 | 4.28-4.50 | 13 |
| fight up to 3 / always, multi hold | dungeon | 0.10 | 0 | 3.48-3.50 | 4.35-4.58 | 13 |
| today | crowd (3-5 ghosts, hp 2-3) | 0.20 | 0 | 0.60 | 0.25 | 1 |
| fight up to 3 | crowd | 0.05-0.13 | 0 | 3.48-3.58 | 0.53-0.55 | 35-36 |
| always fight | crowd | 0.03-0.07 | 0 | 4.00 | 0.57-0.63 | 40 |

- Walk-in p = 0 and 0.2 are reported as ranges.
- Dungeons are `newGame` seeds 1-40, 150 ticks. Crowds are 17-21 square arenas.
- Stubs never read text, so this tests code paths, not Jev.

### Coverage

| Status | Cells |
| --- | --- |
| **Measured** | Ghosts 1/2/3 × hp 1/2/3 × lives 2/3/4 (derived from health 9) × {default, stun 1, stun 3} × {today's hold, multi, kite} × {follow, walk-in}. Multi hold under stun 0, speed 1, claw cooldown 1. Sword cooldown 2 follow only (88% complete). Flee default (61%). |
| **Measured in phase 2** (real `ExplorerBrain` with `hold: 'multi'`, `scripts/measure-outnumbered.mjs --coverage`, walk-in = worst case, health 9, a sampled grid: every 4th open placement, offsets 0..6, plus the corridor; results below) | **Reproduction of table 3** (every 2nd open placement, 59 runs for 2 ghosts, 70 for 3; mean claws per run / % runs with ≥2 hits). Multi, walk-in: 2 ghosts hp 1-3: 0.32 / 0.39 / 0.41 claws, 0% (plan 0.31 / 0.37 / 0.42, 0%); 3 ghosts: 0.60 / 0.43 / 0.47, 0% (plan 0.73 / 0.57 / 0.56, 0%). Today's hold, walk-in: 2 ghosts hp 2-3: 1.7% (plan 0.9%); 3 ghosts hp 2 / 3: 5.7% / 14.3% (plan 4.1% / 15.6%). Same shape, small layout differences. **Health-2 spot check** (`check-duels` section 10): 20 runs of today's hold against 3 ghosts, hp 3: the death derived from hits ≥ 2 at health 9 equals the real loss at health 2 in every run (and the real hits are the first two), and at least one run really dies; 10 multi runs at real health 2 all survive and dispel all 3. **Grace 0 and 1** (walk-in, multi, 34 / 43 runs per cell): identical to grace 4 for 2 ghosts (0 deaths at 2 lives, max 1 hit); 3 ghosts hp 3: **1 of 43 runs (2.3%) takes 2 hits** (hp 1-2: 0 of 43). Follow: 0 deaths. **Claw damage 2** (one hit costs 2 lives, so death at 2 lives = any hit): walk-in 2 ghosts 11-14 of 34 runs (32-41%), 3 ghosts 18-24 of 43 (42-56%); follow: 0 of 34 (2 ghosts), 1 of 43 (2.3%, 3 ghosts hp 2-3). Mean lives lost per walk-in run: 0.64-0.82 (2 ghosts), 0.84-1.12 (3 ghosts); W (steady) gives 1.0 and 2.0, so W holds (conservative by about 20-50% for 2 ghosts, 2x for 3). At damage 2 and 2 lives every hit is lethal: the `#fightOn` rule `lives > clawDamage` is false there, so the multi hold is never reached through caps mode; at 3-4 lives the same runs cost 1 life per hit (3 lives survive any single hit). **4 ghosts, multi hold, which does not hold** (26 runs per cell): walk-in dies at 2 lives in 2 / 8 / 12 of 26 runs (hp 1 / 2 / 3), at 3 lives in 0 / 0 / 3 of 26, at 4 lives in 0; hits per run 0.92 / 1.04 / 1.42 against W 1.5 (hp 2, k = 4.0) and 1.75 (hp 3, k = 4.5); follow: 0 / 1 / 1 of 26 hits (4%). So the "usually costs at most one life" claim must not extend to 4, and W is not exceeded. **Remembered ghost proxy** (a second ghost starts out of sight, 9+ cells away, 72 runs per cell, real health 2, multi hold): default settings walk-in: 7 / 8 hits (hp 1 / 2), 0 lost, 0 not cleared; follow: 2 / 2 hits, 0 lost. **Walk-in at sword cooldown 2** (not steady, multi hold): 2 ghosts 0 runs with 2 hits (hits per run 0.53-0.68); 3 ghosts hp 1 / 2 / 3: 2 / 4 / 7 of 43 runs die at 2 lives (4.7% / 9.3% / 16.3%), 0-1 at 3 lives. Follow (sword cooldown 2): 0 deaths for 2 ghosts but 3 / 34 runs do not clear in 90 ticks (hp 2-3), 3 ghosts hp 2 / 3: 2 / 5 deaths at 2 lives, 2 / 8 not cleared. Both stay inside W for non-steady (`0.5·k`: 1.0 and 1.5 against measured 0.53-0.68 and 0.91-0.95) but the death rates say the gate must keep requiring `steady` (as section 5 does). Fresh from this phase: with a not-steady sword the multi hold gives no safety guarantee. |
| **Still not measured** | Lives 1. hp 4-5. Ghosts with the shield in the loadout (sword only). Claw damage 3. 5+ ghosts in duels (only the crowd games). Real Jev behaviour (everything here is a scripted stub). |
| **Inferred** | The hpW slope. That remembered ghosts weigh like visible ones while fresh (the proxy above only shows that an arriving ghost does not break the multi hold). W for non-steady settings (`0.5·k`) is now checked at sword cooldown 2 only: measured lives lost stay below it, but the death rates there are 5-16% with 3 ghosts, so keep `steady` in the `#fightOn` gate. W for steady settings (`0.5·(k-1)`) holds at claw damage 2, grace 0-1 and 4 ghosts. Phase 3 note: with grace 0-1, 3 ghosts of 3 hp the multi hold took 2 hits in 1 of 43 walk-in runs (2.3%), the same order as stun 3's 2.6%, so the stakes sentence's "usually" covers it. |

## 4. Mechanical mood caps

`allowedMoods(C, ctx)` is pure, in `confidence.js`. `ctx = { lastLife, swordDown, noSword, current }`.

| C | wary | steady | greedy | bold |
| --- | --- | --- | --- | --- |
| ≥ 40 | only by exception | yes | yes | yes (if an attack skill is held) |
| 36-39 | only by exception | yes | yes | no |
| 30-35 | yes | yes | yes | no |
| < 30 | yes | yes | no | no |

Constants: `WARY_MAX = 35`, `BOLD_MIN = 40`, `GREEDY_MIN = 30`, `CAP_HYST = 5`.

**Exceptions that always add wary** (dangers code can name):
- `lastLife`: L ≤ clawDamage.
- `noSword`: no attack skill in the set.
- `swordDown`: the sword is not ready and a visible chasing ghost is within 3 known-path steps. At the default sword cooldown of 1 this never fires on a decision tick.

Cornered with no route past is **not** an exception: running does not help there, and table 3b's flee row shows it.

**Rules.**
- **Hysteresis.** The current mood stays in the list while C is within `CAP_HYST` past its threshold: wary up to C 40, bold down to 35, greedy down to 25.
- **One option.** If only one mood is left, code takes it with no Choice. The decision shape records `sentiment: { choice, probabilities: { [id]: 1 } }`, as one-tactic decisions do today. It cannot happen with these thresholds, because steady is always allowed, but the code path must exist.
- **Question text.** The question becomes: "What should the explorer go after right now? Only the moods your confidence allows are listed: …" followed by the ids actually listed. It stays neutral and truthful. The options stay shuffled.
- **When the cap closes the active mood** (C moves past the hysteresis band):
  - With a ghost in sight: set the pending trigger `confidence`. It respects `REDECIDE_COOLDOWN` and fires at most once per encounter per direction. It costs one sentiment call, and the tactic question follows as on any decision tick. `TRIGGER_TEXT.confidence`: "Your confidence changed enough that your mood no longer fits: choose again."
  - With no ghost in sight: code switches the mood to steady silently, with no call. The turn's `policy` says `{ from, to: 'steady', reason: 'confidence <C>' }`. No memory event, so the 6-entry ring is not polluted.

## 5. Text changes (caps mode only; with caps off the text is byte-identical)

| Text | Caps-mode version |
| --- | --- |
| wary `when` (`brain.js:66`) | "Upside: gets you out alive. Risk: gives up coins and progress. Offered only when the odds are poor: low `self.confidence`, your last life, or no sword against a chaser close by." |
| steady `when` (`:74`) | Drop "Never with 2+ adversaries known: that is wary." and "exactly one is in sight". Use: "…or when adversaries are in sight and you would rather keep to the plan than fight them." |
| bold `when` (`:90`) | "Pick when the sword is ready and `self.confidence` is even or better (it already weighs the adversaries you know, their hp and your lives), one adversary or several." |
| bold `priority` | "Engage adversaries you can beat, the nearest first" replaces "a lone or weakened adversary". |
| Tactic priority (`:615`) | "Engage while the sword is ready: hold 2 steps off the nearest adversary so it steps in and you strike first; the slower ones come later. Run away when cramped or without the sword." The word "outnumbered" is removed. Same length within ±20 B. |
| `#loneFight` → `#fightOn(sit)` | Caps mode: sword ready, `steady`, 1-3 visible, every visible ghost at most 3 strikes, C ≥ `BOLD_MIN`, lives > clawDamage. 1 visible keeps today's rule. 2-3 visible additionally need `ADVERSARY_SPEED < 1` with 3 visible (speed 1 measured 3.9%). |
| Stakes sentence (`:866`) | One visible: unchanged. 2-3: "Holding 2 steps off the nearest and striking first, a fight with these adversaries usually costs at most one life; running may leave them hunting you." The claim rests on table 3/3b: multi hold, steady, ≤3 ghosts, worst case ≤2.6%. "Usually" covers stun 3's 2.6%. |
| Default engage line (`:608`) | Gated by `#fightOn` instead of `#loneFight`. With 2-3 ghosts: "Default: engage while the sword is ready (you act first; hold off the nearest)." |
| `fightFacts` claw clause | Unchanged: per adversary, only `alone`. The stakes sentence carries the multi-ghost claim. |
| `self.confidence` | `"<floor C> <band>"` on every request (+23 B). |
| `CONFIDENCE_SENTENCE` | Caps mode: " `self.confidence` weighs your lives, sword and the adversaries you know against how your fights went; it decides which moods are offered." |

**`run_away` stays offered at every C.** The explorer must be able to flee when cornered or when its plan fails, and the guard is that Jev's mood (bold or steady) and the tactic text now favour engage.

**Engage against 2-3 ghosts.**
- Keep `engageTarget` as it is: the cheapest target, the weaker ghost on a tie, which is in practice the nearest first.
- The multi hold does the rest: stay when on the engage target, the nearest hunting unstunned ghost is at gap 2 (or adjacent), and the sword is ready. The `HOLD_MAX` and `HOLD_ADJACENT_MAX` releases are unchanged.
- No kiting. It was measured worse (table 3).

## 6. Switch and defaults

- New setting `confidenceCaps`: Explorer group, toggle, default **false**, `when: 'next'`.
- `server.js` precedence: `confidenceCaps` → `confidence: 'caps'`, else the `confidenceModel` / `confidenceMeter` logic as today.
- In `'caps'` mode:
  - C is the section 2 value.
  - The C3 gap and engage gates are **off**: C4 measured them as inert, and there is one source of truth.
  - The mood caps, the texts above, `self.confidence` and the multi hold (`hold: 'multi'`) are on.
  - The meter shows the new C. `turn.confidence` gains `capability` and `history`.
- **Default recommendation:** keep it off until phase 5 (live, paid, owner approval). Switch it on if the live metrics in section 9 are met. The free evidence (table 3c) favours on.

## 7. Phases

Phases 1 and 2 touch disjoint files and can run **in parallel in two worktrees**. Phases 3, 4 and 5 are sequential, after both.

### Phase 1: pure model (`confidence.js`, `scripts/check-confidence.mjs`)

**Exports:**
- `capability({ lives, maxLives, clawDamage, swordDamage, steady, armed, ghosts: [{ hp, weight }] }) -> R`
- `combine(R, H, lives, maxLives) -> C`
- `allowedMoods(C, { lastLife, swordDown, noSword, current }) -> string[]`, in SENTIMENTS order: wary, steady, greedy, bold.
- `sightWeight(ageSteps)`
- Constants `W_PER_EXTRA = 0.5`, `HIST_SPAN = 30`, `WARY_MAX`, `BOLD_MIN`, `GREEDY_MIN`, `CAP_HYST`, `NO_SWORD_MAX = 20`.

**Checks:**
- The section 2.2 table, exact.
- Monotonicity: more ghosts never raises R; more lives never lowers it.
- Clamps, the 45 cap on the last life, and the caps table with hysteresis.
- Steady is always in the list.
- The exceptions add wary.
- Still no imports, no `Math.random`, no `Date`.

**Bytes:** none.

**Do not:** touch `apply()` or the weights, or `brain.js`.

### Phase 2: multi-ghost hold (`brain.js` `#holding` only, `perception.js` the `holding` flag at about `:629`, `scripts/check-duels.mjs`, `scripts/measure-outnumbered.mjs`)

**Interface:**
- `ExplorerBrain` option `hold: true | 'multi' | false`, default `true` = today.
- `'multi'`:
  - 2-3 visible: hold when the nearest hunting, unstunned ghost is at gap 2 or adjacent, `approachTarget(engage).steps === 0`, and the sword is ready.
  - The same rule applies to the stay fact "Holds this cell, 2 steps from the nearest…" in `describeMoveParts`.
  - 4+ visible: no hold.

**Checks:**
- Add 3 ghosts to the harness (the header says up to the testbed cap).
- Add `health` spot checks at 2: 20 runs where the derived death equals the real loss.
- Reproduce table 3's multi columns at default as asserts: walk-in, 2-3 ghosts, hp 1-3, zero runs with ≥2 hits.
- With `hold: true`, every existing `check-duels` assert is unchanged.

**Verify the section 3 assumptions** and write the numbers in this plan:
- grace 0/1
- claw damage 2
- 4 ghosts
- the remembered proxy
- walk-in at sword cooldown 2

If one breaks W, adjust W in phase 1's constants and the `#fightOn` gate, not the text.

**Bytes:** none (stay facts are the same length).

**Reviewer:** `hold: true` is byte-identical (`check-request-hashes`), and the asserts above.

### Phase 3: wiring (`brain.js`, `memory.js` only if `progress.confidence` gains fields, `src/settings.js`, `server.js`, `scripts/check-confidence-caps.mjs` new, `scripts/request-hashes.mjs` / `check-request-hashes.mjs`)

**Brain** (`confidence: 'caps'`, which implies `hold: 'multi'`):
- `#capC()` computes R from `#seen` (visible weight 1, remembered via `sightWeight`), the live skill numbers and `#cs.value`.
- `#askSentiment` lists only `allowedMoods(...)`. With one mood left, code takes it and makes no call.
- The pending `confidence` trigger and the silent swap (section 4).
- The section 5 texts as templated variants: SENTIMENTS gets `when_caps` / `priority_caps` keys, picked in caps mode only.
- `#fightOn`, the stakes and default-engage variants, `self.confidence`.
- `#C()` returns null for the gaps in caps mode.

**Settings:** the `confidenceCaps` row and the `server.js` precedence.

**Hashes:**
- Off: the existing fixture stays green.
- Caps: a second fixture `scripts/fixtures/request-hashes-caps.json`, written on purpose in its own commit and compared by `check-request-hashes.mjs`.

**`check-confidence-caps.mjs` behaviour matrix:**
- 1/2/3 ghosts × hp 1-3 × lives 2/3/4 × C bands (history forced through the brain's `confidence` arm object) × patrolling vs chasing.
- Assert: the allowed moods, the sentiment option count and exact ids, the tactic menu (`run_away` always present, engage present when armed).
- A scripted Jev at H 80 with 2 ghosts in sight is never offered wary, picks bold, chooses engage and dispels both with no death at 2 lives, using the duel harness with `confidence: 'caps'`.
- Hysteresis: no option flip within ±5.
- The `confidence` trigger fires at most once per encounter.
- A fog twin: a hidden, unseen ghost leaves C and the options identical.

**check-dungeon:**
- The `:1699` assert of 4 options stays for caps off.
- Add a caps-mode run of 4e and assert the bounds 9500 / 10500. Expected about 9001 / 9565 B.

**Reviewer:** off = byte-identical; every "usually / at most" claim is gated exactly as in section 5; no text says "outnumbered" in caps mode.

**Do not:** change `apply()` weights, add text to the tactic request beyond the swapped line, or touch `public/` (the meter reads `turn.confidence`).

### Phase 4: free measurement and docs (`scripts/measure-caps.mjs` new; `AGENTS.md`, `CONTRACT.md`, this plan)

- Port the scratch `arms` script.
- Compare off vs caps with a stub Jev that picks among *offered* moods (bold if offered, else steady, else wary) and engages when its mood is bold or steady. Run over dungeons 1-40 and crowds 1-40, walk-in p 0 / 0.2, lives 2 and 4.
- **Gate:** caps must not raise games lost or hits per game by more than 1 SE, and must raise dispels.
- Record the results here.

### Phase 5: live run (PAID: owner approval required)

`runs/motivation/step-arenas.mjs`, seeds 101-105 plus 5 more, 120 steps, caps on vs the P7 baseline.

## 8. Tests summary

| Script | Asserts |
| --- | --- |
| `check-confidence` (phase 1) | Tables, caps, hysteresis, purity |
| `check-duels` (phase 2) | Multi-hold zero-death envelope; today's hold unchanged |
| `check-confidence-caps` (phase 3) | The behaviour matrix and the DOMINANT-with-2-ghosts scenario |
| `check-request-hashes` | Off fixture; caps fixture |
| `check-dungeon` 4e | Byte bounds in both modes |

## 9. Live-run success metrics (phase 5, vs P7 live: engage 11/16, 4.0 strikes/game, 9 dispels in 5 games, 1 life lost, 0 deaths, wary 3% of steps)

| Metric | Target |
| --- | --- |
| Decisions with 2+ ghosts in sight picking wary at C > 35 | 0 (mechanical) |
| Fights chosen with 2+ ghosts | ≥ 50% of offers |
| Claws per fight | ≤ 0.5 |
| Lives lost per fight | ≤ 0.15 |
| Deaths | 0 in 10 games |
| Wary share of steps | ≤ 10% |
| Dispels per game | ≥ 2.5 |

P7 had only one 2-ghost decision in 5 games, so add 5 seeds or a 2-ghost gym to get about 20 multi-ghost encounters.

## 10. Risks and guards

| Risk | Guard |
| --- | --- |
| Reckless in 12-ghost dungeons | Remembered and visible ghosts lower R: 4 known at 2 lives gives 17, so wary opens and bold closes. Multi hold applies only to ≤3 visible. `run_away` is always offered. |
| Death spiral at low C | Steady is always allowed. The calm drift in H is unchanged. R recovers as soon as sightings expire. |
| Cap thrash | 5-point hysteresis. The trigger is limited to once per encounter per direction with `REDECIDE_COOLDOWN`. The silent swap out of sight costs nothing. |
| Text claims false under odd settings | The `#fightOn` gate (steady, ≤3, speed < 1 with 3). Phase 2 measures the uncovered cells. |
| Bytes | +23 B on the tactic request. The sentiment request shrinks by about 300-600 B per removed mood. |

## 11. Open questions for the owner

1. **"4 HP".** The explorer has lives (setting 1-9, default 2), not HP. The numbers above hold for lives 2-4. At 2 lives, two 2-hp ghosts read "even" (50), not "dominant". At 4 lives they read "sure" (70). It takes kills (history) to reach dominant. Accept, or raise `W_PER_EXTRA` to be bolder?
2. **Three ghosts at 2 lives read 33** (wary allowed, bold closed), although the stubbed games show fighting them is safe. Should 3 ghosts at 2 lives be "even"? That needs `W_PER_EXTRA = 0.35`.
3. **Default on after phase 5**: yes or no.
4. **Phase 5 is paid.**

## Phase 3/4 results (free, stubbed)

Phase 3 is built: `confidence: 'caps'` (or an arm object `{ caps: true, start, wPerExtra }`), setting `confidenceCaps`, `scripts/check-confidence-caps.mjs`, caps request-hash fixture. Worst-case decision tick in caps mode (`check-dungeon` 4e): 9013 B chase / 9577 B patrol (bounds 9500 / 10500 unchanged; the plan expected about 9001 / 9565).

Phase 4 (`scripts/measure-caps.mjs`, stub Jev picks bold if offered, else steady, else wary; engages when bold or steady). Two runs, 3 arms (off, caps W 0.35, caps W 0.5):
- **Full run**: dungeons and crowds, seeds 1-30, p 0 and 0.2, lives 2 and 4, 150 ticks (240 games per arm). Paired caps35 minus off: lost 0.000 +- 0.008 (2 vs 2), hits/game -0.179 +- 0.037, dispels/game -0.013 +- 0.060, coins/game -0.550 +- 0.106, cleared 0.000 +- 0.022. caps50 is the same within noise (hits -0.188, coins -0.558).
- **Reduced run** (seeds 1-12, p 0.2, 120 ticks, 48 games per arm): caps35 lost -0.021 +- 0.021, hits -0.083 +- 0.072, dispels +0.042 +- 0.163, coins -0.646 +- 0.230, cleared 34 vs 31. Gate passes for both W (small sample).
- Wary share is 0% in every arm and request bytes fall (sentiment about 4.95 -> 4.75 KB dungeons, 5.28 -> 5.0 KB crowds; tick request about 5.3 -> 4.7 KB in crowds). The stub takes bold whenever offered, so the off arm is already a maximal fighter: the stub cannot show the plan's flee problem, and "dispels must rise" cannot be shown here (the full run is flat, -0.013 +- 0.06).
- **Open finding**: coins per game fall by about 0.55-0.65 (significant, about 12-20%) in caps mode, with the same cleared wins. Not diagnosed: the multi hold waits in place more, and the stub (which never reads text) is otherwise identical. Look at it before turning caps on.
- **W decision**: keep W_PER_EXTRA 0.35 (the gate holds on the reduced slice; W 0.5 differs only by noise). The sample is small.
