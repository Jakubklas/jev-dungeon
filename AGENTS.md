# AGENTS.md: Jev Dungeon

Guide for AI coding agents (and humans) about to change this game. Full API signatures live in [CONTRACT.md](CONTRACT.md); this file tells you how not to break things and where the contract has drifted from the code.

## Read this first

1. **Fog of war is a hard rule.** Jev may only receive *known* (lit) cells and adversaries the explorer can *see right now*. Never use `dungeon.tiles`, `dungeon.rooms`, `dungeon.treasure`, `floorCount`, `isFloor` or `floorDistances` in explorer perception. The check scripts run "twin" tests that scramble hidden state and require byte-identical Jev input.
2. **Jev calls cost money. In the game only `POST /api/step` makes them.** Each step makes one explorer call (two on a decision tick: sentiment, then tactic + move), unless the move is forced, plus one call per hunting adversary. Every call is hedged ×2 and retried. The other paid path is `node scripts/run-testbed.mjs --live`. Page load, `GET /api/state`, `POST /api/new`, every `scripts/check-*.mjs` and `run-testbed.mjs` without `--live` are free. Don't press Start, hit `/api/step` or pass `--live` to "test" something unless the user asked for a live run.
3. **Code values beat CONTRACT.md numbers** (CONTRACT.md:138). Don't "fix" code back to a number written in the contract. See [Known drift](#known-drift-between-contractmd-and-code).
4. **Never JSON-clone a `Game`.** `game.litOutside` is a `Set`, and cloning breaks `isKnown` near the map edge.
5. **New files in `public/` must be registered in `server.js` `STATIC`** (server.js:13-18). Anything not listed there returns 404.
6. **A touch is damage, not an instant loss.** An adversary on the explorer's cell costs one life (`hit` event); the game is lost only at 0 lives (`hit` then `caught`). At most one hit per tick, then `GRACE_TICKS` of protection and a knockback. See [Damage](#damage-hits-grace-knockback). Don't reintroduce an instant loss in a new code path.
7. **Don't hand-edit `memory.json`, `memory.md` or `adversaries.json`.** They are runtime output, rewritten every step.
8. **Seeds are deterministic.** Adding, removing or reordering `rng()` calls in `generateDungeon` or `spawnAdversaries` changes every seed's dungeon. `SPAWN_STEPS` (dungeon.js) mirrors `MIN_SPAWN_STEPS` (adversary.js), so change them together.
9. **Only edit files your role owns** (CONTRACT.md:26; [table below](#repo-map--ownership)). There is no git here, so back up a file before a risky edit.
10. **Test explorer behaviour in the testbed, not in a full dungeon.** `src/testbed.js` builds a small configured arena (size, adversaries, props, chest, or an ASCII map). Use it for any test of how the explorer reacts, and **extend it when your test needs a new knob**: add the option to `DEFAULTS` + `normalizeConfig`, a check in `scripts/check-testbed.mjs`, and a row in [Testbed](#testbed-small-test-arenas). Don't hand-build one-off arenas elsewhere. `dungeon.treasure` **may be `null`** in a testbed arena, so guard any new code that reads it.

## Overview

Jev, a paid decision API at TypeSafe (`api.typesafe.ai/v1/systemone`), steers a knight through a procedurally generated grid dungeon one cell per tick, looking for a treasure chest. Every visited cell permanently lights everything within `LIGHT_RADIUS`, and lit cells are the explorer's known territory. Grey ghost adversaries patrol. When one sees the explorer it switches on its own Jev brain and hunts. A ghost that reaches the explorer's cell costs it one of its 2 lives; the game is lost when the last life goes and won when the explorer steps on the chest. The browser shows an isometric 8-bit view. The Node server holds a single game in memory and makes every Jev call. The API key never reaches the browser.

## Run & verify

| What | How |
| --- | --- |
| Node | ≥ 20.12, needed for `process.loadEnvFile`. Zero dependencies, ES modules. |
| Start | `npm start` or `node server.js` from `dungeon-game/` |
| Port | `PORT` env or **3003** (server.js:12) |
| Secrets | `../.env` (`/Users/jakub/jev-playground/.env`, shared with sibling projects). The server throws at startup if `JEV_API_KEY` is missing. Never print the file. |
| Syntax | `node --check <file>` |
| World checks | `node scripts/check-dungeon.mjs`: generation, LOS, fog twins, threat sentences, scripted follower, tactic twins. Takes about 18 s, no Jev. `--measure` adds timings (see drift). |
| Adversary checks | `node scripts/check-adversaries.mjs`: speed, spawning, chase and damage (hit, grace, knockback, one hit per tick), search/brain-off, parallel brains, fog twins. Uses a stub Jev via `setDecider`. Prints walker stats, which are informational only. |
| Testbed checks | `node scripts/check-testbed.mjs`: config parsing and validation, arena shape, determinism, props, adversary placement, ASCII maps, then ~25 stubbed ticks per scenario (incl. a fully lit, chest-less arena). Under 1 s, no Jev. |
| Testbed runner | `node scripts/run-testbed.mjs --size 9x9 --numAdversaries 2 --props few --ticks 30`: plays an arena in the terminal and prints each tick's move, decision trigger, sentiment, tactic, sightings and events, plus an ASCII map after decisions. Any testbed option works as `--<option> <value>`, `--map <file>` reads ASCII rows, `--quiet` drops the maps. **Dry run with stub answers by default (free). `--live` calls the real Jev and costs money.** Memory goes to a temp dir. |
| Testbed server | `PORT=3001 TESTBED='size=9x9&numAdversaries=2&props=few' node server.js`: every new game (page load, Reload, `/api/new` without a body) is that arena. `TESTBED` takes the URL-query form or a JSON object and is validated at startup. Convention: the normal game on **3000**, the testbed on **3001**. |
| Testbed in the browser | `http://localhost:3003/?testbed&size=9x9&numAdversaries=2&props=few&treasure=far&seed=3`. Same keys as the config; `map` rows are split by `/` (URL-encode `#` as `%23`). Page load stays free; Start still costs Jev calls. |
| Visual check | Headless Chrome, e.g. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=out.png --window-size=1400,900 http://localhost:3003`, or playwright-core installed in a scratch dir. For an explored state, use a scratch server that serves `public/` and a game simulated with `applyMove`, with no Jev. |

- **Restarting the server loses the game.** It lives in module memory (`game`, `memory`, `busy`). After a restart, `GET /api/state` returns `game: null` until `POST /api/new`. The page does that on load, and it is free.
- Static files are read from disk on every request, so UI edits need only a browser refresh. Edits to `server.js` or `src/` need a restart.
- The check scripts exit 1 on failure and print `FAIL:` lines. There is no test framework and no `npm test`.

## Repo map & ownership

| File(s) | Purpose | Owner |
| --- | --- | --- |
| `server.js`, `package.json` | HTTP server, static whitelist, single game | UI agent (testbed change: `/api/new` parses `{ testbed }`) |
| `public/index.html`, `public/app.js`, `public/style.css` | Step loop, iso renderer, pane, minimap | UI agent (testbed change: `?testbed` query in `api`/`init`, chest guards in renderer and minimap) |
| `public/sprites.js` | Pixel-art knight, ghost, chest | sprites agent |
| `src/dungeon.js`, `scripts/check-dungeon.mjs` | Map gen, lighting, movement, LOS, `publicView` | world agent (testbed change: `applyMove` treats a `null` treasure as no win) |
| `src/characters/explorer/perception.js` | Known state → plain-language facts for Jev | world agent (testbed change: `seenTreasureCell` returns `null` for a `null` treasure) |
| `src/characters/explorer/brain.js`, `memory.js`, `src/jev.js` | Explorer decisions, memory, Jev client | brain agent (v3: "stay unchanged"; the damage change touched only `RULES` and added `noteHit`, by user request) |
| `src/turn.js`, `src/characters/adversary/*` (`adversary.js`, `brain.js`, `memory.js`, `perception.js`), `scripts/check-adversaries.mjs` | World tick, adversary state machine and Jev brains | adversary(-brain) agent (testbed change: `turn.js` gained `startGame` (shared by `newGame`/`newTestGame`), `newTestGame`, `playTurn`'s optional `dir`, and `view().testbed`) |
| `src/testbed.js`, `scripts/check-testbed.mjs`, `scripts/run-testbed.mjs` | Small configurable test arenas for explorer behaviour | shared: any agent may add options it needs (keep the checks passing) |
| `memory.json`, `memory.md`, `adversaries.json` | Runtime output | nobody (generated) |

## Conventions

- **Cells** are `[x, y]`, with x from 0 to `width-1` and y from 0 to `height-1`. **y points down.** `tiles[y][x]` is `'#'` or `'.'`. Cell keys are `` `${x},${y}` ``.
- **`DIRS`** = `{ up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }` (dungeon.js:13).
- **Map size varies per level.** Always use `dungeon.width`/`dungeon.height`; there are no size constants.
- **One tick** is the explorer's step, then the adversaries' moves. The explorer moves first, and a win on its step ends the tick before the adversaries move.
- **Code style:**
  - ES modules with named exports, `node:` import prefixes, `.js` on relative imports, `.mjs` for scripts.
  - 2-space indent, single quotes, semicolons.
  - camelCase functions, UPPER_SNAKE constants, snake_case keys in shapes sent to Jev or the browser (`explored_pct`, `known_floor_cells`).
  - Each file opens with a `//` header comment on its purpose. Inline comments explain *why*.
  - British vs US spelling is mixed (`neighbour`, `colour`, `centre`/`center`). Match the surrounding file.

## World & perception

**`src/dungeon.js`** (no Jev knowledge)
- Constants: `LIGHT_RADIUS = 7`, `SIGHT_RANGE = 7`, `MIN_SIZE = 25`, `MAX_SIZE = 90`, `ROOM_MIN = 4`, `ROOM_MAX = 15` (dungeon.js:4-9).
- Generation:
  - Width and height are each drawn independently from the seed.
  - Room count is `max(4, round(area/290))`, placed by rejection with a wall gap between rooms.
  - L-shaped corridors join the rooms via a Prim MST, plus about n/4 loop corridors.
  - The outer ring is always wall. The start is a random room centre.
  - The treasure is a room cell at BFS distance ≥ 60% of the farthest reachable cell.
  - It retries on the same PRNG stream if constraints fail.
- Lighting:
  - Every cell within Euclidean `LIGHT_RADIUS` of a visited cell gets brightness `round((1 - d/(R+1))*100)/100`. Line of sight is not needed.
  - Brightness only ever goes up. `light > 0` means known.
  - With R = 7 the range is **0.13 to 1.0**.
- Off-map cells that get lit go into `game.litOutside` and count as known wall. That keeps the map edge indistinguishable from rock, which is intentional.
- Line of sight: `hasLineOfSight` walks a supercover line between cell centres, with endpoints ordered so the result is symmetric. It uses the real tiles. Any `'#'` strictly between the endpoints blocks, and a line through a corner needs both side cells open. **Sight** = LOS and Euclidean distance ≤ `SIGHT_RANGE`.
- `Game` also has `health` / `maxHealth` (`EXPLORER_LIVES = 2`). `damageExplorer(game, amount, sourceId)` takes lives off, is a no-op once won or lost, and sets `lost` and `caughtBy` only when health reaches 0; it returns `{ health, lost }`. `publicView` (and so `view`) sends `health` and `max_health`; the pane draws them as hearts. Defaults are applied with `??=` next to `lost`/`caughtBy`.
- `Game` adds `knownFloor` and `litOutside` beyond the contract's shape. `applyMove` returns `{ moved, revealed, revisit, won }` and is a no-op once won or lost.
- `publicView` sends the full `tiles` to the browser, for the debug Reveal toggle only. The renderer must still hide them; see [Server & UI](#server--ui).

**`src/characters/explorer/perception.js`**: the only source of text Jev reads about the world.
- `APPROACHES` (each with `text` and a first-person `thought` ≤ 60 chars for the UI bubble):
  - Exploration: `nearest_frontier` (default), `largest_unexplored`, `far_side`, `go_to_treasure` (only once the chest is known). `availableApproaches` lists only these.
  - Encounter **tactics** (`tactic: true`, `TACTICS`, `isTactic`): `slip_past`, `run_away` (the old `escape`), `face_off`, `hide`, `race_to_chest` (chest seen), `carry_on` (every visible adversary patrolling).
- `situation(game)` returns `{ steps, lives, hit_protection_steps, known_floor_cells, here, treasure, unexplored_by_direction, frontier_cells, threats[], encounter }`.
  - `known_floor_cells` is a **count**, not a percentage, because a percentage would leak the map size.
  - Unexplored amounts use a fixed 12-cell window and fixed bins, independent of map size.
  - `encounter` is `null` unless an adversary is visible. Otherwise it holds **sentiment-free** sentences: `space` (open room W×H with known ways out, corridor, junction or dead end), `adversaries`, `gap_now` (number), `speed` (from `ADVERSARY_SPEED`), `slip_past` (best route past and its closest approach), `hide`, `run_away`, `dead_ends`, and `chest` (only once seen).
- Encounter model (all over known floor and visible adversaries only):
  - After the explorer's `i` steps, an adversary may have taken `ceil(i·ADVERSARY_SPEED)` steps. The predicted gap at a cell is its known-path distance from the adversary (Euclidean fallback) minus that.
  - `safeDistances(minGap)` is a BFS that only enters cells keeping that gap. The chest may always be entered, since stepping onto it wins.
  - `routeSurvey` runs it for gaps 6..1. The largest gap at which a goal is still reachable is that route's closest approach.
  - A slip goal is a frontier cell (or the seen chest) within 60° of the adversary's bearing and at least as far away as the adversary.
  - A hide cell is within 10 steps and out of `knownLineOfSight`, a copy of the supercover walk in which **unknown cells block**.
  - `face_off` needs an open area (2×2 known-floor flood fill) with both sides ≥ 5 and the current gap ≥ the minimum.
- `tacticFeasibility(game, minGap)` returns `{ id: { target, fact } }` for the feasible tactics only. `tacticOptions` turns that into Choice criteria. `run_away` is always feasible while anything is visible.
- `approachTarget(game, id, { minGap, goal })`: `goal` keeps a tactic's earlier target cell while it is still reachable at the gap, so `slip_past` doesn't lose its goal once its own light reveals it.
- `describeMoves(game, approachId, { minGap, goal })` returns one sentence per legal move: threats (with "below your minimum gap of N" when it applies), chest, reveal estimate, visits, approach progress, dead-end and cornered warnings.
- Distances to adversaries use a BFS over known floor when the adversary's cell is known; otherwise rounded Euclidean.
- Determinism: tie-breaks are steps, then `(y, x)`. Keep them.
- Performance:
  - BFS uses flat `Int32Array`s, and `describeMoves` runs several of them per call.
  - A decision tick runs about 6 gap-limited BFS per minimum gap. That is a few ms on 90×90 maps.
  - Don't add full-grid scans per candidate move.
- `check-dungeon.mjs` covers this with twin tests (encounter facts plus tactic options and targets for the aggressive and scared gaps, with hidden tiles and hidden adversaries scrambled), hand-built slip/corridor/blocked-exit/hide maps, and a stub-Jev brain run (`setAsker`, `setMemoryDir`). It now takes about 18 s.

## Adversaries & the tick

**Spawning** (`spawnAdversaries`):
- Seeded by `rng(seed ^ 0x9e3779b9)`.
- Count is `clamp(round(floorCells/700), 1, 8)`.
- Adversaries spawn on room floor at path distance ≥ 20 from the start and outside the start's sight, spread round-robin across rooms.
- Shape: `{ id: 'a1', pos, mode: 'patrol', budget: 0, lastSeen: null, goal: null }`.
- Patrol routes and the per-game patrol RNG (`seed ^ 0x85ebca6b`) live in WeakMaps so the object keeps its contracted shape. **Don't add fields to it.**

**Constants** (adversary.js:14-20): `ADVERSARY_SPEED = 0.5` (one step per 2 ticks), `CHASE_RANGE = 7`, `MAX_SEARCH_TICKS = 12`, `HIT_DAMAGE = 1`, `GRACE_TICKS = 4`. `KEEP_HUNTING_MIN` lives in `adversary/brain.js`.

**Sight vs chase:**
- `seesExplorer` = Euclidean ≤ `SIGHT_RANGE` + LOS.
- `startsChase` = `seesExplorer && distance <= CHASE_RANGE`.
- They are kept as separate functions and constants on purpose; see [Open questions](#open-questions--known-issues).

**Modes:**
- `patrol`: brain off, code wander, no Jev.
- `chase`: brain on, explorer in sight.
- `search`: brain on, no sight.

**Transitions:**
- `startsChase` emits `spotted` then `brain_on`.
- While the brain is on, sensing flips the adversary between chase and search (`spotted` / `lost_sight`).
- The brain switches off (`brain_off` with `reason`, back to patrol) in either of two cases:
  - more than 12 ticks pass without sight;
  - Jev's `keep_hunting` answer comes back below `KEEP_HUNTING_MIN`.
- **No `gave_up` event is ever emitted.**

**Adversary fog of war:**
- Adversaries know the real map.
- They know the explorer's position only while `seesExplorer` is true. Otherwise they know `last_seen` only.
- They never know the treasure or what the explorer has explored.

### Damage (hits, grace, knockback)

Decided for the damage model (agent 2). Code: `touchCheck`, `knockBack`, `graceLeft` in adversary.js; `damageExplorer` in dungeon.js.
- **Touch = hit.** An adversary on the explorer's cell (it stepped in, or the explorer stepped onto it) calls `damageExplorer(game, HIT_DAMAGE, a.id)` and emits `{ id, type: 'hit', at, health }` (health after the hit). Only the life-ending hit also emits `{ id, type: 'caught', at }`, right after its `hit`, and `stepAdversaries` returns at once. Patrolling (brain-off) ghosts hit too.
- **One hit per tick.** Grace is read once at the start of `stepAdversaries` (`protectedNow`) and a per-call `touch.hit` latch blocks any second hit in the same tick, whether two ghosts step in, or two already share the explorer's cell.
- **Grace.** A hit sets `game.graceTicks = GRACE_TICKS` (4). Each `stepAdversaries` call starts by reading and then decrementing it, so the next 4 ticks cannot hurt; the 5th can. A ghost needs `1/ADVERSARY_SPEED = 2` ticks per step, so a standing explorer is hit again 6 ticks later (asserted in the check). `graceTicks` is a game field (defaulted with `??= 0` in turn.js and the check scripts); `graceLeft(game)` reads it. There is no per-adversary cooldown, so no WeakMap is needed for it.
- **Knockback.** Any adversary on a living explorer's cell after a touch check is moved off it, so a ghost never ends a tick inside the explorer: the hitter, and during grace any ghost that touches it (it is only bounced, no event). An adversary that just stepped in goes back to the cell it came from; one found there before moving (the explorer stepped in) goes to the first floor neighbour in `DIRS` order that is not the explorer's cell, preferring one that is not the explorer's previous trail cell; boxed in, it stays. Knockback sets `budget = 0` (no step, and no Jev call, straight after) and clears the patrol route. No `rng()` is used.
- **Known consequence.** A brain-on adversary next to the explorer still takes the forced move onto its cell during grace (`adversary/brain.js` code policy) and is bounced every time it steps; the first such step after grace is a hit. That is intended: standing next to a ghost is not safe.
- **Explorer text.** `RULES` says a touch costs one life, gives `EXPLORER_LIVES` and `GRACE_TICKS`. `situation.lives` (= `game.health`) and `situation.hit_protection_steps` (= `graceLeft`) are the explorer's own state, so fog-safe (twins share them through `...game`). The step-into move fact starts `Steps into the adversary:` and says "costs 1 life (N of M left) and it is knocked back", "costs your last life and the game is lost", or "no life lost while your hit protection lasts" during grace. A non-lethal hit adds a memory finding via `brain.noteHit` (turn.js); the lethal one keeps `noteCaught`.
- **Adversary text.** Adversary `rules` and the "Steps onto the explorer" move fact say it hits (a life), not that it wins. `danger` in explorer memory is not reset on a hit.

**`stepAdversaries(game)` order** (adversary.js, `stepAdversaries`). These invariants are easy to break:
1. Return immediately if the game is won or lost. Read grace (`protectedNow`), then decrement `game.graceTicks`.
2. Sort adversaries by id and run the touch check for each **before anything moves**. This catches the explorer stepping into one. Only a lethal hit returns early; a non-lethal hit lets the tick go on.
3. Advance the tick counter and run `senseStart` for each.
4. Add `ADVERSARY_SPEED` to every budget. An adversary moves at most one step per tick.
5. Adversaries with `budget >= 1` and the brain on call Jev **in parallel**, all from the same post-explorer snapshot.
6. Apply steps **in id order**. A failed Jev call falls back to a code BFS move with `console.warn`. Brain-off adversaries take a patrol step. Run the touch check after each step (knockback to the previous cell). Two adversaries may share a cell, but never the living explorer's.
7. Return `{ events, turns }`.

**`src/turn.js`:**
- `newGame(seed?)` generates, creates and spawns. It costs no Jev calls.
- `playTurn` runs the explorer's `takeTurn`, then `stepAdversaries`, then `saveMemories(..., DIR)` (writes `adversaries.json`), then `brain.noteCaught` if the game was newly lost, else `brain.noteHit` if a `hit` event fired.
- The `brain` import is a namespace import on purpose.
- `view(game)` sends the **full** adversary list, each as `{ id, pos, mode, visible, brain }`, plus `grace_ticks` and `invulnerable` (grace > 0). The UI hides adversaries that aren't visible unless Reveal is on.

## Explorer brain, memory & Jev client

**`src/jev.js`:**
- `askJev(state, questions)` POSTs `{ model: 'jev-latest', state, questions }` with a Bearer key and returns `answers`.
- Each request is **hedged**: `HEDGE = 2` identical copies race and the first answer wins.
- Each copy retries up to `RETRIES = 3` times on 429, 529 or network errors, with a 20 s timeout per attempt.
- One logical call can therefore bill several times.

**`brain.js` `takeTurn`** (v4):
- **Ordinary tick:** with exactly one legal move, the move is **forced** and no Jev call is made. Otherwise it makes **one** request with `state = { game: RULES, memory, situation }`.
  - Option order is shuffled every tick, because Jev leans toward the first option.
  - An illegal choice falls back to `legal[0]`.
- **Decision tick** (an approach decision). It makes one extra request, **first and in sequence**:
  1. `sentiment` (Choice). It sees memory, situation and the sentiment-free `situation.encounter`. Each option states the circumstances that call for it, its effect, and, while an adversary is in sight, which tactics its `min_gap` leaves open here.
  2. The normal tick request, with the new sentiment already in memory. While an adversary is in sight it adds `tactic` (Choice over the feasible tactics only) plus a **speculative** `move_if_<tactic>` per option, each judged on that tactic's move facts. The move taken is the answer for the chosen tactic, so the move on the decision tick already follows it. With one feasible tactic, code takes it and asks no Choice.
- **Triggers:**
  - `start`: the first tick.
  - `encounter`: an adversary is in sight with no tactic on, an id not seen in this encounter appears, or a visible one goes patrol→chase.
  - `tactic_failed`: the tactic's target is gone, or (except for `run_away`) the gap fell below `min_gap`. At most once every `REDECIDE_COOLDOWN = 3` ticks.
  - `chase_over`: nothing in sight for the sentiment's `end_ticks`. The parked approach resumes.
  - `chest`: the chest was spotted.
  - `review`: a review switched the approach. The sentiment is asked on the next tick, so it is only paid for when the approach really changed.
  - A trigger without an adversary in sight waits through forced ticks.
- **Sentiments** (`SENTIMENTS`, read from `memory.sentiment.id` every tick). Each profile changes behaviour in code:
  - `min_gap`: tactic feasibility and targets, the gap warning in move facts, and `tactic_failed`.
  - `end_ticks`: the encounter end.
  - `priority`: a line in `next_move` and in the `tactic` question.

  | id | min_gap | end_ticks |
  | --- | --- | --- |
  | scared | 5 | 6 |
  | risk_averse | 4 | 5 |
  | cautious (default before the first pick) | 3 | 4 |
  | calculated | 3 | 3 |
  | courageous | 2 | 2 |
  | aggressive | 2 | 1 |
- `next_move` priorities:
  1. Step onto the chest.
  2. Only while threats are visible: never step into one, avoid moves below `min_gap`, plus the current tactic's move hint (e.g. `run_away` keeps the distance growing; `slip_past` may move toward it while the gap holds).
  3. The sentiment's priority line.
  4. Follow the approach.
  5. Reveal new cells.
  6. Avoid backtracking.
- Approach reviews:
  - They run every `REVIEW_EVERY = 8` steps, and only once 8 steps have passed on the current approach.
  - They are skipped during `go_to_treasure` and any tactic.
  - A review adds `approach_working` (Noul) and `next_approach` (Choice over exploration approaches) **to the same request**.
  - The approach switches only if `approach_working < APPROACH_FAILING (0.5)`.
- Code policies:
  - Once the chest is known, switch to `go_to_treasure`; mid-encounter it replaces the parked approach instead.
  - Tactics park the exploration approach with `interruptApproach`. Switching from one tactic to another keeps the parked approach. **Tactics never go into `tried`.**
- **Turn shape:** `{ step, dir, forced, revealed, won, move_decision, decision, review, policy, apiMs }`.
  - `move_decision` = `{ choice, probabilities, confidence, options } | null` (renamed from the old `decision`).
  - `decision` = `null | { trigger, sentiment: { choice, probabilities }, tactic: { choice, probabilities, options } | null, apiMs }`.
  - `apiMs` covers both requests.
- **Request helpers:** `lastRequest()` returns the latest request; `lastRequests()` returns both requests of a decision tick. `setAsker(fn)` stubs Jev and `setMemoryDir(url)` redirects the memory files; both are for the checks.
- `RULES` derives "1 step for every 2 of the explorer's" from `ADVERSARY_SPEED` (`speedPhrase`), so it follows the constant.
- **Cost:** a decision tick costs 2 requests instead of 1. Each encounter costs about 2 decision ticks (`encounter` and `chase_over`), plus `tactic_failed` re-decisions (≤ 1 per 3 ticks). On top of that come one `start` decision per game and one per chest sighting or review switch.

**`memory.js`:**
- Shape: `{ objective, approach { id, current, thought, since_step, tried[], interrupted }, findings[{ fact, step }], progress {…}, latest_action, danger { status: 'safe'|'chased', since_step, adversaries_seen }, sentiment { id, since_step, profile_note }, sentiment_history[{ id, step }] }`.
- `approach.thought` is ≤ 60 chars and set for every approach. On resume it is looked up by id.
- `sentiment.since_step` moves only when the mood changes. `sentiment_history` keeps the last 5 picks.
- `saveMemory` validates the shape (and throws if it's wrong), then writes `memory.json` (the source of truth, also sent verbatim to Jev as `state.memory`) and `memory.md` (rendering only, never read back).
- It runs at the end of every `takeTurn` and in `noteCaught` / `noteHit`.
- **Any new memory field reaches Jev, so it must be fog-safe** and fit the validation limits: findings 12, tried 5, fact 200 chars, thought 60, profile_note 200, sentiment_history 5.
- The revisit window lives in a WeakMap, so it never reaches Jev or disk. The same goes for the brain's encounter bookkeeping and tactic goals.

## Testbed (small test arenas)

`src/testbed.js` builds a tiny arena instead of a generated dungeon, so explorer reactions (to adversaries, cover, corridors, open space) can be watched in isolation. `buildArena(config)` returns `{ dungeon, adversaries, config }`; `turn.js` `newTestGame(config)` turns it into `{ game, memory }` through the same `startGame` as `newGame`, so both start from identical state. It costs no Jev calls.

**Config** (all optional; JSON values or URL-query strings, coerced and validated by `normalizeConfig`):

| Key | Default | Meaning / validation |
| --- | --- | --- |
| `size` | `[11, 11]` | Interior floor `[w, h]`, `"WxH"` or one number; each side 3..60. The map is `(w+2)×(h+2)` with a wall ring, so floor is x 1..w, y 1..h. |
| `seed` | `1` | Drives prop and adversary placement and the patrol RNG. Same config → same arena. |
| `start` | `'center'` | `[x, y]` / `"x,y"` (wall ring included in coordinates) or `'center'`. Must be inside floor. |
| `treasure` | `null` | `null`/`'none'` (no chest: the game only ends when caught), `'far'` (a floor cell farthest from the start by path), or `[x, y]`. Must be reachable. |
| `numAdversaries` | `1` | 0..8, placed at random on floor at least `minAdversaryGap` steps (path) from the start, never on the chest. |
| `adversaries` | `null` | Explicit cells `[[x, y], …]` (URL: `"x,y;x,y"`); overrides `numAdversaries`. |
| `minAdversaryGap` | `4` | Minimum path distance for random adversaries (≥ 1). |
| `adversariesInSight` | `null` | `true`/`false` restricts random adversaries to cells the start can / can't see (`SIGHT_RANGE` + LOS). `null` = either. |
| `props` | `'none'` | `'none'`, `'few'`, `'many'` (random 1-3 cell solid clusters plus small props; never next to the start or chest, never cutting floor off), or an explicit list `[{ kind, x, y, flip? }]` of `SOLID_KINDS`/`SMALL_KINDS`. Presets are ignored when `map` is given. |
| `map` | `null` | ASCII rows (array, or one string split by newlines or `/`) overriding `size`, `start` and the shape: `#` wall, `.` floor, `@` start (required), `T` chest, `A` adversary, `p` solid prop, `s` small prop. Border must be wall; rows equal length; 5..62 per side. `A` cells override `numAdversaries`; with no `T`, `treasure` still applies. |

Unknown keys, bad values and impossible placements throw `TestbedError` with a readable message (the server answers **400**).

**How a testbed arena differs from a dungeon** (expect these when reading results):
- Arenas up to 9×9 with a centred start are **fully lit at step 0** (`LIGHT_RADIUS = 7`), and the default 11×11 leaves only its corners dark: little or no frontier, nothing to explore, and a placed chest is usually seen at once, so the explorer goes straight to `go_to_treasure`. To test reactions to adversaries, leave `treasure` out, or hide the chest out of light with a `map` (e.g. at the end of a corridor longer than 7).
- `rooms` is one room over the whole inside, so patrols wander the whole arena. `decor` is always empty. `dungeon.testbed` is `true`, and `view` sends `testbed: true`.
- Adversaries use the contracted shape and start in `patrol`; they do not go through `spawnAdversaries` (its 20-step / out-of-sight rule can't hold in a small room).
- `generateDungeon` and its `rng()` order are untouched; the testbed uses its own stream (`seed ^ 0x51ed27a3`).

**Adding an option:** add it to `DEFAULTS`, parse and validate it in `normalizeConfig` (accept URL strings too), apply it in `buildArena`, cover it in `check-testbed.mjs`, and add a row to the table above.

## Server & UI

**Server** (`server.js`):
- Routes:
  - `GET /`, `/app.js`, `/style.css`, `/sprites.js` (the `STATIC` whitelist).
  - `GET /api/state` → `{ game: view|null, memory }`.
  - `POST /api/new` → `{ game, memory }`. It waits for any in-flight step. An optional body `{ testbed: {...} }` builds a [testbed arena](#testbed-small-test-arenas) instead; a bad config returns **400** with the reason, a non-JSON body 400.
  - `POST /api/step` → `{ game, memory, turn }`. Returns **409** for no game, game over, or a step already running, and 502 if the turn throws.
- `.env` is loaded *before* the dynamic `import('./src/turn.js')`. Keep that order.

**Step loop** (`public/app.js`):
- `init` never auto-starts, so a page load costs nothing. With `?testbed…` in the URL, `init` and Reload always `POST /api/new` with the query as the testbed config (so the page shows that arena, not the server's current game).
- The chest may be absent (`game.treasure === null`) in a testbed arena; the renderer and minimap skip it.
- One `loop()` runs at a time. `epoch` is captured per request and bumped by Reload, and stale answers are dropped.
- A 409 on a finished game ends the loop quietly. Any other failure pauses with a message.

**Isometric renderer** (v3 look):
- Projection:
  - `TW = 32`, `TH = 16` art px.
  - `isoX = (x - y)·16`, `isoY = (x + y)·8`, measured at the cell centre (x+.5, y+.5).
  - Walls are `WALL_H = 11` px raised blocks: a lit top, a medium left face and a darker right face.
- Pixel look:
  - Everything draws into a low-res offscreen buffer, blitted at integer scale `S` with smoothing off.
  - `resizeBoard` must re-set `imageSmoothingEnabled`, because every resize resets it.
  - The camera snaps to whole art pixels.
- Depth:
  - Pass A draws the flats: floors, fog glow, trail.
  - Pass B walks the diagonals `d = x + y`, drawing walls and then the entities at that depth.
  - While an entity moves, its depth is the larger of the from and to cells. Ties draw chest, then ghost, then knight.
- Culling is by diagonal (`d = x + y`, `e = x - y`), padded for wall and sprite height.
- Tiles are pre-rendered once into caches (`floors[band][variant]`, `walls[band][cap][mask]`, `fogTiles`), so each frame is only `drawImage` calls.
- Palette:
  - Known cells map `light` to 8 bands, from cold navy at the lit edge to warm amber where the knight walked (`bandOf`, app.js:92). `bandOf` assumes `light` runs 0.2 to 1 and clamps lower values; see [Known drift](#known-drift-between-contractmd-and-code).
  - Unknown cells get a flat navy-to-black glow by distance (1-5) to the nearest known cell. `computeFog` runs an 8-way BFS over **`light` only** and is recomputed per view, not per frame.
  - **Never draw unknown walls or read `tiles` for unknown cells unless Reveal is on.** `wallShown` treats an unknown cell in front as not hiding a face, so no gaps leak the layout.
- Reveal map (debug) draws unknown floors, walls, the chest and ghosts at `REVEAL_ALPHA = .42`.
- Easing: newly lit cells fade in through `shown[][]` over `FADE_MS = 300` ms.
- Sprites (`public/sprites.js`):
  - `buildSprites()` returns `{ knight, ghost, chest }`, each `{ canvas, w, h, anchorX, anchorY, frames? }`.
  - Art faces right, at 1 canvas px per art px. The anchor is the point on the cell centre: the feet, or the hover point under the ghost.
  - Knight 18×24 with anchor (9,23); ghost 18×20 with anchor (9,19); chest 12×10 with anchor (6,9).
  - `export const ART` holds the raw grids.
  - `app.js` imports the module dynamically with stand-in fallbacks, so a broken `sprites.js` only shows placeholder shapes and a console warning.
- **Facing rule:**
  - Facing is the sign of the change in `x - y` (screen x).
  - Moving `right` or `up` faces right; `left` or `down` faces left.
  - With no movement, the character keeps its last facing.
  - Facing is tracked per adversary id, plus `'@'` for the explorer, and resets only on Reload (`syncActors(true)`).
  - Mirroring is `scale(-1,1)` around `anchorX`.
- Entities tween over 150 ms with smoothstep. A ghost that jumped more than one cell, or wasn't drawn last time, snaps instead of streaking.
- Damage: a `hit` event logs "a1 hit Jev — 1 life left" (red, `li.hit`) and flashes the board red (`.board-wrap.hit::after`, 450 ms). While `game.invulnerable` the knight blinks (`BLINK_MS = 120`). The overlay text for the final loss is unchanged.
- Ghosts bob 2 px over 1.6 s and cast a floor shadow. A chasing ghost has a red pulsing glow, and a ghost with its brain on shows a cyan marker.
- The minimap stays top-down, is rebuilt only when `miniDirty` is set, and draws the rotated viewport outline.
- Theme:
  - Dark only: navy/stone with an amber accent, square corners, hard shadows, monospace font.
  - Two columns (board + 340 px pane). Below 860 px the board is 70dvh and the page scrolls.

## Known drift between CONTRACT.md and code

The code is the source of truth in every row.

| Topic | CONTRACT.md says | Code does |
| --- | --- | --- |
| Adversary speed | :138 "`ADVERSARY_SPEED` is now 0.65" | **0.5** (adversary.js:14). Contract :37/:66, the check script and `RULES` all say 0.5. The :138 note is stale. |
| Light radius | 4 (:5, :43) | **7** (dungeon.js:4) |
| Map size | 35..150 (:33, :43, :61, :152) | **25..90** (dungeon.js:6-7) |
| Adversary events | `spotted \| lost_sight \| gave_up \| caught` (:78) | `spotted`, `lost_sight`, `hit`, `caught`, `brain_on`, `brain_off`. `gave_up` is never emitted. `caught` now follows only the life-ending `hit`. |
| Catch = loss | Reaching the explorer's cell loses the game | It costs one life (`EXPLORER_LIVES = 2`); see [Damage](#damage-hits-grace-knockback). |
| UI graphics | v2 text: ~18 px square cells, "red circles" (:113-116) | Isometric pixel art per the v3 Look section (:118) |
| Wall height | ~0.6 tile | `WALL_H 11 / TH 16` ≈ 0.69 |
| Old import paths | :26 says `check-dungeon.mjs`/`server.js` still import old paths | Already fixed |
| `check-dungeon --measure` | n/a | Still uses `seedsOfSize(140,150)` and labels "~150x150" (check-dungeon.mjs:387). With `MAX_SIZE = 90` no seed qualifies, so the large-map timing is empty or may break. The minimum-size test uses 35×35, not 25×25. Not yet run. |
| Treasure | Always a cell `[x, y]` | `null` in a testbed arena with no chest. `applyMove`, perception and the renderer guard it. |
| Renderer light floor | Palette spec: navy at light 0.2 | With `LIGHT_RADIUS = 7`, light goes down to 0.13. `bandOf` clamps everything below 0.2 into the coldest band, so the outer ring of each light pool looks flat. |

## Open questions & known issues

- **Chase trigger.** The user wrote "line of sight … and at least 7 steps away"; the code builds "within 7" pending confirmation. The flip is one operator in `startsChase` (adversary.js:84). Because `seesExplorer` already caps distance at `SIGHT_RANGE = 7`, an "at least 7" trigger also needs a larger `SIGHT_RANGE`.
- **Reveal toggle doesn't resync actors.** It only sets `miniDirty` (app.js:1033). A ghost revealed mid-game can tween (streak) across the fog on the next step instead of snapping.
- **Mid-tween occlusion.** If a new view arrives mid-tween, the walking knight can briefly draw over a wall in front of it.
- **Trail dots** are hard to see on the amber floor. Reveal-mode unknown walls look slightly too bright.
- **Stale runtime files.** `memory.json`/`memory.md` and `adversaries.json` (tick 530) are left from a past lost run (`danger` still `chased`). `noteCaught` doesn't reset `danger`. They are overwritten on the next step.
- **Encounter tactics (v4).** `escape` was renamed `run_away`. CONTRACT.md v2 sections still say `escape`. `run_away` never fails by gap, so a chaser that stays in sight triggers no re-decision. `carry_on` is effectively unreachable while `CHASE_RANGE == SIGHT_RANGE`.
- **Walker stats.** Even the `flee` policy in `check-adversaries.mjs` is often caught or times out. The stats are informational, not asserted, and useful for tuning speed and ranges.
