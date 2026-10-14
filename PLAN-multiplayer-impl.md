# PLAN-multiplayer: implementation design (branch `multiplayer-v1`)

## Progress (2026-10-14)

| Package | Status | Evidence / next step |
| --- | --- | --- |
| WP-A–E, WP-I | Complete | Existing gateway, intent, shared world, clock, runtime, lobby, ranking and reviewed player/host pages. The real service now serves those pages and the `/v1` routes covered by the HTTP checks. |
| WP-F | Complete (`7f95df7`, `4a3b9b1`) | Seeded decision and prop shuffles, versioned world/brain/skill/actor snapshots, store event ordering and restart truncation. `check-persistence.mjs` passes a 20 + restore + 20 replay and crash boundary check. The full suite passed 46/46; request hashes intentionally regenerated. |
| WP-G | Complete (`9cfe77a`, `8bab9c0`, `e5e4153`, `c192e28`, `d0f43e0`) | Real `/v1` service, revision workers, private cookie credentials, SSE, key handling, restart auto-resume, room expiry, roster propagation and metrics. Host/HTTP checks cover access, independent keys and server rejection. Full final suite 51/51. |
| WP-H | Complete (`5499ce1`, `478871a`) | Monsters track visible/frozen sightings per explorer and choose targets without revealing hidden positions. Help calls use known-path reach and frozen reports, expiring after 30 steps or when seen empty. Player projections include team sight and filter hidden effects. Multiplayer and fog checks pass; final suite 51/51. |
| WP-J / final review | Complete | Operations guide, contracts, metrics and child crash checks. Review fixed authentication, simultaneous key expiry, durable pending call records, host-ended ranking and heart projection. The final dry suite passed 51/51; authorized live calibration is recorded below. |
| Live calibration | Complete | 60 paid explorer decisions, 118 HTTP posts, median decision period 352.3 ms. Set the built-in `rules.stepMs` default to 350 ms; post-calibration full suite 51/51 and request hashes unchanged. |

Live measurement completed with explicit user authorization on 2026-10-14: 60 explorer decisions, 118 HTTP posts (116 successful, two aborted at shutdown), no decision failures. Median decision period including cadence 352.3 ms, p90 610.6 ms; calibrated `rules.stepMs` to 350 ms. Evidence: [measurement report](docs/measurements/multiplayer-latency-2026-10-14.md) and its sanitized JSON. Post-calibration validation passed 51/51. Calibration commit `50687d6` merged into `main` as `7a5693e`; the merge tree matched the tested branch exactly.

This file turns PLAN-multiplayer.md into concrete seams, files and work packages (WP). PLAN-multiplayer.md
is the product spec; this file is how we build it. If the two disagree on *product* behaviour, PLAN-multiplayer.md
wins; on *code structure*, this file wins. Every deliberate deviation from the plan is listed in "Deviations" at
the end, with the reason. Add to it when you deviate.

## Ground rules for every work package

- Read AGENTS.md first (fog of war, paid paths, seeds, `Game` cloning, static guards). They all still apply.
- **Never call Jev.** Never pass `--live`, never hit `/api/step` or a `/v1` route that starts actors on a real
  server with a real key. Every new check stubs `ask`/`decide` and installs the fetch tripwire
  (`scripts/lib/tripwire.mjs`, WP-A).
- `node scripts/check-all.mjs` (all `scripts/check-*.mjs` in parallel, ~80 s) must be green at the end of every WP.
  The single-player game must keep behaving identically: `check-request-hashes.mjs` must stay green unless a WP
  says it regenerates the fixture on purpose (only WP-F does).
- Commit with `git add <your files>` (never `git add -A`; `.claude/` is untracked on purpose), small commits, each
  ending with the `Co-Authored-By` line you were given.
- Keep the code style (AGENTS.md "Conventions"): ES modules, `node:` prefixes, header comment per file, comments
  explain *why*.
- `src/dungeon.js` may not gain a relative import (check-props copies that one file). Anything `Game` needs lives
  in dungeon.js or is injected.

## Target architecture

```
                 ┌─────────────── service.js (hosted entry, /v1, host, player pages) ───────────────┐
                 │  src/service/http.js  router, cookies, Origin, rate limits, SSE                   │
                 │  src/service/service.js  games registry, rules revisions, lobby, host actions      │
                 │  src/service/store.js    file store runs/server/ (lock, revisions, games/<id>/…)   │
                 │  src/service/project.js  per-viewer projection (fog for players, team view)       │
                 └───────────────┬──────────────────────────────────────────────────────────────────┘
                                 │ one GameActor per running game
          ┌──────────────────────▼──────────────────────┐
          │ src/runtime/game-actor.js                   │  mutation queue (sync critical sections),
          │   clock (src/runtime/clock.js)              │  per-actor schedules, generations, events,
          │   ExplorerActor / MonsterActor              │  observed_at / completed_at / applied_at
          └──────┬───────────────────────────┬──────────┘
     decide()    │                           │  monster turn start / apply
 (async, Jev via │                           │  (adversary.js split)
  gateway)  ┌────▼─────────┐          ┌──────▼────────┐
            │ ExplorerBrain│          │ Adversary     │
            │  decide()    │          │  brain.js     │
            │  apply()     │          │               │
            └────┬─────────┘          └──────┬────────┘
                 │ KnownWorld(game, explorerId)  AdversaryView
            ┌────▼──────────────────────────────▼───────┐
            │ Game (dungeon.js): shared light, loot,     │
            │ adversaries, clock; explorers: ExplorerState[] │
            └────────────────────────────────────────────┘
 src/gateway/  the only place that creates paid askers (key per call, one copy, 7 s per call, records posts)
```

`server.js` + `src/turn.js` (`Run`) stay as the **development** path (hub, arenas, gyms, every existing check). `Run`
becomes a thin legacy driver over the same seams: one explorer, `playTurn()` = explorer decide+apply, then the
monsters' turn start/decide/apply, and the world clock advances by exactly `stepMs` per `playTurn`. That is what keeps
every existing check and the request-hash fixture byte-identical while the hosted runtime runs the same code in
continuous time.

## Work packages

### WP-A: gateway and paid paths (PLAN Phase 0.1-0.2)

Files: `src/gateway/jev-client.js`, `src/gateway/gateway.js`, `src/gateway/errors.js`, `src/gateway/recorder.js`,
`src/jev.js`, `server.js`, `src/turn.js` (only the default-asker lines), the two brains' default-asker lines,
`src/config/registry.js` (+ CONFIG.md regen), `scripts/lib/tripwire.mjs`, `scripts/check-gateway.mjs`,
`scripts/check-paid-paths.mjs`.

- `postWithRetry(body, { key, signal, endpoint, timeoutMs = 7000, retries = 3, retryStatus, backoffMs = 500, fetchImpl, onAttempt, now })`
  per PLAN-multiplayer "Decision routing and cost": one in-flight copy, one deadline covering the whole call
  (retries and backoff included), abortable backoff, `KeyRejected` on 401/403 (no retry), `CallTimeout` when the
  deadline fires, `CallAborted` on the external signal, `CallFailed(status, bodySnippet)` for a final failure. A
  response that arrives after abort/timeout is discarded (the promise has already rejected; nothing is returned).
  Read the response body defensively (non-JSON 200 = `CallFailed`).
- `Gateway` (`new Gateway({ fetchImpl = fetch, serverKey, model, endpoint, timeoutMs, retries, retryStatus, recorder })`):
  - `explorerAsker({ gameId, actorId, getKey, signal })` -> `ask({ kind, state, questions, body })` using the
    participant key from `getKey()` (throws `KeyRejected`-like `NoKey` when null). Never falls back to another key.
  - `monsterDecider({ gameId, signal })` -> `decide({ id, state, questions, body })` with the server key.
  - `devAsker()` / `devDecider()`: what `server.js` uses today (env `JEV_API_KEY`, and the existing laya/openai
    provider switch from `src/jev.js`, kept development-only).
  - Every HTTP attempt calls the recorder **before** fetch and updates it after:
    `{ at, game, actor, kind, attempt, status, bytes_out, bytes_in, ms, outcome }`. Never the key, never the body.
    `recorder` is an interface (`record(entry)`); `MemoryRecorder` for checks; the store (WP-G) writes `calls.jsonl`.
- `src/jev.js`: keep `shuffle`, `jevModel`, `configureJev` and the dev providers, but `askJev` becomes a thin
  wrapper over the gateway's dev path. Registry: `jev.hedgeCopies` default 1, `jev.timeoutMs` default 7000 and its
  doc says "per call, retries and backoff included". The hedge code path may stay for the dev server only when
  `hedgeCopies > 1`; the hosted gateway never hedges.
- **Mandatory injection.** `ExplorerBrain` and the adversary `decide` path no longer import a real caller: a missing
  `ask`/`decide` throws `Error('ask is required: build it with the gateway')` at construction / first use. `Run` passes
  through what it gets; `server.js` builds its askers from `gateway.devAsker()/devDecider()`. Scripts that relied on the
  default (`run-testbed --live`, `measure-* --live`) build gateway askers explicitly.
- `scripts/lib/tripwire.mjs`: `installTripwire()` replaces `globalThis.fetch` with a throwing function and returns an
  uninstall. New checks import it.
- `check-gateway.mjs` (fake transport + fake timers or short real timeouts): retryable statuses then success,
  backoff cancelled by abort, timeout covers retries, late response rejected, 401/403 -> `KeyRejected` with exactly one
  post, exact recorder entries (count, attempts, statuses), key never in recorder output, explorer asker uses only its
  participant key, monster decider only the server key.
- `check-paid-paths.mjs`: static scan: only `src/gateway/*` and `src/jev.js` (dev providers) and
  `src/openai-decider.js` reference `fetch(`; no file under `src/characters/` imports `askJev`; constructing
  `ExplorerBrain` / calling `stepAdversaries` with a hunting ghost without `decide` throws instead of fetching.

### WP-B: intent seams (PLAN Phase 0.3)

Files: `src/characters/explorer/brain.js`, `src/characters/adversary/adversary.js`, `src/characters/adversary/brain.js`,
`src/turn.js`, `scripts/check-intents.mjs`.

- `ExplorerBrain.decide({ signal } = {})` -> `{ intent, pending }`: runs everything `takeTurn` does **up to** the
  world mutation (observation, triggers, Jev calls, answer parsing, private decision bookkeeping that does not depend
  on the move's result). **It must not mutate the `Game`** (no `world.move`, no `world.useSkill`, no write to any
  game field). `intent` is plain JSON: `{ kind: 'explorer', skill: key|null, move: dir|'stay', distance, ... }`
  (whatever `apply` needs; keep it serializable). `pending` is whatever private context `apply` needs (may be kept
  as a private field instead).
- `ExplorerBrain.apply(intent)` -> the same turn object `takeTurn` returns today: validates the intent against the
  **current** world (`skill` still ready and its aimed cells unchanged; `move` still in `availableMoves()`), then
  `world.useSkill` + `world.move` + the after-move bookkeeping + memory save. A stale/invalid part becomes a no-op and
  the turn carries `stale: ['move' | 'skill', reason]`. Sync world mutation; the memory file write may stay async but
  must happen after all world mutation (so the hosted actor can run `apply` under its mutation lock and await the save
  outside it, or skip the file save when a store is used: add `{ save: false }`).
- `takeTurn() { const d = await this.decide(); return this.apply(d.intent); }` byte-identical to today.
- `signal`: an aborted signal makes `decide` reject with `CallAborted` before any further Jev call; a call that
  rejects mid-decision leaves private state consistent (the next `decide` starts clean).
- Adversaries: split `stepAdversaries` into
  - `beginAdversaryTick(game)` (sync: grace, stun, bumps, tick counter, views, sense, morale, budgets) -> `{ ctx, thinkers }`,
  - `decideAdversary(game, a, ctx, { decide, signal })` (async; builds the request synchronously first, as today),
  - `applyAdversaryResult(game, a, ctx, result)` (sync: skill, step, bump, extra budget steps, sense after step),
  and `stepAdversaries` composes them exactly as today. Also expose a **single-monster** pair for the runtime:
  `monsterTurnStart(game, a, { now })` (sync: sense + morale for this one, returns `null` when it does not act) and
  `monsterTurnApply(game, a, start, result)` (sync, current-state validation: a claw strikes whoever stands in its
  cells now; a move into a wall/occupied-by-explorer cell becomes bump/no-op as rules say).
- `check-intents.mjs`: `decide()` leaves a `Game` byte-identical (compare a structural fingerprint before/after:
  pos, light, coins, hp, adversaries' public JSON, strikes); a stale move (cell walled by a twin / occupied) is a no-op
  with a reason; a stale sword misses a ghost moved out of its cells; `takeTurn` == `decide`+`apply` over 30 stubbed
  ticks (turn objects and request bodies equal); adversary split == old `stepAdversaries` (events equal over 50 ticks).

### WP-C: ExplorerState, several explorers, shared light, teammates (PLAN Phase 1.1 first half, 4.2 data model)

Files: `src/dungeon.js`, `src/characters/explorer/known-world.js`, `src/characters/explorer/{known-map,encounter,perception}.js`
(teammate blocking + teammate facts), `src/characters/explorer/brain.js` (state group `surroundings.teammates`, rules
sentence when teammates exist), `src/characters/adversary/adversary.js` + `adversary-view.js` (explorer list instead
of `game.pos`), `src/config/registry.js` (`explorer.helpReachSteps` 48, validated > `monsters.pack.alertSteps`),
`scripts/check-dungeon.mjs` (guard allowlist if needed), `scripts/check-explorers.mjs`.

- `ExplorerState` (class in dungeon.js): `id`, `pos`, `steps` (its own decision counter), `visits`, `trail`, `health`,
  `maxHealth`, `regenAt`, grace, `facing`, `block`, `coins`, `heartAt`, `status` (`'active' | 'dead' | 'forfeited' |
  'won'`), `outcome` stats for the ranking (`strikes`, `dispels`, `diedAt`, `portal`), `skillSet` handle if useful.
- `Game.explorers: ExplorerState[]`, `game.explorer(id)`, `game.activeExplorers()`. The legacy single-explorer fields
  (`pos`, `steps`, `visits`, `health`, `coins`, `facing`, `block`, `graceTicks`, `trail`, ...) stay usable as
  accessors onto the **primary** explorer (`explorers[0]`) so every existing check works untouched. `twin(overrides)`
  must keep working for the fog twins: overriding `pos` on a twin must not move the original's explorer (give the twin
  its own shallow-copied primary `ExplorerState` when an explorer field is overridden).
- `new Game(dungeon, { explorers: [{ id, start }] })`: default one explorer `'explorer'` at `dungeon.start`. Light is
  shared and max-only (already true); each explorer's visit lights around it. `won`/`lost` stay game-level: `won` =
  team win (portal), `lost` = no active explorer left. `damage(amount, sourceId, explorerId = primary)`.
- `applyMove(dir, distance, explorerId = primary)`: a cell holding another active explorer is not a legal move
  (`legalMoves(explorerId)` excludes it). Pickups: first applied action takes the coin/heart.
- `KnownWorld(game, explorerId = primary)`: every read is that explorer's. New fog-safe reads: `teammates()` ->
  `[{ id, pos }]` of every other active explorer (global, through walls: user-approved), `helpReports()` (WP-H fills it;
  return `[]` for now). Teammate cells block moves and known-floor BFS in perception exactly like a solid obstacle,
  encounter/escape/hide targets skip them, and the move fact for a step into one says
  `A teammate stands there.` They never go into `threats` and confidence never counts them.
- Jev state: with at least one teammate, `surroundings.teammates = [{ id, direction, distance }]` (known-path
  distance, else rounded Euclidean, like adversaries) and one rules sentence: other explorers are teammates on the same
  side, cannot hurt it and are not threats. With no teammates nothing changes (request-hash fixture byte-identical).
- Adversary side: `seesExplorer(game, a, explorerId)`, `visibleAdversaries(game, explorerId)`, etc. take an explorer;
  legacy callers default to the primary. Monster targeting across several explorers is WP-H; WP-C only makes the
  functions explorer-parametric and makes knockback/bump/strike resolve against "an explorer on that cell".
- `check-explorers.mjs`: two and three explorers in a testbed arena (add a testbed key `explorers: [[x,y],...]`):
  shared light (B sees what A lit, knownTile equal), personal visits, a move into a teammate is illegal, teammate BFS
  blocking, teammates in requests and never in threats, a fog twin (hidden tiles outside the shared lit area scrambled
  -> identical requests for both explorers), single-explorer requests unchanged.

### WP-D: world clock and durations (PLAN Phase 1.1 second half)

Files: `src/dungeon.js`, `src/characters/adversary/*.js`, `src/skills/*`, `src/turn.js`, `src/config/registry.js`
(`rules.stepMs` calibrated to 350, `rules.cadenceMs` 90; derived durations in CONFIG.md), `scripts/check-clock.mjs`.

- `game.clock` (ms, world time) and `game.rules.stepMs`. `Run.playTurn` advances `game.clock += stepMs` once per turn,
  at the start, so every legacy check sees the same pace as before.
- Shared-world timers become deadlines in ms on that clock: grace (`graceUntil` per explorer), block stance
  (`until` ms), heart respawn (`due` ms = pickup + `heartRespawn * stepMs`), regen (every `regenSteps * stepMs` of
  world time per explorer), skill cooldowns (`readyAt` ms = use + `cooldown * stepMs`; `cooldown_left` in summaries
  stays a step count derived as `ceil(ms left / stepMs)` so requests are byte-identical), stun (`stunUntil`), monster
  movement (`moveIntervalMs = stepMs / speed`, used by the runtime; the legacy budget path stays for `Run`),
  hunt/search decay, morale regen and monster memory ages: a **world tick** = `floor(clock / stepMs)`
  (`game.worldTick()`), so `adversaryTicks` becomes derived from the clock in the hosted runtime and stays the counter
  in `Run`. Dash's real-time cooldown keeps using its own clock source but reads `game.clock` when given one.
- Actor-private timers (explorer memory age, remembered sightings, hold, progress windows, tabu tenure, directive
  steps, coin/review cadences) keep the explorer's own decision counter (`ExplorerState.steps`): see Deviations.
- Pause: `game.pauseAt` / resume re-anchors: all deadlines are stored as remaining ms on pause and re-based on
  resume (`game.freeze()` / `game.thaw(now)` helpers used by WP-E/WP-F).
- `check-clock.mjs`: the converted defaults (grace 4 steps = 1600 ms at 400, heart respawn 200 steps = 80 s, ...),
  equivalence with the step path over 100 stubbed ticks, freeze/thaw keeps remaining durations.

### WP-E: runtime (PLAN Phase 1.2, 1.4)

Files: `src/runtime/clock.js`, `src/runtime/game-actor.js`, `src/runtime/explorer-actor.js`,
`src/runtime/monster-actor.js`, `scripts/check-runtime.mjs`.

- `MonotonicClock` (`performance.now()` based) and `FakeClock` (`advance(ms)` runs due timers in order; used by checks).
- `GameActor({ game, clock, rules, explorers: [{ id, brain }], decideMonster, store?, onEvent })`:
  - `enqueue(command)`: commands run one at a time, synchronously (no `await` inside a mutation); returns a promise of
    the command's result. All world writes go through it.
  - Per actor: `nextDecisionAt`, `inFlight` (at most one), `generation`. Explorer: when due and not in flight, take
    `observedAt = clock.now()`, call `brain.decide({ signal })` (the request is built synchronously at start), then
    enqueue `apply_intent` with `{ actorId, generation, observedAt, completedAt }`. Apply re-checks generation and
    liveness; `brain.apply(intent)` validates against current state. Schedule next at `appliedAt + cadenceMs`
    (`rules.cadenceMs`, 90). A failed/timed-out decision enqueues `decision_failed` and schedules the next one the same
    way (no backlog, no catch-up). `KeyRejected` stops that explorer (`awaiting_key`), see WP-G.
  - Monster: brain-off monsters take code patrol steps on their own interval (`stepMs / speed`); hunting monsters run
    `monsterTurnStart` (sync, in the lock), `decideMonster` (async, outside), `monsterTurnApply` (in the lock). Each
    monster's next turn is `max(cadenceMs, moveIntervalMs)` after its previous apply.
  - The clock drives world timers: before each mutation, `game.clock = clock.now() - startedAt + pausedOffset`.
  - Events get a monotone `seq`, `applied_at`; every applied action produces exactly one event record
    (`{ seq, type, actor, generation, observed_at, completed_at, applied_at, ... }`) passed to `onEvent` (the store
    appends it, then writes state, then SSE publishes: WP-F/WP-G).
  - `pause()` / `resume()` / `stop()`: pause aborts in-flight decisions (their late answers are dropped by generation),
    freezes the game clock; resume re-anchors.
  - `autoplay` flag (default false): nothing schedules until `start()`.
- `check-runtime.mjs` (FakeClock + controlled promises): a slow explorer (its promise never resolves) does not stop a
  fast explorer or a monster; a late sword misses a ghost that moved out of its cells; an aborted/old-generation answer
  never applies; no backlog after a long stall; pause freezes grace and cooldowns, resume continues them; event `seq`
  strictly increasing; a world mutation never happens while a decision awaits (instrument the game).

### WP-F: determinism, snapshots, file store (PLAN Phase 1.3, "Storage and recovery")

Files: `src/jev.js` (`shuffle(items, rand)`), both brains (actor-seeded option shuffles), `src/dungeon.js`
(`rng` with exportable state: `rng(seed)` returns a function that also has `.state()`/`.restore()`; same sequence),
`serialize()`/`static restore()` on `Game`, `ExplorerState`, `ExplorerBrain`, `Adversary`, `SkillSet`/skills,
`GameActor`; `src/service/store.js`; `scripts/check-persistence.mjs`; `scripts/fixtures/request-hashes.json` (regenerated,
own commit).

- Option shuffles use a per-actor seeded stream (`seed ^ hash(actorId) ^ 0x…`) created lazily, never `Math.random`.
  This changes request bytes: regenerate the request-hash fixture in its own commit and say so in the message.
- Versioned snapshots (`{ v: 1, ... }`): all mutable state listed in PLAN "Storage and recovery" incl. tabu, Dash,
  morale, limited-map views, hunt state, private brain fields, RNG states, Set/Map order. No key ever.
- `FileStore(root = 'runs/server')`: `lock()` (pid file; refuses a live other pid; stale lock taken over),
  `host-token`, `settings/<rev>.json` (append-only), `games/<id>/{meta,rules,dungeon,state}.json`, `events.jsonl`,
  `calls.jsonl`, cold `state-<seq>.json` at start/finish/every N events. Writes: append event, then write state via
  temp+rename, then return (caller publishes). Restore: read state, drop events with seq > state.event_seq.
- `check-persistence.mjs`: a stubbed game run 40 ticks vs run 20 + snapshot + restore + 20 -> identical request
  bodies, events, light, outcomes; a crash between event append and state write (simulate) restores without applying
  twice; keys absent from every file (scan); the lock refuses a second store; restore of a running game comes back
  `paused`.

### WP-G: hosted service, host, players, /v1, SSE (PLAN Phase 2, 3)

Files: `service.js` (new entry, `npm run serve`), `src/service/{service,http,auth,project,ratelimit,log}.js`,
`public/play.html`, `public/play.js`, `public/host.html`, `public/host.js` (UI may reuse `public/app.js`'s renderer:
see WP-I), `package.json` script, `scripts/check-host.mjs`, `scripts/check-service.mjs`.

- Binds `127.0.0.1` (`HOST` env to open), port `PORT` or 3100. Startup: store lock, host token (random each start
  unless `HOST_TOKEN`), prints `http://localhost:<port>/host#token=...`, restores games (running ones as `paused`).
- Settings: `GET/PUT /v1/host/settings` over the central registry (validation from `src/config/*`); a PUT writes a new
  revision. A game captures the effective rules at creation into `rules.json`. Until the rules are threaded as an
  immutable object (see Deviations), the service runs games of one rules revision per **worker process**
  (`node:child_process.fork` of `src/service/worker.js`), keyed by revision; the main process routes.
- Players: `POST /v1/games` / `join` / `leave` / `key` / `start` / `directives` / `pause` / `resume`, `GET /v1/games/:id`,
  SSE `/v1/games/:id/events` (Last-Event-ID, heartbeat 15 s, bounded queue: drop the client on overflow). Participant
  cookie `jd_par_<gameId>` HttpOnly SameSite=Strict, random token; name 1-20 chars sanitised like directives; key kept
  in memory only. Origin check on every mutating route; per-address rate limits on create/join/directives.
- Host: cookie from `/host#token=` (the page posts the fragment to `/v1/host/session`), loopback only unless
  `HOST_REMOTE=1`; routes `GET /v1/host/games`, `POST /v1/host/games/:id/{pause,resume,end,reveal}`, call log per game,
  counters. Players get 403 on every host route.
- Private game = room with one slot that starts at once. Autoplay on start (gateway askers: explorer key per
  participant, server key for monsters). A `KeyRejected` -> explorer `awaiting_key` (stands still, still targetable),
  forfeits after `keyRetryMs` (120000) unless a valid key arrives; server key rejected -> whole game paused.
- `/health` (unauthenticated: `{ ok, games, uptime }`), structured JSON logs (no keys, no bodies).
- `check-host.mjs` / `check-service.mjs`: in-process server on an ephemeral port, fake gateway transport, tripwire:
  every route's access matrix, host routes refuse players and non-loopback, Origin rejection, rate limits, cookies,
  keys never in any response/file/log, rejected participant key -> pause one explorer then forfeit after the window,
  rejected server key pauses the game, restart restores running games as paused-until-keys.

### WP-H: shared dungeon (PLAN Phase 4)

Files: `src/service/lobby.js`, `src/characters/adversary/{adversary,brain,perception,memory}.js` (per-explorer targets),
`src/characters/explorer/{known-world,brain,perception}.js` (help reports), `src/scoring.js`, `scripts/check-lobby.mjs`,
`scripts/check-multiplayer.mjs`, `scripts/check-multiplayer-fog.mjs`.

- Lobby: waiting/running/paused/finished/abandoned, 1-`rooms.capacity` (4) players, leader = oldest, deterministic
  transfer, start seals and spawns explorers on distinct start cells (the start room's floor nearest the start, by BFS),
  join/start race on the actor queue (`409 game_started`), 30-minute expiry, reconnect by cookie.
- Monsters: request lists every explorer the monster sees (own or team sight) or holds a frozen sighting of, as
  `explorers[]` `{ id, direction, path_steps, in_sight, ... }`, plus a `target` Choice; `lastSeen`/sightings kept per
  explorer; move facts are built against the chosen-by-default target (nearest seen) and the answer's target updates the
  hunt. One explorer in sight -> no `target` question (single-player bytes unchanged). Stay inside 5.5 KB avg / 8 KB max.
- Help calls (PLAN "Shared exploration"): `help_called` once per direct encounter, recipients within
  `explorer.helpReachSteps` on the shared known-floor graph, frozen `help_report` into the recipient's brain, shown as
  `threats.reported[]` (teammate information, never a direct sighting), expires like remembered sightings.
- Team win on first portal entry; team loss when no active explorer remains; ranking table (`src/scoring.js`) with
  the plan's points and tie-breaks; dead participant -> spectator team projection.
- Projection: per viewer: shared light, every active explorer's position, union of directly seen adversaries
  (`team_visible` when only a teammate sees it), own memory only.
- Checks: everything listed in PLAN Phase 4.4.

### WP-I: UI

`public/play.html|js` (entry: name + key, create/join, lobby with roster and leader Start, game view, key re-entry
prompt, ranking table, spectator mode), `public/host.html|js` (settings editor over `/v1/host/settings`, games list,
pause/resume/end/reveal, call log, counters). Reuse the isometric renderer from `public/app.js` by extracting it into
`public/render.js` (a module both pages import) rather than copying; register every new file in the static whitelist of
both servers. Draw several knights (slot colours), teammates through walls as outlined markers, `team_visible` ghosts.

### WP-J: operations and docs (PLAN Phase 3)

Counters on the host page, backup/restore doc (`docs/OPERATIONS.md`), kill tests (`check-persistence` extension: kill
a child service process during a decision and during an event write, restart, no double apply), AGENTS.md / CONTRACT.md
/ CONFIG.md updates for everything above.

## Order

WP-A ∥ WP-B -> WP-C -> WP-D -> WP-E -> WP-F -> WP-G -> WP-H -> WP-I ∥ WP-J. Each WP ends green and committed.

## Deviations (keep this list current)

1. **Actor-private timers stay on the actor's decision counter.** Memory ages, remembered sightings, engage hold,
   progress windows, tabu tenure, review/coin cadences and directive steps count the explorer's own applied decisions.
   They describe the explorer's own pace and never interact with another actor; converting them would change every
   request (they are stated in steps to Jev) for no gameplay gain. Shared-world timers (grace, block, stun, cooldowns,
   heart respawn, regen, monster movement, hunt decay, morale) are on the world clock.
2. **Rules isolation by worker process first.** Threading an immutable `rules` object through every module is a large
   refactor of the `configure*` hooks; WP-G routes each rules revision to its own worker process (allowed by the plan as
   the interim) and leaves the threading for later.
3. **Hosted service is a separate entry (`service.js`)**, not the dev `server.js`: the dev routes stay where they are
   (localhost, hub) and are simply absent from the hosted process.
4. **A two-call decision tick builds its second request when the first answer arrives** (from the world at that
   instant, still fog-safe), not from the snapshot taken at decision start: the second request depends on the first
   answer.
5. **No `A teammate stands there.` move fact (WP-C).** A step into a teammate is illegal, so `legalMoves` / `availableMoves`
   never offer it and no move question or sentence mentions it; the teammate is solid in `knownDistances` instead, and the
   `surroundings.teammates` group plus the rules sentence ("a cell one stands on is not a move") tell Jev why. Showing a
   fact for an option that is not offered would only cost bytes.
6. **Heart respawn deadline uses the picking explorer's step counter (WP-C)** until WP-D moves it to the world clock;
   `respawnHearts(id)` compares against the explorer whose move triggers it.
7. **`check-portal-objective` is flaky independent of WP-C**: it runs 12-20 `takeTurn`s with `Math.random`-shuffled
   options and, rarely, the explorer wins before the loop ends (`No legal moves`). Seen once in a full `check-all` run
   and not reproduced in 31 reruns; the script is untouched.
8. **Monster claw cooldowns stay turn-counted (WP-E).** A monster's claw cooldown counts its own runtime turns
   (`skills.turnPassed()` per turn); its turn interval is `max(cadenceMs, moveIntervalMs)`, so the pace matches the
   old budget path on average without converting monster skills to deadlines.
9. **`CallAborted` is one class (WP-E).** The class lives in `src/call-aborted.js` and the gateway, explorer and adversary modules
   re-export it (`check-paid-paths` forbids character files from referencing `gateway/`); the explorer fog-guard allowlist
   gained that one import (a pure error class).
10. **Stale aimed attacks swing (WP-E).** `ExplorerBrain.apply` no longer skips a sword whose option or cells changed:
    if the skill is ready it strikes the originally aimed cells against current occupants, as the plan says.


## /v1 API contract (shared by WP-G server and WP-I pages)

All bodies JSON. Errors: `{ error: '<code>', message, ...extra }` with the HTTP status from the Lobby / auth layer.
Mutating routes require a same-origin `Origin`. Participant identity = cookie `jd_par_<gameId>`.

Pages: `GET /` (player entry: name + key, create or join), `GET /g/<gameId>` (lobby + game view of one room; the
room link players share), `GET /host` (host page; token in the URL fragment), static `/play.js`, `/host.js`,
`/render.js`, `/sprites.js`, `/props/*.js`, `/style.css`, `/play.css` (optional).

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /v1/games` | `{ name, key, mode: 'private' \| 'shared' }` | `201 { game: GameSummary, participant_id }` + cookie |
| `POST /v1/games/:id/join` | `{ name, key }` | `200 { game: GameSummary, participant_id }` + cookie |
| `POST /v1/games/:id/leave` | — | `200 { game: GameSummary }` |
| `POST /v1/games/:id/key` | `{ key }` | `200 { participant: { state, key_present } }` |
| `POST /v1/games/:id/start` | — | `200 { game: GameSummary }` |
| `GET /v1/games/:id` | — | `200 GameView` (participant) / `200 { game: GameSummary }` for a non-member of a waiting room (so the join page can show the roster) / `403` otherwise |
| `GET /v1/games/:id/events` | header `Last-Event-ID` | SSE: `event: view` (`data: GameView`), `event: event` (`data: { seq, type, ... }` world events as the viewer may see them), `event: lobby` (`data: GameSummary`), `event: end` (`data: { result, ranking, team_score }`); comment heartbeats |
| `POST /v1/games/:id/directives` | `{ text }` | `200 { directive, queued }` (429 with `retry_in_ms`) |
| `POST /v1/games/:id/pause` / `resume` | — | `200 { game: GameSummary }` (private: its player; shared: 403 for players) |
| `POST /v1/host/session` | `{ token }` | `200 {}` + host cookie |
| `GET /v1/host/settings` | — | `{ revision, values, schema }` |
| `PUT /v1/host/settings` | `{ values }` | `200 { revision, values, changed }` / `400 { error: 'invalid', fields }` |
| `GET /v1/host/games` | — | `{ games: [GameSummary & { calls: { posts, failures, timeouts, p50_ms }, counters }] }` |
| `POST /v1/host/games/:id/{pause,resume,end,reveal}` | — | `200 { game }` (reveal: `{ view: GameView }` with the full map; logged as a host event) |
| `GET /v1/host/games/:id/calls?limit=200` | — | `{ calls: [CallEntry] }` |
| `GET /v1/host/metrics` | — | counters (posts, latency p50/p95, timeouts, actor queue delay, event write delay, SSE lag) |
| `GET /health` | — | `{ ok: true, games, uptime_s }` |

`GameSummary` = `{ id, mode, status, pause_reason, capacity, leader, rules_revision, created_at, participants: [{ participant_id?, name, slot, state, key_present, is_leader, is_self }] }`
(`participant_id` only for `is_self`).

`GameView` = everything the current single-player `Run.view()` gives (tiles are **fog-projected**: unknown cells
sent as `null` rows/cells, never the real tile; no seed), plus:
`self: participant_id`, `explorers: [{ id, participant_id, name, slot, pos, facing, status, self, health, max_health,
invulnerable, coins }]` (positions of every active explorer, global), `adversaries` = the union of adversaries any
active explorer directly sees, each with `visible` (the viewer sees it) and `team_visible` (only a teammate does),
`memory` = the viewer's own explorer memory only, `directive`, `lobby: GameSummary`, `ranking` when finished,
`spectator: true` for a dead / forfeited viewer (team projection, no own memory beyond its last state).
8. **WP-D clock: unmanaged games derive their time from the old counters; monster skill cooldowns stay in monster turns.**
   A `Game` is `managed` only under the hosted runtime (WP-E sets it and writes `game.clock`). Everything else (Run, the
   check drivers) calls `applyMove` / `stepAdversaries` directly without ever moving the clock, so deadlines there read
   `now()` (the legacy tick's time) and `timeOf(e)` (`e.steps * stepMs`), which under `Run` equal `game.clock` and
   elsewhere reproduce the old pace exactly (`Run` still adds one `stepMs` per turn, as specified). Monster skill
   cooldowns (the claw) keep counting the monster's own turns: a deadline of `cooldown * stepMs` would shift a
   budget-path monster by up to a tick; with the runtime a monster's turn interval is `moveIntervalMs`, so the count is
   already a duration. Heart respawn (Deviation 6) now compares the picking explorer's time (`timeOf`), which is the shared
   clock when managed. The `until_step` field stays on a block stance as an informational legacy value.

Optional field the pages use (WP-I): a participant entry in `GameSummary.participants[]` whose `state` is `awaiting_key`
may carry `key_deadline_ms_left` (milliseconds until the keyRetryMs window forfeits it). The key prompt shows a
countdown when it is present and just the explanation when it is absent. Participant states the pages know:
`ready` (waiting room), `active`, `awaiting_key`, `dead`, `forfeited`; the end screen also reads `ranking[]`
(`{ participant_id, name, slot, coins, strikes, dispels, portal, alive, forfeited, points }`), `result`
(`'won' | 'lost'`) and `team_score` from `event: end` / `GameView.ranking`.
