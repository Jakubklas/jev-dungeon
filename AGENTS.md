# AGENTS.md: Jev Dungeon

Guide for AI coding agents (and humans) about to change this game. Full API signatures live in [CONTRACT.md](CONTRACT.md); this file tells you how not to break things. CONTRACT.md was brought in line with the code after the memory redesign (explorer and adversary memory, settings, capability scaffold).

## Architecture

One game is a `Run` (src/turn.js). The explorer sees the world only through a `KnownWorld`; adversaries read the real `Game`. Jev calls are injected, so every check runs without the network.

| Class | File | Role |
| --- | --- | --- |
| `Game` | `src/dungeon.js` | One game's state (position, lighting, lives, grace, adversaries) and its rules: `applyMove`, `damage`, `isKnown`, `knownTile`, `legalMoves`, `availableMoves`, `knownFloorCount`, `exploredPct`, `publicView`, `twin`. Public fields on purpose: the checks set them. |
| `KnownWorld` | `src/characters/explorer/known-world.js` | The explorer's only window on a `Game` (private `#game`): own state, lit cells, adversaries in sight, the chest once lit, and `move(dir)`. All explorer perception, brain and memory code takes a `world`, never a `game`. |
| `ExplorerBrain` | `src/characters/explorer/brain.js` | One explorer: plain-JSON `memory` plus private bookkeeping, `takeTurn()`, `noteHit()`, `noteCaught()`. Built as `new ExplorerBrain(world, { ask, memoryDir })`. |
| `Adversary` | `src/characters/adversary/adversary.js` | One ghost. Six public fields (`id, pos, mode, budget, lastSeen, goal`); hunt state, patrol route and last request body are private, behind accessors. |
| `Run` | `src/turn.js` | One game in progress: `run.game`, `run.explorer`, `run.memory`, `await run.playTurn()`, `run.view()`, `await run.persist()` (writes the opening memory files; `server.js` calls it for every new game, the checks do not). Made by `newGame(seed, opts)` / `newTestGame(config, opts)`. |

Explorer modules form a chain: `known-map.js` (pure known-floor helpers) ← `encounter.js` (encounter model) ← `perception.js` (approaches, tactic options, situation, move facts) ← `brain.js`. No file in the chain imports a later one, so keep it acyclic.

`opts = { ask, decide, dir, memoryDir }` (all optional). `ask` replaces the explorer's Jev call, `decide` the adversaries', `memoryDir` is where `memory.json`/`memory.md` go, `dir` where `adversaries.json` goes. Omitting `ask` or `decide` means the real, paid Jev.

## Read this first

1. **Fog of war is a hard rule.** Jev may only receive *known* (lit) cells, adversaries the explorer can *see right now*, and (user-approved amendment) adversaries it **saw earlier, frozen at the moment of sighting** (`threats.remembered`). The brain records a sighting only from `visibleAdversaries()`, never moves it, and drops it after `REMEMBER_STEPS = 30` steps or as soon as the explorer stands within `SIGHT_RANGE` of the frozen cell with a known line of sight to it while that id is not visible (the cell is seen empty). A remembered sighting never reveals where an adversary is now. Explorer code (`src/characters/explorer/*` except `known-world.js`) reads the game only through `KnownWorld`: never hold a `Game`, never touch `dungeon.tiles`, `dungeon.rooms`, `dungeon.treasure`, `floorCount`, `isFloor` or `floorDistances`. A **static guard** (section 0 of `check-dungeon.mjs`) fails on `game.x`, `game[...]`, `.dungeon`, dynamic or namespace imports, and any import outside its allowlist (`DIRS`, `LIGHT_RADIUS`, `STAY`, `EXPLORER_LIVES`, `SIGHT_RANGE` from dungeon.js; `ADVERSARY_SPEED`, `GRACE_TICKS` from adversary.js; sibling explorer files; jev.js). If you need a new read, add it to `KnownWorld` and make sure it is fog-safe. The checks also run "twin" tests that scramble hidden state and require byte-identical Jev input; the remembered-sighting twins move a hidden adversary after the sighting and require the same request.
2. **Jev calls cost money. In the game only `POST /api/step` makes them.** Each step makes one explorer call (two on a decision tick: sentiment, then tactic + move), unless the move is forced, plus one call per hunting adversary. Every call is hedged ×2 and retried. The other paid paths are `node scripts/run-testbed.mjs --live` and `node scripts/measure-memory.mjs --live`. Page load, `GET /api/state`, `POST /api/new`, every `scripts/check-*.mjs`, `run-testbed.mjs` and `measure-memory.mjs` without `--live` are free. Don't press Start, hit `/api/step` or pass `--live` to "test" something unless the user asked for a live run. In code, a `Run`, `ExplorerBrain` or `stepAdversaries` call **without an injected `ask` / `decide` is a paid path**: always pass stubs in scripts (the `check-*.mjs` scripts and the dry runs of `measure-memory.mjs` also replace `globalThis.fetch` with a throwing tripwire, so a miss fails instead of billing).
3. **Code beats the docs.** CONTRACT.md matches the code today. If you find a difference, the code is right: fix the doc, don't "fix" code back to a number written there.
4. **Never JSON-clone or spread a `Game`.** `game.litOutside` is a `Set`, and the methods live on the prototype, so a clone breaks `isKnown` near the map edge. For a modified copy (twin tests) use `game.twin(overrides)`, a shallow copy that keeps the prototype and shares whatever you don't override. The same goes for an `Adversary`: its hunt state is private, so only `new Adversary({...})` makes a working one.
5. **New files in `public/` must be registered in `server.js` `STATIC`** (server.js:23-32). Anything not listed there returns 404.
6. **A touch is damage, not an instant loss.** An adversary on the explorer's cell costs one life (`hit` event); the game is lost only at 0 lives (`hit` then `caught`). At most one hit per tick, then `GRACE_TICKS` of protection and a knockback. See [Damage](#damage-hits-grace-knockback). Don't reintroduce an instant loss in a new code path.
7. **Don't hand-edit `memory.json`, `memory.md` or `adversaries.json`.** They are runtime output, rewritten every step. (`settings-<port>.json` is written by the `/settings` page, see [Server & UI](#server--ui).)
8. **Seeds are deterministic.** Adding, removing or reordering `rng()` calls in `generateDungeon` or `spawnAdversaries` changes every seed's dungeon. `SPAWN_STEPS` (dungeon.js:28) mirrors `MIN_SPAWN_STEPS` (adversary.js), so change them together.
9. **Only edit files your role owns** ([table below](#repo-map--ownership)), unless the user authorises more. Other sessions may be editing `public/` (or other files) at the same time, so re-read a file before you edit it, and don't commit unless asked. The repo is git (branch `main`): check `git status` before you start.
10. **Test explorer behaviour in the testbed, not in a full dungeon.** `src/testbed.js` builds a small configured arena (size, adversaries, props, chest, or an ASCII map). Use it for any test of how the explorer reacts, and **extend it when your test needs a new knob**: add the option to `DEFAULTS` + `normalizeConfig`, a check in `scripts/check-testbed.mjs`, and a row in [Testbed](#testbed-small-test-arenas). Don't hand-build one-off arenas elsewhere (the check scripts' hand-built `Game`s are the exception). `dungeon.treasure` **may be `null`** in a testbed arena, so guard any new code that reads it.

## Overview

Jev, a paid decision API at TypeSafe (`api.typesafe.ai/v1/systemone`), steers a knight through a procedurally generated grid dungeon one cell per tick, looking for a treasure chest. Every visited cell permanently lights everything within `LIGHT_RADIUS`, and lit cells are the explorer's known territory. Grey ghost adversaries patrol. When one sees the explorer it switches on its own Jev brain and hunts. A ghost that reaches the explorer's cell costs it one of its lives (2 by default); the game is lost when the last life goes and won when the explorer steps on the chest. The browser shows an isometric 8-bit view. Most numbers below are defaults: the gameplay tunables live in `src/settings.js` and are edited on the `/settings` page (see [Server & UI](#server--ui)). The Node server holds a single game in memory and makes every Jev call. The API key never reaches the browser.

## Run & verify

| What | How |
| --- | --- |
| Node | ≥ 20.12, needed for `process.loadEnvFile`. Zero dependencies, ES modules. |
| Start | `npm start` or `node server.js` from `dungeon-game/` |
| Port | `PORT` env or **3003** (server.js:14) |
| Secrets | `../.env` (`/Users/jakub/jev-playground/.env`, shared with sibling projects). The server throws at startup if `JEV_API_KEY` is missing. Never print the file. |
| Syntax | `node --check <file>` |
| World checks | `node scripts/check-dungeon.mjs`: static fog guard (section 0), generation, LOS, fog twins (incl. remembered-sighting twins), threat sentences, explorer memory and brain with a stub `ask` (state keys, memory shape, request-size asserts), scripted follower, tactic twins. Takes about 18 s, no Jev. `--measure` adds timings (see [open issues](#open-questions--known-issues)). |
| Adversary checks | `node scripts/check-adversaries.mjs`: speed, spawning, chase and damage (hit, grace, knockback, one hit per tick), search/brain-off, parallel brains, adversary memory shape (tally, events, latest_action), fog twins. Uses a stub `decide` injected through `stepAdversaries(game, { decide })`. Prints walker stats, which are informational only. |
| Testbed checks | `node scripts/check-testbed.mjs`: config parsing and validation, arena shape, determinism, props, adversary placement, ASCII maps, then ~25 stubbed ticks per scenario (incl. a fully lit, chest-less arena) and a **pack-alert scenario** (two ghosts behind a wall: one spots the explorer, the other must emit `alerted`). Under 1 s, no Jev. |
| Capability checks | `node scripts/check-capabilities.mjs`: the capability scaffold in `src/capabilities/index.js` (empty shipped registry, `defineCapability` validation, feasibility filtering, deterministic order). Pure, no game, no Jev. |
| Memory measurement | `node scripts/measure-memory.mjs [--arena door] [--ticks 60]`: plays the fixture arenas in `scripts/arenas/` (`door`, `open`, `corridor`, `explore`; JSON testbed configs) and prints request bytes (avg/max per kind: explorer sentiment, explorer tick, adversary), decisions, re-encounters after `chase_over`, back-and-forth, steps to the chest, outcome and hits. **Dry run with stub answers by default (free; some metrics are stubbed, so use it to compare request size and structure, not Jev behaviour). `--live` calls the real Jev and costs money**: don't pass it unless the user asked. |
| Testbed runner | `node scripts/run-testbed.mjs --size 9x9 --numAdversaries 2 --props few --ticks 30`: plays an arena in the terminal and prints each tick's move, decision trigger, sentiment, tactic, sightings and events, plus an ASCII map after decisions. Any testbed option works as `--<option> <value>`, `--map <file>` reads ASCII rows, `--quiet` drops the maps. **Dry run with stub answers by default (free). `--live` calls the real Jev and costs money.** The stubs go in as `opts` of `newTestGame`; memory goes to a temp dir. |
| Testbed server | `PORT=3001 TESTBED='size=9x9&numAdversaries=2&props=few' node server.js` (each port has its own `settings-<port>.json`): every new game (page load, Reload, `/api/new` without a body) is that arena. `TESTBED` takes the URL-query form or a JSON object and is validated at startup. Convention: the normal game on **3000**, the testbed on **3001**. |
| Testbed in the browser | `http://localhost:3003/?testbed&size=9x9&numAdversaries=2&props=few&treasure=far&seed=3`. Same keys as the config; `map` rows are split by `/` (URL-encode `#` as `%23`). Page load stays free; Start still costs Jev calls. |
| Settings | `http://localhost:3003/settings` (the `⚙ Settings` button): edit the tunables, saved per port to `settings-<port>.json`. Live knobs apply at once; the rest apply from the next game. |
| Visual check | Headless Chrome, e.g. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=out.png --window-size=1400,900 http://localhost:3003`, or playwright-core installed in a scratch dir. For an explored state, use a scratch server that serves `public/` and a game simulated with `game.applyMove`, with no Jev. |

- **Stubs are injected, never set globally.** `newGame(seed, { ask, decide, dir, memoryDir })`, `newTestGame(config, opts)`, `new ExplorerBrain(world, { ask, memoryDir })` and `stepAdversaries(game, { decide })`. `setAsker`, `setDecider`, `setMemoryDir` and the module-level request recorders are gone (the settings hooks `configureWorld` / `configureAdversaries` are the only module-level setters, called by `src/settings.js`): read the last request bodies from `run.explorer.lastRequest()` / `lastRequests()` and `adversary.lastRequest()`. A stub `ask` is called with `{ kind: 'sentiment' | 'tick', state, questions, body }`, a stub `decide` with `{ id, state, questions, body }`; both return the `answers` object.
- **Restarting the server loses the game.** It lives in module memory (`run`, `busy`). After a restart, `GET /api/state` returns `game: null` until `POST /api/new`. The page does that on load, and it is free.
- Static files are read from disk on every request, so UI edits need only a browser refresh. Edits to `server.js` or `src/` need a restart.
- The check scripts exit 1 on failure and print `FAIL:` lines. There is no test framework and no `npm test`.

## Repo map & ownership

| File(s) | Purpose | Owner |
| --- | --- | --- |
| `server.js`, `package.json` | HTTP server, static whitelist, the single `Run`, `/api/settings` | UI agent (testbed change: `/api/new` parses `{ testbed }`) |
| `public/index.html`, `public/app.js`, `public/style.css`, `public/settings.html` | Step loop, iso renderer, pane (events / encounters / landmarks / recent from explorer memory), minimap, the `/settings` page | UI agent (testbed change: `?testbed` query in `api`/`init`, chest guards in renderer and minimap) |
| `public/sprites.js` | Pixel-art knight, ghost, chest | sprites agent |
| `src/settings.js` | The tunables' schema, validation, per-port persistence, and the hooks `configureWorld` / `configureAdversaries` | shared: add a knob here, wire it in the module it tunes |
| `src/dungeon.js`, `scripts/check-dungeon.mjs` | Map gen, the `Game` class (lighting, movement, damage, `publicView`, `twin`), LOS; the check holds the static fog guard | world agent (testbed change: `applyMove` treats a `null` treasure as no win) |
| `src/characters/explorer/known-world.js` | `KnownWorld`: the explorer's fog-safe window on a `Game` | world agent. The only explorer file that may hold a `Game` |
| `src/characters/explorer/known-map.js`, `encounter.js`, `perception.js` | Known state → plain-language facts for Jev: pure known-floor helpers, the encounter model, approaches/tactics/situation/move facts | world agent (testbed change: the chest comes from `KnownWorld.seenTreasure()`, which returns `null` for a `null` treasure) |
| `src/characters/explorer/brain.js`, `memory.js`, `src/jev.js` | `ExplorerBrain` (minds, decision ticks, remembered sightings), explorer memory, Jev client | brain agent (v3: "stay unchanged"; the damage change touched only `RULES` and added `noteHit`, by user request) |
| `src/turn.js`, `src/characters/adversary/*` (`adversary.js`, `brain.js`, `memory.js`, `perception.js`), `scripts/check-adversaries.mjs` | `Run` (world tick, view), the `Adversary` class, its state machine and Jev brains | adversary(-brain) agent (testbed change: `newTestGame`, `Run`'s optional `dir`, and `view().testbed`) |
| `src/testbed.js`, `scripts/check-testbed.mjs`, `scripts/run-testbed.mjs` | Small configurable test arenas for explorer behaviour | shared: any agent may add options it needs (keep the checks passing) |
| `scripts/measure-memory.mjs`, `scripts/arenas/{door,open,corridor,explore}.json` | Request-size and behaviour metrics over fixture arenas (dry by default) | shared |
| `src/capabilities/index.js`, `scripts/check-capabilities.mjs` | Capability scaffold (`CAPABILITIES` registry, `defineCapability`, `feasibleOptions`, `actionQuestion`). **Empty and not wired into any brain** | shared (plan only beyond the scaffold, see PLAN-memory.md P3) |
| `PLAN-memory.md`, `PLAN-adversary-memory.md`, `PLAN-multiplayer.md` | Plans, not documentation of the code. PLAN-memory.md's P1 (remembered sightings, recent path, landmarks, encounters/events), P2 (regrouped state) and the `curious` mind are in the code; its P3 is only the scaffold. **PLAN-adversary-memory.md (fixed characters, `AdversaryView`, limited map) is not built.** Code wins over plans too. | nobody until the user approves a phase |
| `memory.json`, `memory.md`, `adversaries.json` | Runtime output | nobody (generated) |

## Conventions

- **Cells** are `[x, y]`, with x from 0 to `width-1` and y from 0 to `height-1`. **y points down.** `tiles[y][x]` is `'#'` or `'.'`. Cell keys are `` `${x},${y}` ``.
- **`DIRS`** = `{ up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }` (dungeon.js:30).
- **Map size varies per level.** Always use `dungeon.width`/`dungeon.height`; there are no size constants.
- **One tick** is the explorer's step, then the adversaries' moves. The explorer moves first, and a win on its step ends the tick before the adversaries move.
- **Code style:**
  - ES modules with named exports, `node:` import prefixes, `.js` on relative imports, `.mjs` for scripts.
  - 2-space indent, single quotes, semicolons.
  - PascalCase classes with `#private` fields for state nobody else may touch (`Game` and `Adversary`'s six fields stay public on purpose). camelCase functions, UPPER_SNAKE constants, snake_case keys in shapes sent to Jev or the browser (`explored_pct`, `known_floor_cells`).
  - Each file opens with a `//` header comment on its purpose. Inline comments explain *why*.
  - British vs US spelling is mixed (`neighbour`, `colour`, `centre`/`center`). Match the surrounding file.

## World & perception

**`src/dungeon.js`** (no Jev knowledge)
- Constants (dungeon.js:9-15): `LIGHT_RADIUS = 7`, `SIGHT_RANGE = 7`, `MIN_SIZE = 25`, `MAX_SIZE = 90`, `EXPLORER_LIVES = 2` are `export let` defaults that `src/settings.js` changes through `configureWorld()` (importers see the live value; `SIGHT_RANGE` applies at once, the rest from the next game). `ROOM_MIN = 4` and `ROOM_MAX = 15` are fixed. The room-count divisor (`ROOM_AREA`, 290) is a private tunable.
- Generation:
  - Width and height are each drawn independently from the seed.
  - Room count is `max(4, round(area/ROOM_AREA))` (default 290), placed by rejection with a wall gap between rooms.
  - L-shaped corridors join the rooms via a Prim MST, plus about n/4 loop corridors.
  - The outer ring is always wall. The start is a random room centre.
  - The treasure is a room cell at BFS distance ≥ 60% of the farthest reachable cell.
  - It retries on the same PRNG stream if constraints fail.
- Lighting:
  - Every cell within Euclidean `LIGHT_RADIUS` of a visited cell gets brightness `round((1 - d/(R+1))*100)/100`. Line of sight is not needed.
  - Brightness only ever goes up. `light > 0` means known.
  - With the default R = 7 the range is **0.13 to 1.0**.
- Off-map cells that get lit go into `game.litOutside` and count as known wall. That keeps the map edge indistinguishable from rock, which is intentional.
- Line of sight: `hasLineOfSight` walks a supercover line between cell centres, with endpoints ordered so the result is symmetric. It uses the real tiles. Any `'#'` strictly between the endpoints blocks, and a line through a corner needs both side cells open. **Sight** = LOS and Euclidean distance ≤ `SIGHT_RANGE`.
- **`Game`** (`new Game(dungeon)`) lives in dungeon.js, not its own file, because `check-props.mjs` copies that one file to a temp dir: keep the line `import { placeProps } from './props/place.js';` byte-identical and add no other relative import there. Fields are public and set up in the constructor: `dungeon, pos, steps, visits, light, knownCount, knownFloor, litOutside, floorCount, won, lost, caughtBy, health, maxHealth, graceTicks, trail, adversaries, adversaryTicks, patrolRand`. `adversaryTicks` (world ticks the adversaries have run) and `patrolRand` (patrol RNG, created lazily on the first patrol goal) belong to adversary.js but live here so there is no per-game WeakMap.
- Methods: `applyMove(dir)` returns `{ moved, revealed, revisit, won }` (plus `stayed` for `STAY`) and is a no-op once won or lost. `damage(amount, sourceId)` takes lives off, is a no-op once won or lost, sets `lost` and `caughtBy` only when health reaches 0, and returns `{ health, lost }`. `legalMoves`, `availableMoves`, `isKnown`, `knownTile`, `knownFloorCount`, `exploredPct`, `publicView` (sends `health` and `max_health`; the pane draws hearts), and `twin(overrides)` (see rule 4). `EXPLORER_LIVES` defaults to 2.
- `publicView` sends the full `tiles` to the browser, for the debug Reveal toggle only. The renderer must still hide them; see [Server & UI](#server--ui).

**`src/characters/explorer/known-world.js`** (`KnownWorld`): wraps a `Game` in `#game` and exposes only fog-safe, live (never cached) reads: `pos`, `steps`, `visits`, `health`, `maxHealth`, `graceLeft`, `won`, `width`/`height` (for sizing BFS arrays only), `isKnown`, `knownTile`, `knownFloorCount`, `legalMoves`, `availableMoves`, `visibleAdversaries()` (`{ id, pos, mode, distance }` of the ones in sight now), `seenTreasure()` (the chest once lit, else `null`) and `move(dir)` (the explorer's own step).

**`src/characters/explorer/{known-map,encounter,perception}.js`**: the only source of text Jev reads about the world. Every function takes a `KnownWorld` (`world`).
- `known-map.js`: cell arithmetic, `knownDistances` BFS, `isFrontier`, `wouldReveal`, compass words. Imports no explorer file.
- `encounter.js`: the encounter model below plus `encounterFacts`, `knownLineOfSight`, `speedPhrase`. Imports known-map.js and `ADVERSARY_SPEED` from adversary.js, never perception.js.
- `perception.js`: approaches, tactic feasibility and options (they need `approachTarget`, hence they cannot live in encounter.js), `situation`, `avoidZone`, `describeMoves` / `describeMoveParts`.
- `APPROACHES` (each with `text` and a first-person `thought` ≤ 60 chars for the UI bubble):
  - Exploration: `nearest_frontier` (default), `largest_unexplored`, `far_side`, `go_to_treasure` (only once the chest is known). `availableApproaches` lists only these.
  - Encounter **tactics** (`tactic: true`, `TACTICS`, `isTactic`): `slip_past`, `run_away` (the old `escape`), `face_off`, `hide`, `race_to_chest` (chest seen), `carry_on` (every visible adversary patrolling).
- `situation(world, { remembered, landmarks })` returns the per-tick facts in three groups (the brain adds the rest of Jev's state, see below):
  - `self`: `{ lives, max_lives, hit_protection_steps }`.
  - `surroundings`: `{ here, steps, known_floor_cells, chest, unexplored_by_direction, frontier_cells, landmarks[] }`. `chest` is a sentence (`'not seen yet'`, `'seen, N steps away by known path'`, ...). `landmarks` are `memory.landmarks` made relative to the explorer each tick (`{ kind, note, direction, distance, steps_ago }`).
  - `threats`: `{ visible[], remembered[], encounter }`. `visible` is `{ id, direction, distance, chasing }` per adversary in sight now. `remembered` is the brain's frozen sightings not in sight now, as `{ id, last_seen_steps_ago, was_chasing, direction, distance }` measured from where the explorer stands (direction `'here'` on the frozen cell).
  - `known_floor_cells` is a **count**, not a percentage, because a percentage would leak the map size.
  - Unexplored amounts use a fixed 12-cell window (`SURVEY_REACH`) and fixed bins, independent of map size.
  - `threats.encounter` is `null` unless an adversary is visible. Otherwise it holds **sentiment-free** sentences: `space` (open room W×H with known ways out, corridor, junction or dead end), `adversaries`, `gap_now` (number), `speed` (from `ADVERSARY_SPEED`), `slip_past` (best route past and its closest approach), `hide`, `run_away`, `dead_ends`, and `chest` (only once seen).
- Encounter model (encounter.js; all over known floor and visible adversaries only):
  - After the explorer's `i` steps, an adversary may have taken `ceil(i·ADVERSARY_SPEED)` steps. The predicted gap at a cell is its known-path distance from the adversary (Euclidean fallback) minus that.
  - `safeDistances(minGap)` is a BFS that only enters cells keeping that gap. The chest may always be entered, since stepping onto it wins.
  - `routeSurvey` runs it for gaps 6..1. The largest gap at which a goal is still reachable is that route's closest approach.
  - A slip goal is a frontier cell (or the seen chest) within 60° of the adversary's bearing and at least as far away as the adversary.
  - A hide cell is within 10 steps and out of `knownLineOfSight`, a copy of the supercover walk in which **unknown cells block**.
  - `face_off` needs an open area (2×2 known-floor flood fill) with both sides ≥ 5 and the current gap ≥ the minimum.
- `tacticFeasibility(world, minGap, { exclude })` returns `{ id: { target, fact } }` for the feasible tactics only (a tactic whose target is in `exclude` is dropped). `tacticOptions` turns that into Choice criteria. `run_away` is always feasible while anything is visible.
- `approachTarget(world, id, { minGap, goal, avoid, exclude, remembered })`: `goal` keeps a tactic's earlier target cell while it is still reachable at the gap, so `slip_past` doesn't lose its goal once its own light reveals it. `exclude` (a Set of cell keys) rules cells out as targets (the brain fills it after a ping-pong). `remembered` is the brain's frozen sightings; `run_away` uses them when no adversary is in sight.
- `run_away` (`escapeTarget` in encounter.js): the escape spot is **sticky**, kept until it is reached or no route keeps a gap of 2 (`ESCAPE_KEEP_GAP`) from every adversary. A new one is picked among the cells reachable while keeping the mood's `min_gap` from every adversary (then 2, then any known cell; a tier counts only if it holds a spot at least 4 steps away, `ESCAPE_TRAVEL`), preferring cells on the edge of the known map and corridor/junction cells beyond a room exit over a corner of the room. While the adversary is out of sight it keeps the goal, and once the goal is reached it continues from the frozen chasing sighting (the 3 latest, up to 15 steps old). So `run_away` can have a target with no adversary visible.
- `approachTarget` also takes `avoid`, a Set of cell keys from `avoidZone(world, remembered)` (known cells within 10 known-path steps of a sighting younger than 10 steps, or within 6 of one up to 15 steps old, plus, for each of the 3 latest chasing sightings, a sector: the known cells nearer to the sighting than the explorer is, and the cells whose shortest route from the explorer runs through the frozen cell, within 2 steps). Exploration approaches skip frontier cells in it while any other frontier cell exists; tactics ignore it.
- `describeMoveParts(world, approachId, { minGap, goal, avoid, remembered, prev, backAndForth })` returns, per legal move, `{ shared, target }` (or `{ whole }` for a move that wins the game or for `stay`). `shared` holds the facts that do not depend on the approach: threats (with "below your minimum gap of N" when it applies), a sentence about the nearest remembered sighting ("Heads toward where an adversary was last seen N steps ago ...", and, for a chasing sighting up to 15 steps old, however far the spot is, when no sighting lies within 8 steps of the move's destination, "Heads back toward where a chasing adversary was N steps ago (D steps from that spot after this)."), chest, reveal estimate, visits, "Goes back to the cell you left 2 steps ago (back-and-forth N times in the last 6 moves)", dead-end and cornered warnings. `target` is progress toward this approach's target. `describeMoves` joins the two into one sentence per move. Only the 3 most recent remembered sightings get a BFS per call.
- **Shared move facts.** On a decision tick the brain asks one `move_if_<tactic>` question per feasible tactic. The tactic-independent `shared` facts are sent once, in `surroundings.moves` (`{ dir: sentence }`), and each option carries only its own `target` part, so the request does not repeat them per tactic. Ordinary ticks put the whole sentence in the `next_move` options and send no `surroundings.moves`.
- Distances to adversaries use a BFS over known floor when the adversary's cell is known; otherwise rounded Euclidean.
- Determinism: tie-breaks are steps, then `(y, x)`. Keep them.
- Performance:
  - BFS uses flat `Int32Array`s, and `describeMoves` runs several of them per call.
  - A decision tick runs about 6 gap-limited BFS per minimum gap. That is a few ms on 90×90 maps.
  - Don't add full-grid scans per candidate move.
- `check-dungeon.mjs` covers this with twin tests (encounter facts plus tactic options and targets for the aggressive and scared gaps, with hidden tiles and hidden adversaries scrambled, and remembered-sighting twins that move a hidden adversary after it was seen), hand-built slip/corridor/blocked-exit/hide maps, and a stub-Jev brain run (`new ExplorerBrain(world, { ask, memoryDir })`) that also asserts the state keys, the memory shape and the request-size bounds. Section 4f runs a smart stub Jev (it reads the move sentences the way the priorities say): under `run_away` in a 12x5 room the explorer returns to the cell it just left at most 2 times in 15 ticks, and after `chase_over` on a hall it doesn't walk back toward the frozen sighting while another frontier exists. It takes about 18 s.

## Adversaries & the tick

**Spawning** (`spawnAdversaries`):
- Seeded by `rng(seed ^ 0x9e3779b9)`.
- Count is `min(MAX_ADVERSARIES, max(1, round(floorCells/FLOOR_PER_ADVERSARY)))` (defaults 150 and 12; `MAX_ADVERSARIES = 0` means none), so it grows with the map: 2 on a 25×29 map, about 11 on 70×76.
- Adversaries spawn on room floor at path distance ≥ 20 from the start and outside the start's sight, spread round-robin across rooms.
- Built as `new Adversary({ id: 'a1', pos })`. Public shape (and JSON, in this order): `{ id, pos, mode: 'patrol', budget: 0, lastSeen: null, goal: null }`. **Don't add public fields.**
- Private state (`#hunt` brain state from `brain.js` `newHunt`, `#route` the patrol route, `#lastRequestBody`) is reached through prototype accessors `hunt`, `memory`, `route`, `lastRequestBody` and `lastRequest()`, which are not own properties, so JSON, `Object.keys` and spread still show exactly six keys. Never spread or JSON-clone an `Adversary`.
- The patrol RNG (`seed ^ 0x85ebca6b`) is `game.patrolRand`, one stream per game, created on the first patrol goal.

**Constants** (adversary.js:14-27) are `export let` defaults that `src/settings.js` changes through `configureAdversaries()` (importers see the live value): `ADVERSARY_SPEED = 0.6` (3 steps per 5 ticks), `CHASE_RANGE = 7`, `MAX_SEARCH_TICKS = 18`, `HIT_DAMAGE = 1`, `GRACE_TICKS = 4`, `ALERT_STEPS = 24`. Private tunables in the same file: `FLOOR_PER_ADVERSARY = 150`, `MAX_ADVERSARIES = 12`, `PACK_ALERT = true`, `TEAM_SIGHT = true`; `MIN_SPAWN_STEPS = 20` is fixed. `KEEP_HUNTING_MIN = 0.5` lives in `adversary/brain.js` (also settable). `SIGHT_RANGE` is in dungeon.js. The adversary rules text (`rules()` in `adversary/brain.js`) is built from the live `SIGHT_RANGE`, speed, `MAX_SEARCH_TICKS`, `HIT_DAMAGE` and `GRACE_TICKS` (the last four arrive in `cfg`).

**Sight vs chase:**
- `seesExplorer` = Euclidean ≤ `SIGHT_RANGE` + LOS.
- `startsChase` = `seesExplorer && distance <= CHASE_RANGE`.
- They are kept as separate functions and constants on purpose (and are separate knobs on the settings page); see [Open questions](#open-questions--known-issues).

**Modes:**
- `patrol`: brain off, code wander, no Jev.
- `chase`: brain on, explorer in sight.
- `search`: brain on, no sight.

**Transitions:**
- `startsChase` emits `spotted` then `brain_on`, then (when `PACK_ALERT` is on) `alerted` + `brain_on` for each patrolling packmate within `ALERT_STEPS` path steps (they join in search mode at the explorer's cell, heading as the spotter saw it; alerted ghosts do not alert further; `alertNearby` in adversary.js). `check-testbed.mjs` has a pack-alert scenario for this.
- **Team sight** (when `TEAM_SIGHT` is on): a hunting adversary counts as seeing the explorer when any hunting packmate does (`tracksExplorer`), so a pack closes in together. The adversary's `describeMoves` (`adversary/perception.js`, not the explorer's) adds a "Cuts off N of M cells" fact per move in sight (cells the explorer can reach within `COVER_RADIUS` = 12 steps where this ghost would arrive first, and how many no other ghost covers).
- While the brain is on, sensing flips the adversary between chase and search (`spotted` / `lost_sight`).
- The brain switches off (`brain_off` with `reason`, back to patrol) in either of two cases:
  - more than `MAX_SEARCH_TICKS` (18) ticks pass without sight;
  - Jev's `keep_hunting` answer comes back below `KEEP_HUNTING_MIN`.
- **No `gave_up` event is ever emitted** (the adversary's own memory does log a "Gave up: reason" event, see below).

**Adversary fog of war** (rule 1 covers the explorer only; PLAN-adversary-memory.md would extend it to ghosts, not built):
- Adversaries know the real map.
- They know the explorer's position only while `seesExplorer` is true. Otherwise they know `last_seen` only.
- They never know the treasure or what the explorer has explored.

### Adversary memory & Jev state

`adversary/memory.js` (`createMemory(id)`, validated by `validateMemory`, all memories written together to `adversaries.json` as `{ tick, adversaries }` each tick). One per `Adversary`, reached as `a.memory`:

```
{ id, objective, brain { on, since_tick, last_reason },
  approach { id | null, current, since_step, tried[{ id, steps, reason }] },
  tally { sightings, lost_sight, hits, alerts_heard },
  events[{ tick, text }],
  progress { ticks_hunting, ticks_since_seen, distance_trend },
  latest_action: null | { choice, confidence, forced, fallback } }
```
- `tally` and `events` (`findings` is gone) describe the **current hunt**: `brainOn` resets them. Events (≤ 5, oldest dropped, an identical repeat ignored, the tick never repeated in the text): first sighting, "called for help" (alerted), "Hit the explorer (hit N)", "Gave up: reason". The tally counts `sightings` (re-sights), `lost_sight`, `hits`, `alerts_heard`.
- `approach.id` is `null` exactly while the brain is off. `tried` keeps only the outcome of a **search approach** (`cut_off`, `sweep_last_seen`) that was replaced by another search approach or by giving up. Hops between `direct_pursuit` and searching are not logged.
- `latest_action` is Jev's last `next_move` answer **without probabilities** (validation rejects the key): `{ choice, confidence, forced, fallback }`. The probabilities live in the private hunt state (`a.hunt.probabilities`) and `brainView(a)` (the browser's `view().adversaries[].brain`) still returns `latest_action: { choice, probabilities, confidence }`, so the UI is unchanged.
- Limits: events 5 (text 200), tried 5, approach 240, reason 200, trend 160.
- `noteHit(a, tick)` (`adversary/brain.js`) is called from `touchCheck` in adversary.js (line 335) when the ghost hits the explorer: it bumps `tally.hits` and adds the event.

The request body (`jevState` in `adversary/brain.js`) is `{ game, tick, self, surroundings, explorer, last_seen, [approach_target, checked_cells_near_last_seen], team, recent }`:
- `self` = `{ id, position, mode ('chase'|'search'), approach, latest_action }`; `surroundings` is map facts around the ghost.
- `explorer` carries a position, direction, `path_steps` and `heading` **only while in sight** (else `{ in_sight: false }`); `last_seen` is `{ cell, ticks_ago, heading, direction, path_steps }` or `null`.
- `approach_target` and `checked_cells_near_last_seen` (`"N of M floor cells within 10 steps"`) appear only while searching.
- `team` lists the other ghosts as `{ id, direction, path_steps, role: 'pursuing'|'searching'|'patrolling' }`; `recent` = `{ tally, events, progress }`.
- Questions: `next_move` (not asked with a single legal move or when a move catches the explorer), `search_approach` (first search tick: `cut_off` vs `sweep_last_seen`), `keep_hunting` (Noul, every search tick).

### Damage (hits, grace, knockback)

Code: `touchCheck`, `knockBack`, `graceLeft` in adversary.js; `Game.damage` in dungeon.js. Numbers below are the defaults of `HIT_DAMAGE` and `GRACE_TICKS`.
- **Touch = hit.** An adversary on the explorer's cell (it stepped in, or the explorer stepped onto it) calls `game.damage(HIT_DAMAGE, a.id)` and emits `{ id, type: 'hit', at, health }` (health after the hit). Only the life-ending hit also emits `{ id, type: 'caught', at }`, right after its `hit`, and `stepAdversaries` returns at once. Patrolling (brain-off) ghosts hit too.
- **One hit per tick.** Grace is read once at the start of `stepAdversaries` (`protectedNow`) and a per-call `touch.hit` latch blocks any second hit in the same tick, whether two ghosts step in, or two already share the explorer's cell.
- **Grace.** A hit sets `game.graceTicks = GRACE_TICKS` (4). Each `stepAdversaries` call starts by reading and then decrementing it, so the next 4 ticks cannot hurt; the 5th can. A ghost needs `1/ADVERSARY_SPEED = 2` ticks per step, so a standing explorer is hit again 6 ticks later (asserted in the check). `graceTicks` is a `Game` field (0 from the constructor); `graceLeft(game)` reads it. There is no per-adversary cooldown, so no WeakMap is needed for it.
- **Knockback.** Any adversary on a living explorer's cell after a touch check is moved off it, so a ghost never ends a tick inside the explorer: the hitter, and during grace any ghost that touches it (it is only bounced, no event). An adversary that just stepped in goes back to the cell it came from; one found there before moving (the explorer stepped in) goes to the first floor neighbour in `DIRS` order that is not the explorer's cell, preferring one that is not the explorer's previous trail cell; boxed in, it stays. Knockback sets `budget = 0` (no step, and no Jev call, straight after) and clears the patrol route. No `rng()` is used.
- **Known consequence.** A brain-on adversary next to the explorer still takes the forced move onto its cell during grace (`adversary/brain.js` code policy) and is bounced every time it steps; the first such step after grace is a hit. That is intended: standing next to a ghost is not safe.
- **Explorer text.** `rules()` (brain.js) says a touch costs one life, gives `EXPLORER_LIVES` and `GRACE_TICKS`. `situation.lives` (= `world.health`) and `situation.hit_protection_steps` (= `world.graceLeft`) are the explorer's own state, so fog-safe (twins share them through `game.twin`). The step-into move fact starts `Steps into the adversary:` and says "costs 1 life (N of M left) and it is knocked back", "costs your last life and the game is lost", or "no life lost while your hit protection lasts" during grace. A non-lethal hit adds an event, a `hit_here` landmark and an `encounters.hits` count via `ExplorerBrain.noteHit` (called from `Run.playTurn`); the lethal one keeps `noteCaught` (same, with "Caught by ...").
- **Adversary text.** Adversary `rules` and the "Steps onto the explorer" move fact say it hits (a life), not that it wins.

**`stepAdversaries(game, { decide })` order** (adversary.js; `decide` replaces the Jev call, null = the real one). These invariants are easy to break:
1. Return immediately if the game is won or lost. Read grace (`protectedNow`), then decrement `game.graceTicks`.
2. Sort adversaries by id and run the touch check for each **before anything moves**. This catches the explorer stepping into one. Only a lethal hit returns early; a non-lethal hit lets the tick go on.
3. Advance the tick counter (`game.adversaryTicks`) and run `senseStart` for each.
4. Add `ADVERSARY_SPEED` to every budget. An adversary moves at most one step per tick.
5. Adversaries with `budget >= 1` and the brain on call Jev **in parallel**, all from the same post-explorer snapshot.
6. Apply steps **in id order**. A failed Jev call falls back to a code BFS move with `console.warn`. Brain-off adversaries take a patrol step. Run the touch check after each step (knockback to the previous cell). Two adversaries may share a cell, but never the living explorer's.
7. Return `{ events, turns }`.

**`src/turn.js`** (`Run`):
- `newGame(seed?, opts)` generates, spawns and returns a `Run`; `newTestGame(config, opts)` does the same for a testbed arena. Constructing one costs no Jev calls.
- `run.playTurn()` runs `run.explorer.takeTurn()`, then `stepAdversaries(game, { decide })`, then `saveMemories(..., dir)` (writes `adversaries.json`), then `explorer.noteCaught` if the game was newly lost, else `explorer.noteHit` if a `hit` event fired. The explorer's turn, including its memory save, finishes before the adversaries start. Adversary brains build their request bodies synchronously, in id order, because the option shuffle uses `Math.random`: don't add an `await` before `buildRequest` in `adversary/brain.js` `decide`.
- `run.memory` is the explorer's plain-JSON memory (`run.explorer.memory`).
- `run.view()` sends the **full** adversary list, each as `{ id, pos, mode, visible, brain }`, plus `grace_ticks` and `invulnerable` (grace > 0). The UI hides adversaries that aren't visible unless Reveal is on.

## Explorer brain, memory & Jev client

**`src/jev.js`:**
- `askJev(state, questions, body?)` POSTs `{ model: 'jev-latest', state, questions }` (or the pre-built `body`) with a Bearer key and returns `answers`.
- Each request is **hedged**: `HEDGE = 2` identical copies race and the first answer wins.
- Each copy retries up to `RETRIES = 3` times on 429, 529 or network errors, with a 20 s timeout per attempt.
- One logical call can therefore bill several times.

**What Jev reads (explorer).** `state = { game, self, surroundings, threats, plan, recent }`, built by `ExplorerBrain.#state` from memory plus `situation()` (the old `{ game, memory, situation }` shape, `situation.threats`/`situation.treasure` and the verbatim memory are gone):
- `game`: `rules()`, one sentence block (objective folded in, speed from `speedPhrase`, lives, grace, and what `threats.visible` / `threats.remembered` mean).
- `self`: `{ lives, max_lives, hit_protection_steps, mind: { id, since_step, recent } }`; `mind.recent` is the last 5 picks as runs, e.g. `"cautious×3 → scared"`.
- `surroundings`: from `situation` (above), plus `moves` on a decision tick with tactic questions (the shared move facts, one sentence per direction).
- `threats`: `{ visible, remembered, encounter }`.
- `plan`: `{ approach { id, current, since_step, interrupted | null }, tried[{ id, steps, reason }] }`.
- `recent`: `{ path (compass words), back_and_forth, revealed_since_approach, steps_since_approach, revisits_last_10, encounters, events }`.

**`ExplorerBrain.takeTurn()`** (brain.js). `new ExplorerBrain(world, { ask, memoryDir })` builds the initial memory (it runs `approachTarget`, so the world must be ready). Review info, encounter bookkeeping, the tactic goal, the remembered sightings and the last request bodies are `#private` fields, so there is one brain per `Run` and no module-level mutable state in `explorer/*`. Each tick starts with `#observe()`, which updates the sightings (below).
- **Ordinary tick:** with exactly one legal move, the move is **forced** and no Jev call is made. Otherwise it makes **one** request with a `next_move` question (plus an approach review every few steps).
  - Option order is shuffled every tick, because Jev leans toward the first option.
  - An illegal choice falls back to `legal[0]`.
- **Decision tick** (an approach decision). It makes one extra request, **first and in sequence**:
  1. `sentiment` (Choice). It sees the state and the sentiment-free `threats.encounter`. Each option states the circumstances that call for it (`when`), its effect (min gap, end ticks, note), and, while an adversary is in sight, which tactics its `min_gap` leaves open here.
  2. The normal tick request, with the new sentiment already in `self.mind`. While an adversary is in sight it adds `tactic` (Choice over the feasible tactics only) plus a **speculative** `move_if_<tactic>` per option, each judged on that tactic's move facts. The move taken is the answer for the chosen tactic, so the move on the decision tick already follows it. With one feasible tactic, code takes it and asks no Choice.
- **Merged triggers.** A pending decision (`start`, `chest`, `review`) and an `encounter` on the same tick cost **one** sentiment call: the encounter trigger wins and the pending one is dropped. A trigger without an adversary in sight waits through forced ticks.
- **Triggers:**
  - `start`: the first tick.
  - `encounter`: an adversary is in sight with no tactic on (after `REDECIDE_COOLDOWN` ticks since the last decision), an id not seen in this encounter appears, or a visible one goes patrol→chase.
  - `tactic_failed`: the tactic's target is gone, or (except for `run_away`) the gap fell below `min_gap`, or the explorer is **going back and forth** (`PINGPONG_FAILS = 3` moves since the last decision that returned to the cell just left, `recent.back_and_forth`). A ping-pong also fills the brain's `#exclude` with the two bounce cells and the old target, so `tacticFeasibility` and `approachTarget` pick something else on the re-decision; it is cleared when an encounter starts and when it ends. At most once every `REDECIDE_COOLDOWN = 3` ticks.
  - `chase_over`: nothing in sight for the sentiment's `end_ticks`. The parked approach resumes.
  - `chest`: the chest was spotted.
  - `review`: a review switched the approach. The sentiment is asked on the next tick, so it is only paid for when the approach really changed.
- **Remembered sightings (rule 1).** `#seen` maps adversary id → `{ id, cell, step, chasing }`, written only from `world.visibleAdversaries()` and never updated while the adversary is out of sight. A sighting is dropped when older than `REMEMBER_STEPS = 30` steps or when the explorer is within `SIGHT_RANGE` of the frozen cell with `knownLineOfSight` to it while that id is not visible. The ones not in sight become `threats.remembered`, per-move "where an adversary was last seen" facts, and (within 15 steps) an avoid zone for exploration targets (`avoidZone`).
- **Minds** (`SENTIMENTS` in brain.js, read from `memory.sentiment.id` every tick). Each has `min_gap`, `end_ticks`, `priority` (a line in `next_move` and the `tactic` question), `move_priority` (the same rule, short, for the speculative `move_if_<tactic>` questions), `when` (what Jev reads when picking it) and `note`. Each changes behaviour in code: `min_gap` drives tactic feasibility and targets, the gap warning in move facts and `tactic_failed`; `end_ticks` ends the encounter.

  | id | min_gap | end_ticks |
  | --- | --- | --- |
  | scared | 5 | 6 |
  | risk_averse | 4 | 5 |
  | cautious (default before the first pick; `when` narrowed to recent or nearby danger) | 3 | 4 |
  | curious (opposite of cautious: drawn to the unknown; replaced `calculated`, which is gone) | 3 | 2 |
  | courageous | 2 | 2 |
  | aggressive | 2 | 1 |
- `next_move` priorities (ordinary tick):
  1. Step onto the chest (and, once it is seen, head for it).
  2. Only while threats are visible: never step into one, avoid moves below `min_gap`, plus the current tactic's move hint (e.g. `run_away` keeps the distance growing; `slip_past` may move toward it while the gap holds).
  3. Do not head toward where an adversary was last seen (only when `threats.remembered` is non-empty).
  4. The sentiment's priority line.
  5. Avoid `stay`, follow the approach, reveal new cells, avoid backtracking.
  The speculative questions keep only the chest line (if the chest is seen), the safety line and the mind's `move_priority`.
- Approach reviews:
  - They run every `REVIEW_EVERY = 8` steps, and only once 8 steps have passed on the current approach.
  - They are skipped during `go_to_treasure` and any tactic.
  - A review adds `approach_working` (Noul) and `next_approach` (Choice over exploration approaches) **to the same request**.
  - The approach switches only if `approach_working < APPROACH_FAILING (0.5)`.
- Code policies:
  - Once the chest is known, switch to `go_to_treasure`; mid-encounter it replaces the parked approach instead.
  - Tactics park the exploration approach with `interruptApproach`. Switching from one tactic to another keeps the parked approach. **Tactics never go into `tried`.**
- **Turn shape:** `{ step, dir, forced, revealed, won, move_decision, decision, review, policy, apiMs }`.
  - `move_decision` = `{ choice, probabilities, confidence, options } | null`.
  - `decision` = `null | { trigger, sentiment: { choice, probabilities }, tactic: { choice, probabilities, options } | null, apiMs }`.
  - `apiMs` covers both requests.
- **Request helpers:** `brain.lastRequest()` returns the latest request; `brain.lastRequests()` returns both requests of a decision tick. The injected `ask` is called as `ask({ kind: 'sentiment' | 'tick', state, questions, body })`. `noteCaught(adversaryId)` and `noteHit(adversaryId)` are methods too.
- `rules()` derives "about 3 steps for every 5 of the explorer's" from `ADVERSARY_SPEED` (`speedPhrase`), and lives and grace from `EXPLORER_LIVES` / `GRACE_TICKS`, so it follows the settings.
- **Cost:** a decision tick costs 2 requests instead of 1. Each encounter costs about 2 decision ticks (`encounter` and `chase_over`), plus `tactic_failed` re-decisions (≤ 1 per 3 ticks). On top of that come one `start` decision per game and one per chest sighting or review switch (merged into the encounter's call when they coincide).
- **Request size.** The largest explorer decision tick is about 9-10 KB (a chest-seen, hide-able, 5-6 tactic case). `check-dungeon.mjs` asserts ≤ 9500 bytes for a chasing adversary (5 tactics) and ≤ 10500 for a patrolling one (6 tactics). Adding a state field or a longer option means re-checking these bounds; `measure-memory.mjs` prints the sizes per fixture arena.

**`memory.js`:**
- Shape: `{ approach { id, current, thought, since_step, tried[], interrupted }, progress { steps, known_floor_cells, revealed_since_approach, steps_since_approach, revisits_last_10 }, sentiment { id, since_step }, sentiment_history[{ id, step }], recent { moves[], cells[], back_and_forth }, encounters { count, escaped, hits, last_at_step }, events[{ step, text }], landmarks[{ kind, cell, step, note }] }`. Gone: `objective`, `findings`, `latest_action`, `danger`, `sentiment.profile_note` (the profile text now comes from `SENTIMENTS`).
- `approach.thought` is ≤ 60 chars and set for every approach. On resume it is looked up by id.
- `sentiment.since_step` moves only when the mood changes. `sentiment_history` keeps the last 5 picks.
- `recent`: the last 6 moves and 8 cells; `back_and_forth` counts moves that returned to the cell two positions back (standing still never counts).
- `encounters`: `count` (an encounter began), `escaped` (it ended unhurt at `chase_over`), `hits` (`noteHit` / `noteCaught`).
- `events`: short milestones, newest 6 (saw the chest, dropped an approach after a review, hit, caught, won). The step is its own field, never repeated in the text.
- `landmarks`: located facts, kinds `chest`, `dead_end_explored`, `hit_here`, `hiding_spot_used`; one per kind + cell, at most 8, oldest non-chest evicted first (the chest is never evicted). Perception turns them into direction/distance each tick.
- `saveMemory` validates the shape (and throws if it's wrong), then writes `memory.json` (the source of truth, but **not** sent verbatim: `ExplorerBrain.#state` picks from it) and `memory.md` (rendering only, never read back).
- It runs at the end of every `takeTurn` and in `noteCaught` / `noteHit`.
- **Any new memory field that reaches Jev must be fog-safe** and fit the validation limits (`LIMITS` in memory.js): approach text 240, tried 5, thought 60, sentiment_history 5, events 6 (text 200), landmarks 8 (note 120), recent moves 6 / cells 8.
- The revisit window lives in a WeakMap keyed by the memory object (the one remaining WeakMap), so it never reaches Jev or disk. The brain's encounter bookkeeping, tactic goal and remembered sightings are private fields of `ExplorerBrain`, so sightings are **not** in `memory.json`. `memory` itself stays a plain object, never a class instance.

## Testbed (small test arenas)

`src/testbed.js` builds a tiny arena instead of a generated dungeon, so explorer reactions (to adversaries, cover, corridors, open space) can be watched in isolation. `buildArena(config)` returns `{ dungeon, adversaries, config }` (the adversaries are `Adversary` instances); `turn.js` `newTestGame(config, opts)` wraps it in a `Run` through the same constructor as `newGame`, so both start from identical state. It costs no Jev calls.

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
- Adversaries are built with `new Adversary({ id, pos })` (the contracted shape) and start in `patrol`; they do not go through `spawnAdversaries` (its 20-step / out-of-sight rule can't hold in a small room).
- `generateDungeon` and its `rng()` order are untouched; the testbed uses its own stream (`seed ^ 0x51ed27a3`).

**Adding an option:** add it to `DEFAULTS`, parse and validate it in `normalizeConfig` (accept URL strings too), apply it in `buildArena`, cover it in `check-testbed.mjs`, and add a row to the table above.

## Server & UI

**Server** (`server.js`):
- Routes:
  - `GET /`, `/app.js`, `/settings` (settings.html), `/style.css`, `/sprites.js`, `/props/*.js` (the `STATIC` whitelist).
  - `GET /api/settings` → `settings.view()` (`{ schema, values, defaults, pending }`); `POST /api/settings` with `{ values }` validates, saves `settings-<port>.json` and applies the live knobs at once (400 with the reason on a bad value). Knobs marked `next` (spawn density, lives, light radius, map size, room area) apply from the next `POST /api/new` (`settings.applyNextGame()`). The schema lives in `src/settings.js`: to add a tunable, add a `SCHEMA` row and wire it through `configureWorld` / `configureAdversaries`.
  - `GET /api/state` → `{ game: run.view()|null, memory: run.memory|null }`.
  - `POST /api/new` → `{ game, memory }`. It waits for any in-flight step. An optional body `{ testbed: {...} }` builds a [testbed arena](#testbed-small-test-arenas) instead; a bad config returns **400** with the reason, a non-JSON body 400.
  - `POST /api/step` → `{ game, memory, turn }`. Returns **409** for no game, game over, or a step already running, and 502 if the turn throws.
- `.env` is loaded *before* the dynamic `import('./src/turn.js')`. Keep that order. `settings.js` is loaded (`loadSettings`) at startup, before the first game.
- The pane's memory display reads explorer memory (UI pane: events / encounters / landmarks / recent, plus the approach thought and mind); the UI agent owns its details.

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
  - Known cells map `light` to 8 bands, from cold navy at the lit edge to warm amber where the knight walked (`bandOf` in app.js). `bandOf` assumes `light` runs 0.2 to 1 and clamps lower values; see [open issues](#open-questions--known-issues).
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
- Damage: a `hit` event logs "a1 hit Jev — 1 life left" (red, `li.hit`) and flashes the board red (`.board-wrap.hit::after`, 450 ms). While `game.invulnerable` the knight blinks (`BLINK_MS = 120`). The final loss shows the overlay title "Jev lost all lives".
- Ghosts bob 2 px over 1.6 s and cast a floor shadow. A chasing ghost has a red pulsing glow, and a ghost with its brain on shows a cyan marker.
- The minimap stays top-down, is rebuilt only when `miniDirty` is set, and draws the rotated viewport outline.
- Theme:
  - Dark only: navy/stone with an amber accent, square corners, hard shadows, monospace font.
  - Two columns (board + 340 px pane). Below 860 px the board is 70dvh and the page scrolls.

## Open questions & known issues

- **Chase trigger.** The user wrote "line of sight … and at least 7 steps away"; the code builds "within 7" pending confirmation. The flip is one operator in `startsChase` (adversary.js:156). Because `seesExplorer` already caps distance at `SIGHT_RANGE = 7`, an "at least 7" trigger also needs a larger `SIGHT_RANGE`.
- **Reveal toggle doesn't resync actors.** It only sets `miniDirty` (the Reveal checkbox `onchange` in app.js). A ghost revealed mid-game can tween (streak) across the fog on the next step instead of snapping.
- **Mid-tween occlusion.** If a new view arrives mid-tween, the walking knight can briefly draw over a wall in front of it.
- **Trail dots** are hard to see on the amber floor. Reveal-mode unknown walls look slightly too bright.
- **Encounter tactics (v4).** `escape` was renamed `run_away` (CONTRACT.md says `run_away` now). `run_away` never fails by gap, so a chaser that stays in sight triggers no re-decision. `carry_on` is effectively unreachable while `CHASE_RANGE == SIGHT_RANGE` (the defaults; the settings page can separate them).
- **`run_away` in a closed room.** With a close ghost in a room with no way out, `run_away` can still shuttle from corner to corner. The answer there is `slip_past` or `face_off`, which `run_away` doesn't decide.
- **`check-dungeon --measure` is stale.** It still samples sizes 140..150 and labels them "~150x150" (check-dungeon.mjs:919). With the default `MAX_SIZE = 90` no seed qualifies, so the large-map timing is empty or may break. The minimum-size sample (section 6, check-dungeon.mjs:971) uses 35×35, not 25×25. Not yet run.
- **Renderer light floor.** `bandOf` assumes `light` runs 0.2 to 1. With `LIGHT_RADIUS = 7` it goes down to 0.13 and everything below 0.2 lands in the coldest band, so the outer ring of each light pool looks flat.
- **Walker stats.** Even the `flee` policy in `check-adversaries.mjs` is often caught or times out. The stats are informational, not asserted, and useful for tuning speed and ranges.
- **Request size.** The largest explorer decision tick is about 9-10 KB (asserted ≤ 9500 bytes for a chasing adversary with 5 tactics, ≤ 10500 for a patrolling one with 6, in `check-dungeon.mjs`). The ghosts' requests are smaller. A new state field or longer option text can break these bounds; if you raise them on purpose, say why here.
- **Capabilities are a scaffold.** `src/capabilities/index.js` has an empty registry and no brain calls it; `check-capabilities.mjs` covers only the scaffold. Wiring (a `KnownWorld` `knownItems()`, the static-guard allowlist for `src/capabilities/`) is described in PLAN-memory.md P3, not built.
- **Adversary map knowledge.** Ghosts still read the whole real map. PLAN-adversary-memory.md (fixed characters, `AdversaryView`, a limited map) is a plan only.
