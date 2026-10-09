# Jev Dungeon: module contract (v5, classes)

Jev steers an explorer through a pre-generated 2D dungeon one cell at a time (up/down/left/right, or stay).
The explorer wins by stepping on the treasure chest. Every visited cell permanently lights everything
within `LIGHT_RADIUS` (7, Euclidean, no line of sight needed). Lit cells are **known territory**.
Adversaries roam the dungeon. An adversary that sees the explorer gives chase, and a ghost's claw strike costs the
explorer a life (2 at the start; a touch only bumps the ghost back); the game is lost when the last life goes. The explorer can strike back with a sword and raise a shield (skills, below). Reload regenerates everything.

Zero dependencies (Node ≥ 20.12, ES modules). `JEV_API_KEY` is in `../.env` and never reaches the browser. Port 3003 standalone; `hub.js` (port 3000) routes `/arena/<name>/` and `/gym/<name>/` to per-instance `server.js` processes (see AGENTS.md).

**The code is the source of truth.** This file describes it as of the memory redesign on top of the OOP refactor (`Game`, `KnownWorld`, `ExplorerBrain`, `Adversary`, `Run`, injected Jev calls, regrouped explorer state, explorer and adversary memory, settings), plus the skills work (attack and block for both sides, see PLAN-skills.md). Numbers quoted here are the **defaults**: the tunables live in `src/settings.js` and are edited on the `/settings` page. [AGENTS.md](AGENTS.md) is the working guide (rules, checks, caveats); if the two disagree with the code, fix them.

## Layout and ownership

```
dungeon-game/
  server.js, package.json, public/{index.html,app.js,style.css,sprites.js,settings.html,props/*}   -> UI agent (+ art agents)
  src/dungeon.js                     constants, map gen, line of sight, the Game class                -> world agent
  src/jev.js                         Jev API client (askJev, shuffle)                                 -> brain agent
  src/turn.js                        Run: one game in progress (tick, view); newGame / newTestGame    -> adversary agent
  src/testbed.js                     small configurable test arenas (buildArena, normalizeConfig)    -> shared
  src/settings.js                    tunables: schema, validation, per-port persistence, configure hooks -> shared
  src/skills/{skill,attack,block,skill-set,loadouts,question,config,resolve}.js   skills: classes, loadouts, SkillSet, the `skill` question, tunables, strike resolution -> shared (resolve.js is world rules)
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
  src/characters/adversary/morale.js      monster morale M, pure, imports nothing; wired into brain.js / adversary.js behind the monsterMorale toggle (PLAN-monster-morale.md) -> adversary agent
  src/characters/explorer/confidence.js   confidence score C, pure, imports nothing; wired into brain.js behind the confidenceModel toggle; C3 adds the gates, `self.confidence` and the UI meter (PLAN-confidence C1-C3) -> brain agent
  scripts/check-*.mjs                checks (dungeon, adversaries, testbed, props, skills, characters, memory-kit, confidence, duels, request-hashes; no Jev); scripts/lib/duel-harness.mjs the duel harness they and later scripts import; scripts/request-hashes.mjs + scripts/fixtures/request-hashes.json the request-hash baseline (sha256 of every explorer request over 39 scenarios, compared by check-request-hashes.mjs)
  scripts/run-testbed.mjs            testbed runner (no Jev unless --live)
  scripts/measure-memory.mjs, scripts/arenas/{door,open,corridor,explore,ambush,home,pack,charline,skills}.json   request-size and behaviour metrics over fixture arenas (stubbed unless --live; `--who adversary` is stubbed only)
  PLAN-memory.md, PLAN-adversary-memory.md, PLAN-multiplayer.md   plans, not specs of the code (adversary-memory plan: A1-A4 built behind toggles that default to off; A5 superseded by PLAN-skills.md; mood and wait not built, caution reserved)
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
- **Bumps, strikes, no instant loss.** A touch (an adversary on the explorer's cell, whoever stepped in) is a **bump**: the adversary is knocked back off the cell (event `bump`), no life is lost and no grace starts. Only a **strike** takes a life: a hunting ghost's claw strike costs `clawDamage` (1), event `hit`. The game is lost only at 0 lives (`hit` then `caught`). At most one hit per tick; a hit starts `GRACE_TICKS` (4) of protection (a strike during grace flashes with result `protected`). The explorer moves first in a tick: its skill resolves before its step. A win on the explorer's step ends the tick before the adversaries move.
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
//   Dungeon = { seed, width, height, tiles: string[], start: [x,y], treasure: [x,y] | null, rooms: [{x,y,w,h, role?, order?}], props, decor, layout? }
//   (props/decor: see "props and wall decor" below; a testbed arena also sets `testbed: true`.)
//   LAYOUT ('linear' default | 'maze', knob world.layout, configureWorld({ layout })) picks the generator; width and height come first either way.
//   maze: room count and corridor network scale with area. The floor is fully connected and has loops. The treasure is in a room,
//   at a path distance of at least 60% of the farthest reachable cell.
//   linear: a winding main path of rooms over a patch grid, start in the first room, the portal in the last; 2-5 dead-end side rooms
//   and at most one loop around a single path room; organic rooms, corridors 3-6 wide. rooms[i] is the room's bounding box plus
//   role ('start'|'path'|'portal'|'side') and order (index on the main path); layout = { kind: 'linear', patches, links } is hidden
//   state (spawning and checks only, never explorer code). Same seed and layout give the same dungeon.
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
  //   adversaryTicks /* world ticks the adversaries have run */, patrolRand /* patrol RNG, created lazily */,
  //   facing /* 'up'|'down'|'left'|'right', starts 'right': last step's direction or last strike's aim */,
  //   block /* null | { effectiveness, until_step }: the shield stance */,
  //   strikes /* [{ by, from /* attacker's cell when it struck */, cells, result }] this tick, result 'hit'|'blocked'|'protected'|'miss'|'dispelled' */,
  //   skillRand /* block-roll RNG, null until the first roll */,
  //   winBy /* null | 'chest' | 'cleared': how the game was won ('cleared' = the last adversary was dispelled, resolve.js; only in an arena with no portal: where a portal exists only the portal wins) */,
  //   coinPiles /* [[x, y]] one entry per coin on the floor (duplicates = a bigger pile); replaced, never spliced */,
  //   coins /* the explorer's coin total */, coinRand /* coin-drop RNG, null until the first roll */
  // coinPiles starts as a copy of dungeon.coins (src/coins.js spawnCoins; [] when absent, e.g. hand-built maps).
  applyMove(dir)         // -> { moved, stayed?, revealed, revisit, won, coins, healed, regen, respawned }. No-op when won or lost. STAY keeps the cell, counts a step. Hearts due back (heartsTaken, HEART_RESPAWN) respawn before the pickup, except one on the explorer's cell.
                         //    A move picks up every pile on the destination (coins += n, `coins: n` in the return, 0 otherwise).
                         //    A null treasure never wins.
  damage(amount = 1, sourceId = null)  // -> { health, lost }. No-op when won or lost. Sets lost/caughtBy only at health 0.
  skillRandom()          // next number of the per-game block-roll stream (seed ^ 0x2545f491, created on first call; never touches generation rng order)
  coinRandom()           // next number of the per-game coin-drop stream (seed ^ 0x3c6ef372, created on first call)
  clearTickState()       // strikes = []; drops `block` once steps > until_step. Run.playTurn calls it first.
  legalMoves()           // dirs whose destination is floor ([] once won or lost)
  availableMoves()       // legalMoves plus STAY ([] once won or lost)
  isKnown([x,y]), knownTile([x,y]) /* '#' | '.' | null */, knownFloorCount(), exploredPct()
  publicView()           // -> { seed, width, height, tiles, start, treasure, props, decor, pos, steps, won, lost, health, max_health,
                         //      light /* copy */, visits, trail, explored_pct, facing, strikes /* live array */,
                         //      coin_piles /* copies */, coins, won_by }
  twin(overrides = {})   // shallow copy that keeps the prototype (for fog twin tests). `litOutside` must stay a Set.
}
```
Never JSON-clone or spread a `Game`: `litOutside` is a `Set` and the methods live on the prototype. `Game` lives in dungeon.js because `scripts/check-props.mjs` copies that single file to a temp dir, so dungeon.js keeps the line `import { placeProps } from './props/place.js';` byte-identical and no other relative import. Lit cells outside the map count as known `'#'` (rock), so neither `unexplored_by_direction` nor the "would reveal" counts give away where the map ends.

Performance: maps are up to 90×90. Per-tick work should stay cheap (no full-grid scans per candidate move where a BFS bounded by known cells will do).

## `src/characters/adversary/adversary.js` (adversary agent)

```js
export let ADVERSARY_SPEED = 0.6, CHASE_RANGE = 7, MAX_SEARCH_TICKS = 18, ALERT_STEPS = 24, GRACE_TICKS = 4;   // defaults; live bindings
export function configureAdversaries({ speed, chaseRange, maxSearchTicks, graceTicks, alertSteps, floorPerAdversary, maxAdversaries, packAlert, teamSight, keepHuntingMin, adversaryCharacters, limitedMap })
//   called by src/settings.js; any key optional. Private tunables behind it: FLOOR_PER_ADVERSARY 150, MAX_ADVERSARIES 12, PACK_ALERT true, TEAM_SIGHT true;
//   toggles (both default false, apply from the next game): adversaryCharacters (mixed characters at spawn, per-ghost patrol RNG, smart memory and the regrouped state);
//   limitedMap (ghosts know a limited map; acts only together with adversaryCharacters, see limitedActive()). Live bindings CHARACTERS_ON, LIMITED_ON.
//   keepHuntingMin (0.5) lives in adversary/brain.js (KEEP_HUNTING_MIN). MIN_SPAWN_STEPS (20) is fixed.
export class Adversary {
  // Public fields, in this order. This is also its whole JSON shape (skills, facing, hp, stun are private, so still six keys) (adversaries are never spread or cloned).
  id /* 'a1' */, pos /* [x,y] */, mode /* 'patrol'|'chase'|'search' */, budget /* 0 */, lastSeen /* [x,y]|null */, goal /* [x,y]|null */
  constructor({ id, pos, mode = 'patrol', budget = 0, lastSeen = null, goal = null, character = 'standard', kind = 'ghost', level /* 1-3, default defaultLevel(kind); throws otherwise */, hp = skillConfig().ghostHp, skills = 'ghost' })
  //   character: a preset id from character.js; unknown id throws. skills: a SkillSet, a loadout-id list, or 'ghost' | 'none' (buildSkillSet).
  // Private state behind prototype accessors (not own properties, so JSON/Object.keys show only the six fields):
  get character                  // preset id, fixed at spawn ('standard' by default)
  get profile                    // profileOf(traits of the character): every per-ghost number, the priority line and the words for Jev
  get home                       // spawn cell: centre of the patrol territory and of the limited map's home zone
  get hunt                       // brain state (adversary/brain.js newHunt)
  get memory                     // the adversary's plain-JSON memory (adversaries.json)
  get skills                     // the ghost's SkillSet (claw strike by default, no block)
  get facing / set facing        // 4-way: last step's direction or last strike's aim ('down' at spawn); a bad value throws
  get hp, get maxHp, get stun    // hit points, their maximum, stun ticks left
  get kind                       // 'ghost' | 'troll' (kinds.js)
  get level                      // 1-3, fixed at spawn (PLAN-levels); 2 with monsters.levels.enabled false
  get clawDamage                 // lives one of its claw strikes takes, resolved at construction (kind base times the level multiplier)
  tickStun()                     // -> bool: was stunned this tick (counts one tick down)
  takeHit(damage, fromPos, game = null)   // -> { hp, dispelled }. Loses hp; unless it hit 0, knocked 1 cell directly away from fromPos (floor, not fromPos) and stunned skillConfig().stunTicks, budget 0, route cleared. At 0 hp the caller removes it.
  syncSkills()                   // copies SkillSet summaries into memory.skills
  get route / set route          // cached patrol route, or null
  get lastRequestBody / set ...  // exact body of its last Jev request, or null
  lastRequest()                  // that body parsed, or null
}
export function spawnAdversaries(dungeon)        // -> Adversary[]. Seeded via rng(dungeon.seed ^ 0x9e3779b9).
// src/coins.js
export let FLOOR_PER_COIN = 60, MAX_COINS = 30; configureCoins({ floorPerCoin, maxCoins })
export function spawnCoins(dungeon, { count } = {})  // -> [[x, y]] one coin per cell, min(MAX_COINS, round(floor/FLOOR_PER_COIN)) unless count is given,
                                                  //    round-robin over shuffled rooms (linear layout: side rooms take two per round), never on start/chest/small prop. Seeded via rng(seed ^ 0x5be0cd19).
//   count = min(MAX_ADVERSARIES, max(1, round(floorCells / FLOOR_PER_ADVERSARY))) (defaults 12 and 150). They spawn in rooms at a path distance of at least 20 from start
//   and never in the start's sight, spread round-robin over the rooms. Linear layout: the portal room always gets one, each side room one with
//   chance 1/2, the rest over the main-path rooms, denser toward the portal, none in the start room (same stream). With the adversaryCharacters toggle on, characters are then assigned by
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
//   events = [{ id, type: 'spotted'|'lost_sight'|'hit'|'caught'|'bump'|'blocked'|'strike'|'brain_on'|'brain_off'|'alerted', at: [x,y] }]  // 'alerted' also has `by`
//            hit adds `health` (after the hit; only a claw strike makes one); brain_off adds `reason`. `caught` is emitted only right after the life-ending `hit`.
//            bump: a touch knocked the ghost back, no life lost. blocked: the explorer's shield stopped a strike. strike: { id, type, cells, result } (no `at`), one per strike.
//            (`gave_up` is never emitted.)
//   turns  = [{ id, dir, decision|null, keep_hunting: number|null, brain: 'on'|'off', apiMs, skill_decision, stunned?, error? }]
//            skill_decision = null | { choice, probabilities, used: key|null }: set when the `skill` question was asked (also in a skill-only request), else null; `used` is the claw key that was applied, null for `none`, below SKILL_MIN or refused. Browser/API turn data only: never sent to Jev or stored in adversary memory; stunned: true when it lost its tick to a stun.
export { brainView } from './brain.js'
```
`stepAdversaries` order: return at once if the game is won or lost; read grace, then decrement it; stunned ghosts lose a stun tick (`tickStun`); bump check for every adversary in id order before anything moves (knocks back a ghost the explorer stepped onto; no life lost, and the ghost keeps its budget so a bumped ghost can still strike); bump `game.adversaryTicks`; update views; sense; add `ADVERSARY_SPEED` to every budget (a stunned ghost gets none); brain-on, unstunned adversaries with `budget >= 1` call `decide` in parallel from the same snapshot (a stunned ghost makes no call); then in id order each acting ghost does **skill, step, bump check**: a hunting ghost's picked claw strike runs first through `resolveAttack` (block roll, then grace and the one-hit-per-tick latch, then damage; a lethal strike returns at once), then the step (knockback to the previous cell on a bump), then `skills.turnPassed()`. Brain-off ghosts patrol and never strike. Request bodies are built synchronously in id order, so never add an `await` before `buildRequest` in `adversary/brain.js`. `adversary/brain.js` also exports `newHunt(id)` and `decide(game, a, tick, cfg, ask)`.

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
It is the only adversary file (with adversary.js, which owns physics, bump checks, claw strikes and spawning) that may hold a `Game` or touch `dungeon.tiles`; `perception.js`, `brain.js` and `memory.js` take a `view`, never a `game`. Static guard: `scripts/check-dungeon.mjs` section 0b. Never exposed: the treasure, the explorer's light/visits/trail/health, real tiles outside K. In limited mode K is the home zone (spawn room plus cells within `homeRadius` path steps of the spawn cell, computed once), cells seen (fading after `seenTtl`, capped at `seenCap`), cells heard from a call, and the four cells around the ghost; a wall is known only when 8-adjacent to a known floor cell.

## `src/characters/adversary/character.js` (adversary agent)

```js
export const TRAITS /* aggression, persistence, horizon, roaming, pack */, RESERVED_TRAITS /* ['caution'], dormant */, PRESETS /* standard, aggressive, pursuer, ambusher, patient_hunter, short_sighted, timid, territorial, rover */, PRESET_IDS, SPECIAL_IDS
export function profileOf(traits)               // -> every per-ghost number (chaseRange, restTicks, maxSearchTicks, keepHuntingMin, sweepRadius, cutMax, homeRadius, alertSteps, call/team flags, memory sizes and ttls, and the morale knobs moraleStart / moraleRegen / moraleHurt / moralePack), the priority line (<= 300 chars) and words for Jev. All traits 2 = today's constants.
export const strikeLineFor = (level)           // the strike priority line at level 1-3 (monster morale overrides the character's own level with its mood's)
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
export function newGame(seed?, opts = {})        // generateDungeon, then dungeon.coins = spawnCoins(dungeon), then spawnAdversaries -> Run. No Jev calls.
export function newTestGame(config, opts = {})   // buildArena(config) -> Run. Throws TestbedError on a bad config. The config key `characters`
//   ('standard' default | 'mixed' | one preset id | a list, URL form 'ambusher;timid', applied per ghost in id order and cycled) sets the ghosts' characters.
//   opts = { ask, decide, dir, memoryDir, skills, hold, confidence } (all optional; hold and confidence go to the ExplorerBrain). The config keys `explorerSkills`, `ghostSkills`, `ghostHp` (testbed.js) set the explorer's SkillSet
//   (`explorerSkillSetOf(config)`, handed to `new ExplorerBrain(world, { skills })` through the Run) and each ghost's (`ghostSkillSetOf(config)`, `ghostHp ?? skillConfig().ghostHp`):
//     ask       replaces the explorer's Jev call: ({ kind: 'sentiment'|'tick', state, questions, body }) => answers
//     decide    replaces the adversaries' Jev call: ({ id, state, questions, body }) => answers
//     memoryDir URL of the folder for memory.json / memory.md (default: dungeon-game/)
//     dir       URL of the folder for adversaries.json (default: dungeon-game/)
//   A Run without `ask` / `decide` calls the real, paid Jev.
```
`playTurn`:
0. `game.clearTickState()` (strikes emptied, a lapsed block dropped).
1. `explorer = await this.explorer.takeTurn()` (decides, uses its skill, moves, saves memory). The explorer's skill events (`strike`, `struck`, `dispelled`) come from `explorer.skill_events`, which the brain returns every turn (`[]` when no skill was used).
2. `{ events, turns } = await stepAdversaries(game, { decide })`. It first bumps an adversary the explorer stepped onto (knockback only), and does nothing once the game is won or lost. `events` = the explorer's skill events, then a `coin` event `{ id: 'explorer', type: 'coin', at, gained, total }` when `game.coins` rose during the explorer's turn, then the adversaries'.
3. `saveMemories(...)` writes `adversaries.json` (`{ tick, adversaries: memories }`, in `game.adversaries` order).
4. If newly lost, `explorer.noteCaught(game.caughtBy)`; else if a `hit` event fired, `explorer.noteHit(id)`.

`Turn = { ...ExplorerTurn, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns }`.

`view()` = `{ ...game.publicView(), adversaries: [{ id, pos, mode, visible, brain, character, kind, facing, hp, max_hp, level, claw_damage, morale }], explorer: { remark /* string|null: what the explorer just said about a newly sighted weak / too-strong monster */ }, block /* null | { effectiveness, until_step }: the explorer's own shield stance */, grace_ticks, invulnerable /* grace > 0 */, over: won||lost, testbed }`. `publicView` also carries `facing` and `strikes` (`[{ by, from, cells, result }]` of this tick, from both sides). The full adversary list is included for the debug reveal toggle; `visible` = the explorer sees now. `brain` is the adversary-brain view under "v3" below. `character`, `facing`, `hp`, `max_hp`, `level` and `claw_damage` are Reveal-only displays (the explorer never reads them); the UI hides strikes outside the explorer's sight unless Reveal is on.

`view().route` (spectator-only, `src/route.js`; never sent to Jev, never read by explorer code) is `null` without a portal (testbed with `treasure: null`), else:
```
{ progress: number,   // 0..1, 3 decimals: distance / length
  furthest: number,   // 0..1, the best progress so far
  distance: number,   // spine cells from the start (attach index of the explorer's cell, by walking distance)
  length: number,     // spine.length - 1, so distance === length is the portal
  offset: number,     // walking cells off the spine (0 on it; > 3 reads as exploring)
  state: 'advancing' | 'exploring' | 'backtracking' | 'stationary',
  next_waypoint: [x, y] | null,   // up to 6 steps ahead along strictly decreasing walking distance to the portal; null on the portal
  next_dir: 'up' | 'down' | 'left' | 'right' | null,   // the first of those steps
  cue: string | null,             // 'Heading toward the entrance — portal is the other way.' while a retreat is cued
  suppressed: 'over' | 'portal_known' | 'combat' | 'detour' | null,   // why a cue would be held back, in that priority order; 'detour' = approach heal / collect_coins or a player directive
  waypoints: [[x, y], ...] }      // simplified spine (ends and corners), for the debug overlay
```
It is not part of the `playTurn()` return value.

## `src/skills/*` (shared)

Skills are an attack and a block for the explorer, and a claw strike for each ghost. All free to check (`scripts/check-skills.mjs`; the engage hold and its duels: `scripts/check-duels.mjs`, harness `scripts/lib/duel-harness.mjs`, API in its header: `playDuel(opts)` returns `{ strikes, claws, dispelled, ticks, hitsTaken, held, trace }`; `hold` is true | false | 'multi'; also exports `openGroups(count, n, kind)` and `corridorGroup(count, n, kind)` for 2-4 ghost layouts, and `health` sets the real lives). Replaces the old `src/capabilities/` scaffold (`defineCapability`, `feasibleOptions`, `actionQuestion` are gone).

```js
export class Skill {                              // skill.js. One stateful instance per character per skill.
  static kind = 'skill'
  constructor({ id, name, source = '', text = '', cooldown = 0 })  // id snake_case and not 'none'; cooldown a whole number >= 0
  id, name, source /* 'sword'|'shield'|'claw' */, text, cooldown
  get kind, ready, cooldownLeft, uses, lastUsedStep
  markUsed(step), turnPassed()                    // use starts the cooldown; the owner's turn end counts it down
  options(view, self)                             // -> [{ key, fact, target }]; base offers nothing. Reads only its arguments (fog).
  summary()                                       // -> { id, kind, name, text, ready, cooldown_left }
}
export class AttackSkill extends Skill {          // attack.js. kind 'attack'
  constructor({ shape = [[1, 0]], damage = 1, ...rest })   // shape cells are [forward, right]; [[1,0]] = the cell in front
  cells(pos, facing)                              // shape rotated to the aim (walls and off-map cells included; callers drop them)
  options(view, self)                             // needs ready and self.opponentsNear; one { key: `${id}_${dir}`, fact, target: { dir, cells } } per aim whose cells hold a visible opponent (self.visibleOpponents)
}
export class BlockSkill extends Skill {           // block.js. kind 'block'
  constructor({ effectiveness = 0.5, ...rest })   // 0..1
  options(view, self)                             // needs ready and self.threatNear (true or { id, steps }); one { key: id, fact, target: null }
}
export const MAX_SKILLS = 4
export class SkillSet {                           // skill-set.js. Throws over 4 skills or on a duplicate id.
  constructor(skills = [])
  get skills, size
  options(view, self)                             // -> { key: { fact, target, skill } } in skill order; remembers the keys for get()
  get(key)                                        // -> { skill, target } from the latest options() call, else null
  summaries(), turnPassed()
}
export const LOADOUTS                             // loadouts.js: sword_strike (attack 1, cd 1), shield_block (block 0.6, cd 2), fire_strike (area 2, cd 120), claw_strike (attack 1, cd 2)
export const DEFAULT_SETS = { explorer: ['sword_strike','shield_block','fire_strike'], ghost: ['claw_strike'], none: [] }
export class AreaSkill extends AttackSkill          // area.js: kind 'area', shape BLOCK_9X9 (squareBlock(9), centred), minSeen 2; options() -> one option { key: id, fact, target: { dir, cells } }
export function buildSkillSet(kindOrList = 'none', tuning = {})   // numbers: loadout < skillConfig() (settings) < tuning
export const SKILL_MIN = 0.5                      // question.js
export function skillQuestion(options, priorityLine = '', { neutral = false } = {}) // -> a Choice question, `none` first (never shuffled), or null when options is empty; neutral: the explorer's wording (no "choose none unless")
export function pickSkill(answer, options)        // -> the chosen key, or 'none' (not an option, `none`, or probability < SKILL_MIN)
export function configureSkills(values), skillConfig(), skillDefaults(), loadoutTuning()   // config.js: swordDamage 1, swordCooldown 1, shieldChance 0.6, shieldCooldown 2, clawDamage 1, clawCooldown 2, ghostHp 2, stunTicks 2, coinDropChance 0.6
export const EXPLORER = { id: 'explorer' }        // resolve.js
export function resolveAttack(game, attacker, cells, damage, { canHit, onHit, rand } = {})   // -> events
```
`resolveAttack` (world rules: reads and mutates a `Game`; called only from `KnownWorld.useSkill` and `stepAdversaries`): wall and off-map cells are dropped. A ghost's strike on the explorer's cell: if `game.block` is set and `game.steps <= block.until_step` and a `game.skillRandom()` roll is below `effectiveness`, result `blocked` (event `blocked`); else if `canHit()` is false (grace, or already hit this tick), result `protected`; else `game.damage(damage, id)`, `onHit()`, event `hit` (and `caught` on the last life), result `hit`. The explorer's strike on a ghost always lands (no roll): `Adversary.takeHit` (hp, knockback, stun), event `struck` with `hp`, or at 0 hp the ghost is spliced out of `game.adversaries` and `dispelled` is emitted (result `dispelled`); each dispel then rolls `game.coinRandom()` once and, below `skillConfig().coinDropChance`, adds a pile at the ghost's cell and emits `{ id, type: 'coin_drop', at }`. Every call pushes `{ by, cells, result }` to `game.strikes` and returns a `strike` event `{ id, type: 'strike', cells, result }` last.

**The `skill` question.** Asked in the same request as `next_move`, at most one per request (never per tactic, never in the explorer's sentiment request). Explorer gate: some skill is ready and an adversary is visible within 10 cells or a sighting up to 10 steps old lies within 10; the attack then lists only aims that hold a visible adversary, the block needs a visible chaser within 2 path steps. Ghost gate: a hunting ghost with the explorer in sight within 10 cells. With one legal move, a skill-only request is sent instead (dormant for the explorer: `stay` is always legal). The explorer's mind adds a `skill_priority` line. Fog: explorer skill facts use only visible adversaries, its own sightings and its own strike tally, never a ghost's hp, stun or cooldown.

## `src/characters/explorer/*`

### `known-world.js`: `KnownWorld` (world agent)

The explorer's only window on a game (the one explorer file allowed to hold a `Game`, in a private `#game`). Reads are live, never cached, and fog-safe:

```js
new KnownWorld(game)
get pos, steps, visits, health, maxHealth, graceLeft, won, facing, coins   // the explorer's own state (coins: its purse)
get width, height                       // grid size, only for sizing arrays; says nothing about the layout
isKnown(cell), knownTile(cell), knownFloorCount(), legalMoves(), availableMoves()
visibleAdversaries()                    // -> [{ id, pos, mode, distance, hp, maxHp, stun, level, clawDamage }] the explorer sees now (hp: the health bar it sees; level and clawDamage are in-sight reads likewise, PLAN-levels)
get levelsOn                            // whether monsters.levels.enabled is on (config switch, no game state); off, no level reaches matchup() or Jev
seenTreasure()                          // -> the portal cell once lit, else null (also null when there is none)
seenCoins()                             // -> copies of the coin piles on known (lit) cells only
move(dir)                               // the explorer's own step (Game.applyMove)
useSkill(skillSet, key)                 // before the step: an attack turns to its aim (game.facing) and runs resolveAttack (events strike, struck, dispelled);
                                        // a block sets game.block = { effectiveness, until_step: steps + 1 }. Marks the skill used. -> events[] | null (unknown key, not ready, game over)
```
Static guard (`scripts/check-dungeon.mjs`, section 0): every other `src/characters/explorer/*.js` file must not contain `game.x`, `game[...]`, `.dungeon`, dynamic or namespace imports, or imports outside this allowlist: `DIRS, LIGHT_RADIUS, STAY, EXPLORER_LIVES, SIGHT_RANGE` from dungeon.js (`SIGHT_RANGE` is a constant, used only to expire a remembered sighting); `ADVERSARY_SPEED, GRACE_TICKS` from adversary.js; sibling explorer files (including `./confidence.js`, listed explicitly in the allowlist: pure, imports nothing); `../../jev.js`; `node:fs/promises`; the `src/skills/` exports (`buildSkillSet`, `skillQuestion`, `pickSkill`, and the `resolve.js` pair that only `known-world.js` imports). `src/skills/` has its own guard (section 0c): `options()` reads only its arguments.

### `known-map.js`, `encounter.js`, `perception.js` (world agent)

All take a `world` (a `KnownWorld`). Layering, acyclic: `known-map.js` ← `encounter.js` ← `perception.js`.
- `known-map.js`: `key`, `sameCell`, `step`, `neighbours`, `knownFloor`, `plural`, `euclid`, `isFrontier`, `knownDistances` (BFS over known floor), `wouldReveal`, `compass`, `dirWord`, `compass8`, `reachableFrontier`, `pick`.
- `encounter.js`: the encounter model over known floor and visible adversaries only: `threatsOf`, `threatDistance`, `safeDistances` (gap-limited BFS), `goalsAt`, `hiddenFromAll`, `escapeTarget`, `isRoomCell`, `openArea`, `engageTarget(world, threats, { stunned })` (2 steps off a hunting adversary, next to one the explorer stunned; no gap), `hpText` (`'1 of 2 hp'`), `encounterFacts` (the sentence set behind `threats.encounter`), `knownLineOfSight` (supercover over known tiles, **unknown cells block**), `speedPhrase` (derived from `ADVERSARY_SPEED`).
- `perception.js`: `APPROACHES`, `TACTICS`, `isTactic`, `DEFAULT_MIN_GAP`, `exitSeen(world)`, `leaveFacts(world, sit)`, `availableApproaches(world)`, `approachTarget(world, id, { minGap, goal, avoid, exclude, remembered })`, `tacticFeasibility(world, minGap, { exclude })`, `tacticOptions(world, minGap)`, `avoidZone(world, remembered)`, `situation(world, { remembered, landmarks })`, `describeMoves(world, approachId, opts)` and `describeMoveParts(world, approachId, { minGap, goal, avoid, remembered, prev, backAndForth })`. Tactic feasibility lives here, not in encounter.js, because it needs `approachTarget`.
- Exploration approaches: `nearest_frontier` (default), `largest_unexplored`, `far_side`, `collect_coins` (only while a lit pile is reachable: targets the seen pile with the best coins per known-path step, ties by fewer steps then (y, x), skipping the avoid zone while another pile exists; the portal is a wall; thought "Coins! Worth the detour."; when no seen pile is left reachable the brain hands back to `nearest_frontier` with a `policy` record), `go_to_exit` (only once the portal is known; committed automatically on first sighting, including the plan interrupted by an encounter; never offered by `next_approach`). Encounter tactics (`tactic: true`): `slip_past`, `run_away`, `engage` (offered only while the sword is ready; ignores the minimum gap), `hide`, `race_to_exit`, `carry_on` (see "v4: encounter tactics").
- `situation(world, { remembered = [], landmarks = [] })` returns `{ self, surroundings, threats }` (the brain adds `game`, `plan`, `recent` and `self.mind`):
  - `self = { lives, max_lives, hit_protection_steps, coins }`.
  - `surroundings = { here ('room'|'junction'|'corridor'|'dead end'), steps, known_floor_cells /* a count, not a % */, exit /* sentence */, unexplored_by_direction /* none|little|some|a lot per side, fixed 12-cell window */, frontier_cells, landmarks[], coins? }`. A landmark is `{ kind, note, direction, distance, steps_ago }`, `memory.landmarks` made relative to the explorer every tick. `coins` (only while a lit pile is seen) is up to 3 `{ direction, distance, count }`, nearest first.
  - `threats = { visible[], remembered[], encounter }`. `visible` is `[]` or `{ id, direction: 'north-east', distance: 5, chasing: true, hp: '1 of 2 hp', level: 2, claw_lives: 1 }` per adversary in sight (8-point compass words; `hp` is its health bar; `level` and `claw_lives` (lives one claw takes) only with levels on). `remembered` is `{ id, last_seen_steps_ago, was_chasing, hp (as seen then), level and claw_lives (as seen then; levels on only), direction ('here' on the frozen cell), distance }` per frozen sighting not in sight now. `encounter` is `null` unless an adversary is visible.
- `describeMoveParts` returns, per legal move, `{ shared, target }` (or `{ whole }` for a winning move and for `stay`). `shared` is approach-independent: threat sentences, a sentence about the nearest remembered sighting (also "Heads back toward where a chasing adversary was N steps ago (D steps from that spot after this)." for a chasing sighting up to 15 steps old, whatever the distance), chest, reveal estimate, visits, a "Goes back to the cell you left 2 steps ago" fact, dead-end warnings; `target` is progress toward the approach's target. `describeMoves` joins them into one sentence per move. Threat sentences, for example: "Moves toward an adversary", "Steps into the adversary: only bumps it back, no life lost.", "Leads into a known dead end: risk of being cornered", "Heads toward where an adversary was last seen N steps ago", and the gap warning "below your minimum gap of N". Distances to adversaries use BFS over known floor if the adversary's cell is known, else Euclidean. Only visible adversaries count as threats; remembered sightings only produce the "last seen" sentence.

### `confidence.js` (brain agent; PLAN-confidence C1, wired in C2)

Pure, imports nothing, no clock or randomness. State `{ value 0..100 (50 at start), counts { strikes, blocked, evaded, pressed }, enc { chased, hurt, killed, pressed } }`. Exports: `createConfidence({ weights?, model? } = {})` (C4: `weights` overrides some of the `WEIGHTS` object and is kept in the state as `w`; `model: 'beta'` is the weight-free alternative, value = 100 * (landed + 2) / (landed + taken + 4) from `state.beta { landed, taken }`; both keys are absent from the default state), `WEIGHTS`, `apply(state, event, lives, maxLives)` (returns a new state; events `hit` -15, `struck` +6, `dispelled` +12, `blocked` +3 up to 65, `evaded` +4 up to 65, `pressed` -2 at most -8 per encounter, `calm` +0.3 only below 50; then clamp to 0..100 and to `cap`), `cap(lives, maxLives)` (100 at full lives or `maxLives` 1, 45 on the last life, else `round(100 * (0.3 + 0.7 * lives / maxLives))`), `calm(state)`, `band(C)` (`shaken` <30, `unsure` <40, `even` <65, `sure` <80, `dominant`), `gaps(C)` (min_gap delta +2 / +1 / 0 / -1), `engageOpen(C)` (C >= 40), `seeChase(state)` (marks the encounter as having a chasing sighting) and `closeEncounter(state, lives, maxLives)` (the brain's `chase_over`: `evaded` if chased, not hurt, not killed; then a fresh encounter record), and `applyTurn(state, turn, { lives, maxLives, armed, visible, engaging, stunned })`, which derives the events from a turn shape (`skill_events`, `events`, `decision.trigger`). Constants are named at the top of the file. Checked by `scripts/check-confidence.mjs`.

**Capability and mood caps (PLAN-confidence-mood phase 1; pure, not yet used by brain.js).** `capability({ lives, maxLives, clawDamage = 1, swordDamage = 1, steady = true, armed = true, ghosts: [{ hp, weight }] }, wPerExtra = W_PER_EXTRA) -> R` (integer 0..100): `k = sum weight * (0.75 + 0.125 * min(5, ceil(hp / swordDamage)))`, `W = clawDamage * wPerExtra * max(0, k - 1)` when `steady`, else `clawDamage * wPerExtra * k` (an assumption: only sword cooldown 2 was measured), `R = round(100 * (lives - W) / (lives + 1))` clamped, and `min(R, NO_SWORD_MAX)` when not `armed`. `combine(R, H, lives, maxLives) -> C` = `clamp(R + clamp(H - 50, -30, 30), 0, cap(lives, maxLives))`. `allowedMoods(C, { lastLife, swordDown, noSword, current }) -> string[]` in SENTIMENTS order (wary, steady, greedy, bold): wary when C <= `WARY_MAX` or any exception, steady always, greedy when C >= `GREEDY_MIN`, bold when C >= `BOLD_MIN` and not `noSword`; the current mood stays within `CAP_HYST` past its threshold (wary to 40, greedy to 25, bold to 35). `sightWeight(ageSteps) = clamp(1 - age / HIST_SPAN, 0, 1)`. Constants: `W_PER_EXTRA = 0.35` (owner's default: three 2-hp ghosts at 2 lives read 43, 'even'), `W_PER_EXTRA_SAFE = 0.5` (the measured worst case; the plan's table), `HIST_SPAN = 30`, `WARY_MAX = 35`, `BOLD_MIN = 40`, `GREEDY_MIN = 30`, `CAP_HYST = 5`, `NO_SWORD_MAX = 20`. `apply()` and the event weights are unchanged.

**Wiring (C2, toggle off by default).** `new ExplorerBrain(world, { ask, memoryDir, skills, hold, confidence })`; `Run` / `newGame` / `newTestGame` pass `opts.confidence` through, `server.js` passes `true` for the confidenceModel setting, `'display'` (tracked and shown as the UI bar, gates and request text unchanged: byte-identical requests, `check-confidence-wiring.mjs` section 12) for the confidenceMeter setting (default on), else false (settings `confidenceModel`, default off, and `confidenceMeter`, default on; Explorer group, both `when: 'next'`). With either on: `memory.progress.confidence = { value, counts { strikes, blocked, evaded, pressed } }` (absent with it off; `validateMemory` checks it when present, `LIMITS.confidenceCount`; `memory.md` has a Confidence line), and the turn shape gains `confidence: { value, band, delta, reason }`. Hooks: `noteHit` (hit), `#useSkill` (struck, dispelled), `noteBlocked()` (a new brain method; `Run.playTurn` calls it for each `blocked` event unless the game was just lost), `#encounterPolicy` (seeChase while a visible ghost has mode `chase`; `closeEncounter` at `chase_over`), and at the end of each turn calm (nothing in sight) or pressed (a visible chasing ghost within 2 steps by `threats.visible[].distance`, the sword not ready at the start of the tick, the approach not `engage`, the ghost not stunned by the explorer's own strike). **C3 (gates and the word, toggle on only; with it off nothing changes).** `brain.js` exports `effectiveGap(base, C)`, `effectiveSentiment(id, C)` and `effectiveProfile(memory, C)`: the mood's `min_gap` plus `gaps(C)` (never below 2 when lowered), and its `priority` / `move_priority` lines with "at least N steps" templated from that gap (byte-identical while the gap is the base; `C` null returns the `SENTIMENTS` entry itself). Every reader of the gap uses it: `tacticFeasibility`, `approachTarget` and `describeMoveParts` callers, `#tacticFailing`, `#keepEscapeGoal`, the move questions' safety lines, the tactic question's "keeps adversaries N+ steps away", and the sentiment question's "Effect: min gap N" and "Tactics it leaves here" (per mood, at its effective gap). `engage` is offered only if the sword is ready and `engageOpen(C)` (C >= 40); engage keeps its gap of 1. Jev reads `self.confidence = '<floor(value)> <band>'` on every request and, in the sentiment question's instructions only (exported `CONFIDENCE_SENTENCE`, not in `rules()`), one sentence saying it sums up how the fights went while `threats` and the tactic facts say how this one stands. No new memory event per change; no sentiment option removed or reordered. In the neutral zone (C 40..79) every gate is the identity: `check-request-hashes.mjs` diffs toggle on against toggle off request by request while C stays there, after removing `self.confidence` and the sentence. The UI shows a meter (bar plus `<value> <band>`) from `turn.confidence`, hidden when absent. Events use own state only (own lives, strikes, shield, sight), so a hidden ghost never changes C (fog twin in `check-confidence-wiring.mjs`).

The brain's `confidence` option may be `true` (default weights) or such an object (`new ExplorerBrain(world, { confidence: { weights: { hit: -25 } } })`); it exists for C4's sweep, the server only passes `true`. `scripts/calibrate-confidence.mjs` (C4) and `scripts/lib/fight-executor.mjs` are described in AGENTS.md; results are in PLAN-confidence.md "C4 results".

`scripts/measure-confidence.mjs` (C0) drives the real brain through `newGame` / `newTestGame` and feeds each turn to `applyTurn` passively; results are in PLAN-confidence.md "C0 results". `scripts/lib/duel-harness.mjs` also exports `clawDecide` (the clawing ghost stub) and `mulberry32`.

### `memory.js` + `brain.js`: `ExplorerBrain` (brain agent)

```js
export class ExplorerBrain {
  constructor(world, { ask = null, memoryDir = null, skills = 'explorer', hold = true, confidence = false } = {})  // confidence: false | true | { weights?, model? } (PLAN-confidence, below); hold: the engage hold (AGENTS.md, P7a), true | false | 'multi' (also holds against 2-3 ghosts in sight, PLAN-confidence-mood phase 2; false only in the duel checks); builds the initial memory (runs approachTarget); null ask = real Jev; skills: a SkillSet, a loadout-id list or 'explorer' | 'none'
  get memory()                                 // plain JSON object, saved as memory.json; Jev reads a regrouped state built from it (below)
  async takeTurn()                             // -> ExplorerTurn
  get remark()                                 // string|null: the one-line remark on a monster sighted this tick (`remarkLine` of the weak_target / too_strong pool), else null; shown as view().explorer.remark
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
  progress { steps, known_floor_cells, revealed_since_approach, steps_since_approach, revisits_last_10, coins, confidence? /* { value, counts } only with the confidenceModel toggle on */ },
  sentiment { id, since_step }, sentiment_history[{ id, step }],
  recent { moves[], cells[], back_and_forth },
  encounters { count, escaped, hits, dispelled, last_at_step },
  events[{ step, text }],
  landmarks[{ kind, cell, step, note }],
  skills[{ id, kind, name, text, ready, cooldown_left }] }   // <= 4 (LIMITS.skills), text <= 120; rewritten from the live SkillSet before every save, never read back
```
`objective`, `findings`, `latest_action`, `danger` and `sentiment.profile_note` no longer exist. Limits (`LIMITS`): approach text 240, `tried` 5, thought 60, `sentiment_history` 5, `events` 6 (text 200, oldest dropped, the step never repeated in the text), `landmarks` 8 (note 120; kinds `chest`, `dead_end_explored`, `hit_here`, `hiding_spot_used`; one per kind + cell, the chest is never evicted), `recent.moves` 6, `recent.cells` 8. `recent.back_and_forth` counts moves that returned to the cell two positions back. `encounters.count` / `escaped` / `hits` count encounters begun, ended unhurt, and hits taken. The remembered sightings are **not** in memory: they are a private field of the brain.

**Jev state (explorer).** Memory is not sent verbatim. Every explorer request carries `state = { game, self, surroundings, threats, plan, recent }`:
- `game`: `rules()`, a sentence block saying that adversaries roam, move slower (derived from `ADVERSARY_SPEED`), chase on sight, that a touch only bumps and an adjacent adversary's claw costs `clawDamage` lives (`EXPLORER_LIVES`, `GRACE_TICKS` of protection afterwards), what `threats.visible` / `threats.remembered` mean (with each health bar), and, with an attack skill, what it does (always hits an adjacent adversary, its damage, knockback and the `stunTicks` stun, gone at 0 hp, "may drop a coin" (the chance is never stated; the clause is left out at `coinDropChance` 0), the stun giving the next strike before a claw (claimed only with `stunTicks` >= 2 and the sword's cooldown below `stunTicks`), the claw's `clawCooldown` recharge and the shield's `shieldChance`), then "Besides moving you may use one skill (`self.skills`) per step." The objective opens it: only stepping through the portal wins; advance toward it, dispelling obstacles and pursuers, or slipping past when fighting would prevent arrival. Coins are the score; at 0 lives they are lost.
- `self`: `situation().self` plus `skills` (a compact map `{ id: 'ready' | 'ready in N' }`, to stay inside the size bounds) plus `mind: { id, since_step, recent }` (`recent` = the last 5 picks as runs, "steady×3 → wary").
- `surroundings`: `situation().surroundings`, plus `moves` (`{ dir: shared facts }`, sent once) on a decision tick that asks tactic questions.
- `threats`: `situation().threats` (on the request with the `tactic` question, `encounter` leaves out `slip_past`, `hide`, `run_away` and `exit`: the tactic options state them). `plan`: `{ approach { id, current, since_step, interrupted | null }, tried[{ id, steps, reason }] }` (`tried` is left out of the request with the `tactic` question). A coin switch and the hand-back from `collect_coins` write no `tried` row (`changeApproach` in memory.js): they are not failures.
- `recent`: `{ path /* compass words */, back_and_forth, revealed_since_approach, steps_since_approach, revisits_last_10, encounters, events }`.
- Request size: the largest explorer decision tick is about 9-10 KB (9436 / 10389 B measured with skills); `check-dungeon.mjs` asserts ≤ 9500 bytes (a chasing adversary, 5 tactics) and ≤ 10500 (a patrolling one, 6 tactics). About 60-110 B of headroom.

**Minds.** `SENTIMENTS` has exactly four moods: `wary` (min_gap 4, end_ticks 5; getting away), `steady` (3, 4; the plan, the default before the first pick), `greedy` (3, 2; loot) and `bold` (2, 1; the fight). They replaced scared, risk_averse, cautious, curious, courageous and aggressive; `MOOD_IDS` in memory.js is the only list validation accepts. Each also has `priority` (a line in `next_move` and `tactic`), `move_priority` (the same rule, short, for the speculative `move_if_<tactic>` questions), `when` (its upside, its risk and the circumstances that call for it, shown in the sentiment question), `note` and `skill_priority`. `profileOf(memory)` returns the current profile.

- `next_move` priorities: (1) with `go_to_exit` / `race_to_exit`: step onto the portal, else head for it; otherwise take a safe step through the portal to win, rather than delaying for exploration or loot; (2) while threats are visible, never step into one, avoid moves below the sentiment's `min_gap`, plus the current tactic's hint; (3) do not head toward where an adversary was last seen (when `threats.remembered` is non-empty); (3b) while a pile is seen (`surroundings.coins`): "Coins are the score: a step toward a seen pile beats revealing new cells unless an adversary is near."; (4) the sentiment's priority line; (5) avoid `stay`, follow the approach, reveal new cells, avoid backtracking. The speculative per-tactic questions keep only the portal line, the safety line and the mind's `move_priority`.
- **Remembered sightings.** The brain freezes each adversary in `visibleAdversaries()` as `{ id, cell, step, chasing, hp, maxHp, level, clawDamage }` and drops it after `REMEMBER_STEPS` (30) steps or when the explorer sees the frozen cell empty. The ones not in sight form `threats.remembered`, a per-move "last seen" fact, and an avoid zone (`avoidZone`) that exploration targets steer around: known cells within 10 known-path steps of a sighting under 10 steps old, or 6 of one up to 15 steps old, plus a sector for the 3 latest chasing sightings (known cells nearer the sighting than the explorer, and cells whose shortest route from the explorer runs through the frozen cell). `approachTarget`'s `exclude` (cell keys not to pick) and `remembered` (the sightings) feed `run_away`.
- **Triggers** of a decision tick (`turn.decision.trigger`): `start`, `encounter`, `tactic_failed`, `chase_over`, `exit`, `review`. A pending `start` / `exit` / `review` decision and an `encounter` on the same tick share **one** sentiment call (the encounter wins). `tactic_failed` fires when the tactic's target is gone, when the gap fell below `min_gap` (not for `run_away`), or on **back-and-forth** (`PINGPONG_FAILS` = 3 moves since the last decision returning to the cell just left; the bounce cells and the old target are then excluded from the re-decision's targets, until the encounter starts or ends); at most once per `REDECIDE_COOLDOWN` (3) ticks.
- Coin move fact (in the shared per-move part, so sent once on decision ticks): for the nearest seen pile by known path, only when it is within 8 steps, "Toward 3 seen coins (2 steps after this)." on each move that closes in (no "away" fact; "Picks up N coins." for the step onto a pile). **Coin decision**: the first time a pile is seen within 8 known-path steps (at least 10 steps after the last coin decision, no tactic on, not leaving, not on a review or `leave_now` tick, which delay it) the tick's request also carries a `next_approach` Choice over the available exploration approaches (current one included, `collect_coins` among them); a pick other than the current approach with probability >= 0.5 switches at once, with no `approach_working`. It is asked only on a decision tick: the `coins` sentiment trigger (P4) asks the mood first, or another trigger's sentiment call that tick serves. `collect_coins` is also offered in review `next_approach`.
- Approach reviews (every `REVIEW_EVERY` = 8 steps; `approach_working` below 0.5 switches) do not run during `go_to_exit` or any tactic. First sighting of the portal commits to `go_to_exit` immediately. An active tactic keeps its encounter behavior, but its interrupted plan becomes `go_to_exit`; player directives remain active. Pending review/coin answers cannot undo this commitment. The turn carries a `{ from, to: 'go_to_exit', reason }` policy without adding a `plan.tried` failure. Legacy `leave_now` remains a compatibility fallback and asks whether to head to the portal to win, not whether to abandon clearing.
- `ExplorerTurn = { step, dir, forced, revealed, won, move_decision, held, decision, review, policy, skill_decision, apiMs }`. `held` (boolean) is true when the engage hold chose `stay` itself: no move question, `move_decision` null (so `forced` is true), `dir` `'stay'`; the skill question may still have gone out. `policy: { from, to, reason } | null` is for code-driven approach switches, separate from `review`. `skill_decision = null | { choice, probabilities, used: key | null }`: set when a `skill` question was asked; `used` is the key that was applied (`null` for `none`, below `SKILL_MIN`, or refused by the world).

### Player directive (PLAN-inject)

- `POST /api/inject { text }` -> `200 { directive, queued }` | `400 { error, max_chars? }` | `403` (setting `injectEnabled` false) | `409` (no game / game over) | `429 { error, retry_in_ms }`. Empty text clears. Policy: `Run.submitDirective(text, { maxChars = 140, steps = 20, cooldownMs = 10000, now })` returns `{ status, body }`; `sanitiseDirective(text)` is exported from `turn.js`.
- Settings (Player group, live): `injectEnabled` true, `injectMaxChars` 20..140 (140), `injectSteps` 1..100 (20), `injectCooldownS` 0..120 (10).
- `Run`: `directive` (getter), `inject(text, { steps })`, `clearDirective(reason)`. `ExplorerBrain`: `directive` getter, `setDirective(text, { steps })`, `clearDirective(reason)`.
- Shape: `{ text, from_step, until_step, steps_left }` in `turn.directive`, `view().directive`, the `/api/step` response and `/api/state` game; `memory.directive = { text, from_step, until_step } | null` (text <= `LIMITS.directive` 140).
- Jev state while live: `state.directive = { text, steps_left, from_step }`; `plan.approach.id = 'directive'` with the real approach in `interrupted`; extra Noul `directive_done` (ordinary tick request only, every 5 steps; > 0.5 ends it). Trigger `directive` (sentiment merged under the one-call rule). Events: `Heard: ...`, `Directive ended: <reason>`.

## `server.js` + `public/*` (UI agent)

- Uses `newGame`, `newTestGame` from `./src/turn.js` only, and holds one `Run`. `POST /api/new` → `{ game: run.view(), memory }`; an optional body `{ testbed: {...} }` builds a testbed arena (400 on a bad config). `POST /api/step` → `{ game, memory, turn }`, or 409 once over, with no game, or while a step is running. `GET /api/state` → `{ game: view|null, memory|null }`. Static files come from the `STATIC` whitelist in server.js: a new file in `public/` must be registered there. `TESTBED=<query or JSON>` makes the server a testbed. `GET /settings` serves `public/settings.html`; `GET /api/settings` → `{ schema, values, defaults, pending }`; `POST /api/settings` with `{ values }` saves `settings-<PORT>.json` and applies the live knobs now (the `next` knobs, `pending` until a new game, apply on the next `POST /api/new`); 400 with `{ error }` on a bad value. The schema is `SCHEMA` in `src/settings.js`.
- **Settings page:** the `⚙ Settings` button (next to Start and Reload) goes to `/settings`, a standalone page (`public/settings.html`, inline CSS and JS) that builds its rows from `GET /api/settings`: a slider plus number field per numeric knob, a checkbox per toggle, a `live` / `next game` badge on each, **Save** (disabled until something changed) and **✕** (closes, asking before it discards unsaved edits). A save applies live knobs at once; knobs marked `next game` show "saved" until the next `POST /api/new`. The Adversaries group has two `next game` toggles, both off by default: **Ghost characters** (`adversaryCharacters`: mixed characters at spawn, per-ghost patrol RNG, smart memory) and **Limited ghost map** (`limitedMap`: ghosts know only their home zone and what they have seen; ignored without Ghost characters).
- **Bigger maps:** the board is a camera viewport that follows the explorer, centred and clamped to map edges. It must not shrink a 90×90 map to fit. A minimap of known cells (explorer, chest when known, visible adversaries, viewport outline) sits in a corner of the board or the pane.
- **Taller board:** the board stretches down to the bottom of the window. The control pane sits beside it and scrolls on its own. On narrow screens the board takes about 70dvh.
- Ghosts are drawn only when `visible` (or always, dimmed, with "Reveal map"). A chasing one has a red glow, one with its brain on a cyan marker. The HUD adds the map size (`W×H`), hearts for `health`/`max_health` and a status chip (Safe / Chased / Caught, derived from the game view, not from memory). The pane shows explorer memory (UI pane: events / encounters / landmarks / recent, plus the approach thought and mind; the UI agent owns the details), and turn events go into a short log (a `hit` event logs in red and flashes the board; the knight blinks while `invulnerable`).
- Overlay: "Jev escaped" (portal win; "Dungeon cleared" for the portal-less testbed cleared win) or "Jev lost all lives" (loss), with steps, explored %, approaches used, time, and a Reload button that starts a new level automatically.
- **Look (v3): isometric 8-bit.** `public/sprites.js` holds the pixel art, `public/app.js` + `style.css` the renderer.
  - Projection: `TW = 32`, `TH = 16` art px; `sx = (x-y)*TW/2`, `sy = (x+y)*TH/2`, measured at the cell centre. Floor = diamond tile; wall = raised block 1 or 2 `WALL_H = 11` blocks tall (renderer-only, `hash(x, y, seed ^ 0x5a17) < 0.25 ? 2 : 1` per cell, so a quarter of the walls are 2 blocks; not in `publicView`; floors stay flat) with a lit top and two darker side faces. Drawn in `x+y` order with entities inserted at their cell's depth.
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
- `stepAdversaries` itself detects the explorer stepping onto an adversary (the bump check runs before anything moves). Patrol routes are cached on the `Adversary`.

# v3: bigger rooms, and adversaries with their own Jev brains

## Rooms

Room width and height are each a random integer from 4 to 15, chosen independently. The room count per area drops to match. The minimum map must still fit at least 4 rooms, so generation may allow overlap retries or fewer rooms. Every other generation guarantee stays as before, and adversary spawns stay feasible.

## Adversary brains (fully agentic)

Every adversary has its own Jev brain, and **the brain is on only while the adversary is hunting**:
- **off (patrol):** the code wanders, with no Jev calls.
- **on:** it switches on when `startsChase` fires (event `brain_on`). While on, every adversary step is a Jev Choice over its legal directions. Each tick the adversary is either in sight of the explorer (`mode: 'chase'`) or hunting from memory (`mode: 'search'`).
- While searching, the brain also gets a `keep_hunting` Noul each step: "Is it still worth hunting the explorer?" If the answer is below 0.5 (`KEEP_HUNTING_MIN`), the brain switches off (event `brain_off`, reason recorded). The adversary stops chasing and goes back to code patrol. Code also switches it off after `MAX_SEARCH_TICKS` (18) without sight. Alerted ghosts count `ALERT_STEPS` (24) in path steps.
- **Pack hunting.** When an adversary spots the explorer (`startsChase`), every patrolling adversary within `ALERT_STEPS` (24) path steps joins in `search` mode with `last_seen` at the explorer's cell (events `alerted` with `by`, then `brain_on`; only while `PACK_ALERT` is on, and alerted ghosts do not alert further). While hunting, an adversary also tracks the explorer through any hunting packmate's sight (team sight, `TEAM_SIGHT`), so it stays in `chase` mode and gets the explorer's position while a packmate sees it. In sight, each move option states how many of the explorer's reachable cells (within 12 steps) the move cuts off, and how many of those no other adversary covers.
- Movement keeps the speed budget, at most 1 step per tick. Only adversaries whose brain is on and that have a step this tick make a Jev call. Their calls for one tick are **made in parallel** from the state after the explorer's move, then applied in id order (skill, step, bump check). Two adversaries may share a cell, but never the living explorer's.
- **Adversary fog of war:** by default adversaries know the real map (tiles, rooms, their own position and the other adversaries' positions), read through an `AdversaryView` in `full` mode. With the `limitedMap` toggle (off by default, and only together with `adversaryCharacters`) a ghost knows only its limited map K (home zone, fading seen cells, cells heard from a call, the four cells around it; see the AdversaryView section); a spot with no known route has `path_steps: null` and the brain heads for the edge of what it knows. In both modes they know the explorer's position **only while `seesExplorer` is true** (or a hunting packmate sees it, with `TEAM_SIGHT`). Otherwise they know only `last_seen` (cell + ticks ago + the direction the explorer was heading when last seen), plus, with memory on, frozen sightings. They never know the treasure location or what the explorer has explored.
- **Per-adversary memory** (`createMemory(id, character)` in adversary/memory.js, validated by `validateMemory`): `{ id, character: { id }, objective, brain: { on, since_tick, last_reason }, approach: { id | null, current, since_step, tried[{ id, steps, reason }] }, tally: { sightings, lost_sight, hits, alerts_heard }, events[{ tick, text }], progress: { ticks_hunting, ticks_since_seen, distance_trend }, latest_action: null | { choice, confidence, forced, fallback }, skills[{ id, kind, name, text, ready, cooldown_left }] /* <= 4, mirror of the ghost's SkillSet, rewritten each tick by syncSkills, always present */, sightings[{ cell, tick, heading, source: 'seen'|'called', by? }], recent: { moves[], cells[], back_and_forth }, landmarks[{ kind, cell, tick, note }], lifetime: { hunts, escapes, hits, last_hunt_end_tick } }`. The last four are filled only while the `adversaryCharacters` toggle is on (ticks as units; sightings stored only when the explorer moved at least 3 cells from the newest, newest first; landmark kinds `home` (pinned), `explorer_seen`, `explorer_lost`, `explorer_hid`, `hit_here`, `area_checked`, and **`chest` throws**; capacities and ttls come from the character's `horizon`; `lifetime` is never reset, and with the toggle on `events` are kept across hunts). `findings` is gone: `tally` (counters) and `events` (at most 5: first sighting, called for help, a hit, "Gave up: reason"; text ≤ 200, the tick never repeated in the text) describe the **current hunt** and are reset when the brain switches on. `approach.id` is `null` exactly while the brain is off, and `tried` holds only the outcomes of search approaches. `latest_action` has **no probabilities** (validation rejects the key); they sit in the private hunt state and `brainView` still returns them for the UI. The objective is "Catch the explorer before it finds the treasure". There are 3 approaches: `direct_pursuit` (close the path distance), `cut_off` (head for the junction or corridor the explorer is most likely to pass through next, judged from its heading and the map), and `sweep_last_seen` (search outward from the last-seen cell). Code sets `direct_pursuit` while the explorer is in sight. When sight is lost, Jev picks between `cut_off` and `sweep_last_seen` with a Choice on the first search tick. `noteHit(a, tick)` (adversary/brain.js) is called from `strikeWith` in adversary.js when a claw strike takes a life: it bumps `tally.hits` and adds an event.
- **Jev state (adversary)** (`jevState` in adversary/brain.js): `{ game, tick, self: { id, position, mode, approach, latest_action }, surroundings, explorer, last_seen, [approach_target, checked_cells_near_last_seen], team: [{ id, direction, path_steps, role }], recent: { tally, events, progress } }`. `explorer` holds a position, direction, `path_steps` and `heading` only while in sight (else `{ in_sight: false }`); `last_seen` is `{ cell, ticks_ago, heading, direction, path_steps } | null`; `approach_target` and `checked_cells_near_last_seen` appear only while searching; `team[].role` is `pursuing`, `searching` or `patrolling`. With the `adversaryCharacters` toggle on the state is regrouped: `self.character { id, traits (words), style }` (also sent for any non-standard ghost), `surroundings.landmarks[]` (direction, `path_steps`, `ticks_ago`, fresh/stale/cold word) and, in limited mode, `surroundings.map_note`; `explorer.sightings[]` (`ticks_ago`, freshness, direction, `path_steps | null`, heading, source) and `explorer.trail`; `team` only lists packmates the ghost can hear or see (nearest 4, each with a `report` taken from that packmate's freshest sighting, never a cell, plus `{ others: N }`); `recent: { path: { moves, back_and_forth }, tally, lifetime, events, progress }`; a shorter rules text (with a fog line in limited mode). A non-standard ghost's priority line is added to `next_move`, `search_approach` and `keep_hunting`. A standard ghost with the toggle off sends exactly the pre-character state. Budget asserted by `measure-memory --who adversary`: average ≤ 5.5 KB, max ≤ 8 KB.
- Move descriptions are plain language and come from the ghost's map facts (the real map, or its known set K in limited mode) plus the adversary fog of war: path distance to the explorer (or to the last-seen cell or approach target) before → after, whether the move keeps or gains line of sight, whether it blocks a corridor or junction, and whether it hits the explorer.
- Memories live on each `Adversary` (`a.memory`) and are all written together to `dungeon-game/adversaries.json` each tick. `Run.view()` exposes them.

## `view().adversaries[]` (v3)

`{ id, pos, mode, visible, character: string /* preset id */, kind: 'ghost'|'troll', facing, hp, max_hp, level: 1-3, claw_damage: number /* lives per claw */, morale: null | { value, tier, mood } /* monster morale; null with the toggle off; Reveal-only display, never read by the explorer */, brain: { on: bool, approach: id|null, approach_text, approach_since, objective, latest_action: { choice, probabilities, confidence } | null, last_reason: string|null } }` (`brainView`: `probabilities` come from the private hunt state, the memory's `latest_action` has none)

## Turn (v3)

`playTurn` returns `{ ...ExplorerTurn, events, lost, caughtBy, adversaryTurns: [{ id, dir, decision|null, keep_hunting: number|null, brain: 'on'|'off', apiMs, skill_decision: null|{ choice, probabilities, used }, stunned? }] }`. The event types are `spotted`, `lost_sight`, `hit` (a claw strike took a life; adds `health`), `caught`, `bump` (a touch), `blocked` (a shield stopped a strike), `strike` (`{ id, type, cells, result }`, from either side), `struck` (the explorer hit a ghost; adds `hp`), `dispelled` (a ghost reached 0 hp and left the game), `cleared` (the dispelled ghost was the last one in an arena with no portal: the game is won; `id` 'explorer', `at`), `coin_drop` (a dispelled ghost left a coin; `at`), `coin` (the explorer picked up coins; `at`, `gained`, `total`), `brain_on`, `brain_off` (with `reason`), `alerted` (with `by`) and `routed` (monster morale: morale collapsed, so the monster breaks off; adds `morale`, and a `brain_off` with reason `routed: ...` follows). `struck` and `dispelled` come from `resolveAttack` and are not yet in the turn's `events` (see AGENTS open issues).

# v4: encounter tactics + sentiment (the explorer stops reflexively running)

Read `AGENTS.md` first; it is the current guide.

## Behaviour
- **Encounter decision replaces the reflex.** When an encounter starts (an adversary becomes visible, or a visible one switches patrol→chase), and when the current tactic stops being viable (e.g. its target is unreachable or the gap fell below the sentiment's minimum), the explorer runs a **decision step**: Jev picks a **tactic** (a new approach). Tactics (ids, each with a short first-person `thought`):
  - `slip_past` "I can slip past!": a known route past/around the adversary toward the frontier/portal that never comes closer than the sentiment's minimum gap, using the speed edge.
  - `run_away` "Run away!": get away, keep escape routes open, avoid dead ends. The escape spot is sticky: kept until reached or no route keeps a gap of 2. A new one is picked among cells reachable at the mood's min gap (then 2, then any) at least 4 steps away, preferring the edge of the known map and corridor/junction cells beyond a room exit. It keeps its goal when the adversary is out of sight, then continues from the frozen chasing sighting, so it can have a target with no adversary visible. Known issue: in a closed room with a close ghost it can still shuttle corner to corner; the answer there is `slip_past` / `engage`, which `run_away` doesn't decide.
  - `engage` "Have at you!": fight with the ready sword. Hold two steps from a hunting enemy so it approaches into strike range; close on one stunned by the explorer's strike; strike an adjacent enemy. Facts derive strikes needed from visible hp and explain that dispelling permanently removes the enemy and its pursuit. No fact promises a win from dispelling. Priorities favour manageable fights that clear the way, with possible coins when enabled; regrouping serves renewed advance. No minimum gap. A lost life triggers a `hit` re-decision next tick.
  - `hide` "Duck out of sight.": reach a known cell outside the adversary's line of sight before it arrives (LOS over known tiles only).
  - `race_to_exit` "Go for the portal!": only when the portal is seen.
  - `carry_on` "It hasn't seen me, keep going.": only while every visible adversary is patrolling; keep exploring but avoid its sight.
  Code computes each tactic's feasibility as plain-language facts from **known cells + visible adversaries only**: size/shape of the known space around the explorer (room W×H, corridor, junction, exits), adversary distance and bearing, speed (`ADVERSARY_SPEED`), whether a slip-past route exists and its closest approach, the nearest hide cell and whether it is reached first, dead ends, and chest distance. Infeasible tactics are left out of the options.
- **Sentiment.** Jev picks a sentiment **with every approach decision** (encounter tactics, exploration approach switches after reviews, portal spotted, chase over, new coins nearby (`coins`), a dispel (`dispelled`)): `wary`, `steady` (default), `greedy`, `bold`. The question is what to go after: safety, the plan, loot or the fight. Each sentiment has a code **profile** (`SENTIMENTS`: `min_gap`, `end_ticks`, `priority`, `move_priority`) that directly changes behaviour: tactic feasibility and targets, the gap warning in move descriptions, how many ticks without sight end an encounter, and a priority sentence injected into `next_move`. It is not just a label.
- **Ordering and cost.** A decision step is one extra **sequential** request made just before the normal tick request: request 1 asks `sentiment` (Choice; it sees the state and the encounter facts, and each option says which tactics its minimum gap leaves open here). Coinciding triggers share one sentiment call. Request 2 is the normal tick request with the chosen sentiment in memory, plus `tactic` (Choice), whose answer becomes the approach. `next_move` in that same request is asked speculatively per tactic (`move_if_<tactic>`), so the move on the decision tick already follows the chosen tactic. Ordinary ticks make no extra call.
- **Never** log an encounter tactic as a failed approach in `approach.tried`. Keep the interrupt/resume mechanism.

## Shapes the UI relies on
- `memory.approach.thought`: string ≤ 60 chars, first person, set for **every** approach, exploration ones too (e.g. `nearest_frontier` "Let's check the closest dark edge.").
- `memory.sentiment = { id, since_step }` (the old `profile_note` is gone; the profile text comes from `SENTIMENTS`). `memory.sentiment_history`: last 5 `[{ id, step }]`. Also in memory for the pane: `events`, `encounters`, `landmarks`, `recent` (see the memory shape above).
- `turn.decision = null | { trigger: 'encounter'|'tactic_failed'|'chase_over'|'hit'|'exit'|'review'|'coins'|'dispelled'|'start', sentiment: { choice, probabilities }, tactic: { choice, probabilities, options } | null, apiMs }`. `turn.confidence = { value, band, delta, reason }` only with the confidenceModel toggle on. `turn.move_decision = { choice, probabilities, confidence, options } | null`.
- The bubble key for the explorer is `${approach.id}@${approach.since_step}`. Its text is `approach.thought`, with the sentiment shown as a tag.

# v4: props and wall decor

The **current values in the code take precedence** over numbers in this file. v3's "No props" rule is replaced by this section.

## Layout and ownership (v4)

```
src/props/catalog.js        prop kinds, placement rules, weights (DOM-free, no imports)        -> props-world agent
src/props/place.js          placeProps(dungeon, rand) -> { tiles, props, decor }              -> props-world agent
src/dungeon.js              generateDungeon calls placeProps; Game.publicView adds props, decor -> props-world agent (only these two edits)
scripts/check-props.mjs     placement checks over many seeds (no Jev, no DOM)                 -> props-world agent
public/props/floor-art.js   FLOOR_ART: pixel art for the 11 floor props (DOM-free)              -> floor-art agent
public/props/wall-art.js    WALL_ART: pixel art for the 5 wall decor kinds (DOM-free)          -> wall-art agent
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
| `anvil` | no | small iron anvil |
| `goblet` | no | stone chalice brazier with blue flames (animated, blue glow) |
| `fountain` | yes | stone fountain with blue water (animated, blue glow); picked only for one-cell clusters |
| `forge` | yes | one big brick furnace with a fire mouth, flue and bellows (animated, warm glow) over a block of 4-6 solid cells (2x2, 2x3 or 3x2); see Placement rules |

Wall decor (on a wall's visible face):

| id | look (references: images/4.png, 5.png, 6.png, 2.png) |
| --- | --- |
| `torch` | wall sconce with a flickering flame, casts a warm glow |
| `fireplace` | stone fireplace with burning logs, casts a strong warm glow (image 6) |
| `arch` | dark stone archway opening flanked by small columns (image 4) |
| `gate` | arched barred gate with warm light glowing behind the bars (image 5), faint glow |
| `banner` | big: red tattered banner on a pole, 1 or 2 blocks tall (`stretch`), no glow |

## Data (server -> browser)

`generateDungeon` returns the dungeon with two new fields, and `publicView` passes both through:

```js
props: [{ kind, x, y, solid: bool, flip: bool, w?, h?, part? }]   // floor props, sorted by y then x (publicView: `?? []`, hand-built test maps have none)
decor: [{ kind, x, y, face: 'L'|'R' }]             // wall decor, sorted by y then x
```
- **Solid prop cells are `'#'` in `dungeon.tiles`.** All game logic (movement, pathing, line of sight, perception, Jev) treats them as rock. Only the renderer knows they are props.
- `flip: false` = the prop's back is toward `y-1` (front faces the viewer's lower-left). `flip: true` = back toward `x-1` (front faces lower-right). Solid props are free-standing clusters (see Placement rules), so `flip` only orients/mirrors the sprite. Small props get a random flip.
- **Forge footprint.** A forge is one furnace over a `w` x `h` block of solid cells (`w, h` = 2x2, 2x3 or 3x2): one `props` entry per cell, all `kind: 'forge'`, `solid: true`, the same `flip`. The anchor (top-left cell: min `x`, min `y`) also carries `w` and `h`; the other cells carry `part: true`. All cells are `'#'` like any solid prop. Rendering: art `forge_<w>x<h>` (`forge_<h>x<w>` mirrored when `flip`), cut into 16 px strips along the front faces, each strip drawn at the depth of its footprint cell (so actors pass in front of and behind the right parts); the glow sits at the fire mouth.
- `face: 'L'` = the face toward `+y` (floor at `(x, y+1)`), the block's left face on screen. `face: 'R'` = toward `+x` (floor at `(x+1, y)`), the right face.

## Placement rules (props-world agent)

- Seeded: `placeProps` gets `rng(seed ^ 0x2c1b3c6d)` from `generateDungeon`, after the layout, start and treasure are chosen. The layout, start and treasure must stay exactly what they were without props. Same seed gives the same props.
- **Solid props** stand in free-standing **clusters of 1-4 4-connected cells** (plus the forge, below) inside room rectangles, off the room's edge ring (never on a room cell touching the room's wall line), so a walkable lane runs behind them and they make hiding spots. Clusters keep a Chebyshev gap of 2 from each other (one free cell between, diagonals included), so they never merge. Each cluster has one `flip` (a row along x is `false`, a column along y is `true`, square shapes random); it only mirrors the sprite. Never in a corridor, never 4-adjacent to a doorway (a room floor cell that touches floor outside the room rectangle), never on or 8-adjacent to the start or treasure, never on the floor cell in front of any decor. After each cluster, all remaining floor must stay one connected region, each room's floor must stay connected inside its own rectangle, and the treasure must stay at a path distance of at least 60% of the farthest reachable cell from start; otherwise skip it. No dead-end pockets: each floor 4-neighbour of a cluster keeps at least 2 floor 4-neighbours. Density: about one cluster per 30 inner room cells (the room minus its edge ring), at most 3 per room. Values live in `catalog.js` (`CLUSTER_*`).
- **Small props** stand on floor cells (rooms, rarely corridors), never on the start, treasure or 4-adjacent to the treasure, never on a solid prop. Roughly one per 25 room cells, at most 3 per room.
- **Wall decor** sits on wall cells (never prop cells) whose decor face touches room floor that is not a solid prop. `fireplace`, `arch`, `gate` and `banner` need a straight wall run (both neighbours along the wall are also walls with the same floor side) and are at most one of them per room, in rooms at least 6 cells along that wall. `torch` is the common one: 1-3 per room, plus the occasional corridor torch. No two decor items on 4-adjacent wall cells.
- **Forge** (`FORGE_*` in catalog.js): placed **last**, after small props, so every other prop stays exactly where it would be. A room with at least 4x4 cells inside its edge ring (area at least 20) and fewer than `CLUSTER_MAX` clusters gets one with chance `FORGE_ROOM_CHANCE` (about 0.5 per dungeon), shape and flip chosen on a private stream keyed on the room's geometry and the start cell (no `rand()` draws). Its cells follow every solid-prop rule above (inside the edge ring, off doorways, never on or next to the start or treasure, not in front of decor, no dead ends, connectivity, treasure distance) and also avoid small props. The one-cell forge no longer exists: where the cluster code picks `forge` for a single cell, a `crates` is placed instead (same draw).
- Decor is placed first, then solid props, then small props, then forges.

## Art format (art agents)

Same style as `public/sprites.js`: DOM-free string grids, one char per art pixel, `'.'` transparent, one palette per kind.

```js
export const FLOOR_ART = { shelf: { palette, frames: [grid, ...], anchorX, anchorY, emissive: [] }, ... };  // floor-art.js
export const WALL_ART  = { torch: { palette, frames: [grid, ...], frameMs, glow, emissive: [...] }, ... };  // wall-art.js
```
- Iso tile: diamond 32x16 art px; a cell's centre is the diamond centre. A wall block is 11 art px tall; a wall is 1 or 2 blocks (a quarter are 2). Wall decor is drawn on the lowest block not hidden by a wall in front. Big decor (fireplace, arch, gate, banner) is 1 or 2 blocks tall (hash of cell + seed, renderer only), clamped to the visible blocks of its wall; WALL_ART entries may give `stretch` (front-view row repeated 11 times for the 2-block variant); `buildProps` also returns `wallTall` / `metaTall`. The knight is 18x24, the ghost 18x20, the treasure chest 12x10.
- **Floor props:** drawn in the same 3/4 isometric pixel style as the characters, authored for `flip: false` (backed onto the wall at the upper right, front facing lower-left). The renderer mirrors for `flip: true`. `anchorX, anchorY` = the pixel that sits on the cell centre (the base of the prop). Solid props up to 28 wide x 30 tall; small props up to 20 x 14 and low to the ground.
- **Wall decor:** authored as a flat **front view** (no perspective). The renderer shears it onto the iso wall face (each column shifted down half a pixel per column for `L`, mirrored for `R`). Width up to 14 px. The bottom row sits on the floor line of the face. Height up to 19 px: the face is 11 px tall, so anything above row 11 from the bottom (a chimney hood, an arch keystone) rises above the wall top.
- `frames`: 1-4 frames, all the same size. `frameMs`: frame time for animated flames (default 260).
- `emissive`: palette chars (flames, glowing light) that the renderer must not darken in the cold, dim light bands.
- `glow` (decor, and floor props `goblet`, `fountain`, `forge_*`; optional): `{ x, y, radius, color }`, with x, y in front-view art coordinates, radius in art px. The renderer draws a soft, flickering warm glow there and on the floor in front.
- Palettes should sit next to the existing ones: warm wood browns, cold stone greys, dark navy outlines (`#1b252d`-ish), muted steel, warm flame yellow/orange.

## Rendering (renderer agent)

- `buildProps()` -> `{ floor: { kind: Banded }, wall: { kind: Banded } }`, where `Banded[band]` is a sprite `{ canvas, w, h, anchorX, anchorY, frames? }` for each light band (0..BANDS-1). Non-emissive palette colours are mixed toward the cold navy stone in dim bands, matching the floor and wall ramp.
- Drawing: prop cells are drawn as **floor** (not wall blocks) and do not hide neighbouring wall faces. Floor props are depth-sorted entities (at the same depth they draw before the characters). Decor is drawn right after its wall block. Glow is a flickering additive warm glow, purely visual: it never changes `game.light` or fog.
- **Fog:** a prop or decor item is drawn only when its cell is known (or Reveal map is on, dimmed like the rest), in the light band of its cell. No glow from unknown cells.
- If `public/props/*` fails to load, the game still runs without props (stand-in shapes or nothing).

## Confidence tiers and moods (PLAN-moods)

Confidence caps are the only model. `ExplorerBrain` always tracks C = `combine(capability(...), history)`; `confidence` in its options is only an arm object `{ start?, wPerExtra?, weights?, model?, fixedMood? }` for checks. `confidence.js` exports, besides the history model and `capability` / `combine` / `sightWeight`: `REGEN` (0.25), `REGEN_WAIT` (10), the `regen` event (history moves toward 50, only after `REGEN_WAIT` ticks without a change; state gains `idle`), `tierOf(C, prev)` ('low' <= 35, 'midlow' 36..49, 'mid' 50..69, 'high' >= 70, 5 points of hysteresis), `retreatTier(tier)` (true for low and midlow: the tiers whose tactic menu keeps `run_away`, `hide` and `race_to_exit` beside a forward tactic), `panicNext(C, wasPanic)` (enter < 20, leave >= 25), `TIER_MOODS`, `tierOfMood(id)`, `allowedMoods(C, { lastLife, swordDown, current })` and `defaultMood(list)`. The moods are `panic`, `wary`, `guarded` (low), `cautious`, `steady`, `bold` (midlow), `steady`, `greedy`, `bold` (mid), `bold`, `fearless` (high); `tacticFeasibility(world, minGap, { ..., retreat })` drops the retreat tactics when `retreat` is false and a forward tactic (`engage`, `slip_past`, `carry_on`) is open; `MOOD_IDS` in memory.js lists all eight. `turn.confidence` = `{ value, band, delta, reason, capability, history, tier, panic }`. See AGENTS.md "Confidence, tiers and moods". The sections above on the toggle, `calm`, `gaps` and `engageOpen` describe the retired model and are kept only as history.

## Monster morale (PLAN-monster-morale.md)

The ghost-side twin of the explorer's confidence, behind the `monsterMorale` toggle (`monsters.morale.enabled`, default off, `when: 'next'`). With it off nothing changes: no morale state, no request text, byte-identical monster requests.

`src/characters/adversary/morale.js` (pure, imports nothing; on the section 0b allowlist, so no guard changes):

```js
export function createMorale({ start, regen, hurt })   // state { value /* history H */, baseline, hurt, regen, idle, counts, hunt }
export const moraleOf = (profile)                      // the same from a character profile (moraleStart / moraleRegen / moraleHurt)
export function apply(state, event, hp, maxHp)         // -> new state; events: clawed, wounded ({ type, damage }), blocked, shrugged,
                                                       //    packmate_lost, help_came, cornered, slipped, gave_up, regen
export function startHunt(state)                       // a new hunt: clears the per-hunt slip budget, never the score
export function cap(hp, maxHp)                         // 100 at full hp, LAST_HP_CAP (40) on the last one, else 100*(0.3+0.7*hp/maxHp)
export function capability({ hp, maxHp, strikesToDispel, armed, stunned, support, packWeight })   // R, 0..100
export function combine(R, H, hp, maxHp, baseline)     // M = clamp(R + clamp(H - baseline, -SPAN, SPAN), 0, cap(hp, maxHp))
export function tierOf(M, prev), routNext(M, wasRout), band(M), moodFor(M, prev), moodKnobs(mood, profile)
export const MOODS, MOOD_IDS, TIER_MOODS, DEFAULT_MOOD /* 'stalking' */, EVENT_IDS
export function configureMorale(o); export const moraleSnapshot
```

`brain.js` adds `queueMorale(a, event)` (a no-op with the toggle off), `applyMorale(a, tick, { hp, maxHp, strikesToDispel, armed, stunned, support, cornered })` -> `{ value, band, tier, mood, rout, entered } | null`, `moraleWord(a)` and `moodKnobsOf(a)`; the hunt state gains `morale`, `moraleQueue`, `mood`, `tier`, `rout` and `knobs`; the memory gains `morale` (`null`, or `{ value, baseline, tier, mood, counts }`, validated). `Adversary` gains no public field: it still has exactly six keys.

Moods (two per tier plus `rout`): low `skittish`, `cagey`; mid `stalking` (the identity row: exactly today's numbers), `pressing`; high `relentless`, `frenzied`. Each row moves `keepDistance`, the strike line level, `keepHuntingMin`, `maxSearchTicks`, whether it calls for help and which search approach it leans to — `knobsOf()` in adversary.js reads them. `rout` is entered by code below M 12 and left at 20 (lower than the explorer's panic on purpose: a monster has less survival instinct): the monster breaks off (`turnOff`, so `mode` goes to `patrol` — no new `mode` value, and the explorer never reads a fleeing monster as chasing) and will not hunt again for `ROUT_REST` ticks.

Jev reads only `self.morale` ("48 steady"), the mood's priority line, one `keep_hunting` clause and a survival sentence in `rules()`. `game.dispelled` (`[{ id, at }]`, cleared by `clearTickState`) carries the tick's dispels so `stepAdversaries` can send the death cry to every monster within sight or earshot.

# Enemy levels (PLAN-levels)

`src/characters/adversary/kinds.js` exports: `KINDS`, `KIND_IDS`, `kindOf(id)`, `assignKinds(seed, count, trollShare)`, `kindsFor(spec, seed, count)`, and for levels `LEVEL_RANGE` (`{ ghost: [1, 2], troll: [2, 3] }`, frozen), `LEVELS` (`[1, 2, 3]`), `configureLevels(o)` / `levelsSnapshot()` (keys `levelsEnabled`, `levelHpMult`, `levelDmgMult`, `levelWeightGhost`, `levelWeightTroll`; fed by `config/runtime.js`), `levelsOn()`, `clawMult(level)`, `defaultLevel(kind)` (2 clamped into the range), `assignLevels(seed, kinds)` (stream `seed ^ 0x3c6ef372`, one draw per monster in order, levels off = all `defaultLevel`), `levelsFor(spec, seed, kinds)` (testbed `levels`: `'random'` | number | list cycled) and `levelStats(kind, level)` -> `{ hp, clawDamage }` (throws unless level is an integer 1-3; levels off = the kind base).

`Adversary` has `level` and `clawDamage` accessors (private state, still six public keys). `view().adversaries[]` has `level` and `claw_damage`; `view().explorer.remark` is `string|null`. Explorer side: `KnownWorld.visibleAdversaries()` carries `level` / `clawDamage`, `KnownWorld.levelsOn`; `encounter.js` exports `matchup(world, th, damage) -> 'weak'|'even'|'too_strong'` (strikes = ceil(hp/damage), claws = ceil(lives/clawDamage); weak: strikes 1 and claws > cautionClaws; too_strong: claws <= cautionClaws and strikes > 1; levels off or no level: 'even'), `remarkLine(kind, n)`, `explorerRemarkDefaults()` and `configureExplorerEncounter({ levelCautionClaws, the_weak_target, the_too_strong })`. Jev requests: `threats.visible[]` and `threats.remembered[]` entries gain `level` and `claw_lives` (levels on only; off, requests are byte-identical to the game without levels). Knobs: `monsters.levels.{enabled, hpMult, dmgMult, weights.ghost, weights.troll, cautionClaws}` and the text pools `ui.thoughts.explorer.{weak_target, too_strong}`. Testbed key `levels` (default 2).

Explorer decision telemetry: `turn.decision.sentiment.options` lists the actual mood eligibility menu; `automatic` is true for code-selected panic or a sole eligible mood, false for a Jev choice. Returned probabilities are recorded separately. This telemetry does not enter Jev requests or persistent memory.
