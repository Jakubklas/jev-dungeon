# Jev Dungeon: Server and Multiplayer Implementation Plan

## Goal and build order

Host many durable games on one locally run server, then let several players control independent explorers in one dungeon. The world runs in continuous time. Each explorer and monster starts decisions on its own schedule; a decision is applied when it arrives, against the world at that instant. A slow Jev answer can therefore produce a legal but unsuccessful action, such as a sword swing through a cell the target has left.

Build in this order:

1. Close unmetered paid paths and make decisions separable from world mutation.
2. Add a server-wide settings source, durable games, and per-actor scheduling.
3. Add player entry (a name and a pasted Jev key, no accounts), the host role, access control, and a LAN-safe API.
4. Operate the service locally.
5. Add the waiting room and shared-dungeon combat on the same runtime.

Private games use the same actor runtime as shared games. A game accepts players only in its waiting room; starting it closes admission permanently. A disconnected player already in a running game may reconnect to that same participant. No new participant joins a running game.

## Current code and constraints

This plan follows the current code on `feat/tabu-search` (tabu search, Dash, and lit-cell sight); merge it to `main` before Phase 0. The code remains the authority if an implementation detail differs from this plan.

| Current behavior | Relevant code | Required seam |
| --- | --- | --- |
| One `Run` owns one `Game`, one explorer, and all adversaries; `playTurn()` moves the explorer, then ghosts. | `src/turn.js` | Split actor decisions from action application. Give each explorer and monster its own schedule. |
| One `Game` holds explorer position, lives, skills, visits, coins, and win state. | `src/dungeon.js` | Move explorer-owned state into an `ExplorerState`; keep map, loot, ghosts, and shared light in the world. |
| The explorer reads through `KnownWorld`; adversaries read through `AdversaryView`. | `src/characters/*` | Keep these boundaries. A decision sees a fog-safe snapshot taken when its request starts. |
| `central-config.yaml` is loaded by `src/config/runtime.js`, validated by `src/config/load.js`, and mapped through `src/config/registry.js`. `src/settings.js` re-exports it. | `central-config.yaml`, `src/config/*` | One service settings API, restricted to the host. A central change supplies rules for games created afterward. |
| Browser `POST /api/step` drives paid decisions. `src/jev.js` currently has two hedge copies, three retries, and a 20-second timeout for hosted Jev. | `server.js`, `src/jev.js`, `public/app.js` | Server scheduling, one copy per call, retained retries, seven-second timeout per Jev call (each call of a decision tick gets its own), a key per call, and a record of every HTTP post. |
| Memory, confidence, progress, tabu, skills, Dash, morale, levels, and directives contain actor-specific state, much of it private. | Explorer, adversary, and skill modules | Explicit versioned snapshots; preserve behavior during the split. |
| A touch emits `bump`; only an attack can remove a life. | `src/characters/adversary/adversary.js`, `src/skills/resolve.js` | Preserve this rule when attacks from several actors interleave. |

The hub and its arena/gym instances remain development tools. The server does not expose hub instance management or per-instance settings to players. No art changes are required by this plan.

## Product rules

### Settings

- The service has one central settings document and one settings API. The host (see Players, host, and API) can read and edit it; players receive `403` and cannot see the settings page or call the API.
- The document follows the current `central-config.yaml` registry and validation model. Remove instance overrides and player-facing `POST /api/config?scope=user` from the hosted surface. Keep local hub overrides for development only.
- A successful edit publishes a new central revision atomically. Games created after that point take the new effective rules. Existing games, including rooms still waiting to start, continue with the rules revision captured when the room was created. This avoids a mid-combat rules change and makes restore reproducible. Values currently marked `live` in the single-game server follow this rule in hosted games.
- A game stores `rules_revision` and the effective rules values needed by simulation. This is an internal historical snapshot, not a per-game setting or a player-selectable profile. The game API has no settings fields, settings profile ID, or settings mutation route.
- Secrets, keys and endpoint credentials remain outside the YAML game rules and outside player responses.

The current module-level `configure*` hooks cannot run two rule revisions in one process safely. Thread an immutable `rules` object through world, brain, skill, and monster construction and remove gameplay reads of mutable module globals. Until that refactor is complete, route each active rules revision to an isolated worker internally. Workers are an implementation detail and do not create multiple settings APIs.

### Waiting room and membership

States are `waiting`, `running`, `paused`, `finished`, and `abandoned`. Creating a game creates its waiting room and captures the central rules revision. Shared rooms accept 1-4 players. Anyone who has the room link and enters a name and Jev key may join or leave while the room is `waiting`; there is no invite route; slot assignment is stable once the game starts. The leader starts the room explicitly with any nonempty roster. There is no automatic start deadline. A private room has one slot and starts immediately. The start transaction seals the participant list, creates the dungeon from a server-secret seed, and places explorers on distinct valid starting cells. Room capacity is a central setting, initially four.

Join and start run on the game actor, one at a time; join requires `status = 'waiting'`. A request racing with start either commits before the seal and is included, or receives `409 game_started`. Reconnect uses the existing participant ID and never runs the join path. If the leader leaves before start, leadership transfers deterministically to the oldest remaining participant. Waiting rooms expire after 30 minutes without membership activity, without creating a dungeon or making Jev calls. A browser disconnect does not stop its explorer's server-side decisions; it can reconnect to the same participant and resume its view.

Shared mode is co-op: one world, one waiting room, all explorers on the same side. There is no player-versus-player mode and no parallel-seed race.

### Continuous time and actor decisions

There is no world tick or ordered player round. Time is measured in milliseconds. The world actor serializes only short state mutations; Jev requests run outside that critical section. Every explorer and monster has its own `next_decision_at`, movement cadence, cooldown deadlines, and one in-flight decision at most. Other actors continue moving while one request waits. The base cadence is **90 ms**: an actor starts its next decision no sooner than 90 ms after its previous decision was applied or timed out (central setting).

At decision start, take an immutable actor view from the then-current world and build the request from it. On completion, enqueue an intent at the game actor. Under the mutation lock, check that the actor is still alive and the intent is valid **now**; resolve it using current positions, health, occupancy, cooldowns, grace, and map state. Record `observed_at`, `completed_at`, and `applied_at` for diagnosis. No decision reserves a target cell or holds the world lock while awaiting Jev.

An aimed attack retains the direction and shape chosen from the old observation. It hits only occupants of those cells when it applies. If the target moved, it misses. A movement answer is checked against current legal moves; an invalid stale move becomes a no-op with a reason event, and the actor is scheduled again. Do not silently retarget to a newly visible enemy or move through a newly occupied cell. Apply the same rule to monster claws and Dash. An actor's own next decision is scheduled from its previous application or timeout, according to its cadence; it never queues a backlog of old turns.

Convert step-based timers in game rules to explicit time durations: grace, movement speed, hunt/search decay, heart respawn, block, skill cooldowns, memory age, hold, progress, tabu tenure, and directive expiry. Preserve their intended pace by mapping current step counts to durations at the **measured average move time**, not at the 90 ms cadence: a Jev call takes about 250 ms and a decision tick makes two, so an explorer really moves every 300-600 ms. The step length is a central setting `rules.stepMs`, provisionally **400 ms** until a live measurement of the median decision period sets it (for example grace 4 steps = 1.6 s, heart respawn 200 steps = 80 s); a monster's move interval is `stepMs / speed`. Document the resulting defaults in `CONFIG.md`. Actor decision counters may remain for diagnostics or memory algorithms, but cannot drive shared-world time. A pause freezes remaining gameplay durations; resume reanchors them to the server's monotonic clock. After a process restart, restore remaining durations and schedule at most one decision per actor, avoiding catch-up bursts.

Example runtime seam (illustrative TypeScript-style pseudocode, not a direct patch to current classes):

```ts
async function decide(actorId: string, game: GameActor) {
  const start = game.read(() => {
    const actor = game.actor(actorId);
    return { generation: actor.generation, observedAt: game.now(),
      view: actor.makeDecisionView() }; // immutable, fog-projected
  });

  let intent: Intent;
  try {
    intent = await gateway.ask(start.view, { timeoutMsPerCall: 7_000 });
  } catch (error) {
    game.enqueue({ type: 'decision_failed', actorId, generation: start.generation,
      reason: classify(error) });
    return;
  }

  game.enqueue({ type: 'apply_intent', actorId, generation: start.generation,
    observedAt: start.observedAt, completedAt: game.now(), intent });
}

function applyIntent(world: World, command: ApplyIntent) {
  const actor = world.actor(command.actorId);
  if (!actor?.alive || actor.generation !== command.generation) return; // stale session
  if (command.intent.type === 'sword') {
    if (!actor.skills.sword.readyAt(world.now())) return world.emit('stale_action');
    const cells = swordCells(actor.pos, command.intent.direction, world.map);
    return resolveAttack(world, actor, cells); // current occupants; a moved target is missed
  }
  if (command.intent.type === 'move') {
    if (!world.legalMove(actor, command.intent.direction)) return world.emit('stale_action');
    return world.move(actor, command.intent.direction);
  }
}
```

`generation` changes on death, removal, or control replacement so a completed old request cannot act for a replacement actor. Intent parsing must constrain the answer to options actually offered in that request. Action application must then recheck live legality without allowing an answer to reveal or exploit hidden state.

### Shared exploration and visibility

The dungeon owns one shared brightness map (today's `light` values, plus `litOutside`). When any explorer enters a cell, every cell within the configured light radius takes the higher of its current brightness and the new one; brightness only ever rises, whoever caused it, and `light > 0` still means known. The renderer's warm bands therefore show where any explorer walked; personal visits drive only that explorer's trail, route history and memory. More shared light also widens what monsters can see, since monsters see and are seen only on lit cells. Light never disappears when that explorer leaves, dies, disconnects, or forfeits. Every explorer's `KnownWorld` can read this same explored map, so an area another explorer already visited remains known. Current enemy sightings still require the observer's own range and line of sight; shared lit terrain alone does not reveal an enemy's current location. Remembered sightings remain frozen at their observation time and expire under the converted time rule.

```js
function visit(world, explorer, cell) {
  explorer.visits.set(key(cell), world.now()); // personal route and memory
  for (const [litCell, b] of lightRadius(world.map, cell, world.rules.lightRadius)) {
    world.light.raise(litCell, b);              // shared, permanent, max-only
  }
  world.emit({ type: 'explored', by: explorer.id, at: cell });
}

function knownTile(world, explorer, cell) {
  return world.light.get(cell) > 0 ? world.map.tile(cell) : null;
}
```

Every active explorer's current position is available to every other explorer and player, at any distance and through walls and objects. Their private resources and memory remain private. The same global teammate positions go to each explorer's Jev request. The map itself still follows shared permanent light; a teammate's position does not reveal hidden tiles around them.

A teammate is a character like any other in the explorer's own code: its cell blocks moves, known-floor BFS, the encounter model, escape and hide targets, and the move facts ("a teammate stands there"). The rules sentence and the state tell Jev that the other explorers are teammates playing on the same side, never adversaries: they cannot hurt it, are not threats, and are not counted by confidence as enemies. Teammates go in their own state group (for example `surroundings.teammates[]` with id, direction and known-path distance), never in `threats`. The extra bytes need a measured budget against the request-size bounds.

The screen also shows the live position of every adversary that **at least one** explorer directly sees. The union is recomputed after each world action. A recipient's HUD labels an adversary seen only by a teammate as `team_visible`; it disappears from the live overlay when nobody sees it. That display does not make the adversary directly visible to the recipient's brain: `KnownWorld.visibleAdversaries()` still returns only its own range-and-line-of-sight sightings, including the in-sight hp/level/claw fields. The request projector never substitutes the screen's union for that direct-sight list.

When an explorer newly encounters an adversary by direct sight, the server emits one `help_called` event for that encounter. Other active explorers within `explorer.helpReachSteps` of the caller on the **shared known-floor path graph** receive a `help_report` with caller ID, adversary ID, sighted cell, and observation time. The default reach is 48 path steps, twice the current monster pack-alert default of 24; central validation requires it to remain wider than `monsters.pack.alertSteps`. A report is frozen at that sighting, is labelled as teammate information, and expires under the normal remembered-sighting duration. It never becomes a direct sighting or tracks the adversary after it moves. A later new encounter may call again; a continuously visible enemy does not trigger a call on every decision. The report and a help cue enter each recipient's next scheduled Jev request without an extra immediate paid call. No recipient receives hidden surrounding cells, a live enemy position, or remote hp/level/claw data from the call.

```js
function callForHelp(world, caller, enemy) {
  if (caller.directSightings.has(enemy.id)) return; // one call per direct encounter
  const report = { by: caller.id, enemyId: enemy.id,
    at: [...enemy.pos], observedAt: world.now() };
  for (const recipient of world.activeExplorers()) {
    if (recipient.id === caller.id) continue;
    const steps = knownPathSteps(world.knownTiles, caller.pos, recipient.pos);
    if (steps <= world.rules.helpReachSteps) recipient.addHelpReport(report);
  }
  world.emit({ type: 'help_called', ...report });
}
```

Track direct-sighting transitions before updating `caller.directSightings`; clear an ID when direct sight is lost so a later re-encounter can call again. `knownPathSteps` traverses only lit, known floor cells and cannot inspect hidden corridors.

This teammate position and help report are explicit additions to the explorer's fog-safe API. Keep game access inside `KnownWorld` and the server-side event router; extend the static guard and fog twins. Hidden map changes outside shared lit terrain must not change help delivery, and moving an enemy after the reported sighting must not change the recipient's frozen report.

### Combat and victory

Each explorer owns position, health, grace, facing, block, skills, purse, memory, confidence, directive, and outcome. The world owns ghosts, shared map light, floor loot, and the portal. Explorers cannot attack or damage one another, and a move into another explorer's occupied cell fails current-state validation. An attack checks current targets at its application time. A simultaneous-looking pair of actions is ordered by the game actor's monotone event sequence, not by player slot; that order is persisted and broadcast. The first applied pickup takes a contested coin or heart; the later actor finds the cell empty. One-hit protection applies per target using real-time grace deadlines. Contact with a ghost remains a bump. Ghosts receive only explorers visible at their own decision start (own sight or team sight) and **choose a target at every decision**, so a monster can switch targets mid-pursuit. The monster request lists each explorer it can see (or has a frozen sighting of) and asks for the target together with the move; `lastSeen`, sightings, the cut-off facts and pack alert are kept per explorer. A stale claw can miss or strike a different occupant of its chosen cells at application time, subject to the skill's targeting rule. The extra explorer entries must stay inside the monster request bounds (5.5 KB average, 8 KB max), or the bounds are raised on purpose and recorded.

The shared game is co-op; there is no player-versus-player mode. The game ends when the first living explorer steps through the portal: the team wins, and every participant, alive or dead, receives that result. If every explorer dies or forfeits, the team loses. In a private game, entering the portal wins as today. Portal-less testbed rooms retain their clear-all-enemies rule.

**Ranking.** Every finished shared game shows one table of all participants, sorted by points:

| Source | Points (central settings, defaults) |
| --- | --- |
| Coin held at the end | 10 each |
| Strike landed (`struck` or `dispelled`) | 3 each |
| Dispel | 20 each (on top of its strike) |
| Stepped through the portal | 30 (the one who ended the game) |
| Alive at the end | 15 |

Ties go to more dispels, then more coins, then the later time of death (survivors first), then the earlier join. The table shows the points next to each column (coins, strikes, dispels, portal, alive) so the order explains itself. A dead participant keeps the coins they held when they died; at 0 lives the purse is not lost for ranking. A forfeited participant is listed with their totals at forfeit, marked `forfeited`, and receives no alive bonus. The team score shown above the table is the sum of every participant's points.

## Decision routing and cost

The gateway routes each request by actor ID. Jev is the only provider offered to players; the local Laya and OpenAI Decisions providers stay development-only. Every call in a game uses the Jev model captured from central settings when the room was created. The timeout rule is the same for any model.

| Request source | Model | Key |
| --- | --- | --- |
| Explorer `par_...` | The game's captured Jev model | The key that participant pasted |
| Adversary `a1..aN` | The game's captured Jev model | The server's own key (`JEV_API_KEY` from `.env`) |

A participant's key is used only for that participant's explorer; other participants' keys and the server key are never a fallback. **There are no spending caps for now**: no free tier, no per-player, per-game or daily limits. Every HTTP post is still recorded (game, actor, kind, status, attempts, bytes, elapsed time) for diagnosis, and the host can pause any game.

**Key failure.** If Jev rejects a participant's key (401 or 403), only that explorer stops: its pending call is aborted, it takes no further decisions and stands where it is (monsters can still reach it), and the player's screen asks for a new key. A valid key pasted within `keyRetryMs` (central setting, default 2 minutes) resumes it on its next schedule. After that it forfeits: its actor generation is invalidated, it leaves occupancy and monster target lists, and it keeps its totals for the ranking. The other explorers and monsters continue. If no active explorer remains, the game finishes as a team loss. A forfeit is final: reconnect restores the result screen, not a playing slot. Transient errors and seven-second timeouts cost only that actor's current decision; it tries again on its next schedule. A rejected server key pauses the whole game, because no participant can supply the monsters' route.

Only the gateway may create paid askers. Remove the brains' default real callers and require injected `ask`/`decide`; dry scripts keep throwing network tripwires. The hosted Jev policy is **one copy**, **the existing retry behavior** (up to three retries for the current transient statuses and network failures), and a **seven-second timeout per logical call**, including its retries and backoff. A decision tick that makes two calls in sequence (sentiment, then tactic and move) gives each call its own 7 s; the limit is never shared across the chain. No hedge timer exists. An aborted or timed-out call cannot enqueue an action even if a response arrives afterward. A timed-out actor records a failure and waits for its next own decision opportunity; it does not stall the game.

```js
async function postWithRetry(body, { key, signal, onAttempt, fetchImpl = fetch }) {
  const deadline = AbortSignal.timeout(7_000); // per call, not per decision tick
  const combined = AbortSignal.any([signal, deadline]);
  for (let retry = 0; retry <= 3; retry++) {
    if (combined.aborted) throw combined.reason;
    onAttempt(); // record one HTTP post before fetch
    try {
      const res = await fetchImpl(API, { method: 'POST', body, signal: combined,
        headers: { authorization: `Bearer ${key}` } });
      if (res.ok) return (await res.json()).answers;
      if (res.status === 401 || res.status === 403) throw new KeyRejected(res.status);
      if (![429, 502, 503, 504, 529].includes(res.status) || retry === 3) {
        throw new PermanentOrFinalResponse(res.status);
      }
    } catch (error) {
      if (combined.aborted || retry === 3 || error instanceof KeyRejected
        || error instanceof PermanentOrFinalResponse) throw error;
    }
    await abortableBackoff(500 * 2 ** retry, combined);
  }
}
```

The sketch needs response-body error handling when implemented. Its invariant is one in-flight copy per call and a deadline covering that call. Server scheduling stays disabled until the gateway and its recording pass their checks; afterward, starting a game starts its actors automatically. A player's browser never drives the spending loop.

## Storage and recovery

One server process on one machine, no database for now. Everything lives in a file store under the data directory (`runs/server/` by default), behind a small storage interface so a database can replace it later:

```
runs/server/
  server.lock                  pid lock: a second server on the same folder refuses to start
  host-token                   operator token, mode 0600 (see Host)
  settings/<revision>.json     every published central revision, never edited
  games/<gm_id>/
    meta.json                  status, mode, leader, rules_revision, seed, generation version, tiles hash
    rules.json                 the effective rules captured at creation
    dungeon.json               the pinned dungeon from start
    state.json                 hot state, versioned, with event_seq
    events.jsonl               append-only events, one per applied action
    calls.jsonl                one line per Jev HTTP post (no request bodies, no keys)
```

The game actor is the only writer of its folder. For each applied action it appends the event, then writes `state.json` (temp file + rename, so a crash leaves the old or the new state, never half of one), and only then publishes over SSE. On restart, `state.json` is the truth: events with a `seq` above its `event_seq` are dropped, so an action is never applied twice. Cold snapshots (`state-<seq>.json`) are written at start, at finish and every N events, without treating the count as game time.

Editing settings writes the next `settings/<revision>.json`. Creating a game copies the current revision's effective rules into its `rules.json`; start uses that copy, seals membership and generates the seed. No later settings edit changes the game. The YAML file stays the source in development; the host's settings page writes through the same validation path.

Snapshot all mutable state explicitly: map light, loot, event sequence; each explorer's position, resources, memory, private brain state, timers, in-flight generation, and RNG; each ghost's public six fields, hunt/search memory, limited-map view, skills, timers, and RNG. Include the current tabu and Dash state. Preserve Set and Map order where behavior depends on it. Do not JSON-clone `Game` or `Adversary`; use versioned `serialize`/`restore` methods. Store remaining timer durations at pause or checkpoint and reanchor them on restore. A restored game must reproduce the next request bytes and action sequence under stubbed decisions.

**Keys are never stored.** A pasted key lives only in server memory, attached to its participant; it is never written to disk, logs, `calls.jsonl`, events or snapshots, and never sent back to a browser. So after a restart every running game restores as `paused`, and each living participant is asked to paste their key again when they reconnect. The game resumes on its own once every living participant has a key; the host can also resume it, and a participant still without a key then gets the `keyRetryMs` window before forfeiting.

Keep a seed, generation version, rules snapshot, map hash, and the pinned dungeon from game start. Restore from that file after generator changes; never silently regenerate a different map. Make option shuffles actor-specific seeded RNG streams, since global `Math.random` makes interleaving nondeterministic. Preserve the current dungeon and spawn RNG draw order. Regenerate request-hash fixtures deliberately after request order changes and review the diff.

## Players, host, and API

**No accounts and no sign-up.** A player opens the server's page, types a display name (1-20 characters, sanitised like directives), pastes their Jev key, then creates a room or joins one from its link. Joining issues a random participant token in an `HttpOnly`, `SameSite=Strict` cookie scoped to that game; it is the participant's only identity, used for reconnect, directives and pause. Losing the cookie means losing the seat (the explorer keeps playing until its key is needed again after a restart). Display names need not be unique; the ranking shows the slot colour next to the name.

**The host (operator role).** Whoever runs the server is the host. At startup the server generates a random host token, writes it to `runs/server/host-token` (mode 0600) and prints a one-time URL, `http://localhost:<port>/host#token=...`, to the console, like a notebook server does. Opening it stores the token in an `HttpOnly` host cookie. Host routes require that cookie **and**, by default, a request from a loopback address, so a player on the LAN cannot reach them even with a leaked token (`HOST_REMOTE=1` lifts the loopback rule). The token changes on every restart unless `HOST_TOKEN` pins it. The host page has the central settings editor, a list of games with pause, resume and end, the call log per game, and Reveal for a game (logged as a host event). Players never see any of it: every host route answers `403` to them.

Player directives are free text sent to Jev, so keep their sanitation and rate limits. Mutating requests check `Origin` against the server's own, on top of `SameSite`. Join, create and directive routes are rate-limited per client address.

IDs are random prefixed strings (`gm_`, `par_`); ghost IDs remain game-local `a1..aN`. The HTTP surface is:

| Route | Access and behavior |
| --- | --- |
| `GET/PUT /v1/host/settings` | Host only. One central document, validation, new revision. No game ID. |
| `GET /v1/host/games`, `POST /v1/host/games/:id/{pause,resume,end,reveal}` | Host only. |
| `POST /v1/games` | Anyone with a name and key: creates a waiting room (or a private game, which starts at once); no rule overrides. |
| `POST /v1/games/:id/join` / `leave` | Anyone with the room link, a name and a key; waiting state only. No invite route. |
| `POST /v1/games/:id/key` | Participant only: replace a rejected key, or re-enter it after a restart. |
| `POST /v1/games/:id/start` | Room leader; seals membership and starts actors. |
| `GET /v1/games/:id` | Participant sees their own fog-projected state. |
| `GET /v1/games/:id/events` | SSE with `Last-Event-ID`, heartbeat, bounds on queued bytes. |
| `POST /v1/games/:id/directives` | Participant controls only their own explorer; queued for its next decision. |
| `POST /v1/games/:id/pause` / `resume` | Private game: its player or the host. Shared game: host only. |

The old `/api/new`, `/api/step`, `/api/settings`, `/api/config`, and hub management endpoints remain localhost development routes and are absent from the `/v1` router. No player can call a settings API. There is no general spectator role, but a dead participant switches to a spectator view of the living players until the game ends: the team projection (shared light, every living explorer's position, the union of directly seen adversaries), never another player's private memory, resources or requests. SSE uses a per-viewer projector. It removes hidden map cells, hidden enemies, private memories, keys, request bodies, and the server seed. Every route enforces membership on the server, independent of browser controls. The server binds to `127.0.0.1` by default; `HOST=0.0.0.0` opens it to the LAN.

## Implementation sequence and acceptance

### 0. Paid-path and test seams

1. Add a shared no-network tripwire to all free checks and dry runners. Make real `ask` and `decide` injection mandatory. Route all paid calls through a gateway that takes a key per call, records each post, and supports an external abort signal.
2. Set hosted Jev to one copy, three retries, and a seven-second timeout per call (retries included) in the central config and gateway. Test retryable status, backoff cancellation, timeout, late response rejection, a rejected key, and exact post recording with fake transport.
3. Introduce `DecisionView` and `Intent` contracts. Move `KnownWorld.move`/`useSkill` effects out of the await tail of `ExplorerBrain.takeTurn()`. A brain may produce an intent and update private decision state; only the game actor applies the intent. Make equivalent seams for adversaries.

Exit: all checks are free, no brain can initiate a paid call without injected gateway wiring, and no unresolved promise can mutate a live world.

### 1. Continuous runtime and persistence

1. Extract `ExplorerState` from `Game`; make `KnownWorld` participant-specific and preserve its static fog guard. Give `Game` one shared brightness map. Add central `explorer.helpReachSteps` with a default of 48 and validation against monster alert reach. Add `rules.stepMs` and convert step-based gameplay timers to durations with documented defaults.
2. Implement per-actor schedules and the short mutation queue. Use a fake monotonic clock and controlled promises to prove that a slow explorer does not stop a fast explorer or a monster, and that a late sword misses a target that moved out of its aimed cells.
3. Add versioned snapshots, actor RNG, the file store (atomic state writes, append-only events, pid lock) and restore, including the paused-until-keys restore.
4. Add server-side autoplay, initially disabled. Build private one-player games on this runtime before shared games.

Exit: restored and uninterrupted stubbed games produce equal request bodies, events, world light, and outcomes; a world has no global tick barrier; a restart cannot replay an already applied action; no key reaches disk.

### 2. Players, host, and public boundary

1. Add the name-and-key entry page, participant cookies, the host token and host page, `Origin` checks, rate limits and host events.
2. Add the `/v1` router and SSE projection. Restrict the one settings API to the host; remove player settings routes from `/v1`. Bind dev hub management to localhost.
3. Run fog twins for every participant view and request, including a teammate's newly lit area, global teammate positions, and a hidden monster moved after a help report. Test that each explorer's calls carry only its own key and monsters' only the server key, a rejected key pausing one explorer then forfeiting after `keyRetryMs`, a rejected server key pausing the game, host routes refusing players and non-loopback clients, and access for every route.

Exit: a browser cannot use another participant's key, change rules, reveal hidden state, start another player's room, or reach host routes; keys never leave server memory.

### 3. Operations (local hosting)

The service is hosted locally for now; cloud deployment is deferred. Add a health route, structured logs without keys or request bodies by default, and counters for Jev posts, latency, timeouts, actor queue delay, event write delay and SSE lag on the host page. Document backing up `runs/server/` and test a restore from a copy. Test a process kill during a decision and during an event write: the game must restore without applying an action twice. Keep old rule revisions and pinned dungeons while affected games remain active.

### 4. Shared dungeon

1. Implement waiting-room joins, leaves, leader transfer, start seal, expiry, reconnect, and start/join races.
2. Spawn distinct explorers in one world. Share permanent map light and world loot; keep personal route history, resources, memories, and directives. Add global active-explorer positions, the screen's union of directly seen enemies, and frozen help reports to the correct projection layers. Resolve pickup contention by event application order.
3. Extend monster targeting, attacks, knockback, grace, skill effects, and win resolution for multiple explorers. Preserve bump versus strike semantics. Validate all actions against current state when they apply. Add the end-of-game ranking.
4. Project one SSE stream per viewer and run fog twins. Cover simultaneous portal entries, contested loot, two attacks against one ghost, a ghost moving during a delayed sword call, a ghost switching targets, all teammate positions through walls, the union of directly seen adversaries on every screen, near and far help-call recipients, player death, a rejected key or forfeit while a call is in flight, the dead player's spectator view, and a disconnected participant's reconnection.

Exit: no player joins after start; a slow decision never freezes the dungeon; explored terrain persists for every explorer; every applied action has one durable event and a deterministic order; no hidden state leaks into Jev or player views.

Accounts, spending caps, a database, replays, and cloud hosting follow only after shared co-op play is stable.

## Verification commands and boundaries

Run the existing free checks that cover fog, adversaries, testbed, config, skills, tabu, progress, levels, morale, route, persistence-sensitive request hashes, and API directives. Add `check-runtime.mjs`, `check-persistence.mjs`, `check-lobby.mjs`, `check-multiplayer-fog.mjs`, `check-host.mjs`, and `check-paid-paths.mjs` with stubbed decisions and a throwing `fetch` tripwire. Use testbed arenas for explorer behavior. Do not use `/api/step`, Start, or any `--live` runner as a routine test. Measuring the real decision period for `stepMs` is a live run and needs explicit authorization.

The implementation crosses the ownership boundaries in `AGENTS.md` because the world, both brains, server, config, and UI must change together. Keep each phase reviewable, reread files before editing in a shared workspace, and do not hand-edit runtime memory files or request-hash fixtures except for a deliberate fixture update.
