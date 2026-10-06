# Jev Dungeon: module contract (v2, adversaries)

Jev steers an explorer through a pre-generated 2D dungeon one cell at a time (up/down/left/right).
The explorer wins by stepping on the treasure chest. Every visited cell permanently lights everything
within `LIGHT_RADIUS` (4, Euclidean, no line of sight needed). Lit cells are **known territory**.
Adversaries roam the dungeon. An adversary that sees the explorer gives chase, and the game is lost
if one catches it. Reload regenerates everything.

Zero dependencies (Node ≥ 20.12, ES modules). `JEV_API_KEY` is in `../.env` and never reaches the browser. Port 3003.

## Layout and ownership

```
dungeon-game/
  server.js, package.json, public/{index.html,app.js,style.css}    -> UI agent
  src/dungeon.js                     world: map gen, tiles, lighting, explorer movement, line of sight -> world agent
  src/jev.js                         Jev API client (shared, unchanged; owned by brain agent)
  src/turn.js                        one world tick + new game + browser view                       -> adversary agent
  src/characters/adversary/adversary.js   adversary spawning, senses, state machine, movement      -> adversary agent
  src/characters/explorer/perception.js   what the explorer can sense, as plain-language facts      -> world agent
  src/characters/explorer/memory.js       explorer memory (memory.json/memory.md)                   -> brain agent
  src/characters/explorer/brain.js        Jev decisions for the explorer                            -> brain agent
  scripts/check-dungeon.mjs          map + fog-of-war checks                                        -> world agent
  scripts/check-adversaries.mjs      adversary behaviour checks (no Jev calls)                      -> adversary agent
```
Only create or edit the files you own. The explorer files were just moved into `src/characters/explorer/` and their relative imports already fixed. `server.js` and `scripts/check-dungeon.mjs` still import the old paths, and their owners will fix that.

## Conventions

- A cell is `[x, y]`. `x` runs from 0 to `width-1`, `y` from 0 to `height-1`, and **y points down**. A cell's key is `` `${x},${y}` ``. `tiles[y][x]` is `'#'` or `'.'`.
- `DIRS = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }`.
- Time is turn-based. One **tick** = the explorer's one step plus the adversaries' moves for that tick.
- **Map size varies per level.** `width` and `height` are each a random integer from 35 to 150, chosen independently and drawn from the seed. There are no `WIDTH`/`HEIGHT` constants any more: always use `dungeon.width`/`dungeon.height`.
- **Fog of war stays a hard rule.** Jev may only see two things: known cells, and adversaries the explorer can currently *see* (see Sight). Adversaries the explorer cannot see must never influence anything sent to Jev.
- **Sight (symmetric).** An adversary and the explorer see each other when `hasLineOfSight(dungeon, a, b)` is true **and** their Euclidean distance is `<= SIGHT_RANGE` (7). Line of sight is physical: walls block it, and it uses the real tiles, not light.
- **Chase rule.** An adversary that sees the explorer switches to `chase`. While chasing, it moves along the true shortest floor path toward the explorer (adversaries know the map). When it loses sight, it goes to `search`: it walks to `lastSeen`, and if it doesn't see the explorer again it goes back to `patrol`. `patrol` wanders between random room cells.
- **Speed.** Adversaries move at 0.5 of the explorer's speed. Each tick an adversary gains 0.5 to `budget` and moves one step per whole point (1 step every 2 ticks). Patrolling adversaries use the same speed.
- **Caught.** The game is lost when an adversary occupies the explorer's cell. This is checked after the explorer moves (stepping into an adversary counts) and after every adversary step. The explorer moves first in a tick. A win on the explorer's step ends the tick before the adversaries move.

## `src/dungeon.js` (world agent)

```js
export const LIGHT_RADIUS = 4, SIGHT_RANGE = 7, MIN_SIZE = 35, MAX_SIZE = 150;
export const DIRS;
export function rng(seed)                       // -> () => float in [0,1)   (mulberry32, exported for adversary spawning)
export function generateDungeon(seed = randomSeed()) // -> Dungeon
//   Dungeon = { seed, width, height, tiles: string[], start: [x,y], treasure: [x,y], rooms: [{x,y,w,h}] }
//   Room count and corridor network scale with area. The floor is fully connected and has loops. The treasure is in a room,
//   at a path distance of at least 60% of the farthest reachable cell. Same seed gives the same dungeon.
export function createGame(dungeon)              // -> Game (as before, plus adversaries: [], lost: false, caughtBy: null)
//   Game = { dungeon, pos, steps, visits, light /* [y][x] */, knownCount, floorCount, won, lost, caughtBy, trail, adversaries: [] }
export function isFloor(dungeon, [x,y])          // -> bool (real tiles; for adversary movement, never for explorer perception)
export function floorDistances(dungeon, from)    // -> Map<key, steps> over real floor (adversary pathing)
export function hasLineOfSight(dungeon, a, b)    // -> bool. Bresenham/supercover between cell centres; any '#' strictly between blocks
export function legalMoves(game)                 // -> dirs whose destination is floor ([] once won or lost)
export function applyMove(game, dir)             // -> { moved, revealed, revisit, won }  (no-op when won or lost)
export function isKnown(game, cell), knownTile(game, cell), knownFloorCount(game), exploredPct(game)
export function publicView(game)                 // -> { seed, width, height, tiles, start, treasure, pos, steps, won, lost,
//                                                 light /* rounded to 2 decimals */, visits, trail, explored_pct }
```
Performance: maps are up to 150×150. Per-tick work should stay cheap (no full-grid scans per candidate move where a BFS bounded by known cells will do).

## `src/characters/adversary/adversary.js` (adversary agent). Pure code, no Jev.

```js
export const ADVERSARY_SPEED = 0.5;
export function spawnAdversaries(dungeon)        // -> Adversary[]. Seeded from dungeon.seed (via rng(dungeon.seed ^ 0x9e3779b9)).
//   count = clamp(round(floorCells / 700), 1, 8). They spawn in rooms at a path distance of at least 20 from start
//   and never in the start's sight.
//   Adversary = { id: 'a1', pos: [x,y], mode: 'patrol'|'chase'|'search', budget: 0, lastSeen: [x,y]|null, goal: [x,y]|null }
export const CHASE_RANGE = 7;                    // separate from SIGHT_RANGE on purpose (see below)
export function seesExplorer(game, adversary)    // -> bool (SIGHT_RANGE + hasLineOfSight, symmetric)
export function startsChase(game, adversary)     // -> bool. Trigger for patrol/search -> chase. Currently seesExplorer && distance <= CHASE_RANGE.
//   The user wrote "has a direct line of sight ... and is at least 7 steps away". We build "within 7" pending confirmation,
//   so the trigger must be a one-line change, and sight must stay its own function and constant.
export function visibleAdversaries(game)         // -> [{ id, pos, mode, distance /* euclidean, 1 decimal */ }] that the explorer sees now
export function stepAdversaries(game)            // mutates game.adversaries (and game.lost/caughtBy) -> events
//   events = [{ id, type: 'spotted'|'lost_sight'|'gave_up'|'caught', at: [x,y] }]
```

## `src/turn.js` (adversary agent). The world tick, which the server uses.

```js
export function newGame(seed?)                   // -> { game, memory }: generateDungeon + createGame + spawnAdversaries + brain.newRun
export async function playTurn(game, memory)     // -> Turn
//   1. explorer = await brain.takeTurn(game, memory)        (explorer decides + moves; returns ExplorerTurn)
//   2. If the explorer stepped onto an adversary, then lost. Else if not won: events = stepAdversaries(game)
//   3. If caught: brain.noteCaught(game, memory, adversaryId) records it in memory and saves
//   Turn = { ...ExplorerTurn, events, lost: game.lost, caughtBy: game.caughtBy }
export function view(game)                       // -> { ...publicView(game), adversaries: [{ id, pos, mode, visible }] , over: won||lost }
//   The full adversary list is included for the debug reveal toggle. `visible` = the explorer sees it now.
```

## `src/characters/explorer/perception.js` (world agent)

Same exports as before (`APPROACHES`, `treasureSeen`, `availableApproaches`, `approachTarget`, `describeMoves`, `situation`), adapted to variable map size, plus:
- `APPROACHES.escape = { text: 'An adversary is chasing: get away from it, keep escape routes open, and avoid dead ends.', needsThreat: true }`. `availableApproaches` lists `escape` only while a visible adversary is in `chase` mode.
- `situation(game).threats`: `[]`, or one entry per visible adversary, `{ direction: 'north-east', distance: 5, chasing: true }`. Directions use 8-point compass words.
- `describeMoves` adds threat sentences when any adversary is visible, for example: "Moves away from the chasing adversary (6 steps between you after this)", "Moves toward an adversary", "Steps into the adversary: caught", "Leads into a known dead end: risk of being cornered". Distances to adversaries use BFS over known floor if the adversary's cell is known, else Euclidean. Only visible adversaries count (via `visibleAdversaries`).
- `approachTarget(game, 'escape')`: a reachable known floor cell that maximises (adversary distance − own distance), preferring cells that have more than one exit.

## `src/characters/explorer/memory.js` + `brain.js` (brain agent)

Memory keeps the v1 shape and adds `danger: { status: 'safe' | 'chased', since_step, adversaries_seen: number }`.
`brain.js` keeps `newRun`, `takeTurn`, `lastRequest`, and adds `noteCaught(game, memory, adversaryId)`.
- **Code policy:** when a visible adversary is chasing, switch approach to `escape` (reason "chased by an adversary") unless the approach is `go_to_treasure` and the chest is closer than the chaser. When no adversary has been visible for 3 ticks, switch back to the approach that was interrupted (reason "lost the chaser").
- `next_move` priorities: (1) step onto the chest if possible; (2) when chased, never move toward or into an adversary or into a dead end, and keep the distance growing; (3) approach; (4) reveal new cells; (5) avoid backtracking. `RULES` must say that adversaries roam, move slower (1 step per 2 of yours), chase on sight, and that being caught loses the game.
- Findings: "Spotted an adversary to the north-east, 6 steps away (step N).", "Escaped the chaser (step N).", "Caught by adversary a2 at step N."
- Approach reviews do not run while escaping.

## `server.js` + `public/*` (UI agent)

- Uses `newGame`, `playTurn`, `view` from `./src/turn.js` only. `POST /api/new` → `{ game: view, memory }`. `POST /api/step` → `{ game: view, memory, turn }`, or 409 once over or while a step is running. `GET /api/state`.
- **Bigger maps:** the board is a camera viewport that follows the explorer, with fixed-size cells (~18 px) centred on the explorer and clamped to map edges. It must not shrink a 150×150 map to fit. Add a small minimap of known cells, with the explorer, the chest when known and visible adversaries, in a corner of the board or the pane.
- **Taller board:** the board pane stretches down to the bottom of the window (`height: calc(100dvh - <header>)` or flex). The control pane sits beside it and scrolls on its own. On narrow screens the board takes about 70dvh.
- Adversaries are red circles, drawn only when `visible` (or always, dimmed, with "Reveal map"). A chasing one gets a ring. The HUD adds the map size (`W×H`) and a status chip (Safe / Chased). The pane shows `memory.danger`, and turn events go into a short log.
- Overlay: "Treasure found" (win) or "Caught by an adversary" (loss), with steps, explored %, approaches used, time, and a Reload button that starts a new level automatically.
- **Look (v3): isometric 8-bit.** Spec below; `public/sprites.js` holds the pixel art (sprites agent), `public/app.js` + `style.css` the renderer (UI agent).
  - Projection: `sx = (x-y)*TW/2`, `sy = (x+y)*TH/2`, `TW = 2*TH`. Floor = diamond tile; wall = raised block (~0.6 tile tall) with a lit top and two darker side faces, stone-brick texture. Drawn in `x+y` order with entities inserted at their cell's depth.
  - Pixel look: render to a low-res offscreen buffer, blit at integer scale with smoothing off, camera snapped to whole art pixels.
  - Palette: known cells ramp by `light` (0.2..1) from cold navy stone (0.2) to warm amber/ochre torchlit stone (1.0, where the explorer walked). Unknown cells get a navy floor glow by distance to the nearest known cell, fading to black over ~5 cells, with no wall shapes (fog of war; Reveal map overrides). Quantized to ~6-8 bands.
  - No props (superseded by v4: props and wall decor). The chest stays (gameplay). Trail is warm-tinted and subtle.
  - Characters: explorer = 8-bit knight with an oversized helmet (red plume, shield, red cape). Adversary = grey, red-eyed ghost with a torn cloth body, hovering (bob + floor shadow); chasing adds a red glow. Every character mirrors left/right by its latest screen-x direction of travel (`right`/`up` = faces right, `left`/`down` = faces left), keeping the last facing when it didn't move.
  - `sprites.js`: `export function buildSprites()` -> `{ knight, ghost, chest }`, each `{ canvas, w, h, anchorX, anchorY }` (anchor at the feet / hover point, art drawn facing right). Optional `frames: [...]` of the same shape for idle animation.

## Deviations agreed during the v2 build

- `game.knownFloor` is a running count of known floor cells. `game.litOutside` is a **Set** of lit cells beyond the map edge, so never JSON-clone a game, because that breaks `isKnown` near the edges.
- Lit cells outside the map count as known `'#'` (rock), so neither `unexplored_by_direction` nor the "would reveal" counts give away where the map ends. `unexplored_by_direction` uses a fixed 12-cell window.
- Line of sight is supercover: a line passing exactly through a corner needs both side cells open, so you can't see through a diagonal gap between walls.
- Memory adds `approach.interrupted: { id, approach, since_step, reason } | null`, which holds the approach parked during an escape. Escape interruptions never go into `tried`.
- ExplorerTurn adds `policy: { from, to, reason } | null` for code-driven approach switches, separate from `review`.
- `stepAdversaries` itself detects the explorer stepping onto an adversary. Patrol routes are cached in a WeakMap.
- Findings eviction never drops the treasure-chest finding.

# v3: bigger rooms, and adversaries with their own Jev brains

The **current values in the code take precedence** over numbers written earlier in this file. For example, `ADVERSARY_SPEED` is now 0.65, a deliberate edit by the user. Don't revert values you find in the code.

## Ownership (v3)

| Files | Owner |
| --- | --- |
| `src/dungeon.js`, `scripts/check-dungeon.mjs` | world agent |
| `src/characters/adversary/*` (new: `brain.js`, `memory.js`, `perception.js`; changed: `adversary.js`), `src/turn.js`, `scripts/check-adversaries.mjs` | adversary-brain agent |
| `server.js`, `public/*` | UI agent |

The explorer files (`src/characters/explorer/*`) and `src/jev.js` stay unchanged. The adversary brain reuses `askJev`/`shuffle` from `src/jev.js`.

## Rooms

Room width and height are each a random integer from 4 to 15, chosen independently. The room count per area drops to match. A 35×35 map must still fit at least 4 rooms, so the 35×35 case may allow overlap retries or fewer rooms. Every other generation guarantee stays as before, and adversary spawns stay feasible.

## Adversary brains (fully agentic)

Every adversary has its own Jev brain, and **the brain is on only while the adversary is hunting**:
- **off (patrol):** the code wanders exactly as now, with no Jev calls.
- **on:** it switches on when `startsChase` fires (event `brain_on`). While on, every adversary step is a Jev Choice over its legal directions. Each tick the adversary is either in sight of the explorer (`mode: 'chase'`) or hunting from memory (`mode: 'search'`).
- While searching, the brain also gets a `keep_hunting` Noul each step: "Is it still worth hunting the explorer?" If the answer is below 0.5, the brain switches off (event `brain_off`, reason recorded). The adversary stops chasing and goes back to code patrol. Code also switches it off after `MAX_SEARCH_TICKS` (12) without sight.
- Movement keeps the speed budget, at most 1 step per tick. Only adversaries whose brain is on and that have a step this tick make a Jev call. Their calls for one tick are **made in parallel** from the state after the explorer's move, then applied in id order with a catch check after each step. Two adversaries may share a cell.
- **Adversary fog of war:** adversaries know the real map (tiles, rooms, their own position and the other adversaries' positions). They know the explorer's position **only while `seesExplorer` is true**. Otherwise they know only `last_seen` (cell + ticks ago + the direction the explorer was heading when last seen). They never know the treasure location or what the explorer has explored.
- **Per-adversary memory** keeps the explorer's shape: `{ objective, approach: { id, current, since_step, tried }, findings, progress: { ticks_hunting, ticks_since_seen, distance_trend }, latest_action }`. The objective is "Catch the explorer before it finds the treasure". There are 3 approaches: `direct_pursuit` (close the path distance), `cut_off` (head for the junction or corridor the explorer is most likely to pass through next, judged from its heading and the map), and `sweep_last_seen` (search outward from the last-seen cell). Code sets `direct_pursuit` while the explorer is in sight. When sight is lost, Jev picks between `cut_off` and `sweep_last_seen` with a Choice on the first search tick.
- Move descriptions are plain language and come from real-map facts plus the adversary fog of war. They cover: path distance to the explorer (or to the last-seen cell or approach target) before → after, whether the move keeps or gains line of sight, whether it blocks a corridor or junction, and whether it catches the explorer.
- Memories are kept on the server. All of them are written together to `dungeon-game/adversaries.json` each tick (no per-adversary md file needed). `view(game)` exposes them.

## `view(game).adversaries[]` (v3)

`{ id, pos, mode, visible, brain: { on: bool, approach: id|null, approach_text, approach_since, objective, latest_action: { choice, probabilities, confidence } | null, last_reason: string|null } }`

## Turn (v3)

`playTurn` returns `{ ...ExplorerTurn, events, lost, caughtBy, adversaryTurns: [{ id, dir, decision|null, keep_hunting: number|null, brain: 'on'|'off', apiMs }] }`. The new event types are `brain_on` and `brain_off` (with `reason`), alongside the existing ones.

# v4: encounter tactics + sentiment (the explorer stops reflexively running)

Read `AGENTS.md` first; it is the current guide and overrides older numbers here.

## Ownership (v4)
| Files | Owner |
| --- | --- |
| `src/characters/explorer/{brain,memory,perception}.js`, `scripts/check-dungeon.mjs` | explorer agent |
| `public/{index.html,app.js,style.css}` (and `server.js` only if needed) | UI agent |
Adversary files, `src/turn.js`, `src/dungeon.js`, `src/jev.js` stay unchanged.

## Behaviour
- **Encounter decision replaces the reflex.** The code policy "visible chaser → escape" goes away. When an encounter starts (an adversary becomes visible, or a visible one switches patrol→chase), and when the current tactic stops being viable (e.g. its target is unreachable or the gap fell below the sentiment's minimum), the explorer runs a **decision step**: Jev picks a **tactic** (a new approach). Tactics (ids, each with a short first-person `thought`):
  - `slip_past` "I can slip past!": a known route past/around the adversary toward the frontier/chest that never comes closer than the sentiment's minimum gap, using the speed edge.
  - `run_away` "Run away!": the old `escape`, renamed.
  - `face_off` "Face off.": hold ground in open space, keep a safe gap, and dodge around it as it commits (2× speed), then continue.
  - `hide` "Duck out of sight.": reach a known cell outside the adversary's line of sight before it arrives (LOS over known tiles only).
  - `race_to_chest` "Go for the chest!": only when the chest is seen.
  - `carry_on` "It hasn't seen me, keep going.": only while every visible adversary is patrolling; keep exploring but avoid its sight.
  Code computes each tactic's feasibility as plain-language facts from **known cells + visible adversaries only**: size/shape of the known space around the explorer (room W×H, corridor, junction, exits), adversary distance and bearing, speed (`ADVERSARY_SPEED`, read the constant), whether a slip-past route exists and its closest approach, the nearest hide cell and whether it is reached first, dead ends, and chest distance. Infeasible tactics are left out of the options.
- **Sentiment.** Jev picks a sentiment **with every approach decision** (encounter tactics, exploration approach switches after reviews, chest spotted, chase over): `courageous`, `risk_averse`, `scared`, `calculated`, `aggressive`, `cautious` (the explorer agent may refine the list). Each sentiment has a code **profile** that directly changes behaviour, e.g. `min_gap` used by tactic feasibility and move descriptions, how many ticks without sight end an encounter, and a priority sentence injected into `next_move`. It is not just a label.
- **Ordering and cost.** A decision step is one extra **sequential** request made just before the normal tick request: request 1 asks `sentiment` (Choice; it sees memory, situation and the encounter facts). Request 2 is the normal tick request with the chosen sentiment in memory, plus `tactic` (Choice), whose answer becomes the approach. `next_move` in that same request is asked speculatively per tactic, or the move follows the tactic's best move on the next tick. The explorer agent picks the cleaner option and documents it. Ordinary ticks make no extra call.
- **Never** log an encounter tactic as a failed approach in `approach.tried`. Keep the interrupt/resume mechanism.

## Shapes the UI relies on
- `memory.approach.thought`: string ≤ 60 chars, first person, set for **every** approach, exploration ones too (e.g. `nearest_frontier` "Let's check the closest dark edge.").
- `memory.sentiment = { id, since_step, profile_note }`, where `profile_note` is a short code-written description of what the sentiment changes. `memory.sentiment_history`: last 5 `[{ id, step }]`.
- `turn.decision = null | { trigger: 'encounter'|'tactic_failed'|'chase_over'|'chest'|'review'|'start', sentiment: { choice, probabilities }, tactic: { choice, probabilities, options } | null, apiMs }`.
- The bubble key for the explorer becomes `${approach.id}@${approach.since_step}`. Its text is `approach.thought`, with the sentiment shown as a tag.

# v4: props and wall decor

The **current values in the code take precedence** over numbers in this file. v3's "No props" rule is replaced by this section.

## Layout and ownership (v4)

```
src/props/catalog.js        prop kinds, placement rules, weights (DOM-free, no imports)        -> props-world agent
src/props/place.js          placeProps(dungeon, rand) -> { tiles, props, decor }              -> props-world agent
src/dungeon.js              generateDungeon calls placeProps; publicView adds props, decor     -> props-world agent (only these two edits)
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
- Iso tile: diamond 32x16 art px; a cell's centre is the diamond centre. A wall block is 11 art px tall above the floor. The knight is 18x24, the ghost 18x20, the treasure chest 12x10.
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
