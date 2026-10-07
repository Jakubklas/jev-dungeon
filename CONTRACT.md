# Jev Dungeon: module contract (v5, classes)

Jev steers an explorer through a pre-generated 2D dungeon one cell at a time (up/down/left/right, or stay).
The explorer wins by stepping on the treasure chest. Every visited cell permanently lights everything
within `LIGHT_RADIUS` (7, Euclidean, no line of sight needed). Lit cells are **known territory**.
Adversaries roam the dungeon. An adversary that sees the explorer gives chase, and each touch costs the
explorer a life (2 at the start); the game is lost when the last life goes. Reload regenerates everything.

Zero dependencies (Node ≥ 20.12, ES modules). `JEV_API_KEY` is in `../.env` and never reaches the browser. Port 3003 standalone; `hub.js` (port 3000) routes `/arena/<name>/` and `/gym/<name>/` to per-instance `server.js` processes (see AGENTS.md).

**The code is the source of truth.** This file describes it as of the memory redesign on top of the OOP refactor (`Game`, `KnownWorld`, `ExplorerBrain`, `Adversary`, `Run`, injected Jev calls, regrouped explorer state, explorer and adversary memory, settings, capability scaffold). Numbers quoted here are the **defaults**: the tunables live in `src/settings.js` and are edited on the `/settings` page. [AGENTS.md](AGENTS.md) is the working guide (rules, checks, caveats); if the two disagree with the code, fix them.

## Layout and ownership

```
dungeon-game/
  server.js, package.json, public/{index.html,app.js,style.css,sprites.js,settings.html,props/*}   -> UI agent (+ art agents)
  src/dungeon.js                     constants, map gen, line of sight, the Game class                -> world agent
  src/jev.js                         Jev API client (askJev, shuffle)                                 -> brain agent
  src/turn.js                        Run: one game in progress (tick, view); newGame / newTestGame    -> adversary agent
  src/testbed.js                     small configurable test arenas (buildArena, normalizeConfig)    -> shared
  src/settings.js                    tunables: schema, validation, per-port persistence, configure hooks -> shared
  src/capabilities/index.js          capability scaffold: empty registry, not wired into any brain   -> shared
  src/props/{catalog,place}.js       props and wall decor placement                                   -> props-world agent
  src/characters/adversary/adversary.js   Adversary class, spawning, senses, state machine, movement -> adversary agent
  src/characters/adversary/{brain,memory,perception}.js   adversary Jev brains                       -> adversary agent
  src/characters/adversary/adversary-view.js   AdversaryView: a ghost's window on a Game (full or limited map) -> adversary agent
  src/characters/adversary/character.js   fixed characters: traits, presets, profileOf, assignCharacters -> adversary agent
  src/characters/shared/memory-kit.js     pure memory helpers shared by both characters (no game, no character imports) -> shared
  src/characters/explorer/known-world.js  KnownWorld: the explorer's only window on a Game          -> world agent
  src/characters/explorer/known-map.js    pure known-floor helpers (BFS, frontier, compass)          -> world agent
  src/characters/explorer/encounter.js    the encounter model (safe distances, routes, hide, facts)  -> world agent
  src/characters/explorer/perception.js   approaches, tactics, situation, move facts, as plain text  -> world agent
  src/characters/explorer/memory.js       explorer memory (memory.json / memory.md)                  -> brain agent
  src/characters/explorer/brain.js        ExplorerBrain: Jev decisions for the explorer              -> brain agent
  scripts/check-*.mjs                checks (dungeon, adversaries, testbed, props, capabilities, characters, memory-kit; no Jev)
  scripts/run-testbed.mjs            testbed runner (no Jev unless --live)
  scripts/measure-memory.mjs, scripts/arenas/{door,open,corridor,explore,ambush,home,pack,charline}.json   request-size and behaviour metrics over fixture arenas (stubbed unless --live; `--who adversary` is stubbed only)
  PLAN-memory.md, PLAN-adversary-memory.md, PLAN-multiplayer.md   plans, not specs of the code (adversary-memory plan: A1-A4 built behind toggles that default to off; A5, mood, wait and caution not built)
```
Only edit files your role owns; the full ownership table is in AGENTS.md ("Repo map & ownership").

## Conventions

- A cell is `[x, y]`. `x` runs from 0 to `width-1`, `y` from 0 to `height-1`, and **y points down**. A cell's key is `` `${x},${y}` ``. `tiles[y][x]` is `'#'` or `'.'`.
- `DIRS = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }`. `STAY = 'stay'` is the explorer's non-move (not in `DIRS`).
- Time is turn-based. One **tick** = the explorer's one step plus the adversaries' moves for that tick.
- **Map size varies per level.** `width` and `height` are each a random integer from 25 to 90 (`MIN_SIZE`, `MAX_SIZE`), chosen independently and drawn from the seed. There are no `WIDTH`/`HEIGHT` constants: always use `dungeon.width`/`dungeon.height`.
- **Fog of war stays a hard rule.** Jev may only see three things: known cells, adversaries the explorer can currently *see* (see Sight), and (user-approved amendment) adversaries it *saw earlier*, frozen at the moment of sighting (`threats.remembered`, below). Adversaries the explorer cannot see must never influence anything sent to Jev: a remembered sighting is the explorer's own record at the cell where it saw the adversary, it is never updated from the game, and it expires after `REMEMBER_STEPS` (30) steps or as soon as the explorer sees that cell empty (within `SIGHT_RANGE` with a known line of sight while the id is not visible). Explorer code enforces this structurally: it takes a `KnownWorld`, never a `Game` (see `KnownWorld`), and a static guard in `scripts/check-dungeon.mjs` fails on any other read, and twin tests (hidden tiles and adversaries scrambled, including a hidden adversary moving after it was seen) require byte-identical Jev input.
- **Sight (symmetric).** An adversary and the explorer see each other when `hasLineOfSight(dungeon, a, b)` is true **and** their Euclidean distance is `<= SIGHT_RANGE` (7). Line of sight is physical: walls block it, and it uses the real tiles, not light.
- **Chase rule.** An adversary that sees the explorer within `CHASE_RANGE` (7) switches to `chase`. While chasing, it moves toward the explorer (adversaries know the map). When it loses sight, it goes to `search`: it hunts from `lastSeen`, and after `MAX_SEARCH_TICKS` (18) without sight, or if Jev's `keep_hunting` falls below `KEEP_HUNTING_MIN` (0.5), it goes back to `patrol`. `patrol` wanders between random room cells.
- **Speed.** Adversaries move at 0.6 of the explorer's speed (`ADVERSARY_SPEED`). Each tick an adversary gains 0.6 to `budget` and moves one step per whole point (3 steps every 5 ticks). Patrolling adversaries use the same speed.
- **Damage, not instant loss.** An adversary on the explorer's cell (it stepped in, or the explorer stepped onto it) costs one life (`HIT_DAMAGE = 1`, event `hit`). The game is lost only at 0 lives (`hit` then `caught`). At most one hit per tick; a hit starts `GRACE_TICKS` (4) of protection and the adversary is knocked back off the explorer's cell. The explorer moves first in a tick. A win on the explorer's step ends the tick before the adversaries move.
- **Injected Jev.** Every class that calls Jev takes the call as an option (`ask` for the explorer, `decide` for the adversaries). Left out, it is the real, paid Jev. There are no global setters.

## `src/dungeon.js` (world agent)

```js
export let LIGHT_RADIUS = 7, SIGHT_RANGE = 7, MIN_SIZE = 25, MAX_SIZE = 90, EXPLORER_LIVES = 2;   // defaults; live bindings changed by configureWorld
export const ROOM_MIN = 4, ROOM_MAX = 15;
export function configureWorld({ lightRadius, sightRange, minSize, maxSize, lives, roomArea })  // called by src/settings.js; any key optional. roomArea (290) is the cells-per-room divisor
//   sightRange applies at once; the others shape the next game.
export const DIRS, STAY;
export function rng(seed)                       // -> () => float in [0,1)   (mulberry32)
export function generateDungeon(seed = randomSeed()) // -> Dungeon
//   Dungeon = { seed, width, height, tiles: string[], start: [x,y], treasure: [x,y] | null, rooms: [{x,y,w,h}], props, decor }
//   (props/decor: see "props and wall decor" below; a testbed arena also sets `testbed: true`.)
//   Room count and corridor network scale with area. The floor is fully connected and has loops. The treasure is in a room,
//   at a path distance of at least 60% of the farthest reachable cell. Same seed gives the same dungeon.
//   `treasure` is `null` only in a testbed arena with no chest.
export function isFloor(dungeon, [x,y])          // -> bool (real tiles; for adversary movement, never for explorer perception)
export function floorDistances(dungeon, from)    // -> Map<key, steps> over real floor (adversary pathing)
export function hasLineOfSight(dungeon, a, b)    // -> bool. Supercover line between cell centres; any '#' strictly between blocks
```

```js
export class Game {
  constructor(dungeon)                           // fresh game at dungeon.start, start cell lit
  // Public fields, set in this order by the constructor:
  //   dungeon, pos, steps, visits /* {key: count} */, light /* [y][x], 0 = unknown */, knownCount, knownFloor,
  //   litOutside /* Set of lit keys beyond the map edge: known rock */, floorCount,
  //   won, lost, caughtBy, health, maxHealth /* = EXPLORER_LIVES */, graceTicks /* hit protection left */,
  //   trail, adversaries /* Adversary[] */,
  //   adversaryTicks /* world ticks the adversaries have run */, patrolRand /* patrol RNG, created lazily */
  applyMove(dir)         // -> { moved, stayed?, revealed, revisit, won }. No-op when won or lost. STAY keeps the cell, counts a step.
                         //    A null treasure never wins.
  damage(amount = 1, sourceId = null)  // -> { health, lost }. No-op when won or lost. Sets lost/caughtBy only at health 0.
  legalMoves()           // dirs whose destination is floor ([] once won or lost)
  availableMoves()       // legalMoves plus STAY ([] once won or lost)
  isKnown([x,y]), knownTile([x,y]) /* '#' | '.' | null */, knownFloorCount(), exploredPct()
  publicView()           // -> { seed, width, height, tiles, start, treasure, props, decor, pos, steps, won, lost, health, max_health,
                         //      light /* copy */, visits, trail, explored_pct }
  twin(overrides = {})   // shallow copy that keeps the prototype (for fog twin tests). `litOutside` must stay a Set.
}
```
Never JSON-clone or spread a `Game`: `litOutside` is a `Set` and the methods live on the prototype. `Game` lives in dungeon.js because `scripts/check-props.mjs` copies that single file to a temp dir, so dungeon.js keeps the line `import { placeProps } from './props/place.js';` byte-identical and no other relative import. Lit cells outside the map count as known `'#'` (rock), so neither `unexplored_by_direction` nor the "would reveal" counts give away where the map ends.

Performance: maps are up to 90×90. Per-tick work should stay cheap (no full-grid scans per candidate move where a BFS bounded by known cells will do).

## `src/characters/adversary/adversary.js` (adversary agent)

```js
export let ADVERSARY_SPEED = 0.6, CHASE_RANGE = 7, MAX_SEARCH_TICKS = 18, ALERT_STEPS = 24, HIT_DAMAGE = 1, GRACE_TICKS = 4;   // defaults; live bindings
export function configureAdversaries({ speed, chaseRange, maxSearchTicks, hitDamage, graceTicks, alertSteps, floorPerAdversary, maxAdversaries, packAlert, teamSight, keepHuntingMin, adversaryCharacters, limitedMap })
//   called by src/settings.js; any key optional. Private tunables behind it: FLOOR_PER_ADVERSARY 150, MAX_ADVERSARIES 12, PACK_ALERT true, TEAM_SIGHT true;
//   toggles (both default false, apply from the next game): adversaryCharacters (mixed characters at spawn, per-ghost patrol RNG, smart memory and the regrouped state);
//   limitedMap (ghosts know a limited map; acts only together with adversaryCharacters, see limitedActive()). Live bindings CHARACTERS_ON, LIMITED_ON.
//   keepHuntingMin (0.5) lives in adversary/brain.js (KEEP_HUNTING_MIN). MIN_SPAWN_STEPS (20) is fixed.
export class Adversary {
  // Public fields, in this order. This is also its whole JSON shape (adversaries are never spread or cloned).
  id /* 'a1' */, pos /* [x,y] */, mode /* 'patrol'|'chase'|'search' */, budget /* 0 */, lastSeen /* [x,y]|null */, goal /* [x,y]|null */
  constructor({ id, pos, mode = 'patrol', budget = 0, lastSeen = null, goal = null, character = 'standard' })   // character: a preset id from character.js; unknown id throws
  // Private state behind prototype accessors (not own properties, so JSON/Object.keys show only the six fields):
  get character                  // preset id, fixed at spawn ('standard' by default)
  get profile                    // profileOf(traits of the character): every per-ghost number, the priority line and the words for Jev
  get home                       // spawn cell: centre of the patrol territory and of the limited map's home zone
  get hunt                       // brain state (adversary/brain.js newHunt)
  get memory                     // the adversary's plain-JSON memory (adversaries.json)
  get route / set route          // cached patrol route, or null
  get lastRequestBody / set ...  // exact body of its last Jev request, or null
  lastRequest()                  // that body parsed, or null
}
export function spawnAdversaries(dungeon)        // -> Adversary[]. Seeded via rng(dungeon.seed ^ 0x9e3779b9).
//   count = min(MAX_ADVERSARIES, max(1, round(floorCells / FLOOR_PER_ADVERSARY))) (defaults 12 and 150). They spawn in rooms at a path distance of at least 20 from start
//   and never in the start's sight, spread round-robin over the rooms. With the adversaryCharacters toggle on, characters are then assigned by
//   assignCharacters(dungeon.seed, count, 'mixed') on its own stream rng(seed ^ 0x6a09e667), after every spawn rng() call (same cells for every seed).
export { viewOf as adversaryView }               // (game, adversary) -> the ghost's cached AdversaryView (mode 'limited' only while limitedActive())
export function seesExplorer(game, adversary)    // -> bool (SIGHT_RANGE + hasLineOfSight, symmetric)
export function startsChase(game, adversary)     // -> bool. Trigger for patrol/search -> chase: seesExplorer && distance <= CHASE_RANGE.
//   The user wrote "has a direct line of sight ... and is at least 7 steps away". We build "within 7" pending confirmation,
//   so the trigger stays a one-operator change, and sight stays its own function and constant.
export function visibleAdversaries(game)         // -> [{ id, pos, mode, distance /* euclidean, 1 decimal */ }] that the explorer sees now
export function graceLeft(game)                  // -> game.graceTicks
export async function stepAdversaries(game, { decide = null } = {})   // mutates game.adversaries and the game's health/lost/caughtBy
//   -> { events, turns }. `decide({ id, state, questions, body })` replaces the Jev call of a brain-on adversary (null = the real Jev).
//   events = [{ id, type: 'spotted'|'lost_sight'|'hit'|'caught'|'brain_on'|'brain_off'|'alerted', at: [x,y] }]  // 'alerted' also has `by`
//            hit adds `health` (after the hit); brain_off adds `reason`. `caught` is emitted only right after the life-ending `hit`.
//            (`gave_up` is never emitted.)
//   turns  = [{ id, dir, decision|null, keep_hunting: number|null, brain: 'on'|'off', apiMs, error? }]
export { brainView } from './brain.js'
```
`stepAdversaries` order: return at once if the game is won or lost; read grace, then decrement it; touch check for every adversary in id order before anything moves (catches the explorer stepping into one); bump `game.adversaryTicks`; sense; add `ADVERSARY_SPEED` to every budget; brain-on adversaries with `budget >= 1` call `decide` in parallel from the same snapshot; apply steps in id order with a touch check after each (knockback to the previous cell). Request bodies are built synchronously in id order, so never add an `await` before `buildRequest` in `adversary/brain.js`. `adversary/brain.js` also exports `newHunt(id)` and `decide(game, a, tick, cfg, ask)`.

## `src/characters/adversary/adversary-view.js` (adversary agent)

```js
export class AdversaryView {                      // one per (game, ghost), private #game; the ghost-side twin of KnownWorld
  constructor(game, adversary, { limited = false })   // mode 'full' (real map, today's behaviour) or 'limited' (the limitedMap toggle)
  mode  /* 'full' | 'limited' */
  get pos, get tick                               // live
  explorer(), heading()                           // the explorer's position / frozen heading, null unless this ghost has it in sight now (own or team sight)
  seesExplorerFrom(cell)                          // line-of-sight test from a cell
  teammates(), teammateCount()                    // packmates (id, pos, role); in limited mode only the ones heard or seen
  isKnown(cell), isKnownWall(cell), neighbours(cell), legalMoves()
  distancesFrom(cell)                             // BFS over the real floor (full) or over the known set K only (limited; a cell outside K gives an empty Map)
  cellsInView(from = pos), update(tick)           // line-of-sight physics; update stamps what it sees into K (limited)
  hear(caller, cell, tick)                        // limited: copy the caller's known cells within 6 path steps of the reported cell
  frontierToward(target, dist)                    // the known frontier cell nearest a target outside K
  knownCount(), knownKeys(), get forgotten        // known-map size and cells faded or evicted so far
  kindOf(cell)                                    // room / doorway / junction / corridor / dead end, from known cells only
}
```
It is the only adversary file (with adversary.js, which owns physics, touch checks and spawning) that may hold a `Game` or touch `dungeon.tiles`; `perception.js`, `brain.js` and `memory.js` take a `view`, never a `game`. Static guard: `scripts/check-dungeon.mjs` section 0b. Never exposed: the treasure, the explorer's light/visits/trail/health, real tiles outside K. In limited mode K is the home zone (spawn room plus cells within `homeRadius` path steps of the spawn cell, computed once), cells seen (fading after `seenTtl`, capped at `seenCap`), cells heard from a call, and the four cells around the ghost; a wall is known only when 8-adjacent to a known floor cell.

## `src/characters/adversary/character.js` (adversary agent)

```js
export const TRAITS /* aggression, persistence, horizon, roaming, pack */, RESERVED_TRAITS /* ['caution'], dormant */, PRESETS /* standard, aggressive, pursuer, ambusher, patient_hunter, short_sighted, timid, territorial, rover */, PRESET_IDS, SPECIAL_IDS
export function profileOf(traits)               // -> every per-ghost number (chaseRange, restTicks, maxSearchTicks, keepHuntingMin, sweepRadius, cutMax, homeRadius, alertSteps, call/team flags, memory sizes and ttls), the priority line (<= 300 chars) and words for Jev. All traits 2 = today's constants.
export function assignCharacters(seed, count, mode = 'mixed')   // own stream rng(seed ^ 0x6a09e667); 'mixed' = shuffled deck of the non-standard presets, ghost i gets deck[i]; 'standard' = all standard
export function charactersFor(spec, seed, count)               // testbed `characters` spec ('standard' | 'mixed' | id | list, cycled) -> one id per ghost
```
Shared pure memory helpers used by both characters live in `src/characters/shared/memory-kit.js`: `backAndForth`, `pushRing`, `addLandmarkTo`, `ageEntries`.

## `src/turn.js` (adversary agent). The world tick, which the server uses.

```js
export class Run {                               // one game in progress
  game                                           // the Game
  explorer                                       // the ExplorerBrain (reads the game through a KnownWorld)
  get memory()                                   // = explorer.memory (plain JSON)
  async persist()                                // writes memory.json/md and adversaries.json (server.js on a new game)
  async playTurn()                               // -> Turn
  view()                                         // -> the browser view
}
export function newGame(seed?, opts = {})        // generateDungeon + spawnAdversaries -> Run. No Jev calls.
export function newTestGame(config, opts = {})   // buildArena(config) -> Run. Throws TestbedError on a bad config. The config key `characters`
//   ('standard' default | 'mixed' | one preset id | a list, URL form 'ambusher;timid', applied per ghost in id order and cycled) sets the ghosts' characters.
//   opts = { ask, decide, dir, memoryDir } (all optional):
//     ask       replaces the explorer's Jev call: ({ kind: 'sentiment'|'tick', state, questions, body }) => answers
//     decide    replaces the adversaries' Jev call: ({ id, state, questions, body }) => answers
//     memoryDir URL of the folder for memory.json / memory.md (default: dungeon-game/)
//     dir       URL of the folder for adversaries.json (default: dungeon-game/)
//   A Run without `ask` / `decide` calls the real, paid Jev.
```
`playTurn`:
1. `explorer = await this.explorer.takeTurn()` (decides, moves, saves memory).
2. `{ events, turns } = await stepAdversaries(game, { decide })`. It first hits an explorer that stepped onto an adversary, and does nothing once the game is won or lost.
3. `saveMemories(...)` writes `adversaries.json` (`{ tick, adversaries: memories }`, in `game.adversaries` order).
4. If newly lost, `explorer.noteCaught(game.caughtBy)`; else if a `hit` event fired, `explorer.noteHit(id)`.

`Turn = { ...ExplorerTurn, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns }`.

`view()` = `{ ...game.publicView(), adversaries: [{ id, pos, mode, visible, brain, character }], grace_ticks, invulnerable /* grace > 0 */, over: won||lost, testbed }`. The full adversary list is included for the debug reveal toggle; `visible` = the explorer sees it now. `brain` is the adversary-brain view under "v3" below. `character` is the ghost's preset id, a Reveal-only display (the explorer never reads it).

## `src/characters/explorer/*`

### `known-world.js`: `KnownWorld` (world agent)

The explorer's only window on a game (the one explorer file allowed to hold a `Game`, in a private `#game`). Reads are live, never cached, and fog-safe:

```js
new KnownWorld(game)
get pos, steps, visits, health, maxHealth, graceLeft, won   // the explorer's own state
get width, height                       // grid size, only for sizing arrays; says nothing about the layout
isKnown(cell), knownTile(cell), knownFloorCount(), legalMoves(), availableMoves()
visibleAdversaries()                    // -> [{ id, pos, mode, distance }] the explorer sees now
seenTreasure()                          // -> the chest cell once lit, else null (also null when there is no chest)
move(dir)                               // the explorer's own step (Game.applyMove)
```
Static guard (`scripts/check-dungeon.mjs`, section 0): every other `src/characters/explorer/*.js` file must not contain `game.x`, `game[...]`, `.dungeon`, dynamic or namespace imports, or imports outside this allowlist: `DIRS, LIGHT_RADIUS, STAY, EXPLORER_LIVES, SIGHT_RANGE` from dungeon.js (`SIGHT_RANGE` is a constant, used only to expire a remembered sighting); `ADVERSARY_SPEED, GRACE_TICKS` from adversary.js; sibling explorer files; `../../jev.js`; `node:fs/promises`.

### `known-map.js`, `encounter.js`, `perception.js` (world agent)

All take a `world` (a `KnownWorld`). Layering, acyclic: `known-map.js` ← `encounter.js` ← `perception.js`.
- `known-map.js`: `key`, `sameCell`, `step`, `neighbours`, `knownFloor`, `plural`, `euclid`, `isFrontier`, `knownDistances` (BFS over known floor), `wouldReveal`, `compass`, `dirWord`, `compass8`, `reachableFrontier`, `pick`.
- `encounter.js`: the encounter model over known floor and visible adversaries only: `threatsOf`, `threatDistance`, `safeDistances` (gap-limited BFS), `goalsAt`, `hiddenFromAll`, `escapeTarget`, `isRoomCell`, `openArea`, `faceOffTarget`, `encounterFacts` (the sentence set behind `threats.encounter`), `knownLineOfSight` (supercover over known tiles, **unknown cells block**), `speedPhrase` (derived from `ADVERSARY_SPEED`), `FACE_OFF_MIN_SIDE`.
- `perception.js`: `APPROACHES`, `TACTICS`, `isTactic`, `DEFAULT_MIN_GAP`, `treasureSeen(world)`, `availableApproaches(world)`, `approachTarget(world, id, { minGap, goal, avoid, exclude, remembered })`, `tacticFeasibility(world, minGap, { exclude })`, `tacticOptions(world, minGap)`, `avoidZone(world, remembered)`, `situation(world, { remembered, landmarks })`, `describeMoves(world, approachId, opts)` and `describeMoveParts(world, approachId, { minGap, goal, avoid, remembered, prev, backAndForth })`. Tactic feasibility lives here, not in encounter.js, because it needs `approachTarget`.
- Exploration approaches: `nearest_frontier` (default), `largest_unexplored`, `far_side`, `go_to_treasure` (only once the chest is known). Encounter tactics (`tactic: true`): `slip_past`, `run_away`, `face_off`, `hide`, `race_to_chest`, `carry_on` (see "v4: encounter tactics").
- `situation(world, { remembered = [], landmarks = [] })` returns `{ self, surroundings, threats }` (the brain adds `game`, `plan`, `recent` and `self.mind`):
  - `self = { lives, max_lives, hit_protection_steps }`.
  - `surroundings = { here ('room'|'junction'|'corridor'|'dead end'), steps, known_floor_cells /* a count, not a % */, chest /* sentence */, unexplored_by_direction /* none|little|some|a lot per side, fixed 12-cell window */, frontier_cells, landmarks[] }`. A landmark is `{ kind, note, direction, distance, steps_ago }`, `memory.landmarks` made relative to the explorer every tick.
  - `threats = { visible[], remembered[], encounter }`. `visible` is `[]` or `{ id, direction: 'north-east', distance: 5, chasing: true }` per adversary in sight (8-point compass words). `remembered` is `{ id, last_seen_steps_ago, was_chasing, direction ('here' on the frozen cell), distance }` per frozen sighting not in sight now. `encounter` is `null` unless an adversary is visible.
- `describeMoveParts` returns, per legal move, `{ shared, target }` (or `{ whole }` for a winning move and for `stay`). `shared` is approach-independent: threat sentences, a sentence about the nearest remembered sighting (also "Heads back toward where a chasing adversary was N steps ago (D steps from that spot after this)." for a chasing sighting up to 15 steps old, whatever the distance), chest, reveal estimate, visits, a "Goes back to the cell you left 2 steps ago" fact, dead-end warnings; `target` is progress toward the approach's target. `describeMoves` joins them into one sentence per move. Threat sentences, for example: "Moves toward an adversary", "Steps into the adversary: costs 1 life (N of M left) and it is knocked back" (or "costs your last life and the game is lost", or "no life lost while your hit protection lasts"), "Leads into a known dead end: risk of being cornered", "Heads toward where an adversary was last seen N steps ago", and the gap warning "below your minimum gap of N". Distances to adversaries use BFS over known floor if the adversary's cell is known, else Euclidean. Only visible adversaries count as threats; remembered sightings only produce the "last seen" sentence.

### `memory.js` + `brain.js`: `ExplorerBrain` (brain agent)

```js
export class ExplorerBrain {
  constructor(world, { ask = null, memoryDir = null } = {})  // builds the initial memory (runs approachTarget); null ask = real Jev
  get memory()                                 // plain JSON object, saved as memory.json; Jev reads a regrouped state built from it (below)
  async takeTurn()                             // -> ExplorerTurn
  async noteCaught(adversaryId)                // event "Caught by a2: the last life is gone.", encounters.hits + 1, a hit_here landmark, save
  async noteHit(adversaryId)                   // event "Hit by a2: 1 of 2 lives left.", encounters.hits + 1, a hit_here landmark, save
  lastRequest()                                // latest request body, parsed, or null
  lastRequests()                               // this tick's bodies in order, parsed: [sentiment, tick] on a decision tick
}
export const SENTIMENTS, profileOf
```
Review info, encounter bookkeeping, the tactic goal, the remembered sightings and the last request bodies are `#private` fields: one brain per `Run`, no module-level mutable state. `memory.js`'s revisit window is a WeakMap keyed by the memory object, so it never reaches Jev or disk.

**Memory** (`memory.js`, `createMemory`, validated by `validateMemory`; `saveMemory` writes `memory.json` and `memory.md`) has the shape:

```
{ approach { id, current, thought, since_step, tried[{ id, approach, steps, reason }], interrupted },
  progress { steps, known_floor_cells, revealed_since_approach, steps_since_approach, revisits_last_10 },
  sentiment { id, since_step }, sentiment_history[{ id, step }],
  recent { moves[], cells[], back_and_forth },
  encounters { count, escaped, hits, last_at_step },
  events[{ step, text }],
  landmarks[{ kind, cell, step, note }] }
```
`objective`, `findings`, `latest_action`, `danger` and `sentiment.profile_note` no longer exist. Limits (`LIMITS`): approach text 240, `tried` 5, thought 60, `sentiment_history` 5, `events` 6 (text 200, oldest dropped, the step never repeated in the text), `landmarks` 8 (note 120; kinds `chest`, `dead_end_explored`, `hit_here`, `hiding_spot_used`; one per kind + cell, the chest is never evicted), `recent.moves` 6, `recent.cells` 8. `recent.back_and_forth` counts moves that returned to the cell two positions back. `encounters.count` / `escaped` / `hits` count encounters begun, ended unhurt, and hits taken. The remembered sightings are **not** in memory: they are a private field of the brain.

**Jev state (explorer).** Memory is not sent verbatim. Every explorer request carries `state = { game, self, surroundings, threats, plan, recent }`:
- `game`: `rules()`, a sentence block saying that adversaries roam, move slower (derived from `ADVERSARY_SPEED`), chase on sight, that a touch costs one life (`EXPLORER_LIVES`, `GRACE_TICKS` of protection afterwards), and what `threats.visible` / `threats.remembered` mean. The objective is folded in.
- `self`: `situation().self` plus `mind: { id, since_step, recent }` (`recent` = the last 5 picks as runs, "cautious×3 → scared").
- `surroundings`: `situation().surroundings`, plus `moves` (`{ dir: shared facts }`, sent once) on a decision tick that asks tactic questions.
- `threats`: `situation().threats`. `plan`: `{ approach { id, current, since_step, interrupted | null }, tried[{ id, steps, reason }] }`.
- `recent`: `{ path /* compass words */, back_and_forth, revealed_since_approach, steps_since_approach, revisits_last_10, encounters, events }`.
- Request size: the largest explorer decision tick is about 9-10 KB; `check-dungeon.mjs` asserts ≤ 9500 bytes (a chasing adversary, 5 tactics) and ≤ 10500 (a patrolling one, 6 tactics).

**Minds.** `SENTIMENTS` has `scared` (min_gap 5, end_ticks 6), `risk_averse` (4, 5), `cautious` (3, 4; the default before the first pick), `curious` (3, 2; the opposite of cautious; replaced `calculated`, which is gone), `courageous` (2, 2) and `aggressive` (2, 1). Each also has `priority` (a line in `next_move` and `tactic`), `move_priority` (the same rule, short, for the speculative `move_if_<tactic>` questions), `when` (the circumstances that call for it, shown in the sentiment question) and `note`. `profileOf(memory)` returns the current profile.

- `next_move` priorities: (1) step onto the chest, else head for the seen chest; (2) while threats are visible, never step into one, avoid moves below the sentiment's `min_gap`, plus the current tactic's hint; (3) do not head toward where an adversary was last seen (when `threats.remembered` is non-empty); (4) the sentiment's priority line; (5) avoid `stay`, follow the approach, reveal new cells, avoid backtracking. The speculative per-tactic questions keep only the chest line, the safety line and the mind's `move_priority`.
- **Remembered sightings.** The brain freezes each adversary in `visibleAdversaries()` as `{ id, cell, step, chasing }` and drops it after `REMEMBER_STEPS` (30) steps or when the explorer sees the frozen cell empty. The ones not in sight form `threats.remembered`, a per-move "last seen" fact, and an avoid zone (`avoidZone`) that exploration targets steer around: known cells within 10 known-path steps of a sighting under 10 steps old, or 6 of one up to 15 steps old, plus a sector for the 3 latest chasing sightings (known cells nearer the sighting than the explorer, and cells whose shortest route from the explorer runs through the frozen cell). `approachTarget`'s `exclude` (cell keys not to pick) and `remembered` (the sightings) feed `run_away`.
- **Triggers** of a decision tick (`turn.decision.trigger`): `start`, `encounter`, `tactic_failed`, `chase_over`, `chest`, `review`. A pending `start` / `chest` / `review` decision and an `encounter` on the same tick share **one** sentiment call (the encounter wins). `tactic_failed` fires when the tactic's target is gone, when the gap fell below `min_gap` (not for `run_away`), or on **back-and-forth** (`PINGPONG_FAILS` = 3 moves since the last decision returning to the cell just left; the bounce cells and the old target are then excluded from the re-decision's targets, until the encounter starts or ends); at most once per `REDECIDE_COOLDOWN` (3) ticks.
- Approach reviews (every `REVIEW_EVERY` = 8 steps; `approach_working` below 0.5 switches) do not run during `go_to_treasure` or any tactic.
- `ExplorerTurn = { step, dir, forced, revealed, won, move_decision, decision, review, policy, apiMs }`. `policy: { from, to, reason } | null` is for code-driven approach switches, separate from `review`.

## `server.js` + `public/*` (UI agent)

- Uses `newGame`, `newTestGame` from `./src/turn.js` only, and holds one `Run`. `POST /api/new` → `{ game: run.view(), memory }`; an optional body `{ testbed: {...} }` builds a testbed arena (400 on a bad config). `POST /api/step` → `{ game, memory, turn }`, or 409 once over, with no game, or while a step is running. `GET /api/state` → `{ game: view|null, memory|null }`. Static files come from the `STATIC` whitelist in server.js: a new file in `public/` must be registered there. `TESTBED=<query or JSON>` makes the server a testbed. `GET /settings` serves `public/settings.html`; `GET /api/settings` → `{ schema, values, defaults, pending }`; `POST /api/settings` with `{ values }` saves `settings-<PORT>.json` and applies the live knobs now (the `next` knobs, `pending` until a new game, apply on the next `POST /api/new`); 400 with `{ error }` on a bad value. The schema is `SCHEMA` in `src/settings.js`.
- **Settings page:** the `⚙ Settings` button (next to Start and Reload) goes to `/settings`, a standalone page (`public/settings.html`, inline CSS and JS) that builds its rows from `GET /api/settings`: a slider plus number field per numeric knob, a checkbox per toggle, a `live` / `next game` badge on each, **Save** (disabled until something changed) and **✕** (closes, asking before it discards unsaved edits). A save applies live knobs at once; knobs marked `next game` show "saved" until the next `POST /api/new`. The Adversaries group has two `next game` toggles, both off by default: **Ghost characters** (`adversaryCharacters`: mixed characters at spawn, per-ghost patrol RNG, smart memory) and **Limited ghost map** (`limitedMap`: ghosts know only their home zone and what they have seen; ignored without Ghost characters).
- **Bigger maps:** the board is a camera viewport that follows the explorer, centred and clamped to map edges. It must not shrink a 90×90 map to fit. A minimap of known cells (explorer, chest when known, visible adversaries, viewport outline) sits in a corner of the board or the pane.
- **Taller board:** the board stretches down to the bottom of the window. The control pane sits beside it and scrolls on its own. On narrow screens the board takes about 70dvh.
- Ghosts are drawn only when `visible` (or always, dimmed, with "Reveal map"). A chasing one has a red glow, one with its brain on a cyan marker. The HUD adds the map size (`W×H`), hearts for `health`/`max_health` and a status chip (Safe / Chased / Caught, derived from the game view, not from memory). The pane shows explorer memory (UI pane: events / encounters / landmarks / recent, plus the approach thought and mind; the UI agent owns the details), and turn events go into a short log (a `hit` event logs in red and flashes the board; the knight blinks while `invulnerable`).
- Overlay: "Treasure found" (win) or "Jev lost all lives" (loss), with steps, explored %, approaches used, time, and a Reload button that starts a new level automatically.
- **Look (v3): isometric 8-bit.** `public/sprites.js` holds the pixel art, `public/app.js` + `style.css` the renderer.
  - Projection: `TW = 32`, `TH = 16` art px; `sx = (x-y)*TW/2`, `sy = (x+y)*TH/2`, measured at the cell centre. Floor = diamond tile; wall = raised block 1-3 `WALL_H = 11` blocks tall (renderer-only, `1 + floor(hash(x, y, seed ^ 0x5a17) * 3)` per cell; not in `publicView`; floors stay flat) with a lit top and two darker side faces. Drawn in `x+y` order with entities inserted at their cell's depth.
  - Pixel look: render to a low-res offscreen buffer, blit at integer scale with smoothing off, camera snapped to whole art pixels.
  - Palette: known cells map `light` to 8 bands from cold navy stone (the lit edge) to warm amber torchlit stone (where the explorer walked). With `LIGHT_RADIUS = 7`, `light` runs 0.13..1.0 and the renderer clamps everything below 0.2 into the coldest band. Unknown cells get a navy floor glow by distance to the nearest known cell, fading to black over ~5 cells, with no wall shapes (fog of war; Reveal map overrides).
  - Characters: explorer = 8-bit knight with an oversized helmet (red plume, shield, red cape). Adversary = grey, red-eyed ghost, hovering (bob + floor shadow). Every character mirrors left/right by its latest screen-x direction of travel (`right`/`up` = faces right, `left`/`down` = faces left), keeping the last facing when it didn't move.
  - `sprites.js`: `export function buildSprites()` -> `{ knight, ghost, chest }`, each `{ canvas, w, h, anchorX, anchorY }` (anchor at the feet / hover point, art drawn facing right). Optional `frames: [...]` of the same shape for idle animation.
  - The chest may be absent (`treasure === null`) in a testbed arena; the renderer and minimap skip it.

## Deviations agreed during the v2 build

- `game.knownFloor` is a running count of known floor cells. `game.litOutside` is a **Set** of lit cells beyond the map edge, so never JSON-clone or spread a game (use `game.twin`), because that breaks `isKnown` near the edges.
- `unexplored_by_direction` uses a fixed 12-cell window.
- Line of sight is supercover: a line passing exactly through a corner needs both side cells open, so you can't see through a diagonal gap between walls.
- Memory adds `approach.interrupted: { id, approach, since_step, reason } | null`, which holds the approach parked during an encounter tactic. Tactic interruptions never go into `tried`.
- `stepAdversaries` itself detects the explorer stepping onto an adversary (the touch check runs before anything moves). Patrol routes are cached on the `Adversary`.

# v3: bigger rooms, and adversaries with their own Jev brains

## Rooms

Room width and height are each a random integer from 4 to 15, chosen independently. The room count per area drops to match. The minimum map must still fit at least 4 rooms, so generation may allow overlap retries or fewer rooms. Every other generation guarantee stays as before, and adversary spawns stay feasible.

## Adversary brains (fully agentic)

Every adversary has its own Jev brain, and **the brain is on only while the adversary is hunting**:
- **off (patrol):** the code wanders, with no Jev calls.
- **on:** it switches on when `startsChase` fires (event `brain_on`). While on, every adversary step is a Jev Choice over its legal directions. Each tick the adversary is either in sight of the explorer (`mode: 'chase'`) or hunting from memory (`mode: 'search'`).
- While searching, the brain also gets a `keep_hunting` Noul each step: "Is it still worth hunting the explorer?" If the answer is below 0.5 (`KEEP_HUNTING_MIN`), the brain switches off (event `brain_off`, reason recorded). The adversary stops chasing and goes back to code patrol. Code also switches it off after `MAX_SEARCH_TICKS` (18) without sight. Alerted ghosts count `ALERT_STEPS` (24) in path steps.
- **Pack hunting.** When an adversary spots the explorer (`startsChase`), every patrolling adversary within `ALERT_STEPS` (24) path steps joins in `search` mode with `last_seen` at the explorer's cell (events `alerted` with `by`, then `brain_on`; only while `PACK_ALERT` is on, and alerted ghosts do not alert further). While hunting, an adversary also tracks the explorer through any hunting packmate's sight (team sight, `TEAM_SIGHT`), so it stays in `chase` mode and gets the explorer's position while a packmate sees it. In sight, each move option states how many of the explorer's reachable cells (within 12 steps) the move cuts off, and how many of those no other adversary covers.
- Movement keeps the speed budget, at most 1 step per tick. Only adversaries whose brain is on and that have a step this tick make a Jev call. Their calls for one tick are **made in parallel** from the state after the explorer's move, then applied in id order with a touch check after each step. Two adversaries may share a cell, but never the living explorer's.
- **Adversary fog of war:** by default adversaries know the real map (tiles, rooms, their own position and the other adversaries' positions), read through an `AdversaryView` in `full` mode. With the `limitedMap` toggle (off by default, and only together with `adversaryCharacters`) a ghost knows only its limited map K (home zone, fading seen cells, cells heard from a call, the four cells around it; see the AdversaryView section); a spot with no known route has `path_steps: null` and the brain heads for the edge of what it knows. In both modes they know the explorer's position **only while `seesExplorer` is true** (or a hunting packmate sees it, with `TEAM_SIGHT`). Otherwise they know only `last_seen` (cell + ticks ago + the direction the explorer was heading when last seen), plus, with memory on, frozen sightings. They never know the treasure location or what the explorer has explored.
- **Per-adversary memory** (`createMemory(id, character)` in adversary/memory.js, validated by `validateMemory`): `{ id, character: { id }, objective, brain: { on, since_tick, last_reason }, approach: { id | null, current, since_step, tried[{ id, steps, reason }] }, tally: { sightings, lost_sight, hits, alerts_heard }, events[{ tick, text }], progress: { ticks_hunting, ticks_since_seen, distance_trend }, latest_action: null | { choice, confidence, forced, fallback }, sightings[{ cell, tick, heading, source: 'seen'|'called', by? }], recent: { moves[], cells[], back_and_forth }, landmarks[{ kind, cell, tick, note }], lifetime: { hunts, escapes, hits, last_hunt_end_tick } }`. The last four are filled only while the `adversaryCharacters` toggle is on (ticks as units; sightings stored only when the explorer moved at least 3 cells from the newest, newest first; landmark kinds `home` (pinned), `explorer_seen`, `explorer_lost`, `explorer_hid`, `hit_here`, `area_checked`, and **`chest` throws**; capacities and ttls come from the character's `horizon`; `lifetime` is never reset, and with the toggle on `events` are kept across hunts). `findings` is gone: `tally` (counters) and `events` (at most 5: first sighting, called for help, a hit, "Gave up: reason"; text ≤ 200, the tick never repeated in the text) describe the **current hunt** and are reset when the brain switches on. `approach.id` is `null` exactly while the brain is off, and `tried` holds only the outcomes of search approaches. `latest_action` has **no probabilities** (validation rejects the key); they sit in the private hunt state and `brainView` still returns them for the UI. The objective is "Catch the explorer before it finds the treasure". There are 3 approaches: `direct_pursuit` (close the path distance), `cut_off` (head for the junction or corridor the explorer is most likely to pass through next, judged from its heading and the map), and `sweep_last_seen` (search outward from the last-seen cell). Code sets `direct_pursuit` while the explorer is in sight. When sight is lost, Jev picks between `cut_off` and `sweep_last_seen` with a Choice on the first search tick. `noteHit(a, tick)` (adversary/brain.js) is called from `touchCheck` in adversary.js when the ghost hits the explorer: it bumps `tally.hits` and adds an event.
- **Jev state (adversary)** (`jevState` in adversary/brain.js): `{ game, tick, self: { id, position, mode, approach, latest_action }, surroundings, explorer, last_seen, [approach_target, checked_cells_near_last_seen], team: [{ id, direction, path_steps, role }], recent: { tally, events, progress } }`. `explorer` holds a position, direction, `path_steps` and `heading` only while in sight (else `{ in_sight: false }`); `last_seen` is `{ cell, ticks_ago, heading, direction, path_steps } | null`; `approach_target` and `checked_cells_near_last_seen` appear only while searching; `team[].role` is `pursuing`, `searching` or `patrolling`. With the `adversaryCharacters` toggle on the state is regrouped: `self.character { id, traits (words), style }` (also sent for any non-standard ghost), `surroundings.landmarks[]` (direction, `path_steps`, `ticks_ago`, fresh/stale/cold word) and, in limited mode, `surroundings.map_note`; `explorer.sightings[]` (`ticks_ago`, freshness, direction, `path_steps | null`, heading, source) and `explorer.trail`; `team` only lists packmates the ghost can hear or see (nearest 4, each with a `report` taken from that packmate's freshest sighting, never a cell, plus `{ others: N }`); `recent: { path: { moves, back_and_forth }, tally, lifetime, events, progress }`; a shorter rules text (with a fog line in limited mode). A non-standard ghost's priority line is added to `next_move`, `search_approach` and `keep_hunting`. A standard ghost with the toggle off sends exactly the pre-character state. Budget asserted by `measure-memory --who adversary`: average ≤ 5.5 KB, max ≤ 8 KB.
- Move descriptions are plain language and come from the ghost's map facts (the real map, or its known set K in limited mode) plus the adversary fog of war: path distance to the explorer (or to the last-seen cell or approach target) before → after, whether the move keeps or gains line of sight, whether it blocks a corridor or junction, and whether it hits the explorer.
- Memories live on each `Adversary` (`a.memory`) and are all written together to `dungeon-game/adversaries.json` each tick. `Run.view()` exposes them.

## `view().adversaries[]` (v3)

`{ id, pos, mode, visible, character: string /* preset id */, brain: { on: bool, approach: id|null, approach_text, approach_since, objective, latest_action: { choice, probabilities, confidence } | null, last_reason: string|null } }` (`brainView`: `probabilities` come from the private hunt state, the memory's `latest_action` has none)

## Turn (v3)

`playTurn` returns `{ ...ExplorerTurn, events, lost, caughtBy, adversaryTurns: [{ id, dir, decision|null, keep_hunting: number|null, brain: 'on'|'off', apiMs }] }`. The event types are `spotted`, `lost_sight`, `hit`, `caught`, `brain_on`, `brain_off` (with `reason`) and `alerted` (with `by`).

# v4: encounter tactics + sentiment (the explorer stops reflexively running)

Read `AGENTS.md` first; it is the current guide.

## Behaviour
- **Encounter decision replaces the reflex.** When an encounter starts (an adversary becomes visible, or a visible one switches patrol→chase), and when the current tactic stops being viable (e.g. its target is unreachable or the gap fell below the sentiment's minimum), the explorer runs a **decision step**: Jev picks a **tactic** (a new approach). Tactics (ids, each with a short first-person `thought`):
  - `slip_past` "I can slip past!": a known route past/around the adversary toward the frontier/chest that never comes closer than the sentiment's minimum gap, using the speed edge.
  - `run_away` "Run away!": get away, keep escape routes open, avoid dead ends. The escape spot is sticky: kept until reached or no route keeps a gap of 2. A new one is picked among cells reachable at the mood's min gap (then 2, then any) at least 4 steps away, preferring the edge of the known map and corridor/junction cells beyond a room exit. It keeps its goal when the adversary is out of sight, then continues from the frozen chasing sighting, so it can have a target with no adversary visible. Known issue: in a closed room with a close ghost it can still shuttle corner to corner; the answer there is `slip_past` / `face_off`, which `run_away` doesn't decide.
  - `face_off` "Face off.": hold ground in open space, keep a safe gap, and dodge around it as it commits (2× speed), then continue.
  - `hide` "Duck out of sight.": reach a known cell outside the adversary's line of sight before it arrives (LOS over known tiles only).
  - `race_to_chest` "Go for the chest!": only when the chest is seen.
  - `carry_on` "It hasn't seen me, keep going.": only while every visible adversary is patrolling; keep exploring but avoid its sight.
  Code computes each tactic's feasibility as plain-language facts from **known cells + visible adversaries only**: size/shape of the known space around the explorer (room W×H, corridor, junction, exits), adversary distance and bearing, speed (`ADVERSARY_SPEED`), whether a slip-past route exists and its closest approach, the nearest hide cell and whether it is reached first, dead ends, and chest distance. Infeasible tactics are left out of the options.
- **Sentiment.** Jev picks a sentiment **with every approach decision** (encounter tactics, exploration approach switches after reviews, chest spotted, chase over): `scared`, `risk_averse`, `cautious` (default), `curious` (its opposite: drawn to the unknown), `courageous`, `aggressive`. Each sentiment has a code **profile** (`SENTIMENTS`: `min_gap`, `end_ticks`, `priority`, `move_priority`) that directly changes behaviour: tactic feasibility and targets, the gap warning in move descriptions, how many ticks without sight end an encounter, and a priority sentence injected into `next_move`. It is not just a label.
- **Ordering and cost.** A decision step is one extra **sequential** request made just before the normal tick request: request 1 asks `sentiment` (Choice; it sees the state and the encounter facts, and each option says which tactics its minimum gap leaves open here). Coinciding triggers share one sentiment call. Request 2 is the normal tick request with the chosen sentiment in memory, plus `tactic` (Choice), whose answer becomes the approach. `next_move` in that same request is asked speculatively per tactic (`move_if_<tactic>`), so the move on the decision tick already follows the chosen tactic. Ordinary ticks make no extra call.
- **Never** log an encounter tactic as a failed approach in `approach.tried`. Keep the interrupt/resume mechanism.

## Shapes the UI relies on
- `memory.approach.thought`: string ≤ 60 chars, first person, set for **every** approach, exploration ones too (e.g. `nearest_frontier` "Let's check the closest dark edge.").
- `memory.sentiment = { id, since_step }` (the old `profile_note` is gone; the profile text comes from `SENTIMENTS`). `memory.sentiment_history`: last 5 `[{ id, step }]`. Also in memory for the pane: `events`, `encounters`, `landmarks`, `recent` (see the memory shape above).
- `turn.decision = null | { trigger: 'encounter'|'tactic_failed'|'chase_over'|'chest'|'review'|'start', sentiment: { choice, probabilities }, tactic: { choice, probabilities, options } | null, apiMs }`. `turn.move_decision = { choice, probabilities, confidence, options } | null`.
- The bubble key for the explorer is `${approach.id}@${approach.since_step}`. Its text is `approach.thought`, with the sentiment shown as a tag.

# v4: props and wall decor

The **current values in the code take precedence** over numbers in this file. v3's "No props" rule is replaced by this section.

## Layout and ownership (v4)

```
src/props/catalog.js        prop kinds, placement rules, weights (DOM-free, no imports)        -> props-world agent
src/props/place.js          placeProps(dungeon, rand) -> { tiles, props, decor }              -> props-world agent
src/dungeon.js              generateDungeon calls placeProps; Game.publicView adds props, decor -> props-world agent (only these two edits)
scripts/check-props.mjs     placement checks over many seeds (no Jev, no DOM)                 -> props-world agent
public/props/floor-art.js   FLOOR_ART: pixel art for the 7 floor props (DOM-free)              -> floor-art agent
public/props/wall-art.js    WALL_ART: pixel art for the 4 wall decor kinds (DOM-free)          -> wall-art agent
public/props/index.js       buildProps(): rasterises both art files into banded sprites        -> renderer agent
public/app.js, server.js    drawing props/decor and glow; serving /props/*.js                  -> renderer agent
```
Only create or edit the files you own. Every module is zero-dependency ES modules, matching the surrounding code style.

## Kinds (fixed ids, shared by all agents)

Floor props, one cell each:

| id | solid | look (references: images/2.png, images/3.png, images/1.png) |
| --- | --- | --- |
| `shelf` | yes | wooden storage shelf with jars, sacks and bowls of goods (image 3) |
| `crates` | yes | stacked wooden crates with a blue-banded barrel (image 2) |
| `storage_chest` | yes | closed wooden chest with **blue-grey iron bands, no gold** (must not read as the treasure chest) |
| `pots` | no | cluster of 2-3 clay and dark-blue vases (image 2) |
| `skull` | no | skull with a couple of scattered bones |
| `tools` | no | pickaxe and shovel lying on the floor (image 1) |
| `sword` | no | dropped sword with an arrow or two (image 1) |

Wall decor (on a wall's visible face):

| id | look (references: images/4.png, 5.png, 6.png, 2.png) |
| --- | --- |
| `torch` | wall sconce with a flickering flame, casts a warm glow |
| `fireplace` | stone fireplace with burning logs, casts a strong warm glow (image 6) |
| `arch` | dark stone archway opening flanked by small columns (image 4) |
| `gate` | arched barred gate with warm light glowing behind the bars (image 5), faint glow |

## Data (server -> browser)

`generateDungeon` returns the dungeon with two new fields, and `publicView` passes both through:

```js
props: [{ kind, x, y, solid: bool, flip: bool }]   // floor props, sorted by y then x (publicView: `?? []`, hand-built test maps have none)
decor: [{ kind, x, y, face: 'L'|'R' }]             // wall decor, sorted by y then x
```
- **Solid prop cells are `'#'` in `dungeon.tiles`.** All game logic (movement, pathing, line of sight, perception, Jev) treats them as rock. Only the renderer knows they are props.
- `flip: false` = the prop's back is toward `y-1` (front faces the viewer's lower-left). `flip: true` = back toward `x-1` (front faces lower-right). Solid props are free-standing clusters (see Placement rules), so `flip` only orients/mirrors the sprite. Small props get a random flip.
- `face: 'L'` = the face toward `+y` (floor at `(x, y+1)`), the block's left face on screen. `face: 'R'` = toward `+x` (floor at `(x+1, y)`), the right face.

## Placement rules (props-world agent)

- Seeded: `placeProps` gets `rng(seed ^ 0x2c1b3c6d)` from `generateDungeon`, after the layout, start and treasure are chosen. The layout, start and treasure must stay exactly what they were without props. Same seed gives the same props.
- **Solid props** stand in free-standing **clusters of 1-4 4-connected cells** inside room rectangles, off the room's edge ring (never on a room cell touching the room's wall line), so a walkable lane runs behind them and they make hiding spots. Clusters keep a Chebyshev gap of 2 from each other (one free cell between, diagonals included), so they never merge. Each cluster has one `flip` (a row along x is `false`, a column along y is `true`, square shapes random); it only mirrors the sprite. Never in a corridor, never 4-adjacent to a doorway (a room floor cell that touches floor outside the room rectangle), never on or 8-adjacent to the start or treasure, never on the floor cell in front of any decor. After each cluster, all remaining floor must stay one connected region, each room's floor must stay connected inside its own rectangle, and the treasure must stay at a path distance of at least 60% of the farthest reachable cell from start; otherwise skip it. No dead-end pockets: each floor 4-neighbour of a cluster keeps at least 2 floor 4-neighbours. Density: about one cluster per 30 inner room cells (the room minus its edge ring), at most 3 per room. Values live in `catalog.js` (`CLUSTER_*`).
- **Small props** stand on floor cells (rooms, rarely corridors), never on the start, treasure or 4-adjacent to the treasure, never on a solid prop. Roughly one per 25 room cells, at most 3 per room.
- **Wall decor** sits on wall cells (never prop cells) whose decor face touches room floor that is not a solid prop. `fireplace`, `arch` and `gate` need a straight wall run (both neighbours along the wall are also walls with the same floor side) and are at most one of them per room, in rooms at least 6 cells along that wall. `torch` is the common one: 1-3 per room, plus the occasional corridor torch. No two decor items on 4-adjacent wall cells.
- Decor is placed first, then solid props, then small props.

## Art format (art agents)

Same style as `public/sprites.js`: DOM-free string grids, one char per art pixel, `'.'` transparent, one palette per kind.

```js
export const FLOOR_ART = { shelf: { palette, frames: [grid, ...], anchorX, anchorY, emissive: [] }, ... };  // floor-art.js
export const WALL_ART  = { torch: { palette, frames: [grid, ...], frameMs, glow, emissive: [...] }, ... };  // wall-art.js
```
- Iso tile: diamond 32x16 art px; a cell's centre is the diamond centre. A wall block is 11 art px tall; a wall is 1-3 blocks. Wall decor is drawn on the lowest block not hidden by a wall in front. Big decor (fireplace, arch, gate) is 1 or 2 blocks tall (hash of cell + seed, renderer only), clamped to the visible blocks of its wall; WALL_ART entries may give `stretch` (front-view row repeated 11 times for the 2-block variant); `buildProps` also returns `wallTall` / `metaTall`. The knight is 18x24, the ghost 18x20, the treasure chest 12x10.
- **Floor props:** drawn in the same 3/4 isometric pixel style as the characters, authored for `flip: false` (backed onto the wall at the upper right, front facing lower-left). The renderer mirrors for `flip: true`. `anchorX, anchorY` = the pixel that sits on the cell centre (the base of the prop). Solid props up to 28 wide x 30 tall; small props up to 20 x 14 and low to the ground.
- **Wall decor:** authored as a flat **front view** (no perspective). The renderer shears it onto the iso wall face (each column shifted down half a pixel per column for `L`, mirrored for `R`). Width up to 14 px. The bottom row sits on the floor line of the face. Height up to 19 px: the face is 11 px tall, so anything above row 11 from the bottom (a chimney hood, an arch keystone) rises above the wall top.
- `frames`: 1-4 frames, all the same size. `frameMs`: frame time for animated flames (default 260).
- `emissive`: palette chars (flames, glowing light) that the renderer must not darken in the cold, dim light bands.
- `glow` (decor only, optional): `{ x, y, radius, color }`, with x, y in front-view art coordinates, radius in art px. The renderer draws a soft, flickering warm glow there and on the floor in front.
- Palettes should sit next to the existing ones: warm wood browns, cold stone greys, dark navy outlines (`#1b252d`-ish), muted steel, warm flame yellow/orange.

## Rendering (renderer agent)

- `buildProps()` -> `{ floor: { kind: Banded }, wall: { kind: Banded } }`, where `Banded[band]` is a sprite `{ canvas, w, h, anchorX, anchorY, frames? }` for each light band (0..BANDS-1). Non-emissive palette colours are mixed toward the cold navy stone in dim bands, matching the floor and wall ramp.
- Drawing: prop cells are drawn as **floor** (not wall blocks) and do not hide neighbouring wall faces. Floor props are depth-sorted entities (at the same depth they draw before the characters). Decor is drawn right after its wall block. Glow is a flickering additive warm glow, purely visual: it never changes `game.light` or fog.
- **Fog:** a prop or decor item is drawn only when its cell is known (or Reveal map is on, dimmed like the rest), in the light band of its cell. No glow from unknown cells.
- If `public/props/*` fails to load, the game still runs without props (stand-in shapes or nothing).
