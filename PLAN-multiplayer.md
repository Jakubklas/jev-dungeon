# Jev Dungeon: Cloud and Multiplayer Implementation Plan

## Goal and build order

Host many durable games, then let several players control independent explorers in one dungeon. The world runs in continuous time. Each explorer and monster starts decisions on its own schedule; a decision is applied when it arrives, against the world at that instant. A slow Jev answer can therefore produce a legal but unsuccessful action, such as a sword swing through a cell the target has left.

Build in this order:

1. Close unmetered paid paths and make decisions separable from world mutation.
2. Add a server-wide settings source, durable games, and per-actor scheduling with spend limits.
3. Add accounts, agents, keys, access control, and an internet-safe API.
4. Deploy and operate the service.
5. Add the waiting room and shared-dungeon combat on the same runtime.

Private games use the same actor runtime as shared games. A game accepts players only in its waiting room; starting it closes admission permanently. A disconnected player already in a running game may reconnect to that same participant. No new participant joins a running game.

## Current code and constraints

This plan follows the current `main` code, including tabu search, Dash, and lit-cell sight. The code remains the authority if an implementation detail differs from this plan.

| Current behavior | Relevant code | Required seam |
| --- | --- | --- |
| One `Run` owns one `Game`, one explorer, and all adversaries; `playTurn()` moves the explorer, then ghosts. | `src/turn.js` | Split actor decisions from action application. Give each explorer and monster its own schedule. |
| One `Game` holds explorer position, lives, skills, visits, coins, and win state. | `src/dungeon.js` | Move explorer-owned state into an `ExplorerState`; keep map, loot, ghosts, and shared light in the world. |
| The explorer reads through `KnownWorld`; adversaries read through `AdversaryView`. | `src/characters/*` | Keep these boundaries. A decision sees a fog-safe snapshot taken when its request starts. |
| `central-config.yaml` is loaded by `src/config/runtime.js`, validated by `src/config/load.js`, and mapped through `src/config/registry.js`. `src/settings.js` re-exports it. | `central-config.yaml`, `src/config/*` | One service settings API, restricted to operators. A central change supplies rules for games created afterward. |
| Browser `POST /api/step` drives paid decisions. `src/jev.js` currently has two hedge copies, three retries, and a 20-second timeout for hosted Jev. | `server.js`, `src/jev.js`, `public/app.js` | Server scheduling, one copy per call, retained retries, five-second total call timeout, and metering before every HTTP post. |
| Memory, confidence, progress, tabu, skills, Dash, morale, levels, and directives contain actor-specific state, much of it private. | Explorer, adversary, and skill modules | Explicit versioned snapshots; preserve behavior during the split. |
| A touch emits `bump`; only an attack can remove a life. | `src/characters/adversary/adversary.js`, `src/skills/resolve.js` | Preserve this rule when attacks from several actors interleave. |

The hub and its arena/gym instances remain development tools. The cloud service does not expose hub instance management or per-instance settings to players. No art changes are required by this plan.

## Product rules

### Settings

- The service has one central settings document and one settings API. Operators can read and edit it; ordinary players and agents receive `403` and cannot see the settings page or call the API.
- The document follows the current `central-config.yaml` registry and validation model. Remove cloud instance overrides and player-facing `POST /api/config?scope=user` from the hosted surface. Keep local hub overrides for development only.
- A successful edit publishes a new central revision atomically. Games created after that point take the new effective rules. Existing games, including rooms still waiting to start, continue with the rules revision captured when the room was created. This avoids a mid-combat rules change and makes restore reproducible. Values currently marked `live` in the single-game server follow this rule in hosted games.
- A game stores `rules_revision` and the effective rules values needed by simulation. This is an internal historical snapshot, not a per-game setting or a player-selectable profile. The game API has no settings fields, settings profile ID, or settings mutation route.
- Secrets, endpoint credentials, and billing limits remain outside the YAML game rules and outside player responses.

The current module-level `configure*` hooks cannot run two rule revisions in one process safely. Thread an immutable `rules` object through world, brain, skill, and monster construction and remove gameplay reads of mutable module globals. Until that refactor is complete, route each active rules revision to an isolated worker internally. Workers are an implementation detail and do not create multiple settings APIs.

### Waiting room and membership

States are `waiting`, `running`, `paused`, `finished`, and `abandoned`. Creating a game creates its waiting room and captures the central rules revision. Shared rooms accept 1-4 players. Invited players may join or leave while the room is `waiting`; slot assignment is stable once the game starts. The leader starts the room explicitly with any nonempty roster. There is no automatic start deadline. A private room has one slot and starts immediately. The start transaction seals the participant list, creates the dungeon from a server-secret seed, and places explorers on distinct valid starting cells. Room capacity is a central setting, initially four.

The join endpoint must lock the game row and require `status = 'waiting'`. A request racing with start either commits before the seal and is included, or receives `409 game_started`. Reconnect uses the existing participant ID and never runs the join path. If the leader leaves before start, leadership transfers deterministically to the oldest remaining participant. Waiting rooms expire after 30 minutes without membership activity, without creating a dungeon or making Jev calls. A browser disconnect does not stop its explorer's server-side decisions; it can reconnect to the same participant and resume its view.

A parallel-seed race is several separate games seeded from a server-secret race seed. Shared mode is one world and one waiting room. Co-op can follow shared competitive play without changing admission.

### Continuous time and actor decisions

There is no world tick or ordered player round. Time is measured in milliseconds. The world actor serializes only short state mutations; Jev requests run outside that critical section. Every explorer and monster has its own `next_decision_at`, movement cadence, cooldown deadlines, and one in-flight decision at most. Other actors continue moving while one request waits.

At decision start, take an immutable actor view from the then-current world and build the request from it. On completion, enqueue an intent at the game actor. Under the mutation lock, check that the actor is still alive and the intent is valid **now**; resolve it using current positions, health, occupancy, cooldowns, grace, and map state. Record `observed_at`, `completed_at`, and `applied_at` for diagnosis. No decision reserves a target cell or holds the world lock while awaiting Jev.

An aimed attack retains the direction and shape chosen from the old observation. It hits only occupants of those cells when it applies. If the target moved, it misses. A movement answer is checked against current legal moves; an invalid stale move becomes a no-op with a reason event, and the actor is scheduled again. Do not silently retarget to a newly visible enemy or move through a newly occupied cell. Apply the same rule to monster claws and Dash. An actor's own next decision is scheduled from its previous application or timeout, according to its cadence; it never queues a backlog of old turns.

Convert step-based timers in game rules to explicit time durations: grace, movement speed, hunt/search decay, heart respawn, block, skill cooldowns, memory age, hold, progress, tabu tenure, and directive expiry. Preserve their intended pace by mapping current configured step counts to durations at the initial cadence, then document the resulting defaults in `CONFIG.md`. Actor decision counters may remain for diagnostics or memory algorithms, but cannot drive shared-world time. A pause freezes remaining gameplay durations; resume reanchors them to the server's monotonic clock. After a process restart, restore remaining durations and schedule at most one decision per actor, avoiding catch-up bursts.

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
    intent = await gateway.ask(start.view, { timeoutMs: 5_000 });
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

The dungeon owns one monotone `lit` set. When any explorer enters a cell, add every cell within the configured light radius. Light never disappears when that explorer leaves, dies, disconnects, or forfeits. Every explorer's `KnownWorld` can read this same explored map, so an area another explorer already visited remains known. Current enemy sightings still require the observer's own range and line of sight; shared lit terrain alone does not reveal an enemy's current location. Remembered sightings remain frozen at their observation time and expire under the converted time rule.

```js
function visit(world, explorer, cell) {
  explorer.visits.set(key(cell), world.now()); // personal route and memory
  for (const litCell of cellsInLightRadius(world.map, cell, world.rules.lightRadius)) {
    world.lit.add(key(litCell));                // shared, permanent knowledge
  }
  world.emit({ type: 'explored', by: explorer.id, at: cell });
}

function knownTile(world, explorer, cell) {
  return world.lit.has(key(cell)) ? world.map.tile(cell) : null;
}
```

Every active explorer's current position is available to every other explorer and player, at any distance and through walls and objects. Their private resources and memory remain private. The same global teammate positions go to each explorer's Jev request. The map itself still follows shared permanent light; a teammate's position does not reveal hidden tiles around them.

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

Each explorer owns position, health, grace, facing, block, skills, purse, memory, confidence, directive, and outcome. The world owns ghosts, shared map light, floor loot, and the portal. Explorers cannot attack or damage one another, and a move into another explorer's occupied cell fails current-state validation. An attack checks current targets at its application time. A simultaneous-looking pair of actions is ordered by the game actor's monotone event sequence, not by player slot; that order is persisted and broadcast. The first applied pickup takes a contested coin or heart; the later actor finds the cell empty. One-hit protection applies per target using real-time grace deadlines. Contact with a ghost remains a bump. Ghosts receive only explorers visible at their own decision start and choose a target as part of their decision; a stale claw can miss or strike a different occupant of its chosen cells at application time, subject to the skill's targeting rule.

In a competitive shared dungeon, the first explorer to enter the portal wins. Other survivors receive a finished outcome with their held coins. In a private game, entering the portal wins as today. Portal-less testbed rooms retain their clear-all-enemies rule. Co-op follows the competitive release: the team wins when any living explorer enters the portal, with team score equal to coins held by all explorers at that moment. A dead participant keeps their personal dead outcome but receives the team's result.

## Decision routing and cost control

The gateway routes each request by actor ID. A participant's immutable `agent_version_id` pins the explorer's provider and model when they join. Its calls use that participant's selected BYOK credential. An account without BYOK can use the capped platform explorer key only with the platform's hosted Jev model; other providers or models require an appropriate BYOK credential. A player cannot change provider, model, or key after the room starts. Other participants' keys are never used as a fallback.

All adversaries in one game use the single server-controlled provider and model captured from central settings when the room is created. Their calls use a server credential, independent of every player's model and key. The service pays for adversary calls and charges them against the global and game budgets. Rotating a server secret changes the credential without changing a running game's pinned model. A room cannot start unless every explorer route and the adversary route are available and within their budgets.

| Request source | Provider and model | Credential and budget |
| --- | --- | --- |
| Explorer `par_...` | That participant's pinned agent version | Their matching BYOK key and account quota, or the platform hosted Jev model/key and free-tier quota |
| Adversary `a1..aN` | The game's captured central adversary model | Server key, service quota, and game quota |

If an explorer's key fails authentication or that participant's quota is exhausted, only that participant forfeits. Abort their pending call, invalidate their actor generation, remove their explorer from occupancy and monster target lists, and retain their final purse/outcome for the scoreboard. The other explorers and adversaries continue. If no active explorer remains, finish the game without a winner. A forfeit is final: reconnect restores the result screen, not a playing slot, and no new player joins the running room. Transient request errors and five-second timeouts consume only that actor's current decision opportunity; it tries again on its next schedule. A failed server adversary credential, service-wide cap, or game-wide cap pauses the whole game because no participant can supply that route.

Only the gateway may create paid askers. Remove the brains' default real callers and require injected `ask`/`decide`; dry scripts keep throwing network tripwires. The hosted Jev policy is **one copy**, **the existing retry behavior** (up to three retries for the current transient statuses and network failures), and a **five-second total logical-call timeout**, including retries and backoff. No hedge timer or tenant hedge override exists. An aborted or timed-out call cannot enqueue an action even if a response arrives afterward. A timed-out actor records a failure and waits for its next own decision opportunity; it does not stall the game.

```js
async function postWithRetry(body, { signal, onAttempt, fetchImpl = fetch }) {
  const deadline = AbortSignal.timeout(5_000);
  const combined = AbortSignal.any([signal, deadline]);
  for (let retry = 0; retry <= 3; retry++) {
    if (combined.aborted) throw combined.reason;
    await onAttempt(); // reserve one HTTP post atomically before fetch
    try {
      const res = await fetchImpl(API, { method: 'POST', body, signal: combined });
      if (res.ok) return (await res.json()).answers;
      if (![429, 502, 503, 504, 529].includes(res.status) || retry === 3) {
        throw new PermanentOrFinalResponse(res.status);
      }
    } catch (error) {
      if (combined.aborted || retry === 3 || error instanceof PermanentOrFinalResponse) throw error;
    }
    await abortableBackoff(500 * 2 ** retry, combined);
  }
}
```

The sketch needs response-body error handling and the existing provider adapters when implemented. Its invariant is one in-flight copy and a deadline covering the entire call. Every attempted HTTP post counts toward quota, even on timeout. A platform kill switch, global daily post cap, per-account cap, per-game post cap, and per-actor rate limit are checked before dispatch. A participant-only denial emits `forfeited`; a server or game-wide denial emits `budget_denied` and pauses the game. Server scheduling stays disabled during rollout until these guards and metering pass their checks; afterward, starting a game starts its actors automatically. A player's browser never drives the spending loop.

## Storage and recovery

Use Postgres for durable metadata, one hot state row per game, append-only events, and Jev-attempt metadata. No Redis is required initially. A game actor is the only writer of its world; on more than one server, a renewable lease with a fencing epoch prevents two actors from applying actions to the same game. Persist state and the resulting event in one transaction before SSE publication. Save cold snapshots by event count and at start/finish, without treating the count as game time.

Minimal schema shape:

```sql
CREATE TABLE service_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL, values jsonb NOT NULL, updated_at timestamptz NOT NULL
);

CREATE TABLE games (
  id text PRIMARY KEY, status text NOT NULL,
  mode text NOT NULL, leader_player_id text NOT NULL,
  rules_revision bigint, rules_snapshot jsonb,
  seed bigint, generation_version text, tiles_hash text,
  started_at timestamptz, finished_at timestamptz,
  event_seq bigint NOT NULL DEFAULT 0,
  lease_owner text, lease_epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz
);

CREATE TABLE game_participants (
  id text PRIMARY KEY, game_id text NOT NULL REFERENCES games(id),
  player_id text NOT NULL, agent_version_id text NOT NULL,
  key_id text, -- null only for an eligible platform explorer key
  slot int NOT NULL, status text NOT NULL, -- joined|alive|won|dead|forfeited
  joined_at timestamptz NOT NULL, UNIQUE (game_id, player_id), UNIQUE (game_id, slot)
);

CREATE TABLE game_state (
  game_id text PRIMARY KEY REFERENCES games(id),
  event_seq bigint NOT NULL, schema_version int NOT NULL, body jsonb NOT NULL
);

CREATE TABLE game_events (
  game_id text NOT NULL REFERENCES games(id), seq bigint NOT NULL,
  actor_id text, type text NOT NULL, payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL, PRIMARY KEY (game_id, seq)
);

CREATE TABLE jev_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id text NOT NULL, actor_id text NOT NULL, request_sha text NOT NULL,
  kind text NOT NULL, provider text NOT NULL, model text NOT NULL,
  credential_source text NOT NULL, status text NOT NULL, attempts int NOT NULL,
  request_bytes int NOT NULL, elapsed_ms int, billed_account_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

The settings edit transaction increments `service_settings.revision`. The game creation transaction reads that row and stores the effective rules snapshot in the new waiting room. The start transaction uses that stored snapshot, seals membership, and generates the seed. No later settings edit changes this game. The YAML file remains the operator-facing source in development; cloud edits update the central settings row and its audited revision, and deployments reconcile the file through the same validation path.

Snapshot all mutable state explicitly: map light, loot, event sequence; each explorer's position, resources, memory, private brain state, timers, in-flight generation, and RNG; each ghost's public six fields, hunt/search memory, limited-map view, skills, timers, and RNG. Include the current tabu and Dash state. Preserve Set and Map order where behavior depends on it. Do not JSON-clone `Game` or `Adversary`; use versioned `serialize`/`restore` methods. Store remaining timer durations at pause or checkpoint and reanchor them on restore. A restored game must reproduce the next request bytes and action sequence under stubbed decisions.

Keep a seed, generation version, rules snapshot, map hash, and a pinned dungeon blob from game start. Restore from that blob after generator changes; never silently regenerate a different map. Make option shuffles actor-specific seeded RNG streams, since global `Math.random` makes interleaving nondeterministic. Preserve the current dungeon and spawn RNG draw order. Regenerate request-hash fixtures deliberately after request order changes and review the diff.

## Identity, API, and access

Use hosted OIDC login, cookie sessions with CSRF protection, and versioned agent configs. BYOK is encrypted at rest; the capped platform explorer key serves eligible accounts without one. Only the gateway decrypts a key for a call. Agent persona presets may adjust validated numeric defaults; any free text sent to Jev needs a stated request-byte budget. Player directives are already free text sent to Jev, so retain their sanitation and rate limits.

IDs use prefixed ULIDs (`gm_`, `par_`, `plr_`, `agt_`, `agv_`, `key_`); ghost IDs remain game-local `a1..aN`. The HTTP surface is:

| Route | Access and behavior |
| --- | --- |
| `GET/PUT /v1/admin/settings` | Operator only. One central document, validation, revision, audit. No game ID. |
| `POST /v1/games` | Authenticated player creates a waiting room; no rule overrides. |
| `POST /v1/games/:id/join` / `leave` | Invited player, waiting state only. |
| `POST /v1/games/:id/start` | Room leader; seals membership and starts actors. |
| `GET /v1/games/:id` | Participant sees their own fog-projected state; operator access is audited. |
| `GET /v1/games/:id/events` | SSE with `Last-Event-ID`, heartbeat, bounds on queued bytes. |
| `POST /v1/games/:id/directives` | Participant controls only their own explorer; queued for its next decision. |
| `POST /v1/games/:id/pause` / `resume` | Private-game owner or operator. Shared-game pause/resume is operator only. |
| `POST /v1/keys`, `GET /v1/keys`, `DELETE /v1/keys/:id` | Owner only; responses contain metadata, never plaintext. |

The old `/api/new`, `/api/step`, `/api/settings`, `/api/config`, and hub management endpoints remain localhost development routes and are absent from the public router. No player can call a settings API. The first public release has no spectator role. SSE uses a per-viewer projector. It removes hidden map cells, hidden enemies, private memories, key metadata, request bodies, and the server seed. Reveal is an audited operator action. Every route enforces membership and ownership on the server, independent of browser controls.

## Implementation sequence and acceptance

### 0. Paid-path and test seams

1. Add a shared no-network tripwire to all free checks and dry runners. Make real `ask` and `decide` injection mandatory. Route all paid calls through a gateway that meters each post and supports an external abort signal.
2. Set hosted Jev to one copy, three retries, and a five-second total timeout in the central config and gateway. Test retryable status, backoff cancellation, timeout, late response rejection, and exact post accounting with fake transport.
3. Introduce `DecisionView` and `Intent` contracts. Move `KnownWorld.move`/`useSkill` effects out of the await tail of `ExplorerBrain.takeTurn()`. A brain may produce an intent and update private decision state; only the game actor applies the intent. Make equivalent seams for adversaries.

Exit: all checks are free, no brain can initiate a paid call without injected gateway wiring, and no unresolved promise can mutate a live world.

### 1. Continuous runtime and persistence

1. Extract `ExplorerState` from `Game`; make `KnownWorld` participant-specific and preserve its static fog guard. Give `Game` one shared permanent light set. Add central `explorer.helpReachSteps` with a default of 48 and validation against monster alert reach. Convert step-based gameplay timers to durations with documented defaults.
2. Implement per-actor schedules and the short mutation queue. Use a fake monotonic clock and controlled promises to prove that a slow explorer does not stop a fast explorer or a monster, and that a late sword misses a target that moved out of its aimed cells.
3. Add versioned snapshots, actor RNG, Postgres state/event transactions, lease fencing, and restore. Keep the local file store for testbed use.
4. Add cost caps and server-side autoplay, initially disabled. Build private one-player games on this runtime before shared games.

Exit: restored and uninterrupted stubbed games produce equal request bodies, events, world light, and outcomes; a world has no global tick barrier; a restart cannot replay an already applied action.

### 2. Accounts and public boundary

1. Add accounts, player identity, immutable agent versions, encrypted BYOK, quotas, CSRF, rate limits, and audit events.
2. Add the public `/v1` router and SSE projection. Restrict the one settings API to operators; remove player settings routes from the public router. Bind dev hub management to localhost.
3. Run fog twins for every participant view and request, including a teammate's newly lit area, global teammate positions, and a hidden monster moved after a help report. Test request routing with three different explorer models and one central adversary model, exact billing ownership, single-participant forfeiture on key or quota failure, service-route pause, access for every route, and spend-limit races across two workers.

Exit: an untrusted browser cannot spend another account's key, change rules, reveal hidden state, start another player's game, or manage server instances.

### 3. Cloud operations

Deploy app workers and managed Postgres. Add health checks, migrations, structured logs without secrets or request bodies by default, metrics for Jev posts/latency/timeouts, actor queue delay, event commit delay, SSE lag, and worker lease conflicts. Add backups and a restore drill. Cap concurrent Jev calls globally and per account. Test worker death during a decision and during event commit; fencing must prevent double application. Pin old rule and generator versions while affected games remain active.

### 4. Shared dungeon

1. Implement waiting-room joins, leaves, leader transfer, start seal, expiry, reconnect, and start/join transaction races.
2. Spawn distinct explorers in one world. Share permanent map light and world loot; keep personal route history, resources, memories, and directives. Add global active-explorer positions, the screen's union of directly seen enemies, and frozen help reports to the correct projection layers. Resolve pickup contention by event application order.
3. Extend monster targeting, attacks, knockback, grace, skill effects, and win resolution for multiple explorers. Preserve bump versus strike semantics. Validate all actions against current state when they apply.
4. Project one SSE stream per viewer and run fog twins. Cover simultaneous portal entries, contested loot, two attacks against one ghost, a ghost moving during a delayed sword call, all teammate positions through walls, the union of directly seen adversaries on every screen, near and far help-call recipients, player death or forfeiture while a call is in flight, and a disconnected participant's reconnection.

Exit: no player joins after start; a slow decision never freezes the dungeon; explored terrain persists for every explorer; every applied action has one durable event and a deterministic order; no hidden state leaks into Jev or player views.

Co-op rules, replays, object-store archives, and cross-region hosting follow only after shared competitive play is stable.

## Verification commands and boundaries

Run the existing free checks that cover fog, adversaries, testbed, config, skills, tabu, progress, levels, morale, route, persistence-sensitive request hashes, and API directives. Add `check-runtime.mjs`, `check-persistence.mjs`, `check-lobby.mjs`, `check-multiplayer-fog.mjs`, and `check-paid-paths.mjs` with stubbed decisions and a throwing `fetch` tripwire. Use testbed arenas for explorer behavior. Do not use `/api/step`, Start, or any `--live` runner as a routine test. A protected staging latency measurement may be run only with an explicit budget and authorization.

The implementation crosses the ownership boundaries in `AGENTS.md` because the world, both brains, server, config, and UI must change together. Keep each phase reviewable, reread files before editing in a shared workspace, and do not hand-edit runtime memory files or request-hash fixtures except for a deliberate fixture update.
